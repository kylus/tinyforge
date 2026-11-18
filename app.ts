// The forge's HTTP surface: authentication, request bodies, and routing to the four surfaces (git smart
// HTTP, REST v3, GraphQL v4, MCP). Everything it answers comes out of lib/; lib/http.ts carries the bytes.
import { createHttpServer, type HttpRequest, type HttpResponse, type Server } from './lib/http.ts';
import { gunzipSync, inflateSync } from 'node:zlib';
import { Forge, isoNow } from './lib/forge.ts';
import { advertiseV0, advertiseV2, fetchCommand, lsRefs, receivePack } from './lib/githttp.ts';
import { ApiError } from './lib/ops.ts';
import { handleRest } from './lib/rest.ts';
import { handleGraphql } from './lib/graphql.ts';
import { handleMcp } from './lib/mcp.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const DOCS = 'https://docs.github.com/rest';
const NO_CACHE = { 'cache-control': 'no-cache, max-age=0, must-revalidate', expires: 'Fri, 01 Jan 1980 00:00:00 GMT', pragma: 'no-cache' };
const ADVERT_V2 = advertiseV2();
const FETCH_CACHE_LIMIT = 64;
/** Shared by every request without a query string; readers copy it (paginate does) and never write to it. */
const NO_QUERY = new URLSearchParams();

let counter = 0;
/** A request id: unique per request and never empty. */
function requestId(): string {
  counter += 1;
  return `${(0x5a17c0de + counter).toString(16).toUpperCase()}:${counter.toString(16).toUpperCase()}`;
}

function reply(status: number, body: Buffer | string | undefined, headers: Record<string, string>): HttpResponse {
  const h: Record<string, string> = { 'x-github-request-id': requestId(), ...headers };
  return body === undefined ? { status, headers: h } : { status, headers: h, body };
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): HttpResponse {
  if (status === 204) return reply(204, undefined, headers);
  return reply(status, JSON.stringify(body), { 'content-type': JSON_TYPE, ...headers });
}

const notFound = (): HttpResponse => json(404, { message: 'Not Found', documentation_url: DOCS });

function errorBody(err: ApiError): Record<string, unknown> {
  const body: Record<string, unknown> = { message: err.message, documentation_url: DOCS };
  if (err.errors !== undefined) body.errors = err.errors;
  return body;
}

function split(target: string): { path: string; query: string } {
  const q = target.indexOf('?');
  return q < 0 ? { path: target, query: '' } : { path: target.slice(0, q), query: target.slice(q + 1) };
}

function segmentsOf(path: string): string[] | undefined {
  try {
    const out: string[] = [];
    for (const s of path.split('/')) if (s !== '') out.push(s.includes('%') ? decodeURIComponent(s) : s);
    return out;
  } catch {
    return undefined;
  }
}

/** Build the server. It binds nothing until the caller listens. */
export function createApp(): Server {
  const forge = new Forge(process.env.MAKEFUN_SHOP_TOKEN ?? '');
  return createHttpServer((req) => route(forge, req));
}

function route(forge: Forge, req: HttpRequest): HttpResponse {
  const { method, headers } = req;
  const { path, query } = split(req.target);
  if (path === '/healthz') return method === 'GET' ? json(200, { ok: true }) : json(405, { message: 'Method Not Allowed' });
  const origin = `http://${headers.host ?? 'localhost'}`;
  const authed = forge.authorised(headers.authorization);
  const segs = segmentsOf(path);
  if (segs === undefined) return notFound();

  let body = req.body;
  const enc = headers['content-encoding'];
  if (body.length > 0 && enc === 'gzip') body = gunzipSync(body);
  else if (body.length > 0 && enc === 'deflate') body = inflateSync(body);

  // ---- git smart HTTP: /<owner>/<repo>.git/...
  if (segs.length >= 3 && (segs[1] as string).endsWith('.git') && (segs[2] === 'info' || segs[2] === 'git-upload-pack' || segs[2] === 'git-receive-pack')) {
    if (!authed) return reply(401, JSON.stringify({ message: 'Requires authentication', documentation_url: DOCS }), { 'content-type': JSON_TYPE, 'www-authenticate': 'Basic realm="tinyforge"' });
    const repo = forge.find(segs[0] as string, (segs[1] as string).slice(0, -4));
    if (repo === undefined) return notFound();
    if (segs[2] === 'info' && segs[3] === 'refs' && method === 'GET') {
      const service = new URLSearchParams(query).get('service');
      if (service !== 'git-upload-pack' && service !== 'git-receive-pack') return json(403, { message: 'Dumb HTTP is not supported', documentation_url: DOCS });
      const v2 = service === 'git-upload-pack' && (headers['git-protocol'] ?? '').includes('version=2');
      return reply(200, v2 ? ADVERT_V2 : advertiseV0(repo, service), { 'content-type': `application/x-${service}-advertisement`, ...NO_CACHE });
    }
    if (method === 'POST' && segs[2] === 'git-upload-pack') {
      const text = body.toString('latin1', 0, Math.min(body.length, 80));
      let out: Buffer;
      if (text.includes('command=ls-refs')) out = lsRefs(repo, body);
      else if (text.includes('command=fetch')) {
        const key = body.toString('latin1');
        const hit = repo.packCache.get(key);
        if (hit !== undefined) out = hit;
        else {
          out = fetchCommand(repo, body);
          if (out.length < 4 || out.toString('latin1', 4, 7) !== 'ERR') {
            if (repo.packCache.size >= FETCH_CACHE_LIMIT) repo.packCache.clear();
            repo.packCache.set(key, out);
          }
        }
      } else out = Buffer.from('0000', 'latin1');
      return reply(200, out, { 'content-type': 'application/x-git-upload-pack-result', ...NO_CACHE });
    }
    if (method === 'POST' && segs[2] === 'git-receive-pack') {
      return reply(200, receivePack(repo, body, isoNow()).response, { 'content-type': 'application/x-git-receive-pack-result', ...NO_CACHE });
    }
    return notFound();
  }

  // ---- JSON surfaces
  const first = segs[0];
  const isRest = first === 'api' && segs[1] === 'v3';
  const isGraphql = first === 'api' && segs[1] === 'graphql' && segs.length === 2;
  const isMcp = first === 'mcp' && segs.length === 1;
  if (!isRest && !isGraphql && !isMcp) return notFound();
  if (!authed) return json(401, { message: 'Requires authentication', documentation_url: DOCS }, { 'www-authenticate': 'Bearer' });
  let parsed: unknown;
  if (body.length > 0 && method !== 'GET' && method !== 'HEAD') {
    try {
      parsed = JSON.parse(body.toString('utf8'));
    } catch {
      return isMcp ? json(400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }) : json(400, { message: 'Problems parsing JSON', documentation_url: DOCS });
    }
  }
  try {
    if (isRest) {
      const r = handleRest(forge, { method, segs: segs.slice(2), query: query === '' ? NO_QUERY : new URLSearchParams(query), body: parsed, origin, path });
      return json(r.status, r.body, r.headers ?? {});
    }
    if (isGraphql) {
      if (method !== 'POST') throw new ApiError(404, 'Not Found');
      return json(200, handleGraphql(forge, parsed, origin));
    }
    const r = handleMcp(forge, method, parsed, origin, headers);
    return r.body === undefined ? reply(r.status, undefined, r.headers ?? {}) : json(r.status, r.body, r.headers ?? {});
  } catch (err) {
    if (err instanceof ApiError) return json(err.status, errorBody(err));
    throw err;
  }
}
