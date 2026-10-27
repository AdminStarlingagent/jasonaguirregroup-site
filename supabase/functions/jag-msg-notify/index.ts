// jag-msg-notify — emails a website client that their agent answered in Mensajes.
// Called by n8n "JAG Site · Messages" with the server token (x-jag-token). Body: { id } (a jag_messages row from the agent).
// Spanish first (English when the client chose English). Reply-to is the agent, so an email reply reaches them directly.
import { createClient } from "jsr:@supabase/supabase-js@2";

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SRK = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const RESEND = Deno.env.get("RESEND_API_KEY") || "";
const FROM = Deno.env.get("ALERTS_FROM") || "Jason Aguirre Group <alerts@updates.jasonhoustonrealty.com>";
const SITE = "https://jasonaguirregroup.company";
const CDN = "https://cdn.repliers.io/";
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ ok: false, error: "POST only" }, 405);
  const db = createClient(SB_URL, SRK);
  // the server token, or a caller holding the service key (n8n's Supabase credential): only service_role may run jag_msg_pending
  const tok = req.headers.get("x-jag-token") || "";
  let allowed = false;
  if (tok) { const { data } = await db.rpc("jag_alerts_token_ok", { p_token: tok }); allowed = data === true; }
  if (!allowed) {
    const k = req.headers.get("apikey") || (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
    if (k) { const { error } = await createClient(SB_URL, k, { auth: { persistSession: false } }).rpc("jag_msg_pending", { p_limit: 1 }); allowed = !error; }
  }
  if (!allowed) return json({ ok: false, error: "forbidden" }, 403);
  if (!RESEND) return json({ ok: false, error: "RESEND_API_KEY missing" }, 500);

  let b: any = {}; try { b = await req.json(); } catch { /* empty */ }
  const id = Number(b.id); if (!id) return json({ ok: false, error: "id required" }, 400);
  const { data: m } = await db.from("jag_messages").select("*").eq("id", id).maybeSingle();
  if (!m || m.sender !== "agent") return json({ ok: false, error: "not an agent message" }, 404);
  const { data: c } = await db.from("jag_clients").select("name,email,lang").eq("user_id", m.user_id).maybeSingle();
  if (!c || !/@/.test(c.email || "")) return json({ ok: false, error: "client has no email" }, 200);
  const { data: a } = await db.from("jag_agents").select("name,first_name,email,phone,photo_url").eq("code", m.agent_code || "").maybeSingle();

  const es = c.lang !== "en";
  const { subject, html, text } = render({ es, client: c, agent: a, msg: m });

  const r = await fetch("https://api.resend.com/emails", {
    method: "POST", headers: { Authorization: `Bearer ${RESEND}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: FROM, to: [c.email], reply_to: a?.email || undefined, subject, html, text }),
  });
  const t = await r.text();
  if (!r.ok) return json({ ok: false, error: "resend " + r.status + " " + t.slice(0, 200) }, 200);
  return json({ ok: true });
});

// ---------- the branded email (JAG Real Estate look: logo, ink #17161c, red #c8102e, Plus Jakarta Sans) ----------
const INK = "#17161c", RED = "#c8102e", MUTED = "#6a6972", CARD = "#f5f5f7", LINE = "#e8e8ec";
const FONT = "'Plus Jakarta Sans',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif";
const OFFICE = "(832) 702-3574";
const phoneFmt = (p: unknown) => { const d = String(p || "").replace(/\D/g, "").replace(/^1(?=\d{10}$)/, ""); return d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : String(p || ""); };
const money = (n: unknown) => (n == null || n === "" || !isFinite(Number(n))) ? "" : "$" + Math.round(Number(n)).toLocaleString("en-US");

// deno-lint-ignore no-explicit-any
export function render({ es, client, agent, msg }: { es: boolean; client: any; agent: any; msg: any }) {
  const T = (s: string, e: string) => es ? s : e;
  const who = agent?.first_name || msg.sender_name || T("Su agente", "Your agent");
  const full = agent?.name || who;
  const first = String(client?.name || "").trim().split(/\s+/)[0] || "";
  const link = SITE + "/account#mensajes";
  const card = msg.card && typeof msg.card === "object" ? msg.card : null;
  const home = !!card && card.kind !== "search" && card.kind !== "site";
  const what = card ? (home ? T("una casa", "a home") : T("casas", "homes")) : "";
  const subject = card ? T(`${who} le envió ${what}${home && card.title ? ": " + card.title : ""}`, `${who} sent you ${what}${home && card.title ? ": " + card.title : ""}`)
    : T(`${who} le contestó en su cuenta JAG`, `${who} replied in your JAG account`);
  const headline = card ? T(`${first ? first + ", " : ""}${who} le envió ${what}`, `${first ? first + ", " : ""}${who} sent you ${what}`)
    : T(`${first ? first + ", " : ""}${who} le contestó`, `${first ? first + ", " : ""}${who} replied`);
  const body = String(msg.body || "").slice(0, 600);
  const showNote = !!body && (!card || body !== card.title);
  const phone = phoneFmt(agent?.phone);
  const photo = /^https:\/\//.test(String(agent?.photo_url || "")) ? String(agent.photo_url) : "";
  const specs = card ? [card.beds != null ? `${card.beds} ${T("rec", "bd")}` : "", card.baths != null ? `${card.baths} ${T("baños", "ba")}` : "", card.sqft ? `${Number(card.sqft).toLocaleString("en-US")} ${T("pies²", "sqft")}` : ""].filter(Boolean).join("  ·  ") : "";
  const preheader = card && home ? [card.title, money(card.price), specs].filter(Boolean).join(" · ") : body.slice(0, 120);
  const btn = (href: string, label: string) => `<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" bgcolor="${RED}" style="border-radius:10px"><a href="${href}" style="display:block;padding:15px 20px;font-family:${FONT};font-size:16px;font-weight:700;color:#ffffff;text-decoration:none;border-radius:10px">${esc(label)}</a></td></tr></table>`;

  const avatar = photo
    ? `<img src="${esc(photo)}" width="48" height="48" alt="" style="display:block;width:48px;height:48px;border-radius:24px;object-fit:cover;border:0">`
    : `<table role="presentation" cellpadding="0" cellspacing="0"><tr><td width="48" height="48" align="center" bgcolor="${INK}" style="width:48px;height:48px;border-radius:24px;font-family:${FONT};font-size:19px;font-weight:700;color:#ffffff">${esc(String(who).charAt(0).toUpperCase())}</td></tr></table>`;

  const cardHtml = !card ? "" : home
    ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid ${LINE};border-radius:14px;overflow:hidden;margin:4px 0 0">
${card.photo ? `<tr><td style="padding:0"><a href="${link}"><img src="${CDN}${esc(card.photo)}?class=large" width="536" alt="${esc(card.title || "")}" style="display:block;width:100%;max-width:536px;height:auto;border:0"></a></td></tr>` : ""}
<tr><td style="padding:16px 18px 18px;font-family:${FONT};color:${INK}">
${card.price ? `<div style="font-size:26px;line-height:1.2;font-weight:800;letter-spacing:-.5px">${money(card.price)}</div>` : ""}
${specs ? `<div style="font-size:15px;font-weight:600;margin:4px 0 2px">${esc(specs)}</div>` : ""}
<div style="font-size:14px;color:${MUTED}">${esc(card.title || "")}</div>
${card.mls ? `<div style="font-size:12px;color:${MUTED};margin-top:6px">MLS #${esc(card.mls)}</div>` : ""}
</td></tr></table>`
    : `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid ${LINE};border-radius:14px;margin:4px 0 0"><tr><td style="padding:16px 18px;font-family:${FONT};color:${INK}">
<div style="font-size:11px;letter-spacing:2px;font-weight:700;color:${RED}">${T("BÚSQUEDA DE CASAS", "HOME SEARCH")}</div>
<div style="font-size:18px;font-weight:700;margin-top:4px">${esc(card.title || T("Casas para usted", "Homes for you"))}</div></td></tr></table>`;

  const html = `<!doctype html><html lang="${es ? "es" : "en"}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light only"><meta name="supported-color-schemes" content="light">
<link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;600;700;800&display=swap" rel="stylesheet">
<title>${esc(subject)}</title></head>
<body style="margin:0;padding:0;background:${CARD}">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:${CARD}">${esc(preheader)}&#8199;&#65279;&#847;&#8199;&#65279;&#847;&#8199;&#65279;&#847;</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" bgcolor="${CARD}" style="background:${CARD}"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px">

<tr><td align="center" bgcolor="#ffffff" style="background:#ffffff;border-radius:16px 16px 0 0;padding:26px 24px 18px;border-bottom:3px solid ${RED}">
<a href="${SITE}" style="text-decoration:none"><img src="${SITE}/email-logo.png" width="132" alt="JAG Real Estate" style="display:block;width:132px;height:auto;border:0;font-family:${FONT};font-size:24px;font-weight:800;color:${INK}"></a>
<div style="font-family:${FONT};font-size:11px;letter-spacing:2px;font-weight:600;color:${MUTED};margin-top:8px">eXp REALTY</div>
</td></tr>

<tr><td bgcolor="#ffffff" style="background:#ffffff;padding:26px 32px 8px;font-family:${FONT};color:${INK}">
<table role="presentation" cellpadding="0" cellspacing="0"><tr><td style="padding-right:12px">${avatar}</td>
<td style="font-family:${FONT}"><div style="font-size:15px;font-weight:700;color:${INK}">${esc(full)}</div><div style="font-size:13px;color:${MUTED}">${T("Su agente · JAG Real Estate", "Your agent · JAG Real Estate")}</div></td></tr></table>
<h1 style="margin:20px 0 6px;font-family:${FONT};font-size:24px;line-height:1.25;font-weight:800;letter-spacing:-.4px;color:${INK}">${esc(headline)}</h1>
<p style="margin:0 0 18px;font-size:15px;line-height:1.5;color:${MUTED}">${esc(card ? (home ? T("Ya está en su cuenta JAG, en Mensajes. Véala ahí y contéstele a su agente si le interesa.", "It's waiting in your JAG account under Messages. Take a look and reply to your agent if you like it.") : T("Ya están en su cuenta JAG, en Mensajes. Véalas ahí y contéstele a su agente.", "They're waiting in your JAG account under Messages. Take a look and reply to your agent.")) : T("Tiene un mensaje nuevo en su cuenta JAG:", "You have a new message in your JAG account:"))}</p>
${showNote ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 16px"><tr><td style="background:${CARD};border-left:4px solid ${RED};border-radius:0 12px 12px 0;padding:14px 18px;font-family:${FONT};font-size:16px;line-height:1.55;color:${INK};white-space:pre-wrap">${esc(body)}<div style="font-size:13px;color:${MUTED};margin-top:8px;white-space:normal">— ${esc(who)}</div></td></tr></table>` : ""}
${cardHtml}
</td></tr>

<tr><td bgcolor="#ffffff" style="background:#ffffff;padding:22px 32px 8px">
${btn(link, card ? (home ? T("Ver la casa en mi cuenta", "See the home in my account") : T("Ver las casas en mi cuenta", "See the homes in my account")) : T("Ver y contestar", "View and reply"))}
<p style="margin:12px 0 0;text-align:center;font-family:${FONT};font-size:14px;color:${MUTED}">${home ? T("¿Le gustó? ¿Quiere ir a verla? Contéstele a", "Like it? Want to tour it? Reply to") : T("Contéstele a", "Reply to")} ${esc(who)} ${T("en su cuenta o respondiendo este correo.", "in your account or by replying to this email.")}</p>
</td></tr>

${phone ? `<tr><td bgcolor="#ffffff" style="background:#ffffff;padding:16px 32px 28px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid ${LINE}"><tr><td style="padding-top:16px;font-family:${FONT};font-size:14px;color:${MUTED};text-align:center">
${T("¿Prefiere llamar o mandar texto?", "Rather call or text?")} <a href="tel:+1${esc(phone.replace(/\D/g, ""))}" style="color:${INK};font-weight:700;text-decoration:none">${esc(who)} · ${esc(phone)}</a></td></tr></table>
</td></tr>` : `<tr><td bgcolor="#ffffff" style="background:#ffffff;padding:0 0 20px"></td></tr>`}

<tr><td bgcolor="${INK}" style="background:${INK};border-radius:0 0 16px 16px;padding:24px 32px;font-family:${FONT};color:#c9c8d0;font-size:12px;line-height:1.6;text-align:center">
<div style="font-size:14px;font-weight:800;letter-spacing:3px;color:#ffffff">JAG <span style="color:${RED}">·</span> REAL ESTATE</div>
<div style="margin:4px 0 12px">Jason Aguirre Group · eXp Realty</div>
<div><a href="${SITE}/homes" style="color:#ffffff;text-decoration:none;font-weight:600">${T("Buscar casas", "Search homes")}</a> &nbsp;·&nbsp; <a href="${link}" style="color:#ffffff;text-decoration:none;font-weight:600">${T("Mi cuenta", "My account")}</a> &nbsp;·&nbsp; <a href="tel:+18327023574" style="color:#ffffff;text-decoration:none;font-weight:600">${OFFICE}</a></div>
<div style="margin-top:12px;color:#9a99a3">5373 W Alabama St, Suite 448, Houston, TX<br>
${esc(T("Recibe este aviso porque tiene una cuenta en jasonaguirregroup.company y trabaja con un agente de JAG.", "You get this notice because you have an account on jasonaguirregroup.company and work with a JAG agent."))}</div>
</td></tr>

</table></td></tr></table></body></html>`;

  const text = [headline, "",
    showNote ? `"${body}" — ${who}` : "",
    card ? [card.title, money(card.price), specs, card.mls ? "MLS #" + card.mls : ""].filter(Boolean).join(" · ") : "", "",
    T("Véalo en su cuenta JAG: ", "See it in your JAG account: ") + link,
    phone ? `${who}: ${phone}` : "", "",
    "JAG Real Estate · Jason Aguirre Group · eXp Realty · " + OFFICE,
    "5373 W Alabama St, Suite 448, Houston, TX"].filter((l, i, a) => l !== "" || (a[i - 1] !== "")).join("\n").trim();
  return { subject, html, text };
}
