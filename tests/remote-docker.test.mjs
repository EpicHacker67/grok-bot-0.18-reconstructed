import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { transform } from "esbuild";

test("remote Docker configuration is profile scoped and rejects SSH command injection", async () => {
  const source = await readFile(new URL("../source/shared/node/remote-docker.ts", import.meta.url), "utf8");
  const { code } = await transform(source, { loader: "ts", format: "esm" });
  const { configureRemoteDocker } = await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);
  const root = await mkdtemp(join(tmpdir(), "mengel-remote-"));
  try {
    const env = {};
    configureRemoteDocker(root, env);
    assert.deepEqual(env, {});
    await writeFile(join(root, "remote-docker.json"), JSON.stringify({ sshHost: "holly@holly-ms-7d70", root: "/home/holly/mengel-computer" }));
    configureRemoteDocker(root, env);
    assert.equal(env.DOCKER_HOST, "ssh://holly@holly-ms-7d70");
    assert.equal(env.SAND_REMOTE_DOCKER_ROOT, "/home/holly/mengel-computer");
    const gpu = { sshHost: "holly", root: "/tmp/mengel", gpuDesktop: { image: `sha256:${"a".repeat(64)}`, mediaAddress: "100.108.203.64" } };
    await writeFile(join(root, "remote-docker.json"), JSON.stringify(gpu));
    const gpuEnv = {}; configureRemoteDocker(root, gpuEnv);
    assert.equal(gpuEnv.SAND_DOCKER_GPU_IMAGE, gpu.gpuDesktop.image);
    assert.equal(gpuEnv.SAND_DOCKER_MEDIA_ADDRESS, "100.108.203.64");
    for (const mediaAddress of ["0.0.0.0", "8.8.8.8", "100.108.203.999", "100.128.0.1"]) {
      await writeFile(join(root, "remote-docker.json"), JSON.stringify({ ...gpu, gpuDesktop: { ...gpu.gpuDesktop, mediaAddress } }));
      assert.throws(() => configureRemoteDocker(root, {}), /private Tailscale/);
    }
    await writeFile(join(root, "remote-docker.json"), JSON.stringify({ ...gpu, gpuDesktop: { ...gpu.gpuDesktop, image: "mengel:latest" } }));
    assert.throws(() => configureRemoteDocker(root, {}), /pinned image/);
    for (const config of [{ sshHost: "-oProxyCommand=bad", root: "/tmp/box" }, { sshHost: "host", root: "/tmp/';bad" }, { sshHost: "host", root: "/tmp/../etc" }]) {
      await writeFile(join(root, "remote-docker.json"), JSON.stringify(config));
      assert.throws(() => configureRemoteDocker(root, {}), /safe SSH host/);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
