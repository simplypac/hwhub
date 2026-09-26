import { scrypt, randomBytes, timingSafeEqual, createHash, createCipheriv, createDecipheriv, randomUUID } from "node:crypto";
import { config } from "./config.js";

/* Passwords: scrypt with a random salt per user. */
const N = 16384, R = 8, P = 1, KEYLEN = 64;
const scryptAsync = (pw, salt) => new Promise((ok, fail) =>
  scrypt(pw, salt, KEYLEN, { N, r: R, p: P, maxmem: 64 * 1024 * 1024 }, (e, k) => e ? fail(e) : ok(k)));

export async function hashPassword(pw) {
  const salt = randomBytes(16);
  const key = await scryptAsync(pw.normalize("NFKC"), salt);
  return `scrypt$${N}$${R}$${P}$${salt.toString("base64url")}$${key.toString("base64url")}`;
}
export async function verifyPassword(pw, stored) {
  const [alg, n, r, p, salt, hash] = String(stored).split("$");
  if (alg !== "scrypt" || +n !== N || +r !== R || +p !== P) return false;
  const key = await scryptAsync(pw.normalize("NFKC"), Buffer.from(salt, "base64url"));
  const want = Buffer.from(hash, "base64url");
  return key.length === want.length && timingSafeEqual(key, want);
}
// Used when the email isn't found, so login takes the same time either way.
export const DUMMY_HASH = "scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA$" + "A".repeat(86);

/* Tokens */
export const randomToken = (bytes = 32) => randomBytes(bytes).toString("base64url");
export const sha256 = s => createHash("sha256").update(s).digest("hex");
export const newId = () => randomUUID();
export function inboundToken() {
  const alphabet = "abcdefghjkmnpqrstuvwxyz23456789"; // no look-alikes; email local parts are case-insensitive
  const b = randomBytes(12);
  return Array.from(b, x => alphabet[x % alphabet.length]).join("");
}

/* Encryption for stored secrets (calendar links, Google refresh tokens). AES-256-GCM. */
const key = () => createHash("sha256").update("hh-secrets:" + config.secretKey).digest();
export function encrypt(text) {
  if (text == null) return null;
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key(), iv);
  const ct = Buffer.concat([c.update(String(text), "utf8"), c.final()]);
  return ["v1", iv.toString("base64url"), c.getAuthTag().toString("base64url"), ct.toString("base64url")].join(".");
}
export function decrypt(payload) {
  if (!payload) return null;
  const [v, iv, tag, ct] = payload.split(".");
  if (v !== "v1") throw new Error("Unknown secret format");
  const d = createDecipheriv("aes-256-gcm", key(), Buffer.from(iv, "base64url"));
  d.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([d.update(Buffer.from(ct, "base64url")), d.final()]).toString("utf8");
}

/* Signed short-lived values (OAuth state). */
import { createHmac } from "node:crypto";
export function sign(value, ttlMs = 10 * 60e3) {
  const body = Buffer.from(JSON.stringify({ v: value, exp: Date.now() + ttlMs })).toString("base64url");
  const mac = createHmac("sha256", config.secretKey).update(body).digest("base64url");
  return `${body}.${mac}`;
}
export function unsign(token) {
  const [body, mac] = String(token || "").split(".");
  if (!body || !mac) return null;
  const want = createHmac("sha256", config.secretKey).update(body).digest("base64url");
  if (mac.length !== want.length || !timingSafeEqual(Buffer.from(mac), Buffer.from(want))) return null;
  try { const { v, exp } = JSON.parse(Buffer.from(body, "base64url").toString()); return exp > Date.now() ? v : null; }
  catch { return null; }
}

/* Simple in-memory rate limiter (per process). */
export function rateLimiter({ max, windowMs }) {
  const hits = new Map();
  setInterval(() => { const now = Date.now(); for (const [k, v] of hits) if (v.reset < now) hits.delete(k); }, windowMs).unref();
  return key => {
    const now = Date.now();
    let h = hits.get(key);
    if (!h || h.reset < now) { h = { n: 0, reset: now + windowMs }; hits.set(key, h); }
    h.n++;
    return h.n <= max;
  };
}
