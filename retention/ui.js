// 이탈방지·복귀유도 화면 연결(명세 5·6장). 엔진(engine.js)을 부르고 기존 화면에 카드·알림함·시뮬레이터를 붙인다.
// 기존 기록은 window.ShiftFitApp(index.html이 노출)으로 읽기만 하고, 새 활동만 shiftfit-retention에 저장한다.
import {
  runRetentionEngine, logActivity, awardPoints, dateKey, addDays, atKst, statusBadge, weekCheckins,
  fiveMinPlanVisible, sortInbox, pointsTotal, currentMultiplier, activeMultipliers, returnCheckins, crewPublicView, nudgeOutcomes,
} from './engine.js';
import {
  DEFAULT_CONFIG, LAPSE_REASONS, RESTART_PLANS, CHEER_TEMPLATES, SIGNAL_LABELS, STATE_LABELS,
} from './constants.js';
import { KEYS, readJson, writeJson, loadSim, getNow, setVirtualNow, disableSim, loadRetention, saveRetention } from './store.js';
import { createDemoWorld, demoCtx, simulateCrewCheers, PRESETS, DEMO_CREW_STATES } from './demo.js';

const cfg = DEFAULT_CONFIG;
const app = () => window.ShiftFitApp || {};
const SHIFT_KO = { day: '주간 근무', evening: '오후 근무', night: '야간 근무', off: '비번', rest: '휴무' };
const SHIFT_CODE = { 주간: 'day', 오후: 'evening', 야간: 'night', 비번: 'off', 휴무: 'rest' };
const $ = (sel, root = document) => root.querySelector(sel);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = (p) => `${p}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

let r = null;       // 실제 모드 상태
let world = null;   // 시뮬레이터 모드 세계
let lastSentIds = null;
const simMode = () => loadSim().enabled;

// ── 컨텍스트 ─────────────────────────────────────────────
function realCtx(state) {
  const a = app();
  const activities = [];
  for (const w of a.getActivityRecords?.() || []) {
    if (!w?.id || !w.completedAt) continue;
    activities.push({ id: `w:${w.id}`, type: 'workout_done', occurredAt: w.completedAt, shiftType: SHIFT_CODE[w.shiftType] });
  }
  for (const s of a.getSleepRecords?.() || []) {
    const id = `s:${s.date}`;
    if (state.seen[id]) activities.push({ id, type: 'sleep_logged', occurredAt: state.seen[id] });
  }
  const hours = a.workHours?.() || {};
  const cycle = a.cycle?.() || {};
  return {
    activities,
    shiftOn: (key) => SHIFT_CODE[a.shiftForKey?.(key)] || 'off',
    workHours: { day: hours['주간'], evening: hours['오후'], night: hours['야간'] },
    cycleLength: cycle.length,
    cycleStartKey: cycle.startKey,
    crewMember: true,
    scheduledWorkouts: [],
  };
}

// 기존 수면 기록을 처음 본 시각을 남긴다(포인트 1회 지급용). 이틀 이상 지난 기록은 그 날짜로 본다.
function syncSeen(state, now) {
  const fresh = [];
  for (const s of app().getSleepRecords?.() || []) {
    if (!s?.date) continue;
    const id = `s:${s.date}`;
    if (state.seen[id]) continue;
    const recent = s.date >= addDays(dateKey(now), -1);
    state.seen[id] = recent ? now.toISOString() : atKst(s.date, '09:00').toISOString();
    if (recent) fresh.push(id);
  }
  for (const w of app().getActivityRecords?.() || []) {
    const id = `w:${w?.id}`;
    if (!w?.id || state.seen[id]) continue;
    state.seen[id] = w.completedAt;
    if (w.completedAt && dateKey(w.completedAt) === dateKey(now)) fresh.push(id);
  }
  return fresh;
}

function ctxNow() {
  return simMode() ? demoCtx(world) : realCtx(r);
}
function current() {
  return simMode() ? world.r : r;
}
function setCurrent(next) {
  if (simMode()) { world.r = next; writeJson(KEYS.demo, world); } else { r = next; saveRetention(r); queueSummarySync(); }
}

// ── 엔진 실행 ────────────────────────────────────────────
function run({ quietToast = false } = {}) {
  const now = getNow();
  if (simMode()) {
    world.r = runRetentionEngine(world.r, demoCtx(world), now, cfg);
    simulateCrewCheers(world, now);
    world.r = runRetentionEngine(world.r, demoCtx(world), now, cfg);
    world.now = now.toISOString();
    writeJson(KEYS.demo, world);
  } else {
    const fresh = syncSeen(r, now);
    r = runRetentionEngine(r, realCtx(r), now, cfg);
    for (const id of fresh) {
      const activity = realCtx(r).activities.find((x) => x.id === id);
      if (!activity) continue;
      const result = awardPoints(r, activity, realCtx(r), now, cfg);
      r = result.r;
      announcePoints(result.entry, result.bonuses);
    }
    saveRetention(r);
    queueSummarySync();
  }
  announceNudges(quietToast);
  renderAll();
}

function record(type, meta) {
  const now = getNow();
  const activity = { id: uid(type), type, occurredAt: now.toISOString(), ...(meta ? { meta } : {}) };
  const wasDormant = current().state === 'dormant';
  const result = logActivity(current(), activity, ctxNow(), now, cfg);
  setCurrent(result.r);
  announcePoints(result.entry, result.bonuses);
  announceNudges(true);
  renderAll();
  return { ...result, wasDormant };
}

// ── 토스트 ───────────────────────────────────────────────
let toastTimer;
function toast(message) {
  const el = $('#retention-toast');
  if (!el) return;
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
}

function announcePoints(entry, bonuses = []) {
  const parts = [];
  if (entry) parts.push(`+${entry.amount}P${entry.multiplier > 1 ? ` (×${entry.multiplier})` : ''}`);
  for (const b of bonuses) parts.push(`${b.kind === 'weekly_goal' ? '이번 주 목표 달성' : '복귀 완료'} +${b.amount}P`);
  if (parts.length) toast(parts.join(' · '));
}

function announceNudges(quiet) {
  const sent = sortInbox(current().nudges).filter((n) => !n.silent);
  const ids = new Set(sent.map((n) => n.id));
  if (lastSentIds && !quiet) {
    const fresh = sent.find((n) => !lastSentIds.has(n.id) && !n.readAt);
    if (fresh) setTimeout(() => toast(fresh.text), 900);
  }
  lastSentIds = ids;
}

// ── 화면 그리기 ──────────────────────────────────────────
function renderAll() {
  try {
    renderHome();
    renderBell();
    renderInbox();
    renderCrew();
    renderProfile();
    renderWorkoutPlanNote();
    renderSimPanel();
    maybeShowReturnSheet();
  } catch (error) {
    console.warn('retention ui', error);
  }
}

function renderHome() {
  const host = $('#retention-home');
  if (!host) return;
  const now = getNow(), state = current(), ctx = ctxNow();
  const badge = statusBadge(state, ctx, now, cfg);
  const week = weekCheckins(state, ctx, now);
  const goal = cfg.RETENTION.WEEKLY_CHECKIN_GOAL;
  const todayChecked = state.events.some((e) => e.type === 'condition_check' && dateKey(e.occurredAt) === dateKey(now));
  const plan = state.restartPlan && now - Date.parse(state.restartPlan.createdAt) < 7 * 864e5 ? RESTART_PLANS[state.restartPlan.reason] : null;
  const five = fiveMinPlanVisible(state, now, cfg);
  host.innerHTML = `
    ${badge ? `<div class="rt-badge rt-badge-${badge.kind}" role="status">${esc(badge.text)}</div>` : ''}
    <article class="card rt-card" id="rt-rhythm">
      <div class="card-title"><div><h2>이번 주 체크인 ${Math.min(week.count, goal)}/${goal}일</h2>
      <p>${week.count ? `이번 주 ${week.count}일 체크인했어요${week.count >= goal ? ' · 목표 달성!' : ''}` : '운동·수면 기록, 컨디션 체크, 쉬는 날 선택 모두 체크인이에요'}</p></div>
      <span class="pill">${esc(week.start.slice(5).replace('-', '/'))}~${esc(week.end.slice(5).replace('-', '/'))}</span></div>
      <div class="rt-meter" role="progressbar" aria-valuemin="0" aria-valuemax="${goal}" aria-valuenow="${Math.min(week.count, goal)}"><i style="width:${Math.min(100, (week.count / goal) * 100)}%"></i></div>
      <div class="rt-condition"><span>${todayChecked ? '오늘 컨디션을 남겼어요' : '오늘 컨디션은 어때요?'}</span>
        <div class="rt-choices">${[['good', '좋음'], ['ok', '보통'], ['tired', '피곤함']].map(([k, l]) => `<button class="chip-btn" type="button" data-rt-condition="${k}" ${todayChecked ? 'disabled' : ''}>${l}</button>`).join('')}</div>
      </div>
    </article>
    ${five ? `<article class="card rt-card" id="rt-five"><div class="card-title"><div><h2>이번 주는 5분만 해 볼까요?</h2><p>요즘 근무가 빡빡했죠. 이번 주만 5분 루틴으로 가볍게 바꿔 드릴게요. 기존 계획은 그대로 남아요.</p></div></div>
      <div class="rt-actions"><button class="button small" type="button" data-rt-five="accept">이번 주는 5분만</button><button class="button small secondary" type="button" data-rt-five="decline">괜찮아요</button></div></article>` : ''}
    ${state.fiveMinPlan?.active && state.fiveMinPlan.weekStart === week.start ? '<p class="rt-note">이번 주는 5분 루틴으로 보여 드려요.</p>' : ''}
    ${plan ? `<article class="card rt-card"><div class="card-title"><div><h2>첫 주 플랜 · ${esc(plan.title)}</h2><p>이번 주만 이만큼이면 충분해요.</p></div></div><ul class="rt-list">${plan.items.map((i) => `<li>${esc(i)}</li>`).join('')}</ul>
      ${state.restartPlan.reason === 'schedule_change' ? '<button class="button small" type="button" data-rt-go="calendar">근무표 다시 등록하기</button>' : '<button class="button small" type="button" data-rt-go="workout">루틴 보러 가기</button>'}</article>` : ''}`;
}

function renderBell() {
  const btn = $('#notify-btn');
  if (!btn) return;
  const unread = sortInbox(current().nudges).filter((n) => !n.readAt).length;
  let dot = btn.querySelector('.rt-bell-count');
  if (!dot) { dot = document.createElement('span'); dot.className = 'rt-bell-count'; btn.append(dot); }
  dot.textContent = unread > 9 ? '9+' : String(unread);
  dot.hidden = unread === 0;
  btn.setAttribute('aria-label', unread ? `알림 ${unread}건` : '알림');
}

function renderInbox() {
  const list = $('#rt-inbox-list');
  if (!list) return;
  const items = sortInbox(current().nudges);
  const r2Answered = (n) => current().events.some((e) => e.type === 'lapse_reason' && Date.parse(e.occurredAt) >= Date.parse(n.sentAt));
  list.innerHTML = items.length ? items.map((n) => `
    <li class="rt-inbox-item ${n.readAt ? '' : 'unread'}">
      <button class="rt-inbox-open" type="button" data-rt-open="${esc(n.id)}"><b>${esc(n.text)}</b><small>${esc(new Date(n.sentAt).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }))}${n.silent ? ' · 알림 없이 보관' : ''}</small></button>
      ${n.type === 'R2' && !r2Answered(n) ? `<div class="rt-choices">${Object.entries(LAPSE_REASONS).filter(([k]) => k !== 'no_answer').map(([k, l]) => `<button class="chip-btn" type="button" data-rt-lapse="${k}" data-rt-nudge="${esc(n.id)}">${l}</button>`).join('')}</div>` : ''}
    </li>`).join('') : '<li class="rt-empty">새로운 알림이 없어요.</li>';
}

function renderCrew() {
  const page = $('#page-crew');
  if (!page) return;
  const points = page.querySelector('.card.points');
  if (points) {
    const label = points.querySelector('span');
    const strong = points.querySelector('strong');
    if (label) label.textContent = simMode() ? '내 활동 포인트 · 시뮬레이터' : '내 활동 포인트';
    if (strong) strong.innerHTML = `${pointsTotal(current()).toLocaleString('ko-KR')} <small>P</small>`;
  }
  const host = $('#retention-crew');
  if (!host) return;
  // 크루원 데이터는 공개 허용 필드(닉네임·추천 여부·받은 응원 수)만 사용
  const targets = DEMO_CREW_STATES.filter((m) => m.recommendCheer);
  host.innerHTML = targets.length ? `<div class="card-title"><div><h2>응원 보내기</h2><p>요즘 조용한 크루원에게 한마디 건네 볼까요?</p></div></div>
    ${targets.map((m) => `<div class="rt-cheer-row"><span class="avatar">${esc(m.nickname[0])}</span><span>${esc(m.nickname)}님에게 응원을 보내 볼까요?</span><button class="button small" type="button" data-rt-cheer="${esc(m.nickname)}">응원하기</button></div>`).join('')}` : '';
  host.hidden = !targets.length;
}

function renderProfile() {
  const host = $('#retention-profile');
  if (!host) return;
  const s = current().settings;
  const ledger = [...current().ledger].sort((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt)).slice(0, 30);
  const KIND = { workout_done: '운동 완료', sleep_logged: '수면 기록', condition_check: '컨디션 체크', rest_chosen: '오늘은 휴식', cheer_sent: '응원 보내기', weekly_goal: '주간 목표 보너스', return_complete: '복귀 완료 보너스' };
  host.innerHTML = `
    <div class="card-title"><div><h2>알림·크루 설정</h2><p>쉬는 동안의 알림과 크루 응원을 정해요.</p></div></div>
    <label class="rt-toggle"><input type="checkbox" data-rt-setting="cheerRequestOnRest" ${s.cheerRequestOnRest ? 'checked' : ''}>내가 쉴 때 크루에게 응원 요청 보내기</label>
    <label class="rt-toggle"><input type="checkbox" data-rt-setting="receiveCheers" ${s.receiveCheers ? 'checked' : ''}>크루 응원 알림 받기</label>
    <label class="rt-toggle"><input type="checkbox" data-rt-setting="engineNudges" ${s.engineNudges !== false ? 'checked' : ''}>다시 시작을 돕는 알림 받기</label>
    <label class="rt-field">리듬 주 기준<select data-rt-setting="rhythmWeek"><option value="calendar" ${s.rhythmWeek === 'calendar' ? 'selected' : ''}>달력 주(월~일)</option><option value="shift-cycle" ${s.rhythmWeek === 'shift-cycle' ? 'selected' : ''}>내 교대 주기</option></select></label>
    <h3 class="rt-sub">포인트 내역 <b>${pointsTotal(current()).toLocaleString('ko-KR')}P</b></h3>
    <ul class="rt-ledger">${ledger.length ? ledger.map((e) => `<li><span>${esc(KIND[e.kind] || e.kind)}<small>${esc(new Date(e.occurredAt).toLocaleDateString('ko-KR', { timeZone: 'Asia/Seoul', month: 'numeric', day: 'numeric' }))} · ${esc(e.note || '')}</small></span><b>+${e.amount}P</b></li>`).join('') : '<li class="rt-empty">아직 포인트 내역이 없어요.</li>'}</ul>
    <button class="rt-hidden-link" type="button" data-rt-sim="open">개발자 메뉴 · 날짜 시뮬레이터</button>`;
}

function renderWorkoutPlanNote() {
  const page = $('#page-workout');
  if (!page) return;
  let note = $('#rt-workout-note');
  const state = current(), week = weekCheckins(state, ctxNow(), getNow());
  const active = state.fiveMinPlan?.active && state.fiveMinPlan.weekStart === week.start;
  if (!active) { note?.remove(); return; }
  if (!note) {
    note = document.createElement('div');
    note.id = 'rt-workout-note';
    note.className = 'rt-badge rt-badge-watch';
    page.querySelector('.page-heading')?.after(note);
  }
  note.textContent = '이번 주는 5분 루틴으로 가볍게 해요. 기존 계획은 그대로 남아 있어요.';
}

// ── 복귀 첫 화면 (5.4) ───────────────────────────────────
let returnShownFor = null;
function maybeShowReturnSheet() {
  const state = current();
  const dialog = $('#rt-return');
  if (!dialog || state.state !== 'dormant' || returnShownFor === state.dormantSince || dialog.open) return;
  returnShownFor = state.dormantSince;
  const step = $('#rt-return-body');
  step.innerHTML = `<h2>다시 오셨네요. 오늘 컨디션부터 확인해 볼까요?</h2>
    <div class="rt-choices rt-big">${[['good', '좋음'], ['ok', '보통'], ['tired', '피곤함']].map(([k, l]) => `<button class="chip-btn" type="button" data-rt-return-condition="${k}">${l}</button>`).join('')}</div>`;
  try { dialog.showModal(); } catch { dialog.setAttribute('open', ''); }
}

function returnReasonStep() {
  const state = current();
  const r2 = state.nudges.find((n) => n.type === 'R2' && n.sentAt && Date.parse(n.sentAt) >= Date.parse(state.returnStartedAt || 0) - 30 * 864e5);
  const answered = r2 && state.events.some((e) => e.type === 'lapse_reason' && Date.parse(e.occurredAt) >= Date.parse(r2.sentAt));
  if (answered) return restartStep(state.events.filter((e) => e.type === 'lapse_reason').at(-1)?.meta?.reason || 'no_answer');
  $('#rt-return-body').innerHTML = `<h2>요즘 어떤 게 가장 걸렸나요?</h2><p>한 번만 눌러 주세요. 다음 플랜에 반영할게요.</p>
    <div class="rt-choices rt-big">${Object.entries(LAPSE_REASONS).map(([k, l]) => `<button class="chip-btn" type="button" data-rt-return-reason="${k}">${k === 'no_answer' ? '말하고 싶지 않아요' : l}</button>`).join('')}</div>`;
}

function restartStep(reason) {
  const plan = RESTART_PLANS[reason] || RESTART_PLANS.no_answer;
  const state = current();
  state.restartPlan = { reason, createdAt: getNow().toISOString() };
  setCurrent(state);
  const unconfirmed = 0; // 예정 운동 기능이 아직 없어 미확인 건이 생기지 않는다
  $('#rt-return-body').innerHTML = `<h2>${esc(plan.title)}</h2><p>첫 주는 이것만 해도 충분해요.</p><ul class="rt-list">${plan.items.map((i) => `<li>${esc(i)}</li>`).join('')}</ul>
    ${unconfirmed ? '<button class="button secondary small" type="button" data-rt-skip-unconfirmed>지난 기록은 비워 두고 넘어갈게요</button>' : ''}
    <div class="rt-actions">${reason === 'schedule_change' ? '<button class="button" type="button" data-rt-return-go="calendar">근무표 다시 등록하기</button>' : '<button class="button" type="button" data-rt-return-go="home">시작하기</button>'}</div>`;
  renderAll();
}

// ── 휴식 이유 (5.2) ──────────────────────────────────────
function watchRestCard() {
  const card = $('#workout-rest-guidance');
  if (!card) return;
  const attach = () => {
    if (card.hidden || !$('#workout-intent-rest')?.checked || card.querySelector('.rt-rest')) return;
    const box = document.createElement('div');
    box.className = 'rt-rest';
    box.innerHTML = `<p><b>쉬는 것도 루틴이에요.</b> 오늘 쉬는 이유를 하나만 골라 주세요.</p>
      <div class="rt-choices">${Object.entries(LAPSE_REASONS).filter(([k]) => k !== 'no_answer').map(([k, l]) => `<button class="chip-btn" type="button" data-rt-rest="${k}">${l}</button>`).join('')}</div>`;
    card.append(box);
  };
  new MutationObserver(attach).observe(card, { attributes: true, childList: true, attributeFilter: ['hidden'] });
}

// ── 날짜 시뮬레이터 (6장) ────────────────────────────────
function renderSimPanel() {
  const panel = $('#rt-sim');
  if (!panel) return;
  panel.hidden = !simMode();
  if (!simMode()) return;
  const now = getNow(), state = world.r, ctx = demoCtx(world);
  const week = weekCheckins(state, ctx, now);
  const weekNudges = state.nudges.filter((n) => n.sentAt && !n.cancelledReason && dateKey(n.sentAt) >= week.start && dateKey(n.sentAt) <= week.end).length;
  const cancelled = state.nudges.filter((n) => n.cancelledReason).length;
  const mults = activeMultipliers(state, ctx, now, cfg);
  $('#rt-sim-body').innerHTML = `
    <div class="rt-sim-row"><b>${esc(now.toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', month: 'long', day: 'numeric', weekday: 'short', hour: '2-digit', minute: '2-digit' }))}</b><span>${esc(SHIFT_KO[ctx.shiftOn(dateKey(now))] || '')}</span></div>
    <div class="rt-sim-grid">
      <span>상태</span><b>${esc(STATE_LABELS[state.state])}${state.state === 'returning' ? ` ${Math.min(3, returnCheckins(state, ctx, now))}/3` : ''}</b>
      <span>위험 점수</span><b>${state.riskScore}</b>
      <span>신호</span><b>${state.riskSignals.map((s) => `${esc(SIGNAL_LABELS[s] || s)} ${state.riskDetail?.[s]?.points ?? ''}`).join(', ') || '없음'}</b>
      <span>유효 배수</span><b>×${currentMultiplier(state, ctx, now, cfg)}${mults.length ? ` (${mults.map((m) => `${m.kind} ${m.value}`).join(', ')})` : ''}</b>
      <span>이번 주 알림</span><b>${weekNudges}건 · 취소 누적 ${cancelled}건</b>
      <span>포인트</span><b>${pointsTotal(state)}P</b>
    </div>`;
}

function simShift(days) {
  setVirtualNow(new Date(getNow().getTime() + days * 864e5));
  run();
}

function startSim(base = new Date()) {
  world = createDemoWorld(base, { recent: true });
  setVirtualNow(base);
  run({ quietToast: true });
}

function loadPreset(id) {
  const preset = PRESETS.find((p) => p.id === id);
  const result = preset.run(new Date());
  world = result.world;
  setVirtualNow(result.now);
  writeJson(KEYS.demo, world);
  lastSentIds = null;
  returnShownFor = world.r.state === 'dormant' ? world.r.dormantSince : null;
  run({ quietToast: true });
  toast(`${preset.label}: ${result.steps.at(-1)}`);
  console.info(`[시뮬레이터] ${preset.label}\n- ${result.steps.join('\n- ')}`);
}

// ── Supabase 요약 동기화(관리자 대시보드용, 로그인 사용자만) ─
let syncTimer = null;
function queueSummarySync() {
  if (simMode()) return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(syncSummary, 1500);
}

export function summaryRow(state, ctx, now, userId) {
  const nudges = state.nudges || [];
  const count = (f) => nudges.filter(f).length;
  return {
    user_id: userId,
    state: state.state,
    risk_score: state.riskScore,
    risk_signals: state.riskSignals,
    last_active_at: state.lastActiveAt,
    state_changed_at: state.stateChangedAt,
    dormant_since: state.dormantSince,
    return_started_at: state.returnStartedAt,
    points_total: pointsTotal(state),
    week_checkins: weekCheckins(state, ctx, now).count,
    multiplier: currentMultiplier(state, ctx, now, cfg),
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
      log: nudgeOutcomes(state, ctx, now).slice(-40),
    },
    returns: (state.multipliers || []).filter((m) => m.kind === 'return').length,
    return_completes: (state.ledger || []).filter((e) => e.kind === 'return_complete').length,
    capped_entries: (state.ledger || []).filter((e) => /하루 상한/.test(e.note || '')).length,
    updated_at: now.toISOString(),
  };
}

async function syncSummary() {
  const a = app();
  const client = a.supabase?.(), user = a.user?.();
  if (!client || !user || simMode()) return;
  try {
    await client.from('user_retention').upsert(summaryRow(r, realCtx(r), getNow(), user.id), { onConflict: 'user_id' });
  } catch { /* 테이블이 없거나 오프라인이면 다음 기회에 */ }
}

// ── 일정 변경 감지 (shift_changed 신호) ───────────────────
let lastPattern = null, lastOverrides = null;
function readRaw(key) { try { return localStorage.getItem(key); } catch { return null; } }
function snapshotSchedule() {
  lastPattern = readRaw('shiftfit-pattern') + '|' + readRaw('shiftfit-custom-cycle');
  try { lastOverrides = JSON.parse(readRaw('shiftfit-calendar-overrides') || '{}') || {}; } catch { lastOverrides = {}; }
}
function onScheduleWrite(key) {
  if (simMode() || !r) return;
  const at = getNow().toISOString();
  if (key === 'shiftfit-pattern' || key === 'shiftfit-custom-cycle') {
    const next = readRaw('shiftfit-pattern') + '|' + readRaw('shiftfit-custom-cycle');
    if (lastPattern && !lastPattern.startsWith('null') && next !== lastPattern) r.scheduleEvents.push({ type: 'pattern_change', at });
    lastPattern = next;
  } else if (key === 'shiftfit-calendar-overrides') {
    let next = {};
    try { next = JSON.parse(readRaw(key) || '{}') || {}; } catch { next = {}; }
    const changed = new Set([...Object.keys(next), ...Object.keys(lastOverrides || {})]);
    const count = [...changed].filter((k) => next[k] !== lastOverrides?.[k]).length;
    if (count && Object.keys(lastOverrides || {}).length + count > 0) r.scheduleEvents.push({ type: 'override_edit', at, count });
    lastOverrides = next;
  }
  r.scheduleEvents = r.scheduleEvents.filter((e) => getNow() - Date.parse(e.at) < 30 * 864e5);
  saveRetention(r);
}

// ── DOM 준비 ─────────────────────────────────────────────
const CSS = `
.rt-badge{margin:0 0 14px;padding:10px 14px;border-radius:12px;border:1px solid rgba(184,242,121,.35);background:rgba(184,242,121,.08);color:var(--mint);font-weight:700;font-size:14px}
.rt-badge-returning{border-color:rgba(165,197,255,.4);background:rgba(165,197,255,.08);color:var(--blue)}
.rt-badge-complete{border-color:rgba(207,179,255,.4);background:rgba(207,179,255,.08);color:var(--violet)}
#retention-home{display:grid;gap:12px;margin-bottom:14px}#retention-home:empty{display:none}
.rt-card .card-title{margin-bottom:10px}.rt-meter{height:8px;border-radius:99px;background:var(--panel-3);overflow:hidden}.rt-meter i{display:block;height:100%;background:var(--mint);border-radius:99px}
.rt-condition{display:flex;flex-wrap:wrap;gap:10px;align-items:center;justify-content:space-between;margin-top:14px;color:var(--muted);font-size:14px}
.rt-choices{display:flex;flex-wrap:wrap;gap:8px}.rt-choices.rt-big .chip-btn{min-height:48px;padding:0 18px;font-size:15px}
.chip-btn{min-height:40px;padding:0 14px;border-radius:999px;border:1px solid var(--line);background:var(--panel-2);color:var(--text);font:inherit;font-weight:600;cursor:pointer}.chip-btn:hover:not(:disabled){border-color:var(--mint)}.chip-btn:disabled{opacity:.45;cursor:default}
.rt-actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:12px}.rt-note{margin:0;color:var(--muted);font-size:13px}.rt-list{margin:6px 0 12px;padding-left:18px;color:var(--muted)}
.rt-bell-count{position:absolute;top:2px;right:2px;min-width:17px;height:17px;padding:0 4px;border-radius:99px;background:var(--red);color:#2a0d08;font:800 10px/17px var(--font);text-align:center}#notify-btn{position:relative}
.rt-dialog{width:min(440px,calc(100vw - 32px));max-height:min(80vh,640px);padding:0;border:1px solid var(--line);border-radius:18px;background:var(--panel);color:var(--text)}.rt-dialog::backdrop{background:rgba(0,0,0,.55)}
.rt-dialog-head{display:flex;justify-content:space-between;align-items:center;padding:16px 16px 8px}.rt-dialog-head h2{margin:0;font-size:17px}.rt-dialog-body{padding:4px 16px 18px;overflow-y:auto}
.rt-dialog-body h2{font-size:18px;margin:6px 0 12px}.rt-dialog-body p{color:var(--muted)}
#rt-inbox-list{list-style:none;margin:0;padding:0;display:grid;gap:8px}.rt-inbox-item{border:1px solid var(--line);border-radius:12px;padding:10px}.rt-inbox-item.unread{border-color:rgba(184,242,121,.45)}
.rt-inbox-open{display:grid;gap:3px;width:100%;text-align:left;background:none;border:0;color:var(--text);font:inherit;cursor:pointer;padding:0}.rt-inbox-open small{color:var(--dim)}.rt-inbox-item .rt-choices{margin-top:8px}
.rt-empty{color:var(--dim);padding:14px;text-align:center}
.rt-rest{margin-top:12px;padding-top:12px;border-top:1px solid var(--line)}.rt-rest p{margin:0 0 10px}
.rt-cheer-row{display:flex;align-items:center;gap:10px;padding:8px 0;font-size:14px}.rt-cheer-row span:nth-child(2){flex:1}
.rt-toggle{display:flex;gap:10px;align-items:center;min-height:44px;font-size:14px}.rt-toggle input{width:20px;height:20px;accent-color:var(--mint)}
.rt-field{display:grid;gap:6px;margin:8px 0;font-size:14px;color:var(--muted)}.rt-field select{min-height:44px;border-radius:10px;border:1px solid var(--line);background:var(--panel-2);color:var(--text);padding:0 10px;font:inherit}
.rt-sub{font-size:15px;margin:18px 0 8px;display:flex;justify-content:space-between}.rt-ledger{list-style:none;margin:0;padding:0;display:grid;gap:6px;max-height:260px;overflow-y:auto}
.rt-ledger li{display:flex;justify-content:space-between;gap:10px;padding:8px 10px;border-radius:10px;background:var(--panel-2);font-size:13px}.rt-ledger small{display:block;color:var(--dim)}.rt-ledger b{white-space:nowrap;color:var(--mint)}
.rt-hidden-link{margin-top:16px;background:none;border:0;color:var(--dim);font:inherit;font-size:12px;cursor:pointer;padding:6px 0;text-decoration:underline}
.rt-toast{position:fixed;left:50%;bottom:150px;transform:translate(-50%,12px);z-index:80;max-width:min(420px,calc(100vw - 32px));padding:11px 16px;border-radius:12px;background:#203018;border:1px solid rgba(184,242,121,.4);color:var(--mint);font-weight:700;font-size:14px;opacity:0;pointer-events:none;transition:opacity .2s,transform .2s;text-align:center}.rt-toast.show{opacity:1;transform:translate(-50%,0)}
#rt-sim{position:fixed;right:12px;bottom:88px;z-index:70;width:min(340px,calc(100vw - 24px));max-height:70vh;overflow-y:auto;background:#0d1512;border:1px solid var(--amber);border-radius:14px;padding:12px;font-size:13px;box-shadow:0 12px 32px rgba(0,0,0,.5)}
#rt-sim h3{margin:0 0 8px;font-size:13px;color:var(--amber);display:flex;justify-content:space-between}.rt-sim-row{display:flex;justify-content:space-between;margin-bottom:8px}.rt-sim-grid{display:grid;grid-template-columns:72px 1fr;gap:4px 8px;margin-bottom:10px}.rt-sim-grid span{color:var(--dim)}
#rt-sim .rt-choices{gap:6px;margin-bottom:6px}#rt-sim .chip-btn{min-height:34px;padding:0 10px;font-size:12px}
@media (min-width:900px){#rt-sim{bottom:16px}.rt-toast{bottom:90px}}
`;

function mount() {
  if (!$('#retention-style')) {
    const style = document.createElement('style');
    style.id = 'retention-style';
    style.textContent = CSS;
    document.head.append(style);
  }
  const home = $('#page-home .page-heading');
  if (home && !$('#retention-home')) { const div = document.createElement('div'); div.id = 'retention-home'; home.after(div); }
  const crewStack = $('#page-crew .dashboard-grid .stack');
  if (crewStack && !$('#retention-crew')) { const card = document.createElement('article'); card.className = 'card'; card.id = 'retention-crew'; crewStack.append(card); }
  const profileGrid = $('#page-profile .profile-grid .stack');
  if (profileGrid && !$('#retention-profile')) { const card = document.createElement('article'); card.className = 'card'; card.id = 'retention-profile'; profileGrid.append(card); }
  document.body.insertAdjacentHTML('beforeend', `
    <div class="rt-toast" id="retention-toast" role="status" aria-live="polite"></div>
    <dialog class="rt-dialog" id="rt-inbox" aria-labelledby="rt-inbox-title"><div class="rt-dialog-head"><h2 id="rt-inbox-title">알림함</h2><button class="chip-btn" type="button" data-rt-close>닫기</button></div><div class="rt-dialog-body"><ul id="rt-inbox-list"></ul></div></dialog>
    <dialog class="rt-dialog" id="rt-return" aria-label="다시 시작하기"><div class="rt-dialog-head"><span></span><button class="chip-btn" type="button" data-rt-close>나중에</button></div><div class="rt-dialog-body" id="rt-return-body"></div></dialog>
    <dialog class="rt-dialog" id="rt-cheer" aria-labelledby="rt-cheer-title"><div class="rt-dialog-head"><h2 id="rt-cheer-title">응원 보내기</h2><button class="chip-btn" type="button" data-rt-close>닫기</button></div><div class="rt-dialog-body"><p id="rt-cheer-to"></p><div class="rt-choices rt-big">${CHEER_TEMPLATES.map((t) => `<button class="chip-btn" type="button" data-rt-template="${t.id}">${t.text}</button>`).join('')}</div></div></dialog>
    <aside id="rt-sim" hidden aria-label="날짜 시뮬레이터"><h3>날짜 시뮬레이터 · 데모 데이터 <button class="chip-btn" type="button" data-rt-sim="exit">끄기</button></h3><div id="rt-sim-body"></div>
      <div class="rt-choices">${[1, 7, 14, 30].map((d) => `<button class="chip-btn" type="button" data-rt-sim-shift="${d}">+${d}일</button>`).join('')}<button class="chip-btn" type="button" data-rt-sim="reset">오늘로 리셋</button></div>
      <div class="rt-choices">${PRESETS.map((p, i) => `<button class="chip-btn" type="button" data-rt-preset="${p.id}">${i + 1}. ${p.label}</button>`).join('')}</div></aside>`);

  // 기존 벨 버튼의 '새로운 알림이 없습니다' 대신 알림함을 연다
  const bell = $('#notify-btn');
  if (bell) {
    const fresh = bell.cloneNode(true);
    bell.replaceWith(fresh);
    fresh.addEventListener('click', () => { renderInbox(); try { $('#rt-inbox').showModal(); } catch { $('#rt-inbox').setAttribute('open', ''); } });
  }
  const cheerBtn = $('#cheer-btn');
  if (cheerBtn) {
    const fresh = cheerBtn.cloneNode(true);
    cheerBtn.replaceWith(fresh);
    fresh.addEventListener('click', () => openCheer('크루원'));
  }
  const pointsBtn = $('#points-btn');
  if (pointsBtn) {
    const fresh = pointsBtn.cloneNode(true);
    pointsBtn.replaceWith(fresh);
    fresh.textContent = '포인트 내역';
    fresh.addEventListener('click', () => { app().showPage?.('profile'); setTimeout(() => $('#retention-profile')?.scrollIntoView({ behavior: 'smooth' }), 50); });
  }
  watchRestCard();
  document.addEventListener('click', onClick);
  document.addEventListener('change', onChange);
}

let cheerTarget = '';
function openCheer(name) {
  cheerTarget = name;
  $('#rt-cheer-to').textContent = `${name}님에게 보낼 응원을 골라 주세요.`;
  try { $('#rt-cheer').showModal(); } catch { $('#rt-cheer').setAttribute('open', ''); }
}

function closeDialog(el) {
  const dialog = el.closest('dialog');
  if (dialog?.open) { try { dialog.close(); } catch { dialog.removeAttribute('open'); } }
}

function onClick(event) {
  const t = event.target.closest('button,[data-rt-go]');
  if (!t) return;
  const d = t.dataset;
  if ('rtClose' in d) return closeDialog(t);
  if (d.rtCondition) return void record('condition_check', { level: d.rtCondition });
  if (d.rtFive) {
    const state = current();
    const week = weekCheckins(state, ctxNow(), getNow());
    state.fiveMinPlan = d.rtFive === 'accept'
      ? { active: true, startedAt: getNow().toISOString(), weekStart: week.start }
      : { active: false, declinedAt: getNow().toISOString() };
    setCurrent(state);
    toast(d.rtFive === 'accept' ? '이번 주는 5분 루틴으로 바꿔 보여 드릴게요.' : '알겠어요. 다음에 다시 여쭤볼게요.');
    return renderAll();
  }
  if (d.rtGo) return app().showPage?.(d.rtGo);
  if (d.rtOpen) {
    const state = current();
    const n = state.nudges.find((x) => x.id === d.rtOpen);
    if (n) { n.readAt = n.readAt || getNow().toISOString(); n.respondedAt = n.respondedAt || getNow().toISOString(); setCurrent(state); renderAll(); }
    return;
  }
  if (d.rtLapse) {
    const state = current();
    const n = state.nudges.find((x) => x.id === d.rtNudge);
    if (n) { n.readAt = n.readAt || getNow().toISOString(); n.respondedAt = getNow().toISOString(); setCurrent(state); }
    record('lapse_reason', { reason: d.rtLapse, source: 'R2' });
    return toast('알려 주셔서 고마워요. 다음 플랜에 반영할게요.');
  }
  if (d.rtRest) {
    record('lapse_reason', { reason: d.rtRest, source: 'rest' });
    record('rest_chosen', { reason: d.rtRest });
    t.closest('.rt-rest').innerHTML = '<p><b>쉬는 것도 루틴이에요.</b> 오늘은 편하게 쉬어 주세요.</p>';
    return;
  }
  if (d.rtCheer) return openCheer(d.rtCheer);
  if (d.rtTemplate) {
    closeDialog(t);
    const tpl = CHEER_TEMPLATES.find((x) => x.id === d.rtTemplate);
    record('cheer_sent', { templateId: tpl.id, to: cheerTarget });
    return;
  }
  if (d.rtReturnCondition) {
    record('condition_check', { level: d.rtReturnCondition, source: 'return' });
    return returnReasonStep();
  }
  if (d.rtReturnReason) {
    record('lapse_reason', { reason: d.rtReturnReason, source: 'return' });
    return restartStep(d.rtReturnReason);
  }
  if (d.rtReturnGo) { closeDialog(t); return app().showPage?.(d.rtReturnGo); }
  if (d.rtSim === 'open') return startSim(new Date());
  if (d.rtSim === 'exit') { disableSim(); world = null; lastSentIds = null; returnShownFor = null; return run({ quietToast: true }); }
  if (d.rtSim === 'reset') return startSim(new Date());
  if (d.rtSimShift) return simShift(Number(d.rtSimShift));
  if (d.rtPreset) return loadPreset(d.rtPreset);
}

function onChange(event) {
  const el = event.target;
  const key = el.dataset?.rtSetting;
  if (!key) return;
  const state = current();
  state.settings[key] = el.type === 'checkbox' ? el.checked : el.value;
  setCurrent(state);
  run({ quietToast: true });
}

// ── 시작 ─────────────────────────────────────────────────
function signupGuess() {
  const dates = [
    ...(app().getSleepRecords?.() || []).map((s) => s?.date && atKst(s.date, '09:00').getTime()),
    ...(app().getActivityRecords?.() || []).map((w) => w?.completedAt && Date.parse(w.completedAt)),
  ].filter(Number.isFinite);
  return dates.length ? new Date(Math.min(...dates)) : new Date();
}

function init() {
  mount();
  r = loadRetention(getNow(), signupGuess());
  const user = app().user?.();
  if (user?.created_at && Date.parse(user.created_at) < Date.parse(r.signupAt)) r.signupAt = user.created_at;
  if (new URLSearchParams(location.search).has('demo') && !simMode()) {
    world = createDemoWorld(new Date(), { recent: true });
    setVirtualNow(new Date());
  }
  if (simMode()) world = readJson(KEYS.demo) || createDemoWorld(getNow(), { recent: true });
  snapshotSchedule();
  run({ quietToast: true });
  window.addEventListener('shiftfit:data', (event) => {
    const key = event.detail?.key || '';
    if (key === 'shiftfit-pattern' || key === 'shiftfit-custom-cycle' || key === 'shiftfit-calendar-overrides') onScheduleWrite(key);
    if (key === 'shiftfit-activity-records' || key === 'shiftfit-sleep-records') {
      if (simMode()) {
        const type = key === 'shiftfit-activity-records' ? 'workout_done' : 'sleep_logged';
        setTimeout(() => record(type, { source: 'app' }), 0);
      } else setTimeout(() => run(), 0);
    }
  });
  window.addEventListener('shiftfit:auth', () => {
    const u = app().user?.();
    if (u?.created_at && Date.parse(u.created_at) < Date.parse(r.signupAt)) { r.signupAt = u.created_at; saveRetention(r); }
    queueSummarySync();
  });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) run(); });
  setInterval(() => run(), 60000);
  window.ShiftFitRetention = { run, record, getState: current, getNow, crewView: () => crewPublicView(current(), app().nickname?.() || '나', getNow()) };
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
