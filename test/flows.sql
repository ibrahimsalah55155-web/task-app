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
