// jag-call-queue — the screener's "Leads to call" panel. Team sign-ins only (or the server token, for checks).
// Newest Follow Up Boss leads (last N days, default 7), skipping the stages the watchdog skips and bulk imports,
// with today's calls on each (who, when, answered or not) and whether we already screened them.
// Read-only in Follow Up Boss.
import { createClient } from "jsr:@supabase/supabase-js@2";

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SRK = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
const FUB = "https://api.followupboss.com/v1";
const FUB_PERSON = "https://jasonhoustonrealty.followupboss.com/2/people/view/";
const SITE = "https://jasonaguirregroup.company";
const ALLOWED = [SITE, "https://www.jasonaguirregroup.company", "http://localhost:8080", "http://localhost:8099", "http://127.0.0.1:8765"];
const SKIP_STAGES = ["Past Client", "Sphere", "Trash", "Closed"];   // same as ops.settings exclude_stages
const SKIP_SOURCES = ["Import"];
// A call counts as "no answer" when FUB's outcome says so, or when there's no outcome and it lasted under 30 seconds.
const NO_ANSWER = /no answer|left (a )?message|voicemail|busy|bad number|wrong number|disconnected|no contest/i;

function cors(req: Request) {
  const o = req.headers.get("origin") || "";
  return { "Access-Control-Allow-Origin": ALLOWED.includes(o) ? o : SITE, "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info, x-jag-token", "Access-Control-Allow-Methods": "POST, OPTIONS", "Vary": "Origin" };
}
const json = (req: Request, body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors(req), "Content-Type": "application/json" } });

function houstonMidnight(): Date {
  const f = new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", year: "numeric", month: "2-digit", day: "2-digit", timeZoneName: "shortOffset" });
  const p: Record<string, string> = Object.fromEntries(f.formatToParts(new Date()).map((x) => [x.type, x.value]));
  const off = Number((p.timeZoneName.match(/GMT([+-]\d+)/) || [, "-6"])[1]);
  return new Date(`${p.year}-${p.month}-${p.day}T${String(-off).padStart(2, "0")}:00:00Z`);
}
const last10 = (v: unknown) => String(v || "").replace(/\D/g, "").slice(-10);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors(req) });
  if (req.method !== "POST") return json(req, { ok: false, error: "POST only" }, 405);
  const db = createClient(SB_URL, SRK);

  // who may read this: a team sign-in, or the server token (for checks from the database)
  const tok = req.headers.get("x-jag-token") || "";
  let allowed = false;
  if (tok) { const { data } = await db.rpc("jag_alerts_token_ok", { p_token: tok }); allowed = data === true; }
  if (!allowed) {
    const userDb = createClient(SB_URL, ANON, { global: { headers: { Authorization: req.headers.get("Authorization") || "" } } });
    const { data } = await userDb.rpc("jag_is_team"); allowed = data === true;
  }
  if (!allowed) return json(req, { ok: false, error: "not_team" }, 403);

  let b: any = {}; try { b = await req.json(); } catch { /* defaults */ }
  const days = Math.max(1, Math.min(30, Number(b.days) || 7));
  const max = Math.max(5, Math.min(60, Number(b.limit) || 40));

  let key = Deno.env.get("FUB_API_KEY") || "";
  if (!key) { const { data } = await db.rpc("jag_fub_key"); key = (data as string) || ""; }
  if (!key) return json(req, { ok: false, error: "fub_key" }, 500);
  const H = { Authorization: "Basic " + btoa(key + ":"), "X-System": "JAG-Screener" };
  const fub = async (path: string) => {
    const r = await fetch(FUB + path, { headers: H });
    if (!r.ok) throw new Error(`FUB ${r.status}`);
    return r.json();
  };

  try {
    const since = Date.now() - days * 864e5, today = houstonMidnight().getTime();
    // newest people first (one request), then keep recent, open leads
    const ppl: any = await fub(`/people?sort=-created&limit=100&fields=id,firstName,lastName,name,phones,emails,stage,source,created,assignedTo,assignedUserId,tags`);
    const leads = (ppl.people || []).filter((p: any) => new Date(p.created).getTime() >= since
      && !SKIP_STAGES.includes(String(p.stage || "")) && !SKIP_SOURCES.includes(String(p.source || ""))).slice(0, max);

    // all of today's calls, newest first (usually 1-2 requests), grouped by person
    const calls: any[] = [];
    for (let off = 0; off < 500; off += 100) {
      const page: any = await fub(`/calls?sort=-created&limit=100&offset=${off}`);
      const list = page.calls || [];
      calls.push(...list.filter((c: any) => new Date(c.created).getTime() >= today));
      if (list.length < 100 || new Date(list[list.length - 1].created).getTime() < today) break;
    }
    const { data: agents } = await db.from("jag_agents").select("fub_user_id,name,first_name");
    const who = new Map((agents || []).map((a: any) => [Number(a.fub_user_id), a.first_name || a.name]));
    const byPerson = new Map<number, any[]>();
    for (const c of calls) {
      const pid = Number(c.personId); if (!pid) continue;
      const out = !c.isIncoming, dur = Number(c.duration) || 0, oc = String(c.outcome || "");
      const answered = oc ? !NO_ANSWER.test(oc) : dur >= 30;
      (byPerson.get(pid) || byPerson.set(pid, []).get(pid)!).push({
        at: c.created, by: who.get(Number(c.userId)) || c.userName || null, outgoing: out, duration: dur, outcome: oc || null, answered,
      });
    }

    // already screened? (by phone, last 60 days)
    const { data: scr } = await db.from("jag_screenings").select("id,phone,created_at,screener,hot")
      .gte("created_at", new Date(Date.now() - 60 * 864e5).toISOString()).order("created_at", { ascending: false }).limit(500);
    const screened = new Map<string, any>();
    for (const s of scr || []) { const k = last10(s.phone); if (k.length === 10 && !screened.has(k)) screened.set(k, s); }

    const out = leads.map((p: any) => {
      const phones = (p.phones || []).map((x: any) => x.value).filter(Boolean);
      const phone = ((p.phones || []).find((x: any) => x.isPrimary) || (p.phones || [])[0] || {}).value || null;
      const email = ((p.emails || []).find((x: any) => x.isPrimary) || (p.emails || [])[0] || {}).value || null;
      const today = (byPerson.get(Number(p.id)) || []).sort((a, b) => String(b.at).localeCompare(String(a.at)));
      const status = !today.length ? "not_called" : today.some((c) => c.answered) ? "answered" : "no_answer";
      const sc = phones.map(last10).map((k: string) => screened.get(k)).find(Boolean) || null;
      return {
        id: p.id, name: p.name || [p.firstName, p.lastName].filter(Boolean).join(" ") || "—", first: p.firstName || null, last: p.lastName || null,
        phone, email, stage: p.stage || null, source: p.source || null, created: p.created, assigned: p.assignedTo || null,
        fub_url: FUB_PERSON + p.id, status, calls_today: today.slice(0, 6),
        screened: sc ? { id: sc.id, at: sc.created_at, by: sc.screener, hot: !!sc.hot } : null,
      };
    });
    return json(req, { ok: true, days, as_of: new Date().toISOString(), calls_today_total: calls.length, leads: out });
  } catch (e) {
    return json(req, { ok: false, error: String((e as Error).message || e) }, 502);
  }
});
