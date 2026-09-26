import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, sep } from "node:path";

export class HttpError extends Error {
  constructor(status, code, message) { super(message || code); this.status = status; this.code = code; }
}
export const bad = (code, message) => new HttpError(400, code, message);

export function createRouter() {
  const routes = [];
  const add = method => (path, ...handlers) => {
    const keys = [];
    const re = new RegExp("^" + path.replace(/:(\w+)/g, (_, k) => (keys.push(k), "([^/]+)")) + "/?$");
    routes.push({ method, re, keys, handlers });
  };
  return {
    get: add("GET"), post: add("POST"), patch: add("PATCH"), delete: add("DELETE"), options: add("OPTIONS"),
    match(method, path) {
      let pathMatched = false;
      for (const r of routes) {
        const m = path.match(r.re);
        if (!m) continue;
        pathMatched = true;
        if (r.method !== method) continue;
        const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
        return { handlers: r.handlers, params };
      }
      return pathMatched ? { methodNotAllowed: true } : null;
    },
  };
}

export async function readBody(req, limit) {
  const chunks = []; let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw new HttpError(413, "too_large", "That's too much data.");
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}
export async function readJSON(req, limit = 100_000) {
  const buf = await readBody(req, limit);
  if (!buf.length) return {};
  try { const v = JSON.parse(buf.toString("utf8")); return v && typeof v === "object" ? v : {}; }
  catch { throw bad("bad_json", "Couldn't read the request."); }
}

export function parseCookies(header = "") {
  const out = {};
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
export function cookie(name, value, { maxAge, secure, httpOnly = true, sameSite = "Lax", path = "/" } = {}) {
  let s = `${name}=${encodeURIComponent(value)}; Path=${path}; SameSite=${sameSite}`;
  if (maxAge !== undefined) s += `; Max-Age=${maxAge}`;
  if (httpOnly) s += "; HttpOnly";
  if (secure) s += "; Secure";
  return s;
}

export function send(res, status, body, headers = {}) {
  if (res.headersSent) return;
  const isJSON = body !== undefined && typeof body !== "string" && !Buffer.isBuffer(body);
  res.writeHead(status, { ...(isJSON ? { "Content-Type": "application/json; charset=utf-8" } : {}), "Cache-Control": "no-store", ...headers });
  res.end(body === undefined ? undefined : isJSON ? JSON.stringify(body) : body);
}
export function redirect(res, location, headers = {}) {
  res.writeHead(302, { Location: location, "Cache-Control": "no-store", ...headers }); res.end();
}

export function clientIp(req) {
  const xf = req.headers["x-forwarded-for"];
  // The hosting proxy appends the real client address last; earlier entries can be faked by the client.
  return (typeof xf === "string" && xf.split(",").pop().trim()) || req.socket.remoteAddress || "?";
}

const TYPES = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json", ".webmanifest": "application/manifest+json", ".png": "image/png", ".svg": "image/svg+xml",
  ".ico": "image/x-icon", ".txt": "text/plain; charset=utf-8",
};
export async function serveStatic(req, res, root, pathname, headers) {
  let p = pathname === "/" ? "/index.html" : pathname;
  const full = normalize(join(root, decodeURIComponent(p)));
  if (!full.startsWith(root + sep) && full !== root) return false;
  try {
    const st = await stat(full);
    if (!st.isFile()) return false;
    const type = TYPES[extname(full)] || "application/octet-stream";
    const cache = /\.(png|svg|ico)$/.test(full) ? "public, max-age=86400" : "no-cache";
    res.writeHead(200, { "Content-Type": type, "Cache-Control": cache, ...headers });
    res.end(req.method === "HEAD" ? undefined : await readFile(full));
    return true;
  } catch { return false; }
}
