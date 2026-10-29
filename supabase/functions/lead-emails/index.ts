import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { SITE, esc, money, phoneFmt, tel, row, button, agentStrip, homeCard, h1, lead, callout, shell, C } from "./jag-email.ts";
import { buildQueries } from "./matrix-query.ts";

// JAG home emails for screened leads (table jag_lead_drips). Runs hourly (pg_cron → this function with the vault token).
// Pace (standard): a welcome right away, then up to 2 a week for the first 30 days, then weekly through day 90.
// Sends only 8 AM–8 PM Houston time. Each email shows matching HAR homes the lead hasn't been sent yet; when nothing
// new matches, that email is skipped and the next date moves forward (never an empty email).
// Stops: unsubscribe (POST ?d=<id>&s=<sig>, from /unsubscribe or a mail app's one-click), the agent (jag_drip_stop),
// day 90, or the lead creating a website account — then status 'account', their account gets a saved search with the
// same criteria, their agent is set, and the regular listing alerts take over.
// POST {"preview":"<drip id>"} with the token returns the next email's HTML without sending or changing anything.
//
// Matrix campaigns (rows with params, started from the team's /matrix page): the agent's full HAR criteria,
// pace asap (every ~3 h when something new matches) / daily (10 AM) / weekly (10 AM), until stopped, unsubscribed or ends_at
// (180 days). After the welcome email only listings that are new since the last email are sent. They keep running when
// the client has a website account (the agent chose this search on purpose).

const SB = Deno.env.get("SUPABASE_URL")!;
const SR = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const RK = Deno.env.get("REPLIERS_API_KEY") || "";
const RESEND = Deno.env.get("RESEND_API_KEY") || "";
const FROM = Deno.env.get("ALERTS_FROM") || "Jason Aguirre Group <alerts@updates.jasonhoustonrealty.com>";
const DEF_REPLY = Deno.env.get("ALERTS_REPLY_TO") || "jason.aguirre@jasonhoustonrealty.com";
const TEAM_PHONE = "(832) 702-3574";
const BOARD = "147";
const FIELDS = "mlsNumber,listPrice,type,address,images,details.numBedrooms,details.numBathrooms,details.sqft,details.propertyType,permissions,standardStatus,listDate";
const DAY = 864e5;

type Row = Record<string, any>;

async function db(path: string, init: RequestInit = {}): Promise<any> {
  const r = await fetch(`${SB}/rest/v1/${path}`, {
    ...init,
    headers: { apikey: SR, Authorization: `Bearer ${SR}`, "Content-Type": "application/json", ...(init.headers || {}) },
  });
  if (!r.ok) throw new Error(`db ${path.split("?")[0]} ${r.status} ${(await r.text()).slice(0, 200)}`);
  return r.status === 204 ? null : r.json().catch(() => null);
}
const patch = (id: string, body: Row) =>
  db(`jag_lead_drips?id=eq.${id}`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify(body) });

async function repliers(q: URLSearchParams): Promise<Row[]> {
  q.set("boardId", BOARD);
  const r = await fetch("https://api.repliers.io/listings?" + q.toString(), { headers: { "REPLIERS-API-KEY": RK, Accept: "application/json" } });
  if (!r.ok) { console.error("repliers", r.status, (await r.text()).slice(0, 200)); return []; }
  const d = await r.json();
  return (d.listings || []).filter((l: Row) => {
    const p = l.permissions || {};
    return p.displayPublic !== "N" && p.displayInternetEntireListing !== "N";
  });
}

// Same search the homes page runs for a typed area: Texas + ZIP, or Texas + free text.
function homesQuery(d: Row) {
  if (d.params && typeof d.params === "object") {
    // Matrix campaign: the agent's own criteria, on-market only (never sold/expired in a client email)
    const st = (Array.isArray(d.params.st) ? d.params.st : ["active"]).filter((x: string) => x === "active" || x === "coming");
    const q = buildQueries({ ...d.params, st: st.length ? st : ["active"], off: [] })[0].q;
    if (d.sent_count && d.last_sent_at) q.set("minListDate", new Date(new Date(d.last_sent_at).getTime() - DAY).toISOString().slice(0, 10));
    q.set("hasImages", "true"); q.set("sortBy", "createdOnDesc"); q.set("resultsPerPage", "24"); q.set("fields", FIELDS);
    q.delete("boardId");
    return q;
  }
  const q = new URLSearchParams({ type: "sale", state: "TX", status: "A", hasImages: "true", sortBy: "createdOnDesc", resultsPerPage: "24", fields: FIELDS });
  q.append("class", "residential"); q.append("class", "condo"); q.append("propertyType", "Residential");
  const area = String(d.area || "").trim();
  if (/^\d{5}$/.test(area)) q.set("zip", area); else if (area) q.set("search", area);
  if (d.maxp) q.set("maxPrice", String(d.maxp));
  if (d.beds) q.set("minBedrooms", String(d.beds));
  return q;
}

function snap(l: Row) {
  const a = l.address || {}, d = l.details || {};
  const hideAddr = (l.permissions || {}).displayAddressOnInternet === "N";
  return {
    mls: String(l.mlsNumber), price: l.listPrice ?? null, beds: d.numBedrooms ?? null, baths: d.numBathrooms ?? null, sqft: d.sqft ?? null,
    photo: (l.images || [])[0] || null, zip: a.zip || null, city: a.city || null,
    addr: hideAddr ? "" : [a.streetNumber, a.streetDirectionPrefix, a.streetName, a.streetSuffix, a.streetDirection].filter(Boolean).join(" ") + (a.unitNumber ? " #" + a.unitNumber : ""),
  };
}

async function sig(id: string) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(SR), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const s = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode("drip:" + id));
  return Array.from(new Uint8Array(s)).slice(0, 16).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function houstonHour(d = new Date()) {
  return Number(new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", hour: "numeric", hour12: false }).format(d)) % 24;
}
// The same calendar day as d, at `hour` o'clock Houston time.
function atHoustonHour(d: Date, hour: number): Date {
  const f = new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", year: "numeric", month: "2-digit", day: "2-digit", timeZoneName: "shortOffset" });
  const p: Record<string, string> = Object.fromEntries(f.formatToParts(d).map((x) => [x.type, x.value]));
  const off = Number((p.timeZoneName.match(/GMT([+-]\d+)/) || [, "-6"])[1]);
  return new Date(`${p.year}-${p.month}-${p.day}T${String(hour - off).padStart(2, "0")}:00:00Z`);
}
// Standard pace: every 3 or 4 days (≈2 a week) for the first 30 days, then weekly; null after day 90.
function nextAt(created: Date, sentCount: number, mx?: Row): Date | null {
  if (mx && mx.params) {
    const n = mx.pace === "asap" ? new Date(Date.now() + 3 * 3600e3)
      : atHoustonHour(new Date(Date.now() + (mx.pace === "weekly" ? 7 : 1) * DAY), 10);
    return mx.ends_at && n.getTime() > new Date(mx.ends_at).getTime() ? null : n;
  }
  const age = (Date.now() - created.getTime()) / DAY;
  const step = age < 30 ? (sentCount % 2 ? 3 : 4) : 7;
  const d = atHoustonHour(new Date(Date.now() + step * DAY), 10);
  return (d.getTime() - created.getTime()) / DAY > 90 ? null : d;
}

/* ---------------- email ---------------- */
const fmtPhone = phoneFmt;

const TXT: Record<string, any> = {
  es: {
    hi: "Hola", bd: "rec", ba: "baños", view: "Ver la casa", all: "Ver todas las casas",
    crit: (d: Row) => [d.area ? `en ${d.area}` : "", d.beds ? `de ${d.beds}+ recámaras` : "", d.maxp ? `hasta ${money(d.maxp)}` : ""].filter(Boolean).join(" "),
    welcome: (agent: string, c: string) => `Soy ${agent} del Jason Aguirre Group. Como platicamos, le comparto casas${c ? " " + c : ""} que le pueden gustar:`,
    more: (c: string) => `Salieron casas nuevas${c ? " " + c : ""}. Estas son las más recientes:`,
    s_welcome: (d: Row) => `Casas${d.area ? " en " + d.area : ""} para usted`,
    s_more: (n: number, d: Row) => (n === 1 ? "1 casa nueva" : `${n} casas nuevas`) + (d.area ? " en " + d.area : " para usted"),
    acct_h: "Guarde sus favoritas", acct_p: "Cree su cuenta gratis para guardar casas, ver cuando bajan de precio y recibir avisos en cuanto salgan.",
    acct_btn: "Crear mi cuenta gratis",
    help: (first: string) => `¿Quiere ver alguna? Responda a este correo o llame a ${first} al `,
    why: (dt: string) => `Recibe este correo porque habló con nuestro equipo el ${dt} y aceptó recibir casas por correo.`,
    unsub: "Dejar de recibir estos correos",
    disc: "Información de listados de HAR a través de Repliers; se considera confiable pero no garantizada.",
  },
  en: {
    hi: "Hi", bd: "bd", ba: "ba", view: "View home", all: "See all homes",
    crit: (d: Row) => [d.area ? `in ${d.area}` : "", d.beds ? `with ${d.beds}+ bedrooms` : "", d.maxp ? `up to ${money(d.maxp)}` : ""].filter(Boolean).join(" "),
    welcome: (agent: string, c: string) => `This is ${agent} with the Jason Aguirre Group. As we talked about, here are homes${c ? " " + c : ""} you might like:`,
    more: (c: string) => `New homes just came on the market${c ? " " + c : ""}. Here are the latest:`,
    s_welcome: (d: Row) => `Homes${d.area ? " in " + d.area : ""} for you`,
    s_more: (n: number, d: Row) => (n === 1 ? "1 new home" : `${n} new homes`) + (d.area ? " in " + d.area : " for you"),
    acct_h: "Save your favorites", acct_p: "Create your free account to save homes, see price drops, and get alerts the moment new homes hit the market.",
    acct_btn: "Create my free account",
    help: (first: string) => `Want to see one? Reply to this email or call ${first} at `,
    why: (dt: string) => `You're getting this email because you spoke with our team on ${dt} and agreed to receive homes by email.`,
    unsub: "Unsubscribe from these emails",
    disc: "Listing information from HAR through Repliers; deemed reliable but not guaranteed.",
  },
};

function links(d: Row) {
  const a = d.agent_code ? `a=${encodeURIComponent(d.agent_code)}&` : "";
  const q = new URLSearchParams();
  if (d.area) q.set("q", d.area); if (d.maxp) q.set("maxp", String(d.maxp)); if (d.beds) q.set("beds", String(d.beds));
  return {
    home: (mls: string) => `${SITE}/homes?${a}src=drip#${encodeURIComponent(mls)}`,
    all: `${SITE}/homes?${a}src=drip${q.toString() ? "&" + q.toString() : ""}`,
    account: `${SITE}/account?${a}src=drip`,
  };
}

// Matrix campaigns: show the area / beds / budget from the criteria in the client's email
function title(s: string) { return s.replace(/\b([a-zà-ÿ])([a-zà-ÿ']*)/gi, (_m, a, b) => a.toUpperCase() + b.toLowerCase()); }
function view(d: Row): Row {
  const p = d.params;
  if (!p || typeof p !== "object") return d;
  const first = (v: unknown) => (Array.isArray(v) ? v : []).map(String).filter(Boolean)[0] || "";
  const area = first(p.sub) || first(p.city) || first(p.zip) || first(p.high) || first(p.county) || "";
  return { ...d, area: area ? title(area) : null, beds: Number(p.beds) || null, maxp: Number(p.maxP) || null };
}
function buildEmail(d0: Row, agent: Row | null, homes: Row[], unsubUrl: string) {
  const d = view(d0);
  const L = TXT[d.lang === "en" ? "en" : "es"], first = String(d.name || "").trim().split(/\s+/)[0];
  const aName = agent?.name || "Jason Aguirre", aFirst = agent?.first_name || aName.split(" ")[0], aPhone = agent?.phone ? fmtPhone(agent.phone) : TEAM_PHONE;
  const crit = L.crit(d), lk = links(d), welcome = !d.sent_count;
  const subject = welcome ? L.s_welcome(d) : L.s_more(homes.length, d);
  const dt = new Date(d.created_at).toLocaleDateString(d.lang === "en" ? "en-US" : "es-MX", { timeZone: "America/Chicago", month: "long", day: "numeric", year: "numeric" });
  const cards = homes.map((s) => {
    const specs = [s.beds != null ? `${s.beds} ${L.bd}` : "", s.baths != null ? `${s.baths} ${L.ba}` : "", s.sqft ? `${Number(s.sqft).toLocaleString("en-US")} ${d.lang === "en" ? "sqft" : "pies²"}` : ""].filter(Boolean).join("  ·  ");
    return homeCard({ url: lk.home(s.mls), photo: s.photo, price: s.price, specs, addr: [[s.addr, s.city].filter(Boolean).join(", "), s.zip].filter(Boolean).join(" "), btn: L.view });
  }).join("");
  const es = d.lang !== "en";
  const html = shell({ es, title: subject, preheader: welcome ? L.welcome(aName, crit) : L.more(crit),
    body: row(agentStrip(aName, (es ? "Su agente" : "Your agent") + " · JAG Real Estate", agent?.photo_url)
        + h1(`${L.hi}${first ? " " + first : ""},`) + lead(welcome ? L.welcome(aName, crit) : L.more(crit)) + cards
        + `<div style="text-align:center;margin:4px 0 22px">${button(lk.all, L.all, { kind: "outline" })}</div>`
        + callout(`<div style="font-size:17px;font-weight:800">${esc(L.acct_h)}</div><div style="font-size:14px;color:${C.muted};margin:4px 0 14px">${esc(L.acct_p)}</div>${button(lk.account, L.acct_btn, { kind: "dark" })}`)
        + `<div style="border-top:1px solid ${C.line};padding-top:16px;text-align:center;font-size:14px;color:${C.muted}">${esc(L.help(aFirst))}<a href="tel:${tel(aPhone)}" style="color:${C.ink};font-weight:700;text-decoration:none">${esc(aPhone)}</a>.</div>`, "0 32px"),
    links: [[L.unsub, unsubUrl]],
    footerNote: L.why(dt) + " " + L.disc });
  return { subject, html, replyTo: agent?.email || DEF_REPLY };
}

/* ---------------- account handover ---------------- */
// The lead made a website account: give it a saved search with the same criteria (alerts on), set their agent,
// and stop these emails so the account's listing alerts take over.
async function handover(d: Row, c: Row) {
  const has: Row[] = await db(`jag_client_searches?select=id&user_id=eq.${c.user_id}&limit=1`);
  if (!has || !has.length) {
    const area = String(d.area || "").trim(), api: Row = { type: "sale", state: "TX", propertyType: "Residential" };
    if (/^\d{5}$/.test(area)) api.zip = area; else if (area) api.search = area;
    if (d.maxp) api.maxPrice = String(d.maxp); if (d.beds) api.minBedrooms = String(d.beds);
    const label = [area || "Houston", d.beds ? d.beds + "+ bd" : "", d.maxp ? "≤ " + money(d.maxp) : ""].filter(Boolean).join(" · ");
    await db("jag_client_searches", { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify({
      user_id: c.user_id, label, alerts: true,
      params: { api, ui: { b: null, q: area, beds: d.beds ? String(d.beds) : "", maxp: d.maxp ? String(d.maxp) : "", minp: "", type: "sale", baths: "", kinds: ["Residential"] } },
    }) });
  }
  if (!c.agent_code && d.agent_code) {
    await db(`jag_clients?user_id=eq.${c.user_id}`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ agent_code: d.agent_code, agent_set_at: new Date().toISOString() }) });
  }
  await patch(d.id, { status: "account", stop_reason: "created_account" });
}

/* ---------------- run ---------------- */
async function agentsMap() {
  const rows: Row[] = await db("jag_agents?select=code,name,first_name,phone,email,photo_url&active=eq.true");
  return new Map((rows || []).map((a) => [a.code, a]));
}
async function pick(d: Row) {
  const sent = new Set<string>(d.sent_mls || []);
  return (await repliers(homesQuery(d))).map(snap).filter((s) => !sent.has(s.mls)).slice(0, d.params ? 8 : 6);
}

async function run() {
  const hour = houstonHour(), now = new Date();
  const due: Row[] = await db(`jag_lead_drips?select=*&status=eq.active&next_at=lte.${now.toISOString()}&order=next_at.asc&limit=100`);
  const stats: Row = { due: due.length, sent: 0, skipped: 0, account: 0, done: 0, no_homes: 0, errors: 0, hourCT: hour };
  if (!due.length) return stats;
  if (hour < 8 || hour >= 20) { stats.outside_hours = true; return stats; }
  if (!RESEND || !RK) return { ...stats, error: "RESEND_API_KEY or REPLIERS_API_KEY missing" };
  const agents = await agentsMap();
  for (const d of due) {
    try {
      const created = new Date(d.created_at);
      const mx = !!d.params;
      if (mx ? (d.ends_at && now.getTime() > new Date(d.ends_at).getTime()) : (now.getTime() - created.getTime()) / DAY > 90) { await patch(d.id, { status: "done" }); stats.done++; continue; }
      if (!mx) {
        const acc: Row[] = await db(`jag_clients?select=user_id,agent_code&email=eq.${encodeURIComponent(String(d.email).toLowerCase())}&limit=1`);
        if (acc && acc.length) { await handover(d, acc[0]); stats.account++; continue; }
      }
      const homes = await pick(d);
      if (!homes.length) {
        if (!d.sent_count && !mx) { await patch(d.id, { status: "no_homes", last_error: "No HAR homes match this area and budget" }); stats.no_homes++; }
        else { const n = nextAt(created, d.sent_count, d); await patch(d.id, n ? { next_at: n.toISOString(), last_error: mx && !d.sent_count ? "Waiting: nothing matches right now" : null } : { status: "done" }); stats.skipped++; }
        continue;
      }
      const tok = await sig(d.id);
      const { subject, html, replyTo } = buildEmail(d, agents.get(d.agent_code) || null, homes, `${SITE}/unsubscribe?d=${d.id}&s=${tok}`);
      const r = await fetch("https://api.resend.com/emails", {
        method: "POST", headers: { Authorization: `Bearer ${RESEND}`, "Content-Type": "application/json" },
        body: JSON.stringify({ from: FROM, to: [d.email], reply_to: replyTo, subject, html,
          headers: { "List-Unsubscribe": `<${SB}/functions/v1/lead-emails?d=${d.id}&s=${tok}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" } }),
      });
      if (!r.ok) {
        stats.errors++;
        await patch(d.id, { last_error: `email ${r.status}: ${(await r.text()).slice(0, 160)}`, next_at: new Date(now.getTime() + DAY).toISOString() });
        continue;
      }
      const count = (d.sent_count || 0) + 1, n = nextAt(created, count, d);
      await patch(d.id, { sent_count: count, last_sent_at: now.toISOString(), last_error: null,
        sent_mls: [...(d.sent_mls || []), ...homes.map((h) => h.mls)].slice(-300), ...(n ? { next_at: n.toISOString() } : { status: "done" }) });
      stats.sent++;
    } catch (e) {
      stats.errors++; console.error("drip", d.id, String(e).slice(0, 300));
      try { await patch(d.id, { last_error: String(e).slice(0, 200), next_at: new Date(now.getTime() + DAY).toISOString() }); } catch (_) { /* ignore */ }
    }
  }
  return stats;
}

/* ---------------- unsubscribe ---------------- */
const ORIGINS = new Set(["https://jasonaguirregroup.company", "https://www.jasonaguirregroup.company"]);
function cors(req: Request): Record<string, string> {
  const o = req.headers.get("origin") || "";
  return ORIGINS.has(o) ? { "Access-Control-Allow-Origin": o, "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "content-type", Vary: "Origin" } : { Vary: "Origin" };
}
async function unsubscribe(req: Request, id: string, s: string) {
  const h = { "Content-Type": "application/json", ...cors(req) };
  if (!/^[0-9a-f-]{36}$/.test(id) || !s || s !== await sig(id)) return new Response(JSON.stringify({ ok: false }), { status: 400, headers: h });
  await patch(id, { status: "unsubscribed", stop_reason: "unsubscribe" });
  return new Response(JSON.stringify({ ok: true }), { headers: h });
}

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);
  try {
    const did = url.searchParams.get("d");
    if (did) {
      if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(req) });
      if (req.method === "GET") return Response.redirect(`${SITE}/unsubscribe${url.search}`, 302);
      if (req.method === "POST") return await unsubscribe(req, did, url.searchParams.get("s") || "");
    }
    if (req.method !== "POST") return new Response("not found", { status: 404 });
    const ok = await db("rpc/jag_alerts_token_ok", { method: "POST", body: JSON.stringify({ p_token: req.headers.get("x-jag-token") || "" }) });
    if (ok !== true) return new Response(JSON.stringify({ error: "forbidden" }), { status: 403 });
    const body = await req.json().catch(() => ({}));
    if (body && body.preview) {   // render the next email for one lead; sends nothing, changes nothing
      const rows: Row[] = await db(`jag_lead_drips?select=*&id=eq.${encodeURIComponent(String(body.preview))}`);
      if (!rows || !rows.length) return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
      const d = rows[0], homes = await pick(d), agents = await agentsMap();
      const e = buildEmail(d, agents.get(d.agent_code) || null, homes, `${SITE}/unsubscribe?d=${d.id}&s=${await sig(d.id)}`);
      return new Response(JSON.stringify({ homes: homes.length, subject: e.subject, reply_to: e.replyTo, html: e.html }), { headers: { "Content-Type": "application/json" } });
    }
    const res = { ok: true, ...(await run()) };
    console.log(JSON.stringify(res));
    return new Response(JSON.stringify(res), { headers: { "Content-Type": "application/json" } });
  } catch (e) {
    console.error("lead-emails failure", String(e));
    return new Response(JSON.stringify({ error: String(e).slice(0, 300) }), { status: 500 });
  }
});
