import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { build } from 'esbuild';
async function load(run) {
 const dir=await mkdtemp(join(tmpdir(),'mengel-packet-audio-'));
 try {const out=join(dir,'module.mjs');await build({entryPoints:['source/electron-preload/box-vnc-packet-audio.ts'],outfile:out,bundle:true,platform:'node',format:'esm'});await run(await import(pathToFileURL(out)))}finally{await rm(dir,{recursive:true,force:true})}
}
async function fixture(run) {
 await load(async({createPacketAudio})=>{
  const saved=new Map(['AudioContext','AudioDecoder','EncodedAudioChunk','performance'].map(k=>[k,Object.getOwnPropertyDescriptor(globalThis,k)]));
  const nodes=[],outputs=[],decoded=[];let context,decoder,now=10000,defer=false;
  class Context{state='running';get currentTime(){return now/1000}destination={};outputLatency=.02;constructor(){context=this}resume(){return Promise.resolve()}close(){this.closed=true;return Promise.resolve()}createGain(){return{connect(){},gain:{setValueAtTime(){}}}}createBuffer(_c,n,rate){return{duration:n/rate,getChannelData:()=>new Float32Array(n)}}createBufferSource(){const n={connect(){},disconnect(){},start(t){this.time=t},stop(){this.stopped=true}};nodes.push(n);return n}}
  const frame=timestamp=>({timestamp,numberOfFrames:480,numberOfChannels:2,sampleRate:48000,copyTo(){},close(){}});
  class Decoder{state='configured';decodeQueueSize=0;constructor(options){decoder=this;this.options=options}configure(){}close(){this.state='closed'}decode(chunk){decoded.push(chunk.timestamp);if(!defer)this.options.output(frame((decoded.length-1)*10000))}}
  const channel={close(){this.closed=true}};
  const globals={AudioContext:Context,AudioDecoder:Decoder,EncodedAudioChunk:class{constructor(value){Object.assign(this,value)}},performance:{now:()=>now}};
  for(const[k,v]of Object.entries(globals))Object.defineProperty(globalThis,k,{configurable:true,value:v});
  let player;
  try{
   player=createPacketAudio({createDataChannel:(label,options)=>{assert.equal(label,'mengel-audio-v1');assert.deepEqual(options,{ordered:false,maxRetransmits:0});return channel}},v=>outputs.push(v));
   const send=(seq,stamp)=>{const b=new ArrayBuffer(9),v=new DataView(b);v.setUint32(0,stamp);v.setUint16(4,seq);channel.onmessage({data:b})};
   await run({player,send,nodes,outputs,decoded,channel,advance:ms=>{now+=ms},defer:value=>{defer=value},flush:stamp=>decoder.options.output(frame(stamp)),get context(){return context},get decoder(){return decoder}});
  }finally{player?.close();for(const[k,v]of saved){if(v)Object.defineProperty(globalThis,k,v);else delete globalThis[k]}}
 });
}
test('packet audio preserves the sample clock through jitter, sequence wrap, and missing packets',async()=>{
 await fixture(({send,advance,player,nodes,decoded})=>{
  send(65535,4294967040);advance(10);send(0,224);send(0,224);send(65535,4294967040);
  assert.deepEqual(decoded,[0,10000]);assert.equal(player.stats().dropped,2);
  advance(40);send(4,2144); // Three lost packets must remain a gap, not compress the timeline.
  assert.ok(Math.abs(nodes.at(-1).time-nodes[0].time-.05)<.001);
  assert.ok(player.stats().queueMs<=150);
 });
});
test('packet audio rejects delayed bursts and decoder backlogs, then recovers and closes',async()=>{
 await fixture(f=>{
  f.send(1,0);f.advance(200);f.send(2,480);
  assert.equal(f.nodes.length,1,'old packet must not become a new playback queue');
  f.send(21,9600);assert.equal(f.nodes.length,2,'fresh packet catches up immediately');
  f.defer(true);f.advance(10);f.send(22,10080);f.advance(200);f.flush(210000);
  assert.equal(f.nodes.length,2,'stalled decoder must not play expired sound');
  f.defer(false);f.advance(10000);f.send(23,490560);
  assert.equal(f.nodes.length,3,'long disconnection can establish a fresh clock');
  assert.equal(f.nodes[0].stopped,true);assert.ok(f.player.stats().queueMs<=150);
  f.player.close();assert.equal(f.channel.closed,true);assert.equal(f.context.closed,true);assert.equal(f.decoder.state,'closed');assert.equal(f.outputs.at(-1),null);
  f.send(24,491040);assert.equal(f.nodes.length,3);
 });
});
