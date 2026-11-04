/* Xpress booking picker: choose a day and arrival window. Used on the quote form and in the account (reschedule). */
(() => {
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text) e.textContent = text; return e; };

  function mount(box, { getState, onChange, optional = true, days = 21 }) {
    let data = null, day = null, pick = null, shown = 7;
    box.classList.add('xb'); box.replaceChildren(el('p', 'xb-note', 'Loading available times…'));
    const emit = () => onChange && onChange(pick);

    async function load() {
      const st = getState(); if (!st) { box.replaceChildren(el('p', 'xb-note', 'Choose your state to see available times.')); return; }
      try { const r = await fetch(`/api/availability?state=${st}&days=${days}`); if (!r.ok) throw 0; data = await r.json(); } catch { box.replaceChildren(el('p', 'xb-note', 'Online times are unavailable right now. Leave your details and we will call you to arrange a time.')); return; }
      if (pick && !data.days.some(d => d.date === pick.date && d.windows.some(w => w.id === pick.window && w.available))) { pick = null; emit(); }
      day = pick ? pick.date : null; draw();
    }
    function draw() {
      box.replaceChildren();
      const strip = el('div', 'xb-days', ''); strip.setAttribute('role', 'group'); strip.setAttribute('aria-label', 'Choose a day');
      data.days.slice(0, shown).forEach(d => {
        const open = d.windows.some(w => w.available), b = el('button', 'xb-day' + (day === d.date ? ' on' : ''));
        b.type = 'button'; b.disabled = !open; b.setAttribute('aria-pressed', String(day === d.date));
        b.append(el('span', 'wd', d.weekday), el('b', '', d.label.split(' ')[1]), el('span', 'mo', d.label.split(' ')[0]));
        b.onclick = () => { day = d.date; if (pick && pick.date !== d.date) { pick = null; emit(); } draw(); };
        strip.append(b);
      });
      if (shown < data.days.length) { const more = el('button', 'xb-more', 'More days →'); more.type = 'button'; more.onclick = () => { shown = Math.min(data.days.length, shown + 7); draw(); }; strip.append(more); }
      box.append(strip);
      if (day) {
        const d = data.days.find(x => x.date === day), wrap = el('div', 'xb-wins'); wrap.setAttribute('role', 'group'); wrap.setAttribute('aria-label', 'Choose an arrival window');
        d.windows.forEach(w => { const b = el('button', 'xb-win' + (pick && pick.date === day && pick.window === w.id ? ' on' : ''), w.available ? w.id : w.id + ' · full'); b.type = 'button'; b.disabled = !w.available; b.setAttribute('aria-pressed', String(!!(pick && pick.date === day && pick.window === w.id))); b.onclick = () => { pick = { date: day, window: w.id, label: `${d.weekday}, ${d.label} · ${w.id}` }; emit(); draw(); }; wrap.append(b); });
        box.append(wrap);
      } else box.append(el('p', 'xb-note', 'Pick a day to see arrival windows.'));
      if (pick) { const s = el('p', 'xb-sel'); s.append('Selected: ', el('b', '', pick.label)); if (optional) { const c = el('button', 'xb-clear', 'Clear'); c.type = 'button'; c.onclick = () => { pick = null; day = null; emit(); draw(); }; s.append(' ', c); } box.append(s); }
      box.append(el('p', 'xb-note', data.note + ' Emergency? Call us, we answer 24/7.'));
    }
    box.addEventListener('xb-reload', load);
    load();
    return { reload: load, get value() { return pick; } };
  }
  window.XpBooking = { mount };

  /* ---- quote form integration (Contact page) ---- */
  const form = document.getElementById('estimate-form'); if (!form) return;
  const dateInput = form.elements.date, timeSel = form.elements.time; if (!dateInput || !timeSel) return;
  const labels = [dateInput.closest('label'), timeSel.closest('label')].filter(Boolean); labels.forEach(l => { l.hidden = true; });
  const wrap = el('div', 'field full xb-wrap'); wrap.append(el('strong', 'xb-title', 'Pick an arrival window (optional)'), el('span', 'xb-sub', 'Reserve a time now, or skip and we will call to arrange one.'));
  const host = el('div'); wrap.append(host); labels[0].before(wrap);
  const siteState = document.getElementById('site-state');
  const stateNow = () => siteState?.value || 'PA'; // the page's own script sets this (from the URL, city, saved choice), so we always agree with the state the quote is sent for
  const picker = mount(host, {
    getState: stateNow,
    onChange: p => {
      dateInput.value = p ? p.date : '';
      let o = [...timeSel.options].find(x => x.dataset.slot); if (!o) { o = new Option('', ''); o.dataset.slot = '1'; timeSel.add(o); }
      if (p) { o.value = o.textContent = p.window; timeSel.value = p.window; } else { timeSel.value = ''; o.value = ''; o.textContent = ''; }
    },
  });
  siteState?.addEventListener('change', () => picker.reload());
  addEventListener('load', () => picker.reload()); // after the page script has applied the state
  form.addEventListener('click', e => { if (e.target.closest('[data-next]')) setTimeout(() => picker.reload(), 60); });
})();
