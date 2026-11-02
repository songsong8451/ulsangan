# ShiftFit 엔진 정리

## 1. SFS-100 v2 수면 점수 (`sfs100.js`, 화면이 사용)

6영역 합계 100점. 입력이 없는 영역은 빼고 "얻은 점수 ÷ 가능한 만점 × 100"으로 환산(`mode: partial`).

| 영역 | 만점 | 규칙 |
|---|---|---|
| 수면 시간(낮잠 포함) | 30 | 4h 미만 0 → 4~7h 시간당 10점 → 7~9h 30 → 9h 넘으면 감점(야간 연속 뒤 첫 휴무는 감점 없음) |
| 기상 후 회복감 | 20 | 피로도 1~10 역채점 |
| 수면 만족도 | 15 | 1~10 직선 |
| 근무 연계 타이밍 | 15 | 근무 간 휴식 ≥11h 8점/≥9h 4점, 야간: 퇴근 2h 안 잠들기 +4·출근 전 4h 내 낮잠 +3, 그 외: 밤(22~08시) 비중 ≥50% +7 |
| 효율·연속성 | 10 | 중간 깸(WASO) ≤20분 10/≤40분 6/그 외 2, 효율 ≥85% 10/≥65% 5 → 둘 중 낮은 값 |
| 규칙성 | 10 | 같은 근무 유형 평균 잠든 시각(원형 평균)과 차이 ≤60분 10/≤120분 6/그 외 2, 기록 2건 미만이면 7 |

등급: 85↑ 충분히 회복 · 70↑ 보통 · 50↑ 회복 부족 · 그 아래 회복 필요.
`buildFeedback`: 잃은 점수가 큰 영역부터 권고 최대 2개, 안전 안내(야간+50점 미만 → 졸음운전, 최근 3일 모두 50 미만 → 상담).
`energyScore`(홈 컨디션): `0.6×오늘 + 0.4×최근3일 평균 − 수면부채 벌점(최대 15)`, 매우 졸리면 49 상한 → 좋음/보통/낮음/쉬어가기와 루틴 길이.

## 2. 이전 수면 점수 (`sleep-score.js`, `app.py` `activity_sleep_score`)

4영역 × 25점 같은 비중(RU-SATED 방식): 시간(4h=0, 6h=60, 7h=100), 연속성(NSF 기준 잠들기 30/45분, 깸 20/41분, 깬 횟수 1/4, 효율 85/64%), 만족도, 회복감. 2영역 이상 있어야 계산. 서버는 저장된 SFS 점수가 없을 때만 이 식으로 대신 계산한다.

## 3. 활동 추천 엔진 (`app.py` `evaluate_activity_recommendation`)

입력: shift(오늘·어제 근무, 근무시간, 다음 출근), checkIn(불편함·의도·KSS 졸림), conditionScore, sleep 기록, nextSleep, weather(날씨·대기질·예보), nearby(공원).

판단 사슬(먼저 걸리면 거기서 끝):
1. 안전 차단 — `USER_REPORTED_DISCOMFORT`, `USER_CHOSE_REST`, `WORKING_SHIFT`(휴게 중이면 짧게 허용), `NEXT_SHIFT_SOON`(15분), `NOT_ENOUGH_TIME`(3분 미만), `PLANNED_SLEEP`, `HIGH_SLEEPINESS`(KSS≥7), `VERY_LOW_CONDITION_SCORE`(<35), `HIGH_REPORTED_FATIGUE`(≥8), `SHORT_SLEEP`(<4h)
2. 강도 결정 — 수면점수·컨디션 <55 저강도, <75 가볍게
3. 실내/실외 — `ENVIRONMENT_DATA_UNKNOWN`, `AIR_QUALITY_POOR`, `RAIN_OR_SNOW`, `AFTER_NIGHT_SHIFT`/`LATE_SHIFT_END`(퇴근 3시간 안), `PARK_ACCESS_UNKNOWN`, `NO_VERIFIED_PARK` → 실내. 모두 통과하면 `WEATHER_AND_AIR_OK` 공원 산책
4. 시간 맞추기 — 남은 시간·다음 수면 전에 단계별 분을 잘라 맞춤, 공원은 06~18시 안에 끝나야 함(`PARK_TOO_LATE`, `NOT_ENOUGH_TIME_FOR_PARK`)
5. 루틴 — 근무 유형별 3단계 × 5분, 울산광역시 취약노동자 건강증진센터 유튜브 영상(목·어깨·발목·허리)

## 4. 외부 데이터

기상청 단기예보(격자 변환 `kma_grid`), 에어코리아 실시간 대기질, 공공데이터포털 도시공원, 공유누리 공공체육시설, OSM Nominatim 주소↔좌표. 날씨는 5분 캐시 + 30분 "마지막 정상값" 대비책.
