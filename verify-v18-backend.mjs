// verify-v18-backend.mjs — v1.8 backend smoke test for dsh-web-relay (protocol v1.8 / plugin 1.2.0)
// Run: node "D:\dsh relay test\verify-v18-backend.mjs"
// Exits 0 on success, 1 on any failed assertion.

import { readFileSync } from 'node:fs'

const INDEX = 'D:/DSH/dsh-web-relay/lib/index.js'
const PKG = 'D:/DSH/dsh-web-relay/package.json'

let failures = 0
let total = 0
const check = (name, cond, extra = '') => {
  total += 1
  if (cond) {
    console.log(`  ✓ ${name}`)
  } else {
    failures += 1
    console.error(`  ✗ ${name}${extra ? ' — ' + extra : ''}`)
  }
}

// ---------------------------------------------------------------------------
// 1) normalizeStep reviewSpecified behavior (replicated — normalizeStep lives
//    inside apply() and is not exported; logic copied verbatim from lib/index.js).
// ---------------------------------------------------------------------------
function normalizeStep(raw, index) {
  const id = raw && raw.id != null ? raw.id : raw && raw.stepId != null ? raw.stepId : (index + 1)
  return {
    id: String(id),
    title: String((raw && (raw.title || raw.name)) || `步骤 ${id}`).trim(),
    detail: String((raw && (raw.detail || raw.description)) || '').trim(),
    review: !raw || raw.review !== false,
    reviewSpecified: Boolean(raw && typeof raw.review === 'boolean'),
    acceptance: String((raw && (raw.acceptance || raw.accept)) || '').trim(),
    artifacts: Array.isArray(raw && raw.artifacts) ? raw.artifacts.map(String) : [],
    depends_on: Array.isArray(raw && raw.depends_on)
      ? raw.depends_on.map((d) => String(d))
      : Array.isArray(raw && raw.dependsOn)
        ? raw.dependsOn.map((d) => String(d))
        : [],
    parallel_group: (raw && raw.parallel_group) ? String(raw.parallel_group) : null,
    alternatives: Array.isArray(raw && raw.alternatives) ? raw.alternatives : [],
    importance: (raw && raw.importance === 'high' || raw && raw.importance === 'medium' || raw && raw.importance === 'low') ? raw.importance : null,
    status: 'pending',
    notes: []
  }
}

console.log('[1] normalizeStep reviewSpecified 断言')
{
  const a = normalizeStep({ id: 1, title: 'x' }, 0)            // review 缺省
  const b = normalizeStep({ id: 2, title: 'y', review: false }, 1) // review:false
  const c = normalizeStep({ id: 3, title: 'z', review: true }, 2)  // review:true
  check('review 缺省 → reviewSpecified === false', a.reviewSpecified === false, JSON.stringify(a.reviewSpecified))
  check('review 缺省 → review === true (v1.7 语义保留)', a.review === true)
  check('review:false → reviewSpecified === true', b.reviewSpecified === true, JSON.stringify(b.reviewSpecified))
  check('review:false → review === false', b.review === false)
  check('review:true → reviewSpecified === true', c.reviewSpecified === true, JSON.stringify(c.reviewSpecified))
  check('review:true → review === true', c.review === true)
  check('importance 缺省 → null（普通）', normalizeStep({ id: 4, title: 'w' }, 3).importance === null)
  check('importance=low 透传', normalizeStep({ id: 5, title: 'v', importance: 'low' }, 4).importance === 'low')
  check('importance 非法值 → null', normalizeStep({ id: 6, title: 'u', importance: 'bogus' }, 5).importance === null)
}

// ---------------------------------------------------------------------------
// 2) Dynamic import of the real module (exports are module-level constants).
// ---------------------------------------------------------------------------
console.log('[2] index.js 动态导入 + 导出常量断言')
let mod = null
try {
  mod = await import('../DSH/dsh-web-relay/lib/index.js')
  check('动态 import index.js 成功', mod !== null)
} catch (err) {
  check('动态 import index.js 成功', false, String(err && err.message || err))
}

if (mod) {
  check('导出 WEB_RELAY_PROTOCOL_VERSION_V18 === "v1.8"', mod.WEB_RELAY_PROTOCOL_VERSION_V18 === 'v1.8', String(mod.WEB_RELAY_PROTOCOL_VERSION_V18))
  check('导出 WEB_RELAY_PROTOCOL_VERSION_V17 保留 === "v1.7"', mod.WEB_RELAY_PROTOCOL_VERSION_V17 === 'v1.7')
  const zh = mod.WEB_RELAY_PROTOCOL || ''
  const en = mod.WEB_RELAY_PROTOCOL_EN || ''
  const skill = mod.WEB_RELAY_EXTERNAL_AI_SKILL || ''
  const skillEn = mod.WEB_RELAY_EXTERNAL_AI_SKILL_EN || ''
  check('协议文本含混合模式条目', zh.includes('混合模式协议（v1.8）'))
  check('协议文本含 review:false 硬开关条目', zh.includes('review:false 硬开关（v1.8'))
  check('协议文本含 restructure 条目', zh.includes('steps/restructure'))
  check('协议文本含批量原子打回条目', zh.includes('批量审核原子打回（v1.8）'))
  check('协议文本含 5 段模板缺省对齐条目', zh.includes('5 段模板缺省对齐（v1.8）'))
  check('协议版本历史行 v1.8 存在', zh.includes('v1.8：混合模式（importance 驱动执行/审核分工）'))
  check('英文协议含 v1.8 hybrid mode 条目', en.includes('Hybrid mode protocol (v1.8)'))
  check('英文协议含 review:false hard switch 条目', en.includes('review:false hard switch'))
  check('英文协议版本历史行 v1.8 存在', en.includes('v1.8: hybrid mode'))
  check('Skill 含 ## v1.8 混合模式 章节', skill.includes('## v1.8 混合模式（importance 驱动分工）'))
  check('Skill 含 reviewSpecified 说明', skill.includes('reviewSpecified'))
  check('Skill 版本历史含 v1.8 行', skill.includes('- v1.8：混合模式（importance 驱动执行/审核分工）'))
  check('Skill EN 含 v1.8 hybrid mode 章节', skillEn.includes('## v1.8 hybrid mode'))
  check('Skill EN 版本历史含 v1.8 行', skillEn.includes('- v1.8: hybrid mode'))
  check('v1.7 历史条目保留（协议）', zh.includes('步骤权重协议（v1.7）') && zh.includes('多方案比较协议（v1.7）'))
  check('v1.7 历史条目保留（Skill）', skill.includes('- v1.7：多方案比较'))
}

// ---------------------------------------------------------------------------
// 3) Raw source marker checks (as required by the task).
// ---------------------------------------------------------------------------
console.log('[3] 源文件关键标记断言')
const src = readFileSync(INDEX, 'utf8')
for (const marker of ['WEB_RELAY_PROTOCOL_VERSION_V18', 'mainagent', 'steps/restructure', 'isConcurrent', 'reviewSpecified', "'1.3.0'"]) {
  check(`源文件包含标记 ${marker}`, src.includes(marker), `缺少 "${marker}"`)
}
check('normalizeStep 返回值含 reviewSpecified 字段', /reviewSpecified:\s*Boolean\(raw && typeof raw\.review === 'boolean'\)/.test(src))
check('complete 自动豁免逻辑存在', src.includes("autoPass = step.review === false || (step.importance === 'low' && !step.reviewSpecified)"))
check('autoPass 时 reviewedBy=mainagent', src.includes("step.reviewedBy = 'mainagent'"))
check('批量原子打回标记存在', src.includes('批量原子打回：同批步骤含被拒项，统一退回 rejected 待补证据'))
check('restructure 路由注册存在', src.includes("path: '/dsh-web-relay/steps/restructure'"))
check('statusHandler version 1.2.x/1.3.0', src.includes("version: '1.2.0'") || src.includes("version: '1.2.1'") || src.includes("version: '1.3.0'"))
{
  const residual = src.split('\n').filter((l) => l.includes("=== 'v1.6'") && !l.includes('isConcurrent'))
  check('无残留 === \'v1.6\' 判断（isConcurrent helper 内部除外）', residual.length === 0, `残留 ${residual.length} 行: ${residual.join(' | ')}`)
}
check('无残留 state.protocolVersion === \'v1.6\'', !src.includes("state.protocolVersion === 'v1.6'"))
check('无残留 updated.protocolVersion === \'v1.6\'', !src.includes("updated.protocolVersion === 'v1.6'"))

// package.json version
const pkg = JSON.parse(readFileSync(PKG, 'utf8'))
check('package.json version === 1.2.x/1.3.0', pkg.version === '1.2.0' || pkg.version === '1.2.1' || pkg.version === '1.3.0', pkg.version)

// ---------------------------------------------------------------------------
// 4) LF line endings (repo .gitattributes enforces LF)
// ---------------------------------------------------------------------------
console.log('[4] LF 行尾检查')
check('index.js 无 CRLF', !src.includes('\r\n'))
check('index.js 以 LF 结尾', src.endsWith('\n'))

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log('')
if (failures === 0) {
  console.log(`PASS — verify-v18-backend: 全部 ${total} 项断言通过`)
  console.log('verify-v18-backend: ALL CHECKS PASSED')
  process.exit(0)
} else {
  console.error(`verify-v18-backend: ${failures}/${total} 项断言失败`)
  process.exit(1)
}
