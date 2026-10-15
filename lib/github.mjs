import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileMap, changes } from './files.mjs';
const exec=promisify(execFile);

export function repoURL(value) {
  let url; try { url=new URL(value); } catch { throw new Error('Paste a GitHub repository URL, such as https://github.com/owner/project.'); }
  const match=url.pathname.match(/^\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/);
  if(url.protocol!=='https:' || url.hostname!=='github.com' || url.port || url.username || url.password || url.search || url.hash || !match || match[1].startsWith('.') || match[2].startsWith('.')) throw new Error('Use a plain https://github.com/owner/project repository URL.');
  return {owner:match[1],repo:match[2],url:`https://github.com/${match[1]}/${match[2]}.git`};
}
export async function githubAPI(endpoint,{method='GET',body,token=process.env.GITHUB_TOKEN}={}) {
  if(!endpoint.startsWith('/repos/')) throw new Error('Unsupported GitHub operation.');
  const res=await fetch('https://api.github.com'+endpoint,{method,headers:{Accept:'application/vnd.github+json','User-Agent':'Code-God/0.1',...(token?{Authorization:`Bearer ${token}`}:{})},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(30000),redirect:'error'});
  const data=await res.json();
  if(!res.ok) throw new Error(`GitHub ${res.status}: ${String(data.message||'Request failed').slice(0,250)}`);
  return data;
}
export async function importGithub(value) {
  const repo=repoURL(value), endpoint=`/repos/${repo.owner}/${repo.repo}`;
  const metadata=await githubAPI(endpoint);
  if(metadata.size>100000) throw new Error('Repository is too large for this release. Upload a ZIP of the source without dependencies or assets over 2 MB.');
  const temp=await fs.mkdtemp(path.join(os.tmpdir(),'code-god-import-'));
  const token=process.env.GITHUB_TOKEN;
  const env={PATH:process.env.PATH, ...(process.env.SystemRoot?{SystemRoot:process.env.SystemRoot}:{}),HOME:temp,USERPROFILE:temp,TMPDIR:temp,TEMP:temp,GIT_TERMINAL_PROMPT:'0',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:os.platform()==='win32'?'NUL':'/dev/null',GIT_LFS_SKIP_SMUDGE:'1'};
  for(const name of ['HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','NO_PROXY','http_proxy','https_proxy','all_proxy','no_proxy','SSL_CERT_FILE','SSL_CERT_DIR','GIT_SSL_CAINFO','CURL_CA_BUNDLE'])if(process.env[name])env[name]=process.env[name];
  if(token) { env.GIT_CONFIG_COUNT='1'; env.GIT_CONFIG_KEY_0='http.https://github.com/.extraheader'; env.GIT_CONFIG_VALUE_0=`Authorization: Basic ${Buffer.from('x-access-token:'+token).toString('base64')}`; }
  try {
    // No package installation, submodules, hooks, or project commands run during import.
    await exec('git',['-c','core.hooksPath='+path.join(temp,'disabled-hooks'),'-c','protocol.file.allow=never','clone','--depth','1','--no-recurse-submodules','--single-branch',repo.url,path.join(temp,'repo')],{env,timeout:90000,maxBuffer:1024*1024});
    const checkout=path.join(temp,'repo');
    const {stdout:sha}=await exec('git',['rev-parse','HEAD'],{cwd:checkout,env,timeout:5000});
    const commit=await githubAPI(endpoint+'/git/commits/'+sha.trim());
    const {stdout:staged}=await exec('git',['ls-files','--stage','-z'],{cwd:checkout,env,timeout:5000,maxBuffer:1024*1024});
    const executable={};for(const entry of staged.split('\0')){const match=entry.match(/^100755 [a-f0-9]+ 0\t(.+)$/s);if(match)executable[match[1]]='100755';}
    return {name:repo.repo,source:{type:'github',...repo,branch:metadata.default_branch,sha:sha.trim(),tree:commit.tree.sha,executable},files:await fileMap(checkout)};
  } catch(error) {
    if(error.message?.includes('ENOENT')) throw new Error('Git is required for GitHub import. Install Git and restart Code God.');
    throw new Error(String(error.message||error).replaceAll(token||'__NO_TOKEN__','[redacted]').slice(0,600));
  } finally { await fs.rm(temp,{recursive:true,force:true}); }
}
export async function openPullRequest(store,id,{title,body=''}) {
  if(!process.env.GITHUB_TOKEN) throw new Error('Add GITHUB_TOKEN on the server and restart to create pull requests.');
  const p=store.get(id), source=p.source;
  if(source.type!=='github') throw new Error('Pull requests are available for GitHub-imported projects.');
  if(!title || typeof title!=='string' || title.length>200 || typeof body!=='string' || body.length>10000) throw new Error('Provide a pull request title (up to 200 characters).');
  const diffs=await store.diff(id);
  if(!diffs.length) throw new Error('No changes to send to GitHub.');
  const files=await fileMap(store.root(id)), endpoint=`/repos/${source.owner}/${source.repo}`, entries=[];
  for(const diff of diffs) {
    if(diff.type==='deleted') entries.push({path:diff.path,mode:'100644',type:'blob',sha:null});
    else { const blob=await githubAPI(endpoint+'/git/blobs',{method:'POST',body:{encoding:'base64',content:files.get(diff.path).toString('base64')}}); entries.push({path:diff.path,mode:source.executable?.[diff.path]||'100644',type:'blob',sha:blob.sha}); }
  }
  // Work from the exact imported commit; never overwrite the default branch.
  const tree=await githubAPI(endpoint+'/git/trees',{method:'POST',body:{base_tree:source.tree,tree:entries}});
  const commit=await githubAPI(endpoint+'/git/commits',{method:'POST',body:{message:title,tree:tree.sha,parents:[source.sha]}});
  const branch='code-god/'+Date.now().toString(36)+'-'+id.slice(0,8);
  await githubAPI(endpoint+'/git/refs',{method:'POST',body:{ref:'refs/heads/'+branch,sha:commit.sha}});
  try {
    const pr=await githubAPI(endpoint+'/pulls',{method:'POST',body:{title,body:body+'\n\nCreated with Code God. Review the diff and checks before merging.',head:branch,base:source.branch,draft:true}});
    return {url:pr.html_url,branch};
  } catch(error) { throw new Error(`Branch ${branch} was saved, but the draft pull request could not be opened: ${error.message}`); }
}
