import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { getDefaultAutoSelectFamilyAttemptTimeout } from 'node:net';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const require = createRequire(import.meta.url);
const built = await build({entryPoints:['source/host/extensions/inference/provider-fetch.ts'],bundle:true,write:false,format:'esm',platform:'node',plugins:[{
  name:'external-undici',setup(build) { build.onResolve({filter:/^undici$/},()=>({path:pathToFileURL(require.resolve('undici')).href,external:true})); },
}]});
const { createProviderFetch } = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`);

async function withServer(handler, run) {
  const server = createServer(handler);
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try { await run(`http://127.0.0.1:${server.address().port}`); }
  finally { server.closeAllConnections(); await new Promise(resolve=>server.close(resolve)); }
}

test('provider transport preserves request data and streams without changing global networking', async () => {
  const originalFetch = globalThis.fetch;
  const originalTimeout = getDefaultAutoSelectFamilyAttemptTimeout();
  const transport = createProviderFetch();
  try {
    await withServer(async (req,res)=>{
      const chunks=[];
      for await(const chunk of req) chunks.push(chunk);
      assert.equal(req.headers.authorization,'Bearer test-only');
      assert.equal(Buffer.concat(chunks).toString(),'request body');
      res.writeHead(200,{'content-type':'text/event-stream'});
      res.write('data: first\n\n');
      setTimeout(()=>res.end('data: last\n\n'),350);
    }, async url=>{
      const response=await transport.fetch(url,{method:'POST',headers:{authorization:'Bearer test-only'},body:'request body'});
      assert.equal(response.status,200);
      assert.equal(await response.text(),'data: first\n\ndata: last\n\n');
    });
    assert.equal(globalThis.fetch,originalFetch);
    assert.equal(getDefaultAutoSelectFamilyAttemptTimeout(),originalTimeout);
  } finally { await transport.close(); }
});

test('provider transport honors cancellation while awaiting headers', async () => {
  const transport=createProviderFetch();
  try {
    await withServer(()=>{},async url=>{
      const controller=new AbortController();
      const pending=transport.fetch(url,{signal:controller.signal});
      setTimeout(()=>controller.abort(new Error('cancelled test')),30);
      await assert.rejects(pending,/cancelled test/);
    });
  } finally { await transport.close(); }
});
