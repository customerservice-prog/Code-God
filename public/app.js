const $=s=>document.querySelector(s), $$=s=>[...document.querySelectorAll(s)];
const state={projects:[],project:null,file:null,original:'',dirty:false,tab:'files',mode:'new',uploads:[],zip:null,status:null,run:null,poll:null};
const fragment=new URLSearchParams(location.hash.slice(1));
if(fragment.has('token')){sessionStorage.setItem('code-god-token',fragment.get('token'));history.replaceState(null,'',location.pathname);}
function node(tag,text,className){const el=document.createElement(tag);if(text!==undefined)el.textContent=text;if(className)el.className=className;return el;}
let toastTimer;
function toast(text){$('#toast').textContent=text;$('#toast').hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('#toast').hidden=true,5500);}
async function api(endpoint,options={}){
  const res=await fetch('/api'+endpoint,{method:options.method||'GET',headers:{Authorization:'Bearer '+(sessionStorage.getItem('code-god-token')||''),...(options.body?{'Content-Type':'application/json'}:{})},body:options.body?JSON.stringify(options.body):undefined});
  const data=await res.json();if(!res.ok){if(res.status===401 && !$('#auth-dialog').open)$('#auth-dialog').showModal();throw new Error(data.error||'Request failed.');}return data;
}
const projectAPI=(action,options)=>api('/projects/'+state.project.id+(action?'/'+action:''),options);
const sourceText=p=>p.source.type==='github'?`${p.source.owner}/${p.source.repo} · ${p.source.branch}`:p.source.type==='upload'?'Imported files':'Created in Code God';
function keepEdits(){return !state.dirty || confirm('Discard the unsaved changes in this file?');}
function setDirty(dirty){state.dirty=dirty;$('#unsaved').hidden=!dirty;$('#save-file').disabled=!state.file || !dirty || state.project?.busy;}
async function refreshProjects(){state.projects=await api('/projects');renderProjects();}
function renderProjects(){
  $('#project-count').textContent=state.projects.length;$('#dashboard-count').textContent=state.projects.length;$('#project-list').replaceChildren();$('#project-cards').replaceChildren();
  for(const project of state.projects){
    const nav=node('button',project.name,'project-nav'+(state.project?.id===project.id?' active':''));nav.addEventListener('click',()=>openProject(project.id));$('#project-list').append(nav);
    const card=node('button',undefined,'project-card');card.append(node('span',project.source.type==='github'?'⑂':'◇','project-symbol'),node('h3',project.name),node('p',sourceText(project)),node('p',new Date(project.updated).toLocaleDateString(undefined,{month:'short',day:'numeric'})));card.addEventListener('click',()=>openProject(project.id));$('#project-cards').append(card);
  }
  const add=node('button',undefined,'project-card new-card');add.append(node('b','＋'),node('span','Start a new project'));add.addEventListener('click',()=>showCreate('new'));$('#project-cards').append(add);
}
async function refreshStatus(){
  $('#connection-status span:last-child').textContent='Checking connections';
  try{
    state.status=await api('/status');const s=state.status;
    $('#connection-status').classList.toggle('connected',s.ai.connected&&s.ai.models.length>0);$('#connection-status span:last-child').textContent=s.ai.connected&&s.ai.models.length?'AI connected':'Connect coding AI';
    const selected=$('#model').value;$('#model').replaceChildren();for(const name of s.ai.models)$('#model').append(new Option(name,name));if(!s.ai.models.length)$('#model').append(new Option('Connect a model',''));if(s.ai.models.includes(selected))$('#model').value=selected;else if(s.ai.defaultModel)$('#model').value=s.ai.defaultModel;
    $('#setup-status').replaceChildren();for(const [name,ok,label] of [['Coding AI',s.ai.connected&&s.ai.models.length,s.ai.connected&&s.ai.models.length?'Connected':'Not connected'],['Isolated checks',s.docker,s.docker?'Docker ready':'Docker not running'],['GitHub writes',s.github,s.github?'Token configured':'Not configured']]){const row=node('div',undefined,'setup-state');row.append(node('span',name),node('b',label,ok?'ok':''));$('#setup-status').append(row);}updateControls();
  }catch(error){toast(error.message);}
}
function updateControls(){const busy=Boolean(state.project?.busy||state.run);$('#send-button').disabled=busy||!state.status?.ai.connected||!$('#model').value;$('#stop-button').hidden=!state.run;$('#save-file').disabled=!state.file||!state.dirty||busy;$('#delete-file').disabled=busy;$('#add-file').disabled=busy;$('#run-check').disabled=busy;$('#pr-button').disabled=busy||state.project?.source.type!=='github'||!state.status?.github;$('#pr-button').title=!state.status?.github?'Configure GITHUB_TOKEN in Connections & setup':'Save changes to a new GitHub branch and draft pull request';$('#code-editor').readOnly=busy;}
function renderFiles(){
  $('#file-tree').replaceChildren();for(const file of state.project.files){const el=node('button',file.path,'file-item'+(state.file===file.path?' selected':''));el.title=file.path;el.addEventListener('click',()=>selectFile(file.path));$('#file-tree').append(el);}
}
function renderMessages(){
  $('#messages').replaceChildren();
  if(!state.project.messages.length){const intro=node('div',undefined,'chat-intro');intro.append(node('span','<g>','brand-icon'),node('h2','Let’s build it.'),node('p','Ask for a new feature, a bug fix, or an explanation. Code God reads your project and edits the actual files.'));for(const prompt of ['Explain this project and how to run it.','Find bugs and fix the most important one.','Improve the layout for phones and tablets.']){const b=node('button',prompt+' ↗','prompt-chip');b.addEventListener('click',()=>{$('#prompt').value=prompt;$('#prompt').focus();});intro.append(b);}$('#messages').append(intro);}
  for(const m of state.project.messages){const el=node('div',undefined,'message '+m.role);el.append(node('span',m.role==='user'?'YOU':'CODE GOD','message-label'),node('span',m.content));$('#messages').append(el);}$('#messages').scrollTop=$('#messages').scrollHeight;
}
async function openProject(id,{force=false}={}){
  if(!force&&!keepEdits())return;
  try{
    clearTimeout(state.poll);state.project=await api('/projects/'+id);state.run=null;state.file=null;setDirty(false);$('#code-editor').value='';$('#code-editor').disabled=true;$('#filename').textContent='Select a file';$('#delete-file').hidden=true;
    $('#dashboard').hidden=true;$('#workspace').hidden=false;$('#header-name').textContent=state.project.name;$('#project-title').textContent=state.project.name;$('#project-source').textContent=sourceText(state.project);$('#run-events').hidden=true;$('#run-events').replaceChildren();renderProjects();renderFiles();renderMessages();updateControls();
    localStorage.setItem('code-god-project',id);
    if(state.project.files.length)await selectFile(state.project.files.find(f=>f.path==='index.html')?.path||state.project.files[0].path);
    await loadTab(state.tab);
    if(state.project.latestRun?.status==='running'){state.run=state.project.latestRun.id;pollRun(state.run,id);updateControls();}
  }catch(error){toast(error.message);}
}
async function selectFile(name){if(!keepEdits())return;try{const f=await projectAPI('file?path='+encodeURIComponent(name));state.file=name;state.original=f.content;$('#code-editor').value=f.content;$('#code-editor').disabled=false;$('#filename').textContent=name;$('#delete-file').hidden=false;setDirty(false);renderFiles();updateControls();}catch(error){toast(error.message);}}
async function saveFile(){if(!state.file)return;await projectAPI('file',{method:'PUT',body:{path:state.file,content:$('#code-editor').value}});state.original=$('#code-editor').value;setDirty(false);toast('File saved. A restore point was kept.');}
async function loadTab(tab){
  state.tab=tab;$$('[data-tab]').forEach(b=>b.setAttribute('aria-selected',String(b.dataset.tab===tab)));$$('.tab-content').forEach(el=>el.hidden=el.id!=='tab-'+tab);
  if(!state.project)return;
  try{
    if(tab==='preview'){
      $('#preview-frame').hidden=true;$('#preview-message').hidden=false;$('#preview-message').textContent='Opening preview…';const p=await projectAPI('preview',{method:'POST',body:{}});$('#preview-frame').src=p.url;$('#preview-frame').hidden=false;$('#preview-message').hidden=true;
    }else if(tab==='changes'){
      const diffs=await projectAPI('changes'),target=$('#tab-changes');target.replaceChildren();$('#change-count').textContent=diffs.length||'';const title=node('div',undefined,'content-title');title.append(node('h2','Changes since import'),node('p','Compare your current files with the original project.'));target.append(title);if(!diffs.length)target.append(node('div','Your files match the original project.','empty'));
      for(const diff of diffs){const block=node('section',undefined,'change-block'),heading=node('div',undefined,'change-title');heading.append(node('span',diff.type,diff.type),node('strong',diff.path));block.append(heading);if(diff.binary)block.append(node('p','Binary file changed. Export the project to inspect it.','muted'));else{const sides=node('div',undefined,'change-sides');for(const [label,text] of [['ORIGINAL',diff.before],['CURRENT',diff.after]]){const side=node('div');side.append(node('b',label),node('pre',text||'(empty)'));sides.append(side);}block.append(sides);}target.append(block);}
    }else if(tab==='history'){
      const snapshots=await projectAPI('history'),target=$('#tab-history');target.replaceChildren();const title=node('div',undefined,'content-title');title.append(node('h2','Restore points'),node('p','The original project and the 30 most recent restore points are kept.'));target.append(title);
      for(const s of snapshots){const row=node('div',undefined,'history-row'),info=node('div'),button=node('button','Restore','secondary');info.append(node('strong',s.label),node('small',new Date(s.created).toLocaleString()));button.addEventListener('click',async()=>{if(!keepEdits()||!confirm('Restore all project files to this version? A restore point of your current files will be kept.'))return;try{await projectAPI('restore',{method:'POST',body:{snapshot:s.id}});await openProject(state.project.id,{force:true});toast('Version restored.');}catch(error){toast(error.message);}});row.append(info,button);target.append(row);}
    }
  }catch(error){if(tab==='preview'){$('#preview-message').textContent=error.message;}else toast(error.message);}
}
function showCreate(mode){state.uploads=[];state.zip=null;$('#upload-summary').textContent='Choose source files. Dependencies and common credential files are excluded.';$('#create-error').textContent='';setMode(mode);$('#create-dialog').showModal();}
function setMode(mode){state.mode=mode;$$('[data-mode]').forEach(b=>b.classList.toggle('selected',b.dataset.mode===mode));$('#name-field').hidden=mode==='github';$('#new-fields').hidden=mode!=='new';$('#github-fields').hidden=mode!=='github';$('#upload-fields').hidden=mode!=='upload';$('#create-title').textContent={new:'Start a new project',github:'Bring your GitHub project',upload:'Upload your project'}[mode];$('#create-submit').textContent=mode==='github'?'Import repository ↗':mode==='upload'?'Import project ↗':'Create project ↗';}
const fileBase64=file=>new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result).split(',')[1]);reader.onerror=()=>reject(new Error('Could not read '+file.name));reader.readAsDataURL(file);});
const excluded=p=>p.split('/').some(n=>['.git','node_modules','.next','.venv','venv','__pycache__','.cache','coverage'].includes(n)||/^\.env(?:\.|$)|^\.npmrc$|^\.pypirc$|^id_rsa$|^id_ed25519$|^credentials(?:\.|$)|\.(?:pem|key)$/i.test(n));
async function pollRun(runId,projectId){
  if(state.project?.id!==projectId)return;
  try{const run=await api('/runs/'+runId);$('#run-events').replaceChildren();$('#run-events').hidden=false;for(const event of run.events){const text=event.type==='check'?`Check ${event.content.status}: ${event.content.output}`:event.content;$('#run-events').append(node('div',text,['error','tool_error'].includes(event.type)?'event-error':''));}$('#run-events').scrollTop=$('#run-events').scrollHeight;
    if(run.status==='running'){state.poll=setTimeout(()=>pollRun(runId,projectId),1000);}else{state.run=null;await refreshProjects();await openProject(projectId,{force:true});toast(run.status==='completed'?'Task finished. Review the files and changes.':run.error||'Task stopped.');}
  }catch(error){toast(error.message);state.poll=setTimeout(()=>pollRun(runId,projectId),4000);}
}
$('#create-form').addEventListener('submit',async event=>{
  event.preventDefault();const button=$('#create-submit');button.disabled=true;$('#create-error').textContent='';
  try{let project;const name=$('#new-name').value.trim();if(state.mode==='github'){button.textContent='Importing repository…';project=await api('/import/github',{method:'POST',body:{url:$('#github-url').value.trim()}});}else if(state.mode==='new'){project=await api('/projects',{method:'POST',body:{name,template:$('#template').value}});}else{if(!state.zip&&!state.uploads.length)throw new Error('Choose a ZIP, folder, or source files first.');button.textContent='Importing files…';let payload;if(state.zip){if(state.zip.size>21*1024*1024)throw new Error('ZIP exceeds 20 MB.');payload={name,zipBase64:await fileBase64(state.zip)};}else{const files=[];let total=0;for(const file of state.uploads){const rel=file.webkitRelativePath?file.webkitRelativePath.split('/').slice(1).join('/'):file.name;if(excluded(rel))continue;total+=file.size;if(file.size>2*1024*1024||total>20*1024*1024||files.length>=2000)throw new Error('Limit: 2,000 files, 2 MB each, 20 MB total.');files.push({path:rel,contentBase64:await fileBase64(file)});}payload={name,files};}project=await api('/import/files',{method:'POST',body:payload});}$('#create-dialog').close();await refreshProjects();await openProject(project.id);}
  catch(error){$('#create-error').textContent=error.message;}finally{button.disabled=false;setMode(state.mode);}
});
$('#chat-form').addEventListener('submit',async event=>{event.preventDefault();if(!state.project||state.run)return;if(state.dirty){try{await saveFile();}catch(error){toast(error.message);return;}}try{const run=await projectAPI('runs',{method:'POST',body:{prompt:$('#prompt').value.trim(),model:$('#model').value}});$('#prompt').value='';state.run=run.id;state.project.busy=true;state.project=await projectAPI('');renderMessages();updateControls();pollRun(run.id,state.project.id);}catch(error){toast(error.message);}});
$('#stop-button').addEventListener('click',async()=>{try{await api('/runs/'+state.run+'/stop',{method:'POST',body:{}});toast('Stopping task…');}catch(error){toast(error.message);}});
$('#code-editor').addEventListener('input',()=>setDirty($('#code-editor').value!==state.original));
$('#save-file').addEventListener('click',()=>saveFile().catch(e=>toast(e.message)));
$('#delete-file').addEventListener('click',async()=>{if(!state.file||!confirm('Delete '+state.file+'? You can restore it from History.'))return;try{await projectAPI('file',{method:'DELETE',body:{path:state.file}});setDirty(false);await openProject(state.project.id,{force:true});}catch(error){toast(error.message);}});
$('#add-file').addEventListener('click',async()=>{if(!keepEdits())return;const name=prompt('New file path, such as src/app.js');if(!name)return;if(state.project.files.some(f=>f.path===name))return toast('That file already exists. Select it in the explorer.');try{await projectAPI('file',{method:'PUT',body:{path:name,content:''}});state.project.files=(await projectAPI('')).files;setDirty(false);await selectFile(name);}catch(error){toast(error.message);}});
$('#run-check').addEventListener('click',async()=>{if(state.dirty){try{await saveFile();}catch(error){toast(error.message);return;}}const button=$('#run-check');button.disabled=true;button.textContent='Running…';$('#check-output').textContent='Starting isolated check…';try{const r=await projectAPI('check',{method:'POST',body:{check:$('#check-select').value}});$('#check-output').textContent=r.status.toUpperCase()+'\n\n'+r.output;}catch(error){$('#check-output').textContent=error.message;}finally{button.textContent='Run check';updateControls();}});
$('#export-button').addEventListener('click',async()=>{try{if(state.dirty)await saveFile();const res=await fetch('/api/projects/'+state.project.id+'/export',{headers:{Authorization:'Bearer '+sessionStorage.getItem('code-god-token')}});if(!res.ok)throw new Error('Export failed.');const url=URL.createObjectURL(await res.blob()),a=node('a');a.href=url;a.download=state.project.name+'.zip';a.click();setTimeout(()=>URL.revokeObjectURL(url),10000);}catch(error){toast(error.message);}});
$('#pr-button').addEventListener('click',()=>{$('#pr-result').replaceChildren();$('#pr-error').textContent='';$('#pr-submit').hidden=false;$('#pr-dialog').showModal();});
$('#pr-form').addEventListener('submit',async event=>{event.preventDefault();const button=$('#pr-submit');button.disabled=true;$('#pr-error').textContent='';try{if(state.dirty)await saveFile();const result=await projectAPI('pull-request',{method:'POST',body:{title:$('#pr-title').value,body:$('#pr-body').value}});const a=node('a','Open your draft pull request ↗');a.href=result.url;a.target='_blank';a.rel='noreferrer';$('#pr-result').append(a);button.hidden=true;}catch(error){$('#pr-error').textContent=error.message;}finally{button.disabled=false;}});
$('#auth-form').addEventListener('submit',async event=>{event.preventDefault();sessionStorage.setItem('code-god-token',$('#auth-token').value.trim());try{await refreshProjects();$('#auth-dialog').close();$('#auth-token').value='';await refreshStatus();}catch(error){$('#auth-error').textContent=error.message;}});
$('#home-button').addEventListener('click',()=>{if(!keepEdits())return;clearTimeout(state.poll);state.project=null;state.run=null;setDirty(false);$('#dashboard').hidden=false;$('#workspace').hidden=true;$('#header-name').textContent='All projects';localStorage.removeItem('code-god-project');renderProjects();});
$$('[data-create]').forEach(b=>b.addEventListener('click',()=>showCreate(b.dataset.create)));$$('[data-mode]').forEach(b=>b.addEventListener('click',()=>setMode(b.dataset.mode)));$$('[data-tab]').forEach(b=>b.addEventListener('click',()=>loadTab(b.dataset.tab)));$$('.close-dialog').forEach(b=>b.addEventListener('click',()=>b.closest('dialog').close()));
$('#idea-card').addEventListener('click',()=>showCreate('new'));$('#setup-button').addEventListener('click',()=>$('#setup-dialog').showModal());$('#connection-status').addEventListener('click',()=>$('#setup-dialog').showModal());$('#refresh-status').addEventListener('click',refreshStatus);$('#refresh-preview').addEventListener('click',()=>loadTab('preview'));$('#model').addEventListener('change',updateControls);
for(const kind of ['zip','folder','files']){$('#choose-'+kind).addEventListener('click',()=>$('#'+kind+'-input').click());$('#'+kind+'-input').addEventListener('change',event=>{if(kind==='zip'){state.zip=event.target.files[0];state.uploads=[];}else{state.uploads=[...event.target.files];state.zip=null;}$('#upload-summary').textContent=state.zip?state.zip.name:`${state.uploads.length} files selected`;if(!$('#new-name').value)$('#new-name').value=state.zip?.name.replace(/\.zip$/i,'')||state.uploads[0]?.webkitRelativePath.split('/')[0]||'Imported project';});}
window.addEventListener('beforeunload',event=>{if(state.dirty){event.preventDefault();event.returnValue='';}});
document.addEventListener('keydown',event=>{if((event.ctrlKey||event.metaKey)&&event.key==='s'){event.preventDefault();if(state.file)saveFile().catch(e=>toast(e.message));}if((event.ctrlKey||event.metaKey)&&event.key==='Enter'&&document.activeElement===$('#prompt')){event.preventDefault();if(!$('#send-button').disabled)$('#chat-form').requestSubmit();}});
async function init(){try{await refreshProjects();const previous=localStorage.getItem('code-god-project');if(previous&&state.projects.some(p=>p.id===previous))await openProject(previous);await refreshStatus();}catch(error){if(!$('#auth-dialog').open)toast(error.message);}}
void init();
