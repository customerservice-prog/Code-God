import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {zip,unzip,safePath,writeText,readText,scan,changes,LIMITS} from '../lib/files.mjs';
import {createStore} from '../lib/store.mjs';
import {executeTool} from '../lib/agent.mjs';
import {repoURL,openPullRequest} from '../lib/github.mjs';

test('ZIP round-trip preserves text and binary data, and strips a common folder',()=>{
  const original=new Map([['project/index.html',Buffer.from('<h1>Hello</h1>')],['project/image.png',Buffer.from([0,1,128,255])],['project/empty',Buffer.alloc(0)]]);
  const result=unzip(zip(original),true);assert.equal(result.get('index.html').toString(),'<h1>Hello</h1>');assert.deepEqual(result.get('image.png'),Buffer.from([0,1,128,255]));assert.equal(result.get('empty').length,0);
});
test('path validation rejects traversal, Windows alternate paths and credential files',()=>{
  for(const name of ['../x','/tmp/a','C:/a','a\\b','a/../b','a//b','a/./b','.env','.env.local','.git/config','keys/server.pem','id_rsa','a\0b'])assert.throws(()=>safePath(name));assert.equal(safePath('.github/workflows/ci.yml'),'.github/workflows/ci.yml');
});
test('ZIP import rejects traversal, symlinks, duplicates, corruption and oversized declarations',()=>{
  let bytes=zip(new Map([['xx/a.js',Buffer.from('hello')]]));bytes=Buffer.from(bytes.toString('latin1').replaceAll('xx/a.js','../a.js'),'latin1');assert.throws(()=>unzip(bytes),/Unsafe/);
  bytes=zip(new Map([['a.js',Buffer.from('hello')]]));const cd=bytes.indexOf(Buffer.from([0x50,0x4b,0x01,0x02]));bytes.writeUInt32LE((0xa1ff<<16)>>>0,cd+38);assert.throws(()=>unzip(bytes),/linked/);
  bytes=zip(new Map([['a.js',Buffer.from('a')],['b.js',Buffer.from('b')]]));bytes=Buffer.from(bytes.toString('latin1').replaceAll('b.js','a.js'),'latin1');assert.throws(()=>unzip(bytes),/Duplicate/);
  bytes=zip(new Map([['a.js',Buffer.from('hello')]]));const at=bytes.indexOf(Buffer.from([0x50,0x4b,0x01,0x02]));bytes.writeUInt32LE(LIMITS.file+1,at+24);assert.throws(()=>unzip(bytes),/oversized/);
  bytes=zip(new Map([['a.js',Buffer.from('hello')]]));bytes.writeUInt32LE(123,bytes.indexOf(Buffer.from([0x50,0x4b,0x01,0x02]))+16);assert.throws(()=>unzip(bytes),/checksum/);
});
test('workspace tools edit actual files, reject ambiguous replacement and cannot cross symlinks',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'cg-tools-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  await executeTool(dir,'write_file',{path:'src/app.js',content:'one one\nhello'});assert.equal(await readText(dir,'src/app.js'),'one one\nhello');
  await assert.rejects(executeTool(dir,'replace_text',{path:'src/app.js',old:'one',replacement:'two'}),/exactly once/);
  await executeTool(dir,'replace_text',{path:'src/app.js',old:'hello',replacement:'$& world'});assert.match(await readText(dir,'src/app.js'),/\$& world/);
  const hits=await executeTool(dir,'search_files',{query:'world'});assert.equal(hits[0].line,2);await assert.rejects(executeTool(dir,'write_file',{path:'../escape',content:'no'}));
  if(os.platform()!=='win32'){await fs.symlink(os.tmpdir(),path.join(dir,'link'));await assert.rejects(writeText(dir,'link/escape','no'),/links/);await assert.rejects(scan(dir),/links/);}
});
test('history restores exact files, retains the current version, and survives restart',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'cg-store-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));let store=await createStore(dir);
  const p=await store.create('Test',{type:'new'},new Map([['a.txt',Buffer.from('original')],['b.txt',Buffer.from('remove me')]]));const baseline=store.history(p.id)[0].id;
  await store.snapshot(p.id,'Before edit');await writeText(store.root(p.id),'a.txt','changed');await writeText(store.root(p.id),'c.txt','added');await fs.unlink(path.join(store.root(p.id),'b.txt'));
  assert.deepEqual((await store.diff(p.id)).map(d=>[d.path,d.type]),[['a.txt','modified'],['b.txt','deleted'],['c.txt','added']]);await store.restore(p.id,baseline);assert.equal(await readText(store.root(p.id),'a.txt'),'original');assert.equal((await store.diff(p.id)).length,0);assert.ok(store.history(p.id).some(h=>h.label==='Before restoring a version'));
  store.db.close();store=await createStore(dir);assert.equal(store.list()[0].name,'Test');assert.equal(await readText(store.root(p.id),'b.txt'),'remove me');store.busy.add(p.id);await assert.rejects(store.restore(p.id,baseline),/busy/);store.db.close();
});
test('diff handles additions, deletions and binary changes',()=>{const result=changes(new Map([['a',Buffer.from('old')],['b',Buffer.from('delete')],['c',Buffer.from([0,1])]]),new Map([['a',Buffer.from('new')],['c',Buffer.from([0,2])],['d',Buffer.from('new')]]));assert.deepEqual(result.map(x=>x.type),['modified','deleted','modified','added']);assert.equal(result[2].binary,true);});
test('GitHub import accepts repository URLs only, with no arbitrary hosts or credentials',()=>{assert.deepEqual(repoURL('https://github.com/owner/repository.git'),{owner:'owner',repo:'repository',url:'https://github.com/owner/repository.git'});for(const u of ['http://github.com/o/r','https://github.com.evil.test/o/r','https://user:pass@github.com/o/r','https://github.com/o/r/tree/main','file:///tmp/repo','https://github.com/o/r?x=1'])assert.throws(()=>repoURL(u));});
test('draft PR export writes a separate branch rooted at the imported commit',async t=>{
  const originalFetch=globalThis.fetch,oldToken=process.env.GITHUB_TOKEN,requests=[];process.env.GITHUB_TOKEN='test-only';
  t.after(()=>{globalThis.fetch=originalFetch;if(oldToken===undefined)delete process.env.GITHUB_TOKEN;else process.env.GITHUB_TOKEN=oldToken;});
  globalThis.fetch=async(url,options)=>{const body=options.body?JSON.parse(options.body):null;requests.push({url,body});return new Response(JSON.stringify(url.endsWith('/pulls')?{html_url:'https://github.com/o/r/pull/1'}:{sha:'abc'}),{status:201,headers:{'Content-Type':'application/json'}});};
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'cg-pr-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));const store=await createStore(dir);t.after(()=>store.db.close());const p=await store.create('PR',{type:'github',owner:'o',repo:'r',sha:'original-sha',tree:'original-tree',branch:'main'},new Map([['a.js',Buffer.from('old')]]));await writeText(store.root(p.id),'a.js','new');
  const result=await openPullRequest(store,p.id,{title:'Fix a bug'});assert.equal(result.url,'https://github.com/o/r/pull/1');assert.deepEqual(requests.find(r=>r.url.endsWith('/git/commits')).body.parents,['original-sha']);assert.equal(requests.find(r=>r.url.endsWith('/git/trees')).body.base_tree,'original-tree');assert.match(requests.find(r=>r.url.endsWith('/git/refs')).body.ref,/^refs\/heads\/code-god\//);assert.equal(requests.find(r=>r.url.endsWith('/pulls')).body.draft,true);assert.equal(requests.find(r=>r.url.endsWith('/pulls')).body.base,'main');assert.ok(!requests.some(r=>r.url.includes('/git/refs/heads/main')));
});
