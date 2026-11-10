-- =====================================================================
--  Tasks app: database setup for Supabase
--  Paste the whole file into Supabase > SQL Editor and press Run.
--  Safe to run again: it updates functions and policies in place.
-- =====================================================================

create extension if not exists pgcrypto with schema extensions;

-- ---------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------

create table if not exists public.profiles (
  id                   uuid primary key references auth.users(id) on delete cascade,
  username             text not null unique check (username ~ '^[a-z0-9._-]{3,32}$'),
  full_name            text not null default '',
  role                 text not null default 'user' check (role in ('admin', 'user')),
  active               boolean not null default true,
  must_change_password boolean not null default true,
  created_at           timestamptz not null default now()
);

create table if not exists public.tasks (
  id                bigint generated always as identity primary key,
  description       text not null check (length(btrim(description)) between 1 and 2000),
  opened_at         timestamptz not null default now(),   -- creation date/time the admin picks
  assigned_to       uuid references public.profiles(id) on delete set null,   -- null = everyone
  completed         boolean not null default false,
  completed_by      uuid references public.profiles(id) on delete set null,
  completed_by_name text,
  completed_at      timestamptz,
  folder_path       text check (folder_path is null or length(folder_path) <= 500),   -- where the work files live
  archived          boolean not null default false,
  archived_by       uuid references public.profiles(id) on delete set null,
  archived_by_name  text,
  archived_at       timestamptz,
  created_by        uuid default auth.uid() references public.profiles(id) on delete set null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
-- Projects set up before these columns existed get them here.
-- opened_at starts as the original creation time.
do $$
begin
  if not exists (select 1 from information_schema.columns
                 where table_schema = 'public' and table_name = 'tasks' and column_name = 'opened_at') then
    alter table public.tasks add column opened_at timestamptz not null default now();
    update public.tasks set opened_at = created_at;
  end if;
end $$;
alter table public.tasks add column if not exists folder_path text check (folder_path is null or length(folder_path) <= 500);
alter table public.tasks add column if not exists archived boolean not null default false;
alter table public.tasks add column if not exists archived_by uuid references public.profiles(id) on delete set null;
alter table public.tasks add column if not exists archived_by_name text;
alter table public.tasks add column if not exists archived_at timestamptz;

create index if not exists tasks_assigned_idx on public.tasks (assigned_to);
create index if not exists tasks_completed_at_idx on public.tasks (completed_at);

-- History has no foreign keys on purpose: it must outlive deleted tasks and users.
create table if not exists public.activity (
  id         bigint generated always as identity primary key,
  action     text not null,
  task_id    bigint,
  task_text  text,
  actor_id   uuid,
  actor_name text,
  target_id  uuid,
  details    jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists activity_created_idx on public.activity (created_at desc);
create index if not exists activity_actor_idx on public.activity (actor_id);

-- ---------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------

create or replace function public.display_name(p public.profiles)
returns text language sql immutable as
$$ select coalesce(nullif(btrim(p.full_name), ''), p.username) $$;

create or replace function public.is_active_user()
returns boolean language sql stable security definer set search_path = public as
$$ select exists (select 1 from public.profiles where id = auth.uid() and active) $$;

create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = public as
$$ select exists (select 1 from public.profiles where id = auth.uid() and active and role = 'admin') $$;

-- Internal: the only path that creates login accounts. Not callable from the app.
create or replace function public._create_account(
  p_username text, p_password text, p_full_name text, p_role text, p_must_change boolean)
returns uuid
language plpgsql security definer set search_path = public, extensions
as $$
declare
  v_id    uuid := gen_random_uuid();
  v_email text;
begin
  p_username := lower(btrim(p_username));
  if p_username !~ '^[a-z0-9._-]{3,32}$' then raise exception 'invalid_username'; end if;
  if p_role not in ('admin', 'user') then raise exception 'invalid_role'; end if;
  if exists (select 1 from public.profiles where username = p_username) then
    raise exception 'username_taken';
  end if;
  v_email := p_username || '@users.tasks.local';
  if exists (select 1 from auth.users where email = v_email) then
    raise exception 'username_taken';
  end if;

  insert into auth.users (
    instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
    raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
    confirmation_token, recovery_token, email_change_token_new, email_change,
    email_change_token_current, phone_change, phone_change_token, reauthentication_token)
  values (
    '00000000-0000-0000-0000-000000000000', v_id, 'authenticated', 'authenticated',
    v_email, extensions.crypt(p_password, extensions.gen_salt('bf')), now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    jsonb_build_object('username', p_username), now(), now(),
    '', '', '', '', '', '', '', '');

  insert into auth.identities (id, user_id, provider_id, identity_data, provider,
                               last_sign_in_at, created_at, updated_at)
  values (gen_random_uuid(), v_id, v_id::text,
          jsonb_build_object('sub', v_id::text, 'email', v_email, 'email_verified', true),
          'email', now(), now(), now());

  insert into public.profiles (id, username, full_name, role, active, must_change_password)
  values (v_id, p_username, coalesce(btrim(p_full_name), ''), p_role, true, p_must_change);

  return v_id;
end $$;

create or replace function public._me()
returns public.profiles language sql stable security definer set search_path = public as
$$ select * from public.profiles where id = auth.uid() $$;

-- ---------------------------------------------------------------------
-- History triggers
-- ---------------------------------------------------------------------

create or replace function public.tasks_touch()
returns trigger language plpgsql as
$$ begin new.updated_at := now(); return new; end $$;

create or replace function public.tasks_log()
returns trigger language plpgsql security definer set search_path = public
as $$
declare
  me public.profiles := public._me();
  who text := case when me.id is null then null else public.display_name(me) end;
begin
  if tg_op = 'INSERT' then
    insert into public.activity (action, task_id, task_text, actor_id, actor_name, details)
    values ('task_created', new.id, new.description, me.id, who,
            jsonb_build_object('assigned_to', new.assigned_to));
    return new;
  elsif tg_op = 'DELETE' then
    insert into public.activity (action, task_id, task_text, actor_id, actor_name, details)
    values ('task_deleted', old.id, old.description, me.id, who,
            jsonb_build_object('was_completed', old.completed,
                               'completed_by', old.completed_by,
                               'completed_by_name', old.completed_by_name,
                               'completed_at', old.completed_at));
    return old;
  end if;

  if new.completed and not old.completed then
    insert into public.activity (action, task_id, task_text, actor_id, actor_name, details)
    values ('task_completed', new.id, new.description, new.completed_by, new.completed_by_name,
            jsonb_build_object('completed_at', new.completed_at));
  elsif old.completed and not new.completed then
    -- Keep the original completion record when a task is reopened.
    insert into public.activity (action, task_id, task_text, actor_id, actor_name, details)
    values ('task_reopened', new.id, new.description, me.id, who,
            jsonb_build_object('previous_completed_by', old.completed_by,
                               'previous_completed_by_name', old.completed_by_name,
                               'previous_completed_at', old.completed_at));
  elsif new.archived and not old.archived then
    insert into public.activity (action, task_id, task_text, actor_id, actor_name, details)
    values ('task_archived', new.id, new.description, new.archived_by, new.archived_by_name,
            jsonb_build_object('archived_at', new.archived_at));
  elsif old.archived and not new.archived then
    insert into public.activity (action, task_id, task_text, actor_id, actor_name, details)
    values ('task_unarchived', new.id, new.description, me.id, who,
            jsonb_build_object('previous_archived_by_name', old.archived_by_name,
                               'previous_archived_at', old.archived_at));
  elsif new.description is distinct from old.description
        or new.assigned_to is distinct from old.assigned_to
        or new.opened_at is distinct from old.opened_at then
    insert into public.activity (action, task_id, task_text, actor_id, actor_name, details)
    values ('task_edited', new.id, new.description, me.id, who,
            jsonb_build_object('old_description', old.description,
                               'old_assigned_to', old.assigned_to,
                               'assigned_to', new.assigned_to,
                               'old_opened_at', old.opened_at,
                               'opened_at', new.opened_at,
                               'old_folder_path', old.folder_path,
                               'folder_path', new.folder_path));
  elsif new.folder_path is distinct from old.folder_path then
    insert into public.activity (action, task_id, task_text, actor_id, actor_name, details)
    values ('task_folder_set', new.id, new.description, me.id, who,
            jsonb_build_object('old_folder_path', old.folder_path, 'folder_path', new.folder_path));
  end if;
  return new;
end $$;

drop trigger if exists tasks_touch on public.tasks;
create trigger tasks_touch before update on public.tasks
  for each row execute function public.tasks_touch();

drop trigger if exists tasks_log on public.tasks;
create trigger tasks_log after insert or update or delete on public.tasks
  for each row execute function public.tasks_log();

-- ---------------------------------------------------------------------
-- Row level security (enforced by the server for every request)
-- ---------------------------------------------------------------------

alter table public.profiles enable row level security;
alter table public.tasks    enable row level security;
alter table public.activity enable row level security;

drop policy if exists profiles_read on public.profiles;
create policy profiles_read on public.profiles for select to authenticated
  using (public.is_active_user());

drop policy if exists tasks_read on public.tasks;
create policy tasks_read on public.tasks for select to authenticated
  using (public.is_admin()
         or (public.is_active_user() and (assigned_to is null or assigned_to = auth.uid())));

drop policy if exists tasks_insert on public.tasks;
create policy tasks_insert on public.tasks for insert to authenticated
  with check (public.is_admin());

drop policy if exists tasks_update on public.tasks;
create policy tasks_update on public.tasks for update to authenticated
  using (public.is_admin()) with check (public.is_admin());

drop policy if exists tasks_delete on public.tasks;
create policy tasks_delete on public.tasks for delete to authenticated
  using (public.is_admin());

drop policy if exists activity_read on public.activity;
create policy activity_read on public.activity for select to authenticated
  using (public.is_admin()
         or (public.is_active_user() and (actor_id = auth.uid() or target_id = auth.uid())));

-- Nobody writes profiles or history directly; only the functions below do.
revoke all on public.profiles, public.tasks, public.activity from anon;
revoke insert, update, delete on public.profiles from authenticated;
revoke insert, update, delete on public.activity from authenticated;
-- Admins edit only the task text, its creation date/time and who it is for. Completion fields are
-- set by complete_task / reopen_task, so nobody can sign a task as someone else.
revoke insert, update on public.tasks from authenticated;
grant select, delete on public.tasks to authenticated;
grant insert (description, assigned_to, opened_at, folder_path) on public.tasks to authenticated;
grant update (description, assigned_to, opened_at, folder_path) on public.tasks to authenticated;
grant select on public.profiles, public.activity to authenticated;

-- ---------------------------------------------------------------------
-- App functions
-- ---------------------------------------------------------------------

create or replace function public.complete_task(p_task_id bigint)
returns public.tasks
language plpgsql security definer set search_path = public
as $$
declare
  me public.profiles := public._me();
  t  public.tasks;
begin
  if me.id is null or not me.active then raise exception 'not_allowed'; end if;
  select * into t from public.tasks where id = p_task_id for update;
  if t.id is null then raise exception 'task_not_found'; end if;
  if me.role <> 'admin' and t.assigned_to is not null and t.assigned_to <> me.id then
    raise exception 'not_allowed';
  end if;
  if t.completed then raise exception 'already_completed'; end if;

  update public.tasks
     set completed = true, completed_by = me.id,
         completed_by_name = public.display_name(me), completed_at = now()
   where id = p_task_id
  returning * into t;
  return t;
end $$;

create or replace function public.reopen_task(p_task_id bigint)
returns public.tasks
language plpgsql security definer set search_path = public
as $$
declare
  me public.profiles := public._me();
  t  public.tasks;
begin
  if me.id is null or not me.active then raise exception 'not_allowed'; end if;
  select * into t from public.tasks where id = p_task_id for update;
  if t.id is null then raise exception 'task_not_found'; end if;
  if not t.completed then return t; end if;
  if me.role <> 'admin' and t.completed_by is distinct from me.id then
    raise exception 'not_allowed';
  end if;

  update public.tasks
     set completed = false, completed_by = null, completed_by_name = null, completed_at = null
   where id = p_task_id
  returning * into t;
  return t;
end $$;

-- Anyone who can work on a task can tick "archived" and record where its files are.
create or replace function public.set_task_archived(p_task_id bigint, p_archived boolean)
returns public.tasks
language plpgsql security definer set search_path = public
as $$
declare
  me public.profiles := public._me();
  t  public.tasks;
begin
  if me.id is null or not me.active then raise exception 'not_allowed'; end if;
  select * into t from public.tasks where id = p_task_id for update;
  if t.id is null then raise exception 'task_not_found'; end if;
  if me.role <> 'admin' and t.assigned_to is not null and t.assigned_to <> me.id then
    raise exception 'not_allowed';
  end if;
  if p_archived then
    if t.archived then raise exception 'already_archived'; end if;
    update public.tasks
       set archived = true, archived_by = me.id,
           archived_by_name = public.display_name(me), archived_at = now()
     where id = p_task_id returning * into t;
  else
    if not t.archived then return t; end if;
    if me.role <> 'admin' and t.archived_by is distinct from me.id then raise exception 'not_allowed'; end if;
    update public.tasks
       set archived = false, archived_by = null, archived_by_name = null, archived_at = null
     where id = p_task_id returning * into t;
  end if;
  return t;
end $$;

create or replace function public.set_task_folder(p_task_id bigint, p_path text)
returns public.tasks
language plpgsql security definer set search_path = public
as $$
declare
  me public.profiles := public._me();
  t  public.tasks;
begin
  if me.id is null or not me.active then raise exception 'not_allowed'; end if;
  select * into t from public.tasks where id = p_task_id for update;
  if t.id is null then raise exception 'task_not_found'; end if;
  if me.role <> 'admin' and t.assigned_to is not null and t.assigned_to <> me.id then
    raise exception 'not_allowed';
  end if;
  p_path := nullif(btrim(coalesce(p_path, '')), '');
  if length(p_path) > 500 then raise exception 'path_too_long'; end if;
  update public.tasks set folder_path = p_path where id = p_task_id returning * into t;
  return t;
end $$;

create or replace function public.change_my_password(p_current text, p_new text)
returns void
language plpgsql security definer set search_path = public, extensions
as $$
declare
  me public.profiles := public._me();
  v_hash text;
begin
  if me.id is null or not me.active then raise exception 'not_allowed'; end if;
  if length(coalesce(p_new, '')) < 8 then raise exception 'weak_password'; end if;
  if p_new = p_current then raise exception 'same_password'; end if;
  select encrypted_password into v_hash from auth.users where id = me.id;
  if v_hash is null or extensions.crypt(p_current, v_hash) <> v_hash then
    raise exception 'wrong_password';
  end if;
  update auth.users
     set encrypted_password = extensions.crypt(p_new, extensions.gen_salt('bf')), updated_at = now()
   where id = me.id;
  update public.profiles set must_change_password = false where id = me.id;
  insert into public.activity (action, actor_id, actor_name, target_id)
  values ('password_changed', me.id, public.display_name(me), me.id);
end $$;

create or replace function public.update_my_name(p_full_name text)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  if not public.is_active_user() then raise exception 'not_allowed'; end if;
  update public.profiles set full_name = left(btrim(coalesce(p_full_name, '')), 60)
   where id = auth.uid();
end $$;

-- ----- Admin only -----

create or replace function public.admin_create_user(
  p_username text, p_password text, p_full_name text, p_role text default 'user')
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  me public.profiles := public._me();
  v_id uuid;
begin
  if not public.is_admin() then raise exception 'not_allowed'; end if;
  if length(coalesce(p_password, '')) < 8 then raise exception 'weak_password'; end if;
  v_id := public._create_account(p_username, p_password, p_full_name, p_role, true);
  insert into public.activity (action, actor_id, actor_name, target_id, details)
  values ('user_created', me.id, public.display_name(me), v_id,
          jsonb_build_object('username', lower(btrim(p_username)), 'role', p_role));
  return v_id;
end $$;

create or replace function public.admin_update_user(
  p_id uuid, p_full_name text, p_role text, p_active boolean)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  me public.profiles := public._me();
  target public.profiles;
begin
  if not public.is_admin() then raise exception 'not_allowed'; end if;
  select * into target from public.profiles where id = p_id;
  if target.id is null then raise exception 'user_not_found'; end if;
  if p_role not in ('admin', 'user') then raise exception 'invalid_role'; end if;
  if p_id = me.id and (p_role <> 'admin' or not p_active) then
    raise exception 'cannot_change_self';
  end if;

  update public.profiles
     set full_name = left(btrim(coalesce(p_full_name, '')), 60), role = p_role, active = p_active
   where id = p_id;

  -- A deactivated account cannot sign in, and its open sessions end.
  update auth.users
     set banned_until = case when p_active then null else now() + interval '100 years' end,
         updated_at = now()
   where id = p_id;
  if not p_active then
    delete from auth.sessions where user_id = p_id;
  end if;

  insert into public.activity (action, actor_id, actor_name, target_id, details)
  values ('user_updated', me.id, public.display_name(me), p_id,
          jsonb_build_object('username', target.username,
                             'role', p_role, 'active', p_active,
                             'old_role', target.role, 'old_active', target.active));
end $$;

create or replace function public.admin_reset_password(p_id uuid, p_password text)
returns void
language plpgsql security definer set search_path = public, extensions
as $$
declare
  me public.profiles := public._me();
  target public.profiles;
begin
  if not public.is_admin() then raise exception 'not_allowed'; end if;
  if length(coalesce(p_password, '')) < 8 then raise exception 'weak_password'; end if;
  select * into target from public.profiles where id = p_id;
  if target.id is null then raise exception 'user_not_found'; end if;
  update auth.users
     set encrypted_password = extensions.crypt(p_password, extensions.gen_salt('bf')), updated_at = now()
   where id = p_id;
  update public.profiles set must_change_password = true where id = p_id;
  delete from auth.sessions where user_id = p_id and p_id <> me.id;
  insert into public.activity (action, actor_id, actor_name, target_id, details)
  values ('password_reset', me.id, public.display_name(me), p_id,
          jsonb_build_object('username', target.username));
end $$;

create or replace function public.admin_delete_user(p_id uuid)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  me public.profiles := public._me();
  target public.profiles;
begin
  if not public.is_admin() then raise exception 'not_allowed'; end if;
  if p_id = me.id then raise exception 'cannot_change_self'; end if;
  select * into target from public.profiles where id = p_id;
  if target.id is null then raise exception 'user_not_found'; end if;
  insert into public.activity (action, actor_id, actor_name, target_id, details)
  values ('user_deleted', me.id, public.display_name(me), p_id,
          jsonb_build_object('username', target.username, 'full_name', target.full_name));
  delete from auth.users where id = p_id;   -- removes the profile too
end $$;

-- Who may call what
revoke all on function public._create_account(text, text, text, text, boolean) from public, anon, authenticated;
revoke all on function public._me() from public, anon;
revoke all on function public.tasks_log() from public, anon, authenticated;
revoke all on function public.complete_task(bigint)                 from public, anon;
revoke all on function public.reopen_task(bigint)                   from public, anon;
revoke all on function public.change_my_password(text, text)        from public, anon;
revoke all on function public.set_task_archived(bigint, boolean)     from public, anon;
revoke all on function public.set_task_folder(bigint, text)          from public, anon;
revoke all on function public.update_my_name(text)                  from public, anon;
revoke all on function public.admin_create_user(text, text, text, text) from public, anon;
revoke all on function public.admin_update_user(uuid, text, text, boolean) from public, anon;
revoke all on function public.admin_reset_password(uuid, text)      from public, anon;
revoke all on function public.admin_delete_user(uuid)               from public, anon;
grant execute on function public._me(), public.is_admin(), public.is_active_user(),
  public.complete_task(bigint), public.reopen_task(bigint),
  public.set_task_archived(bigint, boolean), public.set_task_folder(bigint, text),
  public.change_my_password(text, text), public.update_my_name(text),
  public.admin_create_user(text, text, text, text),
  public.admin_update_user(uuid, text, text, boolean),
  public.admin_reset_password(uuid, text), public.admin_delete_user(uuid)
  to authenticated;

-- ---------------------------------------------------------------------
-- Live updates across devices
-- ---------------------------------------------------------------------

do $$
declare t text;
begin
  foreach t in array array['tasks', 'profiles', 'activity'] loop
    if not exists (select 1 from pg_publication_tables
                   where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;

-- ---------------------------------------------------------------------
-- First administrator: username admin, password admin.
-- The app forces a new password on first sign-in.
-- ---------------------------------------------------------------------

do $$
begin
  if not exists (select 1 from public.profiles where role = 'admin') then
    perform public._create_account('admin', 'admin', 'المدير', 'admin', true);
  end if;
end $$;
