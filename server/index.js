// Entry point: node server/index.js
import { config, checkConfig, features } from "./config.js";
import { openDb } from "./db.js";
import { createApp } from "./app.js";
import { startScheduler } from "./sync/scheduler.js";

const problems = checkConfig();
if (problems.length) {
  console.error("Can't start:\n - " + problems.join("\n - "));
  process.exit(1);
}
const db = openDb(config.dbFile);
const server = createApp(db);
server.listen(config.port, () => {
  const f = features();
  console.log(`Homework Hub running at ${config.appUrl} (port ${config.port})`);
  console.log(`  AI reading: ${f.ai ? "on" : "off (set ANTHROPIC_API_KEY)"} | Gmail: ${f.google ? "on" : "off"} | Email forwarding: ${f.forwarding ? "on" : "off"}`);
});
const stopScheduler = startScheduler(db);

// Clean up expired sessions once a day
setInterval(() => db.prepare("DELETE FROM sessions WHERE expires_at < ?").run(Date.now()), 864e5).unref();

for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => {
  stopScheduler();
  server.close(() => { db.close(); process.exit(0); });
  setTimeout(() => process.exit(0), 5000).unref();
});
