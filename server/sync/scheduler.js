// Runs each connection on its own schedule, backs off on errors, and never runs two syncs at once.
import { syncManageBac } from "./managebac.js";
import { syncGmail } from "./gmail.js";

const EVERY_MIN = { managebac: 30, gmail: 15 };
const RUNNERS = { managebac: syncManageBac, gmail: syncGmail };
const running = new Set();

export async function runConnection(db, conn, { force = false, log = () => {} } = {}) {
  const runner = RUNNERS[conn.kind];
  if (!runner) return { skipped: true };
  if (running.has(conn.id)) return { busy: true };
  running.add(conn.id);
  const user = db.prepare("SELECT * FROM users WHERE id = ?").get(conn.user_id);
  const now = Date.now();
  try {
    const result = await runner(db, user, conn, { force, now });
    db.prepare("UPDATE connections SET last_sync = ?, next_sync = ?, last_error = NULL, failures = 0, status = 'active' WHERE id = ?")
      .run(now, now + EVERY_MIN[conn.kind] * 60e3, conn.id);
    return result;
  } catch (e) {
    const failures = conn.failures + 1;
    const stop = ["feed_revoked", "reauth", "not_managebac"].includes(e.code);
    const waitMin = stop ? 24 * 60 : Math.min(EVERY_MIN[conn.kind] * 2 ** failures, 12 * 60);
    db.prepare("UPDATE connections SET last_error = ?, failures = ?, next_sync = ?, status = ? WHERE id = ?")
      .run(JSON.stringify({ code: e.code || "error", message: e.message, at: now }), failures, now + waitMin * 60e3, stop ? "needs_attention" : "active", conn.id);
    log(`[sync] ${conn.kind} for ${conn.user_id.slice(0, 8)} failed: ${e.code || ""} ${e.message}`);
    throw e;
  } finally { running.delete(conn.id); }
}

export function startScheduler(db, { log = console.log, tickMs = 60e3 } = {}) {
  let stopped = false, timer;
  const tick = async () => {
    const due = db.prepare(`SELECT * FROM connections WHERE kind IN ('managebac','gmail') AND status = 'active' AND (next_sync IS NULL OR next_sync <= ?)
                            ORDER BY next_sync LIMIT 20`).all(Date.now());
    for (const conn of due) {
      if (stopped) break;
      try { await runConnection(db, conn, { log }); } catch {}
    }
    if (!stopped) timer = setTimeout(tick, tickMs);
  };
  timer = setTimeout(tick, 3000);
  return () => { stopped = true; clearTimeout(timer); };
}
