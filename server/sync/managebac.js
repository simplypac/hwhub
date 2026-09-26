// ManageBac: every student has a private calendar link (Calendar → Subscribe). Teacher deadlines appear in it.
import { feedToCandidates } from "./ics.js";
import { syncFeed, logIngest } from "./ingest.js";
import { encrypt, decrypt } from "../security.js";
import { parseJSON } from "../db.js";

const ALLOWED = /(^|\.)managebac\.(com|cn|us)$/i;
const MAX_BYTES = 5 * 1024 * 1024;

export function normalizeFeedUrl(input) {
  let u;
  try { u = new URL(String(input || "").trim().replace(/^webcals?:\/\//i, "https://")); }
  catch { throw Object.assign(new Error("That doesn't look like a link."), { code: "bad_url", status: 400 }); }
  u.protocol = "https:";
  if (!ALLOWED.test(u.hostname)) throw Object.assign(new Error("Paste the calendar link from your ManageBac account (it ends in managebac.com)."), { code: "not_managebac", status: 400 });
  return u.toString();
}

export async function fetchFeed(url, { etag, lastModified, timeoutMs = 20000 } = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  const headers = { "User-Agent": "HomeworkHub/1.0 (+calendar sync)", Accept: "text/calendar, */*;q=0.5" };
  if (etag) headers["If-None-Match"] = etag;
  if (lastModified) headers["If-Modified-Since"] = lastModified;
  try {
    const res = await fetch(url, { headers, signal: ctl.signal, redirect: "follow" });
    if (!ALLOWED.test(new URL(res.url || url).hostname)) throw Object.assign(new Error("The link redirected somewhere unexpected."), { code: "bad_redirect" });
    if (res.status === 304) return { notModified: true };
    if ([401, 403, 404, 410].includes(res.status)) throw Object.assign(new Error("ManageBac rejected the link. Copy a fresh one from your calendar."), { code: "feed_revoked" });
    if (!res.ok) throw Object.assign(new Error(`ManageBac returned an error (${res.status}).`), { code: "feed_error" });
    const text = await res.text();
    if (text.length > MAX_BYTES) throw Object.assign(new Error("The calendar is too large."), { code: "feed_too_large" });
    if (!/BEGIN:VCALENDAR/i.test(text)) throw Object.assign(new Error("That link didn't return a calendar. Make sure it's the Subscribe link."), { code: "not_ics" });
    return { text, etag: res.headers.get("etag"), lastModified: res.headers.get("last-modified") };
  } catch (e) {
    if (e.name === "AbortError") throw Object.assign(new Error("ManageBac took too long to answer."), { code: "timeout" });
    if (!e.code) Object.assign(e, { code: "network", message: "Couldn't reach ManageBac." });
    throw e;
  } finally { clearTimeout(timer); }
}

// Import feed text directly (used by sync and by tests).
export function importFeedText(db, user, text, { now = Date.now() } = {}) {
  const { items, skipped, total } = feedToCandidates(text, { tz: user.tz });
  const report = syncFeed(db, user.id, "managebac", items, { now });
  return { ...report, skipped: skipped.length, total };
}

export async function syncManageBac(db, user, conn, { force = false, now = Date.now() } = {}) {
  const meta = parseJSON(conn.meta, {});
  const url = decrypt(conn.secret_enc);
  const res = await fetchFeed(url, force ? {} : { etag: meta.etag, lastModified: meta.lastModified });
  if (res.notModified) return { notModified: true };
  const report = importFeedText(db, user, res.text, { now });
  const summary = `+${report.added.length} new, ${report.updated.length} updated, ${report.merged.length} matched, ${report.removed.length} removed`;
  logIngest(db, user.id, "managebac", `sync-${new Date(now).toISOString().slice(0, 13)}`, "ok", summary);
  db.prepare("UPDATE connections SET meta = ? WHERE id = ?").run(JSON.stringify({ ...meta, etag: res.etag, lastModified: res.lastModified, lastReport: summary }), conn.id);
  return { report };
}

export function saveManageBac(db, userId, url, newId) {
  const clean = normalizeFeedUrl(url);
  const now = Date.now();
  db.prepare(`INSERT INTO connections (id, user_id, kind, secret_enc, meta, status, created_at, next_sync) VALUES (?, ?, 'managebac', ?, '{}', 'active', ?, 0)
              ON CONFLICT(user_id, kind) DO UPDATE SET secret_enc = excluded.secret_enc, meta = '{}', status = 'active', last_error = NULL, failures = 0, next_sync = 0`)
    .run(newId(), userId, encrypt(clean), now);
  return db.prepare("SELECT * FROM connections WHERE user_id = ? AND kind = 'managebac'").get(userId);
}
