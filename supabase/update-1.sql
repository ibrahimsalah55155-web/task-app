-- =====================================================================
--  Update 1: task creation date/time, work folder path, archive tick
--  For projects that already ran setup.sql. Paste into Supabase > SQL Editor
--  and press Run once. Safe to run again.
-- =====================================================================

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

-- History records archive ticks, folder changes and date changes.
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

revoke update on public.tasks from authenticated;
revoke insert on public.tasks from authenticated;
grant insert (description, assigned_to, opened_at, folder_path) on public.tasks to authenticated;
grant update (description, assigned_to, opened_at, folder_path) on public.tasks to authenticated;
revoke all on function public.set_task_archived(bigint, boolean) from public, anon;
revoke all on function public.set_task_folder(bigint, text)      from public, anon;
grant execute on function public.set_task_archived(bigint, boolean), public.set_task_folder(bigint, text) to authenticated;
