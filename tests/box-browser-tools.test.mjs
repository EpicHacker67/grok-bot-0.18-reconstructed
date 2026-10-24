import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {webcrypto} from 'node:crypto';
import vm from 'node:vm';
import test from 'node:test';
import {build} from 'esbuild';

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'mengel-browser-tools-'));
  t.after(() => rm(dir, {recursive:true, force:true}));
  const modules = {};
  for (const [name, entry] of Object.entries({tools:'source/node-agent-coordinator/box-computer-tools.ts', browser:'source/node-agent-coordinator/box-browser-tools.ts', driver:'source/host/runner/tools/sand-browser-driver-source.ts'})) {
    const out = join(dir, name + '.mjs');
    await build({entryPoints:[entry], outfile:out, bundle:true, platform:'node', format:'esm', logLevel:'silent'});
    Object.assign(modules, await import(pathToFileURL(out)));
  }
  return modules;
}
const reply = data => ({code:0, stdout:Buffer.from('__SAND_BROWSER_RESULT__' + JSON.stringify(data)), stderr:'', timedOut:false});

test('browser calls validate input and return page state in a single execution', async t => {
  const f = await fixture(t), calls = [];
  const browser = f.createBoxBrowserTools(async args => { calls.push(args); return reply({ok:true, summary:'Filled field', viewId:'tab-one', data:'textbox Name [ref=e-new-1]'}); }, ':2');
  for (const [name, args] of [['browser_navigate',{url:'javascript:alert(1)'}],['browser_click',{}],['browser_tabs',{action:'close'}],['browser_scroll',{amount:Infinity}],['browser_fill',{ref:'e1',value:12}],['browser_snapshot',{op:'evaluate'}]]) {
    assert.equal((await browser.call(name,args)).isError,true);
  }
  assert.equal(calls.length,0);
  const text = "Unicode 🦋; $(touch nope) ' ";
  const result = await browser.call('browser_fill',{viewId:'tab-one',ref:'e-old-1',value:text});
  assert.equal(calls.length,1);
  const request = JSON.parse(Buffer.from(calls[0].at(-1),'base64').toString());
  assert.equal(request.value,text); assert.equal(request.snapshotAfter,true); assert.equal(request.strictView,true);
  assert.equal(request.display,2); assert.equal(request.cdpPort,9224);
  assert.match(result.content[0].text,/tab-one/); assert.match(result.content[0].text,/e-new-1/);
});

test('desktop setup is reused and simultaneous browser actions are serialized', async t => {
  const f = await fixture(t); let ready=0, active=0, maximum=0, calls=0;
  const tools = f.createBoxComputerTools({ensureReady:async()=>{ready++}, exec:async()=>{
    calls++; active++; maximum=Math.max(maximum,active);
    await new Promise(resolve=>setTimeout(resolve,5)); active--;
    return reply({ok:true,summary:'Done'});
  }});
  await Promise.all([tools.call('browser_snapshot',{}), tools.call('browser_click',{ref:'observed'})]);
  assert.equal(ready,1); assert.equal(maximum,1); assert.equal(calls,2);
  await tools.call('computer_open_url',{url:'https://example.com/'});
  assert.equal(ready,1); assert.equal(calls,3,'opening a URL uses the same browser, without extra shell probes');
});

test('failed actions are not retried and readiness can recover on the next call', async t => {
  const f = await fixture(t); let ready=0,calls=0;
  const tools = f.createBoxComputerTools({ensureReady:async()=>{ready++},exec:async()=>{calls++;return {...reply({}),timedOut:true};}});
  const result = await tools.call('browser_click',{ref:'observed'});
  assert.equal(calls,1); assert.equal(result.isError,true); assert.match(result.content[0].text,/outcome is unknown/);
  await tools.call('browser_snapshot',{}); assert.equal(ready,2); assert.equal(calls,2);
});

test('desktop actions include original screenshot dimensions without a second model call', async t=>{
  const f=await fixture(t); const calls=[];
  const png=Buffer.alloc(24); Buffer.from('89504e470d0a1a0a','hex').copy(png); png.writeUInt32BE(1920,16); png.writeUInt32BE(1080,20);
  const tools=f.createBoxComputerTools({exec:async args=>{calls.push(args);return {code:0,stdout:args.includes('bash')?png:Buffer.alloc(0),stderr:'',timedOut:false}}});
  const result=await tools.call('computer_click',{x:1400,y:800});
  assert.equal(calls.length,2); assert.match(result.content[1].text,/1920×1080/); assert.equal(result.content[2].type,'image');
  await tools.call('computer_key',{key:'Tab',screenshot:false}); assert.equal(calls.length,3);
});

function driverContext(source, globals = {}) {
  const code = source.replace(/^import .*;$/gm,'').replaceAll('import.meta.url', JSON.stringify('file:///test-driver.mjs')).split('const watchdog = setTimeout')[0];
  const context = vm.createContext({crypto:webcrypto, setTimeout, clearTimeout, Map, Uint32Array, ...globals});
  vm.runInContext(code + '\nglobalThis.driverApi = {SNAPSHOT_FN, snapshotPage, visiblePageFrames, READ_PAGE_FN, refHandle, OPS, resolvePage};',context);
  return context;
}

test('snapshot refs cannot be reused after refresh or element removal', async t=>{
  const f=await fixture(t);
  class Element {
    tagName='BUTTON'; innerText='Save'; isConnected=true; children=[];
    getAttribute(){return null} matches(){return true} getBoundingClientRect(){return {width:80,height:30}} querySelector(){return null}
  }
  const button=new Element();
  const context=driverContext(f.SAND_BROWSER_DRIVER_SOURCE,{document:{body:button,querySelector:()=>null},window:{HTMLElement:Element,getComputedStyle:()=>({display:'block',visibility:'visible'})}});
  const api=context.driverApi;
  const first=api.SNAPSHOT_FN({}), oldRef=first.lines[0].match(/ref=([^\]]+)/)[1];
  const frame={evaluateHandle:async(fn,ref)=>{const element=context.__sandRefs.get(ref);return {asElement:()=>element?.isConnected?element:null,dispose:async()=>{}}}};
  const page={frames:()=>[frame]};
  assert.equal(await api.refHandle(page,oldRef),button);
  const second=api.SNAPSHOT_FN({}), newRef=second.lines[0].match(/ref=([^\]]+)/)[1];
  assert.notEqual(oldRef,newRef); await assert.rejects(api.refHandle(page,oldRef),/stale ref/);
  button.isConnected=false; await assert.rejects(api.refHandle(page,newRef),/stale ref/);
  api.SNAPSHOT_FN({selector:'#missing'}); assert.equal(context.__sandRefs.size,0);
});

test('closed explicit tabs fail safely rather than creating a replacement tab', async t=>{
  const f=await fixture(t); let created=0;
  const api=driverContext(f.SAND_BROWSER_DRIVER_SOURCE).driverApi;
  await assert.rejects(api.resolvePage({viewId:'closed',strictView:true},{pages:()=>[],newPage:async()=>{created++}},{views:{},urls:{}}),/no longer available/);
  assert.equal(created,0);
});

test('navigation observes DOM readiness without waiting for unrelated resources',async t=>{
  const f=await fixture(t), waits=[];
  const api=driverContext(f.SAND_BROWSER_DRIVER_SOURCE).driverApi;
  const page={setDefaultTimeout(){},goto:async(url,options)=>waits.push(options.waitUntil),waitForLoadState:async state=>waits.push(state)};
  const context={newPage:async()=>page,newCDPSession:async()=>({send:async()=>({targetInfo:{targetId:'one'}}),detach:async()=>{}})};
  await api.OPS.navigate({request:{url:'https://example.com',newTab:true,snapshotAfter:true},context,state:{views:{}}});
  assert.deepEqual(waits,['domcontentloaded']);
});

test('embedded frame refs are actionable and hidden frame controls are excluded', async t=>{
  const f=await fixture(t), api=driverContext(f.SAND_BROWSER_DRIVER_SOURCE).driverApi;
  let cleared=0;
  const element={isConnected:true};
  const frame=(url,visible,hasRef)=>({
    url:()=>url,
    frameElement:async()=>({isVisible:async()=>visible,dispose:async()=>{}}),
    evaluate:async(fn,options)=>options?{lines:[url+' control'],refCount:1}:void cleared++,
    evaluateHandle:async()=>({asElement:()=>hasRef?element:null,dispose:async()=>{}}),
  });
  const main=frame('main',true,false), iframe=frame('frame',true,true), hidden=frame('hidden',false,false);
  const page={frames:()=>[main,iframe,hidden],mainFrame:()=>main};
  const snapshot=await api.snapshotPage(page);
  assert.equal(cleared,3); assert.equal(snapshot.refCount,2); assert.match(snapshot.lines.join('\n'),/Embedded frame: frame/); assert.doesNotMatch(snapshot.lines.join('\n'),/hidden control/);
  assert.equal(await api.refHandle(page,'observed-iframe-ref'),element);
});

test('long article reading is paginated, searchable, and preserves complete text',async t=>{
  const f=await fixture(t), api=driverContext(f.SAND_BROWSER_DRIVER_SOURCE).driverApi;
  const text='A'.repeat(1000)+' Needle sentence with the complete answer. '+'B'.repeat(1000);
  const frame={evaluate:async()=>text};
  const page={frames:()=>[frame],mainFrame:()=>frame,evaluate:async()=>true,isClosed:()=>false,setDefaultTimeout(){}};
  const context={pages:()=>[page],newCDPSession:async()=>({send:async()=>({targetInfo:{targetId:'article'}}),detach:async()=>{}})};
  const state={views:{article:'article'},urls:{}};
  const first=await api.OPS.read({request:{viewId:'article',limit:500},context,state});
  assert.match(first.data,/start=500/); assert.equal(first.data.split('\n')[0].length,500);
  const second=await api.OPS.read({request:{viewId:'article',start:500,limit:500},context,state});
  assert.match(second.data,/start=1000/);
  const found=await api.OPS.read({request:{viewId:'article',find:'needle',limit:500},context,state});
  assert.match(found.data,/Needle sentence with the complete answer/);
  const missing=await api.OPS.read({request:{viewId:'article',find:'absent'},context,state}); assert.match(missing.summary,/not found/);
});

test('desktop gestures reject bad coordinates and support double clicks',async t=>{
  const f=await fixture(t),calls=[];
  const tools=f.createBoxComputerTools({exec:async args=>{calls.push(args);return {code:0,stdout:Buffer.alloc(0),stderr:'',timedOut:false}}});
  for(const [name,args] of [['computer_click',{x:null,y:10}],['computer_drag',{start_x:1,start_y:2,end_x:-5,end_y:6}],['computer_hover',{x:NaN,y:2}]]) {
    assert.equal((await tools.call(name,args)).isError,true);
  }
  assert.equal(calls.length,0);
  await tools.call('computer_click',{x:12,y:34,click_count:2,screenshot:false});
  assert.ok(calls[0].includes('--repeat')); assert.equal(calls[0][calls[0].indexOf('--repeat')+1],'2');
  await tools.call('computer_drag',{start_x:1,start_y:2,end_x:50,end_y:60,screenshot:false});
  const script=calls[1][calls[1].indexOf('-c')+1]; assert.match(script,/finally:/);assert.match(script,/mouseup/);
  assert.deepEqual(JSON.parse(calls[1].at(-1)),{start:[1,2],end:[50,60]});
});

test('browser bootstrap selects only the matching display profile and ignores worker processes',async t=>{
  const f=await fixture(t);
  const commandLines={
    '11':'/opt/google/chrome/chrome\0--user-data-dir=/home/box/chrome-profile/Fork-3\0--remote-debugging-port=9225\0',
    '12':'/opt/google/chrome/chrome\0--type=utility\0--user-data-dir=/home/box/chrome-profile/Fork-2\0--remote-debugging-port=9999\0',
    '13':'/opt/google/chrome/chrome\0--user-data-dir=/home/box/chrome-profile/Fork-2\0--remote-debugging-port=9223\0',
  };
  const fs={readdirSync:()=>Object.keys(commandLines),readFileSync:path=>commandLines[path.split('/')[2]]};
  const globals={Buffer,process:{argv:['node','-','path',Buffer.from(JSON.stringify({display:2,cdpPort:9224})).toString('base64')]},require:name=>name==='node:fs'?fs:{}};
  const context=vm.createContext(globals);
  vm.runInContext(f.BROWSER_BOOTSTRAP.split('fs.mkdirSync')[0]+'\nglobalThis.selected=request;',context);
  assert.equal(context.selected.cdpPort,9223);
});

test('wait uses a bounded visible-text condition without repeating the preceding action',async t=>{
  const f=await fixture(t), api=driverContext(f.SAND_BROWSER_DRIVER_SOURCE).driverApi,waits=[];
  const page={isClosed:()=>false,setDefaultTimeout(){},getByText:(text,options)=>({first:()=>({waitFor:async opts=>waits.push({text,options,opts})})})};
  const context={pages:()=>[page],newCDPSession:async()=>({send:async()=>({targetInfo:{targetId:'page'}}),detach:async()=>{}})};
  await api.OPS.wait({request:{viewId:'page',text:'Saved',timeoutMs:2500},context,state:{views:{page:'page'},urls:{}}});
  assert.equal(waits.length,1);assert.equal(waits[0].opts.timeout,2500);assert.equal(waits[0].opts.state,'visible');
});

test('shell commands have a remote deadline and bounded text output',async t=>{
  const f=await fixture(t),calls=[];
  const tools=f.createBoxComputerTools({exec:async(args,timeout)=>{calls.push({args,timeout});return {code:124,stdout:Buffer.from('x'.repeat(100000)),stderr:'',timedOut:false}}});
  const result=await tools.call('computer_shell',{command:'sleep 60',timeout_seconds:2});
  assert.equal(calls[0].timeout,5000);assert.ok(calls[0].args.includes('timeout'));assert.ok(calls[0].args.includes('2s'));
  assert.equal(result.isError,true);assert.match(result.content[0].text,/Inspect its effects before retrying/);assert.ok(result.content[0].text.length<33000);
});

test('stable tab identifiers survive reordering and never close a different tab',async t=>{
  const f=await fixture(t),api=driverContext(f.SAND_BROWSER_DRIVER_SOURCE).driverApi,closed=[];
  const page=id=>({id,isClosed:()=>false,url:()=>id,title:async()=>id,close:async()=>closed.push(id)});
  const a=page('a'),b=page('b');let order=[a,b];
  const context={pages:()=>order,newCDPSession:async page=>({send:async()=>({targetInfo:{targetId:page.id}}),detach:async()=>{}})};
  const state={views:{},urls:{}};
  const listing=await api.OPS.tabs({request:{action:'list'},context,state});
  const target=JSON.parse(listing.data).find(tab=>tab.url==='b').viewId;
  order=[b,a];
  await api.OPS.tabs({request:{action:'close',viewId:target,strictView:true},context,state});
  assert.deepEqual(closed,['b']);
  await assert.rejects(api.OPS.tabs({request:{action:'close',viewId:target,strictView:true},context,state}),/no longer available/);
  assert.deepEqual(closed,['b']);
});

test('a stale explicit view never adopts a different tab with the same URL',async t=>{
  const f=await fixture(t),api=driverContext(f.SAND_BROWSER_DRIVER_SOURCE).driverApi;
  const other={isClosed:()=>false,url:()=> 'https://example.com/form'};
  const context={pages:()=>[other],newCDPSession:async()=>({send:async()=>({targetInfo:{targetId:'other'}}),detach:async()=>{}}),newPage:()=>{throw Error('must not create a tab')}};
  await assert.rejects(api.resolvePage({viewId:'original',strictView:true},context,{views:{original:'gone'},urls:{original:'https://example.com/form'}}),/no longer available/);
});

test('form batches reject malformed or ambiguous fields before container execution', async t => {
  const f=await fixture(t),calls=[];
  const browser=f.createBoxBrowserTools(async args=>{calls.push(args);return reply({ok:true,summary:'Done'});}, ':2');
  for(const args of [
    {fields:[]}, {fields:[null]}, {fields:[{ref:'a'}]}, {fields:[{ref:'a',value:'x',checked:true}]},
    {fields:[{ref:'a',checked:'true'}]}, {fields:[{ref:'a',values:[1]}]},
    {fields:[{ref:'a',value:'x',op:'click'}]}, {fields:[{ref:'a',value:'x'},{ref:'a',value:'y'}]},
    {fields:Array.from({length:9},(_,i)=>({ref:String(i),value:''}))},
    {fields:[{ref:'a',value:''}],submitRef:'a'},
    {fields:[{ref:'a',value:''}],waitFor:{text:'Saved'}},
    {fields:[{ref:'a',value:''}],submitRef:'b',waitFor:{text:'Saved',timeoutMs:Infinity}},
  ]) assert.equal((await browser.call('browser_fill_form',args)).isError,true,JSON.stringify(args));
  assert.equal(calls.length,0);
  await browser.call('browser_fill_form',{fields:[{ref:'a',value:'Renée 東京'},{ref:'b',checked:false},{ref:'c',values:['']}],submitRef:'d',waitFor:{text:'Saved'}});
  assert.equal(calls.length,1);
  const request=JSON.parse(Buffer.from(calls[0].at(-1),'base64').toString());
  assert.equal(request.compact,true);assert.equal(request.op,'fill_form');assert.equal(request.fields[0].value,'Renée 東京');
});

function formHarness(api, overrides={}) {
  const actions=[], refs=new Map();let submitted=0;
  const frame={getByText:text=>({first:()=>({waitFor:async()=>{actions.push(['wait',text]);if(overrides.waitFails)throw Error('Timed out');}})}),
    evaluateHandle:async(fn,ref)=>({asElement:()=>refs.get(ref)??null,dispose:async()=>{}})};
  const control=(ref,tag,type)=>{
    const dom={tagName:tag,type,options:[{value:'ready',disabled:false}],matches:()=>tag==='BUTTON'};
    const element={evaluate:async(fn,arg)=>fn(dom,arg),isVisible:async()=>true,isEnabled:async()=>ref!=='save'||actions.length>0,isEditable:async()=>true,dispose:async()=>{},ownerFrame:async()=>frame,
      fill:async value=>{actions.push(['fill',ref,value]);if(overrides.detachAfterFill)refs.delete('mode');if(overrides.fillFails)throw Error('Changed during fill');},
      selectOption:async values=>actions.push(['select',ref,values]),setChecked:async checked=>actions.push(['check',ref,checked]),
      click:async()=>{submitted++;actions.push(['submit']);}};
    refs.set(ref,element);return element;
  };
  control('name','INPUT','text');control('mode','SELECT');control('summary','INPUT','checkbox');control('save','BUTTON');
  const page={frames:()=>[frame],isClosed:()=>false,setDefaultTimeout(){}};
  const context={pages:()=>[page],newCDPSession:async()=>({send:async()=>({targetInfo:{targetId:'form'}}),detach:async()=>{}})};
  const run=request=>api.OPS.fill_form({request:{viewId:'form',fields:[{ref:'name',value:'Café München'},{ref:'mode',values:['ready']},{ref:'summary',checked:true}],submitRef:'save',waitFor:{text:'Saved'},...request},context,state:{views:{form:'form'},urls:{}}});
  return {run,actions,refs,submitted:()=>submitted};
}

test('form batch fills Unicode, selects, checks, then submits once and waits in the submit frame',async t=>{
  const f=await fixture(t),api=driverContext(f.SAND_BROWSER_DRIVER_SOURCE).driverApi,h=formHarness(api);
  const result=await h.run({});
  assert.equal(result.error,undefined);assert.equal(h.submitted(),1);
  assert.deepEqual(h.actions,[['fill','name','Café München'],['select','mode',['ready']],['check','summary',true],['submit'],['wait','Saved']]);
  assert.match(result.summary,/confirmation condition met/);
});

test('batch preflight prevents partial edits for stale refs and wrong control types',async t=>{
  const f=await fixture(t),api=driverContext(f.SAND_BROWSER_DRIVER_SOURCE).driverApi;
  for(const fields of [[{ref:'name',value:'test'},{ref:'missing',value:'x'}],[{ref:'name',value:'test'},{ref:'summary',value:'wrong type'}]]) {
    const h=formHarness(api);const result=await h.run({fields});assert.ok(result.error);assert.equal(h.actions.length,0);assert.equal(h.submitted(),0);
  }
});

test('batch stops after reactive replacement or failed fill and never submits remaining fields',async t=>{
  const f=await fixture(t),api=driverContext(f.SAND_BROWSER_DRIVER_SOURCE).driverApi;
  for(const options of [{detachAfterFill:true},{fillFails:true}]) {
    const h=formHarness(api,options),result=await h.run({});assert.ok(result.error);assert.equal(h.actions.length,1);assert.equal(h.submitted(),0);
    assert.match(result.summary,/Submission was not attempted/);assert.match(result.summary,/failed step may have taken effect/);
  }
});

test('timed-out confirmation preserves partial progress and never replays submission',async t=>{
  const f=await fixture(t),api=driverContext(f.SAND_BROWSER_DRIVER_SOURCE).driverApi,h=formHarness(api,{waitFails:true});
  const data=await h.run({});assert.equal(h.submitted(),1);assert.match(data.summary,/Completed 3\/3 fields/);assert.match(data.summary,/Submission was attempted once/);
  const browser=f.createBoxBrowserTools(async()=>reply({ok:false,...data,page:undefined,data:'status: Saving... [ref=fresh]'}),':2');
  const result=await browser.call('browser_fill_form',{fields:[{ref:'name',value:'test'}],submitRef:'save'});
  assert.equal(result.isError,true);assert.match(result.content[0].text,/Completed 3\/3/);assert.match(result.content[0].text,/ref=fresh/);
});

test('compact snapshots reduce long article repetition while retaining late controls and status',async t=>{
  const f=await fixture(t);
  class Element {
    constructor(tag,text='',attrs={},children=[]){this.tagName=tag;this.innerText=text;this.attrs=attrs;this.children=children;this.isConnected=true;}
    getAttribute(name){return this.attrs[name]??null} matches(){return this.tagName==='BUTTON'}
    getBoundingClientRect(){return {width:100,height:30}} querySelector(){return null}
  }
  const children=Array.from({length:36},(_,i)=>new Element('P',`Section ${i+1}. `+'Routine inventory notes. '.repeat(40)));
  children.push(new Element('P','Shipment ready: ABC123',{role:'status'}),new Element('BUTTON','Save once'));
  const body=new Element('BODY','',{},children),context=driverContext(f.SAND_BROWSER_DRIVER_SOURCE,{document:{body},window:{HTMLElement:Element,getComputedStyle:()=>({display:'block',visibility:'visible'})}});
  const api=context.driverApi,full=api.SNAPSHOT_FN({}).lines.join('\n'),compact=api.SNAPSHOT_FN({compact:true}).lines.join('\n');
  assert.ok(compact.length<full.length*0.15,`${compact.length} vs ${full.length}`);
  assert.match(compact,/Shipment ready: ABC123/);assert.match(compact,/Save once.*ref=/);assert.match(compact,/browser_read/);
  assert.equal(api.SNAPSHOT_FN({compact:true,interactive:true}).refCount,1);
});

test('tab listing reads browser metadata without attaching to any renderer', async t => {
  const f = await fixture(t);
  const context = driverContext(f.SAND_BROWSER_DRIVER_SOURCE, {
    fetch: async () => ({json: async () => [{id:'healthy',type:'page',title:'Healthy',url:'https://fixture.invalid/'},{id:'hung',type:'page',title:'Busy',url:'https://fixture.invalid/busy'}]}),
    AbortSignal,
  });
  vm.runInContext('globalThis.driverApi.routedTarget = routedTarget; saveState = () => {}; openCdpSocket = () => { throw new Error("Listing must not attach"); };', context);
  const result = await context.driverApi.routedTarget({op:'tabs',action:'list',display:2,cdpPort:1234}, {views:{},urls:{}});
  assert.equal(result.result.ok,true);
  assert.equal(JSON.parse(result.result.data).length,2);
  assert.equal(JSON.parse(result.result.data)[1].viewId,'tab-hung');
});

test('an unresponsive child frame does not prevent a healthy main-page snapshot', async t => {
  const f=await fixture(t);
  const never = new Promise(()=>{});
  const main = {};
  // snapshotPage calls the supplied snapshot function by identity.
  const context=driverContext(f.SAND_BROWSER_DRIVER_SOURCE);
  const api=context.driverApi;
  main.evaluate=async fn => fn === api.SNAPSHOT_FN ? {lines:['Healthy controls'],refCount:1} : undefined;
  const child={evaluate:()=>never,frameElement:async()=>({isVisible:async()=>true,dispose:async()=>{}}),url:()=> 'https://fixture.invalid/frame'};
  const page={frames:()=>[main,child],mainFrame:()=>main};
  const started=Date.now();
  const result=await api.snapshotPage(page);
  assert.match(result.lines.join('\n'),/Healthy controls/);
  assert.match(result.lines.join('\n'),/unavailable/);
  assert.ok(Date.now()-started<5000,'child frame deadlines must bound the snapshot');
});
