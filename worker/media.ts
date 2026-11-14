import { z } from 'zod';
import { activity, body, fail, id, json, now, type Context } from './core';
import {
  digestStream, disposition, formatForName, hex, inspectDimensions, inspectFormat, MiB, parseRange,
  PART_SIZE, R2Storage, safeFilename, streamZip, ZIP_FILE_LIMIT, ZIP_SIZE_LIMIT,
} from './storage';

const DEFAULT_STORAGE_LIMIT = 10 * 1024 * MiB;
const MAX_IMAGE_SIZE = 100 * MiB;
const MAX_VIDEO_SIZE = 4096 * MiB;
const MAX_PREVIEW_SIZE = 512 * 1024;
const ONE_DAY = 24 * 60 * 60 * 1000;
const MAX_LEASE_MS = 10 * 60 * 1000;
const SEAL_LEASE_MS = 30 * 60 * 1000;
const targets = z.enum(['publication', 'idea', 'category', 'logo']);
const uuid = z.string().uuid();
const shaSchema = z.string().regex(/^[a-f0-9]{64}$/i);
const metadataSchema = z.object({
  target_type: targets,
  target_id: z.string().max(100).optional().nullish(),
  filename: z.string().trim().min(1).max(300),
  size: z.number().int().positive().max(MAX_VIDEO_SIZE),
  mime_type: z.string().max(100).optional(),
  width: z.number().int().positive().max(100000).nullish(),
  height: z.number().int().positive().max(100000).nullish(),
  duration: z.number().finite().nonnegative().max(604800).nullish(),
  replace_for: uuid.nullish(),
});

type Target = z.infer<typeof targets>;
type ContentTarget = 'publication' | 'idea';
type CoverTarget = 'category' | 'logo';
type Session = {
  id: string; storage_key: string; target_type: Target; target_id: string; replace_for: string | null;
  original_filename: string; mime_type: string; media_type: 'image' | 'video'; format: string;
  file_size: number; width: number | null; height: number | null; duration: number | null; chunk_size: number;
  upload_id: string | null; status: 'creating' | 'uploading' | 'sealing' | 'done' | 'canceling';
  lease: string | null; lease_until: string | null; updated_at: string;
};
type UploadPart = { part_number: number; etag: string | null; sha256: string | null; lease: string | null };
type Asset = {
  id: string; storage_key: string; original_filename: string; mime_type: string; format: string;
  file_size: number; sha256: string; media_type: 'image' | 'video'; width: number | null;
  height: number | null; duration: number | null; preview_storage_key: string | null; preview_size: number;
  created_at: string; deleted_at: string | null;
};
type Attachment = { id: string; media_id: string; role: string; sort_order: number };

const ownerTables = { publication: 'publications', idea: 'ideas', category: 'categories' } as const;
const attachmentTables = { publication: 'publication_media', idea: 'idea_media' } as const;

function parses<T>(schema: z.ZodType<T>, value: unknown) {
  const result = schema.safeParse(value);
  if (!result.success) fail(400, 'Проверьте параметры файла или ссылки.', 'invalid_media_parameters');
  return result.data;
}

function changed(result: D1Result) { return (result.meta.changes ?? 0) > 0; }
const isContent = (type: Target): type is ContentTarget => type === 'publication' || type === 'idea';
const ownerColumn = (type: ContentTarget) => `${type}_id`;
const store = (c: Context) => new R2Storage(c.env.MEDIA);
const leaseAfter = (duration = MAX_LEASE_MS) => new Date(Date.now() + duration).toISOString();

function statement(c: Context, sql: string, values: unknown[] = []) {
  return c.db.prepare(sql).bind(...values);
}

function operation(c: Context, action: string, status: string, bytes: number, detail: string, guard?: { sql: string; args: unknown[] }) {
  return statement(c, `INSERT INTO storage_operations(id,action,status,bytes,detail,created_at)
    SELECT ?,?,?,?,?,?${guard ? ` WHERE ${guard.sql}` : ''}`, [id(), action, status, bytes, detail, now(), ...(guard?.args ?? [])]);
}

async function getOwner(c: Context, type: Target, ownerId: string) {
  if (type === 'logo') return;
  if (ownerId.length > 100) fail(400, 'Некорректный идентификатор.');
  const owner = await statement(c, `SELECT id FROM ${ownerTables[type]} WHERE id=? AND deleted_at IS NULL`, [ownerId]).first();
  if (!owner) fail(404, 'Материал, к которому относится файл, отсутствует.');
}

async function getAsset(c: Context, mediaId: string) {
  const asset = await statement(c, 'SELECT * FROM media_assets WHERE id=? AND deleted_at IS NULL', [mediaId]).first<Asset>();
  if (!asset) fail(404, 'Файл не найден.', 'media_not_found');
  return asset;
}

async function getSession(c: Context, sessionId: string) {
  const session = await statement(c, 'SELECT * FROM upload_sessions WHERE id=?', [sessionId]).first<Session>();
  if (!session) fail(404, 'Загрузка не найдена. Выберите файл заново.', 'upload_not_found');
  return session;
}

function quota(c: Context) {
  const maximum = Number(c.env.MAX_STORAGE_BYTES ?? DEFAULT_STORAGE_LIMIT);
  return Number.isSafeInteger(maximum) && maximum > 0 ? maximum : DEFAULT_STORAGE_LIMIT;
}

const quotaSql = `(
  COALESCE((SELECT SUM(file_size+preview_size) FROM media_assets),0) +
  COALESCE((SELECT SUM(file_size) FROM upload_sessions WHERE status!='done'),0)
  + COALESCE((SELECT SUM(size) FROM preview_uploads),0)
  + ? <= MIN(?,COALESCE(CAST((SELECT json_extract(value,'$.storage_limit') FROM app_settings WHERE key='studio') AS INTEGER),?))
)`;

async function begin(c: Context) {
  const data = parses(metadataSchema, await body(c));
  const filename = safeFilename(data.filename);
  const format = formatForName(filename);
  if (!format) fail(415, 'Этот формат файлов не поддерживается.', 'unsupported_media');
  if (data.size > (format.kind === 'image' ? MAX_IMAGE_SIZE : MAX_VIDEO_SIZE)) {
    fail(413, format.kind === 'image' ? 'Лимит одной фотографии составляет 100 МиБ.' : 'Лимит одного видео составляет 4 ГиБ.', 'file_too_large');
  }
  if (format.kind !== 'image' && !isContent(data.target_type)) fail(415, 'Для обложки требуется изображение.');
  const ownerId = data.target_type === 'logo' ? 'studio' : data.target_id;
  if (!ownerId) fail(400, 'Укажите, к какому материалу относится файл.');
  await getOwner(c, data.target_type, ownerId);
  if (data.replace_for && isContent(data.target_type)) {
    const type = data.target_type;
    const previous = await statement(c, `SELECT id FROM ${attachmentTables[type]} WHERE id=? AND ${ownerColumn(type)}=? AND deleted_at IS NULL`, [data.replace_for, ownerId]).first();
    if (!previous) fail(409, 'Файл для замены больше не прикреплён.');
  }
  const sessionId = id();
  const storageKey = `originals/${sessionId}`;
  const at = now();
  const limit = quota(c);
  const multipart = data.size > PART_SIZE;
  const result = await statement(c, `INSERT INTO upload_sessions
      (id,storage_key,target_type,target_id,replace_for,original_filename,mime_type,media_type,format,file_size,width,height,duration,chunk_size,status,created_at,updated_at)
    SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,? WHERE ${quotaSql}`,
  [sessionId, storageKey, data.target_type, ownerId, isContent(data.target_type) ? data.replace_for ?? null : null,
    filename, format.mime, format.kind, filename.split('.').at(-1)?.toLowerCase() ?? format.extension,
    data.size, data.width ?? null, data.height ?? null, format.kind === 'video' ? data.duration ?? null : null,
    PART_SIZE, multipart ? 'creating' : 'uploading', at, at, data.size, limit, limit]).run();
  if (!changed(result)) fail(413, 'Лимит хранилища исчерпан. Освободите место или повысьте лимит.', 'storage_quota');

  if (multipart) {
    let uploadId: string | undefined;
    try {
      uploadId = await store(c).startMultipart(storageKey, format.mime);
      await statement(c, "UPDATE upload_sessions SET status='uploading',upload_id=? WHERE id=? AND status='creating'", [uploadId, sessionId]).run();
    } catch (error) {
      if (uploadId) await store(c).abortMultipart(storageKey, uploadId).catch(() => {});
      await statement(c, 'DELETE FROM upload_sessions WHERE id=?', [sessionId]).run();
      throw error;
    }
  }
  return json({ id: sessionId, chunk_size: PART_SIZE }, 201);
}

async function rawBytes(c: Context, max: number) {
  const declared = c.req.headers.get('content-length');
  if (declared !== null && Number(declared) > max) fail(413, 'Часть файла превышает установленный размер.');
  if (!c.req.body) fail(400, 'Пустая часть файла.');
  const collected = new Uint8Array(max);
  const reader = c.req.body.getReader();
  let length = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      if (length + next.value.byteLength > max) {
        await reader.cancel();
        fail(413, 'Часть файла превышает установленный размер.');
      }
      collected.set(next.value, length);
      length += next.value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  return collected.subarray(0, length);
}

async function getUpload(c: Context, sessionId: string) {
  const session = await getSession(c, sessionId);
  const parts = await statement(c, 'SELECT part_number,size,sha256 FROM upload_parts WHERE upload_session_id=? AND etag IS NOT NULL ORDER BY part_number', [sessionId]).all();
  return json({ id: session.id, status: session.status, chunk_size: session.chunk_size, size: session.file_size, parts: parts.results });
}

async function putPart(c: Context, sessionId: string, partNumber: number) {
  const session = await getSession(c, sessionId);
  if (session.status !== 'uploading') fail(409, 'Эта загрузка уже завершена или меняется на другом устройстве.');
  const partsCount = Math.ceil(session.file_size / session.chunk_size);
  if (!Number.isSafeInteger(partNumber) || partNumber < 1 || partNumber > partsCount) fail(400, 'Неверный номер части.');
  const expectedSize = partNumber === partsCount ? session.file_size - (partNumber - 1) * session.chunk_size : session.chunk_size;
  const bytes = await rawBytes(c, expectedSize);
  if (bytes.byteLength !== expectedSize) fail(400, 'Передана неполная часть файла. Повторите загрузку.');
  const hash = hex(await crypto.subtle.digest('SHA-256', bytes));
  const claimed = c.req.headers.get('x-content-sha256');
  if (claimed && (!shaSchema.safeParse(claimed).success || claimed.toLowerCase() !== hash)) {
    fail(422, 'Контрольная сумма части не совпала. Повторите загрузку.', 'checksum_mismatch');
  }

  let dimensions: ReturnType<typeof inspectDimensions> = null;
  if (partNumber === 1) {
    const detected = inspectFormat(bytes, formatForName(session.original_filename));
    if (detected?.mime !== session.mime_type &&
      !(session.mime_type === 'image/heif' && detected?.mime === 'image/heic')) {
      fail(415, 'Содержимое файла не соответствует расширению или формат не поддерживается.', 'invalid_file_signature');
    }
    dimensions = inspectDimensions(bytes, session.mime_type);
    if (dimensions && (!dimensions.width || !dimensions.height || dimensions.width > 100000 || dimensions.height > 100000)) {
      fail(415, 'Файл содержит недопустимый размер изображения.', 'invalid_media_dimensions');
    }
  }

  const lease = id();
  const checkAt = now();
  const claim = await statement(c, `INSERT INTO upload_parts(upload_session_id,part_number,lease,lease_until)
    SELECT ?,?,?,? WHERE EXISTS(SELECT 1 FROM upload_sessions WHERE id=? AND status='uploading')
    ON CONFLICT(upload_session_id,part_number) DO UPDATE SET lease=excluded.lease,lease_until=excluded.lease_until
    WHERE upload_parts.lease IS NULL OR upload_parts.lease_until < ?`,
  [sessionId, partNumber, lease, leaseAfter(), sessionId, checkAt]).run();
  if (!changed(claim)) fail(409, 'Эта часть уже загружается. Повторите через несколько секунд.', 'part_in_progress');
  try {
    const stored = await statement(c, 'SELECT part_number,etag,sha256,lease FROM upload_parts WHERE upload_session_id=? AND part_number=?', [session.id, partNumber]).first<UploadPart>();
    if (stored?.etag && stored.sha256 === hash) return json({ part_number: partNumber, sha256: hash });
    // Once a part is committed, only identical retries are allowed. A different selection requires a new session.
    if (stored?.etag) fail(409, 'Имя части совпало, а содержимое изменилось. Начните новую загрузку.', 'part_changed');
    const storage = store(c);
    let etag: string;
    if (session.upload_id) {
      etag = (await storage.putPart(session.storage_key, session.upload_id, partNumber, bytes)).etag;
    } else {
      await storage.write(session.storage_key, bytes, session.mime_type, hash);
      etag = hash;
    }
    const results = await c.db.batch([
      statement(c, `UPDATE upload_parts SET etag=?,sha256=?,size=? WHERE upload_session_id=? AND part_number=? AND lease=?`,
        [etag, hash, bytes.length, sessionId, partNumber, lease]),
      statement(c, `UPDATE upload_sessions SET updated_at=?,width=COALESCE(?,width),height=COALESCE(?,height) WHERE id=? AND status='uploading'`,
        [now(), dimensions?.width ?? null, dimensions?.height ?? null, sessionId]),
    ]);
    if (!changed(results[0])) fail(409, 'Срок сохранения части истёк. Повторите загрузку.', 'upload_conflict');
    return json({ part_number: partNumber, sha256: hash });
  } finally {
    await statement(c, 'UPDATE upload_parts SET lease=NULL,lease_until=NULL WHERE upload_session_id=? AND part_number=? AND lease=?', [sessionId, partNumber, lease]).run();
  }
}

type Condition = { sql: string; args: unknown[] };
const unrestricted: Condition = { sql: '1=1', args: [] };

export function coverReferences(c: Context, type: CoverTarget, ownerId: string, mediaId: string | null, at: string, guard = unrestricted) {
  const operations = [statement(c, `UPDATE owner_covers SET deleted_at=? WHERE owner_type=? AND owner_id=? AND deleted_at IS NULL
    AND media_id IS NOT ? AND ${guard.sql}`, [at, type, ownerId, mediaId, ...guard.args])];
  if (mediaId) {
    operations.push(statement(c, `INSERT OR IGNORE INTO owner_covers(id,owner_type,owner_id,media_id,created_at)
      SELECT ?,?,?,?,? WHERE ${guard.sql}`, [id(), type, ownerId, mediaId, at, ...guard.args]));
  }
  return operations;
}

function coverChanges(c: Context, type: CoverTarget, ownerId: string, mediaId: string | null, at: string, guard: Condition) {
  const operations = coverReferences(c, type, ownerId, mediaId, at, guard);
  operations.push(type === 'category'
    ? statement(c, `UPDATE categories SET cover_media_id=?,updated_at=?,version=version+1 WHERE id=? AND deleted_at IS NULL AND ${guard.sql}`, [mediaId, at, ownerId, ...guard.args])
    : statement(c, `UPDATE app_settings SET value=json_set(value,'$.logo_media_id',?),updated_at=? WHERE key='studio' AND ${guard.sql}`, [mediaId, at, ...guard.args]));
  return operations;
}

function attachChanges(c: Context, s: Session, at: string, guard: Condition) {
  if (!isContent(s.target_type)) return coverChanges(c, s.target_type, s.target_id, s.id, at, guard);
  const type = s.target_type;
  const table = attachmentTables[type];
  const column = ownerColumn(type);
  const ownerTable = ownerTables[type];
  const attachmentId = id();
  const operations = [
    statement(c, `INSERT INTO ${table}(id,${column},media_id,sort_order,role,replace_for)
      SELECT ?,?,?,COALESCE((SELECT sort_order FROM ${table} WHERE id=?),
        (SELECT COALESCE(MAX(sort_order),-1)+1 FROM ${table} WHERE ${column}=? AND deleted_at IS NULL)),
      COALESCE((SELECT role FROM ${table} WHERE id=?),'asset'),? WHERE ${guard.sql}`,
    [attachmentId, s.target_id, s.id, s.replace_for, s.target_id, s.replace_for, s.replace_for, ...guard.args]),
  ];
  if (s.replace_for) operations.push(statement(c, `UPDATE ${table} SET deleted_at=? WHERE id=? AND ${guard.sql}`, [at, s.replace_for, ...guard.args]));
  operations.push(statement(c, `UPDATE ${ownerTable} SET
    cover_media_id=CASE WHEN cover_media_id=(SELECT media_id FROM ${table} WHERE id=?) THEN ? ELSE cover_media_id END,
    updated_at=?,version=version+1 WHERE id=? AND ${guard.sql}`, [s.replace_for, s.media_type === 'image' ? s.id : null, at, s.target_id, ...guard.args]));
  return operations;
}

function stillValid(s: Session): Condition {
  if (s.target_type === 'logo') return unrestricted;
  const sql = `EXISTS(SELECT 1 FROM ${ownerTables[s.target_type]} WHERE id=? AND deleted_at IS NULL)`;
  if (!s.replace_for || !isContent(s.target_type)) return { sql, args: [s.target_id] };
  return {
    sql: `${sql} AND EXISTS(SELECT 1 FROM ${attachmentTables[s.target_type]} WHERE id=? AND ${ownerColumn(s.target_type)}=? AND deleted_at IS NULL)`,
    args: [s.target_id, s.replace_for, s.target_id],
  };
}

async function complete(c: Context, sessionId: string) {
  const { sha256 } = parses(z.object({ sha256: shaSchema.optional() }), await body(c));
  const lease = id();
  const at = now();
  const session = await getSession(c, sessionId);
  if (session.status === 'done') {
    const asset = await getAsset(c, sessionId);
    if (sha256 && asset.sha256 !== sha256.toLowerCase()) fail(422, 'Контрольная сумма оригинала не совпала.', 'checksum_mismatch');
    return json(asset);
  }
  const partsCount = Math.ceil(session.file_size / session.chunk_size);
  const claim = await statement(c, `UPDATE upload_sessions SET status='sealing',lease=?,lease_until=?,updated_at=? WHERE id=?
    AND (status='uploading' OR (status='sealing' AND lease_until < ?))
    AND (SELECT COUNT(*) FROM upload_parts WHERE upload_session_id=? AND etag IS NOT NULL AND lease IS NULL)=?`,
  [lease, leaseAfter(SEAL_LEASE_MS), at, sessionId, at, sessionId, partsCount]).run();
  if (!changed(claim)) fail(409, 'Не все части файла сохранены или завершение уже выполняется.', 'upload_incomplete');
  try {
    const storage = store(c);
    // Recovery: an interrupted attempt may have composed R2 successfully before D1 saved the asset.
    if (session.upload_id && !await storage.inspect(session.storage_key)) {
      const rows = await statement(c, 'SELECT part_number,etag FROM upload_parts WHERE upload_session_id=? ORDER BY part_number', [sessionId]).all<{ part_number: number; etag: string }>();
      await storage.finishMultipart(session.storage_key, session.upload_id, rows.results.map(part => ({ partNumber: part.part_number, etag: part.etag })));
    }
    const stored = await storage.read(session.storage_key);
    if (!stored || stored.size !== session.file_size) {
      if (stored) await stored.body.cancel();
      fail(422, 'Сохранённый файл имеет неверный размер. Отмените загрузку и повторите её.', 'file_size_mismatch');
    }
    const checksum = await digestStream(stored.body);
    if (sha256 && checksum !== sha256.toLowerCase()) fail(422, 'Контрольная сумма оригинала не совпала. Повторите загрузку.', 'checksum_mismatch');
    if (!session.upload_id) {
      const part = await statement(c, 'SELECT sha256 FROM upload_parts WHERE upload_session_id=? AND part_number=1', [sessionId]).first<{ sha256: string }>();
      if (part?.sha256 !== checksum) fail(422, 'Проверка сохранённого оригинала не пройдена.', 'checksum_mismatch');
    }
    const moment = now();
    const valid = stillValid(session);
    const guard = { sql: `EXISTS(SELECT 1 FROM upload_sessions WHERE id=? AND lease=? AND status='done')`, args: [session.id, lease] };
    const result = await c.db.batch([
      statement(c, `UPDATE upload_sessions SET status='done',updated_at=? WHERE id=? AND status='sealing' AND lease=? AND ${valid.sql}`,
        [moment, sessionId, lease, ...valid.args]),
      statement(c, `INSERT INTO media_assets(id,storage_key,original_filename,mime_type,format,file_size,sha256,media_type,width,height,duration,created_at)
        SELECT id,storage_key,original_filename,mime_type,format,file_size,?,media_type,width,height,duration,?
        FROM upload_sessions WHERE id=? AND lease=? AND status='done'`, [checksum, moment, sessionId, lease]),
      ...attachChanges(c, session, moment, guard),
      operation(c, 'upload', 'ok', session.file_size, session.original_filename, guard),
      statement(c, `INSERT INTO activity_log(id,action,entity_type,entity_id,created_at)
        SELECT ?,?,?,?,? WHERE ${guard.sql}`,
      [id(), `Файл загружен · ${session.original_filename}`, session.target_type, session.target_id, moment, ...guard.args]),
      statement(c, `DELETE FROM upload_parts WHERE upload_session_id=? AND ${guard.sql}`, [sessionId, ...guard.args]),
    ]);
    if (!changed(result[0])) fail(409, 'Связанный материал удалён или уже изменён. Отмените загрузку.', 'upload_target_changed');
    return json(await getAsset(c, sessionId), 201);
  } catch (error) {
    await statement(c, "UPDATE upload_sessions SET status='uploading',lease=NULL,lease_until=NULL WHERE id=? AND lease=? AND status='sealing'", [sessionId, lease]).run();
    throw error;
  }
}

async function removeUpload(c: Context, s: Session, expired = false) {
  const at = now();
  const lease = id();
  const result = await statement(c, `UPDATE upload_sessions SET status='canceling',lease=?,lease_until=? WHERE id=? AND
    (status='uploading' OR (status IN ('sealing','canceling') AND lease_until < ?) OR (status='creating' AND updated_at < ?)) AND
    NOT EXISTS(SELECT 1 FROM upload_parts WHERE upload_session_id=? AND lease IS NOT NULL AND lease_until > ?)`,
  [lease, leaseAfter(), s.id, at, new Date(Date.now()-MAX_LEASE_MS).toISOString(), s.id, at]).run();
  if (!changed(result)) {
    if (expired) return;
    fail(409, 'Загрузку нельзя отменить, пока выполняется запись. Повторите попытку.');
  }
  const storage = store(c);
  if (s.upload_id) {
    try {
      await storage.abortMultipart(s.storage_key, s.upload_id);
    } catch (error) {
      // Completed multipart uploads no longer have an upload ID.
      if (!await storage.inspect(s.storage_key) && !/no.?such.?upload|does not exist|not found|10024/iu.test(String(error))) throw error;
    }
  }
  await storage.remove(s.storage_key);
  await c.db.batch([
    statement(c, 'DELETE FROM upload_sessions WHERE id=? AND lease=? AND status=\'canceling\'', [s.id, lease]),
    operation(c, expired ? 'upload_expired' : 'upload_cancel', 'ok', s.file_size, s.original_filename),
  ]);
}

export async function abortExpired(c: Context) {
  const cutoff = new Date(Date.now() - ONE_DAY).toISOString();
  const expired = await statement(c, "SELECT * FROM upload_sessions WHERE status!='done' AND updated_at < ? ORDER BY updated_at LIMIT 8", [cutoff]).all<Session>();
  for (const session of expired.results) {
    try { await removeUpload(c, session, true); }
    catch { await operation(c, 'upload_cleanup', 'error', session.file_size, session.original_filename).run(); }
  }
  await statement(c, "DELETE FROM upload_sessions WHERE status='done' AND updated_at < ?", [cutoff]).run();
  // A crashed preview writer leaves a reserved key here; enqueue deletion before releasing the reservation.
  await c.db.batch([
    statement(c, 'INSERT OR IGNORE INTO media_cleanup(storage_key,created_at) SELECT storage_key,? FROM preview_uploads WHERE created_at < ?', [now(), cutoff]),
    statement(c, 'DELETE FROM preview_uploads WHERE created_at < ?', [cutoff]),
  ]);
}

async function setPreview(c: Context, mediaId: string) {
  const asset = await getAsset(c, mediaId);
  if (asset.preview_storage_key) return json(asset);
  const bytes = await rawBytes(c, MAX_PREVIEW_SIZE);
  const dimensions = inspectDimensions(bytes, 'image/webp');
  if (inspectFormat(bytes)?.mime !== 'image/webp' || !dimensions?.width || !dimensions.height || dimensions.width > 1024 || dimensions.height > 1024) {
    fail(415, 'Превью должно быть изображением WebP не более 1024 пикселей по каждой стороне.');
  }
  const randomKey = `previews/${mediaId}/${id()}`;
  const storage = store(c);
  const maximum = quota(c);
  const claim = await statement(c, `INSERT OR IGNORE INTO preview_uploads(media_id,storage_key,size,created_at)
    SELECT ?,?,?,? WHERE EXISTS(SELECT 1 FROM media_assets WHERE id=? AND deleted_at IS NULL AND preview_storage_key IS NULL) AND ${quotaSql}`,
  [mediaId, randomKey, bytes.length, now(), mediaId, bytes.length, maximum, maximum]).run();
  if (!changed(claim)) {
    const current = await getAsset(c, mediaId);
    if (current.preview_storage_key) return json(current);
    const pending = await statement(c, 'SELECT media_id FROM preview_uploads WHERE media_id=?', [mediaId]).first();
    if (pending) fail(409, 'Превью уже создаётся.');
    fail(413, 'Лимит хранилища исчерпан. Оригинал сохранён.');
  }
  let linked = false;
  try {
    await storage.write(randomKey, bytes, 'image/webp');
    const [result] = await c.db.batch([
      statement(c, `UPDATE media_assets SET preview_storage_key=?,preview_size=?
        WHERE id=? AND deleted_at IS NULL AND preview_storage_key IS NULL AND
        EXISTS(SELECT 1 FROM preview_uploads WHERE media_id=? AND storage_key=?)`,
      [randomKey, bytes.length, mediaId, mediaId, randomKey]),
      statement(c, 'DELETE FROM preview_uploads WHERE media_id=? AND storage_key=?', [mediaId, randomKey]),
    ]);
    linked = changed(result);
    return json(await getAsset(c, mediaId));
  } finally {
    if (!linked) {
      try { await storage.remove(randomKey); }
      catch { await statement(c, 'INSERT OR IGNORE INTO media_cleanup(storage_key,created_at) VALUES(?,?)', [randomKey, now()]).run(); }
      await statement(c, 'DELETE FROM preview_uploads WHERE media_id=? AND storage_key=?', [mediaId, randomKey]).run();
    }
  }
}

async function getMedia(c: Context, mediaId: string) {
  const asset = await getAsset(c, mediaId);
  const download = c.url.searchParams.get('download') === '1';
  const wantsPreview = !download && c.url.searchParams.get('preview') === '1';
  const preview = wantsPreview && Boolean(asset.preview_storage_key);
  if (wantsPreview && !preview && (asset.file_size > MAX_PREVIEW_SIZE ||
    !['image/png','image/jpeg','image/webp','image/gif','image/avif'].includes(asset.mime_type))) {
    fail(404, 'Превью недоступно. Оригинал можно открыть или скачать отдельно.', 'preview_unavailable');
  }
  const byteSize = preview ? asset.preview_size : asset.file_size;
  const key = preview ? asset.preview_storage_key! : asset.storage_key;
  const mime = preview ? 'image/webp' : asset.mime_type;
  const tag = preview ? null : `"${asset.sha256}"`;
  const requestRange = c.req.headers.get('range');
  const ifRange = c.req.headers.get('if-range');
  let range: ReturnType<typeof parseRange>;
  try {
    range = parseRange(ifRange && ifRange !== tag ? null : requestRange, byteSize);
  } catch {
    return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${byteSize}`, 'Accept-Ranges': 'bytes' } });
  }
  const headers = new Headers({
    'Content-Type': mime,
    'Content-Length': String(range?.length ?? byteSize),
    'Content-Disposition': disposition(download ? 'attachment' : 'inline',
      (download && c.url.searchParams.get('filename')?.slice(0, 240)) || asset.original_filename),
    'Accept-Ranges': 'bytes',
    'Cache-Control': preview ? 'private, max-age=3600' : 'private, no-cache',
    'X-Content-Type-Options': 'nosniff',
  });
  if (tag) headers.set('ETag', tag);
  if (!range && tag && c.req.headers.get('if-none-match')?.split(',').some(item => item.trim() === tag || item.trim() === '*')) {
    headers.delete('Content-Length');
    return new Response(null, { status: 304, headers });
  }
  if (range) headers.set('Content-Range', `bytes ${range.offset}-${range.offset + range.length - 1}/${byteSize}`);
  const storage = store(c);
  if (c.req.method === 'HEAD') {
    if (!await storage.inspect(key)) fail(404, 'Объект отсутствует в хранилище.', 'media_object_not_found');
    return new Response(null, { status: range ? 206 : 200, headers });
  }
  const object = await storage.read(key, range ?? undefined);
  if (!object) fail(404, 'Объект отсутствует в хранилище.', 'media_object_not_found');
  return new Response(object.body, { status: range ? 206 : 200, headers });
}

async function reorder(c: Context) {
  const data = parses(z.object({ target_type: z.enum(['publication', 'idea']), target_id: z.string().min(1).max(100), ids: z.array(uuid).max(30000) }), await body(c, 2 * MiB));
  const type = data.target_type;
  const column = ownerColumn(type);
  const table = attachmentTables[type];
  await getOwner(c, type, data.target_id);
  if (new Set(data.ids).size !== data.ids.length) fail(400, 'В новом порядке есть повторяющиеся файлы.');
  const idsJson = JSON.stringify(data.ids);
  const date = now();
  // The same statement validates membership and rewrites the complete order against the current set.
  const result = await c.db.batch([
    statement(c, `UPDATE ${table} SET sort_order=(SELECT CAST(key AS INTEGER) FROM json_each(?) WHERE value=${table}.id)
      WHERE ${column}=? AND deleted_at IS NULL
        AND (SELECT COUNT(*) FROM ${table} a WHERE a.${column}=? AND a.deleted_at IS NULL)=?
        AND NOT EXISTS(SELECT 1 FROM json_each(?) j LEFT JOIN ${table} a
          ON a.id=j.value AND a.${column}=? AND a.deleted_at IS NULL WHERE a.id IS NULL)`,
    [idsJson, data.target_id, data.target_id, data.ids.length, idsJson, data.target_id]),
    statement(c, `UPDATE ${ownerTables[type]} SET updated_at=?,version=version+1 WHERE id=? AND changes()=? AND deleted_at IS NULL`, [date, data.target_id, data.ids.length]),
  ]);
  if (result[0].meta.changes !== data.ids.length) fail(409, 'Состав галереи изменился. Обновите карточку и повторите.', 'attachment_conflict');
  return json({ ok: true });
}

async function setCover(c: Context) {
  const data = parses(z.object({ target_type: targets, target_id: z.string().min(1).max(100).optional(), media_id: uuid.nullable() }), await body(c));
  const type = data.target_type;
  const ownerId = type === 'logo' ? 'studio' : data.target_id;
  if (!ownerId) fail(400, 'Укажите целевой материал.');
  await getOwner(c, type, ownerId);
  const at = now();
  const asset = data.media_id ? await getAsset(c, data.media_id) : null;
  if (asset && asset.media_type !== 'image') fail(415, 'Для обложки требуется изображение.');
  const guard = asset ? { sql: 'EXISTS(SELECT 1 FROM media_assets WHERE id=? AND deleted_at IS NULL)', args: [asset.id] } : unrestricted;
  if (isContent(type)) {
    const membership = asset ? `AND EXISTS(SELECT 1 FROM ${attachmentTables[type]} WHERE ${ownerColumn(type)}=? AND media_id=? AND deleted_at IS NULL)` : '';
    const result = await statement(c, `UPDATE ${ownerTables[type]} SET cover_media_id=?,updated_at=?,version=version+1 WHERE id=? AND deleted_at IS NULL
      AND ${guard.sql} ${membership}`, [data.media_id, at, ownerId, ...guard.args, ...(asset ? [ownerId, asset.id] : [])]).run();
    if (!changed(result)) fail(409, 'Прикрепите фотографию к карточке, чтобы назначить её обложкой.');
  } else {
    const ownerGuard = type === 'category' ? {
      sql: `${guard.sql} AND EXISTS(SELECT 1 FROM categories WHERE id=? AND deleted_at IS NULL)`,
      args: [...guard.args, ownerId],
    } : guard;
    const result = await c.db.batch(coverChanges(c, type, ownerId, data.media_id, at, ownerGuard));
    if (!changed(result.at(-1)!)) fail(409, 'Запись или изображение изменились. Обновите страницу и повторите.');
  }
  await activity(c, data.media_id ? 'Обложка изменена' : 'Обложка снята', type, ownerId).run();
  return json({ ok: true });
}

async function removeAttachment(c: Context, attachmentId: string) {
  const type = parses(z.enum(['publication','idea']), c.url.searchParams.get('target_type'));
  const column = ownerColumn(type);
  const table = attachmentTables[type];
  const record = await statement(c, `SELECT id,${column} AS owner_id,media_id FROM ${table} WHERE id=? AND deleted_at IS NULL`, [attachmentId]).first<Attachment & { owner_id: string }>();
  if (!record) fail(404, 'Файл уже снят с карточки.');
  await getOwner(c, type, record.owner_id);
  const at = now();
  const result = await c.db.batch([
    statement(c, `UPDATE ${table} SET deleted_at=? WHERE id=? AND deleted_at IS NULL`, [at, attachmentId]),
    statement(c, `UPDATE ${ownerTables[type]} SET version=version+1,updated_at=?,cover_media_id=CASE
      WHEN cover_media_id=? AND NOT EXISTS(SELECT 1 FROM ${table} WHERE ${column}=? AND media_id=? AND deleted_at IS NULL)
      THEN NULL ELSE cover_media_id END WHERE id=? AND changes()=1`,
    [at, record.media_id, record.owner_id, record.media_id, record.owner_id]),
    activity(c, 'Файл перемещён в корзину', type, record.owner_id),
  ]);
  if (!changed(result[0])) fail(409, 'Файл уже снят с карточки.');
  return json({ ok: true });
}

async function downloadPublication(c: Context, publicationId: string) {
  const publication = await statement(c, 'SELECT title,cover_media_id FROM publications WHERE id=? AND deleted_at IS NULL', [publicationId]).first<{ title: string; cover_media_id: string | null }>();
  if (!publication) fail(404, 'Публикация не найдена.');
  const conditions = c.url.searchParams.get('photos') === '1' ? "AND a.media_type='image'" : '';
  const rows = await statement(c, `SELECT a.* FROM publication_media m JOIN media_assets a ON a.id=m.media_id
    WHERE m.publication_id=? AND m.deleted_at IS NULL AND a.deleted_at IS NULL ${conditions}
    ORDER BY a.id=? DESC,m.sort_order,m.id`, [publicationId, publication.cover_media_id]).all<Asset>();
  if (!rows.results.length) fail(404, 'В публикации пока нет подходящих файлов.');
  const digits = Math.max(2, String(rows.results.length).length);
  const files = rows.results.map((asset, index) => ({
    key: asset.storage_key, size: asset.file_size, createdAt: asset.created_at, id: asset.id,
    name: `${String(index+1).padStart(digits,'0')}-${asset.id === publication.cover_media_id ? `cover.${asset.format}` : safeFilename(asset.original_filename)}`,
  }));
  if (files.length > ZIP_FILE_LIMIT || files.reduce((total, file) => total + file.size, 0) > ZIP_SIZE_LIMIT) {
    if (c.req.method === 'HEAD') return new Response(null, {headers:{'Content-Type':'application/json','Cache-Control':'no-store'}});
    return json({ files: files.map(file => ({ name: file.name, url: `/api/media/${file.id}?download=1&filename=${encodeURIComponent(file.name)}` })) });
  }
  return new Response(c.req.method === 'HEAD' ? null : streamZip(store(c), files), { headers: {
    'Content-Type': 'application/zip', 'Content-Disposition': disposition('attachment', `${publication.title}.zip`), 'Cache-Control': 'no-store',
  } });
}

export async function media(c: Context): Promise<Response | undefined> {
  const path = c.url.pathname;
  const method = c.req.method;
  if (path === '/api/uploads' && method === 'POST') return begin(c);
  if (path === '/api/media/order' && method === 'PATCH') return reorder(c);
  if (path === '/api/media/cover' && method === 'PATCH') return setCover(c);
  const upload = /^\/api\/uploads\/([^/]+)(?:\/(complete|parts\/(\d+)))?$/u.exec(path);
  if (upload) {
    const sessionId = parses(uuid, upload[1]);
    if (method === 'PUT' && upload[3]) return putPart(c, sessionId, Number(upload[3]));
    if (method === 'POST' && upload[2] === 'complete') return complete(c, sessionId);
    if (!upload[2] && method === 'GET') return getUpload(c, sessionId);
    if (!upload[2] && method === 'DELETE') {
      await removeUpload(c, await getSession(c, sessionId));
      return json({ ok: true });
    }
  }
  const file = /^\/api\/media\/([^/]+)(\/preview)?$/u.exec(path);
  if (file) {
    const mediaId = parses(uuid, file[1]);
    if (file[2] && method === 'PUT') return setPreview(c, mediaId);
    if (!file[2] && (method === 'GET' || method === 'HEAD')) return getMedia(c, mediaId);
  }
  const attachment = /^\/api\/attachments\/([^/]+)$/u.exec(path);
  if (attachment && method === 'DELETE') return removeAttachment(c, parses(uuid, attachment[1]));
  const zip = /^\/api\/publications\/([^/]+)\/download$/u.exec(path);
  if (zip && (method === 'GET' || method === 'HEAD')) return downloadPublication(c, zip[1]);
  return undefined;
}
