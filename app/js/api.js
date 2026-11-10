import { SUPABASE_URL, SUPABASE_KEY, USER_EMAIL_DOMAIN } from './config.js';

const KNOWN = new Set([
  'not_allowed', 'task_not_found', 'already_completed', 'weak_password', 'same_password',
  'wrong_password', 'username_taken', 'invalid_username', 'invalid_role',
  'cannot_change_self', 'user_not_found', 'already_archived', 'path_too_long',
]);

export function toError(e) {
  if (e && e.code && KNOWN.has(e.code)) return e;
  const msg = (e && (e.message || e.error_description || e.msg)) || String(e || '');
  let code = 'unknown';
  if (KNOWN.has(msg.trim())) code = msg.trim();
  else if (/invalid login credentials/i.test(msg)) code = 'invalid_credentials';
  else if (/banned/i.test(msg)) code = 'banned';
  else if (/failed to fetch|network|load failed|fetch failed|timeout/i.test(msg)) code = 'network';
  else if (/jwt|refresh token|not authenticated|session/i.test(msg)) code = 'session';
  const err = new Error(msg);
  err.code = code;
  return err;
}

async function run(promise) {
  let res;
  try { res = await promise; } catch (e) { throw toError(e); }
  if (res && res.error) throw toError(res.error);
  return res ? res.data : undefined;
}

const taskRow = (f) => ({
  description: f.description,
  assigned_to: f.assignedTo || null,
  opened_at: f.openedAt || new Date().toISOString(),
  folder_path: (f.folderPath || '').trim() || null,
});

export const usernameToEmail = (u) => `${String(u).trim().toLowerCase()}@${USER_EMAIL_DOMAIN}`;

export function createApi() {
  const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, storageKey: 'injaz-auth' },
    realtime: { params: { eventsPerSecond: 10 } },
  });

  return {
    async getSession() {
      const data = await run(sb.auth.getSession());
      return data.session || null;
    },
    onAuthChange(cb) {
      const { data } = sb.auth.onAuthStateChange((event, session) => cb(event, session));
      return () => data.subscription.unsubscribe();
    },
    async signIn(username, password) {
      const data = await run(sb.auth.signInWithPassword({ email: usernameToEmail(username), password }));
      return data.session;
    },
    async signOut() {
      try { await sb.auth.signOut({ scope: 'local' }); } catch (_) { /* already signed out */ }
    },
    async myProfile() {
      const data = await run(sb.rpc('_me'));
      const p = Array.isArray(data) ? data[0] : data;
      return p && p.id ? p : null;
    },
    listTasks: () => run(sb.from('tasks').select('*').order('created_at', { ascending: false })),
    listProfiles: () => run(sb.from('profiles').select('*').order('created_at', { ascending: true })),
    listActivity: (limit = 300) =>
      run(sb.from('activity').select('*').order('created_at', { ascending: false }).limit(limit)),

    // fields: { description, assignedTo, openedAt (ISO), folderPath }
    createTask: (f) => run(sb.from('tasks').insert(taskRow(f)).select().single()),
    updateTask: (id, f) => run(sb.from('tasks').update(taskRow(f)).eq('id', id).select().single()),
    setTaskArchived: (id, archived) => run(sb.rpc('set_task_archived', { p_task_id: id, p_archived: archived })),
    setTaskFolder: (id, path) => run(sb.rpc('set_task_folder', { p_task_id: id, p_path: path })),
    deleteTask: (id) => run(sb.from('tasks').delete().eq('id', id)),
    completeTask: (id) => run(sb.rpc('complete_task', { p_task_id: id })),
    reopenTask: (id) => run(sb.rpc('reopen_task', { p_task_id: id })),

    changeMyPassword: (current, next) => run(sb.rpc('change_my_password', { p_current: current, p_new: next })),
    updateMyName: (name) => run(sb.rpc('update_my_name', { p_full_name: name })),

    adminCreateUser: ({ username, password, fullName, role }) =>
      run(sb.rpc('admin_create_user', { p_username: username, p_password: password, p_full_name: fullName, p_role: role })),
    adminUpdateUser: ({ id, fullName, role, active }) =>
      run(sb.rpc('admin_update_user', { p_id: id, p_full_name: fullName, p_role: role, p_active: active })),
    adminResetPassword: (id, password) => run(sb.rpc('admin_reset_password', { p_id: id, p_password: password })),
    adminDeleteUser: (id) => run(sb.rpc('admin_delete_user', { p_id: id })),

    subscribe(onChange) {
      const ch = sb.channel('injaz-live');
      for (const table of ['tasks', 'profiles', 'activity']) {
        ch.on('postgres_changes', { event: '*', schema: 'public', table }, (p) => onChange(table, p));
      }
      ch.subscribe();
      return () => { try { sb.removeChannel(ch); } catch (_) {} };
    },
  };
}
