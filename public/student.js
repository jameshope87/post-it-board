'use strict';

(() => {
  const $ = (id) => document.getElementById(id);
  const screens = { join: $('join-screen'), write: $('write-screen'), closed: $('closed-screen') };
  const codeInput = $('code');
  const textArea = $('note-text');
  const postBtn = $('post-btn');
  const noteMsg = $('note-msg');

  let conn = null;
  let code = '';
  let joined = false;
  let locked = false;
  let posting = false;
  let postTimer = null;
  let colour = PB.load('pb-colour') || 'yellow';
  if (!PB.COLORS[colour]) colour = 'yellow';

  function show(name) {
    for (const [key, el] of Object.entries(screens)) el.hidden = key !== name;
  }

  // ---------- Colour swatches ----------
  const colourList = $('colour-list');
  for (const name of Object.keys(PB.COLORS)) {
    const label = document.createElement('label');
    label.className = 'swatch';
    label.style.background = PB.COLORS[name];
    label.title = name;
    const input = document.createElement('input');
    input.type = 'radio';
    input.name = 'colour';
    input.value = name;
    input.checked = name === colour;
    input.setAttribute('aria-label', name);
    input.addEventListener('change', () => {
      colour = name;
      PB.store('pb-colour', colour);
      applyColour();
    });
    label.append(input);
    colourList.append(label);
  }
  function applyColour() {
    textArea.style.background = PB.COLORS[colour];
  }
  applyColour();

  // ---------- Joining ----------
  function join(c) {
    code = c.toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (!code) return;
    $('join-msg').textContent = 'Joining…';
    $('join-btn').disabled = true;
    if (conn) conn.stop();
    conn = PB.connect({
      hello: () => ({ type: 'student-join', code }),
      onMessage,
      onStatus: (s) => {
        $('conn-banner').hidden = !(s === 'reconnecting' && joined);
      },
    });
  }

  $('join-form').addEventListener('submit', (e) => {
    e.preventDefault();
    join(codeInput.value);
  });

  codeInput.addEventListener('input', () => {
    codeInput.value = codeInput.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
  });

  function onMessage(msg) {
    switch (msg.type) {
      case 'joined':
        joined = true;
        $('join-btn').disabled = false;
        $('join-msg').textContent = '';
        setPrompt(msg.prompt);
        setLocked(msg.locked);
        // Keep the code in the address bar so a refresh rejoins automatically.
        history.replaceState(null, '', '?code=' + encodeURIComponent(msg.code));
        show('write');
        textArea.focus();
        break;
      case 'prompt':
        setPrompt(msg.prompt);
        break;
      case 'locked':
        setLocked(msg.locked);
        break;
      case 'sent':
        finishPosting();
        textArea.value = '';
        updateCounter();
        noteMsg.textContent = '✓ Sent! Your teacher will see it soon. You can post another.';
        noteMsg.className = 'msg ok';
        break;
      case 'error':
        if (msg.fatal) {
          conn.stop();
          $('join-btn').disabled = false;
          if (joined) {
            // Lost connection and the board was closed in the meantime.
            show('closed');
          } else {
            $('join-msg').textContent = msg.message;
            show('join');
            codeInput.focus();
          }
        } else {
          finishPosting();
          noteMsg.textContent = msg.message;
          noteMsg.className = 'msg error';
        }
        break;
      case 'closed':
        conn.stop();
        show('closed');
        break;
    }
  }

  function setPrompt(text) {
    $('prompt').textContent = text || '';
    $('prompt').hidden = !text;
  }

  function setLocked(value) {
    locked = !!value;
    $('locked-banner').hidden = !locked;
    postBtn.disabled = locked || posting;
  }

  // ---------- Writing ----------
  function updateCounter() {
    $('counter').textContent = `${textArea.value.length} / 300`;
  }
  textArea.addEventListener('input', () => {
    updateCounter();
    if (noteMsg.classList.contains('ok')) noteMsg.textContent = '';
  });

  function currentLine() {
    const pos = textArea.selectionStart;
    const start = textArea.value.lastIndexOf('\n', pos - 1) + 1;
    let end = textArea.value.indexOf('\n', pos);
    if (end === -1) end = textArea.value.length;
    return { start, end, text: textArea.value.slice(start, end), pos };
  }

  function insertAt(start, end, text, caret) {
    textArea.setRangeText(text, start, end, 'end');
    if (caret !== undefined) textArea.setSelectionRange(caret, caret);
    textArea.dispatchEvent(new Event('input'));
  }

  $('bullet-btn').addEventListener('click', () => {
    textArea.focus();
    const line = currentLine();
    if (/^\s*[-*•]\s/.test(line.text)) return;
    if (line.text.trim() === '') {
      insertAt(line.start, line.end, '• ');
    } else {
      // start a new bullet line after the current line
      insertAt(line.end, line.end, '\n• ');
    }
  });

  // Enter on a bullet line continues the list; Enter on an empty bullet ends it.
  textArea.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.shiftKey) return;
    const line = currentLine();
    const m = line.text.match(/^\s*[-*•]\s+/);
    if (!m) return;
    e.preventDefault();
    if (line.text.trim() === m[0].trim()) {
      insertAt(line.start, line.end, '');
    } else {
      insertAt(line.pos, line.pos, '\n• ');
    }
  });

  $('note-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const text = textArea.value.trim();
    if (!text || locked || posting) return;
    if (!conn.send({ type: 'note', text, color: colour })) {
      noteMsg.textContent = 'Not connected - please wait a moment and try again.';
      noteMsg.className = 'msg error';
      return;
    }
    posting = true;
    postBtn.disabled = true;
    noteMsg.textContent = 'Sending…';
    noteMsg.className = 'msg';
    postTimer = setTimeout(() => {
      finishPosting();
      noteMsg.textContent = 'No reply from the board - please try again.';
      noteMsg.className = 'msg error';
    }, 8000);
  });

  function finishPosting() {
    clearTimeout(postTimer);
    posting = false;
    postBtn.disabled = locked;
  }

  // ---------- Start ----------
  const fromUrl = new URLSearchParams(location.search).get('code');
  if (fromUrl) {
    codeInput.value = fromUrl.toUpperCase().replace(/[^A-Z0-9]/g, '');
    join(codeInput.value);
  } else {
    codeInput.focus();
  }
})();
