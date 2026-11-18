// MCP over streamable HTTP (JSON-RPC 2.0, plain JSON answers): server/discover for the
// 2026-07-28 era, the legacy initialize handshake, tools/list and tools/call.

import {
  createPullRecord,
  pullConflicts,
  squashMerge,
  store,
  VIEWER,
  type Issue,
  type Pull,
  type Repo,
} from './store.ts';

// -------------------------------------------------------------------------------------------
// tools (one constant: two tools/list calls answer byte-identical JSON)
// -------------------------------------------------------------------------------------------

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner login (the authenticated user).' },
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'Issue state: open, closed, or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        body: { type: 'string', description: 'The pull request body.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Squash-merge a pull request by number.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'integer', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

const SERVER_INFO = { name: 'github-forge', version: '1.0.0' };

// -------------------------------------------------------------------------------------------
// views (the same objects REST serves)
// -------------------------------------------------------------------------------------------

function repoView(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: VIEWER.id },
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
  };
}

function issueView(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => ({ name })),
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    html_url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

function pullView(repo: Repo, pull: Pull): Record<string, unknown> {
  return {
    id: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    head: { ref: pull.head, sha: pull.headSha },
    base: { ref: pull.base, sha: pull.baseSha },
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
  };
}

function okResult(value: unknown): Record<string, unknown> {
  return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value };
}

function errResult(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function missingArgs(tool: ToolDef, args: Record<string, unknown>): string[] {
  return tool.inputSchema.required.filter((name) => args[name] === undefined || args[name] === null || args[name] === '');
}

function callTool(name: string, args: Record<string, unknown>): Record<string, unknown> {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) return errResult(`Unknown tool: ${name}`);
  const missing = missingArgs(tool, args);
  if (missing.length > 0) return errResult(`Missing required argument(s): ${missing.join(', ')}`);
  const owner = typeof args.owner === 'string' && args.owner !== '' ? args.owner : VIEWER.login;
  const repoName = typeof args.repo === 'string' ? args.repo : '';
  switch (name) {
    case 'create_repo': {
      const repo = store.createRepo(
        typeof args.name === 'string' ? args.name : '',
        args.private === true,
        typeof args.description === 'string' ? args.description : '',
      );
      if (!repo) return errResult(`Repository ${owner}/${args.name} already exists`);
      return okResult(repoView(repo));
    }
    case 'get_repo': {
      const repo = store.getRepo(owner, repoName);
      if (!repo) return errResult(`Repository ${owner}/${repoName} not found`);
      return okResult(repoView(repo));
    }
    case 'create_issue': {
      const repo = store.getRepo(owner, repoName);
      if (!repo) return errResult(`Repository ${owner}/${repoName} not found`);
      const issue: Issue = {
        id: store.nextIssueId++,
        number: repo.nextIssue++,
        title: typeof args.title === 'string' ? args.title : '',
        body: typeof args.body === 'string' ? args.body : '',
        state: 'open',
        labels: [],
        createdAt: repo.createdAt,
        updatedAt: repo.createdAt,
        comments: [],
      };
      repo.issues.set(issue.number, issue);
      return okResult(issueView(repo, issue));
    }
    case 'list_issues': {
      const repo = store.getRepo(owner, repoName);
      if (!repo) return errResult(`Repository ${owner}/${repoName} not found`);
      const state = typeof args.state === 'string' ? args.state : 'open';
      const issues = [...repo.issues.values()]
        .filter((i) => state === 'all' || i.state === state)
        .map((i) => issueView(repo, i));
      return okResult({ issues });
    }
    case 'create_pull_request': {
      const repo = store.getRepo(owner, repoName);
      if (!repo) return errResult(`Repository ${owner}/${repoName} not found`);
      const pull = createPullRecord(repo, () => store.nextPullId++, {
        title: typeof args.title === 'string' ? args.title : '',
        body: typeof args.body === 'string' ? args.body : '',
        head: typeof args.head === 'string' ? args.head : '',
        base: typeof args.base === 'string' ? args.base : '',
      });
      if (!pull) return errResult('Could not create pull request: head or base branch not found, or an open pull request already exists');
      return okResult(pullView(repo, pull));
    }
    case 'merge_pull_request': {
      const repo = store.getRepo(owner, repoName);
      if (!repo) return errResult(`Repository ${owner}/${repoName} not found`);
      const number = typeof args.pull_number === 'number' ? args.pull_number : Number.parseInt(String(args.pull_number), 10);
      const pull = repo.pulls.get(number);
      if (!pull) return errResult(`Pull request #${number} not found`);
      if (pull.state !== 'open') return errResult(`Pull request #${number} is not open`);
      if (pullConflicts(repo, pull)) return errResult(`Pull request #${number} is conflicted`);
      const sha = squashMerge(repo, pull);
      if (sha === null) return errResult(`Pull request #${number} could not be merged`);
      return okResult({ merged: true, sha, message: 'Pull request successfully merged', number: pull.number });
    }
    default:
      return errResult(`Unknown tool: ${name}`);
  }
}

// -------------------------------------------------------------------------------------------
// JSON-RPC dispatch. Returns {status, body} where body is the JSON text ('' for 202).
// -------------------------------------------------------------------------------------------

const LEGACY_REVISIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

export function handleMcp(rawBody: Buffer): { status: number; body: string } {
  let request: unknown;
  try {
    request = JSON.parse(rawBody.toString('utf8')) as unknown;
  } catch {
    return {
      status: 400,
      body: JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }),
    };
  }
  if (request === null || typeof request !== 'object' || Array.isArray(request)) {
    return {
      status: 400,
      body: JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } }),
    };
  }
  const req = request as Record<string, unknown>;
  const id = (req.id ?? null) as string | number | null;
  const method = typeof req.method === 'string' ? req.method : '';
  const params = (req.params ?? {}) as Record<string, unknown>;

  // A notification (no id) is answered with 202 and no body.
  if (id === null && method.startsWith('notifications/')) {
    return { status: 202, body: '' };
  }

  const result = (value: unknown): { status: number; body: string } => ({
    status: 200,
    body: JSON.stringify({ jsonrpc: '2.0', id, result: value }),
  });
  const error = (code: number, message: string): { status: number; body: string } => ({
    status: 200,
    body: JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }),
  });

  switch (method) {
    case 'server/discover':
      return result({
        supportedVersions: ['2026-07-28', ...LEGACY_REVISIONS],
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
        instructions: 'A GitHub-compatible git forge: repositories, issues, pull requests, git smart HTTP, GraphQL and MCP.',
        _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO },
      });
    case 'initialize': {
      const asked = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      return result({
        protocolVersion: LEGACY_REVISIONS.includes(asked) ? asked : '2025-11-25',
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      });
    }
    case 'ping':
      return result({});
    case 'tools/list':
      return result({ tools: TOOLS });
    case 'tools/call': {
      const toolName = typeof params.name === 'string' ? params.name : '';
      const args = (params.arguments ?? {}) as Record<string, unknown>;
      if (toolName === '') return error(-32602, 'tools/call needs a tool name');
      if (!TOOLS.some((t) => t.name === toolName)) return error(-32602, `Unknown tool: ${toolName}`);
      return result(callTool(toolName, args));
    }
    default:
      return error(-32601, `Method not found: ${method}`);
  }
}
