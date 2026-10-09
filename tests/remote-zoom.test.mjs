import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import { build } from 'esbuild';

async function load(entry, run) {
  const dir = await mkdtemp(join(tmpdir(), 'mengel-zoom-'));
  try {
    const out = join(dir, 'module.mjs');
    await build({ entryPoints: [entry], outfile: out, bundle: true, platform: 'node', format: 'esm' });
    await run(await import(pathToFileURL(out)));
  } finally { await rm(dir, { recursive: true, force: true }); }
}

test('focused interactive desktops receive zoom, while host shortcuts and previews retain host routing', async () => {
  await load('source/electron-main/vnc/vnc-trust.ts', ({ installGuestInputGuard }) => {
    for (const platform of ['darwin', 'linux']) {
      const handlers = {}, routed = [], zooms = [];
      let interactive = true, prevented = 0;
      installGuestInputGuard({ isDestroyed: () => false, setVisualZoomLevelLimits() {}, setZoomFactor: n => zooms.push(n), on: (name, fn) => handlers[name] = fn }, input => { routed.push(input.key); return true; }, () => interactive, platform);
      const send = key => handlers['before-input-event']({ preventDefault: () => prevented++ }, { type: 'keyDown', key, meta: platform === 'darwin', control: platform !== 'darwin' });
      for (const key of ['=', '+', '-', '0']) send(key);
      assert.equal(prevented, 0);
      assert.deepEqual(routed, []);
      send('q'); assert.deepEqual(routed, ['q']);
      interactive = false;
      send('+'); assert.deepEqual(routed, ['q', '+']);
      handlers['did-finish-load']();
      assert.deepEqual(zooms, [1, 1], 'guest scale remains fixed for video/input alignment');
    }
  });
});

test('Mac zoom chords become remote Control chords without changing ordinary keys', async () => {
  await load('source/electron-preload/preload-vnc.ts', async ({ buildVncMacKeyMappingScript }) => {
    const handlers = {}, sent = [];
    const script = buildVncMacKeyMappingScript().replace('import("./app/ui.js")', 'Promise.resolve({default: uiFixture})');
    runInNewContext(script, { window: {}, navigator: { platform: 'MacIntel' }, uiFixture: { rfb: { sendKey: (...args) => sent.push(args) } }, document: { addEventListener: (name, fn) => handlers[name] = fn } });
    await Promise.resolve();
    for (const [key, code, keysym, shiftKey] of [['=', 'Equal', 0x3d, false], ['+', 'Equal', 0x2b, true], ['-', 'Minus', 0x2d, false], ['0', 'Digit0', 0x30, false], ['+', 'NumpadAdd', 0x2b, false], ['c', 'KeyC', 0x63, false]]) {
      sent.length = 0;
      let prevented = false;
      handlers.keydown({ key, code, shiftKey, metaKey: true, preventDefault: () => prevented = true, stopImmediatePropagation() {} });
      assert.equal(prevented, true);
      const down = sent.filter(x => x[2]);
      assert.deepEqual(down.map(x => x[0]), shiftKey ? [0xffe3, 0xffe1, keysym] : [0xffe3, keysym]);
      assert.deepEqual(sent.at(-1), [0xffe3, 'ControlLeft', false]);
    }
    sent.length = 0;
    handlers.keydown({ key: '+', code: 'Equal', metaKey: false });
    handlers.keydown({ key: '+', code: 'Equal', metaKey: true, altKey: true });
    assert.deepEqual(sent, []);
  });
});
