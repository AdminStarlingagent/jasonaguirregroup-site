// fub-sync: Follow Up Boss <-> JAG Contacts (phase 2 of the CRM).
//
// Auth: x-jag-token (the database: cron every 5 minutes + a kick right after an agent saves something)
//       or x-jag-ops-secret (manual runs: the first import, checks).
//
//   ?action=push                       send queued workspace changes to FUB: stage, assignment, notes, call logs, text logs
//   ?action=sync                       push, then pull everyone FUB changed since the last run (+ stages and ponds)
//   ?action=import&stage=<name>[&next] one page (100 people) of the first import; returns { next } to continue.
//                                      Stage "Lead" stops at leads created more than 180 days ago ("active only").
//   ?action=meta                       refresh stages and ponds
//   ?action=get&path=/...              read-only look at FUB (ops secret only)
//
// Which FUB people live in Contacts ("active only"): anyone already there, anyone in a working stage (not Lead / Trash),
// and leads created in the last 180 days. Trash marks an existing contact as deleted.
import { createClient } from "jsr:@supabase/supabase-js@2";

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SRK = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const FUB = "https://api.followupboss.com/v1";
const OFFICE = "8327023574";
const DAYS = 180;
const FIELDS = [
  "id", "name", "firstName", "lastName", "emails", "phones", "stage", "stageId", "source", "tags", "background", "price",
  "assignedUserId", "assignedPondId", "created", "updated", "lastActivity", "lastCommunication", "lastCall", "contacted", "collaborators",
].join(",");

type Row = Record<string, unknown>;
type Person = { id: number; stage?: string; created?: string; updated?: string } & Row;

const db = createClient(SB_URL, SRK, { auth: { persistSession: false } });
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let FH: Record<string, string> | null = null;
async function fubHeaders() {
  if (FH) return FH;
  const clean = (k: string) => String(k || "").trim().replace(/^basic\s+/i, "").replace(/:$/, "").trim();
  let key = clean(Deno.env.get("FUB_API_KEY") || "");
  if (!key) { const { data } = await db.rpc("jag_fub_key"); key = clean((data as string) || ""); }
  FH = { Authorization: "Basic " + btoa(key + ":"), "Content-Type": "application/json", "X-System": "JAG-Admin" };
  return FH;
}
async function fub(path: string, init: RequestInit = {}): Promise<{ ok: boolean; status: number; body: Row }> {
  const h = await fubHeaders();
  for (let i = 0; i < 4; i++) {
    const r = await fetch(FUB + path, { ...init, headers: { ...h, ...(init.headers || {}) } });
    if (r.status === 429) { await sleep(Math.min(10, Number(r.headers.get("Retry-After")) || 3) * 1000); continue; }
    const t = await r.text();
    let body: Row = {};
    try { body = t ? JSON.parse(t) : {}; } catch { body = { raw: t.slice(0, 300) }; }
    return { ok: r.ok, status: r.status, body };
  }
  return { ok: false, status: 429, body: { error: "rate limited" } };
}

/* ---------- meta ---------- */
async function meta() {
  const [s, p] = await Promise.all([fub("/stages?limit=100"), fub("/ponds?limit=100")]);
  if (!s.ok || !p.ok) return { ok: false, stages: s.status, ponds: p.status };
  const { error } = await db.rpc("jag_fub_meta", { p_stages: s.body.stages || [], p_ponds: p.body.ponds || [] });
  return { ok: !error, error: error?.message, stages: (s.body.stages as Row[] || []).length, ponds: (p.body.ponds as Row[] || []).length };
}

/* ---------- people -> contacts ---------- */
const cutoff = () => Date.now() - DAYS * 86400e3;
async function keepActive(people: Person[]) {
  if (!people.length) return [];
  const ids = people.map((p) => p.id);
  const { data } = await db.from("jag_contacts").select("fub_id").in("fub_id", ids);
  const have = new Set((data || []).map((r: Row) => Number(r.fub_id)));
  const min = cutoff();
  return people.filter((p) => have.has(p.id) ||
    (p.stage !== "Trash" && (p.stage !== "Lead" || Date.parse(String(p.created || "")) >= min)));
}
// FUB gives some "last ..." fields as objects ({ id, date, type, content, direction }): keep the date
const when = (v: unknown) => (v && typeof v === "object" ? ((v as Row).date as string) || null : (v as string) || null);
async function upsert(raw: Person[]) {
  const people = raw.map((p) => ({ ...p, lastCommunication: when(p.lastCommunication), lastActivity: when(p.lastActivity) }));
  let inserted = 0, updated = 0;
  for (let i = 0; i < people.length; i += 50) {
    const { data, error } = await db.rpc("jag_fub_upsert", { p_people: people.slice(i, i + 50) });
    if (error) throw new Error("upsert: " + error.message);
    inserted += Number((data as Row)?.inserted || 0); updated += Number((data as Row)?.updated || 0);
  }
  // when they were last called (the Today list and "no call in N days" lists use it)
  const calls = raw.map((p) => ({ id: p.id, at: when(p.lastCall) })).filter((x) => x.at);
  if (calls.length) await db.rpc("jag_fub_calls", { p: calls });
  return { inserted, updated };
}

async function getState(k: string): Promise<Row> {
  const { data } = await db.from("jag_fub_sync_state").select("v").eq("k", k).maybeSingle();
  return ((data as Row | null)?.v as Row) || {};
}
async function setState(k: string, v: Row) {
  await db.from("jag_fub_sync_state").upsert({ k, v, updated_at: new Date().toISOString() });
}

async function importPage(stage: string, next: string | null) {
  if (!stage) return { ok: false, error: "stage" };
  const st = await getState("pull");
  if (!st.cursor) await setState("pull", { cursor: new Date(Date.now() - 5 * 60e3).toISOString() });
  const q = `/people?stage=${encodeURIComponent(stage)}&limit=100&sort=-created&fields=${FIELDS}` + (next ? `&next=${encodeURIComponent(next)}` : "");
  const r = await fub(q);
  if (!r.ok) return { ok: false, status: r.status, body: r.body };
  const people = (r.body.people || []) as Person[];
  const md = (r.body._metadata || {}) as Row;
  const kept = await keepActive(people);
  const res = await upsert(kept);
  // leads come newest first: once a page reaches leads older than 180 days, the rest are older too
  const old = stage === "Lead" && people.some((p) => Date.parse(String(p.created || "")) < cutoff());
  return { ok: true, stage, got: people.length, kept: kept.length, ...res, total: md.total, next: old ? null : (md.next || null) };
}

async function pull() {
  const st = await getState("pull");
  const since = st.cursor ? Date.parse(String(st.cursor)) - 2 * 60e3 : Date.now() - 10 * 60e3;
  let next: string | null = null, newest = 0, pages = 0, got = 0;
  const all: Person[] = [];
  while (pages < 15) {
    const r = await fub(`/people?limit=100&sort=-updated&fields=${FIELDS}` + (next ? `&next=${encodeURIComponent(next)}` : ""));
    if (!r.ok) return { ok: false, status: r.status, pages };
    pages++;
    const people = (r.body.people || []) as Person[];
    let done = !people.length;
    for (const p of people) {
      const u = Date.parse(String(p.updated || ""));
      if (u > newest) newest = u;
      if (u < since) { done = true; break; }
      all.push(p); got++;
    }
    next = ((r.body._metadata || {}) as Row).next as string || null;
    if (done || !next) break;
  }
  const kept = await keepActive(all);
  const res = await upsert(kept);
  if (newest) await setState("pull", { cursor: new Date(newest).toISOString() });
  return { ok: true, pages, changed: got, kept: kept.length, ...res };
}

/* ---------- workspace -> FUB ---------- */
const OUTCOME: Record<string, string> = { voicemail: "Left Message", noanswer: "No Answer", bad: "Bad Number", busy: "Busy" };
const digits = (s: unknown) => { const d = String(s || "").replace(/\D/g, ""); return d.length === 11 && d[0] === "1" ? d.slice(1) : d; };

async function push() {
  // claimed atomically in the database, so two kicks at the same moment never send the same change twice
  const { data: claimed } = await db.rpc("jag_fub_out_claim", { p_limit: 60 });
  const rows = ((claimed || []) as Row[]).sort((a, b) => Number(a.id) - Number(b.id));
  if (!rows.length) return { ok: true, sent: 0, failed: 0 };
  const cids = [...new Set(rows.map((r: Row) => r.contact_id as string))];
  const codes = [...new Set(rows.map((r: Row) => r.by_code as string).filter(Boolean))];
  const [{ data: cs }, { data: ags }] = await Promise.all([
    db.from("jag_contacts").select("id, fub_id, phone, name").in("id", cids),
    codes.length ? db.from("jag_agents").select("code, fub_user_id, phone, name").in("code", codes) : Promise.resolve({ data: [] as Row[] }),
  ]);
  const C = new Map((cs || []).map((c: Row) => [c.id as string, c]));
  const A = new Map((ags || []).map((a: Row) => [a.code as string, a]));
  let sent = 0, failed = 0;
  for (const o of rows as Row[]) {
    const c = C.get(o.contact_id as string) || {};
    const a = A.get(o.by_code as string) || {};
    const pid = Number(o.fub_id || c.fub_id);
    const pl = (o.payload || {}) as Row;
    const m = (pl.meta || {}) as Row;
    const who = String(pl.who || a.name || "JAG team");
    const body = String(pl.body || "");
    const phone = digits(c.phone);
    const uid = a.fub_user_id ? Number(a.fub_user_id) : undefined;
    let r: { ok: boolean; status: number; body: Row };
    const note = (subject: string, text: string) =>
      fub("/notes", { method: "POST", body: JSON.stringify({ personId: pid, subject, body: text, isHtml: false }) });
    if (o.kind === "stage") r = await fub(`/people/${pid}`, { method: "PUT", body: JSON.stringify({ stage: pl.stage }) });
    else if (o.kind === "assign") r = await fub(`/people/${pid}`, { method: "PUT", body: JSON.stringify({ assignedUserId: Number(pl.user) }) });
    else if (o.kind === "note") r = await note(`Note from ${who} (JAG workspace)`, body);
    else if (o.kind === "call") {
      r = phone
        ? await fub("/calls", { method: "POST", body: JSON.stringify({ personId: pid, phone, isIncoming: false, note: body || undefined,
            outcome: OUTCOME[String(m.outcome || "")] || undefined, userId: uid }) })
        : await note(`Call logged by ${who} (JAG workspace)`, body);
      if (!r.ok && phone) r = await note(`Call logged by ${who} (JAG workspace)` + (m.outcome ? ` · ${m.outcome}` : ""), body);
    } else if (o.kind === "text") {
      const wa = m.via === "whatsapp";
      r = phone && !wa
        ? await fub("/textMessages", { method: "POST", body: JSON.stringify({ personId: pid, message: body, toNumber: phone,
            fromNumber: digits(a.phone) || OFFICE, isIncoming: false, userId: uid }) })
        : await note(`${wa ? "WhatsApp" : "Text"} sent by ${who} (JAG workspace)`, body);
      if (!r.ok && phone && !wa) r = await note(`Text sent by ${who} (JAG workspace)`, body);
    } else r = { ok: false, status: 400, body: { error: "kind" } };
    if (r.ok) {
      sent++;
      await db.from("jag_fub_out").update({ sent_at: new Date().toISOString(), error: null, tries: Number(o.tries || 0) + 1 }).eq("id", o.id);
    } else {
      failed++;
      const permanent = r.status >= 400 && r.status < 500 && r.status !== 429;
      await db.from("jag_fub_out").update({ tries: permanent ? 9 : Number(o.tries || 0) + 1, claimed_at: null,
        error: (r.status + " " + JSON.stringify(r.body)).slice(0, 500) }).eq("id", o.id);
    }
  }
  return { ok: true, sent, failed };
}

/* ---------- entry ---------- */
Deno.serve(async (req) => {
  const tok = req.headers.get("x-jag-token") || "";
  const ops = req.headers.get("x-jag-ops-secret") || "";
  let byOps = false;
  if (ops) { const { data } = await db.rpc("jag_ops_secret"); byOps = !!data && ops === String(data); }
  let ok = byOps;
  if (!ok && tok) { const { data } = await db.rpc("jag_alerts_token_ok", { p_token: tok }); ok = data === true; }
  if (!ok) return new Response("no", { status: 403 });

  const u = new URL(req.url);
  const action = u.searchParams.get("action") || (u.searchParams.get("path") ? "get" : "sync");
  try {
    if (action === "push") return json(await push());
    if (action === "meta") return json(await meta());
    if (action === "import") return json(await importPage(u.searchParams.get("stage") || "", u.searchParams.get("next")));
    if (action === "sync") {
      const p = await push();
      const st = await getState("meta");
      const m = !st.at || Date.now() - Date.parse(String(st.at)) > 6 * 3600e3 ? await meta() : null;
      if (m?.ok) await setState("meta", { at: new Date().toISOString() });
      const l = await pull();
      return json({ ok: true, push: p, meta: m, pull: l });
    }
    if (action === "get" && byOps) {
      const path = u.searchParams.get("path") || "/stages";
      if (!/^\/(stages|users|ponds|people|smartLists|customFields|identity|groups|notes|calls|textMessages)(\b|\?|\/)/.test(path)) return json({ error: "path" }, 400);
      const r = await fub(path);
      return json(r.body, r.status);
    }
    return json({ error: "action" }, 400);
  } catch (e) {
    return json({ ok: false, error: String((e as Error)?.message || e) }, 500);
  }
});
