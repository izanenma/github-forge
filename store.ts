// The forge's store: one in-memory model for every surface (REST, GraphQL, MCP, git).
// Everything here is deterministic: timestamps come from MAKEFUN_TRIAL_NOW (or a fixed
// fallback), ids are sequential counters, and iteration follows insertion order. No wall
// clock, no Math.random, no per-request UUID anywhere in this file.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

// -------------------------------------------------------------------------------------------
// time and identity
// -------------------------------------------------------------------------------------------

/** The trial's fixed now: MAKEFUN_TRIAL_NOW (RFC 3339 or epoch ms), else a fixed instant. */
function trialNow(): { iso: string; epoch: number } {
  const raw = (process.env.MAKEFUN_TRIAL_NOW ?? '').trim();
  const fallback = { iso: '2026-01-01T00:00:00Z', epoch: 1767225600 };
  if (raw === '') return fallback;
  if (/^\d+$/.test(raw)) {
    const ms = Number(raw);
    if (Number.isFinite(ms) && ms > 0) {
      const d = new Date(ms);
      if (!Number.isNaN(d.getTime())) return { iso: d.toISOString().replace('.000Z', 'Z'), epoch: Math.floor(ms / 1000) };
    }
    return fallback;
  }
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return fallback;
  return { iso: d.toISOString().replace('.000Z', 'Z'), epoch: Math.floor(d.getTime() / 1000) };
}

export const NOW = trialNow();
export const NOW_ISO: string = NOW.iso;
export const NOW_EPOCH: number = NOW.epoch;

/** The token's owner: the scenario's viewer (wire.ts buildScenario, constant seed). */
export const VIEWER = { id: 1000, login: 'adaiversen', name: 'ada iversen', email: 'adaiversen@example.invalid' };
export const STRANGER_LOGIN = 'olgabauer';
export const DEFAULT_BRANCH = 'main';
export const ZERO_OID = '0'.repeat(40);

// -------------------------------------------------------------------------------------------
// git objects
// -------------------------------------------------------------------------------------------

export type ObjType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: ObjType;
  data: Buffer;
}

export function hashObject(type: ObjType, data: Buffer): string {
  const h = createHash('sha1');
  h.update(Buffer.from(`${type} ${data.length}\0`, 'utf8'));
  h.update(data);
  return h.digest('hex');
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let off = 0;
  while (off < data.length) {
    const sp = data.indexOf(0x20, off);
    const nul = data.indexOf(0x00, sp + 1);
    entries.push({
      mode: data.subarray(off, sp).toString('ascii'),
      name: data.subarray(sp + 1, nul).toString('utf8'),
      oid: data.subarray(nul + 1, nul + 21).toString('hex'),
    });
    off = nul + 21;
  }
  return entries;
}

function compareTreeNames(a: TreeEntry, b: TreeEntry): number {
  const l = Buffer.from(a.mode === '40000' ? `${a.name}/` : a.name, 'utf8');
  const r = Buffer.from(b.mode === '40000' ? `${b.name}/` : b.name, 'utf8');
  return Buffer.compare(l, r);
}

export function buildTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort(compareTreeNames);
  const parts: Buffer[] = [];
  for (const e of sorted) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'));
    parts.push(Buffer.from(e.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export interface CommitView {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export function parseCommit(data: Buffer): CommitView {
  const blank = data.indexOf('\n\n');
  const head = blank < 0 ? data.toString('utf8') : data.subarray(0, blank).toString('utf8');
  const message = blank < 0 ? '' : data.subarray(blank + 2).toString('utf8');
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of head.split('\n')) {
    const sp = line.indexOf(' ');
    const key = sp < 0 ? line : line.slice(0, sp);
    const val = sp < 0 ? '' : line.slice(sp + 1);
    if (key === 'tree') tree = val;
    else if (key === 'parent') parents.push(val);
    else if (key === 'author') author = val;
    else if (key === 'committer') committer = val;
  }
  return { tree, parents, author, committer, message };
}

export function buildCommit(o: { tree: string; parents: string[]; message: string; timestamp?: number }): Buffer {
  const ts = o.timestamp ?? NOW_EPOCH;
  const who = `${VIEWER.name} <${VIEWER.email}> ${ts} +0000`;
  const lines = [`tree ${o.tree}`];
  for (const p of o.parents) lines.push(`parent ${p}`);
  lines.push(`author ${who}`, `committer ${who}`, '');
  return Buffer.from(`${lines.join('\n')}\n${o.message}`, 'utf8');
}

export interface TagView {
  object: string;
  type: ObjType;
  tag: string;
  tagger: string;
  message: string;
}

export function parseTag(data: Buffer): TagView {
  const blank = data.indexOf('\n\n');
  const head = blank < 0 ? data.toString('utf8') : data.subarray(0, blank).toString('utf8');
  const headers = new Map<string, string>();
  for (const line of head.split('\n')) {
    const sp = line.indexOf(' ');
    if (sp >= 0) headers.set(line.slice(0, sp), line.slice(sp + 1));
  }
  return {
    object: headers.get('object') ?? '',
    type: (headers.get('type') ?? 'commit') as ObjType,
    tag: headers.get('tag') ?? '',
    tagger: headers.get('tagger') ?? '',
    message: blank < 0 ? '' : data.subarray(blank + 2).toString('utf8'),
  };
}

/** Peel a tag (recursively) to the commit it names, or the oid itself when it is not a tag. */
export function peelToCommit(objects: Map<string, GitObject>, oid: string): string {
  let cur = oid;
  for (let i = 0; i < 16; i += 1) {
    const obj = objects.get(cur);
    if (!obj || obj.type !== 'tag') return cur;
    cur = parseTag(obj.data).object;
  }
  return cur;
}

/** Every object reachable from `roots` (commits, trees, tags, blobs). */
export function collectReachable(objects: Map<string, GitObject>, roots: Iterable<string>): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [];
  for (const r of roots) if (/^[0-9a-f]{40}$/.test(r)) queue.push(r);
  while (queue.length) {
    const oid = queue.pop()!;
    if (seen.has(oid)) continue;
    const obj = objects.get(oid);
    if (!obj) continue;
    seen.add(oid);
    if (obj.type === 'commit') {
      const c = parseCommit(obj.data);
      queue.push(c.tree);
      for (const p of c.parents) queue.push(p);
    } else if (obj.type === 'tag') {
      queue.push(parseTag(obj.data).object);
    } else if (obj.type === 'tree') {
      for (const e of parseTree(obj.data)) if (e.mode !== '160000') queue.push(e.oid);
    }
  }
  return seen;
}

// -------------------------------------------------------------------------------------------
// packfiles (plain objects; deltas resolved on read)
// -------------------------------------------------------------------------------------------

const TYPE_CODE: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, ObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

function packObjectHeader(type: ObjType, size: number): Buffer {
  const code = TYPE_CODE[type];
  const bytes: number[] = [];
  let rem = size;
  let first = (code << 4) | (rem & 0x0f);
  rem = Math.floor(rem / 16);
  while (rem > 0) {
    bytes.push(first | 0x80);
    first = rem & 0x7f;
    rem = Math.floor(rem / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

export function writePack(objects: Iterable<GitObject>): Buffer {
  const list = [...objects];
  const parts: Buffer[] = [];
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(list.length, 8);
  parts.push(header);
  for (const o of list) {
    parts.push(packObjectHeader(o.type, o.data.length));
    parts.push(deflateSync(o.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

function readVarint(buf: Buffer, start: number): { size: number; next: number; first: number } {
  let b = buf[start];
  const first = b;
  let size = b & 0x0f;
  let shift = 4;
  let off = start + 1;
  while (b & 0x80) {
    b = buf[off++];
    size += (b & 0x7f) * 2 ** shift;
    shift += 7;
  }
  return { size, next: off, first };
}

function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let off = 0;
  const readSize = (): number => {
    let v = 0;
    let shift = 0;
    for (;;) {
      const b = delta[off++];
      v += (b & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(b & 0x80)) break;
    }
    return v;
  };
  const srcSize = readSize();
  const tgtSize = readSize();
  if (srcSize !== base.length) throw new Error('delta base size mismatch');
  const out = Buffer.allocUnsafe(tgtSize);
  let written = 0;
  while (off < delta.length) {
    const op = delta[off++];
    if (op & 0x80) {
      let cpOff = 0;
      let cpSize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) cpOff += delta[off++] * 2 ** shift;
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if (op & (1 << bit)) cpSize += delta[off++] * 2 ** shift;
        shift += 8;
      }
      if (cpSize === 0) cpSize = 0x10000;
      base.copy(out, written, cpOff, cpOff + cpSize);
      written += cpSize;
    } else if (op !== 0) {
      const n = op & 0x7f;
      delta.copy(out, written, off, off + n);
      off += n;
      written += n;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  if (written !== tgtSize) throw new Error('delta size mismatch');
  return out;
}

/** Parse a packfile into objects (validating SHA-1s). Throws on any corruption. */
export function readPack(pack: Buffer): Map<string, GitObject> {
  if (pack.length < 32) throw new Error('pack too short');
  if (pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('bad pack magic');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = pack.readUInt32BE(8);
  const trailerStart = pack.length - 20;
  const trailer = pack.subarray(trailerStart).toString('hex');
  if (createHash('sha1').update(pack.subarray(0, trailerStart)).digest('hex') !== trailer) {
    throw new Error('pack checksum mismatch');
  }
  interface Raw {
    offset: number;
    typeCode: number;
    size: number;
    data: Buffer;
    baseOffset?: number;
    baseOid?: string;
  }
  const raw: Raw[] = [];
  const byOffset = new Map<number, Raw>();
  let off = 12;
  for (let i = 0; i < count; i += 1) {
    const entryOff = off;
    const h = readVarint(pack, off);
    off = h.next;
    const typeCode = (h.first >> 4) & 0x07;
    const entry: Raw = { offset: entryOff, typeCode, size: h.size, data: Buffer.alloc(0) };
    if (typeCode === 6) {
      let b = pack[off++];
      let value = b & 0x7f;
      while (b & 0x80) {
        b = pack[off++];
        value = ((value + 1) * 128) + (b & 0x7f);
      }
      entry.baseOffset = entryOff - value;
    } else if (typeCode === 7) {
      entry.baseOid = pack.subarray(off, off + 20).toString('hex');
      off += 20;
    } else if (!CODE_TYPE[typeCode]) {
      throw new Error(`unknown pack type ${typeCode}`);
    }
    const inflated = inflateSync(pack.subarray(off, trailerStart), { info: true }) as unknown as {
      buffer: Buffer;
      engine: { bytesWritten: number };
    };
    if (inflated.buffer.length !== h.size) throw new Error('pack entry size mismatch');
    entry.data = inflated.buffer;
    off += inflated.engine.bytesWritten;
    raw.push(entry);
    byOffset.set(entryOff, entry);
  }
  const objects = new Map<string, GitObject>();
  const resolvedByOid = new Map<string, Raw>();
  const resolving = new Set<number>();
  const resolve = (e: Raw): { type: ObjType; data: Buffer; oid: string } => {
    const cached = (e as Raw & { _r?: { type: ObjType; data: Buffer; oid: string } })._r;
    if (cached) return cached;
    if (resolving.has(e.offset)) throw new Error('delta cycle');
    resolving.add(e.offset);
    let type: ObjType;
    let data: Buffer;
    if (e.typeCode === 6) {
      const base = byOffset.get(e.baseOffset!);
      if (!base) throw new Error('ofs-delta base missing');
      const b = resolve(base);
      type = b.type;
      data = applyDelta(b.data, e.data);
    } else if (e.typeCode === 7) {
      const baseEntry = resolvedByOid.get(e.baseOid!);
      if (baseEntry) {
        const b = resolve(baseEntry);
        type = b.type;
        data = applyDelta(b.data, e.data);
      } else {
        const ext = objects.get(e.baseOid!);
        if (!ext) throw new Error('ref-delta base missing');
        type = ext.type;
        data = applyDelta(ext.data, e.data);
      }
    } else {
      type = CODE_TYPE[e.typeCode];
      data = e.data;
    }
    const oid = hashObject(type, data);
    const out = { type, data, oid };
    (e as Raw & { _r?: unknown })._r = out;
    resolvedByOid.set(oid, e);
    resolving.delete(e.offset);
    return out;
  };
  for (const e of raw) {
    const r = resolve(e);
    if (!objects.has(r.oid)) objects.set(r.oid, { type: r.type, data: r.data });
  }
  return objects;
}

// -------------------------------------------------------------------------------------------
// the store: repositories, issues, pull requests
// -------------------------------------------------------------------------------------------

export interface Label {
  name: string;
  color: string;
}

export interface Comment {
  id: number;
  body: string;
  createdAt: string;
  updatedAt: string;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  createdAt: string;
  updatedAt: string;
  comments: Comment[];
}

export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  head: string;
  base: string;
  headSha: string;
  baseSha: string;
  mergeBase: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Repo {
  id: number;
  owner: string;
  name: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  createdAt: string;
  updatedAt: string;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  labels: Map<string, Label>;
  issues: Map<number, Issue>;
  nextIssue: number;
  pulls: Map<number, Pull>;
  nextPull: number;
}

export class Store {
  repos = new Map<string, Repo>();
  nextRepoId = 1;
  nextIssueId = 1;
  nextPullId = 1;
  nextCommentId = 1;

  key(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  createRepo(name: string, isPrivate: boolean, description: string): Repo | null {
    if (this.repos.has(this.key(VIEWER.login, name))) return null;
    const repo: Repo = {
      id: this.nextRepoId++,
      owner: VIEWER.login,
      name,
      description,
      isPrivate,
      defaultBranch: DEFAULT_BRANCH,
      createdAt: NOW_ISO,
      updatedAt: NOW_ISO,
      objects: new Map(),
      refs: new Map(),
      labels: new Map(),
      issues: new Map(),
      nextIssue: 1,
      pulls: new Map(),
      nextPull: 1,
    };
    this.repos.set(this.key(VIEWER.login, name), repo);
    return repo;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.key(owner, name));
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.key(owner, name));
  }

  listRepos(): Repo[] {
    return [...this.repos.values()];
  }
}

export const store = new Store();

// -------------------------------------------------------------------------------------------
// git helpers on one repository
// -------------------------------------------------------------------------------------------

export function refTip(repo: Repo, ref: string): string | undefined {
  return repo.refs.get(ref);
}

export function defaultTip(repo: Repo): string | undefined {
  return repo.refs.get(`refs/heads/${repo.defaultBranch}`);
}

/** Resolve a branch name, a full ref, or a commit oid to a commit oid. */
export function resolveRef(repo: Repo, name: string): string | undefined {
  if (/^[0-9a-f]{40}$/.test(name)) {
    const obj = repo.objects.get(name);
    if (obj && obj.type === 'commit') return name;
    if (obj && obj.type === 'tag') return peelToCommit(repo.objects, name);
    return undefined;
  }
  if (name.startsWith('refs/')) return repo.refs.get(name);
  return repo.refs.get(`refs/heads/${name}`);
}

export function putObject(repo: Repo, type: ObjType, data: Buffer): string {
  const oid = hashObject(type, data);
  if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
  return oid;
}

/** The tree oid at `path` ('' = root) under a commit's tree, or null. */
export function treeAt(repo: Repo, commitOid: string, path: string): string | null {
  const commit = repo.objects.get(commitOid);
  if (!commit || commit.type !== 'commit') return null;
  let treeOid = parseCommit(commit.data).tree;
  if (path === '' || path === '/') return treeOid;
  for (const seg of path.split('/').filter(Boolean)) {
    const tree = repo.objects.get(treeOid);
    if (!tree) return null;
    const entry = parseTree(tree.data).find((e) => e.name === seg);
    if (!entry || entry.mode !== '40000') return null;
    treeOid = entry.oid;
  }
  return treeOid;
}

/** The blob oid at `path` under a commit's tree, or null. */
export function blobAt(repo: Repo, commitOid: string, path: string): string | null {
  const segs = path.split('/').filter(Boolean);
  if (segs.length === 0) return null;
  const dir = treeAt(repo, commitOid, segs.slice(0, -1).join('/'));
  if (dir === null) return null;
  const tree = repo.objects.get(dir);
  if (!tree) return null;
  const entry = parseTree(tree.data).find((e) => e.name === segs[segs.length - 1]);
  if (!entry || entry.mode === '40000') return null;
  return entry.oid;
}

/** Set (or delete with blobOid null) a path in a tree; returns the new root tree oid. */
export function setPath(repo: Repo, treeOid: string, segs: string[], blobOid: string | null): string {
  if (segs.length === 0) return treeOid;
  const tree = repo.objects.get(treeOid);
  const entries: TreeEntry[] = tree && tree.type === 'tree' ? parseTree(tree.data) : [];
  const [head, ...rest] = segs as [string, ...string[]];
  const idx = entries.findIndex((e) => e.name === head);
  if (rest.length === 0) {
    if (blobOid === null) {
      if (idx >= 0) entries.splice(idx, 1);
    } else if (idx >= 0) {
      entries[idx] = { mode: '100644', name: head, oid: blobOid };
    } else {
      entries.push({ mode: '100644', name: head, oid: blobOid });
    }
  } else {
    const child = idx >= 0 && entries[idx].mode === '40000' ? entries[idx].oid : null;
    const emptyTree = putObject(repo, 'tree', buildTree([]));
    const next = setPath(repo, child ?? emptyTree, rest, blobOid);
    const nextEntries = parseTree(repo.objects.get(next)!.data);
    if (nextEntries.length === 0 && blobOid === null) {
      if (idx >= 0) entries.splice(idx, 1);
    } else if (idx >= 0) {
      entries[idx] = { mode: '40000', name: head, oid: next };
    } else {
      entries.push({ mode: '40000', name: head, oid: next });
    }
  }
  return putObject(repo, 'tree', buildTree(entries));
}

/** All commit oids reachable from `oid` (the commit itself first, parents after). */
export function ancestorsOf(repo: Repo, oid: string): Set<string> {
  const seen = new Set<string>();
  const queue = [oid];
  while (queue.length) {
    const cur = queue.pop()!;
    if (seen.has(cur)) continue;
    const obj = repo.objects.get(cur);
    if (!obj || obj.type !== 'commit') continue;
    seen.add(cur);
    for (const p of parseCommit(obj.data).parents) queue.push(p);
  }
  return seen;
}

export function isAncestor(repo: Repo, anc: string, desc: string): boolean {
  return ancestorsOf(repo, desc).has(anc);
}

/** The merge base of two commits (first common ancestor walking from `a`). */
export function mergeBaseOf(repo: Repo, a: string, b: string): string | null {
  const bAnc = ancestorsOf(repo, b);
  const queue = [a];
  const seen = new Set<string>();
  while (queue.length) {
    const cur = queue.shift()!;
    if (seen.has(cur)) continue;
    seen.add(cur);
    if (bAnc.has(cur)) return cur;
    const obj = repo.objects.get(cur);
    if (!obj || obj.type !== 'commit') continue;
    for (const p of parseCommit(obj.data).parents) queue.push(p);
  }
  return null;
}

export interface FileChange {
  path: string;
  status: 'added' | 'modified' | 'removed';
  oldOid: string | null;
  newOid: string | null;
}

/** Flatten a tree to path -> {mode, oid}. */
export function flattenTree(repo: Repo, treeOid: string, prefix = ''): Map<string, { mode: string; oid: string }> {
  const out = new Map<string, { mode: string; oid: string }>();
  const tree = repo.objects.get(treeOid);
  if (!tree || tree.type !== 'tree') return out;
  for (const e of parseTree(tree.data)) {
    const path = prefix === '' ? e.name : `${prefix}/${e.name}`;
    if (e.mode === '40000') {
      for (const [k, v] of flattenTree(repo, e.oid, path)) out.set(k, v);
    } else {
      out.set(path, { mode: e.mode, oid: e.oid });
    }
  }
  return out;
}

/** The file changes between two trees (merge-base tree vs head tree). */
export function diffTrees(repo: Repo, baseTree: string, headTree: string): FileChange[] {
  const base = flattenTree(repo, baseTree);
  const head = flattenTree(repo, headTree);
  const changes: FileChange[] = [];
  const paths = new Set([...base.keys(), ...head.keys()]);
  for (const path of [...paths].sort()) {
    const b = base.get(path);
    const h = head.get(path);
    if (b && !h) changes.push({ path, status: 'removed', oldOid: b.oid, newOid: null });
    else if (!b && h) changes.push({ path, status: 'added', oldOid: null, newOid: h.oid });
    else if (b && h && b.oid !== h.oid) changes.push({ path, status: 'modified', oldOid: b.oid, newOid: h.oid });
  }
  return changes;
}

/** Line additions/deletions between two blobs (multiset difference). */
export function lineDiff(oldData: Buffer | null, newData: Buffer | null): { additions: number; deletions: number } {
  const oldLines = oldData === null ? [] : oldData.toString('utf8').split('\n');
  const newLines = newData === null ? [] : newData.toString('utf8').split('\n');
  const oldCount = new Map<string, number>();
  for (const l of oldLines) oldCount.set(l, (oldCount.get(l) ?? 0) + 1);
  let additions = 0;
  for (const l of newLines) {
    const n = oldCount.get(l) ?? 0;
    if (n > 0) oldCount.set(l, n - 1);
    else additions += 1;
  }
  let deletions = 0;
  for (const n of oldCount.values()) deletions += n;
  return { additions, deletions };
}

/** Commits reachable from `tip`, newest first (walk order: tip, then parents breadth-first). */
export function listCommits(repo: Repo, tip: string, limit = 100): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const queue = [tip];
  while (queue.length && out.length < limit) {
    const cur = queue.shift()!;
    if (seen.has(cur)) continue;
    seen.add(cur);
    const obj = repo.objects.get(cur);
    if (!obj || obj.type !== 'commit') continue;
    out.push(cur);
    for (const p of parseCommit(obj.data).parents) queue.push(p);
  }
  return out;
}

// -------------------------------------------------------------------------------------------
// global ids (GraphQL Relay ids): opaque, stable, base64 of a typed key
// -------------------------------------------------------------------------------------------

export function gid(kind: string, ...parts: (string | number)[]): string {
  return Buffer.from(`${kind}:${parts.join(':')}`, 'utf8').toString('base64');
}

export function parseGid(id: string): { kind: string; parts: string[] } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const [kind, ...parts] = text.split(':');
    if (!kind || parts.length === 0) return null;
    return { kind, parts };
  } catch {
    return null;
  }
}

// -------------------------------------------------------------------------------------------
// pull requests: creation, conflict detection, squash merge (shared by REST, GraphQL, MCP)
// -------------------------------------------------------------------------------------------

/** Create a pull request record; null when the head/base branch is missing or an open duplicate exists. */
export function createPullRecord(
  repo: Repo,
  nextId: () => number,
  input: { title: string; body: string; head: string; base: string },
): Pull | null {
  const headSha = resolveRef(repo, input.head);
  const baseSha = resolveRef(repo, input.base);
  if (headSha === undefined || baseSha === undefined) return null;
  for (const pr of repo.pulls.values()) {
    if (pr.state === 'open' && pr.head === input.head && pr.base === input.base) return null;
  }
  const mergeBase = mergeBaseOf(repo, headSha, baseSha) ?? baseSha;
  const pull: Pull = {
    id: nextId(),
    number: repo.nextPull++,
    title: input.title,
    body: input.body,
    state: 'open',
    head: input.head,
    base: input.base,
    headSha,
    baseSha,
    mergeBase,
    merged: false,
    mergedAt: null,
    mergeCommitSha: null,
    createdAt: NOW_ISO,
    updatedAt: NOW_ISO,
  };
  repo.pulls.set(pull.number, pull);
  return pull;
}

/** The file changes of a pull request (merge-base tree vs head tree). */
export function pullFiles(repo: Repo, pull: Pull): FileChange[] {
  const headCommit = repo.objects.get(pull.headSha);
  const baseCommit = repo.objects.get(pull.mergeBase);
  if (!headCommit || !baseCommit) return [];
  return diffTrees(repo, parseCommit(baseCommit.data).tree, parseCommit(headCommit.data).tree);
}

/** True when the squash merge of `pull` would conflict with the base tip's current content. */
export function pullConflicts(repo: Repo, pull: Pull): boolean {
  const baseTip = resolveRef(repo, pull.base);
  const headTip = resolveRef(repo, pull.head);
  if (baseTip === undefined || headTip === undefined) return true;
  const baseCommit = repo.objects.get(baseTip);
  const headCommit = repo.objects.get(headTip);
  const mergeBaseCommit = repo.objects.get(pull.mergeBase);
  if (!baseCommit || !headCommit || !mergeBaseCommit) return true;
  const changes = diffTrees(repo, parseCommit(mergeBaseCommit.data).tree, parseCommit(headCommit.data).tree);
  for (const change of changes) {
    const baseBlob = blobAt(repo, baseTip, change.path);
    const mergeBlob = blobAt(repo, pull.mergeBase, change.path);
    const headBlob = blobAt(repo, headTip, change.path);
    if (baseBlob !== mergeBlob && baseBlob !== headBlob) return true;
  }
  return false;
}

/** 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' for a pull request. */
export function pullMergeable(repo: Repo, pull: Pull): string {
  if (pull.state !== 'open') return 'UNKNOWN';
  if (resolveRef(repo, pull.head) === undefined || resolveRef(repo, pull.base) === undefined) return 'UNKNOWN';
  return pullConflicts(repo, pull) ? 'CONFLICTING' : 'MERGEABLE';
}

/**
 * Squash-merge an open pull request onto its base branch. Returns the merge commit sha,
 * or null when the pull request is closed, missing, or conflicted.
 */
export function squashMerge(repo: Repo, pull: Pull): string | null {
  if (pull.state !== 'open') return null;
  const baseTip = resolveRef(repo, pull.base);
  const headTip = resolveRef(repo, pull.head);
  if (baseTip === undefined || headTip === undefined) return null;
  if (pullConflicts(repo, pull)) return null;
  const baseCommit = repo.objects.get(baseTip)!;
  const mergeBaseCommit = repo.objects.get(pull.mergeBase);
  const headCommit = repo.objects.get(headTip)!;
  if (!mergeBaseCommit) return null;
  let treeOid = parseCommit(baseCommit.data).tree;
  const changes = diffTrees(repo, parseCommit(mergeBaseCommit.data).tree, parseCommit(headCommit.data).tree);
  for (const change of changes) {
    const segs = change.path.split('/').filter(Boolean);
    treeOid = setPath(repo, treeOid, segs, change.newOid);
  }
  const message = `Merge pull request #${pull.number} from ${pull.head}\n\n${pull.title}`;
  const commitOid = putObject(repo, 'commit', buildCommit({ tree: treeOid, parents: [baseTip], message }));
  repo.refs.set(`refs/heads/${pull.base}`, commitOid);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = NOW_ISO;
  pull.mergeCommitSha = commitOid;
  pull.updatedAt = NOW_ISO;
  return commitOid;
}
