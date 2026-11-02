// 브라우저 저장소 래퍼와 가상 시각(getNow). 저장소 접근은 모두 try/catch — 실패해도 메모리로 계속 동작한다.
import { createRetention } from './engine.js';

export const KEYS = {
  retention: 'shiftfit-retention',          // 실제 사용자 이탈방지 상태(새 활동·원장·알림)
  demo: 'shiftfit-retention-demo',          // 날짜 시뮬레이터 데모 세계(실제 기록과 분리)
  sim: 'shiftfit-retention-sim',            // 시뮬레이터 켜짐·가상 시각
};

const memory = {};

export function readJson(key) {
  try {
    const raw = localStorage.getItem(key);
    if (raw !== null) return JSON.parse(raw);
  } catch { /* 저장소 차단·깨진 값 */ }
  return memory[key] ?? null;
}

export function writeJson(key, value) {
  memory[key] = value;
  try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch { return false; }
}

export function removeKey(key) {
  delete memory[key];
  try { localStorage.removeItem(key); } catch { /* 무시 */ }
}

// ── 날짜 시뮬레이터 ───────────────────────────────────────
export function loadSim() {
  const sim = readJson(KEYS.sim);
  return sim && sim.enabled ? sim : { enabled: false };
}

export function getNow() {
  const sim = loadSim();
  if (!sim.enabled || !sim.virtualNow) return new Date();
  return new Date(Date.parse(sim.virtualNow) + Math.max(0, Date.now() - Date.parse(sim.anchorReal)));
}

export function setVirtualNow(date) {
  writeJson(KEYS.sim, { enabled: true, virtualNow: new Date(date).toISOString(), anchorReal: new Date().toISOString() });
}

export function disableSim() {
  removeKey(KEYS.sim);
}

// ── 실제 사용자 상태 ─────────────────────────────────────
export function loadRetention(now, signupGuess) {
  const saved = readJson(KEYS.retention);
  if (saved && saved.version === 1) return saved;
  return createRetention(signupGuess || now);
}

export function saveRetention(r) {
  writeJson(KEYS.retention, r);
}
