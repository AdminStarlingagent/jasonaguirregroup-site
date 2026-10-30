// jag-client-hub — what the admin client profile does on a person's behalf (team logins only).
//  { action: 'fub', email, phone, name, lead_id?, add? }  → the Follow Up Boss person (found by phone, then email).
//      Not there and add=true: sent to FUB as a website inquiry (normal lead flow), then looked up again.
//      The link is kept on the lead row ("Follow Up Boss") so the next open is instant.
//  { action: 'save_search', email, name, phone, lang, label, api, ui, freq, send_now, note }
//      → makes sure the person has a home-search account (created quietly for loan-app clients; they sign in with a code
//        to that email any time), saves the search with alerts on, and sets how often new-home emails go out.
//        send_now: emails today's best matches right away with the agent's note ("homes picked for you").
//        The hourly listing-alerts job sends new matches from then on; every email has a one-click unsubscribe.
//  { action: 'email_homes', email, name, lang, mls[], note, label } → a JAG-branded email with those homes, reply-to the agent.
//  { action: 'email_list', cart_id, note } → a Matrix client list as a JAG-branded email (photos, prices, one button to the list where
//      they tap ❤️), from the agent, reply-to the agent. Only the agent's own lists (jag_cart_get as them). Logged on the contact timeline.
//  { action: 'invite', invite_id } → the client's personal app invite (jag_invites, made by jag_invite_create) by email, from the agent.
//  { action: 'email', contact_id (or user_id), subject, body } → an email to the contact from their profile (agent's name, replies
//      to the agent), logged on the profile timeline (jag_contact_notes kind 'email') and copied to Follow Up Boss as a note.
//  { action: 'fub_history', contact_id (or user_id) } → the contact's Follow Up Boss notes and calls (read-only), for the profile
//      timeline while both run. Notes/calls the workspace itself wrote back to FUB are left out (they're already on the timeline).
//  Both only work on contacts this team member can see (jag_contact_basic).
// Every send is logged in jag_homes_sent (the profile's "Homes sent" list).
import { createClient } from "jsr:@supabase/supabase-js@2";
import { SITE, esc, money, row, button, homeCard, h1, lead, shell, C, OFFICE, OFFICE_TEL, phoneFmt, tel, agentStrip, steps, quote } from "./jag-email.ts";

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SRK = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
const RK = Deno.env.get("REPLIERS_API_KEY") || "";
const RESEND = Deno.env.get("RESEND_API_KEY") || "";
const FROM = Deno.env.get("ALERTS_FROM") || "Jason Aguirre Group <alerts@updates.jasonhoustonrealty.com>";
const FUB = "https://api.followupboss.com/v1";
const FUB_APP = "https://jasonhoustonrealty.followupboss.com/2/people/view/";
const ALLOWED = [SITE, "https://www.jasonaguirregroup.company", "http://127.0.0.1:8765"];
const SEARCH_KEYS = new Set(["type", "state", "city", "zip", "search", "minPrice", "maxPrice", "minBedrooms", "minBaths", "propertyType", "newc"]);
const FIELDS = "mlsNumber,listPrice,type,address,images,details.numBedrooms,details.numBathrooms,details.sqft,details.propertyType,permissions,standardStatus,daysOnMarket";
type Row = Record<string, any>;

function cors(req: Request) {
  const o = req.headers.get("origin") || "";
  return { "Access-Control-Allow-Origin": ALLOWED.includes(o) ? o : SITE, "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
    "Access-Control-Allow-Methods": "POST, OPTIONS", Vary: "Origin" };
}
const digits10 = (p: unknown) => { const d = String(p || "").replace(/\D/g, "").replace(/^1(?=\d{10}$)/, ""); return d.length === 10 ? d : ""; };
const cleanEmail = (e: unknown) => { const v = String(e || "").trim().toLowerCase(); return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v) ? v : ""; };

async function repliers(q: URLSearchParams): Promise<Row[]> {
  q.set("boardId", "147");
  const r = await fetch("https://api.repliers.io/listings?" + q.toString(), { headers: { "REPLIERS-API-KEY": RK, Accept: "application/json" } });
  if (!r.ok) return [];
  const d = await r.json();
  return (d.listings || []).filter((l: Row) => { const p = l.permissions || {}; return p.displayPublic !== "N" && p.displayInternetEntireListing !== "N"; });
}
function snap(l: Row) {
  const a = l.address || {}, d = l.details || {}, hide = (l.permissions || {}).displayAddressOnInternet === "N";
  return { price: l.listPrice ?? null, beds: d.numBedrooms ?? null, baths: d.numBathrooms ?? null, sqft: d.sqft ?? null, photo: (l.images || [])[0] || null,
    zip: a.zip || null, city: a.city || null, type: l.type || null, ptype: d.propertyType || null,
    addr: hide ? "" : [a.streetNumber, a.streetDirectionPrefix, a.streetName, a.streetSuffix, a.streetDirection].filter(Boolean).join(" ") + (a.unitNumber ? " #" + a.unitNumber : "") };
}

const T = {
  es: { hi: "Hola", picked: (n: number) => n === 1 ? "Una casa para usted" : `${n} casas para usted`, from: "de", view: "Ver la casa", bd: "rec", ba: "baños", sqft: "pies²",
    alerts_on: "Desde hoy le avisamos por correo cuando salga una casa nueva que coincida con:", all: "Ver más casas", call: "¿Quiere verla? Responda a este correo o llame al",
    why: "Recibe este correo porque su agente de Jason Aguirre Group le mandó estas casas.", why_alert: "Recibe este correo porque su agente de Jason Aguirre Group le preparó avisos de casas.",
    unsub: "Dejar de recibir avisos", manage: "Mis avisos", disc: "Información de listados de HAR a través de Repliers; se considera confiable pero no garantizada.",
    signin: "Puede entrar a su cuenta con este correo para guardar casas y cambiar sus avisos.", none: "Por ahora no hay casas que coincidan; le avisamos en cuanto salga una." },
  en: { hi: "Hi", picked: (n: number) => n === 1 ? "A home for you" : `${n} homes for you`, from: "from", view: "View home", bd: "bd", ba: "ba", sqft: "sqft",
    alerts_on: "Starting today we'll email you when a new home comes up that matches:", all: "See more homes", call: "Want to see it? Reply to this email or call",
    why: "You get this email because your Jason Aguirre Group agent sent you these homes.", why_alert: "You get this email because your Jason Aguirre Group agent set up home alerts for you.",
    unsub: "Unsubscribe from alerts", manage: "My alerts", disc: "Listing information from HAR through Repliers; deemed reliable but not guaranteed.",
    signin: "Sign in to your account with this email to save homes and change your alerts.", none: "No homes match right now; we'll let you know as soon as one does." },
};

async function sig(uid: string) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(SRK), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const s = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode("unsub:" + uid));
  return Array.from(new Uint8Array(s)).slice(0, 16).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function homesEmail(o: { es: boolean; name: string; homes: Row[]; note: string; agent: Row; label?: string; alertLabel?: string; unsub?: string; code: string }) {
  const L = T[o.es ? "es" : "en"], first = String(o.name || "").trim().split(/\s+/)[0];
  const subject = o.alertLabel && !o.homes.length ? (o.es ? "Sus avisos de casas están listos" : "Your home alerts are set up") : L.picked(o.homes.length) + (o.label ? ` · ${o.label}` : "");
  const agentLine = `${o.agent.name || "Jason Aguirre"} · ${phoneFmt(o.agent.phone) || OFFICE}`;
  const cards = o.homes.slice(0, 12).map((h) => {
    const s = h.snap, specs = [s.beds != null ? `${s.beds} ${L.bd}` : "", s.baths != null ? `${s.baths} ${L.ba}` : "", s.sqft ? `${Number(s.sqft).toLocaleString("en-US")} ${L.sqft}` : ""].filter(Boolean).join("  ·  ");
    return homeCard({ url: `${SITE}/homes?a=${encodeURIComponent(o.code)}&src=agent#${encodeURIComponent(h.mls)}`, photo: s.photo, price: s.price, specs,
      addr: [[s.addr, s.city].filter(Boolean).join(", "), s.zip].filter(Boolean).join(" "), btn: L.view });
  }).join("");
  const note = o.note ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 18px"><tr><td style="background:${C.card};border-left:4px solid ${C.red};border-radius:0 12px 12px 0;padding:14px 18px;font-size:16px;line-height:1.55;color:${C.ink};white-space:pre-wrap">${esc(o.note)}<div style="font-size:13px;color:${C.muted};margin-top:8px;white-space:normal">— ${esc(agentLine)}</div></td></tr></table>` : "";
  const alertBox = o.alertLabel ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 18px"><tr><td style="background:${C.okTint};border-radius:12px;padding:14px 18px;font-size:15px;line-height:1.5;color:${C.ink}">${esc(L.alerts_on)}<br><b>${esc(o.alertLabel)}</b><div style="font-size:13px;color:${C.muted};margin-top:6px">${esc(L.signin)}</div></td></tr></table>` : "";
  const html = shell({ es: o.es, title: subject, preheader: o.note ? o.note.slice(0, 90) : subject,
    body: row(h1(`${L.hi}${first ? " " + first : ""},`) + note + alertBox + (cards || lead(L.none))
      + `<div style="text-align:center;margin:4px 0 20px">${button(SITE + "/homes?a=" + encodeURIComponent(o.code), L.all, { kind: "outline" })}</div>`
      + `<div style="border-top:1px solid ${C.line};padding-top:16px;text-align:center;font-size:14px;color:${C.muted}">${esc(L.call)} <a href="tel:${esc(tel(o.agent.phone) || OFFICE_TEL)}" style="color:${C.ink};font-weight:700;text-decoration:none">${esc(phoneFmt(o.agent.phone) || OFFICE)}</a>.</div>`, "0 32px"),
    links: o.unsub ? [[L.manage, SITE + "/account#settings"], [L.unsub, o.unsub]] : [],
    footerNote: (o.alertLabel ? L.why_alert : L.why) + " " + L.disc });
  return { subject, html };
}

Deno.serve(async (req) => {
  const H = { ...cors(req), "Content-Type": "application/json" };
  const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: H });
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors(req) });
  if (req.method !== "POST") return json({ ok: false, error: "POST only" }, 405);
  const auth = req.headers.get("Authorization") || "";
  const userDb = createClient(SB_URL, ANON, { global: { headers: { Authorization: auth } } });
  const { data: isTeam } = await userDb.rpc("jag_is_team");
  if (isTeam !== true) return json({ ok: false, error: "not_team" }, 403);
  const db = createClient(SB_URL, SRK);
  const { data: u } = await db.auth.getUser(auth.replace(/^Bearer\s+/i, ""));
  const me = u && u.user ? u.user : null;
  const { data: agentRow } = me ? await db.from("jag_agents").select("code,name,first_name,phone,phone_override,email,photo_url").eq("user_id", me.id).eq("active", true).maybeSingle() : { data: null };
  const agent: Row = agentRow ? { ...agentRow, phone: agentRow.phone_override || agentRow.phone } : { code: "jason", name: "Jason Aguirre", phone: OFFICE, email: "jason.aguirre@jasonhoustonrealty.com" };
  let b: Row = {}; try { b = await req.json(); } catch { /* empty */ }
  const email = cleanEmail(b.email), phone = digits10(b.phone), name = String(b.name || "").trim().slice(0, 120);
  const lang = b.lang === "en" ? "en" : "es";

  // ---------- Follow Up Boss ----------
  if (b.action === "fub") {
    if (!email && !phone) return json({ ok: false, error: "no email or phone" }, 400);
    const clean = (k: string) => String(k || "").trim().replace(/^basic\s+/i, "").replace(/:$/, "").trim();
    let key = clean(Deno.env.get("FUB_API_KEY") || "");
    if (!key) { const { data } = await db.rpc("jag_fub_key"); key = clean((data as string) || ""); }
    if (!key) return json({ ok: false, error: "FUB key not set" }, 500);
    const FH = { Authorization: "Basic " + btoa(key + ":"), "Content-Type": "application/json", "X-System": "JAG-Admin" };
    const find = async () => {
      for (const q of [phone ? `phone=${phone}` : "", email ? `email=${encodeURIComponent(email)}` : ""].filter(Boolean)) {
        const r = await fetch(`${FUB}/people?${q}&limit=1&fields=id,firstName,lastName,stage,assignedTo`, { headers: FH });
        if (r.ok) { const j = await r.json(); const p = (j.people || [])[0]; if (p) return p; }
      }
      return null;
    };
    let p = await find(), added = false;
    if (!p && b.add) {
      const parts = name.split(/\s+/).filter(Boolean);
      const person: Row = { firstName: parts[0] || "Cliente", lastName: parts.slice(1).join(" "), tags: ["JAG Website"] };
      if (phone) person.phones = [{ value: phone, type: "mobile" }];
      if (email) person.emails = [{ value: email, type: "home" }];
      const r = await fetch(`${FUB}/events`, { method: "POST", headers: FH, body: JSON.stringify({ source: "JAG Website", system: "JAG-Admin", type: "General Inquiry",
        message: String(b.note || "Added from the JAG admin client profile.").slice(0, 500), person }) });
      if (!r.ok) return json({ ok: false, error: "FUB " + r.status + " " + (await r.text()).slice(0, 160) }, 502);
      added = true;
      for (let i = 0; i < 3 && !p; i++) { await new Promise((ok) => setTimeout(ok, 700)); p = await find(); }
    }
    if (!p) return json({ ok: true, found: false, added });
    const url = FUB_APP + p.id;
    if (b.lead_id) {
      const { data: l } = await db.from("jag_leads").select("payload").eq("id", b.lead_id).maybeSingle();
      if (l) await db.from("jag_leads").update({ payload: { ...(l.payload || {}), "Follow Up Boss": url } }).eq("id", b.lead_id);
    }
    return json({ ok: true, found: true, added, person_id: p.id, url, name: [p.firstName, p.lastName].filter(Boolean).join(" "), stage: p.stage || null, assigned: p.assignedTo || null });
  }

  // ---------- email homes the agent picked ----------
  if (b.action === "email_homes") {
    if (!email) return json({ ok: false, error: "This client has no valid email." }, 400);
    const mls = (Array.isArray(b.mls) ? b.mls : []).map((m: unknown) => String(m).replace(/[^A-Za-z0-9-]/g, "").slice(0, 24)).filter(Boolean).slice(0, 12);
    if (!mls.length) return json({ ok: false, error: "Pick at least one home." }, 400);
    if (!RESEND) return json({ ok: false, error: "Email is not set up (RESEND_API_KEY)." }, 503);
    const q = new URLSearchParams({ fields: FIELDS, resultsPerPage: "24" }); q.append("status", "A"); q.append("status", "U");
    mls.forEach((m: string) => q.append("mlsNumber", m));
    const ls = await repliers(q);
    const homes = mls.map((m: string) => ls.find((l) => String(l.mlsNumber) === m)).filter((x): x is Row => !!x).map((l) => ({ mls: String(l.mlsNumber), snap: snap(l) }));
    if (!homes.length) return json({ ok: false, error: "Those homes are no longer on HAR." }, 404);
    const { data: acct } = await db.from("jag_clients").select("user_id,lang").ilike("email", email).maybeSingle();
    const es = (acct && acct.lang ? acct.lang : lang) !== "en";
    const m = homesEmail({ es, name, homes, note: String(b.note || "").slice(0, 1000), agent, label: String(b.label || "").slice(0, 80), code: agent.code,
      unsub: acct ? `${SITE}/unsubscribe?u=${acct.user_id}&s=${await sig(acct.user_id)}` : undefined });
    const r = await fetch("https://api.resend.com/emails", { method: "POST", headers: { Authorization: `Bearer ${RESEND}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: FROM.replace(/^[^<]*</, `${agent.name || "Jason Aguirre"} · JAG <`), to: [email], reply_to: agent.email || undefined, subject: m.subject, html: m.html }) });
    if (!r.ok) return json({ ok: false, error: "Email failed: " + (await r.text()).slice(0, 160) }, 502);
    await db.from("jag_homes_sent").insert({ agent_code: agent.code, sent_by: me?.email || null, email, phone: phone || null, user_id: acct ? acct.user_id : null, channel: "email",
      mls: homes.map((h: Row) => h.mls), label: String(b.label || "").slice(0, 200) || null, note: String(b.note || "").slice(0, 1000) || null });
    return json({ ok: true, sent: homes.length });
  }

  // ---------- a Matrix client list, branded ----------
  if (b.action === "email_list") {
    if (!RESEND) return json({ ok: false, error: "Email is not set up (RESEND_API_KEY)." }, 503);
    const { data: cj } = await userDb.rpc("jag_cart_get", { p_cart: b.cart_id });
    const cart: Row | null = cj && (cj as Row).ok ? (cj as Row).cart : null;
    if (!cart || !cart.token) return json({ ok: false, error: "That list isn't yours or was removed." }, 404);
    const to = cleanEmail(cart.email);
    if (!to) return json({ ok: false, error: "This list has no valid email." }, 400);
    const es = cart.lang !== "en", L = T[es ? "es" : "en"];
    const homes: Row[] = (((cj as Row).homes || []) as Row[]).filter((h) => h && h.snap && h.snap.pub !== "N");
    if (!homes.length) return json({ ok: false, error: "Add homes to the list first." }, 400);
    const code = agent.code && agent.code !== "pending" ? agent.code : "jason";
    const url = `${SITE}/lista?a=${encodeURIComponent(code)}&src=email#${cart.token}`;
    const first = String(cart.name || "").trim().split(/\s+/)[0] || "";
    const n = homes.length;
    const subject = es ? `${first ? first + ", l" : "L"}e preparé ${n} ${n === 1 ? "casa" : "casas"}` : `${first ? first + ", I" : "I"} picked ${n} ${n === 1 ? "home" : "homes"} for you`;
    // their message without the link (the button is the link)
    const note = String(b.note || "").replace(/https?:\/\/\S+/g, "").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim().slice(0, 1200);
    const cards = homes.slice(0, 8).map((h) => {
      const s2 = h.snap || {};
      const specs = [s2.beds != null ? `${s2.beds} ${L.bd}` : "", s2.baths != null ? `${s2.baths} ${L.ba}` : "", s2.sqft ? `${Number(s2.sqft).toLocaleString("en-US")} ${L.sqft}` : ""].filter(Boolean).join("  ·  ");
      const nt = h.agent_note ? `<div style="font-size:14px;color:${C.ink};background:${C.redTint};border-radius:10px;padding:8px 12px;margin:-10px 0 18px">💬 ${esc(h.agent_note)}</div>` : "";
      return homeCard({ url, photo: s2.photo, price: s2.price, specs, addr: [[s2.addr, s2.city].filter(Boolean).join(", "), s2.zip].filter(Boolean).join(" "), btn: es ? "Ver y marcar ❤️" : "See it · tap ❤️" }) + nt;
    }).join("");
    const more = n > 8 ? `<p style="margin:0 0 12px;text-align:center;font-size:14px;color:${C.muted}">${es ? `y ${n - 8} más en su lista` : `and ${n - 8} more in your list`}</p>` : "";
    const html = shell({ es, title: subject, preheader: note ? note.slice(0, 90) : subject,
      body: row(agentStrip(agent.name || "Jason Aguirre", (es ? "Tu agente · " : "Your agent · ") + (phoneFmt(agent.phone) || OFFICE) + " · eXp Realty", agent.photo_url)
        + h1(es ? `${first ? first + ", su" : "Su"} lista de casas` : `${first ? first + ", your" : "Your"} home list`)
        + (note ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 18px"><tr><td style="background:${C.card};border-left:4px solid ${C.red};border-radius:0 12px 12px 0;padding:14px 18px;font-size:16px;line-height:1.55;color:${C.ink};white-space:pre-wrap">${esc(note)}</td></tr></table>` : "")
        + `<div style="text-align:center;margin:0 0 20px">${button(url, es ? `Ver mis ${n} casas` : `See my ${n} homes`, { kind: "primary" })}</div>`
        + `<p style="margin:0 0 16px;font-size:14px;color:${C.muted};text-align:center">${es ? "Toque ❤️ en las que le gusten y le aviso para verlas." : "Tap ❤️ on the ones you like and I'll set up the tours."}</p>`
        + cards + more
        + `<div style="text-align:center;margin:4px 0 20px">${button(url, es ? "Abrir mi lista" : "Open my list", { kind: "outline" })}</div>`
        + `<div style="border-top:1px solid ${C.line};padding-top:16px;text-align:center;font-size:14px;color:${C.muted}">${esc(L.call)} <a href="tel:${esc(tel(agent.phone) || OFFICE_TEL)}" style="color:${C.ink};font-weight:700;text-decoration:none">${esc(phoneFmt(agent.phone) || OFFICE)}</a>.</div>`, "0 32px"),
      footerNote: L.why + " " + L.disc });
    const r = await fetch("https://api.resend.com/emails", { method: "POST", headers: { Authorization: `Bearer ${RESEND}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: FROM.replace(/^[^<]*</, `${agent.name || "Jason Aguirre"} · JAG <`), to: [to], reply_to: agent.email || undefined, subject, html }) });
    if (!r.ok) return json({ ok: false, error: "Email failed: " + (await r.text()).slice(0, 160) }, 502);
    const sent = await r.json().catch(() => ({}));
    await db.from("jag_homes_sent").insert({ agent_code: agent.code, sent_by: me?.email || null, email: to, phone: digits10(cart.phone) || null, user_id: cart.user_id || null, channel: "email",
      mls: homes.map((h) => String(h.mls)), label: String(cart.name || "").slice(0, 200) || null, note: note || null });
    // the contact's timeline (an app account, or an email match)
    const { data: ct } = cart.user_id ? await db.from("jag_contacts").select("id,user_id,fub_id").eq("user_id", cart.user_id).maybeSingle()
      : await db.from("jag_contacts").select("id,user_id,fub_id").ilike("email", to).eq("deleted", false).limit(1).maybeSingle();
    if (ct) {
      await db.from("jag_contact_notes").insert({ contact_id: ct.id, user_id: ct.user_id, agent_code: agent.code, author_name: agent.name || null, kind: "email", subject,
        body: (note ? note + "\n\n" : "") + url, meta: { to, resend_id: (sent as Row).id || null, cart: cart.id, homes: n } });
      await db.from("jag_contacts").update({ last_comm_at: new Date().toISOString() }).eq("id", ct.id);
    }
    return json({ ok: true, to, homes: n });
  }

  // ---------- automatic alerts: account + saved search ----------
  if (b.action === "save_search") {
    if (!email) return json({ ok: false, error: "This client needs a valid email for alerts." }, 400);
    const api: Row = {};
    for (const [k, v] of Object.entries(b.api || {})) if (SEARCH_KEYS.has(k) && v != null && v !== "") api[k] = Array.isArray(v) ? v.slice(0, 12).map(String) : String(v).slice(0, 200);
    if (!api.zip && !api.city && !api.search) return json({ ok: false, error: "Add at least one ZIP or city." }, 400);
    api.type = "sale"; api.state = "TX";
    const freq = b.freq === "daily" ? "daily" : "instant";
    // 1. the account (existing, or created quietly with this email)
    let { data: acct } = await db.from("jag_clients").select("*").ilike("email", email).maybeSingle();
    let created = false;
    if (!acct) {
      let uid: string | null = null;
      const cr = await db.auth.admin.createUser({ email, email_confirm: true, user_metadata: { lang, created_by: "team", agent: agent.code } });
      if (cr.data && cr.data.user) uid = cr.data.user.id;
      else {
        // already a login (e.g. signed in once but never finished): find it
        for (let page = 1; page <= 10 && !uid; page++) {
          const { data: lst } = await db.auth.admin.listUsers({ page, perPage: 200 });
          const f = (lst?.users || []).find((x: Row) => String(x.email || "").toLowerCase() === email);
          if (f) uid = f.id; if (!lst || (lst.users || []).length < 200) break;
        }
      }
      if (!uid) return json({ ok: false, error: "Could not set up the account: " + String(cr.error?.message || "unknown").slice(0, 120) }, 500);
      const ins = await db.from("jag_clients").insert({ user_id: uid, email, name: name || null, phone: phone || null, lang, agent_code: agent.code, agent_set_at: new Date().toISOString(),
        notify: { new: freq, price: "instant", status: "instant" }, alert_freq: freq }).select("*").single();
      if (ins.error) return json({ ok: false, error: "Could not set up the account: " + ins.error.message.slice(0, 120) }, 500);
      acct = ins.data; created = true;
      // Follow Up Boss already has this client from their application: skip the "new registration" event
      await db.from("jag_fub_queue").update({ sent_at: new Date().toISOString(), error: "skipped: account set up by the team" }).eq("user_id", uid).eq("kind", "Registration").is("sent_at", null);
    } else {
      // they unsubscribed themselves: we don't turn emails back on for them
      if (acct.alert_freq === "off" || (acct.notify && acct.notify.new === "off")) {
        return json({ ok: false, reason: "unsubscribed", error: "This client turned off new-home emails. They can turn them back on in their account (Ajustes)." }, 409);
      }
      if (acct.paused_by_staff) await db.from("jag_clients").update({ paused_by_staff: false }).eq("user_id", acct.user_id);
      if (b.freq && acct.notify?.new !== freq && acct.alert_freq !== "off") await db.from("jag_clients").update({ notify: { ...(acct.notify || {}), new: freq } }).eq("user_id", acct.user_id);
    }
    // 2. the search, in the same shape the home search page saves
    const label = String(b.label || "").trim().slice(0, 120) || ([] as unknown[]).concat(api.zip || api.city || api.search).join(", ");
    const ui: Row = { ...(b.ui || {}), type: "sale" };
    const { data: s, error: se } = await db.from("jag_client_searches").insert({ user_id: acct.user_id, label, params: { ui, api, by: agent.code }, alerts: true,
      last_checked_at: new Date().toISOString() }).select("id").single();
    if (se) return json({ ok: false, error: "Could not save the search: " + se.message.slice(0, 120) }, 500);
    // 3. optional: today's best matches by email now (and marked so the hourly job doesn't send them again)
    let sent = 0;
    if (b.send_now && RESEND) {
      const q = new URLSearchParams({ status: "A", hasImages: "true", sortBy: "createdOnDesc", resultsPerPage: "8", fields: FIELDS });
      q.append("class", "residential"); q.append("class", "condo");
      for (const [k, v] of Object.entries(api)) { if (k === "newc") continue; for (const x of ([] as unknown[]).concat(v)) q.append(k, String(x)); }
      if (String(api.newc) === "1") q.set("raw.NewConstructionYN", "true");
      const picks = Array.isArray(b.mls) && b.mls.length ? (b.mls as string[]).slice(0, 12) : null;
      let ls = await repliers(q);
      if (picks) { const q2 = new URLSearchParams({ fields: FIELDS, resultsPerPage: "24", status: "A" }); picks.forEach((m) => q2.append("mlsNumber", m)); ls = await repliers(q2); }
      const homes = ls.map((l) => ({ mls: String(l.mlsNumber), snap: snap(l) }));
      const m = homesEmail({ es: (acct.lang || lang) !== "en", name: acct.name || name, homes, note: String(b.note || "").slice(0, 1000), agent, alertLabel: label, code: agent.code,
        unsub: `${SITE}/unsubscribe?u=${acct.user_id}&s=${await sig(acct.user_id)}` });
      const r = await fetch("https://api.resend.com/emails", { method: "POST", headers: { Authorization: `Bearer ${RESEND}`, "Content-Type": "application/json" },
        body: JSON.stringify({ from: FROM.replace(/^[^<]*</, `${agent.name || "Jason Aguirre"} · JAG <`), to: [email], reply_to: agent.email || undefined, subject: m.subject, html: m.html }) });
      if (r.ok) {
        sent = homes.length;
        const now = new Date().toISOString();
        if (homes.length) await db.from("jag_client_alerts").upsert(homes.map((h) => ({ user_id: acct.user_id, kind: "new", mls: h.mls, search_id: s.id, dedupe: "new:" + h.mls,
          detail: { label, snap: h.snap, by: agent.code }, emailed_at: now })), { onConflict: "user_id,dedupe", ignoreDuplicates: true });
        await db.from("jag_homes_sent").insert({ agent_code: agent.code, sent_by: me?.email || null, email, phone: phone || null, user_id: acct.user_id, channel: "email",
          mls: homes.map((h) => h.mls), label: "Alerts: " + label, note: String(b.note || "").slice(0, 1000) || null });
      }
    }
    return json({ ok: true, search_id: s.id, user_id: acct.user_id, account_created: created, emailed: sent, freq });
  }

  // ---------- app invite by email ----------
  if (b.action === "invite") {
    const { data: inv } = await db.from("jag_invites").select("*").eq("id", String(b.invite_id || "")).maybeSingle();
    if (!inv || inv.status === "cancelled") return json({ ok: false, error: "Invite not found." }, 404);
    const { data: staff } = await userDb.rpc("jag_invite_can_see_all");
    if (inv.agent_code !== agent.code && staff !== true) return json({ ok: false, error: "Not your invite." }, 403);
    const to = cleanEmail(inv.email);
    if (!to) return json({ ok: false, error: "Add the client's email first." }, 400);
    if (!RESEND) return json({ ok: false, error: "Email is not set up (RESEND_API_KEY)." }, 503);
    const { data: who } = await db.from("jag_agents").select("code,name,first_name,phone,phone_override,photo_url,email").eq("code", inv.agent_code).maybeSingle();
    const ag: Row = who ? { ...who, phone: who.phone_override || who.phone } : agent;
    const es = inv.lang !== "en", first = String(inv.name || "").trim().split(/\s+/)[0];
    const aFirst = ag.first_name || String(ag.name || "Jason").split(" ")[0];
    const url = `${SITE}/join#${inv.token}`;
    const subject = es ? `${aFirst} te invitó a la app de Jason Aguirre Group` : `${aFirst} invited you to the Jason Aguirre Group app`;
    const items = es
      ? ["Busca casas en todo Houston y guarda tus favoritas.", `Ve las casas que ${esc(aFirst)} te manda y dile cuáles te gustan.`, "Pide visitas y recibe avisos cuando salgan casas nuevas o bajen de precio.", "Sigue tu préstamo y tus pasos para comprar, todo en un lugar."]
      : ["Search homes all over Houston and save your favorites.", `See the homes ${esc(aFirst)} sends you and tell them which ones you like.`, "Request showings and get alerts when new homes hit the market or drop in price.", "Track your loan and your next steps to buy, all in one place."];
    const html = shell({ es, title: subject, preheader: es ? "Crea tu cuenta gratis en 1 minuto." : "Create your free account in 1 minute.",
      body: row(agentStrip(ag.name || "Jason Aguirre", (es ? "Tu agente · " : "Your agent · ") + (phoneFmt(ag.phone) || OFFICE) + " · eXp Realty", ag.photo_url)
        + h1(es ? `¡Hola${first ? " " + first : ""}! Te invito a nuestra app` : `Hi${first ? " " + first : ""}! You're invited to our app`)
        + lead(es ? "Es gratis y te ayuda a encontrar tu casa conmigo, paso a paso." : "It's free and helps us find your home together, step by step.")
        + (inv.note ? quote(String(inv.note).slice(0, 600), ag.name || "") : "")
        + steps(items)
        + `<div style="text-align:center;margin:8px 0 22px">${button(url, es ? "Crear mi cuenta" : "Create my account", { full: true })}</div>`
        + lead(es ? `¿Preguntas? Llámame o mándame texto al ${phoneFmt(ag.phone) || OFFICE}.` : `Questions? Call or text me at ${phoneFmt(ag.phone) || OFFICE}.`)),
      footerNote: es ? `Recibiste este correo porque ${aFirst} de Jason Aguirre Group te invitó. Si no lo esperabas, ignóralo.` : `You got this email because ${aFirst} at Jason Aguirre Group invited you. If you weren't expecting it, just ignore it.` });
    const r = await fetch("https://api.resend.com/emails", { method: "POST", headers: { Authorization: `Bearer ${RESEND}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: FROM.replace(/^[^<]*</, `${ag.name || "Jason Aguirre"} · JAG <`), to: [to], reply_to: ag.email || undefined, subject, html }) });
    if (!r.ok) return json({ ok: false, error: "Email failed: " + (await r.text()).slice(0, 160) }, 502);
    await db.from("jag_invites").update({ sent_count: (inv.sent_count || 0) + 1, sent_at: new Date().toISOString(), channel: "email", updated_at: new Date().toISOString() }).eq("id", inv.id);
    return json({ ok: true, to });
  }

  // ---------- email the client from their profile ----------
  const contactId = String(b.contact_id || b.user_id || "");
  const contact = async (): Promise<Row | null> => {
    if (!/^[0-9a-f-]{36}$/i.test(contactId)) return null;
    const { data } = await userDb.rpc("jag_contact_basic", { p_id: contactId });
    return (data as Row) || null;
  };

  if (b.action === "email") {
    const cl = await contact();
    const to = cleanEmail(cl?.email);
    if (!cl || !to) return json({ ok: false, error: "This client has no valid email." }, 400);
    const subject = String(b.subject || "").trim().slice(0, 200), text = String(b.body || "").trim().slice(0, 8000);
    if (!subject || !text) return json({ ok: false, error: "Add a subject and a message." }, 400);
    if (!RESEND) return json({ ok: false, error: "Email is not set up (RESEND_API_KEY)." }, 503);
    const es = (cl.lang || lang) !== "en";
    const linkify = (t: string) => esc(t).replace(/https?:\/\/[^\s<]+/g, (u) => `<a href="${u}" style="color:${C.red};font-weight:700">${u}</a>`);
    const html = shell({ es, title: subject, preheader: text.slice(0, 90),
      body: row(agentStrip(agent.name || "Jason Aguirre", (es ? "Tu agente · " : "Your agent · ") + (phoneFmt(agent.phone) || OFFICE) + " · eXp Realty", agent.photo_url)
        + `<div style="font-size:16px;line-height:1.6;color:${C.ink};white-space:pre-wrap">${linkify(text)}</div>`
        + `<div style="border-top:1px solid ${C.line};margin-top:22px;padding-top:14px;font-size:14px;color:${C.muted}">${esc(agent.name || "Jason Aguirre")} · Jason Aguirre Group · eXp Realty<br><a href="tel:${esc(tel(agent.phone) || OFFICE_TEL)}" style="color:${C.ink};font-weight:700;text-decoration:none">${esc(phoneFmt(agent.phone) || OFFICE)}</a></div>`),
      footerNote: es ? "Recibiste este correo de tu agente de Jason Aguirre Group. Responde directamente a este correo." : "You got this email from your Jason Aguirre Group agent. Just reply to this email." });
    const r = await fetch("https://api.resend.com/emails", { method: "POST", headers: { Authorization: `Bearer ${RESEND}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: FROM.replace(/^[^<]*</, `${agent.name || "Jason Aguirre"} · JAG <`), to: [to], reply_to: agent.email || undefined, subject, html }) });
    if (!r.ok) return json({ ok: false, error: "Email failed: " + (await r.text()).slice(0, 160) }, 502);
    const sent = await r.json().catch(() => ({}));
    await db.from("jag_contact_notes").insert({ contact_id: cl.id, user_id: cl.user_id, agent_code: agent.code, author_name: agent.name || null, kind: "email", subject, body: text,
      meta: { to, resend_id: (sent as Row).id || null, lola: !!b.lola } });
    await db.from("jag_contacts").update({ last_comm_at: new Date().toISOString() }).eq("id", cl.id);
    if (cl.fub_id) {   // copy to Follow Up Boss (sent by fub-sync)
      await db.from("jag_fub_out").insert({ contact_id: cl.id, fub_id: cl.fub_id, kind: "note", by_code: agent.code,
        payload: { who: agent.name || "JAG team", body: `📧 Email sent to ${to}\nSubject: ${subject}\n\n${text}` } });
      await db.rpc("jag_fub_kick");
    }
    return json({ ok: true, to });
  }

  // ---------- Follow Up Boss history (notes + calls), read-only ----------
  if (b.action === "fub_history") {
    const cl = await contact();
    if (!cl) return json({ ok: false, error: "not found" }, 404);
    const clean = (k: string) => String(k || "").trim().replace(/^basic\s+/i, "").replace(/:$/, "").trim();
    let key = clean(Deno.env.get("FUB_API_KEY") || "");
    if (!key) { const { data } = await db.rpc("jag_fub_key"); key = clean((data as string) || ""); }
    if (!key) return json({ ok: false, error: "FUB key not set" }, 500);
    const FH = { Authorization: "Basic " + btoa(key + ":"), "Content-Type": "application/json", "X-System": "JAG-Admin" };
    const ph = digits10(cl.phone), em = cleanEmail(cl.email);
    let person: Row | null = null;
    if (cl.fub_id) {
      const r = await fetch(`${FUB}/people/${cl.fub_id}?fields=id,firstName,lastName,stage,assignedTo,source`, { headers: FH });
      if (r.ok) person = await r.json();
    }
    if (!person) for (const q of [ph ? `phone=${ph}` : "", em ? `email=${encodeURIComponent(em)}` : ""].filter(Boolean)) {
      const r = await fetch(`${FUB}/people?${q}&limit=1&fields=id,firstName,lastName,stage,assignedTo,source`, { headers: FH });
      if (r.ok) { const j = await r.json(); const p = (j.people || [])[0]; if (p) { person = p; break; } }
    }
    if (!person) return json({ ok: true, found: false });
    const strip = (h: unknown) => String(h || "").replace(/<br\s*\/?>/gi, "\n").replace(/<\/p>/gi, "\n").replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#39;/g, "'").replace(/&quot;/g, '"').trim();
    const [nr, cr] = await Promise.all([
      fetch(`${FUB}/notes?personId=${person.id}&limit=30&sort=-created`, { headers: FH }).then((r) => r.ok ? r.json() : {}).catch(() => ({})),
      fetch(`${FUB}/calls?personId=${person.id}&limit=30`, { headers: FH }).then((r) => r.ok ? r.json() : {}).catch(() => ({})),
    ]);
    // what the workspace wrote back is already on the timeline: skip those copies
    const { data: mine } = await db.from("jag_contact_notes").select("body").eq("contact_id", cl.id).eq("kind", "call");
    const ours = new Set((mine || []).map((x: Row) => String(x.body || "").trim()).filter(Boolean));
    const notes = ((nr as Row).notes || []).filter((n: Row) => !/\(JAG workspace\)\s*$/.test(String(n.subject || ""))).map((n: Row) => ({ at: n.created || n.updated, by: n.createdBy || n.userName || null, subject: n.subject || null, body: strip(n.body).slice(0, 4000) }));
    const calls = ((cr as Row).calls || []).filter((c: Row) => !ours.has(strip(c.note))).map((c: Row) => ({ at: c.created || c.dateCreated, by: c.userName || c.createdBy || null, duration: c.duration ?? null,
      outcome: c.outcome || null, note: strip(c.note).slice(0, 2000), incoming: !!c.isIncoming, recording: c.recordingUrl || null }));
    return json({ ok: true, found: true, url: FUB_APP + person.id, stage: person.stage || null, assigned: person.assignedTo || null, source: person.source || null, notes, calls });
  }
  return json({ ok: false, error: "unknown action" }, 400);
});
