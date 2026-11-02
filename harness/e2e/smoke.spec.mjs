import { test, expect } from '@playwright/test';

const PAGES = ['home', 'calendar', 'workout', 'sleep', 'crew'];

// 키가 없는 로컬·외부 서비스(지도·유튜브·Supabase) 때문에 생기는 오류는 앱 결함이 아니라서 거릅니다.
const IGNORED = /supabase|kakao|youtube|googleapis|gstatic|favicon|net::ERR|Failed to load resource/i;

test.describe('화면 골격', () => {
  test('첫 화면이 뜨고 제목·오늘 탭이 보인다', async ({ page }) => {
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error' && !IGNORED.test(m.text())) errors.push(m.text()); });

    await page.goto('/');
    await expect(page).toHaveTitle(/ShiftFit/);
    await expect(page.locator('#page-home')).toHaveClass(/active/);
    await page.waitForLoadState('networkidle').catch(() => {});
    expect(errors, `콘솔 오류:\n${errors.join('\n')}`).toEqual([]);
  });

  test('메뉴 5개를 차례로 눌러 화면이 바뀐다', async ({ page }) => {
    await page.goto('/');
    for (const name of PAGES) {
      await page.locator(`.nav-btn[data-page="${name}"]:visible`).first().click();
      await expect(page.locator(`#page-${name}`)).toHaveClass(/active/);
      await expect(page.locator('.page.active')).toHaveCount(1);
    }
  });

  test('가로 스크롤이 생기지 않는다', async ({ page }) => {
    await page.goto('/');
    for (const name of PAGES) {
      await page.locator(`.nav-btn[data-page="${name}"]:visible`).first().click();
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(overflow, `${name} 화면 가로 넘침 ${overflow}px`).toBeLessThanOrEqual(1);
    }
  });
});

test.describe('서버 API', () => {
  test('정적 엔진 파일이 제공된다', async ({ request }) => {
    for (const file of ['/sfs100.js', '/watch-monitor.js', '/shiftfit-logo.png']) {
      const res = await request.get(file);
      expect(res.status(), file).toBe(200);
    }
  });

  test('Supabase 설정은 공개키만 내준다', async ({ request }) => {
    const res = await request.get('/api/supabase-config');
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(Object.keys(body).sort()).toEqual(['publishableKey', 'url']);
    expect(JSON.stringify(body)).not.toMatch(/service_role/);
  });

  test('불편함을 알리면 운동을 열지 않는다', async ({ request }) => {
    const res = await request.post('/v1/activity-recommendations/evaluate', { data: { checkIn: { discomfort: true } } });
    const body = await res.json();
    expect(body.showModal).toBe(false);
    expect(body.reasonCodes).toContain('USER_REPORTED_DISCOMFORT');
  });

  test('쉬기를 고르면 쉬기로 답한다', async ({ request }) => {
    const res = await request.post('/v1/activity-recommendations/evaluate', { data: { checkIn: { intent: 'rest' } } });
    const body = await res.json();
    expect(body.showModal).toBe(false);
    expect(body.reasonCodes).toContain('USER_CHOSE_REST');
  });

  // 키가 없으면 서버가 503(일시 사용 불가)으로 답하도록 설계돼 있어 500(서버 오류)만 막습니다.
  test('날씨·주변 API는 키가 없어도 서버 오류 없이 JSON으로 답한다', async ({ request }) => {
    for (const url of ['/api/weather?lat=35.5384&lon=129.3114', '/api/nearby?lat=35.5384&lon=129.3114&radius=3']) {
      const res = await request.get(url);
      expect(res.status(), url).not.toBe(500);
      expect(res.headers()['content-type'], url).toMatch(/json/);
    }
  });
});
