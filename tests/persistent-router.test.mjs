import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { build } from 'esbuild';

async function until(check) {
  const deadline = Date.now() + 12000;
  while (!await check()) { assert.ok(Date.now() < deadline, 'router did not reach expected state'); await new Promise(resolve => setTimeout(resolve, 15)); }
}
async function fixture(t, provider, route = 'codex') {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'mengel-task-router-'));
  const key = `taskProvider${Math.random()}`;
  globalThis[key] = provider;
  const output = path.join(dir, 'router.mjs');
  await build({ entryPoints: ['source/node-agent-coordinator/inference-router.ts'], outfile: output, bundle: true, platform: 'node', format: 'esm', plugins: [{ name: 'provider', setup(builder) {
    builder.onResolve({ filter: /provider-session\.js$/ }, () => ({ path: 'provider', namespace: 'fixture' }));
    builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: `export const runRoutedProviderText = (...args) => globalThis[${JSON.stringify(key)}](...args);` }));
  } }] });
  await writeFile(path.join(dir, 'settings.json'), JSON.stringify({ version: 1, inferenceProvider: route }));
  const { createCoordinatorInferenceRouter } = await import(pathToFileURL(output));
  const events = [];
  let clock = 100000;
  const router = createCoordinatorInferenceRouter({ dataDir: dir, now: () => clock, postEvent: (family, payload) => events.push({ family, payload }), dispatchRemote: async method => method === 'listAgents' ? [{ id: 'a' }] : method === 'listRoutedMcpTools' ? [] : { entries: [] } });
  t.after(async () => { router.dispose(); delete globalThis[key]; await rm(dir, { recursive: true, force: true }); });
  return { router, events, dir, advance: () => clock += 15000 };
}
const call = (o, name, args) => o.executeTool(o.tools.find(tool => tool.name === name), args, name);

test('router continues after a reply and posts completion without fake user messages or routine streaming', async t => {
  const invocations = [];
  const f = await fixture(t, async (_provider, messages, options) => {
    if (options.systemPrompt) return '{}';
    invocations.push({ messages, options });
    if (invocations.length === 1) {
      const result = await call(options, 'task_schedule', { objective: 'Check synthetic playback', progress: 'First fixture started.', delaySeconds: 15 });
      assert.ok(!result.isError); return 'I will continue checking.';
    }
    assert.match(options.memoryContext, /automatic continuation/);
    assert.equal(options.tools.some(tool => tool.name === 'task_schedule'), false);
    options.onTextDelta('private routine update', 'private routine update');
    await call(options, 'task_checkpoint', { status: 'completed', progress: 'Internal fixture evidence.', message: 'Task completed: Fixture completion verified.' });
    return 'internal continuation reply';
  });
  f.router.start();
  await f.router.dispatch('sendPrompt', { agentId: 'a', prompt: 'Check the fixture until it finishes.' });
  await until(() => f.events.some(e => e.payload.entry?.message?.content === 'I will continue checking.'));
  f.advance();
  await until(() => f.events.some(e => e.payload.entry?.message?.content === 'Task completed: Fixture completion verified.'));
  const store = JSON.parse(await readFile(path.join(f.dir, 'inference-router-transcript.json'), 'utf8'));
  assert.equal(store.agents.a.filter(e => e.role === 'user').length, 1);
  assert.equal(store.agents.a.length, 3);
  assert.ok(!f.events.some(e => /private routine|internal continuation/.test(e.payload.entry?.message?.content ?? '')));
  assert.equal(invocations.length, 2);
});

test('a stop message aborts an active continuation and persists cancellation', async t => {
  let began = false;
  const f = await fixture(t, async (_provider, _messages, options) => {
    if (options.systemPrompt) return '{}';
    if (!options.memoryContext.includes('automatic continuation')) {
      await call(options, 'task_schedule', { objective: 'Fixture', progress: 'Waiting.', delaySeconds: 15 });
      return 'Scheduled.';
    }
    began = true;
    await new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }));
    assert.fail('cancelled provider must not continue');
  });
  f.router.start();
  await f.router.dispatch('sendPrompt', { agentId: 'a', prompt: 'Monitor fixture.' });
  await until(() => f.events.some(e => e.payload.entry?.message?.content === 'Scheduled.'));
  f.advance(); await until(() => began);
  await f.router.dispatch('sendPrompt', { agentId: 'a', prompt: 'stop' });
  await until(() => f.events.some(e => e.payload.entry?.message?.content?.startsWith('Stopped.')));
  const store = JSON.parse(await readFile(path.join(f.dir, 'inference-router-tasks.json'), 'utf8'));
  assert.equal(store.tasks[0].status, 'cancelled');
  assert.ok(!f.events.some(e => e.payload.entry?.message?.content?.startsWith('Router error:')));
});

test('router keeps a productive foreground turn alive beyond ten minutes', async t => {
  let finished;
  const providerFinished = new Promise(resolve => finished = resolve);
  const f = await fixture(t, async (_provider, _messages, options) => {
    if (options.systemPrompt) return '{}';
    t.mock.timers.tick(9 * 60000);
    await call(options, 'task_status', {});
    t.mock.timers.tick(9 * 60000);
    options.onProgress();
    t.mock.timers.tick(9 * 60000);
    assert.equal(options.signal.aborted, false);
    finished();
    return 'Long foreground fixture completed.';
  });
  t.mock.timers.enable({apis:['setTimeout']});
  await f.router.dispatch('sendPrompt',{agentId:'a',prompt:'Run the synthetic long turn.'});
  await providerFinished;
  for (let attempts = 0; !f.events.some(e=>e.payload.entry?.message?.content==='Long foreground fixture completed.'); attempts++) {
    assert.ok(attempts<1000);
    await new Promise(resolve=>setImmediate(resolve));
  }
});


test('missed checkpoints get one restricted repair pass with current observations', async t => {
  let continuations = 0, repairs = 0;
  const f = await fixture(t, async (_provider, _messages, options) => {
    if (options.systemPrompt) return '{}';
    if (options.memoryContext.includes('Checkpoint recovery:')) {
      repairs++;
      assert.deepEqual(options.tools.map(t => t.name).sort(), ['task_checkpoint', 'task_status']);
      assert.match(options.memoryContext, /task_status/);
      assert.match(options.memoryContext, /First fixture started/);
      assert.match(options.memoryContext, /Need another fixture check/);
      await assert.rejects(options.executeTool({ name: 'browser_click' }, {}, 'forbidden'), /Only checkpoint/);
      await call(options, 'task_checkpoint', { status: 'waiting', progress: 'Verified fixture; next step is inspect again.', delaySeconds: 600 });
      await assert.rejects(call(options, 'task_checkpoint', { status: 'completed', progress: 'stale' }), /already saved/);
      return 'private repair reply';
    }
    if (!options.memoryContext.includes('automatic continuation')) {
      await call(options, 'task_schedule', { objective: 'Fixture', progress: 'First fixture started.', delaySeconds: 15 });
      return 'Scheduled.';
    }
    continuations++;
    await call(options, 'task_status', {});
    return 'Need another fixture check; no completion evidence.';
  });
  f.router.start();
  await f.router.dispatch('sendPrompt', { agentId: 'a', prompt: 'Monitor fixture.' });
  await until(() => f.events.some(e => e.payload.entry?.message?.content === 'Scheduled.'));
  f.advance();
  await until(async () => JSON.parse(await readFile(path.join(f.dir, 'inference-router-tasks.json'), 'utf8')).tasks[0].progress === 'Verified fixture; next step is inspect again.');
  assert.equal(continuations, 1); assert.equal(repairs, 1);
  assert.ok(!f.events.some(e => /private|Task paused/.test(e.payload.entry?.message?.content ?? '')));
});

for (const outcome of ['no checkpoint', 'cancel']) test(`checkpoint repair is bounded and respects ${outcome}`, async t => {
  let repairing = false, repairFinished = false, repairs = 0;
  const f = await fixture(t, async (_provider, _messages, options) => {
    if (options.systemPrompt) return '{}';
    if (options.memoryContext.includes('Checkpoint recovery:')) {
      repairing = true; repairs++;
      if (outcome === 'cancel') {
        await new Promise(resolve => options.signal.addEventListener('abort', resolve, { once: true }));
        await assert.rejects(async () => call(options, 'task_checkpoint', { status: 'waiting', progress: 'stale' }), /abort/i);
      }
      repairFinished = true;
      return 'No checkpoint.';
    }
    if (!options.memoryContext.includes('automatic continuation')) {
      await call(options, 'task_schedule', { objective: 'Fixture', progress: 'PRIVATE checkpoint', delaySeconds: 15 });
      return 'Scheduled.';
    }
    return 'Forgot to checkpoint.';
  });
  f.router.start();
  await f.router.dispatch('sendPrompt', { agentId: 'a', prompt: 'Monitor fixture.' });
  await until(() => f.events.some(e => e.payload.entry?.message?.content === 'Scheduled.'));
  f.advance(); await until(() => repairing);
  if (outcome === 'cancel') await f.router.dispatch('sendPrompt', { agentId: 'a', prompt: 'stop' });
  await until(async () => {
    const status = JSON.parse(await readFile(path.join(f.dir, 'inference-router-tasks.json'), 'utf8')).tasks[0].status;
    return repairFinished && status === (outcome === 'cancel' ? 'cancelled' : 'blocked');
  });
  await until(() => f.events.some(e => outcome === 'cancel'
    ? e.payload.entry?.message?.content?.startsWith('Stopped.')
    : e.payload.entry?.message?.content?.includes('after a recovery attempt')));
  assert.equal(repairs, 1);
  const stored = JSON.parse(await readFile(path.join(f.dir, 'inference-router-tasks.json'), 'utf8')).tasks[0];
  assert.equal(stored.progress, 'PRIVATE checkpoint');
  assert.ok(!f.events.some(e => /PRIVATE checkpoint|Task paused: Task paused/.test(e.payload.entry?.message?.content ?? '')));
});


test('Claude checkpoint recovery restricts the existing MCP bridge too', async t => {
  let repairs = 0;
  const f = await fixture(t, async (_provider, _messages, options) => {
    if (options.systemPrompt) return '{}';
    const rpc = async (method, params = {}) => (await (await fetch(options.mcpServerUrl, {
      method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    })).json()).result;
    const invoke = (name, args) => rpc('tools/call', { name, arguments: args });
    const tools = (await rpc('tools/list')).tools;
    if (options.memoryContext.includes('Checkpoint recovery:')) {
      repairs++;
      assert.deepEqual(tools.map(t => t.name).sort(), ['task_checkpoint', 'task_status']);
      const denied = await invoke('memory_forget', { query: 'everything' });
      assert.equal(denied.isError, true);
      const saved = await invoke('task_checkpoint', { status: 'blocked', progress: 'Internal fixture sign-in state.', message: 'Please sign in to the fixture.' });
      assert.ok(!saved.isError);
      return 'Private reply';
    }
    if (!options.memoryContext.includes('automatic continuation')) {
      await invoke('task_schedule', { objective: 'Fixture', progress: 'Waiting.', delaySeconds: 15 });
      return 'Scheduled.';
    }
    await invoke('task_status', {});
    return 'Fixture requires sign-in.';
  }, 'claude-code');
  f.router.start();
  await f.router.dispatch('sendPrompt', { agentId: 'a', prompt: 'Monitor fixture.' });
  await until(() => f.events.some(e => e.payload.entry?.message?.content === 'Scheduled.'));
  f.advance();
  await until(() => f.events.some(e => e.payload.entry?.message?.content === 'Please sign in to the fixture.'));
  assert.equal(repairs, 1);
  assert.ok(!f.events.some(e => /Internal fixture|Private reply/.test(e.payload.entry?.message?.content ?? '')));
});
