import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileMap, restoreFiles } from './files.mjs';
const exec=promisify(execFile);
export const CHECKS={
  'javascript-syntax':{image:'node:24-bookworm-slim',command:`node -e 'const fs=require("fs"),cp=require("child_process");let count=0,bad=0;function walk(p){for(const f of fs.readdirSync(p,{withFileTypes:true})){const n=p+"/"+f.name;if(f.isDirectory()&&!f.name.startsWith(".")&&f.name!=="node_modules")walk(n);else if(f.isFile()&&/\\.(?:mjs|cjs|js)$/.test(n)){count++;const r=cp.spawnSync(process.execPath,["--check",n],{encoding:"utf8"});if(r.status){bad++;console.error(r.stderr)}}}}walk(".");console.log(count+" JavaScript files checked");process.exit(bad?1:count?0:2)'`},
  'node-test':{image:'node:24-bookworm-slim',command:'node --test'},
  'npm-test':{image:'node:24-bookworm-slim',command:'npm test'},
  'npm-build':{image:'node:24-bookworm-slim',command:'npm run build'},
  'python-test':{image:'python:3.12-slim',command:'python -m unittest discover -v'}
};
export async function dockerAvailable() { try { await exec('docker',['info','--format','{{.ServerVersion}}'],{timeout:4000}); return true; } catch { return false; } }
export async function runCheck(root,name,{signal}={}) {
  const spec=CHECKS[name]; if(!spec) throw new Error('Choose a supported check.');
  if(!await dockerAvailable()) return {status:'unavailable',exitCode:null,output:'Docker is not running. No project code was executed. Install/start Docker Desktop and retry. Checks never fall back to running imported code on the host.'};
  const temp=await fs.mkdtemp(path.join(os.tmpdir(),'code-god-check-')), container='code-god-'+randomUUID();
  try {
    await restoreFiles(temp,await fileMap(root));
    const args=['run','--rm','--pull=never','--name',container,'--network=none','--read-only','--pids-limit=128','--memory=768m','--cpus=1','--cap-drop=ALL','--security-opt=no-new-privileges','--user=65534:65534','--mount',`type=bind,src=${temp},dst=/input,readonly`,'--tmpfs','/work:rw,nosuid,nodev,size=256m,mode=1777','--tmpfs','/tmp:rw,nosuid,nodev,size=64m,mode=1777','--workdir=/work',spec.image,'sh','-c','cp -R /input/. /work/ && '+spec.command];
    await fs.chmod(temp,0o755);
    return await new Promise((resolve,reject)=>{
      let output='', settled=false;
      const child=spawn('docker',args,{stdio:['ignore','pipe','pipe'],windowsHide:true});
      const finish=(error,code)=>{if(settled)return;settled=true;clearTimeout(timer);signal?.removeEventListener('abort',stop);if(error)reject(error);else resolve({status:code===0?'passed':'failed',exitCode:code,output:output.slice(0,40000)});};
      const stop=()=>{execFile('docker',['rm','-f',container],{timeout:5000},()=>{}); child.kill();finish(new Error(signal?.aborted?'Check stopped.':'Check exceeded 90 seconds.'));};
      const timer=setTimeout(stop,90000);
      const collect=chunk=>{output+=chunk.toString();if(output.length>50000)stop();};
      child.stdout.on('data',collect);child.stderr.on('data',collect);child.on('error',e=>finish(e));child.on('close',code=>finish(null,code));
      signal?.addEventListener('abort',stop,{once:true}); if(signal?.aborted)stop();
    });
  } finally { await fs.rm(temp,{recursive:true,force:true}); }
}
