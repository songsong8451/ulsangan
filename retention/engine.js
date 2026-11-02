// ShiftFit 이탈방지·복귀유도 엔진 (명세 v1.1 4장). 화면과 저장소를 모르는 순수 함수만 둔다.
// 모든 함수는 now(Date)를 인자로 받고, 상태 r은 복사본을 돌려준다(입력은 바꾸지 않음).
//
// 입력 ctx(사실 정보):
//   activities      : 기존 기록에서 끌어온 활동 [{id,type,occurredAt,shiftType?,meta?}] (운동 완료·수면 기록)
//   shiftOn(dateKey): 그날 근무 'day'|'evening'|'night'|'off'|'rest'
//   workHours       : { day:{start,end}, evening:{...}, night:{...} } ('HH:MM', KST)
//   scheduledWorkouts: [{id, plannedAt, status:'unconfirmed'|'done'|'skipped_silent', remindAt?}]
//   cycleLength, cycleStartKey: 교대 주기(리듬 주 'shift-cycle'용)
//   crewMember      : 크루 소속 여부
// r(UserRetention + 엔진 보조 기록)의 events에는 이 기능이 새로 만드는 활동(컨디션 체크·휴식·이유·응원)만 담는다.

import {
  DEFAULT_CONFIG, ACTIVITY_TYPES, ENGINE_NUDGES, NUDGE_ORDER, NUDGE_COPY, CHEER_TEMPLATES,
} from './constants.js';

const MIN = 60000;
const DAY = 86400000;
const KST = 9 * 3600000;

// ── 날짜 도우미 (KST 기준) ────────────────────────────────
export function dateKey(date) {
  return new Date(new Date(date).getTime() + KST).toISOString().slice(0, 10);
}
export function atKst(key, hhmm = '00:00') {
  return new Date(`${key}T${hhmm}:00+09:00`);
}
export function addDays(key, n) {
  const d = new Date(`${key}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
export function diffDays(fromKey, toKey) {
  return Math.round((Date.parse(`${toKey}T00:00:00Z`) - Date.parse(`${fromKey}T00:00:00Z`)) / DAY);
}
const iso = (d) => new Date(d).toISOString();
const hhmmToMin = (t) => { const [h, m] = String(t).split(':').map(Number); return h * 60 + m; };
const clone = (v) => JSON.parse(JSON.stringify(v));

// ── 초기 상태 ─────────────────────────────────────────────
export function createRetention(now, extra = {}) {
  return {
    version: 1,
    state: 'active',
    riskScore: 0,
    riskSignals: [],
    riskDetail: {},
    lastActiveAt: null,
    stateChangedAt: iso(now),
    signupAt: iso(now),
    watchSince: null,
    dormantSince: null,
    returnStartedAt: null,
    lastReturnBonusAt: null,      // 복귀 배수 생성 시각(30일 쿨다운)
    lastReturnCompleteAt: null,   // 복귀 완료 보너스 지급 시각(30일당 1회)
    returnCompletedAt: null,      // 홈 '복귀 완료' 배지용
    fiveMinPlan: { active: false },
    restartPlan: null,
    settings: {
      rhythmWeek: 'calendar',
      cheerRequestOnRest: true,
      receiveCheers: true,
      engineNudges: true,          // 이탈방지 알림 받기(opt_out 필터용)
      quietHours: null,            // { start:'22:00', end:'07:00' } 사용자 알림 금지 시간
      shareWeeklyCheckin: false,   // 크루에 이번 주 체크인 여부 공개
    },
    events: [],          // 이 기능이 새로 기록하는 활동(ActivityLog)
    scheduleEvents: [],  // { type:'pattern_change'|'override_edit', at }
    multipliers: [],
    ledger: [],
    nudges: [],
    cheers: [],          // 받은 응원 CrewCheer
    seen: {},            // 기존 기록 id → 처음 본 시각(포인트 1회 지급용)
    ...extra,
  };
}

// ── 활동·체크인 ───────────────────────────────────────────
const activityCache = new WeakMap();
export function allActivities(r, ctx) {
  const a = ctx.activities || [], e = r.events || [];
  const hit = activityCache.get(e);
  if (hit && hit.a === a && hit.al === a.length && hit.el === e.length) return hit.list;
  const list = [...a, ...e]
    .filter((x) => ACTIVITY_TYPES.includes(x.type) && x.occurredAt)
    .sort((x, y) => Date.parse(x.occurredAt) - Date.parse(y.occurredAt));
  activityCache.set(e, { a, al: a.length, el: e.length, list });
  return list;
}

export function checkinDays(acts, until) {
  const days = new Set();
  for (const a of acts) if (!until || Date.parse(a.occurredAt) <= until.getTime()) days.add(dateKey(a.occurredAt));
  return days;
}

function lastActivity(acts, now) {
  let last = null;
  for (const a of acts) if (Date.parse(a.occurredAt) <= now.getTime()) last = a;
  return last;
}

export function daysIdle(r, ctx, now) {
  const last = lastActivity(allActivities(r, ctx), now);
  const anchor = last ? last.occurredAt : r.signupAt;
  return Math.max(0, diffDays(dateKey(anchor), dateKey(now)));
}

// ── 근무·수면 시간대 ──────────────────────────────────────
const WORK_SHIFTS = ['day', 'evening', 'night'];

export function workInterval(ctx, key) {
  const type = ctx.shiftOn?.(key);
  if (!WORK_SHIFTS.includes(type)) return null;
  const hours = ctx.workHours?.[type];
  if (!hours?.start || !hours?.end) return null;
  const start = atKst(key, hours.start);
  let end = atKst(key, hours.end);
  if (end <= start) end = new Date(end.getTime() + DAY);
  return { type, start, end };
}

// 예상 수면 구간. 명세가 계산식을 정하지 않아 근무표로 추정한다(보고서 '판단' 항목).
//  - 전날 야간 근무였으면 퇴근 1시간 뒤부터 7시간
//  - 그 외에는 기상 8시간 전부터 기상까지. 기상 = 주간 근무면 출근 90분 전, 아니면 07:00
export function sleepWindows(ctx, key) {
  if (ctx.sleepPlan) return ctx.sleepPlan(key);
  const prevNight = workInterval(ctx, addDays(key, -1));
  if (prevNight?.type === 'night') {
    const start = new Date(prevNight.end.getTime() + 60 * MIN);
    return [{ start, end: new Date(start.getTime() + 7 * 3600000) }];
  }
  const today = workInterval(ctx, key);
  let wake = atKst(key, '07:00');
  if (today?.type === 'day') wake = new Date(Math.min(wake.getTime(), today.start.getTime() - 90 * MIN));
  return [{ start: new Date(wake.getTime() - 8 * 3600000), end: wake }];
}

export function expectedWake(ctx, key) {
  const windows = sleepWindows(ctx, key);
  return windows.length ? windows[windows.length - 1].end : atKst(key, '07:00');
}

// t가 알림 금지 구간이면 이유 문자열, 아니면 null
export function quietReason(t, r, ctx, cfg = DEFAULT_CONFIG) {
  const time = new Date(t).getTime();
  const key = dateKey(t);
  const buffer = cfg.RETENTION.SLEEP_BUFFER_MIN * MIN;
  for (const k of [addDays(key, -1), key, addDays(key, 1)]) {
    const work = workInterval(ctx, k);
    if (work && time >= work.start.getTime() && time < work.end.getTime()) return 'work';
    if (work && time >= work.end.getTime() && time < work.end.getTime() + cfg.RETENTION.POST_SHIFT_QUIET_MIN * MIN) return 'post_shift';
    for (const w of sleepWindows(ctx, k)) {
      if (time >= w.start.getTime() - buffer && time < w.end.getTime() + buffer) return 'sleep';
    }
  }
  const quiet = r.settings?.quietHours;
  if (quiet?.start && quiet?.end) {
    const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(t));
    const m = hhmmToMin(parts), s = hhmmToMin(quiet.start), e = hhmmToMin(quiet.end);
    if (s <= e ? m >= s && m < e : m >= s || m < e) return 'user_quiet';
  }
  return null;
}

// 같은 날 ALLOWED_HOUR_START~END 정각 중 after 이후 첫 허용 시각
export function nextAllowedSameDay(after, r, ctx, cfg = DEFAULT_CONFIG) {
  const key = dateKey(after);
  for (let h = cfg.RETENTION.ALLOWED_HOUR_START; h <= cfg.RETENTION.ALLOWED_HOUR_END; h++) {
    const t = atKst(key, `${String(h).padStart(2, '0')}:00`);
    if (t.getTime() > new Date(after).getTime() && !quietReason(t, r, ctx, cfg)) return t;
  }
  return null;
}

// after 이후(당일 포함 최대 days일) 첫 허용 시각 — 크루 응원 묶음용
export function nextAllowedSlot(after, r, ctx, cfg = DEFAULT_CONFIG, days = 7) {
  const start = new Date(after);
  for (let d = 0; d <= days; d++) {
    const key = addDays(dateKey(start), d);
    for (let h = cfg.RETENTION.ALLOWED_HOUR_START; h <= cfg.RETENTION.ALLOWED_HOUR_END; h++) {
      const t = atKst(key, `${String(h).padStart(2, '0')}:00`);
      if (t.getTime() >= start.getTime() && !quietReason(t, r, ctx, cfg)) return t;
    }
  }
  return null;
}

// ── 4.2 위험 점수 ─────────────────────────────────────────
function maxNightRun(ctx, fromKey, toKey) {
  let best = 0, run = 0;
  for (let k = fromKey; k <= toKey; k = addDays(k, 1)) {
    run = ctx.shiftOn?.(k) === 'night' ? run + 1 : 0;
    best = Math.max(best, run);
  }
  return best;
}

const isOff = (type) => type === 'off' || type === 'rest';

export function computeRisk(r, ctx, now, cfg = DEFAULT_CONFIG) {
  const P = cfg.RISK_SIGNAL_POINTS, R = cfg.RETENTION;
  const acts = allActivities(r, ctx).filter((a) => Date.parse(a.occurredAt) <= now.getTime());
  const days = checkinDays(acts);
  const today = dateKey(now);
  const signals = [];
  const detail = {};
  let score = 0;
  const add = (id, points, info) => {
    if (!points) return;
    signals.push(id);
    detail[id] = { points, ...info };
    score += points;
  };

  // freq_drop: 최근 7일 체크인일 < 직전 28일 주평균의 50%. 직전 구간 데이터가 7일 미만이면 스킵.
  const recent = [...days].filter((k) => diffDays(k, today) >= 0 && diffDays(k, today) < 7).length;
  const prior = [...days].filter((k) => diffDays(k, today) >= 7 && diffDays(k, today) < 35).length;
  const priorCovered = Math.min(28, Math.max(0, diffDays(dateKey(r.signupAt), addDays(today, -7)) + 1));
  if (priorCovered >= 7) {
    const weeklyAvg = (prior / priorCovered) * 7;
    if (weeklyAvg > 0 && recent < weeklyAvg * 0.5) {
      const nightAdjusted = maxNightRun(ctx, addDays(today, -6), today) >= 3;
      add('freq_drop', Math.round(P.freq_drop * (nightAdjusted ? 0.5 : 1)), { recent, weeklyAvg: Math.round(weeklyAvg * 10) / 10, nightAdjusted });
    }
  }

  // off_day_silent: 가장 최근(어제까지) 연속 휴무·비번 2일 모두 활동 없음
  for (let i = 1; i <= 21; i++) {
    const k = addDays(today, -i), prev = addDays(k, -1);
    if (isOff(ctx.shiftOn?.(k)) && isOff(ctx.shiftOn?.(prev))) {
      if (!days.has(k) && !days.has(prev)) add('off_day_silent', P.off_day_silent, { days: [prev, k] });
      break;
    }
  }

  // unconfirmed_pile: 지난 예정 운동 중 미확인 3건 이상(근무 시간과 겹친 것 제외)
  const unconfirmed = (ctx.scheduledWorkouts || []).filter((w) => {
    if (w.status !== 'unconfirmed' || Date.parse(w.plannedAt) > now.getTime()) return false;
    const t = Date.parse(w.plannedAt), k = dateKey(w.plannedAt);
    return ![addDays(k, -1), k].some((d) => { const wi = workInterval(ctx, d); return wi && t >= wi.start.getTime() && t < wi.end.getTime(); });
  });
  if (unconfirmed.length >= 3) add('unconfirmed_pile', P.unconfirmed_pile, { count: unconfirmed.length });

  // tired_streak: 컨디션 체크 직전 3회가 모두 '피곤함'
  const checks = acts.filter((a) => a.type === 'condition_check').slice(-3);
  if (checks.length === 3 && checks.every((a) => a.meta?.level === 'tired')) add('tired_streak', P.tired_streak, {});

  // shift_changed: 최근 7일 패턴 변경 1회 이상 또는 근무 수정 3건 이상
  const recentSchedule = (r.scheduleEvents || []).filter((e) => now.getTime() - Date.parse(e.at) < 7 * DAY && Date.parse(e.at) <= now.getTime());
  const patternChanges = recentSchedule.filter((e) => e.type === 'pattern_change').length;
  const edits = recentSchedule.filter((e) => e.type === 'override_edit').reduce((s, e) => s + (e.count || 1), 0);
  if (patternChanges >= 1 || edits >= 3) add('shift_changed', P.shift_changed, { patternChanges, edits });

  // early_user: 가입 후 3~14일차(가입일 = 1일차)
  const dayNumber = diffDays(dateKey(r.signupAt), today) + 1;
  if (dayNumber >= R.EARLY_USER_FROM_DAY && dayNumber <= R.EARLY_USER_TO_DAY) add('early_user', P.early_user, { dayNumber });

  // nudge_ignored: 최근 발송 3건 연속 무응답(예상 기상 후 1시간 안에 보낸 건 제외)
  const sent = (r.nudges || [])
    .filter((n) => n.sentAt && Date.parse(n.sentAt) <= now.getTime() && !n.silent)
    .filter((n) => {
      const wake = expectedWake(ctx, dateKey(n.sentAt)).getTime(), t = Date.parse(n.sentAt);
      return !(t >= wake && t < wake + R.NUDGE_IGNORE_AFTER_WAKE_MIN * MIN);
    })
    .sort((a, b) => Date.parse(a.sentAt) - Date.parse(b.sentAt))
    .slice(-R.NUDGE_IGNORED_STREAK);
  if (sent.length === R.NUDGE_IGNORED_STREAK && sent.every((n) => !n.respondedAt)) add('nudge_ignored', P.nudge_ignored, {});

  // same_lapse: 같은 미실천 이유가 2회 연속(답하지 않음은 제외)
  const lapses = acts.filter((a) => a.type === 'lapse_reason').slice(-2);
  if (lapses.length === 2 && lapses[0].meta?.reason === lapses[1].meta?.reason && lapses[0].meta?.reason !== 'no_answer') {
    add('same_lapse', P.same_lapse, { reason: lapses[0].meta?.reason });
  }

  return { score: Math.min(100, score), signals, detail };
}

// ── 4.3 상태 전이 ─────────────────────────────────────────
function checkinsSince(acts, sinceIso, now) {
  const startKey = dateKey(sinceIso);
  return new Set(acts
    .filter((a) => Date.parse(a.occurredAt) >= Date.parse(sinceIso) - 1 && Date.parse(a.occurredAt) <= now.getTime())
    .map((a) => dateKey(a.occurredAt))
    .filter((k) => diffDays(startKey, k) >= 0)).size;
}

export function returnCheckins(r, ctx, now) {
  if (!r.returnStartedAt) return 0;
  return checkinsSince(allActivities(r, ctx), r.returnStartedAt, now);
}

export function nextState(r0, ctx, now, cfg = DEFAULT_CONFIG) {
  return applyNextState(clone(r0), ctx, now, cfg);
}

function applyNextState(r, ctx, now, cfg) {
  const R = cfg.RETENTION;
  const acts = allActivities(r, ctx);
  const idle = daysIdle(r, ctx, now);
  const set = (state) => { r.state = state; r.stateChangedAt = iso(now); };

  if ((r.state === 'active' || r.state === 'watch') && idle >= R.DORMANT_AFTER_DAYS) {
    set('dormant');
    r.dormantSince = iso(now);
    r.watchSince = null;
  } else if (r.state === 'active' && r.riskScore >= R.WATCH_THRESHOLD) {
    set('watch');
    r.watchSince = iso(now);
  } else if (r.state === 'watch' && r.riskScore < R.WATCH_THRESHOLD) {
    set('active');
    r.watchSince = null;
  } else if (r.state === 'dormant') {
    const back = acts.find((a) => Date.parse(a.occurredAt) >= Date.parse(r.dormantSince) &&Date.parse(a.occurredAt) <= now.getTime());
    if (back) {
      set('returning');
      r.returnStartedAt = back.occurredAt;
      r.dormantSince = null;
      startReturnMultiplier(r, now, cfg);
    }
  } else if (r.state === 'returning') {
    const n = checkinsSince(acts, r.returnStartedAt, now);
    const withinWindow = now.getTime() - Date.parse(r.returnStartedAt) <= R.RETURN_WINDOW_DAYS * DAY;
    if (n >= R.RETURN_COMPLETE_CHECKINS && withinWindow) {
      set('active');
      grantReturnBonus(r, now, cfg);
    } else if (idle >= R.DORMANT_AFTER_DAYS) {
      set('dormant');
      r.dormantSince = iso(now);
      endMultipliers(r, 'return', now);
    } else if (!withinWindow) {
      set('active');
      endMultipliers(r, 'return', now);
    }
  }
  return r;
}

// ── 4.4 배수 ──────────────────────────────────────────────
function endMultipliers(r, kind, now) {
  for (const m of r.multipliers) if (m.kind === kind && Date.parse(m.endsAt) > now.getTime()) m.endsAt = iso(now);
}

function startReturnMultiplier(r, now, cfg) {
  const R = cfg.RETENTION;
  const last = r.lastReturnBonusAt ? Date.parse(r.lastReturnBonusAt) : null;
  if (last !== null && now.getTime() - last < R.RETURN_BONUS_COOLDOWN_DAYS * DAY) return false;
  const start = new Date(r.returnStartedAt || now);
  r.multipliers.push({
    id: `return:${iso(start)}`,
    kind: 'return',
    value: R.RETURN_MULTIPLIER_STEPS[R.RETURN_MULTIPLIER_STEPS.length - 1],
    startsAt: iso(start),
    endsAt: iso(start.getTime() + R.RETURN_WINDOW_DAYS * DAY),
    reason: '다시 오셨네요. 복귀 기간에는 포인트를 더 드려요',
  });
  r.lastReturnBonusAt = iso(now);
  return true;
}

function structuralRisk(r, ctx, now, cfg) {
  const R = cfg.RETENTION;
  const today = dateKey(now), y = addDays(today, -1), yy = addDays(today, -2);
  if (isOff(ctx.shiftOn?.(today)) && ctx.shiftOn?.(y) === 'night' && ctx.shiftOn?.(yy) === 'night') return 'after_nights';
  if ((r.scheduleEvents || []).some((e) => e.type === 'pattern_change' && now.getTime() - Date.parse(e.at) < 7 * DAY && Date.parse(e.at) <= now.getTime())) return 'pattern_change';
  const dayNumber = diffDays(dateKey(r.signupAt), today) + 1;
  if (dayNumber >= R.STRUCTURAL_NEW_USER_FROM_DAY && dayNumber <= R.STRUCTURAL_NEW_USER_TO_DAY) return 'new_user';
  return null;
}

const RISK_REASONS = {
  score: '요즘 근무가 빡빡했죠. 이번 주는 포인트를 더 드려요',
  after_nights: '야간 근무 수고 많으셨어요. 이번 주는 포인트를 더 드려요',
  pattern_change: '근무가 바뀌어 적응 중이죠. 이번 주는 포인트를 더 드려요',
  new_user: '처음 2주가 가장 중요해요. 이번 주는 포인트를 더 드려요',
};

export function refreshMultipliers(r0, ctx, now, cfg = DEFAULT_CONFIG) {
  return applyMultipliers(clone(r0), ctx, now, cfg);
}

function applyMultipliers(r, ctx, now, cfg) {
  const R = cfg.RETENTION;
  const activeRisk = r.multipliers.some((m) => m.kind === 'risk' && Date.parse(m.startsAt) <= now.getTime() && Date.parse(m.endsAt) > now.getTime());
  const cause = r.riskScore >= R.WATCH_THRESHOLD ? 'score' : structuralRisk(r, ctx, now, cfg);
  if (!activeRisk && cause) {
    r.multipliers.push({
      id: `risk:${iso(now)}`,
      kind: 'risk',
      value: R.RISK_MULTIPLIER,
      startsAt: iso(now),
      endsAt: iso(now.getTime() + R.RISK_MULTIPLIER_DAYS * DAY),
      reason: RISK_REASONS[cause],
      cause,
    });
  }
  return r;
}

export function activeMultipliers(r, ctx, now, cfg = DEFAULT_CONFIG) {
  const R = cfg.RETENTION;
  return (r.multipliers || [])
    .filter((m) => Date.parse(m.startsAt) <= now.getTime() && Date.parse(m.endsAt) > now.getTime())
    .map((m) => {
      if (m.kind !== 'return') return { ...m };
      const n = Math.max(1, checkinsSince(allActivities(r, ctx), m.startsAt, now));
      const steps = R.RETURN_MULTIPLIER_STEPS;
      return { ...m, value: steps[Math.min(n, steps.length) - 1], checkins: n };
    });
}

// 곱하지 않고 최댓값 1개, 상한 CAP
export function currentMultiplier(r, ctx, now, cfg = DEFAULT_CONFIG) {
  const values = activeMultipliers(r, ctx, now, cfg).map((m) => m.value);
  return Math.min(cfg.RETENTION.MULTIPLIER_CAP, Math.max(1, ...values));
}

// ── 4.5 포인트 ────────────────────────────────────────────
const isBonus = (kind) => kind === 'weekly_goal' || kind === 'return_complete';

function pointsOnDay(r, key, includeBonus) {
  return r.ledger
    .filter((e) => dateKey(e.occurredAt) === key && (includeBonus || !isBonus(e.kind)))
    .reduce((s, e) => s + e.amount, 0);
}

function pushBonus(r, kind, base, now, cfg, note, id) {
  if (r.ledger.some((e) => e.id === id)) return null;
  let amount = base;
  if (cfg.POLICY.DAILY_CAP_INCLUDES_BONUS) {
    amount = Math.max(0, Math.min(base, cfg.RETENTION.DAILY_POINT_CAP - pointsOnDay(r, dateKey(now), true)));
  }
  const entry = { id, kind, base, multiplier: 1, amount, occurredAt: iso(now), note: amount < base ? `${note} (하루 상한으로 ${amount}P)` : note };
  r.ledger.push(entry);
  return entry;
}

export function rhythmWeek(r, ctx, key) {
  if (r.settings?.rhythmWeek === 'shift-cycle' && ctx.cycleLength >= 2 && ctx.cycleStartKey) {
    const L = ctx.cycleLength;
    const offset = ((diffDays(ctx.cycleStartKey, key) % L) + L) % L;
    const start = addDays(key, -offset);
    return { start, end: addDays(start, L - 1) };
  }
  const weekday = (new Date(`${key}T00:00:00Z`).getUTCDay() + 6) % 7; // 월=0
  const start = addDays(key, -weekday);
  return { start, end: addDays(start, 6) };
}

export function weekCheckins(r, ctx, now) {
  const week = rhythmWeek(r, ctx, dateKey(now));
  const days = [...checkinDays(allActivities(r, ctx), now)].filter((k) => k >= week.start && k <= week.end);
  return { ...week, count: days.length, days };
}

function grantWeeklyGoal(r, ctx, now, cfg) {
  const week = weekCheckins(r, ctx, now);
  if (week.count < cfg.RETENTION.WEEKLY_CHECKIN_GOAL) return null;
  return pushBonus(r, 'weekly_goal', cfg.BONUS_POINTS.weekly_goal, now, cfg, `이번 주 체크인 ${cfg.RETENTION.WEEKLY_CHECKIN_GOAL}일 달성`, `weekly_goal:${week.start}`);
}

function grantReturnBonus(r, now, cfg) {
  const last = r.lastReturnCompleteAt ? Date.parse(r.lastReturnCompleteAt) : null;
  if (last !== null && now.getTime() - last < cfg.RETENTION.RETURN_BONUS_COOLDOWN_DAYS * DAY) return null;
  const entry = pushBonus(r, 'return_complete', cfg.BONUS_POINTS.return_complete, now, cfg, '복귀 완료', `return_complete:${r.returnStartedAt}`);
  if (entry) { r.lastReturnCompleteAt = iso(now); r.returnCompletedAt = iso(now); }
  return entry;
}

// 활동 1건에 대한 포인트. 반환 { r, entry(활동 포인트 또는 null), bonuses[] }
export function awardPoints(r0, activity, ctx, now, cfg = DEFAULT_CONFIG) {
  return applyAward(clone(r0), activity, ctx, now, cfg);
}

function applyAward(r, activity, ctx, now, cfg) {
  const rule = cfg.BASE_POINTS[activity.type];
  const bonuses = [];
  let entry = null;
  if (rule && !r.ledger.some((e) => e.activityId === activity.id)) {
    const key = dateKey(activity.occurredAt || now);
    const sameToday = r.ledger.filter((e) => e.kind === activity.type && dateKey(e.occurredAt) === key).length;
    if (sameToday < rule.dailyLimit) {
      const multiplier = currentMultiplier(r, ctx, now, cfg);
      let amount = Math.round(rule.points * multiplier);
      const room = cfg.RETENTION.DAILY_POINT_CAP - pointsOnDay(r, key, cfg.POLICY.DAILY_CAP_INCLUDES_BONUS);
      const capped = amount > room;
      amount = Math.max(0, Math.min(amount, room));
      const label = multiplier > 1 ? `${rule.points}P × ${multiplier} = ${Math.round(rule.points * multiplier)}P` : `${rule.points}P`;
      entry = {
        id: `pt:${activity.id}`,
        activityId: activity.id,
        kind: activity.type,
        base: rule.points,
        multiplier,
        amount,
        occurredAt: iso(now),
        note: capped ? `${label} → 하루 상한으로 ${amount}P` : label,
      };
      r.ledger.push(entry);
    }
  }
  const weekly = grantWeeklyGoal(r, ctx, now, cfg);
  if (weekly) bonuses.push(weekly);
  return { r, entry, bonuses };
}

export function pointsTotal(r) {
  return (r.ledger || []).reduce((s, e) => s + e.amount, 0);
}

// ── 4.6 알림 계획 ─────────────────────────────────────────
function nudgeText(type, r, ctx, extra) {
  if (type === 'R1') return ctx.crewMember ? NUDGE_COPY.R1_crew : NUDGE_COPY.R1_solo;
  if (type === 'cheer_bundle') return extra;
  return NUDGE_COPY[type] || extra || '';
}

function upsertNudge(r, nudge) {
  if (r.nudges.some((n) => n.id === nudge.id)) return null; // 같은 날 같은 유형 중복 금지(멱등)
  r.nudges.push(nudge);
  return nudge;
}

function applyFilters(r, ctx, nudge, now, cfg, idleAtPlan) {
  const engine = ENGINE_NUDGES.includes(nudge.type);
  if (nudge.type === 'scheduled_workout') return nudge; // 사용자 예약 알림은 항상 보낸다
  if (engine && r.settings?.engineNudges === false) { nudge.cancelledReason = 'opt_out'; return nudge; }
  if (idleAtPlan > cfg.RETENTION.STOP_NUDGE_AFTER_DORMANT_DAYS) { nudge.cancelledReason = 'stopped'; return nudge; }
  const quiet = quietReason(nudge.plannedAt, r, ctx, cfg);
  if (!quiet) return nudge;
  if (nudge.type === 'cheer_bundle') {
    const slot = nextAllowedSlot(nudge.plannedAt, r, ctx, cfg);
    if (slot) nudge.plannedAt = iso(slot); else nudge.cancelledReason = 'quiet_hours';
    return nudge;
  }
  if (cfg.POLICY.QUIET_HOURS_ENGINE_NUDGE === 'defer_same_day') {
    const slot = nextAllowedSameDay(nudge.plannedAt, r, ctx, cfg);
    if (slot) { nudge.deferredFrom = nudge.plannedAt; nudge.plannedAt = iso(slot); return nudge; }
  }
  nudge.cancelledReason = 'quiet_hours';
  nudge.quietReason = quiet;
  return nudge;
}

export function planNudges(r0, ctx, now, cfg = DEFAULT_CONFIG) {
  return applyNudges(clone(r0), ctx, now, cfg);
}

function applyNudges(r, ctx, now, cfg) {
  const R = cfg.RETENTION;
  const acts = allActivities(r, ctx);
  const last = lastActivity(acts, now);
  const anchorKey = dateKey(last ? last.occurredAt : r.signupAt);
  const idle = daysIdle(r, ctx, now);

  // R1~R3: 무활동 N일째 12:00, 활동 공백 1회당 1번씩
  for (const [type, at] of [['R1', R.R1_AT_IDLE_DAYS], ['R2', R.R2_AT_IDLE_DAYS], ['R3', R.R3_AT_IDLE_DAYS]]) {
    if (idle < at) continue;
    const key = addDays(anchorKey, at);
    const nudge = {
      id: `${type}:${anchorKey}`,
      type,
      plannedAt: iso(atKst(key, `${String(R.ENGINE_NUDGE_HOUR).padStart(2, '0')}:00`)),
      text: nudgeText(type, r, ctx),
      crewRequest: type === 'R1' && !!ctx.crewMember && r.settings?.cheerRequestOnRest !== false,
    };
    if (r.nudges.some((n) => n.id === nudge.id)) continue;
    upsertNudge(r, applyFilters(r, ctx, nudge, now, cfg, at));
  }

  // A4: 주의 구간당 1회, 다음 휴무일 예상 기상 + 1시간
  if (r.state === 'watch' && r.watchSince) {
    const id = `A4_reminder:${r.watchSince}`;
    if (!r.nudges.some((n) => n.id === id)) {
      for (let i = 0; i <= 14; i++) {
        const key = addDays(dateKey(now), i);
        if (!isOff(ctx.shiftOn?.(key))) continue;
        const t = new Date(expectedWake(ctx, key).getTime() + R.A4_AFTER_WAKE_MIN * MIN);
        if (t.getTime() < Date.parse(r.watchSince)) continue;
        upsertNudge(r, applyFilters(r, ctx, { id, type: 'A4_reminder', plannedAt: iso(t), text: nudgeText('A4_reminder', r, ctx) }, now, cfg, idle));
        break;
      }
    }
  }

  // 크루 응원 묶음: 받은 응원을 1건으로. R1 공백이면 R1 다음 날부터.
  const pending = (r.cheers || []).filter((c) => !c.bundledAt && Date.parse(c.createdAt) <= now.getTime());
  const openBundle = r.nudges.find((n) => n.type === 'cheer_bundle' && !n.sentAt && !n.cancelledReason);
  if (pending.length && !openBundle) {
    const latest = Math.max(...pending.map((c) => Date.parse(c.createdAt)));
    const r1 = r.nudges.find((n) => n.id === `R1:${anchorKey}`);
    const earliest = r1 ? Math.max(latest, atKst(addDays(dateKey(r1.plannedAt), 1), '00:00').getTime()) : latest;
    const bundle = { id: `cheer_bundle:${iso(earliest)}`, type: 'cheer_bundle', plannedAt: iso(earliest), cheerIds: pending.map((c) => c.id), silent: r.settings?.receiveCheers === false };
    const slot = nextAllowedSlot(new Date(earliest), r, ctx, cfg);
    if (slot) bundle.plannedAt = iso(slot); else bundle.cancelledReason = 'quiet_hours';
    for (const c of pending) c.bundledAt = bundle.plannedAt;
    bundle.text = cheerBundleText(pending);
    upsertNudge(r, bundle);
  } else if (pending.length && openBundle) {
    for (const c of pending) { c.bundledAt = openBundle.plannedAt; openBundle.cheerIds.push(c.id); }
    openBundle.text = cheerBundleText(r.cheers.filter((c) => openBundle.cheerIds.includes(c.id)));
  }

  // 사용자 예약 운동 알림: 엔진 필터와 무관하게 항상 발송
  for (const w of ctx.scheduledWorkouts || []) {
    if (!w.remindAt) continue;
    upsertNudge(r, { id: `scheduled_workout:${w.id}`, type: 'scheduled_workout', plannedAt: iso(w.remindAt), text: w.title ? `${w.title} 시간이에요` : '예약한 운동 시간이에요' });
  }

  // 발송: 계획 시각이 지났고 취소되지 않은 것. A4는 아직 주의 상태일 때만.
  for (const n of r.nudges) {
    if (n.sentAt || n.cancelledReason || Date.parse(n.plannedAt) > now.getTime()) continue;
    if (n.type === 'A4_reminder' && r.state !== 'watch') { n.cancelledReason = 'stopped'; continue; }
    n.sentAt = n.plannedAt;
  }
  return r;
}

export function cheerBundleText(cheers) {
  if (!cheers.length) return '';
  const first = cheers[0].fromName || cheers[0].fromUser;
  return cheers.length === 1 ? `${first}님이 응원을 보냈어요` : `${first}님 외 ${cheers.length - 1}명이 응원을 보냈어요`;
}

export function sortInbox(nudges) {
  return [...nudges]
    .filter((n) => n.sentAt && !n.cancelledReason)
    .sort((a, b) => (Date.parse(b.sentAt) - Date.parse(a.sentAt)) || (NUDGE_ORDER.indexOf(a.type) - NUDGE_ORDER.indexOf(b.type)));
}

// ── 4.1 진입점 ────────────────────────────────────────────
export function runRetentionEngine(r0, ctx, now, cfg = DEFAULT_CONFIG) {
  return applyRun(clone(r0), ctx, now, cfg);
}

function applyRun(r, ctx, now, cfg) {
  const acts = allActivities(r, ctx);
  const last = lastActivity(acts, now);
  r.lastActiveAt = last ? last.occurredAt : null;
  const risk = computeRisk(r, ctx, now, cfg);
  r.riskScore = risk.score;
  r.riskSignals = risk.signals;
  r.riskDetail = risk.detail;
  applyNextState(r, ctx, now, cfg);
  applyMultipliers(r, ctx, now, cfg);
  applyNudges(r, ctx, now, cfg);
  return r;
}

// 활동 기록 → 엔진 실행 → 포인트. 반환 { r, entry, bonuses }
export function logActivity(r0, activity, ctx, now, cfg = DEFAULT_CONFIG) {
  const r1 = clone(r0);
  const isDerived = (ctx.activities || []).some((a) => a.id === activity.id);
  if (!isDerived && !r1.events.some((e) => e.id === activity.id)) r1.events.push(activity);
  const run = applyRun(r1, ctx, now, cfg);
  // 상태 전이에서 생긴 복귀 완료 보너스도 함께 돌려준다
  const fromRun = run.ledger.slice(r0.ledger.length).filter((e) => isBonus(e.kind));
  const awarded = applyAward(run, activity, ctx, now, cfg);
  return { r: awarded.r, entry: awarded.entry, bonuses: [...fromRun, ...awarded.bonuses] };
}

// ── 화면용 파생값 ─────────────────────────────────────────
export function fiveMinPlanVisible(r, now, cfg = DEFAULT_CONFIG) {
  const trigger = r.riskScore >= cfg.RETENTION.HIGH_RISK_THRESHOLD || r.riskSignals.includes('tired_streak');
  if (!trigger || r.fiveMinPlan?.active) return false;
  const declined = r.fiveMinPlan?.declinedAt ? Date.parse(r.fiveMinPlan.declinedAt) : null;
  return declined === null || now.getTime() - declined >= cfg.RETENTION.FIVE_MIN_DECLINE_DAYS * DAY;
}

export function statusBadge(r, ctx, now, cfg = DEFAULT_CONFIG) {
  const mult = currentMultiplier(r, ctx, now, cfg);
  if (r.state === 'returning') {
    const n = Math.min(returnCheckins(r, ctx, now), cfg.RETENTION.RETURN_COMPLETE_CHECKINS);
    return { kind: 'returning', text: `복귀 ${n}/${cfg.RETENTION.RETURN_COMPLETE_CHECKINS}일차 · 지금 포인트 ×${mult}` };
  }
  if (r.returnCompletedAt && dateKey(r.returnCompletedAt) === dateKey(now)) {
    return { kind: 'complete', text: `복귀 완료 · +${cfg.BONUS_POINTS.return_complete}P를 드렸어요` };
  }
  const risk = activeMultipliers(r, ctx, now, cfg).find((m) => m.kind === 'risk');
  if (r.state === 'watch' && risk) return { kind: 'watch', text: `이번 주 포인트 ${risk.value}배 · ${risk.reason}` };
  return null;
}

// 크루원에게 내려가는 데이터: 허용 필드만 (3장 크루 데이터 제약)
export function crewPublicView(r, nickname, now, ctx = { activities: [] }, cfg = DEFAULT_CONFIG) {
  const watchDays = r.watchSince ? (now.getTime() - Date.parse(r.watchSince)) / DAY : 0;
  const recommendCheer = r.settings?.cheerRequestOnRest !== false
    && (r.state === 'dormant' || (r.state === 'watch' && watchDays >= cfg.RETENTION.WATCH_CHEER_SUGGEST_DAYS));
  const view = { nickname, recommendCheer, cheersReceived: (r.cheers || []).length };
  if (r.settings?.shareWeeklyCheckin) view.checkedInThisWeek = weekCheckins(r, ctx, now).count > 0;
  return view;
}

export const CHEERS = CHEER_TEMPLATES;

// ── 관리자용: 알림을 보낸 뒤 어떻게 됐는지 ────────────────
// 알림마다 결과(발송·취소·이월·대기), 응답(탭) 여부, 발송 후 7일 안에 활동했는지를 정리한다.
export function nudgeOutcomes(r, ctx, now) {
  const acts = allActivities(r, ctx);
  return (r.nudges || []).map((n) => {
    const status = n.cancelledReason ? 'cancelled' : n.sentAt ? (n.deferredFrom ? 'deferred' : 'sent') : 'pending';
    let cameBackAt = null;
    if (n.sentAt) {
      const from = Date.parse(n.sentAt), to = Math.min(now.getTime(), from + 7 * DAY);
      cameBackAt = acts.find((a) => Date.parse(a.occurredAt) > from && Date.parse(a.occurredAt) <= to)?.occurredAt || null;
    }
    return {
      type: n.type,
      plannedAt: n.plannedAt,
      sentAt: n.sentAt || null,
      status,
      reason: n.cancelledReason || null,
      quietReason: n.quietReason || null,
      deferredFrom: n.deferredFrom || null,
      responded: !!n.respondedAt,
      cameBack: !!cameBackAt,
      hoursToReturn: cameBackAt ? Math.round((Date.parse(cameBackAt) - Date.parse(n.sentAt)) / 3600000) : null,
      silent: !!n.silent,
      text: n.text || '',
    };
  });
}
