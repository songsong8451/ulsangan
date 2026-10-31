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
  nap_minutes integer check (nap_minutes between 0 and 1440),
  satisfaction_score smallint not null check (satisfaction_score between 1 and 10),
  wake_fatigue_score smallint not null check (wake_fatigue_score between 1 and 10),
  latency_min integer check (latency_min between 0 and 1440),
  waso_min integer check (waso_min between 0 and 1440),
  awakenings smallint check (awakenings between 0 and 100),
  in_bed_minutes integer check (in_bed_minutes between 1 and 1440),
  sleep_start time,
  sleep_start_at timestamptz,
  sleep_end_at timestamptz,
  total_minutes integer check (total_minutes between 0 and 1440),
  naps jsonb not null default '[]'::jsonb,
  shift_type text check (shift_type in ('day', 'evening', 'night', 'off')),
  prev_shift_end timestamptz,
  next_shift_start timestamptz,
  first_off_after_nights boolean not null default false,
  efficiency_pct numeric(5, 2) check (efficiency_pct between 0 and 100),
  score jsonb,
  feedback jsonb,
  shift_before text check (shift_before in ('주간', '오후', '야간', '비번', '휴무')),
  source text not null default 'self' check (source in ('self', 'wearable')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, sleep_date)
);

alter table public.sleep_records add column if not exists nap_minutes integer check (nap_minutes between 0 and 1440);
alter table public.sleep_records add column if not exists latency_min integer check (latency_min between 0 and 1440);
alter table public.sleep_records add column if not exists waso_min integer check (waso_min between 0 and 1440);
alter table public.sleep_records add column if not exists awakenings smallint check (awakenings between 0 and 100);
alter table public.sleep_records add column if not exists in_bed_minutes integer check (in_bed_minutes between 1 and 1440);
alter table public.sleep_records add column if not exists sleep_start time;
alter table public.sleep_records add column if not exists sleep_start_at timestamptz;
alter table public.sleep_records add column if not exists sleep_end_at timestamptz;
alter table public.sleep_records add column if not exists total_minutes integer check (total_minutes between 0 and 1440);
alter table public.sleep_records add column if not exists naps jsonb not null default '[]'::jsonb;
alter table public.sleep_records add column if not exists shift_type text check (shift_type in ('day', 'evening', 'night', 'off'));
alter table public.sleep_records add column if not exists prev_shift_end timestamptz;
alter table public.sleep_records add column if not exists next_shift_start timestamptz;
alter table public.sleep_records add column if not exists first_off_after_nights boolean not null default false;
alter table public.sleep_records add column if not exists efficiency_pct numeric(5, 2) check (efficiency_pct between 0 and 100);
alter table public.sleep_records add column if not exists score jsonb;
alter table public.sleep_records add column if not exists feedback jsonb;
alter table public.sleep_records add column if not exists shift_before text check (shift_before in ('주간', '오후', '야간', '비번', '휴무'));
alter table public.sleep_records add column if not exists source text not null default 'self' check (source in ('self', 'wearable'));

revoke all privileges on table public.sleep_records from anon;
grant select, insert, update, delete on public.sleep_records to authenticated;
alter table public.sleep_records enable row level security;

drop policy if exists "users manage own sleep records" on public.sleep_records;
create policy "users manage own sleep records" on public.sleep_records
  for all to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);
