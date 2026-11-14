import { createHash } from 'node:crypto';
import { open, mkdir, readFile, writeFile, rename, stat, rm } from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable, Transform } from 'node:stream';
import { pathToFileURL } from 'node:url';

const safeKey = /^(?:originals|previews|media)\/[a-zA-Z0-9/_-]{1,180}(?:\.[a-zA-Z0-9]{1,8})?$/u;
function objectPath(root,key) {
  if (!safeKey.test(key)) throw new Error('Некорректный ключ объекта в резервной копии.');
  return resolve(root,'objects',key);
}
const sleep = ms=>new Promise(done=>setTimeout(done,ms));
async function request(base,path,options={}) {
  const headers = new Headers(options.headers);
  if (typeof options.body==='string') headers.set('Content-Type','application/json');
  for (let attempt=0;;attempt++) {
    let response;
    try { response = await fetch(base+'/api'+path,{...options,headers,signal:AbortSignal.timeout(180000)}); }
    catch (error) { if (attempt>=2) throw error; await sleep(1000*(attempt+1)); continue; }
    if (response.ok) return response;
    if (response.status===429 && attempt<3) {
      await response.body.cancel();
      await sleep(Math.max(1,Number(response.headers.get('retry-after'))||60)*1000);
      continue;
    }
    const error = await response.json().catch(()=>({}));
    throw new Error(error.error ?? `Запрос завершился ошибкой ${response.status}`);
  }
}
const get = async (base,path,options) => (await request(base,path,options)).json();
const listObjects = manifest => manifest.tables.media_assets.flatMap(m=>[
  [m.storage_key,m.file_size,m.sha256],...(m.preview_storage_key?[[m.preview_storage_key,m.preview_size,null]]:[])
]);
const checksum = async filename => {
  const hash = createHash('sha256');
  for await (const bytes of createReadStream(filename)) hash.update(bytes);
  return hash.digest('hex');
};
export async function exportBackup(address,root) {
  const base = address.replace(/\/$/u,'');
  const {format,tables,revision} = await get(base,'/export/info');
  const target = resolve(root);
  await mkdir(target,{recursive:true});
  await rm(resolve(target,'manifest.json'),{force:true});
  const manifest = {format,created_at:new Date().toISOString(),tables:{}};
  for (const name of tables) {
    const rows = [];
    for (let cursor=0;;) {
      const page = await get(base,`/export/table?name=${encodeURIComponent(name)}&cursor=${cursor}`);
      rows.push(...page.items);
      if (page.next===null) break;
      cursor=Number(page.next);
    }
    manifest.tables[name]=rows;
  }
  const objects = listObjects(manifest);
  for (const [key,size,expected] of objects) {
    const filename = objectPath(target,key);
    const existing = await stat(filename).catch(()=>null);
    if (existing?.size===size && expected && await checksum(filename)===expected) continue;
    await mkdir(resolve(filename,'..'),{recursive:true});
    const response = await request(base,'/export/object?key='+encodeURIComponent(key));
    const hash = createHash('sha256');
    let bytes=0;
    const meter = new Transform({transform(chunk,_encoding,callback){bytes+=chunk.length;hash.update(chunk);callback(null,chunk);}});
    await pipeline(Readable.fromWeb(response.body),meter,createWriteStream(filename+'.partial'));
    const actual = hash.digest('hex');
    if (size!==bytes || (expected && expected!==actual)) throw new Error(`Повреждён оригинал ${key}. Повторите экспорт.`);
    await rename(filename+'.partial',filename);
  }
  const end = await get(base,'/export/info');
  if (JSON.stringify(end.revision)!==JSON.stringify(revision)) throw new Error('Во время экспорта студия изменилась. Повторите экспорт при закрытых редакторах.');
  await writeFile(resolve(target,'manifest.json.partial'),JSON.stringify(manifest,null,2));
  await rename(resolve(target,'manifest.json.partial'),resolve(target,'manifest.json'));
  await get(base,'/export/done',{method:'POST',body:JSON.stringify({objects:objects.length})});
  return objects.length;
}
export async function restoreBackup(address,root) {
  const base = address.replace(/\/$/u,'');
  const target = resolve(root);
  const manifest = JSON.parse(await readFile(resolve(target,'manifest.json'),'utf8'));
  if (manifest.format!==1 || !Array.isArray(manifest.tables?.media_assets)) throw new Error('Несовместимый манифест.');
  const objects = listObjects(manifest);
  for (const [key,size,expected] of objects) {
    const filename = objectPath(target,key);
    if ((await stat(filename)).size!==size || (expected && await checksum(filename)!==expected)) throw new Error(`Файл ${key} отсутствует или повреждён.`);
  }
  const {token,part_size} = await get(base,'/import',{method:'POST',body:JSON.stringify({confirm:true})});
  const path = '/import/'+token;
  try {
    for (const [table,rows] of Object.entries(manifest.tables)) {
      for (let offset=0;offset<rows.length;offset+=10) await get(base,path+'/rows',{method:'POST',body:JSON.stringify({table,items:rows.slice(offset,offset+10)})});
    }
    for (const [key,size] of objects) {
      const file = await open(objectPath(target,key));
      try {
        for (let offset=0;offset<size;offset+=part_size) {
          const bytes = Buffer.alloc(Math.min(part_size,size-offset));
          const {bytesRead} = await file.read(bytes,0,bytes.length,offset);
          if (bytesRead!==bytes.length) throw new Error('Объект изменился во время восстановления.');
          await request(base,`${path}/object?key=${encodeURIComponent(key)}&part=${offset/part_size+1}`,{method:'PUT',body:bytes});
        }
      } finally { await file.close(); }
    }
    await get(base,path+'/complete',{method:'POST',body:'{}'});
    return objects.length;
  } catch(error) {
    try { while ((await get(base,path,{method:'DELETE'})).remaining) { /* Continue bounded cleanup. */ } }
    catch { console.error(`Очистка сессии ${token} прервана. Повторите DELETE ${base}/api${path} до remaining=false.`); }
    throw error;
  }
}
if (process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
  const [action,address,root] = process.argv.slice(2);
  if (!['export','restore'].includes(action) || !/^https?:\/\//u.test(address??'') || !root) {
    console.error('npm run backup -- export|restore http://127.0.0.1:8787 ./backups/studio');
    process.exitCode=1;
  } else {
    try { console.log('Готово, объектов:',await (action==='export'?exportBackup:restoreBackup)(address,root)); }
    catch (error) { console.error(error.message); process.exitCode=1; }
  }
}
