// Small UI toolkit: element builder, icons, sheets, dialogs, toasts, formatting.

export function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'style' && typeof v === 'object') {
        for (const [sk, sv] of Object.entries(v)) {
          if (sk.startsWith('--')) el.style.setProperty(sk, sv); else el.style[sk] = sv;
        }
      }
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k in el && typeof v !== 'string') el[k] = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
  }
  append(el, kids);
  return el;
}

function append(el, kids) {
  for (const k of kids) {
    if (k == null || k === false) continue;
    if (Array.isArray(k)) append(el, k);
    else el.append(k instanceof Node ? k : document.createTextNode(String(k)));
  }
}

// ---------------------------------------------------------------- icons
const P = {
  home: '<path d="M3.5 10.5 12 3.5l8.5 7V19a1.5 1.5 0 0 1-1.5 1.5h-4.5v-6h-5v6H5A1.5 1.5 0 0 1 3.5 19z"/>',
  tasks: '<path d="M4 6.5 5.6 8 8.5 5M4 12.5 5.6 14 8.5 11M4 18.5 5.6 20 8.5 17M11.5 6.5h8.5M11.5 12.5h8.5M11.5 18.5h8.5"/>',
  users: '<circle cx="9" cy="8.5" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><path d="M16 5a3.5 3.5 0 0 1 0 7M18 14.6a6.5 6.5 0 0 1 3.5 5.4"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.2-4.2"/>',
  eye: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="3"/>',
  eyeOff: '<path d="m3.5 3.5 17 17"/><path d="M10.6 5.6A9.7 9.7 0 0 1 12 5.5c6 0 9.5 6.5 9.5 6.5a16 16 0 0 1-2.9 3.7M6.6 6.9A16.4 16.4 0 0 0 2.5 12S6 18.5 12 18.5a9.5 9.5 0 0 0 4.9-1.4"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/>',
  more: '<circle cx="6" cy="12" r="1.3" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.3" fill="currentColor" stroke="none"/><circle cx="18" cy="12" r="1.3" fill="currentColor" stroke="none"/>',
  edit: '<path d="M4.5 19.5h4L19 9a2.8 2.8 0 0 0-4-4L4.5 15.5z"/><path d="m13.5 6.5 4 4"/>',
  trash: '<path d="M4.5 7h15M10 11v5.5M14 11v5.5M6.5 7l.8 11.2a2 2 0 0 0 2 1.8h5.4a2 2 0 0 0 2-1.8L17.5 7M9.5 7V4.5h5V7"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  x: '<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>',
  calendar: '<rect x="3.5" y="5" width="17" height="15.5" rx="3"/><path d="M3.5 10h17M8 3v4M16 3v4"/>',
  user: '<circle cx="12" cy="8.5" r="4"/><path d="M4.5 20.5a7.5 7.5 0 0 1 15 0"/>',
  logout: '<path d="M14.5 4.5h3a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2h-3"/><path d="M9.5 16.5 5 12l4.5-4.5M5 12h10.5"/>',
  key: '<circle cx="8" cy="15.5" r="4"/><path d="m11 12.5 8.5-8.5M16.5 7l2.5 2.5M14.5 9l2 2"/>',
  shield: '<path d="M12 3.5 5 6.2v5.6c0 4.3 3 7.6 7 8.7 4-1.1 7-4.4 7-8.7V6.2z"/><path d="m9 12 2.2 2.2L15.5 10"/>',
  share: '<path d="M12 3.5v11M8 7.5l4-4 4 4"/><path d="M5.5 12.5V18a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2v-5.5"/>',
  copy: '<rect x="8.5" y="8.5" width="11" height="11" rx="2.5"/><path d="M15.5 8.5v-2a2 2 0 0 0-2-2h-7a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h2"/>',
  refresh: '<path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3"/><path d="M19.5 4.5v4h-4"/>',
  cards: '<rect x="4" y="4.5" width="16" height="6.5" rx="2"/><rect x="4" y="13" width="16" height="6.5" rx="2"/>',
  table: '<rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><path d="M3.5 9.5h17M3.5 14.5h17M9.5 9.5v10"/>',
  chevron: '<path d="m14.5 6-6 6 6 6"/>',
  reopen: '<path d="M4.5 12a7.5 7.5 0 1 0 2.2-5.3"/><path d="M4.5 4.5v4h4"/>',
  offline: '<path d="m3.5 3.5 17 17"/><path d="M8.7 16.3a4.6 4.6 0 0 1 6.6 0M5.5 13a9 9 0 0 1 4.4-2.5M14.6 10.6A9 9 0 0 1 18.5 13M2.5 9.6a13.6 13.6 0 0 1 3.9-2.5M10.6 5.6A13.6 13.6 0 0 1 21.5 9.6"/><circle cx="12" cy="19.5" r=".8" fill="currentColor" stroke="none"/>',
  lock: '<rect x="4.5" y="10.5" width="15" height="10" rx="2.5"/><path d="M8 10.5V7.5a4 4 0 0 1 8 0v3"/>',
  at: '<circle cx="12" cy="12" r="3.5"/><path d="M15.5 12v1.3a2.5 2.5 0 0 0 5 0V12a8.5 8.5 0 1 0-3.3 6.7"/>',
  filter: '<path d="M4 6.5h16M7 12h10M10 17.5h4"/>',
  palette: '<circle cx="12" cy="12" r="8.5"/><path d="M12 3.5v17" /><path d="M12 3.5a8.5 8.5 0 0 1 0 17z" fill="currentColor" stroke="none"/>',
  power: '<path d="M12 3.5v8"/><path d="M7 6.5a7.5 7.5 0 1 0 10 0"/>',
  folder: '<path d="M3.5 7.5a2 2 0 0 1 2-2h4l2 2.2h7a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/>',
  folderPlus: '<path d="M3.5 7.5a2 2 0 0 1 2-2h4l2 2.2h7a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/><path d="M12 11v5M9.5 13.5h5"/>',
  archive: '<rect x="3.5" y="4.5" width="17" height="4.5" rx="1.5"/><path d="M5 9v8.5a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9M10 13h4"/>',
  expand: '<path d="M14 5h5v5M19 5l-7 7M10 19H5v-5"/>',
  chevL: '<path d="m15 6-6 6 6 6"/>',
  arrow: '<path d="M19 12H5M11 6l-6 6 6 6"/>',
  bolt: '<path d="M13 3 5 13.5h6L10 21l8-10.5h-6z"/>',
};

export function icon(name, cls = '') {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 24 24');
  s.setAttribute('class', 'ic ' + cls);
  s.setAttribute('aria-hidden', 'true');
  s.innerHTML = P[name] || '';
  return s;
}

export function logoMark(size = 64) {
  const wrap = h('div', { class: 'logo-mark', style: { width: size + 'px', height: size + 'px' } });
  wrap.innerHTML = `<svg viewBox="0 0 64 64" aria-hidden="true">
    <defs><linearGradient id="lg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#E4FF7A"/><stop offset="1" stop-color="#B5E01E"/></linearGradient></defs>
    <rect x="2" y="2" width="60" height="60" rx="18" fill="url(#lg)"/>
    <rect x="2.5" y="2.5" width="59" height="59" rx="17.5" fill="none" stroke="rgba(255,255,255,.5)"/>
    <path d="M19 33.5 28 42 45.5 23.5" fill="none" stroke="#10140A" stroke-width="5.5" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>`;
  return wrap;
}

// ---------------------------------------------------------------- motion
export const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
export const wait = (ms) => new Promise((r) => setTimeout(r, ms));
export function haptic(ms = 8) { try { navigator.vibrate && navigator.vibrate(ms); } catch (_) {} }

export function countUp(el, to, ms = 700) {
  if (reducedMotion() || to === 0) { el.textContent = String(to); return; }
  const from = Number(el.dataset.v || 0);
  el.dataset.v = String(to);
  if (from === to) { el.textContent = String(to); return; }
  const t0 = performance.now();
  const step = (t) => {
    const p = Math.min(1, (t - t0) / ms);
    const e = 1 - Math.pow(1 - p, 3);
    el.textContent = String(Math.round(from + (to - from) * e));
    if (p < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

// ---------------------------------------------------------------- layers (sheets / dialogs) + back button
// While any sheet/dialog is open, one extra history entry exists, so the Android
// back button closes the top layer instead of leaving the app.
const stack = [];
let ignorePops = 0;
const inLayerEntry = () => !!(history.state && history.state.injazLayer);
function ensureEntry() {
  if (!inLayerEntry()) { try { history.pushState({ injazLayer: true }, ''); } catch (_) {} }
}
window.addEventListener('popstate', () => {
  if (ignorePops > 0) { ignorePops--; return; }
  const top = stack[stack.length - 1];
  if (top) { top.dismiss(true); if (stack.length) ensureEntry(); }
});

function pushLayer(layer) {
  stack.push(layer);
  ensureEntry();
}
function popLayer(layer, fromHistory) {
  const i = stack.indexOf(layer);
  if (i === -1) return;
  stack.splice(i, 1);
  if (fromHistory) return;
  // Deferred: a layer that opens right after this one closes reuses the entry.
  setTimeout(() => {
    if (!stack.length && inLayerEntry()) { ignorePops++; try { history.back(); } catch (_) { ignorePops--; } }
  }, 0);
}

export function closeAllLayers() {
  while (stack.length) stack[stack.length - 1].dismiss(false);
}

const layerRoot = () => document.getElementById('layers');

export function sheet({ title, body, footer, onClose, tall = false }) {
  const backdrop = h('div', { class: 'backdrop' });
  const closeBtn = h('button', { class: 'icon-btn sm', 'aria-label': 'إغلاق', type: 'button' }, icon('x'));
  const panel = h('div', { class: 'sheet' + (tall ? ' tall' : ''), role: 'dialog', 'aria-modal': 'true', 'aria-label': title || '' },
    h('div', { class: 'grabber' }),
    title ? h('div', { class: 'sheet-head' }, h('h2', { class: 'sheet-title' }, title), closeBtn) : null,
    h('div', { class: 'sheet-body' }, body),
    footer ? h('div', { class: 'sheet-foot' }, footer) : null,
  );
  const wrap = h('div', { class: 'layer' }, backdrop, panel);
  let closed = false;
  const layer = {
    el: wrap,
    dismiss(fromHistory) {
      if (closed) return;
      closed = true;
      popLayer(layer, !!fromHistory);
      wrap.classList.remove('open');
      wrap.classList.add('closing');
      setTimeout(() => wrap.remove(), reducedMotion() ? 0 : 320);
      onClose && onClose();
    },
  };
  backdrop.addEventListener('click', () => layer.dismiss(false));
  closeBtn.addEventListener('click', () => layer.dismiss(false));
  wrap.addEventListener('keydown', (e) => { if (e.key === 'Escape') layer.dismiss(false); });

  // drag the grabber down to close
  let y0 = null, dy = 0;
  const grab = panel.querySelector('.grabber');
  const head = panel.querySelector('.sheet-head');
  [grab, head].forEach((g) => g && g.addEventListener('pointerdown', (e) => {
    if (e.target.closest('button')) return;
    y0 = e.clientY; dy = 0; panel.style.transition = 'none'; g.setPointerCapture(e.pointerId);
  }));
  [grab, head].forEach((g) => g && g.addEventListener('pointermove', (e) => {
    if (y0 == null) return;
    dy = Math.max(0, e.clientY - y0);
    panel.style.transform = `translateY(${dy}px)`;
  }));
  [grab, head].forEach((g) => g && g.addEventListener('pointerup', () => {
    if (y0 == null) return;
    y0 = null; panel.style.transition = ''; panel.style.transform = '';
    if (dy > 110) layer.dismiss(false);
  }));

  layerRoot().append(wrap);
  pushLayer(layer);
  requestAnimationFrame(() => requestAnimationFrame(() => wrap.classList.add('open')));
  setTimeout(() => {
    const f = panel.querySelector('[autofocus]');
    if (f) f.focus({ preventScroll: true });
  }, 340);
  return layer;
}

export function confirmDialog({ title, message, confirmText = 'تأكيد', cancelText = 'إلغاء', danger = false }) {
  return new Promise((resolve) => {
    let result = false;
    const backdrop = h('div', { class: 'backdrop' });
    const ok = h('button', { class: 'alert-btn ' + (danger ? 'danger' : 'primary'), type: 'button' }, confirmText);
    const cancel = h('button', { class: 'alert-btn', type: 'button' }, cancelText);
    const box = h('div', { class: 'alert', role: 'alertdialog', 'aria-modal': 'true' },
      h('div', { class: 'alert-text' }, h('h3', null, title), message ? h('p', null, message) : null),
      h('div', { class: 'alert-actions' }, cancel, ok));
    const wrap = h('div', { class: 'layer center' }, backdrop, box);
    let closed = false;
    const layer = {
      dismiss(fromHistory) {
        if (closed) return;
        closed = true;
        popLayer(layer, !!fromHistory);
        wrap.classList.remove('open');
        wrap.classList.add('closing');
        setTimeout(() => wrap.remove(), reducedMotion() ? 0 : 220);
        resolve(result);
      },
    };
    ok.addEventListener('click', () => { result = true; layer.dismiss(false); });
    cancel.addEventListener('click', () => layer.dismiss(false));
    backdrop.addEventListener('click', () => layer.dismiss(false));
    layerRoot().append(wrap);
    pushLayer(layer);
    requestAnimationFrame(() => requestAnimationFrame(() => wrap.classList.add('open')));
    setTimeout(() => (danger ? cancel : ok).focus({ preventScroll: true }), 60);
  });
}

export function actionSheet(actions) {
  return new Promise((resolve) => {
    let picked = null;
    const s = sheet({
      body: h('div', { class: 'action-list' }, actions.map((a) =>
        h('button', { class: 'action-row' + (a.danger ? ' danger' : ''), type: 'button',
          onclick: () => { picked = a.value; s.dismiss(false); } },
        icon(a.icon), h('span', null, a.label)))),
      onClose: () => resolve(picked),
    });
  });
}

let toastTimer;
export function toast(message, kind = 'ok') {
  const root = document.getElementById('toasts');
  root.replaceChildren();
  const t = h('div', { class: 'toast ' + kind, role: 'status' },
    h('span', { class: 'toast-ic' }, icon(kind === 'error' ? 'x' : 'check')), h('span', null, message));
  root.append(t);
  requestAnimationFrame(() => requestAnimationFrame(() => t.classList.add('in')));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.classList.remove('in'); setTimeout(() => t.remove(), 300); }, kind === 'error' ? 3800 : 2400);
}

// ---------------------------------------------------------------- form bits
export function field({ id, label, type = 'text', value = '', placeholder = '', dir, autocomplete, hint, multiline = false, maxlength, autofocus = false, inputmode }) {
  const input = multiline
    ? h('textarea', { id, class: 'input textarea', rows: 3, placeholder, maxlength, autofocus, dir: dir || 'auto' })
    : h('input', { id, class: 'input', type, placeholder, autocomplete, maxlength, autofocus, dir, inputmode,
        autocapitalize: 'off', spellcheck: 'false' });
  input.value = value;
  if (multiline) {
    const fit = () => { input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight + 2, 320) + 'px'; };
    input.addEventListener('input', fit);
    requestAnimationFrame(fit);
  }
  const wrap = h('label', { class: 'field', for: id },
    h('span', { class: 'field-label' }, label),
    input,
    hint ? h('span', { class: 'field-hint' }, hint) : null);
  return { wrap, input };
}

export function passwordField(opts) {
  const f = field({ ...opts, type: 'password', dir: 'ltr' });
  const btn = h('button', { class: 'eye', type: 'button', 'aria-label': 'إظهار كلمة المرور' }, icon('eye'));
  btn.addEventListener('click', (e) => {
    e.preventDefault();
    const show = f.input.type === 'password';
    f.input.type = show ? 'text' : 'password';
    btn.replaceChildren(icon(show ? 'eyeOff' : 'eye'));
    btn.setAttribute('aria-label', show ? 'إخفاء كلمة المرور' : 'إظهار كلمة المرور');
  });
  const box = h('div', { class: 'input-wrap' });
  f.input.replaceWith(box);
  box.append(f.input, btn);
  return f;
}

export function segmented(options, value, onChange, { id } = {}) {
  const el = h('div', { class: 'segmented', role: 'tablist', id });
  const thumb = h('span', { class: 'seg-thumb', 'aria-hidden': 'true' });
  el.append(thumb);
  const btns = options.map((o) => {
    const b = h('button', { class: 'seg', type: 'button', role: 'tab', dataset: { v: o.value } }, o.label);
    b.addEventListener('click', () => { set(o.value); onChange && onChange(o.value); });
    el.append(b);
    return b;
  });
  el.style.setProperty('--n', options.length);
  function set(v) {
    value = v;
    const i = Math.max(0, options.findIndex((o) => o.value === v));
    btns.forEach((b, j) => { b.classList.toggle('on', j === i); b.setAttribute('aria-selected', j === i); });
    el.style.setProperty('--i', i);
  }
  set(value);
  return { el, set, get: () => value };
}

export function toggleSwitch(checked, onChange, label) {
  const input = h('input', { type: 'checkbox', class: 'switch-input', role: 'switch', 'aria-label': label });
  input.checked = checked;
  input.addEventListener('change', () => onChange && onChange(input.checked));
  return { el: h('label', { class: 'switch' }, input, h('span', { class: 'switch-track' }, h('span', { class: 'switch-knob' }))), input };
}

export function button(label, { kind = 'primary', iconName, type = 'button', onclick, id, block = false } = {}) {
  // Full-width primary buttons get the pill call-to-action look: icon disc + fading chevrons.
  if (kind === 'primary' && block) {
    return h('button', { class: 'btn primary block cta', type, onclick, id },
      h('span', { class: 'cta-ic', 'aria-hidden': 'true' }, icon(iconName || 'arrow')),
      h('span', { class: 'btn-label' }, label),
      h('span', { class: 'cta-chev', 'aria-hidden': 'true' }, icon('chevL'), icon('chevL'), icon('chevL')),
      h('span', { class: 'spinner', 'aria-hidden': 'true' }));
  }
  return h('button', { class: `btn ${kind}${block ? ' block' : ''}`, type, onclick, id },
    iconName ? icon(iconName) : null, h('span', { class: 'btn-label' }, label), h('span', { class: 'spinner', 'aria-hidden': 'true' }));
}

// Value for <input type="date"> / <input type="time"> from an ISO time, in local time.
export function toDateInput(iso) {
  const d = iso ? new Date(iso) : new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
export function toTimeInput(iso) {
  const d = iso ? new Date(iso) : new Date();
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
export function fromInputs(date, time) {
  if (!date) return null;
  const [y, m, d] = date.split('-').map(Number);
  const [hh, mm] = (time || '00:00').split(':').map(Number);
  return new Date(y, m - 1, d, hh || 0, mm || 0).toISOString();
}
export function setBusy(btn, busy) { btn.classList.toggle('busy', busy); btn.disabled = busy; }

// ---------------------------------------------------------------- formatting
const pad = (n) => String(n).padStart(2, '0');
export function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;
}
export function fmtTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  let hr = d.getHours();
  const ap = hr >= 12 ? 'PM' : 'AM';
  hr = hr % 12 || 12;
  return `${pad(hr)}:${pad(d.getMinutes())} ${ap}`;
}
export function dayKey(iso) {
  const d = new Date(iso);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
export function dayLabel(key) {
  const today = dayKey(new Date().toISOString());
  const y = new Date(); y.setDate(y.getDate() - 1);
  if (key === today) return 'اليوم';
  if (key === dayKey(y.toISOString())) return 'أمس';
  const [yy, mm, dd] = key.split('-');
  return `${dd}/${mm}/${yy}`;
}
export function initials(name) {
  const parts = String(name || '?').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  const first = Array.from(parts[0])[0] || '';
  const second = parts.length > 1 ? Array.from(parts[parts.length - 1])[0] : '';
  // Arabic letters join into a word, so Arabic names get a single letter.
  if (/[؀-ۿ]/.test(first)) return first;
  return (first + second).toUpperCase();
}
export function avatarHue(id) {
  let x = 0; for (const c of String(id || '')) x = (x * 31 + c.charCodeAt(0)) >>> 0;
  return [74, 92, 150, 42, 170, 60][x % 6];
}
export function avatar(profile, size = 40) {
  const name = profile ? (profile.full_name || profile.username) : '?';
  return h('span', { class: 'avatar', style: { '--hue': avatarHue(profile && profile.id), width: size + 'px', height: size + 'px', fontSize: Math.round(size * 0.38) + 'px' } }, initials(name));
}

export function generatePassword(len = 10) {
  const chars = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const a = new Uint32Array(len);
  crypto.getRandomValues(a);
  let s = '';
  for (let i = 0; i < len; i++) s += chars[a[i] % chars.length];
  return /\d/.test(s) ? s : s.slice(0, -1) + '7';
}

export async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; }
  catch (_) {
    const ta = h('textarea', { style: { position: 'fixed', opacity: '0' } });
    ta.value = text; document.body.append(ta); ta.select();
    let ok = false; try { ok = document.execCommand('copy'); } catch (_) {}
    ta.remove(); return ok;
  }
}
