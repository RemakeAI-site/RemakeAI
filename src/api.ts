import { QueryClient, useQuery } from '@tanstack/react-query';
import { sha256 } from '@noble/hashes/sha2.js';

export const studioClient = new QueryClient({defaultOptions:{queries:{staleTime:3000,retry:1,refetchOnWindowFocus:true}}});
export function invalidateStudio() { return studioClient.invalidateQueries(); }
export class ApiError extends Error {
  constructor(message:string, public status:number, public code?:string) { super(message); }
}
const apiPath = (path:string) => path.startsWith('/api/') ? path : '/api' + (path.startsWith('/') ? path : '/'+path);
export async function api<T=any>(path:string, options?:RequestInit):Promise<T> {
  const headers = new Headers(options?.headers);
  headers.set('Accept','application/json');
  if (typeof options?.body === 'string' && !headers.has('Content-Type')) headers.set('Content-Type','application/json');
  let response:Response;
  try { response = await fetch(apiPath(path),{...options,headers}); }
  catch (error) {
    if (options?.signal?.aborted) throw error;
    throw new ApiError('Связь со студией прервана. Проверьте интернет и повторите.',0);
  }
  if (!response.ok) {
    const error = await response.json().catch(()=>({})) as {error?:string;code?:string};
    throw new ApiError(error.error ?? 'Не удалось выполнить действие.',response.status,error.code);
  }
  const data = (response.status === 204 ? undefined : await response.json()) as T;
  if (options?.method && !['GET','HEAD'].includes(options.method)) void invalidateStudio();
  return data;
}
export function useStudio<T=any>(path:string,enabled=true,refetchInterval:number|false=5000) {
  return useQuery({queryKey:[path],queryFn:({signal})=>api<T>(path,{signal}),enabled,refetchInterval});
}
export const mediaUrl = (id: string | null | undefined, preview=false) => id ? `/api/media/${encodeURIComponent(id)}${preview?'?preview=1':''}` : '';
export function formatBytes(bytes:number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 Б';
  const units = ['Б','КиБ','МиБ','ГиБ','ТиБ'];
  const index = Math.min(units.length-1,Math.floor(Math.log(bytes)/Math.log(1024)));
  return new Intl.NumberFormat('ru',{maximumFractionDigits:index === 0 ? 0 : 1}).format(bytes/1024**index)+' '+units[index];
}
export async function copyText(text:string) {
  if (navigator.clipboard) {
    try { await navigator.clipboard.writeText(text); return; } catch {}
  }
  const node = document.createElement('textarea');
  node.value = text;
  node.style.position='fixed';
  node.style.opacity='0';
  document.body.appendChild(node);
  node.focus();
  node.select();
  node.setSelectionRange(0,text.length);
  try { if (!document.execCommand('copy')) throw new Error('Не удалось скопировать текст.'); }
  finally { node.remove(); }
}
type UploadOptions = { target_type:'category'|'publication'|'idea'|'logo';target_id?:string|null;replace_for?:string|null };
const hex = (arr:Uint8Array) => Array.from(arr,byte=>byte.toString(16).padStart(2,'0')).join('');
const uploadMetadata = async (file:File):Promise<{duration?:number}> => {
  if (!file.type.startsWith('video/') && !/\.(mov|mp4|webm)$/iu.test(file.name)) return {};
  const source = URL.createObjectURL(file);
  const player = document.createElement('video');
  player.preload = 'metadata';
  try {
    return await new Promise(resolve=>{
      const done = () => { clearTimeout(timer); resolve(Number.isFinite(player.duration) ? {duration:player.duration} : {}); };
      const timer = window.setTimeout(done,1500);
      player.onloadedmetadata=done;
      player.onerror=done;
      player.src=source;
    });
  } finally { player.removeAttribute('src'); URL.revokeObjectURL(source); }
};
async function makePreview(file:File) {
  const image = await createImageBitmap(file);
  try {
    const factor = Math.min(1,640/Math.max(image.width,image.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1,Math.round(image.width*factor));
    canvas.height = Math.max(1,Math.round(image.height*factor));
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(image,0,0,canvas.width,canvas.height);
    return await new Promise<Blob|null>(resolve=>canvas.toBlob(resolve,'image/webp',0.8));
  } finally { image.close(); }
}
const pause = (ms:number) => new Promise<void>(resolve=>setTimeout(resolve,ms));
async function retry<T>(action:()=>Promise<T>,signal?:AbortSignal):Promise<T> {
  for (let attempt=0;;attempt++) {
    try { return await action(); }
    catch (error) {
      if (signal?.aborted || attempt>=2 || !(error instanceof ApiError) || (error.status && error.status<500 && ![409,429].includes(error.status))) throw error;
      await pause(error.status===429 ? 61000 : 700*(attempt+1));
    }
  }
}
function sendPart(path:string, bytes:ArrayBuffer, digest:string, progress?: (loaded:number)=>void, signal?:AbortSignal) {
  return new Promise<void>((resolve,reject)=>{
    if (signal?.aborted) { reject(new DOMException('Загрузка отменена.','AbortError')); return; }
    const xhr = new XMLHttpRequest();
    xhr.open('PUT',apiPath(path));
    xhr.setRequestHeader('x-content-sha256',digest);
    xhr.upload.onprogress = event=>progress?.(event.loaded);
    const abort = () => xhr.abort();
    signal?.addEventListener('abort',abort,{once:true});
    xhr.onloadend = () => signal?.removeEventListener('abort',abort);
    xhr.onerror = () => reject(new ApiError('Не удалось передать часть файла.',0));
    xhr.onabort = () => reject(new DOMException('Загрузка отменена.','AbortError'));
    xhr.onload = () => {
      if (xhr.status>=200 && xhr.status<300) return resolve();
      let error = {};
      try { error = JSON.parse(xhr.responseText); } catch {}
      const wire = error as {error?:string;code?:string};
      reject(new ApiError(wire.error ?? 'Ошибка загрузки части файла.',xhr.status,wire.code));
    };
    xhr.send(bytes);
  });
}
export async function uploadOriginal(file:File, options:UploadOptions, progress?: (percentage:number)=>void, signal?:AbortSignal) {
  if (!file.size) throw new Error('Файл пуст.');
  const data = {...options,filename:file.name,size:file.size,mime_type:file.type,...await uploadMetadata(file)};
  const session = await api<{id:string;chunk_size:number}>('/uploads',{method:'POST',body:JSON.stringify(data),signal});
  const base = '/uploads/'+session.id;
  try {
    const hash = sha256.create();
    let part = 0;
    for (let offset=0;offset<file.size;offset+=session.chunk_size) {
      if (signal?.aborted) throw new DOMException('Загрузка отменена.','AbortError');
      const bytes = await file.slice(offset,offset+session.chunk_size).arrayBuffer();
      const view = new Uint8Array(bytes);
      hash.update(view);
      const partHash = hex(sha256(view));
      const path = base+'/parts/'+(++part);
      await retry(()=>sendPart(path,bytes,partHash,loaded=>progress?.(Math.min(99,Math.round((offset+loaded)/file.size*100))),signal),signal);
    }
    const asset = await retry(()=>api<{id:string;media_type:string}>(base+'/complete',{method:'POST',body:JSON.stringify({sha256:hex(hash.clone().digest())}),signal}),signal);
    progress?.(100);
    if (asset.media_type === 'image') {
      try {
        const preview = await makePreview(file);
        if (preview?.type === 'image/webp') await api('/media/'+asset.id+'/preview',{method:'PUT',body:preview});
      } catch { /* The verified original remains usable even if preview generation fails. */ }
    }
    return asset;
  } catch (error) {
    await api(base,{method:'DELETE'}).catch(()=>{});
    throw error;
  }
}
