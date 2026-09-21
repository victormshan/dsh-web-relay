// V3 启动：终态收口（currentIteration=3，外部 AI 预告方向：端到端验收 / 文档 / 0.3.0 发布+部署+用户验收）
import fs from 'node:fs'
const p = 'D:/dsh relay test/web-relay/experiments/expr-2026-08-26_15-17-07.steps.json'
const s = JSON.parse(fs.readFileSync(p, 'utf8'))
s.currentIteration = 3
s.status = 'open'
s.finalized = false
s.finalSummary = null
s.activeSteps = []
s.currentStep = null
s.steps = [
  {
    id: '1', title: 'V3 端到端最终验收',
    detail: '真实会话全量 API 复核：/summary 性能（首次<10s、缓存<500ms）+ perModel/avgCostPerTurn 新字段 + step-details 定位',
    review: true, reviewSpecified: true, importance: 'high', artifact_required: true,
    acceptance: '全量 API 正常，性能指标达标，新字段完整',
    artifacts: [], depends_on: [], parallel_group: null, alternatives: [], status: 'pending', notes: []
  },
  {
    id: '2', title: 'step-value 文档补齐',
    detail: 'README/说明书：持久化缓存、MODEL_PRICES 扩充、perModel 维度、性能实测数据、版本历史',
    review: false, reviewSpecified: true, importance: 'low', artifact_required: true,
    acceptance: '文档覆盖 V1/V2 全部变更，版本号一致 0.3.0',
    artifacts: [], depends_on: [], parallel_group: null, alternatives: [], status: 'pending', notes: []
  },
  {
    id: '3', title: '版本发布 0.3.0 与用户验收',
    detail: 'package.json 0.2.0→0.3.0（正式版，替代 v0.2.0-v* 预发布）、commit + tag v0.3.0 + push、部署安装目录、唤醒用户最终验收',
    review: true, reviewSpecified: true, importance: 'high', artifact_required: true,
    acceptance: '0.3.0 发布完成（tag v0.3.0 + 部署），用户重启后最终验收',
    artifacts: [], depends_on: [1], parallel_group: null, alternatives: [], status: 'pending', notes: []
  }
]
fs.writeFileSync(p, JSON.stringify(s, null, 2) + '\n', 'utf8')
console.log('V3 已启动：currentIteration=3，3 步就绪（Step 2 免审）')
