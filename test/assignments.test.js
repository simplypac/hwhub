import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startTestServer, signUp } from "./helpers.js";

let srv;
before(async () => { srv = await startTestServer(); });
after(() => srv.close());

test("add, edit, tick off, delete", async () => {
  const { c } = await signUp(srv.base);
  const add = await c.call("POST", "/api/assignments", { title: "Econ IA draft", subject: "Economics HL", due: "2026-10-01T20:59:00.000Z", source: "WhatsApp", reqs: ["800 words"] });
  assert.equal(add.status, 201);
  const id = add.body.items[0].id;
  const edit = await c.call("PATCH", `/api/assignments/${id}`, { title: "Econ IA commentary draft", done: true });
  assert.equal(edit.body.title, "Econ IA commentary draft");
  assert.equal(edit.body.done, true);
  const list = await c.call("GET", "/api/assignments");
  assert.equal(list.body.length, 1);
  assert.equal((await c.call("DELETE", `/api/assignments/${id}`)).status, 200);
  assert.equal((await c.call("GET", "/api/assignments")).body.length, 0);
});

test("students can't see or touch each other's assignments", async () => {
  const a = await signUp(srv.base), b = await signUp(srv.base);
  const id = (await a.c.call("POST", "/api/assignments", { title: "Secret task" })).body.items[0].id;
  assert.equal((await b.c.call("GET", "/api/assignments")).body.length, 0);
  assert.equal((await b.c.call("PATCH", `/api/assignments/${id}`, { done: true })).status, 404);
  assert.equal((await b.c.call("DELETE", `/api/assignments/${id}`)).status, 404);
});

test("pasting a message finds the task and due date without AI", async () => {
  const { c } = await signUp(srv.base);
  const r = await c.call("POST", "/api/extract", { text: "Physics: finish the pendulum lab report, max 3 pages. Due Friday 17:00", source: "WhatsApp" });
  assert.equal(r.status, 200);
  assert.equal(r.body.items.length, 1);
  assert.ok(r.body.items[0].due);
  assert.equal(r.body.items[0].source, "WhatsApp");
});

test("signed-out requests are refused", async () => {
  const r = await fetch(srv.base + "/api/assignments");
  assert.equal(r.status, 401);
});
