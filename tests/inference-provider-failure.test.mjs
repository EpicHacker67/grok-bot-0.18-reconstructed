import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { build } from 'esbuild';

test('Claude failure is displayed and the coordinator can accept another prompt', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'mengel-provider-failure-'));
  const previousCli = process.env.CLAUDE_CODE_PATH;
  process.env.CLAUDE_CODE_PATH = process.execPath;
  try {
    const output = path.join(temporary, 'router.mjs');
    await build({
      entryPoints: ['source/node-agent-coordinator/inference-router.ts'], outfile: output,
      bundle: true, platform: 'node', format: 'esm',
      plugins: [{ name: 'failing-claude', setup(builder) {
        builder.onResolve({ filter: /^@anthropic-ai\/claude-agent-sdk$/ }, () => ({ path: 'claude', namespace: 'fixture' }));
        builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: `export async function* query() { yield {type:'result',subtype:'success',is_error:true,result:'Claude Code is too old for this model; update to version 2.1.280 or newer.'}; throw new Error('Claude Code process exited with code 1'); }` }));
      } }],
    });
    await writeFile(path.join(temporary, 'settings.json'), JSON.stringify({ version: 1, inferenceProvider: 'claude-code' }));
    const { createCoordinatorInferenceRouter } = await import(pathToFileURL(output));
    const events = [];
    const router = createCoordinatorInferenceRouter({ dataDir: temporary,
      postEvent: (family, payload) => events.push({ family, payload }),
      dispatchRemote: async method => method === 'listAgents' ? [{ id: 'agent' }] : method === 'listRoutedMcpTools' ? [] : { entries: [] },
    });
    for (let attempt = 1; attempt <= 2; attempt++) {
      assert.equal((await router.dispatch('sendPrompt', { agentId: 'agent', prompt: 'hi' })).handled, true);
      const deadline = Date.now() + 10000;
      while (events.filter(e => e.family === 'transcript' && e.payload.entry?.message?.content?.startsWith('Router error:')).length < attempt) {
        assert.ok(Date.now() < deadline, 'provider error must reach the transcript');
        await new Promise(resolve => setTimeout(resolve, 25));
      }
    }
    const tail = await router.dispatch('getAgentTranscriptTail', { id: 'agent' });
    const errors = tail.value.entries.filter(entry => entry.kind === 'send-message');
    assert.equal(errors.length, 2);
    assert.match(errors[0].message.content, /update to version 2.1.280/);
    assert.doesNotMatch(errors[0].message.content, /signed in|exited with code/);
    assert.equal(events.filter(e => e.family === 'agents').at(-1).payload.agents[0].isRunning, false);
    // Node's test runner also fails this test if any unused result/usage promise
    // escapes as an unhandled rejection, including after the error is displayed.
    await new Promise(resolve => setImmediate(resolve));
  } finally {
    if (previousCli === undefined) delete process.env.CLAUDE_CODE_PATH; else process.env.CLAUDE_CODE_PATH = previousCli;
    await rm(temporary, { recursive: true, force: true });
  }
});

test('Codex receives and executes the isolated computer tools', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'mengel-computer-routing-'));
  try {
    const output = path.join(temporary, 'router.mjs');
    await build({ entryPoints: ['source/node-agent-coordinator/inference-router.ts'], outfile: output,
      bundle: true, platform: 'node', format: 'esm',
      plugins: [{ name: 'provider-and-computer', setup(builder) {
        builder.onResolve({ filter: /provider-session\.js$/ }, () => ({ path: 'provider', namespace: 'fixture' }));
        builder.onResolve({ filter: /box-computer-tools\.js$/ }, () => ({ path: 'computer', namespace: 'fixture' }));
        builder.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ contents: args.path === 'provider' ? `
          export async function runRoutedProviderText(provider, messages, options) {
            const computer = options.tools.find(tool => tool.name === 'computer_shell');
            if (!computer) throw new Error('Missing computer tool');
            const result = await options.executeTool(computer, {command: 'hostname'}, 'call-1');
            return result.content[0].text;
          }` : `
          export function createBoxComputerTools() { return {
            list: () => [{name: 'computer_shell', inputSchema: {type: 'object'}}],
            call: async (name, args) => ({content: [{type: 'text', text: name + ':' + args.command}]})
          }; }` }));
      } }],
    });
    await writeFile(path.join(temporary, 'settings.json'), JSON.stringify({ version: 1, inferenceProvider: 'codex', boxRuntime: 'local-docker' }));
    const { createCoordinatorInferenceRouter } = await import(pathToFileURL(output));
    const events = [];
    const router = createCoordinatorInferenceRouter({ dataDir: temporary,
      postEvent: (family, payload) => events.push({family, payload}),
      dispatchRemote: async method => {
        assert.notEqual(method, 'executeRoutedMcpTool', 'computer tools must execute in the configured container');
        return method === 'listAgents' ? [{id: 'agent'}] : method === 'listRoutedMcpTools' ? [] : {entries: []};
      },
    });
    await router.dispatch('sendPrompt', {agentId: 'agent', prompt: 'Check the computer'});
    const deadline = Date.now() + 10000;
    while (!events.some(e => e.payload.entry?.message?.content === 'computer_shell:hostname')) {
      assert.ok(Date.now() < deadline, 'computer tool result must reach chat');
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  } finally { await rm(temporary, {recursive: true, force: true}); }
});
