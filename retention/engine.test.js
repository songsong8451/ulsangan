// 명세 8장 단위 테스트 + 7장 수용 기준 중 엔진으로 확인할 수 있는 것. 실행: node --test retention/
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createRetention, computeRisk, nextState, currentMultiplier, awardPoints, planNudges, runRetentionEngine,
  logActivity, refreshMultipliers, sortInbox, crewPublicView, dateKey, addDays, atKst, quietReason, pointsTotal,
  fiveMinPlanVisible, statusBadge,
} from './engine.js';
import { withConfig, DEFAULT_CONFIG, RISK_SIGNAL_POINTS } from './constants.js';
import { PRESETS, demoCtx } from './demo.js';

const TODAY = '2026-11-02';
const at = (key, hhmm = '10:00') => atKst(key, hhmm);
const NOW = at(TODAY, '10:00');
let n = 0;
const act = (type, when, meta) => ({ id: `a${++n}`, type, occurredAt: new Date(when).toISOString(), ...(meta ? { meta } : {}) });

const HOURS = { day: { start: '07:00', end: '15:00' }, evening: { start: '15:00', end: '23:00' }, night: { start: '23:00', end: '07:00' } };
function ctxOf({ activities = [], schedule = {}, fallback = 'off', ...rest } = {}) {
  return { activities, shiftOn: (k) => schedule[k] || fallback, workHours: HOURS, crewMember: true, ...rest };
}
// 가입 60일, 하루 걸러 기록하던 사용자(최근 7일은 비움)
function steadyHistory(untilDaysAgo = 8) {
  const out = [];
  for (let d = -60; d <= -untilDaysAgo; d++) if (d % 2 === 0) out.push(act('sleep_logged', at(addDays(TODAY, d))));
  return out;
}
const base = (extra) => createRetention(at(addDays(TODAY, -60), '09:00'), extra);

// ── computeRisk ──────────────────────────────────────────
test('computeRisk: 신호 없음이면 0점', () => {
  const acts = [];
  for (let d = -30; d <= 0; d++) acts.push(act('sleep_logged', at(addDays(TODAY, d), '09:00')));
  const r = computeRisk(base(), ctxOf({ activities: acts, fallback: 'day' }), NOW);
  assert.equal(r.score, 0);
  assert.deepEqual(r.signals, []);
});

test('computeRisk: freq_drop 단독 25점, 야간 3연속이면 ×0.5', () => {
  const acts = [...steadyHistory(), act('sleep_logged', at(addDays(TODAY, -3)))];
  const plain = computeRisk(base(), ctxOf({ activities: acts, fallback: 'day' }), NOW);
  assert.deepEqual(plain.signals, ['freq_drop']);
  assert.equal(plain.score, 25);
  const schedule = { [addDays(TODAY, -4)]: 'night', [addDays(TODAY, -3)]: 'night', [addDays(TODAY, -2)]: 'night' };
  const night = computeRisk(base(), ctxOf({ activities: acts, schedule, fallback: 'day' }), NOW);
  assert.equal(night.detail.freq_drop.points, 13);
  assert.equal(night.detail.freq_drop.nightAdjusted, true);
});

test('computeRisk: freq_drop은 직전 구간 데이터가 7일 미만이면 스킵', () => {
  const r = createRetention(at(addDays(TODAY, -10), '09:00'));
  const acts = [act('sleep_logged', at(addDays(TODAY, -9))), act('sleep_logged', at(addDays(TODAY, -8)))];
  assert.ok(!computeRisk(r, ctxOf({ activities: acts, fallback: 'day' }), NOW).signals.includes('freq_drop'));
});

test('computeRisk: off_day_silent / tired_streak / shift_changed / early_user / same_lapse / unconfirmed_pile', () => {
  const schedule = { [addDays(TODAY, -2)]: 'off', [addDays(TODAY, -1)]: 'rest' };
  const r0 = createRetention(at(addDays(TODAY, -4), '09:00'));
  r0.events = [
    act('condition_check', at(addDays(TODAY, -4)), { level: 'tired' }),
    act('condition_check', at(addDays(TODAY, -4), '20:00'), { level: 'tired' }),
    act('condition_check', at(addDays(TODAY, -3)), { level: 'tired' }),
    act('lapse_reason', at(addDays(TODAY, -3), '11:00'), { reason: 'time' }),
    act('lapse_reason', at(addDays(TODAY, -3), '12:00'), { reason: 'time' }),
  ];
  r0.scheduleEvents = [{ type: 'pattern_change', at: at(addDays(TODAY, -3)).toISOString() }];
  const scheduledWorkouts = [1, 2, 3].map((i) => ({ id: `w${i}`, plannedAt: at(addDays(TODAY, -i), '18:00').toISOString(), status: 'unconfirmed' }));
  const risk = computeRisk(r0, ctxOf({ schedule, fallback: 'day', scheduledWorkouts }), NOW);
  for (const s of ['off_day_silent', 'tired_streak', 'shift_changed', 'early_user', 'same_lapse', 'unconfirmed_pile']) assert.ok(risk.signals.includes(s), s);
  assert.equal(risk.score, 20 + 15 + 15 + 10 + 10 + 15);
});

test('computeRisk: 근무 시간과 겹친 예정 운동은 미확인 누적에서 제외', () => {
  const scheduledWorkouts = [1, 2, 3].map((i) => ({ id: `w${i}`, plannedAt: at(addDays(TODAY, -i), '10:00').toISOString(), status: 'unconfirmed' }));
  const risk = computeRisk(base(), ctxOf({ fallback: 'day', scheduledWorkouts }), NOW);
  assert.ok(!risk.signals.includes('unconfirmed_pile'));
});

test('computeRisk: nudge_ignored는 최근 3건 무응답, 기상 후 1시간 안 발송분 제외', () => {
  const r = base();
  r.nudges = [1, 2, 3].map((i) => ({ id: `x${i}`, type: 'R1', plannedAt: at(addDays(TODAY, -i), '12:00').toISOString(), sentAt: at(addDays(TODAY, -i), '12:00').toISOString() }));
  assert.ok(computeRisk(r, ctxOf({ fallback: 'day' }), NOW).signals.includes('nudge_ignored'));
  r.nudges[2].respondedAt = NOW.toISOString();
  assert.ok(!computeRisk(r, ctxOf({ fallback: 'day' }), NOW).signals.includes('nudge_ignored'));
  // 휴무일 예상 기상 07:00 → 07:30 발송분은 제외되어 3건이 안 됨
  r.nudges = [1, 2, 3].map((i) => ({ id: `y${i}`, type: 'A4_reminder', sentAt: at(addDays(TODAY, -i), i === 1 ? '07:30' : '12:00').toISOString() }));
  assert.ok(!computeRisk(r, ctxOf({ fallback: 'off' }), NOW).signals.includes('nudge_ignored'));
});

test('computeRisk: 합계는 100 상한', () => {
  const cfg = withConfig({ RISK_SIGNAL_POINTS: { early_user: 95, shift_changed: 95 } });
  const r = createRetention(at(addDays(TODAY, -4)));
  r.scheduleEvents = [{ type: 'pattern_change', at: at(addDays(TODAY, -1)).toISOString() }];
  assert.equal(computeRisk(r, ctxOf({ fallback: 'day' }), NOW, cfg).score, 100);
});

test('RISK_SIGNAL_POINTS 값만 바꾸면 점수가 바뀐다(0이면 신호 비활성)', () => {
  const r = createRetention(at(addDays(TODAY, -4)));
  assert.equal(computeRisk(r, ctxOf({ fallback: 'day' }), NOW).score, RISK_SIGNAL_POINTS.early_user);
  const off = withConfig({ RISK_SIGNAL_POINTS: { early_user: 0 } });
  assert.equal(computeRisk(r, ctxOf({ fallback: 'day' }), NOW, off).score, 0);
});

// ── nextState ────────────────────────────────────────────
const lastActive = (daysAgo) => [act('sleep_logged', at(addDays(TODAY, -daysAgo)))];

test('nextState: active → dormant는 정확히 7일, 6일은 유지', () => {
  assert.equal(nextState(base(), ctxOf({ activities: lastActive(7) }), NOW).state, 'dormant');
  assert.equal(nextState(base(), ctxOf({ activities: lastActive(6) }), NOW).state, 'active');
  assert.equal(nextState(base({ state: 'watch' }), ctxOf({ activities: lastActive(7) }), NOW).state, 'dormant');
});

test('nextState: watch 경계 40점', () => {
  const ctx = ctxOf({ activities: lastActive(1) });
  assert.equal(nextState(base({ riskScore: 40 }), ctx, NOW).state, 'watch');
  assert.equal(nextState(base({ riskScore: 39 }), ctx, NOW).state, 'active');
  assert.equal(nextState(base({ state: 'watch', riskScore: 39 }), ctx, NOW).state, 'active');
  assert.equal(nextState(base({ state: 'watch', riskScore: 40 }), ctx, NOW).state, 'watch');
});

test('WATCH_THRESHOLD 값만 바꾸면 전이가 바뀐다', () => {
  const ctx = ctxOf({ activities: lastActive(1) });
  assert.equal(nextState(base({ riskScore: 30 }), ctx, NOW, withConfig({ RETENTION: { WATCH_THRESHOLD: 30 } })).state, 'watch');
});

test('nextState: dormant → returning(+복귀 배수), returning → active(3일)·dormant(7일 무활동)·active(7일 경과)', () => {
  const dormant = base({ state: 'dormant', dormantSince: at(addDays(TODAY, -1)).toISOString() });
  const back = nextState(dormant, ctxOf({ activities: [act('sleep_logged', NOW)] }), NOW);
  assert.equal(back.state, 'returning');
  assert.equal(back.multipliers.filter((m) => m.kind === 'return').length, 1);

  const start = at(addDays(TODAY, -2));
  const returning = base({ state: 'returning', returnStartedAt: start.toISOString() });
  const three = [act('sleep_logged', start), act('sleep_logged', at(addDays(TODAY, -1))), act('sleep_logged', NOW)];
  const done = nextState(returning, ctxOf({ activities: three }), NOW);
  assert.equal(done.state, 'active');
  assert.equal(done.ledger.find((e) => e.kind === 'return_complete')?.amount, 200);

  const idle = base({ state: 'returning', returnStartedAt: at(addDays(TODAY, -7)).toISOString() });
  assert.equal(nextState(idle, ctxOf({ activities: [act('sleep_logged', at(addDays(TODAY, -7)))] }), NOW).state, 'dormant');

  const expired = base({ state: 'returning', returnStartedAt: at(addDays(TODAY, -8), '09:00').toISOString() });
  const twoOld = [act('sleep_logged', at(addDays(TODAY, -8))), act('sleep_logged', at(addDays(TODAY, -2)))];
  const timedOut = nextState(expired, ctxOf({ activities: twoOld }), NOW);
  assert.equal(timedOut.state, 'active');
  assert.ok(!timedOut.ledger.some((e) => e.kind === 'return_complete'));
});

test('수용: 복귀 배수는 30일 안에 두 번 생성되지 않는다', () => {
  const r = base({ state: 'dormant', dormantSince: at(addDays(TODAY, -1)).toISOString(), lastReturnBonusAt: at(addDays(TODAY, -20)).toISOString() });
  const back = nextState(r, ctxOf({ activities: [act('sleep_logged', NOW)] }), NOW);
  assert.equal(back.state, 'returning');
  assert.equal(back.multipliers.length, 0);
});

// ── currentMultiplier ────────────────────────────────────
const mult = (kind, value, startsAt = at(addDays(TODAY, -1))) => ({ id: `${kind}${value}`, kind, value, startsAt: startsAt.toISOString(), endsAt: new Date(startsAt.getTime() + 7 * 864e5).toISOString(), reason: '' });

test('currentMultiplier: 0개=1, 1개, 복수는 최댓값(곱하지 않음), 상한 1.5', () => {
  const ctx = ctxOf();
  assert.equal(currentMultiplier(base(), ctx, NOW), 1);
  assert.equal(currentMultiplier(base({ multipliers: [mult('risk', 1.2)] }), ctx, NOW), 1.2);
  assert.equal(currentMultiplier(base({ multipliers: [mult('risk', 1.2), mult('event', 1.4)] }), ctx, NOW), 1.4);
  assert.equal(currentMultiplier(base({ multipliers: [mult('event', 2), mult('event', 3)] }), ctx, NOW), 1.5);
});

test('수용: 위험 1.2 + 복귀 1.3 동시면 1.3만 적용', () => {
  const start = at(addDays(TODAY, -1));
  const r = base({ multipliers: [mult('risk', 1.2), mult('return', 1.5, start)] });
  const ctx = ctxOf({ activities: [act('sleep_logged', start), act('sleep_logged', NOW)] }); // 복귀 후 2일 → 1.3
  assert.equal(currentMultiplier(r, ctx, NOW), 1.3);
});

// ── awardPoints ──────────────────────────────────────────
test('수용: 같은 날 운동 3회째는 0P이고 원장에 기록되지 않는다', () => {
  let r = base();
  const ctx = ctxOf();
  for (let i = 0; i < 3; i++) r = awardPoints(r, act('workout_done', NOW), ctx, NOW).r;
  const workouts = r.ledger.filter((e) => e.kind === 'workout_done');
  assert.equal(workouts.length, 2);
  assert.equal(pointsTotal(r), 60);
});

test('수용: 하루 활동 포인트는 200P를 넘지 않는다(상한 절삭)', () => {
  const types = ['workout_done', 'workout_done', 'sleep_logged', 'condition_check', 'rest_chosen', 'cheer_sent', 'cheer_sent', 'cheer_sent'];
  const day = (cfg) => {
    let r = base({ multipliers: [mult('event', 1.5)] });
    for (const t of types) r = awardPoints(r, act(t, NOW), ctxOf(), NOW, cfg).r;
    return r;
  };
  // 기본값: 하루 최대치(130P × 1.5 = 195P)도 200P 이하
  const dflt = day(DEFAULT_CONFIG);
  assert.equal(pointsTotal(dflt), 195);
  // 상한 절삭 동작 확인: 상한을 150으로 내리면 150에서 잘린다
  const low = day(withConfig({ RETENTION: { DAILY_POINT_CAP: 150 } }));
  assert.equal(pointsTotal(low), 150);
  assert.ok(low.ledger.some((e) => /하루 상한/.test(e.note)));
});

test('수용: 보너스는 배수 미적용, 기본 정책에선 상한과 무관 / true면 총합 200P', () => {
  const week = ['2026-11-02', '2026-11-03', '2026-11-04']; // 월·화·수
  const run = (cfg) => {
    let r = base({ multipliers: [mult('event', 1.5, at('2026-11-01'))] });
    const acts = [];
    for (const [i, k] of week.entries()) {
      const now = at(k);
      const types = i < 2 ? ['condition_check'] : ['workout_done', 'workout_done', 'sleep_logged', 'condition_check', 'rest_chosen', 'cheer_sent', 'cheer_sent'];
      for (const t of types) { const a = act(t, now); acts.push(a); r = awardPoints(r, a, ctxOf({ activities: acts }), now, cfg).r; }
    }
    return r;
  };
  const dflt = run(DEFAULT_CONFIG);
  const bonus = dflt.ledger.find((e) => e.kind === 'weekly_goal');
  assert.equal(bonus.amount, 100);
  assert.equal(bonus.multiplier, 1);
  const day3 = dflt.ledger.filter((e) => dateKey(e.occurredAt) === week[2]).reduce((s, e) => s + e.amount, 0);
  assert.equal(day3, 280); // 활동 180 + 보너스 100(상한과 무관)
  const capped = run(withConfig({ POLICY: { DAILY_CAP_INCLUDES_BONUS: true } }));
  const day3b = capped.ledger.filter((e) => dateKey(e.occurredAt) === week[2]).reduce((s, e) => s + e.amount, 0);
  assert.equal(day3b, 200);
});

test('수용: 리듬 주 3일째 체크인 시 100P가 1회만', () => {
  let r = base();
  const acts = [];
  for (const k of ['2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05']) {
    const a = act('condition_check', at(k));
    acts.push(a);
    r = awardPoints(r, a, ctxOf({ activities: acts }), at(k)).r;
  }
  assert.equal(r.ledger.filter((e) => e.kind === 'weekly_goal').length, 1);
});

test('수용: "오늘은 휴식"은 체크인일로 인정되고 10P', () => {
  const r0 = base();
  const rest = act('rest_chosen', NOW);
  const { r, entry } = logActivity(r0, rest, ctxOf(), NOW);
  assert.equal(entry.amount, 10);
  assert.equal(r.lastActiveAt, rest.occurredAt);
});

test('수용: 앱 접속(엔진 실행)만으로는 lastActiveAt이 바뀌지 않는다', () => {
  const r0 = base({ lastActiveAt: null });
  const r = runRetentionEngine(r0, ctxOf(), NOW);
  assert.equal(r.lastActiveAt, null);
  const r2 = runRetentionEngine(r, ctxOf(), new Date(NOW.getTime() + 3600000));
  assert.equal(r2.lastActiveAt, null);
});

// ── planNudges ───────────────────────────────────────────
function idleUser(days, cfg = DEFAULT_CONFIG, schedule = {}) {
  const ctx = ctxOf({ activities: lastActive(days), schedule });
  const now = at(TODAY, '22:00');
  return { r: runRetentionEngine(base(), ctx, now, cfg), ctx, now };
}

test('planNudges: 무활동 7·14·30일째 R1·R2·R3 각 1회, 30일 초과면 새로 만들지 않음(stopped)', () => {
  const { r } = idleUser(30);
  for (const t of ['R1', 'R2', 'R3']) assert.equal(r.nudges.filter((x) => x.type === t && x.sentAt).length, 1, t);
  const later = runRetentionEngine(base(), ctxOf({ activities: lastActive(45) }), at(TODAY, '22:00'));
  assert.ok(later.nudges.every((x) => !x.sentAt || Date.parse(x.sentAt) <= at(addDays(TODAY, -15), '12:00').getTime()));
  assert.ok(!later.nudges.some((x) => x.sentAt && x.type === 'A4_reminder'));
});

test('planNudges: 금지 구간(근무 중·수면 ±30분·퇴근 후 120분)은 cancel 정책에서 quiet_hours로 취소', () => {
  const r1Day = addDays(TODAY, -3); // 무활동 10일 → R1은 3일 전 12:00
  for (const [schedule, reason] of [
    [{ [r1Day]: 'day' }, 'work'],                                                   // 07~15 근무 중
    [{ [addDays(r1Day, -1)]: 'night' }, 'sleep'],                                  // 야간 후 08~15 수면
    [{ [r1Day]: 'day' }, 'work'],
  ]) {
    const { r } = idleUser(10, DEFAULT_CONFIG, schedule);
    const n = r.nudges.find((x) => x.type === 'R1');
    assert.equal(n.cancelledReason, 'quiet_hours');
    assert.equal(n.quietReason, reason);
    assert.ok(!n.sentAt);
  }
  // 퇴근 후 120분: 07~11시 주간 근무로 바꾸면 12:00은 퇴근 1시간 뒤
  const ctx = ctxOf({ activities: lastActive(10), schedule: { [r1Day]: 'day' }, workHours: { ...HOURS, day: { start: '05:00', end: '11:00' } } });
  const r = runRetentionEngine(base(), ctx, at(TODAY, '22:00'));
  assert.equal(r.nudges.find((x) => x.type === 'R1').quietReason, 'post_shift');
});

test('POLICY defer_same_day: 같은 날 다음 허용 정각으로 이월, 없으면 취소', () => {
  const cfg = withConfig({ POLICY: { QUIET_HOURS_ENGINE_NUDGE: 'defer_same_day' } });
  const r1Day = addDays(TODAY, -3);
  const { r } = idleUser(10, cfg, { [r1Day]: 'day' }); // 근무 07~15, 퇴근 후 17시까지 금지 → 17:00
  const n = r.nudges.find((x) => x.type === 'R1');
  assert.ok(n.sentAt);
  assert.equal(n.plannedAt, at(r1Day, '17:00').toISOString());
  const allDay = withConfig({ POLICY: { QUIET_HOURS_ENGINE_NUDGE: 'defer_same_day' } });
  const blocked = runRetentionEngine(base({ settings: { ...base().settings, quietHours: { start: '09:00', end: '22:00' } } }), ctxOf({ activities: lastActive(10) }), at(TODAY, '22:00'), allDay);
  assert.equal(blocked.nudges.find((x) => x.type === 'R1').cancelledReason, 'quiet_hours');
});

test('수용: 금지 구간에는 어떤 넛지도 발송되지 않는다', () => {
  for (const policy of ['cancel', 'defer_same_day']) {
    const cfg = withConfig({ POLICY: { QUIET_HOURS_ENGINE_NUDGE: policy } });
    for (let shiftDay = -30; shiftDay <= 0; shiftDay++) {
      const schedule = {};
      for (let d = -40; d <= 0; d++) schedule[addDays(TODAY, d)] = ['day', 'night', 'off', 'rest', 'evening'][((d + shiftDay) % 5 + 5) % 5];
      const ctx = ctxOf({ activities: lastActive(31), schedule });
      const r = runRetentionEngine(base(), ctx, at(TODAY, '23:59'), cfg);
      for (const x of r.nudges.filter((y) => y.sentAt && y.type !== 'scheduled_workout')) {
        assert.equal(quietReason(x.sentAt, r, ctx, cfg), null, `${policy} ${x.type} ${x.sentAt}`);
      }
    }
  }
});

test('수용: 같은 날 같은 유형 중복 없음 + 멱등(여러 번 호출해도 같음)', () => {
  const ctx = ctxOf({ activities: lastActive(8) });
  let r = base();
  for (let i = 0; i < 5; i++) r = runRetentionEngine(r, ctx, new Date(at(TODAY, '13:00').getTime() + i * 60000));
  const keys = r.nudges.map((x) => `${x.type}:${dateKey(x.plannedAt)}`);
  assert.equal(new Set(keys).size, keys.length);
  const again = planNudges(r, ctx, at(TODAY, '13:30'));
  assert.equal(again.nudges.length, r.nudges.length);
});

test('수용: 사용자 예약 운동 알림은 금지 구간·무활동 30일 이후에도 발송', () => {
  const remindAt = at(TODAY, '10:00').toISOString(); // 주간 근무 중
  const ctx = ctxOf({ activities: lastActive(40), fallback: 'day', scheduledWorkouts: [{ id: 'w1', plannedAt: remindAt, remindAt, status: 'unconfirmed', title: '퇴근 후 스트레칭' }] });
  const r = runRetentionEngine(base(), ctx, at(TODAY, '22:00'));
  const s = r.nudges.find((x) => x.type === 'scheduled_workout');
  assert.ok(s.sentAt);
  assert.equal(s.cancelledReason, undefined);
});

test('수용: 응원 3건을 받으면 묶음 알림 1건("○○님 외 2명")', () => {
  const r0 = base();
  r0.cheers = ['수진', '지현', '하늘'].map((name, i) => ({ id: `c${i}`, fromUser: `u${i}`, fromName: name, toUser: 'me', templateId: 'waiting', createdAt: at(TODAY, `0${i + 1}:00`).toISOString() }));
  const r = planNudges(r0, ctxOf({ activities: lastActive(1) }), at(TODAY, '18:00'));
  const bundles = r.nudges.filter((x) => x.type === 'cheer_bundle');
  assert.equal(bundles.length, 1);
  assert.equal(bundles[0].text, '수진님 외 2명이 응원을 보냈어요');
  assert.ok(bundles[0].sentAt);
});

test('opt_out: 이탈방지 알림을 끄면 R 알림은 opt_out으로 취소', () => {
  const r0 = base();
  r0.settings.engineNudges = false;
  const r = runRetentionEngine(r0, ctxOf({ activities: lastActive(8) }), at(TODAY, '22:00'));
  assert.equal(r.nudges.find((x) => x.type === 'R1').cancelledReason, 'opt_out');
});

test('알림함 표시 순서: 같은 시각이면 scheduled > cheer > R > A4 > event', () => {
  const t = at(TODAY, '12:00').toISOString();
  const order = sortInbox(['event', 'A4_reminder', 'R2', 'cheer_bundle', 'scheduled_workout'].map((type) => ({ id: type, type, sentAt: t })));
  assert.deepEqual(order.map((x) => x.type), ['scheduled_workout', 'cheer_bundle', 'R2', 'A4_reminder', 'event']);
});

// ── 배수 생성 ────────────────────────────────────────────
test('위험 배수: 연속 야간 다음 휴무일·가입 8~14일차에 생성, 활성 중이면 다시 만들지 않음', () => {
  const schedule = { [addDays(TODAY, -2)]: 'night', [addDays(TODAY, -1)]: 'night', [TODAY]: 'off' };
  const r = refreshMultipliers(base(), ctxOf({ schedule, fallback: 'day' }), NOW);
  assert.equal(r.multipliers[0].cause, 'after_nights');
  assert.equal(refreshMultipliers(r, ctxOf({ schedule, fallback: 'day' }), NOW).multipliers.length, 1);
  const fresh = refreshMultipliers(createRetention(at(addDays(TODAY, -9))), ctxOf({ fallback: 'day' }), NOW);
  assert.equal(fresh.multipliers[0].cause, 'new_user');
});

// ── 크루 데이터 제약 ─────────────────────────────────────
test('수용: 크루원에게 가는 데이터엔 위험 점수·휴면 기간·수면·피로·미실천 이유가 없다', () => {
  const r = base({ state: 'dormant', riskScore: 88, dormantSince: NOW.toISOString(), riskSignals: ['tired_streak'] });
  r.events = [act('lapse_reason', NOW, { reason: 'fatigue' }), act('condition_check', NOW, { level: 'tired' })];
  const view = crewPublicView(r, '민우', NOW);
  assert.deepEqual(Object.keys(view).sort(), ['cheersReceived', 'nickname', 'recommendCheer']);
  assert.equal(view.recommendCheer, true);
  const text = JSON.stringify(view);
  for (const banned of ['risk', 'dormant', 'sleep', 'fatigue', 'tired', 'lapse', 'reason', '88']) assert.ok(!text.includes(banned), banned);
});

// ── 화면 파생 ────────────────────────────────────────────
test('5분 플랜: 70점 이상 또는 피곤함 연속이면 노출, 거절 후 7일 미노출', () => {
  assert.ok(fiveMinPlanVisible(base({ riskScore: 70, riskSignals: [] }), NOW));
  assert.ok(fiveMinPlanVisible(base({ riskScore: 10, riskSignals: ['tired_streak'] }), NOW));
  assert.ok(!fiveMinPlanVisible(base({ riskScore: 80, riskSignals: [], fiveMinPlan: { active: false, declinedAt: at(addDays(TODAY, -6)).toISOString() } }), NOW));
  assert.ok(fiveMinPlanVisible(base({ riskScore: 80, riskSignals: [], fiveMinPlan: { active: false, declinedAt: at(addDays(TODAY, -7)).toISOString() } }), NOW));
});

// ── 6장 시나리오 프리셋 ──────────────────────────────────
test('프리셋 1 위험 진입: watch + ×1.2 배지', () => {
  const { world, now } = PRESETS[0].run(at(TODAY, '12:00'));
  assert.equal(world.r.state, 'watch');
  const badge = statusBadge(world.r, demoCtx(world), now);
  assert.equal(badge.kind, 'watch');
  assert.match(badge.text, /1\.2배/);
});

test('프리셋 2 휴면 → 복귀: R1·응원 묶음 1건 → returning 1/3', () => {
  const { world, now } = PRESETS[1].run(at(TODAY, '12:00'));
  assert.ok(world.r.nudges.find((x) => x.type === 'R1').sentAt);
  assert.equal(world.r.nudges.filter((x) => x.type === 'cheer_bundle').length, 1);
  assert.equal(world.r.state, 'returning');
  assert.match(statusBadge(world.r, demoCtx(world), now).text, /복귀 1\/3일차 · 지금 포인트 ×1\.2/);
});

test('프리셋 3 복귀 완료: active + 200P + 배지', () => {
  const { world, now } = PRESETS[2].run(at(TODAY, '12:00'));
  assert.equal(world.r.state, 'active');
  assert.equal(world.r.ledger.filter((e) => e.kind === 'return_complete').reduce((s, e) => s + e.amount, 0), 200);
  assert.equal(statusBadge(world.r, demoCtx(world), now).kind, 'complete');
});
