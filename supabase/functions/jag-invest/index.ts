// jag-invest — the investor portal's data engine (jasonaguirregroup.company/invest, invite only).
// POST { action: 'analyze', address, sqft?, beds?, baths? } with the investor's sign-in token:
//   1. RentCast: the property record (beds, baths, sqft, year, lot, taxes, last sale) and its as-is value estimate.
//   2. HAR (Repliers): homes that SOLD nearby in the last 6-12 months, similar size → after-repair value (ARV)
//      as worst / mid / best case from the sold price per sq ft (remodeled comps set mid/best; fixer sales are set aside).
//   3. Saves the run (jag_investor_runs) so the investor can reopen it.
// POST { action: 'lola', id, deal, lang }: Lola reviews the deal (n8n "JAG Investor · Lola deal review" → Claude) and the
//   review + the calculator numbers are saved on the run. This is the only step that uses AI credits.
// RentCast calls are cached: the same address within 7 days reuses the saved property record + value estimate.
import { createClient } from "jsr:@supabase/supabase-js@2";

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SRK = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const RK = Deno.env.get("REPLIERS_API_KEY") || "";
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
const FIXER = /\b(investor special|investors? (welcome|opportunity|delight)|needs? (work|updating|tlc|repairs?|some love)|handyman|sold as[- ]is|as[- ]is condition|fixer|bring your (contractor|investor|tools)|cash (only|buyers?)|tear ?down|lot value|value (is )?in the land|fire damage|flood(ed)? damage|foundation (issues|repair needed))\b/i;
function condition(text: string): "remodeled" | "fixer" | "" {
  const t = String(text || "");
  if (FIXER.test(t)) return "fixer";
  const strong = (t.match(STRONG) || []).length, light = new Set((t.match(LIGHT) || []).map((x) => x.toLowerCase())).size;
  return strong >= 1 || light >= 2 ? "remodeled" : "";
}
const DATE = (d: Date) => d.toISOString().slice(0, 10);

async function rentcast(path: string, key: string) {
  const r = await fetch("https://api.rentcast.io/v1/" + path, { headers: { "X-Api-Key": key, Accept: "application/json" } });
  if (!r.ok) return { error: "rentcast " + r.status, body: (await r.text()).slice(0, 200) };
  return await r.json();
}
async function repliersSold(lat: number, lng: number, km: number, months: number) {
  const q = new URLSearchParams({ boardId: "147", status: "U", lastStatus: "Sld", lat: String(lat), long: String(lng), radius: String(km),
    minSoldDate: DATE(new Date(Date.now() - months * 30.5 * 864e5)), sortBy: "soldDateDesc", resultsPerPage: "80",
    fields: "mlsNumber,soldPrice,soldDate,listPrice,address,map,details.numBedrooms,details.numBathrooms,details.sqft,details.yearBuilt,details.propertyType,details.description,images,daysOnMarket,class,type" });
  q.append("class", "residential");
  const r = await fetch("https://api.repliers.io/listings?" + q.toString(), { headers: { "REPLIERS-API-KEY": RK, Accept: "application/json" } });
  if (!r.ok) return { error: "repliers " + r.status + " " + (await r.text()).slice(0, 200), listings: [] };
  return await r.json();
}

Deno.serve(async (req) => {
  const H = { "Content-Type": "application/json", ...cors(req) };
  const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: H });
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(req) });
  if (req.method !== "POST") return json({ ok: false, error: "POST only" }, 405);
  const db = createClient(SB_URL, SRK);
  let b: any = {}; try { b = await req.json(); } catch { /* empty */ }

  // who is asking: an invited, active investor (or the server token for tests)
  let uid: string | null = null, inv: Row | null = null;
  const tok = req.headers.get("x-jag-token") || "";
  if (tok) { const { data } = await db.rpc("jag_alerts_token_ok", { p_token: tok }); if (data !== true) return json({ ok: false, error: "forbidden" }, 403); }
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
  if (b.action !== "analyze") return json({ ok: false, error: "unknown action" }, 400);
  const address = String(b.address || "").trim().slice(0, 200);
  if (address.length < 6) return json({ ok: false, reason: "address" }, 400);
  const { data: key } = await db.rpc("jag_rentcast_key");
  if (!key) return json({ ok: false, error: "RentCast key missing" }, 500);

  // 1. the property (RentCast record) + as-is value estimate — reused for 7 days per address (saves RentCast calls)
  const norm = (a: string) => a.toLowerCase().replace(/[.,#]/g, " ").replace(/\s+/g, " ").trim();
  let p: Row = {}, avm: Row = {}, cached = false;
  const { data: prev } = await db.from("jag_investor_runs").select("result").gte("created_at", new Date(Date.now() - 7 * 864e5).toISOString())
    .ilike("input->>address", address.replace(/[%_]/g, "")).order("created_at", { ascending: false }).limit(5);
  const hit = (prev || []).find((r: Row) => r.result && r.result.rc && norm(String(r.result.rc.q || "")) === norm(address));
  if (hit) { p = hit.result.rc.p || {}; avm = hit.result.rc.avm || {}; cached = true; }
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
  const avmQ = new URLSearchParams({ address: subject.address, compCount: "15" });
  if (subject.sqft) avmQ.set("squareFootage", String(subject.sqft));
  if (subject.beds) avmQ.set("bedrooms", String(subject.beds));
  if (subject.baths) avmQ.set("bathrooms", String(subject.baths));
  if (subject.type) avmQ.set("propertyType", subject.type);
  const sameSize = !b.sqft && !b.beds && !b.baths;
  if (!cached || !sameSize || !avm.price) avm = await rentcast("avm/value?" + avmQ.toString(), key as string);
  if (subject.lat == null && avm && avm.latitude) { subject.lat = avm.latitude; subject.lng = avm.longitude; }
  if (subject.lat == null) return json({ ok: false, reason: "not_found", subject });

  // 2. sold comps from HAR: 1 mile / 6 months, widening to 2 miles / 12 months when thin
  const here: [number, number] = [subject.lat, subject.lng];
  let raw: Row[] = [], widened = false, repErr = "";
  for (const [km, months] of [[1.6, 6], [3.2, 12]] as [number, number][]) {
    const r: Row = await repliersSold(subject.lat, subject.lng, km, months);
    if (r.error) repErr = r.error;
    raw = (r.listings || []);
    const similar = raw.filter((l) => { const s = num(l.details && l.details.sqft); return !subject.sqft || !s || Math.abs(s - subject.sqft) / subject.sqft <= 0.3; });
    if (similar.length >= 6 || km > 2) { widened = km > 2; break; }
  }
  let comps = raw.map((l) => {
    const a = l.address || {}, d = l.details || {}, m = l.map || {};
    const sqft = num(d.sqft), price = num(l.soldPrice);
    const lat = Number(m.latitude), lng = Number(m.longitude);
    return { source: "HAR", mls: String(l.mlsNumber || ""), address: [a.streetNumber, a.streetName, a.streetSuffix].filter(Boolean).join(" ") + (a.city ? ", " + a.city : ""),
      sold_price: price, sold_date: l.soldDate ? String(l.soldDate).slice(0, 10) : null, list_price: num(l.listPrice), sqft, beds: d.numBedrooms ?? null, baths: d.numBathrooms ?? null,
      year: num(d.yearBuilt), dom: l.daysOnMarket ?? null, photo: (l.images || [])[0] || null, lat: isFinite(lat) ? lat : null, lng: isFinite(lng) ? lng : null,
      miles: isFinite(lat) && isFinite(lng) ? Math.round(miles(here, [lat, lng]) * 100) / 100 : null,
      cond: condition(d.description), ppsf: price && sqft ? Math.round(price / sqft) : null };
  }).filter((c) => c.sold_price && c.ppsf && c.ppsf > 20 && c.ppsf < 1500 && !(c.miles != null && c.miles < 0.01)); // not the house itself
  if (subject.sqft) comps = comps.filter((c) => !c.sqft || Math.abs(c.sqft - subject.sqft!) / subject.sqft! <= 0.3);
  if (subject.beds) comps = comps.filter((c) => c.beds == null || Math.abs(Number(c.beds) - Number(subject.beds)) <= 1);
  comps.sort((x, y) => (x.miles ?? 9) - (y.miles ?? 9));
  comps = comps.slice(0, 25);
  let source = "HAR";
  // fallback: RentCast's comparables (recent listings) when HAR has nothing nearby
  if (comps.length < 3 && avm && Array.isArray(avm.comparables)) {
    source = "RentCast";
    comps = avm.comparables.map((c: Row) => ({ source: "RentCast", mls: c.mlsNumber || "", address: c.formattedAddress, sold_price: num(c.price), sold_date: c.removedDate ? String(c.removedDate).slice(0, 10) : null,
      list_price: num(c.price), sqft: num(c.squareFootage), beds: c.bedrooms ?? null, baths: c.bathrooms ?? null, year: num(c.yearBuilt), dom: c.daysOnMarket ?? null, photo: null,
      lat: c.latitude ?? null, lng: c.longitude ?? null, miles: c.distance != null ? Math.round(c.distance * 100) / 100 : null, cond: "",
      ppsf: num(c.price) && num(c.squareFootage) ? Math.round(num(c.price)! / num(c.squareFootage)!) : null, status: c.status || null }))
      .filter((c: Row) => c.ppsf);
  }

  // 3. after-repair value (what it sells for once rehabbed), from sold $/sq ft × the subject's size.
  //    With 3+ remodeled comps: worst = a typical neighborhood sale, mid = the typical remodeled sale, best = the top remodeled sales.
  //    Otherwise the upper part of all sales stands in for "rehabbed" (rehabbed homes sell above the neighborhood middle).
  // Fixer sales (sold needing work) are left out of the ARV and give a separate "as-is from fixer sales" number.
  const forArv = comps.filter((c: Row) => c.cond !== "fixer");
  const ppsf = forArv.map((c) => c.ppsf!).sort((a, b) => a - b);
  const remod = forArv.filter((c: Row) => c.cond === "remodeled").map((c) => c.ppsf!).sort((a, b) => a - b);
  const fixers = comps.filter((c: Row) => c.cond === "fixer").map((c) => c.ppsf!).sort((a, b) => a - b);
  const sz = subject.sqft;
  let arv: Row | null = null;
  const band = (A: number[], R: number[]) => R.length >= 3
    ? { w: pct(A, 0.5)!, m: Math.max(pct(A, 0.5)!, pct(R, 0.5)!), b: Math.max(pct(A, 0.5)!, pct(R, 0.85)!), basis: "remodeled" }
    : { w: pct(A, 0.4)!, m: pct(A, 0.65)!, b: pct(A, 0.9)!, basis: "all" };
  if (ppsf.length && sz) {
    const k = band(ppsf, remod);
    arv = { worst: round(k.w * sz), mid: round(k.m * sz), best: round(k.b * sz), ppsf: { worst: Math.round(k.w), mid: Math.round(k.m), best: Math.round(k.b) }, basis: k.basis };
  } else if (ppsf.length) {
    const prices = forArv.map((c) => c.sold_price!).sort((a, b) => a - b);
    const rp = forArv.filter((c: Row) => c.cond === "remodeled").map((c) => c.sold_price!).sort((a, b) => a - b);
    const k = band(prices, rp);
    arv = { worst: round(k.w), mid: round(k.m), best: round(k.b), ppsf: null, no_sqft: true, basis: k.basis };
  }
  const fixerValue = fixers.length >= 2 && sz ? { value: round(pct(fixers, 0.5)! * sz), ppsf: Math.round(pct(fixers, 0.5)!), count: fixers.length } : null;
  const spread = ppsf.length ? (pct(ppsf, 0.8)! - pct(ppsf, 0.2)!) / pct(ppsf, 0.5)! : 1;
  const confidence = comps.length >= 8 && spread < 0.35 ? "high" : comps.length >= 4 ? "medium" : "low";
  const result = {
    subject, arv, confidence, comps_source: source, widened, comps_count: comps.length, remodeled_count: remod.length, fixer_count: fixers.length, fixer_value: fixerValue,
    as_is: avm && avm.price ? { value: round(avm.price), low: avm.priceRangeLow ? round(avm.priceRangeLow) : null, high: avm.priceRangeHigh ? round(avm.priceRangeHigh) : null } : null,
    comps, notes: repErr ? [repErr] : [], cached,
  };
  const keepAvm = { price: avm.price, priceRangeLow: avm.priceRangeLow, priceRangeHigh: avm.priceRangeHigh, latitude: avm.latitude, longitude: avm.longitude, comparables: (avm.comparables || []).slice(0, 15) };
  let id = null;
  if (uid) {
    const { data: ins } = await db.from("jag_investor_runs").insert({ user_id: uid, address: subject.address, input: { address, sqft: b.sqft || null, beds: b.beds || null, baths: b.baths || null }, result: { ...result, rc: { q: address, p, avm: keepAvm } } }).select("id").single();
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
  const comps = (r.comps || []) as Row[];
  const doms = comps.map((c) => c.dom).filter((x) => typeof x === "number").sort((a: number, b: number) => a - b);
  const payload = {
    property: r.subject, as_is_estimate: r.as_is, arv: r.arv, arv_confidence: r.confidence, comps_source: r.comps_source,
    as_is_from_fixer_sales: r.fixer_value || null,
    comps: { count: comps.length, remodeled: comps.filter((c) => c.cond === "remodeled").length, sold_needing_work: comps.filter((c) => c.cond === "fixer").length, widened_to_2mi_12mo: !!r.widened,
      median_days_on_market: doms.length ? doms[Math.floor(doms.length / 2)] : null,
      closest: comps.slice(0, 8).map((c) => ({ miles: c.miles, sold: c.sold_price, date: c.sold_date, sqft: c.sqft, ppsf: c.ppsf, beds: c.beds, baths: c.baths, year: c.year, condition: c.cond || "average", dom: c.dom })) },
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
