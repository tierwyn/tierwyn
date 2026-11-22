#!/usr/bin/env node
/**
 * Manual Grok Bot smoke — never run in CI.
 *   TIERWYN_GROKBOT_CDP_PORT=9333 node scripts/grokbot-smoke.mjs
 * Exit 1 if the composer selector no longer resolves.
 */
import WebSocket from '../node_modules/ws/index.js';

const PORT = Numberprocess.env.TIERWYN_GROKBOT_CDP_PORT || 9333;
const COMPOSER = [
  'div.tiptap.ProseMirror.sand-prompt-field[role="textbox"][aria-label="Prompt"]',
  'div.sand-prompt-field[role="textbox"]',
  '[aria-label="Prompt"][role="textbox"]',
];
const SEND = [
  'button[aria-label="Send"]',
  'button[aria-label="Send message"]',
  'button[type="submit"]',
];

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find((t) => t.type === 'page');
if (!page?.webSocketDebuggerUrl) {
  console.error('no page target on', PORT);
  process.exit(1);
}

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject); });
let id = 0;
const pending = new Map();
ws.on('message', (raw) => {
  const msg = JSON.parse(String(raw));
  if (msg.id != null && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(JSON.stringify(msg.error)));
    else resolve(msg.result);
  }
});
function send(method, params) {
  const n = ++id;
  return new Promise((resolve, reject) => {
    pending.set(n, { resolve, reject });
    ws.send(JSON.stringify({ id: n, method, params }));
  });
}
await send('Runtime.enable');
const result = await send('Runtime.evaluate', {
  expression: `(() => {
    const check = (s) => !!document.querySelector(s);
    return {
      composer: ${JSON.stringify(COMPOSER)}.find(check) || null,
      sendButton: ${JSON.stringify(SEND)}.find(check) || null,
    };
  })()`,
  returnByValue: true,
});
const resolved = result.result?.value ?? result.result;
console.log(JSON.stringify({ port: PORT, title: page.title, resolved }, null, 2));
ws.close();
process.exit(resolved?.composer ? 0 : 1);
