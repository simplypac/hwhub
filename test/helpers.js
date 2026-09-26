import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { config } from "../server/config.js";

config.secretKey = "test-secret-key-that-is-long-enough";
config.inbound.domain = "in.hub.test";
config.inbound.secret = "inbound-test-secret";
config.ai.key = ""; // tests run the rule-based readers
config.limits.signupsPerHour = 1000;

const { openDb } = await import("../server/db.js");
const { createApp } = await import("../server/app.js");

export async function startTestServer() {
  const db = openDb(join(mkdtempSync(join(tmpdir(), "hh-")), "test.db"));
  const server = createApp(db, { log: () => {} });
  await new Promise(r => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  config.appUrl = base;
  return { db, base, close: () => new Promise(r => server.close(r)) };
}

// A tiny browser: keeps cookies and sends the same headers the app does.
export function client(base) {
  let jar = "";
  const call = async (method, path, body, headers = {}) => {
    const res = await fetch(base + path, {
      method, redirect: "manual",
      headers: { ...(body !== undefined ? { "Content-Type": "application/json" } : {}), "X-Requested-With": "hh", ...(jar ? { Cookie: jar } : {}), ...headers },
      body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
    });
    const set = res.headers.get("set-cookie");
    if (set) { const [pair] = set.split(";"); jar = pair.endsWith("=") ? "" : pair; }
    const text = await res.text();
    let json; try { json = JSON.parse(text); } catch { json = text; }
    return { status: res.status, body: json, headers: res.headers };
  };
  return { call, get cookie() { return jar; }, set cookie(v) { jar = v; } };
}

export async function signUp(base, email = `s${Math.random().toString(36).slice(2, 8)}@school.test`) {
  const c = client(base);
  const r = await c.call("POST", "/api/auth/signup", { email, password: "correct-horse-9", name: "Test", tz: "Europe/Istanbul" });
  if (r.status !== 201) throw new Error("signup failed " + JSON.stringify(r.body));
  return { c, email, user: r.body.user };
}
