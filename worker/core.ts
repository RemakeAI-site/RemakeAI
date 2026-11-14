export interface Env {
  DB: D1Database;
  MEDIA?: R2Bucket;
  B2_ENDPOINT?: string;
  B2_BUCKET?: string;
  B2_KEY_ID?: string;
  B2_APPLICATION_KEY?: string;
  ASSETS?: Fetcher;
  MAX_STORAGE_BYTES?: string;
  BACKUP_IMPORT_ENABLED?: string;
  RATE_LIMIT?: RateLimit;
  READ_RATE_LIMIT?: RateLimit;
}
export interface Context {
  req: Request;
  url: URL;
  env: Env;
  db: D1Database;
  ctx: ExecutionContext;
}
export class HttpError extends Error {
  constructor(public status: number, message: string, public code?: string) { super(message); }
}
export function json(value: unknown, status = 200, headers?: HeadersInit) {
  const response = Response.json(value, { status, headers });
  response.headers.set('Cache-Control', 'no-store');
  return response;
}
export function fail(status: number, message: string, code?: string): never {
  throw new HttpError(status, message, code);
}
export async function body(c: Context, maxBytes = 262144): Promise<any> {
  if (!c.req.body) return {};
  if (Number(c.req.headers.get('content-length') ?? 0) > maxBytes) fail(413, 'Слишком большой запрос.');
  const buffer = new Uint8Array(maxBytes);
  const reader = c.req.body.getReader();
  let size = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      if (size + chunk.value.byteLength > maxBytes) {
        await reader.cancel();
        fail(413, 'Слишком большой запрос.');
      }
      buffer.set(chunk.value, size);
      size += chunk.value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  try {
    const result: unknown = JSON.parse(new TextDecoder().decode(buffer.subarray(0, size)));
    if (!result || typeof result !== 'object' || Array.isArray(result)) fail(400, 'Ожидается объект JSON.');
    return result;
  } catch {
    fail(400, 'Не удалось прочитать данные JSON.');
  }
}
export const now = () => new Date().toISOString();
export const id = () => crypto.randomUUID();
export const activity = (c: Context, action: string, kind?: string, entityId?: string) => c.db
  .prepare('INSERT INTO activity_log(id,action,entity_type,entity_id,created_at) VALUES(?,?,?,?,?)')
  .bind(id(),action,kind ?? null,entityId ?? null,now());
export const VERSION = '1.0.0';
