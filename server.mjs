import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createStore } from './lib/store.mjs';
import { createAgent, modelStatus } from './lib/agent.mjs';
import { scan, readText, writeText, resolveFile, fileMap, zip, unzip, safePath, ignored, LIMITS } from './lib/files.mjs';
import { importGithub, openPullRequest } from './lib/github.mjs';
import { dockerAvailable, runCheck, CHECKS } from './lib/runner.mjs';

const here=path.dirname(fileURLToPath(import.meta.url));
const types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.mjs':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json','.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.gif':'image/gif','.webp':'image/webp','.ico':'image/x-icon','.woff2':'font/woff2'};
function json(res,status,data) {res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(data));}
async function body(req) {
  if(!(req.headers['content-type']||'').startsWith('application/json')) throw new Error('Send application/json.');
  let size=0;const chunks=[];
  for await(const chunk of req) {size+=chunk.length;if(size>30*1024*1024)throw new Error('Upload exceeds 30 MB.');chunks.push(chunk);}
  try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw new Error('Invalid JSON request.');}
}
function base64(value) {
  if(typeof value!=='string' || value.length>29*1024*1024 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length%4) throw new Error('Invalid file encoding.');
  return Buffer.from(value,'base64');
}
function template(name) {
  if(name==='website') return new Map([['index.html',Buffer.from('<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>My project</title><link rel="stylesheet" href="style.css"></head><body><main><span>YOUR NEXT IDEA</span><h1>Make something great.</h1><p>Describe your changes in Code God to build this project.</p><button id="hello">Try it</button><p id="message" aria-live="polite"></p></main><script src="app.js"></script></body></html>\n')],['style.css',Buffer.from('body{margin:0;background:#f5f2ed;color:#172321;font:18px system-ui;display:grid;place-items:center;min-height:100vh}main{padding:48px;max-width:800px}span{font-size:12px;letter-spacing:.2em}h1{font-size:clamp(42px,8vw,86px);line-height:1.05;letter-spacing:-.05em}p{color:#5b6761;line-height:1.7}button{background:#193e32;color:white;padding:14px 24px;border:0;border-radius:8px;font:inherit;cursor:pointer}\n')],['app.js',Buffer.from('document.querySelector("#hello").addEventListener("click",()=>{document.querySelector("#message").textContent="Your project is working.";});\n')],['README.md',Buffer.from('# My website\n\nA static HTML, CSS, and JavaScript project. Open Preview in Code God.\n')]]);
  return new Map([['README.md',Buffer.from('# New project\n\nDescribe what you want to build in Code God.\n')]]);
}
export async function startServer(options={}) {
  const host=options.host||process.env.CG_HOST||'127.0.0.1';
  const dataDir=path.resolve(options.dataDir||process.env.CG_DATA_DIR||path.join(here,'data'));
  await fs.mkdir(dataDir,{recursive:true,mode:0o700});
  let token=options.token||process.env.CG_AUTH_TOKEN;
  if(!token && !['127.0.0.1','localhost','::1'].includes(host)) throw new Error('Set CG_AUTH_TOKEN to at least 32 characters before binding beyond localhost.');
  if(!token) {
    try{token=(await fs.readFile(path.join(dataDir,'access-token'),'utf8')).trim();}
    catch(e){if(e.code!=='ENOENT')throw e;token=randomBytes(32).toString('hex');await fs.writeFile(path.join(dataDir,'access-token'),token,{mode:0o600});}
  }
  if(token.length<32) throw new Error('CG_AUTH_TOKEN must contain at least 32 characters.');
  const store=await createStore(dataDir),agent=createAgent(store),tickets=new Map();
  let mainPort,previewPort,imports=0;
  const auth=req=>{const supplied=Buffer.from((req.headers.authorization||'').replace(/^Bearer /,'')),expected=Buffer.from(token);return supplied.length===expected.length && timingSafeEqual(supplied,expected);};
  const preview=http.createServer(async(req,res)=>{
    res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Cache-Control','no-store');res.setHeader('Referrer-Policy','no-referrer');
    res.setHeader('Content-Security-Policy',"sandbox allow-scripts; default-src 'self' data: blob:; script-src 'self' 'unsafe-inline' blob:; style-src 'self' 'unsafe-inline'; connect-src 'none'; form-action 'none'; object-src 'none'; base-uri 'self'");
    try {
      if(req.method!=='GET')throw new Error('Not found.');
      const url=new URL(req.url,'http://localhost'),match=url.pathname.match(/^\/t\/([a-f0-9]{48})\/(.*)$/),ticket=match&&tickets.get(match[1]);
      if(!ticket || ticket.expires<Date.now())throw new Error('Preview expired. Reopen Preview in Code God.');
      const name=decodeURIComponent(match[2])||'index.html';
      const file=await resolveFile(ticket.root,name);if((await fs.stat(file)).size>LIMITS.file)throw new Error('File too large.');
      res.writeHead(200,{'Content-Type':types[path.extname(file).toLowerCase()]||'application/octet-stream'});res.end(await fs.readFile(file));
    }catch{res.writeHead(404,{'Content-Type':'text/plain'});res.end('Preview unavailable or expired. Open Preview in Code God to refresh it.');}
  });
  const server=http.createServer(async(req,res)=>{
    res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');
    res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; frame-src http://127.0.0.1:* http://localhost:*; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
    try {
      const hosts=new Set([`127.0.0.1:${mainPort}`,`localhost:${mainPort}`,`${host}:${mainPort}`]);
      if(process.env.CG_PUBLIC_ORIGIN)hosts.add(new URL(process.env.CG_PUBLIC_ORIGIN).host);
      if(!hosts.has(req.headers.host))return json(res,403,{error:'Invalid request host.'});
      if(req.headers.origin && ![`http://${req.headers.host}`,process.env.CG_PUBLIC_ORIGIN].includes(req.headers.origin))return json(res,403,{error:'Cross-origin request blocked.'});
      const url=new URL(req.url,'http://localhost'), pathname=url.pathname;
      if(!pathname.startsWith('/api/')) {
        if(req.method!=='GET')return json(res,405,{error:'Method not allowed.'});
        const asset={'/':'index.html','/app.js':'app.js','/style.css':'style.css'}[pathname];
        if(!asset)return json(res,404,{error:'Not found.'});
        res.writeHead(200,{'Content-Type':types[path.extname(asset)],'Cache-Control':'no-store'});res.end(await fs.readFile(path.join(here,'public',asset)));return;
      }
      if(!auth(req))return json(res,401,{error:'Unlock Code God with the access link printed in its terminal.'});
      if(pathname==='/api/status' && req.method==='GET') {const [ai,docker]=await Promise.all([modelStatus(),dockerAvailable()]);return json(res,200,{ai,docker,github:Boolean(process.env.GITHUB_TOKEN),checks:Object.keys(CHECKS),version:'0.1.0'});}
      if(pathname==='/api/projects' && req.method==='GET')return json(res,200,store.list());
      if(pathname==='/api/projects' && req.method==='POST') {const b=await body(req);return json(res,201,await store.create(b.name,{type:'new'},template(b.template)));}
      if(pathname==='/api/import/files' && req.method==='POST') {
        const b=await body(req);let files;
        if(b.zipBase64)files=unzip(base64(b.zipBase64),true);
        else {
          if(!Array.isArray(b.files) || !b.files.length || b.files.length>LIMITS.files)throw new Error('Choose 1–2,000 source files.');
          files=new Map();let total=0;
          for(const f of b.files) {if(typeof f.path!=='string')throw new Error('File path is missing.');if(ignored(f.path))continue;safePath(f.path);const bytes=base64(f.contentBase64);total+=bytes.length;if(bytes.length>LIMITS.file || total>LIMITS.total)throw new Error('File or project size limit exceeded.');if(files.has(f.path))throw new Error('Duplicate file path.');files.set(f.path,bytes);}
        }
        if(!files.size)throw new Error('No editable source files were found.');
        return json(res,201,await store.create(b.name,{type:'upload'},files));
      }
      if(pathname==='/api/import/github' && req.method==='POST') {
        if(imports>=2)throw new Error('Two imports are already running. Try again shortly.');
        const b=await body(req);imports++;
        try{const imported=await importGithub(b.url);return json(res,201,await store.create(imported.name,imported.source,imported.files));}finally{imports--;}
      }
      const runMatch=pathname.match(/^\/api\/runs\/([a-f0-9-]{36})(\/stop)?$/);
      if(runMatch) {if(req.method==='GET' && !runMatch[2])return json(res,200,agent.getRun(runMatch[1]));if(req.method==='POST' && runMatch[2])return json(res,200,agent.cancel(runMatch[1]));}
      const match=pathname.match(/^\/api\/projects\/([a-f0-9-]{36})(?:\/(.*))?$/);
      if(!match)return json(res,404,{error:'Not found.'});
      const id=match[1],action=match[2]||'',project=store.get(id),root=store.root(id);
      if(action==='' && req.method==='GET')return json(res,200,{...project,files:await scan(root),messages:store.messages(id),busy:store.busy.has(id),latestRun:store.db.prepare('SELECT id,status FROM runs WHERE project_id=? ORDER BY created DESC LIMIT 1').get(id)||null});
      if(action==='file' && req.method==='GET')return json(res,200,{path:url.searchParams.get('path'),content:await readText(root,url.searchParams.get('path'))});
      if(action==='file' && ['PUT','DELETE'].includes(req.method)) {
        const b=await body(req);store.unlocked(id);store.busy.add(id);
        try{await store.snapshot(id,(req.method==='DELETE'?'Before deleting ':'Before saving ')+b.path);if(req.method==='DELETE')await fs.unlink(await resolveFile(root,b.path));else await writeText(root,b.path,b.content);store.touch(id);return json(res,200,{saved:true});}finally{store.busy.delete(id);}
      }
      if(action==='changes' && req.method==='GET')return json(res,200,await store.diff(id,url.searchParams.get('snapshot')));
      if(action==='history' && req.method==='GET')return json(res,200,store.history(id));
      if(action==='restore' && req.method==='POST') {const b=await body(req);await store.restore(id,b.snapshot);return json(res,200,{restored:true});}
      if(action==='runs' && req.method==='POST') {const b=await body(req);if(store.busy.size>=2)throw new Error('Two tasks are running. Stop or finish one before starting another.');return json(res,202,await agent.start(id,b.prompt,b.model));}
      if(action==='check' && req.method==='POST') {
        const b=await body(req);store.unlocked(id);store.busy.add(id);
        try{return json(res,200,await runCheck(root,b.check));}finally{store.busy.delete(id);}
      }
      if(action==='preview' && req.method==='POST') {
        let previewRoot;for(const directory of ['','dist','out','build','public'])try{await resolveFile(root,(directory?directory+'/':'')+'index.html');if((await fs.stat(path.join(root,directory,'index.html'))).isFile()){previewRoot=path.join(root,directory);break;}}catch{}
        if(!previewRoot)throw new Error('No index.html found. For framework apps, export/build a static version first. Server apps can be edited here but need their own runtime to preview.');
        for(const [key,ticket] of tickets)if(ticket.expires<Date.now() || ticket.project===id)tickets.delete(key);
        const ticket=randomBytes(24).toString('hex');tickets.set(ticket,{root:previewRoot,project:id,expires:Date.now()+60*60*1000});
        // Local-only preview keeps imported JavaScript on a separate origin.
        return json(res,200,{url:`http://127.0.0.1:${previewPort}/t/${ticket}/index.html`});
      }
      if(action==='export' && req.method==='GET') {
        const bytes=zip(await fileMap(root));res.writeHead(200,{'Content-Type':'application/zip','Content-Disposition':`attachment; filename="${project.name.replace(/[^a-zA-Z0-9_-]/g,'-')}.zip"`,'Cache-Control':'no-store'});res.end(bytes);return;
      }
      if(action==='pull-request' && req.method==='POST') {
        const b=await body(req);store.unlocked(id);store.busy.add(id);
        try{return json(res,201,await openPullRequest(store,id,b));}finally{store.busy.delete(id);}
      }
      return json(res,404,{error:'Not found.'});
    }catch(error) {if(!res.headersSent)json(res,400,{error:String(error.message||error).slice(0,800)});else res.end();}
  });
  server.requestTimeout=120000;preview.requestTimeout=15000;
  await new Promise((resolve,reject)=>{preview.once('error',reject);preview.listen(options.previewPort??Number(process.env.CG_PREVIEW_PORT||4311),'127.0.0.1',resolve);});
  previewPort=preview.address().port;
  try{await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(options.port??Number(process.env.CG_PORT||4310),host,resolve);});}catch(error){preview.close();store.db.close();throw error;}
  mainPort=server.address().port;
  return {server,preview,store,agent,token,port:mainPort,previewPort,url:`http://127.0.0.1:${mainPort}/#token=${token}`,
    async close(){await agent.stopAll();await Promise.all([new Promise(r=>server.close(r)),new Promise(r=>preview.close(r))]);store.db.close();}
  };
}
if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  startServer().then(app=>{console.log('\n  CODE GOD · Pineda Builder\n\n  Open this private access link on this computer:\n  '+app.url+'\n\n  Keep this link private. Ctrl+C stops the server.\n');}).catch(error=>{console.error(error.message);process.exitCode=1;});
}
