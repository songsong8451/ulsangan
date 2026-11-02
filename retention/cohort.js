// 관리자 대시보드용 가상 사용자 집단 시뮬레이션. 실제 엔진(engine.js)을 하루씩 돌려
// 미결 정책(11장) 값을 바꿨을 때 결과가 어떻게 달라지는지 비교한다. 실제 사용자 데이터는 쓰지 않는다.
import {
  createRetention, runRetentionEngine, logActivity, dateKey, addDays, atKst, weekCheckins, currentMultiplier, pointsTotal, nudgeOutcomes,
} from './engine.js';
import { DEFAULT_CONFIG } from './constants.js';
import { DEFAULT_WORK_HOURS } from './demo.js';

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PATTERNS = {
  four: ['day', 'night', 'off', 'rest'],
  three: ['day', 'evening', 'night', 'off'],
  nights: ['night', 'night', 'night', 'off', 'rest', 'day', 'day'],
};

// 행동 유형: 하루 활동 확률, 근무 종류별 보정, 시간이 지날수록 줄어드는 정도, 알림 응답률, 복귀 성향
const ARCHETYPES = [
  { id: 'steady', weight: 0.34, p: 0.62, decay: 0, respond: 0.55, comeback: 0.5, tired: 0.15 },
  { id: 'fading', weight: 0.2, p: 0.55, decay: 0.022, respond: 0.25, comeback: 0.3, tired: 0.3 },
  { id: 'night_worn', weight: 0.16, p: 0.5, decay: 0.008, respond: 0.3, comeback: 0.35, tired: 0.55, nightPenalty: 0.35 },
  { id: 'early_drop', weight: 0.15, p: 0.6, decay: 0.07, respond: 0.15, comeback: 0.2, tired: 0.25, newUser: true },
  { id: 'returner', weight: 0.15, p: 0.45, decay: 0, respond: 0.45, comeback: 0.75, tired: 0.2, gaps: true },
];

const NAMES = '야간러너 새벽별 교대고수 밤샘요정 회복중 꿀잠기원 철야곰 오후반 비번만세 삼교대장인 수면탐험가 커피끊기 퇴근길 새벽공기 근무표장인 졸음킬러 밤하늘 출근전요가 주간조 야간조'.split(' ');

function pick(rand, list) {
  let x = rand(), acc = 0;
  for (const item of list) { acc += item.weight; if (x < acc) return item; }
  return list[list.length - 1];
}

export function simulateCohort({ users = 80, days = 42, seed = 11, cfg = DEFAULT_CONFIG, endNow = new Date() } = {}) {
  const rand = rng(seed);
  const endKey = dateKey(endNow);
  const startKey = addDays(endKey, -days);
  const timeline = [];
  const people = [];

  for (let i = 0; i < users; i++) {
    const type = pick(rand, ARCHETYPES);
    const patternKey = type.id === 'night_worn' ? 'nights' : rand() < 0.6 ? 'four' : 'three';
    const pattern = PATTERNS[patternKey];
    const offset = Math.floor(rand() * pattern.length);
    const signupKey = type.newUser ? addDays(endKey, -Math.floor(10 + rand() * 30)) : addDays(startKey, -Math.floor(rand() * 30));
    const anchor = addDays(startKey, -offset);
    const schedule = {};
    const ctx = {
      activities: [],
      shiftOn: (k) => schedule[k] || pattern[(((Math.round((Date.parse(`${k}T00:00:00Z`) - Date.parse(`${anchor}T00:00:00Z`)) / 864e5)) % pattern.length) + pattern.length) % pattern.length],
      workHours: DEFAULT_WORK_HOURS,
      crewMember: rand() < 0.7,
      cycleLength: pattern.length,
      cycleStartKey: anchor,
      scheduledWorkouts: [],
    };
    let r = createRetention(atKst(signupKey, '09:00'));
    const track = { watchDays: new Set(), dormantEntries: [], caughtBeforeDormant: 0 };
    let gapUntil = null;
    let prevState = r.state;
    // 시작 전 기간도 짧게 돌려 직전 28일 이력을 만든다
    const from = signupKey > addDays(startKey, -21) ? signupKey : addDays(startKey, -21);
    for (let k = from; k <= endKey; k = addDays(k, 1)) {
      if (k < signupKey) continue;
      const age = Math.max(0, Math.round((Date.parse(`${k}T00:00:00Z`) - Date.parse(`${signupKey}T00:00:00Z`)) / 864e5));
      const shift = ctx.shiftOn(k);
      let p = type.p * Math.exp(-type.decay * age);
      if (shift === 'night') p *= 1 - (type.nightPenalty || 0.15);
      if (type.gaps && !gapUntil && rand() < 0.03) gapUntil = addDays(k, 8 + Math.floor(rand() * 10));
      if (gapUntil && k <= gapUntil) p = 0; else gapUntil = null;
      if (r.state === 'dormant') {
        const nudged = r.nudges.some((n) => n.sentAt && dateKey(n.sentAt) === addDays(k, -1) && !n.cancelledReason);
        const cheered = r.cheers.length > 0;
        p = (nudged ? 0.18 : 0.03) * type.comeback * (cheered ? 1.4 : 1);
      }
      if (r.state === 'returning') p = Math.max(p, 0.5 * type.comeback + 0.2);
      const morning = atKst(k, '08:30');
      r = runRetentionEngine(r, ctx, morning, cfg);
      // R1 크루 응원(크루 소속이면 2~3명)
      for (const n of r.nudges) {
        if (n.type === 'R1' && n.crewRequest && !n.cheersSimulated && Date.parse(n.plannedAt) <= morning.getTime()) {
          n.cheersSimulated = true;
          const count = 2 + Math.floor(rand() * 2);
          for (let c = 0; c < count; c++) r.cheers.push({ id: `c${i}-${n.id}-${c}`, fromUser: `crew${c}`, fromName: ['수진', '지현', '하늘'][c], toUser: `u${i}`, templateId: 'waiting', createdAt: new Date(Date.parse(n.plannedAt) + (c + 1) * 3600000).toISOString() });
        }
      }
      if (rand() < p) {
        const hour = shift === 'night' ? '17:30' : shift === 'day' ? '18:30' : '11:30';
        const at = atKst(k, hour);
        const roll = rand();
        const kind = roll < 0.4 ? 'sleep_logged' : roll < 0.7 ? 'workout_done' : roll < 0.9 ? 'condition_check' : 'rest_chosen';
        const act = { id: `a${i}-${k}-${kind}`, type: kind, occurredAt: at.toISOString() };
        if (kind === 'condition_check') act.meta = { level: rand() < type.tired ? 'tired' : rand() < 0.5 ? 'ok' : 'good' };
        if (kind === 'sleep_logged' || kind === 'workout_done') ctx.activities.push(act);
        r = logActivity(r, act, ctx, at, cfg).r;
        if (kind === 'rest_chosen') r = logActivity(r, { id: `l${i}-${k}`, type: 'lapse_reason', occurredAt: at.toISOString(), meta: { reason: ['time', 'fatigue', 'too_hard', 'schedule_change'][Math.floor(rand() * 4)] } }, ctx, at, cfg).r;
      }
      const evening = atKst(k, '21:30');
      r = runRetentionEngine(r, ctx, evening, cfg);
      // 그날 받은 알림에 응답(탭)
      for (const n of r.nudges) if (n.sentAt && !n.respondedAt && dateKey(n.sentAt) === k && rand() < type.respond) n.respondedAt = new Date(Date.parse(n.sentAt) + 20 * 60000).toISOString();
      if (r.state === 'watch') track.watchDays.add(k);
      const entered = prevState !== 'dormant' && r.state === 'dormant';
      prevState = r.state;
      if (entered) {
        track.dormantEntries.push(k);
        const caught = [...track.watchDays].some((w) => w >= addDays(k, -7) && w <= k);
        if (caught) track.caughtBeforeDormant++;
      }
      if (k >= startKey) {
        let row = timeline.find((t) => t.date === k);
        if (!row) { row = { date: k, active: 0, watch: 0, dormant: 0, returning: 0 }; timeline.push(row); }
        row[r.state]++;
      }
    }
    people.push({ i, type: type.id, patternKey, r, ctx, track });
  }

  const now = atKst(endKey, '21:30');
  const rows = people.map(({ i, type, patternKey, r, ctx, track }) => ({
    ...summaryFrom(r, ctx, now, cfg),
    user_id: `sim-${String(i).padStart(3, '0')}`,
    nickname: `${NAMES[i % NAMES.length]}${Math.floor(i / NAMES.length) || ''}`,
    archetype: type,
    pattern: patternKey,
    dormant_entries: track.dormantEntries.length,
    caught_before_dormant: track.caughtBeforeDormant,
  }));
  return { rows, timeline: timeline.sort((a, b) => a.date.localeCompare(b.date)), asOf: now.toISOString(), days, users };
}

export function summaryFrom(r, ctx, now, cfg = DEFAULT_CONFIG) {
  const nudges = r.nudges || [];
  const count = (f) => nudges.filter(f).length;
  return {
    state: r.state,
    risk_score: r.riskScore,
    risk_signals: r.riskSignals,
    last_active_at: r.lastActiveAt,
    state_changed_at: r.stateChangedAt,
    dormant_since: r.dormantSince,
    return_started_at: r.returnStartedAt,
    points_total: pointsTotal(r),
    week_checkins: weekCheckins(r, ctx, now).count,
    multiplier: currentMultiplier(r, ctx, now, cfg),
    nudge_stats: {
      sent: count((n) => n.sentAt && !n.cancelledReason),
      responded: count((n) => n.respondedAt),
      quiet_hours: count((n) => n.cancelledReason === 'quiet_hours'),
      stopped: count((n) => n.cancelledReason === 'stopped'),
      opt_out: count((n) => n.cancelledReason === 'opt_out'),
      deferred: count((n) => n.deferredFrom),
      r1: count((n) => n.type === 'R1'),
      r1_quiet: count((n) => n.type === 'R1' && n.cancelledReason === 'quiet_hours'),
      // 최근 알림 40건의 결과(관리자 '알림 이후' 표용, 건강 정보 없음)
      log: nudgeOutcomes(r, ctx, now).slice(-40),
    },
    returns: (r.multipliers || []).filter((m) => m.kind === 'return').length,
    return_completes: (r.ledger || []).filter((e) => e.kind === 'return_complete').length,
    capped_entries: (r.ledger || []).filter((e) => /하루 상한/.test(e.note || '')).length,
    updated_at: now.toISOString(),
  };
}
