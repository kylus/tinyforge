// Git smart HTTP: the ref advertisements, upload-pack (protocol v2: ls-refs and fetch, with shallow
// clones) and receive-pack (v0, fast-forward only). Pure functions of a Repo and a request body; the
// router in app.ts does the HTTP.
import { FLUSH, DELIM, PackError, ZERO, buildPack, ingestPack, parseCommit, parseTag, pkt, readPkts, sideband, type GitObject } from './git.ts';
import type { Repo } from './repo.ts';

const AGENT = 'agent=tinyforge/1';

// ---------------------------------------------------------------- advertisements

export function advertiseV2(): Buffer {
  return Buffer.concat([pkt('version 2\n'), pkt(`${AGENT}\n`), pkt('ls-refs=unborn\n'), pkt('fetch=shallow wait-for-done\n'), pkt('server-option\n'), pkt('object-format=sha1\n'), FLUSH]);
}

/** The v0 advertisement (the ref list with capabilities on the first line) for either service. */
export function advertiseV0(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps = service === 'git-receive-pack'
    ? `report-status delete-refs side-band-64k quiet ofs-delta object-format=sha1 ${AGENT}`
    : `multi_ack_detailed side-band-64k thin-pack ofs-delta shallow no-done symref=HEAD:${repo.headRef()} object-format=sha1 ${AGENT}`;
  const parts: Buffer[] = [pkt(`# service=${service}\n`), FLUSH];
  const lines: string[] = [];
  const head = repo.refs.get(repo.headRef());
  if (service === 'git-upload-pack' && head !== undefined) lines.push(`${head} HEAD`);
  for (const name of [...repo.refs.keys()].sort()) {
    const sha = repo.refs.get(name) as string;
    lines.push(`${sha} ${name}`);
    if (service === 'git-upload-pack' && name.startsWith('refs/tags/') && repo.store.get(sha)?.type === 'tag') lines.push(`${repo.peel(sha)} ${name}^{}`);
  }
  if (lines.length === 0) lines.push(`${ZERO} capabilities^{}`);
  lines.forEach((line, i) => parts.push(pkt(i === 0 ? `${line}\0${caps}\n` : `${line}\n`)));
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- upload-pack, protocol v2

interface Request {
  command: string;
  args: string[];
}

function parseV2Request(body: Buffer): Request {
  const { items } = readPkts(body);
  let command = '';
  const args: string[] = [];
  let afterDelim = false;
  for (const item of items) {
    if (item.kind === 'delim') afterDelim = true;
    else if (item.kind === 'data') {
      const line = item.data.toString('utf8').replace(/\n$/, '');
      if (!afterDelim && line.startsWith('command=')) command = line.slice(8);
      else if (afterDelim) args.push(line);
    }
  }
  return { command, args };
}

export function lsRefs(repo: Repo, body: Buffer): Buffer {
  const { args } = parseV2Request(body);
  const prefixes = args.filter((a) => a.startsWith('ref-prefix ')).map((a) => a.slice(11));
  const symrefs = args.includes('symrefs');
  const peel = args.includes('peel');
  const unborn = args.includes('unborn');
  const wanted = (name: string): boolean => prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));
  const out: Buffer[] = [];
  const headSha = repo.refs.get(repo.headRef());
  if (wanted('HEAD')) {
    if (headSha !== undefined) out.push(pkt(`${headSha} HEAD${symrefs ? ` symref-target:${repo.headRef()}` : ''}\n`));
    else if (unborn) out.push(pkt(`unborn HEAD${symrefs ? ` symref-target:${repo.headRef()}` : ''}\n`));
  }
  for (const name of [...repo.refs.keys()].sort()) {
    if (!wanted(name)) continue;
    const sha = repo.refs.get(name) as string;
    let line = `${sha} ${name}`;
    if (peel && repo.store.get(sha)?.type === 'tag') line += ` peeled:${repo.peel(sha)}`;
    out.push(pkt(`${line}\n`));
  }
  out.push(FLUSH);
  return Buffer.concat(out);
}

/** Every tree and blob under `treeSha` that is not in `seen` (which grows). */
function collectTree(repo: Repo, treeSha: string, seen: Set<string>, into: GitObject[] | null): void {
  const stack = [treeSha];
  while (stack.length > 0) {
    const sha = stack.pop() as string;
    if (seen.has(sha)) continue;
    seen.add(sha);
    const obj = repo.store.get(sha);
    if (obj === undefined) continue;
    if (into !== null) into.push(obj);
    if (obj.type !== 'tree') continue;
    for (const e of repo.tree(sha)) if (e.mode !== '160000') stack.push(e.sha);
  }
}

export function fetchCommand(repo: Repo, body: Buffer): Buffer {
  const { args } = parseV2Request(body);
  const wants: string[] = [];
  const haves: string[] = [];
  const clientShallow = new Set<string>();
  let depth = 0;
  let done = false;
  let includeTag = false;
  let relative = false;
  for (const a of args) {
    if (a.startsWith('want ')) wants.push(a.slice(5).trim());
    else if (a.startsWith('have ')) haves.push(a.slice(5).trim());
    else if (a.startsWith('shallow ')) clientShallow.add(a.slice(8).trim());
    else if (a.startsWith('deepen ') && !a.startsWith('deepen-')) depth = Number.parseInt(a.slice(7), 10) || 0;
    else if (a === 'deepen-relative') relative = true;
    else if (a === 'done') done = true;
    else if (a === 'include-tag') includeTag = true;
  }
  const out: Buffer[] = [];
  for (const w of wants) {
    if (!repo.store.has(w)) return Buffer.concat([pkt(`ERR upload-pack: not our ref ${w}\n`)]);
  }
  const common = haves.filter((h) => repo.store.has(h));
  if (!done) {
    out.push(pkt('acknowledgments\n'));
    if (common.length === 0) out.push(pkt('NAK\n'));
    for (const c of common) out.push(pkt(`ACK ${c}\n`));
    if (common.length === 0) {
      out.push(FLUSH);
      return Buffer.concat(out);
    }
    out.push(pkt('ready\n'), DELIM);
  }

  // Commits the client already holds: everything behind its common haves, not crossing its shallow roots.
  const held = new Set<string>();
  {
    const stack = [...common.map((c) => repo.peel(c))];
    while (stack.length > 0) {
      const sha = stack.pop() as string;
      if (held.has(sha)) continue;
      held.add(sha);
      if (clientShallow.has(sha)) continue;
      for (const p of repo.commit(sha)?.parents ?? []) stack.push(p);
    }
  }

  // `deepen-relative` counts from the client's current shallow commits, not from the wants: turn it into
  // an absolute depth by finding how far below the wants the deepest of them sits.
  if (relative && depth > 0 && clientShallow.size > 0) {
    const dist = new Map<string, number>();
    let layer = wants.map((w) => repo.peel(w));
    for (let d = 1; layer.length > 0; d += 1) {
      const next: string[] = [];
      for (const sha of layer) {
        if (dist.has(sha)) continue;
        dist.set(sha, d);
        for (const p of repo.commit(sha)?.parents ?? []) next.push(p);
      }
      layer = next;
    }
    let deepest = 0;
    for (const s of clientShallow) deepest = Math.max(deepest, dist.get(s) ?? 0);
    depth += deepest;
  }

  // The commits to send, and for a depth request, the new shallow boundary.
  const send = new Set<string>();
  const boundary = new Set<string>();
  const tags: GitObject[] = [];
  const walkRoots: string[] = [];
  for (const w of wants) {
    const peeled = repo.peel(w);
    if (peeled !== w) {
      let cur = w;
      for (let i = 0; i < 16; i += 1) {
        const o = repo.store.get(cur);
        if (o === undefined || o.type !== 'tag') break;
        tags.push(o);
        cur = parseTag(o.data).object;
      }
    }
    walkRoots.push(peeled);
  }
  const level = new Map<string, number>();
  let frontier = walkRoots.filter((r) => repo.store.get(r)?.type === 'commit');
  const rootObjects = walkRoots.filter((r) => repo.store.get(r)?.type !== 'commit');
  for (let lv = 1; frontier.length > 0; lv += 1) {
    const next: string[] = [];
    for (const sha of frontier) {
      if (level.has(sha)) continue;
      level.set(sha, lv);
      const parents = repo.commit(sha)?.parents ?? [];
      if (depth > 0 && lv >= depth) {
        if (parents.length > 0) boundary.add(sha);
        continue;
      }
      if (depth === 0 && held.has(sha)) continue;
      for (const p of parents) next.push(p);
    }
    frontier = next;
  }
  for (const sha of level.keys()) if (!held.has(sha)) send.add(sha);

  // Trees the client already has: the tips it holds and the parents just outside what we send.
  const knownTrees = new Set<string>();
  const knownRoots = new Set<string>(common.map((c) => repo.peel(c)));
  for (const sha of send) for (const p of repo.commit(sha)?.parents ?? []) if (held.has(p) && !clientShallow.has(p)) knownRoots.add(p);
  for (const sha of knownRoots) {
    const c = repo.commit(sha);
    if (c !== undefined) collectTree(repo, c.tree, knownTrees, null);
  }

  const objects: GitObject[] = [...tags];
  const seenObjects = new Set<string>(knownTrees);
  for (const sha of send) {
    const o = repo.store.get(sha) as GitObject;
    objects.push(o);
    collectTree(repo, parseCommit(o.data).tree, seenObjects, objects);
  }
  for (const r of rootObjects) {
    const o = repo.store.get(r);
    if (o !== undefined && o.type === 'tree') collectTree(repo, r, seenObjects, objects);
    else if (o !== undefined && !seenObjects.has(r)) {
      seenObjects.add(r);
      objects.push(o);
    }
  }
  if (includeTag) {
    const have = new Set(objects.map((o) => o.sha));
    for (const [name, sha] of repo.refs) {
      const o = repo.store.get(sha);
      if (name.startsWith('refs/tags/') && o !== undefined && o.type === 'tag' && !have.has(sha) && send.has(repo.peel(sha))) objects.push(o);
    }
  }

  if (depth > 0) {
    out.push(pkt('shallow-info\n'));
    for (const b of boundary) if (!clientShallow.has(b)) out.push(pkt(`shallow ${b}\n`));
    for (const s of clientShallow) if (level.has(s) && !boundary.has(s)) out.push(pkt(`unshallow ${s}\n`));
    out.push(DELIM);
  }
  out.push(pkt('packfile\n'), sideband(1, buildPack(objects)), FLUSH);
  return Buffer.concat(out);
}

// ---------------------------------------------------------------- receive-pack

export interface PushResult {
  response: Buffer;
  /** Branches whose tip moved (for pull request bookkeeping). */
  changed: string[];
}

/** Handle a receive-pack POST: commands, then a pack; answer with the report-status. */
export function receivePack(repo: Repo, body: Buffer, now: string): PushResult {
  const { items, pos } = readPkts(body, 0, 1);
  const commands: { old: string; neu: string; ref: string }[] = [];
  let caps = '';
  for (const item of items) {
    if (item.kind !== 'data') continue;
    let line = item.data.toString('utf8');
    const nul = line.indexOf('\0');
    if (nul >= 0) {
      caps = line.slice(nul + 1);
      line = line.slice(0, nul);
    }
    line = line.replace(/\n$/, '');
    if (line.startsWith('shallow ')) continue;
    const m = /^([0-9a-f]{40}) ([0-9a-f]{40}) (.+)$/.exec(line);
    if (m !== null) commands.push({ old: m[1] as string, neu: m[2] as string, ref: m[3] as string });
  }
  const useSideband = caps.split(/\s+/).includes('side-band-64k');
  let unpack = 'ok';
  const packBytes = body.subarray(pos);
  const needsPack = commands.some((c) => c.neu !== ZERO);
  if (needsPack && packBytes.length > 0) {
    try {
      ingestPack(packBytes, repo.store);
    } catch (err) {
      unpack = err instanceof PackError || err instanceof Error ? `error ${err.message}` : 'error';
    }
  }
  const lines: Buffer[] = [pkt(`unpack ${unpack}\n`)];
  const changed: string[] = [];
  for (const cmd of commands) {
    const fail = (why: string): void => void lines.push(pkt(`ng ${cmd.ref} ${why}\n`));
    if (unpack !== 'ok') {
      fail('unpacker error');
      continue;
    }
    if (!cmd.ref.startsWith('refs/') || /[\s~^:?*[\\]|\.\.|\/\/|\.lock$|\/$/.test(cmd.ref)) {
      fail('funny refname');
      continue;
    }
    const current = repo.refs.get(cmd.ref);
    if (cmd.neu === ZERO) {
      if (current === undefined) fail('ref does not exist');
      else if (cmd.old !== ZERO && cmd.old !== current) fail('stale info');
      else if (cmd.ref === repo.headRef() && repo.refs.size > 1) fail('deletion of the current branch prohibited');
      else {
        repo.refs.delete(cmd.ref);
        if (cmd.ref.startsWith('refs/heads/')) changed.push(cmd.ref.slice(11));
        lines.push(pkt(`ok ${cmd.ref}\n`));
      }
      continue;
    }
    const obj = repo.store.get(cmd.neu);
    if (obj === undefined) {
      fail('missing necessary objects');
      continue;
    }
    if (cmd.ref.startsWith('refs/heads/') && obj.type !== 'commit') {
      fail('not a commit');
      continue;
    }
    if (current === undefined) {
      if (cmd.old !== ZERO) fail('stale info');
      else {
        repo.refs.set(cmd.ref, cmd.neu);
        if (cmd.ref.startsWith('refs/heads/')) changed.push(cmd.ref.slice(11));
        lines.push(pkt(`ok ${cmd.ref}\n`));
      }
      continue;
    }
    if (cmd.old !== current) fail(cmd.old === ZERO ? 'already exists' : 'stale info');
    else if (!cmd.ref.startsWith('refs/heads/') || !repo.isAncestor(current, cmd.neu)) fail('non-fast-forward');
    else {
      repo.refs.set(cmd.ref, cmd.neu);
      changed.push(cmd.ref.slice(11));
      lines.push(pkt(`ok ${cmd.ref}\n`));
    }
  }
  lines.push(FLUSH);
  repo.pushed_at = now;
  repo.updated_at = now;
  const report = Buffer.concat(lines);
  return { response: useSideband ? Buffer.concat([sideband(1, report), FLUSH]) : report, changed };
}
