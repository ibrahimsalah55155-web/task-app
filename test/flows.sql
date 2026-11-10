\set ON_ERROR_STOP 0
\set VERBOSITY terse
-- helpers to act as a signed-in user
create or replace function pg_temp.as_user(u text) returns void language plpgsql as $$
begin perform set_config('request.jwt.claim.sub', (select id::text from public.profiles where username = u), false); end $$;

select pg_temp.as_user('admin');
set role authenticated;
select 'admin is_admin' t, public.is_admin();

-- admin/admin login check (crypt matches)
reset role;
select 'seed pw ok' t, extensions.crypt('admin', encrypted_password) = encrypted_password from auth.users where email='admin@users.tasks.local';
set role authenticated;

-- password change
select public.change_my_password('wrong', 'NewPass123');      -- expect wrong_password
select public.change_my_password('admin', 'short');           -- expect weak_password
select public.change_my_password('admin', 'NewPass123');
select 'must_change after' t, must_change_password from public.profiles where username='admin';

-- users
select public.admin_create_user('Sara', 'Temp12345', 'سارة', 'user') is not null as created_sara;
select public.admin_create_user('omar', 'Temp12345', 'عمر', 'user') is not null as created_omar;
select public.admin_create_user('sara', 'Temp12345', 'x', 'user');   -- expect username_taken
select public.admin_create_user('a b', 'Temp12345', 'x', 'user');    -- expect invalid_username

-- tasks
insert into public.tasks (description) values (E'راجع تصميم الصفحة الرئيسية\nوأرسل الملاحظات');
insert into public.tasks (description, assigned_to) values ('مهمة لعمر فقط', (select id from public.profiles where username='omar'));
insert into public.tasks (description, completed, completed_by) values ('hack', true, auth.uid());  -- expect permission denied
select count(*) as tasks_admin_sees from public.tasks;

-- sara: sees only shared task, cannot insert, cannot forge
select pg_temp.as_user('sara');
select 'sara sees' t, count(*) from public.tasks;
insert into public.tasks (description) values ('sara task');       -- expect RLS violation
update public.tasks set completed_by_name = 'admin';                -- expect permission denied
update public.tasks set description = 'changed';                     -- 0 rows (RLS)
select public.complete_task((select id from public.tasks where assigned_to is null));
select public.complete_task((select min(id) from public.tasks where assigned_to is null)); -- expect already_completed
select public.complete_task(2);                                     -- omar's task: expect not_allowed
select 'sara completed' t, completed, completed_by_name, completed_at is not null from public.tasks;
select public.admin_create_user('evil', 'Temp12345', 'x', 'admin'); -- expect not_allowed
select 'sara history' t, action from public.activity order by id;

-- omar reopens sara's task: not allowed
select pg_temp.as_user('omar');
select public.reopen_task(1);        -- expect not_allowed
select 'omar sees' t, count(*) from public.tasks;

-- admin reopens: original record kept in history
select pg_temp.as_user('admin');
select public.reopen_task(1) is not null as reopened;
select 'history' t, action, actor_name, details->>'previous_completed_by_name' as prev from public.activity order by id;

-- deactivate omar
select public.admin_update_user((select id from public.profiles where username='omar'), 'عمر', 'user', false);
select public.admin_update_user(auth.uid(), 'x', 'user', true);   -- expect cannot_change_self
select pg_temp.as_user('omar');
select 'inactive omar sees' t, count(*) from public.tasks;
select public.complete_task(2);                                     -- expect not_allowed

-- anon sees nothing
reset role; select set_config('request.jwt.claim.sub', '', false); set role anon;
select count(*) from public.tasks;                                  -- expect permission denied

-- admin deletes task and user
reset role; select pg_temp.as_user('admin'); set role authenticated;
delete from public.tasks where id = 2;
select public.admin_delete_user((select id from public.profiles where username='omar'));
select 'final' t, action, actor_name from public.activity order by id;
reset role;
select 'auth users left' t, count(*) from auth.users;
select 'banned' t, count(*) from auth.users where banned_until is not null;

-- ===== update 1: dates, folder, archive
reset role; select pg_temp.as_user('admin'); set role authenticated;
insert into public.tasks (description, opened_at, folder_path) values ('dated', '2026-11-01 09:30+02', 'D:\Work\Client\Logo');
update public.tasks set opened_at = '2026-11-02 10:00+02' where description = 'dated';
update public.tasks set archived = true where description = 'dated';                  -- expect permission denied
select pg_temp.as_user('sara');
select (public.set_task_folder((select id from public.tasks where description='dated'), '  \\server\share\job  ')).folder_path as sara_folder;
select (public.set_task_archived((select id from public.tasks where description='dated'), true)).archived_by_name as archived_by;
select public.set_task_archived((select id from public.tasks where description='dated'), true);      -- expect already_archived
reset role; select pg_temp.as_user('admin'); set role authenticated;
select (public.set_task_archived((select id from public.tasks where description='dated'), false)).archived as still_archived;
select 'u1 history' t, action, actor_name from public.activity where task_text = 'dated' order by id;

-- ===== update 2: privacy
reset role; select pg_temp.as_user('sara'); set role authenticated;
select 'sara sees profiles' t, count(*), string_agg(username, ',') from public.profiles;
reset role; select pg_temp.as_user('admin'); set role authenticated;
select 'admin sees profiles' t, count(*) from public.profiles;

-- ===== update 3: personal tasks, chat, notifications
reset role; select pg_temp.as_user('admin'); set role authenticated;
select public.admin_create_user('nour', 'Temp12345', 'نور', 'user') is not null as nour;
insert into public.tasks (description) values ('for everyone u3');
insert into public.tasks (description, assigned_to) values ('for nour u3', (select id from public.profiles where username='nour'));
select pg_temp.as_user('nour');
select 'nour notifs' t, kind, title from public.notifications order by id;
insert into public.tasks (description, assigned_to) values ('nour own', (select id from public.profiles where username='admin'));  -- forced to nour
select 'nour own task' t, assigned_to = auth.uid() as mine, by_admin from public.tasks where description='nour own';
update public.tasks set description='x' where description='nour own';   -- 0 rows (cannot edit)
select (public.complete_task((select id from public.tasks where description='nour own'))).completed as done;
insert into public.messages (body) values ('  أهلاً يا جماعة 👋  ');
insert into public.messages (body, user_name) values ('fake', 'admin');      -- expect permission denied
select 'chat' t, user_name, username, body from public.messages;
select public.mark_notifications_read(null);
select 'nour unread' t, count(*) from public.notifications where read_at is null;
reset role; select pg_temp.as_user('admin'); set role authenticated;
select 'admin notifs' t, kind, title from public.notifications order by id;
select 'admin sees chat' t, count(*) from public.messages;
delete from public.messages;
select 'chat after admin delete' t, count(*) from public.messages;
