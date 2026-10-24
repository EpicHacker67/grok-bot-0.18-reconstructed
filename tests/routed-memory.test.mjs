import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { build } from 'esbuild';

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mengel-memory-'));
  const agentsRootDir = path.join(root, 'agents');
  for (const id of ['alpha', 'beta']) await mkdir(path.join(agentsRootDir, id), { recursive: true });
  const out = path.join(root, 'memory.mjs');
  await build({ entryPoints: ['source/host/extensions/memory/routed-memory.ts'], outfile: out, bundle: true, platform: 'node', format: 'esm' });
  const { createRoutedMemoryService } = await import(pathToFileURL(out));
  const options = { sandRoot: root, agentsRootDir, now: () => Date.UTC(2026, 9, 16) };
  const service = createRoutedMemoryService(options);
  const call = (agentId, name, args) => service({ agentId, operation: 'tool', name, args });
  const context = agentId => service({ agentId, operation: 'context' });
  return { root, service, call, context, restart: () => createRoutedMemoryService(options), dispose: () => rm(root, { recursive: true, force: true }) };
}

test('durable profile and dated notes survive service restart, dedupe, and remain agent isolated', async () => {
  const f = await fixture();
  try {
    const content = 'I prefer concise explanations with code examples.';
    assert.equal(f.call('alpha','memory_write',{content,tier:'profile'}).saved,true);
    assert.equal(f.call('alpha','memory_write',{content,tier:'profile'}).alreadyRecorded,true);
    f.call('alpha','memory_write',{content:'Release scheduled for October 23, 2026.',tier:'log'});
    f.call('alpha','memory_write',{content:'Use the Café 東京 test notebook.',tier:'note'});
    assert.equal(f.restart()({agentId:'alpha',operation:'context'}).facts.length,3);
    assert.equal(f.context('beta').facts.length,0);
    assert.equal(f.call('alpha','memory_search',{query:'notebook'}).memories[0].content,'[note] Use the Café 東京 test notebook.');
    assert.equal(f.call('alpha','memory_forget',{content}).forgotten,true);
    assert.equal(f.context('alpha').facts.some(m => m.content===content),false);
  } finally { await f.dispose(); }
});

test('shared user and opt-in project memories preserve ownership and membership boundaries', async () => {
  const f = await fixture();
  try {
    f.call('alpha','memory_write',{content:'Timezone is America/Chicago.',tier:'profile',scope:'user'});
    assert.equal(f.context('beta').facts[0].scope,'user');
    assert.equal(f.call('beta','memory_forget',{content:'Timezone is America/Chicago.',scope:'user'}).forgotten,false);
    f.call('alpha','memory_project',{action:'create',project:'launch',name:'Launch'});
    f.call('alpha','memory_write',{scope:'project',project:'launch',content:'Launch uses the blue logo.',tier:'log'});
    assert.equal(f.context('beta').facts.some(m=>m.project==='launch'),false);
    assert.throws(()=>f.call('beta','memory_write',{scope:'project',project:'launch',content:'Overwrite',tier:'log'}),/Join/);
    f.call('beta','memory_project',{action:'join',project:'launch'});
    assert.equal(f.context('beta').facts.find(m=>m.project==='launch').via,'alpha');
    f.call('beta','memory_project',{action:'leave',project:'launch'});
    assert.equal(f.context('beta').facts.some(m=>m.project==='launch'),false);
    assert.throws(()=>f.call('../alpha','memory_search',{}),/Invalid/);
    assert.throws(()=>f.call('unknown','memory_search',{}),/Unknown/);
    assert.throws(()=>f.call('alpha','memory_project',{action:'create',project:'../escape',name:'bad'}),/Invalid/);
    assert.throws(()=>f.call('alpha','memory_write',{content:'x'.repeat(501),tier:'profile'}),/500/);
  } finally { await f.dispose(); }
});

test('automatic extraction cannot overwrite explicit facts or resurrect deleted memories', async () => {
  const f = await fixture();
  try {
    const run = text => {
      const snapshot=f.service({agentId:'alpha',operation:'extraction-context'});
      return f.service({agentId:'alpha',operation:'apply-extraction',fingerprint:snapshot.fingerprint,text});
    };
    f.call('alpha','memory_write',{content:'Use concise replies.',tier:'profile'});
    assert.equal(run('remove: Use concise replies.\nlog: Building a music app.').outcome,'committed');
    assert.ok(f.context('alpha').facts.some(m=>m.content==='Use concise replies.'));
    const pending=f.service({agentId:'alpha',operation:'extraction-context'});
    f.call('alpha','memory_forget',{content:'Building a music app.'});
    assert.equal(f.service({agentId:'alpha',operation:'apply-extraction',fingerprint:pending.fingerprint,text:'log: Building a music app.'}).outcome,'stale');
    run('log: Building a music app.');
    assert.equal(f.context('alpha').facts.some(m=>m.content==='Building a music app.'),false);
  } finally { await f.dispose(); }
});

test('router injects durable memory after transcript loss and provides save/forget tools', async () => {
  const f=await fixture();
  try {
    const out=path.join(f.root,'router.mjs');
    await build({ entryPoints:['source/node-agent-coordinator/inference-router.ts'],outfile:out,bundle:true,platform:'node',format:'esm',
      plugins:[{name:'memory-provider',setup(b){
        b.onResolve({filter:/provider-session\.js$/},()=>({path:'provider',namespace:'fake'}));
        b.onLoad({filter:/.*/,namespace:'fake'},()=>({contents:`
          export async function runRoutedProviderText(provider,messages,options){
            const prompt=messages.at(-1).content;
            if(options.systemPrompt) return 'profile: User builds music apps.';
            if(prompt==='remember') {
              const tool=options.tools.find(t=>t.name==='memory_write');
              const result=await options.executeTool(tool,{content:'Favorite test color is teal.',tier:'profile'},'save');
              if(result.isError) throw Error('save failed');
              return 'Remembered teal';
            }
            if(prompt==='recall') {
              if(messages.length!==1) throw Error('test must exclude chat history');
              if(!options.memoryContext.includes('Favorite test color is teal.')) throw Error('missing memory context');
              return 'Recalled teal from durable memory';
            }
            return 'Understood';
          }` }));
      }}] });
    await writeFile(path.join(f.root,'settings.json'),JSON.stringify({version:1,inferenceProvider:'codex'}));
    const {createCoordinatorInferenceRouter}=await import(pathToFileURL(out));
    const events=[];
    const make=()=>createCoordinatorInferenceRouter({dataDir:f.root,postEvent:(family,payload)=>events.push({family,payload}),dispatchRemote:async(method,args)=>method==='routedMemory'?f.service(args):method==='listAgents'?[{id:'alpha'}]:method==='listRoutedMcpTools'?[]:{entries:[]}});
    async function send(router,prompt,expected){
      await router.dispatch('sendPrompt',{agentId:'alpha',prompt});
      const deadline=Date.now()+5000;
      while(!events.some(e=>e.payload.entry?.message?.content===expected)){
        assert.ok(Date.now()<deadline,JSON.stringify(events));await new Promise(r=>setTimeout(r,10));
      }
    }
    await send(make(),'remember','Remembered teal');
    await rm(path.join(f.root,'inference-router-transcript.json'));
    await send(make(),'recall','Recalled teal from durable memory');
    await send(make(),'I build music apps for work.','Understood');
    const deadline=Date.now()+5000;
    while(!f.context('alpha').facts.some(m=>m.content==='User builds music apps.')){
      assert.ok(Date.now()<deadline);await new Promise(r=>setTimeout(r,10));
    }
  } finally { await f.dispose(); }
});

test('Codex receives memory in instructions and extraction has a separate tool-free prompt', async () => {
  const root=await mkdtemp(path.join(os.tmpdir(),'mengel-memory-provider-'));
  const oldRoot=process.env.SAND_DATA_ROOT, oldCodex=process.env.CODEX_HOME;
  try {
    process.env.SAND_DATA_ROOT=root;process.env.CODEX_HOME=root;
    await writeFile(path.join(root,'auth.json'),JSON.stringify({auth_mode:'chatgpt',tokens:{access_token:'test-only',refresh_token:'test-only',id_token:'test-only',account_id:'test-only'}}),{mode:0o600});
    await writeFile(path.join(root,'settings.json'),JSON.stringify({version:1,inferenceProvider:'codex',inferenceModels:{codex:'test-model'}}));
    const out=path.join(root,'provider.mjs');
    await build({entryPoints:['source/host/extensions/inference/provider-session.ts'],outfile:out,bundle:true,platform:'node',format:'esm',
      banner:{js:"import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);"},
      plugins:[{name:'offline-codex',setup(b){
        b.onResolve({filter:/codex-direct-responses\.js$/},()=>({path:'stream',namespace:'fake'}));
        b.onLoad({filter:/.*/,namespace:'fake'},()=>({contents:`export async function* streamCodexDirectResponses(options){
          yield {type:'text-delta',delta:JSON.stringify({instructions:options.instructions,tools:options.tools?.map(t=>t.name)??[]})};
          yield {type:'done',text:'',responseId:'test',usage:{inputTokens:1,outputTokens:1,cacheReadTokens:0,cacheWriteTokens:0}};
        }`}));
      }}]});
    const {runRoutedProviderText}=await import(pathToFileURL(out));
    const normal=JSON.parse(await runRoutedProviderText('codex',[{role:'user',content:'hello'}],{memoryContext:'Remembered fact: prefers concise answers.',tools:[{name:'memory_search',inputSchema:{type:'object'}}]}));
    assert.match(normal.instructions,/prefers concise answers/);
    assert.deepEqual(normal.tools,['memory_search']);
    const extraction=JSON.parse(await runRoutedProviderText('codex',[{role:'user',content:'I build music apps.'}],{systemPrompt:'Extract facts only. No tools.'}));
    assert.equal(extraction.instructions,'Extract facts only. No tools.');
    assert.deepEqual(extraction.tools,[]);
  } finally {
    if(oldRoot===undefined) delete process.env.SAND_DATA_ROOT;else process.env.SAND_DATA_ROOT=oldRoot;
    if(oldCodex===undefined) delete process.env.CODEX_HOME;else process.env.CODEX_HOME=oldCodex;
    await rm(root,{recursive:true,force:true});
  }
});
