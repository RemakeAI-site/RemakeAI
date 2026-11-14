import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const origin = process.argv[2] ?? 'http://localhost:8787';
const suffix = randomUUID();
async function request(path, method = 'GET', data, expected = 200) {
  const response = await fetch(`${origin}/api${path}`, {
    method,
    headers: data ? { 'Content-Type': 'application/json' } : undefined,
    body: data ? JSON.stringify(data) : undefined,
  });
  const result = await response.json();
  assert.equal(response.status, expected, `${method} ${path}: ${JSON.stringify(result)}`);
  return result;
}

const initial = await request('/categories');
assert.equal(initial.length, 11, 'The test requires a fresh database.');
assert.deepEqual(await request('/stats'), {
  total: 0, ready: 0, draft: 0, review: 0, published: 0, ideas: 0, categories: 11, scheduled: 0,
});
const root = await request('/categories', 'POST', { name: `Родитель ${suffix}` }, 201);
const child = await request('/categories', 'POST', { name: `Потомок ${suffix}`, parent_id: root.id }, 201);
const leaf = await request('/categories', 'POST', { name: `Лист ${suffix}`, parent_id: child.id }, 201);
await request(`/categories/${root.id}`, 'PATCH', { version: root.version, parent_id: leaf.id }, 409);
assert.equal((await request('/categories')).find((item) => item.id === root.id).indicator_color, (await request('/settings')).red_color);
const name = `ПРОВЕРЯЕМАЯ публикация ${suffix}`;
const posts = [];
for (const number of [1, 2, 3]) {
  posts.push(await request('/publications', 'POST', {
    title: `${name} ${number}`, category_id: leaf.id, status_id: 'ready', description: 'контент', hashtags: '#ИСПЫТАНИЕ',
  }, 201));
  const settings = await request('/settings');
  const entry = (await request('/categories')).find((item) => item.id === root.id);
  assert.equal(entry.ready_count, number);
  assert.equal(entry.indicator_color, number < 3 ? settings.yellow_color : settings.green_color);
}
const published = await request(`/publications/${posts[0].id}`, 'PATCH', { version: posts[0].version, status_id: 'published' });
assert.ok(published.published_at);
const entry = (await request('/categories')).find((item) => item.id === root.id);
assert.equal(entry.indicator_color, (await request('/settings')).yellow_color);
await request(`/publications/${posts[0].id}`, 'PATCH', { version: posts[0].version, notes: 'stale' }, 409);
const listed = await request(`/publications?category_id=${root.id}&q=${encodeURIComponent('#испытание')}&limit=2`);
assert.equal(listed.total, 3);
assert.equal(listed.items.length, 2);
const idea = await request('/ideas', 'POST', {
  title: `Идея ${suffix}`, category_id: leaf.id, description: 'Описание', scenario: 'Сценарий', notes: 'Заметки', links: ['https://example.org/reference'],
}, 201);
const conversions = await Promise.all([
  request(`/ideas/${idea.id}/convert`, 'POST'), request(`/ideas/${idea.id}/convert`, 'POST'),
]);
assert.equal(conversions[0].id, conversions[1].id);
const content = await request(`/publications/${conversions[0].id}`);
assert.equal(content.description, 'Описание');
assert.equal(content.scenario, 'Сценарий');
assert.equal(content.notes, 'Заметки');
assert.equal(content.category_id, leaf.id);
assert.equal((await request(`/ideas/${idea.id}`)).status, 'realized');
const field = await request('/custom-fields', 'POST', { name: 'Просмотры', type: 'number' }, 201);
const changed = await request(`/publications/${posts[1].id}`, 'PATCH', { version: posts[1].version, custom_fields: { [field.id]: 500 } });
assert.equal(changed.custom_fields[field.id], 500);
await request(`/publications/${posts[1].id}`, 'PATCH', { version: changed.version, custom_fields: { [field.id]: '500' } }, 400);
await request(`/categories/${child.id}`, 'DELETE', { version: child.version, mode: 'trash' });
await request(`/categories/${leaf.id}`, 'GET', undefined, 404);
await request(`/publications/${posts[1].id}`, 'GET', undefined, 404);
const trash = await request('/trash');
const removed = trash.find((item) => item.id === child.id && item.type === 'category');
assert.ok(removed?.group);
await request(`/trash/category/${child.id}/restore`, 'POST');
assert.equal((await request(`/categories/${leaf.id}`)).parent_id, child.id);
assert.equal((await request(`/publications/${posts[1].id}`)).description, 'контент');
const restored = await request(`/categories/${child.id}`);
const destination = initial.find((item) => item.id === 'literally');
const moved = await request(`/categories/${child.id}`, 'PATCH', { version: restored.version, parent_id: destination.id, name: 'Перемещённая подрубрика' });
assert.equal(moved.parent_id, destination.id);
const nested = (await request('/categories')).find((item) => item.id === leaf.id);
assert.equal(nested.path[0], destination.name);
assert.ok(nested.path.includes(moved.name));
await request(`/categories/${moved.id}`, 'DELETE', { version: moved.version, mode: 'move', target_id: root.id });
assert.equal((await request(`/categories/${leaf.id}`)).parent_id, root.id);
assert.equal((await request(`/publications/${posts[1].id}`)).category_id, leaf.id);
const draft = await request(`/publications/${posts[1].id}/duplicate`, 'POST', undefined, 201);
assert.equal(draft.status_id, 'draft');
assert.equal(draft.custom_fields[field.id], 500);
const scheduled = '2026-12-12T10:00:00.000Z';
await request(`/publications/${draft.id}`, 'PATCH', { version: draft.version, scheduled_at: scheduled, status_id: 'scheduled', tiktok_url: '' });
const calendar = await request(`/calendar?from=${encodeURIComponent(scheduled)}&to=2026-12-13T00:00:00Z`);
assert.ok(calendar.find((item) => item.id === draft.id));
assert.equal((await request(`/calendar?from=2026-12-11T00:00:00Z&to=${encodeURIComponent(scheduled)}`)).length, 0);
await request('/publications/bulk', 'POST', { ids: [posts[1].id, posts[2].id], action: 'status', status_id: 'review' });
assert.equal((await request(`/publications?category_id=${root.id}&status_id=review`)).total, 2);

console.log('Content integration passed: seed, statistics, hierarchy, search, versioning, conversion, custom fields, trash, restore.');
