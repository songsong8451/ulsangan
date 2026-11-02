// 배포본 점검: node run-remote.mjs [주소]  (기본값: 현재 짓다 배포본)
import { spawnSync } from 'node:child_process';

const url = process.argv[2] || process.env.BASE_URL || 'https://vi7rabjwt429og3e.jitda.io';
console.log(`▶ 배포본 점검: ${url}`);
const r = spawnSync('npx', ['playwright', 'test'], {
  stdio: 'inherit',
  shell: process.platform === 'win32',
  env: { ...process.env, BASE_URL: url },
});
process.exit(r.status ?? 1);
