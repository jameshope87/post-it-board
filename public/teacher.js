'use strict';

(() => {
  const $ = (id) => document.getElementById(id);
  const boardEl = $('board');
  const queueEl = $('queue');
  const queueList = $('queue-list');
  const promptInput = $('prompt');
  const STORE_KEY = 'pb-teacher';

  let conn = null;
  let session = PB.load(STORE_KEY); // { code, token } - lets a refresh / reopened tab rejoin the board
  let pendingPass = null;
  let justCreated = false;
  let boardVisible = false;

  const state = { code: '', prompt: '', locked: false, expiresAt: 0, studentCount: 0 };
  const notes = new Map();      // id -> note
  const noteEls = new Map();    // id -> element on the board (approved notes)
  const pendingEls = new Map(); // id -> element in the approval queue
  let noteSize = 200;
  let zTop = 1;
  let draggingId = null;

  // ---------- Screens ----------
  function showStart(message) {
    boardVisible = false;
    $('board-screen').hidden = true;
    $('join-overlay').hidden = true;
    $('start-screen').hidden = false;
    $('start-msg').textContent = message || '';
    $('create-btn').disabled = false;
    resetNotes();
  }

  function showBoard() {
    $('start-screen').hidden = true;
    $('board-screen').hidden = false;
    if (!boardVisible) {
      boardVisible = true;
      layout();
    }
  }

  // ---------- Connection ----------
  function hello() {
    if (session) return { type: 'teacher-join', code: session.code, token: session.token };
    if (pendingPass) return { type: 'create', passphrase: pendingPass };
    return null;
  }

  function startConnection() {
    if (conn) conn.stop();
    conn = PB.connect({ hello, onMessage, onStatus });
  }

  function onStatus(status) {
    const el = $('conn-status');
    if (status === 'reconnecting') {
      el.textContent = '⚠ Connection lost, reconnecting…';
      el.className = 'warn';
    } else {
      el.textContent = '';
      el.className = '';
    }
  }

  function endSession(message) {
    if (conn) conn.stop();
    conn = null;
    session = null;
    pendingPass = null;
    PB.store(STORE_KEY, null);
    showStart(message);
  }

  const CLOSE_REASONS = {
    'closed-by-teacher': 'Board closed. All notes have been deleted.',
    'expired': 'The board reached its time limit and was closed automatically.',
    'teacher-left': 'The board was closed because you were away for too long.',
    'server-restart': 'The server restarted, so the board was closed.',
  };

  function onMessage(msg) {
    switch (msg.type) {
      case 'created':
        session = { code: msg.code, token: msg.token };
        pendingPass = null;
        $('pass').value = '';
        PB.store(STORE_KEY, session);
        break;
      case 'state':
        applyState(msg);
        showBoard();
        if (justCreated) {
          justCreated = false;
          openJoinOverlay();
        }
        break;
      case 'note':
        upsertNote(msg.note);
        break;
      case 'removed':
        removeNote(msg.id);
        break;
      case 'locked':
        setLocked(msg.locked);
        break;
      case 'prompt':
        state.prompt = msg.prompt;
        if (document.activeElement !== promptInput) promptInput.value = msg.prompt;
        break;
      case 'students':
        setStudents(msg.count);
        break;
      case 'error':
        if (msg.fatal) endSession(msg.message);
        else $('conn-status').textContent = msg.message;
        break;
      case 'closed':
        endSession(CLOSE_REASONS[msg.reason] || 'Board closed.');
        break;
    }
  }

  // ---------- State ----------
  function applyState(s) {
    state.code = s.code;
    state.prompt = s.prompt;
    state.expiresAt = s.expiresAt;
    $('code-small').textContent = s.code;
    if (document.activeElement !== promptInput) promptInput.value = s.prompt;
    setLocked(s.locked);
    setStudents(s.studentCount);
    updateExpiry();
    resetNotes();
    for (const note of s.notes) upsertNote(note);
  }

  function resetNotes() {
    notes.clear();
    for (const el of noteEls.values()) el.remove();
    noteEls.clear();
    queueList.replaceChildren();
    pendingEls.clear();
    updateCounts();
  }

  function setLocked(locked) {
    state.locked = !!locked;
    $('lock-btn').textContent = state.locked ? 'Unlock' : 'Lock';
    $('lock-btn').classList.toggle('active', state.locked);
    $('locked-banner').hidden = !state.locked;
  }

  function setStudents(count) {
    state.studentCount = count;
    $('student-count').textContent = count;
  }

  function updateExpiry() {
    if (!state.expiresAt) return;
    const t = new Date(state.expiresAt);
    const mins = Math.round((state.expiresAt - Date.now()) / 60000);
    const el = $('expires');
    el.textContent = `Closes automatically at ${t.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` +
      (mins <= 15 ? ` (${Math.max(0, mins)} min left. Save an image if you want to keep the notes)` : '');
    el.className = mins <= 15 ? 'warn' : '';
  }
  setInterval(updateExpiry, 30000);

  function updateCounts() {
    let pending = 0;
    for (const n of notes.values()) if (n.status === 'pending') pending++;
    $('pending-count').textContent = pending;
    $('pending-count').classList.toggle('has-items', pending > 0);
    $('queue-empty').hidden = pending > 0;
    $('approve-all').disabled = pending === 0;
    $('empty-hint').hidden = noteEls.size > 0;
  }

  // ---------- Notes ----------
  function rotation(id) {
    let h = 0;
    for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    return ((h % 50) - 25) / 10; // -2.5° .. +2.4°
  }

  function upsertNote(note) {
    notes.set(note.id, note);
    if (note.status === 'pending') {
      renderPending(note);
    } else {
      removePending(note.id);
      renderApproved(note);
    }
    updateCounts();
  }

  function removeNote(id) {
    notes.delete(id);
    removePending(id);
    const el = noteEls.get(id);
    if (el) {
      el.remove();
      noteEls.delete(id);
    }
    updateCounts();
  }

  function renderPending(note) {
    if (pendingEls.has(note.id)) return;
    const li = document.createElement('li');
    li.className = 'pending';
    li.style.background = PB.COLORS[note.color] || PB.COLORS.yellow;
    li.tabIndex = 0;

    const text = document.createElement('div');
    text.className = 'pending-text';
    PB.renderNoteText(text, note.text);

    const actions = document.createElement('div');
    actions.className = 'pending-actions';
    const ok = document.createElement('button');
    ok.className = 'small approve';
    ok.textContent = '✓ Approve';
    ok.addEventListener('click', () => approve([note.id]));
    const no = document.createElement('button');
    no.className = 'small reject';
    no.textContent = '✕ Delete';
    no.addEventListener('click', () => conn && conn.send({ type: 'delete', id: note.id }));
    actions.append(ok, no);

    li.append(text, actions);
    queueList.append(li);
    pendingEls.set(note.id, li);
  }

  function removePending(id) {
    const li = pendingEls.get(id);
    if (li) {
      li.remove();
      pendingEls.delete(id);
    }
  }

  function renderApproved(note) {
    let el = noteEls.get(note.id);
    if (!el) {
      el = document.createElement('div');
      el.className = 'note';
      el.style.setProperty('--rot', rotation(note.id) + 'deg');
      el.style.zIndex = String(++zTop);

      const del = document.createElement('button');
      del.className = 'note-del';
      del.textContent = '✕';
      del.title = 'Delete note';
      del.setAttribute('aria-label', 'Delete note');
      del.addEventListener('click', () => conn && conn.send({ type: 'delete', id: note.id }));

      const text = document.createElement('div');
      text.className = 'note-text';

      el.append(del, text);
      enableDrag(el, note.id);
      boardEl.append(el);
      noteEls.set(note.id, el);
    }
    el.style.background = PB.COLORS[note.color] || PB.COLORS.yellow;
    PB.renderNoteText(el.querySelector('.note-text'), note.text);
    if (draggingId !== note.id) positionNote(el, note);
    PB.fitText(el.querySelector('.note-text'), noteSize * 0.13, 10);
  }

  function positionNote(el, note) {
    const maxL = Math.max(0, boardEl.clientWidth - noteSize);
    const maxT = Math.max(0, boardEl.clientHeight - noteSize);
    el.style.left = Math.round(note.x * maxL) + 'px';
    el.style.top = Math.round(note.y * maxT) + 'px';
  }

  function layout() {
    if (!boardVisible) return;
    const W = boardEl.clientWidth;
    noteSize = Math.round(Math.min(240, Math.max(150, W / 7)));
    boardEl.style.setProperty('--note-size', noteSize + 'px');
    for (const [id, el] of noteEls) {
      const note = notes.get(id);
      if (note) positionNote(el, note);
      PB.fitText(el.querySelector('.note-text'), noteSize * 0.13, 10);
    }
  }
  new ResizeObserver(layout).observe(boardEl);

  // ---------- Dragging ----------
  function enableDrag(el, id) {
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || e.target.closest('.note-del')) return;
      e.preventDefault();
      const startX = e.clientX;
      const startY = e.clientY;
      const origL = el.offsetLeft;
      const origT = el.offsetTop;
      draggingId = id;
      el.setPointerCapture(e.pointerId);
      el.classList.add('dragging');
      el.style.zIndex = String(++zTop);

      const move = (ev) => {
        const maxL = Math.max(0, boardEl.clientWidth - noteSize);
        const maxT = Math.max(0, boardEl.clientHeight - noteSize);
        el.style.left = Math.min(maxL, Math.max(0, origL + ev.clientX - startX)) + 'px';
        el.style.top = Math.min(maxT, Math.max(0, origT + ev.clientY - startY)) + 'px';
      };
      const up = () => {
        el.removeEventListener('pointermove', move);
        el.removeEventListener('pointerup', up);
        el.removeEventListener('pointercancel', up);
        el.classList.remove('dragging');
        draggingId = null;
        const note = notes.get(id);
        if (!note) return;
        const maxL = Math.max(1, boardEl.clientWidth - noteSize);
        const maxT = Math.max(1, boardEl.clientHeight - noteSize);
        note.x = Math.min(1, el.offsetLeft / maxL);
        note.y = Math.min(1, el.offsetTop / maxT);
        if (conn) conn.send({ type: 'move', id, x: note.x, y: note.y });
      };
      el.addEventListener('pointermove', move);
      el.addEventListener('pointerup', up);
      el.addEventListener('pointercancel', up);
    });
  }

  // ---------- Approving (places notes in the first free grid spot) ----------
  function findFreeSpot(reserved) {
    const W = boardEl.clientWidth;
    const H = boardEl.clientHeight;
    const S = noteSize;
    const gap = 16;
    const taken = [...noteEls.values()].map((el) => ({ l: el.offsetLeft, t: el.offsetTop })).concat(reserved);
    for (let t = gap; t + S <= H; t += S + gap) {
      for (let l = gap; l + S <= W; l += S + gap) {
        const overlaps = taken.some((o) => l < o.l + S && l + S > o.l && t < o.t + S && t + S > o.t);
        if (!overlaps) return { l, t };
      }
    }
    // Board is full - scatter the note somewhere.
    return { l: Math.random() * Math.max(0, W - S), t: Math.random() * Math.max(0, H - S) };
  }

  function approve(ids) {
    if (!conn) return;
    const reserved = [];
    const maxL = Math.max(1, boardEl.clientWidth - noteSize);
    const maxT = Math.max(1, boardEl.clientHeight - noteSize);
    for (const id of ids) {
      const spot = findFreeSpot(reserved);
      reserved.push(spot);
      conn.send({ type: 'approve', id, x: Math.min(1, spot.l / maxL), y: Math.min(1, spot.t / maxT) });
    }
  }

  $('approve-all').addEventListener('click', () => {
    const ids = [...notes.values()]
      .filter((n) => n.status === 'pending')
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((n) => n.id);
    approve(ids);
  });

  // ---------- Toolbar ----------
  let promptTimer = null;
  promptInput.addEventListener('input', () => {
    clearTimeout(promptTimer);
    promptTimer = setTimeout(() => conn && conn.send({ type: 'prompt', text: promptInput.value }), 400);
  });
  promptInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') promptInput.blur();
  });

  $('lock-btn').addEventListener('click', () => conn && conn.send({ type: 'lock', locked: !state.locked }));

  $('clear-btn').addEventListener('click', () => {
    if (confirm('Remove ALL notes from the board, including ones waiting for approval?')) {
      conn && conn.send({ type: 'clear' });
    }
  });

  $('close-btn').addEventListener('click', () => {
    if (confirm('Close this board? All notes will be deleted and students will be disconnected.\n\nTip: use "Save image" first if you want to keep a copy.')) {
      conn && conn.send({ type: 'close' });
    }
  });

  $('queue-btn').addEventListener('click', () => {
    queueEl.hidden = !queueEl.hidden;
    $('queue-btn').setAttribute('aria-expanded', String(!queueEl.hidden));
  });

  const blurToggle = $('blur-toggle');
  const savedBlur = PB.load('pb-blur');
  if (savedBlur === false) blurToggle.checked = false;
  queueEl.classList.toggle('blurred', blurToggle.checked);
  blurToggle.addEventListener('change', () => {
    queueEl.classList.toggle('blurred', blurToggle.checked);
    PB.store('pb-blur', blurToggle.checked);
  });

  $('save-btn').addEventListener('click', saveImage);

  // ---------- Join overlay ----------
  function openJoinOverlay() {
    const base = PB.baseUrl();
    $('join-url').textContent = base.replace(/^https?:\/\//, '').replace(/\/$/, '');
    $('join-code').textContent = state.code;
    $('join-qr').src = 'qr?data=' + encodeURIComponent(base + '?code=' + state.code);
    $('join-overlay').hidden = false;
    $('join-close').focus();
  }
  function closeJoinOverlay() {
    $('join-overlay').hidden = true;
  }
  $('join-btn').addEventListener('click', openJoinOverlay);
  $('join-close').addEventListener('click', closeJoinOverlay);
  $('join-overlay').addEventListener('click', (e) => {
    if (e.target === $('join-overlay')) closeJoinOverlay();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeJoinOverlay();
  });

  // ---------- Save as image ----------
  function wrapText(ctx, text, width) {
    const out = [];
    let cur = '';
    for (const word of text.split(/\s+/).filter(Boolean)) {
      const test = cur ? cur + ' ' + word : word;
      if (ctx.measureText(test).width <= width) {
        cur = test;
        continue;
      }
      if (cur) out.push(cur);
      let w = word;
      while (w.length > 1 && ctx.measureText(w).width > width) {
        let i = w.length - 1;
        while (i > 1 && ctx.measureText(w.slice(0, i)).width > width) i--;
        out.push(w.slice(0, i));
        w = w.slice(i);
      }
      cur = w;
    }
    if (cur) out.push(cur);
    return out;
  }

  function layoutNoteText(ctx, text, width, height, maxPx, minPx) {
    const blocks = PB.parseNote(text);
    for (let size = Math.round(maxPx); size >= minPx; size--) {
      ctx.font = `${size}px ${PB.FONT}`;
      const lineH = size * 1.25;
      const indent = size * 1.1;
      const lines = [];
      for (const b of blocks) {
        if (!b.text.trim()) {
          lines.push({ gap: true });
          continue;
        }
        wrapText(ctx, b.text, b.bullet ? width - indent : width).forEach((t, i) => {
          lines.push({ text: t, x: b.bullet ? indent : 0, dot: b.bullet && i === 0 });
        });
      }
      const total = lines.reduce((sum, l) => sum + (l.gap ? lineH * 0.5 : lineH), 0);
      if (total <= height || size === minPx) return { size, lineH, lines };
    }
  }

  function saveImage() {
    const W = boardEl.clientWidth;
    const S = noteSize;
    const pad = 24;
    const scale = 2;
    // Crop empty space below the lowest note.
    let lowest = 0;
    for (const el of noteEls.values()) lowest = Math.max(lowest, el.offsetTop + S);
    const H = Math.min(boardEl.clientHeight, Math.max(S + pad * 2, lowest + pad));
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');

    const prompt = state.prompt.trim();
    ctx.font = `600 28px ${PB.FONT}`;
    const promptLines = prompt ? wrapText(ctx, prompt, W - pad * 2) : [];
    const headerH = promptLines.length ? pad + promptLines.length * 36 + pad / 2 : 0;
    const footerH = 32;

    canvas.width = W * scale;
    canvas.height = (headerH + H + footerH) * scale;
    ctx.scale(scale, scale);
    ctx.textBaseline = 'top';

    ctx.fillStyle = '#efe8db';
    ctx.fillRect(0, 0, W, headerH + H + footerH);

    if (promptLines.length) {
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, W, headerH);
      ctx.fillStyle = '#1f2328';
      ctx.font = `600 28px ${PB.FONT}`;
      promptLines.forEach((line, i) => ctx.fillText(line, pad, pad + i * 36));
    }

    const ordered = [...noteEls.entries()].sort((a, b) => Number(a[1].style.zIndex) - Number(b[1].style.zIndex));
    const inner = Math.round(S * 0.08);
    for (const [id, el] of ordered) {
      const note = notes.get(id);
      if (!note) continue;
      ctx.save();
      ctx.translate(el.offsetLeft + S / 2, headerH + el.offsetTop + S / 2);
      ctx.rotate((rotation(id) * Math.PI) / 180);
      ctx.shadowColor = 'rgba(0,0,0,0.25)';
      ctx.shadowBlur = 10;
      ctx.shadowOffsetY = 4;
      ctx.fillStyle = PB.COLORS[note.color] || PB.COLORS.yellow;
      ctx.fillRect(-S / 2, -S / 2, S, S);
      ctx.shadowColor = 'transparent';
      ctx.beginPath();
      ctx.rect(-S / 2, -S / 2, S, S);
      ctx.clip();

      const box = S - inner * 2;
      const lay = layoutNoteText(ctx, note.text, box, box, S * 0.13, 10);
      ctx.fillStyle = '#1f2328';
      let y = -S / 2 + inner;
      for (const line of lay.lines) {
        if (line.gap) {
          y += lay.lineH * 0.5;
          continue;
        }
        if (line.dot) {
          ctx.beginPath();
          ctx.arc(-S / 2 + inner + lay.size * 0.4, y + lay.lineH / 2, lay.size * 0.14, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.fillText(line.text, -S / 2 + inner + line.x, y + (lay.lineH - lay.size) / 2);
        y += lay.lineH;
      }
      ctx.restore();
    }

    const date = new Date();
    const stamp = date.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
    ctx.font = `14px ${PB.FONT}`;
    ctx.fillStyle = '#6b6357';
    ctx.fillText(`Post-it Board · ${stamp}`, pad, headerH + H + 9);

    canvas.toBlob((blob) => {
      if (!blob) return;
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      const d = date.toISOString().slice(0, 16).replace('T', '_').replace(':', '-');
      a.download = `post-it-board_${d}.png`;
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    }, 'image/png');
  }

  // ---------- Start ----------
  $('create-form').addEventListener('submit', (e) => {
    e.preventDefault();
    pendingPass = $('pass').value;
    if (!pendingPass) return;
    session = null;
    justCreated = true;
    $('create-btn').disabled = true;
    $('start-msg').textContent = 'Creating board…';
    startConnection();
  });

  if (session && session.code && session.token) {
    $('start-msg').textContent = 'Reconnecting to your board…';
    $('create-btn').disabled = true;
    startConnection();
  } else {
    session = null;
    $('pass').focus();
  }
})();
