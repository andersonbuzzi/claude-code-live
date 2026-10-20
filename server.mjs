// claude-code-live: local, live viewer for Claude Code sessions.
// Reads ~/.claude/projects/<folder>/<session>.jsonl and streams new lines over SSE.
// Unofficial project, not affiliated with Anthropic.
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { StringDecoder } from 'node:string_decoder';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

const PORT = Number(process.env.PORT || 4777);
const HOST = '127.0.0.1';
const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const ROOT = path.join(CLAUDE_DIR, 'projects');
const PROCS_DIR = path.join(CLAUDE_DIR, 'sessions'); // one <pid>.json per running claude
const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
const ACTIVE_MS = 2 * 60 * 1000;
const MAX_TEXT = 12000; // max characters per tool result

const PROJECT_RE = /^[A-Za-z0-9._-]+$/;
const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function sessionPath(project, id) {
  if (!PROJECT_RE.test(project) || !ID_RE.test(id)) return null;
  const p = path.resolve(ROOT, project, id + '.jsonl');
  return p.startsWith(ROOT + path.sep) ? p : null;
}

// ---------- line normalization ----------

// Lines that start with {"type":"X"} we don't need (the biggest ones in the file).
const KEEP_TYPES = new Set(['user', 'assistant', 'system', 'ai-title', 'custom-title', 'summary']);
const LEADING_TYPE = /^\{"type":\s*"([^"]+)"/;

function clip(s, n = MAX_TEXT) {
  if (typeof s !== 'string') s = s == null ? '' : JSON.stringify(s, null, 2);
  return s.length > n ? { text: s.slice(0, n), cut: s.length - n } : { text: s, cut: 0 };
}

function resultText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return JSON.stringify(content, null, 2);
  return content.map(c => c.type === 'text' ? c.text : c.type === 'image' ? '[imagem]' : `[${c.type}]`).join('\n');
}

function userText(content) {
  if (typeof content === 'string') return content;
  return content.map(c => c.type === 'text' ? c.text : c.type === 'image' ? '[imagem]' : '').filter(Boolean).join('\n');
}

// Turns one JSONL line into zero or more simple events for the browser.
// Note labels are codes; the page translates them.
function normalize(o) {
  if (!o || o.isSidechain) return [];
  const ts = o.timestamp;
  switch (o.type) {
    case 'ai-title': return [{ k: 'title', text: o.aiTitle }];
    case 'custom-title': return [{ k: 'title', text: o.customTitle }];
    case 'system':
      if (o.subtype === 'turn_duration') return [{ k: 'turn', ms: o.durationMs, ts }];
      if (o.subtype === 'compact_boundary') return [{ k: 'note', label: 'compacted', ts }];
      return [];
    case 'assistant': {
      const m = o.message || {};
      const out = [];
      for (const c of m.content || []) {
        if (c.type === 'text' && c.text?.trim()) out.push({ k: 'a-text', mid: m.id, text: c.text, ts });
        else if (c.type === 'thinking' && c.thinking?.trim()) out.push({ k: 'a-think', mid: m.id, text: clip(c.thinking).text, ts });
        else if (c.type === 'tool_use' || c.type === 'server_tool_use')
          out.push({ k: 'tool', mid: m.id, id: c.id, name: c.name, input: clip(c.input, 4000), ts });
        else if (c.type?.endsWith('_tool_result') && c.tool_use_id) {
          // Server-side tool result (advisor, web search…) arrives inside the assistant message.
          const r = c.content;
          const text = r?.type?.includes('redacted') ? '(hidden by the server)'
            : Array.isArray(r) ? r.map(x => x.title ? `${x.title} — ${x.url || ''}` : x.text || `[${x.type}]`).join('\n')
            : typeof r === 'string' ? r : r?.text || JSON.stringify(r, null, 2);
          out.push({ k: 'result', id: c.tool_use_id, err: !!r?.error_code, out: clip(text) });
        }
      }
      return out;
    }
    case 'user': {
      const m = o.message || {};
      const content = m.content;
      if (Array.isArray(content) && content.some(c => c.type === 'tool_result')) {
        return content.filter(c => c.type === 'tool_result').map(c => ({
          k: 'result', id: c.tool_use_id, err: !!c.is_error, out: clip(resultText(c.content)),
        }));
      }
      const text = userText(content || '');
      if (!text.trim()) return [];
      if (o.isCompactSummary) return [{ k: 'note', label: 'compact-summary', body: clip(text).text, ts }];
      if (o.isMeta) return [];
      const kind = o.origin?.kind;
      if (kind === 'human' || o.promptSource === 'typed') {
        if (text.startsWith('<command-')) {
          const name = text.match(/<command-name>([\s\S]*?)<\/command-name>/)?.[1] || '';
          const args = text.match(/<command-args>([\s\S]*?)<\/command-args>/)?.[1] || '';
          return [{ k: 'cmd', text: (name + ' ' + args).trim(), ts }];
        }
        return [{ k: 'user', text, ts }];
      }
      if (text.startsWith('<bash-input>')) return [{ k: 'cmd', text: '! ' + text.replace(/<\/?bash-input>/g, '').trim(), ts }];
      if (text.startsWith('<bash-stdout>') || text.startsWith('<bash-stderr>')) {
        const t = text.replace(/<\/?bash-(stdout|stderr)>/g, '').trim();
        return t ? [{ k: 'note', label: 'shell-output', body: clip(t).text, ts }] : [];
      }
      if (text.startsWith('[Request interrupted')) return [{ k: 'note', label: 'interrupted', ts }];
      const label = kind === 'task-notification' ? 'task-done'
        : kind === 'peer' ? 'peer'
        : kind === 'auto-continuation' ? 'auto-continue'
        : 'system';
      return [{ k: 'note', label, body: clip(text, 3000).text, ts }];
    }
  }
  return [];
}

function parseLine(line) {
  if (!line) return [];
  const lead = LEADING_TYPE.exec(line.slice(0, 60));
  if (lead && !KEEP_TYPES.has(lead[1])) return [];
  try { return normalize(JSON.parse(line)); } catch { return []; }
}

// ---------- incremental file reading ----------

// Reads the file from `start` to the end in chunks, calling onLine for each complete line.
// Returns the offset right after the last complete line.
async function readLines(file, start, onLine) {
  const fh = await fsp.open(file, 'r');
  try {
    const { size } = await fh.stat();
    const buf = Buffer.alloc(1 << 20);
    const dec = new StringDecoder('utf8');
    let pos = start, pending = '', consumed = start;
    while (pos < size) {
      const { bytesRead } = await fh.read(buf, 0, Math.min(buf.length, size - pos), pos);
      if (!bytesRead) break;
      pos += bytesRead;
      pending += dec.write(buf.subarray(0, bytesRead));
      let nl;
      while ((nl = pending.indexOf('\n')) !== -1) {
        const line = pending.slice(0, nl);
        pending = pending.slice(nl + 1);
        consumed += Buffer.byteLength(line, 'utf8') + 1;
        onLine(line);
      }
    }
    return consumed; // a trailing partial line waits for the next read
  } finally { await fh.close(); }
}

async function readChunk(file, start, len) {
  const fh = await fsp.open(file, 'r');
  try {
    const buf = Buffer.alloc(len);
    const { bytesRead } = await fh.read(buf, 0, len, start);
    return buf.subarray(0, bytesRead).toString('utf8');
  } finally { await fh.close(); }
}

// ---------- listing ----------

const metaCache = new Map(); // file -> { mtimeMs, size, meta }

function firstPrompt(lines) {
  for (const l of lines) {
    if (!l.includes('"type":"user"') && !l.includes('"type": "user"')) continue;
    for (const ev of parseLine(l)) if (ev.k === 'user' || ev.k === 'cmd') return ev.text;
  }
  return '';
}

async function sessionMeta(project, file, st) {
  const hit = metaCache.get(file);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.meta;
  const HEAD = 256 * 1024, TAIL = 128 * 1024;
  const head = await readChunk(file, 0, Math.min(HEAD, st.size));
  const tail = st.size > HEAD ? await readChunk(file, Math.max(0, st.size - TAIL), TAIL) : '';
  const headLines = head.split('\n');
  if (st.size > HEAD) headLines.pop(); // last line may be cut
  const tailLines = tail ? tail.split('\n').slice(1) : [];
  let cwd = '', started = '', title = '', lastPrompt = '';
  for (const l of headLines) {
    if (!cwd) cwd = l.match(/"cwd":\s*"((?:[^"\\]|\\.)*)"/)?.[1] || '';
    if (!started) started = l.match(/"timestamp":\s*"([^"]+)"/)?.[1] || '';
    if (cwd && started) break;
  }
  for (const l of [...headLines, ...tailLines]) {
    const t = l.match(/^\{"type":\s*"(?:ai|custom)-title",\s*"(?:aiTitle|customTitle)":\s*"((?:[^"\\]|\\.)*)"/);
    if (t) try { title = JSON.parse('"' + t[1] + '"'); } catch {}
    const p = l.match(/^\{"type":\s*"last-prompt",\s*"lastPrompt":\s*"((?:[^"\\]|\\.)*)"/);
    if (p) try { lastPrompt = JSON.parse('"' + p[1] + '"'); } catch {}
  }
  const meta = {
    project, id: path.basename(file, '.jsonl'), cwd: cwd.replace(/\\\\/g, '\\'),
    title, first: firstPrompt(headLines).slice(0, 200), lastPrompt: lastPrompt.slice(0, 200),
    started, mtime: st.mtimeMs, size: st.size,
  };
  metaCache.set(file, { mtimeMs: st.mtimeMs, size: st.size, meta });
  return meta;
}

// ---------- running claude processes ----------

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

// sessionId -> { pid, status, name } for claude processes running now.
async function liveProcs() {
  const map = new Map();
  let files = [];
  try { files = await fsp.readdir(PROCS_DIR); } catch { return map; }
  for (const f of files) {
    if (!/^\d+\.json$/.test(f)) continue;
    try {
      const d = JSON.parse(await fsp.readFile(path.join(PROCS_DIR, f), 'utf8'));
      if (!d.sessionId || !Number.isInteger(d.pid) || !alive(d.pid)) continue;
      const prev = map.get(d.sessionId);
      if (!prev || (d.updatedAt || 0) > (prev.updatedAt || 0))
        map.set(d.sessionId, { pid: d.pid, status: d.status || '', name: d.name || '', updatedAt: d.updatedAt || 0 });
    } catch {}
  }
  return map;
}

async function listSessions() {
  let dirs = [];
  try { dirs = await fsp.readdir(ROOT, { withFileTypes: true }); } catch { return []; }
  const all = [];
  for (const d of dirs) {
    if (!d.isDirectory() || !PROJECT_RE.test(d.name)) continue;
    const dir = path.join(ROOT, d.name);
    let files = [];
    try { files = await fsp.readdir(dir); } catch { continue; }
    for (const f of files) {
      if (!f.endsWith('.jsonl') || !ID_RE.test(f.slice(0, -6))) continue;
      const file = path.join(dir, f);
      try {
        const st = await fsp.stat(file);
        if (st.size === 0) continue;
        all.push(await sessionMeta(d.name, file, st));
      } catch {}
    }
  }
  // Sessions without a cwd inherit one from another session in the same folder.
  const cwdByProject = {};
  for (const s of all) if (s.cwd && !cwdByProject[s.project]) cwdByProject[s.project] = s.cwd;
  const now = Date.now();
  const procs = await liveProcs();
  for (const s of all) {
    s.cwd ||= cwdByProject[s.project] || s.project;
    const p = procs.get(s.id);
    s.proc = p ? { pid: p.pid, status: p.status } : null;
    s.active = (p && p.status !== 'idle') || now - s.mtime < ACTIVE_MS;
  }
  // Hide sessions that were opened and closed without any message.
  return all.filter(s => s.title || s.first || s.lastPrompt || s.active || s.proc).sort((a, b) => b.mtime - a.mtime);
}

// ---------- SSE clients and subscriptions ----------

const clients = new Map(); // clientId -> { res, subs: Set<key> }
const tails = new Map();   // "clientId key" -> { cid, key, file, offset, busy, again }
const MAX_EVENTS = 4000;   // max history sent when a session is opened

function send(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

async function pumpTail(t) {
  if (t.busy) { t.again = true; return; }
  t.busy = true;
  try {
    do {
      t.again = false;
      let st;
      try { st = await fsp.stat(t.file); } catch { break; }
      if (st.size < t.offset) t.offset = 0; // file was rewritten
      if (st.size === t.offset) continue;
      const events = [];
      t.offset = await readLines(t.file, t.offset, l => events.push(...parseLine(l)));
      const c = clients.get(t.cid);
      if (events.length && c && tails.get(t.cid + ' ' + t.key) === t) send(c.res, 'append', { key: t.key, events });
    } while (t.again);
  } finally { t.busy = false; }
}

function pumpKey(key) {
  for (const t of tails.values()) if (t.key === key) pumpTail(t);
}

async function subscribe(cid, project, id) {
  const c = clients.get(cid);
  const file = sessionPath(project, id);
  if (!c || !file) return false;
  const key = `${project}/${id}`;
  if (c.subs.has(key)) return true;
  c.subs.add(key);
  let events = [];
  let offset;
  try { offset = await readLines(file, 0, l => { for (const e of parseLine(l)) events.push(e); }); }
  catch { c.subs.delete(key); return false; }
  if (!c.subs.has(key) || clients.get(cid) !== c) return true; // closed while loading
  // Titles repeat a lot in the file: send only the latest one, separately.
  let title;
  events = events.filter(e => e.k === 'title' ? (title = e.text, false) : true);
  let skipped = 0;
  if (events.length > MAX_EVENTS) { skipped = events.length - MAX_EVENTS; events = events.slice(-MAX_EVENTS); }
  send(c.res, 'history', { key, events, skipped, title });
  const t = { cid, key, file, offset, busy: false, again: false };
  tails.set(cid + ' ' + key, t);
  pumpTail(t); // closes the gap between history and live tail
  return true;
}

function unsubscribe(cid, key) {
  clients.get(cid)?.subs.delete(key);
  tails.delete(cid + ' ' + key);
}

// ---------- directory watching ----------

let listTimer = null;
const tailTimers = new Map();

function onFsChange(rel) {
  if (!rel) return;
  const parts = rel.split(path.sep);
  if (parts.length === 2 && parts[1].endsWith('.jsonl')) {
    const key = `${parts[0]}/${parts[1].slice(0, -6)}`;
    if (!tailTimers.has(key)) {
      tailTimers.set(key, setTimeout(() => { tailTimers.delete(key); pumpKey(key); }, 80));
    }
    if (!listTimer) listTimer = setTimeout(broadcastList, 1500);
  }
}

async function broadcastList() {
  listTimer = null;
  if (!clients.size) return;
  const sessions = await listSessions();
  for (const c of clients.values()) send(c.res, 'list', sessions);
}

try {
  fs.watch(ROOT, { recursive: true }, (_e, f) => onFsChange(f?.toString()));
} catch (e) {
  console.warn('fs.watch failed, relying on polling:', e.message);
}
// Running claude status (busy / idle) changes all the time.
try {
  fs.watch(PROCS_DIR, () => { if (!listTimer) listTimer = setTimeout(broadcastList, 500); });
} catch {}

// Safety net: some fs.watch events get lost.
setInterval(() => { for (const t of tails.values()) pumpTail(t); }, 2000);
setInterval(() => { if (clients.size) broadcastList(); }, 30000);

// ---------- open in Terminal (macOS) ----------
// Errors are codes; the page translates them.

const FOCUS_SCRIPT = `on run argv
  set target to item 1 of argv
  tell application "Terminal"
    repeat with w in windows
      try
        repeat with t in tabs of w
          if tty of t is target then
            set miniaturized of w to false
            set selected of t to true
            set index of w to 1
            activate
            return "ok"
          end if
        end repeat
      end try
    end repeat
  end tell
  return "notfound"
end run`;

const NEW_SCRIPT = `on run argv
  set d to item 1 of argv
  set sid to item 2 of argv
  tell application "Terminal"
    activate
    do script "cd " & quoted form of d & " && claude --resume " & sid
  end tell
  return "ok"
end run`;

const launching = new Map(); // id -> timestamp, avoids two terminals on a double click

async function openInTerminal(project, id) {
  if (process.platform !== 'darwin') return { ok: false, error: 'not-mac' };
  if (!sessionPath(project, id)) return { ok: false, error: 'invalid' };
  const sessions = await listSessions();
  const s = sessions.find(x => x.project === project && x.id === id);
  if (!s) return { ok: false, error: 'not-found' };
  try {
    if (s.proc) {
      const { stdout } = await run('ps', ['-o', 'tty=', '-p', String(s.proc.pid)]);
      const tty = stdout.trim();
      if (!tty || tty === '??') return { ok: false, error: 'no-tty' };
      const r = await run('osascript', ['-e', FOCUS_SCRIPT, '/dev/' + tty]);
      if (r.stdout.trim() === 'ok') return { ok: true, action: 'focus' };
      return { ok: false, error: 'other-terminal' };
    }
    if (Date.now() - (launching.get(id) || 0) < 15000) {
      await run('osascript', ['-e', 'tell application "Terminal" to activate']);
      return { ok: true, action: 'focus' };
    }
    if (!fs.existsSync(s.cwd)) return { ok: false, error: 'no-folder', detail: s.cwd };
    launching.set(id, Date.now());
    await run('osascript', ['-e', NEW_SCRIPT, s.cwd, id]);
    return { ok: true, action: 'new' };
  } catch (e) {
    const msg = String(e.stderr || e.message);
    if (/-1743|not authori[sz]ed|Not authorised/i.test(msg))
      return { ok: false, error: 'automation-denied' };
    return { ok: false, error: 'failed', detail: msg.trim().slice(0, 300) };
  }
}

// ---------- HTTP ----------

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };

function json(res, code, data) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

async function body(req) {
  let s = '';
  for await (const ch of req) { s += ch; if (s.length > 10000) break; }
  try { return JSON.parse(s); } catch { return {}; }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${HOST}`);
  // Only accept our own origin (stops other websites in the browser from talking to the server).
  const host = req.headers.host || '';
  if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host)) { res.writeHead(403); return res.end(); }
  if (req.method === 'POST' && req.headers.origin && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(req.headers.origin)) {
    res.writeHead(403); return res.end();
  }

  if (url.pathname === '/api/stream') {
    const cid = url.searchParams.get('client') || '';
    if (!/^[a-z0-9]{6,40}$/i.test(cid)) { res.writeHead(400); return res.end(); }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    const old = clients.get(cid);
    if (old) for (const key of old.subs) unsubscribe(cid, key);
    clients.set(cid, { res, subs: new Set() });
    send(res, 'list', await listSessions());
    const ping = setInterval(() => res.write(': ping\n\n'), 20000);
    req.on('close', () => {
      clearInterval(ping);
      const c = clients.get(cid);
      if (c?.res === res) { for (const key of [...c.subs]) unsubscribe(cid, key); clients.delete(cid); }
    });
    return;
  }

  if (url.pathname === '/api/subscribe' && req.method === 'POST') {
    const b = await body(req);
    return json(res, 200, { ok: await subscribe(String(b.client), String(b.project), String(b.id)) });
  }
  if (url.pathname === '/api/terminal' && req.method === 'POST') {
    if (req.headers['x-app'] !== '1') { res.writeHead(403); return res.end(); }
    const b = await body(req);
    return json(res, 200, await openInTerminal(String(b.project), String(b.id)));
  }
  if (url.pathname === '/api/unsubscribe' && req.method === 'POST') {
    const b = await body(req);
    unsubscribe(String(b.client), `${b.project}/${b.id}`);
    return json(res, 200, { ok: true });
  }

  // static files
  const rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
  const file = path.resolve(PUBLIC, rel);
  if (!file.startsWith(PUBLIC + path.sep)) { res.writeHead(404); return res.end(); }
  try {
    const data = await fsp.readFile(file);
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  } catch { res.writeHead(404); res.end('not found'); }
});

server.listen(PORT, HOST, () => {
  console.log(`claude-code-live on http://${HOST}:${PORT}  (reading ${ROOT})`);
});
