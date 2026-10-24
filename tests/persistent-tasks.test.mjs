import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { build } from 'esbuild';

const compiled = await build({ entryPoints: ['source/node-agent-coordinator/persistent-tasks.ts'], bundle: true, write: false, platform: 'node', format: 'esm' });
const { createPersistentTasks, normalizeTaskNotification } = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`);
async function fixture(t, run) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'mengel-tasks-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let clock = 100000;
  const notifications = [];
  const options = { path: path.join(dir, 'tasks.json'), now: () => clock, run: task => run(task), notify: async (task, message) => notifications.push({ task, message }) };
  const tasks = createPersistentTasks(options);
  return { tasks, options, notifications, advance: ms => clock += ms, tools: tasks.tools('a', 'codex', 'Advance through my requested playlist.', false), clock: () => clock };
}
const schedule = tools => tools.call('task_schedule', { objective: 'Finish requested playlist', progress: 'First item is playing; inspect whether it ended before advancing.', delaySeconds: 15 });

test('saved tasks survive reopening, wait until due, and report verified completion only once', async t => {
  let reopened;
  const f = await fixture(t, async () => {
    await reopened.tools('a', 'codex', '', true).call('task_checkpoint', { status: 'completed', progress: 'Both items verified complete.' });
  });
  assert.equal((await schedule(f.tools)).isError, undefined);
  reopened = createPersistentTasks(f.options);
  await reopened.tick();
  assert.equal(f.notifications.length, 0);
  f.advance(15000);
  await reopened.tick();
  assert.equal((await reopened.get('a')).status, 'completed');
  assert.equal(f.notifications.length, 1);
  await reopened.tick();
  assert.equal(f.notifications.length, 1);
});

test('an interrupted run recovers from its checkpoint, not from a replayed action', async t => {
  let seen;
  const f = await fixture(t, async task => { seen = task; });
  await schedule(f.tools);
  const file = JSON.parse(await readFile(f.options.path, 'utf8'));
  file.tasks[0].status = 'running';
  await writeFile(f.options.path, JSON.stringify(file));
  f.advance(15000);
  const recovered = createPersistentTasks(f.options);
  await recovered.tick();
  assert.equal(seen.recovery, true);
  assert.equal(seen.progress, file.tasks[0].progress);
  assert.equal((await recovered.get('a')).status, 'blocked', 'missing checkpoint must not silently keep running');
  assert.match(f.notifications[0].message, /recovery attempt/);
  assert.equal((await recovered.get('a')).progress, file.tasks[0].progress);
  assert.ok(!f.notifications[0].message.includes(file.tasks[0].progress));
});

test('sign-in blockers stop future wakes until explicitly resumed', async t => {
  let count = 0;
  const f = await fixture(t, async () => {
    count++;
    await f.tasks.tools('a', 'codex', '', true).call('task_checkpoint', { status: 'blocked', progress: 'Private site state and URLs.', message: 'Please sign in to the site and tell me to resume.' });
  });
  await schedule(f.tools); f.advance(15000); await f.tasks.tick();
  f.advance(60000); await f.tasks.tick();
  assert.equal(count, 1);
  assert.match(f.notifications[0].message, /sign in/);
  assert.equal((await f.tasks.tools('a', 'codex', '', true).call('task_resume', {})).isError, true);
  assert.equal((await f.tools.call('task_resume', {})).isError, undefined);
  f.advance(15000); await f.tasks.tick();
  assert.equal(count, 2);
});

test('cancellation wins over an in-flight failing run and revoked tool calls', async t => {
  let release, started;
  const begin = new Promise(resolve => started = resolve);
  const f = await fixture(t, async () => { started(); await new Promise(resolve => release = resolve); throw new Error('interrupted'); });
  await schedule(f.tools); f.advance(15000);
  const running = f.tasks.tick(); await begin;
  const controller = new AbortController();
  const tools = f.tasks.tools('a', 'codex', '', true, controller.signal);
  controller.abort();
  await f.tasks.stop('a'); release(); await running;
  await assert.rejects(tools.call('task_checkpoint', { status: 'waiting', progress: 'stale' }), /abort/i);
  assert.equal((await f.tasks.get('a')).status, 'cancelled');
  assert.equal(f.notifications.length, 0);
});

test('failures back off, stop after three attempts, and never loop forever', async t => {
  let count = 0;
  const f = await fixture(t, async () => { count++; throw new Error('network lost'); });
  await schedule(f.tools); f.advance(15000);
  await f.tasks.tick(); await f.tasks.tick(); assert.equal(count, 1);
  f.advance(30000); await f.tasks.tick(); assert.equal(count, 2);
  f.advance(60000); await f.tasks.tick(); assert.equal(count, 3);
  f.advance(120000); await f.tasks.tick(); assert.equal(count, 3);
  assert.equal((await f.tasks.get('a')).status, 'blocked');
  assert.equal(f.notifications.length, 1);
});

test('elapsed budget pauses without running, while routine checkpoints remain quiet', async t => {
  let count = 0;
  const f = await fixture(t, async () => { count++; await f.tasks.tools('a', 'codex', '', true).call('task_checkpoint', { status: 'waiting', progress: 'Still playing.', delaySeconds: 60 }); });
  await schedule(f.tools); f.advance(15000); await Promise.all([f.tasks.tick(), f.tasks.tick()]);
  assert.equal(count, 1); assert.equal(f.notifications.length, 0);
  f.advance(4 * 60 * 60 * 1000); await f.tasks.tick();
  assert.equal(count, 1); assert.equal((await f.tasks.get('a')).status, 'blocked');
  assert.match(f.notifications[0].message, /limit/);
});

test('corrupt task files fail closed repeatedly and are preserved', async t => {
  const f = await fixture(t, async () => assert.fail('must not run'));
  await writeFile(f.options.path, '{"schemaVersion":99}');
  for (let i = 0; i < 2; i++) assert.equal((await schedule(f.tools)).isError, true);
  assert.equal(await readFile(f.options.path, 'utf8'), '{"schemaVersion":99}');
});

test('foreground interruption defers without consuming the failure budget; pause can resume', async t => {
  const f = await fixture(t, async () => { throw new DOMException('User message arrived', 'AbortError'); });
  await schedule(f.tools); f.advance(15000); await f.tasks.tick();
  assert.equal((await f.tasks.get('a')).failures, 0);
  assert.equal((await f.tasks.get('a')).status, 'waiting');
  await f.tasks.stop('a', true);
  assert.equal((await f.tasks.get('a')).status, 'blocked');
  assert.equal((await f.tools.call('task_resume', {})).isError, undefined);
  assert.equal((await f.tasks.get('a')).status, 'waiting');
});


test('private checkpoints never appear in chat and pausing preserves recovery notes', async t => {
  const secret = 'Internal checkpoint /mnt/data/private.json ' + 'details '.repeat(800);
  const f = await fixture(t, async () => {
    await f.tools.call('task_checkpoint', { status: 'blocked', progress: secret, message: 'Please sign in before continuing.' });
  });
  await schedule(f.tools); f.advance(15000); await f.tasks.tick();
  assert.equal(f.notifications[0].message, 'Please sign in before continuing.');
  assert.equal((await f.tasks.get('a')).progress, secret.trim().slice(0, 6000));
  await f.tasks.stop('a', true);
  assert.equal((await f.tasks.get('a')).progress, secret.trim().slice(0, 6000));
  await f.tools.call('task_resume', {});
  assert.equal((await f.tasks.get('a')).message, undefined);
});

test('legacy checkpoints without a public message use a short fallback', async t => {
  const f = await fixture(t, async () => {
    await f.tools.call('task_checkpoint', { status: 'completed', progress: 'PRIVATE INTERNAL NOTES '.repeat(200) });
  });
  await schedule(f.tools); f.advance(15000); await f.tasks.tick();
  assert.equal(f.notifications.length, 1);
  assert.ok(f.notifications[0].message.length < 100);
  assert.ok(!f.notifications[0].message.includes('PRIVATE'));
});


test('legacy missing-checkpoint pauses recover private notes without resuming', async t => {
  const f = await fixture(t, async () => assert.fail('must remain paused'));
  await schedule(f.tools);
  const file = JSON.parse(await readFile(f.options.path, 'utf8'));
  const prefix = 'Task paused because the agent did not save its next step. Last checkpoint: ';
  const original = file.tasks[0].progress;
  file.tasks[0].status = 'blocked'; file.tasks[0].progress = prefix + original;
  await writeFile(f.options.path, JSON.stringify(file));
  const reopened = createPersistentTasks(f.options);
  assert.equal((await reopened.get('a')).progress, original);
  assert.equal((await reopened.get('a')).status, 'blocked');
  f.advance(300000); await reopened.tick();
  const visible = normalizeTaskNotification('Task paused: ' + prefix + original);
  assert.ok(!visible.includes(original));
  assert.ok(visible.length < 200);
  assert.equal(normalizeTaskNotification('ordinary user text'), 'ordinary user text');
});
