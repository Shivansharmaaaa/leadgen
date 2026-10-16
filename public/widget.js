/*
 * Leadgen chat widget — one line on the client's site:
 *
 *   <script src="https://YOUR-APP/widget.js" data-tenant="northside-hvac"
 *           data-name="Northside Heating & Air" async></script>
 *
 * Talks to /api/chat on the same host as this script. Everything lives in a
 * shadow root so the host page's CSS cannot break it and ours cannot leak
 * out. The visitor's session id is random and stays in their browser; it is
 * the only key to their conversation. The header says it is an AI assistant
 * (CA SB 1001) and that a person can take over.
 */
(function () {
  "use strict";
  var script = document.currentScript;
  if (!script || window.__leadgenChat) return;
  window.__leadgenChat = true;

  var tenant = script.getAttribute("data-tenant");
  if (!tenant) { console.warn("leadgen widget: data-tenant is required"); return; }
  var businessName = script.getAttribute("data-name") || "us";
  var accent = script.getAttribute("data-color") || "#2563eb";
  var api = new URL("/api/chat", script.src).toString();
  var storeKey = "leadgen-chat:" + tenant;

  // ── state, kept in this browser only ──────────────────────────────────
  function load() {
    try { return JSON.parse(localStorage.getItem(storeKey) || "null"); } catch (e) { return null; }
  }
  function save() {
    try { localStorage.setItem(storeKey, JSON.stringify(state)); } catch (e) { /* private mode: fine */ }
  }
  function newSession() {
    var bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    var s = "";
    for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }
  var state = load() || { sessionId: newSession(), messages: [], lastSeen: new Date(0).toISOString() };
  var seen = {};
  state.messages.forEach(function (m) { if (m.id) seen[m.id] = true; });

  // ── DOM ───────────────────────────────────────────────────────────────
  var host = document.createElement("div");
  host.setAttribute("data-leadgen-chat", "");
  var root = host.attachShadow({ mode: "open" });
  root.innerHTML =
    "<style>" +
    ":host{all:initial}" +
    "*{box-sizing:border-box;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif}" +
    ".wrap{--accent:" + accent + ";--bg:#fff;--fg:#111827;--muted:#6b7280;--line:#e5e7eb;--them:#f3f4f6;" +
    "position:fixed;right:20px;bottom:20px;z-index:2147483000}" +
    "@media (prefers-color-scheme:dark){.wrap{--bg:#111827;--fg:#f9fafb;--muted:#9ca3af;--line:#374151;--them:#1f2937}}" +
    ".open{background:var(--accent);color:#fff;border:0;border-radius:999px;padding:12px 18px;font-size:15px;" +
    "font-weight:600;cursor:pointer;box-shadow:0 6px 20px rgba(0,0,0,.2);display:flex;gap:8px;align-items:center}" +
    ".open:focus-visible,.send:focus-visible,.close:focus-visible{outline:3px solid var(--fg);outline-offset:2px}" +
    ".badge{background:#ef4444;border-radius:999px;min-width:18px;height:18px;font-size:11px;display:none;" +
    "align-items:center;justify-content:center;padding:0 5px}" +
    ".panel{display:none;flex-direction:column;width:360px;max-width:calc(100vw - 32px);height:520px;" +
    "max-height:calc(100vh - 100px);background:var(--bg);color:var(--fg);border:1px solid var(--line);" +
    "border-radius:14px;box-shadow:0 12px 40px rgba(0,0,0,.25);overflow:hidden}" +
    ".panel.on{display:flex}" +
    ".head{padding:14px 16px;background:var(--accent);color:#fff;display:flex;align-items:flex-start;gap:10px}" +
    ".head b{display:block;font-size:15px}.head small{display:block;font-size:12px;opacity:.9;margin-top:2px}" +
    ".close{margin-left:auto;background:transparent;border:0;color:#fff;font-size:22px;line-height:1;cursor:pointer}" +
    ".log{flex:1;overflow-y:auto;padding:14px;display:flex;flex-direction:column;gap:8px}" +
    ".msg{max-width:82%;padding:9px 12px;border-radius:12px;font-size:14px;line-height:1.4;white-space:pre-wrap;" +
    "word-wrap:break-word}" +
    ".me{align-self:flex-end;background:var(--accent);color:#fff;border-bottom-right-radius:4px}" +
    ".them{align-self:flex-start;background:var(--them);border-bottom-left-radius:4px}" +
    ".team{align-self:flex-start;background:var(--them);border-left:3px solid var(--accent)}" +
    ".note{align-self:center;color:var(--muted);font-size:12px;text-align:center}" +
    ".form{display:flex;gap:8px;padding:10px;border-top:1px solid var(--line)}" +
    "textarea{flex:1;resize:none;border:1px solid var(--line);border-radius:10px;padding:9px 10px;font-size:14px;" +
    "background:var(--bg);color:var(--fg);height:42px;max-height:110px}" +
    "textarea:focus{outline:2px solid var(--accent);outline-offset:0}" +
    ".send{background:var(--accent);color:#fff;border:0;border-radius:10px;padding:0 14px;font-weight:600;cursor:pointer}" +
    ".send[disabled]{opacity:.5;cursor:default}" +
    "@media (max-width:480px){.wrap{right:12px;bottom:12px}.panel{width:calc(100vw - 24px);height:calc(100vh - 90px)}}" +
    "</style>" +
    "<div class='wrap'>" +
    "<div class='panel' role='dialog' aria-label='Chat'>" +
    "<div class='head'><div><b></b><small>You're chatting with an AI assistant. A person can take over at any time.</small></div>" +
    "<button class='close' aria-label='Close chat'>×</button></div>" +
    "<div class='log' role='log' aria-live='polite'></div>" +
    "<form class='form'><textarea rows='1' maxlength='1000' aria-label='Your message' placeholder='Type a message…'></textarea>" +
    "<button class='send' type='submit'>Send</button></form>" +
    "</div>" +
    "<button class='open' aria-label='Chat with us'>Chat with us <span class='badge' aria-hidden='true'></span></button>" +
    "</div>";
  document.body.appendChild(host);

  var $ = function (sel) { return root.querySelector(sel); };
  var panel = $(".panel"), log = $(".log"), input = $("textarea"), send = $(".send"),
    openBtn = $(".open"), badge = $(".badge");
  $(".head b").textContent = businessName;
  var unread = 0, busy = false, pollTimer = null;

  function render(m) {
    var el = document.createElement("div");
    el.className = "msg " + (m.from === "me" ? "me" : m.from === "team" ? "team" : m.from === "note" ? "note" : "them");
    el.textContent = m.body;
    log.appendChild(el);
    log.scrollTop = log.scrollHeight;
  }
  function add(m, keep) {
    if (m.id && seen[m.id]) return;
    if (m.id) seen[m.id] = true;
    render(m);
    if (keep !== false) {
      state.messages.push(m);
      if (state.messages.length > 60) state.messages = state.messages.slice(-60);
      // Only the server's clock moves the poll cursor: a visitor's clock
      // running fast would otherwise hide replies from the poll.
      if (m.id && m.at && m.at > state.lastSeen) state.lastSeen = m.at;
      save();
    }
    if (!panel.classList.contains("on") && m.from !== "me") {
      unread++;
      badge.textContent = String(unread);
      badge.style.display = "inline-flex";
    }
  }

  state.messages.forEach(render);
  if (!state.messages.length) render({ from: "them", body: "Hi! How can we help today?" });

  function setOpen(on) {
    panel.classList.toggle("on", on);
    openBtn.style.display = on ? "none" : "flex";
    if (on) {
      unread = 0; badge.style.display = "none";
      setTimeout(function () { input.focus(); }, 0);
      log.scrollTop = log.scrollHeight;
    } else {
      openBtn.focus();
    }
  }
  openBtn.addEventListener("click", function () { setOpen(true); });
  $(".close").addEventListener("click", function () { setOpen(false); });
  root.addEventListener("keydown", function (e) { if (e.key === "Escape") setOpen(false); });

  function post(text) {
    busy = true; send.disabled = true;
    var typing = document.createElement("div");
    typing.className = "msg them"; typing.textContent = "…"; log.appendChild(typing);
    log.scrollTop = log.scrollHeight;
    return fetch(api, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        tenant: tenant, sessionId: state.sessionId, text: text,
        clientMessageId: Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
      }),
    }).then(function (r) {
      return r.json().then(function (data) { return { ok: r.ok, status: r.status, data: data }; });
    }).then(function (res) {
      typing.remove();
      if (!res.ok) {
        add({ from: "note", body: res.data && res.data.error ? res.data.error : "Something went wrong — please try again." }, false);
        return;
      }
      if (res.data.reply) add(res.data.reply);
      else if (res.data.waitingForTeam) {
        add({ from: "note", body: "Thanks — someone from the team will reply here shortly." }, false);
      }
    }).catch(function () {
      typing.remove();
      add({ from: "note", body: "Couldn't reach us just now — please check your connection and try again." }, false);
    }).then(function () { busy = false; send.disabled = false; input.focus(); });
  }

  $(".form").addEventListener("submit", function (e) {
    e.preventDefault();
    var text = input.value.trim();
    if (!text || busy) return;
    input.value = "";
    add({ from: "me", body: text, at: new Date().toISOString() });
    post(text);
  });
  input.addEventListener("keydown", function (e) {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); $(".form").requestSubmit(); }
  });

  // A person replying from the inbox reaches the visitor through this poll.
  function poll() {
    if (document.hidden || !state.messages.length) return;
    var url = api + "?tenant=" + encodeURIComponent(tenant) + "&sessionId=" + encodeURIComponent(state.sessionId) +
      "&after=" + encodeURIComponent(state.lastSeen);
    fetch(url).then(function (r) { return r.ok ? r.json() : { messages: [] }; }).then(function (d) {
      (d.messages || []).forEach(function (m) { add(m); });
    }).catch(function () { /* offline: try again next tick */ });
  }
  pollTimer = setInterval(poll, 5000);

  // Keep the bubble in the corner the visitor can actually see. A host page
  // that overflows sideways on a phone widens the layout viewport, and a
  // plain position:fixed corner lands off-screen.
  var wrap = root.querySelector(".wrap");
  var vv = window.visualViewport;
  function pin() {
    if (!vv) return;
    var right = window.innerWidth - (vv.offsetLeft + vv.width);
    var bottom = window.innerHeight - (vv.offsetTop + vv.height);
    var narrow = vv.width <= 480 ? 12 : 20;
    wrap.style.right = Math.max(0, right) + narrow + "px";
    wrap.style.bottom = Math.max(0, bottom) + narrow + "px";
  }
  if (vv) {
    vv.addEventListener("resize", pin);
    vv.addEventListener("scroll", pin);
    pin();
  }
  window.addEventListener("pagehide", function () { clearInterval(pollTimer); });
})();
