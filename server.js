'use strict';

/*
 * Post-it Board server
 * --------------------
 * - Serves the static pages in ./public
 * - Keeps every board in memory only (no database, nothing written to disk)
 * - Uses one WebSocket endpoint (/ws) for teachers and students
 *
 * A board is deleted when:
 *   - the teacher presses "Close board", or
 *   - no teacher has been connected for GRACE_MINUTES (covers refreshes / accidental closes), or
 *   - it reaches BOARD_MAX_HOURS old.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const QRCode = require('qrcode');

// ---------- Configuration ----------
function num(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const PORT = num(process.env.PORT, 3000);
const PASSPHRASE = process.env.TEACHER_PASSPHRASE || '';
const GRACE_MS = num(process.env.GRACE_MINUTES, 5) * 60 * 1000;
const MAX_AGE_MS = num(process.env.BOARD_MAX_HOURS, 2) * 60 * 60 * 1000;
const MAX_BOARDS = num(process.env.MAX_BOARDS, 50);
const MAX_STUDENTS = num(process.env.MAX_STUDENTS_PER_BOARD, 40);
const TRUST_PROXY = process.env.TRUST_PROXY !== '0';

if (PASSPHRASE.length < 8) {
  console.error('ERROR: TEACHER_PASSPHRASE must be set and at least 8 characters long.');
  process.exit(1);
}

const NOTE_MAX_CHARS = 300;
const NOTE_MAX_LINES = 12;
const PROMPT_MAX_CHARS = 200;
const MAX_NOTES_PER_BOARD = 300;
const MAX_PENDING_PER_BOARD = 150;
const STUDENT_NOTE_INTERVAL_MS = 3000;
const STUDENT_MAX_NOTES = 15;
const COLORS = ['yellow', 'pink', 'blue', 'green', 'orange', 'purple'];
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O, 1/I/L
const CODE_LENGTH = 6;

// ---------- Simple rate limiter ----------
const buckets = new Map();
function rateLimited(key, max, windowMs) {
  const now = Date.now();
  let b = buckets.get(key);
  if (!b || b.resetAt <= now) {
    b = { count: 0, resetAt: now + windowMs };
    buckets.set(key, b);
  }
  b.count += 1;
  return b.count > max;
}
setInterval(() => {
  const now = Date.now();
  for (const [k, b] of buckets) if (b.resetAt <= now) buckets.delete(k);
}, 60 * 1000).unref();

// ---------- Helpers ----------
function clientIp(req) {
  if (TRUST_PROXY) {
    const xff = req.headers['x-forwarded-for'];
    if (xff) {
      // Apache appends the real client address as the last entry.
      const parts = String(xff).split(',').map((s) => s.trim()).filter(Boolean);
      if (parts.length) return parts[parts.length - 1];
    }
  }
  return req.socket.remoteAddress || 'unknown';
}

function publicHosts(req) {
  const hosts = new Set();
  if (req.headers.host) hosts.add(String(req.headers.host).toLowerCase());
  if (TRUST_PROXY && req.headers['x-forwarded-host']) {
    hosts.add(String(req.headers['x-forwarded-host']).split(',')[0].trim().toLowerCase());
  }
  return hosts;
}

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function makeCode() {
  for (let attempt = 0; attempt < 20; attempt++) {
    let code = '';
    for (let i = 0; i < CODE_LENGTH; i++) code += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
    if (!boards.has(code)) return code;
  }
  throw new Error('Could not generate a unique code');
}

function cleanText(input, maxChars, maxLines) {
  let text = String(input ?? '')
    .replace(/\r\n?/g, '\n')
    // strip control characters except newline and tab
    .replace(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g, '')
    .replace(/\t/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (maxLines) text = text.split('\n').slice(0, maxLines).join('\n');
  return text.slice(0, maxChars);
}

function clamp01(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

function send(ws, msg) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

// ---------- Boards ----------
/** @type {Map<string, any>} */
const boards = new Map();

function createBoard() {
  const code = makeCode();
  const now = Date.now();
  const board = {
    code,
    token: crypto.randomBytes(24).toString('base64url'),
    createdAt: now,
    expiresAt: now + MAX_AGE_MS,
    prompt: '',
    locked: false,
    notes: new Map(),
    teachers: new Set(),
    students: new Set(),
    graceTimer: null,
    expiryTimer: null,
  };
  board.expiryTimer = setTimeout(() => deleteBoard(board, 'expired'), MAX_AGE_MS);
  boards.set(code, board);
  console.log(`[board ${code}] created (${boards.size} active)`);
  return board;
}

function deleteBoard(board, reason) {
  if (!boards.has(board.code)) return;
  clearTimeout(board.graceTimer);
  clearTimeout(board.expiryTimer);
  boards.delete(board.code);
  for (const ws of [...board.teachers, ...board.students]) {
    send(ws, { type: 'closed', reason });
    ws.close(1000, 'Board closed');
  }
  board.notes.clear();
  console.log(`[board ${board.code}] deleted: ${reason} (${boards.size} active)`);
}

function boardState(board) {
  return {
    type: 'state',
    code: board.code,
    prompt: board.prompt,
    locked: board.locked,
    expiresAt: board.expiresAt,
    studentCount: board.students.size,
    notes: [...board.notes.values()],
  };
}

function toTeachers(board, msg) {
  for (const ws of board.teachers) send(ws, msg);
}
function toStudents(board, msg) {
  for (const ws of board.students) send(ws, msg);
}
function studentCountChanged(board) {
  toTeachers(board, { type: 'students', count: board.students.size });
}

// ---------- Static files (whitelisted, loaded into memory at startup) ----------
const PUBLIC_DIR = path.join(__dirname, 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};
const staticFiles = new Map();
for (const name of fs.readdirSync(PUBLIC_DIR)) {
  const full = path.join(PUBLIC_DIR, name);
  if (fs.statSync(full).isFile() && MIME[path.extname(name)]) {
    staticFiles.set('/' + name, { body: fs.readFileSync(full), type: MIME[path.extname(name)] });
  }
}
staticFiles.set('/', staticFiles.get('/index.html'));
staticFiles.set('/teacher', staticFiles.get('/teacher.html'));

function securityHeaders(req) {
  const hosts = [...publicHosts(req)].filter((h) => /^[a-z0-9.\-:[\]]+$/.test(h));
  const wsSources = hosts.flatMap((h) => [`wss://${h}`, `ws://${h}`]).join(' ');
  return {
    'Content-Security-Policy':
      `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; ` +
      `connect-src 'self' ${wsSources}; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`,
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'DENY',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const headers = securityHeaders(req);

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, headers).end();
    return;
  }

  if (url.pathname === '/healthz') {
    res.writeHead(200, { ...headers, 'Content-Type': 'text/plain' }).end('ok');
    return;
  }

  if (url.pathname === '/qr') {
    const data = url.searchParams.get('data') || '';
    if (data.length > 300 || !/^https?:\/\//i.test(data)) {
      res.writeHead(400, headers).end();
      return;
    }
    try {
      const svg = await QRCode.toString(data, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
      res.writeHead(200, { ...headers, 'Content-Type': 'image/svg+xml', 'Cache-Control': 'private, max-age=3600' });
      res.end(svg);
    } catch {
      res.writeHead(500, headers).end();
    }
    return;
  }

  const file = staticFiles.get(url.pathname);
  if (!file) {
    res.writeHead(404, { ...headers, 'Content-Type': 'text/plain' }).end('Not found');
    return;
  }
  res.writeHead(200, { ...headers, 'Content-Type': file.type, 'Cache-Control': 'no-cache' });
  res.end(req.method === 'HEAD' ? undefined : file.body);
});

// ---------- WebSockets ----------
const wss = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 });

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname !== '/ws') {
    socket.destroy();
    return;
  }
  // Only accept connections from pages served by this site (stops other websites connecting).
  const origin = req.headers.origin;
  if (origin) {
    let originHost = '';
    try { originHost = new URL(origin).host.toLowerCase(); } catch { /* ignore */ }
    if (!publicHosts(req).has(originHost)) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }
  }
  if (rateLimited('conn:' + clientIp(req), 300, 60 * 1000)) {
    socket.write('HTTP/1.1 429 Too Many Requests\r\n\r\n');
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});

wss.on('connection', (ws, req) => {
  ws.ip = clientIp(req);
  ws.isAlive = true;
  ws.role = null;     // 'teacher' | 'student'
  ws.board = null;
  ws.notesSent = 0;
  ws.lastNoteAt = 0;

  ws.on('pong', () => { ws.isAlive = true; });

  // Must identify within 15s
  const helloTimer = setTimeout(() => { if (!ws.role) ws.close(4000, 'Timeout'); }, 15000);

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (!msg || typeof msg.type !== 'string') return;
    try {
      if (!ws.role) handleHello(ws, msg);
      else if (ws.role === 'teacher') handleTeacher(ws, msg);
      else if (ws.role === 'student') handleStudent(ws, msg);
    } catch (err) {
      console.error('Message handling error:', err);
    }
  });

  ws.on('close', () => {
    clearTimeout(helloTimer);
    const board = ws.board;
    if (!board || !boards.has(board.code)) return;
    if (ws.role === 'teacher') {
      board.teachers.delete(ws);
      if (board.teachers.size === 0) {
        clearTimeout(board.graceTimer);
        board.graceTimer = setTimeout(() => deleteBoard(board, 'teacher-left'), GRACE_MS);
        console.log(`[board ${board.code}] teacher disconnected, deleting in ${GRACE_MS / 60000} min unless they return`);
      }
    } else if (ws.role === 'student') {
      board.students.delete(ws);
      studentCountChanged(board);
    }
  });
});

function fail(ws, message, close = true) {
  send(ws, { type: 'error', message, fatal: close });
  if (close) ws.close(4001, 'Rejected');
}

function handleHello(ws, msg) {
  if (msg.type === 'create') {
    if (rateLimited('pass:' + ws.ip, 10, 15 * 60 * 1000)) {
      return fail(ws, 'Too many attempts. Please wait 15 minutes and try again.');
    }
    if (!safeEqual(msg.passphrase || '', PASSPHRASE)) {
      return fail(ws, 'Incorrect passphrase.');
    }
    if (boards.size >= MAX_BOARDS) {
      return fail(ws, 'The server has reached its limit of open boards. Please try again later.');
    }
    const board = createBoard();
    attachTeacher(ws, board);
    send(ws, { type: 'created', code: board.code, token: board.token });
    send(ws, boardState(board));
    return;
  }

  if (msg.type === 'teacher-join') {
    const board = boards.get(String(msg.code || '').toUpperCase());
    if (rateLimited('tjoin:' + ws.ip, 60, 10 * 60 * 1000)) return fail(ws, 'Too many attempts. Please wait a few minutes.');
    if (!board || !safeEqual(msg.token || '', board.token)) {
      return fail(ws, 'This board no longer exists. It may have expired or been closed.');
    }
    attachTeacher(ws, board);
    send(ws, boardState(board));
    return;
  }

  if (msg.type === 'student-join') {
    const code = String(msg.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    const board = boards.get(code);
    if (!board) {
      // Generous limit: a whole class may share one school IP address.
      if (rateLimited('sjoinfail:' + ws.ip, 100, 10 * 60 * 1000)) {
        return fail(ws, 'Too many incorrect codes. Please wait a few minutes.');
      }
      return fail(ws, 'No board found with that code. Check the code and try again.');
    }
    if (board.students.size >= MAX_STUDENTS) return fail(ws, 'This board is full.');
    ws.role = 'student';
    ws.board = board;
    board.students.add(ws);
    send(ws, { type: 'joined', code: board.code, prompt: board.prompt, locked: board.locked, colors: COLORS });
    studentCountChanged(board);
    return;
  }
}

function attachTeacher(ws, board) {
  ws.role = 'teacher';
  ws.board = board;
  board.teachers.add(ws);
  clearTimeout(board.graceTimer);
  board.graceTimer = null;
}

function handleTeacher(ws, msg) {
  const board = ws.board;
  if (!boards.has(board.code)) return;

  switch (msg.type) {
    case 'approve': {
      const note = board.notes.get(msg.id);
      if (!note || note.status !== 'pending') return;
      note.status = 'approved';
      note.x = clamp01(msg.x);
      note.y = clamp01(msg.y);
      toTeachers(board, { type: 'note', note });
      break;
    }
    case 'move': {
      const note = board.notes.get(msg.id);
      if (!note || note.status !== 'approved') return;
      note.x = clamp01(msg.x);
      note.y = clamp01(msg.y);
      // tell other teacher windows (if any) about the new position
      for (const t of board.teachers) if (t !== ws) send(t, { type: 'note', note });
      break;
    }
    case 'delete': {
      if (board.notes.delete(msg.id)) toTeachers(board, { type: 'removed', id: msg.id });
      break;
    }
    case 'clear': {
      board.notes.clear();
      toTeachers(board, boardState(board));
      break;
    }
    case 'lock': {
      board.locked = !!msg.locked;
      toTeachers(board, { type: 'locked', locked: board.locked });
      toStudents(board, { type: 'locked', locked: board.locked });
      break;
    }
    case 'prompt': {
      board.prompt = cleanText(msg.text, PROMPT_MAX_CHARS, 3);
      toTeachers(board, { type: 'prompt', prompt: board.prompt });
      toStudents(board, { type: 'prompt', prompt: board.prompt });
      break;
    }
    case 'close': {
      deleteBoard(board, 'closed-by-teacher');
      break;
    }
  }
}

function handleStudent(ws, msg) {
  const board = ws.board;
  if (!boards.has(board.code) || msg.type !== 'note') return;

  if (board.locked) return fail(ws, 'The board is locked. Your teacher has paused new notes.', false);

  const text = cleanText(msg.text, NOTE_MAX_CHARS, NOTE_MAX_LINES);
  if (!text) return fail(ws, 'Your note is empty.', false);

  const now = Date.now();
  if (now - ws.lastNoteAt < STUDENT_NOTE_INTERVAL_MS) {
    return fail(ws, 'Slow down a little! Wait a few seconds before posting again.', false);
  }
  if (ws.notesSent >= STUDENT_MAX_NOTES) return fail(ws, 'You have posted the maximum number of notes.', false);

  let pending = 0;
  for (const n of board.notes.values()) if (n.status === 'pending') pending++;
  if (board.notes.size >= MAX_NOTES_PER_BOARD || pending >= MAX_PENDING_PER_BOARD) {
    return fail(ws, 'The board is full right now.', false);
  }

  const note = {
    id: crypto.randomUUID(),
    text,
    color: COLORS.includes(msg.color) ? msg.color : COLORS[0],
    status: 'pending',
    x: 0,
    y: 0,
    createdAt: now,
  };
  board.notes.set(note.id, note);
  ws.lastNoteAt = now;
  ws.notesSent += 1;
  toTeachers(board, { type: 'note', note });
  send(ws, { type: 'sent' });
}

// Drop dead connections (e.g. a laptop that went to sleep) so the grace timer can start.
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 30 * 1000);

server.listen(PORT, () => {
  console.log(`Post-it board listening on port ${PORT}`);
  console.log(`Grace period ${GRACE_MS / 60000} min, max board age ${MAX_AGE_MS / 3600000} h, max ${MAX_BOARDS} boards`);
});

function shutdown() {
  console.log('Shutting down');
  clearInterval(heartbeat);
  for (const board of [...boards.values()]) deleteBoard(board, 'server-restart');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
