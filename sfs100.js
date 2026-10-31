// ShiftFit Sleep Score (SFS-100) v2 — 점수 + 해설 + 권고
// 외부 의존성 없음. 시간 값은 Date 또는 ISO 문자열("2026-10-30T08:30").

const H = 3600 * 1000;
const toDate = (v) => (v instanceof Date ? v : new Date(v));
const hoursBetween = (a, b) => (toDate(b) - toDate(a)) / H;
const r1 = (v) => Math.round(v * 10) / 10;

export const MAX = { duration: 30, alertness: 20, satisfaction: 15, timing: 15, efficiency: 10, regularity: 10 };
export const LABEL = {
  duration: "수면 시간", alertness: "기상 후 회복감", satisfaction: "수면 만족도",
  timing: "근무 연계 타이밍", efficiency: "효율·연속성", regularity: "규칙성",
};

// ── 영역별 점수 ─────────────────────────────────────────────
export function durationPts(tstH, firstOffAfterNights = false) {
  if (tstH < 4) return 0;
  if (tstH < 7) return (tstH - 4) * 10;
  if (tstH <= 9) return 30;
  if (tstH < 10) return firstOffAfterNights ? 30 : 30 - (tstH - 9) * 6;
  return firstOffAfterNights ? 30 : 20;
}
export const alertPts = (fatigue) => {
  const value = Number(fatigue);
  if (!Number.isFinite(value)) return 0;
  // 1 means rested and earns more points; 10 means very tired and earns fewer.
  return ((10 - Math.max(1, Math.min(10, value))) / 9) * 20;
};
export const satisPts = (sat) => ((sat - 1) / 9) * 15;

export function timingPts({ restGapH, shiftType, onsetAfterShiftEndH, preNightNap, nightWindowShare }) {
  let p = restGapH >= 11 ? 8 : restGapH >= 9 ? 4 : 0;
  if (shiftType === "night") {
    if (onsetAfterShiftEndH != null && onsetAfterShiftEndH <= 2) p += 4;
    if (preNightNap) p += 3;
  } else if (nightWindowShare != null && nightWindowShare >= 0.5) {
    p += 7;
  }
  return p;
}
export function effPts(wasoMin, efficiencyPct) {
  const c = [];
  if (wasoMin != null) c.push(wasoMin <= 20 ? 10 : wasoMin <= 40 ? 6 : 2);
  if (efficiencyPct != null) c.push(efficiencyPct >= 85 ? 10 : efficiencyPct >= 65 ? 5 : 0);
  return c.length ? Math.min(...c) : null;
}
export function regPts(onsetDiffMin, sameTypeDays) {
  if (sameTypeDays < 2 || onsetDiffMin == null) return 7;
  return onsetDiffMin <= 60 ? 10 : onsetDiffMin <= 120 ? 6 : 2;
}
export const grade = (s) =>
  s >= 85 ? "충분히 회복" : s >= 70 ? "보통" : s >= 50 ? "회복 부족" : "회복 필요";

// ── 보조 계산 ─────────────────────────────────────────────
function nightWindowShare(start, end) {
  const s = toDate(start), e = toDate(end);
  let overlap = 0;
  for (let d = -1; d <= 1; d++) {
    const ws = new Date(s); ws.setHours(22, 0, 0, 0); ws.setDate(ws.getDate() + d);
    const we = new Date(ws.getTime() + 10 * H);
    overlap += Math.max(0, Math.min(e, we) - Math.max(s, ws));
  }
  return overlap / (e - s);
}
const minutesOfDay = (d) => { d = toDate(d); return d.getHours() * 60 + d.getMinutes(); };
function signedCircDiff(a, b) { let d = (a - b) % 1440; if (d > 720) d -= 1440; if (d < -720) d += 1440; return d; }
export const fmtHM = (h) => {
  const m = Math.round(h * 60); const hh = Math.floor(m / 60), mm = m % 60;
  return hh && mm ? `${hh}시간 ${mm}분` : hh ? `${hh}시간` : `${mm}분`;
};

/**
 * 수면 기록 1건 채점
 * record: { sleepStart?, sleepEnd?, totalMinutes?, naps?:[{start, minutes}], satisfaction?, fatigue?,
 *           wasoMin?, efficiencyPct?, shiftType?, prevShiftEnd?, nextShiftStart?, firstOffAfterNights? }
 *   - 기존 기록처럼 시각 없이 totalMinutes만 있으면 ‘간이 채점’(시간·회복감·만족도·효율만)
 * history: 이 기록 이전 7일 기록 배열
 */
export function scoreSleep(record, history = []) {
  const naps = record.naps || [];
  const napH = naps.reduce((s, n) => s + n.minutes / 60, 0);
  const hasTimes = !!(record.sleepStart && record.sleepEnd);
  const mainH = hasTimes ? hoursBetween(record.sleepStart, record.sleepEnd)
    : record.totalMinutes != null ? record.totalMinutes / 60 : null;
  if (mainH == null) return null;
  if (record.fatigue == null && record.satisfaction == null) return null;   // 추정하지 않음
  const tstH = mainH + napH;

  const parts = {}, ctx = { tstH, hasTimes, shiftType: record.shiftType || null };
  parts.duration = durationPts(tstH, record.firstOffAfterNights);
  if (record.fatigue != null) parts.alertness = alertPts(record.fatigue);
  if (record.satisfaction != null) parts.satisfaction = satisPts(record.satisfaction);

  if (hasTimes && record.shiftType) {
    ctx.restGapH = record.prevShiftEnd && record.nextShiftStart
      ? hoursBetween(record.prevShiftEnd, record.nextShiftStart) : null;
    ctx.onsetAfterShiftEndH = record.prevShiftEnd ? hoursBetween(record.prevShiftEnd, record.sleepStart) : null;
    ctx.preNightNap = record.shiftType === "night" && !!record.nextShiftStart &&
      naps.some((n) => { const g = hoursBetween(n.start, record.nextShiftStart); return g > 0 && g <= 4; });
    ctx.nightWindowShare = nightWindowShare(record.sleepStart, record.sleepEnd);
    parts.timing = timingPts({ ...ctx, restGapH: ctx.restGapH ?? 11 });

    const same = history.filter((h) => h.shiftType === record.shiftType && h.sleepStart);
    if (same.length >= 2) {
      const ang = same.map((h) => (minutesOfDay(h.sleepStart) / 1440) * 2 * Math.PI);
      const avg = Math.atan2(ang.reduce((s, a) => s + Math.sin(a), 0), ang.reduce((s, a) => s + Math.cos(a), 0));
      const avgMin = (((avg / (2 * Math.PI)) * 1440) + 1440) % 1440;
      ctx.onsetShiftMin = Math.round(signedCircDiff(minutesOfDay(record.sleepStart), avgMin));
    }
    parts.regularity = regPts(ctx.onsetShiftMin == null ? null : Math.abs(ctx.onsetShiftMin), same.length);
    ctx.regularityDefault = same.length < 2;
  }

  const eff = effPts(record.wasoMin, record.efficiencyPct);
  if (eff != null) { parts.efficiency = eff; ctx.wasoMin = record.wasoMin; ctx.efficiencyPct = record.efficiencyPct; }
  ctx.fatigue = record.fatigue; ctx.satisfaction = record.satisfaction;
  ctx.firstOffAfterNights = !!record.firstOffAfterNights;

  const got = Object.values(parts).reduce((s, v) => s + v, 0);
  const possible = Object.keys(parts).reduce((s, k) => s + MAX[k], 0);
  const total = r1((got * 100) / possible);
  const lost = Object.fromEntries(Object.keys(parts).map((k) => [k, MAX[k] - parts[k]]));
  const weakest = Object.keys(parts).sort((a, b) => lost[b] - lost[a])[0];
  return {
    total, grade: grade(total), mode: possible === 100 ? "full" : "partial",
    parts: Object.fromEntries(Object.entries(parts).map(([k, v]) => [k, r1(v)])),
    possible, weakest, tstH: Math.round(tstH * 100) / 100, ctx,
  };
}

// ── 해설·권고 ─────────────────────────────────────────────
const HEADLINE = {
  "충분히 회복": "회복이 잘 됐어요",
  "보통": "무난하게 쉬었어요",
  "회복 부족": "회복이 조금 부족해요",
  "회복 필요": "오늘은 쉬는 게 먼저예요",
};

// 영역별 권고 후보: 조건을 만족하면 문구를 돌려줌 (없으면 null)
function tipFor(area, s) {
  const c = s.ctx;
  switch (area) {
    case "duration": {
      if (c.tstH < 7) {
        const lack = fmtHM(7 - c.tstH);
        if (c.shiftType === "night" && c.preNightNap)
          return `낮잠까지 합쳐도 권장 7시간보다 ${lack} 부족해요. 다음 휴무일에 충분히 보충해 보세요.`;
        return c.shiftType === "night"
          ? `권장 7시간보다 ${lack} 부족해요. 야간 출근 전 20–30분 낮잠으로 일부를 채워 보세요.`
          : `권장 7시간보다 ${lack} 부족해요. 수면 시간을 조금 더 확보해 보세요.`;
      }
      if (c.tstH > 9 && !c.firstOffAfterNights)
        return "평소보다 오래 잤어요. 깨는 시각을 일정하게 지키면 리듬을 유지하는 데 도움이 돼요.";
      return null;
    }
    case "alertness":
      return c.fatigue >= 7 ? "일어난 뒤에도 피로가 커요. 오늘 운동은 스트레칭 정도로 가볍게 해요."
        : c.fatigue >= 5 ? "피로가 조금 남아 있어요. 물을 충분히 마시고 무리한 일정은 줄여 보세요." : null;
    case "satisfaction":
      return c.satisfaction <= 4 ? "잠이 만족스럽지 않았어요. 암막 커튼·귀마개로 빛과 소음을 줄여 보세요."
        : c.satisfaction <= 6 ? "잠자리 환경을 한 가지만 바꿔 보세요(빛, 소음, 온도 중 하나)." : null;
    case "timing": {
      if (c.restGapH != null && c.restGapH < 11)
        return `근무 사이 쉬는 시간이 ${fmtHM(c.restGapH)}이에요(권장 11시간 이상). 퇴근 후 바로 잠들 수 있게 준비해 두세요.`;
      if (c.shiftType === "night" && c.onsetAfterShiftEndH != null && c.onsetAfterShiftEndH > 2)
        return `퇴근 후 잠들기까지 ${fmtHM(c.onsetAfterShiftEndH)} 걸렸어요. 귀가 후 바로 잘 수 있게 방을 미리 어둡게 해 두세요.`;
      if (c.shiftType === "night" && !c.preNightNap)
        return "야간 출근 전 20–30분 낮잠을 계획해 보세요. 근무 중 졸림을 줄이는 데 도움이 돼요.";
      if (c.shiftType !== "night" && c.nightWindowShare != null && c.nightWindowShare < 0.5)
        return "주수면이 밤 시간대를 많이 벗어났어요. 근무가 없는 날엔 밤에 자도록 맞춰 보세요.";
      return null;
    }
    case "efficiency":
      return c.wasoMin != null && c.wasoMin > 20
        ? `자는 중에 깬 시간이 ${c.wasoMin}분이에요. 방 온도와 소음, 자기 전 카페인을 점검해 보세요.`
        : c.efficiencyPct != null && c.efficiencyPct < 85
          ? "누워 있던 시간에 비해 실제로 잔 시간이 짧아요. 졸릴 때 잠자리에 들어 보세요." : null;
    case "regularity": {
      if (c.regularityDefault || c.onsetShiftMin == null || Math.abs(c.onsetShiftMin) <= 60) return null;
      const dir = c.onsetShiftMin > 0 ? "늦게" : "일찍";
      return `같은 근무 날보다 ${fmtHM(Math.abs(c.onsetShiftMin) / 60)} ${dir} 잠들었어요. 비슷한 시각에 잠드는 것부터 맞춰 보세요.`;
    }
  }
  return null;
}

/**
 * score: scoreSleep() 결과, recent: 최근 기록들의 점수 배열(최신순, 오늘 포함)
 * 반환: { headline, summary, tips:[{area, text}] (최대 2), notices:[string], hint:string|null }
 */
export function buildFeedback(score, recent = []) {
  if (!score) {
    return { headline: "점수를 계산할 수 없어요",
      summary: "수면 만족도나 기상 후 피로도를 하나 이상 골라 주세요.", tips: [], notices: [], hint: null };
  }
  // 잃은 점수가 큰 영역부터 권고 후보를 찾고 최대 2개
  const order = Object.keys(score.parts).sort(
    (a, b) => (MAX[b] - score.parts[b]) - (MAX[a] - score.parts[a]));
  const tips = [];
  for (const area of order) {
    if (tips.length >= 2) break;
    if (MAX[area] - score.parts[area] < MAX[area] * 0.25) continue;   // 거의 만점이면 생략
    const text = tipFor(area, score);
    if (text) tips.push({ area, text });
  }
  const summary = tips.length
    ? `총 수면 ${fmtHM(score.tstH)} · 가장 아쉬운 부분: ${LABEL[tips[0].area]}`
    : `총 수면 ${fmtHM(score.tstH)} · 모든 영역이 고르게 괜찮아요`;
  if (!tips.length) tips.push({ area: "keep", text: "지금 리듬이 좋아요. 비슷한 시각에 자고 일어나는 것을 유지해 보세요." });

  // 안전·지속 안내 (점수보다 우선 표시)
  const notices = [];
  if (score.total < 50 && score.ctx.shiftType === "night")
    notices.push("졸린 상태의 운전은 음주운전만큼 위험할 수 있어요. 출퇴근 전 졸리면 잠깐 쉬었다 가세요.");
  const last3 = recent.slice(0, 3);
  if (last3.length === 3 && last3.every((v) => v < 50))
    notices.push("낮은 점수가 며칠째 이어지고 있어요. 계속되면 전문가 상담을 받아 보는 것도 방법이에요.");

  const hint = score.mode === "partial" && !score.ctx.hasTimes
    ? "잠든 시각과 깬 시각을 함께 기록하면 근무 일정까지 반영해 더 정확하게 계산해요." : null;

  return { headline: HEADLINE[score.grade], summary, tips, notices, hint };
}

// ── 홈 컨디션(에너지 체크) ─────────────────────────────────
export function energyScore({ todaySfs, last3Sfs, last3TstH, sleepinessNow }) {
  const avg3 = last3Sfs.length ? last3Sfs.reduce((s, v) => s + v, 0) / last3Sfs.length : todaySfs;
  const debt = last3TstH.reduce((s, t) => s + Math.max(0, 7 - t), 0);
  const penalty = Math.min(15, 3 * Math.max(0, debt - 2));
  let e = Math.round(0.6 * todaySfs + 0.4 * avg3 - penalty);
  if (sleepinessNow === "very") e = Math.min(e, 49);
  e = Math.max(0, Math.min(100, e));
  const label = e >= 80 ? "좋음" : e >= 60 ? "보통" : e >= 40 ? "낮음" : "쉬어가기";
  const routine = e >= 80 ? "기본 루틴 15분" : e >= 60 ? "가벼운 루틴 10–15분"
    : e >= 40 ? "스트레칭·호흡 5분" : "휴식 · 파워냅 타이머";
  return { energy: e, label, routine, debtH: r1(debt) };
}
