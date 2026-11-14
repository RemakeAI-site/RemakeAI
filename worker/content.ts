import { z } from 'zod';
import { activity, body, fail, id, json, now, type Context } from './core';
import { coverReferences } from './media';

type Value = string | number | null;
type Row = Record<string, unknown>;
type Entity = 'categories' | 'publications' | 'ideas';

const uuid = z.string().min(1).max(128);
const color = z.string().regex(/^#[\da-f]{6}$/i);
const name = z.string().trim().min(1).max(200);
const largeText = z.string().max(65_536);
const date = z.string().datetime({ offset: true }).transform((value) => new Date(value).toISOString());
const status = z.enum(['draft', 'review', 'ready', 'scheduled', 'published', 'archived']);
const ideaStatus = z.enum(['new', 'developing', 'selected', 'realized', 'archived']);
const priority = z.enum(['low', 'medium', 'high']);
const favorite = z.union([z.boolean(), z.literal(0), z.literal(1)]).transform(Number);
const version = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const confirmation = z.object({ version });
const url = z.string().max(2048).url().refine((value) => /^https?:\/\//i.test(value), 'Допустимы только ссылки HTTP и HTTPS.');
const optionalUrl = z.union([url, z.literal(''), z.null().transform(() => '')]);

const categoryInput = z.object({
  name, description: largeText, parent_id: uuid.nullable(), icon: z.string().max(64), color,
  sort_order: z.number().int().min(-1_000_000).max(1_000_000), is_hidden: favorite, is_archived: favorite,
  description_limit: z.number().int().positive().max(100_000).nullable(), cover_media_id: uuid.nullable(),
});
const publicationInput = z.object({
  title: name, description: largeText, category_id: uuid.nullable(), hashtags: z.string().max(10_000), status_id: status,
  scenario: largeText, notes: largeText, scheduled_at: date.nullable(), published_at: date.nullable(),
  tiktok_url: optionalUrl, is_favorite: favorite,
  custom_fields: z.record(uuid, z.union([z.string().max(10_000), z.number().finite(), z.boolean(), z.null()])),
  cover_media_id: uuid.nullable(),
});
const ideaInput = z.object({
  title: name, description: largeText, category_id: uuid.nullable(), status: ideaStatus, priority,
  scenario: largeText, notes: largeText, links: z.array(url).max(100), is_favorite: favorite,
});
const fieldType = z.enum(['text', 'number', 'date', 'boolean', 'select', 'url']);
const fieldInput = z.object({
  name, type: fieldType, options: z.array(z.string().trim().min(1).max(200)).max(100),
  sort_order: z.number().int().min(-1_000_000).max(1_000_000),
});
const settingsInput = z.object({
  name, logo_media_id: uuid.nullable(), accent: color, theme: z.enum(['dark', 'light', 'system']),
  density: z.enum(['comfortable', 'compact']), text_limit: z.number().int().positive().max(100_000),
  archive_limit: z.number().int().min(0).max(100_000), trash_days: z.number().int().min(1).max(3650),
  timezone: z.string().min(1).max(100).refine((zone) => {
    try { new Intl.DateTimeFormat('ru', { timeZone: zone }); return true; } catch { return false; }
  }, 'Укажите известный часовой пояс IANA.'), date_format: z.enum(['dd.MM.yyyy', 'yyyy-MM-dd', 'd MMM yyyy']),
  storage_limit: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  storage_warn: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  indicator_basis: z.enum(['ready', 'unpublished', 'all', 'published']),
  red_max: z.number().int().min(0).max(100_000), yellow_max: z.number().int().min(1).max(100_001),
  green_min: z.number().int().min(2).max(100_002), red_color: color, yellow_color: color, green_color: color,
});

type Settings = z.output<typeof settingsInput>;
type Category = Row & { id: string; parent_id: string | null; name: string; version: number; search_text: string };
type CategoryCounts = { id: string; ready_count: number; total_count: number; published_count: number; idea_count: number };
type Publication = Row & { id: string; status_id: z.infer<typeof status>; version: number; published_at: string | null; title: string; description: string; hashtags: string };
type Idea = Row & { id: string; version: number; publication_id: string | null; title: string; description: string; links: string };
type Field = Row & { id: string; type: z.infer<typeof fieldType>; options: string; name: string };

const readySql = `status_id = 'ready' AND published_at IS NULL`;
const publishedSql = `(status_id = 'published' OR published_at IS NOT NULL)`;
const visible = `deleted_at IS NULL`;

function sql(c: Context, text: string, ...params: Value[]) {
  return c.db.prepare(text).bind(...params);
}

async function rows<T = Row>(c: Context, text: string, ...params: Value[]): Promise<T[]> {
  return (await sql(c, text, ...params).all<T>()).results;
}

async function one<T = Row>(c: Context, text: string, ...params: Value[]): Promise<T> {
  const result = await sql(c, text, ...params).first<T>();
  if (!result) fail(404, 'Запись не найдена.');
  return result;
}

async function readBody<T extends z.ZodType>(c: Context, schema: T): Promise<z.output<T>> {
  const parsed = schema.safeParse(await body(c));
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0];
  fail(400, `Проверьте поля формы${issue?.path.length ? ` (${issue.path.join('.')})` : ''}.`, 'INVALID_INPUT');
}

function readDateParam(c: Context, key: string): string | null {
  const value = c.url.searchParams.get(key);
  if (!value) return null;
  const parsed = date.safeParse(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00Z` : value);
  if (!parsed.success) fail(400, `Некорректная дата: ${key}.`);
  return parsed.data;
}

function readInteger(c: Context, key: string, fallback: number, minimum: number, maximum: number): number {
  const param = c.url.searchParams.get(key);
  if (param === null || param === '') return fallback;
  const value = Number(param);
  if (!Number.isSafeInteger(value) || value < minimum) fail(400, `Некорректное число: ${key}.`);
  return Math.min(value, maximum);
}

function normalize(...parts: string[]) {
  return parts.join('\n').normalize('NFKC').toLocaleLowerCase('ru').replaceAll('ё', 'е');
}

function queryText(c: Context): string {
  return normalize((c.url.searchParams.get('q') ?? '').trim().slice(0, 256));
}

async function ensureCategory(c: Context, key?: string | null) {
  if (key) await one(c, `SELECT id FROM categories WHERE id = ? AND ${visible}`, key);
}

async function ensureImage(c: Context, key?: string | null) {
  if (key) await one(c, `SELECT id FROM media_assets WHERE id = ? AND media_type = 'image' AND ${visible}`, key);
}

async function ensureOwnedImage(c: Context, key: string, mediaId?: string | null) {
  if (mediaId) await one(c, `SELECT a.id FROM publication_media AS a JOIN media_assets AS m ON m.id = a.media_id
    WHERE a.publication_id = ? AND a.media_id = ? AND a.deleted_at IS NULL AND m.deleted_at IS NULL AND m.media_type = 'image'`, key, mediaId);
}

type Condition = { sql: string; args: Value[] };
const noCondition: Condition = { sql: '1 = 1', args: [] };

function existingCategory(value?: string | null): Condition {
  return value ? { sql: 'EXISTS (SELECT 1 FROM categories WHERE id = ? AND deleted_at IS NULL)', args: [value] } : noCondition;
}

function existingImage(value?: string | null): Condition {
  return value ? { sql: `EXISTS (SELECT 1 FROM media_assets WHERE id = ? AND deleted_at IS NULL AND media_type = 'image')`, args: [value] } : noCondition;
}

function insert(c: Context, table: Entity | 'custom_field_definitions', values: Record<string, Value>, check = noCondition) {
  const fields = Object.keys(values);
  return sql(c, `INSERT INTO ${table} (${fields.join(', ')}) SELECT ${fields.map(() => '?').join(', ')} WHERE ${check.sql}`,
    ...Object.values(values), ...check.args);
}

function createActivity(c: Context, table: Entity, key: string, label: string) {
  return sql(c, `INSERT INTO activity_log (id, action, entity_type, entity_id, created_at)
    SELECT ?, ?, ?, id, ? FROM ${table} WHERE id = ?`, id(), label, table, now(), key);
}

function update(c: Context, table: Entity | 'publication_statuses' | 'custom_field_definitions', values: Record<string, Value>, where: string, ...whereValues: Value[]) {
  return sql(c, `UPDATE ${table} SET ${Object.keys(values).map((key) => `${key} = ?`).join(', ')} WHERE ${where}`, ...Object.values(values), ...whereValues);
}

async function requireMutation(c: Context, statements: D1PreparedStatement[], index = 0) {
  const result = await c.db.batch(statements);
  if (result[index].meta.changes < 1) fail(409, 'Запись изменилась на другом устройстве. Откройте свежую версию и повторите действие.', 'EDIT_CONFLICT');
}

function guardMutation(c: Context, entity: Entity, key: string, expectedVersion: number, label: string, predicate = '1 = 1', extra: Value[] = []) {
  const guardId = id();
  const event = sql(c, `INSERT INTO activity_log (id, action, entity_type, entity_id, created_at)
    SELECT ?, ?, ?, id, ? FROM ${entity} WHERE id = ? AND version = ? AND ${visible} AND (${predicate})`,
    guardId, label, entity, now(), key, expectedVersion, ...extra);
  return { event, guardId, gate: 'EXISTS (SELECT 1 FROM activity_log WHERE id = ?)' };
}

async function readSettings(c: Context): Promise<Settings> {
  return JSON.parse((await one<{ value: string }>(c, `SELECT value FROM app_settings WHERE key = 'studio'`)).value) as Settings;
}

function subtree(rootSql = '?') {
  return `WITH RECURSIVE tree(id) AS (
    SELECT id FROM categories WHERE id = ${rootSql} AND deleted_at IS NULL
    UNION
    SELECT child.id FROM categories AS child JOIN tree ON child.parent_id = tree.id WHERE child.deleted_at IS NULL
  )`;
}

function pathFor(category: Category, byId: Map<string, Category>): string[] {
  const path = [category.name];
  const visited = new Set([category.id]);
  let parent = category.parent_id;
  while (parent && !visited.has(parent)) {
    visited.add(parent);
    const node = byId.get(parent);
    if (!node) break;
    path.push(node.name);
    parent = node.parent_id;
  }
  return path.reverse();
}

async function listCategories(c: Context) {
  const [all, counts, settings] = await Promise.all([
    rows<Category>(c, `SELECT * FROM categories WHERE ${visible} ORDER BY sort_order, name, id`),
    rows<CategoryCounts>(c, `WITH RECURSIVE closure(root_id, category_id) AS (
      SELECT id, id FROM categories WHERE deleted_at IS NULL
      UNION
      SELECT closure.root_id, child.id FROM closure JOIN categories AS child ON child.parent_id = closure.category_id WHERE child.deleted_at IS NULL
    ), publication_counts AS (
      SELECT closure.root_id, count(p.id) AS total_count,
        count(p.id) FILTER (WHERE ${readySql}) AS ready_count,
        count(p.id) FILTER (WHERE ${publishedSql}) AS published_count
      FROM closure LEFT JOIN publications AS p ON p.category_id = closure.category_id AND p.deleted_at IS NULL GROUP BY closure.root_id
    ), idea_counts AS (
      SELECT closure.root_id, count(i.id) AS idea_count
      FROM closure LEFT JOIN ideas AS i ON i.category_id = closure.category_id AND i.deleted_at IS NULL GROUP BY closure.root_id
    ) SELECT c.root_id AS id,c.ready_count,c.total_count,c.published_count,i.idea_count
      FROM publication_counts AS c JOIN idea_counts AS i ON i.root_id = c.root_id`),
    readSettings(c),
  ]);
  const byId = new Map(all.map((item) => [item.id, item]));
  const countById = new Map(counts.map((item) => [item.id, item]));
  const q = queryText(c);
  return all.filter((row) => !q || normalize(row.name, String(row.description ?? '')).includes(q)).map((row) => {
    const { id: _key, ...count } = countById.get(row.id) ?? { id: row.id, ready_count: 0, total_count: 0, published_count: 0, idea_count: 0 };
    const amount = {
      ready: count.ready_count, unpublished: count.total_count - count.published_count, all: count.total_count, published: count.published_count,
    }[settings.indicator_basis];
    const level = amount >= settings.green_min ? 'green' : amount > settings.red_max ? 'yellow' : 'red';
    const label = { ready: 'готовых', unpublished: 'неопубликованных', all: 'всего', published: 'опубликованных' }[settings.indicator_basis];
    return { ...row, ...count, path: pathFor(row, byId), indicator_count: amount,
      indicator_color: settings[`${level}_color`], indicator_label: `${amount} ${label}` };
  });
}

async function categoryRoutes(c: Context, key?: string) {
  const method = c.req.method;
  if (!key && method === 'GET') return json(await listCategories(c));
  if (!key && method === 'POST') {
    const data = await readBody(c, categoryInput.partial().required({ name: true }));
    await Promise.all([ensureCategory(c, data.parent_id), ensureImage(c, data.cover_media_id)]);
    const categoryId = id();
    const timestamp = now();
    const order = data.sort_order ?? (await one<{ next_order: number }>(c,
      'SELECT COALESCE(MAX(sort_order), -1) + 1 AS next_order FROM categories WHERE parent_id IS ? AND deleted_at IS NULL', data.parent_id ?? null)).next_order;
    const parent = existingCategory(data.parent_id);
    const cover = existingImage(data.cover_media_id);
    await requireMutation(c, [insert(c, 'categories', { ...data, id: categoryId, slug: categoryId, sort_order: order,
      created_at: timestamp, updated_at: timestamp, search_text: normalize(data.name, data.description ?? '') }, { sql: `${parent.sql} AND ${cover.sql}`, args: [...parent.args, ...cover.args] }),
    ...(data.cover_media_id ? coverReferences(c, 'category', categoryId, data.cover_media_id, timestamp, existingCategory(categoryId)) : []),
    createActivity(c, 'categories', categoryId, 'Создана рубрика')]);
    return json(await one(c, 'SELECT * FROM categories WHERE id = ?', categoryId), 201);
  }
  if (!key) return;
  const current = await one<Category>(c, `SELECT * FROM categories WHERE id = ? AND ${visible}`, key);
  if (method === 'GET') return json(current);
  if (method === 'PATCH') {
    const { version: expected, ...data } = await readBody(c, categoryInput.partial().extend({ version }));
    await Promise.all([ensureCategory(c, data.parent_id), ensureImage(c, data.cover_media_id)]);
    if (data.parent_id && await sql(c, `${subtree()} SELECT id FROM tree WHERE id = ?`, key, data.parent_id).first()) {
      fail(409, 'Нельзя переместить рубрику внутрь её собственной структуры.', 'CATEGORY_CYCLE');
    }
    const move = data.parent_id ? `EXISTS (SELECT 1 FROM categories WHERE id = ? AND deleted_at IS NULL)
      AND ? NOT IN (WITH RECURSIVE lineage(id) AS (
      SELECT id FROM categories WHERE id = ? UNION SELECT c.parent_id FROM categories c JOIN lineage l ON c.id = l.id WHERE c.parent_id IS NOT NULL
    ) SELECT id FROM lineage)` : '1 = 1';
    const changeCover = data.cover_media_id !== undefined;
    const imageCheck = data.cover_media_id ? `AND EXISTS (SELECT 1 FROM media_assets WHERE id = ? AND deleted_at IS NULL AND media_type = 'image')` : '';
    const guard = guardMutation(c, 'categories', key, expected, 'Изменена рубрика', `${move} ${imageCheck}`, [
      ...(data.parent_id ? [data.parent_id, key, data.parent_id] : []), ...(data.cover_media_id ? [data.cover_media_id] : []),
    ]);
    const timestamp = now();
    const searchText = normalize(data.name ?? current.name, data.description ?? String(current.description ?? ''));
    const coverUpdates = changeCover ? coverReferences(c, 'category', key, data.cover_media_id ?? null, timestamp, { sql: guard.gate, args: [guard.guardId] }) : [];
    await requireMutation(c, [guard.event, update(c, 'categories', { ...data, version: expected + 1,
      updated_at: timestamp, search_text: searchText }, `id = ? AND ${guard.gate}`, key, guard.guardId), ...coverUpdates]);
    return json(await one(c, 'SELECT * FROM categories WHERE id = ?', key));
  }
  if (method !== 'DELETE') return;
  const data = await readBody(c, confirmation.extend({ mode: z.enum(['trash', 'move', 'archive']), target_id: uuid.nullable().optional() }));
  const timestamp = now();
  const guard = guardMutation(c, 'categories', key, data.version, data.mode === 'archive' ? 'Архивирована структура рубрики' : 'Рубрика перемещена в корзину');
  if (data.mode === 'move') {
    const target = data.target_id ?? null;
    await ensureCategory(c, target);
    if (target && await sql(c, `${subtree()} SELECT id FROM tree WHERE id = ?`, key, target).first()) {
      fail(409, 'Выберите место за пределами удаляемой рубрики.', 'CATEGORY_CYCLE');
    }
    const moving = target ? `EXISTS (SELECT 1 FROM categories WHERE id = ? AND deleted_at IS NULL)
      AND ? NOT IN (WITH RECURSIVE tree(id) AS (SELECT id FROM categories WHERE id = ? UNION SELECT c.id FROM categories c JOIN tree t ON c.parent_id = t.id WHERE c.deleted_at IS NULL) SELECT id FROM tree)` : '1 = 1';
    const moveGuard = guardMutation(c, 'categories', key, data.version, 'Рубрика перемещена в корзину, содержимое перенесено', moving, target ? [target, target, key] : []);
    await requireMutation(c, [moveGuard.event,
      sql(c, `UPDATE categories SET parent_id = ?, updated_at = ?, version = version + 1 WHERE parent_id = ? AND ${visible} AND ${moveGuard.gate}`, target, timestamp, key, moveGuard.guardId),
      ...(['publications', 'ideas'] as const).map((table) => sql(c, `UPDATE ${table} SET category_id = ?, updated_at = ?, version = version + 1 WHERE category_id = ? AND ${visible} AND ${moveGuard.gate}`, target, timestamp, key, moveGuard.guardId)),
      update(c, 'categories', { deleted_at: timestamp, trash_group: id(), updated_at: timestamp, version: data.version + 1 }, `id = ? AND ${moveGuard.gate}`, key, moveGuard.guardId),
    ]);
  } else if (data.mode === 'trash') {
    const group = id();
    const cascade = (table: Entity) => sql(c, `${subtree()}
      UPDATE ${table} SET deleted_at = ?, trash_group = ?, updated_at = ?, version = version + 1
      WHERE ${table === 'categories' ? 'id' : 'category_id'} IN (SELECT id FROM tree) AND ${visible} AND ${guard.gate}`,
    key, timestamp, group, timestamp, guard.guardId);
    await requireMutation(c, [guard.event, cascade('publications'), cascade('ideas'), cascade('categories')]);
  } else {
    const cascade = (table: Entity, change: string) => sql(c, `${subtree()}
      UPDATE ${table} SET ${change}, updated_at = ?, version = version + 1
      WHERE ${table === 'categories' ? 'id' : 'category_id'} IN (SELECT id FROM tree) AND ${visible} AND ${guard.gate}`,
    key, timestamp, guard.guardId);
    await requireMutation(c, [guard.event, cascade('publications', `status_id = 'archived'`), cascade('ideas', `status = 'archived'`), cascade('categories', 'is_archived = 1')]);
  }
  return json({ ok: true });
}

const publicationSelect = `SELECT p.*, c.name AS category_name,
  (SELECT count(*) FROM publication_media a JOIN media_assets m ON m.id = a.media_id
   WHERE a.publication_id = p.id AND a.deleted_at IS NULL AND m.deleted_at IS NULL AND m.media_type = 'image') AS photo_count,
  EXISTS (SELECT 1 FROM publication_media a JOIN media_assets m ON m.id = a.media_id
   WHERE a.publication_id = p.id AND a.deleted_at IS NULL AND m.deleted_at IS NULL AND m.media_type = 'video') AS has_video,
  COALESCE(p.cover_media_id, (SELECT m.id FROM publication_media a JOIN media_assets m ON m.id = a.media_id
   WHERE a.publication_id = p.id AND a.deleted_at IS NULL AND m.deleted_at IS NULL AND m.media_type = 'image'
   ORDER BY a.sort_order, a.id LIMIT 1)) AS preview_media_id
  FROM publications p LEFT JOIN categories c ON c.id = p.category_id`;
const ideaSelect = `SELECT i.*, c.name AS category_name FROM ideas i LEFT JOIN categories c ON c.id = i.category_id`;

async function listEntities(c: Context, entity: 'publications' | 'ideas') {
  const isPublication = entity === 'publications';
  const alias = isPublication ? 'p' : 'i';
  const select = isPublication ? publicationSelect : ideaSelect;
  const conditions = [`${alias}.deleted_at IS NULL`];
  const params: Value[] = [];
  const query = c.url.searchParams;
  const page = readInteger(c, 'page', 1, 1, 1_000_000);
  const defaultLimit = 24;
  const limit = readInteger(c, 'limit', defaultLimit, 1, 100);
  const category = query.get('category_id');
  const subcategory = query.get('subcategory_id');
  const cte = category ? subtree() : '';
  if (category) {
    params.push(category);
    conditions.push(`${alias}.category_id IN (SELECT id FROM tree)`);
  }
  if (subcategory) { conditions.push(`${alias}.category_id = ?`); params.push(subcategory); }
  const text = queryText(c);
  if (text) { conditions.push(`instr(${alias}.search_text, ?) > 0`); params.push(text); }
  if (query.get('favorite') === '1') conditions.push(`${alias}.is_favorite = 1`);

  const states = isPublication ? ['status_id'] : ['status', 'priority'];
  for (const key of states) {
    const value = query.get(key);
    if (value) { conditions.push(`${alias}.${key} = ?`); params.push(value); }
  }
  if (isPublication) {
    if (query.get('ready') === '1') conditions.push(`p.status_id = 'ready' AND p.published_at IS NULL`);
    if (query.get('archived') === '1') conditions.push(`(p.status_id IN ('published','archived') OR p.published_at IS NOT NULL)`);
    const hasDescription = query.get('has_description');
    if (hasDescription === '1' || hasDescription === '0') conditions.push(`length(trim(p.description)) ${hasDescription === '1' ? '>' : '='} 0`);
    const hasVideo = query.get('has_video');
    if (hasVideo === '1' || hasVideo === '0') conditions.push(`${hasVideo === '0' ? 'NOT ' : ''}EXISTS (
      SELECT 1 FROM publication_media a JOIN media_assets m ON m.id = a.media_id WHERE a.publication_id = p.id
      AND a.deleted_at IS NULL AND m.deleted_at IS NULL AND m.media_type = 'video')`);
    for (const [key, operator] of [['photo_min', '>='], ['photo_max', '<=']] as const) {
      if (query.get(key)) {
        conditions.push(`(SELECT count(*) FROM publication_media a JOIN media_assets m ON m.id = a.media_id
          WHERE a.publication_id = p.id AND a.deleted_at IS NULL AND m.deleted_at IS NULL AND m.media_type = 'image') ${operator} ?`);
        params.push(readInteger(c, key, 0, 0, 1_000_000));
      }
    }
    for (const [key, field, operator] of [['created_from', 'created_at', '>='], ['created_to', 'created_at', '<'],
      ['scheduled_from', 'scheduled_at', '>='], ['scheduled_to', 'scheduled_at', '<']] as const) {
      const boundary = readDateParam(c, key);
      if (boundary) { conditions.push(`p.${field} ${operator} ?`); params.push(boundary); }
    }
  }
  const sorts: Record<string, string> = {
    newest: `${alias}.created_at DESC`, oldest: `${alias}.created_at ASC`, title: `${alias}.title COLLATE NOCASE ASC`,
    updated: `${alias}.updated_at DESC`, ...(isPublication ? { scheduled: 'p.scheduled_at IS NULL, p.scheduled_at ASC' } : {}),
  };
  const sortKey = query.get('sort') ?? 'updated';
  const sort = Object.hasOwn(sorts, sortKey) ? sorts[sortKey] : sorts.updated;
  const where = conditions.join(' AND ');
  const [total, items] = await Promise.all([
    one<{ total: number }>(c, `${cte} SELECT count(*) AS total FROM ${entity} ${alias} WHERE ${where}`, ...params),
    rows(c, `${cte} ${select} WHERE ${where} ORDER BY ${sort}, ${alias}.id LIMIT ? OFFSET ?`, ...params, limit, (page - 1) * limit),
  ]);
  return { items: isPublication ? items : items.map(decodeLinks), total: total.total, page, limit };
}

function decodeLinks(row: Row) { return { ...row, links: JSON.parse(String(row.links)) as string[] }; }

async function fieldValues(c: Context, key: string) {
  const values = await rows<{ field_id: string; value: string }>(c, 'SELECT field_id, value FROM custom_field_values WHERE publication_id = ?', key);
  return Object.fromEntries(values.map((value) => [value.field_id, JSON.parse(value.value) as unknown]));
}

async function attachedMedia(c: Context, owner: 'publication' | 'idea', key: string) {
  return rows(c, `SELECT m.*, a.id AS attachment_id, a.sort_order, a.role FROM ${owner}_media a
    JOIN media_assets m ON m.id = a.media_id
    WHERE a.${owner}_id = ? AND a.deleted_at IS NULL AND m.deleted_at IS NULL ORDER BY a.sort_order, a.id`, key);
}

async function publicationDetail(c: Context, key: string) {
  const [row, media, fields] = await Promise.all([
    one<Publication>(c, `${publicationSelect} WHERE p.id = ? AND p.deleted_at IS NULL`, key),
    attachedMedia(c, 'publication', key), fieldValues(c, key),
  ]);
  return { ...row, media, custom_fields: fields };
}

async function validateValues(c: Context, values?: z.output<typeof publicationInput>['custom_fields']) {
  if (!values || Object.keys(values).length === 0) return { removed: [] as string[], written: '[]' };
  const entries = Object.entries(values);
  if (entries.length > 1_000) fail(400, 'За один запрос можно изменить до 1000 дополнительных полей.');
  const definitions = new Map((await rows<Field>(c, `SELECT id, name, type, options FROM custom_field_definitions
    WHERE id IN (SELECT value FROM json_each(?))`, JSON.stringify(Object.keys(values)))).map((value) => [value.id, value]));
  const removed: string[] = [];
  const written: string[][] = [];
  for (const [key, value] of entries) {
    const field = definitions.get(key);
    if (!field) fail(400, 'Дополнительное поле удалено. Обновите карточку.');
    if (value === null) { removed.push(key); continue; }
    const valid = {
      text: () => typeof value === 'string', number: () => typeof value === 'number', boolean: () => typeof value === 'boolean',
      select: () => typeof value === 'string' && (JSON.parse(field.options) as string[]).includes(value),
      date: () => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && date.safeParse(`${value}T00:00:00Z`).success,
      url: () => url.safeParse(value).success,
    }[field.type]();
    if (!valid) fail(400, `Проверьте значение поля «${field.name}».`, 'INVALID_CUSTOM_FIELD');
    written.push([key, JSON.stringify(value), field.type, field.options]);
  }
  if (written.length > 0 && JSON.stringify(written).length > 320_000) fail(413, 'Значения дополнительных полей слишком длинные.');
  return { removed, written: JSON.stringify(written) };
}

function unchangedDefinitions(fields: Awaited<ReturnType<typeof validateValues>>): Condition {
  return fields.written === '[]' ? noCondition : {
    sql: `NOT EXISTS (SELECT 1 FROM json_each(?) AS patch LEFT JOIN custom_field_definitions f ON f.id = json_extract(patch.value, '$[0]')
      WHERE f.type IS NOT json_extract(patch.value, '$[2]') OR f.options IS NOT json_extract(patch.value, '$[3]'))`,
    args: [fields.written],
  };
}

function writeValues(c: Context, publicationId: string, fields: Awaited<ReturnType<typeof validateValues>>, guard?: ReturnType<typeof guardMutation>) {
  const { removed, written } = fields;
  const where = guard ? `AND ${guard.gate}` : '';
  const binds = guard ? [guard.guardId] : [];
  const statements: D1PreparedStatement[] = [];
  if (removed.length) statements.push(sql(c, `DELETE FROM custom_field_values
    WHERE publication_id = ? AND field_id IN (SELECT value FROM json_each(?)) ${where}`, publicationId, JSON.stringify(removed), ...binds));
  if (written !== '[]') statements.push(sql(c, `INSERT INTO custom_field_values (publication_id, field_id, value)
    SELECT p.id, f.id, json_extract(patch.value, '$[1]') FROM json_each(?) AS patch
    JOIN custom_field_definitions f ON f.id = json_extract(patch.value, '$[0]') JOIN publications p ON p.id = ? WHERE 1 = 1 ${where}
    ON CONFLICT(publication_id, field_id) DO UPDATE SET value = excluded.value`, written, publicationId, ...binds));
  return statements;
}

function copyMedia(c: Context, from: 'idea' | 'publication', to: 'idea' | 'publication', source: string, target: string, guard?: ReturnType<typeof guardMutation>) {
  return sql(c, `INSERT INTO ${to}_media (id, ${to}_id, media_id, sort_order, role)
    SELECT lower(hex(randomblob(16))), ?, a.media_id, a.sort_order, a.role FROM ${from}_media a JOIN media_assets m ON m.id = a.media_id
    WHERE a.${from}_id = ? AND a.deleted_at IS NULL AND m.deleted_at IS NULL ${guard ? `AND ${guard.gate}` : ''}`,
  target, source, ...(guard ? [guard.guardId] : []));
}

async function duplicatePublication(c: Context, key: string) {
  const current = await one<Publication>(c, `SELECT * FROM publications WHERE id = ? AND ${visible}`, key);
  const title = `${current.title.slice(0, 191)} — копия`;
  const copy = id();
  const timestamp = now();
  const guard = guardMutation(c, 'publications', key, current.version, 'Публикация дублирована');
  await requireMutation(c, [guard.event, sql(c, `INSERT INTO publications
      (id, category_id, title, description, hashtags, status_id, scenario, notes, cover_media_id, created_at, updated_at, search_text)
      SELECT ?, category_id, ?, description, hashtags, 'draft', scenario, notes, cover_media_id, ?, ?, ?
      FROM publications WHERE id = ? AND ${guard.gate}`,
  copy, title, timestamp, timestamp, normalize(title, current.description, current.hashtags), key, guard.guardId),
  copyMedia(c, 'publication', 'publication', key, copy, guard),
  sql(c, `INSERT INTO custom_field_values (publication_id, field_id, value)
    SELECT ?, field_id, value FROM custom_field_values WHERE publication_id = ? AND ${guard.gate}`, copy, key, guard.guardId),
  ]);
  return json(await publicationDetail(c, copy), 201);
}

async function bulkPublications(c: Context) {
  const data = await readBody(c, z.object({ ids: z.array(uuid).min(1).max(96), action: z.enum(['status', 'move', 'archive', 'trash']),
    status_id: status.optional(), category_id: uuid.nullable().optional() }));
  const ids = [...new Set(data.ids)];
  const timestamp = now();
  const assignments: Record<string, Value> = { updated_at: timestamp };
  if (data.action === 'move') {
    assignments.category_id = data.category_id ?? null;
    await ensureCategory(c, data.category_id);
  }
  if (data.action === 'status') {
    if (!data.status_id) fail(400, 'Выберите статус публикаций.');
    assignments.status_id = data.status_id;
  }
  if (data.action === 'archive') assignments.status_id = 'archived';
  if (data.action === 'trash') assignments.deleted_at = timestamp;
  const check = data.action === 'move' ? existingCategory(data.category_id) : noCondition;
  const result = await c.db.batch([sql(c, `UPDATE publications SET ${Object.keys(assignments).map((key) => `${key} = ?`).join(', ')},
    ${assignments.status_id === 'published' ? 'published_at = COALESCE(published_at, ?),' : ''} version = version + 1
    WHERE id IN (SELECT value FROM json_each(?)) AND ${visible} AND ${check.sql}`, ...Object.values(assignments),
  ...(assignments.status_id === 'published' ? [timestamp] : []), JSON.stringify(ids), ...check.args),
  sql(c, `INSERT INTO activity_log (id, action, entity_type, created_at)
    SELECT ?, 'Массовое изменение публикаций', 'publications', ? WHERE changes() > 0`, id(), timestamp)]);
  if (!result[0].meta.changes) fail(409, 'Выбранные записи изменились. Обновите список.');
  return json({ count: result[0].meta.changes });
}

async function publicationRoutes(c: Context, key?: string, action?: string) {
  const method = c.req.method;
  if (!key && method === 'GET') return json(await listEntities(c, 'publications'));
  if (!key && method === 'POST') {
    const { custom_fields: values, ...data } = await readBody(c, publicationInput.partial().required({ title: true }));
    await ensureCategory(c, data.category_id);
    if (data.cover_media_id) fail(400, 'Сначала добавьте изображение в публикацию.');
    const fields = await validateValues(c, values);
    const publicationId = id();
    const timestamp = now();
    const category = existingCategory(data.category_id);
    const definitions = unchangedDefinitions(fields);
    await requireMutation(c, [insert(c, 'publications', { ...data, id: publicationId, created_at: timestamp, updated_at: timestamp,
      published_at: data.status_id === 'published' ? data.published_at ?? timestamp : data.published_at ?? null,
      search_text: normalize(data.title, data.description ?? '', data.hashtags ?? '') },
    { sql: `${category.sql} AND ${definitions.sql}`, args: [...category.args, ...definitions.args] }),
    ...writeValues(c, publicationId, fields), createActivity(c, 'publications', publicationId, 'Создана публикация')]);
    return json(await publicationDetail(c, publicationId), 201);
  }
  if (key === 'bulk' && method === 'POST' && !action) return bulkPublications(c);
  if (key && action === 'duplicate' && method === 'POST') return duplicatePublication(c, key);
  if (!key || action || !['GET', 'PATCH', 'DELETE'].includes(method)) return;
  if (method === 'GET') return json(await publicationDetail(c, key));
  const current = await one<Publication>(c, `SELECT * FROM publications WHERE id = ? AND ${visible}`, key);
  if (method === 'PATCH') {
    const { version: expected, custom_fields: values, ...data } = await readBody(c, publicationInput.partial().extend({ version }));
    await Promise.all([ensureCategory(c, data.category_id), ensureOwnedImage(c, key, data.cover_media_id)]);
    const fields = await validateValues(c, values);
    const updated = now();
    if ((data.status_id ?? current.status_id) === 'published' && !(data.published_at === undefined ? current.published_at : data.published_at)) data.published_at = updated;
    const stateLabel = data.status_id === 'ready' && current.status_id !== 'ready' ? 'Публикация готова' : 'Изменена публикация';
    const category = existingCategory(data.category_id);
    const coverCheck = data.cover_media_id ? `AND EXISTS (SELECT 1 FROM publication_media a JOIN media_assets m ON m.id = a.media_id
      WHERE a.publication_id = ? AND a.media_id = ? AND a.deleted_at IS NULL AND m.deleted_at IS NULL AND m.media_type = 'image')` : '';
    const definitions = unchangedDefinitions(fields);
    const guard = guardMutation(c, 'publications', key, expected, stateLabel, `${category.sql} ${coverCheck} AND ${definitions.sql}`,
      [...category.args, ...(data.cover_media_id ? [key, data.cover_media_id] : []), ...definitions.args]);
    await requireMutation(c, [guard.event, update(c, 'publications', { ...data, version: expected + 1, updated_at: updated,
      search_text: normalize(data.title ?? current.title, data.description ?? current.description, data.hashtags ?? current.hashtags),
    }, `id = ? AND ${guard.gate}`, key, guard.guardId), ...writeValues(c, key, fields, guard)]);
    return json(await publicationDetail(c, key));
  }
  return trashEntity(c, 'publications', key, 'Публикация перемещена в корзину');
}

async function trashEntity(c: Context, entity: 'publications' | 'ideas', key: string, label: string) {
  const expected = (await readBody(c, confirmation)).version;
  const timestamp = now();
  const guard = guardMutation(c, entity, key, expected, label);
  await requireMutation(c, [guard.event, update(c, entity, { deleted_at: timestamp, updated_at: timestamp, version: expected + 1 },
    `id = ? AND ${guard.gate}`, key, guard.guardId)]);
  return json({ ok: true });
}

async function ideaDetail(c: Context, key: string) {
  const [row, media] = await Promise.all([
    one<Idea>(c, `${ideaSelect} WHERE i.id = ? AND i.deleted_at IS NULL`, key), attachedMedia(c, 'idea', key),
  ]);
  return { ...decodeLinks(row), media };
}

async function duplicateIdea(c: Context, key: string) {
  const current = await one<Idea>(c, `SELECT * FROM ideas WHERE id = ? AND ${visible}`, key);
  const title = `${current.title.slice(0, 191)} — копия`;
  const copy = id();
  const timestamp = now();
  const guard = guardMutation(c, 'ideas', key, current.version, 'Идея дублирована');
  await requireMutation(c, [guard.event, sql(c, `INSERT INTO ideas
    (id, category_id, title, description, priority, status, scenario, notes, links, created_at, updated_at, search_text)
    SELECT ?, category_id, ?, description, priority, 'new', scenario, notes, links, ?, ?, ?
    FROM ideas WHERE id = ? AND ${guard.gate}`,
  copy, title, timestamp, timestamp, normalize(title, current.description), key, guard.guardId), copyMedia(c, 'idea', 'idea', key, copy, guard)]);
  return json(await ideaDetail(c, copy), 201);
}

async function convertIdea(c: Context, key: string) {
  const idea = await one<Idea>(c, `SELECT * FROM ideas WHERE id = ? AND ${visible}`, key);
  if (idea.publication_id) return json({ id: idea.publication_id });
  const publicationId = id();
  const timestamp = now();
  const guard = guardMutation(c, 'ideas', key, idea.version, 'Идея превращена в публикацию', 'publication_id IS NULL');
  const results = await c.db.batch([
    guard.event,
    sql(c, `INSERT INTO publications (id, category_id, title, description, status_id, scenario, notes, created_at, updated_at, search_text)
      SELECT ?, category_id, title, description, 'draft', scenario, notes, ?, ?, ? FROM ideas WHERE id = ? AND ${guard.gate}`,
    publicationId, timestamp, timestamp, normalize(idea.title, idea.description), key, guard.guardId),
    copyMedia(c, 'idea', 'publication', key, publicationId, guard),
    update(c, 'ideas', { publication_id: publicationId, status: 'realized', updated_at: timestamp, version: idea.version + 1 },
      `id = ? AND ${guard.gate}`, key, guard.guardId),
  ]);
  if (results[0].meta.changes > 0) return json({ id: publicationId });
  const updated = await one<Idea>(c, `SELECT publication_id FROM ideas WHERE id = ? AND ${visible}`, key);
  if (updated.publication_id) return json({ id: updated.publication_id });
  fail(409, 'Идея изменилась. Обновите её и повторите действие.', 'EDIT_CONFLICT');
}

async function ideaRoutes(c: Context, key?: string, action?: string) {
  const method = c.req.method;
  if (!key && method === 'GET') return json(await listEntities(c, 'ideas'));
  if (!key && method === 'POST') {
    const { links, ...data } = await readBody(c, ideaInput.partial().required({ title: true }));
    await ensureCategory(c, data.category_id);
    const ideaId = id();
    const timestamp = now();
    await requireMutation(c, [insert(c, 'ideas', { ...data, id: ideaId, links: JSON.stringify(links ?? []), created_at: timestamp,
      updated_at: timestamp, search_text: normalize(data.title, data.description ?? '') }, existingCategory(data.category_id)),
    createActivity(c, 'ideas', ideaId, 'Создана идея')]);
    return json(await ideaDetail(c, ideaId), 201);
  }
  if (key && action === 'duplicate' && method === 'POST') return duplicateIdea(c, key);
  if (key && action === 'convert' && method === 'POST') return convertIdea(c, key);
  if (!key || action || !['GET', 'PATCH', 'DELETE'].includes(method)) return;
  if (method === 'GET') return json(await ideaDetail(c, key));
  const current = await one<Idea>(c, `SELECT * FROM ideas WHERE id = ? AND ${visible}`, key);
  if (method === 'PATCH') {
    const { version: expected, links, ...data } = await readBody(c, ideaInput.partial().extend({ version }));
    await ensureCategory(c, data.category_id);
    const category = existingCategory(data.category_id);
    const guard = guardMutation(c, 'ideas', key, expected, 'Изменена идея', category.sql, category.args);
    await requireMutation(c, [guard.event, update(c, 'ideas', { ...data, ...(links === undefined ? {} : { links: JSON.stringify(links) }),
      version: expected + 1, updated_at: now(), search_text: normalize(data.title ?? current.title, data.description ?? current.description),
    }, `id = ? AND ${guard.gate}`, key, guard.guardId)]);
    return json(await ideaDetail(c, key));
  }
  return trashEntity(c, 'ideas', key, 'Идея перемещена в корзину');
}

async function customFields(c: Context, key?: string) {
  const method = c.req.method;
  if (!key && method === 'GET') {
    return json((await rows<Field>(c, 'SELECT * FROM custom_field_definitions ORDER BY sort_order, name, id')).map(decodeOptions));
  }
  if (!key && method === 'POST') {
    const { options, ...data } = await readBody(c, fieldInput.partial().required({ name: true, type: true }));
    const choices = optionsFor(data.type, options ?? []);
    const order = data.sort_order ?? (await one<{ next_order: number }>(c, 'SELECT COALESCE(MAX(sort_order), -1) + 1 AS next_order FROM custom_field_definitions')).next_order;
    const key = id();
    await c.db.batch([insert(c, 'custom_field_definitions', { ...data, id: key, options: JSON.stringify(choices), sort_order: order }),
      activity(c, 'Создано дополнительное поле', 'settings', key)]);
    return json(decodeOptions(await one<Field>(c, 'SELECT * FROM custom_field_definitions WHERE id = ?', key)), 201);
  }
  if (key && method === 'PATCH') {
    const current = await one<Field>(c, 'SELECT * FROM custom_field_definitions WHERE id = ?', key);
    const { options, ...data } = await readBody(c, fieldInput.partial());
    const type = data.type ?? current.type;
    const choices = optionsFor(type, options ?? decodeOptions(current).options);
    const hasValues = await sql(c, 'SELECT 1 FROM custom_field_values WHERE field_id = ? LIMIT 1', key).first();
    if (type !== current.type && hasValues) fail(409, 'В публикациях уже есть значения. Создайте новое поле нужного типа.');
    if (type === 'select' && choices.length && await sql(c, `SELECT 1 FROM custom_field_values WHERE field_id = ?
      AND json_extract(value, '$') NOT IN (SELECT value FROM json_each(?)) LIMIT 1`, key, JSON.stringify(choices)).first()) {
      fail(409, 'Сначала замените используемые варианты в публикациях.');
    }
    await c.db.batch([update(c, 'custom_field_definitions', { ...data, options: JSON.stringify(choices) }, 'id = ?', key),
      activity(c, 'Изменено дополнительное поле', 'settings', key)]);
    return json(decodeOptions(await one<Field>(c, 'SELECT * FROM custom_field_definitions WHERE id = ?', key)));
  }
  if (key && method === 'DELETE') {
    const results = await c.db.batch([sql(c, 'DELETE FROM custom_field_definitions WHERE id = ?', key), activity(c, 'Удалено дополнительное поле', 'settings', key)]);
    if (!results[0].meta.changes) fail(404, 'Поле уже удалено.');
    return json({ ok: true });
  }
}

function optionsFor(type: z.infer<typeof fieldType>, options: string[]) {
  if (type !== 'select') return [];
  if (!options.length) fail(400, 'Укажите хотя бы один вариант списка.');
  return [...new Set(options)];
}

function decodeOptions(row: Field) { return { ...row, options: JSON.parse(row.options) as string[] }; }

async function settingsRoutes(c: Context) {
  if (c.req.method === 'GET') return json(await readSettings(c));
  if (c.req.method !== 'PATCH') return;
  const patch = await readBody(c, settingsInput.partial());
  await ensureImage(c, patch.logo_media_id);
  for (let attempt = 0; attempt < 3; attempt++) {
    const old = await one<{ value: string }>(c, `SELECT value FROM app_settings WHERE key = 'studio'`);
    const updated: Settings = { ...JSON.parse(old.value), ...patch };
    if (updated.storage_warn > updated.storage_limit) fail(400, 'Порог предупреждения не может превышать лимит хранилища.');
    if (updated.red_max >= updated.yellow_max || updated.green_min !== updated.yellow_max + 1) {
      fail(400, 'Диапазоны индикаторов должны идти подряд: красный, жёлтый, зелёный.');
    }
    const timestamp = now();
    const guardId = id();
    const gate = 'EXISTS (SELECT 1 FROM activity_log WHERE id = ?)';
    const imageCheck = patch.logo_media_id ? `AND EXISTS (SELECT 1 FROM media_assets WHERE id = ? AND deleted_at IS NULL AND media_type = 'image')` : '';
    const result = await c.db.batch([
      sql(c, `INSERT INTO activity_log (id, action, entity_type, created_at)
        SELECT ?, 'Изменены настройки студии', 'settings', ? FROM app_settings WHERE key = 'studio' AND value = ? ${imageCheck}`,
      guardId, timestamp, old.value, ...(patch.logo_media_id ? [patch.logo_media_id] : [])),
      sql(c, `UPDATE app_settings SET value = ?, updated_at = ? WHERE key = 'studio' AND ${gate}`, JSON.stringify(updated), timestamp, guardId),
      ...(patch.logo_media_id !== undefined ? coverReferences(c, 'logo', 'studio', patch.logo_media_id, timestamp, { sql: gate, args: [guardId] }) : []),
    ]);
    if (result[0].meta.changes) return json(updated);
  }
  fail(409, 'Настройки обновились на другом устройстве. Повторите сохранение.', 'EDIT_CONFLICT');
}

async function statuses(c: Context, key?: string) {
  if (!key && c.req.method === 'GET') return json(await rows(c, 'SELECT * FROM publication_statuses ORDER BY sort_order, id'));
  if (!key || c.req.method !== 'PATCH') return;
  const data = await readBody(c, z.object({ name, color, sort_order: z.number().int().min(-1_000_000).max(1_000_000) }).partial());
  await one(c, 'SELECT id FROM publication_statuses WHERE id = ?', key);
  if (Object.keys(data).length) await c.db.batch([update(c, 'publication_statuses', data, 'id = ?', key), activity(c, 'Изменён статус публикации', 'settings', key)]);
  return json(await one(c, 'SELECT * FROM publication_statuses WHERE id = ?', key));
}

async function stats(c: Context) {
  const totals = await one(c, `SELECT count(*) AS total, count(*) FILTER (WHERE ${readySql}) AS ready,
    count(*) FILTER (WHERE status_id = 'draft') AS draft, count(*) FILTER (WHERE status_id = 'review') AS review,
    count(*) FILTER (WHERE ${publishedSql}) AS published, count(*) FILTER (WHERE status_id = 'scheduled' AND published_at IS NULL) AS scheduled,
    (SELECT count(*) FROM ideas WHERE deleted_at IS NULL) AS ideas,
    (SELECT count(*) FROM categories WHERE deleted_at IS NULL) AS categories FROM publications WHERE deleted_at IS NULL`);
  return json(totals);
}

async function search(c: Context) {
  const q = queryText(c);
  if (!q) return json({ categories: [], publications: [], ideas: [] });
  const [categories, publications, ideas] = await Promise.all([
    rows<Category>(c, `SELECT * FROM categories WHERE ${visible} ORDER BY sort_order, name, id`),
    rows(c, `${publicationSelect} WHERE p.deleted_at IS NULL AND instr(p.search_text, ?) > 0 ORDER BY p.updated_at DESC LIMIT 10`, q),
    rows(c, `${ideaSelect} WHERE i.deleted_at IS NULL AND instr(i.search_text, ?) > 0 ORDER BY i.updated_at DESC LIMIT 10`, q),
  ]);
  return json({ categories: categories.filter((row) => normalize(row.name, String(row.description ?? '')).includes(q)).slice(0, 10),
    publications, ideas: ideas.map(decodeLinks) });
}

async function calendar(c: Context) {
  const from = readDateParam(c, 'from');
  const to = readDateParam(c, 'to');
  if (!from || !to || from >= to) fail(400, 'Укажите начало и конец периода календаря.');
  const items = await rows(c, `${publicationSelect} WHERE p.deleted_at IS NULL AND p.scheduled_at >= ? AND p.scheduled_at < ? ORDER BY p.scheduled_at, p.id`, from, to);
  return json(items);
}

export async function content(c: Context): Promise<Response | undefined> {
  const [prefix, resource, key, action, extra] = c.url.pathname.split('/').filter(Boolean);
  if (prefix !== 'api' || extra) return;
  switch (resource) {
    case 'categories': if (!action) return categoryRoutes(c, key); break;
    case 'publications': return publicationRoutes(c, key, action);
    case 'ideas': return ideaRoutes(c, key, action);
    case 'custom-fields': if (!action) return customFields(c, key); break;
    case 'statuses': if (!action) return statuses(c, key); break;
    case 'settings': if (!key) return settingsRoutes(c); break;
    case 'stats': if (!key && c.req.method === 'GET') return stats(c); break;
    case 'search': if (!key && c.req.method === 'GET') return search(c); break;
    case 'calendar': if (!key && c.req.method === 'GET') return calendar(c); break;
    case 'activity': if (!key && c.req.method === 'GET') return json(await rows(c, 'SELECT * FROM activity_log ORDER BY created_at DESC, id LIMIT ?',
      readInteger(c, 'limit', 20, 1, 100))); break;
  }
}
