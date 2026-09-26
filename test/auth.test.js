import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startTestServer, client, signUp } from "./helpers.js";

let srv;
before(async () => { srv = await startTestServer(); });
after(() => srv.close());

test("sign up, stay signed in, sign out", async () => {
  const c = client(srv.base);
  const r = await c.call("POST", "/api/auth/signup", { email: "Pac@School.test", password: "correct-horse-9", name: "Pac" });
  assert.equal(r.status, 201);
  assert.equal(r.body.user.email, "pac@school.test");
  assert.match(r.headers.get("set-cookie"), /HttpOnly/);
  assert.equal((await c.call("GET", "/api/me")).status, 200);
  await c.call("POST", "/api/auth/logout");
  assert.equal((await c.call("GET", "/api/me")).status, 401);
});

test("login: right password works, wrong one doesn't, email is case-insensitive", async () => {
  const { email } = await signUp(srv.base);
  const c = client(srv.base);
  assert.equal((await c.call("POST", "/api/auth/login", { email: email.toUpperCase(), password: "nope-nope-1" })).status, 401);
  assert.equal((await c.call("POST", "/api/auth/login", { email: email.toUpperCase(), password: "correct-horse-9" })).status, 200);
  assert.equal((await c.call("GET", "/api/me")).body.user.email, email);
});

test("duplicate emails and weak passwords are rejected", async () => {
  const { email } = await signUp(srv.base);
  const c = client(srv.base);
  assert.equal((await c.call("POST", "/api/auth/signup", { email, password: "another-pass-1" })).status, 409);
  assert.equal((await c.call("POST", "/api/auth/signup", { email: "x@y.test", password: "short" })).status, 400);
  assert.equal((await c.call("POST", "/api/auth/signup", { email: "not-an-email", password: "long-enough-1" })).status, 400);
});

test("requests from other websites are blocked (CSRF)", async () => {
  const { c } = await signUp(srv.base);
  const noHeader = await c.call("POST", "/api/assignments", { title: "x" }, { "X-Requested-With": "" });
  assert.equal(noHeader.status, 403);
  const evil = await c.call("POST", "/api/assignments", { title: "x" }, { Origin: "https://evil.example" });
  assert.equal(evil.status, 403);
});

test("passwords are hashed, never stored in plain text", async () => {
  const { email } = await signUp(srv.base);
  const row = srv.db.prepare("SELECT pass_hash FROM users WHERE email = ?").get(email);
  assert.match(row.pass_hash, /^scrypt\$/);
  assert.ok(!row.pass_hash.includes("correct-horse-9"));
});

test("change password signs out other devices", async () => {
  const { c, email } = await signUp(srv.base);
  const other = client(srv.base);
  await other.call("POST", "/api/auth/login", { email, password: "correct-horse-9" });
  assert.equal((await c.call("POST", "/api/me/password", { current: "correct-horse-9", password: "brand-new-pass-2" })).status, 200);
  assert.equal((await other.call("GET", "/api/me")).status, 401);
  assert.equal((await c.call("GET", "/api/me")).status, 200);
});

test("deleting the account removes all data", async () => {
  const { c, user } = await signUp(srv.base);
  await c.call("POST", "/api/assignments", { title: "Something" });
  assert.equal((await c.call("DELETE", "/api/me", { password: "wrong-one-1" })).status, 401);
  assert.equal((await c.call("DELETE", "/api/me", { password: "correct-horse-9" })).status, 200);
  assert.equal(srv.db.prepare("SELECT COUNT(*) n FROM assignments WHERE user_id = ?").get(user.id).n, 0);
  assert.equal(srv.db.prepare("SELECT COUNT(*) n FROM users WHERE id = ?").get(user.id).n, 0);
});

test("brute force: login attempts are rate limited", async () => {
  const { email } = await signUp(srv.base);
  const c = client(srv.base);
  let last;
  for (let i = 0; i < 12; i++) last = await c.call("POST", "/api/auth/login", { email, password: "wrong-guess-" + i });
  assert.equal(last.status, 429);
});
