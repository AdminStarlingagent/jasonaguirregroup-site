import "jsr:@supabase/functions-js/edge-runtime.d.ts";

// JAG home emails for screened leads (table jag_lead_drips). Runs hourly (pg_cron → this function with the vault token).
// Pace (standard): a welcome right away, then up to 2 a week for the first 30 days, then weekly through day 90.
// Sends only 8 AM–8 PM Houston time. Each email shows matching HAR homes the lead hasn't been sent yet; when nothing
// new matches, that email is skipped and the next date moves forward (never an empty email).
// Stops: unsubscribe (POST ?d=<id>&s=<sig>, from /unsubscribe or a mail app's one-click), the agent (jag_drip_stop),
// day 90, or the lead creating a website account — then status 'account', their account gets a saved search with the
// same criteria, their agent is set, and the regular listing alerts take over.
// POST {"preview":"<drip id>"} with the token returns the next email's HTML without sending or changing anything.

const SB = Deno.env.get("SUPABASE_URL")!;
const SR = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const RK = Deno.env.get("REPLIERS_API_KEY") || "";
const RESEND = Deno.env.get("RESEND_API_KEY") || "";
const FROM = Deno.env.get("ALERTS_FROM") || "Jason Aguirre Group <alerts@updates.jasonhoustonrealty.com>";
const DEF_REPLY = Deno.env.get("ALERTS_REPLY_TO") || "jason.aguirre@jasonhoustonrealty.com";
const TEAM_PHONE = "(832) 702-3574";
const SITE = "https://jasonaguirregroup.company";
const CDN = "https://cdn.repliers.io/";
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
function nextAt(created: Date, sentCount: number): Date | null {
  const age = (Date.now() - created.getTime()) / DAY;
  const step = age < 30 ? (sentCount % 2 ? 3 : 4) : 7;
  const d = atHoustonHour(new Date(Date.now() + step * DAY), 10);
  return (d.getTime() - created.getTime()) / DAY > 90 ? null : d;
}

/* ---------------- email ---------------- */
const esc = (v: any) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
const money = (n: any) => n == null ? "" : "$" + Math.round(Number(n)).toLocaleString("en-US");
function fmtPhone(p: any) { const d = String(p || "").replace(/\D/g, "").replace(/^1(?=\d{10}$)/, ""); return d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : String(p || ""); }

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
    help: (first: string, phone: string) => `¿Quiere ver alguna? Responda a este correo o llame a ${first} al ${phone}.`,
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
    help: (first: string, phone: string) => `Want to see one? Reply to this email or call ${first} at ${phone}.`,
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

function buildEmail(d: Row, agent: Row | null, homes: Row[], unsubUrl: string) {
  const L = TXT[d.lang === "en" ? "en" : "es"], first = String(d.name || "").trim().split(/\s+/)[0];
  const aName = agent?.name || "Jason Aguirre", aFirst = agent?.first_name || aName.split(" ")[0], aPhone = agent?.phone ? fmtPhone(agent.phone) : TEAM_PHONE;
  const crit = L.crit(d), lk = links(d), welcome = !d.sent_count;
  const subject = welcome ? L.s_welcome(d) : L.s_more(homes.length, d);
  const dt = new Date(d.created_at).toLocaleDateString(d.lang === "en" ? "en-US" : "es-MX", { timeZone: "America/Chicago", month: "long", day: "numeric", year: "numeric" });
  const cards = homes.map((s) => {
    const specs = [s.beds != null ? `${s.beds} ${L.bd}` : "", s.baths != null ? `${s.baths} ${L.ba}` : "", s.sqft ? `${Number(s.sqft).toLocaleString("en-US")} sqft` : ""].filter(Boolean).join(" · ");
    const url = lk.home(s.mls);
    return `<tr><td style="padding:0 0 18px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #dddde3;border-radius:12px;overflow:hidden">
      ${s.photo ? `<tr><td><a href="${url}"><img src="${CDN}${esc(s.photo)}?class=medium" width="560" alt="" style="display:block;width:100%;max-width:560px;height:auto;border:0"></a></td></tr>` : ""}
      <tr><td style="padding:14px 16px;font-family:Arial,Helvetica,sans-serif;color:#17161c">
        <div style="font-size:22px;font-weight:bold">${money(s.price)}</div>
        <div style="font-size:14px;margin:2px 0">${esc(specs)}</div>
        <div style="font-size:14px;color:#5f5e68">${esc([s.addr, s.city].filter(Boolean).join(", "))} ${esc(s.zip || "")}</div>
        <a href="${url}" style="display:inline-block;margin-top:12px;background:#c8102e;color:#fff;text-decoration:none;font-weight:bold;padding:10px 16px;border-radius:8px;font-size:14px">${L.view}</a>
      </td></tr></table></td></tr>`;
  }).join("");
  const html = `<!doctype html><html><body style="margin:0;background:#f5f5f7"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f7"><tr><td align="center" style="padding:24px 12px">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#fff;border-radius:14px"><tr><td style="padding:22px 20px 6px;font-family:Arial,Helvetica,sans-serif;color:#17161c">
    <div style="font-size:26px;font-weight:bold;color:#c8102e;letter-spacing:-.5px">JAG <span style="font-size:11px;color:#5f5e68;letter-spacing:2px">REAL ESTATE · eXp Realty</span></div>
    <p style="font-size:16px;margin:16px 0 4px">${L.hi}${first ? " " + esc(first) : ""},</p>
    <p style="font-size:15px;color:#5f5e68;margin:0 0 18px">${esc(welcome ? L.welcome(aName, crit) : L.more(crit))}</p>
  </td></tr><tr><td style="padding:0 20px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0">${cards}</table></td></tr>
  <tr><td style="padding:0 20px 18px;text-align:center"><a href="${lk.all}" style="display:inline-block;border:2px solid #17161c;color:#17161c;text-decoration:none;font-weight:bold;padding:10px 18px;border-radius:8px;font-size:14px;font-family:Arial,Helvetica,sans-serif">${L.all}</a></td></tr>
  <tr><td style="padding:0 20px 18px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f7;border-radius:12px"><tr><td style="padding:16px;font-family:Arial,Helvetica,sans-serif;color:#17161c">
    <div style="font-size:16px;font-weight:bold">${L.acct_h}</div><div style="font-size:14px;color:#5f5e68;margin:4px 0 12px">${L.acct_p}</div>
    <a href="${lk.account}" style="display:inline-block;background:#17161c;color:#fff;text-decoration:none;font-weight:bold;padding:10px 16px;border-radius:8px;font-size:14px">${L.acct_btn}</a>
  </td></tr></table></td></tr>
  <tr><td style="padding:0 20px 18px;font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#17161c">${esc(L.help(aFirst, aPhone))}<br><br>${esc(aName)}<br>Jason Aguirre Group · eXp Realty · ${esc(aPhone)}</td></tr>
  <tr><td style="padding:16px 20px 22px;border-top:1px solid #dddde3;font-family:Arial,Helvetica,sans-serif;font-size:12px;color:#85848d">
    <a href="${unsubUrl}" style="color:#2653d9">${L.unsub}</a><br><br>${esc(L.why(dt))}<br>${L.disc}<br>Jason Aguirre Group · eXp Realty · 5373 W Alabama St, Suite 448, Houston, TX 77056
  </td></tr></table></td></tr></table></body></html>`;
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
  const rows: Row[] = await db("jag_agents?select=code,name,first_name,phone,email&active=eq.true");
  return new Map((rows || []).map((a) => [a.code, a]));
}
async function pick(d: Row) {
  const sent = new Set<string>(d.sent_mls || []);
  return (await repliers(homesQuery(d))).map(snap).filter((s) => !sent.has(s.mls)).slice(0, 6);
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
      if ((now.getTime() - created.getTime()) / DAY > 90) { await patch(d.id, { status: "done" }); stats.done++; continue; }
      const acc: Row[] = await db(`jag_clients?select=user_id,agent_code&email=eq.${encodeURIComponent(String(d.email).toLowerCase())}&limit=1`);
      if (acc && acc.length) { await handover(d, acc[0]); stats.account++; continue; }
      const homes = await pick(d);
      if (!homes.length) {
        if (!d.sent_count) { await patch(d.id, { status: "no_homes", last_error: "No HAR homes match this area and budget" }); stats.no_homes++; }
        else { const n = nextAt(created, d.sent_count); await patch(d.id, n ? { next_at: n.toISOString() } : { status: "done" }); stats.skipped++; }
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
      const count = (d.sent_count || 0) + 1, n = nextAt(created, count);
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
