// Gmail: read-only access to school notification emails (ManageBac, Kognity, K12net, Padlet, Classroom...).
import { config } from "../config.js";
import { encrypt, decrypt } from "../security.js";
import { parseJSON } from "../db.js";
import { processEmail } from "./email.js";
import { alreadyIngested } from "./ingest.js";
import { addressesIn } from "./mime.js";
import { stripHtml } from "./ics.js";

const SCOPES = "openid email https://www.googleapis.com/auth/gmail.readonly";
const redirectUri = () => `${config.appUrl}/api/connect/google/callback`;

export function googleAuthUrl(state) {
  const p = new URLSearchParams({
    client_id: config.google.clientId, redirect_uri: redirectUri(), response_type: "code", scope: SCOPES,
    access_type: "offline", prompt: "consent", include_granted_scopes: "true", state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${p}`;
}

async function tokenRequest(params) {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: config.google.clientId, client_secret: config.google.clientSecret, ...params }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error_description || "Google sign-in failed."), { code: data.error === "invalid_grant" ? "reauth" : "google_error" });
  return data;
}

export async function exchangeCode(code) {
  const data = await tokenRequest({ code, grant_type: "authorization_code", redirect_uri: redirectUri() });
  if (!data.refresh_token) throw Object.assign(new Error("Google didn't grant offline access. Try connecting again."), { code: "no_refresh" });
  if (!String(data.scope || "").includes("gmail.readonly")) throw Object.assign(new Error("Please tick the Gmail permission when connecting."), { code: "scope_missing" });
  let email = "";
  try { email = JSON.parse(Buffer.from(String(data.id_token).split(".")[1], "base64url").toString()).email || ""; } catch {}
  return { refreshToken: data.refresh_token, email };
}

async function accessToken(conn) {
  const data = await tokenRequest({ refresh_token: decrypt(conn.secret_enc), grant_type: "refresh_token" });
  return data.access_token;
}

async function gmail(token, path) {
  const res = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/${path}`, { headers: { Authorization: `Bearer ${token}` } });
  if (res.status === 401) throw Object.assign(new Error("Gmail access expired. Reconnect Gmail."), { code: "reauth" });
  if (!res.ok) throw Object.assign(new Error(`Gmail error ${res.status}`), { code: "gmail_error" });
  return res.json();
}

const b64 = s => Buffer.from(String(s || "").replace(/-/g, "+").replace(/_/g, "/"), "base64");
export function decodeGmailMessage(m) {
  const headers = Object.fromEntries((m.payload?.headers || []).map(h => [h.name.toLowerCase(), h.value]));
  let text = "", html = "";
  (function walk(part) {
    if (!part) return;
    if (part.parts) return part.parts.forEach(walk);
    if (part.filename) return;
    const data = part.body?.data ? b64(part.body.data).toString("utf8") : "";
    if (part.mimeType === "text/plain" && !text) text = data;
    if (part.mimeType === "text/html" && !html) html = data;
  })(m.payload);
  const from = headers.from || "";
  return {
    from, fromAddress: (from.match(/<([^>]+)>/) || [, from])[1].trim().toLowerCase(),
    to: addressesIn(headers.to), subject: headers.subject || "", messageId: (headers["message-id"] || m.id).replace(/[<>]/g, ""),
    date: headers.date || "", text: (text || stripHtml(html)).replace(/\r\n/g, "\n").trim(), html,
  };
}

const QUERY = "(from:managebac.com OR from:kognity.com OR from:k12net.com OR from:padlet.com OR from:classroom.google.com OR from:classroom-noreply@google.com " +
  "OR subject:(assignment OR homework OR deadline OR due OR ödev OR teslim OR görev))";

export async function syncGmail(db, user, conn, { now = Date.now() } = {}) {
  const meta = parseJSON(conn.meta, {});
  const token = await accessToken(conn);
  const window = conn.last_sync ? "newer_than:7d" : "newer_than:21d";
  const list = await gmail(token, `messages?maxResults=50&q=${encodeURIComponent(`${QUERY} ${window}`)}`);
  let added = 0, seen = 0;
  for (const { id } of list.messages || []) {
    if (alreadyIngested(db, user.id, "gmail", id)) continue;
    seen++;
    const msg = decodeGmailMessage(await gmail(token, `messages/${id}?format=full`));
    const r = await processEmail(db, user, msg, { channel: "gmail", extId: id, now: new Date(now) });
    added += (r.results || []).filter(x => x.action === "added").length;
    if (seen >= 40) break;                     // keep each run short; the rest comes next time
  }
  db.prepare("UPDATE connections SET meta = ? WHERE id = ?").run(JSON.stringify({ ...meta, lastReport: `${seen} new emails checked, ${added} assignments added` }), conn.id);
  return { report: { checked: seen, added } };
}

export async function revokeGoogle(conn) {
  try { await fetch("https://oauth2.googleapis.com/revoke", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token: decrypt(conn.secret_enc) }) }); }
  catch {}
}
export const saveGoogle = (db, userId, { refreshToken, email }, newId) => db.prepare(
  `INSERT INTO connections (id, user_id, kind, secret_enc, meta, status, created_at, next_sync) VALUES (?, ?, 'gmail', ?, ?, 'active', ?, 0)
   ON CONFLICT(user_id, kind) DO UPDATE SET secret_enc = excluded.secret_enc, meta = excluded.meta, status = 'active', last_error = NULL, failures = 0, next_sync = 0`)
  .run(newId(), userId, encrypt(refreshToken), JSON.stringify({ email }), Date.now());
