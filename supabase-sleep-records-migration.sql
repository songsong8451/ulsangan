-- Run this in the Supabase SQL Editor to enable secure sleep-record sync.
-- Safe to run after supabase-schema.sql; all changes are idempotent.

alter table public.user_profiles
  add column if not exists nickname_is_custom boolean not null default false;

revoke all privileges on table public.user_profiles from anon;
grant select, insert, update, delete on public.user_profiles to authenticated;
alter table public.user_profiles enable row level security;

drop policy if exists "users manage own profile" on public.user_profiles;
create policy "users manage own profile" on public.user_profiles
  for all to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create table if not exists public.sleep_records (
  user_id uuid not null references auth.users(id) on delete cascade,
  sleep_date date not null,
  sleep_minutes integer not null check (sleep_minutes between 0 and 1440),
  satisfaction_score smallint not null check (satisfaction_score between 1 and 10),
  wake_fatigue_score smallint not null check (wake_fatigue_score between 1 and 10),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, sleep_date)
);

revoke all privileges on table public.sleep_records from anon;
grant select, insert, update, delete on public.sleep_records to authenticated;
alter table public.sleep_records enable row level security;

drop policy if exists "users manage own sleep records" on public.sleep_records;
create policy "users manage own sleep records" on public.sleep_records
  for all to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);
