---
name: shiftfit
description: ShiftFit(교대근무 웰니스, 저장소 songsong8451/ulsangan) 코드를 고치거나 기능을 더하거나 배포할 때 쓴다. 구조·엔진(수면 SFS-100, 활동 추천)·데이터(Supabase)·디자인 토큰·루프 엔지니어링(Playwright 하네스)·Vercel 재배포 규칙을 담는다.
---

# ShiftFit 작업 스킬

교대근무자(주간·오후·야간·비번·휴무)의 수면 회복과 가벼운 운동을 돕는 웹앱. 현재 배포본은 짓다(jitda.io), Vercel로 옮길 예정.

## 한눈에 보는 구조

| 파일 | 역할 |
|---|---|
| `app.py` (Flask, ~1700줄) | 정적 파일 제공 + `/api/weather`(기상청·에어코리아) + `/api/nearby`(공원·공공체육시설) + `/v1/activity-recommendations/evaluate`(활동 추천 엔진) |
| `index.html` (한 파일, ~250KB, 압축된 한 줄 CSS/JS) | 화면 전체. `showPage(name)`으로 `#page-home/calendar/workout/sleep/crew/profile` 전환. 메뉴는 데스크톱 사이드바와 모바일 하단 두 벌(`.nav-btn[data-page]`) |
| `sfs100.js` (ESM) | **화면이 실제로 쓰는 수면 엔진** SFS-100 v2: `scoreSleep`·`buildFeedback`·`energyScore` |
| `sleep-score.js` | 이전 수면 엔진(NSF 4영역×25점). 화면은 안 쓰고, 같은 식이 `app.py`의 `activity_sleep_score`에 파이썬으로 복제돼 있다 → 둘을 고칠 땐 함께 고친다 |
| `watch-monitor.js` | Web Bluetooth 심박(0x180D) 연결. 보안 컨텍스트(https)에서만 동작 |
| `supabase-schema.sql` | `user_profiles`·`shift_times`·`shift_overrides`·`inbody_records`·`sleep_records`, 전부 RLS "본인 것만" |

엔진 세부 규칙은 [references/engines.md](references/engines.md), 디자인 토큰은 [references/design.md](references/design.md).

## 지켜야 할 규칙

1. **공개키만 화면으로.** `/api/supabase-config`는 `url`·`publishableKey`만 낸다. service_role 키를 코드나 응답에 절대 넣지 않는다(하네스가 검사).
2. **외부 API 키는 환경변수.** `DATA_GO_KR_SERVICE_KEY`, `ESHARE_API_KEY`, `DATA_GO_KR_WEATHER_SERVICE_KEY`, `DATA_GO_KR_AIR_SERVICE_KEY`, `SUPABASE_PUBLISHABLE_KEY`. 키가 없으면 503 + JSON으로 답하는 것이 정상 설계(500이면 버그).
3. **안전 우선 판단 순서**를 바꾸지 않는다: 불편함 → 쉬기 선택 → 근무 중 → 15분 내 출근 → 시간 부족 → 수면 예정 → 졸림(KSS≥7) → 컨디션<35 → 피로≥8 → 수면<4h → 그다음에야 날씨·공기·공원. 새 조건은 이 사슬 안 올바른 자리에 끼운다.
4. **시간대는 Asia/Seoul.** Windows에선 `tzdata` 필요(requirements에 있음).
5. **index.html은 압축된 한 줄 코드가 많다.** Edit는 충분히 긴 고유 문자열로 잡고, 고친 뒤 반드시 하네스를 돌린다.
6. 의료 진단처럼 말하지 않는다. 문구는 "~해 보세요", 지속되면 "전문가 상담" 안내 수준.

## 루프 엔지니어링 (고치기 → 확인 → 반복)

하네스: `harness/` (Node, Playwright 1.56.1). 저장소 루트에 package.json을 두지 않는 이유는 Vercel이 Node 프로젝트로 오인하지 않게 하려는 것.

```bash
cd harness && npm i            # 처음 한 번
npm run loop                   # 단위(Python 30건 + JS) → Playwright(데스크톱·모바일)
npm run e2e:remote             # 짓다 배포본 점검
node run-remote.mjs https://<vercel-주소>   # Vercel 배포본 점검
npm run report                 # 실패 시 스크린샷·트레이스
```

- 로컬 서버는 하네스가 **3100번**에 자동으로 띄운다(3000번은 이 PC의 sms-frontend와 겹침). 미리보기는 launch.json의 `ulsangan`(3000번).
- 한 번의 루프: ① 실패하는 테스트나 재현 화면을 먼저 만든다 → ② 고친다 → ③ `npm run loop` → ④ 화면 변경이면 브라우저 미리보기로 데스크톱·375px 모두 눈으로 확인 → ⑤ 통과하면 커밋.
- 새 화면·API를 만들면 `harness/e2e/`에 점검을 같이 추가한다.

## Vercel 재배포 메모

- Vercel의 Python 런타임은 루트의 `app.py`에서 Flask `app`을 찾아 서버리스 함수로 띄운다. 정적 파일도 지금처럼 Flask 라우트로 나간다.
- 서버리스라 `cachetools` 메모리 캐시(날씨 5분)는 인스턴스마다 따로이고 오래 안 간다 → 기능은 유지되나 외부 API 호출이 늘 수 있다.
- 환경변수 5개를 Vercel 프로젝트 설정에 넣는다. Supabase Auth의 Kakao 리디렉트 URL에 새 Vercel 도메인을 추가해야 로그인이 된다.
- 배포 뒤 `node run-remote.mjs <주소>`로 같은 16건을 확인한다.
