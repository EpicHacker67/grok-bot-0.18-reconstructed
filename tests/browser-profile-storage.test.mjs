import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { build } from "esbuild";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "mengel-browser-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const outfile = join(root, "storage.mjs");
  await build({ entryPoints: ["source/electron-main/box/browser-profile-storage.ts"], bundle: true, platform: "node", format: "esm", outfile, logLevel: "silent" });
  const api = await import(pathToFileURL(outfile));
  const commands = [], copies = [];
  const state = { Id: "old-container", State: { Running: true }, Mounts: [] };
  const run = async args => {
    commands.push(args);
    return { ok: true, output: args[0] === "inspect" ? JSON.stringify(state) : "" };
  };
  const copy = async (source, destination) => {
    assert.ok(commands.some(args => args[0] === "stop"), "copy only after browser databases have stopped");
    copies.push({ source, destination });
    return { ok: true, output: "" };
  };
  return { ...api, commands, copies, state, run, copy };
}

test("container replacement preserves every Chrome profile before removal", async t => {
  const f = await fixture(t);
  await f.preserveBrowserProfiles("computer", "pinned-image", f.run, f.copy);
  assert.equal(f.copies.length, 4);
  for (const [, path] of f.BROWSER_PROFILE_PATHS) assert.ok(f.copies.some(item => item.source[1] === `computer:${path}/.`));
  assert.equal(f.commands.some(args => args[0] === "rm"), false);
  assert.equal(f.commands.some(args => args[0] === "start"), false);
  assert.ok(f.copies.every(item => item.destination.includes("none")), "migration helpers have no network");
  assert.ok(f.browserProfileMounts(true).includes("mengel-holly-chrome:/home/box/chrome-profile"));
});

test("existing persistent volumes are reused without overwriting sessions", async t => {
  const f = await fixture(t);
  f.state.Mounts = f.browserProfileMounts().filter((_, i) => i % 2).map(value => {
    const [Name, Destination] = value.split(":"); return { Name, Destination };
  });
  await f.preserveBrowserProfiles("computer", "pinned-image", f.run, f.copy);
  assert.equal(f.copies.length, 0);
  assert.equal(f.commands.filter(args => args[0] === "run").length, 4, "clear only stale process locks on replacement");
});

test("failed profile migration aborts replacement and restores the old computer", async t => {
  const f = await fixture(t);
  await assert.rejects(f.preserveBrowserProfiles("computer", "image", f.run, async () => ({ ok: false, output: "disk full" })), /old computer has been kept/);
  assert.deepEqual(f.commands.at(-1), ["start", "computer"]);
  assert.equal(f.commands.some(args => args[0] === "rm"), false);
});
