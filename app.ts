// The forge's HTTP server: health probe, git smart HTTP, REST v3, GraphQL v4, MCP.
// One process, node:http only, in-memory store. Every reply is JSON (except the git
// binary bodies) and carries a deterministic X-GitHub-Request-Id.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import {
  blobAt,
  buildCommit,
  buildTree,
  createPullRecord,
  gid,
  lineDiff,
  listCommits,
  NOW_EPOCH,
  NOW_ISO,
  parseCommit,
  parseTree,
  pullConflicts,
  pullFiles,
  pullMergeable,
  putObject,
  resolveRef,
  setPath,
  squashMerge,
  store,
  treeAt,
  VIEWER,
  type Issue,
  type Pull,
  type Repo,
} from './store.ts';
import { handleReceivePack, handleUploadPack, infoRefsBody } from './git.ts';
import { executeGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';
let requestCounter = 0;

function nextRequestId(): string {
  requestCounter += 1;
  return `req-${requestCounter}`;
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': nextRequestId(),
    ...headers,
  });
  res.end(text);
}

function sendBytes(res: ServerResponse, status: number, body: Buffer, contentType: string): void {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': body.length,
    'x-github-request-id': nextRequestId(),
  });
  res.end(body);
}

function sendNoContent(res: ServerResponse): void {
  res.writeHead(204, { 'x-github-request-id': nextRequestId() });
  res.end();
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer | string) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buf.length;
      if (total > 64 * 1024 * 1024) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(buf);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function parseJsonBody(raw: Buffer): { ok: true; value: unknown } | { ok: false } {
  if (raw.length === 0) return { ok: true, value: {} };
  try {
    return { ok: true, value: JSON.parse(raw.toString('utf8')) as unknown };
  } catch {
    return { ok: false };
  }
}

function authorized(req: IncomingMessage): boolean {
  if (TOKEN === '') return true;
  return (req.headers.authorization ?? '') === `Bearer ${TOKEN}`;
}

function decode(seg: string): string {
  try {
    return decodeURIComponent(seg);
  } catch {
    return seg;
  }
}

// -------------------------------------------------------------------------------------------
// views
// -------------------------------------------------------------------------------------------

function repoView(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: gid('R', repo.id),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: VIEWER.id, type: 'User' },
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    has_issues: true,
    has_pull_requests: true,
  };
}

function issueView(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: gid('I', repo.id, issue.number),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => ({ name, color: repo.labels.get(name)?.color ?? 'ededed' })),
    user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
  };
}

function pullView(repo: Repo, pull: Pull): Record<string, unknown> {
  const state = pull.state === 'open' ? 'open' : 'closed';
  return {
    id: pull.id,
    node_id: gid('PR', repo.id, pull.number),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    mergeable: pullMergeable(repo, pull) === 'MERGEABLE',
    head: { ref: pull.head, sha: pull.headSha, label: `${repo.owner}:${pull.head}` },
    base: { ref: pull.base, sha: pull.baseSha, label: `${repo.owner}:${pull.base}` },
    user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
  };
}

function commentView(repo: Repo, issue: Issue, comment: { id: number; body: string; createdAt: string; updatedAt: string }): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: gid('C', repo.id, issue.number, comment.id),
    body: comment.body,
    user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    created_at: comment.createdAt,
    updated_at: comment.updatedAt,
  };
}

// -------------------------------------------------------------------------------------------
// pagination (Link rel="next" chains, same-origin absolute URLs)
// -------------------------------------------------------------------------------------------

function paginate<T>(req: IncomingMessage, url: URL, items: T[], defaultPerPage = 30): { page: T[]; link: string | null } {
  const perPageRaw = Number.parseInt(url.searchParams.get('per_page') ?? '', 10);
  const pageRaw = Number.parseInt(url.searchParams.get('page') ?? '', 10);
  const perPage = Number.isFinite(perPageRaw) && perPageRaw > 0 ? Math.min(perPageRaw, 100) : defaultPerPage;
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? pageRaw : 1;
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  const slice = items.slice((page - 1) * perPage, page * perPage);
  const host = req.headers.host ?? '127.0.0.1';
  const base = `http://${host}${url.pathname}`;
  const linkFor = (p: number, rel: string): string => {
    const q = new URLSearchParams(url.searchParams);
    q.set('per_page', String(perPage));
    q.set('page', String(p));
    return `<${base}?${q.toString()}>; rel="${rel}"`;
  };
  const links: string[] = [];
  if (page < totalPages) links.push(linkFor(page + 1, 'next'));
  if (page > 1) links.push(linkFor(page - 1, 'prev'));
  if (totalPages > 1) {
    links.push(linkFor(1, 'first'));
    links.push(linkFor(totalPages, 'last'));
  }
  return { page: slice, link: links.length > 0 ? links.join(', ') : null };
}

// -------------------------------------------------------------------------------------------
// contents helpers
// -------------------------------------------------------------------------------------------

function contentsPath(segs: string[]): string {
  return segs.map(decode).join('/');
}

function fileEntry(repo: Repo, tip: string, path: string): Record<string, unknown> | null {
  const blobOid = blobAt(repo, tip, path);
  if (blobOid === null) return null;
  const blob = repo.objects.get(blobOid)!;
  const name = path.split('/').pop() ?? path;
  return {
    type: 'file',
    encoding: 'base64',
    size: blob.data.length,
    name,
    path,
    content: blob.data.toString('base64'),
    sha: blobOid,
  };
}

// -------------------------------------------------------------------------------------------
// the router
// -------------------------------------------------------------------------------------------

export function createApp(): Server {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void handle(req, res).catch((err: unknown) => {
      try {
        sendJson(res, 500, { message: err instanceof Error ? err.message : String(err) });
      } catch {
        // the socket is already gone; nothing more to do
      }
    });
  });
  server.keepAliveTimeout = 10_000;
  return server;
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const method = req.method ?? 'GET';
  let url: URL;
  try {
    url = new URL(req.url ?? '/', 'http://entry');
  } catch {
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }
  const path = url.pathname;
  const segs = path.split('/').filter((s) => s !== '');

  // Boot probe: no auth.
  if (method === 'GET' && path === '/healthz') {
    sendJson(res, 200, { ok: true });
    return;
  }

  // Git smart HTTP: /{owner}/{repo}.git/...
  if (segs.length >= 2 && segs[1].endsWith('.git')) {
    await handleGit(req, res, method, url, segs);
    return;
  }

  // MCP.
  if (method === 'POST' && path === '/mcp') {
    if (!authorized(req)) {
      sendJson(res, 401, { message: 'Requires authentication' });
      return;
    }
    const raw = await readBody(req);
    const out = handleMcp(raw);
    if (out.status === 202) {
      res.writeHead(202, { 'x-github-request-id': nextRequestId() });
      res.end();
      return;
    }
    sendJson(res, out.status, JSON.parse(out.body) as unknown);
    return;
  }
  if (path === '/mcp') {
    if (!authorized(req)) {
      sendJson(res, 401, { message: 'Requires authentication' });
      return;
    }
    sendJson(res, 405, { message: 'Method Not Allowed' });
    return;
  }

  // GraphQL.
  if (method === 'POST' && path === '/api/graphql') {
    if (!authorized(req)) {
      sendJson(res, 401, { message: 'Requires authentication' });
      return;
    }
    const raw = await readBody(req);
    const parsed = parseJsonBody(raw);
    if (!parsed.ok) {
      sendJson(res, 400, { message: 'Invalid JSON' });
      return;
    }
    const out = executeGraphQL(parsed.value);
    sendJson(res, 200, out);
    return;
  }

  // REST v3.
  if (segs[0] === 'api' && segs[1] === 'v3') {
    await handleRest(req, res, method, url, segs);
    return;
  }

  sendJson(res, 404, { message: 'Not Found' });
}

// -------------------------------------------------------------------------------------------
// git endpoints
// -------------------------------------------------------------------------------------------

async function handleGit(
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  url: URL,
  segs: string[],
): Promise<void> {
  const owner = decode(segs[0]);
  const repoName = decode(segs[1].slice(0, -4));
  const service = segs[2] === 'info' && segs[3] === 'refs' ? 'info/refs' : (segs[2] ?? '');
  if (!authorized(req)) {
    sendJson(res, 401, { message: 'Requires authentication' });
    return;
  }
  const repo = store.getRepo(owner, repoName);
  if (method === 'GET' && service === 'info/refs') {
    const svc = url.searchParams.get('service');
    if (repo === undefined || (svc !== 'git-upload-pack' && svc !== 'git-receive-pack')) {
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }
    const wantV2 = svc === 'git-upload-pack' && (req.headers['git-protocol'] ?? '') === 'version=2';
    sendBytes(res, 200, infoRefsBody(repo, svc, wantV2), `application/x-${svc}-advertisement`);
    return;
  }
  if (method === 'POST' && service === 'git-upload-pack') {
    if (repo === undefined) {
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }
    const raw = await readBody(req);
    const out = handleUploadPack(repo, raw);
    if (out.status !== 200) {
      sendJson(res, out.status, JSON.parse(out.body.toString('utf8')) as unknown);
      return;
    }
    sendBytes(res, 200, out.body, 'application/x-git-upload-pack-result');
    return;
  }
  if (method === 'POST' && service === 'git-receive-pack') {
    if (repo === undefined) {
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }
    const raw = await readBody(req);
    const out = handleReceivePack(repo, raw);
    if (out.status !== 200) {
      sendJson(res, out.status, JSON.parse(out.body.toString('utf8')) as unknown);
      return;
    }
    sendBytes(res, 200, out.body, out.contentType);
    return;
  }
  sendJson(res, 404, { message: 'Not Found' });
}

// -------------------------------------------------------------------------------------------
// REST v3
// -------------------------------------------------------------------------------------------

async function handleRest(
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  url: URL,
  segs: string[],
): Promise<void> {
  if (!authorized(req)) {
    sendJson(res, 401, { message: 'Requires authentication' });
    return;
  }
  const rest = segs.slice(2); // after api/v3

  // API root.
  if (rest.length === 0 && method === 'GET') {
    sendJson(res, 200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' });
    return;
  }
  // Meta.
  if (rest.length === 1 && rest[0] === 'meta' && method === 'GET') {
    sendJson(res, 200, { installed_version: '1.0.0' });
    return;
  }
  // The token's user.
  if (rest.length === 1 && rest[0] === 'user' && method === 'GET') {
    sendJson(res, 200, { login: VIEWER.login, id: VIEWER.id, name: VIEWER.name, email: VIEWER.email, type: 'User' });
    return;
  }
  // List / create the viewer's repositories.
  if (rest.length === 2 && rest[0] === 'user' && rest[1] === 'repos') {
    if (method === 'GET') {
      const { page, link } = paginate(req, url, store.listRepos());
      sendJson(res, 200, page.map(repoView), link === null ? {} : { link });
      return;
    }
    if (method === 'POST') {
      const raw = await readBody(req);
      const parsed = parseJsonBody(raw);
      if (!parsed.ok) {
        sendJson(res, 400, { message: 'Invalid JSON' });
        return;
      }
      const body = (parsed.value ?? {}) as Record<string, unknown>;
      const name = typeof body.name === 'string' ? body.name : '';
      if (name === '' || name.length > 100 || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) {
        sendJson(res, 422, { message: 'Invalid repository name' });
        return;
      }
      const repo = store.createRepo(name, body.private === true, typeof body.description === 'string' ? body.description : '');
      if (repo === null) {
        sendJson(res, 422, { message: 'Repository already exists' });
        return;
      }
      sendJson(res, 201, repoView(repo));
      return;
    }
  }

  // /repos/{owner}/{name}/...
  if (rest.length >= 3 && rest[0] === 'repos') {
    await handleRepo(req, res, method, url, rest.slice(1));
    return;
  }

  sendJson(res, 404, { message: 'Not Found' });
}

async function handleRepo(
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  url: URL,
  rest: string[], // [owner, name, ...tail]
): Promise<void> {
  const owner = decode(rest[0]);
  const name = decode(rest[1]);
  const tail = rest.slice(2);
  const repo = store.getRepo(owner, name);

  const needRepo = (): Repo | null => {
    if (repo === undefined) {
      sendJson(res, 404, { message: 'Not Found' });
      return null;
    }
    return repo;
  };

  // /repos/{o}/{r}
  if (tail.length === 0) {
    if (method === 'GET') {
      const r = needRepo();
      if (r) sendJson(res, 200, repoView(r));
      return;
    }
    if (method === 'PATCH') {
      const r = needRepo();
      if (!r) return;
      const parsed = parseJsonBody(await readBody(req));
      if (!parsed.ok) {
        sendJson(res, 400, { message: 'Invalid JSON' });
        return;
      }
      const body = (parsed.value ?? {}) as Record<string, unknown>;
      if (typeof body.description === 'string') r.description = body.description;
      if (typeof body.private === 'boolean') r.isPrivate = body.private;
      r.updatedAt = NOW_ISO;
      sendJson(res, 200, repoView(r));
      return;
    }
    if (method === 'DELETE') {
      const r = needRepo();
      if (!r) return;
      store.deleteRepo(owner, name);
      sendNoContent(res);
      return;
    }
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }

  const section = tail[0];

  // ---- branches ---------------------------------------------------------------
  if (section === 'branches') {
    const r = needRepo();
    if (!r) return;
    if (tail.length === 1 && method === 'GET') {
      const branches = [...r.refs.keys()]
        .filter((ref) => ref.startsWith('refs/heads/'))
        .map((ref) => ref.slice('refs/heads/'.length))
        .sort()
        .map((branch) => ({ name: branch, commit: { sha: r.refs.get(`refs/heads/${branch}`) } }));
      sendJson(res, 200, branches);
      return;
    }
    if (tail.length === 2 && method === 'GET') {
      const branch = decode(tail[1]);
      const sha = r.refs.get(`refs/heads/${branch}`);
      if (sha === undefined) {
        sendJson(res, 404, { message: 'Not Found' });
        return;
      }
      sendJson(res, 200, { name: branch, commit: { sha } });
      return;
    }
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }

  // ---- git refs ---------------------------------------------------------------
  if (section === 'git' && tail[1] === 'refs') {
    const r = needRepo();
    if (!r) return;
    if (method === 'POST' && tail.length === 2) {
      const parsed = parseJsonBody(await readBody(req));
      if (!parsed.ok) {
        sendJson(res, 400, { message: 'Invalid JSON' });
        return;
      }
      const body = (parsed.value ?? {}) as Record<string, unknown>;
      const ref = typeof body.ref === 'string' ? body.ref : '';
      const sha = typeof body.sha === 'string' ? body.sha : '';
      if (!ref.startsWith('refs/') || !/^[0-9a-f]{40}$/.test(sha)) {
        sendJson(res, 422, { message: 'Invalid ref or sha' });
        return;
      }
      if (r.refs.has(ref)) {
        sendJson(res, 422, { message: 'Reference already exists' });
        return;
      }
      const obj = r.objects.get(sha);
      if (!obj || (obj.type !== 'commit' && obj.type !== 'tag')) {
        sendJson(res, 422, { message: 'Unknown object' });
        return;
      }
      r.refs.set(ref, sha);
      sendJson(res, 201, { ref, object: { sha } });
      return;
    }
    if (method === 'GET' && tail.length >= 4 && (tail[2] === 'heads' || tail[2] === 'tags')) {
      const refName = `refs/${tail[2]}/${tail.slice(3).map(decode).join('/')}`;
      const sha = r.refs.get(refName);
      if (sha === undefined) {
        sendJson(res, 404, { message: 'Not Found' });
        return;
      }
      sendJson(res, 200, { ref: refName, object: { sha } });
      return;
    }
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }

  // ---- commits ----------------------------------------------------------------
  if (section === 'commits' && method === 'GET' && tail.length === 1) {
    const r = needRepo();
    if (!r) return;
    const shaParam = url.searchParams.get('sha');
    const tip = shaParam !== null ? resolveRef(r, shaParam) : r.refs.get(`refs/heads/${r.defaultBranch}`);
    if (tip === undefined) {
      sendJson(res, 200, []);
      return;
    }
    const commits = listCommits(r, tip).map((oid) => {
      const c = parseCommit(r.objects.get(oid)!.data);
      const author = { name: VIEWER.name, email: VIEWER.email, date: new Date(NOW_EPOCH * 1000).toISOString() };
      return { sha: oid, commit: { message: c.message, author, committer: author }, parents: c.parents.map((p) => ({ sha: p })) };
    });
    sendJson(res, 200, commits);
    return;
  }

  // ---- contents ---------------------------------------------------------------
  if (section === 'contents') {
    const r = needRepo();
    if (!r) return;
    const path = contentsPath(tail.slice(1));
    if (method === 'GET') {
      const ref = url.searchParams.get('ref') ?? r.defaultBranch;
      const tip = resolveRef(r, ref);
      if (tip === undefined) {
        sendJson(res, 404, { message: 'Not Found' });
        return;
      }
      const file = path === '' ? null : fileEntry(r, tip, path);
      if (file !== null) {
        sendJson(res, 200, file);
        return;
      }
      const dirOid = treeAt(r, tip, path);
      if (dirOid === null) {
        sendJson(res, 404, { message: 'Not Found' });
        return;
      }
      const entries = parseTree(r.objects.get(dirOid)!.data).map((e) => {
        const entryPath = path === '' ? e.name : `${path}/${e.name}`;
        const isDir = e.mode === '40000';
        const size = isDir ? 0 : (r.objects.get(e.oid)?.data.length ?? 0);
        return { type: isDir ? 'dir' : 'file', name: e.name, path: entryPath, sha: e.oid, size };
      });
      sendJson(res, 200, entries);
      return;
    }
    if (method === 'PUT') {
      const parsed = parseJsonBody(await readBody(req));
      if (!parsed.ok) {
        sendJson(res, 400, { message: 'Invalid JSON' });
        return;
      }
      const body = (parsed.value ?? {}) as Record<string, unknown>;
      const message = typeof body.message === 'string' ? body.message : 'Update';
      const contentB64 = typeof body.content === 'string' ? body.content : '';
      const content = Buffer.from(contentB64, 'base64');
      const branch = typeof body.branch === 'string' ? body.branch : r.defaultBranch;
      let tip = resolveRef(r, branch);
      if (tip === undefined) {
        const baseTip = r.refs.get(`refs/heads/${r.defaultBranch}`);
        if (branch !== r.defaultBranch && baseTip !== undefined) {
          r.refs.set(`refs/heads/${branch}`, baseTip);
          tip = baseTip;
        }
      }
      const existing = tip !== undefined ? blobAt(r, tip, path) : null;
      const sha = typeof body.sha === 'string' ? body.sha : undefined;
      if (existing !== null) {
        if (sha === undefined || sha.toLowerCase() !== existing.toLowerCase()) {
          sendJson(res, 409, { message: 'sha does not match the current file' });
          return;
        }
      }
      const blobOid = putObject(r, 'blob', content);
      const baseTree = tip !== undefined ? parseCommit(r.objects.get(tip)!.data).tree : putObject(r, 'tree', buildTree([]));
      const newTree = setPath(r, baseTree, path.split('/').filter(Boolean), blobOid);
      const commitOid = putObject(r, 'commit', buildCommit({ tree: newTree, parents: tip !== undefined ? [tip] : [], message }));
      r.refs.set(`refs/heads/${branch}`, commitOid);
      r.updatedAt = NOW_ISO;
      sendJson(res, existing !== null ? 200 : 201, {
        content: { name: path.split('/').pop() ?? path, path, sha: blobOid, size: content.length, type: 'file', encoding: 'base64', content: contentB64 },
        commit: { sha: commitOid, message },
      });
      return;
    }
    if (method === 'DELETE') {
      const parsed = parseJsonBody(await readBody(req));
      if (!parsed.ok) {
        sendJson(res, 400, { message: 'Invalid JSON' });
        return;
      }
      const body = (parsed.value ?? {}) as Record<string, unknown>;
      const message = typeof body.message === 'string' ? body.message : 'Delete';
      const branch = typeof body.branch === 'string' ? body.branch : r.defaultBranch;
      const tip = resolveRef(r, branch);
      if (tip === undefined) {
        sendJson(res, 404, { message: 'Not Found' });
        return;
      }
      const existing = blobAt(r, tip, path);
      if (existing === null) {
        sendJson(res, 404, { message: 'Not Found' });
        return;
      }
      const sha = typeof body.sha === 'string' ? body.sha : undefined;
      if (sha !== undefined && sha.toLowerCase() !== existing.toLowerCase()) {
        sendJson(res, 409, { message: 'sha does not match the current file' });
        return;
      }
      const baseTree = parseCommit(r.objects.get(tip)!.data).tree;
      const newTree = setPath(r, baseTree, path.split('/').filter(Boolean), null);
      const commitOid = putObject(r, 'commit', buildCommit({ tree: newTree, parents: [tip], message }));
      r.refs.set(`refs/heads/${branch}`, commitOid);
      r.updatedAt = NOW_ISO;
      sendJson(res, 200, { commit: { sha: commitOid, message } });
      return;
    }
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }

  // ---- labels -----------------------------------------------------------------
  if (section === 'labels') {
    const r = needRepo();
    if (!r) return;
    if (method === 'GET' && tail.length === 1) {
      sendJson(res, 200, [...r.labels.values()]);
      return;
    }
    if (method === 'POST' && tail.length === 1) {
      const parsed = parseJsonBody(await readBody(req));
      if (!parsed.ok) {
        sendJson(res, 400, { message: 'Invalid JSON' });
        return;
      }
      const body = (parsed.value ?? {}) as Record<string, unknown>;
      const name = typeof body.name === 'string' ? body.name : '';
      if (name === '') {
        sendJson(res, 422, { message: 'Label name is required' });
        return;
      }
      const color = typeof body.color === 'string' ? body.color : 'ededed';
      const existing = r.labels.get(name);
      if (existing) {
        sendJson(res, 201, existing);
        return;
      }
      const label = { name, color };
      r.labels.set(name, label);
      sendJson(res, 201, label);
      return;
    }
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }

  // ---- issues -----------------------------------------------------------------
  if (section === 'issues') {
    const r = needRepo();
    if (!r) return;
    // POST /issues/{n}/comments and GET /issues/{n}/comments
    if (tail.length === 3 && tail[2] === 'comments') {
      const number = Number.parseInt(tail[1], 10);
      const issue = r.issues.get(number);
      if (issue === undefined) {
        sendJson(res, 404, { message: 'Not Found' });
        return;
      }
      if (method === 'GET') {
        sendJson(res, 200, issue.comments.map((c) => commentView(r, issue, c)));
        return;
      }
      if (method === 'POST') {
        const parsed = parseJsonBody(await readBody(req));
        if (!parsed.ok) {
          sendJson(res, 400, { message: 'Invalid JSON' });
          return;
        }
        const body = (parsed.value ?? {}) as Record<string, unknown>;
        const comment = { id: store.nextCommentId++, body: typeof body.body === 'string' ? body.body : '', createdAt: NOW_ISO, updatedAt: NOW_ISO };
        issue.comments.push(comment);
        sendJson(res, 201, commentView(r, issue, comment));
        return;
      }
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }
    // /issues/{n}
    if (tail.length === 2) {
      const number = Number.parseInt(tail[1], 10);
      const issue = r.issues.get(number);
      if (issue === undefined) {
        sendJson(res, 404, { message: 'Not Found' });
        return;
      }
      if (method === 'GET') {
        sendJson(res, 200, issueView(r, issue));
        return;
      }
      if (method === 'PATCH') {
        const parsed = parseJsonBody(await readBody(req));
        if (!parsed.ok) {
          sendJson(res, 400, { message: 'Invalid JSON' });
          return;
        }
        const body = (parsed.value ?? {}) as Record<string, unknown>;
        if (body.state === 'open' || body.state === 'closed') issue.state = body.state;
        if (typeof body.title === 'string') issue.title = body.title;
        if (typeof body.body === 'string') issue.body = body.body;
        issue.updatedAt = NOW_ISO;
        sendJson(res, 200, issueView(r, issue));
        return;
      }
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }
    // /issues
    if (tail.length === 1) {
      if (method === 'GET') {
        const state = url.searchParams.get('state') ?? 'open';
        const sort = url.searchParams.get('sort') ?? 'created';
        const direction = url.searchParams.get('direction') ?? 'desc';
        let list = [...r.issues.values()];
        if (state !== 'all') list = list.filter((i) => i.state === state);
        if (sort === 'created') list.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
        const { page, link } = paginate(req, url, list);
        sendJson(res, 200, page.map((i) => issueView(r, i)), link === null ? {} : { link });
        return;
      }
      if (method === 'POST') {
        const parsed = parseJsonBody(await readBody(req));
        if (!parsed.ok) {
          sendJson(res, 400, { message: 'Invalid JSON' });
          return;
        }
        const body = (parsed.value ?? {}) as Record<string, unknown>;
        const title = typeof body.title === 'string' ? body.title : '';
        const labels = Array.isArray(body.labels) ? (body.labels as unknown[]).map((l) => (typeof l === 'string' ? l : (l as Record<string, unknown>).name)).filter((l): l is string => typeof l === 'string') : [];
        for (const label of labels) {
          if (!r.labels.has(label)) {
            sendJson(res, 422, { message: `Label does not exist: ${label}` });
            return;
          }
        }
        const issue: Issue = {
          id: store.nextIssueId++,
          number: r.nextIssue++,
          title,
          body: typeof body.body === 'string' ? body.body : '',
          state: 'open',
          labels,
          createdAt: NOW_ISO,
          updatedAt: NOW_ISO,
          comments: [],
        };
        r.issues.set(issue.number, issue);
        sendJson(res, 201, issueView(r, issue));
        return;
      }
    }
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }

  // ---- pulls ------------------------------------------------------------------
  if (section === 'pulls') {
    const r = needRepo();
    if (!r) return;
    // /pulls/{n}/files
    if (tail.length === 3 && tail[2] === 'files') {
      const number = Number.parseInt(tail[1], 10);
      const pull = r.pulls.get(number);
      if (pull === undefined) {
        sendJson(res, 404, { message: 'Not Found' });
        return;
      }
      if (method === 'GET') {
        const files = pullFiles(r, pull).map((change) => {
          const oldData = change.oldOid ? (r.objects.get(change.oldOid)?.data ?? null) : null;
          const newData = change.newOid ? (r.objects.get(change.newOid)?.data ?? null) : null;
          const { additions, deletions } = lineDiff(oldData, newData);
          return { filename: change.path, status: change.status, additions, deletions, changes: additions + deletions };
        });
        sendJson(res, 200, files);
        return;
      }
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }
    // /pulls/{n}/merge
    if (tail.length === 3 && tail[2] === 'merge') {
      const number = Number.parseInt(tail[1], 10);
      const pull = r.pulls.get(number);
      if (pull === undefined) {
        sendJson(res, 404, { message: 'Not Found' });
        return;
      }
      if (method === 'PUT') {
        const parsed = parseJsonBody(await readBody(req));
        if (!parsed.ok) {
          sendJson(res, 400, { message: 'Invalid JSON' });
          return;
        }
        if (pull.state !== 'open') {
          sendJson(res, 405, { message: 'Pull request is already closed' });
          return;
        }
        if (pullConflicts(r, pull)) {
          sendJson(res, 405, { message: 'Merge conflict' });
          return;
        }
        const sha = squashMerge(r, pull);
        if (sha === null) {
          sendJson(res, 405, { message: 'Could not merge pull request' });
          return;
        }
        sendJson(res, 200, { sha, merged: true, message: 'Pull request successfully merged' });
        return;
      }
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }
    // /pulls/{n}
    if (tail.length === 2) {
      const number = Number.parseInt(tail[1], 10);
      const pull = r.pulls.get(number);
      if (pull === undefined) {
        sendJson(res, 404, { message: 'Not Found' });
        return;
      }
      if (method === 'GET') {
        sendJson(res, 200, pullView(r, pull));
        return;
      }
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }
    // /pulls
    if (tail.length === 1) {
      if (method === 'GET') {
        const state = url.searchParams.get('state') ?? 'open';
        let list = [...r.pulls.values()];
        if (state !== 'all') list = list.filter((p) => p.state === state);
        list.sort((a, b) => a.number - b.number);
        const { page, link } = paginate(req, url, list);
        sendJson(res, 200, page.map((p) => pullView(r, p)), link === null ? {} : { link });
        return;
      }
      if (method === 'POST') {
        const parsed = parseJsonBody(await readBody(req));
        if (!parsed.ok) {
          sendJson(res, 400, { message: 'Invalid JSON' });
          return;
        }
        const body = (parsed.value ?? {}) as Record<string, unknown>;
        const pull = createPullRecord(r, () => store.nextPullId++, {
          title: typeof body.title === 'string' ? body.title : '',
          body: typeof body.body === 'string' ? body.body : '',
          head: typeof body.head === 'string' ? body.head : '',
          base: typeof body.base === 'string' ? body.base : '',
        });
        if (pull === null) {
          sendJson(res, 422, { message: 'Could not create pull request: head or base branch not found, or an open pull request already exists' });
          return;
        }
        sendJson(res, 201, pullView(r, pull));
        return;
      }
    }
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }

  sendJson(res, 404, { message: 'Not Found' });
}
