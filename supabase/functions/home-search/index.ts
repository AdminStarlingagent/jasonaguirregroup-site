import "jsr:@supabase/functions-js/edge-runtime.d.ts";

// JAG home search proxy.
// Keeps the Repliers API key on the server (secret REPLIERS_API_KEY) so it never
// appears in the page source. Public and read-only by design: it only answers
// listing searches, only from the JAG sites, only for HAR (board 147), and only
// with a fixed set of filters and fields.

const ALLOWED_ORIGINS = new Set([
  "https://jasonaguirregroup.company",
  "https://www.jasonaguirregroup.company",
  "https://jasonaguirregroup.us",
  "https://www.jasonaguirregroup.us",
]);

const BOARD_ID = "147"; // HAR
// HAR files townhomes/condos under a separate "condo" class, so search both.
const CLASSES = ["residential", "condo"];

// Filters the search page is allowed to send through.
const PASS = new Set([
  "type", "state", "city", "zip", "search", "map", "minPrice", "maxPrice",
  "minBedrooms", "minBaths", "propertyType", "sortBy", "pageNum", "mlsNumber",
]);

// Only the fields the page displays. raw.NewConstructionYN is HAR's own "new construction" flag.
const FIELDS = [
  "mlsNumber", "listPrice", "type", "address", "map", "images", "photoCount",
  "daysOnMarket", "updatedOn", "details.numBedrooms", "details.numBathrooms",
  "details.sqft", "details.yearBuilt", "details.description",
  "details.propertyType", "details.style", "lot.acres",
  "office.brokerageName", "agents", "permissions", "raw.NewConstructionYN", "raw.BuilderName",
].join(",");

// Extra facts for a single listing page (?detail=1 with one mlsNumber).
const FIELDS_DETAIL = [
  "mlsNumber", "listPrice", "originalPrice", "type", "status", "lastStatus", "standardStatus",
  "listDate", "address", "map", "images", "photoCount", "daysOnMarket", "updatedOn",
  "details", "lot", "taxes", "condominium", "nearby",
  "office.brokerageName", "agents", "permissions", "raw.NewConstructionYN", "raw.BuilderName",
  // facts the team's "Comenzar oferta" pre-fills (all shown publicly on HAR as well)
  "raw.AssociationYN", "raw.AssociationName", "raw.AssociationPhone", "raw.AssociationFee", "raw.AssociationFeeFrequency",
  "raw.ListAgentFullName", "raw.ListAgentEmail", "raw.ListAgentPreferredPhone", "raw.ListAgentStateLicense",
  "raw.ListOfficeName", "raw.ListOfficePhone", "raw.Disclosures", "raw.CountyOrParish", "raw.SubdivisionName",
].join(",");

const MAX_PER_PAGE = 24;

function cors(origin: string | null): Record<string, string> {
  const h: Record<string, string> = { "Vary": "Origin" };
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    h["Access-Control-Allow-Origin"] = origin;
    h["Access-Control-Allow-Methods"] = "GET, OPTIONS";
    h["Access-Control-Allow-Headers"] = "content-type";
    h["Access-Control-Max-Age"] = "86400";
  }
  return h;
}

function json(body: unknown, status: number, origin: string | null, extra: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...cors(origin), ...extra },
  });
}

// Respect the listing's own display permissions from the MLS.
function clean(l: any) {
  const p = l.permissions || {};
  if (p.displayPublic === "N" || p.displayInternetEntireListing === "N") return null;
  if (p.displayAddressOnInternet === "N" && l.address) {
    l.address = { city: l.address.city, state: l.address.state, zip: l.address.zip };
    delete l.map;
  }
  delete l.permissions;
  // only the two raw MLS facts we show: new construction + builder
  const r = l.raw || {};
  l.newConstruction = r.NewConstructionYN === true;
  l.builder = typeof r.BuilderName === "string" && r.BuilderName.trim() ? r.BuilderName.trim().slice(0, 80) : null;
  if ("ListAgentFullName" in r || "AssociationYN" in r || "CountyOrParish" in r) {
    const t = (v: unknown) => typeof v === "string" && v.trim() ? v.trim().slice(0, 120) : null;
    l.offer = {
      hoa: r.AssociationYN === true ? true : r.AssociationYN === false ? false : null,
      hoaName: t(r.AssociationName), hoaPhone: t(r.AssociationPhone),
      hoaFee: typeof r.AssociationFee === "number" ? r.AssociationFee : null, hoaFreq: t(r.AssociationFeeFrequency),
      agent: t(r.ListAgentFullName), agentEmail: t(r.ListAgentEmail), agentPhone: t(r.ListAgentPreferredPhone),
      agentLicense: t(r.ListAgentStateLicense), office: t(r.ListOfficeName), officePhone: t(r.ListOfficePhone),
      disclosures: Array.isArray(r.Disclosures) ? r.Disclosures.slice(0, 12).map(String) : [],
      county: t(r.CountyOrParish), subdivision: t(r.SubdivisionName),
    };
  }
  delete l.raw;
  return l;
}

Deno.serve(async (req: Request) => {
  const origin = req.headers.get("origin");

  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(origin) });
  if (req.method !== "GET") return json({ error: "method_not_allowed" }, 405, origin);
  if (!origin || !ALLOWED_ORIGINS.has(origin)) return json({ error: "origin_not_allowed" }, 403, origin);

  const key = Deno.env.get("REPLIERS_API_KEY");
  if (!key) return json({ error: "not_configured" }, 503, origin);

  const inP = new URL(req.url).searchParams;
  const out = new URLSearchParams();
  for (const [k, v] of inP) {
    if (PASS.has(k) && v.length <= 2000) out.append(k, v);
  }
  // newc=1: only homes the listing agent marked as new construction on HAR (built or being built by a builder)
  if (inP.get("newc") === "1") out.set("raw.NewConstructionYN", "true");
  // Fixed server-side: HAR only, active residential/condo listings with photos, capped page size.
  out.set("boardId", BOARD_ID);
  out.set("status", "A");
  out.delete("class");
  for (const c of CLASSES) out.append("class", c);
  out.set("hasImages", "true");
  const detail = inP.get("detail") === "1" && inP.getAll("mlsNumber").length === 1;
  out.set("fields", detail ? FIELDS_DETAIL : FIELDS);
  const per = detail ? 1 : Math.min(Math.max(parseInt(inP.get("resultsPerPage") || "", 10) || MAX_PER_PAGE, 1), MAX_PER_PAGE);
  out.set("resultsPerPage", String(per));

  try {
    const r = await fetch("https://api.repliers.io/listings?" + out.toString(), {
      headers: { "REPLIERS-API-KEY": key, "Accept": "application/json" },
    });
    if (!r.ok) {
      console.error("repliers error", r.status, (await r.text()).slice(0, 300));
      return json({ error: "upstream_error", status: r.status }, 502, origin);
    }
    const d = await r.json();
    const listings = (d.listings ?? []).map(clean).filter(Boolean);
    return json(
      { count: d.count ?? 0, numPages: d.numPages ?? 1, page: d.page ?? 1, listings },
      200,
      origin,
      { "Cache-Control": "public, max-age=60" },
    );
  } catch (e) {
    console.error("proxy failure", String(e));
    return json({ error: "upstream_unreachable" }, 502, origin);
  }
});
