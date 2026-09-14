# cc 通道自治链条运维手册（OPS-CC-CHAIN）

> 归属：混合架构（CC-HYBRID）的运维层。设计目标是「人工缺席下也能推进」，
> 但**协议审核永不代批**——链条只做派发/机械验收/暂定提交，审核与版间门仍由主 agent 收口。
> 建立时间：2026-09-14（额度窗口约束下的自动化实践）。

## 1. 组件一览

| 组件 | 位置 | 作用 |
| --- | --- | --- |
| `cc-chain.mjs` | 工作区 `D:\dsh relay test` | 可续跑链条：派发→等结算→独立验收→暂定提交→续派；额度耗尽即暂停并存断点 |
| `cc-chains/*.mjs` | 同上 | 链条定义（ordered items：spec / taskId / planStepId） |
| `run-chain.cmd` | `D:\cc-tasks` | 计划任务包装器（`schtasks /TR` 对含空格路径解析失败，故用无空格包装器） |
| `deferred-dispatch.ps1` | `D:\cc-tasks` | 单任务延迟派发（探针确认额度恢复后入队）；链条启用后可不用 |
| `verify-cc-task.mjs` | 工作区 | 交付验收器：写入范围 / `node --check` / 全量测试 / 文件覆盖 / BOM+CRLF 五项 |
| `verify-v1-acceptance.mjs` | 工作区 | V1 验收证据包：对**真实计划**做门禁四态验证（默认拦截 / ALLOW_UNDECLARED 放行 / 突破重置 / 阈值拦截）+ 接线静态取证 + 测试计数 |
| `protocol-close-step.mjs` | 工作区 | 协议收口器：按权威状态机决定动作（pending→start→complete→auto-review；已 approved 直接退出），内置「未落地不得收口」守卫 |
| `cc-doctor.mjs` + `doctor-probe.sh` | 工作区 + `D:\cc-tasks` | 体检：进程/linger/自愈/心跳/认证/队列/额度/失败分类/链条断点 |
| `restart-test.sh` | `D:\cc-tasks` | 受控自愈测试（kill -9 → 验证 `Restart=always` 拉起 + 心跳续跑） |

## 2. 状态与日志文件

| 文件 | 含义 |
| --- | --- |
| `D:\cc-tasks\chain-state.json` | 链条断点：`index` / 每项 `status` / `commit.sha` / `completedAt` |
| `D:\cc-tasks\chain.log` | 链条逐事件日志（派发/结算/验收/提交/暂停） |
| `D:\cc-tasks\chain.lock` | 运行锁（30 分钟新鲜度），防计划任务重入；异常残留时手动删 |
| `D:\cc-tasks\chain-review-needed.md` | 链条跑完后的**待审清单**（协议审核入口） |
| `D:\cc-tasks\doctor.json` | 体检机器可读输出（`--json --out`，UTF-8 无 BOM） |
| `D:\cc-tasks\deferred\*.task.json` | 延迟派发暂存（**不入 queue**，避免 watchdog 取走必然失败的任务） |
| `D:\cc-tasks\cc-quota-state.json` | 配额耗尽状态（插件侧短路依据；由 relay 派发路径写入） |

## 3. 三条硬性不变量

1. **不代批**：链条不调 `/steps/update`、不写 approve。`importance=high` 且 `review:true` 的步骤禁止自审自批；
   必须走外部/降级链审核，并在 trace 留痕。
2. **提交是暂定的**：每项通过机械验收后提交一次（保持工作树干净，否则下一个任务的 `git status` 范围自检会被上一任务残留污染）。
   若协议审核打回，走 `/steps/rollback` 回到该步基线。
3. **幂等可重入**：重复触发安全（锁 + 断点 + 已完成守卫）；任一环节崩溃都不丢进度。

### 3.1 两道防假闭环守卫（2026-09-15 加入，均有回归验证）

- **验收器「改动可归属」判定**：工作树干净时，只在**最近 20 条提交**中按任务 id 匹配归属提交（链条提交信息固定含 taskId），
  匹配不到就报「无产物」并 REJECT。此前只看 HEAD，导致 (a) 任务提交之后又有人提交 docs/lesson 时，会把**别人的提交**算到本任务头上（误报越界）；
  (b) 反过来漏判已提交的任务。两条都在实测中出现过。
- **收口器「未落地不得收口」守卫**：`protocol-close-step.mjs` 通过链条定义做 `label↔planStepId↔taskId` 映射后查 chain-state；
  若该步状态不是 `accepted*`（如 `quota-paused` / `waiting` / `verify-rejected`），直接 exit 3 拒绝，
  避免「代码根本没落地却把步骤置为 review」的假闭环。
  注意：chain-state 里**只有 accepted 分支才写 planStepId**，因此不能只按 planStepId 匹配（否则暂停中的条目会被漏判、守卫被绕过）。

## 4. 运行手册

```powershell
# 体检（每轮先跑这个）
node "D:\dsh relay test\cc-doctor.mjs"                 # 人读
node "D:\dsh relay test\cc-doctor.mjs" --json --out D:\cc-tasks\doctor.json   # 机器可读

# 手动推进链条（计划任务之外的即时触发；额度可用时才会真正派发）
node "D:\dsh relay test\cc-chain.mjs" "cc-chains/v1-v3.mjs"

# 只跑一步（不入链条）：派发 → 等 → 验收
node "D:\dsh relay test\cc-dispatch.mjs" "cc-specs/v1-1.mjs"
node "D:\dsh relay test\verify-cc-task.mjs" v1-1-breakthrough-gate

# 自愈测试（队列必须为空，否则会杀掉执行中的 runner 子进程）
wsl.exe -e bash /mnt/d/cc-tasks/restart-test.sh
```

链条退出码：`0` 完成或跳过；`1` 验收 REJECT / 派发失败（需人工看报告）；`3` 额度暂停或等待结算超时（下次触发自动续跑）。

## 5. 失败分类（可审计）

`runner.sh` 失败时写 `result.json.errorCode`，插件侧 `classifyCcFailure` 与 `cc-stats` 消费；`cc-doctor` 按 `--since` 区分「分类生效后」与「历史遗留」：

| errorCode | 含义 | 处置 |
| --- | --- | --- |
| `cc-quota-exhausted` | 订阅会话额度耗尽（claude.log: `You've hit your session limit · resets …`） | 链条自动暂停，等恢复后续跑 |
| `cc-permission-denied` | 工具未授权导致 Claude 拒绝写入（如 `--allowedTools` 缺 `Edit`） | 修 runner 授权后重派 |
| `cc-timeout` | `timeout 900` 硬超时 | 拆小任务或提高上限 |
| `cc-failed` | 其他执行失败 | 看 `claude.log` |
| `v2-validate-failed` | 产物未过 v2 契约校验 | 按校验输出修产物 |

## 6. 已知边界（不要假装已解决）

- **宿主重启才生效**：插件代码（`lib/`）同步到运行副本后，需宿主 `request-restart` 才加载；
  链条走 WSL watchdog，不依赖宿主，故两者解耦。
- **计划任务是 `Interactive only`**：用户登出时不会触发；WSL 侧服务已 `linger=yes` 可开机自启。
- **额度与交互式使用共享**：同一订阅池，额度耗尽时链条只能等窗口重置（无法绕过）。
- **链条不覆盖**：协议审核/approve、版间门评估、`finalAcceptance` 声明、三版端到端终验——这些必须由主 agent 执行。
- **审计盲点**：机械验收只证明「范围/语法/测试/覆盖/编码」，不证明「实现是否符合意图」；意图层仍需审核环节。

## 7. 相关实证

- 探针 fail-open + 专用心跳：提交 `1113494`（真实目录实测 `{ok:true,reason:alive,stale:false}`）
- 自愈：`kill -9` 后 `NRestarts=1`、心跳续跑（`restart-test.sh`）
- 失败分类：`ccfix-20260914-stats` 记录 `errorCode=cc-quota-exhausted`（提交见同日 cc-stats 提交）
- 经验：lesson `L-2026-0914-061`（编码卫生）、`L-2026-0914-062`（配额分类与延迟派发）、`L-2026-0914-063`（status=failed ≠ 产物不合格）
