// Demo mode: builds a fake ~/.claude folder with made-up sessions, starts the
// server on it and keeps appending to one session so you can watch it live.
// Usage: npm run demo   (then open http://127.0.0.1:4778)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIR = path.join(os.tmpdir(), 'claude-code-live-demo');
const PORT = process.env.PORT || '4778';
const HOME = '/Users/you'; // fake home so screenshots show no real paths

fs.rmSync(DIR, { recursive: true, force: true });
fs.mkdirSync(path.join(DIR, 'projects'), { recursive: true });
fs.mkdirSync(path.join(DIR, 'sessions'), { recursive: true });

const folderName = cwd => cwd.replace(/[^A-Za-z0-9]/g, '-');
let clock = Date.now() - 1000 * 60 * 60 * 30;
const ts = (stepMin = 1) => new Date((clock += stepMin * 60000)).toISOString();

function user(sid, cwd, text) {
  return { type: 'user', sessionId: sid, cwd, timestamp: ts(), promptSource: 'typed', origin: { kind: 'human' },
    message: { role: 'user', content: text }, uuid: randomUUID() };
}
function say(sid, text) {
  return { type: 'assistant', sessionId: sid, timestamp: ts(0.2), uuid: randomUUID(),
    message: { id: 'msg_' + randomUUID(), role: 'assistant', content: [{ type: 'text', text }] } };
}
function tool(sid, name, input, output, isError = false) {
  const id = 'toolu_' + randomUUID().replace(/-/g, '');
  return [
    { type: 'assistant', sessionId: sid, timestamp: ts(0.2), uuid: randomUUID(),
      message: { id: 'msg_' + randomUUID(), role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } },
    { type: 'user', sessionId: sid, timestamp: ts(0.1), uuid: randomUUID(),
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: output, is_error: isError }] } },
  ];
}
const turn = (sid, ms) => ({ type: 'system', subtype: 'turn_duration', durationMs: ms, sessionId: sid, timestamp: ts(0.1) });
const title = (sid, t) => ({ type: 'ai-title', aiTitle: t, sessionId: sid });

function write(cwd, sid, lines, ageMin) {
  const dir = path.join(DIR, 'projects', folderName(cwd));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, sid + '.jsonl');
  fs.writeFileSync(file, lines.flat().map(l => JSON.stringify(l)).join('\n') + '\n');
  const t = new Date(Date.now() - ageMin * 60000);
  fs.utimesSync(file, t, t);
  return file;
}

const shop = path.join(HOME, 'code', 'webshop');
const api = path.join(HOME, 'code', 'billing-api');
const notes = path.join(HOME, 'notes');

// 1) The "live" session: keeps growing while the demo runs.
const liveId = randomUUID();
const liveFile = write(shop, liveId, [
  title(liveId, 'Fix flaky checkout test'),
  user(liveId, shop, 'The checkout test fails about 1 in 5 runs on CI. Can you find out why?'),
  say(liveId, "I'll run the test a few times and look at how the cart total is calculated."),
  tool(liveId, 'Bash', { command: 'npm test -- checkout.spec.ts --repeat 10' },
    'Tests: 8 passed, 2 failed\n  ✗ applies discount before tax (expected 90.00, got 89.99)'),
  tool(liveId, 'Read', { file_path: shop + '/src/cart/total.ts' }, 'export function total(items, discount) {\n  return items.reduce((s, i) => s + i.price * i.qty, 0) * (1 - discount);\n}'),
  say(liveId, 'Found it: the total is computed with floating point and rounded in different places. I\'ll switch to integer cents.'),
], 0.2);

// 2) Waiting for you in a terminal.
const idleId = randomUUID();
write(api, idleId, [
  title(idleId, 'Add retry to invoice webhook'),
  user(idleId, api, 'add retries with backoff to the invoice webhook sender'),
  say(idleId, 'Plan:\n\n1. Wrap `sendWebhook` in a retry helper\n2. Exponential backoff: 1s, 4s, 16s\n3. Log each failed attempt\n\nShould I also add a dead-letter table for webhooks that fail all retries?'),
  turn(idleId, 48000),
], 6);

// 3) Older sessions.
const olderId = randomUUID();
write(api, olderId, [
  title(olderId, 'Upgrade Postgres driver'),
  user(olderId, api, 'upgrade pg to the latest version and fix what breaks'),
  tool(olderId, 'Bash', { command: 'npm install pg@latest && npm test' }, 'added 1 package\nTests: 132 passed'),
  say(olderId, 'Upgraded `pg` and all 132 tests pass. No code changes were needed.'),
  turn(olderId, 95000),
], 60 * 26);

const notesId = randomUUID();
write(notes, notesId, [
  title(notesId, 'Summarize meeting notes'),
  user(notesId, notes, 'summarize this week\'s meeting notes into 5 bullets'),
  tool(notesId, 'Glob', { pattern: 'meetings/2026-*.md' }, 'meetings/2026-10-13.md\nmeetings/2026-10-15.md'),
  say(notesId, '- Launch moved to Nov 4\n- Billing API owns retries now\n- Hiring: two backend roles\n- Design review every Thursday\n- Next offsite in January'),
  turn(notesId, 21000),
], 60 * 50);

const cssId = randomUUID();
write(shop, cssId, [
  title(cssId, 'Dark mode for product page'),
  user(cssId, shop, 'add dark mode to the product page'),
  say(cssId, 'Done. Colors now come from CSS variables with a `prefers-color-scheme: dark` override.'),
  turn(cssId, 64000),
], 60 * 30);

// Fake "running claude" files so the list shows working / waiting status.
// They point at this process and its parent so the server sees them as alive.
const proc = (pid, sid, status) => fs.writeFileSync(path.join(DIR, 'sessions', pid + '.json'),
  JSON.stringify({ pid, sessionId: sid, status, updatedAt: Date.now() }));
proc(process.pid, liveId, 'busy');
proc(process.ppid, idleId, 'idle');

const server = spawn(process.execPath, [path.join(HERE, '..', 'server.mjs')], {
  env: { ...process.env, CLAUDE_CONFIG_DIR: DIR, PORT }, stdio: 'inherit',
});

// Keep the live session moving.
const script = [
  () => tool(liveId, 'Edit', { file_path: shop + '/src/cart/total.ts' }, 'Updated total() to work in integer cents'),
  () => tool(liveId, 'Bash', { command: 'npm test -- checkout.spec.ts --repeat 50' }, 'Tests: 50 passed'),
  () => say(liveId, 'All 50 runs pass now. The fix: prices are stored and summed as integer cents, and only formatted at the end.'),
  () => turn(liveId, 132000),
  () => user(liveId, shop, 'nice. can you add a regression test for the 89.99 case?'),
  () => tool(liveId, 'Write', { file_path: shop + '/src/cart/total.spec.ts' }, 'File created'),
  () => say(liveId, 'Added `total.spec.ts` with the exact cart that used to produce 89.99.'),
];
let i = 0;
const timer = setInterval(() => {
  if (i >= script.length) i = 0;
  const lines = [script[i++]()].flat().map(l => ({ ...l, timestamp: new Date().toISOString() }));
  fs.appendFileSync(liveFile, lines.map(l => JSON.stringify(l)).join('\n') + '\n');
}, 3500);

const stop = () => { clearInterval(timer); server.kill(); process.exit(0); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
console.log(`Demo data in ${DIR}\nOpen http://127.0.0.1:${PORT}`);
