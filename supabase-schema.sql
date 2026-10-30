-- Run or rerun this in Supabase SQL Editor to create/update the app tables.
create extension if not exists pgcrypto;

create table if not exists public.user_profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  nickname text not null default '',
  home_address text,
  avg_sleep_minutes integer check (avg_sleep_minutes between 0 and 1440),
  shift_pattern_key text not null default 'four'
    check (shift_pattern_key in ('four', 'three', 'custom')),
  shift_sequence text[] not null default array['주간', '야간', '비번', '휴무'],
  cycle_start_date date not null default current_date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (cardinality(shift_sequence) between 2 and 14),
  check (shift_sequence <@ array['주간', '오후', '야간', '비번', '휴무']::text[])
);

create table if not exists public.shift_times (
  user_id uuid not null references auth.users(id) on delete cascade,
  shift_key text not null check (shift_key in ('day', 'afternoon', 'night')),
  start_time time not null,
  end_time time not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, shift_key)
);

create table if not exists public.shift_overrides (
  user_id uuid not null references auth.users(id) on delete cascade,
  work_date date not null,
  shift_type text not null check (shift_type in ('주간', '오후', '야간', '비번', '휴무')),
  updated_at timestamptz not null default now(),
  primary key (user_id, work_date)
);

create table if not exists public.inbody_records (
  id text primary key default gen_random_uuid()::text,
  user_id uuid not null references auth.users(id) on delete cascade,
  measured_on date not null,
  height_cm numeric(5, 1) not null check (height_cm between 100 and 250),
  weight_kg numeric(5, 1) not null check (weight_kg between 20 and 400),
  skeletal_muscle_kg numeric(5, 1) check (skeletal_muscle_kg between 1 and 150),
  body_fat_percentage numeric(4, 1) check (body_fat_percentage between 1 and 75),
  created_at timestamptz not null default now()
);

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

create index if not exists inbody_records_user_date_idx
  on public.inbody_records (user_id, measured_on desc);

-- No direct table privileges for unauthenticated visitors.
revoke all privileges on table public.user_profiles from anon;
revoke all privileges on table public.shift_times from anon;
revoke all privileges on table public.shift_overrides from anon;
revoke all privileges on table public.inbody_records from anon;
revoke all privileges on table public.sleep_records from anon;

grant select, insert, update, delete on public.user_profiles to authenticated;
grant select, insert, update, delete on public.shift_times to authenticated;
grant select, insert, update, delete on public.shift_overrides to authenticated;
grant select, insert, update, delete on public.inbody_records to authenticated;
grant select, insert, update, delete on public.sleep_records to authenticated;

alter table public.user_profiles enable row level security;
alter table public.shift_times enable row level security;
alter table public.shift_overrides enable row level security;
alter table public.inbody_records enable row level security;
alter table public.sleep_records enable row level security;

drop policy if exists "users manage own profile" on public.user_profiles;
create policy "users manage own profile" on public.user_profiles
  for all to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

drop policy if exists "users manage own shift times" on public.shift_times;
create policy "users manage own shift times" on public.shift_times
  for all to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

drop policy if exists "users manage own shift overrides" on public.shift_overrides;
create policy "users manage own shift overrides" on public.shift_overrides
  for all to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

drop policy if exists "users manage own inbody records" on public.inbody_records;
create policy "users manage own inbody records" on public.inbody_records
  for all to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

drop policy if exists "users manage own sleep records" on public.sleep_records;
create policy "users manage own sleep records" on public.sleep_records
  for all to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);
