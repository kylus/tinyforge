// The git object layer: hashing, the object store, tree and commit codecs, and the pack format in both
// directions. Everything lives in memory (the forge's store is one process long) and uses only node:zlib
// and node:crypto.
import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export type ObjType = 'commit' | 'tree' | 'blob' | 'tag';
export const ZERO = '0'.repeat(40);

export interface GitObject {
  readonly type: ObjType;
  readonly data: Buffer;
  readonly sha: string;
  /** The zlib form used inside a pack, kept once made: 50 concurrent clones share it. */
  z?: Buffer;
}

const TYPE_NUM: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const NUM_TYPE: (ObjType | undefined)[] = [undefined, 'commit', 'tree', 'blob', 'tag'];

export function hashObject(type: ObjType, data: Buffer): string {
  const h = createHash('sha1');
  h.update(`${type} ${data.length}\0`);
  h.update(data);
  return h.digest('hex');
}

export class ObjectStore {
  readonly objects = new Map<string, GitObject>();

  has(sha: string): boolean {
    return this.objects.has(sha);
  }

  get(sha: string): GitObject | undefined {
    return this.objects.get(sha);
  }

  put(type: ObjType, data: Buffer): GitObject {
    const sha = hashObject(type, data);
    const known = this.objects.get(sha);
    if (known !== undefined) return known;
    const obj: GitObject = { type, data, sha };
    this.objects.set(sha, obj);
    return obj;
  }
}

// ---------------------------------------------------------------- trees and commits

export interface TreeEntry {
  mode: string; // '100644', '100755', '120000', '40000', '160000'
  name: string;
  sha: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const out: TreeEntry[] = [];
  let pos = 0;
  while (pos < data.length) {
    const space = data.indexOf(0x20, pos);
    const nul = data.indexOf(0, space);
    out.push({
      mode: data.toString('latin1', pos, space),
      name: data.toString('utf8', space + 1, nul),
      sha: data.toString('hex', nul + 1, nul + 21),
    });
    pos = nul + 21;
  }
  return out;
}

const isDir = (e: TreeEntry): boolean => e.mode === '40000' || e.mode === '040000';

/** Git sorts tree entries by name, a directory compared as if its name ended in '/'. */
export function encodeTree(entries: TreeEntry[]): Buffer {
  const key = (e: TreeEntry): Buffer => Buffer.from(isDir(e) ? `${e.name}/` : e.name, 'utf8');
  const sorted = entries.map((e) => ({ e, k: key(e) })).sort((a, b) => Buffer.compare(a.k, b.k));
  const parts: Buffer[] = [];
  for (const { e } of sorted) {
    parts.push(Buffer.from(`${isDir(e) ? '40000' : e.mode} ${e.name}\0`, 'utf8'), Buffer.from(e.sha, 'hex'));
  }
  return Buffer.concat(parts);
}

export interface CommitInfo {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export function parseCommit(data: Buffer): CommitInfo {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split < 0 ? text : text.slice(0, split);
  const info: CommitInfo = { tree: '', parents: [], author: '', committer: '', message: split < 0 ? '' : text.slice(split + 2) };
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) info.tree = line.slice(5);
    else if (line.startsWith('parent ')) info.parents.push(line.slice(7));
    else if (line.startsWith('author ')) info.author = line.slice(7);
    else if (line.startsWith('committer ')) info.committer = line.slice(10);
  }
  return info;
}

export interface TagInfo {
  object: string;
  type: string;
  tag: string;
}

export function parseTag(data: Buffer): TagInfo {
  const info: TagInfo = { object: '', type: '', tag: '' };
  for (const line of data.toString('utf8').split('\n')) {
    if (line === '') break;
    if (line.startsWith('object ')) info.object = line.slice(7);
    else if (line.startsWith('type ')) info.type = line.slice(5);
    else if (line.startsWith('tag ')) info.tag = line.slice(4);
  }
  return info;
}

/** "Name <email> 1700000000 +0000": the parts of an identity line. */
export function parseIdent(line: string): { name: string; email: string; epoch: number; tz: string } {
  const m = /^(.*?) <([^>]*)> (\d+) ([+-]\d{4})$/.exec(line);
  if (m === null) return { name: line, email: '', epoch: 0, tz: '+0000' };
  return { name: m[1] ?? '', email: m[2] ?? '', epoch: Number(m[3]), tz: m[4] ?? '+0000' };
}

export function encodeCommit(c: CommitInfo): Buffer {
  const lines = [`tree ${c.tree}`, ...c.parents.map((p) => `parent ${p}`), `author ${c.author}`, `committer ${c.committer}`, '', c.message];
  return Buffer.from(lines.join('\n'), 'utf8');
}

// ---------------------------------------------------------------- pack reading

class PackError extends Error {}
export { PackError };

function readVarintSize(buf: Buffer, start: number): { size: number; pos: number } {
  let pos = start;
  let c = buf[pos++] ?? 0;
  let size = 0;
  let shift = 0;
  for (;;) {
    size += (c & 0x7f) * 2 ** shift;
    if ((c & 0x80) === 0) break;
    c = buf[pos++] ?? 0;
    shift += 7;
  }
  return { size, pos };
}

function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let r = readVarintSize(delta, 0);
  if (r.size !== base.length) throw new PackError('delta base size mismatch');
  r = readVarintSize(delta, r.pos);
  const out = Buffer.allocUnsafe(r.size);
  let pos = r.pos;
  let w = 0;
  while (pos < delta.length) {
    const op = delta[pos++] as number;
    if (op & 0x80) {
      let off = 0;
      let len = 0;
      if (op & 1) off |= (delta[pos++] as number);
      if (op & 2) off |= (delta[pos++] as number) << 8;
      if (op & 4) off |= (delta[pos++] as number) << 16;
      if (op & 8) off |= ((delta[pos++] as number) << 24) >>> 0;
      if (op & 16) len |= (delta[pos++] as number);
      if (op & 32) len |= (delta[pos++] as number) << 8;
      if (op & 64) len |= (delta[pos++] as number) << 16;
      if (len === 0) len = 0x10000;
      base.copy(out, w, off, off + len);
      w += len;
    } else if (op > 0) {
      delta.copy(out, w, pos, pos + op);
      pos += op;
      w += op;
    } else throw new PackError('bad delta opcode');
  }
  if (w !== out.length) throw new PackError('delta result size mismatch');
  return out;
}

interface Packed {
  offset: number;
  type: number;
  data: Buffer;
  baseOffset?: number;
  baseSha?: string;
}

/**
 * Read a whole pack into the store (resolving ofs and ref deltas, thin packs against the store itself)
 * and return the new objects' ids. A malformed pack throws PackError and leaves nothing half-added.
 */
export function ingestPack(buf: Buffer, store: ObjectStore): string[] {
  if (buf.length < 32 || buf.toString('latin1', 0, 4) !== 'PACK') throw new PackError('not a pack');
  const sum = createHash('sha1').update(buf.subarray(0, buf.length - 20)).digest();
  if (!sum.equals(buf.subarray(buf.length - 20))) throw new PackError('pack checksum mismatch');
  const count = buf.readUInt32BE(8);
  const entries: Packed[] = [];
  let pos = 12;
  for (let i = 0; i < count; i += 1) {
    const offset = pos;
    let c = buf[pos++] as number;
    const type = (c >> 4) & 7;
    let size = c & 15;
    let shift = 4;
    while (c & 0x80) {
      c = buf[pos++] as number;
      size += (c & 0x7f) * 2 ** shift;
      shift += 7;
    }
    const entry: Packed = { offset, type, data: Buffer.alloc(0) };
    if (type === 6) {
      c = buf[pos++] as number;
      let off = c & 0x7f;
      while (c & 0x80) {
        c = buf[pos++] as number;
        off = ((off + 1) << 7) | (c & 0x7f);
      }
      entry.baseOffset = offset - off;
    } else if (type === 7) {
      entry.baseSha = buf.toString('hex', pos, pos + 20);
      pos += 20;
    } else if (type < 1 || type > 4) throw new PackError(`bad object type ${type}`);
    const res = inflateSync(buf.subarray(pos, buf.length - 20), { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
    if (res.buffer.length !== size) throw new PackError('object size mismatch');
    entry.data = res.buffer;
    pos += res.engine.bytesWritten;
    entries.push(entry);
  }
  const fresh: string[] = [];
  const byOffset = new Map<number, { type: ObjType; data: Buffer; sha: string }>();
  const add = (e: Packed, type: ObjType, data: Buffer): void => {
    const had = store.has(hashObject(type, data));
    const obj = store.put(type, data);
    byOffset.set(e.offset, { type, data, sha: obj.sha });
    if (!had) fresh.push(obj.sha);
  };
  let pending: Packed[] = [];
  for (const e of entries) {
    if (e.type <= 4) add(e, NUM_TYPE[e.type] as ObjType, e.data);
    else pending.push(e);
  }
  while (pending.length > 0) {
    const next: Packed[] = [];
    for (const e of pending) {
      let base: { type: ObjType; data: Buffer } | undefined;
      if (e.baseOffset !== undefined) base = byOffset.get(e.baseOffset);
      else if (e.baseSha !== undefined) base = store.get(e.baseSha);
      if (base === undefined) next.push(e);
      else add(e, base.type, applyDelta(base.data, e.data));
    }
    if (next.length === pending.length) throw new PackError('unresolved delta base');
    pending = next;
  }
  return fresh;
}

// ---------------------------------------------------------------- pack writing

function entryHeader(type: number, size: number): Buffer {
  const bytes: number[] = [];
  let c = (type << 4) | (size & 15);
  size = Math.floor(size / 16);
  while (size > 0) {
    bytes.push(c | 0x80);
    c = size & 0x7f;
    size = Math.floor(size / 128);
  }
  bytes.push(c);
  return Buffer.from(bytes);
}

export function buildPack(objs: GitObject[]): Buffer {
  const head = Buffer.alloc(12);
  head.write('PACK', 0, 'latin1');
  head.writeUInt32BE(2, 4);
  head.writeUInt32BE(objs.length, 8);
  const parts: Buffer[] = [head];
  for (const o of objs) {
    if (o.z === undefined) o.z = deflateSync(o.data, { level: 1 });
    parts.push(entryHeader(TYPE_NUM[o.type], o.data.length), o.z);
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

// ---------------------------------------------------------------- pkt-lines

export function pkt(data: string | Buffer): Buffer {
  const b = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  return Buffer.concat([Buffer.from((b.length + 4).toString(16).padStart(4, '0'), 'latin1'), b]);
}

export const FLUSH = Buffer.from('0000', 'latin1');
export const DELIM = Buffer.from('0001', 'latin1');

export type PktItem = { kind: 'data'; data: Buffer } | { kind: 'flush' } | { kind: 'delim' };

/** Read pkt-lines from `pos`; stops after `stopAtFlush` flushes (0: reads to the end). */
export function readPkts(buf: Buffer, pos = 0, stopAtFlush = 0): { items: PktItem[]; pos: number } {
  const items: PktItem[] = [];
  let flushes = 0;
  while (pos + 4 <= buf.length) {
    const len = Number.parseInt(buf.toString('latin1', pos, pos + 4), 16);
    if (Number.isNaN(len)) throw new PackError('bad pkt-line');
    if (len === 0) {
      items.push({ kind: 'flush' });
      pos += 4;
      flushes += 1;
      if (stopAtFlush > 0 && flushes >= stopAtFlush) break;
    } else if (len === 1) {
      items.push({ kind: 'delim' });
      pos += 4;
    } else if (len < 4 || pos + len > buf.length) throw new PackError('truncated pkt-line');
    else {
      items.push({ kind: 'data', data: buf.subarray(pos + 4, pos + len) });
      pos += len;
    }
  }
  return { items, pos };
}

/** A pack split into side-band-64k data packets on band 1, as one buffer. */
export function sideband(band: number, data: Buffer): Buffer {
  const parts: Buffer[] = [];
  for (let at = 0; at < data.length; at += 65515) {
    parts.push(pkt(Buffer.concat([Buffer.from([band]), data.subarray(at, at + 65515)])));
  }
  return Buffer.concat(parts);
}
