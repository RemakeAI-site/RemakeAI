import { body, fail, id, json, now, type Context } from './core';
import { digestStream, disposition, inspectFormat, PART_SIZE, R2Storage, streamZip, type ObjectStorage } from './storage';

const schemas = {
  media_assets:'id storage_key original_filename mime_type format file_size sha256 media_type width height duration preview_storage_key preview_size created_at deleted_at',
  publication_statuses:'id name color sort_order',
  categories:'id parent_id name slug description cover_media_id icon color sort_order is_hidden is_archived description_limit search_text created_at updated_at deleted_at trash_group version',
  publications:'id category_id title description hashtags status_id scenario notes cover_media_id scheduled_at published_at tiktok_url is_favorite search_text created_at updated_at deleted_at trash_group version',
  ideas:'id category_id title description priority status scenario notes links cover_media_id publication_id is_favorite search_text created_at updated_at deleted_at trash_group version',
  publication_media:'id publication_id media_id sort_order role deleted_at replace_for',
  idea_media:'id idea_id media_id sort_order role deleted_at replace_for',
  owner_covers:'id owner_type owner_id media_id created_at deleted_at',
  custom_field_definitions:'id name type options sort_order',
  custom_field_values:'publication_id field_id value',
  app_settings:'key value updated_at',
  activity_log:'id action entity_type entity_id created_at',
  archive_exceptions:'publication_id created_at'
} as const;
type Table = keyof typeof schemas;
type Row = Record<string, string|number|null>;
type Manifest = {format:1,created_at:string,tables:Partial<Record<Table,Row[]>>};
type ImportSession = {id:string;token:string;status:string};
type MediaRow = {storage_key:string; file_size:number; sha256:string; mime_type:string; preview_storage_key:string|null; preview_size:number; created_at:string};
type ImportObject = {storage_key:string; staged_key:string; size:number; expected_hash:string|null; mime:string; upload_id:string|null;parts:string;checked:number};
const tables = Object.keys(schemas) as Table[];
const identifiers = /^[a-zA-Z0-9_-]{1,100}$/u;
const objectKey = /^(?:originals|previews|media)\/[a-zA-Z0-9/_-]{1,180}(?:\.[a-zA-Z0-9]{1,8})?$/u;
const UI_LIMIT = 64 * 1024 * 1024;
const guardSql = `(SELECT count(*) FROM publications)+(SELECT count(*) FROM ideas)
 +(SELECT count(*) FROM media_assets)+(SELECT count(*) FROM custom_field_definitions)+(SELECT count(*) FROM activity_log)`;
function rowKey(table:Table, row:Row): string {
  const keys = table === 'custom_field_values' ? [row.publication_id,row.field_id] : table === 'app_settings' ? [row.key] : table === 'archive_exceptions' ? [row.publication_id] : [row.id];
  if (keys.some(key => typeof key !== 'string' || !identifiers.test(key))) fail(400,'Недопустимый идентификатор в копии.');
  return keys.join(':');
}
function tableName(value: string): Table {
  if (!Object.hasOwn(schemas,value)) fail(400,'Неизвестная таблица копии.');
  return value as Table;
}
function validateRow(table:Table, row:unknown): Row {
  const cols = schemas[table].split(' ');
  if (!row || typeof row !== 'object' || Array.isArray(row)) fail(400,'Некорректная запись копии.');
  const data = row as Row;
  for (const col of cols) {
    const value = data[col];
    if (value === undefined || (value !== null && typeof value !== 'string' && typeof value !== 'number')) fail(400,'Неверный формат поля копии.');
  }
  if (table === 'app_settings') {
    if (data.key !== 'studio') fail(400,'Неизвестная запись настроек.');
    try { if (!JSON.parse(String(data.value))?.name) throw new Error(); } catch { fail(400,'Настройки копии повреждены.'); }
  }
  if (table === 'media_assets') {
    const m = data as unknown as MediaRow;
    if (!objectKey.test(m.storage_key) || (m.preview_storage_key && !objectKey.test(m.preview_storage_key)) ||
        !/^[a-f0-9]{64}$/u.test(m.sha256) || !Number.isSafeInteger(m.file_size) || m.file_size <= 0 ||
        !Number.isSafeInteger(m.preview_size) || m.preview_size < 0 || m.preview_size > 2 * 1024 * 1024 ||
        Boolean(m.preview_size) !== Boolean(m.preview_storage_key) ||
        !/^(image\/(png|jpeg|webp|avif|gif|heic|heif)|video\/(mp4|quicktime|webm))$/u.test(m.mime_type)) {
      fail(400,'Некорректные метаданные оригинала.');
    }
  }
  return Object.fromEntries(cols.map(col=>[col,data[col]]));
}
const pageSql = (table:Table) => `SELECT ${schemas[table].split(' ').join(',')} FROM ${table} WHERE rowid>? ORDER BY rowid LIMIT ?`;
async function copyPage(c:Context, table:Table, cursor:number) {
  const clause = pageSql(table).replace('SELECT ','SELECT rowid AS backup_cursor,');
  const {results} = await c.db.prepare(clause).bind(cursor,20).all<Row>();
  return {items:results.map(({backup_cursor:_cursor,...row})=>row), next:results.length === 20 ? results.at(-1)?.backup_cursor : null};
}
async function exportZip(c:Context) {
  const counts = await c.db.prepare('SELECT count(*) n, coalesce(sum(file_size+preview_size),0) size, count(preview_storage_key) previews FROM media_assets').first<{n:number;size:number;previews:number}>();
  if (!counts || counts.n + counts.previews > 38 || counts.size > UI_LIMIT) fail(413,'Копия превышает лимит экспорта через браузер. Используйте команду backup.');
  const queried = await c.db.batch<Row>(tables.map(table=>c.db.prepare(`SELECT ${schemas[table].split(' ').join(',')} FROM ${table} LIMIT 1001`)));
  if (queried.some(result=>result.results.length>1000)) fail(413,'Для этой базы используйте команду backup.');
  const timestamp = now();
  const manifest:Manifest = {format:1,created_at:timestamp,tables:Object.fromEntries(tables.map((table,index)=>[table,queried[index].results]))};
  const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest));
  const base = new R2Storage(c.env.MEDIA);
  const key = 'manifest.json';
  const storage = Object.create(base) as ObjectStorage;
  storage.read = async (filename,range) => filename === key
    ? {body:new Blob([manifestBytes]).stream() as unknown as ReadableStream<Uint8Array>,size:manifestBytes.length,etag:''}
    : base.read(filename,range);
  const media = (manifest.tables.media_assets ?? []) as unknown as MediaRow[];
  const files = media.flatMap(m=>[
    {key:m.storage_key,name:'objects/'+m.storage_key,size:m.file_size,createdAt:m.created_at},
    ...(m.preview_storage_key ? [{key:m.preview_storage_key,name:'objects/'+m.preview_storage_key,size:m.preview_size,createdAt:m.created_at}] : [])
  ]);
  if (manifestBytes.length + files.reduce((n,f)=>n+f.size+256,0) > UI_LIMIT - 1024) fail(413,'Копия превышает лимит браузера. Используйте команду backup.');
  const stream = streamZip(storage,[{key,name:key,size:manifestBytes.length,createdAt:timestamp},...files]);
  const reader = stream.getReader();
  const tracked = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const part = await reader.read();
        if (part.done) {
          controller.close();
          c.ctx.waitUntil(record(c,'success',files.length,'ZIP через браузер'));
        } else controller.enqueue(part.value);
      } catch (err) { controller.error(err); c.ctx.waitUntil(record(c,'error',files.length,'Экспорт ZIP прерван')); }
    },
    cancel() { return reader.cancel(); }
  });
  return new Response(tracked,{headers:{'Content-Type':'application/zip','Content-Disposition':disposition('attachment',`remake-studio-${timestamp.slice(0,10)}.zip`),'Cache-Control':'no-store'}});
}
async function record(c:Context,status:string,objects:number,detail:string) {
  await c.db.prepare('INSERT INTO backup_records VALUES(?,?,?,?,?)').bind(id(),now(),status,objects,detail).run();
}

async function ensureFresh(c:Context) {
  const count = await c.db.prepare(`SELECT ${guardSql} AS n, (SELECT count(*) FROM categories WHERE id NOT IN ('archive-17','what-if','fever-dreams','metro-design','new-year','literally','collaborations','ai-answers','upgrade-reality','moment','imagine')) AS extra`).first<{n:number;extra:number}>();
  if (!count || count.n > 0 || count.extra > 0) fail(409,'Восстановление доступно в новой студии без пользовательских данных.');
}
async function getSession(c:Context, token:string, state = 'pending') {
  if (c.env.BACKUP_IMPORT_ENABLED !== '1') fail(403,'Режим восстановления выключен на сервере.');
  if (!identifiers.test(token)) fail(404,'Сессия восстановления не найдена.');
  const session = await c.db.prepare('SELECT * FROM import_sessions WHERE token=? AND status=?').bind(token,state).first<ImportSession>();
  if (!session) fail(409,'Сессия восстановления закрыта или не найдена.');
  return session;
}
async function begin(c:Context) {
  if (c.env.BACKUP_IMPORT_ENABLED !== '1') fail(403,'Режим восстановления выключен на сервере.');
  if ((await body(c)).confirm !== true) fail(400,'Подтвердите восстановление.');
  await ensureFresh(c);
  const token = id();
  try { await c.db.prepare("INSERT INTO import_sessions(id,token,created_at,status) VALUES(?,?,?,'pending')").bind(id(),token,now()).run(); }
  catch { fail(409,'Восстановление уже выполняется. Завершите существующую сессию.'); }
  return json({token,part_size:PART_SIZE},201);
}
async function stageRows(c:Context, session:ImportSession) {
  const {table:rawName,items} = await body(c,1024*1024);
  const table = tableName(rawName);
  if (!Array.isArray(items) || items.length<1 || items.length>30) fail(400,'Допустимо от 1 до 30 записей за запрос.');
  const statements:D1PreparedStatement[] = [];
  for (const item of items as unknown[]) {
    const row = validateRow(table,item);
    statements.push(c.db.prepare('INSERT OR REPLACE INTO import_rows VALUES(?,?,?,?)').bind(session.id,table,rowKey(table,row),JSON.stringify(row)));
    if (table !== 'media_assets') continue;
    const media = row as unknown as MediaRow;
    statements.push(c.db.prepare('INSERT OR IGNORE INTO import_objects(session_id,storage_key,staged_key,size,expected_hash,mime) VALUES(?,?,?,?,?,?)').bind(session.id,media.storage_key,'originals/'+id(),media.file_size,media.sha256,media.mime_type));
    if (media.preview_storage_key) statements.push(c.db.prepare('INSERT OR IGNORE INTO import_objects(session_id,storage_key,staged_key,size,expected_hash,mime) VALUES(?,?,?,?,?,?)').bind(session.id,media.preview_storage_key,'previews/'+id(),media.preview_size,null,'image/webp'));
  }
  await c.db.batch(statements);
  return json({ok:true});
}
async function putObject(c:Context, session:ImportSession, key:string, number:number) {
  const info = await c.db.prepare('SELECT * FROM import_objects WHERE session_id=? AND storage_key=?').bind(session.id,key).first<ImportObject>();
  if (!info) fail(404,'Объект отсутствует в описи копии.');
  if (info.checked) return json({ok:true,complete:true});
  const reservation = await c.db.prepare('SELECT coalesce(sum(size),0) AS bytes FROM import_objects WHERE session_id=?').bind(session.id).first<{bytes:number}>();
  if ((reservation?.bytes ?? 0)>Number(c.env.MAX_STORAGE_BYTES ?? 10*1024**3)) fail(413,'Копия превышает лимит этого сервера.');
  const objectPath = info.staged_key;
  const parts = JSON.parse(info.parts) as {partNumber:number;etag:string}[];
  if (!Number.isInteger(number) || number<1 || number>Math.ceil(info.size/PART_SIZE) || number>parts.length+1) fail(409,'Передайте следующую часть файла по порядку.');
  if (number <= parts.length) return json({ok:true});
  const transferred = (number-1)*PART_SIZE;
  const length = Math.min(PART_SIZE,info.size-transferred);
  if (c.req.headers.get('content-length') !== null && Number(c.req.headers.get('content-length')) !== length) fail(400,'Размер части не совпадает с описью.');
  const reader = c.req.body?.getReader();
  if (!reader) fail(400,'Часть файла пуста.');
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    if (offset+next.value.length>length) {
      await reader.cancel();
      fail(413,'Часть больше заявленного размера.');
    }
    bytes.set(next.value,offset);
    offset+=next.value.length;
  }
  if (offset!==length) fail(400,'Часть загружена не полностью.');
  if (number===1) {
    const actual = inspectFormat(bytes);
    const equivalent = (actual?.mime==='image/heic' && info.mime==='image/heif') || (actual?.mime==='video/mp4' && info.mime==='video/quicktime');
    if (!actual || (actual.mime!==info.mime && !equivalent)) fail(415,'Формат файла не совпадает с описью.');
  }
  const storage = new R2Storage(c.env.MEDIA);
  if (info.size <= PART_SIZE) {
    const checksum = info.expected_hash ?? undefined;
    if (checksum && await digestStream(new Blob([bytes]).stream() as unknown as ReadableStream<Uint8Array>) !== checksum) fail(422,'Контрольная сумма оригинала не совпадает.');
    await storage.write(objectPath,bytes,info.mime,checksum);
    await c.db.prepare('UPDATE import_objects SET checked=1 WHERE session_id=? AND storage_key=?').bind(session.id,key).run();
    return json({ok:true,complete:true});
  }
  const upload = info.upload_id ?? await storage.startMultipart(objectPath,info.mime);
  if (!info.upload_id) await c.db.prepare('UPDATE import_objects SET upload_id=? WHERE session_id=? AND storage_key=?').bind(upload,session.id,key).run();
  parts.push(await storage.putPart(objectPath,upload,number,bytes));
  if (transferred+length===info.size) {
    const existing = await storage.inspect(objectPath);
    if (!existing) await storage.finishMultipart(objectPath,upload,parts);
    const object = await storage.read(objectPath);
    const actual = object ? await digestStream(object.body) : null;
    if (!object || object.size!==info.size || actual!==info.expected_hash) {
      await storage.remove(objectPath);
      await c.db.prepare("UPDATE import_objects SET upload_id=NULL,parts='[]' WHERE session_id=? AND storage_key=?").bind(session.id,key).run();
      fail(422,'Контрольная сумма восстановленного оригинала не совпадает.');
    }
    await c.db.prepare('UPDATE import_objects SET checked=1,parts=? WHERE session_id=? AND storage_key=?').bind(JSON.stringify(parts),session.id,key).run();
    return json({ok:true,complete:true});
  }
  await c.db.prepare('UPDATE import_objects SET parts=? WHERE session_id=? AND storage_key=?').bind(JSON.stringify(parts),session.id,key).run();
  return json({ok:true});
}
async function commit(c:Context, session:ImportSession) {
  await ensureFresh(c);
  const counts = await c.db.prepare('SELECT count(*) objects, coalesce(sum(size),0) bytes, coalesce(sum(CASE WHEN checked=0 THEN 1 ELSE 0 END),0) pending FROM import_objects WHERE session_id=?').bind(session.id).first<{objects:number;bytes:number;pending:number}>();
  if (counts?.pending) fail(409,'Часть оригиналов ещё не загружена.');
  const configured = Number(c.env.MAX_STORAGE_BYTES ?? 10*1024**3);
  if ((counts?.bytes ?? 0)>configured) fail(413,'Размер копии превышает лимит этого сервера.');
  const header = await c.db.prepare("SELECT payload FROM import_rows WHERE session_id=? AND table_name='app_settings' AND row_key='studio'").bind(session.id).first();
  if (!header) fail(422,'В копии отсутствуют настройки студии.');
  const unlisted = await c.db.prepare(`
    SELECT 1 FROM import_rows r
    WHERE r.session_id=? AND r.table_name='media_assets' AND (
      NOT EXISTS(SELECT 1 FROM import_objects o WHERE o.session_id=r.session_id AND o.storage_key=json_extract(r.payload,'$.storage_key') AND o.size=json_extract(r.payload,'$.file_size') AND o.expected_hash=json_extract(r.payload,'$.sha256')) OR
      (json_extract(r.payload,'$.preview_storage_key') IS NOT NULL AND NOT EXISTS (SELECT 1 FROM import_objects o WHERE o.session_id=r.session_id AND o.storage_key=json_extract(r.payload,'$.preview_storage_key') AND o.size=json_extract(r.payload,'$.preview_size')))
    ) LIMIT 1`).bind(session.id).first();
  if (unlisted) fail(422,'Опись объектов расходится с метаданными.');
  const gate = "EXISTS(SELECT 1 FROM import_sessions WHERE id=? AND status='committing')";
  const statements:D1PreparedStatement[] = [
    c.db.prepare(`UPDATE import_sessions SET status='committing' WHERE id=? AND status='pending' AND (${guardSql})=0`).bind(session.id),
    ...['categories','publication_statuses','app_settings'].map(table=>c.db.prepare(`DELETE FROM ${table} WHERE ${gate}`).bind(session.id))
  ];
  for (const table of tables) {
    const columns = schemas[table].split(' ');
    const values = columns.map(col=>{
      if (table==='categories' && col==='parent_id') return 'NULL';
      if (table==='media_assets' && ['storage_key','preview_storage_key'].includes(col)) {
        return `(SELECT o.staged_key FROM import_objects o WHERE o.session_id=r.session_id AND o.storage_key=json_extract(r.payload,'$.${col}'))`;
      }
      return `json_extract(r.payload,'$.${col}')`;
    });
    statements.push(c.db.prepare(`INSERT INTO ${table}(${columns.join(',')}) SELECT ${values.join(',')} FROM import_rows r WHERE r.session_id=? AND r.table_name=? AND ${gate}`).bind(session.id,table,session.id));
  }
  statements.push(c.db.prepare(`UPDATE categories SET parent_id=(SELECT json_extract(payload,'$.parent_id') FROM import_rows WHERE session_id=? AND table_name='categories' AND row_key=categories.id) WHERE ${gate}`).bind(session.id,session.id));
  statements.push(c.db.prepare("UPDATE import_sessions SET status='finished' WHERE id=? AND status='committing'").bind(session.id));
  let result:D1Result[];
  try { result = await c.db.batch(statements); }
  catch (error) { console.error('restore validation',error); fail(422,'Связи или записи в копии повреждены. Рабочая база сохранена.'); }
  if (!result[0].meta.changes) fail(409,'В студии появились данные. Используйте отдельную чистую студию.');
  await c.db.prepare('DELETE FROM import_sessions WHERE id=?').bind(session.id).run();
  await record(c,'restored',counts?.objects ?? 0,'Резервная копия восстановлена');
  return json({ok:true});
}
async function cancel(c:Context, session:ImportSession) {
  const storage = new R2Storage(c.env.MEDIA);
  // Use bounded pages so large cancellations stay below provider subrequest limits.
  const {results} = await c.db.prepare('SELECT * FROM import_objects WHERE session_id=? LIMIT 15').bind(session.id).all<ImportObject>();
  for (const obj of results) {
    if (obj.upload_id && !obj.checked) await storage.abortMultipart(obj.staged_key,obj.upload_id).catch(()=>{});
    await storage.remove(obj.staged_key);
    await c.db.prepare('DELETE FROM import_objects WHERE session_id=? AND storage_key=?').bind(session.id,obj.storage_key).run();
  }
  if (results.length===15) return json({ok:true,remaining:true});
  await c.db.prepare('DELETE FROM import_sessions WHERE id=?').bind(session.id).run();
  return json({ok:true,remaining:false});
}

export async function backup(c:Context):Promise<Response|undefined> {
  const path = c.url.pathname;
  const method = c.req.method;
  if (path === '/api/backups' && method==='GET') return json((await c.db.prepare('SELECT * FROM backup_records ORDER BY created_at DESC LIMIT 20').all()).results);
  if (path === '/api/export' && method==='GET') return exportZip(c);
  if (path === '/api/export/table' && method==='GET') return json(await copyPage(c,tableName(c.url.searchParams.get('name') ?? ''),Math.max(0,Number(c.url.searchParams.get('cursor'))||0)));
  if (path === '/api/export/info' && method==='GET') {
    const revision = await c.db.prepare("SELECT (SELECT count(*) FROM activity_log) AS actions,(SELECT max(created_at) FROM activity_log) AS last,(SELECT max(updated_at) FROM app_settings) AS settings,(SELECT count(*) FROM media_assets) AS objects,(SELECT max(created_at) FROM media_assets) AS media").first();
    return json({format:1,tables,revision});
  }
  if (path === '/api/export/done' && method==='POST') {
    const {objects} = await body(c);
    if (!Number.isSafeInteger(objects) || objects<0) fail(400,'Неверное число объектов.');
    await record(c,'success',objects,'Командная строка');
    return json({ok:true});
  }
  if (path === '/api/export/object' && method==='GET') {
    const key = c.url.searchParams.get('key') ?? '';
    if (!objectKey.test(key) || !await c.db.prepare('SELECT id FROM media_assets WHERE storage_key=? OR preview_storage_key=?').bind(key,key).first()) fail(404,'Объект не найден.');
    const result = await c.env.MEDIA.get(key);
    if (!result) fail(404,'Не удалось прочитать оригинал.');
    return new Response(result.body,{headers:{'Content-Type':'application/octet-stream','Content-Length':String(result.size),'Cache-Control':'no-store'}});
  }
  if (path === '/api/import' && method==='POST') return begin(c);
  const match = /^\/api\/import\/([^/]+)(\/(rows|object|complete))?$/.exec(path);
  if (!match) return;
  const session = await getSession(c,match[1]);
  if (method==='POST' && match[3]==='rows') return stageRows(c,session);
  if (method==='PUT' && match[3]==='object') return putObject(c,session,c.url.searchParams.get('key') ?? '',Number(c.url.searchParams.get('part')));
  if (method==='POST' && match[3]==='complete') return commit(c,session);
  if (method==='DELETE' && !match[3]) return cancel(c,session);
}
