// Environment connectivity probe: plain HTTP and HTTPS via Node (OpenSSL).
// Usage: node test-env.js
const http = require('http')
const https = require('https')

function fetch(url, timeoutMs = 15000) {
  return new Promise((resolve) => {
    const lib = url.startsWith('https') ? https : http
    const req = lib.get(url, { timeout: timeoutMs }, (res) => {
      let n = 0
      res.on('data', (c) => { n += c.length })
      res.on('end', () => resolve({ url, ok: true, status: res.statusCode, bytes: n }))
    })
    req.on('timeout', () => { req.destroy(); resolve({ url, ok: false, error: 'timeout' }) })
    req.on('error', (e) => resolve({ url, ok: false, error: e.code ?? e.message }))
  })
}

;(async () => {
  const targets = [
    'http://example.com/',
    'https://example.com/',
    'https://api.github.com/',
    'https://www.baidu.com/'
  ]
  for (const t of targets) {
    const r = await fetch(t)
    console.log(JSON.stringify(r))
  }
})()
