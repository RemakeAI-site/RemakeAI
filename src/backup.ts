import { api } from './api';

const safeKey = /^(?:originals|previews|media)\/[a-zA-Z0-9/_-]{1,180}(?:\.[a-zA-Z0-9]{1,8})?$/u;
const LIMIT = 64 * 1024 * 1024;
type WireRow = Record<string, string|number|null>;
type Manifest = {format:number;tables:Record<string,WireRow[]>};
type ZipEntry = {offset:number;size:number};
async function unzipStored(file:File) {
  if (file.size>LIMIT || file.size<22) throw new Error('Размер ZIP должен быть до 64 МиБ.');
  const tailStart = Math.max(0,file.size-65557);
  const tail = new DataView(await file.slice(tailStart).arrayBuffer());
  let marker = tail.byteLength-22;
  while (marker>=0 && (tail.getUint32(marker,true)!==0x06054b50 || marker+22+tail.getUint16(marker+20,true)!==tail.byteLength)) marker--;
  if (marker<0) throw new Error('В архиве отсутствует каталог ZIP.');
  const count = tail.getUint16(marker+10,true);
  const indexSize = tail.getUint32(marker+12,true);
  const indexOffset = tail.getUint32(marker+16,true);
  if (count>1000 || indexSize>1024*1024 || indexOffset+indexSize>tailStart+marker) throw new Error('Некорректный каталог ZIP.');
  const index = new DataView(await file.slice(indexOffset,indexOffset+indexSize).arrayBuffer());
  const decoder = new TextDecoder();
  const entries = new Map<string,ZipEntry>();
  let position = 0;
  for (let i=0;i<count;i++) {
    if (position+46>index.byteLength || index.getUint32(position,true)!==0x02014b50) throw new Error('Запись каталога ZIP повреждена.');
    if (index.getUint16(position+10,true)!==0 || index.getUint16(position+8,true)&1) throw new Error('Используйте оригинальный ZIP, скачанный из студии.');
    const size = index.getUint32(position+24,true);
    const length = index.getUint16(position+28,true);
    const extra = index.getUint16(position+30,true);
    const comment = index.getUint16(position+32,true);
    const local = index.getUint32(position+42,true);
    if (local+30>indexOffset || position+46+length+extra+comment>index.byteLength) throw new Error('Границы файла ZIP повреждены.');
    const name = decoder.decode(new Uint8Array(index.buffer,position+46,length));
    position += 46+length+extra+comment;
    const header = new DataView(await file.slice(local,local+30).arrayBuffer());
    if (header.getUint32(0,true)!==0x04034b50) throw new Error('Заголовок объекта ZIP повреждён.');
    const offset = local+30+header.getUint16(26,true)+header.getUint16(28,true);
    if (offset+size>indexOffset || entries.has(name)) throw new Error('Записи ZIP пересекаются с каталогом или повторяются.');
    entries.set(name,{offset,size});
  }
  return entries;
}
export async function restoreZip(file:File, progress?: (fraction:number)=>void) {
  const entries = await unzipStored(file);
  const manifestFile = entries.get('manifest.json');
  if (!manifestFile || manifestFile.size>16*1024*1024) throw new Error('Манифест резервной копии не найден или слишком большой.');
  let manifest:Manifest;
  try { manifest = JSON.parse(await file.slice(manifestFile.offset,manifestFile.offset+manifestFile.size).text()); }
  catch { throw new Error('Манифест резервной копии повреждён.'); }
  if (manifest.format!==1 || !manifest.tables || !Array.isArray(manifest.tables.media_assets)) throw new Error('Формат резервной копии не поддерживается.');
  const objectMap = new Map<string,number>();
  for (const item of manifest.tables.media_assets) {
    objectMap.set(String(item.storage_key),Number(item.file_size));
    if (item.preview_storage_key) objectMap.set(String(item.preview_storage_key),Number(item.preview_size));
  }
  for (const [key,size] of objectMap) {
    if (!safeKey.test(key) || entries.get('objects/'+key)?.size!==size) throw new Error('В ZIP отсутствует объект из манифеста.');
  }
  const {token,part_size} = await api<{token:string;part_size:number}>('/import',{method:'POST',body:JSON.stringify({confirm:true})});
  const path = '/import/'+token;
  try {
    for (const [table,rows] of Object.entries(manifest.tables)) {
      if (!Array.isArray(rows)) throw new Error('Некорректная таблица в копии.');
      for (let offset=0;offset<rows.length;offset+=10) await api(path+'/rows',{method:'POST',body:JSON.stringify({table,items:rows.slice(offset,offset+10)})});
    }
    let done = 0;
    const total = Array.from(objectMap.values()).reduce((sum,size)=>sum+size,0);
    for (const [key,size] of objectMap) {
      const entry = entries.get('objects/'+key)!;
      for (let offset=0;offset<size;offset+=part_size) {
        const chunk = file.slice(entry.offset+offset,entry.offset+Math.min(size,offset+part_size));
        await api(path+'/object?key='+encodeURIComponent(key)+'&part='+(offset/part_size+1),{method:'PUT',body:chunk});
        done += chunk.size;
        progress?.(total ? Math.min(0.99,done/total) : 0.99);
      }
    }
    await api(path+'/complete',{method:'POST',body:'{}'});
    progress?.(1);
  } catch (error) {
    try {
      while ((await api<{remaining:boolean}>(path,{method:'DELETE'})).remaining) { /* Continue bounded cleanup. */ }
    } catch {}
    throw error;
  }
}
