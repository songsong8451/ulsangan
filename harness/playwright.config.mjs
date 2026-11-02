import { defineConfig, devices } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const python = process.platform === 'win32'
  ? path.join(root, '.venv', 'Scripts', 'python.exe')
  : path.join(root, '.venv', 'bin', 'python');

// BASE_URL을 주면 배포본(짓다·Vercel)을 점검하고, 없으면 로컬 Flask를 3100번에 띄웁니다.
// 3000번은 이 PC의 sms-frontend와 겹쳐서 피합니다.
const PORT = Number(process.env.HARNESS_PORT || 3100);
const remote = process.env.BASE_URL;

export default defineConfig({
  testDir: './e2e',
  outputDir: './.results',
  timeout: 30_000,
  retries: remote ? 1 : 0,
  reporter: [['list'], ['html', { outputFolder: './.report', open: 'never' }]],
  use: {
    baseURL: remote || `http://127.0.0.1:${PORT}`,
    locale: 'ko-KR',
    timezoneId: 'Asia/Seoul',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 } } },
    { name: 'mobile', use: { ...devices['Pixel 7'] } },
  ],
  webServer: remote ? undefined : {
    command: `"${python}" app.py`,
    cwd: root,
    env: { PORT: String(PORT) },
    url: `http://127.0.0.1:${PORT}/`,
    reuseExistingServer: true,
    timeout: 30_000,
  },
});
