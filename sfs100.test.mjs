import assert from 'node:assert/strict';
import * as SFS100 from './sfs100.js';

const recovered = SFS100.energyScore({
  todaySfs: 90,
  last3Sfs: [90, 80, 100],
  last3TstH: [7, 8, 7],
});
assert.equal(recovered.energy, 90);
assert.equal(recovered.label, '좋음');

const sleepDebt = SFS100.energyScore({
  todaySfs: 80,
  last3Sfs: [80, 80, 80],
  last3TstH: [5, 5, 5],
});
assert.equal(sleepDebt.energy, 68);
assert.equal(sleepDebt.label, '보통');

const verySleepy = SFS100.energyScore({
  todaySfs: 100,
  last3Sfs: [100],
  last3TstH: [7],
  sleepinessNow: 'very',
});
assert.equal(verySleepy.energy, 49);
assert.equal(verySleepy.label, '낮음');
assert.equal(verySleepy.routine, '스트레칭·호흡 5분');

console.log('SFS-100 energy engine tests passed');
