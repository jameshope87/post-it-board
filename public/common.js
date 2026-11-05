'use strict';

// Shared helpers for the teacher and student pages.
window.PB = (() => {
  const COLORS = {
    yellow: '#fff59d',
    pink: '#f8bbd0',
    blue: '#b3e5fc',
    green: '#c5e1a5',
    orange: '#ffcc80',
    purple: '#d1c4e9',
  };
  const FONT = '"Segoe UI", system-ui, -apple-system, Roboto, "Helvetica Neue", Arial, sans-serif';
  const BULLET_RE = /^\s*[-*•]\s+/;

  /** Split note text into lines, marking bullet points. */
  function parseNote(text) {
    return String(text).split('\n').map((line) =>
      BULLET_RE.test(line) ? { bullet: true, text: line.replace(BULLET_RE, '') } : { bullet: false, text: line }
    );
  }

  /** Render note text into an element safely (no HTML is ever interpreted). */
  function renderNoteText(el, text) {
    el.replaceChildren();
    let ul = null;
    for (const line of parseNote(text)) {
      if (line.bullet) {
        if (!ul) {
          ul = document.createElement('ul');
          el.append(ul);
        }
        const li = document.createElement('li');
        li.textContent = line.text;
        ul.append(li);
      } else {
        ul = null;
        const p = document.createElement('p');
        if (line.text.trim()) p.textContent = line.text;
        else p.className = 'gap';
        el.append(p);
      }
    }
  }

  /** Shrink the font of a fixed-height text box until its content fits. */
  function fitText(textEl, maxPx, minPx) {
    let size = Math.round(maxPx);
    textEl.style.fontSize = size + 'px';
    while (size > minPx && textEl.scrollHeight > textEl.clientHeight + 1) {
      size -= 1;
      textEl.style.fontSize = size + 'px';
    }
  }

  function wsUrl() {
    const u = new URL('ws', location.href);
    u.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    u.search = '';
    u.hash = '';
    return u.href;
  }

  /** The address of the student page (the folder this app is served from). */
  function baseUrl() {
    const u = new URL('./', location.href);
    u.search = '';
    u.hash = '';
    return u.href;
  }

  /**
   * Open a WebSocket that reconnects automatically.
   * hello() is called on every (re)connect and returns the first message to send.
   */
  function connect({ hello, onMessage, onStatus }) {
    let ws = null;
    let retry = 0;
    let stopped = false;
    let timer = null;

    function open() {
      ws = new WebSocket(wsUrl());
      ws.onopen = () => {
        retry = 0;
        if (onStatus) onStatus('open');
        const h = hello();
        if (h) ws.send(JSON.stringify(h));
      };
      ws.onmessage = (e) => {
        let msg;
        try { msg = JSON.parse(e.data); } catch { return; }
        onMessage(msg);
      };
      ws.onclose = () => {
        if (stopped) return;
        retry += 1;
        if (onStatus) onStatus('reconnecting');
        timer = setTimeout(open, Math.min(10000, 500 * 2 ** retry));
      };
    }
    open();

    return {
      send(msg) {
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify(msg));
          return true;
        }
        return false;
      },
      stop() {
        stopped = true;
        clearTimeout(timer);
        if (ws) ws.close();
      },
    };
  }

  function store(key, value) {
    try {
      if (value === null) localStorage.removeItem(key);
      else localStorage.setItem(key, JSON.stringify(value));
    } catch { /* storage unavailable - fine */ }
  }
  function load(key) {
    try { return JSON.parse(localStorage.getItem(key)); } catch { return null; }
  }

  return { COLORS, FONT, parseNote, renderNoteText, fitText, wsUrl, baseUrl, connect, store, load };
})();
