// The forge's shared state and its identity rule.
//
// One bearer token (MAKEFUN_SHOP_TOKEN) names one account, but nothing tells the process the login. So
// the forge learns it: repositories made through POST /user/repos wait without an owner until a request
// names an owner for one of them, and that name becomes the token's login (see claim()). From then on a
// repository under any other owner is 404, never 403.
import { Repo } from './repo.ts';

export interface Identity {
  login: string;
  id: number;
  name: string;
  email: string;
}

export function isoNow(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export class Forge {
  readonly token: string;
  login: string | null = null;
  private readonly repos = new Map<string, Repo>();
  private nextRepoId = 1000;
  private nextCommentId = 1;
  private nextGlobalId = 1;

  constructor(token: string) {
    this.token = token;
  }

  authorised(header: string | undefined): boolean {
    if (header === undefined) return false;
    if (this.token !== '' && header === `Bearer ${this.token}`) return true;
    const m = /^(?:bearer|token)\s+(.+)$/i.exec(header.trim());
    return m !== null && (this.token === '' || m[1] === this.token);
  }

  me(): Identity {
    const login = this.login ?? 'octocat';
    return { login, id: 1000, name: login, email: `${login}@users.noreply.example` };
  }

  newCommentId(): number {
    return this.nextCommentId++;
  }

  newId(): number {
    return this.nextGlobalId++;
  }

  private key(owner: string, name: string): string {
    return `${owner.toLowerCase()}/${name.toLowerCase()}`;
  }

  create(name: string, isPrivate: boolean, description: string | null, defaultBranch = 'main'): Repo {
    const repo = new Repo(this.nextRepoId++, this.login ?? '', name, isPrivate, description, defaultBranch, isoNow());
    this.repos.set(this.key(this.login ?? '', name), repo);
    return repo;
  }

  exists(name: string): boolean {
    return this.repos.has(this.key(this.login ?? '', name));
  }

  /** The repository `owner/name` as this token sees it, or undefined (a stranger's, or none). */
  find(owner: string, name: string): Repo | undefined {
    if (this.login === null) this.claim(owner, name);
    if (this.login === null || owner.toLowerCase() !== this.login.toLowerCase()) return undefined;
    return this.repos.get(this.key(this.login, name));
  }

  /** The first owner named for a repository that is waiting for one becomes the token's login. */
  private claim(owner: string, name: string): void {
    const waiting = this.repos.get(this.key('', name));
    if (waiting === undefined) return;
    this.login = owner;
    for (const [k, repo] of [...this.repos]) {
      if (repo.owner !== '') continue;
      this.repos.delete(k);
      repo.owner = owner;
      this.repos.set(this.key(owner, repo.name), repo);
    }
  }

  adopt(repo: Repo): void {
    this.repos.set(this.key(repo.owner, repo.name), repo);
  }

  remove(repo: Repo): void {
    this.repos.delete(this.key(repo.owner, repo.name));
  }

  list(): Repo[] {
    return [...this.repos.values()];
  }

  /** Repository by its node id (GraphQL and MCP hand these back). */
  byId(id: number): Repo | undefined {
    return this.list().find((r) => r.id === id);
  }
}

export function repoNodeId(id: number): string {
  return `R_${Buffer.from(`010:Repository${id}`).toString('base64url')}`;
}

export function decodeRepoNodeId(node: string): number | undefined {
  if (!node.startsWith('R_')) return undefined;
  const m = /^010:Repository(\d+)$/.exec(Buffer.from(node.slice(2), 'base64url').toString('utf8'));
  return m === null ? undefined : Number(m[1]);
}

/** An opaque global id: a kind prefix and the base64url of its colon-joined parts. */
export function nodeId(kind: string, ...parts: (string | number)[]): string {
  return `${kind}_${Buffer.from(parts.join(':')).toString('base64url')}`;
}

export function parseNodeId(id: string): { kind: string; parts: string[] } | undefined {
  const at = id.indexOf('_');
  if (at <= 0) return undefined;
  return { kind: id.slice(0, at), parts: Buffer.from(id.slice(at + 1), 'base64url').toString('utf8').split(':') };
}
