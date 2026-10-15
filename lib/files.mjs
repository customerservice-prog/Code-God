import fs from 'node:fs/promises';
import path from 'node:path';
import { inflateRawSync, deflateRawSync } from 'node:zlib';

export const LIMITS = { files: 2000, file: 2 * 1024 * 1024, total: 20 * 1024 * 1024, text: 256 * 1024 };
const skipDirs = new Set(['.git', 'node_modules', '.next', '__pycache__', '.venv', 'venv', '.cache', 'coverage']);
export function ignored(name) {
  const parts = name.replaceAll('\\', '/').split('/');
  return parts.some(p => skipDirs.has(p.toLowerCase()) || /^\.env(?:\.|$)/i.test(p) || /^\.npmrc$|^\.pypirc$|^id_rsa$|^id_ed25519$|^credentials(?:\.|$)|\.(?:pem|key)$/i.test(p));
}
export function safePath(name) {
  if (typeof name !== 'string' || !name || name.length > 240 || /[\x00-\x1f\\:<>"|?*]/.test(name) || name.startsWith('/') || name.split('/').some(p => !p || p === '.' || p === '..' || /[. ]$/.test(p) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p)) || ignored(name)) throw new Error('That path is outside the editable project or contains a protected file.');
  return name;
}
export async function resolveFile(root, name) {
  safePath(name);
  let current = root;
  for (const part of name.split('/')) {
    current = path.join(current, part);
    try { if ((await fs.lstat(current)).isSymbolicLink()) throw new Error('Symbolic links are not supported.'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return current;
}
export async function scan(root) {
  const entries = [];
  let total = 0;
  async function walk(dir, prefix = '') {
    for (const item of (await fs.readdir(dir, { withFileTypes: true })).sort((a,b) => a.name.localeCompare(b.name))) {
      const name = prefix + item.name;
      if (ignored(name)) continue;
      safePath(name);
      if (item.isSymbolicLink()) throw new Error('Remove symbolic links before importing this project.');
      if (item.isDirectory()) await walk(path.join(dir,item.name), name + '/');
      else if (item.isFile()) {
        const info = await fs.stat(path.join(dir,item.name));
        total += info.size;
        if (info.size > LIMITS.file || total > LIMITS.total || entries.length >= LIMITS.files) throw new Error('Project limit: 2,000 files, 2 MB per file, 20 MB total (dependencies and Git history excluded).');
        entries.push({ path: name, size: info.size });
      }
    }
  }
  await walk(root);
  return entries;
}
export async function readText(root, name) {
  const location = await resolveFile(root, name);
  const info = await fs.stat(location);
  if (info.size > LIMITS.text) throw new Error('Text editor limit is 256 KB per file.');
  const bytes = await fs.readFile(location);
  if (bytes.includes(0)) throw new Error('Binary file; download the project to open this file.');
  return bytes.toString('utf8');
}
export async function writeText(root, name, text) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > LIMITS.text) throw new Error('Text file limit is 256 KB.');
  const target = await resolveFile(root, name);
  const entries = await scan(root);
  const previous = entries.find(f => f.path === name);
  if (!previous && entries.length >= LIMITS.files) throw new Error('Too many project files.');
  if (entries.reduce((sum,f) => sum + f.size,0) - (previous?.size || 0) + Buffer.byteLength(text) > LIMITS.total) throw new Error('Project size limit reached.');
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target,text);
}
export async function fileMap(root) {
  const out = new Map();
  for (const item of await scan(root)) out.set(item.path, await fs.readFile(await resolveFile(root,item.path)));
  return out;
}

const crcTable = Array.from({length:256},(_,n) => { for(let k=0;k<8;k++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1; return n >>> 0; });
function crc32(bytes) { let crc = 0xffffffff; for (const byte of bytes) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8); return (crc ^ 0xffffffff) >>> 0; }
export function zip(files) {
  const chunks = [], central = []; let offset = 0;
  for (const [name,data] of files) {
    safePath(name);
    const filename = Buffer.from(name), bytes = Buffer.from(data), compressed = deflateRawSync(bytes), crc = crc32(bytes);
    const h = Buffer.alloc(30); h.writeUInt32LE(0x04034b50); h.writeUInt16LE(20,4); h.writeUInt16LE(0x800,6); h.writeUInt16LE(8,8); h.writeUInt32LE(crc,14); h.writeUInt32LE(compressed.length,18); h.writeUInt32LE(bytes.length,22); h.writeUInt16LE(filename.length,26);
    const c = Buffer.alloc(46); c.writeUInt32LE(0x02014b50); c.writeUInt16LE(20,4); c.writeUInt16LE(20,6); c.writeUInt16LE(0x800,8); c.writeUInt16LE(8,10); c.writeUInt32LE(crc,16); c.writeUInt32LE(compressed.length,20); c.writeUInt32LE(bytes.length,24); c.writeUInt16LE(filename.length,28); c.writeUInt32LE(offset,42);
    chunks.push(h,filename,compressed); central.push(c,filename); offset += h.length + filename.length + compressed.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(files.size,8); end.writeUInt16LE(files.size,10); end.writeUInt32LE(directory.length,12); end.writeUInt32LE(offset,16);
  return Buffer.concat([...chunks,directory,end]);
}
export function unzip(input, stripRoot = false) {
  const bytes = Buffer.from(input);
  if (bytes.length > LIMITS.total + 1024 * 1024) throw new Error('ZIP exceeds the 20 MB import limit.');
  let end = -1;
  for(let i=bytes.length-22;i>=Math.max(0,bytes.length-65557);i--) if (bytes.readUInt32LE(i)===0x06054b50 && i + 22 + bytes.readUInt16LE(i+20) === bytes.length) { end=i; break; }
  if (end < 0) throw new Error('Not a supported ZIP archive.');
  const count=bytes.readUInt16LE(end+10), cdStart=bytes.readUInt32LE(end+16), cdSize=bytes.readUInt32LE(end+12);
  if (count > LIMITS.files || bytes.readUInt16LE(end+4) || bytes.readUInt16LE(end+6) || count !== bytes.readUInt16LE(end+8) || cdStart + cdSize !== end) throw new Error('Unsupported ZIP layout or too many files.');
  const entries = []; let pointer = cdStart, total = 0;
  for(let i=0;i<count;i++) {
    if(pointer+46>end || bytes.readUInt32LE(pointer)!==0x02014b50) throw new Error('Invalid ZIP directory.');
    const flags=bytes.readUInt16LE(pointer+8), method=bytes.readUInt16LE(pointer+10), crc=bytes.readUInt32LE(pointer+16), compressed=bytes.readUInt32LE(pointer+20), size=bytes.readUInt32LE(pointer+24), nameLen=bytes.readUInt16LE(pointer+28), extra=bytes.readUInt16LE(pointer+30), comment=bytes.readUInt16LE(pointer+32), attrs=bytes.readUInt32LE(pointer+38), at=bytes.readUInt32LE(pointer+42);
    const next=pointer+46+nameLen+extra+comment;
    if(next>end || (flags&1) || ![0,8].includes(method) || (attrs>>>16 & 0xf000)===0xa000) throw new Error('Encrypted, linked, or unsupported ZIP entry.');
    let name=bytes.subarray(pointer+46,pointer+46+nameLen).toString('utf8'); pointer=next;
    if(name.endsWith('/')) { if(!ignored(name))safePath(name.slice(0,-1)); continue; }
    // Validate before filtering so traversal cannot hide inside an ignored directory.
    if(!name || /[\x00-\x1f\\:]/.test(name) || name.startsWith('/') || name.split('/').some(p=>!p || p==='.' || p==='..')) throw new Error('Unsafe archive path.');
    if(ignored(name)) continue;
    total += size;
    if(size>LIMITS.file || total>LIMITS.total || at+30>cdStart || bytes.readUInt32LE(at)!==0x04034b50) throw new Error('Invalid entry or oversized ZIP expansion.');
    const localNameLength=bytes.readUInt16LE(at+26), localExtraLength=bytes.readUInt16LE(at+28), start=at+30+localNameLength+localExtraLength;
    if(start+compressed>cdStart || bytes.subarray(at+30,at+30+localNameLength).toString('utf8')!==name || bytes.readUInt16LE(at+8)!==method) throw new Error('Invalid ZIP entry boundary.');
    const data = method===8 ? inflateRawSync(bytes.subarray(start,start+compressed), {maxOutputLength:Math.max(1,Math.min(size,LIMITS.file))}) : bytes.subarray(start,start+compressed);
    if(data.length!==size || crc32(data)!==crc) throw new Error('ZIP checksum mismatch.');
    entries.push([name, data]);
  }
  if(pointer!==end) throw new Error('Invalid ZIP central directory.');
  const root=entries[0]?.[0].split('/')[0];
  if(stripRoot && root && entries.every(([n])=>n.startsWith(root+'/'))) for(const entry of entries) entry[0]=entry[0].slice(root.length+1);
  const result = new Map();
  for(const [name,data] of entries) { safePath(name); if(result.has(name)) throw new Error('Duplicate archive path.'); result.set(name,data); }
  return result;
}
export async function restoreFiles(root, files) {
  // Only app-owned workspace directories reach here. Imported symlinks are rejected.
  await fs.rm(root,{recursive:true,force:true}); await fs.mkdir(root,{recursive:true});
  for(const [name,bytes] of files) { const target=await resolveFile(root,name); await fs.mkdir(path.dirname(target),{recursive:true}); await fs.writeFile(target,bytes); }
}
export function changes(before, after) {
  const result=[];
  for(const name of [...new Set([...before.keys(),...after.keys()])].sort()) {
    const a=before.get(name), b=after.get(name);
    if(a && b && a.equals(b)) continue;
    const binary=(a?.includes(0) || b?.includes(0) || (a?.length||0)>LIMITS.text || (b?.length||0)>LIMITS.text);
    result.push({path:name,type:!a?'added':!b?'deleted':'modified',binary:Boolean(binary),before:binary?'':a?.toString('utf8')||'',after:binary?'':b?.toString('utf8')||''});
  }
  return result;
}
