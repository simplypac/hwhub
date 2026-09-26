// Every source (calendar feed, email, web page, paste) ends up here.
// One assignment can be seen by several sources; each sighting is a "ref" pointing at the same row.
import { newId } from "../security.js";
import { parseJSON, tx } from "../db.js";

// How much we trust a source's details. Higher wins when two sources disagree.
export const RANK = { feed: 3, email: 2, page: 2, paste: 1, manual: 0 };
const FIELDS = ["title", "subject", "due", "all_day", "kind", "reqs", "notes", "link"];
const channelOf = ref => ref.split(":")[0];

const STOP = new Set(("the a an and or of for to on in at by your you new task assignment homework hw due deadline please submit reminder " +
  "ve veya ile için icin bir bu şu yeni ödev odev görev gorev teslim hatırlatma").split(" "));
export function tokens(title) {
  return new Set(String(title || "").toLocaleLowerCase("tr").normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\p{N}.]+/gu, " ").split(" ").map(w => w.replace(/^\.+|\.+$/g, "")).filter(w => w && !STOP.has(w)));
}
export function similarity(a, b) {
  const A = tokens(a), B = tokens(b);
  if (!A.size || !B.size) return 0;
  let common = 0; for (const w of A) if (B.has(w)) common++;
  return (2 * common) / (A.size + B.size);
}
const subjectKey = s => String(s || "").toLocaleLowerCase("tr").split(/\s+/)[0] || "";
const subjectsCompatible = (a, b) => !a || !b || subjectKey(a) === subjectKey(b);

function findDuplicate(db, userId, cand, channel, now) {
  const rows = db.prepare(`SELECT a.*, (SELECT group_concat(ref, '|') FROM assignment_refs r WHERE r.assignment_id = a.id) AS refs
                           FROM assignments a WHERE a.user_id = ? AND (a.removed = 0 OR a.user_edited LIKE '%"deleted"%')`).all(userId);
  let best = null, bestScore = 0;
  for (const row of rows) {
    const refs = (row.refs || "").split("|").filter(Boolean);
    // The same channel always sends the same ref for the same item, so a different ref from the same channel is a different task.
    if (channel !== "manual" && refs.some(r => channelOf(r) === channel)) continue;
    if (cand.link && row.link && cand.link === row.link) return row;
    const sim = similarity(cand.title, row.title);
    const subjOk = subjectsCompatible(cand.subject, row.subject);
    let score = 0;
    if (cand.due && row.due) {
      const gapH = Math.abs(new Date(cand.due) - new Date(row.due)) / 36e5;
      if (gapH <= 36 && (sim >= 0.5 || (sim >= 0.34 && subjOk && cand.subject && row.subject))) score = sim + (gapH < 1 ? 0.3 : 0) + (subjOk ? 0.1 : 0);
    } else if (sim >= 0.75 && subjOk && now - row.created_at < 21 * 864e5) score = sim;
    if (score > bestScore) { bestScore = score; best = row; }
  }
  return best;
}

function toRow(c) {
  return {
    title: String(c.title || "Untitled task").slice(0, 200), subject: String(c.subject || "").slice(0, 80),
    due: c.due || null, all_day: c.allDay ? 1 : 0, kind: c.kind || null,
    reqs: JSON.stringify((c.reqs || []).slice(0, 8)), notes: String(c.notes || "").slice(0, 4000), link: c.link || null,
  };
}
const isEmpty = (f, v) => v == null || v === "" || (f === "reqs" && v === "[]");

/**
 * cand: { ref, source, rank, title, subject, due, allDay, kind, reqs, notes, link, confidence }
 * Returns { action: "added" | "updated" | "merged" | "unchanged" | "restored", id, title }
 */
export function upsert(db, userId, cand, { now = Date.now() } = {}) {
  const channel = channelOf(cand.ref);
  const incoming = toRow(cand);
  const rank = cand.rank ?? RANK[channel] ?? 1;

  const existingRef = db.prepare("SELECT assignment_id FROM assignment_refs WHERE user_id = ? AND ref = ?").get(userId, cand.ref);
  let row = existingRef && db.prepare("SELECT * FROM assignments WHERE id = ? AND user_id = ?").get(existingRef.assignment_id, userId);
  let action;

  if (!row) {
    const dup = findDuplicate(db, userId, cand, channel, now);
    if (dup) { row = dup; action = "merged"; }
  }
  if (!row) {
    const id = newId();
    db.prepare(`INSERT INTO assignments (id, user_id, title, subject, due, all_day, source, rank, kind, reqs, notes, link, confidence, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, userId, incoming.title, incoming.subject, incoming.due, incoming.all_day, cand.source || "Other", rank, incoming.kind,
        incoming.reqs, incoming.notes, incoming.link, cand.confidence || "high", now, now);
    db.prepare("INSERT INTO assignment_refs (user_id, ref, assignment_id, seen_at) VALUES (?, ?, ?, ?)").run(userId, cand.ref, id, now);
    return { action: "added", id, title: incoming.title };
  }

  // Update an existing row. Never touch what the student edited by hand.
  const locked = new Set(parseJSON(row.user_edited, []));
  if (locked.has("deleted")) { // the student deleted it: remember this sighting, but keep it hidden
    db.prepare(`INSERT INTO assignment_refs (user_id, ref, assignment_id, seen_at) VALUES (?, ?, ?, ?)
                ON CONFLICT(user_id, ref) DO UPDATE SET seen_at = excluded.seen_at`).run(userId, cand.ref, row.id, now);
    return { action: "unchanged", id: row.id, title: row.title };
  }
  const wins = rank >= row.rank;
  const changes = [];
  const set = {};
  for (const f of FIELDS) {
    if (locked.has(f === "all_day" ? "due" : f)) continue;
    const cur = row[f], next = incoming[f];
    if (isEmpty(f, next) || String(cur ?? "") === String(next ?? "")) continue;
    if (!wins && !isEmpty(f, cur)) continue;          // lower-trust source only fills gaps
    set[f] = next;
    if (f === "due" && cur) changes.push({ field: "due", from: cur, to: next });
  }
  if (wins && rank > row.rank) { set.rank = rank; set.source = cand.source || row.source; }
  if (cand.confidence === "high" && row.confidence !== "high") set.confidence = "high";
  const restored = row.removed ? true : false;
  if (restored) set.removed = 0;
  if (changes.length) set.last_change = JSON.stringify({ at: now, changes });

  const keys = Object.keys(set);
  if (keys.length) {
    db.prepare(`UPDATE assignments SET ${keys.map(k => `${k} = ?`).join(", ")}, updated_at = ? WHERE id = ?`)
      .run(...keys.map(k => set[k]), now, row.id);
  }
  db.prepare(`INSERT INTO assignment_refs (user_id, ref, assignment_id, seen_at) VALUES (?, ?, ?, ?)
              ON CONFLICT(user_id, ref) DO UPDATE SET seen_at = excluded.seen_at, assignment_id = excluded.assignment_id`).run(userId, cand.ref, row.id, now);
  if (!action) action = restored ? "restored" : keys.some(k => FIELDS.includes(k)) ? "updated" : "unchanged";
  return { action, id: row.id, title: set.title || row.title };
}

/**
 * A whole feed (e.g. ManageBac calendar): upsert everything, then hide items that vanished from it.
 * Items only disappear if the feed should still contain them (inside its date window) and no other source saw them.
 */
export function syncFeed(db, userId, channel, items, { now = Date.now(), windowDays = [-30, 95] } = {}) {
  const report = { added: [], updated: [], merged: [], restored: [], removed: [], unchanged: 0 };
  const known = db.prepare("SELECT COUNT(*) AS n FROM assignment_refs WHERE user_id = ? AND ref LIKE ?").get(userId, channel + ":%").n;
  if (items.length === 0 && known >= 3) {
    throw Object.assign(new Error("The calendar came back empty, so nothing was changed. The link may have been reset."), { code: "feed_empty" });
  }
  return tx(db, () => {
    const seen = new Set();
    for (const c of items) {
      seen.add(c.ref);
      const r = upsert(db, userId, c, { now });
      if (r.action === "unchanged") report.unchanged++; else report[r.action].push(r.title);
    }
    const lo = now + windowDays[0] * 864e5, hi = now + windowDays[1] * 864e5;
    const refs = db.prepare(`SELECT r.ref, a.id, a.title, a.due, a.done, a.removed,
                               (SELECT COUNT(*) FROM assignment_refs o WHERE o.assignment_id = a.id AND o.ref NOT LIKE ?) AS others
                             FROM assignment_refs r JOIN assignments a ON a.id = r.assignment_id
                             WHERE r.user_id = ? AND r.ref LIKE ?`).all(channel + ":%", userId, channel + ":%");
    for (const r of refs) {
      if (seen.has(r.ref) || r.removed || r.done || r.others > 0 || !r.due) continue;
      const due = new Date(r.due).getTime();
      if (due < lo || due > hi) continue;
      db.prepare("UPDATE assignments SET removed = 1, updated_at = ? WHERE id = ?").run(now, r.id);
      report.removed.push(r.title);
    }
    return report;
  });
}

export function logIngest(db, userId, channel, extId, status, summary) {
  db.prepare(`INSERT INTO ingest_log (user_id, channel, ext_id, received_at, status, summary) VALUES (?, ?, ?, ?, ?, ?)
              ON CONFLICT(user_id, channel, ext_id) DO UPDATE SET status = excluded.status, summary = excluded.summary, received_at = excluded.received_at`)
    .run(userId, channel, String(extId).slice(0, 300), Date.now(), status, String(summary || "").slice(0, 500));
}
export const alreadyIngested = (db, userId, channel, extId) =>
  !!db.prepare("SELECT 1 FROM ingest_log WHERE user_id = ? AND channel = ? AND ext_id = ? AND status != 'error'").get(userId, channel, String(extId).slice(0, 300));
