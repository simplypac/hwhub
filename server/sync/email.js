// Turns one email (from forwarding or Gmail) into assignments.
import { aiEnabled, aiExtract } from "../ai.js";
import { parseDueFromText } from "../dates.js";
import { detectSubject } from "./ics.js";
import { upsert, logIngest, alreadyIngested, RANK } from "./ingest.js";
import { tx, parseJSON } from "../db.js";

const PLATFORMS = [
  ["ManageBac", /managebac\./i],
  ["Kognity", /kognity\./i],
  ["K12net", /k12net\./i],
  ["Padlet", /padlet\./i],
  ["Classroom", /classroom\.google\.com|classroom-noreply@google\.com/i],
  ["Teams", /teams\.microsoft\.com|@teams\.mail\.microsoft|microsoft teams/i],
];
export function detectPlatform(msg) {
  const hay = `${msg.fromAddress || ""} ${msg.from || ""}`;
  for (const [name, re] of PLATFORMS) if (re.test(hay)) return name;
  // Manually forwarded mail: the original sender is inside the body
  const body = `${msg.subject || ""}\n${(msg.text || "").slice(0, 3000)}`;
  for (const [name, re] of PLATFORMS) if (re.test(body)) return name;
  return "Email";
}

const TASK_WORDS = /\b(assignment|homework|task|due|deadline|submit|submission|quiz|test|exam|essay|worksheet|project|lab report|reading|practice|draft|IA|EE|TOK)\b|ödev|odev|görev|gorev|teslim|sınav|sinav|proje|quiz|yazılı|yazili|çalışma kağıdı/iu;
const NOISE = /\b(password|verify your|sign[- ]?in|login|security alert|newsletter|unsubscribe from marketing|receipt|invoice|your order)\b|şifre|sifre|giriş|giris yap/iu;

export function looksLikeAssignment(msg, platform) {
  const subject = msg.subject || "", body = (msg.text || "").slice(0, 4000);
  if (NOISE.test(subject)) return false;
  if (TASK_WORDS.test(subject)) return true;
  return platform !== "Email" && TASK_WORDS.test(body);
}

// Gmail sends a confirmation code to a new forwarding address before it will forward anything.
export function forwardingConfirmation(msg) {
  const isGmail = /forwarding-noreply@google\.com/i.test(msg.fromAddress || msg.from || "");
  if (!isGmail) return null;
  const code = (msg.subject.match(/#(\d{6,12})/) || msg.text.match(/(?:code|kod)[^\d]{0,40}(\d{6,12})/i) || [])[1] || null;
  const link = (msg.text.match(/https:\/\/(?:mail(?:-settings)?\.google\.com|isolated\.mail\.google\.com)\/\S+/) || [])[0] || null;
  const requester = (msg.subject.match(/from\s+(\S+@\S+)/i) || msg.text.match(/(\S+@\S+)\s+has requested/i) || [])[1] || null;
  return { code, link: link && link.replace(/[)>.,]+$/, ""), requester, at: Date.now() };
}

const SUBJECT_PREFIX = /^\s*((re|fwd?|fw|ilt|i̇lt|ynt|tr)\s*:\s*|\[[^\]]{1,40}\]\s*|(new|yeni)\s+(task|assignment|homework|ödev|görev)\s*[:\-–]?\s*|(reminder|hatırlatma|hatirlatma)\s*[:\-–]\s*|you have (a )?new (task|assignment)\s*[:\-–]?\s*)+/iu;
export function cleanSubject(s) {
  let t = String(s || "").replace(SUBJECT_PREFIX, "").trim();
  t = t.replace(/\s*[-–|]\s*(managebac|kognity|k12net|padlet|google classroom)\s*$/i, "").trim();
  return t || String(s || "").trim();
}
function firstLink(text, platform) {
  const links = (text || "").match(/https:\/\/[^\s<>"')]+/g) || [];
  const host = { ManageBac: /managebac\./, Kognity: /kognity\./, K12net: /k12net\./, Padlet: /padlet\./, Classroom: /classroom\.google\.com/, Teams: /teams\.microsoft\.com/ }[platform];
  return (host && links.find(l => host.test(l))) || null;
}
const REQ = /\b\d+\s*(words?|pages?|slides?|questions?|minutes?|sources?|paragraphs?|kelime|sayfa|soru|slayt)\b|\b(pdf|docx|upload|submit|turnitin|print|bring|handwritten|cite|bibliography|rubric|mla|apa|double[- ]spaced|show (?:full |all )?working)\b|yükle|yukle|getir/iu;
const cap = s => s ? s[0].toLocaleUpperCase("tr") + s.slice(1) : s;
function requirementsFrom(text, exclude = "") {
  const out = [];
  const ex = exclude.toLowerCase();
  for (let frag of String(text || "").split(/\n|[;,]|(?<=[.!?])\s+/)) {
    frag = frag.trim().replace(/^[-•*\d.)\s]+/, "").replace(/[.!]+$/, "").trim();
    if (frag.length < 4 || frag.length > 140 || !REQ.test(frag) || /\b(due|deadline)\b|teslim/i.test(frag)) continue;
    const f = frag.toLowerCase();
    if (ex && (ex.includes(f) || f.includes(ex))) {
      // the line repeats the title; keep only the length part, e.g. "(en az 400 kelime)"
      const len = frag.match(/((?:en az|max(?:imum)?|at least|min(?:imum)?|up to)\s+)?\d+\s*(words?|pages?|slides?|questions?|kelime|sayfa|soru|slayt)\b/i);
      if (len && !out.some(o => o.toLowerCase() === len[0].toLowerCase())) out.push(cap(len[0]));
      continue;
    }
    if (!out.some(o => o.toLowerCase() === frag.toLowerCase())) out.push(cap(frag));
    if (out.length >= 5) break;
  }
  return out;
}

// A pasted chat message or post: "Econ: finish the IA draft, max 800 words, upload as PDF. Due Monday 23:59"
export function pasteRules(text, { now, tz }) {
  const lines = String(text).split(/\n+/).map(l => l.trim()).filter(l => l && !/^(hi|hello|hey|dear|merhaba|sevgili|selam)\b[^.!?:]{0,40}[,:!]?$/i.test(l));
  let body = lines.join(" ").replace(/^(hi|hello|hey|dear|merhaba|sevgili|selam)\b[^,:]{0,40}[,:]\s*/i, "");
  let subjectHint = "";
  const pre = body.match(/^([\p{L}\d .&/]{2,30}):\s+/u) || body.match(/^([\p{L}\d .&/]{2,30}?)\s+[-–]\s+/u);
  if (pre && (pre[0].includes(":") || detectSubject(pre[1]))) { subjectHint = pre[1].trim(); body = body.slice(pre[0].length); }
  let title = body.split(/(?<=[.!?])\s+/)[0];
  title = title.replace(/\s*[,;(\-–]?\s*\b(due|deadline|by|until|before)\b.*$/i, "").replace(/\s*[,;]?\s*(son\s+)?teslim.*$/i, "");
  const clauses = title.split(/\s*[,;]\s*/);
  title = clauses[0].split(/\s+/).length >= 3 || clauses.length === 1 ? clauses[0] : clauses.slice(0, 2).join(", ");
  const extra = [];
  const len = title.match(/\s+(en az|max(?:imum)?|at least|min(?:imum)?|up to|about|yaklaşık)\s+\d+\s*(words?|pages?|slides?|questions?|kelime|sayfa|soru|slayt)\b.*$/i)
    || title.match(/\s+\d{3,}\s*(words?|kelime)\b.*$/i);
  if (len && len.index > 8) { extra.push(cap(len[0].trim())); title = title.slice(0, len.index); }
  title = cap(title.replace(/[.!:]+$/, "").trim()).slice(0, 100);
  const due = parseDueFromText(text, { now, tz });
  const subject = detectSubject(subjectHint, text.slice(0, 300)) || (subjectHint.split(/\s+/).length <= 3 ? subjectHint : "");
  const reqs = [...extra, ...requirementsFrom(text, title)].filter((r, i, a) => a.findIndex(x => x.toLowerCase() === r.toLowerCase()) === i).slice(0, 5);
  return [{ title: title || cap(body.slice(0, 80)), subject, due, reqs }];
}

// "Türk Dili ve Edebiyatı - Şiir analizi" -> subject + "Şiir analizi"
function splitSubjectPrefix(title) {
  const m = title.match(/^(.{2,40}?)\s*(?:[-–:|])\s+(.{3,})$/u);
  return m && detectSubject(m[1]) ? { subject: detectSubject(m[1]), title: m[2] } : { subject: "", title };
}
export function ruleExtract(msg, platform, { now, tz }) {
  const split = splitSubjectPrefix(cleanSubject(msg.subject));
  const title = split.title.slice(0, 120);
  const text = `${msg.subject}\n${msg.text || ""}`;
  return [{
    title, subject: split.subject || detectSubject(msg.subject, (msg.text || "").slice(0, 400)),
    due: parseDueFromText(text.slice(0, 5000), { now, tz }),
    reqs: requirementsFrom((msg.text || "").slice(0, 3000), title), platform,
  }];
}

/**
 * msg: parsed email { messageId, from, fromAddress, subject, text }
 * channel: "email" (forwarding) or "gmail"
 */
export async function processEmail(db, user, msg, { channel = "email", extId, now = new Date(), connection } = {}) {
  const id = extId || msg.messageId || `${msg.fromAddress}|${msg.subject}|${msg.date}`;
  if (alreadyIngested(db, user.id, channel, id)) return { status: "duplicate", results: [] };

  const confirm = forwardingConfirmation(msg);
  if (confirm) {
    const conn = db.prepare("SELECT * FROM connections WHERE user_id = ? AND kind = 'forwarding'").get(user.id);
    const meta = { ...parseJSON(conn?.meta, {}), confirm };
    if (conn) db.prepare("UPDATE connections SET meta = ? WHERE id = ?").run(JSON.stringify(meta), conn.id);
    logIngest(db, user.id, channel, id, "confirm", "Gmail forwarding confirmation received");
    return { status: "confirm", confirm, results: [] };
  }

  const platform = detectPlatform(msg);
  if (!looksLikeAssignment(msg, platform)) {
    logIngest(db, user.id, channel, id, "ignored", `${platform}: ${msg.subject}`.slice(0, 200));
    return { status: "ignored", results: [] };
  }

  let found, method = "rules";
  if (aiEnabled()) {
    try {
      found = await aiExtract(`From: ${msg.from}\nSubject: ${msg.subject}\n\n${msg.text}`, { now, tz: user.tz, hint: platform, kind: "email" });
      method = "ai";
    } catch (e) { found = null; }
  }
  if (!found) found = ruleExtract(msg, platform, { now, tz: user.tz });
  // Rule-based reading of a platform email with no date and a vague title is too unreliable to add.
  if (method === "rules") found = found.filter(f => f.due || platform !== "Email");

  const link = firstLink(msg.text, platform);
  const results = tx(db, () => found.map((f, i) => upsert(db, user.id, {
    ref: `${channel}:${id}#${i}`, source: normalizePlatform(f.platform, platform), rank: RANK.email,
    title: f.title, subject: f.subject || detectSubject(msg.subject), due: f.due, reqs: f.reqs,
    notes: "", link, confidence: method === "ai" || f.due ? "high" : "low",
  }, { now: now.getTime() })));
  const summary = results.length ? results.map(r => `${r.action}: ${r.title}`).join("; ") : `No task found in "${msg.subject}"`;
  logIngest(db, user.id, channel, id, results.length ? "ok" : "ignored", summary);
  return { status: "ok", method, platform, results };
}

const KNOWN = ["ManageBac", "Kognity", "K12net", "Padlet", "Classroom", "Teams", "WhatsApp", "Email", "Other"];
export function normalizePlatform(p, fallback = "Email") {
  const hit = KNOWN.find(k => k.toLowerCase() === String(p || "").toLowerCase());
  // Trust the sender over the AI's guess when the sender is a known platform.
  return fallback !== "Email" ? fallback : hit || fallback;
}
