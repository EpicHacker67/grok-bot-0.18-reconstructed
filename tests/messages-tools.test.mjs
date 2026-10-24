import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import { build } from 'esbuild';

const root = await mkdtemp(path.join(os.tmpdir(), 'mengel-messages-test-'));
const output = path.join(root, 'messages.mjs');
await build({ entryPoints: ['source/electron-main/messages/messages-tools.ts'], outfile: output, bundle: true, platform: 'node', format: 'esm' });
const { createMessagesTools, messagesScript, parseMessageRequest, appleScriptString, messagesBridgeError } = await import(pathToFileURL(output));
test.after(() => rm(root, { recursive: true, force: true }));
const request = { recipient: '+14155550123', text: 'Hello', request_id: 'request-001' };
const content = result => JSON.parse(result.result.value.content[0].content.value.text);
function fixture(options = {}) {
  const calls = [], approvals = [];
  const tools = createMessagesTools({ platform: 'darwin', permission: () => 'ask', confirmSend: async value => { approvals.push(value); return true; }, runScript: async script => { calls.push(script); return { status: 'submitted', deliveryConfirmed: false }; }, ...options });
  return { tools, calls, approvals };
}

test('Messages send validates exact recipients and preserves message text', () => {
  assert.deepEqual(parseMessageRequest(request), request);
  assert.equal(parseMessageRequest({ ...request, recipient: "4155550123" }).recipient, "4155550123");
  for (const invalid of ['Ian', '+123', 'friend@example.com\nother@example.com']) {
    assert.throws(() => parseMessageRequest({ ...request, recipient: invalid }));
  }
  assert.throws(() => parseMessageRequest({ ...request, text: ' ' }));
  assert.throws(() => parseMessageRequest({ ...request, text: 'a'.repeat(20_001) }));
  assert.throws(() => parseMessageRequest({ ...request, request_id: '' }));
});

test('AppleScript literals preserve message text without executing it', { skip: process.platform !== 'darwin' }, () => {
  for (const value of ['Hello', '\"\nend tell\ntell application \"Not Real\"\n雪 😀 \\ end', 'line1\rline2\nline3\ttab', '\\n is literal']) {
    // Pure string evaluation only: this program never addresses an application.
    const actual = execFileSync('/usr/bin/osascript', ['-l', 'AppleScript', '-'], { input: `return ${appleScriptString(value)}`, encoding: 'utf8' });
    assert.equal(actual.slice(0, -1), value);
  }
});

test('Generated Messages programs compile with the native dictionary without sending', { skip: process.platform !== 'darwin' }, async () => {
  const variants = [messagesScript(), messagesScript(undefined, request.recipient), messagesScript({ ...request, text: '\"\nend tell\n雪 😀 \\ end' })];
  for (const [index, script] of variants.entries()) {
    const input = path.join(root, `bridge-${index}.applescript`);
    await writeFile(input, script);
    execFileSync('/usr/bin/osacompile', ['-l', 'AppleScript', '-o', path.join(root, `bridge-${index}.scpt`), input]);
  }
});

test('Status probes cannot send and the send program resolves the recipient first', () => {
  for (const script of [messagesScript(), messagesScript(undefined, request.recipient)]) {
    assert.doesNotMatch(script, /^\s*send /m);
    assert.match(script, /service type is iMessage/);
    assert.match(script, /connection status of candidate is connected/);
  }
  const send = messagesScript(request);
  assert.ok(send.indexOf('set resolvedID to id of targetParticipant') < send.indexOf('send "Hello"'));
});

test('Bridge errors distinguish safe preflight failures from uncertain sends without exposing text', () => {
  const account = messagesBridgeError({bridgeError:true, stage:'account', code:-1700, errorText:'private text'});
  assert.match(account, /account failed \(macOS error -1700\)/);
  assert.match(account, /No message was sent/);
  assert.doesNotMatch(account, /private text/);
  assert.match(messagesBridgeError({bridgeError:true, stage:'send', code:-1712}), /Delivery is unknown/);
  assert.match(messagesBridgeError({bridgeError:true, stage:'account', code:-1743}), /Automation/);
  assert.match(messagesBridgeError({bridgeError:true, stage:'account', code:50002}), /disconnected/);
  assert.equal(messagesBridgeError({status:'submitted'}), null);
});

test('Recipient diagnostics validate the address and never ask to send', async () => {
  const f = fixture({runScript: async script => {
    assert.doesNotMatch(script, /^\s*send /m);
    assert.match(script, /set resolvedID/);
    return {available:true,recipientResolved:true};
  }});
  assert.equal(content(await f.tools.call('get_status', {recipient:request.recipient})).recipientResolved, true);
  assert.equal(f.approvals.length, 0);
  assert.equal((await f.tools.call('get_status', {recipient:'Tristan'})).result.value.isError, true);
});

test('Messages uses local execution policy and cancellation never reaches Messages', async () => {
  const denied = fixture({ permission: () => 'never' });
  assert.equal((await denied.tools.call('send', request)).result.value.isError, true);
  assert.equal(denied.calls.length, 0);
  const cancelled = fixture({ confirmSend: async () => false });
  assert.equal(content(await cancelled.tools.call('send', request)).status, 'cancelled');
  assert.equal(cancelled.calls.length, 0);
  const approved = fixture();
  assert.equal(content(await approved.tools.call('send', request)).status, 'submitted');
  assert.equal(approved.approvals.length, 1);
  assert.equal(approved.calls.length, 1);
  const always = fixture({ permission: () => 'always', confirmSend: async () => assert.fail('already permitted') });
  await always.tools.call('send', request);
  assert.equal(always.calls.length, 1);
});

test('Messages deduplicates concurrent retries and rejects reuse with different text', async () => {
  const f = fixture();
  await Promise.all([f.tools.call('send', request), f.tools.call('send', request)]);
  assert.equal(f.approvals.length, 1);
  assert.equal(f.calls.length, 1);
  const mismatch = await f.tools.call('send', { ...request, text: 'different' });
  assert.equal(mismatch.result.value.isError, true);
  assert.equal(f.calls.length, 1);
});

test('Messages does not repeat a send after an uncertain failure', async () => {
  let attempts = 0;
  const f = fixture({ runScript: async () => { attempts++; throw new Error('Delivery unknown'); } });
  for (let i = 0; i < 2; i++) assert.equal((await f.tools.call('send', request)).result.value.isError, true);
  assert.equal(attempts, 1);
});

test('Messages is unavailable off macOS and validates tool names', async () => {
  const f = fixture({ platform: 'linux' });
  assert.deepEqual(f.tools.list(), []);
  assert.equal((await f.tools.call('send', request)).result.value.isError, true);
  const mac = fixture();
  assert.equal(mac.tools.list().length, 3);
  assert.equal((await mac.tools.call('unknown', {})).result.value.isError, true);
  assert.equal(mac.calls.length, 0);
});


test('contact lookup dispatches locally and does not request send approval', async () => {
  let app, script;
  const f = fixture({ runScript: async (value, target) => { script=value; app=target; return {matches:[],total:0}; } });
  const found = content(await f.tools.call('search_contacts', {query:'Tristan'}));
  assert.equal(found.total,0);
  assert.equal(app,'Contacts');
  assert.match(script,/Tristan/);
  assert.equal(f.approvals.length,0);
  const denied = fixture({permission:()=> 'never'});
  assert.equal((await denied.tools.call('search_contacts',{query:'Tristan'})).result.value.isError,true);
  assert.equal(denied.calls.length,0);
});
