// The forge's data model: repositories (objects, refs, labels, issues, pull requests) and the helpers
// that read a git history out of them. All of it is in memory.
import { ObjectStore, ZERO, encodeCommit, encodeTree, parseCommit, parseTag, parseTree, type CommitInfo, type TreeEntry } from './git.ts';

export interface Label {
  id: number;
  name: string;
  color: string;
  description: string | null;
}

export interface Comment {
  id: number;
  body: string;
  user: string;
  created_at: string;
  updated_at: string;
}

export interface Issue {
  number: number;
  id: number;
  title: string;
  body: string | null;
  state: 'open' | 'closed';
  labels: string[];
  user: string;
  comments: Comment[];
  created_at: string;
  updated_at: string;
  closed_at: string | null;
}

export interface Pull {
  number: number;
  id: number;
  title: string;
  body: string | null;
  state: 'open' | 'closed';
  draft: boolean;
  head: string; // branch name
  headSha: string;
  base: string;
  baseSha: string;
  user: string;
  merged: boolean;
  mergeCommitSha: string | null;
  comments: Comment[];
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  merged_at: string | null;
}

export class Repo {
  id: number;
  owner: string; // '' while the forge has not yet learned the token's login
  name: string;
  isPrivate: boolean;
  description: string | null;
  defaultBranch: string;
  readonly store = new ObjectStore();
  readonly refs = new Map<string, string>();
  readonly labels = new Map<string, Label>();
  readonly issues: Issue[] = [];
  readonly pulls: Pull[] = [];
  /** Issues and pull requests draw numbers from one sequence, as GitHub's do. */
  nextNumber = 1;
  nextId = 1;
  created_at: string;
  updated_at: string;
  pushed_at: string | null = null;
  /** Pack responses by request shape: objects never change once stored, so a hit stays valid. */
  readonly packCache = new Map<string, Buffer>();

  constructor(id: number, owner: string, name: string, isPrivate: boolean, description: string | null, defaultBranch: string, now: string) {
    this.id = id;
    this.owner = owner;
    this.name = name;
    this.isPrivate = isPrivate;
    this.description = description;
    this.defaultBranch = defaultBranch;
    this.created_at = now;
    this.updated_at = now;
  }

  get fullName(): string {
    return `${this.owner}/${this.name}`;
  }

  headRef(): string {
    return `refs/heads/${this.defaultBranch}`;
  }

  branchSha(branch: string): string | undefined {
    return this.refs.get(`refs/heads/${branch}`);
  }

  commit(sha: string): CommitInfo | undefined {
    const o = this.store.get(sha);
    return o !== undefined && o.type === 'commit' ? parseCommit(o.data) : undefined;
  }

  /** Follow tag objects down to the commit (or other object) they name. */
  peel(sha: string): string {
    let cur = sha;
    for (let i = 0; i < 16; i += 1) {
      const o = this.store.get(cur);
      if (o === undefined || o.type !== 'tag') return cur;
      cur = parseTag(o.data).object;
    }
    return cur;
  }

  /** True when `ancestor` is `descendant` or reachable from it through parents. */
  isAncestor(ancestor: string, descendant: string): boolean {
    if (ancestor === descendant) return true;
    const seen = new Set<string>([descendant]);
    const stack = [descendant];
    while (stack.length > 0) {
      const sha = stack.pop() as string;
      const c = this.commit(sha);
      if (c === undefined) continue;
      for (const p of c.parents) {
        if (p === ancestor) return true;
        if (!seen.has(p)) {
          seen.add(p);
          stack.push(p);
        }
      }
    }
    return false;
  }

  /** Commits reachable from `tip`, newest first by committer time (ties in discovery order). */
  history(tip: string, limit = Infinity): { sha: string; info: CommitInfo }[] {
    const seen = new Set<string>([tip]);
    const out: { sha: string; info: CommitInfo; t: number; i: number }[] = [];
    const stack = [tip];
    let n = 0;
    while (stack.length > 0) {
      const sha = stack.pop() as string;
      const info = this.commit(sha);
      if (info === undefined) continue;
      const m = /> (\d+) /.exec(info.committer);
      out.push({ sha, info, t: m === null ? 0 : Number(m[1]), i: n++ });
      for (const p of info.parents) {
        if (!seen.has(p)) {
          seen.add(p);
          stack.push(p);
        }
      }
    }
    out.sort((a, b) => b.t - a.t || a.i - b.i);
    return out.slice(0, limit === Infinity ? undefined : limit);
  }

  /** The first common ancestor of two commits (nearest to `a` in breadth-first order), or undefined. */
  mergeBase(a: string, b: string): string | undefined {
    const ancestorsOfB = new Set<string>();
    const queue = [b];
    while (queue.length > 0) {
      const sha = queue.shift() as string;
      if (ancestorsOfB.has(sha)) continue;
      ancestorsOfB.add(sha);
      for (const p of this.commit(sha)?.parents ?? []) queue.push(p);
    }
    const seen = new Set<string>();
    const q = [a];
    while (q.length > 0) {
      const sha = q.shift() as string;
      if (seen.has(sha)) continue;
      seen.add(sha);
      if (ancestorsOfB.has(sha)) return sha;
      for (const p of this.commit(sha)?.parents ?? []) q.push(p);
    }
    return undefined;
  }

  /** The tree entries of a tree object; empty when it is missing. */
  tree(sha: string): TreeEntry[] {
    const o = this.store.get(sha);
    return o !== undefined && o.type === 'tree' ? parseTree(o.data) : [];
  }

  /** A flat map path -> {sha, mode} of every blob under a tree. */
  flatten(treeSha: string): Map<string, { sha: string; mode: string }> {
    const out = new Map<string, { sha: string; mode: string }>();
    const walk = (sha: string, prefix: string): void => {
      for (const e of this.tree(sha)) {
        const path = prefix === '' ? e.name : `${prefix}/${e.name}`;
        if (e.mode === '40000') walk(e.sha, path);
        else if (e.mode !== '160000') out.set(path, { sha: e.sha, mode: e.mode });
      }
    };
    walk(treeSha, '');
    return out;
  }

  /** Look a path up under a tree: a blob or tree entry, or undefined. */
  lookup(treeSha: string, path: string): TreeEntry | undefined {
    const parts = path.split('/').filter((p) => p !== '');
    let cur = treeSha;
    let found: TreeEntry | undefined;
    for (let i = 0; i < parts.length; i += 1) {
      found = this.tree(cur).find((e) => e.name === parts[i]);
      if (found === undefined) return undefined;
      if (i < parts.length - 1) {
        if (found.mode !== '40000') return undefined;
        cur = found.sha;
      }
    }
    return found;
  }

  /** A new tree equal to `treeSha` with `path` set to a blob (or removed when blobSha is null). */
  withFile(treeSha: string | undefined, path: string, blobSha: string | null, mode = '100644'): string | undefined {
    const parts = path.split('/').filter((p) => p !== '');
    const rec = (cur: string | undefined, i: number): string | undefined => {
      const entries = cur === undefined ? [] : this.tree(cur);
      const name = parts[i] as string;
      const idx = entries.findIndex((e) => e.name === name);
      if (i === parts.length - 1) {
        if (idx >= 0) entries.splice(idx, 1);
        if (blobSha !== null) entries.push({ mode, name, sha: blobSha });
      } else {
        const child = idx >= 0 && entries[idx]?.mode === '40000' ? (entries[idx] as TreeEntry).sha : undefined;
        const next = rec(child, i + 1);
        if (idx >= 0) entries.splice(idx, 1);
        if (next !== undefined) entries.push({ mode: '40000', name, sha: next });
      }
      if (entries.length === 0) return undefined;
      return this.store.put('tree', encodeTree(entries)).sha;
    };
    return rec(treeSha, 0);
  }

  makeCommit(tree: string, parents: string[], message: string, author: string, committer: string): string {
    return this.store.put('commit', encodeCommit({ tree, parents, author, committer, message })).sha;
  }

  isEmpty(): boolean {
    return this.refs.size === 0;
  }
}

export const EMPTY_TREE_SHA = '4b825dc642cb6eb9a060e54bf8d69288fbfd895e';
export { ZERO };
