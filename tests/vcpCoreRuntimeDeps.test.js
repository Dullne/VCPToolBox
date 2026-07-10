const test = require('node:test');
const assert = require('node:assert/strict');

const runsInsideVcpCoreContainer =
  process.platform === 'linux' &&
  process.arch === 'arm64' &&
  process.cwd() === '/usr/src/app';
const containerOnly = runsInsideVcpCoreContainer
  ? false
  : 'vcp-core Linux/arm64 container runtime smoke only';

test('vcp-core runtime can load the SSH transport dependency', { skip: containerOnly }, () => {
  assert.doesNotThrow(() => require('ssh2'));
});

test('rust-vexus-lite exposes native methods used by VCP core', { skip: containerOnly }, () => {
  const { VexusIndex } = require('../rust-vexus-lite');
  const methods = Object.getOwnPropertyNames(VexusIndex.prototype);

  for (const method of [
    'computeEpaBasis',
    'publishEpaBasisCache',
    'computePairwiseSimilarities',
    'computeIntrinsicResiduals'
  ]) {
    assert(
      methods.includes(method),
      `VexusIndex.prototype is missing ${method}`
    );
  }
});
