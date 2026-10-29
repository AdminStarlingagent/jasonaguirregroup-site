// JAG Matrix criteria → Repliers (HAR, board 147) query.
// Shared by matrix-search (the team's /matrix page) and lead-emails (Matrix "auto email" campaigns),
// so a campaign always runs exactly the search the agent built. Only whitelisted, validated values pass.
//
// Criteria (all optional):
//  type 'sale'|'lease'
//  st   on-market statuses:  active | option (Option Pending) | pcs (Pending Continue to Show) | pending | coming
//  off  off-market statuses: sold | withdrawn | expired | terminated     offDays: look back N days (default 180)
//  pt   HAR property types (raw.HAR_PropertyType): Single-Family, Townhouse/Condo, ...
//  minP maxP beds maxBeds baths half minSf maxSf minYb maxYb gar maxSt minAc maxAc
//  newc pool hoa   'y' | 'n' | ''
//  city zip county sub dist elem mid high geo fin   arrays of strings
//  kw   keyword (remarks/address)    street  street name
//  map  [[lng,lat],...] polygon      rad {lat,lng,mi}
//  hot  {k:'new'|'price', d:days}    sort  one of SORTS

export type Crit = Record<string, any>;

export const SORTS = new Set([
  "listPriceAsc", "listPriceDesc", "createdOnDesc", "updatedOnDesc", "sqftDesc", "sqftAsc", "bedsDesc", "bathsDesc",
  "yearBuiltDesc", "yearBuiltAsc", "listPricePerSqFtAsc", "listPricePerSqFtDesc", "soldDateDesc", "soldPriceDesc", "soldPriceAsc",
  "statusAscListPriceAsc",
]);

const ON: Record<string, { std: string; mls: string }> = {
  active: { std: "Active", mls: "Active" },
  option: { std: "Pending", mls: "Option Pending" },
  pcs: { std: "Pending", mls: "Pending Continue to Show" },
  pending: { std: "Pending", mls: "Pending" },
  coming: { std: "Coming Soon", mls: "Coming Soon" },
};
const OFF: Record<string, { std: string; date: string }> = {
  sold: { std: "Closed", date: "minSoldDate" },
  withdrawn: { std: "Withdrawn", date: "minUnavailableDate" },
  expired: { std: "Expired", date: "minUnavailableDate" },
  terminated: { std: "Canceled", date: "minUnavailableDate" },
};

const num = (v: unknown, lo: number, hi: number): number | null => {
  const n = Number(String(v ?? "").replace(/[$,\s]/g, ""));
  return Number.isFinite(n) && n >= lo && n <= hi && String(v ?? "").trim() !== "" ? n : null;
};
const strs = (v: unknown, max = 25): string[] =>
  (Array.isArray(v) ? v : typeof v === "string" ? v.split(/[,;\n]/) : [])
    .map((x) => String(x ?? "").trim().slice(0, 100)).filter((x) => x && !/[<>{}]/.test(x)).slice(0, max);
const yn = (v: unknown) => (v === "y" ? "true" : v === "n" ? "false" : null);
const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

// Base filters shared by every status group.
function base(c: Crit): URLSearchParams {
  const q = new URLSearchParams();
  q.set("boardId", "147");
  q.append("class", "residential"); q.append("class", "condo");
  q.set("type", c.type === "lease" ? "lease" : "sale");
  const set = (k: string, v: number | null) => { if (v != null) q.set(k, String(Math.round(v))); };
  set("minPrice", num(c.minP, 0, 1e9)); set("maxPrice", num(c.maxP, 1, 1e9));
  set("minBedrooms", num(c.beds, 0, 20)); set("maxBedrooms", num(c.maxBeds, 0, 20));
  set("minBaths", num(c.baths, 0, 20)); set("minBathroomsHalf", num(c.half, 0, 10));
  set("minSqft", num(c.minSf, 0, 50000)); set("maxSqft", num(c.maxSf, 1, 50000));
  set("minYearBuilt", num(c.minYb, 1800, 2100)); set("maxYearBuilt", num(c.maxYb, 1800, 2100));
  set("minGarageSpaces", num(c.gar, 0, 20)); set("maxStories", num(c.maxSt, 1, 10));
  const ac = num(c.minAc, 0, 100000), ax = num(c.maxAc, 0, 100000);
  if (ac) q.set("minLotSizeSqft", String(Math.round(ac * 43560)));
  if (ax) q.set("maxLotSizeSqft", String(Math.round(ax * 43560)));
  const many = (k: string, v: unknown, max?: number) => strs(v, max).forEach((x) => q.append(k, x));
  many("city", c.city); many("raw.CountyOrParish", c.county); many("raw.SubdivisionName", c.sub, 40);
  many("raw.HighSchoolDistrict", c.dist); many("raw.ElementarySchool", c.elem); many("raw.MiddleOrJuniorSchool", c.mid);
  many("raw.HighSchool", c.high); many("raw.HAR_GeoMarketArea", c.geo); many("raw.HAR_PropertyType", c.pt);
  many("raw.ListingTerms", c.fin);
  strs(c.zip, 40).filter((z) => /^\d{5}$/.test(z)).forEach((z) => q.append("zip", z));
  if (typeof c.street === "string" && c.street.trim()) q.set("streetName", c.street.trim().slice(0, 60));
  const nc = yn(c.newc); if (nc) q.set("raw.NewConstructionYN", nc);
  const pool = yn(c.pool); if (pool) q.set("raw.PoolPrivateYN", pool);
  const hoa = yn(c.hoa); if (hoa) q.set("raw.AssociationYN", hoa);
  if (typeof c.kw === "string" && c.kw.trim()) q.set("search", c.kw.trim().slice(0, 120));
  // location shape: drawn polygon, or a radius around a point
  if (Array.isArray(c.map) && c.map.length >= 3 && c.map.length <= 200) {
    const ring = c.map.map((p: any) => [Number(p[0]), Number(p[1])]).filter((p: number[]) => isFinite(p[0]) && isFinite(p[1]) && Math.abs(p[1]) <= 90);
    if (ring.length >= 3) q.set("map", JSON.stringify([[...ring, ring[0]]]));
  } else if (c.rad && isFinite(Number(c.rad.lat)) && isFinite(Number(c.rad.lng)) && num(c.rad.mi, 0.1, 100)) {
    q.set("lat", String(Number(c.rad.lat))); q.set("long", String(Number(c.rad.lng)));
    q.set("radius", String(num(c.rad.mi, 0.1, 100))); q.set("radiusUnit", "mi");
  }
  // hot sheet: new listings or price drops in the last N days
  const hd = num(c.hot?.d, 1, 365);
  if (hd && c.hot?.k === "new") q.set("minListDate", day(Date.now() - hd * 864e5));
  if (hd && c.hot?.k === "price") { q.set("lastPriceChangeType", "decrease"); q.set("minPriceChangeDateTime", day(Date.now() - hd * 864e5)); }
  return q;
}

// One query per status group (on-market / off-market), because sold dates can't be mixed with active listings.
export function buildQueries(c: Crit): { group: "on" | "off"; q: URLSearchParams }[] {
  const out: { group: "on" | "off"; q: URLSearchParams }[] = [];
  const on = strs(c.st).filter((s) => ON[s]);
  const off = strs(c.off).filter((s) => OFF[s]);
  if (!on.length && !off.length) on.push("active");
  if (on.length) {
    const q = base(c);
    [...new Set(on.map((s) => ON[s].std))].forEach((s) => q.append("standardStatus", s));
    // only narrow by HAR status when it actually narrows (all of Active/Coming Soon are one HAR status each)
    const pend = on.filter((s) => ON[s].std === "Pending");
    if (pend.length && pend.length < 3) on.forEach((s) => q.append("raw.MlsStatus", ON[s].mls));
    out.push({ group: "on", q });
  }
  if (off.length) {
    const days = num(c.offDays, 1, 3650) || 180;
    const since = day(Date.now() - days * 864e5);
    // sold uses sold date; the others use the date they came off the market — run separately when mixed
    const sold = off.includes("sold"), rest = off.filter((s) => s !== "sold");
    if (sold) { const q = base(c); q.append("standardStatus", "Closed"); q.set("minSoldDate", since); out.push({ group: "off", q }); }
    if (rest.length) {
      const q = base(c); rest.forEach((s) => q.append("standardStatus", OFF[s].std)); q.set("minUnavailableDate", since);
      out.push({ group: "off", q });
    }
  }
  return out;
}

// Short human summary, e.g. "RES ACT $300K- 3+ 2+ 1,400+ sqft Magnolia" (Matrix speed bar style)
export function summary(c: Crit): string {
  const k = (n: number) => (n >= 1e6 ? "$" + +(n / 1e6).toFixed(2) + "M" : "$" + Math.round(n / 1000) + "K");
  const parts: string[] = [];
  parts.push(c.type === "lease" ? "LEASE" : "RES");
  const st = strs(c.st), off = strs(c.off);
  parts.push([...st.map((s) => ({ active: "ACT", option: "OP", pcs: "PCS", pending: "PEND", coming: "CS" } as any)[s] || ""),
    ...off.map((s) => ({ sold: "SLD", withdrawn: "WITH", expired: "EXP", terminated: "TERM" } as any)[s] || "")].filter(Boolean).join("/") || "ACT");
  const a = num(c.minP, 0, 1e9), b = num(c.maxP, 1, 1e9);
  if (a || b) parts.push((a ? k(a) : "") + "-" + (b ? k(b) : ""));
  if (num(c.beds, 0, 20)) parts.push(c.beds + "+ bd"); if (num(c.baths, 0, 20)) parts.push(c.baths + "+ ba");
  if (num(c.minSf, 0, 50000)) parts.push(Number(c.minSf).toLocaleString("en-US") + "+ sqft");
  const where = [...strs(c.city), ...strs(c.zip), ...strs(c.sub), ...strs(c.high)].slice(0, 3);
  if (where.length) parts.push(where.join(", "));
  if (Array.isArray(c.map) && c.map.length >= 3) parts.push("map area");
  if (c.rad && c.rad.mi) parts.push(`${c.rad.mi} mi radius`);
  if (c.newc === "y") parts.push("new build");
  return parts.join(" ");
}
