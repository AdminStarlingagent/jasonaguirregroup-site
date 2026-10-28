import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { SITE, esc, money, row, button, homeCard, h1, lead, shell, C } from "./jag-email.ts";

// JAG listing alerts. Runs hourly (pg_cron → this function with the vault token).
//  1. Saved searches: new HAR listings that match, listed since the last check.
//  2. "Smart" alerts: new listings in the ZIPs a client keeps viewing, with their usual beds/baths/price.
//  3. Saved homes: price changes and status changes (pending, sold, back on market...).
// Alerts are always recorded (clients see them in their account). Emails go out through Resend
// when RESEND_API_KEY is set: "instant" clients every run, "daily" clients once a day at the hour
// they usually browse (best_hour from jag_client_scores, 7 AM-8 PM Houston), otherwise the 8 AM run.
// Home links carry ?src=alert so the site can log that the client came back from an alert.
// POST ?u=<user>&s=<sig> unsubscribes (site confirm page or mail-app one-click).

const SB = Deno.env.get("SUPABASE_URL")!;
const SR = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const RK = Deno.env.get("REPLIERS_API_KEY") || "";
const RESEND = Deno.env.get("RESEND_API_KEY") || "";
const FROM = Deno.env.get("ALERTS_FROM") || "Jason Aguirre Group <alerts@updates.jasonhoustonrealty.com>";
const REPLY_TO = Deno.env.get("ALERTS_REPLY_TO") || "jason.aguirre@jasonhoustonrealty.com";
const BOARD = "147";
const FIELDS = "mlsNumber,listPrice,type,address,images,details.numBedrooms,details.numBathrooms,details.sqft,details.propertyType,permissions,standardStatus,listDate";
const SEARCH_KEYS = new Set(["type", "state", "city", "zip", "search", "map", "minPrice", "maxPrice", "minBedrooms", "minBaths", "propertyType"]);

type Row = Record<string, any>;

async function db(path: string, init: RequestInit = {}): Promise<any> {
  const r = await fetch(`${SB}/rest/v1/${path}`, {
    ...init,
    headers: { apikey: SR, Authorization: `Bearer ${SR}`, "Content-Type": "application/json", ...(init.headers || {}) },
  });
  if (!r.ok) throw new Error(`db ${path.split("?")[0]} ${r.status} ${(await r.text()).slice(0, 200)}`);
  return r.status === 204 ? null : r.json().catch(() => null);
}

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

function snap(l: Row) {
  const a = l.address || {}, d = l.details || {};
  const hideAddr = (l.permissions || {}).displayAddressOnInternet === "N";
  return {
    price: l.listPrice ?? null, beds: d.numBedrooms ?? null, baths: d.numBathrooms ?? null, sqft: d.sqft ?? null,
    photo: (l.images || [])[0] || null, zip: a.zip || null, city: a.city || null,
    addr: hideAddr ? "" : [a.streetNumber, a.streetDirectionPrefix, a.streetName, a.streetSuffix, a.streetDirection].filter(Boolean).join(" ") + (a.unitNumber ? " #" + a.unitNumber : ""),
    type: l.type || null, ptype: d.propertyType || null,
  };
}

function day(ts: string | number | Date) { return new Date(ts).toISOString().slice(0, 10); }
function median(a: any[]) {
  const v = a.filter((x) => x != null && isFinite(x)).map(Number).sort((x, y) => x - y);
  return v.length ? v[Math.floor((v.length - 1) / 2)] : null;
}

async function sig(uid: string) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(SR), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const s = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode("unsub:" + uid));
  return Array.from(new Uint8Array(s)).slice(0, 16).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/* ---------------- collect alerts ---------------- */
async function collect(clients: Map<string, Row>) {
  const now = new Date();
  const out: Row[] = [];
  const stats = { searches: 0, smart: 0, favorites: 0 };

  // 1. saved searches
  const searches: Row[] = await db("jag_client_searches?select=*&alerts=eq.true");
  for (const s of searches) {
    if (!clients.has(s.user_id)) continue;
    const api = (s.params && s.params.api) || {};
    if (api.type === "lease") continue; // rental alerts not offered yet
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(api)) {
      if (!SEARCH_KEYS.has(k)) continue;
      for (const x of ([] as any[]).concat(v)) q.append(k, String(x).slice(0, 2000));
    }
    if (String(api.newc) === "1") q.set("raw.NewConstructionYN", "true"); // "Construcción nueva" searches
    q.set("status", "A"); q.append("class", "residential"); q.append("class", "condo");
    q.set("hasImages", "true"); q.set("minListDate", day(new Date(s.last_checked_at).getTime() - 864e5));
    q.set("sortBy", "createdOnDesc"); q.set("resultsPerPage", "15"); q.set("fields", FIELDS);
    const ls = await repliers(q);
    stats.searches++;
    for (const l of ls) {
      out.push({ user_id: s.user_id, kind: "new", mls: String(l.mlsNumber), search_id: s.id, dedupe: "new:" + l.mlsNumber,
        detail: { label: s.label, snap: snap(l) } });
    }
    await db(`jag_client_searches?id=eq.${s.id}`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ last_checked_at: now.toISOString() }) });
  }

  // 2. smart alerts from the last 30 days of activity + saved homes
  const since30 = new Date(now.getTime() - 30 * 864e5).toISOString();
  const acts: Row[] = await db(`jag_client_activity?select=user_id,kind,zip,price,beds,baths,ptype&kind=in.(view,search)&created_at=gte.${since30}`);
  const favs: Row[] = await db("jag_client_favorites?select=*");
  const taste = new Map<string, Row[]>();
  for (const a of acts) {
    if (/lease/i.test(a.ptype || "")) continue;
    (taste.get(a.user_id) || taste.set(a.user_id, []).get(a.user_id)!).push({ ...a, w: a.kind === "view" ? 1 : 2 });
  }
  for (const f of favs) {
    const s = f.snap || {};
    if (s.type === "Lease") continue;
    (taste.get(f.user_id) || taste.set(f.user_id, []).get(f.user_id)!).push({ zip: s.zip, price: f.last_price || s.price, beds: s.beds, baths: s.baths, w: 3 });
  }
  for (const [uid, rows] of taste) {
    if (!clients.has(uid)) continue;
    const zc: Record<string, number> = {};
    for (const r of rows) if (r.zip && /^\d{5}$/.test(r.zip)) zc[r.zip] = (zc[r.zip] || 0) + r.w;
    const zips = Object.keys(zc).filter((z) => zc[z] >= 3).sort((a, b) => zc[b] - zc[a]).slice(0, 2); // real interest, not one click
    if (!zips.length) continue;
    const beds = median(rows.map((r) => r.beds)), baths = median(rows.map((r) => r.baths));
    const price = median(rows.filter((r) => r.price > 20000).map((r) => r.price));
    for (const z of zips) {
      const q = new URLSearchParams({ type: "sale", zip: z, status: "A", hasImages: "true", sortBy: "createdOnDesc", resultsPerPage: "5", fields: FIELDS });
      q.append("class", "residential"); q.append("class", "condo"); q.append("propertyType", "Residential");
      q.set("minListDate", day(now.getTime() - 2 * 864e5));
      if (beds) q.set("minBedrooms", String(Math.floor(beds)));
      if (baths) q.set("minBaths", String(Math.floor(baths)));
      if (price) { q.set("minPrice", String(Math.round(price * 0.75))); q.set("maxPrice", String(Math.round(price * 1.25))); }
      const ls = await repliers(q);
      stats.smart++;
      const label = [z, beds ? Math.floor(beds) + "+ bd" : "", baths ? Math.floor(baths) + "+ ba" : ""].filter(Boolean).join(" · ");
      for (const l of ls) out.push({ user_id: uid, kind: "new", mls: String(l.mlsNumber), search_id: null, dedupe: "new:" + l.mlsNumber, detail: { smart: true, label, snap: snap(l) } });
    }
  }

  // 3. saved homes: price + status changes
  const mlsList = [...new Set(favs.filter((f) => clients.has(f.user_id)).map((f) => f.mls))];
  const cur = new Map<string, Row>();
  for (let i = 0; i < mlsList.length; i += 40) {
    const q = new URLSearchParams({ fields: FIELDS, resultsPerPage: "100" });
    q.append("status", "A"); q.append("status", "U");
    for (const m of mlsList.slice(i, i + 40)) q.append("mlsNumber", m);
    for (const l of await repliers(q)) {
      const prev = cur.get(String(l.mlsNumber));
      // a relisted home can appear twice; prefer the active record
      if (!prev || l.standardStatus === "Active") cur.set(String(l.mlsNumber), l);
    }
  }
  for (const f of favs) {
    const l = cur.get(f.mls); if (!l || !clients.has(f.user_id)) continue;
    stats.favorites++;
    const patch: Row = {};
    const sn = { ...(f.snap || {}), ...snap(l) };
    if (l.listPrice && f.last_price && Number(l.listPrice) !== Number(f.last_price)) {
      out.push({ user_id: f.user_id, kind: "price", mls: f.mls, search_id: null, dedupe: `price:${f.mls}:${l.listPrice}`,
        detail: { old_price: Number(f.last_price), new_price: Number(l.listPrice), snap: sn } });
    }
    if (l.listPrice && Number(l.listPrice) !== Number(f.last_price)) patch.last_price = l.listPrice;
    const st = l.standardStatus || null;
    if (st && f.last_status && st !== f.last_status) {
      out.push({ user_id: f.user_id, kind: "status", mls: f.mls, search_id: null, dedupe: `status:${f.mls}:${st}:${day(now)}`,
        detail: { old_status: f.last_status, new_status: st, snap: sn } });
    }
    if (st && st !== f.last_status) patch.last_status = st;
    if (Object.keys(patch).length) {
      await db(`jag_client_favorites?user_id=eq.${f.user_id}&mls=eq.${encodeURIComponent(f.mls)}`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify(patch) });
    }
  }

  // record (duplicates are ignored, so a home is only announced once per client)
  let inserted: Row[] = [];
  for (let i = 0; i < out.length; i += 200) {
    const r = await db("jag_client_alerts?on_conflict=user_id,dedupe", {
      method: "POST", headers: { Prefer: "resolution=ignore-duplicates,return=representation" }, body: JSON.stringify(out.slice(i, i + 200)),
    });
    inserted = inserted.concat(r || []);
  }
  return { stats, found: out.length, inserted: inserted.length };
}

/* ---------------- email (JAG design from jag-email.ts) ---------------- */
const TXT: Record<string, Record<string, any>> = {
  es: { hi: "Hola", intro: "Tenemos novedades de casas para usted:", new: "Casa nueva", smart: "Casa nueva parecida a lo que busca", price: "Cambió de precio", status: "Cambió de estado",
    view: "Ver la casa", manage: "Administrar mis avisos", unsub: "Dejar de recibir estos correos", why: "Recibe este correo porque tiene avisos de casas en su cuenta de jasonaguirregroup.company (usted o su agente los activó).",
    disc: "Información de listados de HAR a través de Repliers; se considera confiable pero no garantizada.", bd: "rec", ba: "baños", sqft: "pies²", for: "Para su búsqueda: ",
    s_new: (n: number) => n === 1 ? "1 casa nueva para usted" : `${n} casas nuevas para usted`, s_change: "Novedades de sus casas guardadas", cta: "¿Quiere verla o saber si califica? Responda a este correo o llámenos al", all: "Ver todo en mi cuenta" },
  en: { hi: "Hi", intro: "Here is what is new for you:", new: "New home", smart: "New home like what you are looking for", price: "Price change", status: "Status change",
    view: "View home", manage: "Manage my alerts", unsub: "Unsubscribe from these emails", why: "You get this email because your jasonaguirregroup.company account has home alerts on (set up by you or your agent).",
    disc: "Listing information from HAR through Repliers; deemed reliable but not guaranteed.", bd: "bd", ba: "ba", sqft: "sqft", for: "For your search: ",
    s_new: (n: number) => n === 1 ? "1 new home for you" : `${n} new homes for you`, s_change: "Updates on your saved homes", cta: "Want to see it or find out if you qualify? Reply to this email or call", all: "See everything in my account" },
};

function emailHtml(c: Row, alerts: Row[], unsubUrl: string, subject: string) {
  const es = c.lang !== "en";
  const L = TXT[es ? "es" : "en"];
  const first = (c.name || "").trim().split(/\s+/)[0];
  const cards = alerts.slice(0, 12).map((a) => {
    const d = a.detail || {}, s = d.snap || {};
    const label = a.kind === "price" ? esc(L.price) : a.kind === "status" ? `${esc(L.status)}: ${esc(d.new_status)}`
      : `${esc(d.smart ? L.smart : L.new)}${d.label && !d.smart ? ` · <span style="color:${C.muted};font-weight:600">${esc(L.for)}${esc(d.label)}</span>` : ""}`;
    const priceHtml = a.kind === "price"
      ? `<div style="font-size:26px;line-height:1.2;font-weight:800;letter-spacing:-.5px">${money(d.new_price)} <span style="font-size:16px;font-weight:600;color:${C.muted};text-decoration:line-through">${money(d.old_price)}</span></div>`
      : undefined;
    const specs = [s.beds != null ? `${s.beds} ${L.bd}` : "", s.baths != null ? `${s.baths} ${L.ba}` : "", s.sqft ? `${Number(s.sqft).toLocaleString("en-US")} ${L.sqft}` : ""].filter(Boolean).join("  ·  ");
    return homeCard({ url: `${SITE}/homes?src=alert#${encodeURIComponent(a.mls)}`, photo: s.photo, price: s.price, priceHtml, specs,
      addr: [[s.addr, s.city].filter(Boolean).join(", "), s.zip].filter(Boolean).join(" "), label, btn: L.view });
  }).join("");
  const preheader = alerts.slice(0, 3).map((a) => { const s = (a.detail || {}).snap || {}; return [money(s.price), s.city].filter(Boolean).join(" "); }).filter(Boolean).join(" · ");
  return shell({ es, title: subject, preheader,
    body: row(h1(`${L.hi}${first ? " " + first : ""},`) + lead(L.intro) + cards
      + `<div style="text-align:center;margin:4px 0 20px">${button(SITE + "/account", L.all, { kind: "outline" })}</div>`
      + `<div style="border-top:1px solid ${C.line};padding-top:16px;text-align:center;font-size:14px;color:${C.muted}">${esc(L.cta)} <a href="tel:+18327023574" style="color:${C.ink};font-weight:700;text-decoration:none">(832) 702-3574</a>.</div>`, "0 32px"),
    links: [[L.manage, SITE + "/account#settings"], [L.unsub, unsubUrl]],
    footerNote: L.why + " " + L.disc });
}

// Each client's usual browsing hour (from the active buyer score). Missing table or data → 8 AM.
async function bestHours(): Promise<Map<string, number>> {
  try {
    const rows: Row[] = await db("jag_client_scores?select=user_id,best_hour&best_hour=not.is.null");
    return new Map((rows || []).map((r) => [r.user_id, Number(r.best_hour)]));
  } catch (e) {
    console.error("best hours", String(e).slice(0, 200));
    return new Map();
  }
}

// Each kind of alert follows the client's own switch (Ajustes): new homes, price changes, status changes → instant | daily | off.
// Clients from before the switches existed use their single alert_freq for all three.
function freqOf(c: Row, kind: string): string {
  const n = c.notify || {}, key = kind === "price" ? "price" : kind === "status" ? "status" : "new";
  return n[key] || c.alert_freq || "instant";
}
function quietNow(f: any, t: any, h: number) {
  if (f == null || t == null || f === t) return false;
  return f < t ? (h >= f && h < t) : (h >= f || h < t);
}
async function markEmailed(ids: any[]) {
  if (!ids.length) return;
  await db(`jag_client_alerts?id=in.(${ids.join(",")})`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ emailed_at: new Date().toISOString() }) });
}

async function sendEmails(clients: Map<string, Row>) {
  const hourCT = Number(new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", hour: "numeric", hour12: false }).format(new Date())) % 24;
  const todayCT = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago" }).format(new Date());
  const since = new Date(Date.now() - 7 * 864e5).toISOString();
  const pending: Row[] = await db(`jag_client_alerts?select=*&emailed_at=is.null&created_at=gte.${since}&order=created_at.desc&limit=2000`);
  const byUser = new Map<string, Row[]>();
  for (const a of pending) (byUser.get(a.user_id) || byUser.set(a.user_id, []).get(a.user_id)!).push(a);
  const hours = byUser.size ? await bestHours() : new Map<string, number>();
  let sent = 0, skipped = 0, held = 0;
  for (const [uid, list] of byUser) {
    const c = clients.get(uid);
    if (!c || c.paused_by_staff) { skipped++; continue; }
    // switched off: those stay in the app (Novedades) but never go out by email
    const off = list.filter((a) => freqOf(c, a.kind) === "off");
    if (off.length) await markEmailed(off.map((a) => a.id));
    const instant = list.filter((a) => freqOf(c, a.kind) === "instant");
    const daily = list.filter((a) => freqOf(c, a.kind) === "daily");
    if (!instant.length && !daily.length) continue;
    if (quietNow(c.quiet_from, c.quiet_to, hourCT)) { held++; continue; }            // quiet hours: wait
    const bh = hours.get(uid);
    const sendHour = bh != null && bh >= 7 && bh <= 20 ? bh : 8;
    const dailyDue = daily.length > 0 && hourCT >= sendHour && hourCT <= 20 && String(c.alerts_daily_on || "") !== todayCT;
    const out = instant.concat(dailyDue ? daily : []).sort((x, y) => String(y.created_at).localeCompare(String(x.created_at)));
    if (!out.length) continue;
    if (!RESEND) { skipped++; continue; }
    const L = TXT[c.lang === "en" ? "en" : "es"];
    const nNew = out.filter((a) => a.kind === "new").length;
    const subject = nNew ? L.s_new(nNew) : L.s_change;
    const tok = await sig(uid);
    const fnUnsub = `${SB}/functions/v1/listing-alerts?u=${uid}&s=${tok}`;
    const pageUnsub = `${SITE}/unsubscribe?u=${uid}&s=${tok}`;
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST", headers: { Authorization: `Bearer ${RESEND}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: FROM, to: [c.email], reply_to: REPLY_TO, subject, html: emailHtml(c, out, pageUnsub, subject),
        headers: { "List-Unsubscribe": `<${fnUnsub}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" } }),
    });
    if (!r.ok) { console.error("resend", r.status, (await r.text()).slice(0, 300)); continue; }
    await markEmailed(out.map((a) => a.id));
    if (dailyDue) await db(`jag_clients?user_id=eq.${uid}`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ alerts_daily_on: todayCT }) });
    sent++;
  }
  return { sent, skipped, held_quiet: held, email_configured: !!RESEND, hourCT };
}

/* ---------------- unsubscribe ---------------- */
// The email links to jasonaguirregroup.company/unsubscribe (a confirm button), which POSTs here.
// Mail apps' one-click unsubscribe (List-Unsubscribe-Post) also POSTs here directly.
const ORIGINS = new Set(["https://jasonaguirregroup.company", "https://www.jasonaguirregroup.company"]);
function cors(req: Request): Record<string, string> {
  const o = req.headers.get("origin") || "";
  return ORIGINS.has(o) ? { "Access-Control-Allow-Origin": o, "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "content-type", Vary: "Origin" } : { Vary: "Origin" };
}
async function unsubscribe(req: Request, u: string, s: string) {
  const h = { "Content-Type": "application/json", ...cors(req) };
  if (!/^[0-9a-f-]{36}$/.test(u) || !s || s !== await sig(u)) return new Response(JSON.stringify({ ok: false }), { status: 400, headers: h });
  const cur: Row[] = await db(`jag_clients?select=notify&user_id=eq.${u}`);
  const notify = { ...((cur && cur[0] && cur[0].notify) || {}), new: "off", price: "off", status: "off" };   // message emails keep their own switch
  await db(`jag_clients?user_id=eq.${u}`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ alert_freq: "off", notify }) });
  return new Response(JSON.stringify({ ok: true }), { headers: h });
}

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);
  try {
    if (url.searchParams.get("u")) {
      if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(req) });
      if (req.method === "GET") return Response.redirect(`${SITE}/unsubscribe${url.search}`, 302);
      if (req.method === "POST") return await unsubscribe(req, url.searchParams.get("u")!, url.searchParams.get("s") || "");
    }
    if (req.method !== "POST") return new Response("not found", { status: 404 });
    const ok = await db("rpc/jag_alerts_token_ok", { method: "POST", body: JSON.stringify({ p_token: req.headers.get("x-jag-token") || "" }) });
    if (ok !== true) return new Response(JSON.stringify({ error: "forbidden" }), { status: 403 });
    if (!RK) return new Response(JSON.stringify({ error: "REPLIERS_API_KEY missing" }), { status: 503 });

    const list: Row[] = await db("jag_clients?select=*");
    const clients = new Map(list.map((c) => [c.user_id, c]));
    const col = await collect(clients);
    const em = await sendEmails(clients);
    const res = { ok: true, clients: list.length, ...col, ...em };
    console.log(JSON.stringify(res));
    return new Response(JSON.stringify(res), { headers: { "Content-Type": "application/json" } });
  } catch (e) {
    console.error("alerts failure", String(e));
    return new Response(JSON.stringify({ error: String(e).slice(0, 300) }), { status: 500 });
  }
});
