import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { build } from 'esbuild';

async function load(run, entry = "source/electron-main/box/remote-clipboard.ts") {
  const dir = await mkdtemp(join(tmpdir(), 'mengel-clipboard-'));
  try {
    const out = join(dir, 'module.mjs');
    await build({ entryPoints: [entry], outfile: out, bundle: true, platform: 'node', format: 'esm' });
    await run(await import(pathToFileURL(out)));
  } finally { await rm(dir, { recursive: true, force: true }); }
}

test('clipboard accepts Unicode text and PNG; rejects unsupported or oversized data', async () => {
  await load(({ parseRemoteClipboard, MAX_CLIPBOARD_BYTES }) => {
    const text = 'Copied from Holly — 日本語 🖼️';
    assert.equal(parseRemoteClipboard({ mime: 'text/plain', data: Buffer.from(text).toString('base64') }).bytes.toString(), text);
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aJWQAAAAASUVORK5CYII=', 'base64');
    assert.deepEqual(parseRemoteClipboard({ mime: 'image/png', data: png.toString('base64') }).bytes, png);
    for (const value of [null, { mime: 'text/html', data: '' }, { mime: 'image/png', data: 'bm90IGEgcG5n' }, { mime: 'text/plain', data: '!!!!' }, { mime: 'text/plain', data: 'A'.repeat(Math.ceil(MAX_CLIPBOARD_BYTES / 3) * 4 + 4) }]) assert.equal(parseRemoteClipboard(value), null);
  });
});

test('clipboard stream handles fragmented data and stops stale viewers from writing the Mac clipboard', async () => {
  await load(({ createRemoteClipboardSession }) => {
    const children = [], values = [];
    const session = createRemoteClipboardSession(value => values.push(value.bytes.toString()), () => {
      const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill() { this.killed = true; } });
      children.push(child); return child;
    });
    const packet = text => JSON.stringify({ mime: 'text/plain', data: Buffer.from(text).toString('base64') }) + '\n';
    try {
      session.sync(1); session.sync(1); assert.equal(children.length, 1);
      const first = children[0], data = packet('remote copy');
      first.stdout.write('{"ready":true}\n'); assert.deepEqual(values, []);
      first.stdout.write(data.slice(0, 8)); assert.deepEqual(values, []);
      first.stdout.write(data.slice(8)); assert.deepEqual(values, ['remote copy']);
      session.sync(2); assert.equal(first.killed, true);
      first.stdout.write(packet('stale')); assert.deepEqual(values, ['remote copy']);
      session.stop(1); children[1].stdout.write(packet('new copy'));
      assert.deepEqual(values, ['remote copy', 'new copy']);
      session.stop(2); children[1].stdout.write(packet('hidden'));
      assert.deepEqual(values, ['remote copy', 'new copy']);
      assert.equal(children[1].stdin.writableEnded, true);
    } finally { session.stop(); }
  });
});


test('clipboard visibility heartbeats keep one stream alive and hidden views stop syncing', async () => {
  await load(async ({ installVncClipboardBridge }) => {
    let onVisibility, poll, starts = 0, stops = 0, disposed = false;
    const windowEvents = {};
    installVncClipboardBridge({
      renderer: { on: (_name, fn) => onVisibility = fn },
      edge: { syncRemoteClipboard: async () => { starts++; return { supported: true }; }, stopRemoteClipboard: async () => { stops++; }, readClipboard: async () => '' },
      frame: null,
      window: { addEventListener: (name, fn) => windowEvents[name] = fn },
      document: { getElementById: () => null, addEventListener() {} },
      location: { pathname: '/vnc.html', search: '?sandInteractive=1' },
      startPolling: ({ task }) => { poll = task; return { dispose: () => disposed = true }; },
      isTextarea: () => false,
    });
    poll(); assert.equal(starts, 0);
    onVisibility(null, true); await new Promise(r => setImmediate(r));
    assert.equal(starts, 1);
    onVisibility(null, true); assert.equal(stops, 0, 'duplicate visible events must not restart the remote reader');
    poll(); await new Promise(r => setImmediate(r)); assert.equal(starts, 2);
    onVisibility(null, false); assert.equal(stops, 1);
    poll(); assert.equal(starts, 2);
    windowEvents.pagehide(); assert.equal(disposed, true);
  }, 'source/electron-preload/preload-vnc.ts');
});
