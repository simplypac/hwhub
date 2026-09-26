import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { startTestServer, signUp, client } from "./helpers.js";
import { importFeedText } from "../server/sync/managebac.js";
import { parseMime } from "../server/sync/mime.js";
import { similarity } from "../server/sync/ingest.js";
import { normalizeFeedUrl } from "../server/sync/managebac.js";

const fx = n => readFileSync(new URL(`./fixtures/${n}`, import.meta.url), "utf8");
const NOW = new Date("2026-09-25T12:00:00Z").getTime();
let srv;
before(async () => { srv = await startTestServer(); });
after(() => srv.close());

const userRow = email => srv.db.prepare("SELECT * FROM users WHERE email = ?").get(email);
const list = uid => srv.db.prepare("SELECT * FROM assignments WHERE user_id = ? AND removed = 0 ORDER BY due").all(uid);
async function inbound(raw, envelopeTo) {
  return fetch(`${srv.base}/api/inbound/email`, { method: "POST", headers: { "Content-Type": "message/rfc822", "X-Inbound-Secret": "inbound-test-secret", ...(envelopeTo ? { "X-Envelope-To": envelopeTo } : {}) }, body: raw });
}
function setToken(email, token) { srv.db.prepare("UPDATE users SET inbound_token = ? WHERE email = ?").run(token, email); }

test("ManageBac feed: keeps homework, skips timetable/holidays/meetings", async () => {
  const { email } = await signUp(srv.base);
  const u = userRow(email);
  const r = importFeedText(srv.db, u, fx("sample-managebac.ics"), { now: NOW });
  assert.equal(r.added.length, 4);
  assert.equal(r.skipped, 3);
  const titles = list(u.id).map(a => a.title);
  assert.ok(titles.includes("IA Commentary 1 Draft"));
  assert.ok(titles.includes("TOK Exhibition: object selection"));
  assert.ok(!titles.some(t => /Parent|Holiday|Math AA HL$/.test(t)));
});

test("ManageBac re-sync: no duplicates, ticks kept, moved deadlines update, manual edits win", async () => {
  const { email, c } = await signUp(srv.base);
  const u = userRow(email);
  importFeedText(srv.db, u, fx("sample-managebac.ics"), { now: NOW });
  const bio = list(u.id).find(a => a.title.includes("3.2"));
  const econ = list(u.id).find(a => a.title.includes("IA Commentary"));
  await c.call("PATCH", `/api/assignments/${econ.id}`, { done: true });
  await c.call("PATCH", `/api/assignments/${bio.id}`, { title: "Bio Qs (my name)" });
  const moved = fx("sample-managebac.ics").replace("DTSTART:20260926T180000Z", "DTSTART:20260927T180000Z").replace("DP Economics HL: IA Commentary 1 Draft", "DP Economics HL: IA Commentary 1 Draft v2");
  const r = importFeedText(srv.db, u, moved, { now: NOW });
  assert.equal(r.added.length, 0);
  const after = Object.fromEntries(list(u.id).map(a => [a.id, a]));
  assert.equal(after[econ.id].done, 1);
  assert.equal(after[econ.id].title, "IA Commentary 1 Draft v2");
  assert.equal(after[bio.id].title, "Bio Qs (my name)");
  assert.equal(after[bio.id].due, "2026-09-27T18:00:00.000Z");
  assert.match(after[bio.id].last_change, /"due"/);
});

test("ManageBac: teacher-deleted task disappears; empty feed never wipes the list", async () => {
  const { email } = await signUp(srv.base);
  const u = userRow(email);
  importFeedText(srv.db, u, fx("sample-managebac.ics"), { now: NOW });
  const without = fx("sample-managebac.ics").replace(/BEGIN:VEVENT\r?\nUID:task-1002[\s\S]*?END:VEVENT\r?\n/, "");
  const r = importFeedText(srv.db, u, without, { now: NOW });
  assert.deepEqual(r.removed, ["Topic 3.2 practice questions"]);
  const empty = "BEGIN:VCALENDAR\nVERSION:2.0\nEND:VCALENDAR\n";
  assert.throws(() => importFeedText(srv.db, u, empty, { now: NOW }), { code: "feed_empty" });
  assert.equal(list(u.id).length, 3);
});

test("a task you delete stays deleted after the next sync", async () => {
  const { email, c } = await signUp(srv.base);
  const u = userRow(email);
  importFeedText(srv.db, u, fx("sample-managebac.ics"), { now: NOW });
  const tok = list(u.id).find(a => a.title.startsWith("TOK"));
  await c.call("DELETE", `/api/assignments/${tok.id}`);
  importFeedText(srv.db, u, fx("sample-managebac.ics"), { now: NOW });
  assert.ok(!list(u.id).some(a => a.title.startsWith("TOK")));
});

test("MIME: Turkish encoded subject, ISO-8859-9 quoted-printable body, envelope address", () => {
  const m = parseMime(fx("k12net-turkish.eml"));
  assert.equal(m.subject, "Yeni Ödev: Türk Dili ve Edebiyatı - Şiir analizi");
  assert.match(m.text, /Son teslim tarihi: 30\.09\.2026 17:00/);
  assert.match(m.text, /Türk Dili ve Edebiyatı dersi için/);
  assert.ok(m.deliveredTo.includes("abc234xyz789@in.hub.test"));
  assert.equal(m.fromAddress, "bildirim@k12net.com");
});

test("forwarded K12net email becomes an assignment (Turkish, rule-based)", async () => {
  const { email } = await signUp(srv.base);
  setToken(email, "abc234xyz789");
  const res = await inbound(fx("k12net-turkish.eml"));
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.results[0].action, "added");
  const a = list(userRow(email).id)[0];
  assert.equal(a.source, "K12net");
  assert.equal(a.title, "Şiir analizi");
  assert.equal(a.subject, "Türk Dili ve Edebiyatı");
  assert.deepEqual(JSON.parse(a.reqs), ["En az 400 kelime"]);
  assert.equal(a.due, "2026-09-30T14:00:00.000Z"); // 17:00 Istanbul
  assert.equal(a.link, "https://okul.k12net.com/odev/12345");
  // the same email again is ignored
  assert.equal((await (await inbound(fx("k12net-turkish.eml"))).json()).status, "duplicate");
  setToken(email, "retired" + Math.random().toString(36).slice(2, 8));
});

test("same task from ManageBac and a Kognity email is merged, not duplicated", async () => {
  const { email } = await signUp(srv.base);
  const u = userRow(email);
  setToken(email, "merge234test");
  importFeedText(srv.db, u, fx("sample-managebac.ics"), { now: NOW });
  const before = list(u.id).length;
  const raw = fx("kognity.eml").replace("To: pac.student@gmail.com", "To: pac.student@gmail.com");
  const r = await (await inbound(raw, "merge234test@in.hub.test")).json();
  assert.equal(r.results[0].action, "merged");
  assert.equal(list(u.id).length, before);
  const bio = list(u.id).find(a => a.title.includes("3.2"));
  assert.equal(bio.source, "ManageBac");            // the calendar is trusted more than the email
  assert.equal(bio.due, "2026-09-26T18:00:00.000Z"); // same moment either way (21:00 Istanbul)
  setToken(email, "retired" + Math.random().toString(36).slice(2, 8));
});

test("Gmail forwarding confirmation code is captured and shown to the student", async () => {
  const { email, c } = await signUp(srv.base);
  setToken(email, "abc234xyz789");
  const r = await (await inbound(fx("gmail-confirm.eml"))).json();
  assert.equal(r.status, "confirm");
  const conns = (await c.call("GET", "/api/connections")).body;
  assert.equal(conns.forwarding.confirm.code, "482917365");
  assert.match(conns.forwarding.confirm.link, /^https:\/\/mail-settings\.google\.com\//);
  setToken(email, "retired" + Math.random().toString(36).slice(2, 8));
});

test("inbound webhook: wrong secret refused, unknown address ignored, JSON (Postmark) works", async () => {
  const bad = await fetch(`${srv.base}/api/inbound/email`, { method: "POST", headers: { "X-Inbound-Secret": "nope" }, body: "x" });
  assert.equal(bad.status, 401);
  const unknown = await inbound(fx("kognity.eml"), "nobody@in.hub.test");
  assert.equal(unknown.status, 202);
  const { email } = await signUp(srv.base);
  setToken(email, "postmark234");
  const pm = await fetch(`${srv.base}/api/inbound/email`, {
    method: "POST", headers: { "Content-Type": "application/json", "X-Inbound-Secret": "inbound-test-secret" },
    body: JSON.stringify({ From: "Padlet <notifications@padlet.com>", To: "me@gmail.com", OriginalRecipient: "postmark234@in.hub.test", Subject: "New post: Homework - TOK exhibition ideas due 2 Oct", TextBody: "Post your 3 objects. Due 2 October 2026 23:59", MessageID: "pm-1" }),
  });
  assert.equal(pm.status, 200);
  const a = list(userRow(email).id)[0];
  assert.equal(a.source, "Padlet");
});

test("newsletters and login alerts are ignored", async () => {
  const { email } = await signUp(srv.base);
  setToken(email, "noise234test");
  const raw = "From: ManageBac <no-reply@managebac.com>\nSubject: Security alert: new sign-in\nMessage-ID: <n1>\n\nSomeone signed in to your account.";
  const r = await (await inbound(raw, "noise234test@in.hub.test")).json();
  assert.equal(r.status, "ignored");
  assert.equal(list(userRow(email).id).length, 0);
});

test("browser extension: token auth, page text becomes assignments, no duplicates on re-send", async () => {
  const { c, email } = await signUp(srv.base);
  const t = (await c.call("POST", "/api/tokens", { name: "Chrome" })).body.token;
  assert.match(t, /^hh_/);
  const page = { url: "https://app.kognity.com/assignments", title: "Assignments", text: "Assignments\nBiology SL\nTopic 4.1 practice questions\nDue 3 October 2026 21:00\nEssay draft for TOK\nDue 5 Oct 2026" };
  const send = () => fetch(`${srv.base}/api/ingest/page`, { method: "POST", headers: { Authorization: `Bearer ${t}`, "Content-Type": "application/json" }, body: JSON.stringify(page) }).then(r => r.json());
  const first = await send();
  assert.equal(first.added, 2);
  const second = await send();
  assert.equal(second.added, 0);
  assert.equal(list(userRow(email).id).length, 2);
  // the token can't be used for anything else
  const other = await fetch(`${srv.base}/api/assignments`, { headers: { Authorization: `Bearer ${t}` } });
  assert.equal(other.status, 403);
});

test("ManageBac link validation", () => {
  assert.equal(normalizeFeedUrl("webcal://myschool.managebac.com/student/calendar/abc.ics"), "https://myschool.managebac.com/student/calendar/abc.ics");
  assert.throws(() => normalizeFeedUrl("https://evil.example/cal.ics"), { code: "not_managebac" });
});

test("title similarity used for matching", () => {
  assert.ok(similarity("Topic 3.2 practice questions", "New assignment: Topic 3.2 practice questions") > 0.9);
  assert.ok(similarity("Topic 3.2 practice questions", "Topic 4.1 practice questions") < 0.8);
});

test("pasted messages without AI: clean title, subject, due date, requirements", async () => {
  const { pasteRules } = await import("../server/sync/email.js");
  const now = new Date("2026-09-25T12:00:00Z"), tz = "Europe/Istanbul";
  const [a] = pasteRules("Econ: finish the IA commentary draft, max 800 words, upload as PDF. Due Monday 23:59", { now, tz });
  assert.deepEqual([a.title, a.subject, a.due, a.reqs], ["Finish the IA commentary draft", "Economics", "2026-09-28T20:59:00.000Z", ["Max 800 words", "Upload as PDF"]]);
  const [b] = pasteRules("Merhaba arkadaşlar, Türk Dili: şiir analizi ödevi en az 400 kelime, son teslim 30.09.2026", { now, tz });
  assert.deepEqual([b.title, b.subject, b.reqs], ["Şiir analizi ödevi", "Türk Dili ve Edebiyatı", ["En az 400 kelime"]]);
});
