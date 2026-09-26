// Finds a due date inside free text (emails, pages). English + Turkish.
import { zonedToDate } from "./sync/ics.js";

const MONTHS = {
  jan: 1, january: 1, ocak: 1, feb: 2, february: 2, şubat: 2, subat: 2, mar: 3, march: 3, mart: 3,
  apr: 4, april: 4, nisan: 4, may: 5, mayıs: 5, mayis: 5, jun: 6, june: 6, haziran: 6,
  jul: 7, july: 7, temmuz: 7, aug: 8, august: 8, ağustos: 8, agustos: 8, sep: 9, sept: 9, september: 9, eylül: 9, eylul: 9,
  oct: 10, october: 10, ekim: 10, nov: 11, november: 11, kasım: 11, kasim: 11, dec: 12, december: 12, aralık: 12, aralik: 12,
};
const WEEKDAYS = [
  ["sunday", "sun", "pazar"], ["monday", "mon", "pazartesi"], ["tuesday", "tue", "tues", "salı", "sali"],
  ["wednesday", "wed", "çarşamba", "carsamba"], ["thursday", "thu", "thur", "thurs", "perşembe", "persembe"],
  ["friday", "fri", "cuma"], ["saturday", "sat", "cumartesi"],
];
const MONTH_RE = Object.keys(MONTHS).sort((a, b) => b.length - a.length).join("|");
const DAY_RE = WEEKDAYS.flat().sort((a, b) => b.length - a.length).join("|");
const KEYWORDS = /\b(due|deadline|by|until|before|submit|submission|closes?)\b|teslim|son\s+tarih|bitiş|bitis|tarihine\s+kadar|kadar/giu;

// Wall-clock parts of "now" in the student's time zone.
function nowParts(now, tz) {
  const f = new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric", month: "numeric", day: "numeric", weekday: "short" });
  const p = Object.fromEntries(f.formatToParts(now).map(x => [x.type, x.value]));
  const wd = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(p.weekday);
  return { y: +p.year, m: +p.month, d: +p.day, wd };
}
function addDays({ y, m, d }, n) {
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}

function toTime(h, mi, ap) {
  h = +h; mi = +(mi || 0); ap = (ap || "").toLowerCase();
  if (ap === "pm" && h < 12) h += 12;
  if (ap === "am" && h === 12) h = 0;
  return h <= 23 && mi <= 59 ? { h, mi } : null;
}
// "Friday 23:59", "29 Sep, 11:59 pm", "29.09.2026 saat 17.00"
function timeAfter(t, from) {
  const tail = t.slice(from, from + 30);
  let m = tail.match(/^[\s,\-–]*(?:at|saat|@)?\s*(\d{1,2})[:.](\d{2})(?![./]\d)(?:\s*(am|pm))?/i);
  if (m) return toTime(m[1], m[2], m[3]);
  m = tail.match(/^[\s,\-–]*(?:at|saat|@)?\s*(\d{1,2})\s*(am|pm)\b/i);
  return m ? toTime(m[1], 0, m[2]) : null;
}
// "11:59 PM on Friday", "17:00, 29.09.2026"
function timeBefore(t, idx) {
  const head = t.slice(Math.max(0, idx - 24), idx);
  const m = head.match(/(\d{1,2})[:.](\d{2})\s*(am|pm)?\s*(?:on|,|-|–)?\s*$/i) || head.match(/(\d{1,2})\s*(am|pm)\s*(?:on|,)?\s*$/i);
  if (!m) return null;
  return m.length === 5 ? toTime(m[1], m[2], m[3]) : toTime(m[1], 0, m[2]);
}

/** Returns every date mention with its position. */
export function findDates(text, { now = new Date(), tz = "Europe/Istanbul" } = {}) {
  const t = text.toLocaleLowerCase("tr");
  const today = nowParts(now, tz);
  const out = [];
  const push = (idx, len, ymd) => {
    if (!ymd || ymd.m < 1 || ymd.m > 12 || ymd.d < 1 || ymd.d > 31) return;
    const time = timeAfter(t, idx + len) || timeBefore(t, idx);
    out.push({ idx, ymd, time });
  };
  const fixYear = (y, m, d) => {
    if (y) return y < 100 ? 2000 + y : y;
    // no year given: pick the next occurrence (allow ~2 months in the past for late reminders)
    let yy = today.y;
    const diff = Date.UTC(yy, m - 1, d) - Date.UTC(today.y, today.m - 1, today.d);
    if (diff < -60 * 864e5) yy++;
    return yy;
  };
  let m;
  // ISO: 2026-09-29
  for (const r of t.matchAll(/\b(20\d{2})-(\d{1,2})-(\d{1,2})\b/g)) push(r.index, r[0].length, { y: +r[1], m: +r[2], d: +r[3] });
  // 29.09.2026 / 29/09/26 / 29-09-2026 (day first, as used in Turkey and the IB)
  for (const r of t.matchAll(/\b(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})\b/g)) push(r.index, r[0].length, { y: fixYear(+r[3]), m: +r[2], d: +r[1] });
  // 29.09 (no year) — only when followed by a time or preceded by a keyword, to avoid version numbers like 3.2
  for (const r of t.matchAll(/(?<![\d.])(\d{1,2})[./](\d{1,2})(?![\d./])/g)) {
    const before = t.slice(Math.max(0, r.index - 25), r.index);
    if (!/(due|deadline|by|until|teslim|tarih)/.test(before) && !/^\s*(,|at|saat)?\s*\d{1,2}[:.]\d{2}/.test(t.slice(r.index + r[0].length, r.index + r[0].length + 12))) continue;
    push(r.index, r[0].length, { y: fixYear(0, +r[2], +r[1]), m: +r[2], d: +r[1] });
  }
  // 29 September 2026 / 29 Eylül / 29th Sep
  for (const r of t.matchAll(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(${MONTH_RE})\\.?(?:,?\\s+(\\d{4}))?`, "giu")))
    push(r.index, r[0].length, { y: fixYear(r[3] ? +r[3] : 0, MONTHS[r[2]], +r[1]), m: MONTHS[r[2]], d: +r[1] });
  // September 29, 2026 / Sep 29
  for (const r of t.matchAll(new RegExp(`\\b(${MONTH_RE})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?\\b`, "giu")))
    push(r.index, r[0].length, { y: fixYear(r[3] ? +r[3] : 0, MONTHS[r[1]], +r[2]), m: MONTHS[r[1]], d: +r[2] });
  // today / tonight / tomorrow / bugün / yarın
  for (const r of t.matchAll(/\b(today|tonight|tomorrow)\b|bugün|yarın|yarin/giu)) {
    const w = r[0]; push(r.index, w.length, addDays(today, /tomorrow|yarın|yarin/.test(w) ? 1 : 0));
  }
  // weekday names -> the next such day (today counts if a later time is given)
  for (const r of t.matchAll(new RegExp(`(?<![\\p{L}])(next\\s+|this\\s+|gelecek\\s+|önümüzdeki\\s+)?(${DAY_RE})(?![\\p{L}])`, "giu"))) {
    const idx = WEEKDAYS.findIndex(list => list.includes(r[2]));
    let add = (idx - today.wd + 7) % 7;
    if (add === 0) add = 7;
    if (r[1] && /next|gelecek|önümüzdeki/.test(r[1]) && add < 7) add += 0; // "next Friday" = the coming Friday in everyday use
    push(r.index, r[0].length, addDays(today, add));
  }
  return out.sort((a, b) => a.idx - b.idx);
}

/** Best due date in the text, as an ISO string (UTC), or null. */
export function parseDueFromText(text, { now = new Date(), tz = "Europe/Istanbul" } = {}) {
  if (!text) return null;
  const dates = findDates(text, { now, tz });
  if (!dates.length) return null;
  // Prefer a date that comes right after a "due / teslim" style keyword.
  const lower = text.toLocaleLowerCase("tr");
  let best = null, bestScore = -Infinity;
  const kws = [...lower.matchAll(KEYWORDS)].map(k => k.index + k[0].length);
  for (const d of dates) {
    let score = -d.idx / 1000;                                   // earlier in the text is slightly better
    for (const k of kws) { const gap = d.idx - k; if (gap >= 0 && gap < 40) score = Math.max(score, 10 - gap / 5); }
    const kwBefore = kws.find(k => k <= d.idx && d.idx - k < 40);
    if (!kwBefore) for (const k of kws) { const gap = k - d.idx; if (gap > 0 && gap < 25) score = Math.max(score, 5 - gap / 5); } // "29.09 tarihine kadar"
    if (d.time) score += 1;
    if (score > bestScore) { bestScore = score; best = d; }
  }
  const { ymd, time } = best;
  const date = zonedToDate(ymd.y, ymd.m, ymd.d, time ? time.h : 23, time ? time.mi : 59, 0, tz);
  return isNaN(date) ? null : date.toISOString();
}
