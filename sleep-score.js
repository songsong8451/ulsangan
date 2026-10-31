/**
 * ShiftFit 수면 점수 (100점) — 교대근무자용 보완판
 * ------------------------------------------------------------
 * 하루 점수는 4개 영역을 25점씩 같은 비중으로 합산합니다.
 *  1) 수면 시간(24시간 합계, 낮잠 포함)  — Watson 외 2015 AASM/SRS: 성인 7시간 이상,
 *     교대근무자는 "24시간당 7시간 이상". RU-SATED Duration(7~9시간).
 *  2) 수면 연속성(잠들기까지 시간·중간 깸·깬 횟수·수면 효율) — Ohayon 외 2017 NSF 수면 질 권고의
 *     '좋음/나쁨' 기준값.
 *  3) 수면 만족도(1~10) — RU-SATED Satisfaction, 단일 문항 수면 질 척도(Snyder 외 2018).
 *  4) 회복감(기상 후 피로도 1~10, 역채점) — 야간근무 후 '개운하지 않은 수면'이 흔함
 *     (야간근무 후 수면 연구, PMC8527589).
 * 같은 비중 합산은 RU-SATED가 6개 차원을 같은 배점(0~2점)으로 더하는 방식을 따른 것입니다.
 *
 * 하루 점수에 넣지 않는 것
 *  - 수면 단계(깊은 잠·렘 %): NSF 패널은 수면 구조를 수면 질 지표로 합의하지 못했고,
 *    소비자용 기기의 단계 판정은 제품마다 편차가 큼(Lee 외 2023, Chinoy 외 2021). 참고 표시만.
 *  - 수면 시각(Timing)·규칙성(Regularity): 근무표가 정하는 부분이라 하루 점수에서 빼고
 *    '주간 수면 건강' 지표로 따로 보여 줍니다(Windred 외 2024: 규칙성이 사망 위험을 수면 시간보다
 *    더 잘 예측).
 *
 * 컨텍스트 경고(점수와 별도)
 *  - 근무 간 휴식 11시간 미만(quick return) — Vedaa 외 2016 체계적 고찰.
 *  - 최근 3일 누적 수면 부족 — 야간근무가 이어져도 수면이 늘지 않아 부족분이 쌓임.
 *  - 낮은 점수가 오래 지속 — 교대근무 수면장애는 증상이 3개월 이상일 때 진단 기준에 해당.
 *
 * DESIGN 안의 값은 논문에 정해진 값이 아니라 앱 설계값입니다.
 */

const NSF = {
  // [좋음 기준, 나쁨 기준] — 좋음 이하(또는 이상)면 100점, 나쁨이면 0점, 사이는 직선
  latencyMin: [30, 45],
  wasoMin: [20, 41],
  awakenings: [1, 4],
  efficiencyPct: [85, 64],
};

const DESIGN = {
  durationPoints: [[240, 0], [360, 60], [420, 100]], // 4h=0, 6h=60, 7h 이상=100
  dailyTargetMin: 420, // 24시간당 7시간
  debtDays: 3,
  debtWarnMin: 180, // 3일 누적 3시간 이상 부족하면 경고
  quickReturnHours: 11,
  regularityWindowMin: 60, // RU-SATED: 같은 시각 ±1시간
  regularityDays: 14,
  shiftBaselineMinRecords: 4,
  lowScore: 50,
  lowStreakDays: 14, // 2주 평균이 낮으면 상담 안내
  minDomainsForScore: 2,
};

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;

function interpolate(points, x) {
  if (x <= points[0][0]) return points[0][1];
  for (let i = 1; i < points.length; i++) {
    const [x0, y0] = points[i - 1], [x1, y1] = points[i];
    if (x <= x1) return y0 + ((x - x0) / (x1 - x0)) * (y1 - y0);
  }
  return points[points.length - 1][1];
}

/** NSF 기준 사이를 0~100으로 (good이 작을수록 좋은 항목과 클수록 좋은 항목 모두 처리) */
function nsfScore(value, [good, poor]) {
  if (!isNum(value)) return null;
  if (good < poor) return clamp(((poor - value) / (poor - good)) * 100, 0, 100);
  return clamp(((value - poor) / (good - poor)) * 100, 0, 100);
}

function totalSleepMinutes(r) {
  if (!isNum(r?.sleepMinutes)) return null;
  return r.sleepMinutes + (isNum(r.napMinutes) ? r.napMinutes : 0);
}

function domainScores(r) {
  const d = {};
  const total = totalSleepMinutes(r);
  if (total !== null) d.duration = interpolate(DESIGN.durationPoints, total);

  const efficiency = isNum(r.efficiencyPct)
    ? r.efficiencyPct
    : isNum(r.inBedMinutes) && r.inBedMinutes > 0 && isNum(r.sleepMinutes)
      ? (r.sleepMinutes / r.inBedMinutes) * 100
      : null;
  const cont = [
    nsfScore(r.latencyMin, NSF.latencyMin),
    nsfScore(r.wasoMin, NSF.wasoMin),
    nsfScore(r.awakenings, NSF.awakenings),
    nsfScore(efficiency, NSF.efficiencyPct),
  ].filter(isNum);
  if (cont.length) d.continuity = mean(cont);

  if (isNum(r.satisfaction)) d.satisfaction = ((clamp(r.satisfaction, 1, 10) - 1) / 9) * 100;
  if (isNum(r.fatigue)) d.restoration = ((10 - clamp(r.fatigue, 1, 10)) / 9) * 100;
  return d;
}

/**
 * 수면 기록 1건 → 100점
 * record: {date, sleepMinutes, satisfaction, fatigue,               // 기존 필드
 *          napMinutes?, latencyMin?, wasoMin?, awakenings?,          // 추가 필드(선택)
 *          inBedMinutes? | efficiencyPct?, sleepStart?('HH:MM'),
 *          shiftBefore?('주간'|'오후'|'야간'|'비번'|'휴무'), source?('self'|'wearable'), stages?}
 */
function scoreSleep(r) {
  const d = domainScores(r || {});
  const keys = Object.keys(d);
  const notes = [];
  if (keys.length < DESIGN.minDomainsForScore) {
    return { score: null, domains: d, confidence: 'none', notes: ['두 가지 이상 입력해야 점수를 계산해요.'] };
  }
  const score = Math.round(mean(Object.values(d)));
  const confidence = keys.length === 4 ? 'high' : keys.length === 3 ? 'medium' : 'low';
  if (!('continuity' in d)) notes.push('잠들기까지 걸린 시간·중간에 깬 시간을 입력하면 더 정확해요.');
  if (r.source === 'wearable' && 'continuity' in d) notes.push('웨어러블은 깨어 있는 시간을 적게 잡는 경향이 있어 연속성 점수가 실제보다 좋게 나올 수 있어요.');
  if (r.stages) notes.push('수면 단계 비율은 참고용으로만 보여 주고 점수에는 넣지 않아요.');
  if (r.shiftBefore === '야간') notes.push('야간근무 후 낮잠은 생체리듬상 짧아지기 쉬워요. 낮잠을 더해 24시간 합계로 계산했어요.');
  const total = totalSleepMinutes(r);
  if (isNum(total) && total > 540) notes.push('9시간 넘게 잤어요. 수면 부족을 회복하는 중이면 자연스러운 일이라 감점하지 않았어요.');
  return { score, domains: roundAll(d), confidence, totalSleepMinutes: total, notes };
}

const roundAll = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, Math.round(v)]));
const byDateDesc = (a, b) => b.date.localeCompare(a.date);

/** 최근 n일(기준일 포함) 누적 수면 부족(분). 기록 없는 날은 계산에서 뺍니다. */
function sleepDebt(records, endDate, days = DESIGN.debtDays) {
  const end = new Date(`${endDate}T00:00:00Z`).getTime();
  const recent = records.filter((r) => {
    const t = new Date(`${r.date}T00:00:00Z`).getTime();
    return t <= end && t > end - days * 86400000;
  });
  const debt = recent.reduce((sum, r) => {
    const total = totalSleepMinutes(r);
    return isNum(total) ? sum + Math.max(0, DESIGN.dailyTargetMin - total) : sum;
  }, 0);
  return { debtMinutes: Math.round(debt), daysCounted: recent.length };
}

const toMin = (hhmm) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || ''));
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};
// 자정을 넘는 시각 차이(원형 거리)
const circDiff = (a, b) => { const d = Math.abs(a - b) % 1440; return Math.min(d, 1440 - d); };

/**
 * 주간 수면 건강: 규칙성
 * 같은 근무 유형 뒤의 주수면끼리 비교해 '평소 시작 시각 ±60분 안에 잠든 비율'을 셉니다.
 * 교대근무자는 근무표 때문에 매일 같은 시각에 자기 어려우므로, 근무 유형별로 따로 봅니다(설계 판단).
 */
function weeklySleepHealth(records, endDate) {
  const end = new Date(`${endDate}T00:00:00Z`).getTime();
  const recent = records.filter((r) => {
    const t = new Date(`${r.date}T00:00:00Z`).getTime();
    return t <= end && t > end - DESIGN.regularityDays * 86400000;
  });
  const groups = {};
  recent.forEach((r) => {
    const s = toMin(r.sleepStart);
    if (s === null) return;
    (groups[r.shiftBefore || '기타'] ||= []).push(s);
  });
  const perShift = {};
  let inWindow = 0, counted = 0;
  Object.entries(groups).forEach(([shift, starts]) => {
    if (starts.length < 2) return;
    // 평소 시작 시각 = 다른 날들과의 시각 차이 합이 가장 작은 날(중앙값 성격, 하루 튄 날에 덜 흔들림)
    const usual = starts.reduce((best, m) => {
      const cost = starts.reduce((s, o) => s + circDiff(m, o), 0);
      return cost < best.cost ? { m, cost } : best;
    }, { m: starts[0], cost: Infinity }).m;
    const hits = starts.filter((m) => circDiff(m, usual) <= DESIGN.regularityWindowMin).length;
    perShift[shift] = { usualStart: `${String(Math.floor(usual / 60)).padStart(2, '0')}:${String(usual % 60).padStart(2, '0')}`, regularPct: Math.round((hits / starts.length) * 100), n: starts.length };
    inWindow += hits; counted += starts.length;
  });
  const scores = recent.map(scoreSleep).map((s) => s.score).filter(isNum);
  return {
    regularityPct: counted ? Math.round((inWindow / counted) * 100) : null,
    perShift,
    avgDailyScore: scores.length ? Math.round(mean(scores)) : null,
    daysWithRecords: recent.length,
  };
}

/** 같은 근무 유형 뒤의 평소 점수와 비교 */
function shiftBaseline(records, record) {
  if (!record?.shiftBefore) return null;
  const same = records.filter((r) => r !== record && r.date < record.date && r.shiftBefore === record.shiftBefore)
    .sort(byDateDesc).slice(0, 28).map(scoreSleep).map((s) => s.score).filter(isNum);
  if (same.length < DESIGN.shiftBaselineMinRecords) return null;
  return { shiftType: record.shiftBefore, mean: Math.round(mean(same)), n: same.length };
}

/**
 * 하루 평가 전체: 점수 + 근무 유형 기준 비교 + 경고
 * ctx: {restHoursBeforeNextShift?}
 */
function evaluateSleepDay(records, date, ctx = {}) {
  const record = records.find((r) => r.date === date) || null;
  const result = record ? scoreSleep(record) : { score: null, domains: {}, confidence: 'none', notes: ['이날 수면 기록이 없어요.'] };
  const flags = [];
  const debt = sleepDebt(records, date);
  if (debt.daysCounted >= 2 && debt.debtMinutes >= DESIGN.debtWarnMin) {
    flags.push({ key: 'sleepDebt', text: `최근 ${debt.daysCounted}일 동안 7시간 기준으로 ${Math.floor(debt.debtMinutes / 60)}시간 ${debt.debtMinutes % 60}분 부족해요. 쉬는 날 회복 수면이나 근무 전 낮잠을 고려하세요.` });
  }
  if (isNum(ctx.restHoursBeforeNextShift) && ctx.restHoursBeforeNextShift < DESIGN.quickReturnHours) {
    flags.push({ key: 'quickReturn', text: `다음 근무까지 ${ctx.restHoursBeforeNextShift}시간이에요. 11시간 미만 휴식은 수면 부족·피로와 관련이 있어 잠잘 시간을 먼저 확보하세요.` });
  }
  const twoWeeks = records.filter((r) => r.date <= date).sort(byDateDesc).slice(0, DESIGN.lowStreakDays).map(scoreSleep).map((s) => s.score).filter(isNum);
  if (twoWeeks.length >= 10 && mean(twoWeeks) < DESIGN.lowScore) {
    flags.push({ key: 'persistentLow', text: '2주 넘게 수면 점수가 낮아요. 잠들기 어렵거나 근무 중 졸림이 몇 달째 이어진다면 수면 전문의와 상담해 보세요.' });
  }
  return { date, ...result, shiftBaseline: record ? shiftBaseline(records, record) : null, sleepDebt: debt, flags };
}

const api = { NSF, DESIGN, scoreSleep, evaluateSleepDay, sleepDebt, weeklySleepHealth, shiftBaseline, nsfScore };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
if (typeof window !== 'undefined') window.ShiftFitSleep = api;
