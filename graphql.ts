// GraphQL v4: a small parser and executor for exactly the documents gh and
// github-mcp-server send (see program/env/src/checks-graphql.ts). No dependency, no
// schema library: the field sets below are the schema the introspection answers.

import {
  blobAt,
  createPullRecord,
  gid,
  lineDiff,
  NOW_EPOCH,
  NOW_ISO,
  parseCommit,
  parseGid,
  parseTree,
  pullConflicts,
  pullFiles,
  pullMergeable,
  squashMerge,
  store,
  VIEWER,
  type Issue,
  type Pull,
  type Repo,
} from './store.ts';

// -------------------------------------------------------------------------------------------
// parser
// -------------------------------------------------------------------------------------------

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: Map<string, ValueNode> };

interface FieldSelection {
  kind: 'field';
  alias: string;
  name: string;
  args: Map<string, ValueNode>;
  selections: Selection[];
}

interface FragmentSelection {
  kind: 'fragment';
  typeCondition: string | null;
  selections: Selection[];
}

type Selection = FieldSelection | FragmentSelection;

interface Operation {
  kind: 'query' | 'mutation';
  name: string | null;
  variableDefinitions: Map<string, { type: string; defaultValue?: ValueNode }>;
  selections: Selection[];
}

class GqlError extends Error {}

function tokenize(src: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',') {
      i += 1;
      continue;
    }
    if (c === '#') {
      while (i < src.length && src[i] !== '\n') i += 1;
      continue;
    }
    if (c === '.' && src.slice(i, i + 3) === '...') {
      tokens.push('...');
      i += 3;
      continue;
    }
    if ('{}()[]:!=$@'.includes(c)) {
      tokens.push(c);
      i += 1;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      let out = '';
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\' && j + 1 < src.length) {
          const e = src[j + 1];
          out += e === 'n' ? '\n' : e === 't' ? '\t' : e === 'r' ? '\r' : e;
          j += 2;
        } else {
          out += src[j];
          j += 1;
        }
      }
      tokens.push(JSON.stringify(out));
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(c)) {
      let j = i;
      while (j < src.length && /[0-9.eE+-]/.test(src[j])) j += 1;
      tokens.push(src.slice(i, j));
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j])) j += 1;
      tokens.push(src.slice(i, j));
      i = j;
      continue;
    }
    throw new GqlError(`unexpected character ${JSON.stringify(c)} in GraphQL document`);
  }
  return tokens;
}

class Parser {
  private pos = 0;
  private tokens: string[];
  constructor(tokens: string[]) {
    this.tokens = tokens;
  }

  peek(): string {
    return this.tokens[this.pos] ?? '';
  }

  next(): string {
    const t = this.tokens[this.pos] ?? '';
    this.pos += 1;
    return t;
  }

  expect(t: string): void {
    const got = this.next();
    if (got !== t) throw new GqlError(`expected ${JSON.stringify(t)}, got ${JSON.stringify(got)}`);
  }

  parseDocument(): Operation[] {
    const ops: Operation[] = [];
    while (this.pos < this.tokens.length) {
      ops.push(this.parseOperation());
    }
    return ops;
  }

  parseOperation(): Operation {
    let kind: 'query' | 'mutation' = 'query';
    let name: string | null = null;
    const t = this.peek();
    if (t === 'query' || t === 'mutation') {
      kind = this.next() as 'query' | 'mutation';
      if (this.peek() !== '' && this.peek() !== '(' && this.peek() !== '{' && !/^[A-Z]/.test(this.peek())) {
        // anonymous or named
      }
      if (this.peek() !== '(' && this.peek() !== '{') name = this.next();
    }
    const variableDefinitions = new Map<string, { type: string; defaultValue?: ValueNode }>();
    if (this.peek() === '(') {
      this.next();
      while (this.peek() !== ')') {
        this.expect('$');
        const varName = this.next();
        this.expect(':');
        let type = '';
        while (this.peek() !== '=' && this.peek() !== ')' && this.peek() !== '$') {
          type += this.next();
        }
        let defaultValue: ValueNode | undefined;
        if (this.peek() === '=') {
          this.next();
          defaultValue = this.parseValue();
        }
        variableDefinitions.set(varName, { type, defaultValue });
      }
      this.expect(')');
    }
    const selections = this.parseSelectionSet();
    return { kind, name, variableDefinitions, selections };
  }

  parseSelectionSet(): Selection[] {
    this.expect('{');
    const out: Selection[] = [];
    while (this.peek() !== '}') {
      if (this.peek() === '') throw new GqlError('unterminated selection set');
      out.push(this.parseSelection());
    }
    this.expect('}');
    return out;
  }

  parseSelection(): Selection {
    if (this.peek() === '...') {
      this.next();
      let typeCondition: string | null = null;
      if (this.peek() === 'on') {
        this.next();
        typeCondition = this.next();
      }
      return { kind: 'fragment', typeCondition, selections: this.parseSelectionSet() };
    }
    let alias = '';
    let name = this.next();
    if (this.peek() === ':') {
      this.next();
      alias = name;
      name = this.next();
    } else {
      alias = name;
    }
    const args = new Map<string, ValueNode>();
    if (this.peek() === '(') {
      this.next();
      while (this.peek() !== ')') {
        const argName = this.next();
        this.expect(':');
        args.set(argName, this.parseValue());
      }
      this.expect(')');
    }
    // directives (none in the graded documents): skip @name(args)
    while (this.peek() === '@') {
      this.next();
      this.next();
      if (this.peek() === '(') {
        let depth = 0;
        while (this.pos < this.tokens.length) {
          const t = this.next();
          if (t === '(') depth += 1;
          else if (t === ')') {
            depth -= 1;
            if (depth === 0) break;
          }
        }
      }
    }
    let selections: Selection[] = [];
    if (this.peek() === '{') selections = this.parseSelectionSet();
    return { kind: 'field', alias, name, args, selections };
  }

  parseValue(): ValueNode {
    const t = this.next();
    if (t === '$') return { kind: 'variable', name: this.next() };
    if (t === '[') {
      const values: ValueNode[] = [];
      while (this.peek() !== ']') values.push(this.parseValue());
      this.expect(']');
      return { kind: 'list', values };
    }
    if (t === '{') {
      const fields = new Map<string, ValueNode>();
      while (this.peek() !== '}') {
        const key = this.next();
        this.expect(':');
        fields.set(key, this.parseValue());
      }
      this.expect('}');
      return { kind: 'object', fields };
    }
    if (t === 'true') return { kind: 'boolean', value: true };
    if (t === 'false') return { kind: 'boolean', value: false };
    if (t === 'null') return { kind: 'null' };
    if (t.startsWith('"')) return { kind: 'string', value: JSON.parse(t) as string };
    if (/^-?\d+$/.test(t)) return { kind: 'int', value: Number.parseInt(t, 10) };
    if (/^-?\d+\.\d+$/.test(t)) return { kind: 'float', value: Number.parseFloat(t) };
    return { kind: 'enum', value: t };
  }
}

// -------------------------------------------------------------------------------------------
// schema: the fields each type answers (introspection reads these lists)
// -------------------------------------------------------------------------------------------

const FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', '__type', '__schema'],
  User: ['login', 'id', 'name', 'email'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'description', 'private', 'createdAt', 'updatedAt', 'issue', 'issues', 'pullRequests', 'pullRequest'],
  Ref: ['name'],
  Issue: ['id', 'number', 'title', 'body', 'state', 'createdAt', 'updatedAt', 'labels', 'author', 'url'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequest: ['id', 'number', 'title', 'body', 'state', 'merged', 'mergedAt', 'headRefName', 'baseRefName', 'mergeable', 'files', 'head', 'base', 'createdAt', 'updatedAt'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestChangedFile: ['path', 'additions', 'deletions', 'changes', 'status'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  CreateIssuePayload: ['issue', 'clientMutationId'],
  CloseIssuePayload: ['issue', 'clientMutationId'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId'],
  AddCommentPayload: ['commentEdge', 'clientMutationId', 'subject'],
  CommentEdge: ['node', 'cursor'],
  Comment: ['id', 'body', 'createdAt', 'updatedAt'],
  __Type: ['name', 'kind', 'fields', 'enumValues', 'description'],
  __Field: ['name', 'description'],
  __EnumValue: ['name', 'description'],
  __Schema: ['queryType', 'mutationType', 'types'],
  Label: ['name', 'color', 'description'],
};

const ENUMS: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
};

// -------------------------------------------------------------------------------------------
// executor
// -------------------------------------------------------------------------------------------

interface Ctx {
  variables: Record<string, unknown>;
  errors: { message: string }[];
}

type ResolverValue =
  | { __type: string; [key: string]: unknown }
  | null;

function resolveValue(node: ValueNode, ctx: Ctx): unknown {
  switch (node.kind) {
    case 'variable':
      return ctx.variables[node.name] ?? null;
    case 'string':
    case 'int':
    case 'float':
    case 'boolean':
    case 'enum':
      return node.value;
    case 'null':
      return null;
    case 'list':
      return node.values.map((v) => resolveValue(v, ctx));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [k, v] of node.fields) out[k] = resolveValue(v, ctx);
      return out;
    }
  }
}

function argValue(field: FieldSelection, name: string, ctx: Ctx): unknown {
  const node = field.args.get(name);
  if (node === undefined) return undefined;
  return resolveValue(node, ctx);
}

function repoObject(repo: Repo): ResolverValue {
  return {
    __type: 'Repository',
    __repo: repo,
    id: gid('R', repo.id),
    databaseId: repo.id,
    name: repo.name,
    nameWithOwner: `${repo.owner}/${repo.name}`,
    owner: { __type: 'User', login: repo.owner, id: String(VIEWER.id), name: VIEWER.name, email: VIEWER.email },
    defaultBranchRef: { __type: 'Ref', name: repo.defaultBranch },
    viewerPermission: 'ADMIN',
    hasIssuesEnabled: true,
    description: repo.description,
    private: repo.isPrivate,
    createdAt: repo.createdAt,
    updatedAt: repo.updatedAt,
  };
}

function issueObject(repo: Repo, issue: Issue): ResolverValue {
  return {
    __type: 'Issue',
    __repo: repo,
    __issue: issue,
    id: gid('I', repo.id, issue.number),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state === 'open' ? 'OPEN' : 'CLOSED',
    createdAt: issue.createdAt,
    updatedAt: issue.updatedAt,
    labels: issue.labels.map((name) => ({ __type: 'Label', name })),
    author: { __type: 'User', login: VIEWER.login, id: String(VIEWER.id), name: VIEWER.name, email: VIEWER.email },
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

function pullObject(repo: Repo, pull: Pull): ResolverValue {
  const state = pull.state === 'open' ? 'OPEN' : pull.merged ? 'MERGED' : 'CLOSED';
  return {
    __type: 'PullRequest',
    __repo: repo,
    __pull: pull,
    id: gid('PR', repo.id, pull.number),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state,
    merged: pull.merged,
    mergedAt: pull.mergedAt,
    headRefName: pull.head,
    baseRefName: pull.base,
    mergeable: pullMergeable(repo, pull),
    createdAt: pull.createdAt,
    updatedAt: pull.updatedAt,
  };
}

function cursorFor(n: number): string {
  return Buffer.from(`cursor:${n}`, 'utf8').toString('base64');
}

function cursorToNumber(cursor: unknown): number | null {
  if (typeof cursor !== 'string' || cursor === '') return null;
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    if (!text.startsWith('cursor:')) return null;
    const n = Number.parseInt(text.slice(7), 10);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

function executeSelections(
  value: ResolverValue,
  selections: Selection[],
  ctx: Ctx,
): Record<string, unknown> | null {
  if (value === null) return null;
  const out: Record<string, unknown> = {};
  for (const sel of selections) {
    if (sel.kind === 'fragment') {
      if (sel.typeCondition !== null && sel.typeCondition !== value.__type) continue;
      const sub = executeSelections(value, sel.selections, ctx);
      if (sub !== null) Object.assign(out, sub);
      continue;
    }
    const fieldName = sel.name;
    const allowed = FIELDS[value.__type] ?? [];
    if (value.__type !== 'Query' && value.__type !== 'Mutation' && !allowed.includes(fieldName)) {
      ctx.errors.push({ message: `Cannot query field "${fieldName}" on type "${value.__type}".` });
      continue;
    }
    if ((value.__type === 'Query' || value.__type === 'Mutation') && !allowed.includes(fieldName)) {
      ctx.errors.push({ message: `Cannot query field "${fieldName}" on type "${value.__type}".` });
      continue;
    }
    const resolved = resolveField(value, sel, ctx);
    if (sel.selections.length > 0) {
      if (resolved === null || resolved === undefined) {
        out[sel.alias] = null;
      } else if (Array.isArray(resolved)) {
        out[sel.alias] = resolved.map((item) =>
          item !== null && typeof item === 'object' && '__type' in (item as Record<string, unknown>)
            ? executeSelections(item as ResolverValue, sel.selections, ctx)
            : item,
        );
      } else if (typeof resolved === 'object' && '__type' in (resolved as Record<string, unknown>)) {
        out[sel.alias] = executeSelections(resolved as ResolverValue, sel.selections, ctx);
      } else {
        out[sel.alias] = resolved;
      }
    } else {
      out[sel.alias] = resolved ?? null;
    }
  }
  return out;
}

function issueStateOf(v: unknown): 'open' | 'closed' | null {
  return v === 'OPEN' ? 'open' : v === 'CLOSED' ? 'closed' : null;
}

function resolveField(value: ResolverValue, field: FieldSelection, ctx: Ctx): unknown {
  if (value === null) return null;
  const type = value.__type;
  const repo = (value as Record<string, unknown>).__repo as Repo | undefined;
  switch (type) {
    case 'Query': {
      if (field.name === 'viewer') {
        return { __type: 'User', login: VIEWER.login, id: String(VIEWER.id), name: VIEWER.name, email: VIEWER.email };
      }
      if (field.name === 'repository') {
        const owner = argValue(field, 'owner', ctx);
        const name = argValue(field, 'name', ctx);
        if (typeof owner !== 'string' || typeof name !== 'string') return null;
        const found = store.getRepo(owner, name);
        return found ? repoObject(found) : null;
      }
      if (field.name === 'node') {
        const id = argValue(field, 'id', ctx);
        if (typeof id !== 'string') return null;
        return nodeById(id);
      }
      if (field.name === '__type') {
        const name = argValue(field, 'name', ctx);
        if (typeof name !== 'string') return null;
        return typeObject(name);
      }
      if (field.name === '__schema') {
        return { __type: '__Schema', queryType: { name: 'Query' }, mutationType: { name: 'Mutation' }, types: [] };
      }
      return null;
    }
    case 'Repository': {
      if (!repo) return null;
      if (field.name === 'issue') {
        const number = argValue(field, 'number', ctx);
        if (typeof number !== 'number') return null;
        const issue = repo.issues.get(number);
        return issue ? issueObject(repo, issue) : null;
      }
      if (field.name === 'issues') {
        return issuesConnection(repo, field, ctx);
      }
      if (field.name === 'pullRequests') {
        return pullsConnection(repo, field, ctx);
      }
      if (field.name === 'pullRequest') {
        const number = argValue(field, 'number', ctx);
        if (typeof number !== 'number') return null;
        const pull = repo.pulls.get(number);
        return pull ? pullObject(repo, pull) : null;
      }
      return (value as Record<string, unknown>)[field.name] ?? null;
    }
    case 'Issue': {
      return (value as Record<string, unknown>)[field.name] ?? null;
    }
    case 'PullRequest': {
      if (!repo) return null;
      const pull = (value as Record<string, unknown>).__pull as Pull;
      if (field.name === 'files') {
        const first = argValue(field, 'first', ctx);
        const files = pullFiles(repo, pull).map((change) => {
          const oldData = change.oldOid ? repo.objects.get(change.oldOid)?.data ?? null : null;
          const newData = change.newOid ? repo.objects.get(change.newOid)?.data ?? null : null;
          const { additions, deletions } = lineDiff(oldData, newData);
          return {
            __type: 'PullRequestChangedFile',
            path: change.path,
            status: change.status,
            additions,
            deletions,
            changes: additions + deletions,
          };
        });
        const nodes = typeof first === 'number' ? files.slice(0, first) : files;
        return { __type: 'PullRequestConnection', nodes, pageInfo: { __type: 'PageInfo', hasNextPage: false, endCursor: null } };
      }
      return (value as Record<string, unknown>)[field.name] ?? null;
    }
    case 'IssueConnection':
    case 'PullRequestConnection': {
      return (value as Record<string, unknown>)[field.name] ?? null;
    }
    case 'PageInfo': {
      return (value as Record<string, unknown>)[field.name] ?? null;
    }
    case 'Mutation': {
      return resolveMutation(field, ctx);
    }
    case '__Type': {
      if (field.name === 'fields') {
        const name = (value as Record<string, unknown>).__typeName as string;
        return (FIELDS[name] ?? []).map((n) => ({ __type: '__Field', name: n, description: null }));
      }
      if (field.name === 'enumValues') {
        const name = (value as Record<string, unknown>).__typeName as string;
        return (ENUMS[name] ?? []).map((n) => ({ __type: '__EnumValue', name: n, description: null }));
      }
      return (value as Record<string, unknown>)[field.name] ?? null;
    }
    default: {
      return (value as Record<string, unknown>)[field.name] ?? null;
    }
  }
}

function typeObject(name: string): ResolverValue {
  if (FIELDS[name] !== undefined || ENUMS[name] !== undefined) {
    return { __type: '__Type', __typeName: name, name, kind: ENUMS[name] !== undefined ? 'ENUM' : 'OBJECT', description: null };
  }
  return null;
}

function nodeById(id: string): ResolverValue {
  const parsed = parseGid(id);
  if (!parsed) return null;
  if (parsed.kind === 'R') {
    const dbId = Number.parseInt(parsed.parts[0] ?? '', 10);
    for (const repo of store.listRepos()) if (repo.id === dbId) return repoObject(repo);
    return null;
  }
  if (parsed.kind === 'I') {
    const dbId = Number.parseInt(parsed.parts[0] ?? '', 10);
    const number = Number.parseInt(parsed.parts[1] ?? '', 10);
    for (const repo of store.listRepos()) {
      if (repo.id !== dbId) continue;
      const issue = repo.issues.get(number);
      if (issue) return issueObject(repo, issue);
    }
    return null;
  }
  if (parsed.kind === 'PR') {
    const dbId = Number.parseInt(parsed.parts[0] ?? '', 10);
    const number = Number.parseInt(parsed.parts[1] ?? '', 10);
    for (const repo of store.listRepos()) {
      if (repo.id !== dbId) continue;
      const pull = repo.pulls.get(number);
      if (pull) return pullObject(repo, pull);
    }
    return null;
  }
  return null;
}

function issuesConnection(repo: Repo, field: FieldSelection, ctx: Ctx): ResolverValue {
  const first = argValue(field, 'first', ctx);
  const after = argValue(field, 'after', ctx);
  const states = argValue(field, 'states', ctx);
  const orderBy = argValue(field, 'orderBy', ctx) as { field?: string; direction?: string } | undefined;
  let list = [...repo.issues.values()];
  if (Array.isArray(states) && states.length > 0) {
    const wanted = new Set(states.map((s) => issueStateOf(s)).filter((s): s is 'open' | 'closed' => s !== null));
    list = list.filter((i) => wanted.has(i.state));
  }
  const direction = orderBy?.direction === 'DESC' ? -1 : 1;
  list.sort((a, b) => (a.number - b.number) * direction);
  const afterNum = cursorToNumber(after);
  if (afterNum !== null) {
    list = direction === 1 ? list.filter((i) => i.number > afterNum) : list.filter((i) => i.number < afterNum);
  }
  const limit = typeof first === 'number' ? first : list.length;
  const page = list.slice(0, limit);
  const hasNextPage = list.length > page.length;
  const endCursor = page.length > 0 ? cursorFor(page[page.length - 1].number) : null;
  return {
    __type: 'IssueConnection',
    nodes: page.map((i) => issueObject(repo, i)),
    pageInfo: { __type: 'PageInfo', hasNextPage, hasPreviousPage: false, startCursor: page.length > 0 ? cursorFor(page[0].number) : null, endCursor },
    totalCount: list.length,
  };
}

function pullsConnection(repo: Repo, field: FieldSelection, ctx: Ctx): ResolverValue {
  const first = argValue(field, 'first', ctx);
  const after = argValue(field, 'after', ctx);
  let list = [...repo.pulls.values()].filter((p) => p.state === 'open');
  list.sort((a, b) => a.number - b.number);
  const afterNum = cursorToNumber(after);
  if (afterNum !== null) list = list.filter((p) => p.number > afterNum);
  const limit = typeof first === 'number' ? first : list.length;
  const page = list.slice(0, limit);
  const hasNextPage = list.length > page.length;
  const endCursor = page.length > 0 ? cursorFor(page[page.length - 1].number) : null;
  return {
    __type: 'PullRequestConnection',
    nodes: page.map((p) => pullObject(repo, p)),
    pageInfo: { __type: 'PageInfo', hasNextPage, hasPreviousPage: false, startCursor: page.length > 0 ? cursorFor(page[0].number) : null, endCursor },
    totalCount: list.length,
  };
}

function findRepoByGid(id: unknown): Repo | null {
  if (typeof id !== 'string') return null;
  const parsed = parseGid(id);
  if (!parsed || parsed.kind !== 'R') return null;
  const dbId = Number.parseInt(parsed.parts[0] ?? '', 10);
  for (const repo of store.listRepos()) if (repo.id === dbId) return repo;
  return null;
}

function findIssueByGid(id: unknown): { repo: Repo; issue: Issue } | null {
  if (typeof id !== 'string') return null;
  const parsed = parseGid(id);
  if (!parsed || parsed.kind !== 'I') return null;
  const dbId = Number.parseInt(parsed.parts[0] ?? '', 10);
  const number = Number.parseInt(parsed.parts[1] ?? '', 10);
  for (const repo of store.listRepos()) {
    if (repo.id !== dbId) continue;
    const issue = repo.issues.get(number);
    if (issue) return { repo, issue };
  }
  return null;
}

function findPullByGid(id: unknown): { repo: Repo; pull: Pull } | null {
  if (typeof id !== 'string') return null;
  const parsed = parseGid(id);
  if (!parsed || parsed.kind !== 'PR') return null;
  const dbId = Number.parseInt(parsed.parts[0] ?? '', 10);
  const number = Number.parseInt(parsed.parts[1] ?? '', 10);
  for (const repo of store.listRepos()) {
    if (repo.id !== dbId) continue;
    const pull = repo.pulls.get(number);
    if (pull) return { repo, pull };
  }
  return null;
}

function resolveMutation(field: FieldSelection, ctx: Ctx): unknown {
  const input = argValue(field, 'input', ctx) as Record<string, unknown> | undefined;
  if (field.name === 'createIssue') {
    const repo = findRepoByGid(input?.repositoryId);
    if (!repo) {
      ctx.errors.push({ message: 'createIssue: repository not found' });
      return null;
    }
    const title = typeof input?.title === 'string' ? input.title : '';
    const body = typeof input?.body === 'string' ? input.body : '';
    const issue: Issue = {
      id: store.nextIssueId++,
      number: repo.nextIssue++,
      title,
      body,
      state: 'open',
      labels: [],
      createdAt: NOW_ISO,
      updatedAt: NOW_ISO,
      comments: [],
    };
    repo.issues.set(issue.number, issue);
    return { __type: 'CreateIssuePayload', issue: issueObject(repo, issue), clientMutationId: null };
  }
  if (field.name === 'closeIssue') {
    const found = findIssueByGid(input?.issueId);
    if (!found) {
      ctx.errors.push({ message: 'closeIssue: issue not found' });
      return null;
    }
    found.issue.state = 'closed';
    found.issue.updatedAt = NOW_ISO;
    return { __type: 'CloseIssuePayload', issue: issueObject(found.repo, found.issue), clientMutationId: null };
  }
  if (field.name === 'createPullRequest') {
    const repo = findRepoByGid(input?.repositoryId);
    if (!repo) {
      ctx.errors.push({ message: 'createPullRequest: repository not found' });
      return null;
    }
    const pull = createPullRecord(repo, () => store.nextPullId++, {
      title: typeof input?.title === 'string' ? input.title : '',
      body: typeof input?.body === 'string' ? input.body : '',
      head: typeof input?.headRefName === 'string' ? input.headRefName : '',
      base: typeof input?.baseRefName === 'string' ? input.baseRefName : '',
    });
    if (!pull) {
      ctx.errors.push({ message: 'createPullRequest: head or base branch not found, or an open pull request already exists' });
      return null;
    }
    return { __type: 'CreatePullRequestPayload', pullRequest: pullObject(repo, pull), clientMutationId: null };
  }
  if (field.name === 'mergePullRequest') {
    const found = findPullByGid(input?.pullRequestId);
    if (!found) {
      ctx.errors.push({ message: 'mergePullRequest: pull request not found' });
      return null;
    }
    if (pullConflicts(found.repo, found.pull)) {
      ctx.errors.push({ message: 'mergePullRequest: pull request is conflicted' });
      return null;
    }
    const sha = squashMerge(found.repo, found.pull);
    if (sha === null) {
      ctx.errors.push({ message: 'mergePullRequest: could not merge' });
      return null;
    }
    return { __type: 'MergePullRequestPayload', pullRequest: pullObject(found.repo, found.pull), clientMutationId: null };
  }
  if (field.name === 'addComment') {
    const found = findIssueByGid(input?.subjectId);
    if (!found) {
      ctx.errors.push({ message: 'addComment: subject not found' });
      return null;
    }
    const body = typeof input?.body === 'string' ? input.body : '';
    const comment = { id: store.nextCommentId++, body, createdAt: NOW_ISO, updatedAt: NOW_ISO };
    found.issue.comments.push(comment);
    return {
      __type: 'AddCommentPayload',
      commentEdge: {
        __type: 'CommentEdge',
        node: { __type: 'Comment', id: gid('C', found.repo.id, found.issue.number, comment.id), body, createdAt: NOW_ISO, updatedAt: NOW_ISO },
        cursor: cursorFor(comment.id),
      },
      clientMutationId: null,
    };
  }
  return null;
}

// -------------------------------------------------------------------------------------------
// entry point: one operation (or an array of operations for batching)
// -------------------------------------------------------------------------------------------

export interface GqlResult {
  data: Record<string, unknown> | null;
  errors: { message: string }[];
}

export function executeGraphQL(body: unknown): GqlResult | GqlResult[] {
  if (Array.isArray(body)) {
    return body.map((entry) => executeOne(entry));
  }
  return executeOne(body);
}

function executeOne(body: unknown): GqlResult {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { data: null, errors: [{ message: 'GraphQL request must be a JSON object with a query string.' }] };
  }
  const record = body as Record<string, unknown>;
  const query = record.query;
  if (typeof query !== 'string' || query.trim() === '') {
    return { data: null, errors: [{ message: 'GraphQL request has no query string.' }] };
  }
  const variables = (record.variables ?? {}) as Record<string, unknown>;
  let operations: Operation[];
  try {
    operations = new Parser(tokenize(query)).parseDocument();
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : String(err) }] };
  }
  const operationName = typeof record.operationName === 'string' ? record.operationName : null;
  let operation = operations[0];
  if (operationName !== null) {
    operation = operations.find((op) => op.name === operationName) ?? operations[0];
  }
  if (!operation) return { data: null, errors: [{ message: 'GraphQL document has no operation.' }] };
  const ctx: Ctx = { variables: { ...variables }, errors: [] };
  // Apply variable defaults.
  for (const [name, def] of operation.variableDefinitions) {
    if (!(name in ctx.variables) || ctx.variables[name] === undefined) {
      if (def.defaultValue !== undefined) ctx.variables[name] = resolveValue(def.defaultValue, ctx);
    }
  }
  const root: ResolverValue = operation.kind === 'mutation' ? { __type: 'Mutation' } : { __type: 'Query' };
  const data = executeSelections(root, operation.selections, ctx);
  if (ctx.errors.length > 0) return { data: null, errors: ctx.errors };
  return { data, errors: [] };
}

// Re-exported for app.ts's REST use of the same commit helpers.
export { NOW_EPOCH, blobAt, parseCommit, parseTree };
