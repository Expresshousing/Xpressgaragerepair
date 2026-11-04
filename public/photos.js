/* Xpress photo helper: pick photos, shrink them on the phone, upload to a quote. */
(() => {
  const MAX_SIDE = 1600, LIMIT = 8, MAX_BYTES = 8 * 1024 * 1024;
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text) e.textContent = text; return e; };

  /* Shrink big phone photos before sending (faster on mobile data). Falls back to the original if the browser can't decode it (e.g. HEIC on Chrome). */
  async function compress(file) {
    if (!/^image\/(jpeg|png|webp)$/.test(file.type)) return file.size <= MAX_BYTES ? file : null;
    try {
      const bmp = await createImageBitmap(file), scale = Math.min(1, MAX_SIDE / Math.max(bmp.width, bmp.height));
      if (scale === 1 && file.size <= 1.5 * 1024 * 1024) { bmp.close?.(); return file; }
      const c = document.createElement('canvas'); c.width = Math.round(bmp.width * scale); c.height = Math.round(bmp.height * scale);
      c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height); bmp.close?.();
      const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.85)); return blob && blob.size < file.size ? new File([blob], file.name.replace(/\.\w+$/, '') + '.jpg', { type: 'image/jpeg' }) : file;
    } catch { return file.size <= MAX_BYTES ? file : null; }
  }

  async function uploadOne(ref, file, token) {
    const r = await fetch(`/api/quotes/${ref}/photos`, { method: 'POST', headers: { 'content-type': file.type || 'application/octet-stream', 'x-file-name': encodeURIComponent(file.name || 'photo'), ...(token ? { 'x-upload-token': token } : {}) }, body: file });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'Upload failed');
  }

  /* A tidy picker: thumbnails with remove buttons. Returns { files(), clear() }. */
  function mountPicker(box, { max = LIMIT, onChange } = {}) {
    let list = []; // {file, url}
    const input = el('input'); input.type = 'file'; input.accept = 'image/*'; input.multiple = true; input.hidden = true;
    const btn = el('button', 'xp-btn ghost xph-add', '📷 Add photos'); btn.type = 'button';
    const grid = el('div', 'xph-grid'), note = el('p', 'xph-note', 'Optional. A clear photo of the door, spring or damage helps us quote accurately. Up to ' + max + ' photos.'), err = el('p', 'xph-err'); err.setAttribute('role', 'alert');
    box.replaceChildren(btn, input, note, grid, err);
    const draw = () => { grid.replaceChildren(); list.forEach((it, i) => { const t = el('div', 'xph-t'), img = el('img'); img.src = it.url; img.alt = 'Selected photo ' + (i + 1); const x = el('button', 'xph-x', '✕'); x.type = 'button'; x.setAttribute('aria-label', 'Remove photo ' + (i + 1)); x.onclick = () => { URL.revokeObjectURL(it.url); list.splice(i, 1); draw(); onChange && onChange(); }; t.append(img, x); grid.append(t); }); btn.textContent = list.length ? `📷 Add more (${list.length}/${max})` : '📷 Add photos'; btn.disabled = list.length >= max; };
    btn.onclick = () => input.click();
    input.onchange = async () => {
      err.textContent = ''; const picked = [...input.files]; input.value = '';
      for (const f of picked) {
        if (list.length >= max) { err.textContent = `You can add up to ${max} photos.`; break; }
        if (!/^image\//.test(f.type) && !/\.(heic|heif)$/i.test(f.name)) { err.textContent = 'Only photos can be added.'; continue; }
        const c = await compress(f); if (!c) { err.textContent = `${f.name} is too large (8 MB max).`; continue; }
        list.push({ file: c, url: c.type.startsWith('image/') && c.type !== 'image/heic' ? URL.createObjectURL(c) : 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect width="100" height="100" fill="#eee"/><text x="50" y="55" text-anchor="middle" font-size="14" fill="#777">photo</text></svg>') });
      }
      draw(); onChange && onChange();
    };
    draw();
    return { files: () => list.map(x => x.file), clear: () => { list.forEach(x => URL.revokeObjectURL(x.url)); list = []; draw(); } };
  }

  window.XpPhotos = { compress, uploadOne, mountPicker, picker: null, failed: 0,
    /* called by the quote form right after the quote is saved */
    async uploadPending(ref, token) { this.failed = 0; const files = this.picker ? this.picker.files() : []; for (const f of files) { try { await uploadOne(ref, f, token); } catch { this.failed++; } } return files.length; },
  };

  /* ---- quote form (Contact page) ---- */
  const form = document.getElementById('estimate-form'); if (!form || !form.elements.message) return;
  const wrap = el('div', 'field full xph-wrap'); wrap.append(el('strong', 'xph-title', 'Photos of the problem (optional)')); const host = el('div'); wrap.append(host);
  form.elements.message.closest('label').after(wrap); window.XpPhotos.picker = mountPicker(host);
})();
