import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const [origin, persistedD1State] = process.argv.slice(2);
assert.ok(origin && persistedD1State, 'Pass the test server URL and isolated local D1 state directory.');
const root = fileURLToPath(new URL('..', import.meta.url));
const database = 'remake-ai-studio';
const run = randomUUID();
const categoryId = `library-${run}`;
const subcategoryId = `${categoryId}-nested`;
const sqlQuote = (text) => `'${String(text).replaceAll("'", "''")}'`;
const values = (row) => `(${row.map(sqlQuote).join(',')})`;

const created = new Date('2026-04-01T00:00:00.000Z');
const updated = new Date('2026-05-01T00:00:00.000Z');
const startDate = created.toISOString();
const publications = Array.from({ length: 120 }, (_, index) => {
  const label = String(index + 1).padStart(3, '0');
  const title = `Выпуск ${label}`;
  const description = index % 2 ? 'материал крупной библиотеки' : '';
  const subcategory = index < 60 ? subcategoryId : categoryId;
  const status = index % 3 === 0 ? 'ready' : index % 3 === 1 ? 'draft' : 'published';
  const timestamp = index < 60 ? startDate : updated.toISOString();
  const tags = index < 60 ? '#ТЕСТ_БИБЛИОТЕКИ' : '#ПРОЕКТ_БИБЛИОТЕКИ';
  return values([`${run}-${label}`, subcategory, title, description, status, timestamp, timestamp, tags,
    [title, description, tags].join('\n').toLocaleLowerCase('ru')]);
});
const fixture = resolve(persistedD1State, `library-${run}.sql`);
await mkdir(persistedD1State, { recursive: true });
await writeFile(fixture, `
INSERT INTO categories (id, name, slug, created_at, updated_at) VALUES ${values([categoryId, `Тестовая библиотека ${run}`, categoryId, startDate, startDate])};
INSERT INTO categories (id, name, slug, created_at, updated_at, parent_id) VALUES ${values([subcategoryId, 'Вложенная библиотека', subcategoryId, startDate, startDate, categoryId])};
INSERT INTO publications (id, category_id, title, description, status_id, created_at, updated_at, hashtags, search_text) VALUES\n${publications.join(',\n')};
`);
const installer = spawnSync(process.execPath, [resolve(root, 'node_modules/wrangler/bin/wrangler.js'), 'd1', 'execute',
  database, '--local', '--persist-to', persistedD1State, '--file', fixture], {
  cwd: root, env: { ...process.env, WRANGLER_SEND_METRICS: 'false' }, encoding: 'utf8', timeout: 30_000,
});
assert.equal(installer.status, 0, [installer.stdout, installer.stderr, installer.error].filter(Boolean).join('\n'));

async function get(path, data) {
  const url = new URL(`/api/${path}`, origin);
  if (data) url.search = new URLSearchParams(data).toString();
  const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  assert.equal(response.status, 200, `GET ${url.pathname}, ${await response.clone().text()}`);
  return response.json();
}
const list = (filters = {}) => get('publications', { category_id: categoryId, ...filters });
const started = performance.now();
const [first, last, filtered, categories, nested, counts] = await Promise.all([
  list({ limit: 24, page: 1, sort: 'title' }), list({ limit: 24, page: 5, sort: 'title' }),
  list({ q: '#тест_библиотеки', status_id: 'ready', has_description: '1', has_video: '0', photo_max: 0 }), get('categories'),
  list({ subcategory_id: subcategoryId, created_to: '2026-04-02T00:00:00Z' }), get('stats'),
]);
assert.equal(first.total, 120);
assert.equal(first.items.length, 24);
assert.equal(first.items[0].title, 'Выпуск 001');
assert.equal(last.items[23].title, 'Выпуск 120');
assert.equal(filtered.total, 10);
assert.equal(nested.total, 60);
assert.ok(counts.total >= 120);
const card = categories.find((entry) => entry.id === categoryId);
assert.equal(card.total_count, 120);
assert.equal(card.ready_count, 40);
assert.equal(card.published_count, 40);
console.log(`Large library integration passed: 120 publications, 5 pages, recursion, search, filters, statistics (${Math.round(performance.now() - started)} ms).`);
