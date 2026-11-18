// The forge's operations: what REST, GraphQL and MCP all do to the store, once. Each throws ApiError
// with the status GitHub would answer; the three front ends only translate.
import { ZERO, encodeTree, parseCommit, parseIdent, type CommitInfo, type TreeEntry } from './git.ts';
import { Forge, isoNow } from './forge.ts';
import { EMPTY_TREE_SHA, type Issue, type Pull, type Repo } from './repo.ts';

export class ApiError extends Error {
  status: number;
  errors?: unknown[];
  constructor(status: number, message: string, errors?: unknown[]) {
    super(message);
    this.status = status;
    if (errors !== undefined) this.errors = errors;
  }
}

export const invalid = (resource: string, field: string, code = 'invalid'): ApiError =>
  new ApiError(422, 'Validation Failed', [{ resource, field, code }]);

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
export const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

// ---------------------------------------------------------------- repositories

export function createRepo(forge: Forge, body: Json): Repo {
  const name = str(body.name);
  if (name === undefined || name.trim() === '') throw invalid('Repository', 'name', 'missing_field');
  if (!/^[A-Za-z0-9._-]{1,100}$/.test(name) || name === '.' || name === '..') throw invalid('Repository', 'name');
  if (forge.exists(name)) throw new ApiError(422, 'Repository creation failed.', [{ resource: 'Repository', code: 'custom', field: 'name', message: 'name already exists on this account' }]);
  const description = typeof body.description === 'string' ? body.description : null;
  const isPrivate = body.private === true || body.visibility === 'private';
  const branch = str(body.default_branch) ?? 'main';
  return forge.create(name, isPrivate, description, branch);
}

export function need(forge: Forge, owner: string, name: string): Repo {
  const repo = forge.find(owner, name);
  if (repo === undefined) throw new ApiError(404, 'Not Found');
  return repo;
}

// ---------------------------------------------------------------- identities and commits

export function identLine(name: string, email: string, when: Date = new Date()): string {
  return `${name} <${email}> ${Math.floor(when.getTime() / 1000)} +0000`;
}

function identFrom(spec: unknown, fallback: { name: string; email: string }): string {
  if (isObj(spec) && typeof spec.name === 'string' && typeof spec.email === 'string') {
    const d = typeof spec.date === 'string' ? new Date(spec.date) : new Date();
    return identLine(spec.name, spec.email, Number.isNaN(d.getTime()) ? new Date() : d);
  }
  return identLine(fallback.name, fallback.email);
}

export function isoOfIdent(line: string): string {
  const p = parseIdent(line);
  return new Date(p.epoch * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export function cleanMessage(m: string): string {
  return m.replace(/\n$/, '');
}

// ---------------------------------------------------------------- contents

function cleanPath(path: string): string {
  const parts = path.split('/').filter((p) => p !== '');
  if (parts.length === 0 || parts.some((p) => p === '.' || p === '..')) throw new ApiError(404, 'Not Found');
  return parts.join('/');
}

export interface ContentWrite {
  path: string;
  message: string;
  content: Buffer | null; // null deletes
  sha?: string;
  branch?: string;
  author?: unknown;
  committer?: unknown;
}

export function writeContent(forge: Forge, repo: Repo, w: ContentWrite): { commitSha: string; blobSha: string | null; created: boolean } {
  const path = cleanPath(w.path);
  const branch = w.branch ?? repo.defaultBranch;
  const ref = `refs/heads/${branch}`;
  const tip = repo.refs.get(ref);
  if (tip === undefined && !(repo.isEmpty() && branch === repo.defaultBranch)) throw new ApiError(404, `Branch ${branch} not found`);
  const parent = tip === undefined ? undefined : repo.commit(tip);
  const existing = parent === undefined ? undefined : repo.lookup(parent.tree, path);
  if (existing !== undefined && existing.mode === '40000') throw new ApiError(422, 'Invalid request.\n\n"sha" wasn\'t supplied.');
  if (w.content === null) {
    if (existing === undefined) throw new ApiError(404, 'Not Found');
    if (w.sha === undefined) throw invalid('Content', 'sha', 'missing_field');
    if (w.sha !== existing.sha) throw new ApiError(409, `${path} does not match ${existing.sha}`);
  } else if (existing !== undefined) {
    if (w.sha === undefined) throw new ApiError(422, 'Invalid request.\n\n"sha" wasn\'t supplied.');
    if (w.sha !== existing.sha) throw new ApiError(409, `${path} does not match ${existing.sha}`);
  } else if (w.sha !== undefined) {
    throw new ApiError(409, `${path} does not match`);
  }
  const me = forge.me();
  const blob = w.content === null ? null : repo.store.put('blob', w.content);
  const tree = repo.withFile(parent?.tree, path, blob === null ? null : blob.sha) ?? repo.store.put('tree', encodeTree([])).sha;
  const author = identFrom(w.author, me);
  const committer = identFrom(w.committer ?? w.author, me);
  const commit = repo.makeCommit(tree, tip === undefined ? [] : [tip], `${w.message}\n`, author, committer);
  repo.refs.set(ref, commit);
  const now = isoNow();
  repo.pushed_at = now;
  repo.updated_at = now;
  return { commitSha: commit, blobSha: blob === null ? null : blob.sha, created: existing === undefined };
}

export function commitAt(repo: Repo, ref: string | undefined): { sha: string; info: CommitInfo } | undefined {
  let sha: string | undefined;
  if (ref === undefined || ref === '') sha = repo.refs.get(repo.headRef());
  else if (/^[0-9a-f]{40}$/i.test(ref) && repo.store.has(ref.toLowerCase())) sha = ref.toLowerCase();
  else sha = repo.refs.get(`refs/heads/${ref}`) ?? repo.refs.get(`refs/tags/${ref}`) ?? repo.refs.get(ref) ?? undefined;
  if (sha === undefined) return undefined;
  const peeled = repo.peel(sha);
  const info = repo.commit(peeled);
  return info === undefined ? undefined : { sha: peeled, info };
}

// ---------------------------------------------------------------- issues and labels

export function createLabel(repo: Repo, body: Json): { id: number; name: string; color: string; description: string | null } {
  const name = str(body.name);
  if (name === undefined || name === '') throw invalid('Label', 'name', 'missing_field');
  if ([...repo.labels.keys()].some((k) => k.toLowerCase() === name.toLowerCase())) throw invalid('Label', 'name', 'already_exists');
  const label = { id: repo.nextId++, name, color: (str(body.color) ?? 'ededed').replace(/^#/, ''), description: str(body.description) ?? null };
  repo.labels.set(name, label);
  return label;
}

function labelNames(repo: Repo, raw: unknown): string[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw invalid('Issue', 'labels');
  const out: string[] = [];
  for (const item of raw) {
    const name = typeof item === 'string' ? item : isObj(item) ? str(item.name) : undefined;
    if (name === undefined) throw invalid('Issue', 'labels');
    const found = [...repo.labels.keys()].find((k) => k.toLowerCase() === name.toLowerCase());
    if (found === undefined) throw invalid('Label', 'name', 'invalid');
    out.push(found);
  }
  return out;
}

export function createIssue(forge: Forge, repo: Repo, body: Json): Issue {
  const title = typeof body.title === 'number' ? String(body.title) : str(body.title);
  if (title === undefined || title.trim() === '') throw invalid('Issue', 'title', 'missing_field');
  const labels = labelNames(repo, body.labels);
  const now = isoNow();
  const issue: Issue = {
    number: repo.nextNumber++,
    id: forge.newId(),
    title,
    body: str(body.body) ?? null,
    state: 'open',
    labels,
    user: forge.me().login,
    comments: [],
    created_at: now,
    updated_at: now,
    closed_at: null,
  };
  repo.issues.push(issue);
  repo.updated_at = now;
  return issue;
}

export function patchIssue(repo: Repo, issue: Issue, body: Json): void {
  if (body.title !== undefined) {
    if (typeof body.title !== 'string' || body.title === '') throw invalid('Issue', 'title');
    issue.title = body.title;
  }
  if (body.body !== undefined) issue.body = str(body.body) ?? null;
  if (body.labels !== undefined) issue.labels = labelNames(repo, body.labels);
  if (body.state !== undefined) {
    if (body.state !== 'open' && body.state !== 'closed') throw invalid('Issue', 'state');
    if (body.state !== issue.state) {
      issue.state = body.state;
      issue.closed_at = body.state === 'closed' ? isoNow() : null;
    }
  }
  issue.updated_at = isoNow();
}

export function findIssue(repo: Repo, n: number): Issue {
  const issue = repo.issues.find((i) => i.number === n);
  if (issue === undefined) throw new ApiError(404, 'Not Found');
  return issue;
}

export function addComment(forge: Forge, target: { comments: Issue['comments']; updated_at: string }, body: Json): Issue['comments'][number] {
  const text = str(body.body);
  if (text === undefined || text === '') throw invalid('IssueComment', 'body', 'missing_field');
  const now = isoNow();
  const comment = { id: forge.newCommentId(), body: text, user: forge.me().login, created_at: now, updated_at: now };
  target.comments.push(comment);
  target.updated_at = now;
  return comment;
}

// ---------------------------------------------------------------- pull requests

function branchOf(spec: string): string {
  const colon = spec.indexOf(':');
  return colon >= 0 ? spec.slice(colon + 1) : spec;
}

export function createPull(forge: Forge, repo: Repo, body: Json): Pull {
  const title = str(body.title);
  if (title === undefined || title.trim() === '') throw invalid('PullRequest', 'title', 'missing_field');
  const headSpec = str(body.head);
  const baseSpec = str(body.base);
  if (headSpec === undefined) throw invalid('PullRequest', 'head', 'missing_field');
  if (baseSpec === undefined) throw invalid('PullRequest', 'base', 'missing_field');
  const head = branchOf(headSpec);
  const base = branchOf(baseSpec);
  const headSha = repo.branchSha(head);
  const baseSha = repo.branchSha(base);
  if (headSha === undefined) throw invalid('PullRequest', 'head');
  if (baseSha === undefined) throw invalid('PullRequest', 'base');
  const now = isoNow();
  const pull: Pull = {
    number: repo.nextNumber++,
    id: forge.newId(),
    title,
    body: str(body.body) ?? null,
    state: 'open',
    draft: body.draft === true,
    head,
    headSha,
    base,
    baseSha,
    user: forge.me().login,
    merged: false,
    mergeCommitSha: null,
    comments: [],
    created_at: now,
    updated_at: now,
    closed_at: null,
    merged_at: null,
  };
  repo.pulls.push(pull);
  repo.updated_at = now;
  return pull;
}

export function findPull(repo: Repo, n: number): Pull {
  const pull = repo.pulls.find((p) => p.number === n);
  if (pull === undefined) throw new ApiError(404, 'Not Found');
  return pull;
}

/** A pull request with its branch tips refreshed while it is still open. */
export function livePull(repo: Repo, pull: Pull): Pull {
  if (pull.state === 'open') {
    pull.headSha = repo.branchSha(pull.head) ?? pull.headSha;
    pull.baseSha = repo.branchSha(pull.base) ?? pull.baseSha;
  }
  return pull;
}

export function patchPull(repo: Repo, pull: Pull, body: Json): void {
  if (typeof body.title === 'string' && body.title !== '') pull.title = body.title;
  if (body.body !== undefined) pull.body = str(body.body) ?? null;
  if (body.state === 'closed' && pull.state === 'open') {
    pull.state = 'closed';
    pull.closed_at = isoNow();
  } else if (body.state === 'open' && pull.state === 'closed' && !pull.merged) {
    pull.state = 'open';
    pull.closed_at = null;
  }
  if (typeof body.base === 'string' && repo.branchSha(body.base) !== undefined) pull.base = body.base;
  pull.updated_at = isoNow();
}

export interface FileChange {
  filename: string;
  status: 'added' | 'removed' | 'modified';
  sha: string;
  additions: number;
  deletions: number;
  patch?: string;
}

function lines(buf: Buffer): string[] {
  const text = buf.toString('utf8');
  if (text === '') return [];
  const parts = text.split('\n');
  if (parts[parts.length - 1] === '') parts.pop();
  return parts;
}

/** Line diff by longest common subsequence: the marked lines, and the counts. */
export function diffLines(a: string[], b: string[]): { marks: string[]; add: number; del: number } {
  const n = a.length;
  const m = b.length;
  const marks: string[] = [];
  let add = 0;
  let del = 0;
  if (n * m > 4_000_000) {
    for (const l of a) marks.push(`-${l}`);
    for (const l of b) marks.push(`+${l}`);
    return { marks, add: m, del: n };
  }
  const t: Uint32Array[] = [];
  for (let i = 0; i <= n; i += 1) t.push(new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      t[i]![j] = a[i] === b[j] ? (t[i + 1]![j + 1] as number) + 1 : Math.max(t[i + 1]![j] as number, t[i]![j + 1] as number);
    }
  }
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      marks.push(` ${a[i]}`);
      i += 1;
      j += 1;
    } else if ((t[i + 1]![j] as number) >= (t[i]![j + 1] as number)) {
      marks.push(`-${a[i++]}`);
      del += 1;
    } else {
      marks.push(`+${b[j++]}`);
      add += 1;
    }
  }
  while (i < n) {
    marks.push(`-${a[i++]}`);
    del += 1;
  }
  while (j < m) {
    marks.push(`+${b[j++]}`);
    add += 1;
  }
  return { marks, add, del };
}

export function treeOfCommit(repo: Repo, sha: string | undefined): string | undefined {
  return sha === undefined ? undefined : repo.commit(sha)?.tree;
}

export function changedFiles(repo: Repo, baseTree: string | undefined, headTree: string | undefined): FileChange[] {
  const before = baseTree === undefined ? new Map() : repo.flatten(baseTree);
  const after = headTree === undefined ? new Map() : repo.flatten(headTree);
  const names = [...new Set([...before.keys(), ...after.keys()])].sort();
  const out: FileChange[] = [];
  for (const name of names) {
    const a = before.get(name);
    const b = after.get(name);
    if (a !== undefined && b !== undefined && a.sha === b.sha && a.mode === b.mode) continue;
    const aBuf = a === undefined ? Buffer.alloc(0) : (repo.store.get(a.sha)?.data ?? Buffer.alloc(0));
    const bBuf = b === undefined ? Buffer.alloc(0) : (repo.store.get(b.sha)?.data ?? Buffer.alloc(0));
    const al = lines(aBuf);
    const bl = lines(bBuf);
    const d = diffLines(al, bl);
    const patch = `@@ -${al.length === 0 ? 0 : 1},${al.length} +${bl.length === 0 ? 0 : 1},${bl.length} @@\n${d.marks.join('\n')}`;
    out.push({
      filename: name,
      status: a === undefined ? 'added' : b === undefined ? 'removed' : 'modified',
      sha: (b ?? a)!.sha,
      additions: d.add,
      deletions: d.del,
      patch,
    });
  }
  return out;
}

/** A three-way merge by path: undefined when two sides changed the same path differently. */
export function mergeTrees(repo: Repo, baseTree: string | undefined, ours: string, theirs: string): string | undefined {
  const base = baseTree === undefined ? new Map() : repo.flatten(baseTree);
  const a = repo.flatten(ours);
  const b = repo.flatten(theirs);
  const result = new Map<string, { sha: string; mode: string }>();
  for (const path of new Set([...base.keys(), ...a.keys(), ...b.keys()])) {
    const x = base.get(path);
    const y = a.get(path);
    const z = b.get(path);
    const same = (p: typeof x, q: typeof x): boolean => p?.sha === q?.sha && p?.mode === q?.mode;
    let pick: typeof x;
    if (same(y, z)) pick = y;
    else if (same(x, y)) pick = z;
    else if (same(x, z)) pick = y;
    else return undefined;
    if (pick !== undefined) result.set(path, pick);
  }
  return buildTree(repo, result);
}

export function buildTree(repo: Repo, flat: Map<string, { sha: string; mode: string }>): string {
  type Node = { files: TreeEntry[]; dirs: Map<string, Node> };
  const root: Node = { files: [], dirs: new Map() };
  for (const [path, v] of flat) {
    const parts = path.split('/');
    let node = root;
    for (const dir of parts.slice(0, -1)) {
      let next = node.dirs.get(dir);
      if (next === undefined) {
        next = { files: [], dirs: new Map() };
        node.dirs.set(dir, next);
      }
      node = next;
    }
    node.files.push({ mode: v.mode, name: parts[parts.length - 1] as string, sha: v.sha });
  }
  const write = (node: Node): string => {
    const entries = [...node.files];
    for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, sha: write(child) });
    return repo.store.put('tree', encodeTree(entries)).sha;
  };
  return write(root);
}

export function mergeable(repo: Repo, pull: Pull): boolean {
  const head = livePull(repo, pull).headSha;
  const base = pull.baseSha;
  const ours = treeOfCommit(repo, base);
  const theirs = treeOfCommit(repo, head);
  if (ours === undefined || theirs === undefined) return false;
  const mb = repo.mergeBase(base, head);
  return mergeTrees(repo, treeOfCommit(repo, mb), ours, theirs) !== undefined;
}

export function mergePull(forge: Forge, repo: Repo, pull: Pull, body: Json): { sha: string; message: string } {
  if (pull.state !== 'open' || pull.merged) throw new ApiError(405, 'Pull Request is not mergeable');
  livePull(repo, pull);
  if (typeof body.sha === 'string' && body.sha !== pull.headSha) throw new ApiError(409, 'Head branch was modified. Review and try the merge again.');
  const base = repo.branchSha(pull.base);
  const head = repo.branchSha(pull.head);
  if (base === undefined || head === undefined) throw new ApiError(405, 'Pull Request is not mergeable');
  const ours = treeOfCommit(repo, base);
  const theirs = treeOfCommit(repo, head);
  const mb = repo.mergeBase(base, head);
  const merged = ours === undefined || theirs === undefined ? undefined : mergeTrees(repo, treeOfCommit(repo, mb), ours, theirs);
  if (merged === undefined) throw new ApiError(405, 'Pull Request is not mergeable');
  const me = forge.me();
  const title = str(body.commit_title) ?? `${pull.title} (#${pull.number})`;
  const extra = str(body.commit_message);
  const message = extra === undefined || extra === '' ? title : `${title}\n\n${extra}`;
  const ident = identLine(me.name, me.email);
  const sha = repo.makeCommit(merged, [base], `${message}\n`, ident, ident);
  repo.refs.set(`refs/heads/${pull.base}`, sha);
  const now = isoNow();
  pull.headSha = head;
  pull.baseSha = base;
  pull.state = 'closed';
  pull.merged = true;
  pull.mergeCommitSha = sha;
  pull.closed_at = now;
  pull.merged_at = now;
  pull.updated_at = now;
  repo.pushed_at = now;
  repo.updated_at = now;
  return { sha, message: 'Pull Request successfully merged' };
}

export { EMPTY_TREE_SHA, ZERO, parseCommit };
