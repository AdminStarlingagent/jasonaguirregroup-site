// jag-screening-fub — logs one call screening (public.jag_screenings) in Follow Up Boss.
// Called by screener.html / admin.html with the team member's login.
// Finds the client by phone, then email. If found: adds tags + note (+ follow-up task); stage and agent stay as they are,
// except a hot screening moves early-stage clients to Hot Prospect.
// If not found: creates the client UNASSIGNED in the Calls pond, stage Applied (Hot Prospect when hot), source "JAG Screener",
// tagged #starling_stop so Starling AI does not text someone a teammate is already talking to.
// One client, one row in the admin: if the client already sent the Home Loan application (e.g. the agent started it
// during the call), the screening is attached to that application. Otherwise hot screenings get a "Screened" row.
import { createClient } from "jsr:@supabase/supabase-js@2";

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SRK = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
const FUB = "https://api.followupboss.com/v1";
const FUB_APP = "https://jasonhoustonrealty.followupboss.com/2/people/view/";
const SITE = "https://jasonaguirregroup.company";
const CALLS_POND_ID = 2;
const STAGE_NEW = "Applied";
const STAGE_HOT = "Hot Prospect";
// Existing clients in these early stages move to Hot Prospect when the screening is hot; later stages are left alone.
const PROMOTE = ["Lead", "Nurture", "Attempted contact", "Spoke with customer", "Unresponsive", "Trash", "2027 Follow-up", "Credit Lead", "Out Of Town", "Sphere"];
const SOURCE = "JAG Screener";
const LANE = { listo: "Listo", revision: "Revisión", prep: "Preparación" } as Record<string, string>;
const ALLOWED = [SITE, "https://www.jasonaguirregroup.company", "http://localhost:8080"];

function cors(req: Request) {
  const o = req.headers.get("origin") || "";
  return {
    "Access-Control-Allow-Origin": ALLOWED.includes(o) ? o : SITE,
    "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}
const json = (req: Request, body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors(req), "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors(req) });
  if (req.method !== "POST") return json(req, { ok: false, error: "POST only" }, 405);

  // 1. Only signed-in team members.
  const auth = req.headers.get("Authorization") || "";
  const userDb = createClient(SB_URL, ANON, { global: { headers: { Authorization: auth } } });
  const { data: isTeam } = await userDb.rpc("jag_is_team");
  if (isTeam !== true) return json(req, { ok: false, error: "not_team" }, 403);

  let body: { id?: string; force?: boolean } = {};
  try { body = await req.json(); } catch { /* empty */ }
  if (!body.id) return json(req, { ok: false, error: "missing id" }, 400);

  const db = createClient(SB_URL, SRK);
  const { data: row, error: rowErr } = await db.from("jag_screenings").select("*").eq("id", body.id).single();
  if (rowErr || !row) return json(req, { ok: false, error: "screening not found" }, 404);
  if (row.fub_status === "sent" && row.fub_person_id && !body.force) {
    return json(req, { ok: true, already: true, person_id: row.fub_person_id, created: row.fub_created, url: FUB_APP + row.fub_person_id });
  }

  // Clean up common copy-paste problems (spaces, line breaks, a pasted "Basic " prefix or trailing ":").
  const clean = (k: string) => String(k || "").trim().replace(/^basic\s+/i, "").replace(/:$/, "").trim();
  let key = clean(Deno.env.get("FUB_API_KEY") || "");
  if (!key) { const { data } = await db.rpc("jag_fub_key"); key = clean((data as string) || ""); }
  if (!key) return await fail("FUB key not set");

  const H = { Authorization: "Basic " + btoa(key + ":"), "Content-Type": "application/json", "X-System": "JAG-Screener" };
  async function fub(path: string, init: RequestInit = {}) {
    const r = await fetch(FUB + path, { ...init, headers: { ...H, ...(init.headers || {}) } });
    const t = await r.text();
    let j: any = null; try { j = t ? JSON.parse(t) : null; } catch { j = { raw: t.slice(0, 300) }; }
    if (!r.ok) throw new Error(`FUB ${init.method || "GET"} ${path.split("?")[0]} ${r.status}: ${(j && (j.errorMessage || j.raw)) || ""}`.slice(0, 300));
    return j;
  }
  async function fail(msg: string) {
    await db.from("jag_screenings").update({ fub_status: "error", fub_error: msg.slice(0, 400), fub_tries: (row.fub_tries || 0) + 1 }).eq("id", row.id);
    return json(req, { ok: false, error: msg }, 200);
  }

  try {
    const phone10 = String(row.phone || "").replace(/\D/g, "").slice(-10);
    const email = String(row.email || "").trim().toLowerCase();
    const laneName = LANE[row.lane] || "";
    const hot = row.hot === true;
    const tags = ["Screened", ...(laneName ? ["Ruta: " + laneName] : []), ...(hot ? ["Hot lead"] : []), "#starling_stop"];

    // 2. Find the client.
    let person: any = null;
    if (phone10.length === 10) {
      const r = await fub(`/people?phone=${phone10}&limit=1&fields=id,firstName,lastName,stage,assignedPondId`);
      person = (r.people || [])[0] || null;
    }
    if (!person && /@/.test(email)) {
      const r = await fub(`/people?email=${encodeURIComponent(email)}&limit=1&fields=id,firstName,lastName,stage,assignedPondId`);
      person = (r.people || [])[0] || null;
    }

    // 3. Create (unassigned, Calls pond, Applied or Hot Prospect) or tag the existing client.
    let created = false;
    if (!person) {
      const parts = String(row.client_name || "").trim().split(/\s+/).filter(Boolean);
      const p: any = {
        firstName: parts[0] || "Cliente", lastName: parts.slice(1).join(" ") || "",
        stage: hot ? STAGE_HOT : STAGE_NEW, source: SOURCE, tags, assignedPondId: CALLS_POND_ID,
      };
      if (phone10.length === 10) p.phones = [{ value: phone10, type: "mobile", isPrimary: true }];
      if (/@/.test(email)) p.emails = [{ value: email, type: "home", isPrimary: true }];
      person = await fub(`/people`, { method: "POST", body: JSON.stringify(p) });
      created = true;
      if (person && person.id && Number(person.assignedPondId) !== CALLS_POND_ID) {
        try { await fub(`/people/${person.id}`, { method: "PUT", body: JSON.stringify({ assignedPondId: CALLS_POND_ID }) }); } catch { /* keep going */ }
      }
    } else {
      // Keep their other tags, replace any older "Ruta: …" tag with the current one.
      const cur = await fub(`/people/${person.id}?fields=id,tags,stage`);
      const keep = ((cur && cur.tags) || []).filter((t: string) => !/^Ruta: /i.test(t) && !tags.includes(t));
      const upd: any = { tags: [...keep, ...tags] };
      if (hot && PROMOTE.includes(String((cur && cur.stage) || ""))) upd.stage = STAGE_HOT;
      await fub(`/people/${person.id}`, { method: "PUT", body: JSON.stringify(upd) });
    }
    const pid = Number(person.id);
    if (!pid) return await fail("FUB did not return a client id");

    // 4. Note with a link back to the screening.
    const es = row.lang !== "en";
    const link = `${SITE}/screener.html#s=${row.id}`;
    const subject = (hot ? "🔥 " : "") + (es ? "Screening de llamada – Ruta " : "Call screening – Route ") + (laneName || "");
    const noteBody = (row.note || "") + "\n\n" + (es ? "Ver screening completo y PDF: " : "Full screening and PDF: ") + link;
    await fub(`/notes`, { method: "POST", body: JSON.stringify({ personId: pid, subject, body: noteBody, isHtml: false }) });

    // 5. Follow-up task for the person who made the call (if a follow-up time was set).
    let task_id: number | null = null;
    if (row.follow_at) {
      let assignedUserId: number | undefined;
      try {
        const u = await fub(`/users?limit=100&fields=id,name`);
        const want = String(row.screener || "").toLowerCase().trim();
        const hit = (u.users || []).find((x: any) => want && String(x.name || "").toLowerCase().trim() === want)
          || (u.users || []).find((x: any) => want && String(x.name || "").toLowerCase().startsWith(want.split(" ")[0] + " "));
        if (hit) assignedUserId = Number(hit.id);
      } catch { /* task goes to the default owner */ }
      const due = new Date(row.follow_at);
      const dueDate = due.toLocaleDateString("en-CA", { timeZone: "America/Chicago" });
      const t: any = {
        personId: pid, type: "Follow Up", dueDate, dueDateTime: due.toISOString(),
        name: es ? "Seguimiento del screening: ¿llenó el enlace de evaluación?" : "Screening follow-up: did they fill out the evaluation link?",
      };
      if (assignedUserId) t.assignedUserId = assignedUserId;
      try { const tr = await fub(`/tasks`, { method: "POST", body: JSON.stringify(t) }); task_id = tr && tr.id ? Number(tr.id) : null; } catch { /* note is the important part */ }
    }

    await db.from("jag_screenings").update({
      fub_status: "sent", fub_person_id: pid, fub_created: created, fub_error: null,
      fub_tries: (row.fub_tries || 0) + 1, fub_sent_at: new Date().toISOString(),
    }).eq("id", row.id);

    // 6. One client, one row. Already sent the Home Loan application? Attach the screening to it.
    let app_lead_id: string | null = null;
    try { const { data } = await db.rpc("jag_attach_screening_to_app", { p_screening: row.id }); app_lead_id = (data as string) || null; } catch { /* keep going */ }

    // Otherwise hot screenings show up in the admin Leads list as type "Screened" so the loan team calls them first.
    if (hot && !app_lead_id) {
      try {
        const { data: dup } = await db.from("jag_leads").select("id").eq("type", "Screened").contains("payload", { "Screening ID": String(row.id) }).limit(1);
        if (!dup || !dup.length) {
          const A = row.answers || {};
          const money = (n: number) => "$" + Math.round(n).toLocaleString("en-US");
          const payload: Record<string, unknown> = {
            "Screening ID": String(row.id), "Screening": link, "Screened By": row.screener || "",
            "Readiness": row.score != null ? row.score + "%" : "", "Route": laneName,
            "Est. Buying Power (Screener)": row.est_max ? money(row.est_max) : "",
            "Combined Monthly Income": A.calc_monthly ? String(A.calc_monthly) : "",
            "Monthly Debts": A.calc_debts != null ? String(A.calc_debts) : "",
            "Savings": A.savings ? String(A.savings) : "", "Area": A.area || "", "Buying": A.when || "",
            "Follow Up Boss": FUB_APP + pid, "Call notes": row.note || "",
          };
          Object.keys(payload).forEach((k) => { if (payload[k] === "" || payload[k] == null) delete payload[k]; });
          await db.from("jag_leads").insert({
            type: "Screened", name: row.client_name || "", email: row.email || null, phone: row.phone || null,
            lang: row.lang === "en" ? "English" : "Español", source: "Call screener" + (row.screener ? " · " + row.screener : ""),
            status: "New", est_amount: row.est_max || null, payload,
          });
        }
      } catch { /* the FUB part already worked */ }
    }

    return json(req, { ok: true, person_id: pid, created, task_id, app_lead_id, url: FUB_APP + pid });
  } catch (e) {
    return await fail(String((e as Error).message || e));
  }
});
