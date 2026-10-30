// jag-appointments — every client appointment in one place, both ways with Follow Up Boss.
//   POST {action:'sync'}    x-jag-token (pg_cron every 10 min): FUB appointments from 60 days ago to 60 days ahead → jag_appointments;
//                           then, for appointments that already happened, what the team did after (calls, texts, notes);
//                           then Lola's reminders / nudges (jag_appts_tick) and client reminder emails.
//   POST {action:'outcome', id, outcome_id, note}     team login: sets the outcome in FUB + a note, here too.
//   POST {action:'create', contact_id, start, minutes, type_id, location, note, invite:'owner'|'team'}
//                                                      team login: books it in FUB (client + agent invited) + a note, here too.
//   POST {action:'refresh', id}                         team login: re-checks one appointment's follow-up now.
import { createClient } from "jsr:@supabase/supabase-js@2";

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SRK = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
const RESEND = Deno.env.get("RESEND_API_KEY") || "";
const FROM = Deno.env.get("ALERTS_FROM") || "Jason Aguirre Group <alerts@updates.jasonhoustonrealty.com>";
const FUB = "https://api.followupboss.com/v1";
const SITE = "https://jasonaguirregroup.company";
const ALLOWED = ["https://jasonaguirregroup.company", "https://www.jasonaguirregroup.company"];
const OUTCOMES: Record<number, string> = { 1: "No show", 2: "Working with buyers", 3: "Listing obtained", 4: "Application Submitted" };
const TYPES: Record<number, string> = { 1: "Buyer consultation", 2: "Listing" };
type Row = Record<string, any>;

function cors(req: Request) {
  const o = req.headers.get("origin") || "";
  return { "Access-Control-Allow-Origin": ALLOWED.includes(o) ? o : SITE, "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info, x-jag-token",
    "Access-Control-Allow-Methods": "POST, OPTIONS", "Vary": "Origin" };
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let FH: Record<string, string> = {};
async function fub(path: string, init: RequestInit = {}): Promise<any> {
  for (let i = 0; i < 4; i++) {
    const r = await fetch(FUB + path, { ...init, headers: { ...FH, ...(init.headers || {}) } });
    if (r.status === 429) { await sleep(1500 * (i + 1)); continue; }
    const t = await r.text();
    let j: any = null; try { j = JSON.parse(t); } catch { j = { raw: t.slice(0, 300) }; }
    if (!r.ok) throw new Error(`FUB ${r.status} ${path.split("?")[0]}: ${(j && (j.errorMessage || j.raw)) || ""}`.slice(0, 300));
    return j;
  }
  throw new Error("FUB rate limit");
}

// notes our own automations write (they don't count as a person following up)
const AUTO_NOTE = /^(AI Conversation|Conversaci|Cita de Starling|Starling CRM|Showing request \(website\)|Website|JAG (Website|email|Agent Hub booking)|Lola|Email bounced|Marked a JAG email)/i;

function toRow(a: Row, contacts: Map<number, Row>, opsOwner: Map<number, number>) {
  const inv = Array.isArray(a.invitees) ? a.invitees : [];
  const persons = inv.filter((x: Row) => x.personId).map((x: Row) => Number(x.personId));
  const users = [...new Set(inv.filter((x: Row) => x.userId).map((x: Row) => Number(x.userId)))];
  const p = persons[0];
  const c = p ? contacts.get(p) : null;
  // owner: the client's assigned agent if invited; else FUB intake's pick; else the only teammate invited; else who booked it
  let owner: number | null = null;
  if (c && c.assigned_fub_user && users.includes(Number(c.assigned_fub_user))) owner = Number(c.assigned_fub_user);
  else if (opsOwner.has(Number(a.id))) owner = opsOwner.get(Number(a.id))!;
  else if (users.length === 1) owner = users[0];
  else if (c && c.assigned_fub_user) owner = Number(c.assigned_fub_user);
  else owner = a.createdById ? Number(a.createdById) : (users[0] || null);
  const pname = (inv.find((x: Row) => x.personId) || {}).name || null;
  return {
    fub_id: Number(a.id), title: String(a.title || "").slice(0, 200), description: String(a.description || "").slice(0, 2000) || null,
    start_at: a.start, end_at: a.end || null, all_day: !!a.allDay, location: String(a.location || "").slice(0, 200) || null,
    type: a.type || (a.typeId ? TYPES[a.typeId] || null : null), outcome: a.outcome || (a.outcomeId ? OUTCOMES[a.outcomeId] || null : null),
    outcome_id: a.outcomeId || null, fub_person_id: p || null, person_name: pname, extra_person_ids: persons.slice(1),
    user_ids: users, owner_user_id: owner, created_by_id: a.createdById || null,
    source: /^starling/i.test(String(a.title || "")) ? "starling" : "fub",
    fub_created: a.created || null, fub_updated: a.updated || null, deleted: false, updated_at: new Date().toISOString(),
  };
}

// what the team did around / after an appointment, from FUB calls, texts and notes for that person
function followFor(ap: Row, calls: Row[], texts: Row[], notes: Row[]) {
  const s = Date.parse(ap.start_at), e = ap.end_at ? Date.parse(ap.end_at) : s + 3600e3;
  let attend: Row | null = null, c = 0, talked = 0, tx = 0, nt = 0, last: Row | null = null;
  const touch = (at: number, kind: string, by: string) => { if (!last || at > last.at) last = { at, kind, by }; };
  for (const k of calls) {
    const at = Date.parse(k.created); if (!k.userId) continue;
    const dur = Number(k.duration || 0);
    if (at >= s - 30 * 60e3 && at <= e + 90 * 60e3 && dur >= 60 && (!attend || dur > attend.sec)) attend = { sec: dur, min: Math.round(dur / 60), by: k.userName || null };
    if (at > e && (!k.isIncoming || dur > 0)) { c++; if (dur >= 60) talked++; touch(at, dur >= 60 ? "call (" + Math.round(dur / 60) + " min)" : "call", k.userName || ""); }
  }
  for (const t of texts) {
    const at = Date.parse(t.created);
    if (at > e && !t.isIncoming && t.userId && t.status !== "Failed") { tx++; touch(at, "text", t.userName || ""); }
  }
  for (const n of notes) {
    const at = Date.parse(n.created);
    if (at > e && n.createdById > 0 && !AUTO_NOTE.test(String(n.subject || "")) && !/^Asked for a showing on jasonaguirregroup/i.test(String(n.body || ""))) { nt++; touch(at, "note", n.createdBy || ""); }
  }
  const L = last as Row | null;
  return { attend, calls: c, talked, texts: tx, notes: nt, last_at: L ? new Date(L.at).toISOString() : null, last_kind: L ? L.kind : null, last_by: L ? L.by : null,
           checked_at: new Date().toISOString() };
}

async function personActivity(pid: number) {
  const [c, t, n] = await Promise.all([
    fub(`/calls?personId=${pid}&limit=50&sort=-created`).catch(() => ({ calls: [] })),
    fub(`/textMessages?personId=${pid}&limit=50&sort=-created`).catch(() => ({ textmessages: [] })),
    fub(`/notes?personId=${pid}&limit=50&sort=-created`).catch(() => ({ notes: [] })),
  ]);
  return { calls: c.calls || [], texts: t.textmessages || t.textMessages || [], notes: n.notes || [] };
}

function esc(s: unknown) { return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!)); }
function phoneFmt(p: unknown) { const d = String(p || "").replace(/\D/g, "").slice(-10); return d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : ""; }
function reminderEmail(x: Row) {
  const es = x.lang !== "en", a = x.agent || {}, first = esc(x.first || "");
  const d = new Date(x.start_at);
  const day = d.toLocaleDateString(es ? "es-MX" : "en-US", { weekday: "long", month: "long", day: "numeric", timeZone: "America/Chicago" });
  const time = d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/Chicago" });
  const who = a.first ? esc(a.first) : "Jason Aguirre Group", ph = phoneFmt(a.phone) || "(832) 702-3574";
  const subject = es ? `Recordatorio: su cita con ${a.first || "Jason Aguirre Group"}, ${day}` : `Reminder: your appointment with ${a.first || "Jason Aguirre Group"}, ${day}`;
  const html = `<!doctype html><html><body style="margin:0;padding:0;background:#f5f5f7"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f7"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#fff;border-radius:18px;font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#17161c">
<tr><td style="padding:28px 28px 8px"><div style="font-size:12px;font-weight:800;letter-spacing:.18em;text-transform:uppercase;color:#c8102e">Jason Aguirre Group · eXp Realty</div>
<h1 style="margin:10px 0 6px;font-size:26px;line-height:1.2">${es ? `¡Hola ${first}! Le recordamos su cita` : `Hi ${first}! A reminder about your appointment`}</h1></td></tr>
<tr><td style="padding:8px 28px"><table role="presentation" width="100%" style="background:#f6f5f3;border-radius:14px"><tr><td style="padding:16px 18px;font-size:16px;line-height:1.5">
<b style="font-size:18px">${esc(day.charAt(0).toUpperCase() + day.slice(1))} · ${esc(time)}</b><br>${es ? "Con" : "With"} ${who}${x.location ? `<br>${esc(x.location)}` : ""}</td></tr></table></td></tr>
<tr><td style="padding:14px 28px 6px;font-size:15px;line-height:1.55;color:#45444c">${es ? `Si necesita cambiar la hora, llame o mande texto a ${who} al <a href="tel:+1${String(a.phone || "8327023574").replace(/\D/g, "").slice(-10)}" style="color:#c8102e;font-weight:700">${esc(ph)}</a>.` : `If you need to change the time, call or text ${who} at <a href="tel:+1${String(a.phone || "8327023574").replace(/\D/g, "").slice(-10)}" style="color:#c8102e;font-weight:700">${esc(ph)}</a>.`}</td></tr>
<tr><td style="padding:10px 28px 28px"><a href="${SITE}/homes" style="display:inline-block;background:#c8102e;color:#fff;text-decoration:none;font-weight:800;border-radius:12px;padding:13px 20px">${es ? "Ver casas mientras tanto" : "Browse homes meanwhile"}</a></td></tr>
<tr><td style="padding:16px 28px;border-top:1px solid #eee;font-size:12px;color:#85848d">Jason Aguirre Group · eXp Realty · 5373 W Alabama St, Suite 448, Houston, TX 77056 · (832) 702-3574</td></tr>
</table></td></tr></table></body></html>`;
  return { subject, html };
}

Deno.serve(async (req) => {
  const H = { ...cors(req), "Content-Type": "application/json" };
  const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: H });
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors(req) });
  if (req.method !== "POST") return json({ ok: false, error: "POST only" }, 405);
  const db = createClient(SB_URL, SRK);
  let b: Row = {}; try { b = await req.json(); } catch { /* empty */ }

  let key = String(Deno.env.get("FUB_API_KEY") || "").trim().replace(/^basic\s+/i, "").replace(/:$/, "");
  if (!key) { const { data } = await db.rpc("jag_fub_key"); key = String(data || "").trim(); }
  if (!key) return json({ ok: false, error: "FUB key not set" }, 500);
  FH = { Authorization: "Basic " + btoa(key + ":"), "Content-Type": "application/json", "X-System": "JAG-Website" };

  // ---------------- sync (the database, every 10 minutes) ----------------
  if (b.action === "sync") {
    const { data: tokOk } = await db.rpc("jag_alerts_token_ok", { p_token: req.headers.get("x-jag-token") || "" });
    if (tokOk !== true) return json({ ok: false, error: "forbidden" }, 403);
    const t0 = Date.now(), stats: Row = { fetched: 0, saved: 0, removed: 0, followed: 0, emails: 0 };
    const from = new Date(Date.now() - (Number(b.days) || 60) * 864e5).toISOString(), to = new Date(Date.now() + 60 * 864e5).toISOString();
    // 1. appointments in the window (only ones with a client)
    const all: Row[] = [];
    let next = `/appointments?start=${encodeURIComponent(from)}&end=${encodeURIComponent(to)}&limit=100&sort=start`;
    for (let i = 0; i < 30 && next; i++) {
      const j = await fub(next);
      for (const a of j.appointments || []) all.push(a);
      const n = j._metadata && j._metadata.nextLink; next = n ? String(n).replace(FUB, "") : "";
    }
    stats.fetched = all.length;
    const withPerson = all.filter((a) => (a.invitees || []).some((x: Row) => x.personId));
    const pids = [...new Set(withPerson.flatMap((a) => (a.invitees || []).filter((x: Row) => x.personId).map((x: Row) => Number(x.personId))))];
    const contacts = new Map<number, Row>();
    for (let i = 0; i < pids.length; i += 200) {
      const { data } = await db.from("jag_contacts").select("fub_id,assigned_fub_user").in("fub_id", pids.slice(i, i + 200));
      for (const c of data || []) contacts.set(Number(c.fub_id), c);
    }
    const opsOwner = new Map<number, number>();
    const ids = withPerson.map((a) => Number(a.id));
    {
      const { data } = await db.rpc("jag_appts_ops_owners", { p_ids: ids });
      for (const o of (data as Row[]) || []) if (o.assigned) opsOwner.set(Number(o.id), Number(o.assigned));
    }
    const rows = withPerson.map((a) => toRow(a, contacts, opsOwner));
    for (let i = 0; i < rows.length; i += 200) {
      const { error } = await db.from("jag_appointments").upsert(rows.slice(i, i + 200), { onConflict: "fub_id" });
      if (error) return json({ ok: false, error: error.message, stats }, 500);
    }
    stats.saved = rows.length;
    // deleted in FUB (or a client removed): gone here too
    const seen = new Set(rows.map((r) => r.fub_id));
    const { data: local } = await db.from("jag_appointments").select("id,fub_id").gte("start_at", from).lte("start_at", to).not("fub_id", "is", null).eq("deleted", false);
    const gone = (local || []).filter((r: Row) => !seen.has(Number(r.fub_id))).map((r: Row) => r.id);
    if (gone.length && all.length > 0) { await db.from("jag_appointments").update({ deleted: true, updated_at: new Date().toISOString() }).in("id", gone); stats.removed = gone.length; }

    // 2. follow-up for appointments that already happened: never checked first, then the oldest checks (recent ones every 2 h)
    const { data: past } = await db.from("jag_appointments").select("id,fub_person_id,start_at,end_at,follow,outcome")
      .eq("deleted", false).eq("all_day", false).not("fub_person_id", "is", null).lt("start_at", new Date().toISOString()).gte("start_at", from)
      .order("start_at", { ascending: false }).limit(1000);
    const due = (past || []).filter((r: Row) => {
      const ck = r.follow && r.follow.checked_at ? Date.parse(r.follow.checked_at) : 0;
      const age = Date.now() - Date.parse(r.start_at);
      return !ck || (age < 14 * 864e5 && Date.now() - ck > 2 * 3600e3) || (Date.now() - ck > 24 * 3600e3);
    }).sort((x: Row, y: Row) => (x.follow ? 1 : 0) - (y.follow ? 1 : 0));
    const byPerson = new Map<number, Row[]>();
    for (const r of due) { const p = Number(r.fub_person_id); if (!byPerson.has(p)) byPerson.set(p, []); byPerson.get(p)!.push(r); }
    const maxP = Math.min(Number(b.persons) || 35, 80);
    for (const [pid, list] of [...byPerson.entries()].slice(0, maxP)) {
      if (Date.now() - t0 > 110e3) break;
      const act = await personActivity(pid);
      for (const r of list) {
        const f = followFor(r, act.calls, act.texts, act.notes);
        await db.from("jag_appointments").update({ follow: f }).eq("id", r.id);
        stats.followed++;
      }
    }
    stats.follow_left = Math.max(0, byPerson.size - maxP);

    // 3. Lola: client text reminders, owner nudges, Jason's daily list (skipped on backfill runs: {no_lola:true})
    if (!b.no_lola) { const { data: tick } = await db.rpc("jag_appts_tick"); stats.lola = tick; }
    // 4. client reminder emails
    if (RESEND && !b.no_lola) {
      const { data: dueMail } = await db.rpc("jag_appts_email_due");
      for (const x of (dueMail as Row[]) || []) {
        const m = reminderEmail(x);
        const r = await fetch("https://api.resend.com/emails", { method: "POST", headers: { Authorization: `Bearer ${RESEND}`, "Content-Type": "application/json" },
          body: JSON.stringify({ from: FROM, to: [x.email], reply_to: "jason.aguirre@jasonhoustonrealty.com", subject: m.subject, html: m.html }) });
        const { data: cur } = await db.from("jag_appointments").select("client_reminded").eq("id", x.id).single();
        await db.from("jag_appointments").update({ client_reminded: { ...((cur && cur.client_reminded) || {}), email: r.ok ? new Date().toISOString() : "failed" } }).eq("id", x.id);
        if (r.ok) stats.emails++;
      }
    }
    stats.ms = Date.now() - t0;
    return json({ ok: true, stats });
  }

  // ---------------- team actions (Agent Hub) ----------------
  const auth = req.headers.get("Authorization") || "";
  const userDb = createClient(SB_URL, ANON, { global: { headers: { Authorization: auth } } });
  const { data: isTeam } = await userDb.rpc("jag_is_team");
  if (isTeam !== true) return json({ ok: false, error: "not_team" }, 403);
  const { data: u } = await db.auth.getUser(auth.replace(/^Bearer\s+/i, ""));
  const me = u && u.user ? u.user : null;
  const { data: ag } = me ? await db.from("jag_agents").select("code,name,first_name,fub_user_id").eq("user_id", me.id).eq("active", true).maybeSingle() : { data: null };
  const meName = (ag && (ag.first_name || ag.name)) || "Team";

  if (b.action === "outcome") {
    const { data: ap } = await db.from("jag_appointments").select("*").eq("id", Number(b.id)).single();
    if (!ap) return json({ ok: false, error: "not found" }, 404);
    const oid = Number(b.outcome_id), oname = OUTCOMES[oid];
    if (!oname) return json({ ok: false, error: "bad outcome" }, 400);
    const note = String(b.note || "").trim().slice(0, 1500);
    try {
      if (ap.fub_id) await fub(`/appointments/${ap.fub_id}`, { method: "PUT", body: JSON.stringify({ outcomeId: oid }) });
      if (ap.fub_person_id) {
        const when = new Date(ap.start_at).toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "America/Chicago" });
        await fub("/notes", { method: "POST", body: JSON.stringify({ personId: ap.fub_person_id, subject: "Appointment outcome: " + oname,
          body: `${oname} · appointment ${when}${ap.title ? " (" + ap.title + ")" : ""}${note ? "\n" + note : ""}\nLogged by ${meName} in the JAG Agent Hub.`, isHtml: false }) });
      }
    } catch (e) { return json({ ok: false, error: String((e as Error).message || e) }, 502); }
    await db.from("jag_appointments").update({ outcome: oname, outcome_id: oid, outcome_at: new Date().toISOString(), outcome_by: meName,
      note: note || ap.note, updated_at: new Date().toISOString() }).eq("id", ap.id);
    // the FUB intake's after-appointment call check is done too
    if (ap.fub_id) await db.rpc("jag_appts_check_done", { p_fub_id: ap.fub_id });
    return json({ ok: true, outcome: oname });
  }

  if (b.action === "create") {
    const { data: c } = await db.from("jag_contacts").select("id,fub_id,name,assigned_fub_user,lang").eq("id", String(b.contact_id || "")).maybeSingle();
    if (!c || !c.fub_id) return json({ ok: false, error: "This client isn't in Follow Up Boss yet." }, 400);
    const start = new Date(String(b.start || ""));
    if (isNaN(start.getTime()) || start.getTime() < Date.now() - 864e5) return json({ ok: false, error: "Pick a valid date and time." }, 400);
    const mins = Math.min(Math.max(Number(b.minutes) || 30, 15), 240);
    const end = new Date(start.getTime() + mins * 60e3);
    const typeId = TYPES[Number(b.type_id)] ? Number(b.type_id) : 1;
    const owner = Number(b.owner_fub_user) || (ag && ag.fub_user_id) || Number(c.assigned_fub_user) || 1;
    let users: number[] = [owner];
    if (b.invite === "team") { const { data: t } = await db.rpc("jag_appts_team_fub"); users = [...new Set([owner, ...(((t as number[]) || []).map(Number).filter(Boolean))])]; }
    const loc = String(b.location || "").trim().slice(0, 200), note = String(b.note || "").trim().slice(0, 1500);
    const title = `${TYPES[typeId]} with ${c.name || "client"}`;
    let created: Row;
    try {
      created = await fub("/appointments", { method: "POST", body: JSON.stringify({ title, start: start.toISOString(), end: end.toISOString(), allDay: false,
        location: loc, description: note, typeId, invitees: [{ personId: c.fub_id }, ...users.map((x) => ({ userId: x }))] }) });
      const when = start.toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "America/Chicago" });
      await fub("/notes", { method: "POST", body: JSON.stringify({ personId: c.fub_id, subject: "JAG Agent Hub booking",
        body: `${title} · ${when} (${mins} min)${loc ? " · " + loc : ""}${note ? "\n" + note : ""}\nBooked by ${meName} in the JAG Agent Hub.`, isHtml: false }) });
    } catch (e) { return json({ ok: false, error: String((e as Error).message || e) }, 502); }
    const row = { ...toRow(created, new Map([[Number(c.fub_id), c]]), new Map()), owner_user_id: owner, source: "hub", note: note || null };
    const { data: saved } = await db.from("jag_appointments").upsert(row, { onConflict: "fub_id" }).select("id").single();
    return json({ ok: true, id: saved && saved.id, fub_id: created.id });
  }

  if (b.action === "refresh") {
    const { data: ap } = await db.from("jag_appointments").select("id,fub_person_id,start_at,end_at").eq("id", Number(b.id)).single();
    if (!ap || !ap.fub_person_id) return json({ ok: false, error: "not found" }, 404);
    const act = await personActivity(Number(ap.fub_person_id));
    const f = followFor(ap, act.calls, act.texts, act.notes);
    await db.from("jag_appointments").update({ follow: f }).eq("id", ap.id);
    return json({ ok: true, follow: f });
  }

  return json({ ok: false, error: "unknown action" }, 400);
});
