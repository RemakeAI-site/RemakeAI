import { AwsClient } from 'aws4fetch';
import { fail, type Env } from './core';
import { R2Storage, type ObjectStorage } from './storage';

type Range = { offset: number; length: number };
type Part = { partNumber: number; etag: string };
const escapeXml = (value:string) => value.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');

class B2Storage implements ObjectStorage {
  private readonly client: AwsClient;
  private readonly base: string;

  constructor(endpoint:string, bucket:string, accessKeyId:string, secretAccessKey:string) {
    const match = /^s3\.([a-z0-9-]+)\.backblazeb2\.com$/.exec(endpoint);
    if (!match || !/^[a-z0-9-]{6,63}$/.test(bucket)) fail(503,'Некорректная конфигурация Backblaze B2.');
    this.base = 'https://'+endpoint+'/'+bucket;
    this.client = new AwsClient({accessKeyId,secretAccessKey,service:'s3',region:match[1],retries:0});
  }

  private async request(method:string,key:string,query:Record<string,string>={}, headers?:HeadersInit,body?:BodyInit, missing=false) {
    const url = new URL(this.base + (key ? '/'+key.split('/').map(encodeURIComponent).join('/') : ''));
    for (const [name,value] of Object.entries(query)) url.searchParams.set(name,value);
    const response = await this.client.fetch(url,{method,headers,body});
    if (missing && response.status===404) { await response.body?.cancel(); return null; }
    if (!response.ok) {
      const text = method==='HEAD' ? '' : await response.text();
      const code = /<Code>([A-Za-z0-9]+)<\/Code>/.exec(text)?.[1];
      throw new Error('B2 '+method+' '+response.status+(code?' '+code:''));
    }
    return response;
  }

  async check() { const r = await this.request('GET','',{'list-type':'2','max-keys':'1'}); await r?.body?.cancel(); }
  async inspect(key:string) {
    const r = await this.request('HEAD',key,{},undefined,undefined,true);
    return r ? {size:Number(r.headers.get('Content-Length'))} : null;
  }
  async read(key:string,range?:Range) {
    const headers = range ? {Range:`bytes=${range.offset}-${range.offset+range.length-1}`} : undefined;
    const r = await this.request('GET',key,{},headers,undefined,true);
    if (!r?.body) return null;
    const size = Number(r.headers.get('Content-Range')?.split('/').at(-1) ?? r.headers.get('Content-Length'));
    return {body:r.body as ReadableStream<Uint8Array>,size,etag:r.headers.get('ETag')??''};
  }
  async write(key:string,bytes:Uint8Array<ArrayBuffer>,mime:string,sha256?:string) {
    const headers = new Headers({'Content-Type':mime});
    if (sha256) headers.set('x-amz-content-sha256',sha256);
    const r = await this.request('PUT',key,{},headers,bytes);
    await r?.body?.cancel();
  }
  async remove(key:string) {
    // Delete the concrete version so expired files do not keep consuming space.
    const r = await this.request('HEAD',key,{},undefined,undefined,true);
    if (!r) return;
    const versionId = r.headers.get('x-amz-version-id');
    if (!versionId) throw new Error('B2 did not return an object version ID');
    await this.request('DELETE',key,{versionId},undefined,undefined,true);
  }
  async startMultipart(key:string,mime:string) {
    const r = await this.request('POST',key,{uploads:''},{'Content-Type':mime});
    const id = /<UploadId>([^<]+)<\/UploadId>/.exec(await r!.text())?.[1];
    if (!id) throw new Error('B2 did not return an upload ID');
    return id;
  }
  async putPart(key:string,uploadId:string,partNumber:number,bytes:Uint8Array<ArrayBuffer>) {
    const r = await this.request('PUT',key,{uploadId,partNumber:String(partNumber)},undefined,bytes);
    const etag = r?.headers.get('ETag');
    await r?.body?.cancel();
    if (!etag) throw new Error('B2 did not return a part ETag');
    return {etag,partNumber};
  }
  async finishMultipart(key:string,uploadId:string,parts:Part[]) {
    const xml = '<CompleteMultipartUpload>'+parts.map(p=>`<Part><PartNumber>${p.partNumber}</PartNumber><ETag>${escapeXml(p.etag)}</ETag></Part>`).join('')+'</CompleteMultipartUpload>';
    const r = await this.request('POST',key,{uploadId},{'Content-Type':'application/xml'},xml);
    if (!/<CompleteMultipartUploadResult[\s>]/.test(await r!.text())) throw new Error('B2 did not complete the upload');
  }
  async abortMultipart(key:string,uploadId:string) { await this.request('DELETE',key,{uploadId},undefined,undefined,true); }
}

export function objectStorage(env:Env):ObjectStorage {
  if (env.MEDIA) return new R2Storage(env.MEDIA);
  if (!env.B2_ENDPOINT || !env.B2_BUCKET || !env.B2_KEY_ID || !env.B2_APPLICATION_KEY) {
    fail(503,'Хранилище медиа ещё не подключено. Проверьте настройки студии.');
  }
  return new B2Storage(env.B2_ENDPOINT,env.B2_BUCKET,env.B2_KEY_ID,env.B2_APPLICATION_KEY);
}
