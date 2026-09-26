import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseICS, classify, feedToCandidates } from "../server/sync/ics.js";
import { parseDueFromText } from "../server/dates.js";

const ics = readFileSync(new URL("./fixtures/sample-managebac.ics", import.meta.url), "utf8");

test("calendar: folded lines, escapes, alarms, time zones", () => {
  const ev = parseICS(ics, { tz: "Europe/Istanbul" });
  assert.equal(ev.length, 7);
  assert.equal(ev.find(e => e.uid === "task-1004@managebac").summary, "Physics HL Lab Report, pendulum");
  assert.equal(ev.find(e => e.uid === "task-1001@managebac").start.toISOString(), "2026-09-29T20:59:00.000Z");
  assert.equal(ev.find(e => e.uid === "task-1003@managebac").start.toISOString(), "2026-10-02T20:59:00.000Z"); // all-day = 23:59 Istanbul
});

test("calendar: homework vs other events", () => {
  const kinds = Object.fromEntries(parseICS(ics).map(e => [e.uid.split("@")[0], classify(e).kind]));
  for (const id of ["task-1001", "task-1002", "task-1003", "task-1004"]) assert.equal(kinds[id], "assignment", id);
  for (const id of ["event-2001", "event-2002", "event-2003"]) assert.equal(kinds[id], "event", id);
});

test("calendar: clean titles, subjects, requirements", () => {
  const { items } = feedToCandidates(ics, { tz: "Europe/Istanbul" });
  const econ = items.find(i => i.ref.includes("1001"));
  assert.equal(econ.title, "IA Commentary 1 Draft");
  assert.equal(econ.subject, "Economics HL");
  assert.equal(econ.kind, "summative");
  assert.ok(econ.reqs.some(r => /800 words/.test(r)));
  assert.equal(items.find(i => i.ref.includes("1003")).title, "TOK Exhibition: object selection");
});

test("due dates in English and Turkish", () => {
  const now = new Date("2026-09-25T12:00:00Z"), tz = "Europe/Istanbul";
  const at = (s) => parseDueFromText(s, { now, tz });
  assert.equal(at("Due: 29 September 2026 at 23:59"), "2026-09-29T20:59:00.000Z");
  assert.equal(at("Please submit by Thursday 11:59pm"), "2026-10-01T20:59:00.000Z");
  assert.equal(at("Teslim tarihi: 30.09.2026 17:00"), "2026-09-30T14:00:00.000Z");
  assert.equal(at("Ödevinizi Pazartesi günü teslim ediniz"), "2026-09-28T20:59:00.000Z");
  assert.equal(at("Son teslim 2 Ekim saat 23.59"), "2026-10-02T20:59:00.000Z");
  assert.equal(at("due tomorrow"), "2026-09-26T20:59:00.000Z");
  assert.equal(at("Read chapter 3.2 and 3.3"), null);
});
