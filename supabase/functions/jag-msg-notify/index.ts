// jag-msg-notify — emails a website client that their agent answered in Mensajes.
// Called by n8n "JAG Site · Messages" with the server token (x-jag-token). Body: { id } (a jag_messages row from the agent).
// Spanish first (English when the client chose English). Reply-to is the agent, so an email reply reaches them directly.
import { createClient } from "jsr:@supabase/supabase-js@2";
import { SITE, OFFICE, ADDRESS, money, phoneFmt, tel, row, button, agentStrip, quote, homeCard, eyebrow, h1, lead, shell, callout, esc, C, FONT } from "./jag-email.ts";

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SRK = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const RESEND = Deno.env.get("RESEND_API_KEY") || "";
const FROM = Deno.env.get("ALERTS_FROM") || "Jason Aguirre Group <alerts@updates.jasonhoustonrealty.com>";
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

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

// ---------- the email (JAG design from jag-email.ts) ----------
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
  const specs = card ? [card.beds != null ? `${card.beds} ${T("rec", "bd")}` : "", card.baths != null ? `${card.baths} ${T("baños", "ba")}` : "", card.sqft ? `${Number(card.sqft).toLocaleString("en-US")} ${T("pies²", "sqft")}` : ""].filter(Boolean).join("  ·  ") : "";
  const preheader = card && home ? [card.title, money(card.price), specs].filter(Boolean).join(" · ") : body.slice(0, 120);

  const cardHtml = !card ? "" : home
    ? homeCard({ url: link, photo: card.photo, price: card.price, specs, addr: card.title, mls: card.mls })
    : callout(eyebrow(T("Búsqueda de casas", "Home search")) + `<div style="font-size:18px;font-weight:700;margin-top:4px">${esc(card.title || T("Casas para usted", "Homes for you"))}</div>`);
  const intro = card ? (home ? T("Ya está en su cuenta JAG, en Mensajes. Véala ahí y contéstele a su agente si le interesa.", "It's waiting in your JAG account under Messages. Take a look and reply to your agent if you like it.")
      : T("Ya están en su cuenta JAG, en Mensajes. Véalas ahí y contéstele a su agente.", "They're waiting in your JAG account under Messages. Take a look and reply to your agent."))
    : T("Tiene un mensaje nuevo en su cuenta JAG:", "You have a new message in your JAG account:");
  const cta = card ? (home ? T("Ver la casa en mi cuenta", "See the home in my account") : T("Ver las casas en mi cuenta", "See the homes in my account")) : T("Ver y contestar", "View and reply");
  const after = `${home ? T("¿Le gustó? ¿Quiere ir a verla? Contéstele a", "Like it? Want to tour it? Reply to") : T("Contéstele a", "Reply to")} ${who} ${T("en su cuenta o respondiendo este correo.", "in your account or by replying to this email.")}`;

  const html = shell({ es, title: subject, preheader,
    body: row(agentStrip(full, T("Su agente · JAG Real Estate", "Your agent · JAG Real Estate"), agent?.photo_url) + h1(headline) + lead(intro) + (showNote ? quote(body, who) : "") + cardHtml, "0 32px")
      + row(button(link, cta, { full: true }) + `<p style="margin:12px 0 0;text-align:center;font-size:14px;color:${C.muted}">${esc(after)}</p>`, "12px 32px 0")
      + (phone ? row(`<div style="border-top:1px solid ${C.line};padding-top:16px;text-align:center;font-size:14px;color:${C.muted}">${T("¿Prefiere llamar o mandar texto?", "Rather call or text?")} <a href="tel:${tel(phone)}" style="color:${C.ink};font-weight:700;text-decoration:none">${esc(who)} · ${esc(phone)}</a></div>`, "20px 32px 0") : ""),
    footerNote: T("Recibe este aviso porque tiene una cuenta en jasonaguirregroup.company y trabaja con un agente de JAG.", "You get this notice because you have an account on jasonaguirregroup.company and work with a JAG agent.") });

  const text = [headline, "",
    showNote ? `"${body}" — ${who}` : "",
    card ? [card.title, money(card.price), specs, card.mls ? "MLS #" + card.mls : ""].filter(Boolean).join(" · ") : "", "",
    T("Véalo en su cuenta JAG: ", "See it in your JAG account: ") + link,
    phone ? `${who}: ${phone}` : "", "",
    "JAG Real Estate · Jason Aguirre Group · eXp Realty · " + OFFICE, ADDRESS].filter((l, i, a) => l !== "" || (a[i - 1] !== "")).join("\n").trim();
  return { subject, html, text };
}
