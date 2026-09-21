// V2 启动：主 agent 按候选方向代规划（外部 AI 缺席），currentIteration=2
import fs from 'node:fs'
const p = 'D:/dsh relay test/web-relay/experiments/expr-2026-08-26_16-05-00.steps.json'
const s = JSON.parse(fs.readFileSync(p, 'utf8'))
s.currentIteration = 2
s.status = 'open'
s.finalized = false
s.finalSummary = null
s.activeSteps = []
s.currentStep = null
s.architectNotes = 'V2 由主 agent 按候选方向代规划（外部 AI 缺席：Gemini 429 + dialog 兜底空）；恢复后补审'
s.steps = [
  {
    id: '1', title: 'i18n 全键对称与文案质量复核',
    detail: '逐键核对 zh/en 35 键对称与文案（byModel/modelShare/perTurnAvg/cacheHits/parseMs/cached 等），修正不一致',
    review: true, reviewSpecified: true, importance: 'high', artifact_required: false,
    acceptance: 'zh/en 键集合完全对称且文案语义一致',
    artifacts: [], depends_on: [], parallel_group: null, alternatives: [], status: 'pending', notes: []
  },
  {
    id: '2', title: 'UI 边界防护',
    detail: 'perModel 空数据/占比 0 保护、stats 字段缺失容错、长模型名省略（textOverflow）、占比条 0% 不渲染',
    review: true, reviewSpecified: true, importance: 'medium', artifact_required: true, parallel_group: 'v2_ui',
    acceptance: '异常数据不崩溃，展示优雅降级',
    artifacts: [], depends_on: [], alternatives: [], status: 'pending', notes: []
  },
  {
    id: '3', title: '前端状态清理与细节',
    detail: 'turn 展开/详情状态在会话切换后清理（防串数据）、CustomEvent 监听清理、刷新时 loading 态正确',
    review: true, reviewSpecified: true, importance: 'medium', artifact_required: true, parallel_group: 'v2_ui',
    acceptance: '会话切换无残留状态，监听无泄漏',
    artifacts: [], depends_on: [], alternatives: [], status: 'pending', notes: []
  },
  {
    id: '4', title: 'V2 验证与发布 v0.4.0-v2',
    detail: 'VM 冒烟 + i18n 对称断言 + 部署，tag v0.4.0-v2',
    review: true, reviewSpecified: true, importance: 'high', artifact_required: false, depends_on: [1, 2, 3],
    acceptance: '冒烟/断言通过，v0.4.0-v2 发布部署',
    artifacts: [], parallel_group: null, alternatives: [], status: 'pending', notes: []
  }
]
fs.writeFileSync(p, JSON.stringify(s, null, 2) + '\n', 'utf8')
console.log('V2 已启动：currentIteration=2，4 步就绪')
