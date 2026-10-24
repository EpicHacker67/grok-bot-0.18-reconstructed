import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import vm from 'node:vm';
import test from 'node:test';
import { build } from 'esbuild';
const root = await mkdtemp(path.join(os.tmpdir(), 'mengel-contacts-test-'));
const output = path.join(root, 'contacts.mjs');
await build({entryPoints:['source/electron-main/messages/contacts-script.ts'],outfile:output,bundle:true,platform:'node',format:'esm'});
const {contactsScript,parseContactQuery} = await import(pathToFileURL(output));
test.after(()=>rm(root,{recursive:true,force:true}));
function lookup(query, rows) {
  const fields = items => items.map(({label='',value})=>({label:()=>label,value:()=>value}));
  const people = rows.map((row,index)=>({
    id:()=>String(index), name:()=>row.name, nickname:()=>row.nickname??'',
    phones:()=>{ assert.notEqual(row.unrelated,true,'must not read unrelated contact numbers'); return fields(row.phones??[]); },
    emails:()=>fields(row.emails??[]),
  }));
  people.name=()=>rows.map(row=>row.name);
  people.nickname=()=>rows.map(row=>row.nickname??'');
  return JSON.parse(vm.runInNewContext(contactsScript(query), { Application: id=>{
    assert.equal(id,'com.apple.AddressBook');return {people};
  }}));
}

test('named Contacts lookup resolves a saved local number without guessing country code',()=>{
  const result=lookup('tristan',[
    {name:'Unrelated Person',unrelated:true},
    {name:'Tristan Example',phones:[{label:'mobile',value:'(415) 555-0123'}]},
  ]);
  assert.equal(result.total,1);
  assert.equal(result.matches[0].preferredRecipient,'4155550123');
  assert.match(result.guidance,/Do not ask/);
});
test('duplicate first names return all matches for disambiguation',()=>{
  const result=lookup('Tristan',[
    {name:'Tristan One',phones:[{value:'+1 (415) 555-0123'}]},
    {name:'Tristan Two',phones:[{value:'+1 (415) 555-0124'}]},
  ]);
  assert.equal(result.total,2);assert.match(result.guidance,/Ask which/);
  assert.equal(result.matches[0].preferredRecipient,'+14155550123');
});
test('nickname and accent-insensitive full-name lookup work',()=>{
  const rows=[{name:'Tristán Example',nickname:'T-Man',phones:[{value:'+44 7700 900123'}]}];
  assert.equal(lookup('Tristan Example',rows).total,1);
  assert.equal(lookup('T-Man',rows).total,1);
  assert.equal(lookup('another',rows).total,0);
});
test('multiple numbers prefer a unique mobile number and otherwise require clarification',()=>{
  const rows=[{name:'Tristan',phones:[{label:'home',value:'4155550123'},{label:'work',value:'4155550124'}]}];
  assert.equal(lookup('Tristan',rows).matches[0].preferredRecipient,null);
  rows[0].phones[1].label='_$!<Mobile>!$_';
  assert.equal(lookup('Tristan',rows).matches[0].preferredRecipient,'4155550124');
  rows[0].phones[0].label='iPhone';
  assert.equal(lookup('Tristan',rows).matches[0].preferredRecipient,null);
});
test('lookup rejects extensions rather than silently combining them into a number',()=>{
  const result=lookup('Tristan',[{name:'Tristan',phones:[{value:'415-555-0123 ext 45'}]}]);
  assert.equal(result.matches[0].preferredRecipient,null);
});
test('lookup is bounded and never treats a truncated list as a unique match',()=>{
  const result=lookup('Tristan',Array.from({length:25},(_,i)=>({name:'Tristan '+i,phones:[{value:'4155550123'}]})));
  assert.equal(result.total,25);assert.equal(result.matches.length,20);assert.equal(result.truncated,true);
  assert.match(result.guidance,/Ask which/);
});
test('query validation and script encoding keep lookup data separate from executable code',()=>{
  for (const query of ['', '*', '\nTristan', 'a'.repeat(121)]) assert.throws(()=>parseContactQuery({query}));
  assert.equal(parseContactQuery({query:' Tristan '}),'Tristan');
  assert.doesNotThrow(()=>lookup('"; throw Error("injected"); //',[]));
});
