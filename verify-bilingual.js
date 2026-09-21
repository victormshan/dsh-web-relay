// Verify bilingual protocol
const fs = require('fs')
const i = fs.readFileSync('D:/DSH/dsh-web-relay/lib/index.js', 'utf8')
const c = fs.readFileSync('D:/DSH/dsh-web-relay/lib/client.js', 'utf8')
console.log('EN protocol const:', i.includes('WEB_RELAY_PROTOCOL_EN'))
console.log('EN skill const:', i.includes('WEB_RELAY_EXTERNAL_AI_SKILL_EN'))
console.log('handler en block:', i.includes('en: {'))
console.log('client en state:', c.includes('en: d.en'))
console.log('client locale pick:', c.includes("locale === 'en' && protocol.en"))
console.log('packContext locale:', c.includes('locale === \'en\' && data.en'))
// quick sanity: node --check already ran; count lines
console.log('index lines:', i.split('\n').length, '| client lines:', c.split('\n').length)
