import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
const built=await build({stdin:{contents:`export * from './source/node-agent-coordinator/gateway/gateway-client.ts'; export {createDeadlinePolicy,realClock} from './source/internal/scheduling.ts';`,resolveDir:process.cwd()},bundle:true,write:false,format:'esm',platform:'node'});
const {CoordinatorGatewayClient,createCoordinatorGatewayClientTiming,createDeadlinePolicy,realClock}=await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`);
function client(resolveConnection,onTransportEvent=()=>{}) {
 return new CoordinatorGatewayClient({resolveConnection,onEvent:()=>{},onTransportEvent,timing:{...createCoordinatorGatewayClientTiming(),connectDeadline:createDeadlinePolicy(realClock,{name:'test-connect',timeoutMs:10})}});
}
test('remote startup may exceed the SSE handshake deadline', async t=>{
 let ready=false,fetches=0;
 const events=[];
 t.mock.method(globalThis,'fetch',async()=>{fetches++;assert.equal(ready,true);return new Response('data: {"channel":"ready","payload":{}}\n\n')});
 const gateway=client(async()=>{await new Promise(r=>setTimeout(r,40));ready=true;return {baseUrl:'https://example.invalid'}},e=>events.push(e));
 try {await gateway.streamEvents(()=>{},0);assert.equal(fetches,1);assert.ok(events.some(e=>e.family==='transport-connected'))}finally{gateway.close()}
});
test('a ready host still has a bounded SSE handshake', async t=>{
 let aborted=false;
 t.mock.method(globalThis,'fetch',async(_url,init)=>new Promise((_,reject)=>init.signal.addEventListener('abort',()=>{aborted=true;reject(init.signal.reason)},{once:true})));
 const gateway=client(async()=>({baseUrl:'https://example.invalid'}));
 try {await assert.rejects(gateway.streamEvents(()=>{},0));assert.equal(aborted,true)}finally{gateway.close()}
});
test('closing during startup cancels resolution without making a request', async t=>{
 let started;
 const ready=new Promise(r=>{started=r});
 t.mock.method(globalThis,'fetch',async()=>assert.fail('cancelled startup must not fetch'));
 const gateway=client(async signal=>{started();return new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}))});
 const pending=gateway.streamEvents(()=>{},0);
 await ready;
 gateway.close();
 await assert.rejects(pending);
});

const supervisorBundle=await build({entryPoints:['source/node-agent-coordinator/gateway/host-supervisor.ts'],bundle:true,write:false,format:'esm',platform:'node'});
const {SandHostSupervisor,createCoordinatorHostSupervisorTiming}=await import(`data:text/javascript;base64,${Buffer.from(supervisorBundle.outputFiles[0].text).toString('base64')}`);
test('a roster timeout does not abandon startup shared with the event stream', async ()=>{
 let resolve,starts=0;
 const pending=new Promise(r=>{resolve=r});
 const supervisor=new SandHostSupervisor({timing:createCoordinatorHostSupervisorTiming(),resolveGatewayConnection:()=>{starts++;return pending}});
 const rosterAbort=new AbortController();
 const roster=supervisor.ensureConnection(rosterAbort.signal);
 const stream=supervisor.ensureConnection();
 const rejected=assert.rejects(roster,/abandoned/);
 rosterAbort.abort();
 await rejected;
 resolve({baseUrl:'https://example.invalid'});
 assert.equal((await stream).baseUrl,'https://example.invalid');
 assert.equal(starts,1);
});
test('explicit health invalidation still supersedes a shared startup', async ()=>{
 const pending=[];
 const supervisor=new SandHostSupervisor({timing:createCoordinatorHostSupervisorTiming(),resolveGatewayConnection:()=>new Promise(resolve=>pending.push(resolve))});
 const old=supervisor.ensureConnection();
 supervisor.invalidateHealthCache();
 const current=supervisor.ensureConnection();
 pending[1]({baseUrl:'https://current.invalid'});
 pending[0]({baseUrl:'https://stale.invalid'});
 assert.equal((await current).baseUrl,'https://current.invalid');
 assert.equal((await old).baseUrl,'https://current.invalid');
});
