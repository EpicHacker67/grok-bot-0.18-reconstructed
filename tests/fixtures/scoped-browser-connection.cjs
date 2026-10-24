// Standalone Linux regression: an isolated headless Chrome, never the user's profile.
// Usage: node scoped-browser-connection.cjs /path/to/generated-driver.mjs
const assert = require('node:assert/strict');
const { spawn, execFile } = require('node:child_process');
const { mkdtemp, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { promisify } = require('node:util');
const { createServer } = require('node:http');
const { createRequire } = require('node:module');
const { chromium } = createRequire('/node_modules/fixture.cjs')('playwright-core');
const exec = promisify(execFile);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
(async () => {
  const profile = await mkdtemp(join(tmpdir(), 'mengel-isolated-browser-'));
  const server = createServer();
  // Avoid recursive frames while retaining a normal child frame.
  server.on('request', (req, res) => res.end(req.url === '/frame' ? '<p>Child frame text</p>' : '<!doctype html><title>Healthy fixture</title><button onclick="this.textContent=\'Clicked once\'">Test button</button><input aria-label="Name"><iframe src="/frame"></iframe>'));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const web = `http://127.0.0.1:${server.address().port}/`;
  const chrome = spawn('/usr/bin/google-chrome', ['--headless=new', '--no-sandbox', '--disable-gpu', '--no-first-run', '--remote-debugging-port=19325', '--user-data-dir='+profile, 'about:blank'], { stdio: 'ignore' });
  let browser;
  const report = {};
  try {
    for (let attempt = 0; ; attempt++) {
      try { if ((await fetch('http://127.0.0.1:19325/json/version')).ok) break; } catch {}
      if (attempt > 50) throw new Error('Fixture Chrome failed to start');
      await delay(100);
    }
    browser = await chromium.connectOverCDP('http://127.0.0.1:19325');
    console.log('Fixture Chrome connected');
    const context = browser.contexts()[0];
    context.setDefaultTimeout(10000);
    const healthy = context.pages()[0]; await healthy.goto(web);
    const frozen = await context.newPage(); await frozen.goto(web.replace('127.0.0.1','localhost')+'frozen');
    const debuggerSession = await context.newCDPSession(frozen);
    let resumed = false;
    void debuggerSession.send('Runtime.evaluate', {expression:'while (true) {}'}).finally(() => { resumed = true; }).catch(() => {});
    await delay(200);
    console.log('Background fixture renderer blocked');
    const start = Date.now();
    try { const connection = await chromium.connectOverCDP('http://127.0.0.1:19325', {timeout:2000}); await connection.close(); report.baseline = 'connected'; }
    catch { report.baseline = 'timed out on frozen background tab'; }
    report.baselineMs = Date.now()-start;
    console.log('Baseline: '+report.baseline);
    assert.equal(report.baseline, 'timed out on frozen background tab');
    async function driver(request) {
      const started = Date.now(); console.log('Driver: '+request.op);
      const {stdout} = await exec(process.execPath, [process.argv[2], Buffer.from(JSON.stringify({ display: 199925, cdpPort: 19325, strictView:true, preferVisible:true, snapshotAfter:true, ...request })).toString('base64')], { timeout:25000, maxBuffer:1024*1024 });
      const line = stdout.split('\n').find(l => l.startsWith('__SAND_BROWSER_RESULT__'));
      assert.ok(line, stdout);
      const result = JSON.parse(line.slice('__SAND_BROWSER_RESULT__'.length));
      assert.equal(result.ok,true,JSON.stringify(result));
      return {...result, elapsedMs:Date.now()-started};
    }
    const listed = await driver({op:'tabs',action:'list'});
    const tabs = JSON.parse(listed.data), tab = tabs.find(t => t.url === web);
    assert.ok(tab); assert.equal(tabs.length,2); report.listMs=listed.elapsedMs;
    const snapshot = await driver({op:'snapshot',viewId:tab.viewId});
    assert.match(snapshot.data,/Test button/); assert.match(snapshot.data,/Child frame text/);
    report.snapshotMs=snapshot.elapsedMs;
    const ref = snapshot.data.split('\n').find(l=>l.includes('Test button')).match(/ref=([^\]]+)/)[1];
    const clicked = await driver({op:'click',viewId:tab.viewId,ref});
    assert.match(clicked.data,/Clicked once/); report.clickMs=clicked.elapsedMs;
    const opened = await driver({op:'navigate',url:web+'new',newTab:true});
    assert.match(opened.data,/Test button/);
    const listAfter = await driver({op:'tabs',action:'list'});
    assert.equal(JSON.parse(listAfter.data).length,3);
    assert.equal(resumed,false,'driver must leave unrelated frozen tab untouched');
    await debuggerSession.send('Runtime.terminateExecution');
    const closed = await driver({op:'tabs',action:'close',viewId:opened.viewId});
    assert.match(closed.summary,/Closed/);
    report.passed=true;
    console.log(JSON.stringify(report,null,2));
  } finally {
    await browser?.close().catch(()=>{});
    chrome.kill('SIGKILL'); await new Promise(resolve => chrome.once('exit',resolve));
    await new Promise(resolve => server.close(resolve));
    await rm(profile,{recursive:true,force:true});
    await rm('/tmp/.sand-browser/views-199925.json',{force:true});
  }
})().catch(error => { console.error(error); process.exitCode=1; });
