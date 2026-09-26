import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { timingSafeEqual, createHash } from "node:crypto";
import { config, features } from "./config.js";
import { assignmentOut, parseJSON, tx } from "./db.js";
import { createRouter, readJSON, readBody, parseCookies, cookie, send, redirect, serveStatic, clientIp, HttpError, bad } from "./http.js";
import { hashPassword, verifyPassword, DUMMY_HASH, randomToken, sha256, newId, inboundToken, sign, unsign, rateLimiter } from "./security.js";
import { aiEnabled, aiExtract, aiPlan } from "./ai.js";
import { upsert, RANK, logIngest } from "./sync/ingest.js";
import { processEmail, pasteRules, normalizePlatform } from "./sync/email.js";
import { parseMime, addressesIn } from "./sync/mime.js";
import { saveManageBac, syncManageBac } from "./sync/managebac.js";
import { googleAuthUrl, exchangeCode, saveGoogle, revokeGoogle } from "./sync/gmail.js";
import { runConnection } from "./sync/scheduler.js";
import { parseDueFromText } from "./dates.js";
import { detectSubject } from "./sync/ics.js";

const PUBLIC_DIR = fileURLToPath(new URL("../public", import.meta.url));
const SESSION_DAYS = 30;
const SOURCES = ["ManageBac", "Kognity", "K12net", "Padlet", "Classroom", "Teams", "WhatsApp", "Email", "Other"];


/* ---------------- validation ---------------- */
const str = (v, max, name, { required = false } = {}) => {
  if (v == null || v === "") { if (required) throw bad("missing_" + name, `Please fill in ${name}.`); return ""; }
  if (typeof v !== "string") throw bad("bad_" + name, `Invalid ${name}.`);
  const s = v.trim();
  if (s.length > max) throw bad("long_" + name, `${name[0].toUpperCase() + name.slice(1)} is too long.`);
  if (required && !s) throw bad("missing_" + name, `Please fill in ${name}.`);
  return s;
};
const validEmail = e => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e) && e.length <= 200;
const validTz = tz => { try { new Intl.DateTimeFormat("en", { timeZone: tz }); return true; } catch { return false; } };
const isoOrNull = v => { if (v == null || v === "") return null; const d = new Date(v); if (isNaN(d)) throw bad("bad_due", "Invalid due date."); return d.toISOString(); };
const reqList = v => Array.isArray(v) ? v.filter(x => typeof x === "string").map(x => x.trim()).filter(Boolean).slice(0, 8).map(x => x.slice(0, 200)) : [];
const safeLink = v => typeof v === "string" && /^https:\/\/[^\s]{3,500}$/.test(v) ? v : null;

/* ---------------- sessions ---------------- */
function createSession(db, res, user, req) {
  const token = randomToken(32), now = Date.now();
  db.prepare("INSERT INTO sessions (token_hash, user_id, created_at, expires_at, ua) VALUES (?, ?, ?, ?, ?)")
    .run(sha256(token), user.id, now, now + SESSION_DAYS * 864e5, String(req.headers["user-agent"] || "").slice(0, 200));
  res.setHeader("Set-Cookie", cookie("hh_session", token, { maxAge: SESSION_DAYS * 86400, secure: config.secureCookies }));
}
function authenticate(db, req) {
  const bearer = (req.headers.authorization || "").match(/^Bearer\s+(hh_[\w-]{20,})$/);
  if (bearer) {
    const row = db.prepare("SELECT u.*, t.id AS token_id FROM api_tokens t JOIN users u ON u.id = t.user_id WHERE t.token_hash = ?").get(sha256(bearer[1]));
    if (!row) return null;
    db.prepare("UPDATE api_tokens SET last_used = ? WHERE id = ?").run(Date.now(), row.token_id);
    return { user: row, via: "token" };
  }
  const token = parseCookies(req.headers.cookie).hh_session;
  if (!token) return null;
  const row = db.prepare("SELECT u.*, s.expires_at, s.token_hash FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?").get(sha256(token));
  if (!row || row.expires_at < Date.now()) return null;
  if (row.expires_at - Date.now() < (SESSION_DAYS - 1) * 864e5) // slide the expiry at most once a day
    db.prepare("UPDATE sessions SET expires_at = ? WHERE token_hash = ?").run(Date.now() + SESSION_DAYS * 864e5, row.token_hash);
  return { user: row, via: "cookie", sessionHash: row.token_hash };
}
// Cookie-authenticated writes must come from our own page (blocks cross-site request forgery).
function checkCsrf(req) {
  if (req.headers["x-requested-with"] !== "hh") throw new HttpError(403, "csrf", "Request blocked.");
  const origin = req.headers.origin;
  if (origin && origin !== new URL(config.appUrl).origin) throw new HttpError(403, "csrf", "Request blocked.");
}

const userOut = u => ({ id: u.id, email: u.email, name: u.name, tz: u.tz, created: u.created_at });
const forwardingAddress = u => config.inbound.domain ? `${u.inbound_token}@${config.inbound.domain}` : null;

/* ---------------- app ---------------- */
export function createApp(db, { log = console.log } = {}) {
  const r = createRouter();
  const L = config.limits;
  const loginLimit = rateLimiter({ max: L.loginsPer15Min, windowMs: 15 * 60e3 });
  const signupLimit = rateLimiter({ max: L.signupsPerHour, windowMs: 60 * 60e3 });
  const aiLimit = rateLimiter({ max: L.aiPerHour, windowMs: 60 * 60e3 });
  const inboundLimit = rateLimiter({ max: L.inboundPerDay, windowMs: 24 * 60 * 60e3 });
  const requireUser = ({ allowToken = false } = {}) => (ctx) => {
    const auth = authenticate(db, ctx.req);
    if (!auth) throw new HttpError(401, "signed_out", "Please sign in.");
    if (auth.via === "token" && !allowToken) throw new HttpError(403, "token_not_allowed", "Not allowed with an extension token.");
    if (auth.via === "cookie" && ctx.req.method !== "GET" && ctx.req.method !== "HEAD") checkCsrf(ctx.req);
    ctx.user = auth.user; ctx.auth = auth;
  };
  const auth = requireUser();

  /* ----- accounts ----- */
  r.post("/api/auth/signup", async ({ req, res }) => {
    checkCsrf(req);
    if (!signupLimit(clientIp(req))) throw new HttpError(429, "slow_down", "Too many sign-ups from here. Try again later.");
    const b = await readJSON(req);
    const email = str(b.email, 200, "email", { required: true }).toLowerCase();
    const name = str(b.name, 60, "name");
    const password = typeof b.password === "string" ? b.password : "";
    if (!validEmail(email)) throw bad("bad_email", "That email doesn't look right.");
    if (password.length < 8) throw bad("weak_password", "Use at least 8 characters for your password.");
    if (password.length > 200) throw bad("long_password", "That password is too long.");
    if (password.toLowerCase() === email || /^(12345678|password|qwertyui|11111111)/i.test(password)) throw bad("weak_password", "Pick a less guessable password.");
    const tz = typeof b.tz === "string" && validTz(b.tz) ? b.tz : config.defaultTz;
    if (db.prepare("SELECT 1 FROM users WHERE email = ?").get(email)) throw new HttpError(409, "email_taken", "There's already an account with that email. Try signing in.");
    const user = { id: newId(), email, name, tz, inbound_token: inboundToken(), created_at: Date.now() };
    db.prepare("INSERT INTO users (id, email, name, pass_hash, tz, inbound_token, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(user.id, email, name, await hashPassword(password), tz, user.inbound_token, user.created_at);
    createSession(db, res, user, req);
    send(res, 201, { user: userOut(user) });
  });

  r.post("/api/auth/login", async ({ req, res }) => {
    checkCsrf(req);
    const b = await readJSON(req);
    const email = str(b.email, 200, "email", { required: true }).toLowerCase();
    const password = typeof b.password === "string" ? b.password : "";
    if (!loginLimit(clientIp(req)) || !loginLimit("e:" + email)) throw new HttpError(429, "slow_down", "Too many attempts. Wait 15 minutes and try again.");
    const user = db.prepare("SELECT * FROM users WHERE email = ?").get(email);
    const ok = await verifyPassword(password, user ? user.pass_hash : DUMMY_HASH);
    if (!user || !ok) throw new HttpError(401, "bad_login", "Email or password is wrong.");
    if (typeof b.tz === "string" && validTz(b.tz) && b.tz !== user.tz) db.prepare("UPDATE users SET tz = ? WHERE id = ?").run(b.tz, user.id);
    createSession(db, res, user, req);
    send(res, 200, { user: userOut(user) });
  });

  r.post("/api/auth/logout", async ({ req, res }) => {
    const a = authenticate(db, req);
    if (a?.sessionHash) { checkCsrf(req); db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(a.sessionHash); }
    res.setHeader("Set-Cookie", cookie("hh_session", "", { maxAge: 0, secure: config.secureCookies }));
    send(res, 200, { ok: true });
  });

  r.get("/api/me", auth, ({ res, user }) => send(res, 200, { user: userOut(user), features: features(), forwardingAddress: forwardingAddress(user) }));

  r.patch("/api/me", auth, async ({ req, res, user }) => {
    const b = await readJSON(req);
    const name = b.name !== undefined ? str(b.name, 60, "name") : user.name;
    const tz = b.tz !== undefined ? (validTz(b.tz) ? b.tz : user.tz) : user.tz;
    db.prepare("UPDATE users SET name = ?, tz = ? WHERE id = ?").run(name, tz, user.id);
    send(res, 200, { user: userOut({ ...user, name, tz }) });
  });

  r.post("/api/me/password", auth, async ({ req, res, user, auth: a }) => {
    const b = await readJSON(req);
    if (!(await verifyPassword(String(b.current || ""), user.pass_hash))) throw new HttpError(401, "bad_password", "Your current password is wrong.");
    const next = String(b.password || "");
    if (next.length < 8 || next.length > 200) throw bad("weak_password", "Use at least 8 characters.");
    db.prepare("UPDATE users SET pass_hash = ? WHERE id = ?").run(await hashPassword(next), user.id);
    db.prepare("DELETE FROM sessions WHERE user_id = ? AND token_hash != ?").run(user.id, a.sessionHash || ""); // sign out other devices
    send(res, 200, { ok: true });
  });

  r.delete("/api/me", auth, async ({ req, res, user }) => {
    const b = await readJSON(req);
    if (!(await verifyPassword(String(b.password || ""), user.pass_hash))) throw new HttpError(401, "bad_password", "Password is wrong.");
    const gmail = db.prepare("SELECT * FROM connections WHERE user_id = ? AND kind = 'gmail'").get(user.id);
    if (gmail) await revokeGoogle(gmail);
    db.prepare("DELETE FROM users WHERE id = ?").run(user.id); // everything else is deleted with it (ON DELETE CASCADE)
    res.setHeader("Set-Cookie", cookie("hh_session", "", { maxAge: 0, secure: config.secureCookies }));
    send(res, 200, { ok: true });
  });

  /* ----- assignments ----- */
  const getOwned = (id, userId) => {
    const row = db.prepare("SELECT * FROM assignments WHERE id = ? AND user_id = ?").get(id, userId);
    if (!row) throw new HttpError(404, "not_found", "That assignment doesn't exist anymore.");
    return row;
  };

  r.get("/api/assignments", auth, ({ res, user }) => {
    const rows = db.prepare("SELECT * FROM assignments WHERE user_id = ? AND removed = 0 ORDER BY due IS NULL, due").all(user.id);
    send(res, 200, rows.map(assignmentOut));
  });

  r.post("/api/assignments", auth, async ({ req, res, user }) => {
    const b = await readJSON(req);
    const items = Array.isArray(b.items) ? b.items.slice(0, 30) : [b];
    const fromPaste = Array.isArray(b.items);
    const now = Date.now();
    const results = tx(db, () => items.map(it => {
      const cand = {
        title: str(it.title, 200, "title", { required: true }), subject: str(it.subject, 80, "subject"), due: isoOrNull(it.due),
        reqs: reqList(it.reqs), notes: str(it.notes, 4000, "notes"), link: safeLink(it.link),
        source: SOURCES.includes(it.source) ? it.source : "Other", confidence: "high",
      };
      if (fromPaste) return upsert(db, user.id, { ...cand, ref: `paste:${newId()}`, rank: RANK.paste }, { now });
      const id = newId();
      db.prepare(`INSERT INTO assignments (id, user_id, title, subject, due, source, rank, reqs, notes, link, created_at, updated_at)
                  VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)`).run(id, user.id, cand.title, cand.subject, cand.due, cand.source, JSON.stringify(cand.reqs), cand.notes, cand.link, now, now);
      return { action: "added", id, title: cand.title };
    }));
    const rows = results.map(x => assignmentOut(db.prepare("SELECT * FROM assignments WHERE id = ?").get(x.id)));
    send(res, 201, { results, items: rows });
  });

  r.patch("/api/assignments/:id", auth, async ({ req, res, user, params }) => {
    const row = getOwned(params.id, user.id);
    const b = await readJSON(req);
    const set = {}; const edited = new Set(parseJSON(row.user_edited, []));
    const hasRefs = !!db.prepare("SELECT 1 FROM assignment_refs WHERE assignment_id = ?").get(row.id);
    if ("done" in b) set.done = b.done ? 1 : 0;
    const content = {
      title: () => str(b.title, 200, "title", { required: true }), subject: () => str(b.subject, 80, "subject"),
      due: () => isoOrNull(b.due), reqs: () => JSON.stringify(reqList(b.reqs)), notes: () => str(b.notes, 4000, "notes"),
    };
    for (const [f, get] of Object.entries(content)) {
      if (!(f in b)) continue;
      const v = get();
      if (String(v ?? "") === String(row[f] ?? "")) continue;
      set[f] = v; if (hasRefs) edited.add(f);   // syncs won't overwrite this field any more
    }
    if ("source" in b && SOURCES.includes(b.source)) set.source = b.source;
    if (Object.keys(set).length) {
      set.user_edited = JSON.stringify([...edited]);
      const keys = Object.keys(set);
      db.prepare(`UPDATE assignments SET ${keys.map(k => `${k} = ?`).join(", ")}, updated_at = ? WHERE id = ?`).run(...keys.map(k => set[k]), Date.now(), row.id);
    }
    send(res, 200, assignmentOut(db.prepare("SELECT * FROM assignments WHERE id = ?").get(row.id)));
  });

  r.delete("/api/assignments/:id", auth, ({ res, user, params }) => {
    const row = getOwned(params.id, user.id);
    const hasRefs = !!db.prepare("SELECT 1 FROM assignment_refs WHERE assignment_id = ?").get(row.id);
    if (hasRefs) { // keep a hidden tombstone so the next sync doesn't bring it back
      const edited = new Set(parseJSON(row.user_edited, [])); edited.add("deleted");
      db.prepare("UPDATE assignments SET removed = 1, user_edited = ?, updated_at = ? WHERE id = ?").run(JSON.stringify([...edited]), Date.now(), row.id);
    } else db.prepare("DELETE FROM assignments WHERE id = ?").run(row.id);
    send(res, 200, { ok: true });
  });

  /* ----- AI helpers ----- */
  r.post("/api/extract", auth, async ({ req, res, user }) => {
    const b = await readJSON(req, 60_000);
    const text = str(b.text, 20000, "text", { required: true });
    const source = SOURCES.includes(b.source) ? b.source : "Other";
    let items, method = "rules";
    if (aiEnabled()) {
      if (!aiLimit(user.id)) throw new HttpError(429, "slow_down", "You've used a lot of AI reads this hour. Try again later.");
      try { items = await aiExtract(text, { tz: user.tz, hint: source, kind: "paste" }); method = "ai"; } catch (e) { log("[ai] extract failed:", e.code, e.message); }
    }
    if (!items) items = pasteRules(text, { now: new Date(), tz: user.tz });
    // The student's choice wins; if they picked "Other", use the platform the AI recognised.
    send(res, 200, { method, items: items.map(i => ({ ...i, source: source !== "Other" ? source : SOURCES.includes(i.platform) ? i.platform : "Other" })) });
  });

  r.post("/api/plan", auth, async ({ res, user }) => {
    if (!aiEnabled()) throw new HttpError(501, "no_ai", "AI isn't set up on this server.");
    if (!aiLimit(user.id)) throw new HttpError(429, "slow_down", "Try again in a bit.");
    const rows = db.prepare(`SELECT * FROM assignments WHERE user_id = ? AND removed = 0 AND done = 0 AND (due IS NULL OR due < ?) ORDER BY due IS NULL, due LIMIT 15`)
      .all(user.id, new Date(Date.now() + 7 * 864e5).toISOString()).map(assignmentOut);
    if (!rows.length) return send(res, 200, { text: "Nothing's due in the next week. Enjoy the evening." });
    send(res, 200, { text: await aiPlan(rows, { tz: user.tz }) });
  });

  /* ----- connections ----- */
  const connRow = (userId, kind) => db.prepare("SELECT * FROM connections WHERE user_id = ? AND kind = ?").get(userId, kind);
  const connOut = c => c && {
    connected: true, status: c.status, lastSync: c.last_sync, error: parseJSON(c.last_error, null),
    report: parseJSON(c.meta, {}).lastReport || null,
  };

  r.get("/api/connections", auth, ({ res, user }) => {
    const f = features();
    const gm = connRow(user.id, "gmail"), fw = connRow(user.id, "forwarding");
    const tokens = db.prepare("SELECT id, name, created_at, last_used FROM api_tokens WHERE user_id = ? ORDER BY created_at DESC").all(user.id);
    send(res, 200, {
      managebac: connOut(connRow(user.id, "managebac")) || { connected: false },
      gmail: { available: f.google, ...(gm ? { ...connOut(gm), email: parseJSON(gm.meta, {}).email || "" } : { connected: false }) },
      forwarding: { available: f.forwarding, address: forwardingAddress(user), confirm: parseJSON(fw?.meta, {}).confirm || null,
        lastEmail: db.prepare("SELECT received_at FROM ingest_log WHERE user_id = ? AND channel = 'email' ORDER BY received_at DESC LIMIT 1").get(user.id)?.received_at || null },
      extension: { tokens },
      ai: f.ai,
    });
  });

  r.post("/api/connections/managebac", auth, async ({ req, res, user }) => {
    const b = await readJSON(req);
    const conn = saveManageBac(db, user.id, str(b.url, 1000, "link", { required: true }), newId);
    try {
      const result = await runConnection(db, conn, { force: true, log });
      send(res, 200, { ok: true, report: result.report || null });
    } catch (e) {
      if (["feed_revoked", "not_ics", "bad_redirect"].includes(e.code)) db.prepare("DELETE FROM connections WHERE id = ?").run(conn.id);
      throw new HttpError(400, e.code || "sync_failed", e.message);
    }
  });

  r.post("/api/connections/:kind/sync", auth, async ({ res, user, params }) => {
    const conn = connRow(user.id, params.kind);
    if (!conn) throw new HttpError(404, "not_connected", "That isn't connected.");
    try { const out = await runConnection(db, conn, { force: true, log }); send(res, 200, { ok: true, ...out }); }
    catch (e) { throw new HttpError(502, e.code || "sync_failed", e.message); }
  });

  r.delete("/api/connections/:kind", auth, async ({ res, user, params }) => {
    const conn = connRow(user.id, params.kind);
    if (conn?.kind === "gmail") await revokeGoogle(conn);
    if (conn) db.prepare("DELETE FROM connections WHERE id = ?").run(conn.id);
    send(res, 200, { ok: true });
  });

  r.post("/api/connections/forwarding/rotate", auth, ({ res, user }) => {
    const t = inboundToken();
    db.prepare("UPDATE users SET inbound_token = ? WHERE id = ?").run(t, user.id);
    db.prepare("UPDATE connections SET meta = '{}' WHERE user_id = ? AND kind = 'forwarding'").run(user.id);
    send(res, 200, { address: forwardingAddress({ ...user, inbound_token: t }) });
  });

  r.post("/api/connections/forwarding/dismiss", auth, ({ res, user }) => {
    db.prepare("UPDATE connections SET meta = '{}' WHERE user_id = ? AND kind = 'forwarding'").run(user.id);
    send(res, 200, { ok: true });
  });

  /* ----- Google sign-in for Gmail ----- */
  r.get("/api/connect/google", ({ req, res }) => {
    const a = authenticate(db, req);
    if (!a || a.via !== "cookie") return redirect(res, "/?error=signed_out");
    if (!features().google) return redirect(res, "/?error=google_not_configured");
    const nonce = randomToken(16);
    res.setHeader("Set-Cookie", cookie("hh_oauth", nonce, { maxAge: 600, secure: config.secureCookies }));
    redirect(res, googleAuthUrl(sign({ uid: a.user.id, nonce })));
  });

  r.get("/api/connect/google/callback", async ({ req, res, url }) => {
    const clear = cookie("hh_oauth", "", { maxAge: 0, secure: config.secureCookies });
    const a = authenticate(db, req);
    const state = unsign(url.searchParams.get("state"));
    const nonce = parseCookies(req.headers.cookie).hh_oauth;
    if (url.searchParams.get("error")) return redirect(res, "/?error=google_cancelled", { "Set-Cookie": clear });
    if (!a || !state || state.uid !== a.user.id || !nonce || state.nonce !== nonce) return redirect(res, "/?error=google_state", { "Set-Cookie": clear });
    try {
      const tokens = await exchangeCode(url.searchParams.get("code"));
      saveGoogle(db, a.user.id, tokens, newId);
      const conn = connRow(a.user.id, "gmail");
      runConnection(db, conn, { force: true, log }).catch(() => {}); // first sync in the background
      redirect(res, "/?connected=gmail", { "Set-Cookie": clear });
    } catch (e) {
      log("[google]", e.code, e.message);
      redirect(res, `/?error=${encodeURIComponent(e.code || "google_error")}`, { "Set-Cookie": clear });
    }
  });

  /* ----- extension tokens ----- */
  r.get("/api/tokens", auth, ({ res, user }) =>
    send(res, 200, db.prepare("SELECT id, name, created_at, last_used FROM api_tokens WHERE user_id = ? ORDER BY created_at DESC").all(user.id)));
  r.post("/api/tokens", auth, async ({ req, res, user }) => {
    const b = await readJSON(req);
    const count = db.prepare("SELECT COUNT(*) AS n FROM api_tokens WHERE user_id = ?").get(user.id).n;
    if (count >= 10) throw bad("too_many_tokens", "Remove an old extension key first.");
    const token = "hh_" + randomToken(24), id = newId();
    db.prepare("INSERT INTO api_tokens (id, user_id, token_hash, name, created_at) VALUES (?, ?, ?, ?, ?)").run(id, user.id, sha256(token), str(b.name, 40, "name") || "Browser extension", Date.now());
    send(res, 201, { id, token });
  });
  r.delete("/api/tokens/:id", auth, ({ res, user, params }) => {
    db.prepare("DELETE FROM api_tokens WHERE id = ? AND user_id = ?").run(params.id, user.id);
    send(res, 200, { ok: true });
  });

  /* ----- browser extension: a page the student is looking at ----- */
  const corsOpen = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Authorization, Content-Type", "Access-Control-Allow-Methods": "POST, GET, OPTIONS", "Access-Control-Max-Age": "600" };
  r.options("/api/ingest/page", ({ res }) => send(res, 204, undefined, corsOpen));
  r.options("/api/ping", ({ res }) => send(res, 204, undefined, corsOpen));
  r.get("/api/ping", ({ req, res }) => {
    const a = authenticate(db, req);
    send(res, a ? 200 : 401, a ? { ok: true, name: a.user.name || a.user.email } : { error: "signed_out" }, corsOpen);
  });
  r.post("/api/ingest/page", async (ctx) => {
    const { req, res } = ctx;
    Object.entries(corsOpen).forEach(([k, v]) => res.setHeader(k, v));
    requireUser({ allowToken: true })(ctx);
    const user = ctx.user;
    const b = await readJSON(req, 400_000);
    let pageUrl;
    try { pageUrl = new URL(String(b.url || "")); } catch { throw bad("bad_url", "Missing page address."); }
    const text = str(b.text, 120_000, "page text", { required: true });
    const host = pageUrl.hostname.toLowerCase();
    const platform = [["ManageBac", /managebac\./], ["Kognity", /kognity\./], ["K12net", /k12net\./], ["Padlet", /padlet\./], ["Classroom", /classroom\.google\./], ["Teams", /teams\.microsoft\./]].find(([, re]) => re.test(host))?.[0] || "Other";
    let items, method = "rules";
    if (aiEnabled()) {
      if (!aiLimit(user.id)) throw new HttpError(429, "slow_down", "Too many page reads this hour.");
      try { items = await aiExtract(`Page: ${String(b.title || "").slice(0, 200)}\nURL: ${pageUrl.origin}${pageUrl.pathname}\n\n${text}`, { tz: user.tz, hint: platform, kind: "page" }); method = "ai"; }
      catch (e) { log("[ai] page failed:", e.code, e.message); }
    }
    if (!items) items = pageRules(text, { tz: user.tz });
    const now = Date.now();
    const results = tx(db, () => items.map(it => upsert(db, user.id, {
      ref: `page:${host}:${createHash("sha1").update((it.title || "").toLowerCase().replace(/\s+/g, " ").trim()).digest("hex").slice(0, 16)}`,
      source: platform === "Other" ? normalizePlatform(it.platform, "Other") : platform, rank: RANK.page,
      title: it.title, subject: it.subject || detectSubject(it.title), due: it.due, reqs: it.reqs || [], link: `${pageUrl.origin}${pageUrl.pathname}`,
      confidence: method === "ai" ? "high" : "low",
    }, { now })));
    logIngest(db, user.id, "page", `${host}${pageUrl.pathname}@${new Date(now).toISOString().slice(0, 16)}`, "ok",
      results.length ? results.map(x => `${x.action}: ${x.title}`).join("; ") : `No assignments found on ${host}`);
    send(res, 200, { method, platform, found: results.length, added: results.filter(x => x.action === "added").length, results });
  });

  /* ----- inbound email (forwarding) ----- */
  r.post("/api/inbound/email", async ({ req, res, url }) => {
    const given = String(req.headers["x-inbound-secret"] || url.searchParams.get("secret") || "");
    const want = config.inbound.secret;
    if (!want || given.length !== want.length || !timingSafeEqual(Buffer.from(given), Buffer.from(want))) throw new HttpError(401, "bad_secret", "Unauthorized");
    const buf = await readBody(req, 8 * 1024 * 1024);
    const type = String(req.headers["content-type"] || "");
    let msg, envelope = [];
    if (/json/.test(type)) {
      let j; try { j = JSON.parse(buf.toString("utf8")); } catch { throw bad("bad_json"); }
      if (typeof j.raw === "string") msg = parseMime(j.raw);
      else msg = {
        from: typeof j.From === "string" ? j.From : j.from?.text || j.from || "",
        subject: j.Subject ?? j.subject ?? "", messageId: String(j.MessageID || j.messageId || j["Message-Id"] || "").replace(/[<>]/g, ""),
        text: j.TextBody ?? j.text ?? "", html: j.HtmlBody ?? j.html ?? "", date: j.Date || j.date || "",
        to: addressesIn(typeof j.To === "string" ? j.To : j.to?.text || j.to || ""), deliveredTo: [],
      };
      msg.fromAddress ||= ((String(msg.from).match(/<([^>]+)>/) || [, msg.from])[1] || "").trim().toLowerCase();
      if (!msg.text && msg.html) msg.text = (await import("./sync/ics.js")).stripHtml(msg.html).trim();
      envelope = [j.OriginalRecipient, j.recipient, ...(Array.isArray(j.recipients) ? j.recipients : []), j.envelope?.to, ...(Array.isArray(j.envelope?.to) ? j.envelope.to : [])]
        .flat().filter(x => typeof x === "string").flatMap(addressesIn);
    } else msg = parseMime(buf);
    envelope.push(...addressesIn(req.headers["x-envelope-to"] || ""), ...addressesIn(url.searchParams.get("to") || ""));
    const candidates = [...envelope, ...(msg.deliveredTo || []), ...(msg.to || []), ...(msg.cc || [])];
    const domain = config.inbound.domain;
    const tokenFor = a => { const [local, dom] = a.split("@"); return dom === domain ? local.split("+")[0] : null; };
    let user = null;
    for (const a of candidates) { const t = tokenFor(a); if (t && (user = db.prepare("SELECT * FROM users WHERE inbound_token = ?").get(t))) break; }
    if (!user) return send(res, 202, { ignored: "unknown_recipient" }); // 2xx so the mail service doesn't retry forever
    if (!inboundLimit(user.id)) return send(res, 202, { ignored: "daily_limit" });
    db.prepare(`INSERT INTO connections (id, user_id, kind, meta, status, created_at) VALUES (?, ?, 'forwarding', '{}', 'active', ?) ON CONFLICT(user_id, kind) DO NOTHING`).run(newId(), user.id, Date.now());
    const result = await processEmail(db, user, msg, { channel: "email" });
    send(res, 200, { status: result.status, results: (result.results || []).map(x => ({ action: x.action, title: x.title })) });
  });

  r.get("/api/activity", auth, ({ res, user }) => send(res, 200,
    db.prepare("SELECT channel, status, summary, received_at FROM ingest_log WHERE user_id = ? ORDER BY received_at DESC LIMIT 25").all(user.id)));

  r.get("/healthz", ({ res }) => send(res, 200, { ok: true }));

  /* ----- request handling ----- */
  const htmlHeaders = {
    "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
    "X-Content-Type-Options": "nosniff", "Referrer-Policy": "same-origin", "X-Frame-Options": "DENY",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
    ...(config.secureCookies ? { "Strict-Transport-Security": "max-age=31536000" } : {}),
  };

  return createServer(async (req, res) => {
    const url = new URL(req.url, "http://local");
    try {
      if (url.pathname.startsWith("/api/") || url.pathname === "/healthz") {
        res.setHeader("X-Content-Type-Options", "nosniff");
        const m = r.match(req.method, url.pathname);
        if (!m) throw new HttpError(404, "not_found", "Not found.");
        if (m.methodNotAllowed) throw new HttpError(405, "method_not_allowed", "Not allowed.");
        const ctx = { req, res, url, params: m.params };
        for (const h of m.handlers) { await h(ctx); if (res.headersSent) break; }
        return;
      }
      if (req.method !== "GET" && req.method !== "HEAD") throw new HttpError(405, "method_not_allowed", "Not allowed.");
      if (await serveStatic(req, res, PUBLIC_DIR, url.pathname, htmlHeaders)) return;
      if (!/\.\w+$/.test(url.pathname) && await serveStatic(req, res, PUBLIC_DIR, "/index.html", htmlHeaders)) return;
      send(res, 404, "Not found", { "Content-Type": "text/plain" });
    } catch (e) {
      const status = e.status || 500;
      if (status >= 500) log("[error]", req.method, url.pathname, e.stack || e);
      send(res, status, { error: e.code || "server_error", message: status >= 500 && !e.code ? "Something went wrong on our side." : e.message });
    }
  });
}

/* Page text without AI: lines that look like tasks with a date nearby. Rough, marked low-confidence. */
function pageRules(text, { tz }) {
  const lines = text.split("\n").map(s => s.trim()).filter(Boolean);
  const out = [];
  const task = /\b(assignment|homework|task|quiz|test|worksheet|essay|lab|reading|practice|draft|IA|EE)\b|ödev|görev|sınav|proje/iu;
  for (let i = 0; i < lines.length && out.length < 20; i++) {
    const line = lines[i];
    if (line.length < 4 || line.length > 160 || !task.test(line)) continue;
    const near = [line, lines[i + 1] || "", lines[i + 2] || ""].join("\n");
    const due = parseDueFromText(near, { tz });
    if (!due) continue;
    const title = line.replace(/\b(due|teslim)\b.*$/i, "").trim().slice(0, 120);
    if (title && !out.some(o => o.title === title)) out.push({ title, subject: detectSubject(line), due, reqs: [] });
  }
  return out;
}
