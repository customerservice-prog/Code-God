import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {setTimeout as pause} from 'node:timers/promises';
import {startServer} from '../server.mjs';
import {unzip,zip} from '../lib/files.mjs';

test('HTTP flow: auth, import, edit, changes, preview, export, restore and cross-origin protection',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'cg-http-'));const app=await startServer({dataDir:dir,port:0,previewPort:0,token:'test-access-token-which-is-at-least-32-characters'});t.after(async()=>{await app.close();await fs.rm(dir,{recursive:true,force:true});});
  const origin='http://127.0.0.1:'+app.port;
  const call=async(route,method='GET',payload,headers={})=>{const res=await fetch(origin+'/api'+route,{method,headers:{Authorization:'Bearer '+app.token,...(payload?{'Content-Type':'application/json'}:{}),...headers},body:payload?JSON.stringify(payload):undefined});return {status:res.status,data:await res.json()};};
  assert.equal((await fetch(origin+'/api/projects')).status,401);assert.equal((await call('/projects','GET',null,{Origin:'https://evil.test'})).status,403);
  const badHost=await new Promise((resolve,reject)=>{const request=http.get(origin+'/api/projects',{headers:{Host:'evil.test',Authorization:'Bearer '+app.token}},response=>{response.resume();resolve(response.statusCode);});request.on('error',reject);});assert.equal(badHost,403);
  const created=await call('/projects','POST',{name:'My website',template:'website'});assert.equal(created.status,201);const id=created.data.id;
  assert.equal((await call('/projects/'+id)).data.files.length,4);assert.equal((await call('/projects/'+id+'/file?path=..%2Foutside')).status,400);
  const history=(await call('/projects/'+id+'/history')).data;
  assert.equal((await call('/projects/'+id+'/file','PUT',{path:'index.html',content:'<h1>Changed</h1><script>document.body.dataset.test="yes";</script>'})).status,200);
  assert.equal((await call('/projects/'+id+'/changes')).data[0].type,'modified');
  const preview=(await call('/projects/'+id+'/preview','POST',{})).data;const previewRes=await fetch(preview.url);assert.equal(previewRes.status,200);assert.match(await previewRes.text(),/Changed/);assert.match(previewRes.headers.get('content-security-policy'),/sandbox allow-scripts/);assert.match(previewRes.headers.get('content-security-policy'),/connect-src 'none'/);assert.equal((await fetch(preview.url.replace('index.html','.env'))).status,404);
  const exported=await fetch(origin+'/api/projects/'+id+'/export',{headers:{Authorization:'Bearer '+app.token}});assert.match(unzip(Buffer.from(await exported.arrayBuffer())).get('index.html').toString(),/Changed/);
  assert.equal((await call('/projects/'+id+'/restore','POST',{snapshot:history[0].id})).status,200);assert.equal((await call('/projects/'+id+'/changes')).data.length,0);
  const zipData=zip(new Map([['folder/hello.txt',Buffer.from('uploaded')]]));const uploaded=await call('/import/files','POST',{name:'Upload',zipBase64:zipData.toString('base64')});assert.equal(uploaded.status,201);assert.equal((await call('/projects/'+uploaded.data.id+'/file?path=hello.txt')).data.content,'uploaded');
  const textUpload=await call('/import/files','POST',{name:'Folder',files:[{path:'src/a.js',contentBase64:Buffer.from('export const a=1;').toString('base64')},{path:'.env',contentBase64:Buffer.from('secret').toString('base64')}]});assert.equal(textUpload.status,201);assert.equal((await call('/projects/'+textUpload.data.id)).data.files.length,1);
  const html=await (await fetch(origin+'/')).text();for(const asset of ['/style.css','/app.js'])assert.equal((await fetch(origin+asset)).status,200);assert.match(html,/Build with Code God/);
});
test('agent round-trip: model tool call changes a real file, feeds back result, and keeps restore point',async t=>{
  let requests=0;const received=[];
  const model=http.createServer(async(req,res)=>{let text='';for await(const chunk of req)text+=chunk;received.push(JSON.parse(text));requests++;res.setHeader('Content-Type','application/json');res.end(JSON.stringify({message:requests===1?{role:'assistant',content:'I will edit the page.',tool_calls:[{function:{name:'write_file',arguments:{path:'index.html',content:'<h1>Built by the agent</h1>'}}}]}:{role:'assistant',content:'Updated index.html. Checks were not run.'}}));});await new Promise(r=>model.listen(0,'127.0.0.1',r));
  const saved=process.env.CG_AI_URL;process.env.CG_AI_URL='http://127.0.0.1:'+model.address().port;const dir=await fs.mkdtemp(path.join(os.tmpdir(),'cg-agent-'));const app=await startServer({dataDir:dir,port:0,previewPort:0,token:'test-access-token-which-is-at-least-32-characters'});
  t.after(async()=>{await app.close();await new Promise(r=>model.close(r));await fs.rm(dir,{recursive:true,force:true});if(saved===undefined)delete process.env.CG_AI_URL;else process.env.CG_AI_URL=saved;});
  const p=await app.store.create('Agent project',{type:'new'},new Map([['index.html',Buffer.from('original')]]));const run=await app.agent.start(p.id,'Make the page say hello','test-model');let result;
  for(let i=0;i<100;i++){result=app.agent.getRun(run.id);if(result.status!=='running')break;await pause(20);}
  assert.equal(result.status,'completed');assert.equal(requests,2);assert.match(await fs.readFile(path.join(app.store.root(p.id),'index.html'),'utf8'),/Built by the agent/);assert.ok(received[1].messages.some(m=>m.role==='tool'&&m.content.includes('saved')));assert.ok(app.store.history(p.id).some(s=>s.label.startsWith('Before AI:')));assert.ok(app.store.messages(p.id).at(-1).content.includes('not run'));assert.equal(app.store.busy.size,0);
});
