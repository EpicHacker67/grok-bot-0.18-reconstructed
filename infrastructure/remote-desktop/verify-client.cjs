// Run with Electron on the receiving Mac. Uses only its own disposable window.
const {app,BrowserWindow,ipcMain}=require('electron');
const {spawn}=require('node:child_process');
const {writeFileSync}=require('node:fs');
const sampleCount=Math.max(2,Math.min(30,Number(process.env.MENGEL_TEST_SAMPLES)||8));
const target=process.env.MENGEL_TEST_HOST||'holly@holly-ms-7d70';
const container=process.env.MENGEL_TEST_CONTAINER||'mengel-gpu-preview';
if(!/^[\w.@-]+$/.test(target)||!(container==='grok-bot-local-vm'||/^mengel-[\w-]+$/.test(container)))throw Error('Invalid test target');
const remote=`let data='';process.stdin.on('data',b=>data+=b);process.stdin.on('end',async()=>{try{let token=process.env.SAND_GATEWAY_TOKEN||require('fs').readFileSync('/tmp/mengel-test-token','utf8');let r=await fetch('http://127.0.0.1:8840/offer',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:data});if(!r.ok)throw Error(await r.text());console.log(await r.text())}catch(e){console.error(e.message);process.exitCode=1}})`;
const quote=s=>"'"+s.replaceAll("'","'\\''")+"'";
ipcMain.handle('offer',(_event,offer)=>new Promise((ok,fail)=>{
 const p=spawn('ssh',['-o','BatchMode=yes',target,`docker exec -i ${container} /exec-daemon/node -e ${quote(remote)}`]);let out='',err='';p.stdout.on('data',b=>out+=b);p.stderr.on('data',b=>err+=b);p.on('error',fail);p.on('close',code=>code?fail(Error(err)):ok(JSON.parse(out)));p.stdin.end(JSON.stringify(offer));
}));
let window;
ipcMain.on('result',async(_event,result)=>{writeFileSync('/tmp/mengel-stream-result.json',JSON.stringify(result,null,2));console.log(JSON.stringify({connection:result.connection,error:result.error,samples:result.samples?.map(reports=>reports.map(r=>({kind:r.kind,fps:r.measuredFps,bufferMs:1000*r.jitterBufferDelay/r.jitterBufferEmittedCount,targetMs:1000*r.jitterBufferTargetDelay/r.jitterBufferEmittedCount,decodeMs:1000*r.totalDecodeTime/r.framesDecoded})))}));if(window)writeFileSync('/tmp/mengel-stream-preview.png',(await window.capturePage()).toPNG());app.quit()});
app.commandLine.appendSwitch('autoplay-policy','no-user-gesture-required');
app.setPath('userData','/tmp/mengel-stream-verification-profile');
app.whenReady().then(()=>{
 window=new BrowserWindow({width:1280,height:760,show:true,webPreferences:{nodeIntegration:true,contextIsolation:false,backgroundThrottling:false}});
 window.loadURL('data:text/html;charset=utf-8,'+encodeURIComponent(`<!doctype html><body style="margin:0;background:black"><video style="width:100%;height:100vh" autoplay playsinline></video><script>
 const {ipcRenderer}=require('electron');(async()=>{try{
 const pc=new RTCPeerConnection({iceServers:[]});pc.addTransceiver('video',{direction:'recvonly'});pc.addTransceiver('audio',{direction:'recvonly'});
 const video=document.querySelector('video'),stream=new MediaStream();pc.ontrack=e=>{e.receiver.jitterBufferTarget=0;stream.addTrack(e.track);video.srcObject=stream;video.play()};
 await pc.setLocalDescription(await pc.createOffer());await new Promise(resolve=>{if(pc.iceGatheringState==='complete')return resolve();pc.onicegatheringstatechange=()=>{if(pc.iceGatheringState==='complete')resolve()}});
 const answer=await ipcRenderer.invoke('offer',pc.localDescription.toJSON());await pc.setRemoteDescription({type:'answer',sdp:answer.sdp});
 const samples=[];let last=0,lastTime=performance.now();
 for(let i=0;i<${sampleCount};i++){await new Promise(r=>setTimeout(r,2000));const now=performance.now(),reports=[];(await pc.getStats()).forEach(r=>{if(r.type==='inbound-rtp'){reports.push(r);if(r.kind==='video'){r.measuredFps=(r.framesDecoded-last)*1000/(now-lastTime);last=r.framesDecoded;lastTime=now}}});samples.push(reports)}
 const result={connection:pc.connectionState,samples};pc.close();ipcRenderer.send('result',result);
 }catch(e){ipcRenderer.send('result',{error:String(e)})}})();</script>`));
});
setTimeout(()=>{console.error('Verification timed out');app.exit(1)},sampleCount*2000+24000).unref();
