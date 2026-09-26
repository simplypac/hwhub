const $ = s => document.querySelector(s);
const store = chrome.storage.local;
let cfg = {};

function say(text, cls = "") { const o = $("#out"); o.className = "msg " + cls; o.textContent = text; }
async function call(path, opts = {}) {
  const res = await fetch(cfg.server.replace(/\/+$/, "") + path, { ...opts, headers: { Authorization: `Bearer ${cfg.key}`, "Content-Type": "application/json", ...(opts.headers || {}) } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || (res.status === 401 ? "The key isn't valid any more. Create a new one in the app." : `Error ${res.status}`));
  return data;
}
function showSetup() { $("#setup").hidden = false; $("#main").hidden = true; $("#server").value = cfg.server || ""; $("#key").value = cfg.key || ""; }
async function showMain() {
  $("#setup").hidden = true; $("#main").hidden = false;
  try { const me = await call("/api/ping"); $("#who").textContent = `Signed in as ${me.name}.`; }
  catch (e) { $("#who").textContent = e.message; }
}

$("#save").onclick = async () => {
  const server = $("#server").value.trim(), key = $("#key").value.trim();
  if (!/^https?:\/\//.test(server) || !/^hh_/.test(key)) { $("#who").textContent = "Paste the app address (starting with https://) and a key starting with hh_."; return; }
  cfg = { server, key };
  try { await call("/api/ping"); await store.set(cfg); showMain(); }
  catch (e) { $("#who").textContent = e.message; }
};
$("#change").onclick = showSetup;

$("#send").onclick = async () => {
  const btn = $("#send"); btn.disabled = true; say("Reading the page…");
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !/^https?:/.test(tab.url || "")) throw new Error("Open a normal web page first.");
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => ({ url: location.href, title: document.title, text: (document.body ? document.body.innerText : "").slice(0, 110000) }),
    });
    const page = results[0].result;
    if (!page.text || page.text.trim().length < 20) throw new Error("This page looks empty. Wait for it to load, then try again.");
    say("Finding assignments…");
    const r = await call("/api/ingest/page", { method: "POST", body: JSON.stringify(page) });
    if (!r.found) { say("No assignments found on this page. Try the page that lists your tasks and due dates.", "err"); return; }
    const out = $("#out"); out.className = "msg ok";
    out.textContent = r.added ? `Added ${r.added} new${r.found > r.added ? `, ${r.found - r.added} already in your list` : ""}.` : `All ${r.found} were already in your list.`;
    const ul = document.createElement("ul");
    for (const x of r.results.slice(0, 6)) { const li = document.createElement("li"); li.textContent = `${x.title}${x.action === "added" ? "" : " (already there)"}`; ul.appendChild(li); }
    out.appendChild(ul);
  } catch (e) { say(e.message, "err"); }
  finally { btn.disabled = false; }
};

store.get(["server", "key"]).then(v => { cfg = v || {}; if (cfg.server && cfg.key) showMain(); else showSetup(); });
