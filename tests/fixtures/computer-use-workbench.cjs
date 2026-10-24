// Local, disposable end-to-end fixture. No accounts or external requests.
// Run inside the desktop container: node computer-use-workbench.cjs
const http = require('node:http');
const fs = require('node:fs');
const logPath = process.env.MENGEL_WORKBENCH_LOG || '/tmp/mengel-computer-use-workbench.jsonl';
const html = `<!doctype html><meta charset="utf-8"><title>Mengel control workbench</title>
<style>body{max-width:850px;margin:40px auto;font:17px system-ui;line-height:1.5}input,select,button{font:inherit;margin:8px;padding:8px}iframe{width:100%;height:180px;border:1px solid #aaa}canvas{border:1px solid #777}article p{max-width:70ch}</style>
<h1>Mengel control workbench</h1><p>Disposable local tests. These controls do not contact an external service.</p>
<form id="form"><label for="name">Test name</label><input id="name" name="name"><label for="mode">Mode</label><select id="mode"><option value="draft">Draft</option><option value="ready">Ready</option></select><label><input type="checkbox" id="checked">Include summary</label><button>Save test</button></form>
<p id="result" role="status">No test saved.</p><h2>Embedded editor</h2><iframe src="/frame" title="Embedded editor"></iframe>
<h2>Shadow control</h2><div id="shadow"></div><h2>Desktop drag test</h2><p>Drag the blue square into the outlined target. This is a canvas with no DOM controls.</p><canvas id="canvas" width="500" height="150"></canvas><p id="drag-result">Not dragged.</p>
<p><a target="_blank" href="/reference">Open reference in new tab</a></p>
<article><h2>Long reading sample</h2>
${Array.from({length:32},(_,i)=>`<p>Section ${i+1}. ${'This sample deliberately contains enough rendered text to need more than one reading window. '.repeat(8)}${i===23?'The final delivery window is Thursday, 14:30–16:00, and the package code is ORBIT-739.':''}</p>`).join('')}
</article><script>
async function record(kind,value){await fetch('/record',{method:'POST',body:JSON.stringify({kind,value})})}
document.querySelector('#form').onsubmit=async e=>{e.preventDefault();const value={name:document.querySelector('#name').value,mode:document.querySelector('#mode').value,checked:document.querySelector('#checked').checked};document.querySelector('#result').textContent='Saving…';await record('form',value);setTimeout(()=>document.querySelector('#result').textContent='Saved test: '+value.name+' / '+value.mode+' / summary '+value.checked,350)};
const root=document.querySelector('#shadow').attachShadow({mode:'open'});root.innerHTML='<button>Activate shadow control</button><p role="status">Inactive</p>';root.querySelector('button').onclick=async()=>{await record('shadow',true);root.querySelector('p').textContent='Shadow control activated'};
const canvas=document.querySelector('canvas'),ctx=canvas.getContext('2d');let x=20,held=false;function draw(){ctx.clearRect(0,0,500,150);ctx.strokeRect(380,40,80,80);ctx.fillStyle='#397bf6';ctx.fillRect(x,60,40,40)}draw();canvas.onpointerdown=e=>{const b=canvas.getBoundingClientRect(),px=e.clientX-b.left,py=e.clientY-b.top;held=px>=x&&px<=x+40&&py>=60&&py<=100;if(held)canvas.setPointerCapture(e.pointerId)};canvas.onpointermove=e=>{if(held){x=Math.max(0,Math.min(460,e.clientX-canvas.getBoundingClientRect().left-20));draw()}};canvas.onpointerup=async()=>{if(held&&x>=380&&x<=420){await record('drag',true);document.querySelector('#drag-result').textContent='Drag verified'}held=false};
</script>`;
const frame = '<!doctype html><meta charset="utf-8"><label>Frame note <input id="note"></label><button>Save note</button><p id="result">No note saved.</p><script>document.querySelector("button").onclick=async()=>{const value=document.querySelector("input").value;await fetch("/record",{method:"POST",body:JSON.stringify({kind:"frame",value})});document.querySelector("p").textContent="Saved note: "+value}</script>';
const server = http.createServer(async (req,res)=>{
  if(req.method==='GET' && ['/','/frame','/reference'].includes(req.url)){
    res.setHeader('content-type','text/html; charset=utf-8');res.setHeader('cache-control','no-store');
    return res.end(req.url==='/frame'?frame:req.url==='/reference'?'<h1>Workbench reference</h1><p>Reference code: LANTERN-42</p>':html);
  }
  if(req.method==='POST'&&req.url==='/record'){
    let raw='';for await(const chunk of req){raw+=chunk;if(raw.length>10000){res.writeHead(413);return res.end()}}
    try {const {kind,value}=JSON.parse(raw);if(!['form','frame','shadow','drag'].includes(kind))throw Error();fs.appendFileSync(logPath,JSON.stringify({time:Date.now(),kind,value})+'\n');return res.end('Recorded')}catch{res.writeHead(400);return res.end('Invalid test event')}
  }
  res.writeHead(404);res.end('Not found');
});
server.listen(18766,'127.0.0.1',()=>console.log('Workbench: http://127.0.0.1:18766/'));
setTimeout(()=>server.close(),30*60*1000).unref();
