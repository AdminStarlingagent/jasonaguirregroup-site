import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { buildQueries, summary, SORTS, type Crit } from "./matrix-query.ts";

// JAG Matrix search — the team's HAR Matrix-style search (/matrix). TEAM ONLY (signed-in JAG team members).
// Unlike the public home-search proxy, this returns agent-only HAR facts: private (agent) remarks, showing
// instructions, appointment desk, list agent contact, price-change log, sold/pending/expired statuses and comps.
// Never expose these to clients — the client list page (/lista) only gets the public snapshot saved in the cart.
//
// POST {action:"search", c:<criteria>, page, per, sort}   → rows for the single-line grid
// POST {action:"detail", mls}                            → everything for the 360° view
// POST {action:"facets", c}                              → pick lists (subdivisions, schools, areas...) for the criteria scope

const SB = Deno.env.get("SUPABASE_URL")!;
const ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
const RK = Deno.env.get("REPLIERS_API_KEY") || "";
const ORIGINS = new Set([
  "https://jasonaguirregroup.company", "https://www.jasonaguirregroup.company",
  "https://jasonaguirregroup.us", "https://www.jasonaguirregroup.us",
  "http://localhost:8080", "http://localhost:8099",
]);

const GRID_FIELDS = [
  "mlsNumber", "listPrice", "originalPrice", "soldPrice", "soldDate", "listDate", "type", "standardStatus", "daysOnMarket",
  "address", "map", "images", "photoCount", "details.numBedrooms", "details.numBathrooms", "details.sqft", "details.yearBuilt",
  "lot.acres", "lastPriceChangeType", "timestamps.lastPriceChanged", "permissions",
  "raw.MlsStatus", "raw.SubdivisionName", "raw.CumulativeDaysOnMarket", "raw.BathroomsFull", "raw.BathroomsHalf", "raw.BuilderName",
  "raw.NewConstructionYN", "raw.HAR_PropertyType", "raw.LotSizeAcres", "raw.GarageSpaces", "raw.Stories", "raw.PoolPrivateYN",
  "raw.ListOfficeMlsId", "raw.ListOfficeName", "raw.MLSAreaMajor", "raw.HAR_OpenHouseUpcoming", "raw.CountyOrParish",
  "raw.HighSchool", "raw.ListingTerms", "raw.HAR_TaxRate", "raw.AssociationFee", "raw.AssociationFeeFrequency",
  "raw.ShowingInstructions", "raw.ClosePrice", "raw.CloseDate",
].join(",");

type Row = Record<string, any>;

function cors(o: string | null): Record<string, string> {
  return o && ORIGINS.has(o)
    ? { "Access-Control-Allow-Origin": o, "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info", "Access-Control-Max-Age": "86400", Vary: "Origin" }
    : { Vary: "Origin" };
}
const json = (o: string | null, b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { "Content-Type": "application/json", ...cors(o) } });

async function isTeam(auth: string): Promise<boolean> {
  if (!/^Bearer .{20,}/.test(auth)) return false;
  const r = await fetch(`${SB}/rest/v1/rpc/jag_is_team`, { method: "POST", headers: { apikey: ANON, Authorization: auth, "Content-Type": "application/json" }, body: "{}" });
  return r.ok && (await r.json().catch(() => false)) === true;
}

async function rep(path: string, q: URLSearchParams): Promise<Row> {
  const r = await fetch(`https://api.repliers.io/${path}?${q.toString()}`, { headers: { "REPLIERS-API-KEY": RK, Accept: "application/json" } });
  const t = await r.text();
  if (!r.ok) { console.error("repliers", r.status, t.slice(0, 300)); throw new Error(`feed ${r.status}: ${t.slice(0, 160)}`); }
  return JSON.parse(t);
}

const addrLine = (a: Row) => [a.streetNumber, a.streetDirectionPrefix, a.streetName, a.streetSuffix, a.streetDirection].filter(Boolean).join(" ");

function row(l: Row): Row {
  const a = l.address || {}, d = l.details || {}, r = l.raw || {}, p = l.permissions || {};
  return {
    mls: String(l.mlsNumber), st: r.MlsStatus || l.standardStatus, std: l.standardStatus, type: l.type,
    price: l.listPrice ?? null, orig: l.originalPrice ?? null, sold: l.soldPrice ?? r.ClosePrice ?? null, soldDate: (l.soldDate || r.CloseDate || "").slice(0, 10) || null,
    listDate: (l.listDate || "").slice(0, 10) || null, dom: l.daysOnMarket ?? null, cdom: r.CumulativeDaysOnMarket ?? null,
    addr: addrLine(a), unit: a.unitNumber || null, city: a.city || null, zip: a.zip || null,
    lat: l.map?.latitude ?? null, lng: l.map?.longitude ?? null,
    photo: (l.images || [])[0] || null, photos: l.photoCount ?? (l.images || []).length,
    beds: d.numBedrooms ?? null, baths: d.numBathrooms ?? null, bf: r.BathroomsFull ?? null, bh: r.BathroomsHalf ?? null,
    sqft: d.sqft ? Number(d.sqft) : null, yb: d.yearBuilt ? Number(d.yearBuilt) : null, acres: r.LotSizeAcres ?? l.lot?.acres ?? null,
    sub: r.SubdivisionName || null, builder: r.BuilderName || null, newc: r.NewConstructionYN === true, ptype: r.HAR_PropertyType || null,
    gar: r.GarageSpaces ?? null, stories: r.Stories ?? null, pool: r.PoolPrivateYN === true, office: r.ListOfficeMlsId || null,
    officeName: r.ListOfficeName || null, area: r.MLSAreaMajor || null, oh: r.HAR_OpenHouseUpcoming || null, county: r.CountyOrParish || null,
    hs: r.HighSchool || null, terms: Array.isArray(r.ListingTerms) ? r.ListingTerms : [], tax: r.HAR_TaxRate ?? null,
    hoa: r.AssociationFee ?? null, hoaFreq: r.AssociationFeeFrequency || null, show: r.ShowingInstructions || null,
    drop: l.lastPriceChangeType || null, dropAt: l.timestamps?.lastPriceChanged || null,
    // MLS display rules for anything a client will see
    pub: p.displayPublic === "N" || p.displayInternetEntireListing === "N" ? "N" : "Y", noaddr: p.displayAddressOnInternet === "N",
  };
}

async function search(b: Row) {
  const c: Crit = b.c && typeof b.c === "object" ? b.c : {};
  const per = Math.min(Math.max(parseInt(b.per, 10) || 25, 5), 100);
  const page = Math.min(Math.max(parseInt(b.page, 10) || 1, 1), 200);
  const groups = buildQueries(c);
  const sort = SORTS.has(b.sort) ? b.sort : "listPriceAsc";
  const res = await Promise.all(groups.map(async (g) => {
    const q = new URLSearchParams(g.q);
    let s = sort;
    if (g.group === "on" && /^sold/.test(s)) s = "listPriceAsc";
    if (g.group === "off" && s === "statusAscListPriceAsc") s = "soldDateDesc";
    q.set("sortBy", s); q.set("fields", GRID_FIELDS); q.set("pageNum", String(page));
    q.set("resultsPerPage", String(groups.length > 1 ? Math.ceil(per / groups.length) : per));
    const d = await rep("listings", q);
    return { group: g.group, count: d.count ?? 0, numPages: d.numPages ?? 0, rows: (d.listings || []).map(row) };
  }));
  return {
    ok: true, summary: summary(c), page, per,
    count: res.reduce((n, r) => n + r.count, 0), numPages: Math.max(0, ...res.map((r) => r.numPages)),
    groups: res.map((r) => ({ group: r.group, count: r.count })), rows: res.flatMap((r) => r.rows),
  };
}

async function detail(b: Row) {
  const mls = String(b.mls || "");
  if (!/^[0-9A-Za-z-]{3,20}$/.test(mls)) return { ok: false, error: "mls" };
  // the single-listing call has comps, rooms and the price log; HAR's own (agent-only) fields come from a search by MLS #
  const rq = new URLSearchParams({ boardId: "147", mlsNumber: mls, fields: "mlsNumber,raw", resultsPerPage: "1" });
  ["Active", "Pending", "Coming Soon", "Closed", "Withdrawn", "Expired", "Canceled"].forEach((s) => rq.append("standardStatus", s));
  const [l, s] = await Promise.all([rep(`listings/${encodeURIComponent(mls)}`, new URLSearchParams({ boardId: "147" })), rep("listings", rq).catch((): Row => ({}))]);
  const r = (s.listings || [])[0]?.raw || l.raw || {};
  const keep = [
    "MlsStatus", "SubdivisionName", "HAR_LegalSubdivision", "CountyOrParish", "HAR_GeoMarketArea", "MLSAreaMajor", "ParcelNumber", "TaxLegalDescription",
    "ElementarySchool", "MiddleOrJuniorSchool", "HighSchool", "HighSchoolDistrict", "Directions", "PublicRemarks", "PrivateRemarks",
    "ShowingInstructions", "HAR_PhoneApptDesk", "HAR_PhoneApptDesc", "HAR_PhoneAlt", "HAR_PhoneAltDesc", "ListAgentFullName", "ListAgentMlsId",
    "ListAgentEmail", "ListAgentPreferredPhone", "ListAgentStateLicense", "ListOfficeName", "ListOfficeMlsId", "ListOfficePhone",
    "HAR_ListTeamName", "BuilderName", "NewConstructionYN", "HAR_CompletionDate", "PropertyCondition", "YearBuiltSource", "ArchitecturalStyle",
    "StructureType", "HAR_PropertyType", "PropertySubType", "Stories", "GarageSpaces", "ParkingFeatures", "PoolPrivateYN", "PoolFeatures",
    "HAR_PoolArea", "LotSizeAcres", "LotSizeSquareFeet", "LotSizeDimensions", "LotFeatures", "LotSizeSource", "FoundationDetails", "Roof",
    "ConstructionMaterials", "Flooring", "Appliances", "LaundryFeatures", "Heating", "Cooling", "WaterSource", "Sewer", "Fencing",
    "InteriorFeatures", "RoomKitchenFeatures", "RoomMasterBathroomFeatures", "HAR_RoomDescription", "HAR_Countertops", "AssociationYN",
    "AssociationName", "AssociationPhone", "AssociationFee", "AssociationFeeFrequency", "HAR_AnnualMaintDesc", "HAR_MaintFeeIncludes",
    "HAR_HOAWebsite", "AssociationAmenities", "HAR_OtherMandatoryFee", "HAR_Restrictions", "Disclosures", "HAR_UtilityDistrict",
    "HAR_TaxRate", "TaxYear", "TaxAnnualAmount", "ListingTerms", "ListingAgreement", "HAR_PriceSqFtList", "HAR_LotPriceSqFtList",
    "CumulativeDaysOnMarket", "DaysOnMarket", "OriginalListPrice", "ListingContractDate", "StatusChangeTimestamp", "HAR_OpenHouseUpcoming",
    "VirtualTourURLUnbranded", "VirtualTourURLBranded", "HAR_SaleMLNum", "ClosePrice", "CloseDate", "WaterfrontFeatures", "Ownership",
    "HAR_ApprovalRequired", "BathroomsFull", "BathroomsHalf", "BedroomsTotal", "LivingArea", "PublicSurveySection", "HAR_CensusTract",
  ];
  const raw: Row = {};
  for (const k of keep) if (r[k] !== undefined && r[k] !== null && r[k] !== "") raw[k] = r[k];
  const comps = (l.comparables || []).slice(0, 12).map((x: Row) => ({
    mls: x.mlsNumber, addr: addrLine(x.address || {}), city: x.address?.city, zip: x.address?.zip, status: x.lastStatus,
    list: x.listPrice, sold: x.soldPrice, soldDate: (x.soldDate || "").slice(0, 10) || null, listDate: (x.listDate || "").slice(0, 10) || null,
    beds: x.details?.numBedrooms ?? null, baths: x.details?.numBathrooms ?? null, sqft: x.details?.sqft ? Number(x.details.sqft) : null,
    yb: x.details?.yearBuilt ? Number(x.details.yearBuilt) : null, dist: x.distance ?? null,
  }));
  return {
    ok: true, row: row({ ...l, raw: r }),
    images: l.images || [], rooms: l.rooms || [], details: l.details || {}, lot: l.lot || {}, taxes: l.taxes || {},
    priceLog: (l.listPriceLog || []).map((x: Row) => ({ at: x.updatedOn, type: x.type, from: Number(x.previousListPrice) || null, to: Number(x.currentListPrice) || null })),
    timestamps: l.timestamps || {}, history: l.history || [], openHouse: l.openHouse || [], comps, raw,
    agents: (l.agents || []).map((a: Row) => ({ name: a.name, email: a.email, phones: a.phones, id: a.boardAgentId })),
  };
}

const FACETS = ["raw.SubdivisionName", "raw.ElementarySchool", "raw.MiddleOrJuniorSchool", "raw.HighSchool", "raw.HighSchoolDistrict",
  "raw.HAR_GeoMarketArea", "raw.CountyOrParish", "address.city", "raw.HAR_PropertyType", "raw.ListingTerms"];
async function facets(b: Row) {
  const c: Crit = b.c && typeof b.c === "object" ? b.c : {};
  // scope = location only (so the pick lists don't shrink as other filters are added)
  const scope: Crit = { type: c.type, city: c.city, zip: c.zip, county: c.county, map: c.map, rad: c.rad, st: ["active", "option", "pcs", "pending", "coming"] };
  const q = buildQueries(scope)[0].q;
  q.set("listings", "false"); q.set("aggregates", FACETS.join(","));
  const d = await rep("listings", q);
  const ag = d.aggregates || {}, out: Row = {};
  const pick = (obj: Row | undefined) => Object.entries(obj || {}).sort((x: any, y: any) => y[1] - x[1]).slice(0, 80).map(([k, n]) => [k, n]);
  for (const f of FACETS) {
    const [top, key] = f.split(".");
    out[key] = pick((ag[top] || {})[key]);
  }
  return { ok: true, count: d.count ?? 0, facets: out };
}

Deno.serve(async (req: Request) => {
  const o = req.headers.get("origin");
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(o) });
  if (req.method !== "POST") return json(o, { error: "POST only" }, 405);
  if (!o || !ORIGINS.has(o)) return json(o, { error: "origin_not_allowed" }, 403);
  if (!RK) return json(o, { error: "not_configured" }, 503);
  if (!(await isTeam(req.headers.get("Authorization") || ""))) return json(o, { error: "not_team" }, 403);
  let b: Row = {};
  try { b = await req.json(); } catch { /* empty */ }
  try {
    if (b.action === "detail") return json(o, await detail(b));
    if (b.action === "facets") return json(o, await facets(b));
    return json(o, await search(b));
  } catch (e) {
    return json(o, { ok: false, error: String(e).slice(0, 240) }, 502);
  }
});
