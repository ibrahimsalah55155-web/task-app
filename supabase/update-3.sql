-- =====================================================================
--  Update 3: personal tasks, team chat, notifications
--  - A regular user can add a task for themselves only (it is in their name).
--  - Tasks remember whether the admin created them.
--  - Team chat (everyone with an active account).
--  - Notifications: new task for you, someone finished/archived a task, and so on.
--  Paste into Supabase > SQL Editor and press Run once. Safe to run again.
-- =====================================================================

-- ---------------------------------------------------------------- tasks: who created it
alter table public.tasks add column if not exists by_admin boolean not null default true;

create or replace function public.tasks_before_insert()
returns trigger language plpgsql security definer set search_path = public
as $$
begin
  new.by_admin   := public.is_admin();
  new.created_by := auth.uid();
  -- A regular user's task is always their own.
  if not new.by_admin then new.assigned_to := auth.uid(); end if;
  return new;
end $$;

drop trigger if exists tasks_before_insert on public.tasks;
create trigger tasks_before_insert before insert on public.tasks
  for each row execute function public.tasks_before_insert();

drop policy if exists tasks_insert on public.tasks;
create policy tasks_insert on public.tasks for insert to authenticated
  with check (public.is_admin() or (public.is_active_user() and assigned_to = auth.uid()));

-- ---------------------------------------------------------------- team chat
create table if not exists public.messages (
  id         bigint generated always as identity primary key,
  user_id    uuid references public.profiles(id) on delete set null,
  user_name  text not null default '',
  username   text not null default '',
  body       text not null check (length(btrim(body)) between 1 and 2000),
  created_at timestamptz not null default now()
);
create index if not exists messages_created_idx on public.messages (created_at desc);

-- The sender is always the signed-in person; names are copied so chat keeps working
-- even though regular users cannot read other people's accounts.
create or replace function public.messages_before_insert()
returns trigger language plpgsql security definer set search_path = public
as $$
declare me public.profiles := public._me();
begin
  if me.id is null or not me.active then raise exception 'not_allowed'; end if;
  new.user_id    := me.id;
  new.user_name  := public.display_name(me);
  new.username   := me.username;
  new.body       := btrim(new.body);
  new.created_at := now();
  return new;
end $$;

drop trigger if exists messages_before_insert on public.messages;
create trigger messages_before_insert before insert on public.messages
  for each row execute function public.messages_before_insert();

alter table public.messages enable row level security;
drop policy if exists messages_read on public.messages;
create policy messages_read on public.messages for select to authenticated using (public.is_active_user());
drop policy if exists messages_insert on public.messages;
create policy messages_insert on public.messages for insert to authenticated with check (public.is_active_user());
drop policy if exists messages_delete on public.messages;
create policy messages_delete on public.messages for delete to authenticated
  using (public.is_admin() or (public.is_active_user() and user_id = auth.uid()));

revoke all on public.messages from anon;
revoke insert, update, delete on public.messages from authenticated;
grant select, delete on public.messages to authenticated;
grant insert (body) on public.messages to authenticated;

-- ---------------------------------------------------------------- notifications
create table if not exists public.notifications (
  id         bigint generated always as identity primary key,
  user_id    uuid not null references public.profiles(id) on delete cascade,
  kind       text not null,
  title      text not null,
  body       text,
  task_id    bigint,
  created_at timestamptz not null default now(),
  read_at    timestamptz
);
create index if not exists notifications_user_idx on public.notifications (user_id, created_at desc);

alter table public.notifications enable row level security;
drop policy if exists notifications_read on public.notifications;
create policy notifications_read on public.notifications for select to authenticated using (user_id = auth.uid());
revoke all on public.notifications from anon;
revoke insert, update, delete on public.notifications from authenticated;
grant select on public.notifications to authenticated;

create or replace function public.mark_notifications_read(p_ids bigint[] default null)
returns void language sql security definer set search_path = public
as $$
  update public.notifications set read_at = now()
   where user_id = auth.uid() and read_at is null and (p_ids is null or id = any(p_ids));
$$;
revoke all on function public.mark_notifications_read(bigint[]) from public, anon;
grant execute on function public.mark_notifications_read(bigint[]) to authenticated;

-- Internal helpers: send to one person / to every active admin.
create or replace function public._notify(p_user uuid, p_kind text, p_title text, p_body text, p_task bigint)
returns void language sql security definer set search_path = public
as $$
  insert into public.notifications (user_id, kind, title, body, task_id)
  select p.id, p_kind, p_title, left(p_body, 300), p_task
    from public.profiles p where p.id = p_user and p.active;
$$;
create or replace function public._notify_admins(p_except uuid, p_kind text, p_title text, p_body text, p_task bigint)
returns void language sql security definer set search_path = public
as $$
  insert into public.notifications (user_id, kind, title, body, task_id)
  select p.id, p_kind, p_title, left(p_body, 300), p_task
    from public.profiles p where p.active and p.role = 'admin' and p.id is distinct from p_except;
$$;
revoke all on function public._notify(uuid, text, text, text, bigint) from public, anon, authenticated;
revoke all on function public._notify_admins(uuid, text, text, text, bigint) from public, anon, authenticated;

create or replace function public.tasks_notify()
returns trigger language plpgsql security definer set search_path = public
as $$
declare
  me public.profiles := public._me();
  who text := case when me.id is null then 'المدير' else public.display_name(me) end;
begin
  if tg_op = 'INSERT' then
    if new.by_admin then
      if new.assigned_to is not null then
        if new.assigned_to is distinct from me.id then
          perform public._notify(new.assigned_to, 'task_assigned', 'مهمة جديدة لك', new.description, new.id);
        end if;
      else
        insert into public.notifications (user_id, kind, title, body, task_id)
        select p.id, 'task_assigned', 'مهمة جديدة للفريق', left(new.description, 300), new.id
          from public.profiles p where p.active and p.id is distinct from me.id;
      end if;
    else
      perform public._notify_admins(me.id, 'task_self', 'مهمة شخصية جديدة · ' || who, new.description, new.id);
    end if;
    return new;
  end if;

  if new.completed and not old.completed then
    perform public._notify_admins(new.completed_by, 'task_completed', 'تم إنجاز مهمة · ' || coalesce(new.completed_by_name, who), new.description, new.id);
  end if;
  if new.archived and not old.archived then
    perform public._notify_admins(new.archived_by, 'task_archived', 'تمت أرشفة مهمة · ' || coalesce(new.archived_by_name, who), new.description, new.id);
  end if;
  if new.assigned_to is not null and new.assigned_to is distinct from old.assigned_to
     and new.assigned_to is distinct from me.id then
    perform public._notify(new.assigned_to, 'task_assigned', 'مهمة جديدة لك', new.description, new.id);
  end if;
  return new;
end $$;
revoke all on function public.tasks_notify() from public, anon, authenticated;

drop trigger if exists tasks_notify on public.tasks;
create trigger tasks_notify after insert or update on public.tasks
  for each row execute function public.tasks_notify();

-- ---------------------------------------------------------------- live updates
do $$
declare t text;
begin
  foreach t in array array['messages', 'notifications'] loop
    if not exists (select 1 from pg_publication_tables
                   where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;
