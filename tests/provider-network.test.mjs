import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { build } from 'esbuild';

async function load(file) {
  const built = await build({entryPoints:[`source/host/extensions/inference/${file}.ts`],bundle:true,write:false,format:'esm',platform:'node'});
  return import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`);
}
const { fetchProviderConnection } = await load('provider-network');
const { streamCodexDirectResponses } = await load('codex-direct-responses');
const opts = { label:'Codex',retryDelayMs:0,timeoutMs:100 };
const broken = () => new TypeError('fetch failed', {cause:Object.assign(new Error('private URL and token'),{code:'ECONNRESET'})});
const abortingFetch = async (_url,init) => new Promise((_,reject) => init.signal.addEventListener('abort',()=>reject(init.signal.reason),{once:true}));

test('a stale connection retries with identical request data and succeeds', async () => {
  const calls=[];
  const reply=await fetchProviderConnection(async (url,init)=>{
    calls.push({url,body:init.body,auth:new Headers(init.headers).get('authorization')});
    if(calls.length<3) throw broken();
    return new Response('OK');
  },'https://example.invalid/responses',{method:'POST',headers:{authorization:'test'},body:'payload'},opts);
  assert.equal(await reply.text(),'OK');
  assert.equal(calls.length,3);
  assert.deepEqual(calls[0],calls[2]);
});

test('connection timeouts are bounded and errors omit private details', async () => {
  let count=0;
  await assert.rejects(fetchProviderConnection(async (...args)=>{count++; return abortingFetch(...args)},'https://example.invalid',{}, {...opts,timeoutMs:5}), /timed out after 3 attempts/);
  assert.equal(count,3);
  await assert.rejects(fetchProviderConnection(async ()=>{throw broken()},'https://example.invalid/private',{},opts), error=>{
    assert.match(error.message,/Codex.*interrupted after 3 attempts/);
    assert.doesNotMatch(error.message,/private|token|https/);
    return true;
  });
});

test('HTTP errors and certificate failures are not blindly retried', async () => {
  for(const status of [401,403,429,500]) {
    let count=0;
    const response=await fetchProviderConnection(async ()=>{count++; return new Response('',{status})},'https://example.invalid',{},opts);
    assert.equal(response.status,status);
    assert.equal(count,1);
  }
  let count=0;
  await assert.rejects(fetchProviderConnection(async ()=>{count++; throw new TypeError('fetch failed',{cause:{code:'CERT_HAS_EXPIRED'}})},'https://example.invalid',{},opts),/secure connection could not be verified/);
  assert.equal(count,1);
});

test('caller cancellation stops immediately without retrying', async () => {
  const controller=new AbortController();
  let count=0;
  const pending=fetchProviderConnection(async (...args)=>{count++; return abortingFetch(...args)},'https://example.invalid',{signal:controller.signal},opts);
  controller.abort(new Error('cancelled by caller'));
  await assert.rejects(pending,/cancelled by caller/);
  assert.equal(count,1);
});

test('a slow response body survives the connection deadline', async () => {
  let signal;
  const reply=await fetchProviderConnection(async (_url,init)=>{
    signal=init.signal;
    return new Response(new ReadableStream({start(controller){setTimeout(()=>{controller.enqueue(new TextEncoder().encode('OK'));controller.close()},30)}}));
  },'https://example.invalid',{}, {...opts,timeoutMs:5});
  assert.equal(await reply.text(),'OK');
  assert.equal(signal.aborted,false);
});

test('a token refresh request opts out of retries', async () => {
  let count=0;
  await assert.rejects(fetchProviderConnection(async ()=>{count++; throw broken()},'https://example.invalid',{}, {...opts,retries:0}));
  assert.equal(count,1);
});

function sse(output, text='') {
  const events=[...(text ? [{type:'response.output_text.delta',delta:text}] : []), {type:'response.completed',response:{id:'response',output}}];
  return new Response(events.map(e=>`data: ${JSON.stringify(e)}\n\n`).join(''));
}

test('recovering the tool-result request never repeats a completed tool', async () => {
  let requests=0, toolRuns=0;
  const events=[];
  const transport=async (_url,init)=>{
    requests++;
    if(requests===1) return sse([{type:'function_call',name:'send_message',call_id:'call-1',arguments:'{}'}]);
    if(requests===2) throw broken();
    assert.equal(JSON.parse(init.body).input.at(-1).call_id,'call-1');
    return sse([],'Done');
  };
  for await(const event of streamCodexDirectResponses({fetch:(url,init)=>fetchProviderConnection(transport,url,init,opts),endpoint:'https://example.invalid',model:'test',instructions:'test',input:[],tools:[{name:'send_message',parameters:{type:'object'},source:{}}],executeTool:async()=>{toolRuns++; return {sent:true}}})) events.push(event);
  assert.equal(toolRuns,1);
  assert.equal(requests,3);
  assert.equal(events.at(-1).text,'Done');
});

test('a stream disconnect after headers is not replayed', async () => {
  let requests=0;
  await assert.rejects(async ()=>{
    for await(const event of streamCodexDirectResponses({fetch:(url,init)=>fetchProviderConnection(async ()=>{
      requests++;
      return new Response(new ReadableStream({start(controller){controller.error(broken())}}));
    },url,init,opts),endpoint:'https://example.invalid',model:'test',instructions:'test',input:[]})) {}
  });
  assert.equal(requests,1);
});

test('real HTTP socket reset recovers on a fresh connection', async () => {
  let requests=0;
  const server=createServer((req,res)=>{
    requests++;
    if(requests===1){req.socket.destroy(); return}
    res.end('connected');
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try {
    const response=await fetchProviderConnection(fetch,`http://127.0.0.1:${server.address().port}`,{method:'POST',body:'test'}, {...opts,timeoutMs:2000});
    assert.equal(await response.text(),'connected');
    assert.equal(requests,2);
  } finally {server.closeAllConnections(); await new Promise(resolve=>server.close(resolve))}
});
