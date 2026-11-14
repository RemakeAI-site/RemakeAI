import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { crc32, deflateSync } from 'node:zlib';

const base = (process.argv[2] ?? 'http://localhost:8787').replace(/\/$/, '') + '/api';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

async function response(path, { method = 'GET', data, headers = {}, expected = 200 } = {}) {
  const raw = data instanceof Uint8Array;
  const res = await fetch(base + path, {
    method,
    headers: { ...(!raw && data !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
    body: raw ? data : data === undefined ? undefined : JSON.stringify(data),
  });
  if (res.status !== expected) throw new Error(`${method} ${path} => ${res.status}: ${await res.text()}`);
  return res;
}

async function get(path, opts) { return (await response(path, opts)).json(); }

function pngChunk(name, bytes) {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(bytes.length);
  header.write(name, 4);
  const footer = Buffer.alloc(4);
  footer.writeUInt32BE(crc32(bytes, crc32(header.subarray(4))));
  return Buffer.concat([header, bytes, footer]);
}

function png(width, height, seed) {
  let value = seed;
  const scanline = width * 3 + 1;
  const pixels = Buffer.alloc(scanline * height);
  for (let row = 0; row < height; row++) {
    for (let column = 1; column < scanline; column++) {
      value = (value * 1664525 + 1013904223) >>> 0;
      pixels[row * scanline + column] = value >>> 24;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(pixels)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// Read central directory offsets and validate that every stored ZIP member retains its exact bytes.
function zipEntries(zip) {
  const directory = zip.length - 22;
  assert.equal(zip.readUInt32LE(directory), 0x06054b50);
  const entries = zip.readUInt16LE(directory + 10);
  let cursor = zip.readUInt32LE(directory + 16);
  const files = new Map();
  for (let index = 0; index < entries; index++) {
    assert.equal(zip.readUInt32LE(cursor), 0x02014b50);
    assert.equal(zip.readUInt16LE(cursor + 10), 0);
    const checksum = zip.readUInt32LE(cursor + 16);
    const size = zip.readUInt32LE(cursor + 20);
    const nameLength = zip.readUInt16LE(cursor + 28);
    const local = zip.readUInt32LE(cursor + 42);
    const name = zip.toString('utf8', cursor + 46, cursor + 46 + nameLength);
    const position = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    const bytes = zip.subarray(position, position + size);
    assert.equal(zip.readUInt32LE(local), 0x04034b50);
    assert.equal(crc32(bytes), checksum);
    files.set(name, sha(bytes));
    cursor += 46 + nameLength + zip.readUInt16LE(cursor + 30) + zip.readUInt16LE(cursor + 32);
  }
  return files;
}

async function upload(filename, bytes, target = { target_type: 'publication', target_id: publication.id }) {
  const session = await get('/uploads', { method: 'POST', expected: 201, data: { ...target, filename, size: bytes.byteLength } });
  const url = '/uploads/' + session.id;
  assert.deepEqual((await get(url)).parts, []);
  for (let index = 0; index * session.chunk_size < bytes.byteLength; index++) {
    const part = bytes.subarray(index * session.chunk_size, (index + 1) * session.chunk_size);
    const path = url + '/parts/' + (index + 1);
    const options = { method: 'PUT', data: part, headers: { 'x-content-sha256': sha(part) } };
    await get(path, options);
    if (index === 0) await get(path, options);
  }
  assert.equal((await get(url)).parts.length, Math.ceil(bytes.byteLength / session.chunk_size));
  const checksum = sha(bytes);
  const asset = await get(url + '/complete', { method: 'POST', expected: 201, data: { sha256: checksum } });
  const replay = await get(url + '/complete', { method: 'POST', data: { sha256: checksum } });
  const original = await response('/media/' + asset.id + '?download=1');
  assert.equal(asset.sha256, checksum);
  assert.equal(replay.id, asset.id);
  assert.equal(sha(new Uint8Array(await original.arrayBuffer())), checksum);
  return asset;
}

const category = await get('/categories', { method: 'POST', expected: 201, data: { name: 'Проверка медиа ' + Date.now() } });
const publication = await get('/publications', { method: 'POST', expected: 201, data: { title: 'Проверка оригиналов', category_id: category.id } });
const galleryPath = '/publications/' + publication.id;
const photos = [];
for (let index = 0; index < 5; index++) photos.push(await upload(`scene-${index}.png`, png(48, 32, 11 + index)));
const largePng = png(1940, 1600, 1337);
assert.ok(largePng.length > 8 * 1024 * 1024, 'Проверка должна задействовать multipart.');
const large = await upload('original.png', largePng);
assert.equal(large.width, 1940);
assert.equal(large.height, 1600);

const videoBytes = await readFile(new URL('fixtures/media-test.mp4', import.meta.url));
const video = await upload('clip.mp4', videoBytes);
const range = await response('/media/' + video.id, { headers: { range: 'bytes=8-27' }, expected: 206 });
assert.equal(range.headers.get('content-range'), `bytes 8-27/${video.file_size}`);
assert.deepEqual(Buffer.from(await range.arrayBuffer()), videoBytes.subarray(8, 28));
const invalidRange = await response('/media/' + video.id, { headers: { range: 'bytes=999999-' }, expected: 416 });
assert.equal(invalidRange.headers.get('content-range'), 'bytes */' + video.file_size);

const preview = Buffer.from('UklGRloAAABXRUJQVlA4IE4AAACQBgCdASqqAFoAPm02mUmkIyKhIIgAgA2JaW7hdUAAT22IvEFRz2xF4gqOe2IvEFRz2xF4gqOe2IvEFRlAAP7/ciNiO373pa4GgAAAAAA=', 'base64');
await get('/media/' + large.id + '/preview', { method: 'PUT', data: preview });
const previewResult = await response('/media/' + large.id + '?preview=1');
assert.equal(previewResult.headers.get('content-type'), 'image/webp');
assert.deepEqual(Buffer.from(await previewResult.arrayBuffer()), preview);

await get('/media/cover', { method: 'PATCH', data: { target_type: 'publication', target_id: publication.id, media_id: large.id } });
const initial = await get(galleryPath);
const order = initial.media.map(asset => asset.attachment_id).reverse();
await get('/media/order', { method: 'PATCH', data: { target_type: 'publication', target_id: publication.id, ids: order } });
const ordered = await get(galleryPath);
assert.deepEqual(ordered.media.map(asset => asset.attachment_id), order);

const zipResponse = await response(galleryPath + '/download');
assert.equal(zipResponse.headers.get('content-type'), 'application/zip');
const zip = zipEntries(Buffer.from(await zipResponse.arrayBuffer()));
assert.equal(zip.size, 7);
assert.equal(zip.get('01-cover.png'), large.sha256);
assert.deepEqual(new Set(zip.values()), new Set([...photos, large, video].map(asset => asset.sha256)));
const photoZip = zipEntries(Buffer.from(await (await response(galleryPath + '/download?photos=1')).arrayBuffer()));
assert.equal(photoZip.size, 6);
assert.ok(![...photoZip.keys()].some(name => name.endsWith('.mp4')));

const originalAttachment = ordered.media.find(asset => asset.id === large.id);
const replacement = await upload('replacement.webp', preview, {
  target_type: 'publication', target_id: publication.id, replace_for: originalAttachment.attachment_id,
});
const replaced = await get(galleryPath);
assert.equal(replaced.cover_media_id, replacement.id);
assert.equal(replaced.media.some(asset => asset.id === large.id), false);
assert.equal(sha(Buffer.from(await (await response('/media/' + large.id + '?download=1')).arrayBuffer())), large.sha256);
await get('/attachments/' + replaced.media[0].attachment_id + '?target_type=publication', { method: 'DELETE' });

const cover = await upload('cover.webp', preview, { target_type: 'category', target_id: category.id });
assert.equal((await get('/categories/' + category.id)).cover_media_id, cover.id);
await get('/media/cover', { method: 'PATCH', data: { target_type: 'category', target_id: category.id, media_id: null } });
assert.equal((await get('/categories/' + category.id)).cover_media_id, null);

const bad = await get('/uploads', { method: 'POST', expected: 201, data: {
  filename: 'invalid.png', size: 4, target_type: 'publication', target_id: publication.id,
} });
await response('/uploads/' + bad.id + '/parts/1', { method: 'PUT', data: new Uint8Array([1, 2, 3, 4]), expected: 415 });
await get('/uploads/' + bad.id, { method: 'DELETE' });
await response('/uploads/' + bad.id, { expected: 404 });

console.log('Медиа: пять PNG, multipart, MP4, SHA-256, Range, WebP-превью, ZIP с CRC, порядок кадров, замена файла, обложка, отклонение неверного формата, отмена загрузки.');
