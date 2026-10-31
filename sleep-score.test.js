const assert = require('node:assert/strict');
const S = require('./sleep-score.js');

// NSF 기준 경계
assert.equal(S.nsfScore(30, S.NSF.latencyMin), 100);
assert.equal(S.nsfScore(45, S.NSF.latencyMin), 0);
assert.equal(S.nsfScore(85, S.NSF.efficiencyPct), 100);
assert.equal(S.nsfScore(64, S.NSF.efficiencyPct), 0);
assert.equal(S.nsfScore(1, S.NSF.awakenings), 100);

// 1. 좋은 밤: 7.5h, 잠들기 10분, 깸 10분, 1회, 만족 9, 피로 2 → 4영역 모두, 높은 점수
{
  const r = S.scoreSleep({ date: '2026-10-30', sleepMinutes: 450, latencyMin: 10, wasoMin: 10, awakenings: 1, satisfaction: 9, fatigue: 2 });
  assert.equal(r.confidence, 'high');
  assert.ok(r.score >= 90, `score=${r.score}`);
  console.log('1 ok', r.score, r.domains);
}

// 2. 야간근무 후 낮 수면 5h + 낮잠 90분 → 24h 합계 6.5h로 계산
{
  const withNap = S.scoreSleep({ date: '2026-10-30', sleepMinutes: 300, napMinutes: 90, satisfaction: 5, fatigue: 6, shiftBefore: '야간' });
  const noNap = S.scoreSleep({ date: '2026-10-30', sleepMinutes: 300, satisfaction: 5, fatigue: 6, shiftBefore: '야간' });
  assert.equal(withNap.totalSleepMinutes, 390);
  assert.ok(withNap.score > noNap.score);
  console.log('2 ok', noNap.score, '→', withNap.score);
}

// 3. 수면 단계는 점수에 영향 없음
{
  const base = { date: '2026-10-30', sleepMinutes: 420, satisfaction: 7, fatigue: 4 };
  assert.equal(S.scoreSleep(base).score, S.scoreSleep({ ...base, stages: { deep: 5, rem: 40 } }).score);
  console.log('3 ok');
}

// 4. 9시간 넘게 자도 감점 없음
{
  const r = S.scoreSleep({ date: '2026-10-30', sleepMinutes: 600, satisfaction: 8, fatigue: 2 });
  assert.equal(r.domains.duration, 100);
  console.log('4 ok');
}

// 5. 연속 야간근무 3일 → 누적 부족 경고 + quick return 경고
{
  const recs = [
    { date: '2026-10-28', sleepMinutes: 330, satisfaction: 5, fatigue: 6, shiftBefore: '야간' },
    { date: '2026-10-29', sleepMinutes: 320, satisfaction: 5, fatigue: 6, shiftBefore: '야간' },
    { date: '2026-10-30', sleepMinutes: 340, satisfaction: 4, fatigue: 7, shiftBefore: '야간' },
  ];
  const e = S.evaluateSleepDay(recs, '2026-10-30', { restHoursBeforeNextShift: 9 });
  const keys = e.flags.map((f) => f.key);
  assert.ok(keys.includes('sleepDebt'));
  assert.ok(keys.includes('quickReturn'));
  assert.equal(e.sleepDebt.debtMinutes, 270);
  console.log('5 ok', e.score, e.flags.map((f) => f.text));
}

// 6. 근무 유형별 기준선
{
  const recs = [];
  for (let i = 1; i <= 6; i++) recs.push({ date: `2026-10-${String(i).padStart(2, '0')}`, sleepMinutes: 330, satisfaction: 5, fatigue: 6, shiftBefore: '야간' });
  recs.push({ date: '2026-10-10', sleepMinutes: 330, satisfaction: 5, fatigue: 6, shiftBefore: '야간' });
  const e = S.evaluateSleepDay(recs, '2026-10-10');
  assert.equal(e.shiftBaseline.shiftType, '야간');
  assert.equal(e.shiftBaseline.n, 6);
  console.log('6 ok', e.shiftBaseline);
}

// 7. 규칙성: 야간 후 08:30 전후, 휴무 23:00 전후 → 근무 유형별로 따로 계산, 자정 넘김 처리
{
  const recs = [
    { date: '2026-10-20', sleepStart: '08:30', shiftBefore: '야간', sleepMinutes: 330 },
    { date: '2026-10-21', sleepStart: '09:00', shiftBefore: '야간', sleepMinutes: 330 },
    { date: '2026-10-22', sleepStart: '11:30', shiftBefore: '야간', sleepMinutes: 300 },
    { date: '2026-10-24', sleepStart: '23:30', shiftBefore: '휴무', sleepMinutes: 480 },
    { date: '2026-10-25', sleepStart: '00:10', shiftBefore: '휴무', sleepMinutes: 470 },
  ];
  const w = S.weeklySleepHealth(recs, '2026-10-26');
  assert.equal(w.perShift['휴무'].regularPct, 100);
  assert.equal(w.perShift['야간'].regularPct, 67);
  console.log('7 ok', w);
}

// 8. 기록 부족 → 점수 없음
assert.equal(S.scoreSleep({ date: '2026-10-30', satisfaction: 7 }).score, null);

// 9. 오늘 컨디션은 최근 수면 점수를 사용하고, 낮은 자기 보고는 낮음 단계로 제한
{
  const now = new Date('2026-10-31T08:00:00+09:00');
  const records = [{ date: '2026-10-31', sleepMinutes: 420, satisfaction: 9, fatigue: 2 }];
  const comfortable = S.scoreTodayCondition(records, null, now);
  const low = S.scoreTodayCondition(records, 'low', now);
  assert.equal(comfortable.score, 93);
  assert.equal(comfortable.grade, '좋음');
  assert.equal(low.score, 54);
  assert.equal(low.grade, '낮음');
}

// 10. 오래된 기록과 점수 계산에 부족한 기록은 오늘 점수로 사용하지 않음
{
  const now = new Date('2026-10-31T08:00:00+09:00');
  assert.equal(S.scoreTodayCondition([{ date: '2026-10-29', sleepMinutes: 420, satisfaction: 8 }], null, now).reason, 'stale');
  assert.equal(S.scoreTodayCondition([{ date: '2026-10-31', satisfaction: 8 }], null, now).reason, 'insufficient');
  assert.equal(S.scoreTodayCondition([], null, now).reason, 'missing');
}
console.log('today condition tests passed');
console.log('all sleep tests passed');
