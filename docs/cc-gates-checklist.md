# 四重门控清单 + 覆盖映射（stab1-4-gate-regression）

事故复盘：`buildReviewTask()` 曾把 `outputDir` 硬编码为绝对路径
`/mnt/d/cc-tasks/tasks/<id>/out`，违反 v2 schema（outputDir 必须是任务根内相对子路径），
导致每个 cc 审核任务在门控 ① 被 REJECT（`.invalid/` 累计 13 例，claude-code 审核成功率 0%）。
现已修复为相对 `out`，本任务补上"组合防线"回归测试，防止修复被静默回退。

## 门控清单

| # | 门控 | 实现位置 | 现有测试覆盖（修复前） | 本任务新增覆盖 | 残余缺口 |
|---|------|---------|----------------------|----------------|----------|
| ① 宿主派发前置 | `lib/index.js:3040`（`runCcReviewTask` 调 `validateTask(task)`，不合格拒绝派发） | `test/cc-channel.test.js:88` 只单独断言 `task.outputDir === 'out'`，未断言整体通过 `validateTask` | `gate-regression.test.mjs`：`validateTask(buildReviewTask(...))` 组合断言 ok===true；6 类畸形任务（绝对 outputDir / `..` 越界 / taskId 非法×2 / title 空 / prompt 空 / kind 非法 / expectArtifacts 越界）被拒；kind 缺失兼容性 | `runCcReviewTask` 本体（含 `buildReviewTask`→`validateTask`→写队列的完整调用链）无单测，仅静态校验器有覆盖 |
| ② 宿主 poll 后 | `lib/index.js:3056`（`validateResult`：done.flag 根 / result.json / review 默认产物 `out/review.md`；`lib/index.js:3060-3066` 校验器异常已收紧为显式失败——两态不变式） | `test/task-schema-v2.test.mjs` 覆盖 `validateResult` 主要路径 | `gate-regression.test.mjs`：done.flag misplaced（out/）→ `doneFlagErrorCode==='done-flag-misplaced'`；无 result.json 无 done.flag（执行中）→ PENDING 语义不误报 `done-flag-missing`；result.json 已写出但 done.flag 双缺 → 真异常 `done-flag-missing`；完整合规态整体通过；`validateResultText` 的 `result-invalid`/`result-corrupt` errorCode | `lib/index.js:3060-3066` 的"校验器异常显式失败"分支（catch 块）无单测，仅逻辑走读确认 |
| ③ cc-watchdog 侧 | `D:\cc-tasks\cc-watchdog.sh:25`（dispatch 前 `node "$VALIDATOR" validate-task "$q"`，非法任务隔离到 `queue/.invalid/`） | 无自动化测试（bash 脚本） | 无（本任务范围仅 2 个 Node 文件，未新增 bash 测试） | **无自动化测试**，只能 WSL 手工/集成验证 |
| ④ runner 完成侧 | `D:\cc-tasks\runner.sh:38`（`node "$VALIDATOR" validate-result "$PWD/$TD"` 不合格 → 覆写 `failed`，errorCode=`v2-validate-failed`） | 无自动化测试（bash 脚本） | 无（同上） | **无自动化测试**，只能 WSL 手工/集成验证 |

## 最小验证命令（人工执行，覆盖 ③④ 缺口）

```bash
VALIDATOR=/mnt/d/dsh-web-relay/scripts/task-schema-cli.mjs   # cc-watchdog.sh:10 / runner.sh:33 同源定义

# ③ cc-watchdog.sh 门控：构造一个非法 task（绝对 outputDir）投入 queue/，
#   确认被移入 queue/.invalid/ 而非 tasks/
node "$VALIDATOR" validate-task /path/to/malformed.task.json; echo "exit=$?"

# ④ runner.sh 门控：在某个 tasks/<id>/ 下手工构造不合格产物（如 done.flag 放 out/），
#   直接调用同一 CLI 校验器观察 validate-result 判定
node "$VALIDATOR" validate-result /mnt/d/cc-tasks/tasks/<id>; echo "exit=$?"
cat /mnt/d/cc-tasks/tasks/<id>/validate.out   # runner.sh 覆写 failed 前的校验输出
```

---

## 附录：bash 侧门控自动化测试与缺陷修复（stab2_2，2026-09-10）

### 测试脚本
`scripts/verify-cc-gates.sh`（WSL 执行：`bash scripts/verify-cc-gates.sh`）——在 `/tmp` 沙箱内
真实调用 VALIDATOR 并逐行复现两处 bash 胶水逻辑；开头有 **drift-guard**：先 `grep -F` 生产脚本
确认门控行仍与测试假设一致，生产脚本一旦变更会先失败提示"复现可能已过期"。

最近一次运行：**PASS=16 FAIL=0 KNOWN_ISSUE=0**（EXIT_CODE=0）。

覆盖：③ 非法 task（outputDir 绝对路径）被拒 + 隔离进 `queue/.invalid/` + 合法 task 放行派发；
④ done.flag 误放 out/ 被拒（`doneFlagErrorCode=done-flag-misplaced`）+ expectArtifacts 缺失被拒
+ 合规产物通过 + 覆写字段核验；软模式（VALIDATOR/node 缺失时短路放行不报错）。
诚实标注：`cc-watchdog.sh` 常驻循环与 `runner.sh` 真实 claude 执行路径未端到端跑（理由见
cc 任务 `stab2-2-bash-gates` 的 notes.md）。

### 测试发现的真实缺陷（已修复）
**④ runner.sh 覆写 failed 的 result.json 曾是非法 JSON**（原第 40 行）：
```bash
VERR=$(head -c 300 "$TD/validate.out" | tr '\n' ' ')
echo '{"status":"failed",...,"reason":"'"$VERR"'"}' > "$TD/result.json"   # ← VERR 是 JSON（含双引号），未转义
```
**后果**：④门控的意图是"坏结果不逃逸"，但它写出的 failed result **本身坏 JSON** →
宿主 `pollTaskResult` 的 `JSON.parse` 失败会 `continue` 继续轮询 → **白等到超时**（而非立即感知
失败），门控效果被自身缺陷抵消。

**修复**（runner.sh 现第 44 行）：改用 node 安全序列化（同分支上方已保证 node 可用）：
```bash
node -e 'const fs=require("fs");fs.writeFileSync(process.argv[1],JSON.stringify({status:"failed",start:process.argv[2],end:process.argv[3],exit:0,errorCode:"v2-validate-failed",reason:process.argv[4]},null,2))' "$TD/result.json" "$START" "$END" "$VERR"
```

**验证**：`bash scripts/verify-cc-gates.sh` → ④ 覆写产物 JSON 合法性 PASS；另用对照实验确认
旧拼接方式产出的 JSON 确实非法（`Expected ',' or '}' after property value`）。
