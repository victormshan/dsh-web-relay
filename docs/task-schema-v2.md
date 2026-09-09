# cc-task-schema v2（三方任务契约库）

> 版本：s2v2（AutoIteration expr-2026-09-09_12-30-09 V2/6）
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
node scripts/task-schema-cli.mjs report <taskDir|parentDir>    # 单任务或父目录批量；末尾参数 'md' 输出 Markdown 表
```

## 4b. ErrorCode 分类（s2v2）

- 导出 `RESULT_ERROR_CODES = [result-missing, result-corrupt, result-invalid]`、`DONE_FLAG_ERROR_CODES = [done-flag-misplaced, done-flag-missing]`
- `validateResultText`/`validateResult` 返回 `errorCode`（null=合法）；errors 带 `[errorCode]` 前缀
- `validateResult.details` 增 `resultErrorCode / doneFlagErrorCode`

## 5. 集成

- **cc-channel 派发前置校验**（lib/index.js runCcReviewTask）：buildReviewTask 产物经 `validateTask`，不合格拒绝派发（`cc 任务契约校验失败（v2）`）
- **cc-watchdog 侧门控**（s2v2_2，D:\cc-tasks/cc-watchdog.sh）：dispatch 前调 `task-schema-cli validate-task`，非法任务隔离到 `queue/.invalid/` 不派发（validator=on 日志）；校验器/node 缺失 = 软模式跳过
- **runner 语义对齐**：done.flag 必须在任务根（Claude 任务契约已明示；runner 失败检测不变）
- **acceptanceScript**：CLI validate-result 内联执行（task.acceptanceScript 存在 → runAcceptanceScript，exit 0 才 ok）
- **v1 向后兼容**：缺 kind 容错 unknown、缺省字段按 v1 语义——旧 task.json 不受影响

## 6. 测试

- `test/task-schema-v2.test.mjs`：35 用例（fake fs/exec，跨平台 path.join）——validateTask、validateResultText、validateResult（done.flag/errorCode/expectArtifacts/custom outputDir）、runAcceptanceScript、errorCode 分类 6 例
- 全量基线：275（独立仓 victormshan/dsh-web-relay）

## 7. 升级兼容矩阵

| 场景 | v1 | v2 |
|---|---|---|
| done.flag 放 out/ | runner 误判 failed（事故）| validateResult 报 misplaced 硬拦截 + cc-watchdog 侧门控 |
| result.json 结构 | status/reason 自由 | status 枚举 + exit + failed-reason + **errorCode 分类** |
| 期望产物 | 无 | expectArtifacts 存在性硬校验 |
| 验收 | Claude 自判 | acceptanceScript 可选执行钩子（CLI 内联）|
| 派发入口 | 无校验 | cc-channel validateTask 前置 + cc-watchdog REJECT 隔离 |
