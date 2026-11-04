/* Fills the "Customer Reviews" section from /api/public/reviews. Stays hidden when there is nothing real to show.
   Text is inserted with textContent (never as HTML), so a customer's words can't alter the page. */
(() => {
  const sec = document.querySelector('[data-site-reviews]'); if (!sec) return;
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
  const stars = n => '★'.repeat(n) + '☆'.repeat(5 - n);
  fetch('/api/public/reviews').then(r => r.ok ? r.json() : null).then(d => {
    if (!d || (!d.items.length && !d.average)) return;
    const agg = sec.querySelector('[data-sr-agg]');
    if (d.average) { const big = el('b', 'sr-num', d.average.toFixed(1)), s = el('span', 'sr-stars', stars(Math.round(d.average))); s.setAttribute('aria-hidden', 'true'); agg.append(big, ' ', s, el('span', 'sr-count', ` from ${d.count} customer ratings`)); agg.setAttribute('aria-label', `Average rating ${d.average.toFixed(1)} out of 5 from ${d.count} customer ratings`); }
    const grid = sec.querySelector('[data-sr-grid]');
    d.items.slice(0, 6).forEach(r => {
      const a = el('article'), st = el('span', 'micro sr-s', stars(r.rating)); st.setAttribute('aria-label', `${r.rating} out of 5 stars`);
      const when = r.date ? new Date(r.date + '-15').toLocaleDateString('en-US', { month: 'long', year: 'numeric' }) : '';
      a.append(st, el('h3', '', r.name), el('p', 'sr-q', '“' + r.text + '”'), el('p', 'sr-meta', [r.service, r.town + (r.state ? ', ' + r.state : ''), when].filter(Boolean).join(' · ')));
      grid.append(a);
    });
    sec.querySelector('[data-sr-note]').textContent = 'Ratings come from customers after completed jobs. The average counts every rating we receive, not only the ones shown here. Comments are shown as the customer wrote them, with their permission.';
    if (!d.items.length) grid.remove();
    sec.hidden = false;
  }).catch(() => { });
})();
