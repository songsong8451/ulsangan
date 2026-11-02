// 엔진 단위 테스트를 한 번에 돌립니다: Python 활동 엔진 + JS 수면 엔진 두 개.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const python = process.platform === 'win32'
  ? path.join(root, '.venv', 'Scripts', 'python.exe')
  : path.join(root, '.venv', 'bin', 'python');

const suites = [
  ['활동 추천 엔진 (Python)', python, ['-m', 'unittest', 'test_activity_engine']],
  ['수면 엔진 (JS)', process.execPath, ['--test', 'sleep-score.test.js', 'sfs100.test.mjs']],
  ['이탈방지 엔진 (JS)', process.execPath, ['--test', 'retention/engine.test.js']],
];

let failed = 0;
for (const [label, cmd, args] of suites) {
  console.log(`\n▶ ${label}`);
  const r = spawnSync(cmd, args, { cwd: root, stdio: 'inherit' });
  if (r.status !== 0) failed++;
}
console.log(failed ? `\n✖ 단위 테스트 실패 ${failed}건` : '\n✔ 단위 테스트 모두 통과');
process.exit(failed ? 1 : 0);
