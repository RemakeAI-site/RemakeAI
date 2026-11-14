import { crc32 } from 'node:zlib';

export const MiB = 1024 * 1024;
export const PART_SIZE = 8 * MiB;
export const ZIP_SIZE_LIMIT = 256 * MiB;
export const ZIP_FILE_LIMIT = 40;

type ByteRange = { offset: number; length: number };
type ObjectContent = { body: ReadableStream<Uint8Array>; size: number; etag: string };
type StoredPart = { partNumber: number; etag: string };

// The media service depends on this interface rather than Cloudflare-specific R2 methods.
export interface ObjectStorage {
  check(): Promise<void>;
  inspect(key: string): Promise<{ size: number } | null>;
  read(key: string, range?: ByteRange): Promise<ObjectContent | null>;
  write(key: string, bytes: Uint8Array<ArrayBuffer>, mime: string, sha256?: string): Promise<void>;
  remove(key: string): Promise<void>;
  startMultipart(key: string, mime: string): Promise<string>;
  putPart(key: string, uploadId: string, number: number, bytes: Uint8Array<ArrayBuffer>): Promise<StoredPart>;
  finishMultipart(key: string, uploadId: string, parts: StoredPart[]): Promise<void>;
  abortMultipart(key: string, uploadId: string): Promise<void>;
}

export class R2Storage implements ObjectStorage {
  constructor(private readonly bucket: R2Bucket) {}

  async check() { await this.bucket.list({limit:1}); }

  async inspect(key: string) {
    const object = await this.bucket.head(key);
    return object ? { size: object.size } : null;
  }

  async read(key: string, range?: ByteRange) {
    const object = await this.bucket.get(key, { range });
    return object ? { body: object.body as ReadableStream<Uint8Array>, size: object.size, etag: object.httpEtag } : null;
  }

  async write(key: string, bytes: Uint8Array<ArrayBuffer>, mime: string, sha256?: string) {
    await this.bucket.put(key, bytes, { httpMetadata: { contentType: mime }, sha256 });
  }

  remove(key: string) { return this.bucket.delete(key); }

  async startMultipart(key: string, mime: string) {
    return (await this.bucket.createMultipartUpload(key, { httpMetadata: { contentType: mime } })).uploadId;
  }

  putPart(key: string, uploadId: string, number: number, bytes: Uint8Array<ArrayBuffer>) {
    return this.bucket.resumeMultipartUpload(key, uploadId).uploadPart(number, bytes);
  }

  async finishMultipart(key: string, uploadId: string, parts: StoredPart[]) {
    await this.bucket.resumeMultipartUpload(key, uploadId).complete(parts);
  }

  abortMultipart(key: string, uploadId: string) {
    return this.bucket.resumeMultipartUpload(key, uploadId).abort();
  }
}

interface MediaFormat {
  mime: string;
  kind: 'image' | 'video';
  extension: string;
}

const formats: Record<string, MediaFormat> = {
  png: { mime: 'image/png', kind: 'image', extension: 'png' },
  jpg: { mime: 'image/jpeg', kind: 'image', extension: 'jpg' },
  webp: { mime: 'image/webp', kind: 'image', extension: 'webp' },
  gif: { mime: 'image/gif', kind: 'image', extension: 'gif' },
  avif: { mime: 'image/avif', kind: 'image', extension: 'avif' },
  heic: { mime: 'image/heic', kind: 'image', extension: 'heic' },
  heif: { mime: 'image/heif', kind: 'image', extension: 'heif' },
  mp4: { mime: 'video/mp4', kind: 'video', extension: 'mp4' },
  mov: { mime: 'video/quicktime', kind: 'video', extension: 'mov' },
  webm: { mime: 'video/webm', kind: 'video', extension: 'webm' },
};

const byExtension: Record<string, MediaFormat> = {
  ...formats, jpeg: formats.jpg, jpe: formats.jpg, heics: formats.heic,
  heifs: formats.heif, m4v: formats.mp4,
};

export function formatForName(name: string) {
  const extension = name.match(/\.([a-z0-9]+)$/i)?.[1]?.toLowerCase();
  return extension ? byExtension[extension] : undefined;
}

export function safeFilename(name: string) {
  const lastComponent = name.trim().split(/[/\\]/u).at(-1) ?? '';
  // eslint-disable-next-line no-control-regex
  const sanitized = lastComponent.replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069<>:"|?*]/gu, '_');
  const fileExtension = sanitized.match(/\.[a-z0-9]{1,8}$/i)?.[0] ?? '';
  const stem = sanitized.slice(0, sanitized.length - fileExtension.length).replace(/^\.+|[. ]+$/gu, '');
  return `${Array.from(stem || 'file').slice(0, 150).join('')}${fileExtension}`;
}

export function disposition(action: 'attachment' | 'inline', name: string) {
  const sanitized = safeFilename(name);
  const ascii = sanitized.replace(/[^\x20-\x7e]|["\\]/g, '_');
  const encoded = new TextDecoder().decode(new TextEncoder().encode(sanitized));
  const unicode = encodeURIComponent(encoded).replace(/['()*]/gu, symbol => `%${symbol.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${action}; filename="${ascii}"; filename*=UTF-8''${unicode}`;
}

function magic(bytes: Uint8Array, sequence: number[], offset = 0) {
  return sequence.every((byte, index) => bytes[offset + index] === byte);
}

function ascii(bytes: Uint8Array, offset: number, length: number) {
  return String.fromCharCode(...bytes.subarray(offset, offset + length));
}

export function inspectFormat(bytes: Uint8Array, preferred?: MediaFormat): MediaFormat | null {
  if (magic(bytes, [137, 80, 78, 71, 13, 10, 26, 10]) && ascii(bytes, 12, 4) === 'IHDR') return formats.png;
  if (magic(bytes, [255, 216, 255])) return formats.jpg;
  if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP' && ['VP8 ', 'VP8L', 'VP8X'].includes(ascii(bytes, 12, 4))) return formats.webp;
  if (['GIF87a', 'GIF89a'].includes(ascii(bytes, 0, 6))) return formats.gif;
  if (magic(bytes, [26, 69, 223, 163]) && new TextDecoder().decode(bytes.subarray(0, 4096)).includes('webm')) return formats.webm;

  if (bytes.length < 16) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const name = ascii(bytes, 4, 4);
  if (name === 'ftyp') {
    const ftypSize = view.getUint32(0);
    const brands = [ascii(bytes, 8, 4)];
    for (let offset = 16; offset + 4 <= Math.min(ftypSize, bytes.length, 1024); offset += 4) {
      brands.push(ascii(bytes, offset, 4));
    }
    if (ftypSize < 16) return null;
    if (brands.some(brand => ['avif', 'avis'].includes(brand))) return formats.avif;
    if (brands.some(brand => ['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'hevm', 'hevs'].includes(brand))) return formats.heic;
    if (brands.some(brand => ['mif1', 'msf1'].includes(brand))) return formats.heif;
    if (brands.includes('qt  ')) return formats.mov;
    if (brands.some(brand => /^(isom|iso[2-9]|mp4[12]|M4V |avc1|dash|MSNV|3g[pe][0-9])$/u.test(brand))) {
      return preferred?.extension === 'mov' ? formats.mov : formats.mp4;
    }
  }
  // Some QuickTime exports begin with a movie or media-data atom and carry no ftyp.
  if (preferred?.extension === 'mov' && ['moov', 'mdat', 'wide', 'free'].includes(name) &&
      (view.getUint32(0) >= 8 || view.getUint32(0) === 1)) return formats.mov;
  return null;
}

export function inspectDimensions(bytes: Uint8Array, mime: string): { width: number; height: number } | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (mime === 'image/png' && bytes.length >= 24) return { width: view.getUint32(16), height: view.getUint32(20) };
  if (mime === 'image/gif' && bytes.length >= 10) return { width: view.getUint16(6, true), height: view.getUint16(8, true) };
  if (mime === 'image/webp' && bytes.length >= 30) {
    const chunk = ascii(bytes, 12, 4);
    if (chunk === 'VP8X') return {
      width: 1 + bytes[24] + bytes[25] * 256 + bytes[26] * 65536,
      height: 1 + bytes[27] + bytes[28] * 256 + bytes[29] * 65536,
    };
    if (chunk === 'VP8L' && bytes[20] === 47) {
      const dimensions = view.getUint32(21, true);
      return { width: 1 + (dimensions & 16383), height: 1 + ((dimensions >>> 14) & 16383) };
    }
    if (chunk === 'VP8 ' && magic(bytes, [157, 1, 42], 23)) return {
      width: view.getUint16(26, true) & 16383, height: view.getUint16(28, true) & 16383,
    };
  }
  if (mime === 'image/jpeg') {
    for (let index = 2; index + 8 < bytes.length;) {
      if (bytes[index++] !== 255) return null;
      const marker = bytes[index++];
      if (marker === 255) { index--; continue; }
      if (marker === 218 || marker === 217) break;
      const length = view.getUint16(index);
      if (length < 2 || index + length > bytes.length) break;
      if (length >= 8 && [192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207].includes(marker)) {
        return { width: view.getUint16(index + 5), height: view.getUint16(index + 3) };
      }
      index += length;
    }
  }
  if (['image/avif', 'image/heic', 'image/heif'].includes(mime)) {
    for (let offset = 0; offset + 20 <= Math.min(bytes.length, MiB); offset++) {
      // ISO BMFF ispe item property stores the extent of the encoded image.
      if (magic(bytes, [105, 115, 112, 101], offset + 4) && view.getUint32(offset) === 20) {
        return { width: view.getUint32(offset + 12), height: view.getUint32(offset + 16) };
      }
    }
  }
  return null;
}

export function parseRange(header: string | null, size: number): ByteRange | null {
  if (!header) return null;
  const parts = /^bytes=(\d*)-(\d*)$/u.exec(header.trim());
  if (!parts || (!parts[1] && !parts[2]) || !size) throw new RangeError('Недопустимый диапазон.');
  const upper = parts[2] ? Number(parts[2]) : undefined;
  const lower = parts[1] ? Number(parts[1]) : undefined;
  if ((upper !== undefined && !Number.isSafeInteger(upper)) || (lower !== undefined && !Number.isSafeInteger(lower))) {
    throw new RangeError('Недопустимый диапазон.');
  }
  if (lower === undefined && upper) return { offset: Math.max(size - upper, 0), length: Math.min(upper, size) };
  const end = Math.min(upper ?? size - 1, size - 1);
  if (lower === undefined || lower >= size || lower > end) throw new RangeError('Недопустимый диапазон.');
  return { offset: lower, length: end - lower + 1 };
}

export function hex(buffer: ArrayBuffer) {
  return Array.from(new Uint8Array(buffer), byte => byte.toString(16).padStart(2, '0')).join('');
}

export async function digestStream(source: ReadableStream<Uint8Array>) {
  const NativeDigestStream = (crypto as Crypto & { DigestStream: typeof DigestStream }).DigestStream;
  const sink = new NativeDigestStream('SHA-256');
  await source.pipeTo(sink);
  return hex(await sink.digest);
}

type ZipFile = { key: string; name: string; size: number; createdAt: string };
type ZipIndex = { name: Uint8Array; size: number; offset: number; crc: number; time: number; date: number };

function bytesWith(length: number, write: (view: DataView) => void) {
  const bytes = new Uint8Array(length);
  write(new DataView(bytes.buffer));
  return bytes;
}

function dosTimestamp(value: string) {
  const time = new Date(value);
  return {
    time: (time.getUTCHours() << 11) | (time.getUTCMinutes() << 5) | (time.getUTCSeconds() >> 1),
    date: ((Math.max(1980, Math.min(2107, time.getUTCFullYear())) - 1980) << 9) |
      ((time.getUTCMonth() + 1) << 5) | time.getUTCDate(),
  };
}

async function* zipParts(storage: ObjectStorage, files: ZipFile[]) {
  const index: ZipIndex[] = [];
  let offset = 0;
  for (const file of files) {
    const object = await storage.read(file.key);
    if (!object) throw new Error('Оригинал отсутствует в хранилище.');
    const item = { name: new TextEncoder().encode(file.name), ...dosTimestamp(file.createdAt), size: file.size, offset, crc: 0 };
    const header = bytesWith(30, view => {
      view.setUint32(0, 0x04034b50, true);
      view.setUint16(4, 20, true);
      view.setUint16(6, 0x0808, true); // UTF-8, with trailing data descriptor.
      view.setUint16(10, item.time, true);
      view.setUint16(12, item.date, true);
      view.setUint16(26, item.name.length, true);
    });
    const reader = object.body.getReader();
    let read = 0;
    let finished = false;
    try {
      yield header;
      yield item.name;
      for (;;) {
        const part = await reader.read();
        if (part.done) { finished = true; break; }
        item.crc = crc32(part.value, item.crc);
        read += part.value.byteLength;
        yield part.value;
      }
    } finally {
      if (!finished) await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
    if (read !== item.size) throw new Error('Размер оригинала изменился.');
    yield bytesWith(16, view => {
      view.setUint32(0, 0x08074b50, true);
      view.setUint32(4, item.crc, true);
      view.setUint32(8, item.size, true);
      view.setUint32(12, item.size, true);
    });
    index.push(item);
    offset += header.length + item.name.length + item.size + 16;
  }
  const startOfIndex = offset;
  for (const item of index) {
    yield bytesWith(46, view => {
      view.setUint32(0, 0x02014b50, true);
      view.setUint16(4, 20, true);
      view.setUint16(6, 20, true);
      view.setUint16(8, 0x0808, true);
      view.setUint16(12, item.time, true);
      view.setUint16(14, item.date, true);
      view.setUint32(16, item.crc, true);
      view.setUint32(20, item.size, true);
      view.setUint32(24, item.size, true);
      view.setUint16(28, item.name.length, true);
      view.setUint32(42, item.offset, true);
    });
    yield item.name;
    offset += 46 + item.name.length;
  }
  yield bytesWith(22, view => {
    view.setUint32(0, 0x06054b50, true);
    view.setUint16(8, index.length, true);
    view.setUint16(10, index.length, true);
    view.setUint32(12, offset - startOfIndex, true);
    view.setUint32(16, startOfIndex, true);
  });
}

export function streamZip(storage: ObjectStorage, files: ZipFile[]) {
  const iterator = zipParts(storage, files);
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const part = await iterator.next();
      if (part.done) controller.close();
      else controller.enqueue(part.value);
    },
    async cancel() { await iterator.return(undefined); },
  });
}
