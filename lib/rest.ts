// GitHub REST v3 under /api/v3: routing and the JSON shapes. The work itself is in ops.ts.
import { parseCommit, parseTag } from './git.ts';
import { Forge, nodeId, repoNodeId } from './forge.ts';
import {
  ApiError,
  addComment,
  changedFiles,
  cleanMessage,
  commitAt,
  createIssue,
  createLabel,
  createPull,
  createRepo,
  findIssue,
  findPull,
  invalid,
  isoOfIdent,
  livePull,
  mergePull,
  mergeable,
  need,
  patchIssue,
  patchPull,
  str,
  treeOfCommit,
  writeContent,
} from './ops.ts';
import type { Issue, Pull, Repo } from './repo.ts';

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

export interface RestRequest {
  method: string;
  segs: string[];
  query: URLSearchParams;
  body: unknown;
  origin: string;
  path: string;
}

export interface RestResponse {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}

// ---------------------------------------------------------------- shapes

export function userJson(forge: Forge, origin: string, login?: string): Json {
  const me = forge.me();
  const l = login ?? me.login;
  return {
    login: l,
    id: me.id,
    node_id: `U_${Buffer.from(`04:User${me.id}`).toString('base64url')}`,
    avatar_url: `${origin}/avatars/${l}`,
    gravatar_id: '',
    url: `${origin}/api/v3/users/${l}`,
    html_url: `${origin}/${l}`,
    type: 'User',
    site_admin: false,
    name: me.name,
    email: me.email,
  };
}

export function repoJson(forge: Forge, repo: Repo, origin: string): Json {
  const api = `${origin}/api/v3/repos/${repo.fullName}`;
  return {
    id: repo.id,
    node_id: repoNodeId(repo.id),
    name: repo.name,
    full_name: repo.fullName,
    private: repo.isPrivate,
    visibility: repo.isPrivate ? 'private' : 'public',
    owner: userJson(forge, origin, repo.owner),
    html_url: `${origin}/${repo.fullName}`,
    description: repo.description,
    fork: false,
    url: api,
    clone_url: `${origin}/${repo.fullName}.git`,
    git_url: `git://${new URL(origin).host}/${repo.fullName}.git`,
    ssh_url: `git@${new URL(origin).host}:${repo.fullName}.git`,
    default_branch: repo.defaultBranch,
    created_at: repo.created_at,
    updated_at: repo.updated_at,
    pushed_at: repo.pushed_at,
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    forks_count: 0,
    open_issues_count: repo.issues.filter((i) => i.state === 'open').length + repo.pulls.filter((p) => p.state === 'open').length,
    has_issues: true,
    has_wiki: false,
    archived: false,
    disabled: false,
    language: null,
    permissions: { admin: true, maintain: true, push: true, triage: true, pull: true },
  };
}

function labelJson(repo: Repo, origin: string, name: string): Json {
  const l = repo.labels.get(name);
  return {
    id: l?.id ?? 0,
    node_id: `LA_${l?.id ?? 0}`,
    url: `${origin}/api/v3/repos/${repo.fullName}/labels/${encodeURIComponent(name)}`,
    name,
    color: l?.color ?? 'ededed',
    default: false,
    description: l?.description ?? null,
  };
}

export function issueJson(forge: Forge, repo: Repo, i: Issue, origin: string): Json {
  const api = `${origin}/api/v3/repos/${repo.fullName}`;
  return {
    id: i.id,
    node_id: nodeId('I', repo.id, i.number),
    url: `${api}/issues/${i.number}`,
    repository_url: api,
    labels_url: `${api}/issues/${i.number}/labels{/name}`,
    comments_url: `${api}/issues/${i.number}/comments`,
    html_url: `${origin}/${repo.fullName}/issues/${i.number}`,
    number: i.number,
    title: i.title,
    user: userJson(forge, origin, i.user),
    labels: i.labels.map((n) => labelJson(repo, origin, n)),
    state: i.state,
    state_reason: i.state === 'closed' ? 'completed' : null,
    locked: false,
    assignee: null,
    assignees: [],
    milestone: null,
    comments: i.comments.length,
    created_at: i.created_at,
    updated_at: i.updated_at,
    closed_at: i.closed_at,
    author_association: 'OWNER',
    body: i.body,
  };
}

function commentJson(forge: Forge, repo: Repo, number: number, c: Issue['comments'][number], origin: string): Json {
  const api = `${origin}/api/v3/repos/${repo.fullName}`;
  return {
    id: c.id,
    node_id: nodeId('IC', repo.id, number, c.id),
    url: `${api}/issues/comments/${c.id}`,
    html_url: `${origin}/${repo.fullName}/issues/${number}#issuecomment-${c.id}`,
    body: c.body,
    user: userJson(forge, origin, c.user),
    created_at: c.created_at,
    updated_at: c.updated_at,
    issue_url: `${api}/issues/${number}`,
    author_association: 'OWNER',
  };
}

function identJson(line: string): Json {
  const m = /^(.*?) <([^>]*)>/.exec(line);
  return { name: m?.[1] ?? '', email: m?.[2] ?? '', date: isoOfIdent(line) };
}

export function commitJson(forge: Forge, repo: Repo, sha: string, origin: string): Json {
  const info = parseCommit(repo.store.get(sha)?.data ?? Buffer.alloc(0));
  const api = `${origin}/api/v3/repos/${repo.fullName}`;
  return {
    sha,
    node_id: `C_${sha}`,
    commit: {
      author: identJson(info.author),
      committer: identJson(info.committer),
      message: cleanMessage(info.message),
      tree: { sha: info.tree, url: `${api}/git/trees/${info.tree}` },
      url: `${api}/git/commits/${sha}`,
      comment_count: 0,
      verification: { verified: false, reason: 'unsigned', signature: null, payload: null },
    },
    url: `${api}/commits/${sha}`,
    html_url: `${origin}/${repo.fullName}/commit/${sha}`,
    comments_url: `${api}/commits/${sha}/comments`,
    author: null,
    committer: null,
    parents: info.parents.map((p) => ({ sha: p, url: `${api}/commits/${p}`, html_url: `${origin}/${repo.fullName}/commit/${p}` })),
  };
}

export function pullJson(forge: Forge, repo: Repo, p: Pull, origin: string): Json {
  livePull(repo, p);
  const api = `${origin}/api/v3/repos/${repo.fullName}`;
  const can = p.state === 'open' ? mergeable(repo, p) : null;
  const files = changedFiles(repo, treeOfCommit(repo, repo.mergeBase(p.baseSha, p.headSha)), treeOfCommit(repo, p.headSha));
  const repoObj = repoJson(forge, repo, origin);
  const side = (ref: string, sha: string): Json => ({ label: `${repo.owner}:${ref}`, ref, sha, user: userJson(forge, origin, repo.owner), repo: repoObj });
  return {
    id: p.id,
    node_id: nodeId('PR', repo.id, p.number),
    url: `${api}/pulls/${p.number}`,
    html_url: `${origin}/${repo.fullName}/pull/${p.number}`,
    diff_url: `${origin}/${repo.fullName}/pull/${p.number}.diff`,
    patch_url: `${origin}/${repo.fullName}/pull/${p.number}.patch`,
    issue_url: `${api}/issues/${p.number}`,
    commits_url: `${api}/pulls/${p.number}/commits`,
    comments_url: `${api}/issues/${p.number}/comments`,
    number: p.number,
    state: p.state,
    locked: false,
    title: p.title,
    user: userJson(forge, origin, p.user),
    body: p.body,
    labels: [],
    created_at: p.created_at,
    updated_at: p.updated_at,
    closed_at: p.closed_at,
    merged_at: p.merged_at,
    merge_commit_sha: p.mergeCommitSha,
    assignee: null,
    assignees: [],
    draft: p.draft,
    head: side(p.head, p.headSha),
    base: side(p.base, p.baseSha),
    author_association: 'OWNER',
    merged: p.merged,
    mergeable: can,
    rebaseable: can,
    mergeable_state: p.merged ? 'unknown' : can === null ? 'unknown' : can ? 'clean' : 'dirty',
    merged_by: p.merged ? userJson(forge, origin, p.user) : null,
    comments: p.comments.length,
    review_comments: 0,
    maintainer_can_modify: false,
    commits: repo.history(p.headSha).filter((c) => !repo.isAncestor(c.sha, p.baseSha)).length,
    additions: files.reduce((n, f) => n + f.additions, 0),
    deletions: files.reduce((n, f) => n + f.deletions, 0),
    changed_files: files.length,
  };
}

// ---------------------------------------------------------------- helpers

export function paginate<T>(items: T[], req: RestRequest): { page: T[]; headers: Record<string, string> } {
  const per = Math.min(100, Math.max(1, Number.parseInt(req.query.get('per_page') ?? '30', 10) || 30));
  const pageNo = Math.max(1, Number.parseInt(req.query.get('page') ?? '1', 10) || 1);
  const last = Math.max(1, Math.ceil(items.length / per));
  const link = (n: number, rel: string): string => {
    const q = new URLSearchParams(req.query);
    q.set('page', String(n));
    q.set('per_page', String(per));
    return `<${req.origin}${req.path}?${q.toString()}>; rel="${rel}"`;
  };
  const parts: string[] = [];
  if (pageNo < last) parts.push(link(pageNo + 1, 'next'), link(last, 'last'));
  if (pageNo > 1) parts.push(link(1, 'first'), link(pageNo - 1, 'prev'));
  const headers: Record<string, string> = {};
  if (parts.length > 0) headers.link = parts.join(', ');
  return { page: items.slice((pageNo - 1) * per, pageNo * per), headers };
}

const ok = (body: unknown, headers?: Record<string, string>): RestResponse => (headers === undefined ? { status: 200, body } : { status: 200, body, headers });
const created = (body: unknown): RestResponse => ({ status: 201, body });
const notFound = (): ApiError => new ApiError(404, 'Not Found');

function bodyObj(req: RestRequest): Json {
  if (req.body === undefined || req.body === null) return {};
  if (!isObj(req.body)) throw new ApiError(400, 'Problems parsing JSON');
  return req.body;
}

function intSeg(s: string | undefined): number {
  if (s === undefined || !/^\d+$/.test(s)) throw notFound();
  return Number(s);
}

function contentEntry(repo: Repo, origin: string, path: string, e: { mode: string; sha: string }, withBody: boolean): Json {
  const api = `${origin}/api/v3/repos/${repo.fullName}`;
  const isTree = e.mode === '40000';
  const data = isTree ? Buffer.alloc(0) : (repo.store.get(e.sha)?.data ?? Buffer.alloc(0));
  const out: Json = {
    type: isTree ? 'dir' : e.mode === '120000' ? 'symlink' : 'file',
    name: path.split('/').pop(),
    path,
    sha: e.sha,
    size: isTree ? 0 : data.length,
    url: `${api}/contents/${path}`,
    html_url: `${origin}/${repo.fullName}/blob/${repo.defaultBranch}/${path}`,
    git_url: `${api}/git/${isTree ? 'trees' : 'blobs'}/${e.sha}`,
    download_url: isTree ? null : `${origin}/${repo.fullName}/raw/${repo.defaultBranch}/${path}`,
  };
  if (withBody) {
    out.encoding = 'base64';
    out.content = `${data.toString('base64').replace(/(.{60})/g, '$1\n')}\n`.replace(/\n\n$/, '\n');
  }
  return out;
}

function commitSummary(forge: Forge, repo: Repo, sha: string, origin: string): Json {
  const info = parseCommit(repo.store.get(sha)?.data ?? Buffer.alloc(0));
  const api = `${origin}/api/v3/repos/${repo.fullName}`;
  return {
    sha,
    node_id: `C_${sha}`,
    url: `${api}/git/commits/${sha}`,
    html_url: `${origin}/${repo.fullName}/commit/${sha}`,
    author: identJson(info.author),
    committer: identJson(info.committer),
    tree: { sha: info.tree, url: `${api}/git/trees/${info.tree}` },
    message: cleanMessage(info.message),
    parents: info.parents.map((p) => ({ sha: p, url: `${api}/git/commits/${p}`, html_url: `${origin}/${repo.fullName}/commit/${p}` })),
    verification: { verified: false, reason: 'unsigned', signature: null, payload: null },
  };
}

function refJson(repo: Repo, origin: string, name: string): Json {
  const sha = repo.refs.get(name) as string;
  const type = repo.store.get(sha)?.type ?? 'commit';
  const api = `${origin}/api/v3/repos/${repo.fullName}`;
  return { ref: name, node_id: `REF_${Buffer.from(name).toString('base64url')}`, url: `${api}/git/${name}`, object: { sha, type, url: `${api}/git/${type}s/${sha}` } };
}

// ---------------------------------------------------------------- the router

export function handleRest(forge: Forge, req: RestRequest): RestResponse {
  const { method, segs, origin } = req;
  const [a, b, c, d, e] = segs;
  const rest = (from: number): string => segs.slice(from).join('/');

  if (segs.length === 0) {
    if (method !== 'GET') throw notFound();
    return ok(
      {
        current_user_url: `${origin}/api/v3/user`,
        repository_url: `${origin}/api/v3/repos/{owner}/{repo}`,
        rate_limit_url: `${origin}/api/v3/rate_limit`,
        user_repositories_url: `${origin}/api/v3/users/{user}/repos{?type,page,per_page,sort}`,
      },
      { 'x-oauth-scopes': 'repo, read:org', 'x-accepted-oauth-scopes': '' },
    );
  }
  if (a === 'meta' && segs.length === 1 && method === 'GET') return ok({ verifiable_password_authentication: false, installed_version: '3.14.0', hooks: [], web: [], api: [], git: [], packages: [], pages: [], importer: [], actions: [], dependabot: [] });
  if (a === 'rate_limit' && segs.length === 1 && method === 'GET') {
    const bucket = { limit: 5000, used: 0, remaining: 5000, reset: 2_000_000_000 };
    return ok({ resources: { core: bucket, graphql: bucket, search: bucket }, rate: bucket });
  }
  if (a === 'user' && segs.length === 1 && method === 'GET') return ok(userJson(forge, origin));
  if (a === 'user' && b === 'repos' && segs.length === 2) {
    if (method === 'POST') {
      const repo = createRepo(forge, bodyObj(req));
      return created(repoJson(forge, repo, origin));
    }
    if (method === 'GET') {
      let list = forge.list();
      const vis = req.query.get('visibility');
      if (vis === 'private') list = list.filter((r) => r.isPrivate);
      else if (vis === 'public') list = list.filter((r) => !r.isPrivate);
      list.sort((x, y) => x.name.toLowerCase().localeCompare(y.name.toLowerCase()));
      if ((req.query.get('direction') ?? '') === 'desc') list.reverse();
      const { page, headers } = paginate(list, req);
      return ok(page.map((r) => repoJson(forge, r, origin)), headers);
    }
    throw new ApiError(405, 'Method Not Allowed');
  }
  if (a === 'users' && b !== undefined && segs.length === 2 && method === 'GET') {
    if (forge.login !== null && b.toLowerCase() !== forge.login.toLowerCase()) throw notFound();
    return ok(userJson(forge, origin, b));
  }
  if (a === 'users' && b !== undefined && c === 'repos' && segs.length === 3 && method === 'GET') {
    if (forge.login === null || b.toLowerCase() !== forge.login.toLowerCase()) return ok([]);
    const { page, headers } = paginate(forge.list().filter((r) => !r.isPrivate), req);
    return ok(page.map((r) => repoJson(forge, r, origin)), headers);
  }
  if (a !== 'repos' || b === undefined || c === undefined) throw notFound();

  const repo = need(forge, b, c);
  const api = `${origin}/api/v3/repos/${repo.fullName}`;
  if (segs.length === 3) {
    if (method === 'GET') return ok(repoJson(forge, repo, origin));
    if (method === 'PATCH') {
      const body = bodyObj(req);
      if (body.description !== undefined) repo.description = str(body.description) ?? null;
      if (typeof body.private === 'boolean') repo.isPrivate = body.private;
      if (typeof body.name === 'string' && body.name !== repo.name) {
        if (forge.exists(body.name)) throw invalid('Repository', 'name', 'already_exists');
        forge.remove(repo);
        repo.name = body.name;
        forge.adopt(repo);
      }
      if (typeof body.default_branch === 'string' && repo.branchSha(body.default_branch) !== undefined) repo.defaultBranch = body.default_branch;
      repo.updated_at = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
      return ok(repoJson(forge, repo, origin));
    }
    if (method === 'DELETE') {
      forge.remove(repo);
      return { status: 204 };
    }
    throw new ApiError(405, 'Method Not Allowed');
  }

  switch (d) {
    case 'branches': {
      if (method !== 'GET') break;
      const branchJson = (name: string): Json => {
        const sha = repo.branchSha(name) as string;
        return { name, commit: { sha, url: `${api}/commits/${sha}` }, protected: false };
      };
      if (segs.length === 4) {
        const names = [...repo.refs.keys()].filter((k) => k.startsWith('refs/heads/')).map((k) => k.slice(11)).sort();
        const { page, headers } = paginate(names, req);
        return ok(page.map(branchJson), headers);
      }
      const name = rest(4);
      if (repo.branchSha(name) === undefined) throw new ApiError(404, 'Branch not found');
      const sha = repo.branchSha(name) as string;
      return ok({ name, commit: commitJson(forge, repo, sha, origin), protected: false, _links: { self: `${api}/branches/${name}` } });
    }
    case 'commits': {
      if (method !== 'GET') break;
      if (segs.length === 4) {
        const want = req.query.get('sha') ?? undefined;
        const tip = commitAt(repo, want);
        if (tip === undefined) {
          if (repo.isEmpty() && want === undefined) return ok([]);
          throw new ApiError(want === undefined ? 409 : 404, want === undefined ? 'Git Repository is empty.' : 'Not Found');
        }
        const path = req.query.get('path');
        let list = repo.history(tip.sha);
        if (path !== null && path !== '') {
          list = list.filter((h) => {
            const here = repo.lookup(h.info.tree, path)?.sha;
            const before = h.info.parents.length === 0 ? undefined : repo.lookup(repo.commit(h.info.parents[0] as string)?.tree ?? '', path)?.sha;
            return here !== before;
          });
        }
        const { page, headers } = paginate(list, req);
        return ok(page.map((h) => commitJson(forge, repo, h.sha, origin)), headers);
      }
      const ref = rest(4);
      const found = commitAt(repo, ref);
      if (found === undefined) throw new ApiError(404, 'Not Found');
      return ok(commitJson(forge, repo, found.sha, origin));
    }
    case 'contents': {
      const path = rest(4).replace(/\/+$/, '');
      if (method === 'GET') {
        const ref = req.query.get('ref') ?? undefined;
        const tip = commitAt(repo, ref);
        if (tip === undefined) throw notFound();
        if (path === '') {
          return ok(repo.tree(tip.info.tree).map((e) => contentEntry(repo, origin, e.name, e, false)));
        }
        const entry = repo.lookup(tip.info.tree, path);
        if (entry === undefined) throw notFound();
        if (entry.mode === '40000') return ok(repo.tree(entry.sha).map((x) => contentEntry(repo, origin, `${path}/${x.name}`, x, false)));
        return ok(contentEntry(repo, origin, path, entry, true));
      }
      if (method === 'PUT' || method === 'DELETE') {
        if (path === '') throw notFound();
        const body = bodyObj(req);
        const message = str(body.message);
        if (message === undefined || message === '') throw invalid('Content', 'message', 'missing_field');
        let content: Buffer | null = null;
        if (method === 'PUT') {
          if (typeof body.content !== 'string') throw invalid('Content', 'content', 'missing_field');
          if (!/^[A-Za-z0-9+/=\s]*$/.test(body.content)) throw new ApiError(422, 'content is not valid Base64');
          content = Buffer.from(body.content, 'base64');
        }
        const w = writeContent(forge, repo, {
          path,
          message,
          content,
          ...(str(body.sha) === undefined ? {} : { sha: str(body.sha) as string }),
          ...(str(body.branch) === undefined ? {} : { branch: str(body.branch) as string }),
          author: body.author,
          committer: body.committer,
        });
        const commit = commitSummary(forge, repo, w.commitSha, origin);
        const contentObj = w.blobSha === null ? null : contentEntry(repo, origin, path, { mode: '100644', sha: w.blobSha }, false);
        if (contentObj !== null) contentObj.encoding = 'base64';
        if (contentObj !== null) contentObj.download_url = `${origin}/${repo.fullName}/raw/${repo.defaultBranch}/${path}`;
        return { status: method === 'PUT' && w.created ? 201 : 200, body: { content: contentObj, commit } };
      }
      break;
    }
    case 'git': {
      if (e === 'refs' || e === 'ref' || e === 'matching-refs') {
        const name = rest(5);
        if (method === 'POST' && e === 'refs' && segs.length === 5) {
          const body = bodyObj(req);
          const ref = str(body.ref);
          const sha = str(body.sha);
          if (ref === undefined || !ref.startsWith('refs/') || sha === undefined) throw invalid('Reference', 'ref', 'missing_field');
          if (repo.refs.has(ref)) throw new ApiError(422, 'Reference already exists');
          if (!repo.store.has(sha)) throw new ApiError(422, 'Object does not exist');
          repo.refs.set(ref, sha);
          return created(refJson(repo, origin, ref));
        }
        if (method === 'GET' && segs.length === 5 && e === 'refs') {
          return ok([...repo.refs.keys()].sort().map((k) => refJson(repo, origin, k)));
        }
        if (method === 'GET' && e === 'matching-refs') return ok([...repo.refs.keys()].filter((k) => k.startsWith(`refs/${name}`)).sort().map((k) => refJson(repo, origin, k)));
        const full = `refs/${name}`;
        if (method === 'GET') {
          if (repo.refs.has(full)) return ok(refJson(repo, origin, full));
          const kids = [...repo.refs.keys()].filter((k) => k.startsWith(`${full}/`)).sort();
          if (kids.length > 0 && e === 'refs') return ok(kids.map((k) => refJson(repo, origin, k)));
          throw new ApiError(404, 'Not Found');
        }
        if (method === 'PATCH') {
          if (!repo.refs.has(full)) throw notFound();
          const body = bodyObj(req);
          const sha = str(body.sha);
          if (sha === undefined || !repo.store.has(sha)) throw new ApiError(422, 'Object does not exist');
          if (body.force !== true && !repo.isAncestor(repo.refs.get(full) as string, sha)) throw new ApiError(422, 'Update is not a fast forward');
          repo.refs.set(full, sha);
          return ok(refJson(repo, origin, full));
        }
        if (method === 'DELETE') {
          if (!repo.refs.has(full)) throw new ApiError(422, 'Reference does not exist');
          repo.refs.delete(full);
          return { status: 204 };
        }
      }
      if (e === 'commits' && method === 'GET' && segs.length === 6) {
        const sha = rest(5);
        if (repo.store.get(sha)?.type !== 'commit') throw notFound();
        return ok(commitSummary(forge, repo, sha, origin));
      }
      if (e === 'trees' && method === 'GET' && segs.length === 6) {
        const found = commitAt(repo, rest(5));
        const sha = found !== undefined ? found.info.tree : rest(5);
        if (repo.store.get(sha)?.type !== 'tree') throw notFound();
        const tree = repo.tree(sha).map((t) => ({ path: t.name, mode: t.mode.padStart(6, '0'), type: t.mode === '40000' ? 'tree' : t.mode === '160000' ? 'commit' : 'blob', sha: t.sha, url: `${api}/git/${t.mode === '40000' ? 'trees' : 'blobs'}/${t.sha}` }));
        return ok({ sha, url: `${api}/git/trees/${sha}`, tree, truncated: false });
      }
      if (e === 'blobs' && method === 'GET' && segs.length === 6) {
        const blob = repo.store.get(rest(5));
        if (blob === undefined || blob.type !== 'blob') throw notFound();
        return ok({ sha: blob.sha, node_id: `B_${blob.sha}`, size: blob.data.length, url: `${api}/git/blobs/${blob.sha}`, content: blob.data.toString('base64'), encoding: 'base64' });
      }
      if (e === 'tags' && method === 'GET' && segs.length === 6) {
        const tag = repo.store.get(rest(5));
        if (tag === undefined || tag.type !== 'tag') throw notFound();
        const t = parseTag(tag.data);
        return ok({ sha: tag.sha, tag: t.tag, object: { sha: t.object, type: t.type } });
      }
      break;
    }
    case 'labels': {
      if (segs.length === 4 && method === 'POST') return created(labelJson(repo, origin, createLabel(repo, bodyObj(req)).name));
      if (segs.length === 4 && method === 'GET') {
        const { page, headers } = paginate([...repo.labels.keys()], req);
        return ok(page.map((n) => labelJson(repo, origin, n)), headers);
      }
      if (segs.length === 5 && method === 'GET') {
        const name = decodeURIComponent(rest(4));
        if (!repo.labels.has(name)) throw notFound();
        return ok(labelJson(repo, origin, name));
      }
      break;
    }
    case 'issues': {
      if (segs.length === 4 && method === 'POST') return created(issueJson(forge, repo, createIssue(forge, repo, bodyObj(req)), origin));
      if (segs.length === 4 && method === 'GET') {
        const state = req.query.get('state') ?? 'open';
        const want = (req.query.get('labels') ?? '').split(',').filter((x) => x !== '');
        let list = repo.issues.filter((i) => state === 'all' || i.state === state);
        if (want.length > 0) list = list.filter((i) => want.every((w) => i.labels.includes(w)));
        const sort = req.query.get('sort') ?? 'created';
        const dir = (req.query.get('direction') ?? 'desc') === 'asc' ? 1 : -1;
        const keyOf = (i: Issue): string | number => (sort === 'comments' ? i.comments.length : sort === 'updated' ? i.updated_at : i.created_at);
        list = [...list].sort((x, y) => {
          const kx = keyOf(x);
          const ky = keyOf(y);
          const c1 = kx < ky ? -1 : kx > ky ? 1 : 0;
          return c1 !== 0 ? dir * c1 : dir * (x.number - y.number);
        });
        const { page, headers } = paginate(list, req);
        return ok(page.map((i) => issueJson(forge, repo, i, origin)), headers);
      }
      if (e === 'comments' && segs.length === 4) break;
      const n = intSeg(e === undefined ? undefined : segs[4]);
      const issue = findIssue(repo, n);
      if (segs.length === 5) {
        if (method === 'GET') return ok(issueJson(forge, repo, issue, origin));
        if (method === 'PATCH') {
          patchIssue(repo, issue, bodyObj(req));
          return ok(issueJson(forge, repo, issue, origin));
        }
        break;
      }
      if (segs[5] === 'comments' && segs.length === 6) {
        if (method === 'POST') return created(commentJson(forge, repo, n, addComment(forge, issue, bodyObj(req)), origin));
        if (method === 'GET') {
          const { page, headers } = paginate(issue.comments, req);
          return ok(page.map((x) => commentJson(forge, repo, n, x, origin)), headers);
        }
      }
      break;
    }
    case 'pulls': {
      if (segs.length === 4 && method === 'POST') return created(pullJson(forge, repo, createPull(forge, repo, bodyObj(req)), origin));
      if (segs.length === 4 && method === 'GET') {
        const state = req.query.get('state') ?? 'open';
        let list = repo.pulls.filter((p) => state === 'all' || p.state === state);
        const head = req.query.get('head');
        if (head !== null && head !== '') list = list.filter((p) => p.head === head.slice(head.indexOf(':') + 1));
        const baseQ = req.query.get('base');
        if (baseQ !== null && baseQ !== '') list = list.filter((p) => p.base === baseQ);
        const dir = (req.query.get('direction') ?? 'desc') === 'asc' ? 1 : -1;
        list = [...list].sort((x, y) => dir * (x.number - y.number));
        const { page, headers } = paginate(list, req);
        return ok(page.map((p) => pullJson(forge, repo, p, origin)), headers);
      }
      const n = intSeg(e === undefined ? undefined : segs[4]);
      const pull = findPull(repo, n);
      if (segs.length === 5) {
        if (method === 'GET') return ok(pullJson(forge, repo, pull, origin));
        if (method === 'PATCH') {
          patchPull(repo, pull, bodyObj(req));
          return ok(pullJson(forge, repo, pull, origin));
        }
        break;
      }
      const sub = segs[5];
      if (sub === 'merge' && segs.length === 6) {
        if (method === 'PUT') {
          const r = mergePull(forge, repo, pull, bodyObj(req));
          return ok({ sha: r.sha, merged: true, message: r.message });
        }
        if (method === 'GET') {
          if (!pull.merged) throw notFound();
          return { status: 204 };
        }
      }
      if (sub === 'files' && method === 'GET' && segs.length === 6) {
        livePull(repo, pull);
        const files = changedFiles(repo, treeOfCommit(repo, repo.mergeBase(pull.baseSha, pull.headSha)), treeOfCommit(repo, pull.headSha));
        const { page, headers } = paginate(files, req);
        return ok(
          page.map((f) => ({
            sha: f.sha,
            filename: f.filename,
            status: f.status,
            additions: f.additions,
            deletions: f.deletions,
            changes: f.additions + f.deletions,
            blob_url: `${origin}/${repo.fullName}/blob/${pull.headSha}/${f.filename}`,
            raw_url: `${origin}/${repo.fullName}/raw/${pull.headSha}/${f.filename}`,
            contents_url: `${api}/contents/${f.filename}?ref=${pull.headSha}`,
            patch: f.patch,
          })),
          headers,
        );
      }
      if (sub === 'commits' && method === 'GET' && segs.length === 6) {
        livePull(repo, pull);
        const list = repo.history(pull.headSha).filter((h) => !repo.isAncestor(h.sha, pull.baseSha)).reverse();
        const { page, headers } = paginate(list, req);
        return ok(page.map((h) => commitJson(forge, repo, h.sha, origin)), headers);
      }
      break;
    }
    default:
      break;
  }
  throw notFound();
}
