-- 이탈방지·복귀유도 엔진 관리자 대시보드용 설정. Supabase SQL Editor에서 supabase-schema.sql 다음에 실행하세요.
-- 여러 번 실행해도 안전합니다. service_role 키 없이 동작합니다:
-- 앱은 로그인 사용자 본인의 요약 상태만 user_retention에 저장하고,
-- 관리자는 자기 로그인 토큰으로 조회하며 아래 정책이 app_admins 명단에게만 전체 읽기를 허용합니다.
-- 원본 기록(수면·운동)은 기존 테이블·기기 저장소를 그대로 쓰고, 여기에는 계산 결과 요약만 둡니다.

-- 1) 관리자 명단
create table if not exists public.app_admins (
  user_id uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);
revoke all privileges on table public.app_admins from anon, authenticated;
alter table public.app_admins enable row level security;

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from public.app_admins where user_id = (select auth.uid()));
$$;
revoke all on function public.is_admin() from public, anon;
grant execute on function public.is_admin() to authenticated;

-- 2) 사용자별 이탈방지 요약(앱이 엔진 실행 뒤 본인 행만 upsert)
create table if not exists public.user_retention (
  user_id uuid primary key references auth.users(id) on delete cascade,
  state text not null check (state in ('active', 'watch', 'dormant', 'returning')),
  risk_score smallint not null default 0 check (risk_score between 0 and 100),
  risk_signals text[] not null default '{}',
  last_active_at timestamptz,
  state_changed_at timestamptz,
  dormant_since timestamptz,
  return_started_at timestamptz,
  points_total integer not null default 0,
  week_checkins smallint not null default 0,
  multiplier numeric(3, 2) not null default 1,
  nudge_stats jsonb not null default '{}'::jsonb,
  returns smallint not null default 0,
  return_completes smallint not null default 0,
  capped_entries smallint not null default 0,
  updated_at timestamptz not null default now()
);
revoke all privileges on table public.user_retention from anon;
grant select, insert, update on public.user_retention to authenticated;
alter table public.user_retention enable row level security;

drop policy if exists "users write own retention" on public.user_retention;
create policy "users write own retention" on public.user_retention
  for insert to authenticated
  with check ((select auth.uid()) = user_id);

drop policy if exists "users update own retention" on public.user_retention;
create policy "users update own retention" on public.user_retention
  for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

drop policy if exists "users or admins read retention" on public.user_retention;
create policy "users or admins read retention" on public.user_retention
  for select to authenticated
  using ((select auth.uid()) = user_id or (select public.is_admin()));

-- 3) 관리자는 닉네임 표시를 위해 프로필을 읽을 수 있음(기존 "본인 것만" 정책과 OR)
drop policy if exists "admins read all profiles" on public.user_profiles;
create policy "admins read all profiles" on public.user_profiles
  for select to authenticated using ((select public.is_admin()));

-- 4) 가입일은 관리자에게만 이 함수로
create or replace function public.admin_user_accounts()
returns table (user_id uuid, email text, created_at timestamptz, last_sign_in_at timestamptz)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not public.is_admin() then
    raise exception 'admin only' using errcode = '42501';
  end if;
  return query
    select u.id, u.email::text, u.created_at, u.last_sign_in_at
    from auth.users u
    where u.deleted_at is null;
end;
$$;
revoke all on function public.admin_user_accounts() from public, anon;
grant execute on function public.admin_user_accounts() to authenticated;

-- 5) 관리자 등록: 카카오로 한 번 로그인한 뒤, 이메일을 본인 것으로 바꿔 실행하세요.
-- insert into public.app_admins (user_id)
-- select id from auth.users where email = '관리자-이메일@example.com'
-- on conflict do nothing;
