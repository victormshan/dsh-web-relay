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

1. **不代批**：链条自身不写 approve；启用 `--close-after-accept` 时，收口走 `/steps/auto-review` 的**独立审核通道**取裁决，
   并受 `--min-reviewer` 强度门约束（弱通道可用时停止等人）。`importance=high` 且 `review:true` 的步骤永远不由实施方自批。
2. **提交是暂定的**：每项通过机械验收后提交一次（保持工作树干净，否则下一个任务的 `git status` 范围自检会被上一任务残留污染）。
   若协议审核打回，走 `/steps/rollback` 回到该步基线。
3. **幂等可重入**：重复触发安全（锁 + 断点 + 已完成守卫）；任一环节崩溃都不丢进度。

### 3.1 闭环开关与审核强度门（2026-09-15 加入）

链条默认止步于 `accepted-awaiting-review`（等人收口）。启用闭环后，每步在「验收 + 提交」之后自动执行协议收口：

```powershell
node "D:\dsh relay test\cc-chain.mjs" "cc-chains/v1-v3.mjs" --close-after-accept --min-reviewer web-gemini
```

- **不是自批**：收口器只做 `start → complete(带证据) → /steps/auto-review`，裁决由**独立审核通道**给出；
  `--min-reviewer` 设置可接受的最低通道强度（external/swarm=4 > web-gemini=3 > dialog=1 > manual=0）。
  默认 `web-gemini`：接受 external / Swarm 双角色盲审 / web-gemini 网页通道；**拒绝 dialog 兜底与 manual**（停止等人，exit 5）。
- **自审守卫（独立于强度）**：被收口的步骤若由 cc 实现（链条项存在即视为 cc 实现），则 `reviewedBy=cc/claude` 的裁决
  **一律拒绝**（exit 5，`error=self-review-rejected`）——即便其强度数值与 web-gemini 同级，也不允许实施方审自己。
  实测用例：external/swarm/web-gemini 接受；cc（自审）/dialog/manual 停止。
- 当前通道实测（2026-09-15 00:38 取自 relay `/health-check`）：`bridge.ok=true`（web-gemini 在线），
  step 1 的裁决实测为 `reviewedBy=external`（强度 4）。
- **停止语义**（链条遇任一种即停，状态写进 `chain-state.json`）：
  | chain 状态 | 触发条件 |
  | --- | --- |
  | `review-rejected` | 审核未通过（rejected / 仍在 review，退出码 1） |
  | `closure-blocked` | 该步在链条中未落地（守卫拦截，退出码 3） |
  | `reviewer-too-weak` | 只有弱于 `--min-reviewer` 的通道可用（退出码 5） |
  | `self-review-rejected` | 裁决来自 cc/claude 而本步由 cc 实现（自审，退出码 5） |
  | `closure-timeout` | 收口调用超过 20 分钟（外部审核卡住；否则链条会表现为「静默停摆」） |
  | `closure-failed` | 收口过程其它异常 |
- **打回后的恢复路径**：收口器遇到 `rejected` 会**先 `action=reopen` 再重新 complete + auto-review**（否则 complete/review 都会因状态不符被拒）；
  reopen 失败则报 `reopen-failed` 并停止。人工恢复同样用 `POST /steps/update {action:'reopen'}`；修正后的实现需重新走一次机械验收再收口。
- **状态写入顺序（踩过的坑）**：链条必须**先写 `accepted-awaiting-review` 再调用收口器**——收口器的前置守卫会读 chain-state
  判断「该步是否已落地」，若先收口后写状态，守卫读不到 accepted 记录会直接拒绝收口（exit 3）。
- 通过后 chain 状态为 `approved-and-closed`，并记录 `closure.reviewedBy` 供审计。
- **断点续跑清理逻辑可离线自测**（无需额度）：`node "D:\dsh relay test\cc-chain.mjs" --selftest-clear`
  验证两条语义——① 上次已结算（有 `result.json`）→ 归档到 `tasks/_retry-archive/` 并移除该目录（返回 true）；
  ② 上次仍在运行（无 `result.json`）→ **不得清理**（返回 false，继续等待）。2026-09-15 01:56 实测 PASS，无残留。

### 3.2 两道防假闭环守卫（2026-09-15 加入，均有回归验证）

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

## 7. 宿主重启（让插件 lib/ 新代码在运行中生效）

链条走 WSL watchdog，**不依赖宿主**；重启期间链条第 N 次调度会因锁或额度探针自然跳过，不会误判为失败。
但 relay 侧的新行为（如 `/health-check` 的 `ccWatchdogWarning`、突破度门禁、`/ask` 审计注入）只有重启后才生效。

```powershell
# 1) 三副本同步（改动文件逐个哈希比对；docs/lib/package.json 均需同步）
#    目标：profiles\web\node_modules\dsh-web-relay、D:\DSH\dsh-web-relay、D:\dsh-web-relay-standalone

# 2) 请求重启（只写请求文件后立即返回——由独立进程树的 watchdog 执行，避免工具进程自杀）
node "D:\dsh-web-relay\bin\watchdog.mjs" request-restart 5

# 3) 重启后核验
#    GET http://127.0.0.1:3080/dsh-web-relay/health-check → bootId 变化；应出现新增审计字段；version 仍为 4.9.7
```

- 面板白屏≠故障：先清该站点数据再判断（lesson L-2026-0913-057）。
- **重启后必跑工具链回归**（一条命令覆盖 11 项，确认 relay 路由契约未漂移、守卫与断点语义未变）：
  ```powershell
  node "D:\dsh relay test\regression-post-restart.mjs"      # 期望 RESULT: 11/11 通过（前置条件：仓库工作树干净）
  ```
  覆盖：体检 / 验收器（已提交=ACCEPT、未产出=REJECT）/ 收口器（已批准=noop、未落地=拒绝 exit 3）/
  V1 验收与版间门 / 声明器探测（端点未落地=exit 4）/ 规格模板扫描 / 链条探针模式（无副作用）/ 规格门控 / 断点清理自测。
  2026-09-15 实测：重启（bootId `mu00fi5u-ac150922` → `mu1jg0z6-f86aa1cc`）后 **11/11 通过**。
  **前置条件**：仓库工作树必须干净——`verify-cc-task` 以**工作树**判「改动可归属」，脏树会把无关的未提交文件判成越界
  （实测可复现：造一个 `.dirty-probe` → `[FAIL] 越界` → REJECT；移除后恢复 ACCEPT）。该现象曾造成一次无法归因的「9/11」假失败，
  现套件在脏树时会打印 `[PRECONDITION]` 告警。
  **套件不得有副作用**：链条相关用例必须用 `cc-chain.mjs --probe-only`（只探针、不派发、不改状态、不留锁）——
  此前误用整链运行做「干跑」，在探针偶然返回 OK 时会**真的派发任务**（2026-09-15 02:00 实际发生：派发 → 4 秒后 cc-quota-exhausted → 暂停）。
- 路由方法备忘（避免误报故障）：`/steps`、`/health-check` 为 **GET**；`/steps/update`、`/steps/auto-review`、`/steps/restructure`、`/trace` 为 **POST**——
  对 POST 路由发 GET 会得到 400（本项目曾因此误判 `/trace` 损坏）。
- 失败回滚：查 `bin/` 下的 watchdog 日志；必要时手工重启宿主，插件代码在磁盘上已是新版，不影响回滚到旧提交（`git revert`）。

## 8. 相关实证

- 探针 fail-open + 专用心跳：提交 `1113494`（真实目录实测 `{ok:true,reason:alive,stale:false}`）
- 自愈：`kill -9` 后 `NRestarts=1`、心跳续跑（`restart-test.sh`）
- 失败分类：`ccfix-20260914-stats` 记录 `errorCode=cc-quota-exhausted`（提交见同日 cc-stats 提交）
- 经验：lesson `L-2026-0914-061`（编码卫生）、`L-2026-0914-062`（配额分类与延迟派发）、`L-2026-0914-063`（status=failed ≠ 产物不合格）
