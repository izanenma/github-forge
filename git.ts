// git smart HTTP: protocol v2 upload-pack (ls-refs, fetch), v0 receive-pack (push),
// and the v0/v2 ref advertisements. Pure wire code over the store in store.ts.

import {
  hashObject,
  parseCommit,
  parseTag,
  parseTree,
  peelToCommit,
  readPack,
  writePack,
  ZERO_OID,
  type GitObject,
  type Repo,
} from './store.ts';

// -------------------------------------------------------------------------------------------
// pkt-line
// -------------------------------------------------------------------------------------------

export function pkt(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const header = Buffer.allocUnsafe(4);
  header.write((data.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([header, data]);
}

export const FLUSH = Buffer.from('0000', 'ascii');
export const DELIM = Buffer.from('0001', 'ascii');

interface Decoded {
  packets: { text: string; raw: Buffer }[];
  rest: Buffer;
  sawFlush: boolean;
}

/** Decode pkt-lines until a flush (or the end); the bytes after the flush are `rest`. */
export function decodeUntilFlush(buf: Buffer): Decoded {
  const packets: { text: string; raw: Buffer }[] = [];
  let off = 0;
  while (off + 4 <= buf.length) {
    const head = buf.subarray(off, off + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(head)) throw new Error(`bad pkt-line header ${JSON.stringify(head)}`);
    const len = Number.parseInt(head, 16);
    if (len === 0) return { packets, rest: buf.subarray(off + 4), sawFlush: true };
    if (len === 1) {
      packets.push({ text: '', raw: buf.subarray(off, off + 4) });
      off += 4;
      continue;
    }
    if (len === 2) {
      off += 4;
      continue;
    }
    if (len < 4 || off + len > buf.length) throw new Error('truncated pkt-line');
    const raw = buf.subarray(off, off + len);
    packets.push({ text: raw.subarray(4).toString('utf8'), raw });
    off += len;
  }
  if (off !== buf.length) throw new Error('trailing bytes in pkt-line stream');
  return { packets, rest: Buffer.alloc(0), sawFlush: false };
}

/** All pkt-lines of a complete body (no trailing pack); throws on garbage. */
export function decodeAll(buf: Buffer): string[] {
  const { packets, rest, sawFlush } = decodeUntilFlush(buf);
  if (rest.length > 0 || !sawFlush) throw new Error('pkt-line stream did not end with a flush');
  return packets.map((p) => p.text);
}

// -------------------------------------------------------------------------------------------
// advertisements
// -------------------------------------------------------------------------------------------

function sortedRefs(repo: Repo): { name: string; oid: string }[] {
  return [...repo.refs.entries()]
    .map(([name, oid]) => ({ name, oid }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

function v0Ad(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps =
    service === 'git-receive-pack'
      ? 'report-status side-band-64k delete-refs ofs-delta agent=github-forge/1.0 symref=HEAD:refs/heads/main'
      : 'side-band-64k ofs-delta shallow agent=github-forge/1.0 symref=HEAD:refs/heads/main';
  const parts: Buffer[] = [pkt(`# service=${service}\n`), FLUSH];
  const refs = sortedRefs(repo);
  const headOid = repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? ZERO_OID;
  if (refs.length === 0) {
    parts.push(pkt(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    parts.push(pkt(`${headOid} HEAD\0${caps}\n`));
    for (const ref of refs) {
      parts.push(pkt(`${ref.oid} ${ref.name}\n`));
      const obj = repo.objects.get(ref.oid);
      if (obj && obj.type === 'tag') {
        parts.push(pkt(`${peelToCommit(repo.objects, ref.oid)} ${ref.name}^{}\n`));
      }
    }
  }
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

function v2Ad(): Buffer {
  return Buffer.concat([
    pkt('version 2\n'),
    pkt('agent=github-forge/1.0\n'),
    pkt('object-format=sha1\n'),
    pkt('ls-refs=unborn\n'),
    pkt('fetch=shallow filter\n'),
    FLUSH,
  ]);
}

export function infoRefsBody(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack', wantV2: boolean): Buffer {
  if (service === 'git-upload-pack' && wantV2) return v2Ad();
  return v0Ad(repo, service);
}

// -------------------------------------------------------------------------------------------
// ls-refs (v2)
// -------------------------------------------------------------------------------------------

function lsRefsBody(repo: Repo, prefixes: string[], peel: boolean, symrefs: boolean, unborn: boolean): Buffer {
  const parts: Buffer[] = [];
  const refs = sortedRefs(repo);
  const headOid = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));
  if (refs.length === 0) {
    if (unborn && keep('HEAD')) parts.push(pkt('unborn HEAD symref-target:refs/heads/main\n'));
    parts.push(FLUSH);
    return Buffer.concat(parts);
  }
  if (prefixes.length === 0 && headOid !== undefined) {
    parts.push(pkt(`${headOid} HEAD${symrefs ? ' symref-target:refs/heads/main' : ''}\n`));
  }
  for (const ref of refs) {
    if (!keep(ref.name)) continue;
    let line = `${ref.oid} ${ref.name}`;
    const obj = repo.objects.get(ref.oid);
    if (peel && obj && obj.type === 'tag') line += ` peeled:${peelToCommit(repo.objects, ref.oid)}`;
    parts.push(pkt(`${line}\n`));
  }
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

// -------------------------------------------------------------------------------------------
// fetch (v2): which objects to send, and the shallow boundary afterwards
// -------------------------------------------------------------------------------------------

export interface FetchRequest {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth?: number;
}

interface FetchPlan {
  objects: GitObject[];
  shallow: string[];
  unshallow: string[];
}

function commitWalk(repo: Repo, req: FetchRequest): FetchPlan {
  // What the client already holds: reachable from its haves, but never past a shallow
  // boundary commit (the client has that commit and its tree, not its parents).
  const shallowSet = new Set(req.shallow);
  const haveReachable = new Set<string>();
  {
    const queue = [...req.haves];
    while (queue.length) {
      const oid = queue.pop()!;
      if (haveReachable.has(oid)) continue;
      const obj = repo.objects.get(oid);
      if (!obj) continue;
      haveReachable.add(oid);
      if (obj.type === 'commit') {
        const c = parseCommit(obj.data);
        queue.push(c.tree);
        if (!shallowSet.has(oid)) for (const p of c.parents) queue.push(p);
      } else if (obj.type === 'tag') {
        queue.push(parseTag(obj.data).object);
      } else if (obj.type === 'tree') {
        for (const e of parseTree(obj.data)) if (e.mode !== '160000') queue.push(e.oid);
      }
    }
  }
  const included = new Set<string>(); // commit oids to send
  const includedDist = new Map<string, number>(); // distance from a want, first seen
  const cutParents = new Map<string, Set<string>>(); // included commit -> parents not sent
  const queue: { oid: string; dist: number }[] = [];
  const seen = new Set<string>();
  for (const want of req.wants) {
    const obj = repo.objects.get(want);
    if (!obj) continue;
    if (obj.type === 'tag') {
      const target = peelToCommit(repo.objects, want);
      queue.push({ oid: target, dist: 0 });
    } else if (obj.type === 'commit') {
      queue.push({ oid: want, dist: 0 });
    }
  }
  while (queue.length) {
    const { oid, dist } = queue.shift()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    const held = haveReachable.has(oid);
    const inShallow = shallowSet.has(oid);
    if (held && !inShallow) continue; // already held, and its history is held too
    if (req.depth !== undefined && dist >= req.depth && !held) continue; // cut by depth
    if (!held) {
      included.add(oid);
      if (!includedDist.has(oid)) includedDist.set(oid, dist);
    }
    const parents = parseCommit(obj.data).parents;
    const unsent = new Set<string>();
    for (const p of parents) {
      const pObj = repo.objects.get(p);
      const pHeld = haveReachable.has(p);
      const pIncluded = !pHeld || shallowSet.has(p);
      if (req.depth !== undefined && dist + 1 >= req.depth && !pHeld) {
        unsent.add(p);
      } else if (!pIncluded) {
        unsent.add(p);
      }
      if (pObj && pObj.type === 'commit') queue.push({ oid: p, dist: dist + 1 });
    }
    if (unsent.size > 0) cutParents.set(oid, unsent);
  }
  // The shallow boundary after this fetch: included commits whose history was cut
  // (a parent neither sent nor held), plus a parentless commit fetched at the depth
  // limit (a root commit is still a shallow boundary), plus old boundary commits
  // whose parents are still unknown.
  const newShallow: string[] = [];
  if (req.depth !== undefined) {
    for (const oid of included) {
      const cut = cutParents.get(oid);
      const obj = repo.objects.get(oid);
      const parents = obj && obj.type === 'commit' ? parseCommit(obj.data).parents : [];
      const cutParent = cut !== undefined && [...cut].some((p) => !haveReachable.has(p));
      const rootAtLimit = parents.length === 0 && includedDist.get(oid) === req.depth - 1;
      if (cutParent || rootAtLimit) newShallow.push(oid);
    }
  }
  // Unshallow: old boundary commits whose parents are now included or held.
  const unshallow: string[] = [];
  const remainingOld: string[] = [];
  for (const s of req.shallow) {
    const obj = repo.objects.get(s);
    if (!obj || obj.type !== 'commit') continue;
    const parents = parseCommit(obj.data).parents;
    if (parents.every((p) => included.has(p) || haveReachable.has(p))) unshallow.push(s);
    else remainingOld.push(s);
  }
  // Objects: the included commits and their tree closures (never a parent commit
  // the depth limit cut), plus wanted tags, minus objects the client already holds.
  const wanted = new Set<string>();
  for (const oid of included) {
    wanted.add(oid);
    const commit = repo.objects.get(oid);
    if (!commit || commit.type !== 'commit') continue;
    const stack = [parseCommit(commit.data).tree];
    while (stack.length) {
      const treeOid = stack.pop()!;
      if (wanted.has(treeOid)) continue;
      wanted.add(treeOid);
      const tree = repo.objects.get(treeOid);
      if (!tree || tree.type !== 'tree') continue;
      for (const e of parseTree(tree.data)) stack.push(e.oid);
    }
  }
  for (const want of req.wants) {
    const obj = repo.objects.get(want);
    if (obj && obj.type === 'tag') wanted.add(want);
  }
  const objects: GitObject[] = [];
  for (const oid of [...wanted].sort()) {
    if (haveReachable.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (obj) objects.push(obj);
  }
  return { objects, shallow: [...new Set([...newShallow, ...remainingOld])].sort(), unshallow: unshallow.sort() };
}

function sidebandPack(pack: Buffer): Buffer {
  const parts: Buffer[] = [];
  const CHUNK = 60000;
  for (let off = 0; off < pack.length; off += CHUNK) {
    const slice = pack.subarray(off, Math.min(off + CHUNK, pack.length));
    parts.push(pkt(Buffer.concat([Buffer.from([1]), slice])));
  }
  return Buffer.concat(parts);
}

export function fetchV2Body(repo: Repo, req: FetchRequest): Buffer {
  const plan = commitWalk(repo, req);
  const pack = writePack(plan.objects);
  const parts: Buffer[] = [pkt('acknowledgments\n'), pkt('NAK\n'), FLUSH];
  if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
    parts.push(pkt('shallow-info\n'));
    for (const oid of plan.shallow) parts.push(pkt(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) parts.push(pkt(`unshallow ${oid}\n`));
    parts.push(FLUSH);
  }
  parts.push(pkt('packfile\n'), sidebandPack(pack), FLUSH);
  return Buffer.concat(parts);
}

// -------------------------------------------------------------------------------------------
// upload-pack entry: dispatch ls-refs / fetch from one POST body
// -------------------------------------------------------------------------------------------

export function handleUploadPack(repo: Repo, body: Buffer): { status: number; body: Buffer; message?: string } {
  let lines: string[];
  try {
    lines = decodeAll(body);
  } catch (err) {
    return { status: 400, body: Buffer.from(JSON.stringify({ message: `bad pkt-line: ${err instanceof Error ? err.message : String(err)}` })), message: 'bad pkt-line' };
  }
  const command = lines.find((l) => l.startsWith('command='))?.slice('command='.length).replace(/\n$/, '');
  if (command === 'ls-refs') {
    const delimAt = lines.indexOf('');
    const args = lines.slice(delimAt + 1);
    const prefixes: string[] = [];
    let peel = false;
    let symrefs = false;
    let unborn = false;
    for (const arg of args) {
      const a = arg.replace(/\n$/, '');
      if (a === 'peel') peel = true;
      else if (a === 'symrefs') symrefs = true;
      else if (a === 'unborn') unborn = true;
      else if (a.startsWith('ref-prefix ')) prefixes.push(a.slice('ref-prefix '.length));
    }
    return { status: 200, body: lsRefsBody(repo, prefixes, peel, symrefs, unborn) };
  }
  if (command === 'fetch') {
    const delimAt = lines.indexOf('');
    const args = lines.slice(delimAt + 1);
    const req: FetchRequest = { wants: [], haves: [], shallow: [] };
    for (const raw of args) {
      const a = raw.replace(/\n$/, '');
      if (a.startsWith('want ')) req.wants.push(a.slice(5).trim());
      else if (a.startsWith('have ')) req.haves.push(a.slice(5).trim());
      else if (a.startsWith('shallow ')) req.shallow.push(a.slice(8).trim());
      else if (a.startsWith('deepen ')) {
        const n = Number.parseInt(a.slice(7).trim(), 10);
        if (Number.isFinite(n)) req.depth = n;
      }
    }
    return { status: 200, body: fetchV2Body(repo, req) };
  }
  return { status: 400, body: Buffer.from(JSON.stringify({ message: `unknown upload-pack command ${JSON.stringify(command ?? null)}` })), message: 'unknown command' };
}

// -------------------------------------------------------------------------------------------
// receive-pack entry: unpack a pack, apply commands with fast-forward checks, report status
// -------------------------------------------------------------------------------------------

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

export function handleReceivePack(repo: Repo, body: Buffer): { status: number; body: Buffer; contentType: string } {
  const RESULT_TYPE = 'application/x-git-receive-pack-result';
  let decoded: Decoded;
  try {
    decoded = decodeUntilFlush(body);
  } catch (err) {
    return { status: 400, body: Buffer.from(JSON.stringify({ message: `bad pkt-line: ${err instanceof Error ? err.message : String(err)}` })), contentType: 'application/json' };
  }
  const commands: PushCommand[] = [];
  let sideband = false;
  for (const { text } of decoded.packets) {
    if (text === '') continue; // delim
    const line = text.replace(/\n$/, '');
    const nul = line.indexOf('\0');
    const head = nul >= 0 ? line.slice(0, nul) : line;
    const caps = nul >= 0 ? line.slice(nul + 1) : '';
    if (caps.includes('side-band-64k')) sideband = true;
    const parts = head.split(' ');
    if (parts.length < 3) continue;
    commands.push({ oldOid: parts[0], newOid: parts[1], ref: parts.slice(2).join(' ') });
  }
  const reportLines: string[] = [];
  let unpackOk = true;
  let unpackDetail = 'ok';
  const packBytes = decoded.rest;
  const needsPack = commands.some((c) => c.newOid !== ZERO_OID);
  if (needsPack && packBytes.length > 0) {
    try {
      const objects = readPack(packBytes);
      for (const [oid, obj] of objects) {
        const recomputed = hashObject(obj.type, obj.data);
        if (recomputed !== oid) throw new Error(`object ${oid} does not hash to itself`);
        if (!repo.objects.has(oid)) repo.objects.set(oid, obj);
      }
    } catch (err) {
      unpackOk = false;
      unpackDetail = err instanceof Error ? err.message : String(err);
    }
  }
  if (unpackOk) {
    for (const cmd of commands) {
      const current = repo.refs.get(cmd.ref);
      if (cmd.newOid === ZERO_OID) {
        // delete
        if (current === undefined) {
          reportLines.push(`ng ${cmd.ref} reference does not exist\n`);
        } else if (current !== cmd.oldOid) {
          reportLines.push(`ng ${cmd.ref} old value does not match\n`);
        } else {
          repo.refs.delete(cmd.ref);
          reportLines.push(`ok ${cmd.ref}\n`);
        }
        continue;
      }
      const target = repo.objects.get(cmd.newOid);
      if (!target) {
        reportLines.push(`ng ${cmd.ref} object not found\n`);
        continue;
      }
      if (cmd.oldOid === ZERO_OID) {
        if (current !== undefined) {
          reportLines.push(`ng ${cmd.ref} reference already exists\n`);
          continue;
        }
        repo.refs.set(cmd.ref, cmd.newOid);
        reportLines.push(`ok ${cmd.ref}\n`);
        continue;
      }
      if (current === undefined) {
        reportLines.push(`ng ${cmd.ref} reference does not exist\n`);
        continue;
      }
      if (current !== cmd.oldOid) {
        reportLines.push(`ng ${cmd.ref} old value does not match\n`);
        continue;
      }
      const newCommit = peelToCommit(repo.objects, cmd.newOid);
      const oldCommit = peelToCommit(repo.objects, cmd.oldOid);
      const newObj = repo.objects.get(newCommit);
      if (!newObj || newObj.type !== 'commit') {
        reportLines.push(`ng ${cmd.ref} object is not a commit\n`);
        continue;
      }
      // fast-forward: the old tip must be an ancestor of the new tip.
      const ancestors = new Set<string>();
      const queue = [newCommit];
      let ff = false;
      while (queue.length) {
        const cur = queue.pop()!;
        if (cur === oldCommit) {
          ff = true;
          break;
        }
        if (ancestors.has(cur)) continue;
        ancestors.add(cur);
        const obj = repo.objects.get(cur);
        if (!obj || obj.type !== 'commit') continue;
        for (const p of parseCommit(obj.data).parents) queue.push(p);
      }
      // A tag object update to the same commit is a fast-forward too.
      if (!ff && newCommit === oldCommit) ff = true;
      if (!ff) {
        reportLines.push(`ng ${cmd.ref} non-fast-forward\n`);
        continue;
      }
      repo.refs.set(cmd.ref, cmd.newOid);
      reportLines.push(`ok ${cmd.ref}\n`);
    }
  } else {
    for (const cmd of commands) reportLines.push(`ng ${cmd.ref} unpack failed\n`);
  }
  const inner = Buffer.concat([pkt(`unpack ${unpackDetail}\n`), ...reportLines.map((l) => pkt(l))]);
  let out: Buffer;
  if (sideband) {
    const parts: Buffer[] = [];
    const CHUNK = 60000;
    for (let off = 0; off < inner.length; off += CHUNK) {
      const slice = inner.subarray(off, Math.min(off + CHUNK, inner.length));
      parts.push(pkt(Buffer.concat([Buffer.from([1]), slice])));
    }
    parts.push(FLUSH);
    out = Buffer.concat(parts);
  } else {
    out = Buffer.concat([inner, FLUSH]);
  }
  return { status: 200, body: out, contentType: RESULT_TYPE };
}
