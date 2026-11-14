import { z } from 'zod';
import { activity, body, fail, id, json, now, VERSION, type Context } from './core';

const owners = {category:'categories',publication:'publications',idea:'ideas'} as const;
const types = z.enum(['category','publication','idea','attachment','cover']);
type Kind = z.infer<typeof types>;
const archiveSchema = z.object({ id:z.string().min(1), action:z.enum(['keep','metadata','media','trash']) });
const activeMedia = `SELECT pm.media_id FROM publication_media pm JOIN publications p ON p.id=pm.publication_id WHERE pm.deleted_at IS NULL AND p.deleted_at IS NULL
  UNION SELECT im.media_id FROM idea_media im JOIN ideas i ON i.id=im.idea_id WHERE im.deleted_at IS NULL AND i.deleted_at IS NULL
  UNION SELECT cover_media_id FROM publications WHERE deleted_at IS NULL
  UNION SELECT media_id FROM (
    SELECT cover_media_id AS media_id FROM ideas WHERE deleted_at IS NULL
    UNION SELECT cover_media_id FROM categories WHERE deleted_at IS NULL
    UNION SELECT media_id FROM owner_covers WHERE deleted_at IS NULL AND owner_type='logo'
  )`;
const unreferenced = `NOT EXISTS(SELECT 1 FROM publication_media WHERE media_id=m.id)
  AND NOT EXISTS(SELECT 1 FROM idea_media WHERE media_id=m.id)
  AND NOT EXISTS(SELECT 1 FROM owner_covers WHERE media_id=m.id)
  AND NOT EXISTS(SELECT 1 FROM categories WHERE cover_media_id=m.id)
  AND NOT EXISTS(SELECT 1 FROM publications WHERE cover_media_id=m.id)
  AND NOT EXISTS(SELECT 1 FROM ideas WHERE cover_media_id=m.id)
  AND NOT EXISTS(SELECT 1 FROM app_settings WHERE key='studio' AND json_extract(value,'$.logo_media_id')=m.id)`;
type TrashItem = {id:string; type:Kind; name:string; deleted_at:string; group?:string; owner_type?:string};
const trashSQL = `
SELECT id,'category' AS type,name,deleted_at,trash_group AS "group",'category' AS owner_type FROM categories WHERE deleted_at IS NOT NULL
UNION ALL SELECT id,'publication',title,deleted_at,trash_group,'publication' FROM publications WHERE deleted_at IS NOT NULL
UNION ALL SELECT id,'idea',title,deleted_at,trash_group,'idea' FROM ideas WHERE deleted_at IS NOT NULL
UNION ALL SELECT * FROM (
SELECT a.id,'attachment',m.original_filename,a.deleted_at,NULL,'publication' FROM publication_media a JOIN media_assets m ON m.id=a.media_id WHERE a.deleted_at IS NOT NULL
UNION ALL SELECT a.id,'attachment',m.original_filename,a.deleted_at,NULL,'idea' FROM idea_media a JOIN media_assets m ON m.id=a.media_id WHERE a.deleted_at IS NOT NULL
UNION ALL SELECT a.id,'cover',m.original_filename,a.deleted_at,NULL,a.owner_type FROM owner_covers a JOIN media_assets m ON m.id=a.media_id WHERE a.deleted_at IS NOT NULL)
`;

async function collectOrphans(c: Context) {
  const timestamp = now();
  await c.db.batch([
    c.db.prepare(`INSERT OR IGNORE INTO media_cleanup SELECT m.storage_key,? FROM media_assets m WHERE ${unreferenced}`).bind(timestamp),
    c.db.prepare(`INSERT OR IGNORE INTO media_cleanup SELECT m.preview_storage_key,? FROM media_assets m WHERE m.preview_storage_key IS NOT NULL AND ${unreferenced}`).bind(timestamp),
    c.db.prepare(`DELETE FROM media_assets AS m WHERE ${unreferenced}`)
  ]);
  const {results} = await c.db.prepare('SELECT storage_key FROM media_cleanup ORDER BY created_at LIMIT 25').all<{storage_key:string}>();
  if (!results.length) return;
  await c.env.MEDIA.delete(results.map(row=>row.storage_key));
  await c.db.prepare(`DELETE FROM media_cleanup WHERE storage_key IN (SELECT value FROM json_each(?))`).bind(JSON.stringify(results.map(row=>row.storage_key))).run();
}

async function trashAction(c: Context, type: Kind, entityId: string, restore: boolean) {
  const item = await c.db.prepare(`SELECT * FROM (${trashSQL}) WHERE type=? AND id=?`).bind(type,entityId).first<TrashItem>();
  if (!item) fail(404,'Объект в корзине не найден.');
  const timestamp = now();
  const stmts: D1PreparedStatement[] = [];
  if (type === 'attachment') {
    const isIdea = item.owner_type === 'idea';
    const parent = isIdea ? 'ideas' : 'publications';
    const key = isIdea ? 'idea_id' : 'publication_id';
    const table = isIdea ? 'idea_media' : 'publication_media';
    if (restore) {
      const active = await c.db.prepare(`SELECT p.deleted_at FROM ${parent} p JOIN ${table} m ON p.id=m.${key} WHERE m.id=?`).bind(entityId).first<{deleted_at:string|null}>();
      if (!active || active.deleted_at) fail(409,'Сначала восстановите карточку, к которой прикреплён файл.');
      stmts.push(c.db.prepare(`UPDATE ${parent} SET version=version+1,updated_at=? WHERE id=(SELECT ${key} FROM ${table} WHERE id=?) AND deleted_at IS NULL`).bind(timestamp,entityId));
      stmts.push(c.db.prepare(`UPDATE ${table} SET deleted_at=NULL WHERE id=? AND EXISTS(SELECT 1 FROM ${parent} p WHERE p.id=${table}.${key} AND p.deleted_at IS NULL)`).bind(entityId));
    } else stmts.push(c.db.prepare(`DELETE FROM ${table} WHERE id=? AND deleted_at IS NOT NULL`).bind(entityId));
  } else if (type === 'cover') {
    const cover = await c.db.prepare('SELECT owner_type,owner_id,media_id FROM owner_covers WHERE id=?').bind(entityId).first<{owner_type:string;owner_id:string;media_id:string}>();
    if (!cover) fail(404,'Обложка отсутствует.');
    if (!restore) stmts.push(c.db.prepare('DELETE FROM owner_covers WHERE id=? AND deleted_at IS NOT NULL').bind(entityId));
    else {
      if (cover.owner_type === 'category' && !await c.db.prepare('SELECT id FROM categories WHERE id=? AND deleted_at IS NULL').bind(cover.owner_id).first()) {
        fail(409,'Сначала восстановите рубрику.');
      }
      stmts.push(c.db.prepare('UPDATE owner_covers SET deleted_at=? WHERE owner_type=? AND owner_id=? AND deleted_at IS NULL').bind(timestamp,cover.owner_type,cover.owner_id));
      stmts.push(c.db.prepare('UPDATE owner_covers SET deleted_at=NULL WHERE id=?').bind(entityId));
      if (cover.owner_type === 'category') stmts.push(c.db.prepare('UPDATE categories SET cover_media_id=?,version=version+1,updated_at=? WHERE id=? AND deleted_at IS NULL').bind(cover.media_id,timestamp,cover.owner_id));
      else stmts.push(c.db.prepare("UPDATE app_settings SET value=json_set(value,'$.logo_media_id',?),updated_at=? WHERE key='studio'").bind(cover.media_id,timestamp));
    }
  } else {
    const table = owners[type];
    if (type === 'category' && item.group) {
      if (restore) {
        stmts.push(c.db.prepare('UPDATE categories SET parent_id=NULL WHERE id=? AND parent_id IN (SELECT id FROM categories WHERE deleted_at IS NOT NULL AND coalesce(trash_group,\'\')<>?)').bind(entityId,item.group));
        for (const owner of ['categories','publications','ideas']) {
          stmts.push(c.db.prepare(`UPDATE ${owner} SET deleted_at=NULL,trash_group=NULL,version=version+1,updated_at=? WHERE trash_group=?`).bind(timestamp,item.group));
        }
      } else {
        stmts.push(c.db.prepare("DELETE FROM owner_covers WHERE owner_type='category' AND owner_id IN (SELECT id FROM categories WHERE trash_group=?)").bind(item.group));
        for (const owner of ['publications','ideas','categories']) {
          stmts.push(c.db.prepare(`DELETE FROM ${owner} WHERE trash_group=? AND deleted_at IS NOT NULL`).bind(item.group));
        }
      }
    } else if (restore) {
      const locator = type === 'category' ? 'parent_id' : 'category_id';
      stmts.push(c.db.prepare(`UPDATE ${table} SET ${locator}=CASE WHEN ${locator} IN (SELECT id FROM categories WHERE deleted_at IS NULL) THEN ${locator} ELSE NULL END,deleted_at=NULL,trash_group=NULL,version=version+1,updated_at=? WHERE id=? AND deleted_at IS NOT NULL`).bind(timestamp,entityId));
    } else {
      if (type === 'category') stmts.push(c.db.prepare("DELETE FROM owner_covers WHERE owner_type='category' AND owner_id=?").bind(entityId));
      stmts.push(c.db.prepare(`DELETE FROM ${table} WHERE id=? AND deleted_at IS NOT NULL`).bind(entityId));
    }
  }
  await c.db.batch([...stmts, activity(c,restore?'Восстановлено из корзины':'Удалено окончательно',type,entityId)]);
  if (!restore) await collectOrphans(c);
}

export async function maintenance(c: Context) {
  const config = await c.db.prepare("SELECT json_extract(value,'$.trash_days') AS period FROM app_settings WHERE key='studio'").first<{period:number}>();
  if ((config?.period ?? 0) > 0) {
    const cutoff = new Date(Date.now() - config!.period * 86400000).toISOString();
    // A single batch preserves the links of records that have yet to expire.
    await c.db.batch([
      c.db.prepare('DELETE FROM publication_media WHERE deleted_at < ?').bind(cutoff),
      c.db.prepare('DELETE FROM idea_media WHERE deleted_at < ?').bind(cutoff),
      c.db.prepare("DELETE FROM owner_covers WHERE deleted_at < ? OR (owner_type='category' AND owner_id IN (SELECT id FROM categories WHERE deleted_at < ?))").bind(cutoff,cutoff),
      ...['ideas','publications','categories'].map(table=>c.db.prepare(`DELETE FROM ${table} WHERE deleted_at < ?`).bind(cutoff))
    ]);
  }
  await collectOrphans(c);
}

async function getArchiveSuggestions(c: Context) {
  const config = await c.db.prepare("SELECT json_extract(value,'$.archive_limit') AS n FROM app_settings WHERE key='studio'").first<{n:number}>();
  const limit = config?.n ?? 3;
  const {results} = await c.db.prepare(`
    WITH ranked AS (
      SELECT p.*, row_number() OVER(PARTITION BY category_id ORDER BY coalesce(published_at,updated_at) DESC,id) n
      FROM publications p WHERE p.deleted_at IS NULL AND (p.status_id='published' OR p.published_at IS NOT NULL)
    )
    SELECT r.* FROM ranked r WHERE n>? AND NOT EXISTS(SELECT 1 FROM archive_exceptions a WHERE a.publication_id=r.id)
    AND EXISTS(SELECT 1 FROM publication_media m WHERE m.publication_id=r.id AND m.deleted_at IS NULL)
    ORDER BY coalesce(published_at,updated_at) LIMIT 100`).bind(limit).all();
  return json({limit,items:results});
}
async function archiveAction(c:Context) {
  const data = archiveSchema.safeParse(await body(c));
  if (!data.success) fail(400,'Выберите публикацию и действие.');
  const {id:entityId,action} = data.data;
  const entity = await c.db.prepare("SELECT id FROM publications WHERE id=? AND deleted_at IS NULL AND (status_id='published' OR published_at IS NOT NULL)").bind(entityId).first();
  if (!entity) fail(404,'Опубликованная запись не найдена.');
  const timestamp = now();
  const stmts: D1PreparedStatement[] = [];
  if (action === 'keep') stmts.push(c.db.prepare('INSERT OR IGNORE INTO archive_exceptions VALUES(?,?)').bind(entityId,timestamp));
  if (action === 'trash') stmts.push(c.db.prepare('UPDATE publications SET deleted_at=?,updated_at=?,version=version+1 WHERE id=? AND deleted_at IS NULL').bind(timestamp,timestamp,entityId));
  if (action === 'metadata' || action === 'media') {
    stmts.push(c.db.prepare('UPDATE publication_media SET deleted_at=? WHERE publication_id=? AND deleted_at IS NULL').bind(timestamp,entityId));
    stmts.push(c.db.prepare(`UPDATE publications SET cover_media_id=NULL,updated_at=?,version=version+1${action === 'metadata' ? ",status_id='archived'" : ''} WHERE id=? AND deleted_at IS NULL`).bind(timestamp,entityId));
  }
  await c.db.batch([...stmts,activity(c,'Обновлено хранение публикации','publication',entityId)]);
  return json({ok:true});
}

async function health(c: Context, write = false) {
  const check = async (task: () => Promise<unknown>) => {
    try { await task(); return {ok:true}; } catch { return {ok:false}; }
  };
  const database = check(() => c.db.prepare('SELECT 1').first());
  const storage = check(async () => {
    if (!write) return c.env.MEDIA.list({limit:1});
    const key = `diagnostics/${id()}`;
    try {
      await c.env.MEDIA.put(key,'remake-ai-studio');
      const object = await c.env.MEDIA.get(key);
      if (await object?.text() !== 'remake-ai-studio') throw new Error('bad probe');
    } finally { await c.env.MEDIA.delete(key); }
  });
  const [db,bucket] = await Promise.all([database,storage]);
  return {database:db,storage:bucket};
}

async function summary(c: Context) {
  const statuses = await health(c);
  const result = { ...statuses, version:VERSION, usage:{originals:0,previews:0,images:0,videos:0,trash:0,count:0}, categories:[] as unknown[], largest:[] as unknown[], backup:null as unknown, errors:[] as unknown[] };
  if (!statuses.database.ok) return json(result);
  const [usage,categories,largest,backup,errors] = await c.db.batch([
    c.db.prepare(`SELECT count(*) count,coalesce(sum(file_size),0) originals,coalesce(sum(preview_size),0) previews,
      coalesce(sum(CASE WHEN media_type='image' THEN file_size ELSE 0 END),0) images,
      coalesce(sum(CASE WHEN media_type='video' THEN file_size ELSE 0 END),0) videos,
      coalesce(sum(CASE WHEN id NOT IN (SELECT media_id FROM (${activeMedia}) WHERE media_id IS NOT NULL) THEN file_size+preview_size ELSE 0 END),0) trash
      FROM media_assets`),
    c.db.prepare(`WITH RECURSIVE tree(root,child) AS (
      SELECT id,id FROM categories WHERE deleted_at IS NULL UNION ALL
      SELECT tree.root,c.id FROM tree JOIN categories c ON c.parent_id=tree.child AND c.deleted_at IS NULL
    ), links AS (
      SELECT category_id,pm.media_id FROM publications p JOIN publication_media pm ON pm.publication_id=p.id AND pm.deleted_at IS NULL WHERE p.deleted_at IS NULL
      UNION SELECT category_id,im.media_id FROM ideas i JOIN idea_media im ON im.idea_id=i.id AND im.deleted_at IS NULL WHERE i.deleted_at IS NULL
      UNION SELECT id,cover_media_id FROM categories WHERE deleted_at IS NULL AND cover_media_id IS NOT NULL
    ), unique_media AS (SELECT DISTINCT tree.root,links.media_id FROM tree JOIN links ON links.category_id=tree.child)
    SELECT c.id,c.name,coalesce(sum(m.file_size+m.preview_size),0) bytes FROM categories c
    LEFT JOIN unique_media u ON u.root=c.id LEFT JOIN media_assets m ON m.id=u.media_id
    WHERE c.deleted_at IS NULL GROUP BY c.id ORDER BY bytes DESC,c.sort_order LIMIT 200`),
    c.db.prepare(`WITH unique_media AS (SELECT DISTINCT publication_id,media_id FROM publication_media WHERE deleted_at IS NULL)
    SELECT p.id,p.title,sum(m.file_size+m.preview_size) bytes FROM unique_media u JOIN publications p ON p.id=u.publication_id
    JOIN media_assets m ON m.id=u.media_id WHERE p.deleted_at IS NULL GROUP BY p.id ORDER BY bytes DESC LIMIT 20`),
    c.db.prepare('SELECT * FROM backup_records ORDER BY created_at DESC LIMIT 1'),
    c.db.prepare("SELECT id,action,detail,created_at FROM storage_operations WHERE status='error' ORDER BY created_at DESC LIMIT 15")
  ]);
  return json({...result,usage:usage.results[0] ?? result.usage,categories:categories.results,largest:largest.results,backup:backup.results[0] ?? null,errors:errors.results});
}
export async function system(c: Context): Promise<Response|undefined> {
  const path = c.url.pathname;
  const method = c.req.method;
  if (path === '/api/system' && method === 'GET') return summary(c);
  if (path === '/api/system/diagnose' && method === 'POST') return json(await health(c,true));
  if (path === '/api/system/archive' && method === 'GET') return getArchiveSuggestions(c);
  if (path === '/api/system/archive' && method === 'POST') return archiveAction(c);
  if (path === '/api/system/cleanup' && method === 'POST') {
    if (!(await body(c)).confirm) fail(400,'Подтвердите очистку.');
    await maintenance(c);
    return json({ok:true});
  }
  if (path === '/api/trash' && method === 'GET') {
    const {results} = await c.db.prepare(`SELECT * FROM (${trashSQL}) ORDER BY deleted_at DESC`).all();
    return json(results);
  }
  const match = /^\/api\/trash\/([^/]+)\/([^/]+)(\/restore)?$/.exec(path);
  if (match && ((method === 'POST' && match[3]) || (method === 'DELETE' && !match[3]))) {
    const kind = types.safeParse(match[1]);
    if (!kind.success) fail(404,'Тип объекта неизвестен.');
    if (method === 'DELETE' && (await body(c)).confirm !== true) fail(400,'Подтвердите окончательное удаление.');
    await trashAction(c,kind.data,match[2],method === 'POST');
    return json({ok:true});
  }
}
