'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { run } = require('../src/proc');

test('process runner reports timeouts distinctly from non-zero exits', async () => {
  await assert.rejects(
    run(process.execPath, ['-e', 'setTimeout(() => {}, 1000)'], { timeout: 20 }),
    /timed out after 20ms/,
  );

  await assert.rejects(
    run(process.execPath, ['-e', 'process.exit(7)']),
    /exited with 7/,
  );
});
