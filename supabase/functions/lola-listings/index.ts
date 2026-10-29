// lola-listings: Lola's weekly email of new HAR listings to Houston-area leads (jag_lead_alerts, supabase-lola-listings.sql).
//
// Cron (every 10 minutes, mid-morning Houston time) with x-jag-token:
//   1. once a day: jag_lead_alerts_ramp (after a healthy pilot, adds 300 more leads a day until everyone is in)
//   2. claims up to 40 leads that are due (never emailed, or a week since the last email)
//   3. finds new listings for each (their budget / ZIP, else $150K-$300K around Houston), skipping homes already sent
//   4. sends a Spanish-first (English for English speakers) email from the assigned agent's name, replies to that agent,
//      with "tell me what you want" (casas.html) and a one-click unsubscribe; logs it on the contact's timeline
//
// ?unsub=<token>          one-click unsubscribe (mail apps POST; a click on GET lands on casas.html)
// ?action=test&to=<email>[&contact=<id>]   ops secret: send a preview of one lead's email to <email> (nothing recorded)
import { SITE, esc, money, row, button, homeCard, h1, lead, shell, C, OFFICE, phoneFmt, agentStrip, callout } from "./jag-email.ts";

const SB = Deno.env.get("SUPABASE_URL")!;
const SR = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const RK = Deno.env.get("REPLIERS_API_KEY") || "";
const RESEND = Deno.env.get("RESEND_API_KEY") || "";
const FROM = Deno.env.get("ALERTS_FROM") || "Jason Aguirre Group <alerts@updates.jasonhoustonrealty.com>";
const SELF = `${SB}/functions/v1/lola-listings`;
const FIELDS = "mlsNumber,listPrice,type,address,images,details.numBedrooms,details.numBathrooms,details.sqft,details.propertyType,permissions,listDate";
const PICKS = 6;
type Row = Record<string, any>;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });
async function rpc(fn: string, args: Row = {}): Promise<any> {
  const r = await fetch(`${SB}/rest/v1/rpc/${fn}`, { method: "POST", headers: { apikey: SR, Authorization: `Bearer ${SR}`, "Content-Type": "application/json" }, body: JSON.stringify(args) });
  const t = await r.text();
  if (!r.ok) throw new Error(`${fn} ${r.status} ${t.slice(0, 200)}`);
  return t ? JSON.parse(t) : null;
}
async function repliers(q: URLSearchParams): Promise<Row[]> {
  q.set("boardId", "147");
  const r = await fetch("https://api.repliers.io/listings?" + q.toString(), { headers: { "REPLIERS-API-KEY": RK, Accept: "application/json" } });
  if (!r.ok) { console.error("repliers", r.status, (await r.text()).slice(0, 200)); return []; }
  const d = await r.json();
  return (d.listings || []).filter((l: Row) => { const p = l.permissions || {}; return p.displayPublic !== "N" && p.displayInternetEntireListing !== "N"; });
}
function snap(l: Row) {
  const a = l.address || {}, d = l.details || {}, hide = (l.permissions || {}).displayAddressOnInternet === "N";
  return { mls: String(l.mlsNumber), price: l.listPrice ?? null, beds: d.numBedrooms ?? null, baths: d.numBathrooms ?? null, sqft: d.sqft ?? null,
    photo: (l.images || [])[0] || null, zip: a.zip || null, city: a.city || null,
    addr: hide ? "" : [a.streetNumber, a.streetDirectionPrefix, a.streetName, a.streetSuffix, a.streetDirection].filter(Boolean).join(" ") + (a.unitNumber ? " #" + a.unitNumber : "") };
}
const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/* ---------- finding homes ---------- */
const cache = new Map<string, Row[]>();
async function homesFor(cr: Row): Promise<Row[]> {
  const key = JSON.stringify([cr.min, cr.max, cr.beds, cr.zips, cr.cities]);
  if (cache.has(key)) return cache.get(key)!;
  const run = async (days: number) => {
    const q = new URLSearchParams({ type: "sale", status: "A", hasImages: "true", sortBy: "createdOnDesc", resultsPerPage: "60", fields: FIELDS });
    q.append("class", "residential"); q.append("class", "condo");
    q.set("minPrice", String(cr.min || 80000)); q.set("maxPrice", String(cr.max || 300000)); q.set("minBedrooms", String(cr.beds || 2));
    const zips: string[] = cr.zips || [], cities: string[] = cr.cities || [];
    if (zips.length) zips.forEach((z) => q.append("zip", z)); else cities.forEach((c) => q.append("city", c));
    q.set("minListDate", day(Date.now() - days * 864e5));
    return (await repliers(q)).map(snap).filter((h) => h.photo && h.price);
  };
  let list = await run(7);
  if (list.length < PICKS) list = list.concat((await run(21)).filter((h) => !list.some((x) => x.mls === h.mls)));
  cache.set(key, list);
  return list;
}
// up to 6 homes not sent before, spread across cities
function pick(list: Row[], sent: string[]): Row[] {
  const seen = new Set(sent), byCity = new Map<string, Row[]>();
  for (const h of list) { if (seen.has(h.mls)) continue; const k = h.city || "?"; if (!byCity.has(k)) byCity.set(k, []); byCity.get(k)!.push(h); }
  const out: Row[] = [], groups = [...byCity.values()];
  while (out.length < PICKS && groups.some((g) => g.length)) for (const g of groups) { const h = g.shift(); if (h && out.length < PICKS) out.push(h); }
  return out;
}

/* ---------- the email ---------- */
const T = {
  es: { hi: (f: string) => `Hola${f ? " " + f : ""}, estas casas salieron esta semana`, view: "Ver la casa", bd: "rec", ba: "baños", sqft: "pies²",
    why: (cr: Row, mine: boolean) => mine ? `Las escogí según lo que me dijo: hasta ${money(cr.max)}${cr.cities?.length && cr.cities.length <= 4 ? " en " + cr.cities.join(", ") : ""}. ¿Alguna le gusta? Responda a este correo y la vamos a ver.`
      : `Le escogí casas nuevas de hasta ${money(cr.max)} en el área de Houston. ¿Alguna le gusta? Responda a este correo y la vamos a ver.`,
    tell: "Dígame qué busca", tellTxt: "¿Busca otra zona, otro precio o más recámaras? Dígamelo en 30 segundos y solo le mando lo que le sirve.",
    more: "Ver más casas", pre: "¿Ya sabe cuánto puede comprar? Precalifique gratis, no afecta su crédito:", preBtn: "Ver cuánto califico",
    subj: (n: number, cr: Row, f: string, first: boolean) => first ? `${f ? f + ", " : ""}casas nuevas para usted en Houston` : `${n} casas nuevas esta semana · hasta ${money(cr.max)}`,
    prefs: "Elegir qué casas recibo", unsub: "Cancelar suscripción",
    foot: "Recibe este correo porque pidió información de casas a Jason Aguirre Group. Lola es la asistente de su agente. Información de listados de HAR a través de Repliers; se considera confiable pero no garantizada.",
    agent: "Tu agente" },
  en: { hi: (f: string) => `Hi${f ? " " + f : ""}, these homes just hit the market`, view: "View home", bd: "bd", ba: "ba", sqft: "sqft",
    why: (cr: Row, mine: boolean) => mine ? `Picked from what you told me: up to ${money(cr.max)}${cr.cities?.length && cr.cities.length <= 4 ? " in " + cr.cities.join(", ") : ""}. Like one? Reply to this email and we'll go see it.`
      : `I picked new homes up to ${money(cr.max)} around Houston for you. Like one? Reply to this email and we'll go see it.`,
    tell: "Tell me what you want", tellTxt: "Looking in another area, price or size? Tell me in 30 seconds and I'll only send what fits.",
    more: "See more homes", pre: "Know how much you can buy? Get pre-qualified free, no hit to your credit:", preBtn: "See what I qualify for",
    subj: (n: number, cr: Row, f: string, first: boolean) => first ? `${f ? f + ", " : ""}new homes for you in Houston` : `${n} new homes this week · up to ${money(cr.max)}`,
    prefs: "Choose which homes I get", unsub: "Unsubscribe",
    foot: "You get this email because you asked Jason Aguirre Group about homes. Lola is your agent's assistant. Listing information from HAR through Repliers; deemed reliable but not guaranteed.",
    agent: "Your agent" },
};
function firstName(r: Row) { return String(r.first_name || r.name || "").trim().split(/\s+/)[0].replace(/^./, (c) => c.toUpperCase()).slice(0, 30); }
function buildEmail(r: Row, homes: Row[], mine: boolean) {
  const es = r.lang !== "en", L = T[es ? "es" : "en"], ag = r.agent || {}, f = firstName(r), cr = r.criteria || {};
  const prefs = `${SITE}/casas.html?t=${r.token}`, unsub = `${SITE}/casas.html?t=${r.token}&u=1`;
  const homeUrl = (mls: string) => `${SITE}/homes?a=${encodeURIComponent(ag.code || "jason")}&src=lola#${encodeURIComponent(mls)}`;
  const cards = homes.map((h) => {
    const specs = [h.beds != null ? `${h.beds} ${L.bd}` : "", h.baths != null ? `${h.baths} ${L.ba}` : "", h.sqft ? `${Number(h.sqft).toLocaleString("en-US")} ${L.sqft}` : ""].filter(Boolean).join("  ·  ");
    return homeCard({ url: homeUrl(h.mls), photo: h.photo, price: h.price, specs, addr: [[h.addr, h.city].filter(Boolean).join(", "), h.zip].filter(Boolean).join(" "), btn: L.view });
  }).join("");
  const phone = phoneFmt(ag.phone) || OFFICE;
  const html = shell({ es, title: L.subj(homes.length, cr, f, !!r.first), preheader: L.why(cr, mine).slice(0, 110),
    body: row(agentStrip(ag.name || "Jason Aguirre", `${L.agent} · ${phone} · eXp Realty`, ag.photo_url)
      + h1(L.hi(f)) + lead(L.why(cr, mine)) + cards
      + callout(`<div style="font-weight:800;font-size:16px;margin-bottom:6px">${esc(L.tell)}</div><div style="margin-bottom:12px">${esc(L.tellTxt)}</div>${button(prefs, L.tell)}`, "red")
      + callout(`<div style="margin-bottom:10px">${esc(L.pre)}</div>${button(`${SITE}/apply.html?src=lola`, L.preBtn, { kind: "dark" })}`, "gray")
      + `<div style="text-align:center;margin:6px 0 4px">${button(`${SITE}/homes?a=${encodeURIComponent(ag.code || "jason")}&src=lola`, L.more, { kind: "outline" })}</div>`, "0 32px"),
    links: [[L.prefs, prefs], [L.unsub, unsub]], footerNote: L.foot });
  return { subject: L.subj(homes.length, cr, f, !!r.first), html };
}
async function send(r: Row, mail: { subject: string; html: string }, to: string) {
  const ag = r.agent || {};
  const res = await fetch("https://api.resend.com/emails", { method: "POST", headers: { Authorization: `Bearer ${RESEND}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: FROM.replace(/^[^<]*</, `${String(ag.name || "Jason Aguirre").replace(/[<>"]/g, "")} · JAG <`), to: [to], reply_to: ag.email || undefined,
      subject: mail.subject, html: mail.html, tags: [{ name: "kind", value: "lola_listings" }],
      headers: { "List-Unsubscribe": `<${SELF}?unsub=${r.token}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" } }) });
  const body = await res.json().catch(() => ({}));
  return res.ok ? { id: String((body as Row).id || ""), error: null } : { id: null, error: `${res.status} ${String((body as Row).message || (body as Row).name || "").slice(0, 200)}` };
}
const isDefault = (cr: Row) => !(cr.zips || []).length && (cr.cities || []).length >= 10;

/* ---------- entry ---------- */
Deno.serve(async (req) => {
  const u = new URL(req.url);
  const unsub = u.searchParams.get("unsub");
  if (unsub) {
    if (/^[0-9a-f]{24,64}$/.test(unsub)) await rpc("jag_lead_alert_set", { p_token: unsub, p: { unsub: true } }).catch(() => null);
    if (req.method === "POST") return new Response("ok");
    return Response.redirect(`${SITE}/casas.html?t=${encodeURIComponent(unsub)}&done=unsub`, 302);
  }
  const tok = req.headers.get("x-jag-token") || "", ops = req.headers.get("x-jag-ops-secret") || "";
  let byOps = false;
  if (ops) byOps = String(await rpc("jag_ops_secret").catch(() => "")) === ops;
  const ok = byOps || (tok && (await rpc("jag_alerts_token_ok", { p_token: tok }).catch(() => false)) === true);
  if (!ok) return new Response("no", { status: 403 });
  if (!RK || !RESEND) return json({ ok: false, error: "REPLIERS_API_KEY / RESEND_API_KEY missing" }, 503);

  const action = u.searchParams.get("action") || "run";
  try {
    if (action === "test" && byOps) {
      // a preview of one lead's email, sent to someone on the team; nothing is recorded
      const to = String(u.searchParams.get("to") || "");
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(to)) return json({ ok: false, error: "to" }, 400);
      const cid = u.searchParams.get("contact");
      const r: Row = { token: "preview0000000000000000000000000", lang: u.searchParams.get("lang") === "en" ? "en" : "es", first: u.searchParams.get("first") === "1",
        name: u.searchParams.get("name") || "María", criteria: { min: 150000, max: 300000, beds: 2, zips: [], cities: [] }, sent_mls: [],
        agent: { code: "jason", name: "Jason Aguirre", first_name: "Jason", email: "jason.aguirre@jasonhoustonrealty.com", phone: "8327023574" } };
      if (cid) {
        const rows = await fetch(`${SB}/rest/v1/jag_lead_alerts?contact_id=eq.${encodeURIComponent(cid)}&select=token,criteria,lang,sent_mls,contact:jag_contacts(name,first_name,assigned_code)`,
          { headers: { apikey: SR, Authorization: `Bearer ${SR}` } }).then((x) => x.json());
        const a = rows && rows[0];
        if (a) { Object.assign(r, { token: a.token, criteria: a.criteria, lang: a.lang, name: a.contact?.name, first_name: a.contact?.first_name });
          const ag = await fetch(`${SB}/rest/v1/jag_agents?code=eq.${encodeURIComponent(a.contact?.assigned_code || "jason")}&select=code,name,first_name,email,phone,phone_override,photo_url`,
            { headers: { apikey: SR, Authorization: `Bearer ${SR}` } }).then((x) => x.json());
          if (ag && ag[0]) r.agent = { ...ag[0], phone: ag[0].phone_override || ag[0].phone }; }
      }
      if (!r.criteria.cities?.length && !r.criteria.zips?.length) r.criteria.cities = await rpc("jag_lola_cities");
      const homes = pick(await homesFor(r.criteria), []);
      const mail = buildEmail(r, homes, !isDefault(r.criteria));
      const s = await send(r, mail, to);
      return json({ ok: !s.error, homes: homes.length, subject: mail.subject, ...s });
    }

    // the cron run
    const ramp = await rpc("jag_lead_alerts_ramp").catch((e) => ({ error: String(e) }));
    const due: Row[] = await rpc("jag_lead_alerts_claim", { p_limit: Number(u.searchParams.get("limit")) || 40 });
    let sent = 0, skipped = 0, failed = 0;
    const started = Date.now();
    for (const r of due) {
      if (Date.now() - started > 120e3) continue;   // out of time: the claim runs out in 20 minutes and a later run sends it
      const homes = pick(await homesFor(r.criteria || {}), r.sent_mls || []);
      if (homes.length < 2) { await rpc("jag_lead_alert_skip", { p_contact: r.contact_id }); skipped++; continue; }
      const mail = buildEmail(r, homes, !isDefault(r.criteria || {}));
      const s = await send(r, mail, r.email);
      await rpc("jag_lead_alert_done", { p_contact: r.contact_id, p_mls: s.error ? [] : homes.map((h) => h.mls), p_resend: s.id, p_error: s.error });
      if (s.error) failed++; else sent++;
      await sleep(600);   // stay under the email provider's 2-per-second limit
    }
    return json({ ok: true, ramp, claimed: due.length, sent, skipped, failed, searches: cache.size });
  } catch (e) {
    return json({ ok: false, error: String((e as Error)?.message || e) }, 500);
  }
});
