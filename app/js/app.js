import { createApi } from './api.js';
import { APP_URL, APK_URL, APP_NAME, APP_VERSION } from './config.js';
import {
  h, icon, logoMark, sheet, confirmDialog, actionSheet, toast, field, passwordField, segmented,
  toggleSwitch, button, setBusy, fmtDate, fmtTime, dayKey, dayLabel, avatar, generatePassword,
  copyText, countUp, reducedMotion, wait, haptic, closeAllLayers, toDateInput, toTimeInput, fromInputs,
} from './ui.js';

const api = window.__INJAZ_TEST_API__ || createApi();
const root = document.getElementById('root');

// ====================================================================== state
const S = {
  me: null,
  tasks: [],
  profiles: [],
  activity: [],
  status: 'idle',          // idle | loading | ready | error
  route: null,
  filter: { status: 'all', user: '', date: '', q: '' },
  view: pref('view', 'cards'),
  pending: new Set(),      // task ids with a request in flight
  justDone: new Set(),     // task ids to play the check animation on (next render only)
  hold: new Set(),         // just-completed task ids kept in place briefly
  unsubscribe: null,
};

function pref(k, d) { try { return localStorage.getItem('injaz.' + k) || d; } catch (_) { return d; } }
function setPref(k, v) { try { localStorage.setItem('injaz.' + k, v); } catch (_) {} }

const isAdmin = () => S.me && S.me.role === 'admin';
const nameOf = (p) => (p ? (p.full_name && p.full_name.trim()) || p.username : '');
const profileById = (id) => S.profiles.find((p) => p.id === id);

const ERR = {
  not_allowed: 'ليس لديك صلاحية لهذا الإجراء',
  task_not_found: 'هذه المهمة لم تعد موجودة',
  already_completed: 'أنجز شخص آخر هذه المهمة للتو',
  weak_password: 'كلمة المرور يجب أن تكون 8 أحرف على الأقل',
  same_password: 'اختر كلمة مرور مختلفة عن الحالية',
  wrong_password: 'كلمة المرور الحالية غير صحيحة',
  username_taken: 'اسم المستخدم هذا مستخدم بالفعل',
  invalid_username: 'اسم المستخدم من 3 إلى 32 حرفاً إنجليزياً صغيراً أو رقماً، ويمكن استخدام . و _ و -',
  invalid_role: 'نوع الحساب غير صالح',
  cannot_change_self: 'لا يمكنك إيقاف حسابك أو إزالة صلاحية المدير منه',
  user_not_found: 'هذا الحساب لم يعد موجوداً',
  invalid_credentials: 'اسم المستخدم أو كلمة المرور غير صحيحة',
  banned: 'هذا الحساب موقوف. تواصل مع المدير',
  network: 'تعذّر الاتصال. تأكد من الإنترنت وحاول مرة أخرى',
  session: 'انتهت الجلسة. سجّل الدخول مرة أخرى',
  already_archived: 'سجّل شخص آخر أرشفة هذه المهمة للتو',
  path_too_long: 'مسار الفولدر طويل جداً',
};
// Arabic number agreement for "task".
function tasksN(n) {
  if (n === 1) return 'مهمة واحدة';
  if (n === 2) return 'مهمتان';
  if (n >= 3 && n <= 10) return `${n} مهام`;
  return `${n} مهمة`;
}
const isolate = (s) => `\u2066${s}\u2069`;

const errText = (e) => ERR[e && e.code] || 'حدث خطأ غير متوقع. حاول مرة أخرى';

// ====================================================================== theme
function applyTheme(mode) {
  const light = mode === 'light';
  document.documentElement.setAttribute('data-theme', light ? 'light' : 'dark');
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', light ? '#EEF0EA' : '#0C0D0F');
}

// ====================================================================== cache
const cacheKey = () => 'injaz.cache.' + (S.me ? S.me.id : '');
function saveCache() {
  try { localStorage.setItem(cacheKey(), JSON.stringify({ t: S.tasks, p: S.profiles, a: S.activity.slice(0, 120) })); } catch (_) {}
}
function loadCache() {
  try {
    const c = JSON.parse(localStorage.getItem(cacheKey()) || 'null');
    if (c) { S.tasks = c.t || []; S.profiles = c.p || []; S.activity = c.a || []; return true; }
  } catch (_) {}
  return false;
}

// ====================================================================== boot
async function boot() {
  applyTheme(pref('theme', 'dark'));
  showSplash();
  const t0 = performance.now();
  let session = null;
  try { session = await api.getSession(); } catch (_) {}
  await wait(Math.max(0, 750 - (performance.now() - t0)));
  if (!session) { showLogin(); return; }
  await enterApp();
}

api.onAuthChange((event) => {
  if (event === 'SIGNED_OUT' && S.me) leaveApp('انتهت الجلسة. سجّل الدخول مرة أخرى');
});

async function enterApp(fromLogin = false) {
  let me;
  try { me = await api.myProfile(); }
  catch (e) {
    if (e.code === 'network') { showOffline(); return; }
    await api.signOut(); showLogin(errText(e)); return;
  }
  if (!me) { await api.signOut(); showLogin('لم يتم العثور على حسابك'); return; }
  if (!me.active) { await api.signOut(); showLogin(ERR.banned); return; }
  S.me = me;
  if (me.must_change_password) { showForcedPassword(); return; }
  showShell(fromLogin);
}

// Sign out on purpose (clears S.me first so the auth listener does not report an expired session).
async function signOutNow(message) {
  S.me = null;
  await api.signOut();
  leaveApp(message);
}

function leaveApp(message) {
  if (S.unsubscribe) { S.unsubscribe(); S.unsubscribe = null; }
  closeAllLayers();
  S.me = null; S.tasks = []; S.profiles = []; S.activity = []; S.status = 'idle'; S.route = null;
  showLogin(message);
}

// ====================================================================== splash
function showSplash() {
  root.replaceChildren(h('div', { class: 'splash' },
    h('div', { class: 'splash-mark' }, logoMark(84)),
    h('div', { class: 'splash-name' }, APP_NAME)));
}

function showOffline() {
  const retry = button('إعادة المحاولة', { iconName: 'refresh', kind: 'secondary' });
  retry.addEventListener('click', async () => { setBusy(retry, true); await enterApp(); });
  root.replaceChildren(h('div', { class: 'center-screen' },
    stateBlock('offline', 'لا يوجد اتصال', 'تأكد من اتصالك بالإنترنت، ثم حاول مرة أخرى.', retry)));
}

// ====================================================================== login
function showLogin(message = '') {
  const user = field({ id: 'login-user', label: 'اسم المستخدم', dir: 'ltr', autocomplete: 'username', placeholder: 'admin' });
  const pass = passwordField({ id: 'login-pass', label: 'كلمة المرور', autocomplete: 'current-password', placeholder: '••••••••' });
  const err = h('p', { class: 'form-error', role: 'alert' }, message);
  const submit = button('تسجيل الدخول', { type: 'submit', block: true });
  const card = h('form', { class: 'auth-card glass-strong', novalidate: true },
    h('div', { class: 'auth-brand' }, logoMark(64),
      h('h1', { class: 'auth-title' }, APP_NAME),
      h('p', { class: 'auth-sub' }, 'سجّل دخولك لمتابعة مهام الفريق')),
    h('div', { class: 'stack' }, user.wrap, pass.wrap),
    err, submit);

  card.addEventListener('submit', async (e) => {
    e.preventDefault();
    const u = user.input.value.trim().toLowerCase();
    const p = pass.input.value;
    if (!u || !p) { showErr('اكتب اسم المستخدم وكلمة المرور'); return; }
    setBusy(submit, true); err.textContent = '';
    try {
      await api.signIn(u, p);
      await enterApp(true);
    } catch (ex) {
      setBusy(submit, false);
      showErr(errText(ex));
    }
  });
  function showErr(t) {
    err.textContent = t;
    card.classList.remove('shake'); void card.offsetWidth; card.classList.add('shake');
    haptic(20);
  }

  root.replaceChildren(h('div', { class: 'auth-screen' }, card,
    h('p', { class: 'auth-foot' }, `${APP_NAME} · ${APP_VERSION}`)));
  setTimeout(() => (user.input.value ? pass.input : user.input).focus({ preventScroll: true }), 350);
}

// ====================================================================== password
function passwordForm({ forced, onDone }) {
  const cur = passwordField({ id: 'pw-cur', label: forced ? 'كلمة المرور الحالية (المؤقتة)' : 'كلمة المرور الحالية', autocomplete: 'current-password' });
  const nw = passwordField({ id: 'pw-new', label: 'كلمة المرور الجديدة', autocomplete: 'new-password', hint: '8 أحرف على الأقل' });
  const cf = passwordField({ id: 'pw-confirm', label: 'تأكيد كلمة المرور الجديدة', autocomplete: 'new-password' });
  const meter = h('div', { class: 'meter', 'aria-hidden': 'true' }, h('span'), h('span'), h('span'), h('span'));
  nw.wrap.append(meter);
  nw.input.addEventListener('input', () => {
    const v = nw.input.value;
    let s = 0;
    if (v.length >= 8) s++;
    if (v.length >= 12) s++;
    if (/[A-Z]/.test(v) && /[a-z]/.test(v)) s++;
    if (/\d/.test(v) && /[^A-Za-z0-9]/.test(v)) s++;
    meter.dataset.s = v ? Math.max(1, s) : 0;
  });
  const err = h('p', { class: 'form-error', role: 'alert' });
  const submit = button(forced ? 'حفظ ومتابعة' : 'تغيير كلمة المرور', { type: 'submit', block: true });
  const form = h('form', { class: 'stack', novalidate: true }, cur.wrap, nw.wrap, cf.wrap, err, submit);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    err.textContent = '';
    if (nw.input.value.length < 8) { err.textContent = ERR.weak_password; return; }
    if (nw.input.value !== cf.input.value) { err.textContent = 'كلمتا المرور غير متطابقتين'; return; }
    setBusy(submit, true);
    try {
      await api.changeMyPassword(cur.input.value, nw.input.value);
      S.me.must_change_password = false;
      toast('تم تغيير كلمة المرور');
      onDone && onDone();
    } catch (ex) {
      setBusy(submit, false);
      err.textContent = errText(ex);
    }
  });
  return { form, first: cur.input };
}

function showForcedPassword() {
  const { form, first } = passwordForm({ forced: true, onDone: () => showShell(true) });
  const out = h('button', { class: 'link-btn', type: 'button' }, 'تسجيل الخروج');
  out.addEventListener('click', () => signOutNow());
  root.replaceChildren(h('div', { class: 'auth-screen' },
    h('div', { class: 'auth-card glass-strong' },
      h('div', { class: 'auth-brand' },
        h('span', { class: 'brand-icon' }, icon('lock')),
        h('h1', { class: 'auth-title sm' }, 'اختر كلمة مرور جديدة'),
        h('p', { class: 'auth-sub' }, `مرحباً ${nameOf(S.me)}. لحماية حسابك، غيّر كلمة المرور المؤقتة قبل المتابعة.`)),
      form, out)));
  setTimeout(() => first.focus({ preventScroll: true }), 350);
}

// ====================================================================== shell
const ROUTES = {
  home:     { label: 'الرئيسية', icon: 'home',  admin: true,  title: 'الرئيسية' },
  tasks:    { label: 'المهام',   icon: 'tasks', admin: false, title: 'المهام' },
  users:    { label: 'المستخدمون', icon: 'users', admin: true, title: 'المستخدمون' },
  activity: { label: 'السجل',    icon: 'clock', admin: false, title: 'السجل' },
};
const routesFor = () => Object.keys(ROUTES).filter((r) => isAdmin() || !ROUTES[r].admin);

let shell = null;

function showShell(animate) {
  const headerTitle = h('div', { class: 'bar-title' });
  const addBtn = h('button', { class: 'icon-btn accent', type: 'button', 'aria-label': 'إضافة' }, icon('plus'));
  const meBtn = h('button', { class: 'avatar-btn', type: 'button', 'aria-label': 'حسابي' }, avatar(S.me, 34));
  const header = h('header', { class: 'topbar' },
    h('div', { class: 'topbar-inner' }, headerTitle, h('div', { class: 'bar-actions' }, addBtn, meBtn)));

  const view = h('main', { class: 'view', id: 'view' });
  const tabs = routesFor();
  const indicator = h('span', { class: 'tab-indicator', 'aria-hidden': 'true' });
  const tabBtns = tabs.map((r) => h('button', { class: 'tab', type: 'button', dataset: { r }, onclick: () => go(r) },
    icon(ROUTES[r].icon), h('span', null, r === 'activity' && !isAdmin() ? 'سجلي' : ROUTES[r].label)));
  const tabbar = h('nav', { class: 'tabbar', style: { '--n': tabs.length } }, h('div', { class: 'tabbar-inner' }, indicator, tabBtns));

  const el = h('div', { class: 'shell' + (animate ? ' enter' : '') }, header, view, tabbar);
  root.replaceChildren(el);
  shell = { el, header, headerTitle, addBtn, meBtn, view, tabBtns, screen: null };

  addBtn.addEventListener('click', () => shell.screen && shell.screen.add && shell.screen.add());
  meBtn.addEventListener('click', openProfile);

  // data
  S.status = loadCache() ? 'ready' : 'loading';
  const start = (location.hash || '').slice(1);
  go(tabs.includes(start) ? start : (isAdmin() ? 'home' : 'tasks'), true);
  loadAll();
  if (S.unsubscribe) S.unsubscribe();
  S.unsubscribe = api.subscribe(onLiveChange);
}

window.addEventListener('scroll', () => onScroll(), { passive: true });
function onScroll() {
  if (!shell) return;
  shell.header.classList.toggle('scrolled', window.scrollY > 36);
}

function go(route, first = false) {
  if (!shell || (S.route === route && !first)) { if (S.route === route) window.scrollTo({ top: 0, behavior: reducedMotion() ? 'auto' : 'smooth' }); return; }
  S.route = route;
  try { history.replaceState(history.state, '', '#' + route); } catch (_) {}
  shell.tabBtns.forEach((b, i) => {
    const on = b.dataset.r === route;
    b.classList.toggle('on', on);
    b.setAttribute('aria-current', on ? 'page' : 'false');
    if (on) shell.el.querySelector('.tabbar').style.setProperty('--i', i);
  });
  const title = route === 'activity' && !isAdmin() ? 'سجلي' : ROUTES[route].title;
  shell.headerTitle.textContent = title;
  const screen = SCREENS[route]();
  shell.screen = screen;
  shell.addBtn.hidden = !screen.add;
  const page = h('div', { class: 'page' + (first ? '' : ' page-in') });
  screen.mount(page);
  shell.view.replaceChildren(page);
  window.scrollTo(0, 0);
  onScroll();
  screen.update();
}

function refresh() { if (shell && shell.screen) shell.screen.update(); }

async function loadAll(silent = false) {
  if (!S.tasks.length && !silent) { S.status = 'loading'; refresh(); }
  try {
    const [tasks, profiles, activity] = await Promise.all([api.listTasks(), api.listProfiles(), api.listActivity()]);
    S.tasks = tasks || []; S.profiles = profiles || []; S.activity = activity || [];
    const me = S.profiles.find((p) => p.id === S.me.id);
    if (me) {
      if (!me.active) { await signOutNow(ERR.banned); return; }
      const roleChanged = me.role !== S.me.role;
      S.me = me;
      if (roleChanged) { toast('تم تحديث صلاحيات حسابك'); showShell(false); return; }
    }
    S.status = 'ready';
    saveCache();
  } catch (e) {
    if (e.code === 'session') { await signOutNow(ERR.session); return; }
    if (S.status !== 'ready') { S.status = 'error'; S.error = e; }
    else if (!silent) toast(errText(e), 'error');
  }
  refresh();
}

let liveTimer;
function onLiveChange() {
  clearTimeout(liveTimer);
  liveTimer = setTimeout(() => loadAll(true), 250);
}
document.addEventListener('visibilitychange', () => { if (!document.hidden && S.me && shell) loadAll(true); });
window.addEventListener('online', () => { if (S.me && shell) loadAll(true); });

// ====================================================================== shared blocks
const ILLUSTRATIONS = {
  tasks: `<svg viewBox="0 0 160 120" aria-hidden="true"><rect x="38" y="14" width="84" height="96" rx="16" class="il-card"/><rect x="62" y="8" width="36" height="14" rx="7" class="il-accent-soft"/><rect x="54" y="42" width="14" height="14" rx="5" class="il-accent"/><path d="m57.5 49 2.5 2.5 5-5" class="il-check"/><rect x="74" y="45" width="34" height="8" rx="4" class="il-line"/><rect x="54" y="66" width="14" height="14" rx="5" class="il-box"/><rect x="74" y="69" width="26" height="8" rx="4" class="il-line"/><rect x="54" y="88" width="14" height="14" rx="5" class="il-box"/><rect x="74" y="91" width="30" height="8" rx="4" class="il-line"/><circle cx="130" cy="30" r="5" class="il-accent-soft"/><circle cx="26" cy="88" r="7" class="il-accent-soft"/></svg>`,
  search: `<svg viewBox="0 0 160 120" aria-hidden="true"><circle cx="72" cy="56" r="30" class="il-card"/><circle cx="72" cy="56" r="18" class="il-box"/><path d="m94 78 20 20" class="il-stroke"/><circle cx="128" cy="34" r="5" class="il-accent-soft"/><circle cx="30" cy="84" r="6" class="il-accent-soft"/></svg>`,
  users: `<svg viewBox="0 0 160 120" aria-hidden="true"><rect x="30" y="22" width="100" height="78" rx="18" class="il-card"/><circle cx="80" cy="52" r="13" class="il-accent-soft"/><path d="M58 88a22 22 0 0 1 44 0" class="il-stroke"/><circle cx="128" cy="24" r="6" class="il-accent-soft"/></svg>`,
  clock: `<svg viewBox="0 0 160 120" aria-hidden="true"><circle cx="80" cy="60" r="40" class="il-card"/><path d="M80 38v22l14 9" class="il-stroke"/><circle cx="128" cy="26" r="6" class="il-accent-soft"/><circle cx="34" cy="94" r="5" class="il-accent-soft"/></svg>`,
  offline: `<svg viewBox="0 0 160 120" aria-hidden="true"><circle cx="80" cy="60" r="40" class="il-card"/><path d="M60 64a28 28 0 0 1 40 0M68 74a14 14 0 0 1 24 0" class="il-stroke"/><path d="m56 40 48 48" class="il-stroke danger"/></svg>`,
};

function stateBlock(kind, title, text, action) {
  const art = h('div', { class: 'state-art' });
  art.innerHTML = ILLUSTRATIONS[kind] || ILLUSTRATIONS.tasks;
  return h('div', { class: 'state' }, art, h('h3', null, title), text ? h('p', null, text) : null, action || null);
}

function errorBlock() {
  const retry = button('إعادة المحاولة', { iconName: 'refresh', kind: 'secondary' });
  retry.addEventListener('click', () => { setBusy(retry, true); loadAll(); });
  return stateBlock('offline', 'تعذّر تحميل البيانات', errText(S.error), retry);
}

function skeletonCards(n = 4) {
  return h('div', { class: 'list' }, Array.from({ length: n }, () =>
    h('div', { class: 'card skeleton-card' },
      h('div', { class: 'sk-row' }, h('span', { class: 'sk sk-box' }), h('span', { class: 'sk sk-line w70' })),
      h('span', { class: 'sk sk-line w45' }),
      h('div', { class: 'sk-meta' }, h('span', { class: 'sk sk-line' }), h('span', { class: 'sk sk-line' }), h('span', { class: 'sk sk-line' })))));
}

function largeTitle(text, sub) {
  return h('div', { class: 'large-title' }, h('h1', null, text), sub ? h('p', { class: 'lt-sub' }, sub) : h('p', { class: 'lt-sub' }));
}

// ====================================================================== tasks
function canToggle(t) {
  if (!S.me) return false;
  if (t.completed) return isAdmin() || t.completed_by === S.me.id;
  return isAdmin() || !t.assigned_to || t.assigned_to === S.me.id;
}

const sortDone = (t) => (t.completed && !S.hold.has(t.id) ? 1 : 0);
function visibleTasks() {
  const f = S.filter;
  const q = f.q.trim().toLowerCase();
  return S.tasks
    .filter((t) => f.status === 'all' || (f.status === 'done' ? t.completed : !t.completed))
    .filter((t) => !f.user || t.assigned_to === f.user)
    .filter((t) => !f.date || (t.completed_at && dayKey(t.completed_at) === f.date))
    .filter((t) => !q || t.description.toLowerCase().includes(q) || (t.completed_by_name || '').toLowerCase().includes(q)
      || (t.folder_path || '').toLowerCase().includes(q))
    .sort((a, b) => (sortDone(a) - sortDone(b)) ||
      (a.completed ? new Date(b.completed_at) - new Date(a.completed_at) : new Date(b.opened_at || b.created_at) - new Date(a.opened_at || a.created_at)));
}

function checkbox(t) {
  const allowed = canToggle(t);
  const b = h('button', {
    class: 'check' + (t.completed ? ' on' : '') + (S.justDone.has(t.id) ? ' pop' : '') + (S.pending.has(t.id) ? ' wait' : ''),
    type: 'button', role: 'checkbox', 'aria-checked': t.completed ? 'true' : 'false',
    'aria-label': t.completed ? 'تم، اضغط لإعادة الفتح' : 'تم',
    disabled: !allowed,
  });
  b.innerHTML = '<span class="check-box"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 12.5 4 4L18 8"/></svg></span>';
  b.addEventListener('click', (e) => { e.stopPropagation(); toggleTask(t.id); });
  return b;
}

async function toggleTask(id) {
  const t = S.tasks.find((x) => x.id === id);
  if (!t || S.pending.has(id) || !canToggle(t)) return;
  if (!t.completed) {
    const before = { ...t };
    Object.assign(t, { completed: true, completed_by: S.me.id, completed_by_name: nameOf(S.me), completed_at: new Date().toISOString() });
    S.pending.add(id); S.justDone.add(id); S.hold.add(id); haptic(12);
    refresh();
    S.justDone.delete(id);
    setTimeout(() => { S.hold.delete(id); refresh(); }, 1100);
    try {
      const row = await api.completeTask(id);
      Object.assign(t, row || {});
    } catch (e) {
      Object.assign(t, before);
      toast(errText(e), 'error');
      if (e.code === 'already_completed') loadAll(true);
    }
    S.pending.delete(id); refresh();
  } else {
    const who = t.completed_by_name ? ` بواسطة ${t.completed_by_name}` : '';
    const ok = await confirmDialog({
      title: 'إعادة فتح المهمة؟',
      message: `ستعود المهمة إلى قيد التنفيذ. يبقى سجل إنجازها${who} محفوظاً في السجل.`,
      confirmText: 'إعادة الفتح',
    });
    if (!ok) return;
    const before = { ...t };
    Object.assign(t, { completed: false, completed_by: null, completed_by_name: null, completed_at: null });
    S.pending.add(id); refresh();
    try {
      const row = await api.reopenTask(id);
      Object.assign(t, row || {});
      toast('أُعيد فتح المهمة');
    } catch (e) {
      Object.assign(t, before);
      toast(errText(e), 'error');
    }
    S.pending.delete(id); refresh();
  }
}

function assignedLabel(t) {
  if (!t.assigned_to) return 'للجميع';
  const p = profileById(t.assigned_to);
  return p ? `لـ ${nameOf(p)}` : 'لمستخدم محذوف';
}

function metaCell(label, value, cls = '') {
  return h('div', { class: 'meta ' + cls }, h('span', { class: 'meta-k' }, label), h('span', { class: 'meta-v' }, value));
}
// Date on top, time underneath.
function dtCell(label, iso, cls = '') {
  return h('div', { class: 'meta ' + cls + (iso ? '' : ' empty') }, h('span', { class: 'meta-k' }, label),
    h('span', { class: 'dt' }, h('b', null, iso ? fmtDate(iso) : '—'), iso ? h('span', null, fmtTime(iso)) : null));
}
const openedAt = (t) => t.opened_at || t.created_at;

// ----- archive tick
const canArchive = (t) => !!S.me && (isAdmin() || !t.assigned_to || t.assigned_to === S.me.id) &&
  (!t.archived || isAdmin() || t.archived_by === S.me.id);

function archiveBox(t) {
  const allowed = canArchive(t);
  const busy = S.pending.has('a' + t.id);
  const b = h('button', {
    class: 'check small' + (t.archived ? ' on' : '') + (S.justDone.has('a' + t.id) ? ' pop' : '') + (busy ? ' wait' : ''),
    type: 'button', role: 'checkbox', 'aria-checked': t.archived ? 'true' : 'false', 'aria-label': 'تم الأرشفة', disabled: !allowed,
  });
  b.innerHTML = '<span class="check-box"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 12.5 4 4L18 8"/></svg></span>';
  b.addEventListener('click', (e) => { e.stopPropagation(); toggleArchive(t.id); });
  return b;
}

async function toggleArchive(id) {
  const t = S.tasks.find((x) => x.id === id);
  const key = 'a' + id;
  if (!t || S.pending.has(key) || !canArchive(t)) return;
  const before = { ...t };
  const next = !t.archived;
  if (!next) {
    const ok = await confirmDialog({ title: 'إلغاء علامة الأرشفة؟', message: 'يبقى تسجيل الأرشفة السابق محفوظاً في السجل.', confirmText: 'إلغاء العلامة' });
    if (!ok) return;
  }
  Object.assign(t, next
    ? { archived: true, archived_by: S.me.id, archived_by_name: nameOf(S.me), archived_at: new Date().toISOString() }
    : { archived: false, archived_by: null, archived_by_name: null, archived_at: null });
  S.pending.add(key);
  if (next) { S.justDone.add(key); haptic(10); }
  refresh();
  S.justDone.delete(key);
  try { Object.assign(t, (await api.setTaskArchived(id, next)) || {}); if (next) toast('تم تسجيل الأرشفة'); }
  catch (e) { Object.assign(t, before); toast(errText(e), 'error'); if (e.code === 'already_archived') loadAll(true); }
  S.pending.delete(key); refresh();
}

// ----- work folder path
const canSetFolder = (t) => !!S.me && (isAdmin() || !t.assigned_to || t.assigned_to === S.me.id);

function folderEditor(t) {
  const f = field({ id: 'folder-path', label: 'مسار الفولدر', value: t.folder_path || '', dir: 'ltr', placeholder: 'D:\\Projects\\Client\\Logo', maxlength: 500, autofocus: true });
  f.input.classList.add('mono');
  const err = h('p', { class: 'form-error', role: 'alert' });
  const save = button('حفظ المسار', { block: true, iconName: 'folder' });
  const s = sheet({ title: 'مسار الفولدر', body: h('div', { class: 'stack' },
    h('p', { class: 'muted' }, 'اكتب أو الصق مكان ملفات الشغل، عشان أي حد يلاقيها بسهولة.'), f.wrap, err), footer: save });
  const submit = async (e) => {
    e && e.preventDefault();
    setBusy(save, true);
    try {
      const row = await api.setTaskFolder(t.id, f.input.value);
      Object.assign(S.tasks.find((x) => x.id === t.id) || {}, row || {});
      toast(f.input.value.trim() ? 'حُفظ المسار' : 'حُذف المسار');
      s.dismiss(false); refresh();
    } catch (ex) { setBusy(save, false); err.textContent = errText(ex); }
  };
  save.addEventListener('click', submit);
  f.input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(e); });
}

function folderRow(t) {
  if (!t.folder_path) {
    return canSetFolder(t)
      ? h('button', { class: 'folder-add', type: 'button', onclick: () => folderEditor(t) }, icon('folderPlus'), 'أضف مسار الفولدر')
      : null;
  }
  const copy = h('button', { class: 'icon-btn xs ghost', type: 'button', 'aria-label': 'نسخ المسار',
    onclick: async (e) => { e.stopPropagation(); (await copyText(t.folder_path)) ? toast('نُسخ المسار') : toast('لم يتم النسخ', 'error'); } }, icon('copy'));
  const edit = canSetFolder(t) ? h('button', { class: 'icon-btn xs ghost', type: 'button', 'aria-label': 'تعديل المسار', onclick: () => folderEditor(t) }, icon('edit')) : null;
  return h('div', { class: 'folder' }, icon('folder'), h('span', { class: 'folder-path' }, t.folder_path), copy, edit);
}

function archiveRow(t) {
  return h('div', { class: 'archive' + (t.archived ? ' on' : '') }, archiveBox(t),
    h('div', { class: 'archive-text' },
      h('span', { class: 'archive-label' }, 'تم الأرشفة'),
      t.archived ? h('span', { class: 'archive-who' }, `${t.archived_by_name || '—'} · ${isolate(fmtDate(t.archived_at) + ' ' + fmtTime(t.archived_at))}`) : null));
}

function taskCard(t, i, enter) {
  const desc = h('p', { class: 'task-desc', dir: 'auto' }, t.description);
  const card = h('article', {
    class: 'card task' + (t.completed ? ' done' : '') + (enter ? ' enter' : ''),
    style: enter ? { '--d': Math.min(i, 8) * 40 + 'ms' } : null,
  },
  h('div', { class: 'task-top' },
    checkbox(t),
    h('div', { class: 'task-main' },
      desc,
      h('div', { class: 'task-tags' },
        h('span', { class: 'tag tag-accent' }, icon(t.assigned_to ? 'user' : 'users'), assignedLabel(t)),
        t.completed ? h('span', { class: 'tag tag-ok' }, icon('check'), 'تمت') : h('span', { class: 'tag tag-wait' }, icon('clock'), 'قيد التنفيذ'))),
    isAdmin() ? h('button', { class: 'icon-btn sm ghost', type: 'button', 'aria-label': 'خيارات المهمة', onclick: (e) => { e.stopPropagation(); taskMenu(t); } }, icon('more')) : null),
  h('div', { class: 'task-meta' },
    dtCell('أُنشئت', openedAt(t), 'm-open'),
    dtCell('اكتملت', t.completed_at, 'm-done'),
    metaCell('اسم المستخدم', t.completed_by_name || '—', 'm-user' + (t.completed_by_name ? '' : ' empty'))),
  folderRow(t),
  archiveRow(t));

  // long descriptions: tap to expand
  requestAnimationFrame(() => {
    if (desc.scrollHeight > desc.clientHeight + 2) {
      desc.classList.add('clamped');
      desc.addEventListener('click', () => desc.classList.toggle('open'));
    }
  });
  return card;
}

function dtTd(iso) {
  return h('td', null, iso ? h('span', { class: 'dt' }, h('b', null, fmtDate(iso)), h('span', null, fmtTime(iso))) : '—');
}

function taskTable(list) {
  const rows = list.map((t) => h('tr', { class: t.completed ? 'done' : '' },
    h('td', { class: 'c-task' }, h('div', { class: 'cell-task' },
      h('span', { class: 'cell-desc', dir: 'auto' }, t.description),
      isAdmin() ? h('button', { class: 'icon-btn xs ghost', type: 'button', 'aria-label': 'خيارات المهمة', onclick: () => taskMenu(t) }, icon('more')) : null)),
    h('td', { class: 'c-check' }, checkbox(t)),
    h('td', null, t.completed_by_name || '—'),
    dtTd(openedAt(t)),
    dtTd(t.completed_at),
    h('td', { class: 'c-folder' }, t.folder_path
      ? h('span', { class: 'folder-path' }, t.folder_path)
      : (canSetFolder(t) ? h('button', { class: 'link-btn', type: 'button', onclick: () => folderEditor(t) }, 'إضافة') : '—')),
    h('td', null, h('div', { class: 'cell-archive' }, archiveBox(t), t.archived ? h('span', { class: 'archive-who' }, t.archived_by_name || '') : null))));
  return h('div', { class: 'table-wrap card' },
    h('table', { class: 'tbl' },
      h('thead', null, h('tr', null, ['المهمة', 'تم', 'اسم المستخدم', 'الإنشاء', 'الإنجاز', 'مسار الفولدر', 'تم الأرشفة'].map((x) => h('th', null, x)))),
      h('tbody', null, rows)));
}

async function taskMenu(t) {
  const v = await actionSheet([
    { value: 'edit', label: 'تعديل المهمة', icon: 'edit' },
    { value: 'folder', label: t.folder_path ? 'تعديل مسار الفولدر' : 'إضافة مسار الفولدر', icon: 'folder' },
    { value: 'delete', label: 'حذف المهمة', icon: 'trash', danger: true },
  ]);
  if (v === 'edit') taskEditor(t);
  if (v === 'folder') folderEditor(t);
  if (v === 'delete') {
    const ok = await confirmDialog({ title: 'حذف المهمة؟', message: 'ستُحذف المهمة نهائياً، ويبقى أثرها في السجل.', confirmText: 'حذف', danger: true });
    if (!ok) return;
    const idx = S.tasks.findIndex((x) => x.id === t.id);
    const removed = S.tasks.splice(idx, 1);
    refresh();
    try { await api.deleteTask(t.id); toast('حُذفت المهمة'); }
    catch (e) { S.tasks.splice(idx, 0, ...removed); refresh(); toast(errText(e), 'error'); }
  }
}

function userOptions(selected, { allLabel = 'كل المستخدمين', onlyActive = true } = {}) {
  const sel = h('select', { class: 'input select' });
  sel.append(h('option', { value: '' }, allLabel));
  S.profiles.filter((p) => !onlyActive || p.active || p.id === selected)
    .forEach((p) => sel.append(h('option', { value: p.id }, `${nameOf(p)} (@${p.username})`)));
  sel.value = selected || '';
  return sel;
}

function taskEditor(t) {
  const editing = !!t;
  const desc = field({ id: 'task-desc', label: 'وصف المهمة', multiline: true, value: t ? t.description : '', placeholder: 'اكتب المطلوب بالتفصيل…', maxlength: 2000, autofocus: true });
  const when = t ? openedAt(t) : new Date().toISOString();
  const date = field({ id: 'task-date', label: 'تاريخ الإنشاء', type: 'date', value: toDateInput(when) });
  const time = field({ id: 'task-time', label: 'وقت الإنشاء', type: 'time', value: toTimeInput(when) });
  const folder = field({ id: 'task-folder', label: 'مسار الفولدر (اختياري)', value: t ? t.folder_path || '' : '', dir: 'ltr', placeholder: 'D:\\Projects\\Client\\Logo', maxlength: 500 });
  folder.input.classList.add('mono');
  const assign = userOptions(t ? t.assigned_to : '', { allLabel: 'الجميع' });
  assign.id = 'task-assign';
  const assignWrap = h('label', { class: 'field', for: 'task-assign' }, h('span', { class: 'field-label' }, 'مُسندة إلى'), assign);
  const err = h('p', { class: 'form-error', role: 'alert' });
  const save = button(editing ? 'حفظ التعديلات' : 'إضافة المهمة', { block: true, type: 'submit', iconName: editing ? 'check' : 'plus' });
  const form = h('form', { class: 'stack', novalidate: true }, desc.wrap,
    h('div', { class: 'row2' }, date.wrap, time.wrap), assignWrap, folder.wrap, err);
  const s = sheet({ title: editing ? 'تعديل المهمة' : 'مهمة جديدة', body: form, footer: save, tall: true });
  const submit = async (e) => {
    e && e.preventDefault();
    const text = desc.input.value.trim();
    if (!text) { err.textContent = 'اكتب وصف المهمة'; desc.input.focus(); return; }
    if (!date.input.value) { err.textContent = 'اختر تاريخ الإنشاء'; return; }
    const fields = { description: text, assignedTo: assign.value, openedAt: fromInputs(date.input.value, time.input.value), folderPath: folder.input.value };
    setBusy(save, true);
    try {
      if (editing) {
        const row = await api.updateTask(t.id, fields);
        Object.assign(S.tasks.find((x) => x.id === t.id) || {}, row);
        toast('حُفظت التعديلات');
      } else {
        const row = await api.createTask(fields);
        if (row && !S.tasks.some((x) => x.id === row.id)) S.tasks.unshift(row);
        toast('أُضيفت المهمة');
      }
      s.dismiss(false); refresh();
    } catch (ex) { setBusy(save, false); err.textContent = errText(ex); }
  };
  form.addEventListener('submit', submit);
  save.addEventListener('click', submit);
}

function TasksScreen() {
  let list, sub, search, seg, chipsRow, mounted = false;
  return {
    add: isAdmin() ? () => taskEditor(null) : null,
    mount(page) {
      sub = h('p', { class: 'lt-sub' });
      const lt = h('div', { class: 'large-title' }, h('h1', null, 'المهام'), sub);

      search = h('input', { id: 'task-search', class: 'search-input', type: 'search', placeholder: 'ابحث في المهام', value: S.filter.q, enterkeyhint: 'search' });
      search.addEventListener('input', () => { S.filter.q = search.value; this.update(); });
      const searchBox = h('div', { class: 'search' }, icon('search'), search);

      seg = segmented([
        { value: 'all', label: 'الكل' }, { value: 'pending', label: 'قيد التنفيذ' }, { value: 'done', label: 'المكتملة' },
      ], S.filter.status, (v) => { S.filter.status = v; this.update(); }, { id: 'task-status' });

      chipsRow = h('div', { class: 'chips' });
      this.renderChips();

      list = h('div', { class: 'list-host' });
      page.append(lt, h('div', { class: 'toolbar' }, searchBox, seg.el, chipsRow), list);
    },
    renderChips() {
      const kids = [];
      if (isAdmin()) {
        const sel = userOptions(S.filter.user, { allLabel: 'كل المستخدمين', onlyActive: false });
        sel.className = 'chip-select';
        sel.setAttribute('aria-label', 'مُسندة إلى');
        sel.addEventListener('change', () => { S.filter.user = sel.value; this.renderChips(); this.update(); });
        kids.push(h('label', { class: 'chip' + (S.filter.user ? ' on' : '') }, icon('user'), sel));
      }
      const date = h('input', { type: 'date', class: 'chip-date', 'aria-label': 'يوم الإنجاز', value: S.filter.date });
      date.addEventListener('change', () => { S.filter.date = date.value; this.renderChips(); this.update(); });
      kids.push(h('label', { class: 'chip' + (S.filter.date ? ' on' : '') }, icon('calendar'),
        h('span', { class: 'chip-text' }, S.filter.date ? fmtDate(S.filter.date + 'T12:00:00') : 'يوم الإنجاز'), date));
      if (S.filter.user || S.filter.date) {
        kids.push(h('button', { class: 'chip clear', type: 'button', onclick: () => { S.filter.user = ''; S.filter.date = ''; this.renderChips(); this.update(); } }, icon('x'), 'مسح'));
      }
      const viewToggle = h('div', { class: 'view-toggle', role: 'group', 'aria-label': 'طريقة العرض' },
        h('button', { class: 'vt' + (S.view === 'cards' ? ' on' : ''), type: 'button', 'aria-label': 'بطاقات', onclick: () => setView('cards') }, icon('cards')),
        h('button', { class: 'vt' + (S.view === 'table' ? ' on' : ''), type: 'button', 'aria-label': 'جدول', onclick: () => setView('table') }, icon('table')));
      const setView = (v) => { S.view = v; setPref('view', v); this.renderChips(); this.update(); };
      chipsRow.replaceChildren(h('div', { class: 'chips-scroll' }, kids), viewToggle);
    },
    update() {
      if (!list) return;
      const done = S.tasks.filter((t) => t.completed).length;
      sub.textContent = S.tasks.length ? `${S.tasks.length - done} قيد التنفيذ · ${done} مكتملة` : '';
      if (S.status === 'loading' && !S.tasks.length) { list.replaceChildren(skeletonCards()); return; }
      if (S.status === 'error' && !S.tasks.length) { list.replaceChildren(errorBlock()); return; }
      const items = visibleTasks();
      if (!S.tasks.length) {
        list.replaceChildren(stateBlock('tasks', 'لا توجد مهام بعد',
          isAdmin() ? 'أضف أول مهمة لفريقك، وستظهر هنا فوراً على كل الأجهزة.' : 'عندما يضيف المدير مهاماً لك، ستظهر هنا.',
          isAdmin() ? button('إضافة مهمة', { iconName: 'plus', onclick: () => taskEditor(null) }) : null));
        return;
      }
      if (!items.length) { list.replaceChildren(stateBlock('search', 'لا توجد نتائج', 'جرّب كلمة بحث أخرى أو غيّر عوامل التصفية.')); return; }
      const enter = !mounted && !reducedMotion();
      mounted = true;
      list.replaceChildren(S.view === 'table' ? taskTable(items) : h('div', { class: 'list' }, items.map((t, i) => taskCard(t, i, enter))));
    },
  };
}

// ====================================================================== dashboard
// Ruler gauge: tick marks lit up to the value, with a bright marker.
function ruler(pct) {
  const N = 41;
  const ticks = h('div', { class: 'ruler-ticks' }, Array.from({ length: N }, () => h('i')));
  const mark = h('span', { class: 'ruler-mark' });
  const el = h('div', { class: 'ruler', role: 'img', 'aria-label': `نسبة الإنجاز ${Math.round(pct)}%` },
    ticks, mark, h('div', { class: 'ruler-scale' }, h('span', null, '0%'), h('span', null, '50%'), h('span', null, '100%')));
  return {
    el,
    set(p, animate) {
      const lit = Math.round((p / 100) * (N - 1));
      if (!animate) mark.style.transition = 'none';
      requestAnimationFrame(() => {
        mark.style.right = `${p}%`;
        [...ticks.children].forEach((t, i) => {
          const on = i <= lit && p > 0;
          if (animate) setTimeout(() => t.classList.toggle('lit', on), i * 18); else t.classList.toggle('lit', on);
        });
      });
    },
  };
}

function activityText(a) {
  const who = a.actor_name || 'النظام';
  const task = a.task_text ? `«${a.task_text.length > 60 ? a.task_text.slice(0, 60) + '…' : a.task_text}»` : '';
  const d = a.details || {};
  const uname = d.username ? isolate('@' + d.username) : 'حساباً';
  switch (a.action) {
    case 'task_created': return [who, ` أضاف مهمة ${task}`];
    case 'task_edited': return [who, ` عدّل مهمة ${task}`];
    case 'task_deleted': return [who, ` حذف مهمة ${task}`];
    case 'task_completed': return [who, ` أنجز ${task}`];
    case 'task_reopened': return [who, ` أعاد فتح ${task}`];
    case 'task_archived': return [who, ` سجّل أرشفة ${task}`];
    case 'task_unarchived': return [who, ` ألغى أرشفة ${task}`];
    case 'task_folder_set': return [who, d.folder_path ? ` حدّد مسار الفولدر لـ ${task}` : ` حذف مسار الفولدر من ${task}`];
    case 'user_created': return [who, ` أنشأ حساب ${uname}`];
    case 'user_updated':
      if (d.old_active !== undefined && d.old_active !== d.active) return [who, d.active ? ` أعاد تفعيل حساب ${uname}` : ` أوقف حساب ${uname}`];
      if (d.old_role && d.old_role !== d.role) return [who, d.role === 'admin' ? ` منح ${uname} صلاحية المدير` : ` جعل ${uname} مستخدماً عادياً`];
      return [who, ` عدّل بيانات ${uname}`];
    case 'user_deleted': return [who, ` حذف حساب ${uname}`];
    case 'password_reset': return [who, ` أعاد تعيين كلمة مرور ${uname}`];
    case 'password_changed': return [who, ' غيّر كلمة المرور'];
    default: return [who, ' قام بإجراء'];
  }
}
const ACT_ICON = {
  task_created: ['plus', 'accent'], task_edited: ['edit', 'accent'], task_deleted: ['trash', 'danger'],
  task_completed: ['check', 'ok'], task_reopened: ['reopen', 'warn'], user_created: ['user', 'accent'],
  task_archived: ['archive', 'ok'], task_unarchived: ['archive', 'warn'], task_folder_set: ['folder', 'accent'],
  user_updated: ['shield', 'accent'], user_deleted: ['trash', 'danger'], password_reset: ['key', 'warn'], password_changed: ['lock', 'ok'],
};

function activityRow(a, i, enter) {
  const [ic, tone] = ACT_ICON[a.action] || ['clock', 'accent'];
  const [who, rest] = activityText(a);
  const d = a.details || {};
  let extra = null;
  if (a.action === 'task_reopened' && d.previous_completed_at) {
    extra = h('p', { class: 'act-extra' }, `كانت منجزة بواسطة ${d.previous_completed_by_name || '—'} · ${isolate(fmtDate(d.previous_completed_at) + ' ' + fmtTime(d.previous_completed_at))}`);
  } else if (a.action === 'task_unarchived' && d.previous_archived_at) {
    extra = h('p', { class: 'act-extra' }, `كانت مؤرشفة بواسطة ${d.previous_archived_by_name || '—'} · ${isolate(fmtDate(d.previous_archived_at) + ' ' + fmtTime(d.previous_archived_at))}`);
  } else if (a.action === 'task_folder_set' && d.folder_path) {
    extra = h('p', { class: 'act-extra', dir: 'ltr' }, d.folder_path);
  }
  return h('div', { class: 'act' + (enter ? ' enter' : ''), style: enter ? { '--d': Math.min(i, 10) * 30 + 'ms' } : null },
    h('span', { class: 'act-ic ' + tone }, icon(ic)),
    h('div', { class: 'act-body' }, h('p', { class: 'act-text' }, h('b', null, who), rest), extra),
    h('time', { class: 'act-time num' }, fmtTime(a.created_at)));
}

function HomeScreen() {
  let host, pills, mounted = false;
  return {
    add: () => taskEditor(null),
    mount(page) {
      const hr = new Date().getHours();
      pills = h('div', { class: 'greet-pills' });
      page.append(
        h('div', { class: 'greet' }, avatar(S.me, 48),
          h('div', { class: 'greet-text' },
            h('span', { class: 'greet-hi' }, hr < 12 ? 'صباح الخير' : 'مساء الخير'),
            h('span', { class: 'greet-name' }, nameOf(S.me)))),
        pills);
      host = h('div', { class: 'dash' });
      page.append(host);
    },
    update() {
      if (!host) return;
      const total = S.tasks.length;
      const done = S.tasks.filter((t) => t.completed).length;
      const archived = S.tasks.filter((t) => t.archived).length;
      const pending = total - done;
      const activeUsers = S.profiles.filter((p) => p.active).length;
      pills.replaceChildren(
        h('span', { class: 'tag' }, icon('calendar'), isolate(fmtDate(new Date().toISOString()))),
        h('span', { class: 'tag' }, icon('users'), `${activeUsers} نشط`),
        h('span', { class: 'tag' }, icon('archive'), `${archived} مؤرشفة`));
      if (S.status === 'loading' && !S.tasks.length) {
        host.replaceChildren(h('div', { class: 'card sk-hero' }, h('span', { class: 'sk sk-line w45' }), h('span', { class: 'sk sk-ruler' })), skeletonCards(2));
        return;
      }
      if (S.status === 'error' && !S.tasks.length) { host.replaceChildren(errorBlock()); return; }
      const pct = total ? (done / total) * 100 : 0;
      const enter = !mounted && !reducedMotion();

      const g = ruler(pct);
      const num = h('b', null, '0');
      const hero = h('section', { class: 'card hero' + (enter ? ' enter' : '') },
        h('div', { class: 'hero-head' },
          h('div', null,
            h('p', { class: 'hero-title' }, 'نسبة الإنجاز'),
            h('p', { class: 'hero-sub' }, total ? `${done} من ${total} منجزة · ${tasksN(pending)} قيد التنفيذ` : 'أضف مهمة لتبدأ المتابعة')),
          h('div', { class: 'hero-num' }, num, h('span', null, '%'))),
        g.el);

      const stat = (label, value, ic, tone, i, onGo) => {
        const n = h('span', { class: 'stat-num num' }, String(value));
        const el = h('button', { class: 'card stat' + (enter ? ' enter' : ''), type: 'button', onclick: onGo, style: enter ? { '--d': (i + 1) * 50 + 'ms' } : null },
          h('span', { class: 'stat-go', 'aria-hidden': 'true' }, icon('expand')),
          h('span', { class: 'stat-ic ' + tone }, icon(ic)), n, h('span', { class: 'stat-label' }, label));
        if (enter) { n.textContent = '0'; countUp(n, value); } else n.dataset.v = String(value);
        return el;
      };
      const openTasks = (status) => () => { S.filter.status = status; go('tasks'); };
      const grid = h('section', { class: 'stats' },
        stat('إجمالي المهام', total, 'tasks', 'accent', 0, openTasks('all')),
        stat('المكتملة', done, 'check', 'ok', 1, openTasks('done')),
        stat('قيد التنفيذ', pending, 'clock', 'warn', 2, openTasks('pending')),
        stat('المستخدمون النشطون', activeUsers, 'users', 'accent', 3, () => go('users')));

      // who completed what
      const counts = new Map();
      S.tasks.forEach((t) => { if (t.completed && t.completed_by) counts.set(t.completed_by, (counts.get(t.completed_by) || 0) + 1); });
      const leaders = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
      const max = leaders.length ? leaders[0][1] : 1;
      const leaderBox = h('section', { class: 'card section' + (enter ? ' enter' : ''), style: enter ? { '--d': '250ms' } : null },
        h('div', { class: 'section-head' }, h('h2', null, 'الأكثر إنجازاً')),
        leaders.length ? h('div', { class: 'leaders' }, leaders.map(([id, n]) => {
          const p = profileById(id);
          const name = p ? nameOf(p) : (S.tasks.find((t) => t.completed_by === id) || {}).completed_by_name || '—';
          return h('div', { class: 'leader' }, avatar(p || { id, full_name: name }, 34),
            h('div', { class: 'leader-main' }, h('div', { class: 'leader-top' }, h('span', { class: 'leader-name' }, name), h('span', { class: 'leader-n' }, tasksN(n))),
              h('div', { class: 'bar' }, h('span', { style: { width: (n / max) * 100 + '%' } }))));
        })) : h('p', { class: 'muted pad' }, 'ستظهر هنا أسماء من أنجزوا مهاماً.'));

      const recent = S.activity.slice(0, 6);
      const recentBox = h('section', { class: 'card section' + (enter ? ' enter' : ''), style: enter ? { '--d': '300ms' } : null },
        h('div', { class: 'section-head' }, h('h2', null, 'آخر النشاطات'),
          h('button', { class: 'link-btn', type: 'button', onclick: () => go('activity') }, 'عرض الكل')),
        recent.length ? h('div', { class: 'acts' }, recent.map((a) => activityRow(a))) : h('p', { class: 'muted pad' }, 'لا يوجد نشاط بعد.'));

      host.replaceChildren(hero, grid, leaderBox, recentBox);
      g.set(pct, enter);
      if (enter) countUp(num, Math.round(pct), 900); else num.textContent = String(Math.round(pct));
      mounted = true;
    },
  };
}

// ====================================================================== activity
function ActivityScreen() {
  let host, mounted = false;
  return {
    add: null,
    mount(page) {
      page.append(largeTitle(isAdmin() ? 'السجل' : 'سجلي', isAdmin() ? 'كل ما يحدث في التطبيق' : 'المهام التي أنجزتها وتغييرات حسابك'));
      host = h('div');
      page.append(host);
    },
    update() {
      if (!host) return;
      if (S.status === 'loading' && !S.activity.length) { host.replaceChildren(skeletonCards(3)); return; }
      if (S.status === 'error' && !S.activity.length) { host.replaceChildren(errorBlock()); return; }
      if (!S.activity.length) { host.replaceChildren(stateBlock('clock', 'لا يوجد نشاط بعد', 'ستظهر هنا المهام المنجزة وكل التغييرات بترتيب زمني.')); return; }
      const groups = new Map();
      S.activity.forEach((a) => { const k = dayKey(a.created_at); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(a); });
      const enter = !mounted && !reducedMotion();
      let i = 0;
      host.replaceChildren(...[...groups.entries()].map(([k, items]) =>
        h('section', { class: 'day' }, h('h3', { class: 'day-label' }, dayLabel(k)),
          h('div', { class: 'card acts' }, items.map((a) => activityRow(a, i++, enter))))));
      mounted = true;
    },
  };
}

// ====================================================================== users
function inviteText(name, username, password) {
  const url = APP_URL || (location.protocol.startsWith('http') && !/localhost|127\.0\.0\.1/.test(location.hostname) ? location.origin + location.pathname : '');
  return [
    `مرحباً ${name || username}،`,
    `تم إنشاء حسابك في تطبيق «${APP_NAME}».`,
    '',
    'تحميل التطبيق (أندرويد):',
    APK_URL,
    url ? 'أو افتحه من المتصفح:' : null,
    url || null,
    '',
    `اسم المستخدم: ${username}`,
    `كلمة المرور المؤقتة: ${password}`,
    '',
    'سيُطلب منك اختيار كلمة مرور جديدة عند أول تسجيل دخول.',
  ].filter((x) => x !== null).join('\n');
}

function showInvite(name, username, password, title = 'الحساب جاهز') {
  const text = inviteText(name, username, password);
  const pre = h('div', { class: 'invite', dir: 'rtl' }, text);
  const copyBtn = button('نسخ الدعوة', { iconName: 'copy', kind: 'secondary' });
  copyBtn.addEventListener('click', async () => { (await copyText(text)) ? toast('نُسخت الدعوة') : toast('لم يتم النسخ، حدد النص وانسخه يدوياً', 'error'); });
  const shareBtn = button('مشاركة', { iconName: 'share' });
  shareBtn.addEventListener('click', async () => {
    if (navigator.share) { try { await navigator.share({ text }); } catch (_) {} }
    else if (await copyText(text)) toast('نُسخت الدعوة، الصقها في أي محادثة');
  });
  sheet({
    title,
    body: h('div', { class: 'stack' },
      h('div', { class: 'success-badge' }, h('span', { class: 'ok-dot' }, icon('check')), h('p', null, 'أرسل هذه البيانات للمستخدم ليسجّل دخوله.')),
      pre,
      h('p', { class: 'field-hint' }, 'لن تظهر كلمة المرور المؤقتة مرة أخرى بعد إغلاق هذه النافذة.')),
    footer: h('div', { class: 'btn-row' }, copyBtn, shareBtn),
  });
}

function passwordGen(id, label) {
  const f = passwordField({ id, label, autocomplete: 'new-password', hint: '8 أحرف على الأقل. سيغيّرها المستخدم عند أول دخول.' });
  f.input.value = generatePassword();
  f.input.type = 'text';
  f.wrap.querySelector('.eye').replaceChildren(icon('eyeOff'));
  const gen = h('button', { class: 'eye gen', type: 'button', 'aria-label': 'توليد كلمة مرور جديدة', onclick: (e) => { e.preventDefault(); f.input.value = generatePassword(); haptic(); } }, icon('refresh'));
  f.wrap.querySelector('.input-wrap').append(gen);
  return f;
}

function userCreator() {
  const name = field({ id: 'nu-name', label: 'الاسم', placeholder: 'مثال: سارة أحمد', autofocus: true, maxlength: 60 });
  const uname = field({ id: 'nu-user', label: 'اسم المستخدم', dir: 'ltr', placeholder: 'sara', autocomplete: 'off', hint: 'حروف إنجليزية صغيرة وأرقام، ويمكن استخدام . و _ و -', maxlength: 32 });
  uname.input.addEventListener('input', () => { uname.input.value = uname.input.value.toLowerCase().replace(/\s/g, ''); });
  const pw = passwordGen('nu-pass', 'كلمة مرور مؤقتة');
  let role = 'user';
  const roleSeg = segmented([{ value: 'user', label: 'مستخدم' }, { value: 'admin', label: 'مدير' }], role, (v) => { role = v; roleHint.textContent = hintFor(v); });
  const hintFor = (v) => v === 'admin' ? 'تحكّم كامل: المهام والحسابات والسجل.' : 'يرى مهامه وينجزها، ويطّلع على سجله فقط.';
  const roleHint = h('span', { class: 'field-hint' }, hintFor(role));
  const err = h('p', { class: 'form-error', role: 'alert' });
  const save = button('إنشاء الحساب', { block: true });
  const form = h('form', { class: 'stack', novalidate: true }, name.wrap, uname.wrap, pw.wrap,
    h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'نوع الحساب'), roleSeg.el, roleHint), err);
  const s = sheet({ title: 'حساب جديد', body: form, footer: save, tall: true });
  const submit = async (e) => {
    e && e.preventDefault();
    err.textContent = '';
    const u = uname.input.value.trim().toLowerCase();
    if (!/^[a-z0-9._-]{3,32}$/.test(u)) { err.textContent = ERR.invalid_username; uname.input.focus(); return; }
    if (pw.input.value.length < 8) { err.textContent = ERR.weak_password; return; }
    setBusy(save, true);
    try {
      await api.adminCreateUser({ username: u, password: pw.input.value, fullName: name.input.value.trim(), role });
      s.dismiss(false);
      loadAll(true);
      setTimeout(() => showInvite(name.input.value.trim(), u, pw.input.value), 340);
    } catch (ex) { setBusy(save, false); err.textContent = errText(ex); }
  };
  form.addEventListener('submit', submit);
  save.addEventListener('click', submit);
}

function userEditor(p) {
  const self = p.id === S.me.id;
  const completed = S.tasks.filter((t) => t.completed_by === p.id).length;
  const name = field({ id: 'eu-name', label: 'الاسم', value: p.full_name, maxlength: 60 });
  let role = p.role;
  const roleSeg = segmented([{ value: 'user', label: 'مستخدم' }, { value: 'admin', label: 'مدير' }], role, (v) => { role = v; });
  const active = toggleSwitch(p.active, null, 'الحساب مفعّل');
  if (self) { roleSeg.el.classList.add('disabled'); roleSeg.el.querySelectorAll('button').forEach((b) => (b.disabled = true)); active.input.disabled = true; }
  const err = h('p', { class: 'form-error', role: 'alert' });

  const resetBtn = h('button', { class: 'row-btn', type: 'button' }, icon('key'), h('span', null, 'إعادة تعيين كلمة المرور'), icon('chevron', 'row-chev'));
  const delBtn = h('button', { class: 'row-btn danger', type: 'button', disabled: self }, icon('trash'), h('span', null, 'حذف الحساب'));
  const save = button('حفظ', { block: true });

  const body = h('div', { class: 'stack' },
    h('div', { class: 'profile-mini' }, avatar(p, 52), h('div', null,
      h('p', { class: 'pm-name' }, nameOf(p)), h('p', { class: 'pm-user', dir: 'ltr' }, '@' + p.username),
      h('p', { class: 'pm-stat' }, completed ? `أنجز ${tasksN(completed)}` : 'لم ينجز مهام بعد'))),
    name.wrap,
    h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'نوع الحساب'), roleSeg.el),
    h('div', { class: 'row-switch' }, h('div', null, h('p', { class: 'rs-title' }, 'الحساب مفعّل'), h('p', { class: 'field-hint' }, 'الحساب الموقوف لا يستطيع تسجيل الدخول.')), active.el),
    self ? h('p', { class: 'note' }, 'لا يمكنك تغيير نوع حسابك أو إيقافه.') : null,
    err,
    h('div', { class: 'group' }, resetBtn, delBtn));
  const s = sheet({ title: 'تعديل الحساب', body, footer: save, tall: true });

  save.addEventListener('click', async () => {
    setBusy(save, true); err.textContent = '';
    try {
      await api.adminUpdateUser({ id: p.id, fullName: name.input.value.trim(), role, active: active.input.checked });
      toast('حُفظت التغييرات'); s.dismiss(false); loadAll(true);
    } catch (ex) { setBusy(save, false); err.textContent = errText(ex); }
  });
  resetBtn.addEventListener('click', () => {
    const pw = passwordGen('rp-pass', 'كلمة المرور المؤقتة الجديدة');
    const e2 = h('p', { class: 'form-error', role: 'alert' });
    const ok = button('إعادة التعيين', { block: true });
    const s2 = sheet({ title: 'إعادة تعيين كلمة المرور', body: h('div', { class: 'stack' },
      h('p', { class: 'muted' }, `سيُطلب من ${nameOf(p)} اختيار كلمة مرور جديدة عند الدخول بهذه الكلمة المؤقتة.`), pw.wrap, e2), footer: ok });
    ok.addEventListener('click', async () => {
      if (pw.input.value.length < 8) { e2.textContent = ERR.weak_password; return; }
      setBusy(ok, true);
      try {
        await api.adminResetPassword(p.id, pw.input.value);
        s2.dismiss(false);
        setTimeout(() => showInvite(nameOf(p), p.username, pw.input.value, 'كلمة المرور الجديدة'), 340);
      } catch (ex) { setBusy(ok, false); e2.textContent = errText(ex); }
    });
  });
  delBtn.addEventListener('click', async () => {
    const yes = await confirmDialog({ title: `حذف حساب ${nameOf(p)}؟`, message: 'لن يتمكن من تسجيل الدخول مرة أخرى. تبقى المهام التي أنجزها وسجل نشاطه كما هي.', confirmText: 'حذف الحساب', danger: true });
    if (!yes) return;
    try { await api.adminDeleteUser(p.id); toast('حُذف الحساب'); s.dismiss(false); loadAll(true); }
    catch (ex) { err.textContent = errText(ex); }
  });
}

function UsersScreen() {
  let host, sub, mounted = false;
  return {
    add: () => userCreator(),
    mount(page) {
      sub = h('p', { class: 'lt-sub' });
      page.append(h('div', { class: 'large-title' }, h('h1', null, 'المستخدمون'), sub));
      host = h('div');
      page.append(host);
    },
    update() {
      if (!host) return;
      const activeN = S.profiles.filter((p) => p.active).length;
      sub.textContent = S.profiles.length ? `${activeN} نشط من ${S.profiles.length}` : '';
      if (S.status === 'loading' && !S.profiles.length) { host.replaceChildren(skeletonCards(3)); return; }
      if (S.status === 'error' && !S.profiles.length) { host.replaceChildren(errorBlock()); return; }
      if (S.profiles.length <= 1) {
        host.replaceChildren(
          S.profiles.length ? h('div', { class: 'list' }, S.profiles.map((p) => userCard(p, 0, false))) : null,
          stateBlock('users', 'أضف فريقك', 'أنشئ حساباً لكل شخص، ثم شارك معه بيانات الدخول.', button('حساب جديد', { iconName: 'plus', onclick: userCreator })));
        return;
      }
      const enter = !mounted && !reducedMotion();
      const sorted = [...S.profiles].sort((a, b) => (b.active - a.active) || (a.role === 'admin' ? -1 : 0) - (b.role === 'admin' ? -1 : 0) || nameOf(a).localeCompare(nameOf(b), 'ar'));
      host.replaceChildren(h('div', { class: 'list' }, sorted.map((p, i) => userCard(p, i, enter))));
      mounted = true;
    },
  };
}

function userCard(p, i, enter) {
  const n = S.tasks.filter((t) => t.completed_by === p.id).length;
  return h('button', { class: 'card user' + (p.active ? '' : ' off') + (enter ? ' enter' : ''), type: 'button',
    style: enter ? { '--d': Math.min(i, 8) * 40 + 'ms' } : null, onclick: () => userEditor(p) },
  avatar(p, 44),
  h('div', { class: 'user-main' },
    h('div', { class: 'user-top' }, h('span', { class: 'user-name' }, nameOf(p)),
      p.id === S.me.id ? h('span', { class: 'tag' }, 'أنت') : null),
    h('span', { class: 'user-handle', dir: 'ltr' }, '@' + p.username),
    h('div', { class: 'task-tags' },
      h('span', { class: 'tag ' + (p.role === 'admin' ? 'tag-accent' : '') }, p.role === 'admin' ? 'مدير' : 'مستخدم'),
      p.active ? null : h('span', { class: 'tag tag-danger' }, 'موقوف'),
      h('span', { class: 'tag tag-plain' }, n ? `أنجز ${tasksN(n)}` : 'لم ينجز مهام بعد'))),
  icon('chevron', 'row-chev'));
}

// ====================================================================== profile
function openProfile() {
  const p = S.me;
  const mine = S.tasks.filter((t) => t.completed_by === p.id).length;
  const nameF = field({ id: 'pf-name', label: 'الاسم الظاهر', value: p.full_name, maxlength: 60 });
  const saveName = h('button', { class: 'chip-btn', type: 'button' }, 'حفظ');
  nameF.wrap.querySelector('.input').after(saveName);
  nameF.wrap.classList.add('inline-save');
  saveName.addEventListener('click', async (e) => {
    e.preventDefault();
    try { await api.updateMyName(nameF.input.value.trim()); S.me.full_name = nameF.input.value.trim(); toast('حُفظ الاسم'); loadAll(true); pmName.textContent = nameOf(S.me); }
    catch (ex) { toast(errText(ex), 'error'); }
  });
  const theme = segmented([{ value: 'dark', label: 'داكن' }, { value: 'light', label: 'فاتح' }],
    pref('theme', 'dark') === 'light' ? 'light' : 'dark', (v) => { setPref('theme', v); applyTheme(v); }, { id: 'pf-theme' });
  const pwBtn = h('button', { class: 'row-btn', type: 'button' }, icon('lock'), h('span', null, 'تغيير كلمة المرور'), icon('chevron', 'row-chev'));
  const outBtn = h('button', { class: 'row-btn danger', type: 'button' }, icon('logout'), h('span', null, 'تسجيل الخروج'));
  const pmName = h('p', { class: 'pm-name lg' }, nameOf(p));

  const s = sheet({
    title: 'حسابي', tall: true,
    body: h('div', { class: 'stack' },
      h('div', { class: 'profile-hero' }, avatar(p, 72), pmName,
        h('p', { class: 'pm-user', dir: 'ltr' }, '@' + p.username),
        h('div', { class: 'task-tags center' }, h('span', { class: 'tag ' + (p.role === 'admin' ? 'tag-accent' : '') }, p.role === 'admin' ? 'مدير' : 'مستخدم'),
          h('span', { class: 'tag tag-ok' }, mine ? `أنجزت ${tasksN(mine)}` : 'لم تنجز مهام بعد'))),
      nameF.wrap,
      h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'المظهر'), theme.el),
      h('div', { class: 'group' }, pwBtn, outBtn),
      h('p', { class: 'version' }, `${APP_NAME} ${APP_VERSION}`)),
  });
  pwBtn.addEventListener('click', () => {
    let s2;
    const { form } = passwordForm({ forced: false, onDone: () => s2 && s2.dismiss(false) });
    s2 = sheet({ title: 'تغيير كلمة المرور', body: form });
  });
  outBtn.addEventListener('click', async () => {
    const ok = await confirmDialog({ title: 'تسجيل الخروج؟', confirmText: 'تسجيل الخروج', danger: true });
    if (!ok) return;
    s.dismiss(false);
    await signOutNow();
  });
}

const SCREENS = { home: HomeScreen, tasks: TasksScreen, users: UsersScreen, activity: ActivityScreen };

boot();
