import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
const compiled = await build({ entryPoints: ['source/node-agent-coordinator/turn-watchdog.ts'], bundle: true, write: false, platform: 'node', format: 'esm' });
const { createTurnWatchdog, TurnTimeoutError } = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`);

test('a productive turn survives the old ten-minute cutoff; a silent stall still stops', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const controller = new AbortController(), watchdog = createTurnWatchdog(controller);
  for (let i = 0; i < 8; i++) {
    t.mock.timers.tick(9 * 60000); watchdog.progress();
    assert.equal(controller.signal.aborted, false, 'continued activity must extend idle budget');
  }
  t.mock.timers.tick(10 * 60000);
  assert.equal(controller.signal.aborted, true);
  assert.ok(controller.signal.reason instanceof TurnTimeoutError);
  assert.equal(controller.signal.reason.kind, 'idle');
  watchdog.close();
});

test('continuous work has a four-hour ceiling and disposal clears both clocks', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const controller = new AbortController(), watchdog = createTurnWatchdog(controller);
  for (let i = 0; i < 48; i++) { t.mock.timers.tick(5 * 60000); watchdog.progress(); }
  assert.equal(controller.signal.reason.kind, 'total'); watchdog.close();
  const another = new AbortController(), disposed = createTurnWatchdog(another);
  disposed.close(); disposed.progress(); t.mock.timers.tick(5 * 60 * 60000);
  assert.equal(another.signal.aborted, false);
});
