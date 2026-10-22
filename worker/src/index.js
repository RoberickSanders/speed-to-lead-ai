// Speed-to-lead demo for "Example Med Spa" (fictional). No SMS or email is ever sent.
// Flow: web form -> one classification call (lead score + fields) -> LLM drafts a text reply -> guardrail post-check -> D1.
const TEXT_MODEL = "@cf/meta/llama-3.2-3b-instruct";
const CONF_THRESHOLD = 0.7; // fields below this confidence are routed to a human
const BOOKING = "[booking link]";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });

async function sha(s) {
  const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("stl-demo:" + s));
  return [...new Uint8Array(b)].slice(0, 12).map((x) => x.toString(16).padStart(2, "0")).join("");
}

function field(a) {
  if (!a) return { value: null, confidence: 0, status: "human" };
  const v = a.value ?? null;
  const conf = v === null ? (a.p_null ?? 0) : (a.confidence ?? 0);
  const status = conf < CONF_THRESHOLD ? "human" : v === null ? "missing" : "ok";
  return { value: v, confidence: Math.round(conf * 1000) / 1000, status };
}

// ---- Classifier: one call does lead scoring (ICP fit + buy intent) AND the lead fields (service, timeframe, budget, urgency). ----
// Works with any structured-classification API that accepts {model, state, questions} and returns per-question
// answers with confidences. URL/model come from Worker vars; the key is a Worker secret (never logged).
const BAND_HOT = 0.7, BAND_WARM = 0.4; // band on avg(icp_fit, buy_intent): >=0.7 hot, >=0.4 warm, else cold
const ICP = "a person who wants a med spa treatment (Botox, fillers, laser, facials, microneedling, body contouring) at Example Med Spa. Spam, vendors, job seekers and people outside the service area are not ICP.";
const QUESTIONS = {
  icp_fit: { type: "yes_no", instructions: `The sender is inside Example Med Spa's ideal customer profile: ${ICP}` },
  buy_intent: { type: "yes_no", instructions: "The sender is likely to book a paid treatment soon (names a service and near-term timing, or asks to book). Just browsing or price shopping with no timeline is weak evidence." },
  service: { type: "choice", instructions: "Which med spa service does the sender mainly want?", criteria: {
    botox: "Botox, Dysport or other neurotoxin", filler: "lip, cheek or other dermal filler", laser_hair_removal: "laser hair removal",
    facial: "facial, peel or HydraFacial", microneedling: "microneedling or skin resurfacing", body: "body contouring, CoolSculpting or weight loss",
    other: "some other treatment", unknown: "no service is named" } },
  timeframe: { type: "choice", instructions: "When does the sender want the appointment or results?", criteria: {
    asap: "as soon as possible, today or tomorrow", this_week: "this week or this weekend, or before an event in the next 7 days",
    this_month: "within the next few weeks", later: "a month or more away, or a far-off season", unknown: "no timing given" } },
  budget: { type: "choice", instructions: "What budget in US dollars does the sender state?", criteria: {
    none: "no budget mentioned", under_200: "under $200", "200_500": "$200 to $500", "500_1000": "$500 to $1,000", over_1000: "over $1,000" } },
  urgency: { type: "score", instructions: "How urgently should the spa respond?",
    criteria: ["Low: no time pressure", "Medium: routine request with some timing", "High: wants something within days, a deadline or event, or is upset"] },
};
const LABEL = { botox: "Botox", filler: "Filler", laser_hair_removal: "Laser hair removal", facial: "Facial", microneedling: "Microneedling", body: "Body contouring", other: "Other treatment",
  asap: "ASAP", this_week: "This week", this_month: "This month", later: "Later", under_200: "<200", "200_500": "200-500", "500_1000": "500-1000", over_1000: "1000+" };
const r3 = (x) => Math.round((x ?? 0) * 1000) / 1000;
function pickChoice(a, empty) {
  if (!a || !a.choice) return { value: null, confidence: 0, status: "human" };
  const conf = r3(a.confidence);
  if (conf < CONF_THRESHOLD) return { value: LABEL[a.choice] ?? null, confidence: conf, status: "human" };
  return a.choice === empty ? { value: null, confidence: conf, status: "missing" } : { value: LABEL[a.choice] ?? a.choice, confidence: conf, status: "ok" };
}
const EMPTY_FIELDS = () => ({ service: field(null), timeframe: field(null), budget: field(null), urgency: field(null) });
const FALLBACK_SCORE = { label: "warm", model_label: null, confidence: 0, status: "human" };
async function classifyLead(env, day, name, message) {
  if (!env.CLASSIFIER_API_KEY) throw new Error("CLASSIFIER_API_KEY not set");
  const res = await fetch(env.CLASSIFIER_API_URL, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${env.CLASSIFIER_API_KEY}` },
    body: JSON.stringify({ model: env.CLASSIFIER_MODEL, state: { today: day, channel: "web_form", name, message }, questions: QUESTIONS }), signal: AbortSignal.timeout(8000) });
  if (!res.ok) { throw new Error(`classifier http ${res.status}`); }
  const a = (await res.json())?.answers || {};
  if (typeof a.icp_fit?.p_yes !== "number" || typeof a.buy_intent?.p_yes !== "number") throw new Error("no score");
  const icp = r3(a.icp_fit.p_yes), intent = r3(a.buy_intent.p_yes), avg = (icp + intent) / 2;
  const label = avg >= BAND_HOT ? "hot" : avg >= BAND_WARM ? "warm" : "cold";
  const u = a.urgency || {}; const lvl = ["low", "medium", "high"][Math.max(0, Math.min(2, Math.round(Number(u.score ?? 0))))] ;
  const uConf = r3(u.confidence ?? 0);
  const fields = { service: pickChoice(a.service, "unknown"), timeframe: pickChoice(a.timeframe, "unknown"), budget: pickChoice(a.budget, "none"),
    urgency: { value: lvl, confidence: uConf, status: uConf && uConf < CONF_THRESHOLD ? "human" : "ok", signal: null } };
  return { fields, score: { label, model_label: label, confidence: r3(Math.min(1, 0.5 + 2 * Math.min(Math.abs(avg - BAND_HOT), Math.abs(avg - BAND_WARM)))), icp_fit: icp, buy_intent: intent, status: "ok" } };
}

// Post-check: the reply must never offer specific days, dates or times. Drop any sentence that does.
const SLOT_RE = /\b(mon|tues?|wed(nes)?|thu(rs?)?|fri|sat(ur)?|sun)(day)?s?\b|\b(we have|we've got|there is|there's|we can (usually )?(fit|accommodate|squeeze))\b|\b(availability|openings?|same-day)\b|\b(today|tonight|tomorrow|weekend)\b|\b\d{1,2}(:\d{2})?\s*(am|pm|a\.m\.|p\.m\.)|\b\d{1,2}:\d{2}\b|\b\d{1,2}(st|nd|rd|th)\b|\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+\d{1,2}\b|\b\d{1,2}\/\d{1,2}\b|\b(morning|afternoon|evening|noon)\b/i;
// Post-check: the reply must never contain links, emails or phone numbers (only the BOOKING placeholder). Drop any sentence that does.
const CONTACT_RE = /(https?:\/\/|www\.|\b[a-z0-9-]+\.(com|net|org|io|co|ly|me|app|link)\b|[\w.+-]+@[\w-]+\.[\w.]+|\+?\d[\d\s().-]{6,}\d)/i;
function cleanReply(text, name, f) {
  const parts = String(text || "").split(/(?<=[.!?])\s+/).filter(Boolean);
  let kept = parts.filter((x) => !SLOT_RE.test(x) && !CONTACT_RE.test(x));
  if (kept.length !== parts.length) kept = kept.filter((x) => !/\b(which|either|those|these|that time|works for you)\b.*\?$/i.test(x));
  let out = kept.join(" ").trim();
  const changed = kept.length !== parts.length;
  if (!out || out.length < 25) return { text: fallbackReply(name, f), rewritten: true };
  if (/what day works best/i.test(out)) { if (changed && !out.includes(BOOKING)) out += ` You can also grab a time here: ${BOOKING}`; }
  else if (changed || !/\?\s*$/.test(out)) out = out.replace(/\s*$/, "") + ` What day works best for you? You can also grab a time here: ${BOOKING}`;
  return { text: out.slice(0, 400), rewritten: changed };
}

function fallbackReply(name, f) {
  const first = (name || "there").split(" ")[0];
  const svc = f.service.status === "ok" ? f.service.value : "your visit";
  return `Hi ${first}! Thanks for reaching out to Example Med Spa about ${svc}. What day works best for you? You can also pick a time here: ${BOOKING}. Reply STOP to opt out.`;
}

async function handleLead(req, env) {
  const t0 = Date.now();
  const receivedAt = new Date(t0).toISOString();
  let body;
  try { body = await req.json(); } catch { return json({ error: "Bad request" }, 400); }
  const name = String(body.name || "").trim().slice(0, 80);
  const contact = String(body.contact || "").trim().slice(0, 120);
  const message = String(body.message || "").trim().slice(0, 600);
  if (!name || !contact || message.length < 5) return json({ error: "Please fill in your name, contact and what you're looking for." }, 400);

  // Rate limiting (per IP per hour + global per day), stored in D1
  const ip = req.headers.get("cf-connecting-ip") || "unknown";
  const ipHash = await sha(ip);
  const hourAgo = t0 - 3600_000;
  const day = receivedAt.slice(0, 10);
  const [ipCount, dayRow] = await Promise.all([
    env.DB.prepare("SELECT COUNT(*) AS n FROM hits WHERE ip_hash=? AND ts>?").bind(ipHash, hourAgo).first(),
    env.DB.prepare("SELECT n FROM usage WHERE day=?").bind(day).first(),
  ]);
  if ((ipCount?.n || 0) >= Number(env.RATE_PER_HOUR || 8)) return json({ error: "Demo rate limit reached for your network. Try again in an hour." }, 429);
  if ((dayRow?.n || 0) >= Number(env.GLOBAL_PER_DAY || 300)) return json({ error: "The demo has hit its daily cap. Try again tomorrow." }, 429);
  await env.DB.batch([
    env.DB.prepare("INSERT INTO hits (ip_hash, ts) VALUES (?, ?)").bind(ipHash, t0),
    env.DB.prepare("DELETE FROM hits WHERE ts < ?").bind(hourAgo),
    env.DB.prepare("INSERT INTO usage (day, n) VALUES (?, 1) ON CONFLICT(day) DO UPDATE SET n = n + 1").bind(day),
  ]);

  const aiOn = String(env.AI_ENABLED || "true").toLowerCase() === "true";
  let f, reply, extractMs = 0, replyMs = 0, scoreMs = 0, note = null, sc, rewritten = false;
  if (aiOn) {
    // One call does both the read (fields) and the score.
    const ta = Date.now();
    try { const j = await classifyLead(env, day, name, message); f = j.fields; sc = j.score; }
    catch (e) { console.error("classifyLead failed:", String(e?.message || e).slice(0, 400)); note = "Read/score step failed; routed to a human."; f = EMPTY_FIELDS(); sc = { ...FALLBACK_SCORE }; }
    extractMs = Date.now() - ta; scoreMs = extractMs;
    const tb = Date.now();
    try {
      const known = Object.entries(f).filter(([, v]) => v.status === "ok").map(([k, v]) => `${k}: ${v.value}`).join("; ") || "none";
      const r = await env.AI.run(TEXT_MODEL, {
        max_tokens: 120,
        temperature: 0.4,
        messages: [
          { role: "system", content: "You write the first text message a med spa sends to a new lead, within seconds of their web form. Business: Example Med Spa. Rules: under 320 characters, warm and human, use their first name, reference what they asked for and their timing if known, NEVER propose or invent specific days, dates or times (no 'Thursday', 'the 12th', '4pm', 'tomorrow'); the spa's calendar is unknown, so also never claim availability or openings. Instead end by inviting them to pick a time, e.g. 'What day works best for you?' or 'Book here: [booking link]'. Never mention money, prices or their budget, no medical claims, no emojis overload (max 1). Output only the message text." },
          { role: "user", content: `Lead name: ${name}\nTheir message: ${message}\nExtracted: ${known}` },
        ],
      });
      reply = String(r?.response || "").trim().replace(/^"|"$/g, "");
    } catch { /* fall back below */ }
    if (!reply) reply = fallbackReply(name, f);
    ({ text: reply, rewritten } = cleanReply(reply, name, f));
    replyMs = Date.now() - tb;
  } else {
    note = "AI is switched off (kill switch). Template reply used; every field goes to a human.";
    f = { service: field(null), timeframe: field(null), budget: field(null), urgency: field(null) };
    reply = fallbackReply(name, f);
    sc = { label: "warm", model_label: null, confidence: 0, status: "human" };
  }
  const s = sc.label;
  const responseMs = Date.now() - t0;

  await env.DB.batch([
    env.DB.prepare(`INSERT INTO leads (created_at,name,contact,message,service,service_conf,timeframe,timeframe_conf,budget,budget_conf,urgency,urgency_conf,score,reply,response_ms,ip_hash)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(receivedAt, name, contact, message,
      f.service.value, f.service.confidence, f.timeframe.value, f.timeframe.confidence,
      f.budget.value === null ? null : Number(f.budget.value) || null, f.budget.confidence,
      f.urgency.value, f.urgency.confidence, s, reply, responseMs, ipHash),
    env.DB.prepare("DELETE FROM leads WHERE id NOT IN (SELECT id FROM leads ORDER BY id DESC LIMIT ?)").bind(Number(env.MAX_ROWS || 200)),
  ]);

  return json({ received_at: receivedAt, response_ms: responseMs, extract_ms: extractMs, score_ms: scoreMs, reply_ms: replyMs, fields: f, score: s, score_detail: sc, reply_rewritten: rewritten, reply, ai_enabled: aiOn, note });
}

const CSS = `*{box-sizing:border-box}body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:#f6f3f0;color:#1f1d1b}
.wrap{max-width:720px;margin:0 auto;padding:20px}.demo{background:#1f1d1b;color:#fff;font-size:12px;letter-spacing:.08em;text-align:center;padding:6px}
h1{font-size:26px;margin:18px 0 4px}.sub{color:#6b625b;margin:0 0 18px}.card{background:#fff;border-radius:14px;padding:18px;box-shadow:0 1px 3px rgba(0,0,0,.08);margin-bottom:16px}
label{display:block;font-weight:600;font-size:14px;margin:12px 0 6px}input,textarea{width:100%;padding:12px;border:1px solid #d8d1ca;border-radius:10px;font:inherit}
textarea{min-height:96px}button{margin-top:16px;width:100%;padding:14px;border:0;border-radius:10px;background:#b5835a;color:#fff;font-size:16px;font-weight:600;cursor:pointer}
button:disabled{opacity:.6}.big{font-size:40px;font-weight:800;color:#2f7d4f}.muted{color:#6b625b;font-size:13px}table{width:100%;border-collapse:collapse;font-size:14px}
td,th{padding:8px 6px;border-bottom:1px solid #eee;text-align:left;vertical-align:top}.pill{display:inline-block;padding:2px 10px;border-radius:99px;font-size:12px;font-weight:700;text-transform:uppercase}
.hot{background:#fde2e1;color:#b42318}.warm{background:#fef0c7;color:#93370d}.cold{background:#e0eaff;color:#1d4ed8}.human{color:#b42318;font-weight:600}
.sms{background:#e9e9eb;border-radius:18px 18px 18px 4px;padding:12px 14px;max-width:90%;white-space:pre-wrap}.stats{display:flex;gap:12px;flex-wrap:wrap}.stats .card{flex:1;min-width:140px;text-align:center}
a{color:#8a5a33}.foot{text-align:center;color:#8f867e;font-size:12px;margin:24px 0}.err{color:#b42318}`;

const page = (title, inner) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>${CSS}</style></head>
<body><div class="demo">DEMO · FICTIONAL BUSINESS · NO MESSAGES ARE ACTUALLY SENT</div><div class="wrap">${inner}
<div class="foot">Speed-to-lead demo on Cloudflare Workers + Workers AI + D1 · <a href="/">Form</a> · <a href="/dashboard">Dashboard</a></div></div></body></html>`;

const HOME = page("Example Med Spa · Speed-to-lead demo", `
<h1>Example Med Spa</h1><p class="sub">Tell us what you're looking for. You'll see the reply our system would text you, and how fast it was ready.</p>
<form id="f" class="card">
<label for="name">Name</label><input id="name" name="name" required maxlength="80" placeholder="Jamie Rivera">
<label for="contact">Phone or email</label><input id="contact" name="contact" required maxlength="120" placeholder="(555) 010-2030">
<label for="message">What are you looking for?</label><textarea id="message" name="message" required maxlength="600" placeholder="Want botox before my wedding on the 14th, budget around 500"></textarea>
<button id="b" type="submit">Send</button><p class="muted">Demo only: nothing is texted or emailed. Please don't enter real contact details.</p>
</form><div id="out"></div>
<script>
const f=document.getElementById('f'),out=document.getElementById('out'),b=document.getElementById('b');
const e=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
f.onsubmit=async ev=>{ev.preventDefault();b.disabled=true;b.textContent='Working…';out.innerHTML='';const t=performance.now();
try{const r=await fetch('/api/lead',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(Object.fromEntries(new FormData(f)))});
const d=await r.json();const rt=Math.round(performance.now()-t);if(!r.ok){out.innerHTML='<div class="card err">'+e(d.error)+'</div>';return;}
const rows=Object.entries(d.fields).map(([k,v])=>'<tr><td>'+k+'</td><td>'+(v.value===null?'<span class="muted">not mentioned</span>':e(k==='budget'?'$'+v.value:v.value))+(v.signal?'<div class="muted">“'+e(v.signal)+'”</div>':'')+'</td><td>'+Math.round(v.confidence*100)+'%</td><td>'+(v.status==='human'?'<span class="human">would go to a human</span>':v.status==='ok'?'auto':'—')+'</td></tr>').join('');
out.innerHTML='<div class="card"><div class="muted">Reply ready in</div><div class="big">'+(d.response_ms/1000).toFixed(2)+'s</div><div class="muted">'+d.response_ms+' ms server-side (read and score in one step) · '+rt+' ms round trip in your browser · received '+e(new Date(d.received_at).toLocaleTimeString())+'</div></div>'
+'<div class="card"><b>Lead score:</b> <span class="pill '+d.score+'">'+d.score+'</span> <span class="muted">'+Math.round(d.score_detail.confidence*100)+'% confidence</span>'+(d.score_detail.status==='human'?' · <span class="human">would go to a human</span>'+(d.score_detail.model_label&&d.score_detail.model_label!==d.score?' <span class="muted">(model leaned '+e(d.score_detail.model_label)+')</span>':''):'')+(d.note?'<p class="muted">'+e(d.note)+'</p>':'')+'<table><tr><th>Field</th><th>Value</th><th>Confidence</th><th>Routing</th></tr>'+rows+'</table></div>'
+'<div class="card"><div class="muted" style="margin-bottom:8px">Text that would be sent to '+e(f.contact.value)+':</div><div class="sms">'+e(d.reply)+'</div></div>'
+'<div class="card muted"><b>How this works:</b> Read + Score (fields and hot/warm/cold from fit and buying intent, '+d.extract_ms+' ms) → Reply (drafts text, '+d.reply_ms+' ms). A classification model reads and scores the lead in one step; a Cloudflare Workers AI text model drafts the reply.</div>'
+'<p style="text-align:center"><a href="/dashboard">See all demo leads →</a></p>';out.scrollIntoView({behavior:'smooth'});}
catch(x){out.innerHTML='<div class="card err">Something went wrong. Try again.</div>'}finally{b.disabled=false;b.textContent='Send'}};
</script>`);

async function dashboard(env) {
  const [{ results }, agg] = await Promise.all([
    env.DB.prepare("SELECT created_at,name,message,service,service_conf,timeframe,timeframe_conf,budget,budget_conf,urgency,urgency_conf,score,reply,response_ms FROM leads ORDER BY id DESC LIMIT 50").all(),
    env.DB.prepare("SELECT COUNT(*) n, AVG(response_ms) avg_ms, SUM(score='hot') hot, SUM(score='warm') warm, SUM(score='cold') cold FROM leads").first(),
  ]);
  const cell = (v, c) => (v === null || v === undefined ? '<span class="muted">—</span>' : esc(v)) + `<div class="muted">${Math.round((c || 0) * 100)}%${(c || 0) < CONF_THRESHOLD ? ' · <span class="human">human</span>' : ""}</div>`;
  const rows = results.map((r) => `<tr><td>${esc(new Date(r.created_at).toISOString().replace("T", " ").slice(5, 16))} UTC<div class="muted">${(r.response_ms / 1000).toFixed(2)}s</div></td>
<td><b>${esc(r.name)}</b><div class="muted">${esc(r.message)}</div></td><td>${cell(r.service, r.service_conf)}</td><td>${cell(r.timeframe, r.timeframe_conf)}</td>
<td>${cell(r.budget === null ? null : "$" + r.budget, r.budget_conf)}</td><td>${cell(r.urgency, r.urgency_conf)}</td><td><span class="pill ${esc(r.score)}">${esc(r.score)}</span></td></tr>`).join("");
  return page("Dashboard · Speed-to-lead demo", `<h1>Demo lead dashboard</h1><p class="sub">Most recent ${results.length} leads (stored rows capped at ${esc(env.MAX_ROWS || 200)}).</p>
<div class="stats"><div class="card"><div class="muted">Leads</div><div class="big" style="color:#1f1d1b">${agg?.n || 0}</div></div>
<div class="card"><div class="muted">Avg response</div><div class="big">${agg?.avg_ms ? (agg.avg_ms / 1000).toFixed(2) + "s" : "—"}</div></div>
<div class="card"><div class="muted">Hot / Warm / Cold</div><div class="big" style="font-size:30px"><span style="color:#b42318">${agg?.hot || 0}</span> / <span style="color:#93370d">${agg?.warm || 0}</span> / <span style="color:#1d4ed8">${agg?.cold || 0}</span></div></div></div>
<div class="card" style="overflow-x:auto"><table><tr><th>Time</th><th>Lead</th><th>Service</th><th>Timeframe</th><th>Budget</th><th>Urgency</th><th>Score</th></tr>${rows || '<tr><td colspan="7" class="muted">No leads yet.</td></tr>'}</table></div>`);
}


// Dashboard shows every stored submission, so it needs the DASHBOARD_TOKEN secret, sent as
// the x-dashboard-token header or ?token= query. Unset token = dashboard disabled. Cloudflare Access is a stronger option.
async function dashboardAllowed(req, url, env) {
  const want = env.DASHBOARD_TOKEN;
  if (!want) return false;
  const got = req.headers.get("x-dashboard-token") || url.searchParams.get("token") || "";
  const [a, b] = await Promise.all([sha(got), sha(want)]);
  return a === b; // compare fixed-length hashes, not raw strings
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const html = (h) => new Response(h, { headers: { "content-type": "text/html;charset=utf-8", "x-robots-tag": "noindex" } });
    if (url.pathname === "/api/lead" && req.method === "POST") return handleLead(req, env);
    if (url.pathname === "/dashboard") {
      if (!(await dashboardAllowed(req, url, env))) return new Response("Unauthorized", { status: 401, headers: { "x-robots-tag": "noindex" } });
      return html(await dashboard(env));
    }
    if (url.pathname === "/" || url.pathname === "/index.html") return html(HOME);
    return new Response("Not found", { status: 404 });
  },
};
