// Final acceptance: verify v0.9.0 features in both files
const fs = require('fs')
const c = fs.readFileSync('D:/DSH/dsh-web-relay/lib/client.js', 'utf8')
const i = fs.readFileSync('D:/DSH/dsh-web-relay/lib/index.js', 'utf8')

console.log('=== client.js 特征 ===')
const cChecks = {
  localeDict: c.includes('localeDict'),
  manualReview: c.includes('manualReview'),
  finalizeTask: c.includes('finalizeTask'),
  finalSummary: c.includes('finalSummary'),
  progressRail: c.includes('progBadge'),
  splitterFold: c.includes('rawNext < 180'),
  i18nPersist: c.includes('dsh-web-relay:locale'),
  toggleLocale: c.includes('toggleLocale'),
  submitManualReview: c.includes('submitManualReview'),
  busyAction: c.includes('stepBusyAction'),
}
console.log(JSON.stringify(cChecks, null, 1))
console.log('client.js 行数:', c.split('\n').length)

console.log('=== index.js 特征 ===')
const iChecks = {
  v15: i.includes("WEB_RELAY_PROTOCOL_VERSION = 'v1.5'"),
  dialogModel: i.includes('callDialogModel'),
  reviewedBy: i.includes('reviewedBy'),
  artifactRequired: i.includes('artifact_required'),
  stateLock: i.includes('lockReview'),
  probeCache: i.includes('probeCache'),
  finalizeHandler: i.includes('finalizeHandler'),
  summarize: i.includes('summarizeReviewSources'),
  finalizeRoute: i.includes('/dsh-web-relay/steps/finalize'),
}
console.log(JSON.stringify(iChecks, null, 1))
console.log('index.js 行数:', i.split('\n').length)

const allPass = Object.values(cChecks).every(Boolean) && Object.values(iChecks).every(Boolean)
console.log(allPass ? 'ALL FEATURES PRESENT' : 'MISSING FEATURES!')
process.exit(allPass ? 0 : 1)
