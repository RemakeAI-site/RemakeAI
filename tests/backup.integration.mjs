import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { exportBackup, restoreBackup } from '../scripts/backup.mjs';

const [base,target,tmp] = process.argv.slice(2);
const get = async (host,path) => {
  const r = await fetch(host+'/api'+path);
  assert.equal(r.status,200,`GET ${path} ${r.status}`);
  return r.json();
};
const inspect = await get(base,'/system');
assert.equal(inspect.database.ok,true);
assert.equal(inspect.storage.ok,true);
assert.ok(inspect.usage.originals>0);
const path = resolve(tmp,'backup');
const count = await exportBackup(base,path);
assert.ok(count>0);
assert.equal(await restoreBackup(target,path),count);
const source = await get(base,'/stats');
const copy = await get(target,'/stats');
assert.deepEqual(copy,source);
const manifest = JSON.parse(await readFile(resolve(path,'manifest.json'),'utf8'));
for (const image of manifest.tables.media_assets) {
  const r = await fetch(target+'/api/media/'+image.id+'?download=1');
  assert.equal(r.status,200);
  assert.equal(createHash('sha256').update(Buffer.from(await r.arrayBuffer())).digest('hex'),image.sha256);
}
const copied = await get(target,'/backups');
assert.equal(copied[0].status,'restored');
const denied = await fetch(target+'/api/import',{method:'POST',headers:{'Content-Type':'application/json'},body:'{"confirm":true}'});
assert.equal(denied.status,409,'populated databases must not be overwritten');
const zip = await fetch(target+'/api/export');
if (zip.status===200) {
  const name = resolve(tmp,'browser.zip');
  await writeFile(name,Buffer.from(await zip.arrayBuffer()));
  const check = spawnSync('unzip',['-t',name],{encoding:'utf8'});
  if (!check.error) assert.equal(check.status,0,check.stdout+check.stderr);
} else assert.equal(zip.status,413);
console.log('Backup passed: D1/R2 data exported, restored on a fresh instance, SHA-256 matches every original.');
