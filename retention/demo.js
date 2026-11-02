// 날짜 시뮬레이터(명세 6장)용 데모 세계와 시나리오 프리셋. 실제 사용자 기록은 건드리지 않는다.
// 데모 세계 = { r, activities(운동·수면처럼 기존 기록에서 오는 활동), schedule{dateKey: shift}, now }

import {
  createRetention, runRetentionEngine, logActivity, dateKey, addDays, atKst,
} from './engine.js';
import { DEFAULT_CONFIG, STATE_LABELS } from './constants.js';

export const DEMO_CREW = [
  { id: 'crew-sujin', name: '수진' },
  { id: 'crew-jihyun', name: '지현' },
  { id: 'crew-haneul', name: '하늘' },
  { id: 'crew-minwoo', name: '민우' },
];

// 크루원 화면 데모: 응원 추천 대상 여부는 엔진이 만든 공개 필드만 쓴다.
export const DEMO_CREW_STATES = [
  { nickname: '민우', recommendCheer: true, cheersReceived: 1 },
  { nickname: '지현', recommendCheer: false, cheersReceived: 4 },
  { nickname: '수진', recommendCheer: false, cheersReceived: 2 },
];

export const DEFAULT_WORK_HOURS = {
  day: { start: '07:00', end: '15:00' },
  evening: { start: '15:00', end: '23:00' },
  night: { start: '23:00', end: '07:00' },
};

const PATTERN = ['day', 'night', 'off', 'rest'];

export function demoCtx(world) {
  const anchor = world.cycleStartKey;
  return {
    activities: world.activities,
    shiftOn: (k) => world.schedule[k] || PATTERN[(((Math.round((Date.parse(`${k}T00:00:00Z`) - Date.parse(`${anchor}T00:00:00Z`)) / 86400000)) % 4) + 4) % 4],
    workHours: DEFAULT_WORK_HOURS,
    crewMember: true,
    cycleLength: 4,
    cycleStartKey: anchor,
    scheduledWorkouts: [],
  };
}

let seq = 0;
const id = (p) => `${p}-${(++seq).toString(36)}`;

function activity(type, at, meta) {
  return { id: id(type), type, occurredAt: new Date(at).toISOString(), ...(meta ? { meta } : {}) };
}

// 가입 40일 전, 일주일에 4일쯤 꾸준히 쓰던 사용자
// recent=true면 어제까지 꾸준히 쓴 활성 사용자로 시작(시뮬레이터 기본값)
export function createDemoWorld(now, { recent = false } = {}) {
  const today = dateKey(now);
  const world = {
    cycleStartKey: addDays(today, -40),
    schedule: {},
    activities: [],
    r: createRetention(atKst(addDays(today, -40), '09:00')),
    now: new Date(now).toISOString(),
  };
  for (let d = -40; d <= (recent ? -1 : -8); d++) {
    if ([0, 1, 3, 5].includes(((d % 7) + 7) % 7)) {
      world.activities.push(activity('sleep_logged', atKst(addDays(today, d), '10:00')));
      if (d % 2 === 0) world.activities.push(activity('workout_done', atKst(addDays(today, d), '17:00')));
    }
  }
  return world;
}

export function runWorld(world, now, cfg = DEFAULT_CONFIG) {
  world.now = new Date(now).toISOString();
  world.r = runRetentionEngine(world.r, demoCtx(world), new Date(now), cfg);
  simulateCrewCheers(world, new Date(now));
  world.r = runRetentionEngine(world.r, demoCtx(world), new Date(now), cfg);
  return world;
}

// 기존 기록(운동·수면)처럼 world.activities에 넣거나, 새 활동이면 r.events로 들어간다.
export function worldLog(world, type, now, meta, cfg = DEFAULT_CONFIG) {
  const act = activity(type, now, meta);
  if (type === 'workout_done' || type === 'sleep_logged') world.activities.push(act);
  const result = logActivity(world.r, act, demoCtx(world), new Date(now), cfg);
  world.r = result.r;
  world.now = new Date(now).toISOString();
  return result;
}

// R1 응원 요청이 나가면 데모 크루 3명이 몇 시간 안에 응원을 보낸다(로컬 시뮬레이션)
export function simulateCrewCheers(world, now) {
  for (const n of world.r.nudges) {
    if (n.type !== 'R1' || !n.crewRequest || n.cheersSimulated) continue;
    // 금지 구간으로 R1 알림이 취소돼도 크루 화면 추천은 R1 시점에 노출된다(4.7)
    const base = Date.parse(n.plannedAt);
    if (base > now.getTime()) continue;
    n.cheersSimulated = true;
    DEMO_CREW.slice(0, 3).forEach((m, i) => {
      world.r.cheers.push({
        id: `cheer-${m.id}-${base}`,
        fromUser: m.id,
        fromName: m.name,
        toUser: 'me',
        templateId: ['waiting', 'five_together', 'slowly'][i],
        createdAt: new Date(base + (i + 1) * 3600000).toISOString(),
      });
    });
  }
}

// ── 시나리오 프리셋 ────────────────────────────────────────
// 1. 위험 진입: 야간 3연속 후 휴무 2일 무기록 → watch + ×1.2 배지
export function presetRiskEntry(baseNow, cfg = DEFAULT_CONFIG) {
  const world = createDemoWorld(baseNow);
  const today = dateKey(baseNow);
  const steps = [];
  ['night', 'night', 'night'].forEach((s, i) => { world.schedule[addDays(today, -5 + i)] = s; });
  world.schedule[addDays(today, -6)] = 'day';
  world.schedule[addDays(today, -2)] = 'off';
  world.schedule[addDays(today, -1)] = 'rest';
  world.schedule[today] = 'off';
  world.activities.push(activity('workout_done', atKst(addDays(today, -6), '17:00')));
  world.r.scheduleEvents.push({ type: 'override_edit', at: atKst(addDays(today, -6), '20:00').toISOString(), count: 3 });
  const now = atKst(today, '10:00');
  runWorld(world, now, cfg);
  steps.push(`야간 3연속(${addDays(today, -5)}~${addDays(today, -3)}) 뒤 휴무 2일 무기록 → 상태 ${STATE_LABELS[world.r.state]}, 위험 ${world.r.riskScore}`);
  return { world, now, steps };
}

// 2. 휴면 → 복귀: 마지막 활동 +7일(R1·응원 묶음) → 활동 1건 → returning 1/3
export function presetDormantReturn(baseNow, cfg = DEFAULT_CONFIG) {
  const world = createDemoWorld(baseNow);
  const today = dateKey(baseNow);
  const steps = [];
  const lastKey = addDays(today, -8);
  world.activities.push(activity('sleep_logged', atKst(lastKey, '10:00')));
  for (let d = -9; d <= 1; d++) world.schedule[addDays(today, d)] = 'off';
  runWorld(world, atKst(addDays(lastKey, 3), '10:00'), cfg);
  const r1Day = addDays(lastKey, 7);
  runWorld(world, atKst(r1Day, '12:30'), cfg);
  const r1 = world.r.nudges.find((n) => n.type === 'R1');
  steps.push(`무활동 7일째(${r1Day}) → 상태 ${STATE_LABELS[world.r.state]}, R1 ${r1?.sentAt ? '발송' : `취소(${r1?.cancelledReason})`}`);
  const nextMorning = atKst(addDays(r1Day, 1), '10:00');
  runWorld(world, nextMorning, cfg);
  const bundle = world.r.nudges.find((n) => n.type === 'cheer_bundle');
  steps.push(`다음 날 응원 묶음 1건: "${bundle?.text}" (${bundle?.sentAt ? '발송' : '대기'})`);
  const result = worldLog(world, 'condition_check', new Date(nextMorning.getTime() + 15 * 60000), { level: 'ok' }, cfg);
  steps.push(`컨디션 체크 1건 → 상태 ${STATE_LABELS[world.r.state]}, +${result.entry?.amount}P (${result.entry?.note})`);
  return { world, now: new Date(nextMorning.getTime() + 15 * 60000), steps };
}

// 3. 복귀 완료: 복귀 후 3일 체크인 → active + 200P + 배지
export function presetReturnComplete(baseNow, cfg = DEFAULT_CONFIG) {
  const { world, now: start, steps } = presetDormantReturn(baseNow, cfg);
  let now = start;
  for (let i = 1; i <= 2; i++) {
    now = new Date(now.getTime() + 86400000);
    runWorld(world, now, cfg);
    const r = worldLog(world, i === 1 ? 'sleep_logged' : 'workout_done', now, undefined, cfg);
    steps.push(`복귀 ${i + 1}일차 기록 → 상태 ${STATE_LABELS[world.r.state]}, +${r.entry?.amount}P (${r.entry?.note})${r.bonuses.map((b) => ` · 보너스 +${b.amount}P(${b.note})`).join('')}`);
  }
  return { world, now, steps };
}

export const PRESETS = [
  { id: 'risk', label: '위험 진입', run: presetRiskEntry },
  { id: 'return', label: '휴면 → 복귀', run: presetDormantReturn },
  { id: 'complete', label: '복귀 완료', run: presetReturnComplete },
];
