// V3 启动：终态收口（currentIteration=3；端到端验收 / 文档 / 0.4.0 正式发布）
import fs from 'node:fs'
const p = 'D:/dsh relay test/web-relay/experiments/expr-2026-08-26_16-05-00.steps.json'
const s = JSON.parse(fs.readFileSync(p, 'utf8'))
s.currentIteration = 3
s.status = 'open'
s.finalized = false
s.finalSummary = null
s.activeSteps = []
s.currentStep = null
s.architectNotes = 'V3 终态收口（外部 AI 缺席，主 agent 按终态方向执行）'
s.steps = [
  {
    id: '1', title: 'V3 端到端最终验收',
    detail: '真实数据复核：/summary 新字段（perModel/avgCostPerTurn/stats）+ tree + step-details，VM 冒烟 + i18n 对称',
    review: true, reviewSpecified: true, importance: 'high', artifact_required: true,
    acceptance: '全量 API 与新 UI 数据就绪，验证脚本全过',
    artifacts: [], depends_on: [], parallel_group: null, alternatives: [], status: 'pending', notes: []
  },
  {
    id: '2', title: '文档更新（前端 V1/V2）',
    detail: 'step-value README 补前端增强（多模型下钻/缓存指标/stats）、版本历史 v0.4.0',
    review: false, reviewSpecified: true, importance: 'low', artifact_required: true,
    acceptance: 'README 覆盖前端变更，版本 0.4.0',
    artifacts: [], depends_on: [], parallel_group: null, alternatives: [], status: 'pending', notes: []
  },
  {
    id: '3', title: '版本发布 0.4.0 与用户验收',
    detail: 'package.json 0.4.0 正式版（替代 v0.4.0-v* 预发布）、commit + tag v0.4.0 + push + 部署、唤醒用户最终验收',
    review: true, reviewSpecified: true, importance: 'high', artifact_required: true, depends_on: [1, 2],
    acceptance: 'v0.4.0 正式发布完成，用户重启后验收',
    artifacts: [], parallel_group: null, alternatives: [], status: 'pending', notes: []
  }
]
fs.writeFileSync(p, JSON.stringify(s, null, 2) + '\n', 'utf8')
console.log('V3 已启动：currentIteration=3，3 步就绪（Step 2 免审）')
