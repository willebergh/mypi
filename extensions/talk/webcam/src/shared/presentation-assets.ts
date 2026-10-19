/** Node-only local assets, shared by the Talk producer and Electron main. Never import in a renderer. */
import { randomBytes } from 'node:crypto';
import { constants, closeSync, fchmodSync, fstatSync, lstatSync, mkdirSync, openSync, readSync, unlinkSync, writeSync, type Stats } from 'node:fs';
import { dirname, extname, isAbsolute, join, parse, resolve } from 'node:path';
import { PRESENTATION_MAX_IMAGE_BYTES, parsePresentationImage, presentationDimensions, type PresentationImage } from './presentation-protocol.ts';

const same = (a: Stats, b: Stats) => a.dev === b.dev && a.ino === b.ino;
export class PresentationAssetError extends Error {}
function bad(message: string): never { throw new PresentationAssetError(message); }
const uid = () => process.getuid?.() ?? bad('Presentations require a same-user local filesystem');
function absolute(path: string): string {
  if (typeof path !== 'string' || !isAbsolute(path) || path.length > 4096 || /[\u0000-\u001f\u007f]/u.test(path)
    || path.split(/[\\/]/u).includes('..')) bad('Use an absolute local image path without parent traversal');
  return resolve(path);
}
/** Node has no portable openat(). Hold no-follow directory descriptors and recheck
 * inode identities around every synchronous operation. Assumes the same OS user
 * does not maliciously rename ancestors concurrently (see integration notes). */
function directories<T>(path: string, privateLeaves: number, operation: () => T): T {
  path = absolute(path);
  const root = parse(path).root;
  const parts = path.slice(root.length).split('/').filter(Boolean);
  const opened: { path: string; fd: number; stat: Stats }[] = [];
  try {
    let current = root;
    for (let i = -1; i < parts.length; i++) {
      if (i >= 0) current = join(current, parts[i]);
      const before = lstatSync(current);
      if (!before.isDirectory() || before.isSymbolicLink()) bad('Image/cache directories must not contain symlinks');
      const fd = openSync(current, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      const stat = fstatSync(fd);
      opened.push({ path: current, fd, stat });
      if (!same(before, stat) || !stat.isDirectory()) bad('Image/cache directory changed');
      if (i >= parts.length - privateLeaves && (stat.uid !== uid() || (stat.mode & 0o777) !== 0o700))
        bad('Presentation cache directories must be owned by this user with mode 0700');
    }
    const verify = () => {
      for (const entry of opened) {
        const next = lstatSync(entry.path);
        if (next.isSymbolicLink() || !same(entry.stat, next)) bad('Image/cache directory changed');
      }
    };
    verify();
    const result = operation();
    verify();
    return result;
  } finally { for (const entry of opened.reverse()) closeSync(entry.fd); }
}
function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
export type PresentationImageInfo = Omit<PresentationImage, 'assetId'>;
/** Real PNG/JPEG signatures, bounded container structure and dimensions; decoder
 * still must reject corrupt compressed pixels before delivering a prepared image. */
export function inspectPresentationImage(data: Buffer): PresentationImageInfo {
  if (data.length < 24 || data.length > PRESENTATION_MAX_IMAGE_BYTES) bad('Image must be 24 bytes to 8 MiB');
  let width = 0, height = 0;
  let mime: PresentationImage['mime'];
  if (data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    mime = 'image/png';
    let offset = 8, chunks = 0, imageData = false, ended = false;
    while (offset + 12 <= data.length) {
      if (++chunks > 4096) bad('PNG contains too many chunks');
      const size = data.readUInt32BE(offset), end = offset + 12 + size;
      if (end > data.length) bad('PNG is truncated');
      const type = data.toString('ascii', offset + 4, offset + 8);
      if (!/^[A-Za-z]{4}$/u.test(type) || crc32(data.subarray(offset + 4, end - 4)) !== data.readUInt32BE(end - 4)) bad('PNG chunk is invalid');
      if (chunks === 1) {
        if (type !== 'IHDR' || size !== 13) bad('PNG header is invalid');
        width = data.readUInt32BE(offset + 8); height = data.readUInt32BE(offset + 12);
        const depth = data[offset + 16], color = data[offset + 17];
        const depths: Record<number, number[]> = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
        if (!depths[color]?.includes(depth) || data[offset + 18] !== 0 || data[offset + 19] !== 0 || data[offset + 20] > 1) bad('Unsupported PNG encoding');
      } else if (type === 'IHDR') bad('PNG has duplicate headers');
      if (type === 'acTL' || type === 'fcTL' || type === 'fdAT') bad('Animated PNG is not supported');
      if (type === 'IDAT') imageData = true;
      if (type === 'IEND') {
        if (size !== 0 || !imageData || end !== data.length) bad('PNG ending is invalid');
        ended = true; break;
      }
      offset = end;
    }
    if (!ended) bad('PNG has no complete image');
  } else if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
    mime = 'image/jpeg';
    let offset = 2, segments = 0, scanned = false, ended = false;
    while (offset < data.length) {
      if (++segments > 8192 || data[offset++] !== 0xff) bad('JPEG marker is invalid');
      while (offset < data.length && data[offset] === 0xff) offset++;
      const marker = data[offset++];
      if (marker === 0xd9) { ended = offset === data.length; break; }
      if (marker === 0xd8 || marker === 0 || marker === undefined || (marker >= 0xd0 && marker <= 0xd7)) bad('JPEG marker is invalid');
      if (offset + 2 > data.length) bad('JPEG is truncated');
      const length = data.readUInt16BE(offset), end = offset + length;
      if (length < 2 || end > data.length) bad('JPEG segment is truncated');
      const sof = marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);
      if (sof) {
        if (![0xc0, 0xc2].includes(marker) || width || length < 11 || data[offset + 2] !== 8) bad('Only 8-bit baseline/progressive JPEG is supported');
        height = data.readUInt16BE(offset + 3); width = data.readUInt16BE(offset + 5);
        const components = data[offset + 7];
        if (![1, 3, 4].includes(components) || length !== 8 + 3 * components) bad('JPEG frame is invalid');
      }
      offset = end;
      if (marker === 0xda) {
        if (!width || length < 6) bad('JPEG scan is invalid');
        scanned = true;
        // Entropy bytes: skip escaped FF and restart markers, retaining the next real marker.
        while (offset < data.length) {
          if (data[offset] !== 0xff) { offset++; continue; }
          let next = offset + 1;
          while (next < data.length && data[next] === 0xff) next++;
          if (data[next] === 0 || (data[next] >= 0xd0 && data[next] <= 0xd7)) { offset = next + 1; continue; }
          break;
        }
      }
    }
    if (!ended || !scanned) bad('JPEG has no complete image');
  } else bad('Only real PNG and JPEG images are supported');
  if (!presentationDimensions(width, height)) bad('Image dimensions must be 1–4096 pixels per edge and at most 8 megapixels');
  return { mime, bytes: data.length, width, height };
}
function readImage(path: string, cache = false): { data: Buffer; info: PresentationImageInfo } {
  return directories(dirname(path), cache ? 2 : 0, () => {
    const before = lstatSync(path);
    if (!before.isFile() || before.isSymbolicLink() || before.size < 24 || before.size > PRESENTATION_MAX_IMAGE_BYTES)
      bad('Image must be a regular local file of 24 bytes to 8 MiB');
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || !same(before, stat) || stat.size !== before.size
        || (cache && (stat.uid !== uid() || (stat.mode & 0o777) !== 0o600 || stat.nlink !== 1))) bad('Unsafe or changed image file');
      // Only sniff a fixed header until magic is verified. Never fully read a nonimage file.
      const head = Buffer.alloc(24);
      if (readSync(fd, head, 0, head.length, 0) !== head.length) bad('Image is truncated');
      if (!head.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
        && !(head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff)) bad('File is not a PNG or JPEG image');
      const data = Buffer.alloc(stat.size);
      let offset = 0;
      while (offset < data.length) {
        const count = readSync(fd, data, offset, data.length - offset, offset);
        if (!count) bad('Image changed while reading');
        offset += count;
      }
      const after = fstatSync(fd), named = lstatSync(path);
      if (!same(stat, named) || !same(stat, after) || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs)
        bad('Image changed while reading');
      return { data, info: inspectPresentationImage(data) };
    } finally { closeSync(fd); }
  });
}
export function presentationAssetPath(socketPath: string, image: PresentationImage): string {
  const valid = parsePresentationImage(image);
  if (!valid) bad('Invalid presentation asset metadata');
  return join(dirname(absolute(socketPath)), 'presentations', `${valid.assetId}.${valid.mime === 'image/png' ? 'png' : 'jpg'}`);
}
/** Consumer derives the ONLY accepted path from its configured HUD socket, not the payload. */
export function readPresentationAsset(socketPath: string, image: PresentationImage): Buffer {
  const { data, info } = readImage(presentationAssetPath(socketPath, image), true);
  if (info.mime !== image.mime || info.bytes !== image.bytes || info.width !== image.width || info.height !== image.height)
    bad('Presentation image does not match its metadata');
  return data;
}
/** One controller/cache per publisher. At most current + staging (16 MiB total).
 * Failed removals remain tracked and block further allocation at the cap. No scans,
 * recursive deletes, source writes, or deletion of files from another controller. */
export function createPresentationAssetCache(socketPath: string) {
  socketPath = absolute(socketPath);
  const directory = join(dirname(socketPath), 'presentations');
  const owned = new Map<string, { path: string; stat: Stats }>();
  function remove(assetId: string): void {
    const entry = owned.get(assetId);
    if (!entry) return;
    try {
      directories(directory, 2, () => {
        const current = lstatSync(entry.path);
        if (!current.isFile() || current.isSymbolicLink() || !same(entry.stat, current)) bad('Owned presentation file was replaced');
        unlinkSync(entry.path);
      });
      owned.delete(assetId);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') owned.delete(assetId);
      // Preserve exact ownership records on any uncertainty, never unlink replacements.
    }
  }
  return {
    put(source: string): PresentationImage {
      source = absolute(source);
      if (!['.png', '.jpg', '.jpeg'].includes(extname(source).toLowerCase())) bad('Choose a local .png, .jpg or .jpeg image');
      if (source.split('/').some(part => /^(?:\.env(?:\..*)?|\.ssh|\.aws|\.gnupg|\.kube)$/iu.test(part)
        || /(?:^|[._-])(?:auth|credentials?|secrets?|tokens?|passwords?|id_rsa|id_ed25519)(?:[._-]|$)/iu.test(part)))
        bad('Credential and secret paths cannot be presented');
      if (owned.size >= 2) bad('Presentation cache is full; clear it before replacing the image');
      const { data, info } = readImage(source);
      const assetId = randomBytes(16).toString('hex');
      const image = { assetId, ...info };
      const path = presentationAssetPath(socketPath, image);
      try {
        directories(dirname(socketPath), 1, () => {
          try { mkdirSync(directory, { mode: 0o700 }); } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
          }
          directories(directory, 2, () => {
            const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
            try {
              owned.set(assetId, { path, stat: fstatSync(fd) });
              fchmodSync(fd, 0o600);
              let offset = 0;
              while (offset < data.length) {
                const count = writeSync(fd, data, offset, data.length - offset);
                if (!count) bad('Could not write presentation image');
                offset += count;
              }
            } finally { closeSync(fd); }
          });
        });
        return image;
      } catch (error) { remove(assetId); throw error; }
    },
    remove,
    clear() { for (const id of owned.keys()) remove(id); },
    /** Diagnostics are counts only, never filenames or source paths. */
    count: () => owned.size,
  };
}
