// ShiftFit 이탈방지·복귀유도 엔진 상수 (명세 v1.1 2장).
// 미결 정책(11장)은 POLICY·RISK_SIGNAL_POINTS·RETENTION.WATCH_THRESHOLD 값만 바꾸면 동작이 바뀐다.

export const RETENTION = {
  WATCH_THRESHOLD: 40,          // 이상이면 watch
  HIGH_RISK_THRESHOLD: 70,      // 이상이면 5분 플랜 제안
  DORMANT_AFTER_DAYS: 7,        // 마지막 활동 후 N일 경과 → dormant
  RETURN_WINDOW_DAYS: 7,        // 복귀중 유지 기간
  RETURN_COMPLETE_CHECKINS: 3,  // 복귀 완료에 필요한 체크인일 수
  RETURN_BONUS_COOLDOWN_DAYS: 30,
  WEEKLY_CHECKIN_GOAL: 3,
  STOP_NUDGE_AFTER_DORMANT_DAYS: 30,

  MULTIPLIER_CAP: 1.5,
  RISK_MULTIPLIER: 1.2,
  RISK_MULTIPLIER_DAYS: 7,
  RETURN_MULTIPLIER_STEPS: [1.2, 1.3, 1.5],

  DAILY_POINT_CAP: 200,
  SLEEP_BUFFER_MIN: 30,
  POST_SHIFT_QUIET_MIN: 120,

  R1_AT_IDLE_DAYS: 7,
  R2_AT_IDLE_DAYS: 14,
  R3_AT_IDLE_DAYS: 30,

  // 명세에 숫자로 나온 값 중 2장 표에 없던 것들
  ENGINE_NUDGE_HOUR: 12,        // R1~R3 발송 시각
  ALLOWED_HOUR_START: 9,        // 이월·묶음 알림 허용 시각(정각) 시작
  ALLOWED_HOUR_END: 21,         // 끝(포함)
  A4_AFTER_WAKE_MIN: 60,        // 휴무일 예상 기상 + 1시간
  NUDGE_IGNORED_STREAK: 3,
  NUDGE_IGNORE_AFTER_WAKE_MIN: 60,
  WATCH_CHEER_SUGGEST_DAYS: 3,
  FIVE_MIN_DECLINE_DAYS: 7,
  EARLY_USER_FROM_DAY: 3,
  EARLY_USER_TO_DAY: 14,
  STRUCTURAL_NEW_USER_FROM_DAY: 8,
  STRUCTURAL_NEW_USER_TO_DAY: 14,
};

export const POLICY = {
  QUIET_HOURS_ENGINE_NUDGE: 'cancel', // 'cancel' | 'defer_same_day'
  DAILY_CAP_INCLUDES_BONUS: false,
};

export const RISK_SIGNAL_POINTS = {
  freq_drop: 25,
  off_day_silent: 20,
  unconfirmed_pile: 15,
  tired_streak: 15,
  shift_changed: 15,
  early_user: 10,
  nudge_ignored: 10,
  same_lapse: 10,
};

export const BASE_POINTS = {
  workout_done: { points: 30, dailyLimit: 2 },
  sleep_logged: { points: 20, dailyLimit: 1 },
  condition_check: { points: 10, dailyLimit: 1 },
  rest_chosen: { points: 10, dailyLimit: 1 },
  cheer_sent: { points: 10, dailyLimit: 3 },
};

export const BONUS_POINTS = {
  weekly_goal: 100,
  return_complete: 200,
};

export const ACTIVITY_TYPES = ['workout_done', 'sleep_logged', 'condition_check', 'rest_chosen', 'lapse_reason', 'cheer_sent'];

export const ENGINE_NUDGES = ['A4_reminder', 'R1', 'R2', 'R3'];
// 같은 시각에 겹칠 때 알림함 표시 순서 (4.6)
export const NUDGE_ORDER = ['scheduled_workout', 'cheer_bundle', 'R1', 'R2', 'R3', 'A4_reminder', 'event'];

export const SIGNAL_LABELS = {
  freq_drop: '체크인 빈도 감소',
  off_day_silent: '휴무일 2일 연속 무기록',
  unconfirmed_pile: '미확인 예정 운동 누적',
  tired_streak: '피곤함 3회 연속',
  shift_changed: '근무 패턴 변경',
  early_user: '가입 초기(3~14일차)',
  nudge_ignored: '알림 3건 연속 무응답',
  same_lapse: '같은 미실천 이유 반복',
};

export const STATE_LABELS = { active: '활성', watch: '주의', dormant: '휴면', returning: '복귀중' };

export const LAPSE_REASONS = {
  time: '시간 부족',
  fatigue: '피로',
  too_hard: '운동이 어려움',
  schedule_change: '일정 변경',
  no_answer: '답하지 않음',
};

export const RESTART_PLANS = {
  time: { title: '짧게 나눠서 시작해요', items: ['휴무일 1회 루틴', '근무일 3분 스트레칭 2회'] },
  fatigue: { title: '회복부터 챙겨요', items: ['수면 기록 남기기', '퇴근 후 호흡 루틴 3분'] },
  too_hard: { title: '5분 입문 루틴', items: ['동작 설명 보기', '5분 타이머로 따라 하기'] },
  schedule_change: { title: '근무표부터 다시 맞춰요', items: ['근무표 다시 등록하기', '바뀐 근무에 맞춰 자동 재계획'] },
  no_answer: { title: '가볍게 한 번', items: ['5분 루틴 1회'] },
};

export const CHEER_TEMPLATES = [
  { id: 'waiting', text: '기다리고 있어요' },
  { id: 'five_together', text: '같이 5분만 해요' },
  { id: 'slowly', text: '천천히 와도 괜찮아요' },
  { id: 'rest_well', text: '푹 쉬고 와요' },
];

export const NUDGE_COPY = {
  A4_reminder: '오늘은 휴무일이에요. 컨디션만 가볍게 체크해 볼까요?',
  R1_crew: '크루가 응원을 준비하고 있어요. 돌아오면 포인트를 더 드려요.',
  R1_solo: 'ShiftFit이 기다리고 있어요. 돌아오면 포인트를 더 드려요.',
  R2: '요즘 어떤 게 가장 걸렸나요? 한 번만 눌러 알려 주세요.',
  R3: '언제든 편할 때 다시 와요. 이후에는 먼저 알림을 보내지 않을게요.',
};

export const DEFAULT_CONFIG = { RETENTION, POLICY, RISK_SIGNAL_POINTS, BASE_POINTS, BONUS_POINTS };

// 일부 값만 바꾼 설정을 만든다. 예: withConfig({ POLICY: { QUIET_HOURS_ENGINE_NUDGE: 'defer_same_day' } })
export function withConfig(overrides = {}) {
  const out = {};
  for (const key of Object.keys(DEFAULT_CONFIG)) {
    out[key] = { ...DEFAULT_CONFIG[key], ...(overrides[key] || {}) };
  }
  return out;
}
