// Optional AI layer. Without ANTHROPIC_API_KEY the app still works using the rule-based readers.
import { config } from "./config.js";
import { zonedToDate } from "./sync/ics.js";

export const aiEnabled = () => !!config.ai.key;

async function callClaude({ system, user, maxTokens = 1200, timeoutMs = 30000 }) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      signal: ctl.signal,
      headers: { "content-type": "application/json", "x-api-key": config.ai.key, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: config.ai.model, max_tokens: maxTokens, system, messages: [{ role: "user", content: user }] }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw Object.assign(new Error(`AI request failed (${res.status})`), { code: res.status === 429 ? "ai_busy" : "ai_error", detail: detail.slice(0, 300) });
    }
    const data = await res.json();
    return (data.content || []).filter(b => b.type === "text").map(b => b.text).join("");
  } catch (e) {
    if (e.name === "AbortError") throw Object.assign(new Error("AI took too long"), { code: "ai_timeout" });
    throw e;
  } finally { clearTimeout(timer); }
}

function parseJSONLoose(text) {
  const clean = text.replace(/```(?:json)?/gi, "").trim();
  const start = clean.indexOf("{"), end = clean.lastIndexOf("}");
  if (start < 0 || end < start) throw Object.assign(new Error("AI didn't return JSON"), { code: "ai_bad_output" });
  return JSON.parse(clean.slice(start, end + 1));
}

const EXTRACT_SYSTEM = `You pull homework out of school messages for an IB Diploma student in Turkey.
Messages may be in English or Turkish and may come from ManageBac, Kognity, K12net, Padlet, Google Classroom, Teams, WhatsApp or a teacher's email.
Only extract real tasks the student must do or submit (homework, assignments, readings, practice, tests/quizzes to prepare for, IA/EE/TOK milestones).
Ignore: grades already given, announcements with no task, login alerts, newsletters, marketing, and anything already past due by more than 2 days.
Reply with JSON only, no prose.`;

/**
 * text -> [{ title, subject, due (ISO UTC|null), requirements[], platform }]
 * kind: "email" | "page" | "paste"
 */
export async function aiExtract(text, { now = new Date(), tz = config.defaultTz, hint = "", kind = "email" } = {}) {
  const local = new Intl.DateTimeFormat("en-GB", { timeZone: tz, weekday: "long", day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit" }).format(now);
  const user = `Right now it is ${local} in ${tz}.
Source: ${kind}${hint ? ` (${hint})` : ""}.

Return exactly:
{"assignments":[{"title":"clear task name in the message's language, max 70 chars, no subject prefix","subject":"school subject if known (e.g. Economics HL, Biology SL, Math AA HL, TOK, Türk Dili ve Edebiyatı) else empty","due":"YYYY-MM-DDTHH:MM in ${tz} local time, or null","requirements":["up to 5 short concrete items: length, format, pages/questions, how to submit"],"platform":"ManageBac|Kognity|K12net|Padlet|Classroom|Teams|WhatsApp|Email|Other"}]}

Rules: one entry per separate task. Resolve "tomorrow", "Friday", "yarın", "Cuma" against the current date above; weekday names mean the next such day. Date only (no time) means 23:59. No task -> {"assignments":[]}.
${kind === "page" ? "This is the visible text of a web page the student opened. List every assignment shown with its due date; skip menus, navigation and completed items.\n" : ""}
<content>
${text.slice(0, kind === "page" ? 24000 : 12000)}
</content>`;
  const out = parseJSONLoose(await callClaude({ system: EXTRACT_SYSTEM, user, maxTokens: 1500 }));
  const list = Array.isArray(out.assignments) ? out.assignments : [];
  return list.filter(a => a && typeof a.title === "string" && a.title.trim()).slice(0, 30).map(a => ({
    title: a.title.trim().slice(0, 120),
    subject: typeof a.subject === "string" ? a.subject.trim().slice(0, 60) : "",
    due: localToISO(a.due, tz),
    reqs: Array.isArray(a.requirements) ? a.requirements.map(String).map(s => s.trim()).filter(Boolean).slice(0, 6) : [],
    platform: typeof a.platform === "string" ? a.platform : "",
  }));
}

function localToISO(v, tz) {
  if (typeof v !== "string") return null;
  const m = v.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/);
  if (!m) return null;
  const d = zonedToDate(+m[1], +m[2], +m[3], m[4] ? +m[4] : 23, m[5] ? +m[5] : 59, 0, tz);
  return isNaN(d) ? null : d.toISOString();
}

export async function aiPlan(tasks, { now = new Date(), tz = config.defaultTz } = {}) {
  const local = new Intl.DateTimeFormat("en-GB", { timeZone: tz, weekday: "long", hour: "2-digit", minute: "2-digit" }).format(now);
  const list = tasks.map(t => `- ${t.title} (${t.subject || "no subject"}) due ${t.due ? new Intl.DateTimeFormat("en-GB", { timeZone: tz, weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(new Date(t.due)) : "no date"}${t.reqs?.length ? "; " + t.reqs.join(", ") : ""}`).join("\n");
  return (await callClaude({
    system: "You help an IB student plan their evening. Be direct and friendly, like a helpful older student. Plain text only, no lists or markdown.",
    user: `It is ${local}. Unfinished work:\n${list}\n\nIn 3-4 sentences: what to do first and why (overdue and soonest first), rough time for each, and what can wait.`,
    maxTokens: 400,
  })).trim();
}
