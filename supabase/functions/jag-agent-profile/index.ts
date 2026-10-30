// jag-agent-profile — homes each JAG agent closed, from HAR (through Repliers), for the public agent profiles.
//   POST {action:'sync_sold'}  x-jag-token (pg_cron daily): for every agent's HAR login IDs (jag_agents.har_ids), the sold
//                              listings where they were the buyer's agent, listing agent, or co-agent → jag_agent_sold.
//   POST {action:'sync_sold', code:'monica'} the same for one agent (the Agent Hub calls it after an agent adds a HAR ID).
// Only what the profile shows is kept: date, city, ZIP, subdivision, map point, beds/baths/sqft, type, first photo, side.
// No sold prices and no street addresses.
import { createClient } from "jsr:@supabase/supabase-js@2";

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SRK = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
const RK = Deno.env.get("REPLIERS_API_KEY") || "";
const ALLOWED = ["https://jasonaguirregroup.company", "https://www.jasonaguirregroup.company"];
const FIELDS = "mlsNumber,soldDate,address,map,images,details.numBedrooms,details.numBathrooms,details.sqft,details.propertyType,details.style,permissions,raw.SubdivisionName,lastStatus";
// which HAR field means which side of the deal
const SIDES: [string, "buyer" | "list"][] = [
  ["raw.BuyerAgentMlsId", "buyer"], ["raw.CoBuyerAgentMlsId", "buyer"], ["raw.ListAgentMlsId", "list"], ["raw.CoListAgentMlsId", "list"],
];
type Row = Record<string, any>;

function cors(req: Request) {
  const o = req.headers.get("origin") || "";
  return { "Access-Control-Allow-Origin": ALLOWED.includes(o) ? o : ALLOWED[0], "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-jag-token",
    "Access-Control-Allow-Methods": "POST, OPTIONS", "Vary": "Origin" };
}

async function soldFor(field: string, id: string): Promise<Row[]> {
  const out: Row[] = [];
  for (let page = 1; page <= 10; page++) {
    const q = new URLSearchParams({ boardId: "147", status: "U", lastStatus: "Sld", resultsPerPage: "100", pageNum: String(page), fields: FIELDS, sortBy: "soldDateDesc" });
    q.set(field, id);
    const r = await fetch("https://api.repliers.io/listings?" + q.toString(), { headers: { "REPLIERS-API-KEY": RK, Accept: "application/json" } });
    if (!r.ok) { console.error("repliers", field, id, r.status, (await r.text()).slice(0, 200)); break; }
    const d = await r.json();
    for (const l of d.listings || []) out.push(l);
    if (page >= (d.numPages || 1)) break;
  }
  return out;
}

function row(l: Row, code: string, side: string) {
  const a = l.address || {}, d = l.details || {}, m = l.map || {}, raw = l.raw || {};
  const num = (v: unknown) => (v == null || v === "" || !isFinite(Number(v)) ? null : Number(v));
  return {
    mls: String(l.mlsNumber), agent_code: code, side,
    sold_date: l.soldDate ? String(l.soldDate).slice(0, 10) : null,
    city: a.city || null, zip: a.zip || null,
    subdivision: typeof raw.SubdivisionName === "string" && raw.SubdivisionName.trim() ? raw.SubdivisionName.trim().slice(0, 80) : null,
    lat: num(m.latitude), lng: num(m.longitude),
    beds: num(d.numBedrooms), baths: num(d.numBathrooms), sqft: num(d.sqft) != null ? Math.round(Number(d.sqft)) : null,
    ptype: d.propertyType || null, style: d.style || null,
    photo: (l.images || [])[0] || null, synced_at: new Date().toISOString(),
  };
}

Deno.serve(async (req) => {
  const H = { ...cors(req), "Content-Type": "application/json" };
  const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: H });
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors(req) });
  if (req.method !== "POST") return json({ ok: false }, 405);
  const db = createClient(SB_URL, SRK);
  const b: Row = await req.json().catch(() => ({}));

  // who may run it: the daily job (token) or a team member for their own profile
  const { data: tokOk } = await db.rpc("jag_alerts_token_ok", { p_token: req.headers.get("x-jag-token") || "" });
  let only: string | null = null;
  if (tokOk !== true) {
    const auth = req.headers.get("Authorization") || "";
    const userDb = createClient(SB_URL, ANON, { global: { headers: { Authorization: auth } } });
    const { data: me } = await userDb.rpc("jag_my_profile_get", { p_code: b.code || null });
    if (!me || !(me as Row).ok) return json({ ok: false, error: "forbidden" }, 403);
    only = (me as Row).agent.code;
  }
  if (b.action !== "sync_sold") return json({ ok: false, error: "action" }, 400);
  if (!RK) return json({ ok: false, error: "REPLIERS_API_KEY missing" }, 503);

  const { data: agents } = await db.rpc("jag_agent_har_ids");
  const list = ((agents as Row[]) || []).filter((a) => !only ? (!b.code || a.code === b.code) : a.code === only);
  const stats: Row = {};
  for (const a of list) {
    const rows = new Map<string, Row>();
    const ids = [...new Set((a.ids as string[]).flatMap((x) => [x, x.toLowerCase()]))];
    for (const [field, side] of SIDES) {
      for (const id of ids) {
        for (const l of await soldFor(field, id)) {
          const p = l.permissions || {};
          if (p.displayPublic === "N" || p.displayInternetEntireListing === "N") continue;
          if (l.lastStatus && l.lastStatus !== "Sld") continue;
          const r = row(l, a.code, side);
          rows.set(r.mls + ":" + side, r);
        }
      }
    }
    const all = [...rows.values()];
    for (let i = 0; i < all.length; i += 200) {
      const { error } = await db.from("jag_agent_sold").upsert(all.slice(i, i + 200), { onConflict: "mls,agent_code,side", ignoreDuplicates: false });
      if (error) return json({ ok: false, error: error.message, stats }, 500);
    }
    stats[a.code] = { buyer: all.filter((r) => r.side === "buyer").length, list: all.filter((r) => r.side === "list").length };
  }
  return json({ ok: true, stats });
});
