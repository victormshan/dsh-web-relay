/**
 * cc-task-schema v2：task.json / result.json 严格校验器。
 *
 * 背景：dsh-web-relay 通过 D:\cc-tasks 派发任务给 Claude Code
 * （runner.sh: `claude -p` 读 task.json → 产出 out/ + done.flag → 写 result.json）。
 * v1 契约校验较弱，曾发生 Claude 把 done.flag 误放在 out/ 目录下，导致
 * runner 在任务根找不到 done.flag 而误判为 failed。v2 在此基础上补齐：
 *   - task.json 的严格静态校验（validateTask）
 *   - result.json 的结构校验（validateResultText，纯函数无 IO）
 *   - 运行时校验（validateResult）：done.flag 位置断言 + result.json 结构 +
 *     expectArtifacts 存在性硬校验
 *   - 可选验收脚本执行钩子（runAcceptanceScript）
 *
 * 所有涉及文件系统 / 子进程的操作都通过依赖注入（fsImpl / exec）完成，
 * 默认实现使用 node:fs/promises 与 node:child_process，测试可注入 fake
 * 实现而不触碰真实磁盘。
 */

import path from "node:path";
import { promises as fsp } from "node:fs";
import { execFileSync } from "node:child_process";

/** taskId 合法格式：字母数字开头，其后允许字母数字/点/下划线/短横线，总长 1~64。 */
const TASK_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/**
 * kind 允许的枚举值。额外接受显式 "unknown"，以兼容 v1 语义
 * （v1 中 kind 缺失时会被 parseTask 归一化为 "unknown"）。
 */
const KIND_ENUM = ["implement", "review", "understand", "unknown"];

/** result.json 的 status 允许的枚举值。 */
const RESULT_STATUS_ENUM = ["done", "failed"];
// s2v2_1: 精准 ErrorCode 分类（result.json / done.flag 校验错误码）
export const RESULT_ERROR_CODES = Object.freeze(["result-missing", "result-corrupt", "result-invalid"]);
export const DONE_FLAG_ERROR_CODES = Object.freeze(["done-flag-misplaced", "done-flag-missing"]);

/** Windows 风格绝对路径（如 C:\ 或 C:/）识别正则，用于 outputDir/doneFlag 越界检测。 */
const WINDOWS_ABS_RE = /^[A-Za-z]:[\\/]/;

/**
 * task.json / result.json 字段规范（描述性常量，非运行时强校验逻辑本身）。
 * 供文档、IDE 提示、以及其他工具复用字段定义。
 */
export const TASK_SCHEMA_V2 = Object.freeze({
  taskId: Object.freeze({
    type: "string",
    required: true,
    pattern: TASK_ID_RE.source,
    description:
      "任务唯一标识，需匹配 " +
      TASK_ID_RE.source +
      "；不强制要求 kind 前缀（implement-/review-/understand- 等），自由前缀（如 s2v1-）合法。",
  }),
  kind: Object.freeze({
    type: "string",
    required: false,
    enum: KIND_ENUM,
    default: "unknown",
    description:
      "任务类型枚举：implement|review|understand。缺失按 v1 语义容错为 unknown，不报错。",
  }),
  title: Object.freeze({
    type: "string",
    required: true,
    description: "任务标题，非空字符串。",
  }),
  prompt: Object.freeze({
    type: "string",
    required: true,
    description: "任务提示词，非空字符串。",
  }),
  refs: Object.freeze({
    type: "array",
    items: "string",
    required: false,
    default: [],
    description: "参考资料列表，可选，默认空数组。",
  }),
  acceptance: Object.freeze({
    type: "string",
    required: false,
    description: "验收标准描述，可选。",
  }),
  outputDir: Object.freeze({
    type: "string",
    required: false,
    default: "out",
    description:
      "产出目录，必须是任务根目录内的相对子路径；禁止绝对路径与 .. 越界。",
  }),
  expectArtifacts: Object.freeze({
    type: "array",
    items: "string",
    required: false,
    default: [],
    description:
      "期望产出物列表，元素为相对 outputDir 的路径；运行时校验其存在性。",
  }),
  doneFlag: Object.freeze({
    type: "string",
    required: false,
    default: "done.flag",
    description:
      "完成标记文件名。位置必须在任务根目录（与 task.json 同级），禁止放在 outputDir/out 内；" +
      "字段本身必须是不含路径分隔符的裸文件名，实际落盘位置由 validateResult 在运行时断言。",
  }),
});

/**
 * 判断相对路径字符串是否“安全”：非绝对路径（含 Windows 盘符形式），
 * 且路径分段中不包含 ".."（防止越出任务根目录）。
 * @param {unknown} p 待检测路径
 * @returns {boolean}
 */
function isSafeRelativePath(p) {
  if (typeof p !== "string" || p.length === 0) return false;
  if (p.startsWith("/") || p.startsWith("\\")) return false;
  if (WINDOWS_ABS_RE.test(p)) return false;
  const segments = p.split(/[\\/]+/);
  if (segments.some((seg) => seg === "..")) return false;
  return true;
}

/**
 * 判断字符串是否是不含任何路径分隔符的“裸文件名”（用于 doneFlag 静态校验）。
 * @param {unknown} p
 * @returns {boolean}
 */
function isBareFilename(p) {
  return (
    typeof p === "string" &&
    p.length > 0 &&
    !/[\\/]/.test(p) &&
    p !== "." &&
    p !== ".."
  );
}

/**
 * 校验 task.json 契约（静态校验，不涉及任何 IO）。
 * @param {unknown} taskOrText 已解析的 task 对象，或其 JSON 文本表示
 * @returns {{ok: boolean, errors: string[]}}
 */
export function validateTask(taskOrText) {
  let task = taskOrText;

  if (typeof taskOrText === "string") {
    try {
      task = JSON.parse(taskOrText);
    } catch (err) {
      return { ok: false, errors: [`task.json 不是合法 JSON: ${err.message}`] };
    }
  }

  if (typeof task !== "object" || task === null || Array.isArray(task)) {
    return { ok: false, errors: ["task 必须是一个对象"] };
  }

  const errors = [];

  if (typeof task.taskId !== "string" || !TASK_ID_RE.test(task.taskId)) {
    errors.push(
      `taskId 非法: 必须匹配 ${TASK_ID_RE.source} (收到 ${JSON.stringify(task.taskId)})`
    );
  }

  // kind 缺失按 v1 语义容错，不报错；仅当提供了非法值时报错。
  if (task.kind !== undefined) {
    if (typeof task.kind !== "string" || !KIND_ENUM.includes(task.kind)) {
      errors.push(
        `kind 非法: 允许值 ${KIND_ENUM.join("|")} (收到 ${JSON.stringify(task.kind)})`
      );
    }
  }

  if (typeof task.title !== "string" || task.title.trim().length === 0) {
    errors.push("title 必须是非空字符串");
  }

  if (typeof task.prompt !== "string" || task.prompt.trim().length === 0) {
    errors.push("prompt 必须是非空字符串");
  }

  if (task.refs !== undefined) {
    if (
      !Array.isArray(task.refs) ||
      task.refs.some((r) => typeof r !== "string")
    ) {
      errors.push("refs 必须是字符串数组");
    }
  }

  if (task.acceptance !== undefined && typeof task.acceptance !== "string") {
    errors.push("acceptance 必须是字符串");
  }

  if (task.outputDir !== undefined) {
    if (typeof task.outputDir !== "string" || task.outputDir.length === 0) {
      errors.push("outputDir 必须是非空字符串");
    } else if (!isSafeRelativePath(task.outputDir)) {
      errors.push(
        `outputDir 越界或非法: ${task.outputDir}（禁止绝对路径与 .. 越界）`
      );
    }
  }

  if (task.expectArtifacts !== undefined) {
    if (!Array.isArray(task.expectArtifacts)) {
      errors.push("expectArtifacts 必须是数组");
    } else {
      task.expectArtifacts.forEach((item, i) => {
        if (typeof item !== "string" || item.trim().length === 0) {
          errors.push(`expectArtifacts[${i}] 必须是非空字符串`);
        } else if (!isSafeRelativePath(item)) {
          errors.push(`expectArtifacts[${i}] 越界或非法: ${item}`);
        }
      });
    }
  }

  if (task.doneFlag !== undefined) {
    if (typeof task.doneFlag !== "string" || task.doneFlag.trim().length === 0) {
      errors.push("doneFlag 必须是非空字符串");
    } else if (!isBareFilename(task.doneFlag)) {
      errors.push(
        `doneFlag 必须是不含路径分隔符的裸文件名，且不得指向 out/ 等子目录: ${task.doneFlag}`
      );
    }
  }

  return { ok: errors.length === 0, errors };
}

/**
 * 校验 result.json 的结构（纯函数，无 IO，供无 IO 单测使用）。
 * 规则：
 *   - status 必须是 'done' | 'failed'；
 *   - exit（若提供）必须是整数；
 *   - status 为 'failed' 时 reason 必须是非空字符串。
 * @param {unknown} resultJsonText result.json 的 JSON 文本，或已解析对象
 * @returns {{ok: boolean, errors: string[]}}
 */
export function validateResultText(resultJsonText) {
  let result = resultJsonText;

  if (typeof resultJsonText === "string") {
    try {
      result = JSON.parse(resultJsonText);
    } catch (err) {
      return {
        ok: false,
        errors: [`[result-corrupt] result.json 不是合法 JSON: ${err.message}`],
        errorCode: "result-corrupt",
      };
    }
  }

  if (typeof result !== "object" || result === null || Array.isArray(result)) {
    return { ok: false, errors: ["[result-invalid] result 必须是一个对象"], errorCode: "result-invalid" };
  }

  const errors = [];

  if (
    typeof result.status !== "string" ||
    !RESULT_STATUS_ENUM.includes(result.status)
  ) {
    errors.push(
      `status 非法: 允许值 ${RESULT_STATUS_ENUM.join("|")} (收到 ${JSON.stringify(result.status)})`
    );
  }

  if (
    result.exit !== undefined &&
    !(typeof result.exit === "number" && Number.isInteger(result.exit))
  ) {
    errors.push(`exit 必须是整数 (收到 ${JSON.stringify(result.exit)})`);
  }

  if (result.status === "failed") {
    if (typeof result.reason !== "string" || result.reason.trim().length === 0) {
      errors.push("status 为 failed 时 reason 必须是非空字符串");
    }
  }

  return { ok: errors.length === 0, errors, errorCode: errors.length > 0 ? "result-invalid" : null };
}

/** 默认 fsImpl：基于 node:fs/promises 的真实文件系统实现。 */
const defaultFsImpl = Object.freeze({
  async exists(p) {
    try {
      await fsp.access(p);
      return true;
    } catch {
      return false;
    }
  },
  async readFile(p) {
    return fsp.readFile(p, "utf8");
  },
});

/**
 * 解析产出目录的绝对/规范路径：taskDir + (task.outputDir 或默认 'out')。
 * @param {string} taskDir
 * @param {unknown} outputDir
 * @returns {string}
 */
function resolveOutputDir(taskDir, outputDir) {
  const rel =
    typeof outputDir === "string" && outputDir.length > 0 ? outputDir : "out";
  return path.join(taskDir, rel);
}

/**
 * 运行时校验：done.flag 位置断言 + result.json 结构 + expectArtifacts 存在性。
 *
 * done.flag 硬拦截规则（修复 done.flag 误放 out/ 导致 runner 误判 failed 的事故）：
 *   - taskDir/<doneFlag> 存在 → doneFlagAtRoot = true，通过；
 *   - taskDir/<doneFlag> 不存在，但 outputDir/<doneFlag> 存在 → 报
 *     'done.flag misplaced: expected at task root <taskDir>/done.flag, found under out/'；
 *   - 两处都不存在 → 报 'done.flag missing: expected at task root <taskDir>/<doneFlag>'。
 *
 * result.json 规则：
 *   - 不存在 → 视为任务仍在进行中，报 'result.json missing'，details.resultPending = true；
 *   - 存在但结构不合法 → 报 'result.json: <具体错误>'（复用 validateResultText）。
 *
 * expectArtifacts 规则：对 task.expectArtifacts 中每一项，相对 outputDir 解析后
 * 检查是否存在；缺失则报 'missing artifact: <path>'。
 *
 * @param {object} options
 * @param {string} options.taskDir 任务根目录（task.json 与 done.flag 应在此目录下）
 * @param {object} [options.task] 已校验的 task 对象（用于读取 outputDir / doneFlag / expectArtifacts）
 * @param {{exists: (p: string) => Promise<boolean>, readFile: (p: string) => Promise<string>}} [options.fsImpl]
 *   文件系统实现注入，默认使用 node:fs/promises
 * @returns {Promise<{ok: boolean, errors: string[], details: {doneFlagAtRoot: boolean, resultPending: boolean, artifacts: {name: string, exists: boolean}[]}}>}
 */
export async function validateResult({ taskDir, task = {}, fsImpl = defaultFsImpl }) {
  const errors = [];
  const outputDir = resolveOutputDir(taskDir, task.outputDir);
  const doneFlagName =
    typeof task.doneFlag === "string" && task.doneFlag.length > 0
      ? task.doneFlag
      : "done.flag";

  const rootFlagPath = path.join(taskDir, doneFlagName);
  const outFlagPath = path.join(outputDir, doneFlagName);

  // s2v3_2（PENDING 消误报）: 先查 result.json——缺失 = 任务执行中/未完成（pending），
  // done.flag 的 missing 判定仅在 result.json 已写出（任务宣告结束）时才成立；
  // misplaced（放 out/）恒为契约违例（无论 pending）。
  const resultPath = path.join(taskDir, "result.json");
  let resultPending = false;
  let resultErrorCode = null;
  if (await fsImpl.exists(resultPath)) {
    const text = await fsImpl.readFile(resultPath);
    const { ok: resultOk, errors: resultErrors, errorCode: textErrorCode } = validateResultText(text);
    if (!resultOk) {
      resultErrorCode = textErrorCode || "result-invalid";
      errors.push(...resultErrors.map((e) => `result.json: ${e}`));
    }
  } else {
    resultPending = true;
    resultErrorCode = "result-missing";
    errors.push("[result-missing] result.json missing");
  }

  const doneFlagAtRoot = await fsImpl.exists(rootFlagPath);
  let doneFlagErrorCode = null
  if (!doneFlagAtRoot) {
    const inOut = await fsImpl.exists(outFlagPath);
    if (inOut) {
      doneFlagErrorCode = "done-flag-misplaced";
      errors.push(
        `[done-flag-misplaced] done.flag misplaced: expected at task root ${taskDir}/${doneFlagName}, found under out/`
      );
    } else if (!resultPending) {
      // result.json 已写出但 done.flag 双缺 = 任务结束却漏完成标记（真异常）
      doneFlagErrorCode = "done-flag-missing";
      errors.push(
        `[done-flag-missing] done.flag missing: expected at task root ${taskDir}/${doneFlagName}`
      );
    }
    // else: resultPending（无 result.json）→ 视为执行中，不报 done-flag-missing（s2v3_2 消误报）
  }

  // s2v3_1: review 任务 expectArtifacts 自动兜底——kind=review 且未显式声明 → 默认校验 out/review.md（review 产物约定）
  const expectArtifacts = Array.isArray(task.expectArtifacts)
    ? task.expectArtifacts
    : (task.kind === "review" ? ["review.md"] : []);
  const artifacts = [];
  for (const name of expectArtifacts) {
    const artifactPath = path.join(outputDir, name);
    const exists = await fsImpl.exists(artifactPath);
    artifacts.push({ name, exists });
    if (!exists) {
      errors.push(`missing artifact: ${name}`);
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    details: { doneFlagAtRoot, resultPending, artifacts, resultErrorCode, doneFlagErrorCode },
  };
}

/**
 * 默认 exec 实现：通过 /bin/sh -c 执行验收脚本，非 0 退出码会抛出异常。
 * @param {string} script
 * @param {string} cwd
 */
function defaultExec(script, cwd) {
  execFileSync("/bin/sh", ["-c", script], { cwd, stdio: "pipe" });
}

/**
 * 可选验收脚本执行钩子。exec 注入（默认 child_process execFileSync 封装）：
 * exit 0 → { ok: true }；非 0 或抛错 → { ok: false, error }。
 * @param {object} options
 * @param {string} options.script 要执行的脚本/命令
 * @param {string} [options.cwd] 执行目录，默认 process.cwd()
 * @param {(script: string, cwd: string) => void} [options.exec] 执行函数注入，默认基于 execFileSync
 * @returns {{ok: boolean, error?: string}}
 */
export function runAcceptanceScript({ script, cwd = process.cwd(), exec = defaultExec }) {
  if (typeof script !== "string" || script.trim().length === 0) {
    return { ok: false, error: "script 不能为空" };
  }
  try {
    exec(script, cwd);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err && err.message ? err.message : String(err) };
  }
}

// ---- s2v5_1: watchdog 崩溃/重启恢复分类（cc-watchdog.sh / runner.sh 被杀后悬挂任务判定）----

/**
 * 恢复扫描分类（watchdog 崩溃/重启恢复路径，s2v5_1）。
 *
 * 场景：cc-watchdog.sh / runner.sh 在执行中被外部 kill（或宿主崩溃），
 * tasks/<taskId>/ 目录悬挂：可能有 task.json + claude.log + out/ 部分产物，
 * 但 result.json 缺失或 done.flag 位置异常。宿主重启后（cc-watchdog 恢复轮询）
 * 需对悬挂任务做「终态判定」，不得因产物缺失误报 done/failed。
 *
 * 判定规则（终态仅由根 done.flag 决定）：
 *   - done.flag 在任务根 → 终态完成（done）：runner 在写 result.json 前被杀
 *     （或已完成契约但未落 result）→ 补写 result.json 即恢复（state='done'，
 *     needsResultWrite=true 表示缺 result.json）。
 *   - done.flag 在 out/ → 契约违例（misplaced），即使 result.json done 也算失败态。
 *   - 无 done.flag + result.json 缺失 → in-progress（执行中被 kill / 尚未完成），
 *     恢复动作 = 重新执行 runner（state='in-progress'）。
 *   - result.json 在但结构非法 → 按 result-corrupt 处理。
 *
 * @param {object} options
 * @param {string} options.taskDir 任务根目录
 * @param {object} [options.task] 已校验 task 对象（读 outputDir / doneFlag）
 * @param {{exists: (p: string) => Promise<boolean>, readFile: (p: string) => Promise<string>}} [options.fsImpl]
 * @returns {Promise<{state: 'done'|'in-progress'|'failed', needsResultWrite: boolean,
 *   resultErrorCode: (string|null), doneFlagErrorCode: (string|null), reasons: string[]}>}
 */
export async function classifyTaskRecovery({ taskDir, task = {}, fsImpl = defaultFsImpl }) {
  const reasons = [];
  const outputDir = resolveOutputDir(taskDir, task.outputDir);
  const doneFlagName =
    typeof task.doneFlag === "string" && task.doneFlag.length > 0
      ? task.doneFlag
      : "done.flag";
  const rootFlagPath = path.join(taskDir, doneFlagName);
  const outFlagPath = path.join(outputDir, doneFlagName);
  const resultPath = path.join(taskDir, "result.json");

  const flagAtRoot = await fsImpl.exists(rootFlagPath);
  const flagInOut = await fsImpl.exists(outFlagPath);

  let resultErrorCode = null;
  let hasResult = false;
  let resultStatus = null;
  if (await fsImpl.exists(resultPath)) {
    hasResult = true;
    const text = await fsImpl.readFile(resultPath);
    const { ok, errorCode } = validateResultText(text);
    if (!ok) {
      resultErrorCode = errorCode || "result-invalid";
      reasons.push(`result.json: ${errorCode || "invalid"}`);
    } else {
      try { resultStatus = JSON.parse(text).status; } catch { /* 结构合法时必有 status */ }
    }
  } else {
    resultErrorCode = "result-missing";
  }

  // 位置违例恒报：done.flag 放 out/ = 契约破坏（无论终态/执行中）
  if (flagInOut && !flagAtRoot) {
    return {
      state: "failed",
      needsResultWrite: false,
      resultErrorCode,
      doneFlagErrorCode: "done-flag-misplaced",
      reasons: [...reasons, "done.flag misplaced (found under out/, expected at task root)"],
    };
  }

  if (flagAtRoot) {
    // 终态由根 done.flag 决定 → done；缺 result.json = runner 被杀于写 result 前 → 补写恢复
    return {
      state: "done",
      needsResultWrite: !hasResult,
      resultErrorCode,
      doneFlagErrorCode: null,
      reasons: hasResult ? reasons : [...reasons, "done.flag at root but result.json missing (runner killed before write) → needs result write"],
    };
  }

  // 无根 done.flag
  if (resultErrorCode === "result-missing") {
    // 无 result.json 无 done.flag = 执行中/被杀未完成（PENDING 语义，不误报 done-flag-missing）
    return {
      state: "in-progress",
      needsResultWrite: false,
      resultErrorCode: "result-missing",
      doneFlagErrorCode: null,
      reasons: ["no done.flag and no result.json → in-progress (runner killed mid-run) → re-run runner"],
    };
  }

  // result.json 结构非法 → failed + inspect
  if (resultStatus === null) {
    return {
      state: "failed",
      needsResultWrite: false,
      resultErrorCode,
      doneFlagErrorCode: null,
      reasons,
    };
  }

  // result.json 合法但无根 done.flag：
  //   - status=failed：runner 失败路径的正常结果（无 done.flag 属预期）→ failed，不误报 done-flag
  //   - status=done：result 宣告 done 但缺根 flag = 契约违例（正常流程 runner 只在根 flag 在时才写 done）
  if (resultStatus === "done") {
    return {
      state: "failed",
      needsResultWrite: false,
      resultErrorCode,
      doneFlagErrorCode: "done-flag-missing",
      reasons: [...reasons, "result.json status=done but root done.flag missing (contract violation)"],
    };
  }
  return {
    state: "failed",
    needsResultWrite: false,
    resultErrorCode,
    doneFlagErrorCode: null,
    reasons: reasons.length ? reasons : ["result.json status=failed (runner failure path)"],
  };
}

/** 恢复动作建议：由 classifyTaskRecovery 结果映射为 watchdog 可执行动作。 */
export function recoveryAction(classification) {
  if (!classification) return "none";
  if (classification.state === "done" && classification.needsResultWrite) return "write-result";
  if (classification.state === "done") return "none";
  if (classification.state === "in-progress") return "re-run";
  return "inspect"; // failed / 异常 → 人工或按 failed 记录
}

// ---- s2v5_4: v2 校验结果摘要（单行可读；面板/主 agent note 复用，不复制校验逻辑）----

/**
 * 把 validateResult 结果压缩成一行可读摘要（供面板展示 / step note / trace）。
 * @param {{ok: boolean, errors?: string[], details?: object}} v2r validateResult 输出
 * @returns {string} 形如 `v2 OK` 或 `v2 FAIL[result-missing]：<首错>`
 */
export function summarizeValidation(v2r) {
  if (!v2r) return "v2 校验未执行";
  if (v2r.ok) return "v2 OK（done.flag 根/result.json/产物齐）";
  const d = v2r.details || {};
  const code = d.resultErrorCode || d.doneFlagErrorCode || "invalid";
  const first = Array.isArray(v2r.errors) && v2r.errors.length ? v2r.errors[0] : "";
  return `v2 FAIL[${code}]${first ? `：${String(first).slice(0, 160)}` : ""}`;
}
