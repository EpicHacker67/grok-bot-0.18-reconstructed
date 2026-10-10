import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import test from 'node:test';
import {build} from 'esbuild';

async function load(entry, run) {
  const dir=await mkdtemp(join(tmpdir(),'mengel-audio-test-'));
  try {
    const out=join(dir,'module.mjs');
    await build({entryPoints:[entry],outfile:out,bundle:true,platform:'node',format:'esm'});
    await run(await import(pathToFileURL(out)));
  } finally { await rm(dir,{recursive:true,force:true}); }
}

test('audio queue preserves partial stereo frames and bounds latency after stalls', async()=>{
  await load('source/electron-main/box/remote-audio.ts',({AudioQueue})=>{
    const q=new AudioQueue();
    q.push(Buffer.from([1,2,3])); assert.equal(q.read().length,0);
    q.push(Buffer.from([4,5,6,7,8,9]));assert.deepEqual([...q.read()],[1,2,3,4,5,6,7,8]);
    q.push(Buffer.from([10,11,12,13,14,15,16]));assert.deepEqual([...q.read()],[9,10,11,12,13,14,15,16]);
    const large=Buffer.alloc(200008);large.writeFloatLE(.25,200000);large.writeFloatLE(-.25,200004);
    q.push(large);const result=q.read();assert.equal(result.length,96000);
    assert.equal(new DataView(result.buffer).getFloat32(result.length-8,true),.25);
    assert.equal(q.read().length,0);
  });
});

test('remote sound decodes stereo and stops on hide; muted views do not reconnect', async()=>{
  await load('source/electron-preload/box-vnc-audio.ts',async({installRemoteAudio})=>{
    const saved=new Map(['location','localStorage','document','window','AudioContext'].map(k=>[k,Object.getOwnPropertyDescriptor(globalThis,k)]));
    const handlers={},buttonHandlers={},windowHandlers={},decoded=[],nodes=[];
    const elements=[];
    const createElement=tag=>{
      const attrs={},listeners={};
      const element={tag,attrs,listeners,style:{setProperty(){}},append(){},contains:target=>elements.includes(target),addEventListener:(n,fn)=>listeners[n]=fn,setAttribute:(k,v)=>attrs[k]=v};
      elements.push(element);return element;
    };
    let gainLevel=0;
    const gain={connect(){},gain:{cancelScheduledValues(){},setTargetAtTime:value=>gainLevel=value}};
    let visibleListener,starts=0,stops=0,reads=0;
    const bytes=new Uint8Array(16);const view=new DataView(bytes.buffer);
    [.25,-.5,.75,-1].forEach((n,i)=>view.setFloat32(i*4,n,true));
    class Context {
      state='suspended';currentTime=1;destination={};
      resume(){this.state='running';this.onstatechange?.();return Promise.resolve()}
      suspend(){this.state='suspended';return Promise.resolve()}
      close(){this.state='closed';return Promise.resolve()}
      createGain(){return gain}
      createBuffer(channels,frames,rate){const data=[new Float32Array(frames),new Float32Array(frames)];decoded.push(data);return{duration:frames/rate,getChannelData:i=>data[i]}}
      createBufferSource(){const node={connect(){},disconnect(){},start(){},stop(){this.stopped=true}};nodes.push(node);return node}
    }
    const globals={location:{pathname:'/vnc.html',search:'?sandInteractive=1'},localStorage:{getItem:()=>null,setItem(){}},document:{createElement,body:{append(){}},addEventListener:(n,fn)=>handlers[n]=fn},window:{addEventListener:(n,fn)=>windowHandlers[n]=fn},AudioContext:Context};
    for(const [k,v] of Object.entries(globals))Object.defineProperty(globalThis,k,{configurable:true,value:v});
    try{
      const audio=installRemoteAudio({startAudio:async()=>{starts++;return{supported:true,started:true}},readAudio:async()=>({bytes:reads++===0?bytes:new Uint8Array(),error:null}),stopAudio:async()=>{stops++}}, {on:(_channel,fn)=>visibleListener=fn});
      const button=elements.find(e=>e.tag==='button'),slider=elements.find(e=>e.tag==='input');
      assert.equal(starts,0,'hidden viewer must not capture');
      visibleListener(null,true);await new Promise(r=>setTimeout(r,10));
      assert.deepEqual([...decoded[0][0]],[.25,.75]);assert.deepEqual([...decoded[0][1]],[-.5,-1]);
      assert.equal(gainLevel,1);
      slider.value='35';slider.listeners.input();assert.equal(gainLevel,.35);assert.equal(starts,1,'volume dragging must not restart capture');
      button.listeners.click();assert.equal(button.attrs['aria-label'],'Unmute remote computer');assert.equal(slider.value,'0');assert.equal(gainLevel,0);assert.equal(nodes[0].stopped,true);
      visibleListener(null,false);visibleListener(null,true);await new Promise(r=>setTimeout(r,10));assert.equal(starts,1);
      button.listeners.click();await new Promise(r=>setTimeout(r,10));assert.equal(starts,2);
      assert.equal(gainLevel,.35,'unmute restores the prior volume');assert.equal(slider.value,'35');
      const media={volume:1,muted:true,play:async()=>{}};
      audio.setMediaElement(media);await new Promise(r=>setTimeout(r,10));
      assert.equal(starts,2,'WebRTC audio replaces PCM capture rather than playing twice');
      assert.equal(media.volume,.35);assert.equal(media.muted,false);
      button.listeners.click();assert.equal(media.muted,true);
      button.listeners.click();assert.equal(media.muted,false);assert.equal(starts,2);
      audio.setMediaElement(null);await new Promise(r=>setTimeout(r,10));
      assert.equal(starts,3,'VNC fallback restores PCM audio automatically');
      slider.value='0';slider.listeners.input();assert.equal(gainLevel,0);assert.equal(button.attrs['aria-label'],'Unmute remote computer');
      visibleListener(null,false);assert.ok(stops>=2);windowHandlers.pagehide();
    }finally{for(const [k,v] of saved)v?Object.defineProperty(globalThis,k,v):delete globalThis[k]}
  });
});

test('volume controls ignore browser activity, reveal locally, and stay visible during a drag', async t=>{
  await load('source/electron-preload/box-vnc-audio.ts',({installRemoteAudio})=>{
    const saved=new Map(['location','localStorage','document','window'].map(k=>[k,Object.getOwnPropertyDescriptor(globalThis,k)]));
    const elements=[],events={};
    let visibility,stops=0;
    const createElement=tag=>{
      const element={tag,attrs:{},listeners:{},style:{setProperty(){}},append(){},contains(){return false},
        getBoundingClientRect(){return {left:800,right:950,top:600,bottom:640}},
        setAttribute(k,v){this.attrs[k]=v},addEventListener(n,fn){this.listeners[n]=fn}};
      elements.push(element);return element;
    };
    const globals={location:{pathname:'/vnc.html',search:'?sandInteractive=1'},
      localStorage:{getItem:k=>k==='mengel-remote-sound'?'muted':null},
      document:{createElement,body:{append(){}},addEventListener:(n,fn)=>(events[n]??=[]).push(fn)},
      window:{addEventListener(){}}};
    for(const [k,v] of Object.entries(globals))Object.defineProperty(globalThis,k,{configurable:true,value:v});
    t.mock.timers.enable({apis:['setTimeout']});
    const fire=(n,coords={clientX:100,clientY:100})=>events[n]?.forEach(fn=>fn({target:null,...coords}));
    try{
      installRemoteAudio({startAudio:async()=>{throw new Error('muted')},readAudio:async()=>{throw new Error('muted')},stopAudio:async()=>{stops++}}, {on:(_channel,fn)=>visibility=fn});
      const controls=elements.find(e=>e.tag==='div');
      visibility(null,true);
      t.mock.timers.tick(2000);fire('pointermove');fire('wheel');fire('keydown');fire('pointerdown');
      t.mock.timers.tick(999);assert.equal(controls.attrs['data-idle'],'false');
      t.mock.timers.tick(1);assert.equal(controls.attrs['data-idle'],'true');assert.equal(stops,0,'hiding the controls must not affect playback');
      fire('pointermove');fire('wheel');fire('keydown');assert.equal(controls.attrs['data-idle'],'true','browser activity must not reveal the controls');
      fire('pointermove',{clientX:850,clientY:620});assert.equal(controls.attrs['data-idle'],'false');
      t.mock.timers.tick(2000);controls.listeners.wheel();t.mock.timers.tick(2000);assert.equal(controls.attrs['data-idle'],'false','control activity resets the delay');
      controls.listeners.pointerdown();t.mock.timers.tick(10000);assert.equal(controls.attrs['data-idle'],'false','do not hide mid-drag');
      fire('pointerup');t.mock.timers.tick(3000);assert.equal(controls.attrs['data-idle'],'true');
      controls.listeners.keydown();assert.equal(controls.attrs['data-idle'],'false');
      visibility(null,false);t.mock.timers.tick(3000);assert.equal(controls.attrs['data-idle'],'false','closing the viewer clears its idle timer');
      visibility(null,true);t.mock.timers.tick(3000);assert.equal(controls.attrs['data-idle'],'true');
      visibility(null,false);
    }finally{t.mock.timers.reset();for(const [k,v] of saved)v?Object.defineProperty(globalThis,k,v):delete globalThis[k]}
  });
});
