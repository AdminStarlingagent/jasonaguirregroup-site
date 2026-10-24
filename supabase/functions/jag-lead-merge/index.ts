// jag-lead-merge — one client, one row. Team sign-ins only (or the server token, for checks).
// Merges a call screening ("Screened" lead) into the client's Home Loan application in the admin (jag_merge_leads),
// then updates the client in Follow Up Boss: adds the email from the application, tags "Mortgage app",
// optionally uses the name on the application (often the legal name), and leaves a note with both names.
//   { keep, drop, preview: true }            → what would happen (no changes)
//   { keep, drop, use_app_name: true|false } → merge
import { createClient } from "jsr:@supabase/supabase-js@2";

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SRK = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
const FUB = "https://api.followupboss.com/v1";
const FUB_PERSON = "https://jasonhoustonrealty.followupboss.com/2/people/view/";
const SITE = "https://jasonaguirregroup.company";
const ALLOWED = [SITE, "https://www.jasonaguirregroup.company", "http://localhost:8080", "http://127.0.0.1:8765"];

function cors(req: Request) {
  const o = req.headers.get("origin") || "";
  return { "Access-Control-Allow-Origin": ALLOWED.includes(o) ? o : SITE, "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info, x-jag-token", "Access-Control-Allow-Methods": "POST, OPTIONS", "Vary": "Origin" };
}
const json = (req: Request, body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors(req), "Content-Type": "application/json" } });
const last10 = (v: unknown) => String(v || "").replace(/\D/g, "").slice(-10);
const clean = (k: string) => String(k || "").trim().replace(/^basic\s+/i, "").replace(/:$/, "").trim();

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors(req) });
  if (req.method !== "POST") return json(req, { ok: false, error: "POST only" }, 405);
  const db = createClient(SB_URL, SRK);
  const userDb = createClient(SB_URL, ANON, { global: { headers: { Authorization: req.headers.get("Authorization") || "" } } });

  const tok = req.headers.get("x-jag-token") || "";
  let viaToken = false, allowed = false;
  if (tok) { const { data } = await db.rpc("jag_alerts_token_ok", { p_token: tok }); viaToken = allowed = data === true; }
  if (!allowed) { const { data } = await userDb.rpc("jag_is_team"); allowed = data === true; }
  if (!allowed) return json(req, { ok: false, error: "not_team" }, 403);

  let b: any = {}; try { b = await req.json(); } catch { /* empty */ }
  if (!b.keep || !b.drop) return json(req, { ok: false, error: "keep and drop are required" }, 400);

  const { data: rows } = await db.from("jag_leads").select("*").in("id", [b.keep, b.drop]);
  const keep = (rows || []).find((r: any) => r.id === b.keep), drop = (rows || []).find((r: any) => r.id === b.drop);
  if (!keep || !drop) return json(req, { ok: false, error: "not_found" }, 404);
  const sid = (drop.payload || {})["Screening ID"] || (keep.payload || {})["Screening ID"] || null;
  const { data: scr } = sid ? await db.from("jag_screenings").select("id,screener,client_name,fub_person_id,score").eq("id", sid).maybeSingle() : { data: null };
  const kp = keep.payload || {};
  const appName = [kp["First Name"], kp["Middle Name"], kp["Last Name"]].filter((x: string) => x && String(x).trim()).join(" ").trim() || keep.name || "";

  // Follow Up Boss
  let key = clean(Deno.env.get("FUB_API_KEY") || "");
  if (!key) { const { data } = await db.rpc("jag_fub_key"); key = clean((data as string) || ""); }
  const H = { Authorization: "Basic " + btoa(key + ":"), "Content-Type": "application/json", "X-System": "JAG-Admin" };
  const fub = async (path: string, init: RequestInit = {}) => {
    const r = await fetch(FUB + path, { ...init, headers: H });
    const t = await r.text(); let j: any = null; try { j = t ? JSON.parse(t) : null; } catch { j = null; }
    if (!r.ok) throw new Error(`FUB ${init.method || "GET"} ${path.split("?")[0]} ${r.status}`);
    return j;
  };
  const F = "id,firstName,lastName,name,emails,phones,stage,tags,assignedTo";
  const findBy = async (q: string) => { try { return ((await fub(`/people?${q}&limit=5&fields=${F}`)).people || []); } catch { return []; } };

  let person: any = null; const others: any[] = [];
  try {
    const pid = scr?.fub_person_id || Number(String(kp["Follow Up Boss"] || (drop.payload || {})["Follow Up Boss"] || "").split("/").pop()) || null;
    if (pid) person = await fub(`/people/${pid}?fields=${F}`);
  } catch { person = null; }
  const byPhone = last10(keep.phone || drop.phone).length === 10 ? await findBy("phone=" + last10(keep.phone || drop.phone)) : [];
  const email = String(keep.email || drop.email || "").trim().toLowerCase();
  const byEmail = /@/.test(email) ? await findBy("email=" + encodeURIComponent(email)) : [];
  if (!person) person = byPhone[0] || byEmail[0] || null;
  for (const p of [...byPhone, ...byEmail]) if (person && p.id !== person.id && !others.some((o) => o.id === p.id)) others.push(p);
  const summary = (p: any) => p && { id: p.id, name: p.name || [p.firstName, p.lastName].filter(Boolean).join(" "), stage: p.stage, assigned: p.assignedTo,
    emails: (p.emails || []).map((e: any) => e.value), url: FUB_PERSON + p.id };

  const plan = { keep: { id: keep.id, type: keep.type, name: keep.name, app_name: appName, email: keep.email },
    drop: { id: drop.id, type: drop.type, name: drop.name, status: drop.status }, screening: scr,
    fub: summary(person), fub_duplicates: others.map(summary),
    names_differ: appName.toLowerCase() !== String(person?.name || drop.name || "").toLowerCase() };
  if (b.preview) return json(req, { ok: true, preview: true, ...plan });

  // 1) the admin rows
  const merger = viaToken ? db : userDb;
  const { data: m, error: mErr } = await merger.rpc("jag_merge_leads", { p_keep: keep.id, p_drop: drop.id });
  if (mErr || !m || !(m as any).ok) return json(req, { ok: false, error: (m as any)?.reason || mErr?.message || "merge_failed", ...plan }, 200);

  // 2) Follow Up Boss
  const done: string[] = []; let fubError: string | null = null;
  if (person) {
    try {
      const upd: any = { tags: ["Mortgage app"] };
      const have = (person.emails || []).map((e: any) => String(e.value || "").toLowerCase());
      if (/@/.test(email) && !have.includes(email)) { upd.emails = [...(person.emails || []).map((e: any) => ({ value: e.value, type: e.type, isPrimary: e.isPrimary })), { value: email, type: "home" }]; done.push("added email " + email); }
      const oldName = person.name || [person.firstName, person.lastName].filter(Boolean).join(" ");
      if (b.use_app_name && appName && plan.names_differ) {
        const fn = String(kp["First Name"] || appName.split(" ")[0] || "").trim();
        const ln = [kp["Middle Name"], kp["Last Name"]].filter((x: string) => x && String(x).trim()).join(" ").trim() || appName.split(" ").slice(1).join(" ");
        if (fn) upd.firstName = fn; if (ln) upd.lastName = ln;
        done.push(`name ${oldName} → ${appName}`);
      }
      await fub(`/people/${person.id}?mergeTags=true`, { method: "PUT", body: JSON.stringify(upd) });
      done.push("tagged Mortgage app");
      const lines = [
        "One client: the call screening" + (scr?.screener ? " (by " + scr.screener + ")" : "") + " and the Home Loan application are now one record in the JAG admin.",
        plan.names_differ ? `Name on the loan application: ${appName}${b.use_app_name ? " (now the name on this contact)" : ""}. Name from the call: ${drop.name || oldName}. The application name may be the legal name.` : "",
        /@/.test(email) ? "Email from the application: " + email : "",
        others.length ? "Possible duplicate contact(s) in FUB: " + others.map((o) => FUB_PERSON + o.id).join(" , ") + " (merge them in FUB)" : "",
        SITE + "/admin.html",
      ].filter(Boolean).join("\n");
      await fub(`/notes`, { method: "POST", body: JSON.stringify({ personId: person.id, subject: "Screening + loan application merged", body: lines, isHtml: false }) });
      done.push("added a note");
      if (!kp["Follow Up Boss"]) await db.from("jag_leads").update({ payload: { ...(m as any).keep_payload, "Follow Up Boss": FUB_PERSON + person.id } }).eq("id", keep.id);
    } catch (e) { fubError = String((e as Error).message || e); }
  }
  return json(req, { ok: true, merged: true, fub_done: done, fub_error: fubError, ...plan });
});
