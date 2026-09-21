// ==UserScript==
// @name         dsh-relay gemini-web-bridge
// @namespace    dsh-relay
// @version      0.1.0
// @description  主 agent ↔ gemini.google.com 网页自动交流（油猴 PoC）：轮询本地中转服务器取任务 → DOM 自动回复 → 回传
// @match        https://gemini.google.com/*
// @connect      127.0.0.1
// @connect      localhost
// @grant        GM_xmlhttpRequest
// @run-at       document-idle
// ==/UserScript==
// ===========================================================================
// 原理：
//   1) 每 3 秒轮询 http://127.0.0.1:8899/next-task（GM_xmlhttpRequest 绕过 CORS）
//   2) 有任务 → 在 Gemini 聊天输入框（contenteditable）填入 prompt，触发输入事件
//   3) 点击发送按钮（按 aria-label 匹配"发送"/"Send"；兜底 dispatch Enter）
//   4) 轮询"回复完成"（发送按钮从停止态恢复 / 最后 model-response 文本稳定），抓取回复
//   5) GM_xmlhttpRequest POST /submit-answer 回传
// 注意：Gemini 前端 DOM 可能变化——选择器已尽量宽松（contenteditable + 按钮文字匹配）。
// ===========================================================================
(function () {
  'use strict'
  const BRIDGE = 'http://localhost:8899'   // 用 localhost（Chrome 回环豁免）而非 127.0.0.1（PNA 拦截）
  const POLL_MS = 3000
  const BUSY = { id: null, lastTextLen: -1, stableRounds: 0 }

  function req(method, path, body) {
    return new Promise((resolve) => {
      console.log('[dsh-bridge] req', method, path)
      GM_xmlhttpRequest({
        method, url: BRIDGE + path,
        headers: { 'content-type': 'application/json' },
        data: body ? JSON.stringify(body) : undefined,
        onload: (r) => {
          console.log('[dsh-bridge] resp', path, r.status, String(r.responseText || '').slice(0, 60))
          try { resolve(JSON.parse(r.responseText)) } catch { resolve({ ok: false }) }
        },
        onerror: (e) => { console.error('[dsh-bridge] error', path, e && e.error || e); resolve({ ok: false, error: 'network' }) },
        ontimeout: () => { console.error('[dsh-bridge] timeout', path); resolve({ ok: false, error: 'timeout' }) },
        timeout: 10000
      })
    })
  }

  // ---- Gemini DOM 交互（宽松选择器）----
  function getInput() {
    // chat 输入通常是 contenteditable 富文本；部分版本是 textarea
    return document.querySelector('[contenteditable="true"]') || document.querySelector('textarea.ql-editor, textarea')
  }
  function getSendButton() {
    // 按钮文字含"发送"/"Send"；或 aria-label
    const btns = [...document.querySelectorAll('button')]
    return btns.find((b) => {
      const label = (b.getAttribute('aria-label') || '').toLowerCase()
      const text = (b.textContent || '').toLowerCase()
      return label.includes('send') || label.includes('发送') || (text.includes('send') && b.textContent.trim().length < 12)
    }) || null
  }
  function setInputValue(el, text) {
    el.focus()
    // contenteditable：直接设置 + 派发 input（React 兼容）
    if (el.isContentEditable) {
      el.textContent = text
      el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }))
    } else {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
      setter.call(el, text)
      el.dispatchEvent(new Event('input', { bubbles: true }))
    }
  }
  function isReplyFinished() {
    // 发送按钮恢复可点（停止→发送）或最后回复文本稳定
    const send = getSendButton()
    if (send && !send.disabled) {
      const len = lastReplyLen()
      if (len === BUSY.lastTextLen) { BUSY.stableRounds++; if (BUSY.stableRounds >= 3) return true }
      else { BUSY.lastTextLen = len; BUSY.stableRounds = 0 }
    }
    return false
  }
  function lastReplyLen() {
    const nodes = document.querySelectorAll('model-response, .model-response-text, [data-test-id="model-response"]')
    const last = nodes[nodes.length - 1]
    return last ? (last.textContent || '').trim().length : 0
  }
  function grabReply() {
    const nodes = document.querySelectorAll('model-response, .model-response-text, [data-test-id="model-response"]')
    const last = nodes[nodes.length - 1]
    return last ? (last.textContent || '').trim() : ''
  }

  async function handleTask(task) {
    BUSY.id = task.id
    BUSY.lastTextLen = -1
    BUSY.stableRounds = 0
    const input = getInput()
    if (!input) return console.warn('[dsh-bridge] 未找到输入框')
    setInputValue(input, task.prompt)
    await new Promise((r) => setTimeout(r, 500))
    const send = getSendButton()
    if (send) send.click()
    else {
      // 兜底：Enter 提交
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }))
    }
    console.log('[dsh-bridge] 已发送任务', task.id)
    // 等待回复完成（最多 120s）
    const deadline = Date.now() + 120000
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 1000))
      if (isReplyFinished() && lastReplyLen() > 0) break
    }
    const answer = grabReply()
    await req('POST', '/submit-answer', { id: task.id, answer })
    console.log('[dsh-bridge] 任务', task.id, '已回传, 长度', answer.length)
    BUSY.id = null
  }

  setInterval(async () => {
    if (BUSY.id) return // 处理中不取新任务
    const r = await req('GET', '/next-task')
    if (r && r.ok && r.task) await handleTask(r.task)
  }, POLL_MS)
  console.log('[dsh-relay gemini-web-bridge] 已启动，轮询', BRIDGE, '每', POLL_MS, 'ms')
})()
