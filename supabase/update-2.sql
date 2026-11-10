-- =====================================================================
--  Update 2: staff privacy
--  A regular user can read only their own account details; admins see all.
--  Paste into Supabase > SQL Editor and press Run once. Safe to run again.
-- =====================================================================

-- Staff privacy: a regular user sees only their own account; admins see everyone.
-- (Who completed or archived a task is still shown on the task itself.)
drop policy if exists profiles_read on public.profiles;
create policy profiles_read on public.profiles for select to authenticated
  using (public.is_admin() or (id = auth.uid() and public.is_active_user()));
