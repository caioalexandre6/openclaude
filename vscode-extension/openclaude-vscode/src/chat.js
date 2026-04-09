const vscode = require('vscode');
const { spawn, execFileSync } = require('child_process');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

/**
 * Find node.exe on Windows — checks common installation paths.
 */
function findNodeExe() {
  const fs = require('fs');
  const candidates = [
    // Standard nodejs installer
    'C:\\Program Files\\nodejs\\node.exe',
    'C:\\Program Files (x86)\\nodejs\\node.exe',
    // Alongside the npm global dir
    path.join(process.env.APPDATA || '', '..', 'Local', 'Programs', 'nodejs', 'node.exe'),
    // nvm for Windows
    path.join(process.env.APPDATA || '', 'nvm', 'current', 'node.exe'),
  ];
  for (const c of candidates) {
    try { if (fs.existsSync(c)) return c; } catch { /* ignore */ }
  }
  // Last resort: try to find node in PATH via where
  try {
    return execFileSync('cmd.exe', ['/c', 'where node'], {
      encoding: 'utf8', timeout: 4000,
    }).trim().split('\n')[0].trim() || 'node';
  } catch {
    return 'node';
  }
}

/**
 * Find the openclaude entry-point script (.js/mjs), following the npm global
 * link chain so we bypass the .cmd wrapper entirely.
 */
function findOpenClaudeScript(execName) {
  const fs = require('fs');
  const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');

  // npm global package location
  const pkgDir = path.join(appData, 'npm', 'node_modules', '@gitlawb', 'openclaude');

  if (!fs.existsSync(pkgDir)) {
    return null;
  }

  try {
    // Resolve npm link / junction
    const realPkgDir = fs.realpathSync(pkgDir);

    // Always prefer compiled CLI
    const distCli = path.join(realPkgDir, 'dist', 'cli.mjs');

    if (fs.existsSync(distCli)) {
      return distCli;
    }
  } catch {
    // ignore
  }

  return null;
}

/**
 * Build an env object with common npm global bin dirs added to PATH.
 */
function buildEnrichedEnv() {
  const currentPath = process.env.PATH || process.env.Path || '';
  const sep = process.platform === 'win32' ? ';' : ':';
  const extra = [];

  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    extra.push(path.join(appData, 'npm'));
    const pf = process.env.ProgramFiles || 'C:\\Program Files';
    extra.push(path.join(pf, 'nodejs'));
  } else {
    extra.push('/usr/local/bin', '/usr/bin', path.join(os.homedir(), '.npm-global', 'bin'));
    extra.push(path.join(os.homedir(), '.nvm', 'versions', 'node', 'current', 'bin'));
  }

  const unique = [...new Set([...extra, ...currentPath.split(sep)])].filter(Boolean);
  return { ...process.env, PATH: unique.join(sep), Path: unique.join(sep) };
}

// ─── Process Manager ──────────────────────────────────────────────────────────

class OpenClaudeProcess {
  constructor(launchCommand, cwd, env) {
    this.launchCommand = launchCommand;
    this.cwd = cwd;
    this.env = env;
    this.proc = null;
    this.buffer = '';
    this.onEvent = null;
    this.onExit = null;
  }

  start() {
    const flags = [
      '--print',
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--verbose',
      '--permission-mode', 'acceptEdits',
    ];

    const spawnEnv = { ...buildEnrichedEnv(), ...this.env };
    const spawnCwd = this.cwd || process.env.USERPROFILE || process.env.HOME || undefined;

    // On Windows: spawn node.exe + script directly to avoid .cmd wrapper issues
    let spawnCmd, spawnArgs;
    if (process.platform === 'win32') {
      const execName = this.launchCommand.trim().split(/\s+/)[0];
      const script = findOpenClaudeScript(execName);
      const nodeExe = findNodeExe();
      if (script) {
        spawnCmd = nodeExe;
        spawnArgs = [script, ...flags];
      } else {
        // Try resolving dist/cli.mjs directly from npm package even if link resolution failed
        const fs = require('fs');
        const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
        const pkgDir = path.join(appData, 'npm', 'node_modules', '@gitlawb', 'openclaude');
        const distCli = path.join(pkgDir, 'dist', 'cli.mjs');

        if (fs.existsSync(distCli)) {
          spawnCmd = nodeExe;
          spawnArgs = [distCli, ...flags];
        } else {
          // Final fallback: use the .cmd wrapper
          const cmdPath = path.join(appData, 'npm', `${execName}.cmd`);
          spawnCmd = 'cmd.exe';
          spawnArgs = ['/d', '/c', cmdPath, ...flags];
        }
      }

      // Safety: if something resolved to bin/openclaude, force dist CLI instead
      if (spawnArgs && spawnArgs[0] && spawnArgs[0].includes('bin\\openclaude')) {
        const fs = require('fs');
        const pkgDir = path.dirname(path.dirname(spawnArgs[0]));
        const distCli = path.join(pkgDir, 'dist', 'cli.mjs');
        if (fs.existsSync(distCli)) {
          spawnArgs[0] = distCli;
        }
      }
    } else {
      spawnCmd = this.launchCommand.trim().split(/\s+/)[0];
      spawnArgs = flags;
    }

    // Emit diagnostic so we can see what we're launching
    if (this.onEvent) {
      this.onEvent({ type: '_stderr', text: `Starting: ${spawnCmd} ${spawnArgs.join(' ')}` });
    }

    this.proc = spawn(spawnCmd, spawnArgs, {
      cwd: spawnCwd,
      env: spawnEnv,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });

    this.proc.stdout.setEncoding('utf8');
    this.proc.stdout.on('data', (chunk) => {
      this.buffer += chunk;
      this._drainBuffer();
    });

    this.proc.stderr.setEncoding('utf8');
    this.proc.stderr.on('data', (chunk) => {
      if (this.onEvent) {
        this.onEvent({ type: '_stderr', text: chunk.toString().trim() });
      }
    });

    this.proc.on('exit', (code, signal) => {
      this.proc = null;
      if (this.onExit) this.onExit(code, signal);
    });

    this.proc.on('error', (err) => {
      if (this.onEvent) {
        this.onEvent({ type: '_error', text: err.message });
      }
    });
  }

  _drainBuffer() {
    let newline = this.buffer.indexOf('\n');
    while (newline !== -1) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (line) {
        try {
          const event = JSON.parse(line);
          if (this.onEvent) this.onEvent(event);
        } catch {
          // non-JSON line — ignore
        }
      }
      newline = this.buffer.indexOf('\n');
    }
  }

  send(text) {
    if (!this.proc || !this.proc.stdin.writable) return false;
    const msg = JSON.stringify({
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
    });
    this.proc.stdin.write(msg + '\n');
    return true;
  }

  isAlive() {
    return Boolean(this.proc);
  }

  kill() {
    if (this.proc) {
      this.proc.kill();
      this.proc = null;
    }
  }
}

// ─── WebView HTML ─────────────────────────────────────────────────────────────

function getChatHtml(nonce, cwd) {
  const displayCwd = cwd
    ? path.basename(cwd)
    : 'No workspace';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <style>
    :root {
      --bg: #0a0908;
      --bg2: #131110;
      --bg3: #1c1714;
      --border: #3a2e28;
      --text: #f0e6da;
      --dim: #c0a890;
      --soft: #8a7060;
      --accent: #d97757;
      --accent2: #f09464;
      --green: #7ec98f;
      --yellow: #e8c56b;
      --red: #ff7a6a;
      --blue: #7ab8d9;
      --user-bg: #1e1612;
      --assistant-bg: #0e0c0b;
      --tool-bg: #111009;
      --radius: 8px;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    html, body {
      height: 100%;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      font-size: 13px;
      background: var(--bg);
      color: var(--text);
      overflow: hidden;
    }
    #root {
      display: flex;
      flex-direction: column;
      height: 100vh;
    }

    /* ── Header ── */
    #header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 8px 12px;
      background: var(--bg2);
      border-bottom: 1px solid var(--border);
      flex-shrink: 0;
    }
    #header-left { display: flex; align-items: center; gap: 8px; }
    #status-dot {
      width: 8px; height: 8px;
      border-radius: 50%;
      background: var(--soft);
      transition: background 0.3s;
    }
    #status-dot.ready { background: var(--green); }
    #status-dot.thinking { background: var(--yellow); animation: pulse 1s infinite; }
    #status-dot.error { background: var(--red); }
    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.4; }
    }
    #status-label { color: var(--dim); font-size: 11px; }
    #cwd-label { color: var(--soft); font-size: 11px; }
    #header-actions { display: flex; gap: 4px; }
    .icon-btn {
      background: none; border: none; cursor: pointer;
      color: var(--soft); padding: 4px 6px; border-radius: 4px;
      font-size: 14px; line-height: 1;
      transition: color 0.2s, background 0.2s;
    }
    .icon-btn:hover { color: var(--text); background: var(--bg3); }

    /* ── Messages ── */
    #messages {
      flex: 1;
      overflow-y: auto;
      padding: 12px 0;
      display: flex;
      flex-direction: column;
      gap: 0;
    }
    #messages::-webkit-scrollbar { width: 4px; }
    #messages::-webkit-scrollbar-track { background: transparent; }
    #messages::-webkit-scrollbar-thumb { background: var(--border); border-radius: 2px; }

    .msg-row {
      padding: 10px 16px;
      border-bottom: 1px solid transparent;
      animation: fadeIn 0.15s ease;
    }
    @keyframes fadeIn { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; } }
    .msg-row:last-child { border-bottom: none; }
    .msg-row.user { background: var(--user-bg); border-bottom-color: var(--border); }
    .msg-row.assistant { background: var(--assistant-bg); }

    .msg-header {
      display: flex; align-items: center; gap: 6px;
      margin-bottom: 6px;
    }
    .msg-role {
      font-size: 10px; font-weight: 600; letter-spacing: 0.06em;
      text-transform: uppercase;
    }
    .msg-role.user { color: var(--accent2); }
    .msg-role.assistant { color: var(--blue); }
    .msg-time { color: var(--soft); font-size: 10px; }

    .msg-content { line-height: 1.6; color: var(--text); white-space: pre-wrap; word-break: break-word; }

    /* ── Code blocks ── */
    .msg-content code {
      background: var(--bg3);
      border: 1px solid var(--border);
      border-radius: 3px;
      padding: 1px 4px;
      font-family: 'Cascadia Code', 'Fira Code', Consolas, monospace;
      font-size: 12px;
    }
    .code-block {
      background: var(--bg3);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      margin: 8px 0;
      overflow: hidden;
    }
    .code-block-header {
      display: flex; justify-content: space-between; align-items: center;
      padding: 4px 10px;
      background: var(--bg2);
      border-bottom: 1px solid var(--border);
      font-size: 11px; color: var(--dim);
    }
    .code-block pre {
      padding: 10px;
      overflow-x: auto;
      font-family: 'Cascadia Code', 'Fira Code', Consolas, monospace;
      font-size: 12px;
      line-height: 1.5;
      color: var(--text);
    }
    .code-block pre::-webkit-scrollbar { height: 3px; }
    .code-block pre::-webkit-scrollbar-thumb { background: var(--border); }

    /* ── Tool cards ── */
    .tool-card {
      margin: 6px 0;
      border: 1px solid var(--border);
      border-radius: var(--radius);
      overflow: hidden;
      background: var(--tool-bg);
    }
    .tool-card-header {
      display: flex; align-items: center; gap: 8px;
      padding: 7px 10px;
      cursor: pointer;
      user-select: none;
      background: var(--bg2);
    }
    .tool-card-header:hover { background: var(--bg3); }
    .tool-icon { font-size: 13px; }
    .tool-name { font-weight: 600; font-size: 12px; color: var(--dim); }
    .tool-path { color: var(--soft); font-size: 11px; font-family: monospace; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .tool-status {
      font-size: 10px; font-weight: 600; letter-spacing: 0.05em;
      padding: 2px 6px; border-radius: 3px;
    }
    .tool-status.running { background: rgba(232,197,107,0.15); color: var(--yellow); }
    .tool-status.done { background: rgba(126,201,143,0.15); color: var(--green); }
    .tool-status.error { background: rgba(255,122,106,0.15); color: var(--red); }
    .tool-chevron { color: var(--soft); font-size: 10px; margin-left: 4px; }
    .tool-card-body {
      padding: 8px 10px;
      border-top: 1px solid var(--border);
      display: none;
    }
    .tool-card-body.open { display: block; }
    .tool-detail-label { font-size: 10px; color: var(--soft); margin-bottom: 4px; letter-spacing: 0.05em; text-transform: uppercase; }
    .tool-detail-value {
      font-family: monospace; font-size: 11px; color: var(--dim);
      white-space: pre-wrap; word-break: break-all;
      max-height: 200px; overflow-y: auto;
      background: var(--bg);
      padding: 6px 8px; border-radius: 4px;
      border: 1px solid var(--border);
    }
    .tool-detail-value::-webkit-scrollbar { width: 3px; }
    .tool-detail-value::-webkit-scrollbar-thumb { background: var(--border); }

    /* ── Thinking indicator ── */
    .thinking-row {
      padding: 8px 16px;
      display: flex; align-items: center; gap: 8px;
    }
    .thinking-dots span {
      display: inline-block; width: 5px; height: 5px;
      border-radius: 50%; background: var(--soft);
      animation: bounce 1.4s infinite ease-in-out;
    }
    .thinking-dots span:nth-child(2) { animation-delay: 0.2s; }
    .thinking-dots span:nth-child(3) { animation-delay: 0.4s; }
    @keyframes bounce {
      0%, 80%, 100% { transform: scale(0.6); opacity: 0.4; }
      40% { transform: scale(1); opacity: 1; }
    }
    .thinking-label { color: var(--soft); font-size: 11px; }

    /* ── Empty state ── */
    #empty-state {
      flex: 1;
      display: flex; flex-direction: column;
      align-items: center; justify-content: center;
      gap: 12px; color: var(--soft);
      pointer-events: none;
    }
    #empty-state .logo { font-size: 32px; }
    #empty-state h2 { font-size: 15px; color: var(--dim); font-weight: 600; }
    #empty-state p { font-size: 12px; text-align: center; max-width: 220px; line-height: 1.5; }

    /* ── Input area ── */
    #input-area {
      border-top: 1px solid var(--border);
      background: var(--bg2);
      padding: 10px 12px;
      flex-shrink: 0;
    }
    #input-wrap {
      display: flex; gap: 8px; align-items: flex-end;
    }
    #input {
      flex: 1;
      background: var(--bg3);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      color: var(--text);
      font-family: inherit; font-size: 13px;
      padding: 8px 10px;
      resize: none;
      min-height: 38px; max-height: 160px;
      line-height: 1.5;
      outline: none;
      transition: border-color 0.15s;
    }
    #input:focus { border-color: var(--accent); }
    #input::placeholder { color: var(--soft); }
    #input:disabled { opacity: 0.5; cursor: not-allowed; }
    #send-btn {
      background: var(--accent);
      border: none; border-radius: var(--radius);
      color: #fff; font-size: 14px;
      width: 36px; height: 36px;
      cursor: pointer; flex-shrink: 0;
      display: flex; align-items: center; justify-content: center;
      transition: background 0.2s, opacity 0.2s;
    }
    #send-btn:hover { background: var(--accent2); }
    #send-btn:disabled { opacity: 0.4; cursor: not-allowed; }
    #input-hint { font-size: 10px; color: var(--soft); margin-top: 4px; }
  </style>
</head>
<body>
<div id="root">
  <div id="header">
    <div id="header-left">
      <div id="status-dot"></div>
      <span id="status-label">Starting…</span>
      <span id="cwd-label">${escapeHtml(displayCwd)}</span>
    </div>
    <div id="header-actions">
      <button class="icon-btn" id="btn-new" title="New session">✦</button>
      <button class="icon-btn" id="btn-clear" title="Clear display">⊘</button>
    </div>
  </div>

  <div id="messages"></div>

  <div id="input-area">
    <div id="input-wrap">
      <textarea id="input" rows="1" placeholder="Message OpenClaude…" disabled></textarea>
      <button id="send-btn" disabled title="Send (Enter)">▲</button>
    </div>
    <div id="input-hint">Enter to send · Shift+Enter for new line</div>
  </div>
</div>

<script nonce="${nonce}">
const vscode = acquireVsCodeApi();

// ── State ──────────────────────────────────────────────────────────────────
let ready = false;
let busy = false;
let msgCount = 0;
let currentAssistantEl = null;
let thinkingEl = null;
const toolCards = new Map(); // tool_use_id → {card, bodyEl, statusEl}

// ── DOM refs ───────────────────────────────────────────────────────────────
const messagesEl = document.getElementById('messages');
const inputEl = document.getElementById('input');
const sendBtn = document.getElementById('send-btn');
const statusDot = document.getElementById('status-dot');
const statusLabel = document.getElementById('status-label');

// ── Utilities ──────────────────────────────────────────────────────────────
function esc(str) {
  return String(str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function formatTime() {
  return new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function setStatus(state, label) {
  statusDot.className = state;
  statusLabel.textContent = label;
}

function scrollToBottom() {
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function autoResize() {
  inputEl.style.height = 'auto';
  inputEl.style.height = Math.min(inputEl.scrollHeight, 160) + 'px';
}

// ── Markdown-lite renderer ─────────────────────────────────────────────────
function renderMarkdown(text) {
  // Code blocks
  text = text.replace(/\`\`\`(\\w*)\\n?([\\s\\S]*?)\`\`\`/g, (_, lang, code) => {
    return '<div class="code-block"><div class="code-block-header"><span>' + esc(lang || 'code') + '</span></div><pre>' + esc(code.trimEnd()) + '</pre></div>';
  });
  // Inline code
  text = text.replace(/\`([^\`\\n]+)\`/g, '<code>$1</code>');
  // Bold
  text = text.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  // Italic
  text = text.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  // Keep newlines
  text = text.replace(/\\n/g, '<br>');
  return text;
}

// ── Message rows ───────────────────────────────────────────────────────────
function addUserRow(text) {
  removeThinking();
  const row = document.createElement('div');
  row.className = 'msg-row user';
  row.innerHTML =
    '<div class="msg-header"><span class="msg-role user">You</span><span class="msg-time">' + formatTime() + '</span></div>' +
    '<div class="msg-content">' + esc(text) + '</div>';
  messagesEl.appendChild(row);
  scrollToBottom();
}

function startAssistantRow() {
  removeThinking();
  const row = document.createElement('div');
  row.className = 'msg-row assistant';
  row.innerHTML =
    '<div class="msg-header"><span class="msg-role assistant">OpenClaude</span><span class="msg-time">' + formatTime() + '</span></div>' +
    '<div class="msg-content"></div>';
  messagesEl.appendChild(row);
  currentAssistantEl = row.querySelector('.msg-content');
  scrollToBottom();
  return row;
}

function appendAssistantText(text) {
  if (!currentAssistantEl) startAssistantRow();
  // Accumulate raw text and re-render
  currentAssistantEl.dataset.raw = (currentAssistantEl.dataset.raw || '') + text;
  try {
    currentAssistantEl.innerHTML = renderMarkdown(currentAssistantEl.dataset.raw);
  } catch (e) {
    currentAssistantEl.textContent = currentAssistantEl.dataset.raw;
  }
  scrollToBottom();
}

function addToolCard(id, name, inputObj) {
  if (!currentAssistantEl) startAssistantRow();

  const icon = toolIcon(name);
  const label = toolLabel(name, inputObj);

  const card = document.createElement('div');
  card.className = 'tool-card';
  card.innerHTML =
    '<div class="tool-card-header">' +
      '<span class="tool-icon">' + icon + '</span>' +
      '<span class="tool-name">' + esc(name) + '</span>' +
      '<span class="tool-path">' + esc(label) + '</span>' +
      '<span class="tool-status running" data-id="' + esc(id) + '">RUNNING</span>' +
      '<span class="tool-chevron">▸</span>' +
    '</div>' +
    '<div class="tool-card-body">' +
      '<div class="tool-detail-label">Input</div>' +
      '<div class="tool-detail-value">' + esc(JSON.stringify(inputObj, null, 2)) + '</div>' +
    '</div>';

  const header = card.querySelector('.tool-card-header');
  const body = card.querySelector('.tool-card-body');
  const chevron = card.querySelector('.tool-chevron');
  header.addEventListener('click', () => {
    body.classList.toggle('open');
    chevron.textContent = body.classList.contains('open') ? '▾' : '▸';
  });

  currentAssistantEl.appendChild(card);
  toolCards.set(id, {
    card,
    bodyEl: body,
    statusEl: card.querySelector('.tool-status'),
  });
  scrollToBottom();
}

function updateToolCard(id, resultContent, isError) {
  const entry = toolCards.get(id);
  if (!entry) return;
  const { bodyEl, statusEl } = entry;

  statusEl.textContent = isError ? 'ERROR' : 'DONE';
  statusEl.className = 'tool-status ' + (isError ? 'error' : 'done');

  const resultText = typeof resultContent === 'string'
    ? resultContent
    : JSON.stringify(resultContent, null, 2);

  const resultSection = document.createElement('div');
  resultSection.innerHTML =
    '<div class="tool-detail-label" style="margin-top:8px">Result</div>' +
    '<div class="tool-detail-value">' + esc(resultText.slice(0, 2000)) + (resultText.length > 2000 ? '\\n…(truncated)' : '') + '</div>';
  bodyEl.appendChild(resultSection);
}

function showThinking() {
  if (thinkingEl) return;
  thinkingEl = document.createElement('div');
  thinkingEl.className = 'thinking-row';
  thinkingEl.innerHTML =
    '<div class="thinking-dots"><span></span><span></span><span></span></div>' +
    '<span class="thinking-label">Thinking…</span>';
  messagesEl.appendChild(thinkingEl);
  scrollToBottom();
}

function removeThinking() {
  if (thinkingEl) { thinkingEl.remove(); thinkingEl = null; }
}

// ── Tool helpers ───────────────────────────────────────────────────────────
function toolIcon(name) {
  const icons = {
    Read: '📄', Write: '✍️', Edit: '✏️', Glob: '🔍',
    Grep: '🔎', Bash: '⚡', WebFetch: '🌐', WebSearch: '🔍',
    Agent: '🤖', TodoWrite: '📋', AskUserQuestion: '❓',
  };
  return icons[name] || '🔧';
}

function toolLabel(name, input) {
  if (!input) return '';
  if (input.file_path) return input.file_path;
  if (input.path) return input.path;
  if (input.command) return input.command.slice(0, 60);
  if (input.query) return input.query;
  if (input.url) return input.url;
  if (input.pattern) return input.pattern;
  return '';
}

// ── Set enabled state ──────────────────────────────────────────────────────
function setReady(isReady) {
  ready = isReady;
  setBusy(false);
}

function setBusy(isBusy) {
  busy = isBusy;
  const disabled = !ready || busy;
  inputEl.disabled = disabled;
  sendBtn.disabled = disabled;
  if (!disabled) inputEl.focus();
}

// ── Send message ───────────────────────────────────────────────────────────
function sendMessage() {
  const text = inputEl.value.trim();
  if (!text || busy || !ready) return;
  inputEl.value = '';
  autoResize();
  addUserRow(text);
  currentAssistantEl = null;
  toolCards.clear();
  setBusy(true);
  setStatus('thinking', 'Thinking…');
  showThinking();
  vscode.postMessage({ type: 'userMessage', text });
}

// ── Event handlers ─────────────────────────────────────────────────────────
sendBtn.addEventListener('click', sendMessage);

inputEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});

inputEl.addEventListener('input', autoResize);

document.getElementById('btn-new').addEventListener('click', () => {
  vscode.postMessage({ type: 'newSession' });
});

document.getElementById('btn-clear').addEventListener('click', () => {
  messagesEl.innerHTML = '';
  currentAssistantEl = null;
  toolCards.clear();
});

// ── Messages from extension ────────────────────────────────────────────────
window.addEventListener('message', (e) => {
  const msg = e.data;
  switch (msg.type) {

    case 'ready':
      setReady(true);
      setStatus('ready', 'Ready');
      break;

    case 'busy':
      setBusy(true);
      setStatus('thinking', 'Thinking…');
      break;

    case 'error':
      setStatus('error', 'Error');
      removeThinking();
      setBusy(false);
      if (msg.text) {
        const row = document.createElement('div');
        row.className = 'msg-row assistant';
        row.innerHTML = '<div class="msg-header"><span class="msg-role" style="color:var(--red)">Error</span></div>' +
          '<div class="msg-content" style="color:var(--red)">' + esc(msg.text) + '</div>';
        messagesEl.appendChild(row);
        scrollToBottom();
      }
      break;

    case 'stderr':
      // Show stderr output as a dim status line (helps diagnose startup failures)
      if (msg.text) {
        let stderrRow = document.getElementById('stderr-row');
        if (!stderrRow) {
          stderrRow = document.createElement('div');
          stderrRow.id = 'stderr-row';
          stderrRow.style.cssText = 'padding:6px 16px;font-size:11px;color:var(--soft);font-family:monospace;white-space:pre-wrap;word-break:break-all;border-bottom:1px solid var(--border);background:var(--bg2)';
          messagesEl.prepend(stderrRow);
        }
        stderrRow.textContent = msg.text.slice(-300);
      }
      break;

    case 'killed':
      setReady(false);
      setStatus('error', 'Session ended');
      setBusy(false);
      removeThinking();
      break;

    // ── OpenClaude stream events ──

    case 'assistant': {
      const content = msg.content || [];
      if (content.length === 0) {
        appendAssistantText('[debug: content array is empty]');
      }
      for (const block of content) {
        if (block.type === 'text' && block.text) {
          appendAssistantText(block.text);
        } else if (block.type === 'tool_use') {
          addToolCard(block.id, block.name, block.input || {});
        } else {
          appendAssistantText('[debug: block.type=' + block.type + ' text=' + JSON.stringify(block.text) + ']');
        }
      }
      break;
    }

    case 'tool_result': {
      const results = msg.content || [];
      for (const block of results) {
        const id = block.tool_use_id;
        let resultText = '';
        if (Array.isArray(block.content)) {
          resultText = block.content.map(b => b.text || '').join('\\n');
        } else if (typeof block.content === 'string') {
          resultText = block.content;
        }
        updateToolCard(id, resultText, block.is_error);
      }
      break;
    }

    case 'result':
      removeThinking();
      currentAssistantEl = null;
      setBusy(false);
      setStatus('ready', 'Ready');
      break;

    case 'restarted':
      setReady(true);
      setStatus('ready', 'Ready');
      break;
  }
});

// ── Init ───────────────────────────────────────────────────────────────────
setStatus('', 'Starting…');
</script>
</body>
</html>`;
}

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ─── Chat Panel Provider ──────────────────────────────────────────────────────

class ChatPanelProvider {
  constructor() {
    this._panel = null;
    this._proc = null;
  }

  /** Open or reveal the chat panel */
  async open(cwd) {
    if (this._panel) {
      this._panel.reveal(vscode.ViewColumn.Two, false);
      return;
    }

    this._panel = vscode.window.createWebviewPanel(
      'openclaude.chat',
      'OpenClaude Chat',
      { viewColumn: vscode.ViewColumn.Two, preserveFocus: false },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
      },
    );

    const nonce = crypto.randomBytes(16).toString('base64');
    this._panel.webview.html = getChatHtml(nonce, cwd || '');

    this._panel.webview.onDidReceiveMessage((msg) => {
      this._handleWebviewMessage(msg, cwd);
    });

    this._panel.onDidDispose(() => {
      this._panel = null;
      this._killProc();
    });

    // Start the process after a short delay so the WebView has time to render
    setTimeout(() => this._startProc(cwd), 600);
  }

  _handleWebviewMessage(msg, cwd) {
    switch (msg.type) {
      case 'userMessage':
        if (this._proc && this._proc.isAlive()) {
          this._proc.send(msg.text);
        } else {
          // Process died — restart and send
          this._startProc(cwd, msg.text);
        }
        break;

      case 'newSession':
        this._killProc();
        this._postToWebview({ type: 'killed' });
        setTimeout(() => this._startProc(cwd), 300);
        break;
    }
  }

  _startProc(cwd, initialMessage) {
    this._killProc();

    const configured = vscode.workspace.getConfiguration('openclaude');
    const launchCommand = configured.get('launchCommand', 'openclaude');
    const shimEnabled = configured.get('useOpenAIShim', false);

    const env = {};
    if (shimEnabled) env.CLAUDE_CODE_USE_OPENAI = '1';

    const proc = new OpenClaudeProcess(launchCommand, cwd, env);

    const stderrLines = [];
    let readySent = false;
    let startupTimer;

    // Timeout: if no ready after 20s, surface stderr as error
    const initTimeout = setTimeout(() => {
      if (!readySent) {
        const msg = stderrLines.length
          ? stderrLines.join('\n')
          : 'OpenClaude did not start. Check that the openclaude command works in a terminal.';
        this._postToWebview({ type: 'error', text: msg });
      }
    }, 20000);

    const sendReady = () => {
      if (!readySent) {
        readySent = true;
        clearTimeout(initTimeout);
        clearTimeout(startupTimer);
        this._postToWebview({ type: 'ready' });
        if (initialMessage) {
          proc.send(initialMessage);
          this._postToWebview({ type: 'busy' });
        }
      }
    };

    proc.onEvent = (event) => {
      if (!event || !event.type) return;

      switch (event.type) {
        case '_stderr':
          stderrLines.push(event.text);
          // Show stderr live in the chat so the user can see what's happening
          this._postToWebview({ type: 'stderr', text: event.text });
          break;

        case '_error':
          clearTimeout(initTimeout);
          clearTimeout(startupTimer);
          this._postToWebview({ type: 'error', text: event.text });
          break;

        case 'system':
          if (event.subtype === 'init') {
            sendReady();
          }
          break;

        case 'assistant': {
          const msg = event.message;
          if (!msg || !Array.isArray(msg.content)) break;
          this._postToWebview({ type: 'assistant', content: msg.content });
          break;
        }

        case 'user': {
          // Tool results come back as user messages with tool_result blocks
          const msg = event.message;
          if (!msg || !Array.isArray(msg.content)) break;
          const toolResults = msg.content.filter(b => b.type === 'tool_result');
          if (toolResults.length > 0) {
            this._postToWebview({ type: 'tool_result', content: toolResults });
          }
          break;
        }

        case 'result':
          this._postToWebview({ type: 'result', subtype: event.subtype });
          break;

        default:
          break;
      }
    };

    proc.onExit = (_code) => {
      clearTimeout(initTimeout);
      clearTimeout(startupTimer);
      this._proc = null;
      this._postToWebview({ type: 'killed' });
    };

    proc.start();
    this._proc = proc;

    // If system.init is not emitted before first message (some versions of openclaude
    // only emit it after receiving stdin), mark as ready after a short startup delay.
    startupTimer = setTimeout(() => {
      if (proc.isAlive()) sendReady();
    }, 1500);
  }

  _killProc() {
    if (this._proc) {
      this._proc.kill();
      this._proc = null;
    }
  }

  _postToWebview(msg) {
    if (this._panel) {
      this._panel.webview.postMessage(msg);
    }
  }

  dispose() {
    this._killProc();
    if (this._panel) {
      this._panel.dispose();
      this._panel = null;
    }
  }
}

module.exports = { ChatPanelProvider };
