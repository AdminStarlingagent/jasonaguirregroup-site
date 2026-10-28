// jag-app-fub — a Home Loan application (jag_leads, type "Mortgage Application") → Follow Up Boss stage "Applied".
// Called by the database right after an application lands (trigger jag_leads_app_to_fub → x-jag-token), and in batches
// to catch up older applications. Body: { id } | { backfill: true, limit?, dry? }.
//   Finds the client by phone, then email.
//   Found in an early stage (Lead, Nurture, Attempted contact…) → moves to Applied. Already Applied or further along
//     (Hot Prospect, Pre-approved, Under contract, Closed…) → stage left alone.
//   Not found → created UNASSIGNED in the Calls pond, stage Applied, source "JAG Home App", tagged #starling_stop
//     (the team calls applicants; the Starling AI agent shouldn't double message them).
//   New applications also get a "JAG Home App" tag and a note with the loan basics (never SSN, date of birth or address).
//   Catch-up: clients a teammate already moved to Applied or further are skipped entirely (no tag, no note).
import { createClient } from "npm:@supabase/supabase-js@2";

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SRK = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const FUB = "https://api.followupboss.com/v1";
const FUB_APP = "https://jasonhoustonrealty.followupboss.com/2/people/view/";
const CALLS_POND_ID = 2;
const STAGE = "Applied";
// Same early stages the call screener promotes from; anything else is Applied or further along and is left alone.
const EARLY = ["Lead", "Nurture", "Attempted contact", "Spoke with customer", "Unresponsive", "Trash", "2027 Follow-up", "Credit Lead", "Out Of Town", "Sphere"];
// Catch-up of older applications only moves clients still in these default stages; stages a teammate picked on purpose
// (2027 Follow-up, Credit Lead, Nurture…) were "moved manually" and stay as they are.
const CATCHUP = ["Lead", "Attempted contact", "Spoke with customer", "Unresponsive"];
const SOURCE = "JAG Home App";
const TAG = "JAG Home App";
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { "Content-Type": "application/json" } });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Only these application answers go into the FUB note.
const NOTE_KEYS = ["Loan Goal", "Qualifying With", "Work Status", "Gross Monthly Income", "Monthly Debts", "Co-borrower", "Employer", "Job Title",
  "Pay Type", "Pay Rate", "Hours per Week", "Job Start Year", "Own or Rent", "Monthly Rent", "Timeline to Buy", "Credit Range (self-reported)", "Preferred Language"];

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ ok: false, error: "POST only" }, 405);
  const db = createClient(SB_URL, SRK);
  const { data: tokOk } = await db.rpc("jag_alerts_token_ok", { p_token: req.headers.get("x-jag-token") || "" });
  if (tokOk !== true) return json({ ok: false, error: "forbidden" }, 403);
  let b: any = {}; try { b = await req.json(); } catch { /* empty */ }

  const clean = (k: string) => String(k || "").trim().replace(/^basic\s+/i, "").replace(/:$/, "").trim();
  let key = clean(Deno.env.get("FUB_API_KEY") || "");
  if (!key) { const { data } = await db.rpc("jag_fub_key"); key = clean((data as string) || ""); }
  if (!key) return json({ ok: false, error: "FUB key not set" });
  const H = { Authorization: "Basic " + btoa(key + ":"), "Content-Type": "application/json", "X-System": "JAG-Website" };
  async function fub(path: string, init: RequestInit = {}) {
    for (let a = 0; a < 3; a++) {
      const r = await fetch(FUB + path, { ...init, headers: { ...H, ...(init.headers || {}) } });
      if (r.status === 429) { await sleep(2000 * (a + 1)); continue; }
      const t = await r.text();
      let j: any = null; try { j = t ? JSON.parse(t) : null; } catch { j = { raw: t.slice(0, 300) }; }
      if (!r.ok) throw new Error(`FUB ${init.method || "GET"} ${path.split("?")[0]} ${r.status}: ${(j && (j.errorMessage || j.raw)) || ""}`.slice(0, 300));
      return j;
    }
    throw new Error("FUB rate limit");
  }

  async function one(lead: any, catchUp: boolean, dry: boolean) {
    const p = lead.payload || {};
    const phone10 = String(lead.phone || p.Phone || "").replace(/\D/g, "").slice(-10);
    const email = String(lead.email || p.Email || "").trim().toLowerCase();
    let person: any = null;
    if (phone10.length === 10) person = ((await fub(`/people?phone=${phone10}&limit=1&fields=id,stage,tags`)).people || [])[0] || null;
    if (!person && /@/.test(email)) person = ((await fub(`/people?email=${encodeURIComponent(email)}&limit=1&fields=id,stage,tags`)).people || [])[0] || null;
    const was = person ? String(person.stage || "") : "";
    const early = !person || (catchUp ? CATCHUP : EARLY).includes(was);
    let action = !person ? "created" : early ? "moved" : "left";
    if (catchUp && person && !early) return { id: lead.id, action: "skipped", stage: was, person: person.id };
    if (dry) return { id: lead.id, action: dry ? "would_" + action : action, stage: was, person: person && person.id };

    if (!person) {
      const first = String(p["First Name"] || "").trim(), last = String(p["Last Name"] || "").trim();
      const parts = String(lead.name || "").trim().split(/\s+/).filter(Boolean);
      const np: any = { firstName: first || parts[0] || "Cliente", lastName: last || parts.slice(1).join(" "), stage: STAGE, source: SOURCE,
        tags: [TAG, "#starling_stop"], assignedPondId: CALLS_POND_ID };
      if (phone10.length === 10) np.phones = [{ value: phone10, type: "mobile", isPrimary: true }];
      if (/@/.test(email)) np.emails = [{ value: email, type: "home", isPrimary: true }];
      person = await fub(`/people`, { method: "POST", body: JSON.stringify(np) });
      if (person && person.id && Number(person.assignedPondId) !== CALLS_POND_ID) {
        try { await fub(`/people/${person.id}`, { method: "PUT", body: JSON.stringify({ assignedPondId: CALLS_POND_ID }) }); } catch { /* keep going */ }
      }
    } else {
      const tags: string[] = (person.tags || []).slice();
      const upd: any = {};
      if (!tags.includes(TAG)) upd.tags = [...tags, TAG];
      if (early) upd.stage = STAGE;
      if (Object.keys(upd).length) await fub(`/people/${person.id}`, { method: "PUT", body: JSON.stringify(upd) });
    }
    const pid = Number(person && person.id);
    if (!pid) throw new Error("FUB did not return a client id");

    // note with the loan basics
    const when = new Date(lead.created_at).toLocaleString("en-US", { timeZone: "America/Chicago", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
    const est = lead.est_amount ? "$" + Math.round(lead.est_amount).toLocaleString("en-US") : (p["Estimate Shown to Client"] || "");
    const lines = [
      `Sent the JAG Home Loan application on ${when}${lead.source ? " (" + lead.source + ")" : ""}.`,
      est ? `Est. buying power: ${est}` : "",
      ...NOTE_KEYS.filter((k) => p[k] != null && String(p[k]).trim() !== "").map((k) => `${k}: ${String(p[k]).slice(0, 120)}`),
      action === "moved" ? `Stage: ${was || "none"} → Applied.` : action === "left" ? `Stage left as ${was}.` : "New in Follow Up Boss: Calls pond, stage Applied.",
      "Full application: jasonaguirregroup.company/admin (Loan apps).",
    ].filter(Boolean);
    await fub(`/notes`, { method: "POST", body: JSON.stringify({ personId: pid, subject: "🏠 JAG Home Loan application", body: lines.join("\n"), isHtml: false }) });

    // remember it on the application
    const payload = { ...p, "Follow Up Boss": FUB_APP + pid };
    await db.from("jag_leads").update({ payload, fub_app_at: new Date().toISOString(), fub_app_result: action + (was ? " (" + was + ")" : "") }).eq("id", lead.id);
    return { id: lead.id, action, stage: was, person: pid };
  }

  const cols = "id,created_at,type,name,email,phone,status,source,est_amount,payload,fub_app_at";
  try {
    if (b.id) {
      const { data: lead } = await db.from("jag_leads").select(cols).eq("id", b.id).single();
      if (!lead || lead.type !== "Mortgage Application" || lead.status === "Merged") return json({ ok: false, error: "not an application" });
      if (lead.fub_app_at && !b.force) return json({ ok: true, already: true });
      try { return json({ ok: true, ...(await one(lead, false, false)) }); }
      catch (e) { await db.from("jag_leads").update({ fub_app_result: "error: " + String((e as Error).message).slice(0, 200) }).eq("id", lead.id); return json({ ok: false, error: String((e as Error).message) }); }
    }
    if (b.backfill) {
      const limit = Math.min(Math.max(Number(b.limit) || 15, 1), 40), dry = b.dry === true;
      const { data: all } = await db.from("jag_leads").select(cols + ",fub_app_result").eq("type", "Mortgage Application").is("fub_app_at", null)
        .order("created_at", { ascending: true }).limit(500);
      const leads = (all || []).filter((l: any) => l.status !== "Merged" && !/^skipped/.test(String(l.fub_app_result || ""))).slice(0, dry ? 500 : limit);
      const out: any[] = [];
      for (const lead of leads) {
        try {
          const r = await one(lead, true, dry);
          if (!dry && r.action === "skipped") await db.from("jag_leads").update({ fub_app_result: "skipped (" + r.stage + ")", payload: { ...(lead.payload || {}), "Follow Up Boss": FUB_APP + r.person } }).eq("id", lead.id);
          out.push(r);
        } catch (e) {
          out.push({ id: lead.id, action: "error", error: String((e as Error).message).slice(0, 160) });
          if (!dry) await db.from("jag_leads").update({ fub_app_result: "error: " + String((e as Error).message).slice(0, 200) }).eq("id", lead.id);
        }
        await sleep(dry ? 80 : 250);
      }
      const tally: Record<string, number> = {};
      out.forEach((r) => { const k = r.action + (r.stage && r.action !== "error" ? " · " + r.stage : ""); tally[k] = (tally[k] || 0) + 1; });
      return json({ ok: true, done: out.length, tally, errors: out.filter((r) => r.action === "error") });
    }
    return json({ ok: false, error: "id or backfill required" }, 400);
  } catch (e) { return json({ ok: false, error: String((e as Error).message) }); }
});
