# cc-task-schema v2（三方任务契约库）

> 版本：s2v5（AutoIteration expr-2026-09-09_12-30-09 V5/6）
> 用途：DSH 主 agent → Claude Code（D:\cc-tasks 派发）任务单契约的**严格机器校验**——修 v4.9 事故（done.flag 误放 out/ 致 runner 误判 failed）。

## 1. task.json 字段规范（TASK_SCHEMA_V2）

| 字段 | 类型 | 必填 | 规则 |
|---|---|---|---|
| taskId | string | ✅ | `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`（sanitizeTaskId 兼容）|
| kind | enum | 缺省容错 | `implement\|review\|understand`；缺失按 v1 语义容错为 `unknown`（不报错）|
| title | string | ✅ | 非空 |
| prompt | string | ✅ | 非空 |
| refs | string[] | 可选 | 默认 `[]` |
| acceptance | string | 可选 | 验收标准（提示性）|
| outputDir | string | 可选 | 任务目录内相对子路径（默认 `out`）；**禁绝对路径/`..` 越界** |
| expectArtifacts | string[] | 可选 | 相对 outputDir 的期望产物——运行时校验存在性 |
| doneFlag | string | 可选 | 默认 `done.flag`；**位置必须在任务根**（task.json 同目录），禁放 outputDir/out 内 |

## 2. result.json 结构化（v1 仅 status/reason）

```json
{ "status": "done|failed", "start": "ISO", "end": "ISO", "exit": 0,
  "errorCode": "timeout|exit-nonzero|done-flag-missing|…", "reason": "failed 时必填" }
```

## 3. 校验 API（lib/task-schema-v2.mjs）

- `validateTask(task)` → `{ok, errors[]}`：契约静态校验（taskId/kind/title/prompt/outputDir 越界/expectArtifacts 元素）
- `validateResultText(resultJson)` → `{ok, errors[]}`：result 结构（status 枚举/exit 整数/failed 需 reason）
- `validateResult({taskDir, task, fsImpl})` → `{ok, errors[], details{doneFlagAtRoot, resultPending, artifacts[]}}`：
  - **done.flag 根位置硬拦截**：根缺失但 out/ 存在 → `misplaced: expected at task root <dir>/done.flag, found under out/`（修 v4.9 事故）
  - result.json 结构校验（`result.json: ` 前缀）
  - expectArtifacts 逐项存在性（`missing artifact: <name>`）
- `runAcceptanceScript({script, cwd, exec})` → `{ok, error?}`：可选验收脚本钩子（exit 0 = ok）
- 全部 IO 经注入 `fsImpl`/`exec`（默认 node:fs/promises / execFileSync）——fake 单测

## 4. CLI（scripts/task-schema-cli.mjs）

```sh
node scripts/task-schema-cli.mjs validate-task <task.json>     # exit 0/1/2
node scripts/task-schema-cli.mjs validate-result <taskDir>     # done.flag 根 + result.json(errorCode) + expectArtifacts + acceptanceScript
node scripts/task-schema-cli.mjs report <taskDir|parentDir>    # 单任务或父目录批量；末尾参数 'md' 输出 Markdown 表；'--verbose' 附完整明细
node scripts/task-schema-cli.mjs recover <tasksParentDir>      # s2v5_1: watchdog 崩溃/重启恢复——悬挂任务补 result / 列 re-run
```

## 4b. ErrorCode 分类（s2v2）

- 导出 `RESULT_ERROR_CODES = [result-missing, result-corrupt, result-invalid]`、`DONE_FLAG_ERROR_CODES = [done-flag-misplaced, done-flag-missing]`
- `validateResultText`/`validateResult` 返回 `errorCode`（null=合法）；errors 带 `[errorCode]` 前缀
- `validateResult.details` 增 `resultErrorCode / doneFlagErrorCode`

## 4c. report 分组汇总（s2v5_2）

- 批量 report 默认输出 `summary`：按状态分组（done/pending/failed）计数 + `firstPending/firstFailed`（每组首条任务的 task/errorCode/firstError）——mixed 批次一眼可读；`--verbose` 附完整 `results` 明细。
- 状态归类：ok → done；`resultPending`（result.json 缺失）→ pending；其余 → failed。

## 5. 集成

- **cc-channel 派发前置校验**（lib/index.js runCcReviewTask）：buildReviewTask 产物经 `validateTask`，不合格拒绝派发（`cc 任务契约校验失败（v2）`）
- **cc-watchdog 侧门控**（s2v2_2，D:\cc-tasks/cc-watchdog.sh）：dispatch 前调 `task-schema-cli validate-task`，非法任务隔离到 `queue/.invalid/` 不派发（validator=on 日志）；校验器/node 缺失 = 软模式跳过
- **runner 语义对齐**：done.flag 必须在任务根（Claude 任务契约已明示；runner 失败检测不变）
- **acceptanceScript**：CLI validate-result 内联执行（task.acceptanceScript 存在 → runAcceptanceScript，exit 0 才 ok）
- **v1 向后兼容**：缺 kind 容错 unknown、缺省字段按 v1 语义——旧 task.json 不受影响

## 6. 测试

- `test/task-schema-v2.test.mjs`：35 用例（fake fs/exec，跨平台 path.join）——validateTask、validateResultText、validateResult（done.flag/errorCode/expectArtifacts/custom outputDir）、runAcceptanceScript、errorCode 分类 6 例
- 全量基线：280（独立仓 victormshan/dsh-web-relay）
- s2v3 增补：review 任务默认产物（kind=review 无 expectArtifacts → out/review.md）+ PENDING 语义（无 result.json=执行中，done.flag 双缺不误报；misplaced 恒报）+ runner.sh 完成侧 validate-result 门控（v2-validate-failed）

## 7. 升级兼容矩阵

| 场景 | v1 | v2 |
|---|---|---|
| done.flag 放 out/ | runner 误判 failed（事故）| validateResult 报 misplaced 硬拦截 + cc-watchdog 侧门控 |
| result.json 结构 | status/reason 自由 | status 枚举 + exit + failed-reason + **errorCode 分类** |
| 期望产物 | 无 | expectArtifacts 存在性硬校验 |
| 验收 | Claude 自判 | acceptanceScript 可选执行钩子（CLI 内联）|
| 派发入口 | 无校验 | cc-channel validateTask 前置 + cc-watchdog REJECT 隔离 |


## 8. 派发纪律与自动消费（s2v4）

- **refs 用当前源路径**：派发 Claude 任务时 task refs/prompt 引用的源文件路径必须是**当前仓库路径**（s2v2-errorcode 教训：refs 写了迁移前旧路径 /mnt/d/DSH/... 致 Claude 取不到源、产出偏离现状——派发前核对 DSH_RELAY_REPO 当前值）。
- **主 agent poll 自动消费**：cc 任务 poll 完成（done）后 index.js runCcReviewTask 自动 validateResult——done.flag 根/result.json/review 默认产物 out/review.md 不合格即拦（不进 approved）；校验器异常软跳过（readReviewOut 兜底）。
- **install 契约对齐**：install-new-env 产物（task.json 契约形态）与 v2 门控一致（kind/taskId/prompt 必填等）。

## 9. watchdog 崩溃/重启恢复（s2v5_1）

- **场景**：cc-watchdog.sh / runner.sh 在执行中被外部 kill（或宿主崩溃），tasks/<id>/ 悬挂——result.json 缺失或 done.flag 位置异常。
- **分类 API**：`lib/task-schema-v2.mjs` 新增 `classifyTaskRecovery({taskDir, task, fsImpl})` → `{state: 'done'|'in-progress'|'failed', needsResultWrite, resultErrorCode, doneFlagErrorCode, reasons}` + `recoveryAction(cls)` → `write-result | re-run | none | inspect`：
  - **done.flag 根在** → 终态 done（契约完成）；若 result.json 缺失（runner 写 result 前被杀）→ `needsResultWrite=true` → **补写 result.json {status:done}** 即恢复。
  - done.flag 在 out/（misplaced）→ failed（契约违例恒报，不自动改）。
  - **无 done.flag 无 result.json** → in-progress（执行中被杀/未完成）→ **re-run runner**（不误报 done/failed——PENDING 语义跨重启稳定）。
  - result.json 结构非法 → failed + inspect；status=done 但缺根 flag → done-flag-missing 违例。
- **CLI recover**：`task-schema-cli.mjs recover <tasksParentDir>` 批量执行恢复动作——补写 result（recovered:true 标记）/列 re-run/保留 untouched，输出 JSON 汇总。
- **测试**：`test/cc-recovery.test.mjs` 2 例（真实临时目录）+ `test/task-schema-v2.test.mjs` 恢复分类 5 例（fake fs）。

## 10. cc-watchdog REJECT 隔离复检闭环（s2v5_3）

- **根因修复（outputDir 相对化）**：`lib/cc-channel.js buildReviewTask` 的 `outputDir` 曾硬编码绝对路径 `/mnt/d/cc-tasks/tasks/<id>/out`——违反 v2 schema（outputDir 必须是任务根内相对子路径），导致**每个 cc 审核任务都被 validate-task 门控 REJECT**（.invalid/ 13 例实证）。现改为相对 `out`；绝对落盘路径（/mnt/d/...）仅在 prompt 里提示 Claude，不进 task.json 字段。任务契约从此可正常过 v2 门控。
- **CLI invalid 复检闭环**（人工处理 REJECT 隔离任务 queue/.invalid/）：
  ```sh
  node scripts/task-schema-cli.mjs invalid list <ccTasksRoot>        # 列出隔离任务 + reject 原因（validate-task 重放）
  node scripts/task-schema-cli.mjs invalid revalidate <ccTasksRoot> <file>  # 修复后重跑（exit 0=可恢复）
  node scripts/task-schema-cli.mjs invalid recover <ccTasksRoot> <file>     # revalidate 通过 → 移回 queue/ 重入队
  node scripts/task-schema-cli.mjs invalid approve <ccTasksRoot> <file>     # 人工确认废弃 → 打 .approved 标记（幂等）
  node scripts/task-schema-cli.mjs invalid clean <ccTasksRoot> [file]       # 仅删已 approved；未 approved 拒删（exit 1）
  ```
- **纪律**：REJECT 隔离的任务不自动回收；人工复检三选一——修复后 revalidate+recover 重入队 / approve 废弃后 clean / 保留待查。cc-watchdog 只负责 REJECT 隔离，不自动删。
- **测试**：`test/cc-recovery.test.mjs` invalid 复检 2 例（真实临时目录：list 原因/revalidate/recover 重入队/未 approved 拒删/approve 后 clean）。
