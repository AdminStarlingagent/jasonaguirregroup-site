// jag-invest — the investor portal's data engine (jasonaguirregroup.company/invest, invite only).
// POST { action: 'analyze', address, sqft?, beds?, baths? } with the investor's sign-in token:
//   1. RentCast: the property record, its as-is value estimate and its long-term rent estimate (cached 7 days per address).
//   2. HAR (Repliers): homes that SOLD nearby — same type, similar era and size, close and recent — each adjusted to
//      this house's size and weighted by how similar it is → after-repair value (ARV) as worst / mid / best case.
//      Outliers and fixer sales are set aside (still listed).
//   3. FEMA flood zone (National Flood Hazard Layer) and the active listings he'd compete with at resale.
//   4. Saves the run (jag_investor_runs) so the investor can reopen it.
// POST { action: 'lola', id, deal, lang }: Lola reviews the deal (n8n "JAG Investor · Lola deal review" → Claude); saved on the run.
//   This is the only step that uses AI credits.
// POST { action: 'scan' } with the server token (daily, ops.kick_invest_scan): the deal finder. For each investor's
//   watch (areas, price, beds, minimum profit) it checks active HAR listings, runs the same comps/ARV math on the likely
//   flips (fixer wording, price cuts, long days on market, low $/sq ft) and emails a digest of the ones that clear his
//   profit bar. No RentCast calls and no AI.
import { createClient } from "jsr:@supabase/supabase-js@2";
import { SITE, esc, money, row, button, h1, lead, callout, shell, eyebrow, C, CDN } from "./jag-email.ts";

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SRK = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const RK = Deno.env.get("REPLIERS_API_KEY") || "";
const RESEND = Deno.env.get("RESEND_API_KEY") || "";
const FROM = Deno.env.get("ALERTS_FROM") || "Jason Aguirre Group <alerts@updates.jasonhoustonrealty.com>";
const ORIGINS = new Set(["https://jasonaguirregroup.company", "https://www.jasonaguirregroup.company", "http://127.0.0.1:8765"]);
type Row = Record<string, any>;

function cors(req: Request): Record<string, string> {
  const o = req.headers.get("origin") || "";
  return ORIGINS.has(o) ? { "Access-Control-Allow-Origin": o, "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info", Vary: "Origin" } : { Vary: "Origin" };
}
const num = (v: unknown) => { const n = Number(String(v ?? "").replace(/[^0-9.]/g, "")); return isFinite(n) && n > 0 ? n : null; };
const round = (n: number, to = 1000) => Math.round(n / to) * to;
function pct(sorted: number[], p: number) { if (!sorted.length) return null; const i = (sorted.length - 1) * p, lo = Math.floor(i), hi = Math.ceil(i); return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo); }
function miles(a: [number, number], b: [number, number]) {
  const R = 3958.8, r = (d: number) => d * Math.PI / 180, dLat = r(b[0] - a[0]), dLng = r(b[1] - a[1]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(r(a[0])) * Math.cos(r(b[0])) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
// Listing remarks → condition. "Remodeled" needs one strong phrase or two lighter ones; "fixer" = sold needing work.
const STRONG = /\b(remodel(ed|ing)?|renovat(ed|ion)|fully (updated|redone|renovated)|complete(ly)? (updated|redone|renovated)|down to the studs)\b/gi;
const LIGHT = /\b(updated|upgraded|new (roof|kitchen|flooring|floors|cabinets|paint|hvac|a\/c|ac|windows|appliances|countertops|fixtures|plumbing|electrical)|granite|quartz|shaker|luxury vinyl|lvp|move[- ]in ready|turn[- ]?key|like new)\b/gi;
const FIXER = /\b(investor special|investors? (welcome|opportunity|delight)|needs? (work|updating|tlc|repairs?|some love)|handyman|sold as[- ]is|as[- ]is condition|being sold as[- ]is|fixer|bring your (contractor|investor|tools)|cash (only|buyers?)|tear ?down|lot value|value (is )?in the land|fire damage|flood(ed)? damage|foundation (issues|repair needed)|sweat equity|diamond in the rough)\b/i;
function condition(text: string): "remodeled" | "fixer" | "" {
  const t = String(text || "");
  if (FIXER.test(t)) return "fixer";
  const strong = (t.match(STRONG) || []).length, light = new Set((t.match(LIGHT) || []).map((x) => x.toLowerCase())).size;
  return strong >= 1 || light >= 2 ? "remodeled" : "";
}
const DATE = (d: Date) => d.toISOString().slice(0, 10);
const isTH = (t: string) => /town|condo|hi-?rise|mid-?rise|duplex|multi|quad|triplex|mobile|manufactured/i.test(t);

async function rentcast(path: string, key: string) {
  const r = await fetch("https://api.rentcast.io/v1/" + path, { headers: { "X-Api-Key": key, Accept: "application/json" } });
  if (!r.ok) return { error: "rentcast " + r.status, body: (await r.text()).slice(0, 200) };
  return await r.json();
}
const FIELDS = "mlsNumber,soldPrice,soldDate,listPrice,originalPrice,listDate,lastStatus,status,address,map,details.numBedrooms,details.numBathrooms,details.sqft,details.yearBuilt,details.propertyType,details.style,details.description,images,daysOnMarket,taxes,class,type";
async function repliers(params: Record<string, string | string[]>) {
  const q = new URLSearchParams({ boardId: "147", fields: FIELDS });
  for (const [k, v] of Object.entries(params)) (Array.isArray(v) ? v : [v]).forEach((x) => q.append(k, x));
  if (!q.has("class")) q.append("class", "residential");
  const r = await fetch("https://api.repliers.io/listings?" + q.toString(), { headers: { "REPLIERS-API-KEY": RK, Accept: "application/json" } });
  if (!r.ok) return { error: "repliers " + r.status + " " + (await r.text()).slice(0, 200), listings: [] };
  return await r.json();
}
function toComp(l: Row, here: [number, number]) {
  const a = l.address || {}, d = l.details || {}, m = l.map || {};
  const sqft = num(d.sqft), price = num(l.soldPrice) || num(l.listPrice), lat = Number(m.latitude), lng = Number(m.longitude);
  return { source: "HAR", mls: String(l.mlsNumber || ""), address: [a.streetNumber, a.streetName, a.streetSuffix].filter(Boolean).join(" ") + (a.city ? ", " + a.city : ""),
    zip: a.zip || null, sold_price: num(l.soldPrice), sold_date: l.soldDate ? String(l.soldDate).slice(0, 10) : null, list_price: num(l.listPrice), original_price: num(l.originalPrice),
    list_date: l.listDate ? String(l.listDate).slice(0, 10) : null, last_status: l.lastStatus || null,
    sqft, beds: d.numBedrooms ?? null, baths: d.numBathrooms ?? null, year: num(d.yearBuilt), dom: l.daysOnMarket ?? null, photo: (l.images || [])[0] || null,
    lat: isFinite(lat) && lat ? lat : null, lng: isFinite(lng) && lng ? lng : null, miles: isFinite(lat) && isFinite(lng) && lat ? Math.round(miles(here, [lat, lng]) * 100) / 100 : null,
    type: [d.propertyType, d.style].filter(Boolean).join(" · ") || null, cond: condition(d.description),
    tax: l.taxes && l.taxes.annualAmount ? num(l.taxes.annualAmount) : null,
    ppsf: price && sqft ? Math.round(price / sqft) : null } as Row;
}

// ---------- comps + after-repair value (shared by the address lookup and the deal finder) ----------
type Subject = { lat: number; lng: number; sqft: number | null; year: number | null; beds: number | null; type: string | null };
const TIERS = [{ km: 1.6, mo: 6, yr: 15, sz: 0.25 }, { km: 1.6, mo: 12, yr: 15, sz: 0.25 }, { km: 3.2, mo: 12, yr: 15, sz: 0.25 }, { km: 3.2, mo: 12, yr: 25, sz: 0.35 }];
function fitsFor(s: Subject) {
  const subjTH: boolean | null = s.type ? isTH(String(s.type)) : null;
  return (c: Row, T: Row) =>
    !!c.ppsf && c.ppsf > 20 && c.ppsf < 1500 && !(c.miles != null && c.miles < 0.01) // not the house itself
    && (subjTH == null || !c.type || isTH(String(c.type)) === subjTH)
    && (!s.year || !c.year || Math.abs(c.year - Number(s.year)) <= T.yr)
    && (!s.sqft || !c.sqft || Math.abs(c.sqft - s.sqft) / s.sqft <= T.sz)
    && (!s.beds || c.beds == null || Math.abs(Number(c.beds) - Number(s.beds)) <= 1);
}
// weighted percentile: each sale sits at the middle of its weight; read p off that line
function wpct(L: Row[], p: number) {
  const s = L.slice().sort((x, y) => x.adj - y.adj);
  if (!s.length) return null;
  const tot = s.reduce((t, c) => t + c.w, 0); let acc = 0;
  const at = s.map((c) => { const m = (acc + c.w / 2) / tot; acc += c.w; return m; });
  if (p <= at[0]) return s[0].adj;
  for (let i = 1; i < s.length; i++) if (p <= at[i]) return s[i - 1].adj + (s[i].adj - s[i - 1].adj) * (p - at[i - 1]) / (at[i] - at[i - 1]);
  return s[s.length - 1].adj;
}
async function compsAndArv(s: Subject, fallback: Row[] | null) {
  const here: [number, number] = [s.lat, s.lng], sz = s.sqft, fits = fitsFor(s);
  const pools: Record<string, Row[]> = {}; let repErr = "";
  const pool = async (km: number, months: number) => {
    const k = km + "/" + months;
    if (!pools[k]) {
      const r: Row = await repliers({ status: "U", lastStatus: "Sld", lat: String(s.lat), long: String(s.lng), radius: String(km),
        minSoldDate: DATE(new Date(Date.now() - months * 30.5 * 864e5)), sortBy: "soldDateDesc", resultsPerPage: "80" });
      if (r.error) repErr = r.error; pools[k] = r.listings || [];
    }
    return pools[k];
  };
  let comps: Row[] = [], tier = 0;
  for (let i = 0; i < TIERS.length; i++) {
    comps = (await pool(TIERS[i].km, TIERS[i].mo)).map((l) => toComp(l, here)).filter((c) => !!c.sold_price && fits(c, TIERS[i]));
    tier = i;
    if (comps.filter((c) => c.cond !== "fixer").length >= 6) break;
  }
  let source = "HAR";
  if (comps.length < 3 && fallback && fallback.length) { source = "RentCast"; comps = fallback; }
  // each sale adjusted to THIS house: bigger/smaller is worth more/less, at about a third of its $/sq ft (appraiser style);
  // weight: closer, more recent, same era and size count more
  const now = Date.now();
  for (const c of comps) {
    let adj = c.sold_price;
    if (sz && c.sqft) { const d = (sz - c.sqft) * 0.35 * (c.sold_price / c.sqft); adj = c.sold_price + Math.max(-0.15 * c.sold_price, Math.min(0.15 * c.sold_price, d)); }
    c.adj = Math.round(adj / 500) * 500;
    const mo = c.sold_date ? (now - Date.parse(c.sold_date)) / (30.5 * 864e5) : 9;
    const w = (1 / (0.35 + (c.miles ?? 1.5))) * Math.max(0.35, 1 - mo / 18)
      * (s.year && c.year ? Math.max(0.4, 1 - Math.abs(c.year - Number(s.year)) / 40) : 0.8)
      * (sz && c.sqft ? Math.max(0.4, 1 - Math.abs(c.sqft - sz) / sz) : 0.8);
    c.w = Math.round(w * 1000) / 1000;
  }
  // sales far from the pack (a golf-course home, a teardown) are left out but still listed
  const base = comps.filter((c) => c.cond !== "fixer").map((c) => c.adj).sort((x, y) => x - y);
  const med0 = pct(base, 0.5);
  for (const c of comps) c.out = med0 ? (c.adj < med0 * 0.75 || c.adj > med0 * 1.3) : false;
  comps.sort((x, y) => (x.out ? 1 : 0) - (y.out ? 1 : 0) || (x.miles ?? 9) - (y.miles ?? 9));
  comps = comps.slice(0, 25);
  // worst = the low quarter, mid = the weighted middle, best = the high quarter; remodeled sales can lift mid/best,
  // never above the top of the neighborhood (90th percentile)
  const A = comps.filter((c) => !c.out && c.cond !== "fixer"), R = A.filter((c) => c.cond === "remodeled");
  let arv: Row | null = null;
  if (A.length) {
    let w = wpct(A, 0.25)!, m = wpct(A, 0.5)!, bst = wpct(A, 0.75)!;
    const top = wpct(A, 0.9)!;
    if (R.length >= 3) { m = Math.min(Math.max(m, wpct(R, 0.5)!), wpct(A, 0.75)!); bst = Math.min(Math.max(bst, wpct(R, 0.75)!), top); }
    if (A.length < 3) { w = Math.min(w, m * 0.95); bst = Math.max(bst, m * 1.05); }
    w = round(Math.min(w, m)); m = round(m); bst = round(Math.max(bst, m));
    arv = { worst: w, mid: m, best: bst, ppsf: sz ? { worst: Math.round(w / sz), mid: Math.round(m / sz), best: Math.round(bst / sz) } : null, basis: R.length >= 3 ? "remodeled" : "all", method: "adjusted" };
  }
  const fx = comps.filter((c) => c.cond === "fixer" && !c.out);
  const fixerValue = fx.length >= 2 ? { value: round(wpct(fx, 0.5)!), ppsf: sz ? Math.round(wpct(fx, 0.5)! / sz) : null, count: fx.length } : null;
  const spread = arv && A.length >= 3 ? (wpct(A, 0.75)! - wpct(A, 0.25)!) / arv.mid : 1;
  const confidence = A.length >= 6 && spread < 0.2 && tier <= 1 ? "high" : A.length >= 4 && spread < 0.35 ? "medium" : "low";
  const T = TIERS[tier];
  return { comps, arv, confidence, source, widened: tier > 0, search: { miles: T.km / 1.6, months: T.mo, years: T.yr, size_pct: Math.round(T.sz * 100) },
    comps_count: A.length, out_count: comps.filter((c) => c.out).length, remodeled_count: R.length, fixer_count: fx.length, fixer_value: fixerValue, repErr };
}

// the portal's default flip math (same numbers the calculator starts with), used by the deal finder
function quickDeal(price: number, arv: Row, sqft: number | null, fixer: boolean, taxYr: number | null, target = 30000) {
  const rate = fixer ? 55 : 35, rehab = Math.round(rate * (sqft || 1500) / 500) * 500, rehabT = rehab * 1.1;
  const costs = (P: number) => { const loan = P * 0.85 + rehabT; return { loan, allin: P * 1.02 + rehabT + loan * 0.07 + 1500 + 5 * ((taxYr || P * 0.023) / 12 + 425) }; };
  const { loan, allin } = costs(price);
  const at = (v: number) => Math.round(v - v * 0.075 - allin);
  // the most he could pay and still make his target in the mid case (profit is a straight line in the price)
  const p0 = arv.mid * 0.925 - costs(0).allin, p1 = arv.mid * 0.925 - costs(100000).allin, slope = (p1 - p0) / 100000;
  const maxOffer = slope < 0 ? Math.max(0, Math.floor((target - p0) / slope / 1000) * 1000) : null;
  return { rehab, rehab_level: fixer ? "heavy" : "medium", all_in: Math.round(allin), cash: Math.round(allin - loan),
    profit: { worst: at(arv.worst), mid: at(arv.mid), best: at(arv.best) }, margin_mid: Math.round(at(arv.mid) / arv.mid * 1000) / 10,
    mao70: Math.max(0, round(arv.mid * 0.7 - rehabT)), target, max_offer: maxOffer,
    below_list_pct: maxOffer != null ? Math.round((1 - maxOffer / price) * 1000) / 10 : null };
}

// FEMA National Flood Hazard Layer: the flood zone at this point
async function flood(lat: number, lng: number) {
  try {
    const u = "https://hazards.fema.gov/arcgis/rest/services/public/NFHL/MapServer/28/query?geometry=" + lng + "," + lat +
      "&geometryType=esriGeometryPoint&inSR=4326&spatialRel=esriSpatialRelIntersects&outFields=FLD_ZONE,ZONE_SUBTY,SFHA_TF,STATIC_BFE&returnGeometry=false&f=json";
    // FEMA's server sometimes resets the first connection: try up to 3 times
    let r: Response | null = null;
    for (let i = 0; i < 3 && !r; i++) {
      try {
        const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 15000);
        r = await fetch(u, { signal: ctl.signal, headers: { "User-Agent": "Mozilla/5.0 (JAG Investor Portal)", Accept: "application/json" } }); clearTimeout(t);
      } catch (_e) { r = null; await new Promise((ok) => setTimeout(ok, 400)); }
    }
    if (!r) return { error: "fema unreachable" };
    if (!r.ok) return { error: "fema " + r.status };
    const j = await r.json(); const f = (j.features || [])[0];
    if (!f) return { zone: null, risk: "unmapped" };
    const a = f.attributes || {}, zone = String(a.FLD_ZONE || "").trim(), sub = a.ZONE_SUBTY ? String(a.ZONE_SUBTY) : null;
    const high = a.SFHA_TF === "T" || /^(A|V)/.test(zone);
    const moderate = !high && /0\.2 PCT|500/i.test(sub || "");
    return { zone, subtype: sub, sfha: high, risk: high ? "high" : moderate ? "moderate" : zone === "D" ? "undetermined" : "minimal", bfe: a.STATIC_BFE > -9000 ? a.STATIC_BFE : null };
  } catch (_e) { return { error: "fema error" }; }
}

// the active listings he'd be competing with when he sells (same type, era and size, within a mile)
async function competition(s: Subject) {
  const here: [number, number] = [s.lat, s.lng], fits = fitsFor(s);
  const r: Row = await repliers({ status: "A", type: "sale", lat: String(s.lat), long: String(s.lng), radius: "1.6", resultsPerPage: "60" });
  const list = (r.listings || []).map((l: Row) => toComp(l, here)).filter((c: Row) => c.list_price && fits(c, TIERS[0]))
    .sort((x: Row, y: Row) => (x.miles ?? 9) - (y.miles ?? 9)).slice(0, 15)
    .map((c: Row) => ({ mls: c.mls, address: c.address, list_price: c.list_price, original_price: c.original_price, dom: c.dom, sqft: c.sqft, beds: c.beds, baths: c.baths, year: c.year,
      ppsf: c.ppsf, miles: c.miles, photo: c.photo, lat: c.lat, lng: c.lng, cond: c.cond, last_status: c.last_status, cut: c.original_price && c.list_price && c.original_price > c.list_price ? Math.round(c.original_price - c.list_price) : 0 }));
  const doms = list.map((c: Row) => c.dom).filter((x: unknown) => typeof x === "number").sort((a: number, b: number) => a - b);
  const pp = list.map((c: Row) => c.ppsf).filter(Boolean).sort((a: number, b: number) => a - b);
  return { count: list.length, median_dom: doms.length ? Math.round(pct(doms, 0.5)!) : null, median_ppsf: pp.length ? Math.round(pct(pp, 0.5)!) : null,
    price_cuts: list.filter((c: Row) => c.cut > 0).length, listings: list, error: r.error || null };
}

Deno.serve(async (req) => {
  const H = { "Content-Type": "application/json", ...cors(req) };
  const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: H });
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(req) });
  if (req.method !== "POST") return json({ ok: false, error: "POST only" }, 405);
  const db = createClient(SB_URL, SRK);
  let b: any = {}; try { b = await req.json(); } catch { /* empty */ }

  // who is asking: an invited, active investor (or the server token: tests and the daily scan)
  let uid: string | null = null, inv: Row | null = null, server = false;
  const tok = req.headers.get("x-jag-token") || "";
  if (tok) { const { data } = await db.rpc("jag_alerts_token_ok", { p_token: tok }); if (data !== true) return json({ ok: false, error: "forbidden" }, 403); server = true; }
  else {
    const jwt = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
    const { data: u } = await db.auth.getUser(jwt);
    if (!u || !u.user) return json({ ok: false, reason: "sign_in" }, 401);
    uid = u.user.id;
    const email = String(u.user.email || "").toLowerCase();
    const { data: rows } = await db.from("jag_investors").select("*").eq("active", true).or(`user_id.eq.${uid},email.eq.${email.replace(/[,()]/g, "")}`);
    inv = (rows || [])[0] || null;
    if (!inv) return json({ ok: false, reason: "not_invited" }, 403);
    const { count } = await db.from("jag_investor_runs").select("id", { count: "exact", head: true }).eq("user_id", uid).gte("created_at", new Date(Date.now() - 864e5).toISOString());
    if (b.action === "analyze" && (count || 0) >= (inv.runs_per_day || 40)) return json({ ok: false, reason: "limit" }, 429);
  }

  if (b.action === "lola") return await lola(db, uid, b, json);
  if (b.action === "scan") { if (!server) return json({ ok: false, error: "server only" }, 403); return json(await scan(db, b.watch_id ? Number(b.watch_id) : null, !!b.dry)); }
  if (b.action === "scan_mine") { if (!uid) return json({ ok: false }, 403); return json(await scan(db, Number(b.watch_id) || -1, false, uid)); }
  if (b.action !== "analyze") return json({ ok: false, error: "unknown action" }, 400);
  const address = String(b.address || "").trim().slice(0, 200);
  if (address.length < 6) return json({ ok: false, reason: "address" }, 400);
  const { data: key } = await db.rpc("jag_rentcast_key");
  if (!key) return json({ ok: false, error: "RentCast key missing" }, 500);

  // 1. the property (RentCast record) + as-is value + rent — reused for 7 days per address (saves RentCast calls)
  const norm = (a: string) => a.toLowerCase().replace(/[.,#]/g, " ").replace(/\s+/g, " ").trim();
  let p: Row = {}, avm: Row = {}, rentRaw: Row = {}, cached = false;
  const { data: prev } = await db.from("jag_investor_runs").select("result").gte("created_at", new Date(Date.now() - 7 * 864e5).toISOString())
    .ilike("input->>address", address.replace(/[%_]/g, "")).order("created_at", { ascending: false }).limit(5);
  const hit = (prev || []).find((r: Row) => r.result && r.result.rc && norm(String(r.result.rc.q || "")) === norm(address));
  if (hit) { p = hit.result.rc.p || {}; avm = hit.result.rc.avm || {}; rentRaw = hit.result.rc.rent || {}; cached = true; }
  else {
    const propRes = await rentcast("properties?address=" + encodeURIComponent(address), key as string);
    p = Array.isArray(propRes) ? (propRes[0] || {}) : {};
  }
  const subject = {
    address: p.formattedAddress || address, lat: p.latitude ?? null, lng: p.longitude ?? null,
    beds: num(b.beds) ?? p.bedrooms ?? null, baths: num(b.baths) ?? p.bathrooms ?? null, sqft: num(b.sqft) ?? p.squareFootage ?? null,
    year: p.yearBuilt ?? null, lot: p.lotSize ?? null, type: p.propertyType || null, county: p.county || null, subdivision: p.subdivision || null,
    last_sale: p.lastSaleDate ? { date: String(p.lastSaleDate).slice(0, 10), price: p.lastSalePrice ?? null } : null,
    tax: (() => { const t = p.propertyTaxes || {}; const y = Object.keys(t).sort().pop(); return y ? { year: Number(y), total: t[y].total ?? null } : null; })(),
    assessed: (() => { const t = p.taxAssessments || {}; const y = Object.keys(t).sort().pop(); return y ? { year: Number(y), value: t[y].value ?? null } : null; })(),
    hoa: p.hoa && p.hoa.fee ? p.hoa.fee : null, owner_occupied: p.ownerOccupied ?? null,
    found: !!p.formattedAddress,
  };
  const sameSize = !b.sqft && !b.beds && !b.baths;
  const q = new URLSearchParams({ address: subject.address });
  if (subject.sqft) q.set("squareFootage", String(subject.sqft));
  if (subject.beds) q.set("bedrooms", String(subject.beds));
  if (subject.baths) q.set("bathrooms", String(subject.baths));
  if (subject.type) q.set("propertyType", subject.type);
  const [avmNew, rentNew] = await Promise.all([
    !cached || !sameSize || !avm.price ? rentcast("avm/value?" + q.toString() + "&compCount=15", key as string) : Promise.resolve(null),
    !cached || !sameSize || !rentRaw.rent ? rentcast("avm/rent/long-term?" + q.toString() + "&compCount=10", key as string) : Promise.resolve(null),
  ]);
  if (avmNew) avm = avmNew;
  if (rentNew) rentRaw = rentNew;
  if (subject.lat == null && avm && avm.latitude) { subject.lat = avm.latitude; subject.lng = avm.longitude; }
  if (subject.lat == null) return json({ ok: false, reason: "not_found", subject });

  // RentCast comparables are the fallback when HAR has no similar sales nearby
  const fallback = Array.isArray(avm.comparables) ? avm.comparables.map((c: Row) => ({ source: "RentCast", mls: c.mlsNumber || "", address: c.formattedAddress, sold_price: num(c.price),
    sold_date: c.removedDate ? String(c.removedDate).slice(0, 10) : null, list_price: num(c.price), sqft: num(c.squareFootage), beds: c.bedrooms ?? null, baths: c.bathrooms ?? null,
    year: num(c.yearBuilt), dom: c.daysOnMarket ?? null, photo: null, lat: c.latitude ?? null, lng: c.longitude ?? null, miles: c.distance != null ? Math.round(c.distance * 100) / 100 : null,
    cond: "", type: c.propertyType || null, ppsf: num(c.price) && num(c.squareFootage) ? Math.round(num(c.price)! / num(c.squareFootage)!) : null, status: c.status || null })).filter((c: Row) => c.ppsf && c.sold_price) : null;
  const S: Subject = { lat: subject.lat, lng: subject.lng!, sqft: subject.sqft, year: subject.year, beds: subject.beds, type: subject.type };
  const [ca, fl, comp] = await Promise.all([compsAndArv(S, fallback), flood(subject.lat, subject.lng!), competition(S)]);

  const r5 = (n: number) => Math.round(n / 5) * 5;
  const rent = rentRaw && rentRaw.rent ? { rent: r5(rentRaw.rent), low: rentRaw.rentRangeLow ? r5(rentRaw.rentRangeLow) : null, high: rentRaw.rentRangeHigh ? r5(rentRaw.rentRangeHigh) : null,
    comps: (rentRaw.comparables || []).slice(0, 8).map((c: Row) => ({ address: c.formattedAddress, rent: c.price, beds: c.bedrooms, baths: c.bathrooms, sqft: c.squareFootage,
      miles: c.distance != null ? Math.round(c.distance * 100) / 100 : null, days_old: c.daysOld ?? null })) } : null;
  const result = {
    subject, arv: ca.arv, confidence: ca.confidence, comps_source: ca.source, widened: ca.widened, search: ca.search, comps_count: ca.comps_count, out_count: ca.out_count,
    remodeled_count: ca.remodeled_count, fixer_count: ca.fixer_count, fixer_value: ca.fixer_value,
    as_is: avm && avm.price ? { value: round(avm.price), low: avm.priceRangeLow ? round(avm.priceRangeLow) : null, high: avm.priceRangeHigh ? round(avm.priceRangeHigh) : null } : null,
    rent, flood: fl, competition: comp,
    comps: ca.comps, notes: ca.repErr ? [ca.repErr] : [], cached,
  };
  const keepAvm = { price: avm.price, priceRangeLow: avm.priceRangeLow, priceRangeHigh: avm.priceRangeHigh, latitude: avm.latitude, longitude: avm.longitude, comparables: (avm.comparables || []).slice(0, 15) };
  const keepRent = rentRaw && rentRaw.rent ? { rent: rentRaw.rent, rentRangeLow: rentRaw.rentRangeLow, rentRangeHigh: rentRaw.rentRangeHigh, comparables: (rentRaw.comparables || []).slice(0, 10) } : {};
  let id = null;
  if (uid) {
    const { data: ins } = await db.from("jag_investor_runs").insert({ user_id: uid, address: subject.address, input: { address, sqft: b.sqft || null, beds: b.beds || null, baths: b.baths || null },
      result: { ...result, rc: { q: address, p, avm: keepAvm, rent: keepRent } } }).select("id").single();
    id = ins ? ins.id : null;
  }
  return json({ ok: true, id, ...result });
});

// ---------- Lola's review: the saved run (trusted numbers) + the investor's calculator → n8n → Claude ----------
// deno-lint-ignore no-explicit-any
async function lola(db: any, uid: string | null, b: Row, json: (b: unknown, s?: number) => Response) {
  if (!uid) return json({ ok: false, error: "investors only" }, 403);
  const id = Number(b.id);
  const { data: run } = await db.from("jag_investor_runs").select("*").eq("id", id).eq("user_id", uid).maybeSingle();
  if (!run) return json({ ok: false, reason: "not_found" }, 404);
  const { count } = await db.from("jag_investor_runs").select("id", { count: "exact", head: true }).eq("user_id", uid).gte("lola_at", new Date(Date.now() - 864e5).toISOString());
  if ((count || 0) >= 25) return json({ ok: false, reason: "lola_limit" }, 429);
  const r: Row = run.result || {};
  // the calculator numbers come from the page; keep only plain numbers and short labels
  const clean = (v: unknown, d = 0): unknown => {
    if (d > 3) return null;
    if (typeof v === "number") return isFinite(v) ? Math.round(v * 100) / 100 : null;
    if (typeof v === "string") return v.slice(0, 60);
    if (typeof v === "boolean") return v;
    if (Array.isArray(v)) return v.slice(0, 10).map((x) => clean(x, d + 1));
    if (v && typeof v === "object") { const o: Row = {}; for (const [k, x] of Object.entries(v).slice(0, 40)) o[k.slice(0, 30)] = clean(x, d + 1); return o; }
    return null;
  };
  const calc = clean(b.deal || {}) as Row;
  const removed = new Set(Array.isArray(calc && calc.excluded) ? (calc.excluded as string[]) : []);
  const comps = ((r.comps || []) as Row[]).filter((c) => removed.size ? !removed.has(c.mls || c.address) : !c.out);
  const doms = comps.map((c) => c.dom).filter((x) => typeof x === "number").sort((a: number, b: number) => a - b);
  const cp: Row = r.competition || {};
  const payload = {
    property: r.subject, as_is_estimate: r.as_is, arv_from_server: r.arv,
    arv_used_by_investor: { worst: calc.worst && (calc.worst as Row).arv, mid: calc.mid && (calc.mid as Row).arv, best: calc.best && (calc.best as Row).arv },
    arv_confidence: r.confidence, comps_source: r.comps_source, comp_search: r.search || null, as_is_from_fixer_sales: r.fixer_value || null,
    fema_flood_zone: r.flood || null, market_rent: r.rent ? { rent: r.rent.rent, low: r.rent.low, high: r.rent.high } : null,
    competing_active_listings: cp.count != null ? { count: cp.count, median_days_on_market: cp.median_dom, median_list_ppsf: cp.median_ppsf, with_price_cuts: cp.price_cuts } : null,
    comps: { count: comps.length, remodeled: comps.filter((c) => c.cond === "remodeled").length, sold_needing_work: comps.filter((c) => c.cond === "fixer").length, widened_to_2mi_12mo: !!r.widened,
      median_days_on_market: doms.length ? doms[Math.floor(doms.length / 2)] : null,
      closest: comps.slice(0, 8).map((c) => ({ miles: c.miles, sold: c.sold_price, adjusted_to_subject: c.adj ?? null, date: c.sold_date, sqft: c.sqft, ppsf: c.ppsf, beds: c.beds, baths: c.baths, year: c.year, condition: c.cond || "average", dom: c.dom })) },
    calculator: calc,
  };
  const { data: secret } = await db.rpc("jag_ops_secret");
  if (!secret) return json({ ok: false, error: "not_configured" }, 500);
  try {
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 55000);
    const res = await fetch("https://toomuchtaco.app.n8n.cloud/webhook/jag-invest-lola", { method: "POST", signal: ctl.signal,
      headers: { "Content-Type": "application/json", "X-JAG-Ops-Secret": String(secret) },
      body: JSON.stringify({ lang: b.lang === "en" ? "en" : "es", deal: payload }) });
    clearTimeout(t);
    const j = await res.json().catch(() => null);
    if (!res.ok || !j || !j.answer) return json({ ok: false, reason: "lola_unavailable" }, 502);
    const answer = String(j.answer).slice(0, 2500), at = new Date().toISOString();
    await db.from("jag_investor_runs").update({ lola: answer, lola_at: at, deal: calc }).eq("id", id);
    return json({ ok: true, lola: answer, lola_at: at });
  } catch (_e) {
    return json({ ok: false, reason: "lola_timeout" }, 504);
  }
}

// ---------- deal finder: active HAR listings in his areas → likely flips → comps/ARV → digest email ----------
// deno-lint-ignore no-explicit-any
async function scan(db: any, onlyWatch: number | null, dry: boolean, owner: string | null = null) {
  let qw = db.from("jag_investor_watches").select("*").eq("active", true).is("removed_at", null);
  if (onlyWatch) qw = qw.eq("id", onlyWatch);
  if (owner) qw = qw.eq("user_id", owner);
  const { data: watches } = await qw;
  const report: Row[] = [];
  const started = Date.now();
  for (const w of (watches || []) as Row[]) {
    if (Date.now() - started > 100000) { report.push({ watch: w.id, skipped: "time" }); continue; }
    if (owner && w.last_run_at && Date.now() - Date.parse(w.last_run_at) < 10 * 60000) { report.push({ watch: w.id, skipped: "recent" }); continue; }
    const { data: invr } = await db.from("jag_investors").select("email,name,active").eq("user_id", w.user_id).eq("active", true).maybeSingle();
    if (!invr) { report.push({ watch: w.id, skipped: "investor off" }); continue; }
    const zips = (w.areas || []).filter((a: string) => /^\d{5}$/.test(a)), cities = (w.areas || []).filter((a: string) => !/^\d{5}$/.test(a));
    const params: Record<string, string> = { status: "A", type: "sale", resultsPerPage: "100" };
    if (w.min_price) params.minPrice = String(w.min_price);
    if (w.max_price) params.maxPrice = String(w.max_price);
    if (w.min_beds) params.minBeds = String(w.min_beds);
    const listings: Row[] = [];
    // ZIPs and cities are separate searches (Repliers ANDs different fields)
    for (const part of [zips.length ? { zip: zips } : null, cities.length ? { city: cities } : null].filter(Boolean) as Record<string, string[]>[]) {
      const r: Row = await repliers({ ...params, ...part });
      (r.listings || []).forEach((l: Row) => listings.push(l));
    }
    const { data: seen } = await db.from("jag_investor_finds").select("mls").eq("watch_id", w.id);
    const seenSet = new Set((seen || []).map((x: Row) => x.mls));
    const cand = listings.map((l) => toComp(l, [Number(l.map?.latitude) || 0, Number(l.map?.longitude) || 0]))
      .filter((c) => c.mls && !seenSet.has(c.mls) && c.list_price && c.sqft && c.lat != null && !isTH(String(c.type || ""))
        && (!w.min_sqft || c.sqft >= w.min_sqft) && (!w.max_sqft || c.sqft <= w.max_sqft));
    // likely flips first: fixer wording, then price cuts / long days on market, then the lowest $/sq ft in the batch
    const pp = cand.map((c) => c.ppsf).filter(Boolean).sort((a, b) => a - b), low = pct(pp, 0.3) || 0;
    const score = (c: Row) => (c.cond === "fixer" ? 100 : 0) + (c.original_price && c.original_price > c.list_price ? 25 : 0) + ((c.dom || 0) >= 45 ? 20 : 0) + (c.ppsf && c.ppsf <= low ? 30 : 0) - (c.cond === "remodeled" ? 60 : 0);
    const picks = cand.map((c) => ({ c, s: score(c) })).filter((x) => x.s >= 20).sort((a, b) => b.s - a.s).slice(0, 12);
    const found: Row[] = [], looked: Row[] = [];
    for (const { c } of picks) {
      if (Date.now() - started > 120000) break;
      const ca = await compsAndArv({ lat: c.lat, lng: c.lng, sqft: c.sqft, year: c.year, beds: c.beds, type: c.type }, null);
      if (!ca.arv || ca.comps_count < 3) continue;
      const est = quickDeal(c.list_price, ca.arv, c.sqft, c.cond === "fixer", c.tax, w.min_profit || 30000);
      looked.push({ address: c.address, list: c.list_price, arv_mid: ca.arv.mid, profit_at_list: est.profit.mid, max_offer: est.max_offer, below_list_pct: est.below_list_pct, comps: ca.comps_count, cond: c.cond, dom: c.dom });
      // a find: it already works at list price, or an offer no more than 12% under list gets him to his target
      // (more room when the listing is stale or already cut: sellers there take lower offers)
      const room = (c.dom || 0) >= 60 || (c.original_price && c.original_price > c.list_price) || c.cond === "fixer" ? 15 : 12;
      if (est.profit.mid < (w.min_profit || 30000) && !(est.below_list_pct != null && est.below_list_pct <= room)) continue;
      const why: string[] = [];
      if (c.cond === "fixer") why.push("fixer");
      if (c.original_price && c.original_price > c.list_price) why.push("price_cut:" + Math.round(c.original_price - c.list_price));
      if ((c.dom || 0) >= 45) why.push("dom:" + c.dom);
      if (c.ppsf && c.ppsf <= low) why.push("low_ppsf");
      found.push({ watch_id: w.id, user_id: w.user_id, mls: c.mls, address: c.address + (c.zip ? " " + c.zip : ""), list_price: c.list_price, photo: c.photo,
        arv: { ...ca.arv, confidence: ca.confidence, comps: ca.comps_count }, est, why,
        listing: { beds: c.beds, baths: c.baths, sqft: c.sqft, year: c.year, dom: c.dom, original_price: c.original_price, lat: c.lat, lng: c.lng } });
    }
    found.sort((a, b) => (a.est.below_list_pct ?? 99) - (b.est.below_list_pct ?? 99));
    let emailed = false;
    if (!dry) {
      if (found.length) await db.from("jag_investor_finds").upsert(found, { onConflict: "watch_id,mls", ignoreDuplicates: true });
      await db.from("jag_investor_watches").update({ last_run_at: new Date().toISOString(), ...(found.length ? { last_sent_at: new Date().toISOString() } : {}) }).eq("id", w.id);
      if (found.length && RESEND) emailed = await sendFinds(db, w, invr, found);
    }
    report.push({ watch: w.id, listings: listings.length, candidates: picks.length, found: found.length, emailed, sample: dry ? found.slice(0, 5) : undefined, looked: dry ? looked : undefined });
  }
  return { ok: true, watches: report };
}

// deno-lint-ignore no-explicit-any
async function sendFinds(db: any, w: Row, invr: Row, found: Row[]) {
  const { data: cl } = await db.from("jag_clients").select("lang").eq("user_id", w.user_id).maybeSingle();
  const es = !cl || cl.lang !== "en";
  const T = (s: string, e: string) => es ? s : e;
  const first = String(invr.name || "").trim().split(/\s+/)[0];
  const n = found.length, top = found.slice(0, 8), where = w.label || (w.areas || []).join(", ");
  const subject = T(`${n} posible${n > 1 ? "s" : ""} flip${n > 1 ? "s" : ""} en ${where}`, `${n} possible flip${n > 1 ? "s" : ""} in ${where}`);
  const whyTxt = (x: string) => x === "fixer" ? T("Se vende para arreglar", "Sold needing work") : x === "low_ppsf" ? T("$/pie² bajo para la zona", "Low $/sq ft for the area")
    : x.startsWith("price_cut:") ? T("Bajó ", "Price cut ") + money(Number(x.split(":")[1])) : x.startsWith("dom:") ? x.split(":")[1] + T(" días en el mercado", " days on market") : x;
  const cards = top.map((f) => {
    const link = SITE + "/invest?a=" + encodeURIComponent(f.address);
    const L = f.listing || {};
    return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid ${C.line};border-radius:14px;overflow:hidden;margin:0 0 16px">
${f.photo ? `<tr><td style="padding:0"><a href="${esc(link)}"><img src="${CDN}${esc(f.photo)}?class=large" width="536" alt="" style="display:block;width:100%;max-width:536px;height:auto;border:0"></a></td></tr>` : ""}
<tr><td style="padding:14px 18px 16px;color:${C.ink}">
<div style="font-size:12px;font-weight:700;color:${C.red}">${esc((f.why || []).map(whyTxt).join(" · "))}</div>
<div style="font-size:16px;font-weight:700;margin:4px 0 2px">${esc(f.address)}</div>
<div style="font-size:13.5px;color:${C.muted}">${esc([L.beds != null ? L.beds + T(" rec", " bd") : "", L.baths != null ? L.baths + T(" baños", " ba") : "", L.sqft ? Number(L.sqft).toLocaleString("en-US") + T(" pies²", " sqft") : "", L.year || ""].filter(Boolean).join(" · "))}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:10px;font-size:14px"><tr>
<td style="padding:6px 0"><span style="color:${C.muted}">${T("Precio", "List")}</span><br><b>${money(f.list_price)}</b></td>
<td style="padding:6px 0"><span style="color:${C.muted}">${T("Valor remodelada", "After repair")}</span><br><b>${money(f.arv.mid)}</b></td>
<td style="padding:6px 0"><span style="color:${C.muted}">${T("Oferta máx.", "Max offer")}</span><br><b style="color:${C.ok}">${money(f.est.max_offer)}</b></td></tr></table>
<div style="font-size:13px;color:${C.muted};margin-top:4px">${esc(f.est.profit.mid >= f.est.target
  ? T(`Al precio de lista deja unos ${money(f.est.profit.mid)} en el caso medio.`, `At list price it leaves about ${money(f.est.profit.mid)} in the mid case.`)
  : T(`Para ganar ${money(f.est.target)} ofrezca hasta ${money(f.est.max_offer)} (${f.est.below_list_pct}% abajo del precio de lista).`, `To make ${money(f.est.target)}, offer up to ${money(f.est.max_offer)} (${f.est.below_list_pct}% under list).`))}</div>
<div style="margin-top:12px">${button(link, T("Analizar en el portal", "Analyze in the portal"), { full: true, kind: "outline" })}</div>
</td></tr></table>`;
  }).join("");
  const html = shell({ es, title: subject, preheader: T("Del buscador de tratos de su Portal de Inversionista.", "From your Investor Portal deal finder."),
    body: row(eyebrow(T("Buscador de tratos", "Deal finder")) + h1(subject) +
      lead(T(`${first ? first + ", e" : "E"}stas casas a la venta en HAR podrían dejarle ${money(w.min_profit)} o más con números típicos de flip (remodelación, préstamo, 5 meses, venta), al precio de lista o con una oferta razonable. Ábralas en el portal para ajustar los números.`,
             `${first ? first + ", t" : "T"}hese HAR listings could leave you ${money(w.min_profit)} or more with typical flip numbers (rehab, loan, 5 months, sale), at list price or with a reasonable offer. Open them in the portal to adjust the numbers.`)) +
      cards + (n > top.length ? `<p style="text-align:center;color:${C.muted};font-size:14px">${T(`Y ${n - top.length} más en su portal.`, `And ${n - top.length} more in your portal.`)}</p>` : "") +
      callout(`<span style="font-size:13px;color:${C.muted}">${esc(T("Estimados con casas vendidas cerca; no son un avalúo. Verifique condición, zona de inundación y título antes de ofertar.", "Estimates from nearby sales, not an appraisal. Verify condition, flood zone and title before you offer."))}</span>`), "0 32px")
      + row(button(SITE + "/invest#finder", T("Ver todos en mi portal", "See all in my portal"), { full: true }), "8px 32px 0"),
    footerNote: T("Recibe este correo porque activó el buscador de tratos en su Portal de Inversionista JAG.", "You get this email because you turned on the deal finder in your JAG Investor Portal."),
    links: [[T("Cambiar alertas", "Change alerts"), SITE + "/invest#finder"]] });
  const r = await fetch("https://api.resend.com/emails", { method: "POST", headers: { Authorization: `Bearer ${RESEND}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: FROM, to: [invr.email], subject, html }) });
  if (r.ok) await db.from("jag_investor_finds").update({ emailed_at: new Date().toISOString() }).eq("watch_id", w.id).in("mls", found.map((f) => f.mls));
  return r.ok;
}
