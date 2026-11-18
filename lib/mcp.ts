// Model Context Protocol over streamable HTTP, JSON-RPC 2.0: server/discover, initialize, ping, and the
// forge's tools. Every tool is a thin call into the REST handler, so what an agent does over MCP and what
// REST then shows are the same objects by construction.
import { Forge } from './forge.ts';
import { ApiError } from './ops.ts';
import { handleRest, type RestRequest } from './rest.ts';

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

const REVISIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const SERVER = { name: 'tinyforge', version: '1.0.0' };

interface Tool {
  name: string;
  description: string;
  properties: Record<string, Json>;
  required: string[];
  run: (a: Json, call: (req: Omit<RestRequest, 'origin' | 'path' | 'query'> & { query?: Record<string, string> }) => unknown) => unknown;
}

const s = (description: string): Json => ({ type: 'string', description });
const repoProps = { owner: s('Repository owner (the account login)'), repo: s('Repository name') };

const TOOLS: Tool[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository for the authenticated account.',
    properties: { name: s('Repository name'), description: s('Short description'), private: { type: 'boolean', description: 'Whether the repository is private' } },
    required: ['name'],
    run: (a, call) => call({ method: 'POST', segs: ['user', 'repos'], body: { name: a.name, description: a.description, private: a.private } }),
  },
  {
    name: 'get_repo',
    description: 'Get a repository: its name, owner, default branch and visibility.',
    properties: repoProps,
    required: ['owner', 'repo'],
    run: (a, call) => call({ method: 'GET', segs: ['repos', String(a.owner), String(a.repo)], body: undefined }),
  },
  {
    name: 'create_issue',
    description: 'Open a new issue in a repository.',
    properties: { ...repoProps, title: s('Issue title'), body: s('Issue body'), labels: { type: 'array', items: { type: 'string' }, description: 'Existing label names' } },
    required: ['owner', 'repo', 'title'],
    run: (a, call) => call({ method: 'POST', segs: ['repos', String(a.owner), String(a.repo), 'issues'], body: { title: a.title, body: a.body, labels: a.labels } }),
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository, newest first, filtered by state (open, closed or all).',
    properties: { ...repoProps, state: { type: 'string', enum: ['open', 'closed', 'all'], description: 'Issue state filter' } },
    required: ['owner', 'repo'],
    run: (a, call) => call({ method: 'GET', segs: ['repos', String(a.owner), String(a.repo), 'issues'], body: undefined, query: a.state === undefined ? {} : { state: String(a.state) } }),
  },
  {
    name: 'get_issue',
    description: 'Read one issue by number.',
    properties: { ...repoProps, issue_number: { type: 'integer', description: 'Issue number' } },
    required: ['owner', 'repo', 'issue_number'],
    run: (a, call) => call({ method: 'GET', segs: ['repos', String(a.owner), String(a.repo), 'issues', String(a.issue_number)], body: undefined }),
  },
  {
    name: 'update_issue',
    description: 'Change the title, body or state (open or closed) of an issue.',
    properties: { ...repoProps, issue_number: { type: 'integer', description: 'Issue number' }, title: s('New title'), body: s('New body'), state: { type: 'string', enum: ['open', 'closed'], description: 'New state' } },
    required: ['owner', 'repo', 'issue_number'],
    run: (a, call) => call({ method: 'PATCH', segs: ['repos', String(a.owner), String(a.repo), 'issues', String(a.issue_number)], body: { title: a.title, body: a.body, state: a.state } }),
  },
  {
    name: 'add_issue_comment',
    description: 'Comment on an issue or pull request.',
    properties: { ...repoProps, issue_number: { type: 'integer', description: 'Issue or pull request number' }, body: s('Comment text') },
    required: ['owner', 'repo', 'issue_number', 'body'],
    run: (a, call) => call({ method: 'POST', segs: ['repos', String(a.owner), String(a.repo), 'issues', String(a.issue_number), 'comments'], body: { body: a.body } }),
  },
  {
    name: 'create_branch',
    description: 'Create a branch from another branch (default: the default branch).',
    properties: { ...repoProps, branch: s('New branch name'), from_branch: s('Branch to start from') },
    required: ['owner', 'repo', 'branch'],
    run: (a, call) => {
      const base = a.from_branch === undefined ? undefined : String(a.from_branch);
      const from = base ?? (call({ method: 'GET', segs: ['repos', String(a.owner), String(a.repo)], body: undefined }) as Json).default_branch;
      const ref = call({ method: 'GET', segs: ['repos', String(a.owner), String(a.repo), 'git', 'ref', 'heads', String(from)], body: undefined }) as Json;
      return call({ method: 'POST', segs: ['repos', String(a.owner), String(a.repo), 'git', 'refs'], body: { ref: `refs/heads/${String(a.branch)}`, sha: (ref.object as Json).sha } });
    },
  },
  {
    name: 'list_branches',
    description: 'List the branches of a repository.',
    properties: repoProps,
    required: ['owner', 'repo'],
    run: (a, call) => call({ method: 'GET', segs: ['repos', String(a.owner), String(a.repo), 'branches'], body: undefined }),
  },
  {
    name: 'get_file_contents',
    description: 'Read a file or list a directory of a repository at a branch or commit.',
    properties: { ...repoProps, path: s('File or directory path'), ref: s('Branch, tag or commit') },
    required: ['owner', 'repo', 'path'],
    run: (a, call) => call({ method: 'GET', segs: ['repos', String(a.owner), String(a.repo), 'contents', ...String(a.path).split('/').filter((x) => x !== '')], body: undefined, query: a.ref === undefined ? {} : { ref: String(a.ref) } }),
  },
  {
    name: 'create_or_update_file',
    description: 'Create or update one file with a commit (the content is plain text).',
    properties: { ...repoProps, path: s('File path'), content: s('File content'), message: s('Commit message'), branch: s('Branch to commit to'), sha: s('Blob sha of the file being replaced') },
    required: ['owner', 'repo', 'path', 'content', 'message'],
    run: (a, call) => call({ method: 'PUT', segs: ['repos', String(a.owner), String(a.repo), 'contents', ...String(a.path).split('/').filter((x) => x !== '')], body: { message: a.message, content: Buffer.from(String(a.content)).toString('base64'), branch: a.branch, sha: a.sha } }),
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    properties: { ...repoProps, title: s('Pull request title'), head: s('Head branch'), base: s('Base branch'), body: s('Pull request body'), draft: { type: 'boolean', description: 'Open as a draft' } },
    required: ['owner', 'repo', 'title', 'head', 'base'],
    run: (a, call) => call({ method: 'POST', segs: ['repos', String(a.owner), String(a.repo), 'pulls'], body: { title: a.title, head: a.head, base: a.base, body: a.body, draft: a.draft } }),
  },
  {
    name: 'get_pull_request',
    description: 'Read one pull request by number.',
    properties: { ...repoProps, pull_number: { type: 'integer', description: 'Pull request number' } },
    required: ['owner', 'repo', 'pull_number'],
    run: (a, call) => call({ method: 'GET', segs: ['repos', String(a.owner), String(a.repo), 'pulls', String(a.pull_number)], body: undefined }),
  },
  {
    name: 'list_pull_requests',
    description: 'List the pull requests of a repository by state (open, closed or all).',
    properties: { ...repoProps, state: { type: 'string', enum: ['open', 'closed', 'all'], description: 'State filter' } },
    required: ['owner', 'repo'],
    run: (a, call) => call({ method: 'GET', segs: ['repos', String(a.owner), String(a.repo), 'pulls'], body: undefined, query: a.state === undefined ? {} : { state: String(a.state) } }),
  },
  {
    name: 'merge_pull_request',
    description: 'Merge an open pull request into its base branch.',
    properties: { ...repoProps, pull_number: { type: 'integer', description: 'Pull request number' }, commit_title: s('Merge commit title'), commit_message: s('Merge commit message'), merge_method: { type: 'string', enum: ['merge', 'squash', 'rebase'], description: 'How to merge' } },
    required: ['owner', 'repo', 'pull_number'],
    run: (a, call) => call({ method: 'PUT', segs: ['repos', String(a.owner), String(a.repo), 'pulls', String(a.pull_number), 'merge'], body: { commit_title: a.commit_title, commit_message: a.commit_message, merge_method: a.merge_method } }),
  },
];

/** The tool list, built once so every tools/list answer is the same bytes. */
const TOOL_LIST = TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: { type: 'object', properties: t.properties, required: t.required } }));

function rpcError(id: unknown, code: number, message: string): Json {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

function callTool(forge: Forge, origin: string, params: unknown): { result?: Json; error?: { code: number; message: string } } {
  if (!isObj(params) || typeof params.name !== 'string') return { error: { code: -32602, message: 'Invalid params: a tool name is required' } };
  const tool = TOOLS.find((t) => t.name === params.name);
  if (tool === undefined) return { error: { code: -32602, message: `Unknown tool: ${params.name}` } };
  const args = isObj(params.arguments) ? params.arguments : {};
  for (const key of tool.required) {
    const v = args[key];
    if (v === undefined || v === null || v === '') return { error: { code: -32602, message: `Invalid params: missing required argument "${key}"` } };
  }
  for (const [key, spec] of Object.entries(tool.properties)) {
    const v = args[key];
    if (v === undefined || v === null) continue;
    const t = spec.type;
    const okType = t === 'string' ? typeof v === 'string' : t === 'boolean' ? typeof v === 'boolean' : t === 'integer' ? Number.isInteger(typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : v) : t === 'array' ? Array.isArray(v) : true;
    if (!okType) return { error: { code: -32602, message: `Invalid params: argument "${key}" must be of type ${String(t)}` } };
  }
  const call = (r: Omit<RestRequest, 'origin' | 'path' | 'query'> & { query?: Record<string, string> }): unknown => {
    const path = `/api/v3/${r.segs.map(encodeURIComponent).join('/')}`;
    const res = handleRest(forge, { ...r, query: new URLSearchParams(r.query ?? {}), origin, path });
    return res.body;
  };
  try {
    const out = tool.run(args, call);
    return { result: { content: [{ type: 'text', text: JSON.stringify(out) }], structuredContent: Array.isArray(out) ? { items: out } : out, isError: false } };
  } catch (err) {
    if (err instanceof ApiError) return { result: { content: [{ type: 'text', text: JSON.stringify({ message: err.message, status: err.status, errors: err.errors }) }], isError: true } };
    throw err;
  }
}

function handleOne(forge: Forge, origin: string, msg: unknown): Json | undefined {
  if (!isObj(msg) || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') return rpcError(isObj(msg) ? msg.id : null, -32600, 'Invalid Request');
  const hasId = 'id' in msg && msg.id !== undefined;
  const id = msg.id;
  if (!hasId) return undefined; // a notification: nothing comes back
  const ok = (result: unknown): Json => ({ jsonrpc: '2.0', id, result });
  switch (msg.method) {
    case 'server/discover':
      return ok({ supportedVersions: REVISIONS, serverInfo: SERVER, capabilities: { tools: { listChanged: false } }, instructions: 'A GitHub-compatible forge: repositories, issues and pull requests.' });
    case 'initialize': {
      const wanted = isObj(msg.params) && typeof msg.params.protocolVersion === 'string' ? msg.params.protocolVersion : '';
      return ok({ protocolVersion: REVISIONS.includes(wanted) ? wanted : REVISIONS[1], capabilities: { tools: { listChanged: false } }, serverInfo: SERVER, instructions: 'A GitHub-compatible forge: repositories, issues and pull requests.' });
    }
    case 'ping':
      return ok({});
    case 'tools/list':
      return ok({ tools: TOOL_LIST });
    case 'tools/call': {
      const r = callTool(forge, origin, msg.params);
      return r.error === undefined ? ok(r.result) : rpcError(id, r.error.code, r.error.message);
    }
    case 'resources/list':
      return ok({ resources: [] });
    case 'prompts/list':
      return ok({ prompts: [] });
    default:
      return rpcError(id, -32601, `Method not found: ${msg.method}`);
  }
}

export function handleMcp(forge: Forge, method: string, body: unknown, origin: string, _headers: Record<string, string>): { status: number; body?: unknown; headers?: Record<string, string> } {
  if (method === 'GET' || method === 'DELETE') return { status: 405, body: { message: 'Method Not Allowed' }, headers: { allow: 'POST' } };
  if (method !== 'POST') return { status: 405, body: { message: 'Method Not Allowed' }, headers: { allow: 'POST' } };
  if (Array.isArray(body)) {
    const out = body.map((m) => handleOne(forge, origin, m)).filter((x): x is Json => x !== undefined);
    return out.length === 0 ? { status: 202 } : { status: 200, body: out };
  }
  const r = handleOne(forge, origin, body);
  return r === undefined ? { status: 202 } : { status: 200, body: r };
}
