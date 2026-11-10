-- Minimal stand-in for a fresh Supabase project, for local testing only.
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
end $$;
create schema extensions;
create extension pgcrypto with schema extensions;
create schema auth;
grant usage on schema auth to anon, authenticated;
grant usage on schema public to anon, authenticated;
grant usage on schema extensions to anon, authenticated;

create table auth.users (
  instance_id uuid, id uuid primary key, aud varchar(255), role varchar(255),
  email varchar(255), encrypted_password varchar(255), email_confirmed_at timestamptz,
  invited_at timestamptz, confirmation_token varchar(255), confirmation_sent_at timestamptz,
  recovery_token varchar(255), recovery_sent_at timestamptz, email_change_token_new varchar(255),
  email_change varchar(255), email_change_sent_at timestamptz, last_sign_in_at timestamptz,
  raw_app_meta_data jsonb, raw_user_meta_data jsonb, is_super_admin boolean,
  created_at timestamptz, updated_at timestamptz, phone text unique default null,
  phone_confirmed_at timestamptz, phone_change text default '', phone_change_token varchar(255) default '',
  phone_change_sent_at timestamptz, email_change_token_current varchar(255) default '',
  email_change_confirm_status smallint default 0, banned_until timestamptz,
  reauthentication_token varchar(255) default '', reauthentication_sent_at timestamptz,
  is_sso_user boolean not null default false, deleted_at timestamptz, is_anonymous boolean not null default false
);
create table auth.identities (
  provider_id text not null, user_id uuid not null references auth.users(id) on delete cascade,
  identity_data jsonb not null, provider text not null, last_sign_in_at timestamptz,
  created_at timestamptz, updated_at timestamptz,
  email text generated always as (lower(identity_data->>'email')) stored,
  id uuid primary key default gen_random_uuid(), unique (provider_id, provider)
);
create table auth.sessions (id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade, created_at timestamptz default now());

create function auth.uid() returns uuid language sql stable as
$$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
grant execute on function auth.uid() to anon, authenticated;

-- Supabase grants table access to the API roles by default; RLS does the real gating.
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;

create publication supabase_realtime;
