// V2 启动：替换 steps 为 V2 3 步，currentIteration=2（保留 iterations=3 与元数据）
import fs from 'node:fs'
const p = 'D:/dsh relay test/web-relay/experiments/expr-2026-08-26_15-17-07.steps.json'
const s = JSON.parse(fs.readFileSync(p, 'utf8'))
s.currentIteration = 2
s.status = 'open'
s.finalized = false
s.finalSummary = null
s.activeSteps = []
s.currentStep = null
s.steps = [
  {
    id: '1', title: '修复 dialog 降级链空响应缺陷',
    detail: '排查修复 dsh-web-relay lib/index.js callDialogModel（llm.stream provider=deepseek-official）的 chunk 解析与消息格式逻辑，确保 Gemini 429 限流时 dialog 节点正常返回 approved/rejected 评语，不直接穿透至 manual',
    review: true, reviewSpecified: true, importance: 'high', artifact_required: true,
    acceptance: '模拟 Gemini 异常场景，dialog 降级节点稳定输出 approved/rejected 及评语',
    artifacts: [], depends_on: [], parallel_group: null, alternatives: [], status: 'pending', notes: []
  },
  {
    id: '2', title: '首次解析性能二次优化',
    detail: '优化 step-value zstd 会话日志解析（多会话并行解析 + 帧级让出优化），无缓存首次解析降至 <5s',
    review: true, reviewSpecified: true, importance: 'medium', artifact_required: true, parallel_group: 'v2_perf',
    acceptance: '无缓存状态下大体积会话日志首次解析 <5s',
    artifacts: [], depends_on: [], alternatives: [], status: 'pending', notes: []
  },
  {
    id: '3', title: '版间门自动唤醒与持久化健壮性巩固',
    detail: '验证 writeStepState 补全 iterations/currentIteration 白名单后的读写逻辑，确保 V2→V3 跨版本切分时版间门控无需人工介入自动流转',
    review: true, reviewSpecified: true, importance: 'high', artifact_required: true,
    acceptance: '自动化断言用例通过，V2 全量过审后直接触发 V3 递进指针',
    artifacts: [], depends_on: [], parallel_group: null, alternatives: [], status: 'pending', notes: []
  }
]
fs.writeFileSync(p, JSON.stringify(s, null, 2) + '\n', 'utf8')
console.log('V2 已启动：currentIteration=2，3 步就绪')
