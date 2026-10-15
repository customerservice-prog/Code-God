import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
function walk(dir){for(const entry of fs.readdirSync(dir,{withFileTypes:true})){if(['.git','data','node_modules'].includes(entry.name))continue;const file=path.join(dir,entry.name);if(entry.isDirectory())walk(file);else if(/\.(mjs|js)$/.test(file))execFileSync(process.execPath,['--check',file],{stdio:'inherit'});}}
walk('.');console.log('All JavaScript syntax checks passed.');
