/* Xpress live chat widget: floating button on every page. Talks to /api/chat/*. */
(() => {
  if (location.pathname.startsWith('/admin')) return;
  const $ = (s, r = document) => r.querySelector(s), K = 'xp_chat_token';
  const phone = (document.querySelector('[data-region-phone]')?.textContent || '215-397-1926').trim();
  const tel = 'tel:+1' + phone.replace(/\D/g, '');
  const root = document.createElement('div'); root.id = 'xp-chat';
  root.innerHTML = `
  <button class="xp-fab" aria-expanded="false" aria-controls="xp-panel"><span class="xp-dot" hidden></span><svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12Z"/></svg><span>Chat with us</span></button>
  <section class="xp-panel" id="xp-panel" role="dialog" aria-label="Live chat with Xpress" hidden>
    <header><div><strong>Xpress Garage Doors</strong><small class="xp-status">Checking availability…</small></div><button class="xp-x" aria-label="Close chat">✕</button></header>
    <div class="xp-body"><div class="xp-msgs" role="log" aria-live="polite"></div>
      <form class="xp-intro" hidden><p>Tell us how we can help. We reply right here, and keep the conversation in your account.</p>
        <label>Your name<input name="name" autocomplete="name" required maxlength="80"></label>
        <label>Email<input name="email" type="email" autocomplete="email" required maxlength="120"></label>
        <label>What do you need help with?<select name="topic"><option>Get a quote</option><option>Existing appointment</option><option>Complaint or problem with a job</option><option>Billing question</option><option>General question</option></select></label>
        <label>Message<textarea name="message" required maxlength="2000" rows="3"></textarea></label>
        <button class="xp-send" type="submit">Start chat</button><p class="xp-err" role="alert"></p></form>
    </div>
    <form class="xp-compose" hidden><input name="message" placeholder="Type your message…" autocomplete="off" maxlength="2000" aria-label="Message"><button type="submit" aria-label="Send">➤</button></form>
    <footer><a href="${tel}">☎ Urgent? Call ${phone}</a><a href="/account/">My account</a></footer>
  </section>`;
  document.body.append(root);
  const fab = $('.xp-fab', root), panel = $('.xp-panel', root), msgs = $('.xp-msgs', root), intro = $('.xp-intro', root), compose = $('.xp-compose', root), dot = $('.xp-dot', root);
  let token = localStorage.getItem(K), last = 0, timer = null, open = false, seen = 0;

  const esc = s => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const draw = list => { for (const m of list) { if (m.id <= last) continue; last = m.id; const d = document.createElement('div'); d.className = 'xp-m xp-' + m.sender; d.innerHTML = `${m.sender === 'staff' && m.staffName ? `<small class="xp-who">${esc(m.staffName)} from Xpress</small>` : ''}<p>${esc(m.body).replace(/\n/g, '<br>')}</p><time>${new Date(m.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</time>`; msgs.append(d); if (m.sender === 'staff' && !open) dot.hidden = false; } msgs.scrollTop = msgs.scrollHeight; };
  async function status() { try { const s = await (await fetch('/api/chat/status')).json(); $('.xp-status', root).textContent = s.online ? '● Online · usually replies in a few minutes' : `Away · ${s.hours}. Leave a message`; $('.xp-status', root).className = 'xp-status ' + (s.online ? 'on' : 'off'); } catch { $('.xp-status', root).textContent = 'Call us for fastest help'; } }
  async function poll() {
    if (!token) return;
    try { const r = await fetch(`/api/chat/${token}?after=${last}`); if (r.status === 404) { localStorage.removeItem(K); token = null; last = 0; msgs.replaceChildren(); showIntro(); return; } draw((await r.json()).messages); } catch { }
  }
  function loop() { clearInterval(timer); timer = setInterval(poll, open ? 3000 : 12000); }
  function showIntro() { intro.hidden = false; compose.hidden = true; }
  async function prefill() {
    try { const r = await fetch('/api/me'); if (r.ok) { const { customer } = await r.json(); intro.name.value = customer.name; intro.email.value = customer.email; } } catch { }
  }
  function toggle(v) {
    open = v; panel.hidden = !v; fab.setAttribute('aria-expanded', String(v)); fab.classList.toggle('xp-hide', v && innerWidth < 600);
    if (v) { dot.hidden = true; status(); if (token) { intro.hidden = true; compose.hidden = false; poll(); } else { showIntro(); prefill(); } setTimeout(() => (token ? compose.message : intro.name).focus(), 50); }
    lockPage(v);
    loop();
  }
  // Phones: the chat is a full-screen page; freeze the page behind it so nothing shifts, and follow the keyboard.
  let savedY = 0, vvBound = false;
  const full = () => innerWidth <= 600;
  function fit() { if (open && full()) { panel.style.height = (window.visualViewport ? visualViewport.height : innerHeight) + 'px'; panel.style.top = (window.visualViewport ? visualViewport.offsetTop : 0) + 'px'; } else { panel.style.height = ''; panel.style.top = ''; } }
  function lockPage(v) {
    const on = v && full(), b = document.body, h = document.documentElement;
    if (on && !h.classList.contains('xp-lock')) { savedY = scrollY; b.style.top = -savedY + 'px'; h.classList.add('xp-lock'); }
    if (!on && h.classList.contains('xp-lock')) { h.classList.remove('xp-lock'); b.style.top = ''; scrollTo(0, savedY); }
    if (window.visualViewport && !vvBound) { vvBound = true; visualViewport.addEventListener('resize', fit); visualViewport.addEventListener('scroll', fit); }
    fit();
  }
  fab.addEventListener('click', () => toggle(!open)); $('.xp-x', root).addEventListener('click', () => toggle(false));
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && open) toggle(false); });
  document.addEventListener('click', e => { const t = e.target.closest('[data-open-chat]'); if (t) { e.preventDefault(); toggle(true); } });

  intro.addEventListener('submit', async e => {
    e.preventDefault(); const err = $('.xp-err', root); err.textContent = ''; const btn = $('.xp-send', root); btn.disabled = true;
    try {
      const r = await fetch('/api/chat/start', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(Object.fromEntries(new FormData(intro))) });
      const d = await r.json(); if (!r.ok) throw new Error(d.error || 'Could not start chat');
      token = d.token; localStorage.setItem(K, token); last = 0; msgs.replaceChildren(); draw(d.messages); intro.hidden = true; compose.hidden = false; compose.message.focus(); intro.message.value = ''; loop();
    } catch (x) { err.textContent = x.message; } finally { btn.disabled = false; }
  });
  compose.addEventListener('submit', async e => {
    e.preventDefault(); const t = compose.message.value.trim(); if (!t) return; compose.message.value = '';
    await fetch(`/api/chat/${token}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message: t }) }); poll();
  });
  if (token) { fetch(`/api/chat/${token}?after=0`).then(r => r.ok ? r.json() : null).then(d => { if (d) { draw(d.messages); seen = last; } }).catch(() => { }); loop(); }
})();
