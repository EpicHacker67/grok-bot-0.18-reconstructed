import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { build } from 'esbuild';

const compiled = await build({ stdin: { contents: `export { createRoutedRoutines } from './source/node-agent-coordinator/routed-routines.ts'; export { FileAutomationStore } from './source/host/automations/automation-store.ts'; export { computeNextRunAt } from './source/shared/automation-schedule.ts';`, resolveDir: process.cwd() }, bundle: true, platform: 'node', format: 'esm', write: false });
const { createRoutedRoutines, FileAutomationStore, computeNextRunAt } = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`);
const data = result => JSON.parse(result.content[0].text);
const spec = { action: 'create', name: 'Daily fixture', prompt: 'Summarize the fixture; notify only on changes.', schedule: '0 17 * * *', timeZone: 'America/Chicago', enabled: false };
async function fixture(t, wrap = fn => fn) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'mengel-routines-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new FileAutomationStore(path.join(dir, 'automations'));
  const calls = [];
  const dispatch = wrap(async (method, args) => {
    calls.push({ method, args });
    assert.equal(args.id, 'current-agent');
    switch (method) {
      case 'getAgentAutomations': return store.list();
      case 'createAgentAutomation': store.upsert(args.spec); break;
      case 'updateAgentAutomation': store.update(args.automationId, args.spec); break;
      case 'setAgentAutomationEnabled': store.setEnabled(args.automationId, args.isEnabled); break;
      case 'deleteAgentAutomation': store.remove(args.automationId); break;
      default: assert.fail(method);
    }
    return store.list();
  });
  const controller = new AbortController();
  const tools = createRoutedRoutines('current-agent', dispatch, { timeZone: 'America/Chicago', signal: controller.signal });
  return { dir, store, tools, calls, controller };
}

test('routine creation uses the native store and preserves timezone across restarts and DST', async t => {
  const f = await fixture(t);
  const result = await f.tools.call('routine_manage', spec);
  assert.ok(!result.isError);
  const saved = data(result).routine;
  assert.equal(saved.trigger.schedule, 'CRON_TZ=America/Chicago 0 17 * * *');
  assert.equal(saved.isEnabled, false);
  const reopened = new FileAutomationStore(path.join(f.dir, 'automations'));
  assert.equal(reopened.get(saved.id).prompt, spec.prompt);
  assert.equal(new Date(computeNextRunAt(saved.trigger.schedule, Date.parse('2026-11-12T00:00:00Z'))).toISOString(), '2026-11-12T23:00:00.000Z');
  assert.equal(new Date(computeNextRunAt(saved.trigger.schedule, Date.parse('2026-07-12T00:00:00Z'))).toISOString(), '2026-07-12T22:00:00.000Z');
  assert.equal(data(await f.tools.call('routine_list', {})).routines[0].id, saved.id);
});

test('partial update preserves schedule, prompt, enabled state, and history; toggles and delete verify persistence', async t => {
  const f = await fixture(t);
  const { id } = data(await f.tools.call('routine_manage', spec)).routine;
  f.store.recordRun(id, Date.now());
  const updated = await f.tools.call('routine_manage', { action: 'update', id, name: 'Renamed fixture' });
  assert.ok(!updated.isError);
  const saved = f.store.get(id);
  assert.equal(saved.prompt, spec.prompt); assert.equal(saved.isEnabled, false);
  assert.equal(saved.trigger.schedule, 'CRON_TZ=America/Chicago 0 17 * * *');
  assert.ok(saved.lastRunAt);
  assert.equal(data(await f.tools.call('routine_manage', { action: 'resume', id })).routine.isEnabled, true);
  assert.equal(data(await f.tools.call('routine_manage', { action: 'pause', id })).routine.isEnabled, false);
  assert.equal(data(await f.tools.call('routine_manage', { action: 'delete', id })).deleted, true);
  assert.equal(f.store.list().length, 0);
});

test('concurrent and repeated creates reuse an identical routine instead of duplicating it', async t => {
  const f = await fixture(t);
  const results = await Promise.all([f.tools.call('routine_manage', spec), f.tools.call('routine_manage', spec)]);
  assert.equal(f.store.list().length, 1);
  assert.equal(data(results[1]).alreadyExists, true);
  const conflict = await f.tools.call('routine_manage', { ...spec, prompt: 'Changed instructions' });
  assert.equal(conflict.isError, true);
  assert.equal(f.calls.filter(c => c.method === 'createAgentAutomation').length, 1);
});

test('validation rejects invalid schedules, IDs, cross-agent arguments, and ambiguous updates before mutation', async t => {
  const f = await fixture(t);
  for (const args of [
    { ...spec, schedule: '61 17 * * *' }, { ...spec, timeZone: 'Not/AZone' },
    { ...spec, schedule: 'CRON_TZ=UTC 0 17 * * *' }, { ...spec, schedule: '0 0 31 2 *' },
    { ...spec, agentId: 'another-agent' }, { ...spec, enabled: 'false' }, { ...spec, name: 'two\nlines' },
    { action: 'update', id: '../another-agent', name: 'wrong' }, { action: 'resume', id: 'not-found' },
  ]) assert.equal((await f.tools.call('routine_manage', args)).isError, true);
  assert.equal(f.store.list().length, 0);
  assert.ok(f.calls.every(c => c.method === 'getAgentAutomations'));
});

test('silent host rejection is not reported as saved', async t => {
  const f = await fixture(t, fn => (method, args) => method === 'createAgentAutomation' ? Promise.resolve([]) : fn(method, args));
  const result = await f.tools.call('routine_manage', spec);
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /not confirmed/);
});

test('uncertain sends are not retried; later create discovers the persisted result', async t => {
  let writes = 0;
  const f = await fixture(t, fn => async (method, args) => {
    const result = await fn(method, args);
    if (method === 'createAgentAutomation') { writes++; throw new Error('Connection lost after save; outcome unknown'); }
    return result;
  });
  assert.equal((await f.tools.call('routine_manage', spec)).isError, true);
  assert.equal(data(await f.tools.call('routine_manage', spec)).alreadyExists, true);
  assert.equal(writes, 1);
});

test('cancelled routine calls cannot mutate state', async t => {
  const f = await fixture(t); f.controller.abort();
  await assert.rejects(f.tools.call('routine_manage', spec), /abort/i);
  assert.equal(f.calls.length, 0);
});

test('missing routine backend fails instead of pretending no routines exist', async () => {
  const tools = createRoutedRoutines('a', async () => ({ entries: [] }), { timeZone: 'America/Chicago' });
  assert.equal((await tools.call('routine_list', {})).isError, true);
  assert.equal((await tools.call('routine_manage', spec)).isError, true);
});
