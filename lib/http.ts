// A small HTTP/1.1 server on node:net. node:http spends most of a request's time building request and
// response objects the forge never needs; every route here is a function from (method, target, headers,
// body) to (status, headers, body), so this loop parses the request itself and writes one buffer back.
//
// What it speaks: keep-alive and pipelining, Content-Length and chunked request bodies, Expect:
// 100-continue, HEAD, Connection: close and HTTP/1.0. What it does not: upgrades, trailers, or request
// targets other than origin-form.
import { createServer, type Server, type Socket } from 'node:net';

export interface HttpRequest {
  method: string;
  target: string;
  headers: Record<string, string>;
  body: Buffer;
}

export interface HttpResponse {
  status: number;
  headers?: Record<string, string>;
  body?: Buffer | string;
}

export type Handler = (req: HttpRequest) => HttpResponse;

const REASONS: Record<number, string> = {
  100: 'Continue',
  200: 'OK',
  201: 'Created',
  202: 'Accepted',
  204: 'No Content',
  304: 'Not Modified',
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  405: 'Method Not Allowed',
  409: 'Conflict',
  413: 'Payload Too Large',
  422: 'Unprocessable Entity',
  431: 'Request Header Fields Too Large',
  500: 'Internal Server Error',
};

const MAX_HEADER_BYTES = 64 * 1024;
const MAX_BODY_BYTES = 512 * 1024 * 1024;
const CRLFCRLF = Buffer.from('\r\n\r\n');

let dateText = new Date().toUTCString();
let dateAt = 0;
function httpDate(): string {
  const now = Date.now();
  if (now - dateAt > 1000) {
    dateAt = now;
    dateText = new Date(now).toUTCString();
  }
  return dateText;
}

/** Decode a chunked body that starts at `buf[0]`; null while it is still incomplete. */
function decodeChunked(buf: Buffer): { body: Buffer; used: number } | null | 'bad' {
  const parts: Buffer[] = [];
  let pos = 0;
  for (;;) {
    const eol = buf.indexOf('\r\n', pos);
    if (eol < 0) return null;
    const size = Number.parseInt(buf.toString('latin1', pos, eol).split(';')[0] as string, 16);
    if (Number.isNaN(size) || size < 0) return 'bad';
    pos = eol + 2;
    if (size === 0) {
      // Skip any trailers up to the blank line.
      for (;;) {
        const end = buf.indexOf('\r\n', pos);
        if (end < 0) return null;
        const empty = end === pos;
        pos = end + 2;
        if (empty) return { body: Buffer.concat(parts), used: pos };
      }
    }
    if (pos + size + 2 > buf.length) return null;
    parts.push(buf.subarray(pos, pos + size));
    pos += size + 2;
  }
}

function serialise(res: HttpResponse, head: boolean, close: boolean, version: string): Buffer | string {
  const body = res.body === undefined ? '' : res.body;
  const length = typeof body === 'string' ? Buffer.byteLength(body) : body.length;
  let text = `HTTP/1.1 ${res.status} ${REASONS[res.status] ?? 'Status'}\r\ndate: ${httpDate()}\r\n`;
  const headers = res.headers;
  if (headers !== undefined) for (const k in headers) text += `${k}: ${headers[k]}\r\n`;
  if (res.status !== 204 && res.status !== 304) text += `content-length: ${length}\r\n`;
  if (close) text += 'connection: close\r\n';
  else if (version === 'HTTP/1.0') text += 'connection: keep-alive\r\n';
  text += '\r\n';
  if (head || res.status === 204 || res.status === 304 || length === 0) return text;
  if (typeof body === 'string') return text + body;
  return Buffer.concat([Buffer.from(text, 'latin1'), body]);
}

export function createHttpServer(handler: Handler): Server {
  return createServer({ noDelay: true, keepAlive: true }, (sock: Socket) => {
    let buf: Buffer = Buffer.alloc(0);
    let sentContinue = false;
    let closed = false;
    sock.on('error', () => sock.destroy());
    sock.on('close', () => {
      closed = true;
    });
    const fail = (status: number): void => {
      sock.end(serialise({ status, headers: { 'content-type': 'application/json' }, body: '{"message":"Bad Request"}' }, false, true, 'HTTP/1.1'));
    };
    const drain = (): void => {
      while (!closed && buf.length > 0) {
        const headEnd = buf.indexOf(CRLFCRLF);
        if (headEnd < 0) {
          if (buf.length > MAX_HEADER_BYTES) fail(431);
          return;
        }
        const head = buf.toString('latin1', 0, headEnd);
        const lines = head.split('\r\n');
        const first = lines[0] as string;
        const s1 = first.indexOf(' ');
        const s2 = first.lastIndexOf(' ');
        if (s1 <= 0 || s2 <= s1) {
          fail(400);
          return;
        }
        const method = first.slice(0, s1);
        const target = first.slice(s1 + 1, s2);
        const version = first.slice(s2 + 1);
        const headers: Record<string, string> = {};
        for (let i = 1; i < lines.length; i += 1) {
          const line = lines[i] as string;
          const colon = line.indexOf(':');
          if (colon <= 0) continue;
          const name = line.slice(0, colon).toLowerCase();
          const value = line.slice(colon + 1).trim();
          headers[name] = name in headers ? `${headers[name]}, ${value}` : value;
        }
        let body: Buffer = Buffer.alloc(0);
        let used = headEnd + 4;
        if ((headers['transfer-encoding'] ?? '').toLowerCase().includes('chunked')) {
          if (headers.expect !== undefined && !sentContinue) {
            sentContinue = true;
            sock.write('HTTP/1.1 100 Continue\r\n\r\n');
          }
          const dec = decodeChunked(buf.subarray(used));
          if (dec === null) return;
          if (dec === 'bad') {
            fail(400);
            return;
          }
          body = dec.body;
          used += dec.used;
        } else if (headers['content-length'] !== undefined) {
          const n = Number(headers['content-length']);
          if (!Number.isInteger(n) || n < 0 || n > MAX_BODY_BYTES) {
            fail(n > MAX_BODY_BYTES ? 413 : 400);
            return;
          }
          if (buf.length < used + n) {
            if (headers.expect !== undefined && !sentContinue) {
              sentContinue = true;
              sock.write('HTTP/1.1 100 Continue\r\n\r\n');
            }
            return;
          }
          body = buf.subarray(used, used + n);
          used += n;
        }
        sentContinue = false;
        buf = buf.subarray(used);
        const wantsClose = (headers.connection ?? '').toLowerCase().includes('close') || (version === 'HTTP/1.0' && !(headers.connection ?? '').toLowerCase().includes('keep-alive'));
        let res: HttpResponse;
        try {
          res = handler({ method, target, headers, body });
        } catch (err) {
          res = { status: 500, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message: `Server Error: ${err instanceof Error ? err.message : 'error'}` }) };
        }
        const out = serialise(res, method === 'HEAD', wantsClose, version);
        sock.write(out);
        if (wantsClose) {
          sock.end();
          return;
        }
      }
    };
    sock.on('data', (chunk: Buffer) => {
      buf = buf.length === 0 ? chunk : Buffer.concat([buf, chunk]);
      drain();
    });
  });
}

export type { Server };
