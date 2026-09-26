// Calendar (.ics) reading: parse -> classify (homework or not) -> normalize into a clean assignment.

/* ------------------------------------------------------------------ */
/* 1. ICS parsing                                                      */
/* ------------------------------------------------------------------ */

function unfold(text) {
  // RFC 5545: long lines are folded with CRLF + a single space or tab.
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\n[ \t]/g, "");
}

function unescapeText(v) {
  return v.replace(/\\n/gi, "\n").replace(/\\,/g, ",").replace(/\\;/g, ";").replace(/\\\\/g, "\\");
}

function parseLine(line) {
  // NAME;PARAM=VAL;PARAM="quoted:val":value  (colons may appear inside quoted params)
  let i = 0, inQuote = false;
  for (; i < line.length; i++) {
    const c = line[i];
    if (c === '"') inQuote = !inQuote;
    else if (c === ":" && !inQuote) break;
  }
  const head = line.slice(0, i), value = line.slice(i + 1);
  const parts = head.split(";");
  const name = parts.shift().toUpperCase();
  const params = {};
  for (const p of parts) {
    const eq = p.indexOf("=");
    if (eq > 0) params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1).replace(/^"|"$/g, "");
  }
  return { name, params, value };
}

function tzOffsetMs(utcMs, timeZone) {
  const f = new Intl.DateTimeFormat("en-US", {
    timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  const p = Object.fromEntries(f.formatToParts(new Date(utcMs)).map(x => [x.type, x.value]));
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - utcMs;
}

export function zonedToDate(y, mo, d, h, mi, s, timeZone) {
  const wall = Date.UTC(y, mo - 1, d, h, mi, s);
  try {
    const off1 = tzOffsetMs(wall, timeZone);
    let t = wall - off1;
    const off2 = tzOffsetMs(t, timeZone);
    if (off2 !== off1) t = wall - off2; // DST edge
    return new Date(t);
  } catch {
    return new Date(y, mo - 1, d, h, mi, s); // unknown TZID -> device local time
  }
}

export function parseICSDate(value, params = {}, tz) {
  const local = (y, mo, d, h, mi, sec) => tz ? zonedToDate(y, mo, d, h, mi, sec, tz) : new Date(y, mo - 1, d, h, mi, sec);
  const v = value.trim();
  const m = v.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/);
  if (!m) return null;
  const [, y, mo, d, h, mi, s, z] = m;
  if (h === undefined || params.VALUE === "DATE") {
    // All-day: treat as due end of that day in local time.
    return { date: local(+y, +mo, +d, 23, 59, 0), allDay: true };
  }
  if (z) return { date: new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, +(s || 0))), allDay: false };
  if (params.TZID) return { date: zonedToDate(+y, +mo, +d, +h, +mi, +(s || 0), params.TZID), allDay: false };
  return { date: local(+y, +mo, +d, +h, +mi, +(s || 0)), allDay: false }; // floating time = the student's local time
}

export function parseICS(text, { tz } = {}) {
  if (typeof text !== "string" || !/BEGIN:VCALENDAR/i.test(text)) {
    throw Object.assign(new Error("Not a calendar file"), { code: "not_ics" });
  }
  const lines = unfold(text).split("\n");
  const events = [];
  let cur = null, depth = 0;
  for (const raw of lines) {
    if (!raw.trim()) continue;
    const { name, params, value } = parseLine(raw);
    if (name === "BEGIN" && value.toUpperCase() === "VEVENT") { cur = { categories: [] }; depth = 0; continue; }
    if (!cur) continue;
    if (name === "BEGIN") { depth++; continue; }            // e.g. VALARM inside an event
    if (name === "END" && depth > 0) { depth--; continue; }
    if (depth > 0) continue;
    if (name === "END" && value.toUpperCase() === "VEVENT") { if (cur.uid && cur.start) events.push(cur); cur = null; continue; }
    switch (name) {
      case "UID": cur.uid = value.trim(); break;
      case "SUMMARY": cur.summary = unescapeText(value).trim(); break;
      case "DESCRIPTION": cur.description = unescapeText(value); break;
      case "LOCATION": cur.location = unescapeText(value).trim(); break;
      case "URL": cur.url = value.trim(); break;
      case "STATUS": cur.status = value.trim().toUpperCase(); break;
      case "RRULE": cur.recurring = true; break;
      case "CATEGORIES": cur.categories.push(...unescapeText(value).split(",").map(s => s.trim()).filter(Boolean)); break;
      case "DTSTART": { const r = parseICSDate(value, params, tz); if (r) { cur.start = r.date; cur.allDay = r.allDay; } break; }
      case "DTEND": { const r = parseICSDate(value, params, tz); if (r) cur.end = r.date; break; }
      case "LAST-MODIFIED": { const r = parseICSDate(value, params, tz); if (r) cur.modified = r.date; break; }
    }
  }
  return events;
}

/* ------------------------------------------------------------------ */
/* 2. Classification: is this event homework, or just a calendar event? */
/* ------------------------------------------------------------------ */

const STRONG_TASK = /\b(due|deadline|submit|submission|homework|hw|assignment|summative|formative|internal assessment|extended essay|lab report|worksheet|problem set|pset|draft|quiz|test|exam|essay|commentary|presentation|project|coursework|reading|practice questions?|tok exhibition|portfolio|individual oral|outline|proposal|reflection|research question|annotations?)\b/i;
const IB_CODES = /\b(IA|EE|TOK|CAS|IO|HL|SL)\b/;
const NOT_TASK = /\b(holiday|break|vacation|assembly|parent|meeting|conference|trip|excursion|fair|ceremony|graduation|no school|day off|sports day|club|practice match|homeroom|advisory|lunch|timetable|period \d|block [a-h])\b/i;
const TASK_URL = /\/(core_)?tasks?\/|\/assignments?\//i;

export function classify(ev) {
  let score = 0; const why = [];
  const text = `${ev.summary || ""} ${ev.categories.join(" ")}`;
  const desc = ev.description || "";
  if (ev.url && TASK_URL.test(ev.url)) { score += 3; why.push("task link"); }
  if (STRONG_TASK.test(text)) { score += 2; why.push("task word in title"); }
  else if (STRONG_TASK.test(desc)) { score += 1; why.push("task word in description"); }
  if (IB_CODES.test(ev.summary || "")) { score += 1; why.push("IB code"); }
  if (/\b\d+\s*(words?|pages?|slides?|questions?)\b/i.test(`${text} ${desc}`)) { score += 1; why.push("length requirement"); }
  if (ev.recurring) { score -= 4; why.push("repeats (timetable)"); }
  if (NOT_TASK.test(text)) { score -= 3; why.push("event word"); }
  if (ev.status === "CANCELLED") { score -= 10; why.push("cancelled"); }
  if (ev.end && ev.start && !ev.allDay && ev.end - ev.start >= 3 * 3600e3) { score -= 1; why.push("long event"); }
  const kind = score >= 2 ? "assignment" : score <= 0 ? "event" : "unsure";
  return { kind, score, why };
}

/* ------------------------------------------------------------------ */
/* 3. Normalization: clean title, subject, requirements                */
/* ------------------------------------------------------------------ */

const SUBJECTS = [
  ["Math AA", /\bmath(ematics)?\s*(:?\s*)?(analysis|aa)\b/i], ["Math AI", /\bmath(ematics)?\s*(:?\s*)?(applications|ai)\b/i],
  ["Math", /\bmath(ematics)?\b/i], ["Biology", /\bbio(logy)?\b/i], ["Chemistry", /\bchem(istry)?\b/i], ["Physics", /\bphysics\b/i],
  ["Economics", /\becon(omics)?\b/i], ["Business", /\bbusiness( management)?\b/i], ["Psychology", /\bpsych(ology)?\b/i],
  ["History", /\bhistory\b/i], ["Geography", /\bgeography\b/i], ["Computer Science", /\b(computer science|comp ?sci|cs)\b/i],
  ["English", /\benglish\b/i], ["Turkish", /\b(turkish|türkçe|turkce)\b/i], ["Spanish", /\bspanish\b/i], ["French", /\bfrench\b/i],
  ["German", /\bgerman\b/i], ["Visual Arts", /\bvisual arts?\b/i], ["Music", /\bmusic\b/i], ["Film", /\bfilm\b/i],
  ["ESS", /\b(ess|environmental systems)\b/i], ["Design Technology", /\bdesign tech(nology)?\b/i],
  ["Global Politics", /\bglobal politics\b/i], ["TOK", /\b(tok|theory of knowledge)\b/i], ["EE", /\b(ee|extended essay)\b/i], ["CAS", /\bcas\b/i],
];
// Turkish names used by K12net and Turkish teachers (whole words only, so "teslim tarihi" isn't History)
const W = w => new RegExp(`(?<![\\p{L}])(?:${w})(?![\\p{L}])`, "iu");
SUBJECTS.unshift(
  ["Türk Dili ve Edebiyatı", W("türk dili(?: ve edebiyatı)?|edebiyat|tde")], ["Math", W("matematik")], ["Physics", W("fizik")],
  ["Chemistry", W("kimya")], ["Biology", W("biyoloji")], ["History", W("tarih")], ["Geography", W("coğrafya|cografya")],
  ["English", W("[iİ]ngilizce")], ["Economics", W("ekonomi")], ["Psychology", W("psikoloji")], ["Philosophy", W("felsefe")],
  ["TOK", W("bilgi kuramı")], ["Visual Arts", W("görsel sanatlar")], ["Music", W("müzik")],
);

export function detectSubject(...texts) {
  for (const t of texts) {
    if (!t) continue;
    for (const [name, re] of SUBJECTS) {
      if (re.test(t)) {
        const level = (t.match(/\b(HL|SL)\b/) || [])[1];
        return level && !["TOK", "EE", "CAS"].includes(name) ? `${name} ${level}` : name;
      }
    }
  }
  return "";
}

export function stripHtml(s) {
  return (s || "").replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|li|div)>/gi, "\n").replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"');
}

// "DP Economics HL (Gr 11)" is just a class name; "TOK Exhibition" is part of the task name.
function isJustClassName(prefix) {
  if (!detectSubject(prefix)) return false;
  let rest = prefix;
  for (const [, re] of SUBJECTS) rest = rest.replace(new RegExp(re.source, "gi"), " ");
  rest = rest.replace(/\b(DP|IB|MYP|HL|SL|Y(ea)?r\s*\d+|Gr(ade)?\s*\d+|G\d+|\d{4}\s*[-–/]\s*\d{2,4}|class|group|[A-Z]\d?)\b/gi, " ").replace(/[()\[\],.]/g, " ");
  return rest.trim() === "";
}

function cleanTitle(summary, subject) {
  let t = (summary || "").trim();
  t = t.replace(/^\s*(deadline|due|task|assignment|homework|hw)\s*[:\-–]\s*/i, "");
  t = t.replace(/\s*[\[(](summative|formative)[\])]\s*/gi, " ");
  // Drop a leading class name like "DP Biology HL (Gr 11): " or "Economics - "
  const m = t.match(/^(.{2,60}?)\s*[:\-–|]\s+(.+)$/);
  if (m && isJustClassName(m[1])) t = m[2];
  return t.replace(/\s{2,}/g, " ").trim() || (summary || "Untitled task");
}

function extractRequirements(desc) {
  const lines = stripHtml(desc).split(/\n|(?<=[.!?])\s+/).map(s => s.trim()).filter(Boolean);
  const req = /\b\d+\s*(words?|pages?|slides?|questions?|minutes?|mins?|sources?)\b|\b(pdf|docx|upload|submit|turnitin|print|bring|handwritten|typed|cite|bibliography|rubric|criteri(a|on))\b/i;
  const out = [];
  for (const l of lines) if (req.test(l) && l.length <= 140 && !out.includes(l)) out.push(l.replace(/^[-•*]\s*/, ""));
  return out.slice(0, 5);
}

export function normalize(ev, cls) {
  const desc = stripHtml(ev.description || "").trim();
  const subject = detectSubject(ev.categories.join(" "), ev.summary, ev.location, desc.slice(0, 200));
  const text = `${ev.summary} ${ev.categories.join(" ")}`;
  return {
    ref: `managebac:${ev.uid}`,
    source: "ManageBac",
    rank: 3,
    title: cleanTitle(ev.summary, subject),
    subject,
    due: ev.start.toISOString(),
    allDay: !!ev.allDay,
    kind: /summative/i.test(text) ? "summative" : /formative/i.test(text) ? "formative" : null,
    reqs: extractRequirements(ev.description),
    notes: desc.slice(0, 600),
    link: ev.url || null,
    confidence: cls.kind === "assignment" ? "high" : "low",
  };
}


// Whole feed -> list of assignment candidates (+ what was skipped and why).
export function feedToCandidates(icsText, { tz } = {}) {
  const events = parseICS(icsText, { tz });
  const items = [], skipped = [];
  for (const ev of events) {
    const cls = classify(ev);
    if (cls.kind === "event") skipped.push({ title: ev.summary, why: cls.why });
    else items.push(normalize(ev, cls));
  }
  return { items, skipped, total: events.length };
}
