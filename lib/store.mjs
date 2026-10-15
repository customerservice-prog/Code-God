import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs/promises';
import { fileMap, zip, unzip, restoreFiles, changes } from './files.mjs';

export async function createStore(dataDir) {
  await fs.mkdir(path.join(dataDir,'workspaces'),{recursive:true});
  const db=new DatabaseSync(path.join(dataDir,'code-god.sqlite'));
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
    CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY,name TEXT NOT NULL,source TEXT NOT NULL,created TEXT NOT NULL,updated TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS snapshots(id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id),label TEXT NOT NULL,created TEXT NOT NULL,files BLOB NOT NULL,baseline INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS messages(id INTEGER PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id),role TEXT NOT NULL,content TEXT NOT NULL,created TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id),status TEXT NOT NULL,model TEXT NOT NULL,created TEXT NOT NULL,events TEXT NOT NULL,error TEXT);
  `);
  db.prepare("UPDATE runs SET status='interrupted',error='Server restarted. Changes are saved; start another request to continue.' WHERE status='running'").run();
  const busy=new Set();
  const root=id=>{ get(id); return path.join(dataDir,'workspaces',id); };
  const parseProject=row=>row?{...row,source:JSON.parse(row.source)}:null;
  function get(id) { if(!/^[a-f0-9-]{36}$/.test(id||'')) throw new Error('Project not found.'); const p=parseProject(db.prepare('SELECT * FROM projects WHERE id=?').get(id)); if(!p) throw new Error('Project not found.'); return p; }
  function touch(id) { db.prepare('UPDATE projects SET updated=? WHERE id=?').run(new Date().toISOString(),id); }
  function unlocked(id) { get(id); if(busy.has(id)) throw new Error('This project is busy. Stop its running task before editing.'); }
  async function snapshot(id,label,baseline=false) {
    const sid=randomUUID();
    db.prepare('INSERT INTO snapshots VALUES(?,?,?,?,?,?)').run(sid,id,label.slice(0,160),new Date().toISOString(),zip(await fileMap(root(id))),Number(baseline));
    db.prepare('DELETE FROM snapshots WHERE project_id=? AND baseline=0 AND id NOT IN (SELECT id FROM snapshots WHERE project_id=? AND baseline=0 ORDER BY created DESC LIMIT 30)').run(id,id);
    return sid;
  }
  function snapshotMap(id,sid) { const row=db.prepare('SELECT files FROM snapshots WHERE project_id=? AND id=?').get(id,sid); if(!row) throw new Error('Version not found.'); return unzip(row.files); }
  async function create(name,source,files) {
    if(typeof name!=='string' || !name.trim() || name.length>80) throw new Error('Project name must be 1–80 characters.');
    const id=randomUUID(), now=new Date().toISOString();
    db.prepare('INSERT INTO projects VALUES(?,?,?,?,?)').run(id,name.trim(),JSON.stringify(source),now,now);
    try { await restoreFiles(root(id),files); await snapshot(id,'Original project',true); return get(id); }
    catch(error) { await fs.rm(root(id),{recursive:true,force:true}); db.prepare('DELETE FROM snapshots WHERE project_id=?').run(id); db.prepare('DELETE FROM projects WHERE id=?').run(id); throw error; }
  }
  const message=(id,role,content)=>db.prepare('INSERT INTO messages(project_id,role,content,created) VALUES(?,?,?,?)').run(id,role,content,new Date().toISOString());
  return {db,busy,root,get,touch,unlocked,snapshot,snapshotMap,create,message,
    list:()=>db.prepare('SELECT * FROM projects ORDER BY updated DESC').all().map(parseProject),
    messages:id=>db.prepare('SELECT role,content,created FROM messages WHERE project_id=? ORDER BY id').all(id),
    history:id=>db.prepare('SELECT id,label,created,baseline FROM snapshots WHERE project_id=? ORDER BY created DESC').all(id),
    async restore(id,sid) { unlocked(id); busy.add(id); try { const files=snapshotMap(id,sid); await snapshot(id,'Before restoring a version'); await restoreFiles(root(id),files); touch(id); } finally { busy.delete(id); } },
    async diff(id,sid) { const base=sid||db.prepare('SELECT id FROM snapshots WHERE project_id=? AND baseline=1').get(id)?.id; return changes(snapshotMap(id,base),await fileMap(root(id))); }
  };
}
