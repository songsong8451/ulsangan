import { test, expect } from '@playwright/test';

// 이탈방지·복귀유도 엔진: 관리자 대시보드 + 앱 화면(시뮬레이터·알림함·복귀 화면) + 수용 기준 중 화면으로 볼 것.
test.describe('관리자 대시보드', () => {
  test('토큰 없이 실제 데이터를 요청하면 401 JSON으로 막는다', async ({ request }) => {
    const res = await request.get('/api/admin/retention');
    expect(res.status()).toBe(401);
    expect(res.headers()['content-type']).toMatch(/json/);
  });

  test('관리자 확인은 토큰이 없으면 admin=false', async ({ request }) => {
    expect((await (await request.get('/api/admin/me')).json()).admin).toBe(false);
  });

  test('엔진 모듈만 제공하고 다른 파일은 막는다', async ({ request }) => {
    expect((await request.get('/retention/engine.js')).status()).toBe(200);
    expect((await request.get('/retention/engine.test.js')).status()).toBe(404);
  });

  test('시뮬레이션 대시보드가 그려진다', async ({ page }) => {
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto('/admin?demo=1');
    await expect(page.locator('#dashboard')).toBeVisible({ timeout: 20000 });
    await expect(page.locator('#user-rows tr')).toHaveCount(80);
    await expect(page.locator('#k-r1')).toContainText('%');
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(1);
    expect(errors).toEqual([]);
  });
});

test.describe('이탈방지 앱 화면', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.evaluate(() => localStorage.clear());
  });

  test('접속만 하면 활동으로 치지 않고, 홈 리듬 카드와 알림함이 보인다', async ({ page }) => {
    await page.goto('/');
    await page.reload();
    await expect(page.locator('#rt-rhythm')).toContainText('이번 주 체크인 0/3일');
    expect(await page.evaluate(() => window.ShiftFitRetention.getState().lastActiveAt)).toBeNull();
    await expect(page.locator('#rt-sim')).toBeHidden();
    await expect(page.locator('#admin-mode')).toBeHidden();
    await page.locator('#notify-btn:visible').click();
    await expect(page.locator('#rt-inbox')).toBeVisible();
    await expect(page.locator('#rt-inbox-list')).toContainText('새로운 알림이 없어요');
  });

  test('컨디션 체크는 체크인 + 10P, 같은 날 두 번은 막힌다', async ({ page }) => {
    await page.goto('/');
    await page.locator('[data-rt-condition="ok"]').click();
    await expect(page.locator('#retention-toast')).toContainText('+10P');
    await expect(page.locator('#rt-rhythm')).toContainText('1/3일');
    await expect(page.locator('[data-rt-condition="good"]')).toBeDisabled();
  });

  test('시뮬레이터 프리셋 3개: 위험 진입 → 휴면·복귀 → 복귀 완료', async ({ page }) => {
    await page.goto('/?demo=1');
    await expect(page.locator('#rt-sim')).toBeVisible();
    await page.locator('[data-rt-preset="risk"]').click();
    await expect(page.locator('.rt-badge-watch')).toContainText('1.2배');
    await page.locator('[data-rt-preset="return"]').click();
    await expect(page.locator('.rt-badge-returning')).toContainText('복귀 1/3일차 · 지금 포인트 ×1.2');
    await page.locator('#notify-btn:visible').click();
    await expect(page.locator('#rt-inbox-list')).toContainText('수진님 외 2명이 응원을 보냈어요');
    await page.locator('#rt-inbox [data-rt-close]').click();
    await page.locator('[data-rt-preset="complete"]').click();
    await expect(page.locator('.rt-badge-complete')).toContainText('+200P');
  });

  test('복귀 첫 화면에 공백 일수가 없다', async ({ page }) => {
    await page.goto('/?demo=1');
    await page.locator('[data-rt-sim-shift="14"]').click();
    const sheet = page.locator('#rt-return');
    await expect(sheet).toBeVisible();
    await expect(sheet).toContainText('다시 오셨네요');
    expect(await sheet.innerText()).not.toMatch(/\d+\s*일/);
    await page.locator('[data-rt-return-condition="ok"]').click();
    expect(await sheet.innerText()).not.toMatch(/\d+\s*일/);
    await page.locator('[data-rt-return-reason="too_hard"]').click();
    await expect(sheet).toContainText('5분 입문 루틴');
  });

  test('크루원에게 가는 데이터엔 위험·휴면·수면·피로·이유가 없다', async ({ page }) => {
    await page.goto('/?demo=1');
    await page.locator('[data-rt-sim-shift="14"]').click();
    const view = await page.evaluate(() => window.ShiftFitRetention.crewView());
    expect(Object.keys(view).sort()).toEqual(['cheersReceived', 'nickname', 'recommendCheer']);
    expect(JSON.stringify(view)).not.toMatch(/risk|dormant|sleep|fatigue|tired|lapse|reason/i);
  });

  test('저장소 접근이 실패해도 앱이 깨지지 않는다', async ({ page }) => {
    await page.addInitScript(() => {
      const fail = () => { throw new Error('storage blocked'); };
      Storage.prototype.getItem = fail;
      Storage.prototype.setItem = fail;
      Storage.prototype.removeItem = fail;
    });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto('/');
    await expect(page.locator('#rt-rhythm')).toBeVisible();
    await page.locator('[data-rt-condition="good"]').click();
    await expect(page.locator('#rt-rhythm')).toContainText('1/3일');
    await page.locator('.nav-btn[data-page="sleep"]:visible').first().click();
    await expect(page.locator('#page-sleep')).toHaveClass(/active/);
    expect(errors).toEqual([]);
  });
});
