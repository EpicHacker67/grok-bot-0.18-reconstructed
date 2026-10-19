import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { build } from 'esbuild';

async function fixture(entry, run, extra = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mengel-attachments-'));
  try {
    const output = path.join(root, 'module.mjs');
    await build({ entryPoints: [entry], outfile: output, bundle: true, platform: 'node', format: 'esm', ...extra });
    await run(await import(pathToFileURL(output)), root);
  } finally { await rm(root, { recursive: true, force: true }); }
}

test('screenshot staging does not depend on Electron Web Crypto method binding', async () => {
  await fixture('source/electron-main/attachments/attachments.ts', async ({ createAttachmentEdgePort }, root) => {
    const original = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
    const browserCrypto = { randomUUID() { assert.equal(this, browserCrypto, 'Web Crypto needs its receiver'); return 'browser'; } };
    Object.defineProperty(globalThis, 'crypto', { configurable: true, value: browserCrypto });
    try {
      const uploads = [];
      const edge = createAttachmentEdgePort({ getStagingDir: () => root, isWithinStagingDir: p => p.startsWith(root + '/'), byteLimitForName: () => 25 * 1024 * 1024,
        onEdgeFailure: failure => assert.fail(JSON.stringify(failure)),
        legs: { uploadAttachment: async args => { uploads.push(args); return { path: '/home/box/sand-data/agents/test/attachments/image.png' }; } },
      });
      const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
      const staged = await edge.stageBytes('Screenshot 2026-09-25 at 1.41.57 PM.png', bytes);
      assert.equal(staged.ok, true);
      assert.deepEqual(new Uint8Array(await readFile(staged.path)), bytes);
      assert.equal((await edge.commitStaged([staged.path], ['screenshot.png'])).length, 1);
      assert.equal(uploads[0].bytesBase64, Buffer.from(bytes).toString('base64'));
      assert.deepEqual(await edge.stageBytes('empty.png', new Uint8Array()), { ok: false, reason: 'empty' });
      await edge.discardStaged(staged.path);
    } finally { Object.defineProperty(globalThis, 'crypto', original); }
  });
});

test('Claude and Codex receive image blocks instead of serialized image text', async () => {
  await fixture('source/host/extensions/inference/provider-images.ts', async ({ claudeImagePrompt, codexMessageInput }) => {
    const image = 'data:image/png;base64,aGVsbG8=';
    const messages = [{ role: 'user', content: [{ type: 'text', text: 'Read this screenshot' }, { type: 'image', image }] }];
    const input = codexMessageInput(messages);
    assert.deepEqual(input[0].content[1], { type: 'input_image', image_url: image, detail: 'auto' });
    const streamed = [];
    for await (const message of claudeImagePrompt(messages, 'Instructions')) streamed.push(message);
    assert.equal(streamed.length, 1);
    assert.deepEqual(streamed[0].message.content.at(-1), { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aGVsbG8=' } });
    assert.equal(claudeImagePrompt([{ role: 'user', content: 'hello' }], 'Instructions'), null);
  });
});

test('image-only messages retain their attachments for transcript reloads and follow-ups', async () => {
  await fixture('source/node-agent-coordinator/inference-router.ts', async ({ createCoordinatorInferenceRouter }, root) => {
    await writeFile(path.join(root, 'settings.json'), JSON.stringify({ version: 1, inferenceProvider: 'codex' }));
    const events = [];
    const reads = [];
    const router = createCoordinatorInferenceRouter({ dataDir: root, postEvent: (family, payload) => events.push({ family, payload }), dispatchRemote: async (method, args) => {
      if (method === 'readAttachmentImage') { reads.push(args.path); return { dataUrl: 'data:image/png;base64,aGVsbG8=', width: 1, height: 1 }; }
      return method === 'listAgents' ? [{ id: 'test' }] : method === 'listRoutedMcpTools' ? [] : { entries: [] };
    } });
    for (const [index, prompt] of ['', 'What did that screenshot say?'].entries()) {
      await router.dispatch('sendPrompt', { agentId: 'test', prompt, ...(index === 0 ? { attachmentPaths: ['/home/box/image.png'], attachmentNames: ['Screenshot.png'] } : {}) });
      const deadline = Date.now() + 10000;
      while (events.filter(e => e.payload.entry?.message?.content === 'Saw the image').length < index + 1) {
        assert.ok(Date.now() < deadline, JSON.stringify(events));
        await new Promise(resolve => setTimeout(resolve, 25));
      }
    }
    assert.equal(reads.length, 2);
    const tail = (await router.dispatch('getAgentTranscriptTail', { id: 'test' })).value;
    assert.equal(tail.entries.find(entry => entry.kind === 'user-attachment').file_name, 'Screenshot.png');
    assert.doesNotMatch(await readFile(path.join(root, 'inference-router-transcript.json'), 'utf8'), /base64/);
  }, { plugins: [{ name: 'image-provider', setup(builder) {
    builder.onResolve({ filter: /provider-session\.js$/ }, () => ({ path: 'provider', namespace: 'fixture' }));
    builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: `export async function runRoutedProviderText(provider,messages) { if(!messages.some(m=>Array.isArray(m.content)&&m.content.some(p=>p.type==='image'&&p.image.startsWith('data:image/png')))) throw new Error('Image was lost'); return 'Saw the image'; }` }));
  } }] });
});
