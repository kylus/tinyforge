// GitHub GraphQL v4, the subset gh and github-mcp-server use: a small parser, a schema table that doubles
// as the introspection answer, and an executor over the same operations REST uses (ops.ts).
import { Forge, decodeRepoNodeId, nodeId, parseNodeId, repoNodeId } from './forge.ts';
import {
  ApiError,
  addComment,
  changedFiles,
  createIssue,
  createPull,
  findIssue,
  findPull,
  livePull,
  mergePull,
  mergeable,
  patchIssue,
  treeOfCommit,
} from './ops.ts';
import type { Issue, Pull, Repo } from './repo.ts';

type Json = Record<string, unknown>;

// ---------------------------------------------------------------- parsing

type Value =
  | { k: 'var'; name: string }
  | { k: 'lit'; v: unknown }
  | { k: 'list'; items: Value[] }
  | { k: 'obj'; fields: Record<string, Value> };

interface Field {
  kind: 'field';
  alias: string;
  name: string;
  args: Record<string, Value>;
  directives: Directive[];
  sel: Selection[] | null;
}
interface Spread {
  kind: 'spread';
  name: string;
  directives: Directive[];
}
interface Inline {
  kind: 'inline';
  on: string | null;
  directives: Directive[];
  sel: Selection[];
}
type Selection = Field | Spread | Inline;
interface Directive {
  name: string;
  args: Record<string, Value>;
}
interface Operation {
  type: 'query' | 'mutation' | 'subscription';
  name: string | null;
  vars: { name: string; def: Value | null }[];
  sel: Selection[];
}
interface Document {
  ops: Operation[];
  fragments: Map<string, { on: string; sel: Selection[] }>;
}

class GqlSyntax extends Error {}

function tokenize(src: string): { t: string; v: string }[] {
  const out: { t: string; v: string }[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i] as string;
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',' || c === '﻿') i += 1;
    else if (c === '#') {
      while (i < src.length && src[i] !== '\n') i += 1;
    } else if (c === '.' && src.startsWith('...', i)) {
      out.push({ t: 'p', v: '...' });
      i += 3;
    } else if ('!$&():=@[]{|}'.includes(c)) {
      out.push({ t: 'p', v: c });
      i += 1;
    } else if (c === '"') {
      if (src.startsWith('"""', i)) {
        const end = src.indexOf('"""', i + 3);
        if (end < 0) throw new GqlSyntax('Unterminated block string');
        out.push({ t: 's', v: src.slice(i + 3, end).trim() });
        i = end + 3;
      } else {
        let j = i + 1;
        let text = '';
        while (j < src.length && src[j] !== '"') {
          if (src[j] === '\\') {
            const n = src[j + 1];
            if (n === 'u') {
              text += String.fromCharCode(Number.parseInt(src.slice(j + 2, j + 6), 16));
              j += 6;
              continue;
            }
            text += n === 'n' ? '\n' : n === 't' ? '\t' : n === 'r' ? '\r' : n === 'b' ? '\b' : n === 'f' ? '\f' : (n ?? '');
            j += 2;
          } else text += src[j++];
        }
        if (j >= src.length) throw new GqlSyntax('Unterminated string');
        out.push({ t: 's', v: text });
        i = j + 1;
      }
    } else if (/[-0-9]/.test(c)) {
      const m = /^-?\d+(\.\d+)?([eE][+-]?\d+)?/.exec(src.slice(i));
      if (m === null) throw new GqlSyntax(`Unexpected character "${c}"`);
      out.push({ t: 'n', v: m[0] });
      i += m[0].length;
    } else if (/[A-Za-z_]/.test(c)) {
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i)) as RegExpExecArray;
      out.push({ t: 'w', v: m[0] });
      i += m[0].length;
    } else throw new GqlSyntax(`Unexpected character "${c}"`);
  }
  return out;
}

function parseDocument(src: string): Document {
  const toks = tokenize(src);
  let p = 0;
  const peek = (): { t: string; v: string } | undefined => toks[p];
  const isP = (v: string): boolean => peek()?.t === 'p' && peek()?.v === v;
  const eat = (v: string): void => {
    if (!isP(v)) throw new GqlSyntax(`Expected "${v}", found ${peek() === undefined ? 'end of document' : `"${peek()?.v}"`}`);
    p += 1;
  };
  const name = (): string => {
    const t = peek();
    if (t === undefined || t.t !== 'w') throw new GqlSyntax(`Expected a name, found ${t === undefined ? 'end of document' : `"${t.v}"`}`);
    p += 1;
    return t.v;
  };
  const value = (): Value => {
    const t = peek();
    if (t === undefined) throw new GqlSyntax('Unexpected end of document');
    if (isP('$')) {
      p += 1;
      return { k: 'var', name: name() };
    }
    if (isP('[')) {
      p += 1;
      const items: Value[] = [];
      while (!isP(']')) items.push(value());
      p += 1;
      return { k: 'list', items };
    }
    if (isP('{')) {
      p += 1;
      const fields: Record<string, Value> = {};
      while (!isP('}')) {
        const key = name();
        eat(':');
        fields[key] = value();
      }
      p += 1;
      return { k: 'obj', fields };
    }
    p += 1;
    if (t.t === 's') return { k: 'lit', v: t.v };
    if (t.t === 'n') return { k: 'lit', v: Number(t.v) };
    if (t.t === 'w') return { k: 'lit', v: t.v === 'true' ? true : t.v === 'false' ? false : t.v === 'null' ? null : { enum: t.v } };
    throw new GqlSyntax(`Unexpected "${t.v}"`);
  };
  const args = (): Record<string, Value> => {
    const out: Record<string, Value> = {};
    if (!isP('(')) return out;
    p += 1;
    while (!isP(')')) {
      const key = name();
      eat(':');
      out[key] = value();
    }
    p += 1;
    return out;
  };
  const directives = (): Directive[] => {
    const out: Directive[] = [];
    while (isP('@')) {
      p += 1;
      out.push({ name: name(), args: args() });
    }
    return out;
  };
  const selections = (): Selection[] => {
    eat('{');
    const out: Selection[] = [];
    while (!isP('}')) {
      if (peek() === undefined) throw new GqlSyntax('Expected "}", found end of document');
      if (isP('...')) {
        p += 1;
        if (peek()?.t === 'w' && peek()?.v !== 'on') {
          const n = name();
          out.push({ kind: 'spread', name: n, directives: directives() });
        } else {
          let on: string | null = null;
          if (peek()?.v === 'on') {
            p += 1;
            on = name();
          }
          const d = directives();
          out.push({ kind: 'inline', on, directives: d, sel: selections() });
        }
      } else {
        let first = name();
        let alias = first;
        if (isP(':')) {
          p += 1;
          first = name();
        }
        const a = args();
        const d = directives();
        out.push({ kind: 'field', alias, name: first, args: a, directives: d, sel: isP('{') ? selections() : null });
        alias = first;
      }
    }
    p += 1;
    return out;
  };
  const typeRef = (): void => {
    if (isP('[')) {
      p += 1;
      typeRef();
      eat(']');
    } else name();
    if (isP('!')) p += 1;
  };
  const doc: Document = { ops: [], fragments: new Map() };
  while (p < toks.length) {
    if (isP('{')) {
      doc.ops.push({ type: 'query', name: null, vars: [], sel: selections() });
      continue;
    }
    const kw = name();
    if (kw === 'fragment') {
      const fname = name();
      if (name() !== 'on') throw new GqlSyntax('Expected "on"');
      const on = name();
      directives();
      doc.fragments.set(fname, { on, sel: selections() });
    } else if (kw === 'query' || kw === 'mutation' || kw === 'subscription') {
      let opName: string | null = null;
      if (peek()?.t === 'w') opName = name();
      const vars: Operation['vars'] = [];
      if (isP('(')) {
        p += 1;
        while (!isP(')')) {
          eat('$');
          const vn = name();
          eat(':');
          typeRef();
          let def: Value | null = null;
          if (isP('=')) {
            p += 1;
            def = value();
          }
          directives();
          vars.push({ name: vn, def });
        }
        p += 1;
      }
      directives();
      doc.ops.push({ type: kw, name: opName, vars, sel: selections() });
    } else throw new GqlSyntax(`Unexpected "${kw}"`);
  }
  if (doc.ops.length === 0) throw new GqlSyntax('Unexpected end of document');
  return doc;
}

// ---------------------------------------------------------------- the schema

interface Ctx {
  forge: Forge;
  origin: string;
  vars: Json;
  doc: Document;
}

class GqlError extends Error {
  type: string;
  constructor(message: string, type = 'INTERNAL') {
    super(message);
    this.type = type;
  }
}

type Resolver = (parent: any, args: Json, ctx: Ctx) => unknown;
interface FieldDef {
  type: string;
  resolve?: Resolver;
  args?: string[];
}
interface TypeDef {
  kind: 'OBJECT' | 'ENUM' | 'INPUT_OBJECT' | 'SCALAR' | 'INTERFACE';
  fields?: Record<string, FieldDef>;
  enumValues?: string[];
  implements?: string[];
}

const iso = (s: string | null): string | null => s;

function connection<T>(items: T[], args: Json): { nodes: T[]; edges: { cursor: string; node: T }[]; totalCount: number; pageInfo: Json } {
  const cursorOf = (i: number): string => Buffer.from(`cursor:${i + 1}`).toString('base64');
  let start = 0;
  if (typeof args.after === 'string') {
    const m = /^cursor:(\d+)$/.exec(Buffer.from(args.after, 'base64').toString('utf8'));
    start = m === null ? 0 : Number(m[1]);
  }
  let end = items.length;
  const first = typeof args.first === 'number' ? args.first : undefined;
  if (first !== undefined) end = Math.min(items.length, start + Math.max(0, first));
  let slice = items.slice(start, end);
  let offset = start;
  if (typeof args.last === 'number') {
    const cut = Math.max(0, slice.length - args.last);
    slice = slice.slice(cut);
    offset += cut;
  }
  return {
    nodes: slice,
    edges: slice.map((node, i) => ({ cursor: cursorOf(offset + i), node })),
    totalCount: items.length,
    pageInfo: {
      hasNextPage: offset + slice.length < items.length,
      hasPreviousPage: offset > 0,
      startCursor: slice.length === 0 ? null : cursorOf(offset),
      endCursor: slice.length === 0 ? null : cursorOf(offset + slice.length - 1),
    },
  };
}

const gh = (origin: string, repo: Repo, tail = ''): string => `${origin}/${repo.fullName}${tail}`;
const user = (login: string, ctx: Ctx): Json => ({ __t: 'User', login, forge: ctx.forge });

const issueW = (repo: Repo, issue: Issue): Json => ({ __t: 'Issue', repo, issue });
const pullW = (repo: Repo, pull: Pull): Json => ({ __t: 'PullRequest', repo, pull });

function lookupRepo(ctx: Ctx, owner: unknown, name: unknown): Repo | null {
  if (typeof owner !== 'string' || typeof name !== 'string') throw new GqlError('owner and name are required', 'MISSING_ARGUMENT');
  return ctx.forge.find(owner, name) ?? null;
}

function repoOfId(ctx: Ctx, id: unknown): Repo {
  const n = typeof id === 'string' ? decodeRepoNodeId(id) : undefined;
  const repo = n === undefined ? undefined : ctx.forge.byId(n);
  if (repo === undefined) throw new GqlError(`Could not resolve to a Repository with the id '${String(id)}'.`, 'NOT_FOUND');
  return repo;
}

function issueOfId(ctx: Ctx, id: unknown): { repo: Repo; issue: Issue } {
  const p = typeof id === 'string' ? parseNodeId(id) : undefined;
  const repo = p?.kind === 'I' ? ctx.forge.byId(Number(p.parts[0])) : undefined;
  const issue = repo?.issues.find((i) => i.number === Number(p?.parts[1]));
  if (repo === undefined || issue === undefined) throw new GqlError(`Could not resolve to an Issue with the id '${String(id)}'.`, 'NOT_FOUND');
  return { repo, issue };
}

function pullOfId(ctx: Ctx, id: unknown): { repo: Repo; pull: Pull } {
  const p = typeof id === 'string' ? parseNodeId(id) : undefined;
  const repo = p?.kind === 'PR' ? ctx.forge.byId(Number(p.parts[0])) : undefined;
  const pull = repo?.pulls.find((x) => x.number === Number(p?.parts[1]));
  if (repo === undefined || pull === undefined) throw new GqlError(`Could not resolve to a PullRequest with the id '${String(id)}'.`, 'NOT_FOUND');
  return { repo, pull };
}

const pullState = (p: Pull): string => (p.merged ? 'MERGED' : p.state === 'open' ? 'OPEN' : 'CLOSED');

const SCHEMA: Record<string, TypeDef> = {
  Query: {
    kind: 'OBJECT',
    fields: {
      viewer: { type: 'User!', resolve: (_p, _a, c) => user(c.forge.me().login, c) },
      repository: { type: 'Repository', args: ['owner', 'name'], resolve: (_p, a, c) => {
        const repo = lookupRepo(c, a.owner, a.name);
        return repo === null ? null : { __t: 'Repository', repo };
      } },
      node: { type: 'Node', args: ['id'], resolve: (_p, a, c) => {
        const p = typeof a.id === 'string' ? parseNodeId(a.id) : undefined;
        if (p === undefined) return null;
        try {
          if (p.kind === 'R') return { __t: 'Repository', repo: repoOfId(c, a.id) };
          if (p.kind === 'I') {
            const r = issueOfId(c, a.id);
            return issueW(r.repo, r.issue);
          }
          if (p.kind === 'PR') {
            const r = pullOfId(c, a.id);
            return pullW(r.repo, r.pull);
          }
        } catch {
          return null;
        }
        return null;
      } },
      rateLimit: { type: 'RateLimit', resolve: () => ({ __t: 'RateLimit', limit: 5000, remaining: 5000, used: 0, cost: 1, resetAt: '2033-05-18T03:33:20Z' }) },
    },
  },
  Mutation: {
    kind: 'OBJECT',
    fields: {
      createIssue: { type: 'CreateIssuePayload', args: ['input'], resolve: (_p, a, c) => {
        const input = (a.input ?? {}) as Json;
        const repo = repoOfId(c, input.repositoryId);
        const body: Json = { title: input.title, body: input.body };
        if (Array.isArray(input.labelIds)) body.labels = input.labelIds;
        const issue = wrapOps(() => createIssue(c.forge, repo, body));
        return { __t: 'CreateIssuePayload', issue: issueW(repo, issue) };
      } },
      closeIssue: { type: 'CloseIssuePayload', args: ['input'], resolve: (_p, a, c) => {
        const { repo, issue } = issueOfId(c, ((a.input ?? {}) as Json).issueId);
        patchIssue(repo, issue, { state: 'closed' });
        return { __t: 'CloseIssuePayload', issue: issueW(repo, issue) };
      } },
      reopenIssue: { type: 'ReopenIssuePayload', args: ['input'], resolve: (_p, a, c) => {
        const { repo, issue } = issueOfId(c, ((a.input ?? {}) as Json).issueId);
        patchIssue(repo, issue, { state: 'open' });
        return { __t: 'ReopenIssuePayload', issue: issueW(repo, issue) };
      } },
      createPullRequest: { type: 'CreatePullRequestPayload', args: ['input'], resolve: (_p, a, c) => {
        const input = (a.input ?? {}) as Json;
        const repo = repoOfId(c, input.repositoryId);
        const pull = wrapOps(() => createPull(c.forge, repo, { title: input.title, body: input.body, head: input.headRefName, base: input.baseRefName, draft: input.draft }));
        return { __t: 'CreatePullRequestPayload', pullRequest: pullW(repo, pull) };
      } },
      mergePullRequest: { type: 'MergePullRequestPayload', args: ['input'], resolve: (_p, a, c) => {
        const input = (a.input ?? {}) as Json;
        const { repo, pull } = pullOfId(c, input.pullRequestId);
        wrapOps(() => mergePull(c.forge, repo, pull, { commit_title: input.commitHeadline, commit_message: input.commitBody }));
        return { __t: 'MergePullRequestPayload', pullRequest: pullW(repo, pull) };
      } },
      addComment: { type: 'AddCommentPayload', args: ['input'], resolve: (_p, a, c) => {
        const input = (a.input ?? {}) as Json;
        const target = typeof input.subjectId === 'string' ? parseNodeId(input.subjectId) : undefined;
        if (target?.kind === 'PR') {
          const { repo, pull } = pullOfId(c, input.subjectId);
          const comment = wrapOps(() => addComment(c.forge, pull, { body: input.body }));
          return { __t: 'AddCommentPayload', commentEdge: { __t: 'IssueCommentEdge', node: commentW(repo, pull.number, comment), cursor: 'Y3Vyc29yOjE=' } };
        }
        const { repo, issue } = issueOfId(c, input.subjectId);
        const comment = wrapOps(() => addComment(c.forge, issue, { body: input.body }));
        return { __t: 'AddCommentPayload', commentEdge: { __t: 'IssueCommentEdge', node: commentW(repo, issue.number, comment), cursor: 'Y3Vyc29yOjE=' } };
      } },
    },
  },
  Node: { kind: 'INTERFACE', fields: { id: { type: 'ID!' } } },
  Actor: { kind: 'INTERFACE', fields: { login: { type: 'String!' } } },
  RepositoryOwner: { kind: 'INTERFACE', fields: { login: { type: 'String!' }, id: { type: 'ID!' } } },
  User: {
    kind: 'OBJECT',
    implements: ['Node', 'Actor', 'RepositoryOwner'],
    fields: {
      login: { type: 'String!', resolve: (p) => p.login },
      id: { type: 'ID!', resolve: (p) => `U_${Buffer.from(`04:User${p.forge.me().id}`).toString('base64url')}` },
      databaseId: { type: 'Int', resolve: (p) => p.forge.me().id },
      name: { type: 'String', resolve: (p) => p.forge.me().name },
      email: { type: 'String', resolve: (p) => p.forge.me().email },
      url: { type: 'URI!', resolve: (p, _a, c) => `${c.origin}/${p.login}` },
      avatarUrl: { type: 'URI!', resolve: (p, _a, c) => `${c.origin}/avatars/${p.login}` },
    },
  },
  Repository: {
    kind: 'OBJECT',
    implements: ['Node'],
    fields: {
      id: { type: 'ID!', resolve: (p) => repoNodeId(p.repo.id) },
      databaseId: { type: 'Int', resolve: (p) => p.repo.id },
      name: { type: 'String!', resolve: (p) => p.repo.name },
      nameWithOwner: { type: 'String!', resolve: (p) => p.repo.fullName },
      description: { type: 'String', resolve: (p) => p.repo.description },
      owner: { type: 'RepositoryOwner!', resolve: (p, _a, c) => user(p.repo.owner, c) },
      isPrivate: { type: 'Boolean!', resolve: (p) => p.repo.isPrivate },
      isEmpty: { type: 'Boolean!', resolve: (p) => p.repo.isEmpty() },
      url: { type: 'URI!', resolve: (p, _a, c) => gh(c.origin, p.repo) },
      createdAt: { type: 'DateTime!', resolve: (p) => p.repo.created_at },
      updatedAt: { type: 'DateTime!', resolve: (p) => p.repo.updated_at },
      pushedAt: { type: 'DateTime', resolve: (p) => p.repo.pushed_at },
      defaultBranchRef: { type: 'Ref', resolve: (p) => {
        const sha = p.repo.refs.get(p.repo.headRef());
        return sha === undefined ? null : { __t: 'Ref', name: p.repo.defaultBranch, sha };
      } },
      viewerPermission: { type: 'RepositoryPermission', resolve: () => 'ADMIN' },
      hasIssuesEnabled: { type: 'Boolean!', resolve: () => true },
      hasWikiEnabled: { type: 'Boolean!', resolve: () => false },
      issue: { type: 'Issue', args: ['number'], resolve: (p, a) => {
        const issue = p.repo.issues.find((i: Issue) => i.number === a.number);
        return issue === undefined ? null : issueW(p.repo, issue);
      } },
      issues: { type: 'IssueConnection!', args: ['first', 'last', 'after', 'before', 'states', 'orderBy', 'labels'], resolve: (p, a) => {
        const states = Array.isArray(a.states) ? (a.states as unknown[]).map((s) => String(s).toLowerCase()) : null;
        let list: Issue[] = p.repo.issues.filter((i: Issue) => states === null || states.includes(i.state));
        if (Array.isArray(a.labels)) list = list.filter((i) => (a.labels as string[]).every((l) => i.labels.includes(l)));
        const order = (a.orderBy ?? {}) as Json;
        const field = String(order.field ?? 'CREATED_AT');
        const dir = String(order.direction ?? 'ASC') === 'DESC' ? -1 : 1;
        const key = (i: Issue): string | number => (field === 'COMMENTS' ? i.comments.length : field === 'UPDATED_AT' ? i.updated_at : i.created_at);
        list = [...list].sort((x, y) => {
          const kx = key(x);
          const ky = key(y);
          const c = kx < ky ? -1 : kx > ky ? 1 : 0;
          return c !== 0 ? dir * c : dir * (x.number - y.number);
        });
        const conn = connection(list, a);
        return mapConn(conn, (i) => issueW(p.repo, i));
      } },
      pullRequest: { type: 'PullRequest', args: ['number'], resolve: (p, a) => {
        const pull = p.repo.pulls.find((x: Pull) => x.number === a.number);
        return pull === undefined ? null : pullW(p.repo, pull);
      } },
      pullRequests: { type: 'PullRequestConnection!', args: ['first', 'last', 'after', 'before', 'states', 'headRefName', 'baseRefName', 'orderBy'], resolve: (p, a) => {
        const states = Array.isArray(a.states) ? (a.states as unknown[]).map(String) : null;
        let list: Pull[] = p.repo.pulls.filter((x: Pull) => states === null || states.includes(pullState(x)));
        if (typeof a.headRefName === 'string') list = list.filter((x) => x.head === a.headRefName);
        if (typeof a.baseRefName === 'string') list = list.filter((x) => x.base === a.baseRefName);
        const order = (a.orderBy ?? {}) as Json;
        const dir = String(order.direction ?? 'ASC') === 'DESC' ? -1 : 1;
        list = [...list].sort((x, y) => dir * (x.number - y.number));
        return mapConn(connection(list, a), (x) => pullW(p.repo, x));
      } },
    },
  },
  Ref: {
    kind: 'OBJECT',
    implements: ['Node'],
    fields: {
      id: { type: 'ID!', resolve: (p) => nodeId('REF', p.name) },
      name: { type: 'String!', resolve: (p) => p.name },
      prefix: { type: 'String!', resolve: () => 'refs/heads/' },
      target: { type: 'GitObject', resolve: (p) => ({ __t: 'Commit', oid: p.sha }) },
    },
  },
  GitObject: { kind: 'INTERFACE', fields: { oid: { type: 'GitObjectID!' } } },
  Commit: {
    kind: 'OBJECT',
    implements: ['GitObject'],
    fields: { oid: { type: 'GitObjectID!', resolve: (p) => p.oid }, id: { type: 'ID!', resolve: (p) => nodeId('C', p.oid) } },
  },
  Issue: {
    kind: 'OBJECT',
    implements: ['Node'],
    fields: {
      id: { type: 'ID!', resolve: (p) => nodeId('I', p.repo.id, p.issue.number) },
      databaseId: { type: 'Int', resolve: (p) => p.issue.id },
      number: { type: 'Int!', resolve: (p) => p.issue.number },
      title: { type: 'String!', resolve: (p) => p.issue.title },
      body: { type: 'String!', resolve: (p) => p.issue.body ?? '' },
      state: { type: 'IssueState!', resolve: (p) => p.issue.state.toUpperCase() },
      stateReason: { type: 'String', resolve: (p) => (p.issue.state === 'closed' ? 'COMPLETED' : null) },
      url: { type: 'URI!', resolve: (p, _a, c) => gh(c.origin, p.repo, `/issues/${p.issue.number}`) },
      createdAt: { type: 'DateTime!', resolve: (p) => p.issue.created_at },
      updatedAt: { type: 'DateTime!', resolve: (p) => p.issue.updated_at },
      closedAt: { type: 'DateTime', resolve: (p) => iso(p.issue.closed_at) },
      closed: { type: 'Boolean!', resolve: (p) => p.issue.state === 'closed' },
      author: { type: 'Actor', resolve: (p, _a, c) => user(p.issue.user, c) },
      repository: { type: 'Repository!', resolve: (p) => ({ __t: 'Repository', repo: p.repo }) },
      labels: { type: 'LabelConnection', args: ['first', 'after'], resolve: (p, a) => mapConn(connection(p.issue.labels as string[], a), (n) => ({ __t: 'Label', name: n, repo: p.repo })) },
      comments: { type: 'IssueCommentConnection!', args: ['first', 'after'], resolve: (p, a) => mapConn(connection(p.issue.comments as Issue['comments'], a), (cm) => commentW(p.repo, p.issue.number, cm)) },
    },
  },
  Label: {
    kind: 'OBJECT',
    implements: ['Node'],
    fields: {
      id: { type: 'ID!', resolve: (p) => nodeId('LA', p.repo.id, p.name) },
      name: { type: 'String!', resolve: (p) => p.name },
      color: { type: 'String!', resolve: (p) => p.repo.labels.get(p.name)?.color ?? 'ededed' },
    },
  },
  IssueComment: {
    kind: 'OBJECT',
    implements: ['Node'],
    fields: {
      id: { type: 'ID!', resolve: (p) => nodeId('IC', p.repo.id, p.number, p.comment.id) },
      body: { type: 'String!', resolve: (p) => p.comment.body },
      createdAt: { type: 'DateTime!', resolve: (p) => p.comment.created_at },
      author: { type: 'Actor', resolve: (p, _a, c) => user(p.comment.user, c) },
    },
  },
  PullRequest: {
    kind: 'OBJECT',
    implements: ['Node'],
    fields: {
      id: { type: 'ID!', resolve: (p) => nodeId('PR', p.repo.id, p.pull.number) },
      databaseId: { type: 'Int', resolve: (p) => p.pull.id },
      number: { type: 'Int!', resolve: (p) => p.pull.number },
      title: { type: 'String!', resolve: (p) => p.pull.title },
      body: { type: 'String!', resolve: (p) => p.pull.body ?? '' },
      state: { type: 'PullRequestState!', resolve: (p) => pullState(p.pull) },
      merged: { type: 'Boolean!', resolve: (p) => p.pull.merged },
      closed: { type: 'Boolean!', resolve: (p) => p.pull.state === 'closed' },
      isDraft: { type: 'Boolean!', resolve: (p) => p.pull.draft },
      mergeable: { type: 'MergeableState!', resolve: (p) => (p.pull.merged ? 'UNKNOWN' : mergeable(p.repo, p.pull) ? 'MERGEABLE' : 'CONFLICTING') },
      headRefName: { type: 'String!', resolve: (p) => p.pull.head },
      baseRefName: { type: 'String!', resolve: (p) => p.pull.base },
      headRefOid: { type: 'GitObjectID!', resolve: (p) => livePull(p.repo, p.pull).headSha },
      baseRefOid: { type: 'GitObjectID!', resolve: (p) => livePull(p.repo, p.pull).baseSha },
      mergedAt: { type: 'DateTime', resolve: (p) => p.pull.merged_at },
      createdAt: { type: 'DateTime!', resolve: (p) => p.pull.created_at },
      updatedAt: { type: 'DateTime!', resolve: (p) => p.pull.updated_at },
      closedAt: { type: 'DateTime', resolve: (p) => p.pull.closed_at },
      url: { type: 'URI!', resolve: (p, _a, c) => gh(c.origin, p.repo, `/pull/${p.pull.number}`) },
      author: { type: 'Actor', resolve: (p, _a, c) => user(p.pull.user, c) },
      repository: { type: 'Repository!', resolve: (p) => ({ __t: 'Repository', repo: p.repo }) },
      additions: { type: 'Int!', resolve: (p) => pullFiles(p).reduce((n, f) => n + f.additions, 0) },
      deletions: { type: 'Int!', resolve: (p) => pullFiles(p).reduce((n, f) => n + f.deletions, 0) },
      changedFiles: { type: 'Int!', resolve: (p) => pullFiles(p).length },
      files: { type: 'PullRequestChangedFileConnection', args: ['first', 'after'], resolve: (p, a) => mapConn(connection(pullFiles(p), a), (f) => ({ __t: 'PullRequestChangedFile', f })) },
      comments: { type: 'IssueCommentConnection!', args: ['first', 'after'], resolve: (p, a) => mapConn(connection(p.pull.comments as Pull['comments'], a), (cm) => commentW(p.repo, p.pull.number, cm)) },
    },
  },
  PullRequestChangedFile: {
    kind: 'OBJECT',
    fields: {
      path: { type: 'String!', resolve: (p) => p.f.filename },
      additions: { type: 'Int!', resolve: (p) => p.f.additions },
      deletions: { type: 'Int!', resolve: (p) => p.f.deletions },
      changeType: { type: 'PatchStatus!', resolve: (p) => p.f.status.toUpperCase() },
    },
  },
  RateLimit: {
    kind: 'OBJECT',
    fields: {
      limit: { type: 'Int!', resolve: (p) => p.limit },
      remaining: { type: 'Int!', resolve: (p) => p.remaining },
      used: { type: 'Int!', resolve: (p) => p.used },
      cost: { type: 'Int!', resolve: (p) => p.cost },
      resetAt: { type: 'DateTime!', resolve: (p) => p.resetAt },
    },
  },
  PageInfo: {
    kind: 'OBJECT',
    fields: {
      hasNextPage: { type: 'Boolean!', resolve: (p) => p.hasNextPage },
      hasPreviousPage: { type: 'Boolean!', resolve: (p) => p.hasPreviousPage },
      startCursor: { type: 'String', resolve: (p) => p.startCursor },
      endCursor: { type: 'String', resolve: (p) => p.endCursor },
    },
  },
  CreateIssuePayload: { kind: 'OBJECT', fields: { issue: { type: 'Issue', resolve: (p) => p.issue }, clientMutationId: { type: 'String', resolve: () => null } } },
  CloseIssuePayload: { kind: 'OBJECT', fields: { issue: { type: 'Issue', resolve: (p) => p.issue }, clientMutationId: { type: 'String', resolve: () => null } } },
  ReopenIssuePayload: { kind: 'OBJECT', fields: { issue: { type: 'Issue', resolve: (p) => p.issue }, clientMutationId: { type: 'String', resolve: () => null } } },
  CreatePullRequestPayload: { kind: 'OBJECT', fields: { pullRequest: { type: 'PullRequest', resolve: (p) => p.pullRequest }, clientMutationId: { type: 'String', resolve: () => null } } },
  MergePullRequestPayload: { kind: 'OBJECT', fields: { pullRequest: { type: 'PullRequest', resolve: (p) => p.pullRequest }, clientMutationId: { type: 'String', resolve: () => null } } },
  AddCommentPayload: { kind: 'OBJECT', fields: { commentEdge: { type: 'IssueCommentEdge', resolve: (p) => p.commentEdge }, clientMutationId: { type: 'String', resolve: () => null } } },
  IssueCommentEdge: { kind: 'OBJECT', fields: { node: { type: 'IssueComment', resolve: (p) => p.node }, cursor: { type: 'String!', resolve: (p) => p.cursor } } },
  IssueState: { kind: 'ENUM', enumValues: ['OPEN', 'CLOSED'] },
  PullRequestState: { kind: 'ENUM', enumValues: ['OPEN', 'CLOSED', 'MERGED'] },
  MergeableState: { kind: 'ENUM', enumValues: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'] },
  PatchStatus: { kind: 'ENUM', enumValues: ['ADDED', 'DELETED', 'RENAMED', 'COPIED', 'MODIFIED', 'CHANGED'] },
  RepositoryPermission: { kind: 'ENUM', enumValues: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'] },
  OrderDirection: { kind: 'ENUM', enumValues: ['ASC', 'DESC'] },
  IssueOrderField: { kind: 'ENUM', enumValues: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'] },
  SearchType: { kind: 'ENUM', enumValues: ['ISSUE', 'ISSUE_ADVANCED', 'REPOSITORY', 'USER', 'DISCUSSION'] },
  String: { kind: 'SCALAR' },
  Int: { kind: 'SCALAR' },
  Float: { kind: 'SCALAR' },
  Boolean: { kind: 'SCALAR' },
  ID: { kind: 'SCALAR' },
  URI: { kind: 'SCALAR' },
  DateTime: { kind: 'SCALAR' },
  GitObjectID: { kind: 'SCALAR' },
};

// The connection types share one shape.
for (const [name, node] of [
  ['IssueConnection', 'Issue'],
  ['PullRequestConnection', 'PullRequest'],
  ['LabelConnection', 'Label'],
  ['IssueCommentConnection', 'IssueComment'],
  ['PullRequestChangedFileConnection', 'PullRequestChangedFile'],
] as const) {
  SCHEMA[name] = {
    kind: 'OBJECT',
    fields: {
      nodes: { type: `[${node}]`, resolve: (p) => p.nodes },
      edges: { type: `[${name.replace('Connection', 'Edge')}]`, resolve: (p) => p.edges },
      totalCount: { type: 'Int!', resolve: (p) => p.totalCount },
      pageInfo: { type: 'PageInfo!', resolve: (p) => p.pageInfo },
    },
  };
  SCHEMA[name.replace('Connection', 'Edge')] = {
    kind: 'OBJECT',
    fields: { node: { type: node, resolve: (p) => p.node }, cursor: { type: 'String!', resolve: (p) => p.cursor } },
  };
}
SCHEMA.IssueCommentEdge = { kind: 'OBJECT', fields: { node: { type: 'IssueComment', resolve: (p) => p.node }, cursor: { type: 'String!', resolve: (p) => p.cursor } } };

function commentW(repo: Repo, number: number, comment: Issue['comments'][number]): Json {
  return { __t: 'IssueComment', repo, number, comment };
}

function pullFiles(p: { repo: Repo; pull: Pull }): ReturnType<typeof changedFiles> {
  livePull(p.repo, p.pull);
  return changedFiles(p.repo, treeOfCommit(p.repo, p.repo.mergeBase(p.pull.baseSha, p.pull.headSha)), treeOfCommit(p.repo, p.pull.headSha));
}

function mapConn<T, U>(c: ReturnType<typeof connection<T>>, f: (t: T) => U): Json {
  return { nodes: c.nodes.map(f), edges: c.edges.map((e) => ({ cursor: e.cursor, node: f(e.node) })), totalCount: c.totalCount, pageInfo: c.pageInfo };
}

/** Run an ops.ts call and turn its ApiError into a GraphQL error. */
function wrapOps<T>(fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    if (err instanceof ApiError) throw new GqlError(err.message, err.status === 404 ? 'NOT_FOUND' : 'UNPROCESSABLE');
    throw err;
  }
}

// ---------------------------------------------------------------- introspection

function typeRef(t: string): Json {
  if (t.endsWith('!')) return { kind: 'NON_NULL', name: null, ofType: typeRef(t.slice(0, -1)) };
  if (t.startsWith('[')) return { kind: 'LIST', name: null, ofType: typeRef(t.slice(1, -1)) };
  return { kind: SCHEMA[t]?.kind ?? 'OBJECT', name: t, ofType: null };
}

function introspectType(name: string): Json | null {
  const t = SCHEMA[name];
  if (t === undefined) return null;
  return {
    __t: '__Type',
    kind: t.kind,
    name,
    description: null,
    fields: t.fields === undefined ? null : Object.entries(t.fields).map(([n, f]) => ({ __t: '__Field', name: n, description: null, type: typeRef(f.type), args: (f.args ?? []).map((a) => ({ name: a, description: null, type: typeRef('String'), defaultValue: null })), isDeprecated: false, deprecationReason: null })),
    enumValues: t.enumValues === undefined ? null : t.enumValues.map((v) => ({ name: v, description: null, isDeprecated: false, deprecationReason: null })),
    interfaces: t.kind === 'OBJECT' ? (t.implements ?? []).map((i) => typeRef(i)) : null,
    possibleTypes: t.kind === 'INTERFACE' ? Object.entries(SCHEMA).filter(([, d]) => d.implements?.includes(name)).map(([n]) => typeRef(n)) : null,
    inputFields: null,
    ofType: null,
  };
}

// ---------------------------------------------------------------- execution

interface Out {
  data?: Json | null;
  errors?: Json[];
}

class Validation extends Error {}

function typeNameOf(t: string): string {
  return t.replace(/[[\]!]/g, '');
}

function valueOf(v: Value, ctx: Ctx): unknown {
  switch (v.k) {
    case 'var':
      return ctx.vars[v.name];
    case 'list':
      return v.items.map((i) => valueOf(i, ctx));
    case 'obj':
      return Object.fromEntries(Object.entries(v.fields).map(([k, x]) => [k, valueOf(x, ctx)]));
    default: {
      const lit = v.v;
      return typeof lit === 'object' && lit !== null && 'enum' in lit ? (lit as { enum: string }).enum : lit;
    }
  }
}

function skipped(directives: Directive[], ctx: Ctx): boolean {
  for (const d of directives) {
    const flag = d.args.if === undefined ? true : valueOf(d.args.if, ctx);
    if (d.name === 'skip' && flag === true) return true;
    if (d.name === 'include' && flag === false) return true;
  }
  return false;
}

function fieldDefOf(typeName: string, field: string): FieldDef | undefined {
  if (field === '__typename') return { type: 'String!' };
  const t = SCHEMA[typeName];
  return t?.fields?.[field];
}

/** Check a selection set against the schema before anything runs: an unknown field fails the whole request. */
function validate(sel: Selection[], typeName: string, ctx: Ctx, seen: Set<string>): void {
  for (const s of sel) {
    if (s.kind === 'inline') {
      validate(s.sel, s.on ?? typeName, ctx, seen);
    } else if (s.kind === 'spread') {
      const frag = ctx.doc.fragments.get(s.name);
      if (frag === undefined) throw new Validation(`Unknown fragment "${s.name}".`);
      if (!seen.has(s.name)) {
        seen.add(s.name);
        validate(frag.sel, frag.on, ctx, seen);
      }
    } else {
      if (typeName === 'Query' && (s.name === '__type' || s.name === '__schema')) continue;
      if (typeName.startsWith('__') || typeName === 'Node' && s.name !== 'id' && s.name !== '__typename') {
        // Interface fields are checked on the concrete type's fragments.
      }
      const def = fieldDefOf(typeName, s.name);
      if (def === undefined) {
        if (SCHEMA[typeName]?.kind === 'INTERFACE' || typeName.startsWith('__')) continue;
        throw new Validation(`Field '${s.name}' doesn't exist on type '${typeName}'`);
      }
      const inner = typeNameOf(def.type);
      if (s.sel !== null) {
        if (SCHEMA[inner]?.kind === 'SCALAR' || SCHEMA[inner]?.kind === 'ENUM') throw new Validation(`Selections can't be made on scalars (field '${s.name}' returns ${inner} but has selections)`);
        validate(s.sel, inner, ctx, seen);
      } else if (SCHEMA[inner]?.kind === 'OBJECT' || SCHEMA[inner]?.kind === 'INTERFACE') {
        throw new Validation(`Field '${s.name}' of type '${inner}' must have a selection of subfields`);
      }
    }
  }
}

function collect(sel: Selection[], runtime: string, ctx: Ctx, into: Map<string, Field[]>): void {
  for (const s of sel) {
    if (skipped(s.directives, ctx)) continue;
    if (s.kind === 'field') {
      const list = into.get(s.alias);
      if (list === undefined) into.set(s.alias, [s]);
      else list.push(s);
    } else if (s.kind === 'inline') {
      if (s.on === null || applies(s.on, runtime)) collect(s.sel, runtime, ctx, into);
    } else {
      const frag = ctx.doc.fragments.get(s.name);
      if (frag !== undefined && applies(frag.on, runtime)) collect(frag.sel, runtime, ctx, into);
    }
  }
}

function applies(cond: string, runtime: string): boolean {
  return cond === runtime || (SCHEMA[runtime]?.implements ?? []).includes(cond);
}

function execObject(sel: Selection[], parent: any, typeName: string, ctx: Ctx, path: (string | number)[], errors: Json[]): Json {
  const runtime = typeof parent?.__t === 'string' ? parent.__t : typeName;
  const fields = new Map<string, Field[]>();
  collect(sel, runtime, ctx, fields);
  const out: Json = {};
  for (const [alias, group] of fields) {
    const f = group[0] as Field;
    if (f.name === '__typename') {
      out[alias] = runtime;
      continue;
    }
    if (f.name === '__type' && typeName === 'Query') {
      const t = introspectType(String(valueOf(f.args.name as Value, ctx)));
      out[alias] = t === null || f.sel === null ? null : execObject(group.flatMap((g) => g.sel ?? []), t, '__Type', ctx, [...path, alias], errors);
      continue;
    }
    if (f.name === '__schema' && typeName === 'Query') {
      const schema = { __t: '__Schema', queryType: { name: 'Query' }, mutationType: { name: 'Mutation' }, types: Object.keys(SCHEMA).map((n) => introspectType(n)) };
      out[alias] = execObject(group.flatMap((g) => g.sel ?? []), schema, '__Schema', ctx, [...path, alias], errors);
      continue;
    }
    if (typeName.startsWith('__') || parent?.__t?.startsWith?.('__')) {
      out[alias] = completeIntrospection(f, parent, ctx, [...path, alias], errors);
      continue;
    }
    const def = SCHEMA[runtime]?.fields?.[f.name] ?? SCHEMA[typeName]?.fields?.[f.name];
    if (def === undefined || def.resolve === undefined) {
      out[alias] = null;
      continue;
    }
    const args: Json = {};
    for (const [k, v] of Object.entries(f.args)) args[k] = valueOf(v, ctx);
    try {
      const raw = def.resolve(parent, args, ctx);
      out[alias] = complete(raw, def.type, group.flatMap((g) => g.sel ?? []), ctx, [...path, alias], errors);
    } catch (err) {
      if (err instanceof GqlError) errors.push({ type: err.type, path: [...path, alias], message: err.message });
      else errors.push({ path: [...path, alias], message: err instanceof Error ? err.message : 'Internal error' });
      out[alias] = null;
    }
  }
  return out;
}

function completeIntrospection(f: Field, parent: any, ctx: Ctx, path: (string | number)[], errors: Json[]): unknown {
  const raw = parent[f.name];
  const finish = (v: unknown): unknown => {
    if (v === null || v === undefined) return null;
    if (Array.isArray(v)) return v.map(finish);
    if (typeof v === 'object') return f.sel === null ? v : execObject(f.sel, v, '__x', ctx, path, errors);
    return v;
  };
  return finish(raw);
}

function complete(value: unknown, type: string, sel: Selection[], ctx: Ctx, path: (string | number)[], errors: Json[]): unknown {
  if (value === null || value === undefined) return null;
  const t = type.endsWith('!') ? type.slice(0, -1) : type;
  if (t.startsWith('[')) {
    const inner = t.slice(1, -1);
    return (value as unknown[]).map((v, i) => complete(v, inner, sel, ctx, [...path, i], errors));
  }
  const def = SCHEMA[t];
  if (def === undefined || def.kind === 'SCALAR' || def.kind === 'ENUM') return value;
  return execObject(sel, value, t, ctx, path, errors);
}

export function runDocument(forge: Forge, origin: string, query: string, variables: Json, operationName: string | null): Out {
  let doc: Document;
  try {
    doc = parseDocument(query);
  } catch (err) {
    return { errors: [{ message: `Parse error: ${err instanceof Error ? err.message : 'invalid document'}` }] };
  }
  const op = operationName === null ? doc.ops[0] : doc.ops.find((o) => o.name === operationName);
  if (op === undefined) return { errors: [{ message: 'Unknown operation named "' + String(operationName) + '".' }] };
  if (operationName === null && doc.ops.length > 1) return { errors: [{ message: 'An operation name is required when a document holds more than one operation.' }] };
  const vars: Json = { ...variables };
  const ctx: Ctx = { forge, origin, vars, doc };
  for (const v of op.vars) if (vars[v.name] === undefined && v.def !== null) vars[v.name] = valueOf(v.def, ctx);
  const root = op.type === 'mutation' ? 'Mutation' : 'Query';
  try {
    validate(op.sel, root, ctx, new Set());
  } catch (err) {
    if (err instanceof Validation) return { errors: [{ message: err.message, locations: [{ line: 1, column: 1 }] }] };
    throw err;
  }
  const errors: Json[] = [];
  const data = execObject(op.sel, { __t: root }, root, ctx, [], errors);
  return errors.length > 0 ? { data, errors } : { data };
}

export function handleGraphql(forge: Forge, body: unknown, origin: string): unknown {
  const one = (req: unknown): Out => {
    if (typeof req !== 'object' || req === null || Array.isArray(req)) return { errors: [{ message: 'A query attribute must be specified and must be a string.' }] };
    const r = req as Json;
    if (typeof r.query !== 'string') return { errors: [{ message: 'A query attribute must be specified and must be a string.' }] };
    const vars = typeof r.variables === 'object' && r.variables !== null && !Array.isArray(r.variables) ? (r.variables as Json) : {};
    return runDocument(forge, origin, r.query, vars, typeof r.operationName === 'string' ? r.operationName : null);
  };
  if (Array.isArray(body)) return body.map(one);
  return one(body);
}
