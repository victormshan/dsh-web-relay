// Inspect dsh-llm service public API
const fs = require('fs')
const t = fs.readFileSync('C:/nvm4w/nodejs/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-llm/lib/index.js', 'utf8')
const lines = t.split('\n')
for (let i = 0; i < lines.length; i++) {
  const l = lines[i]
  if (/var \w+ = class|static inject|super\(ctx, "llm"\)|async (chat|complete|request|generate)|provide\(|this\.request =|LLMService/.test(l)) {
    console.log((i + 1) + '|' + l.trim().slice(0, 150))
  }
}
