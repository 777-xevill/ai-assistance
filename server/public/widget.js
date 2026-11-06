/*!
 * Website chat widget.
 * Usage: <script src="https://YOUR-APP/widget.js" data-key="wc_..." async></script>
 */
(function () {
  'use strict';
  if (window.__aiChatWidgetLoaded) return;
  window.__aiChatWidgetLoaded = true;

  var script =
    document.currentScript ||
    document.querySelector('script[data-key][src*="widget.js"]');
  if (!script) return;
  var KEY = script.getAttribute('data-key');
  if (!KEY) return;
  // data-mode="page": the hosted chat page (/chat/KEY). Full-screen, always open, no launcher.
  var PAGE = script.getAttribute('data-mode') === 'page';
  var API = new URL(script.src).origin + '/api/widget/' + encodeURIComponent(KEY);
  var STORE = 'aichat_' + KEY;

  var state = {
    open: false,
    visitorId: null,
    messages: [],
    lastAt: null,
    typing: false,
    unread: 0,
    config: { title: 'Chat with us', color: '#0f766e', welcome: 'Hi! How can we help you today?' },
    pollTimer: null,
    recording: null,
  };

  function load(k) {
    try { return window.localStorage.getItem(STORE + '_' + k); } catch (e) { return null; }
  }
  function save(k, v) {
    try { window.localStorage.setItem(STORE + '_' + k, v); } catch (e) { /* private mode */ }
  }

  function api(path, opts) {
    opts = opts || {};
    var init = { method: opts.method || 'GET', headers: {} };
    if (opts.json) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(opts.json);
    } else if (opts.form) {
      init.body = opts.form;
    }
    return fetch(API + path, init).then(function (r) {
      return r.json().then(function (data) {
        if (!r.ok) throw new Error((data && data.error) || 'Request failed');
        return data;
      });
    });
  }

  // ---------------------------------------------------------------------------
  // UI
  // ---------------------------------------------------------------------------
  var host = document.createElement('div');
  host.id = 'ai-chat-widget';
  host.style.cssText = 'position:fixed;z-index:2147483000;bottom:0;right:0;';
  document.body.appendChild(host);
  var root = host.attachShadow ? host.attachShadow({ mode: 'open' }) : host;

  root.innerHTML =
    '<style>' +
    ':host{all:initial}' +
    '*{box-sizing:border-box;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Noto Sans","Noto Sans Bengali",Helvetica,Arial,sans-serif}' +
    '.launcher{position:fixed;right:20px;bottom:20px;width:58px;height:58px;border-radius:50%;border:none;cursor:pointer;color:#fff;box-shadow:0 8px 24px rgba(0,0,0,.18);display:flex;align-items:center;justify-content:center;transition:transform .15s}' +
    '.launcher:hover{transform:scale(1.05)}' +
    '.launcher svg{width:28px;height:28px}' +
    '.badge{position:absolute;top:-2px;right:-2px;background:#ef4444;color:#fff;border-radius:999px;font-size:11px;min-width:18px;height:18px;padding:0 5px;display:none;align-items:center;justify-content:center;font-weight:700}' +
    '.panel{position:fixed;right:20px;bottom:90px;width:370px;max-width:calc(100vw - 32px);height:560px;max-height:calc(100vh - 120px);background:#fff;border-radius:16px;box-shadow:0 16px 48px rgba(0,0,0,.2);display:none;flex-direction:column;overflow:hidden;color:#18181b}' +
    '.panel.open{display:flex}' +
    '.head{padding:16px 18px;color:#fff;display:flex;align-items:center;gap:10px}' +
    '.head .t{font-weight:700;font-size:15px;line-height:1.2}' +
    '.head .s{font-size:12px;opacity:.85;margin-top:2px}' +
    '.head .x{margin-left:auto;background:transparent;border:none;color:#fff;cursor:pointer;font-size:22px;line-height:1;opacity:.85}' +
    '.list{flex:1;overflow-y:auto;padding:16px 14px;background:#f8fafc;display:flex;flex-direction:column;gap:8px}' +
    '.msg{max-width:82%;padding:9px 12px;border-radius:14px;font-size:14px;line-height:1.45;white-space:pre-wrap;word-wrap:break-word}' +
    '.msg.b{background:#fff;border:1px solid #e4e4e7;align-self:flex-start;border-bottom-left-radius:4px}' +
    '.msg.v{color:#fff;align-self:flex-end;border-bottom-right-radius:4px}' +
    '.msg img{display:block;max-width:100%;border-radius:10px;margin:2px 0}' +
    '.msg a{color:inherit;text-decoration:underline}' +
    '.msg audio{max-width:220px}' +
    '.typing{align-self:flex-start;background:#fff;border:1px solid #e4e4e7;border-radius:14px;padding:10px 14px;display:none;gap:4px}' +
    '.typing span{width:6px;height:6px;border-radius:50%;background:#a1a1aa;animation:b 1.2s infinite}' +
    '.typing span:nth-child(2){animation-delay:.15s}.typing span:nth-child(3){animation-delay:.3s}' +
    '@keyframes b{0%,60%,100%{transform:translateY(0);opacity:.6}30%{transform:translateY(-4px);opacity:1}}' +
    '.foot{border-top:1px solid #e4e4e7;padding:10px;display:flex;gap:6px;align-items:flex-end;background:#fff}' +
    '.foot textarea{flex:1;resize:none;border:1px solid #e4e4e7;border-radius:12px;padding:9px 11px;font-size:14px;max-height:96px;min-height:40px;outline:none;color:#18181b;background:#fff}' +
    '.foot textarea:focus{border-color:#a1a1aa}' +
    '.ib{width:40px;height:40px;border-radius:10px;border:none;background:#f4f4f5;color:#52525b;cursor:pointer;display:flex;align-items:center;justify-content:center;flex-shrink:0}' +
    '.ib:hover{background:#e4e4e7}' +
    '.ib svg{width:20px;height:20px}' +
    '.ib.rec{background:#fee2e2;color:#dc2626}' +
    '.send{color:#fff}' +
    '.note{font-size:11px;color:#71717a;text-align:center;padding:6px 0 0}' +
    '.err{font-size:12px;color:#dc2626;padding:0 12px 6px;display:none}' +
    '.panel.page{top:0;bottom:0;right:50%;transform:translateX(50%);width:560px;max-width:100vw;height:100%;max-height:100%;border-radius:0;box-shadow:0 0 0 1px #e4e4e7,0 16px 48px rgba(0,0,0,.12)}' +
    '@media (max-width:480px){.panel.page{transform:none;right:0}}' +
    '@media (max-width:480px){.panel{right:0;bottom:0;width:100vw;max-width:100vw;height:100%;max-height:100%;border-radius:0}.launcher{right:16px;bottom:16px}}' +
    '</style>' +
    '<button class="launcher" aria-label="Open chat">' +
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>' +
    '<span class="badge"></span></button>' +
    '<div class="panel" role="dialog" aria-label="Chat">' +
    '<div class="head"><div><div class="t"></div><div class="s">Typically replies in a minute</div></div><button class="x" aria-label="Close chat">&times;</button></div>' +
    '<div class="list" aria-live="polite"><div class="typing"><span></span><span></span><span></span></div></div>' +
    '<div class="err"></div>' +
    '<div class="foot">' +
    '<button class="ib attach" aria-label="Send a photo"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg></button>' +
    '<button class="ib mic" aria-label="Record a voice message"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/></svg></button>' +
    '<textarea rows="1" placeholder="Type a message…" aria-label="Message"></textarea>' +
    '<button class="ib send" aria-label="Send"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg></button>' +
    '<input type="file" accept="image/*" hidden>' +
    '</div></div>';

  var $ = function (s) { return root.querySelector(s); };
  var launcher = $('.launcher');
  var badge = $('.badge');
  var panel = $('.panel');
  var list = $('.list');
  var typingEl = $('.typing');
  var input = $('textarea');
  var sendBtn = $('.send');
  var fileInput = $('input[type=file]');
  var micBtn = $('.mic');
  var errEl = $('.err');

  if (PAGE) {
    panel.classList.add('page');
    launcher.style.display = 'none';
    $('.x').style.display = 'none';
  }

  function applyConfig() {
    var c = state.config.color || '#0f766e';
    launcher.style.background = c;
    $('.head').style.background = c;
    sendBtn.style.background = c;
    $('.t').textContent = state.config.title || 'Chat';
    var style = document.createElement('style');
    style.textContent = '.msg.v{background:' + c + '}';
    root.appendChild(style);
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (ch) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
    });
  }

  function richText(s) {
    return escapeHtml(s)
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>');
  }

  function render(m) {
    var el = document.createElement('div');
    el.className = 'msg ' + (m.from === 'visitor' ? 'v' : 'b');
    var html = '';
    (m.attachments || []).forEach(function (a) {
      if (a.kind === 'image') html += '<img src="' + escapeHtml(a.url) + '" alt="">';
      else if (a.kind === 'audio') html += '<audio controls src="' + escapeHtml(a.url) + '"></audio>';
      else html += '<a href="' + escapeHtml(a.url) + '" target="_blank" rel="noopener">' + escapeHtml(a.name || 'Attachment') + '</a>';
    });
    if (m.text) html += (html ? '<br>' : '') + richText(m.text);
    el.innerHTML = html;
    list.insertBefore(el, typingEl);
  }

  function scrollDown() {
    list.scrollTop = list.scrollHeight;
  }

  function addMessages(msgs) {
    var added = 0;
    msgs.forEach(function (m) {
      if (state.messages.some(function (x) { return x.id === m.id; })) return;
      state.messages.push(m);
      render(m);
      if (!state.lastAt || m.createdAt > state.lastAt) state.lastAt = m.createdAt;
      if (m.from === 'business' && !state.open) added++;
    });
    if (added) {
      state.unread += added;
      badge.textContent = String(state.unread);
      badge.style.display = 'flex';
    }
    scrollDown();
  }

  function showTyping(on) {
    state.typing = on;
    typingEl.style.display = on ? 'flex' : 'none';
    if (on) scrollDown();
  }

  function showError(msg) {
    errEl.textContent = msg || '';
    errEl.style.display = msg ? 'block' : 'none';
  }

  function welcome() {
    if (!state.messages.length && state.config.welcome) {
      render({ from: 'business', text: state.config.welcome, attachments: [] });
    }
  }

  // ---------------------------------------------------------------------------
  // Data
  // ---------------------------------------------------------------------------
  function ensureSession() {
    if (state.visitorId) return Promise.resolve();
    return api('/session', { method: 'POST', json: { visitorId: load('visitor') } }).then(function (data) {
      state.visitorId = data.visitorId;
      save('visitor', data.visitorId);
      addMessages(data.messages || []);
    });
  }

  function poll() {
    if (!state.visitorId) return Promise.resolve();
    var q = '?visitorId=' + encodeURIComponent(state.visitorId) + (state.lastAt ? '&after=' + encodeURIComponent(state.lastAt) : '');
    return api('/messages' + q)
      .then(function (data) {
        addMessages(data.messages || []);
        showTyping(Boolean(data.typing));
      })
      .catch(function () { /* transient */ });
  }

  function schedulePoll() {
    clearTimeout(state.pollTimer);
    var delay = state.open ? (state.typing ? 1500 : 3000) : 15000;
    state.pollTimer = setTimeout(function () {
      poll().then(schedulePoll);
    }, delay);
  }

  function send(text, file) {
    showError('');
    return ensureSession()
      .then(function () {
        if (file) {
          var form = new FormData();
          form.append('visitorId', state.visitorId);
          if (text) form.append('text', text);
          form.append('file', file, file.name || 'upload');
          return api('/messages', { method: 'POST', form: form });
        }
        return api('/messages', { method: 'POST', json: { visitorId: state.visitorId, text: text } });
      })
      .then(function (data) {
        addMessages([data.message]);
        showTyping(true);
        schedulePoll();
      })
      .catch(function (e) {
        showError(e.message || 'Could not send. Please try again.');
      });
  }

  // ---------------------------------------------------------------------------
  // Events
  // ---------------------------------------------------------------------------
  function toggle(open) {
    state.open = open;
    panel.classList.toggle('open', open);
    if (open) {
      state.unread = 0;
      badge.style.display = 'none';
      ensureSession()
        .then(function () {
          welcome();
          return poll();
        })
        .then(schedulePoll)
        .catch(function () { showError('Chat is unavailable right now.'); });
      setTimeout(function () { input.focus(); }, 50);
    } else {
      schedulePoll();
    }
  }

  launcher.addEventListener('click', function () { toggle(!state.open); });
  $('.x').addEventListener('click', function () { toggle(false); });

  function submit() {
    var text = input.value.trim();
    if (!text) return;
    input.value = '';
    input.style.height = '';
    send(text);
  }
  sendBtn.addEventListener('click', submit);
  input.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  });
  input.addEventListener('input', function () {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 96) + 'px';
  });

  $('.attach').addEventListener('click', function () { fileInput.click(); });
  fileInput.addEventListener('change', function () {
    var f = fileInput.files && fileInput.files[0];
    fileInput.value = '';
    if (f) send(input.value.trim(), f);
    input.value = '';
  });

  // Voice messages (MediaRecorder). Tap to start, tap again to send.
  if (!window.MediaRecorder || !navigator.mediaDevices) micBtn.style.display = 'none';
  micBtn.addEventListener('click', function () {
    if (state.recording) {
      state.recording.stop();
      return;
    }
    navigator.mediaDevices
      .getUserMedia({ audio: true })
      .then(function (stream) {
        var chunks = [];
        var rec = new MediaRecorder(stream);
        state.recording = rec;
        micBtn.classList.add('rec');
        rec.ondataavailable = function (e) { if (e.data.size) chunks.push(e.data); };
        rec.onstop = function () {
          stream.getTracks().forEach(function (t) { t.stop(); });
          micBtn.classList.remove('rec');
          state.recording = null;
          var type = rec.mimeType || 'audio/webm';
          var blob = new Blob(chunks, { type: type });
          if (blob.size < 1000) return;
          var ext = type.indexOf('mp4') >= 0 ? 'm4a' : type.indexOf('ogg') >= 0 ? 'ogg' : 'webm';
          send('', new File([blob], 'voice.' + ext, { type: type.split(';')[0] }));
        };
        rec.start();
        setTimeout(function () { if (state.recording === rec) rec.stop(); }, 120000);
      })
      .catch(function () { showError('Microphone access was blocked.'); });
  });

  api('/config')
    .then(function (cfg) { state.config = cfg; })
    .catch(function () { /* defaults */ })
    .then(function () {
      applyConfig();
      if (PAGE) {
        document.title = state.config.title || document.title;
        toggle(true);
        return;
      }
      if (load('visitor')) {
        state.visitorId = load('visitor');
        ensureSessionFromStore();
      }
    });

  function ensureSessionFromStore() {
    api('/session', { method: 'POST', json: { visitorId: state.visitorId } })
      .then(function (data) {
        state.visitorId = data.visitorId;
        save('visitor', data.visitorId);
        addMessages(data.messages || []);
        state.unread = 0;
        badge.style.display = 'none';
        schedulePoll();
      })
      .catch(function () { /* ignore */ });
  }

  window.AIChatWidget = { open: function () { toggle(true); }, close: function () { toggle(false); } };
})();
