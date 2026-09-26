// Reads a raw email (RFC 822 / MIME) into { from, to, subject, text, html, ... } with no dependencies.
import { stripHtml } from "./ics.js";

function decodeBytes(bytes, charset = "utf-8") {
  const cs = String(charset).toLowerCase().replace(/^"|"$/g, "");
  try { return new TextDecoder(cs === "us-ascii" ? "utf-8" : cs).decode(bytes); }
  catch { return new TextDecoder("utf-8").decode(bytes); }
}
const latin1Bytes = s => Buffer.from(s, "latin1");

function decodeQP(s) {
  const clean = s.replace(/=\r?\n/g, "");
  const out = [];
  for (let i = 0; i < clean.length; i++) {
    const c = clean[i];
    if (c === "=" && /^[0-9A-Fa-f]{2}$/.test(clean.slice(i + 1, i + 3))) { out.push(parseInt(clean.slice(i + 1, i + 3), 16)); i += 2; }
    else out.push(clean.charCodeAt(i) & 0xff);
  }
  return Buffer.from(out);
}

// =?UTF-8?B?...?= and =?ISO-8859-9?Q?...?= (RFC 2047). Adjacent encoded words join without the space between them.
export function decodeWords(s) {
  if (!s) return "";
  return s.replace(/(=\?[^?]+\?[bqBQ]\?[^?]*\?=)\s+(?==\?)/g, "$1")
    .replace(/=\?([^?*]+)(?:\*[^?]*)?\?([bqBQ])\?([^?]*)\?=/g, (_, cs, enc, data) => {
      const bytes = enc.toUpperCase() === "B" ? Buffer.from(data, "base64") : decodeQP(data.replace(/_/g, " "));
      return decodeBytes(bytes, cs);
    });
}

function parseHeaders(block) {
  const headers = {};
  const unfolded = block.replace(/\r?\n[ \t]+/g, " ");
  for (const line of unfolded.split(/\r?\n/)) {
    const i = line.indexOf(":");
    if (i <= 0) continue;
    const k = line.slice(0, i).trim().toLowerCase(), v = line.slice(i + 1).trim();
    (headers[k] ||= []).push(v);
  }
  return headers;
}
const h1 = (headers, k) => (headers[k] || [])[0] || "";

function parseParams(value) {
  const [type, ...rest] = value.split(";");
  const params = {};
  for (const p of rest) {
    const i = p.indexOf("=");
    if (i > 0) params[p.slice(0, i).trim().toLowerCase().replace(/\*$/, "")] = p.slice(i + 1).trim().replace(/^"|"$/g, "").replace(/^utf-8''/i, "");
  }
  return { type: type.trim().toLowerCase(), params };
}

function splitHeadBody(raw) {
  const m = raw.match(/\r?\n\r?\n/);
  if (!m) return [raw, ""];
  return [raw.slice(0, m.index), raw.slice(m.index + m[0].length)];
}

function walk(raw, acc, depth = 0) {
  if (depth > 8) return;
  const [head, body] = splitHeadBody(raw);
  const headers = parseHeaders(head);
  const ct = parseParams(h1(headers, "content-type") || "text/plain; charset=us-ascii");
  const disp = h1(headers, "content-disposition").toLowerCase();
  const enc = h1(headers, "content-transfer-encoding").toLowerCase();

  if (ct.type.startsWith("multipart/") && ct.params.boundary) {
    const b = "--" + ct.params.boundary;
    const parts = body.split(b).slice(1);
    for (const part of parts) {
      if (part.startsWith("--")) break;
      walk(part.replace(/^\r?\n/, ""), acc, depth + 1);
    }
    return;
  }
  if (ct.type === "message/rfc822") { walk(body, acc, depth + 1); return; }
  if (disp.startsWith("attachment")) { acc.attachments.push(decodeWords(ct.params.name || "") || "attachment"); return; }
  if (!ct.type.startsWith("text/")) return;

  const bytes = enc === "base64" ? Buffer.from(body.replace(/\s+/g, ""), "base64")
    : enc === "quoted-printable" ? decodeQP(body) : latin1Bytes(body);
  const text = decodeBytes(bytes, ct.params.charset || "utf-8");
  if (ct.type === "text/html" && !acc.html) acc.html = text;
  else if (ct.type === "text/plain" && !acc.text) acc.text = text;
}

const addr = v => { const m = String(v).match(/<([^>]+)>/); return (m ? m[1] : String(v)).trim().toLowerCase(); };
export const addressesIn = v => String(v || "").split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/).map(addr).filter(a => a.includes("@"));

export function parseMime(input) {
  const raw = Buffer.isBuffer(input) ? input.toString("latin1") : String(input);
  const [head] = splitHeadBody(raw);
  const headers = parseHeaders(head);
  const acc = { text: "", html: "", attachments: [] };
  walk(raw, acc);
  const text = acc.text || stripHtml(acc.html);
  return {
    from: decodeWords(h1(headers, "from")),
    fromAddress: addr(decodeWords(h1(headers, "from"))),
    to: addressesIn(h1(headers, "to")),
    cc: addressesIn(h1(headers, "cc")),
    subject: decodeWords(h1(headers, "subject")),
    messageId: h1(headers, "message-id").replace(/[<>]/g, ""),
    date: h1(headers, "date"),
    // Where the mail was actually delivered (needed for forwarding, where To: is still the student's own address)
    deliveredTo: [...(headers["delivered-to"] || []), ...(headers["x-original-to"] || []), ...(headers["x-forwarded-to"] || []), ...(headers["envelope-to"] || [])].flatMap(addressesIn),
    text: text.replace(/\r\n/g, "\n").trim(),
    html: acc.html,
    attachments: acc.attachments,
  };
}
