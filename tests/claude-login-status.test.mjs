import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { build } from 'esbuild';

test('Claude login detection uses CLI status for credentials stored in Keychain', async () => {
  const root=await mkdtemp(path.join(os.tmpdir(),'mengel-auth-status-'));
  const before=process.env.CLAUDE_CODE_PATH;
  const executable=path.join(root,'claude');
  process.env.CLAUDE_CODE_PATH=executable;
  try {
    const output=path.join(root,'status.mjs');
    await build({entryPoints:['source/shared/node/inference-router-local.ts'],outfile:output,bundle:true,platform:'node',format:'esm'});
    const {getLocalInferenceCliStatus}=await import(pathToFileURL(output));
    for (const loggedIn of [true,false]) {
      await writeFile(executable,`#!/bin/sh\n[ "$1" = auth ] && [ "$2" = status ] || exit 2\nprintf '%s\\n' '{"loggedIn":${loggedIn}}'\nexit ${loggedIn?0:1}\n`,{mode:0o700});
      const result=await getLocalInferenceCliStatus();
      assert.equal(result['claude-code'].installed,true);
      assert.equal(result['claude-code'].authenticated,loggedIn);
    }
  } finally {
    if(before===undefined) delete process.env.CLAUDE_CODE_PATH; else process.env.CLAUDE_CODE_PATH=before;
    await rm(root,{recursive:true,force:true});
  }
});
