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
  const who = a?.first_name || m.sender_name || (es ? "Su agente" : "Your agent");
  const first = String(c.name || "").trim().split(/\s+/)[0] || "";
  const link = SITE + "/account#mensajes";
  const card = m.card && typeof m.card === "object" ? m.card : null;
  const home = card && card.kind !== "search" && card.kind !== "site";
  const subject = card ? (es ? `${who} le envió ${home ? "una casa" : "casas"} en JAG` : `${who} sent you ${home ? "a home" : "homes"} on JAG`)
    : (es ? `${who} le contestó en JAG` : `${who} replied to you on JAG`);
  const money = (n: unknown) => (n == null || !isFinite(Number(n))) ? "" : "$" + Math.round(Number(n)).toLocaleString("en-US");
  const specs = card ? [card.beds != null ? `${card.beds} ${es ? "rec" : "bd"}` : "", card.baths != null ? `${card.baths} ${es ? "baños" : "ba"}` : "", card.sqft ? `${Number(card.sqft).toLocaleString("en-US")} ${es ? "pies²" : "sqft"}` : ""].filter(Boolean).join(" · ") : "";
  const cardHtml = card ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #dddde3;border-radius:12px;overflow:hidden;margin:6px 0 4px">
${card.photo ? `<tr><td><a href="${link}"><img src="${CDN}${esc(card.photo)}?class=medium" width="516" alt="" style="display:block;width:100%;height:auto;border:0"></a></td></tr>` : ""}
<tr><td style="padding:12px 14px;font-family:Arial,Helvetica,sans-serif;color:#17161c">${card.price ? `<div style="font-size:22px;font-weight:bold">${money(card.price)}</div>` : ""}
${specs ? `<div style="font-size:14px;margin:2px 0">${esc(specs)}</div>` : ""}<div style="font-size:14px;color:#5f5e68">${esc(card.title || "")}</div></td></tr></table>` : "";
  const preview = String(m.body || "").slice(0, 600);
  const html = `<!doctype html><html><body style="margin:0;background:#f5f5f7"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f7"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#fff;border-radius:14px"><tr><td style="padding:24px 22px;font-family:Arial,Helvetica,sans-serif;color:#17161c">
<div style="font-size:12px;letter-spacing:.3em;font-weight:700;color:#c8102e">JAG REAL ESTATE</div>
<h1 style="font-size:22px;margin:14px 0 6px">${esc(card ? (es ? `Hola${first ? " " + first : ""}, ${who} le envió ${home ? "una casa" : "casas"}` : `Hi${first ? " " + first : ""}, ${who} sent you ${home ? "a home" : "homes"}`) : (es ? `Hola${first ? " " + first : ""}, ${who} le contestó` : `Hi${first ? " " + first : ""}, ${who} replied`))}</h1>
<p style="margin:0 0 16px;color:#5f5e68;font-size:15px">${esc(es ? "Tiene un mensaje nuevo de su agente en su cuenta JAG:" : "You have a new message from your agent in your JAG account:")}</p>
${preview && (!card || preview !== card.title) ? `<div style="background:#f5f5f7;border-radius:12px;padding:14px 16px;font-size:16px;line-height:1.5;white-space:pre-wrap">${esc(preview)}</div>` : ""}${cardHtml}
<p style="margin:20px 0 6px"><a href="${link}" style="display:inline-block;background:#c8102e;color:#fff;text-decoration:none;font-weight:700;padding:13px 22px;border-radius:10px">${esc(card ? (es ? "Verla en mi cuenta" : "See it in my account") : (es ? "Ver y contestar" : "View and reply"))}</a></p>
${a?.phone ? `<p style="margin:14px 0 0;font-size:14px;color:#5f5e68">${esc(es ? "¿Prefiere llamar? " : "Rather call? ")}${esc(who)}: <a href="tel:${esc(String(a.phone).replace(/[^0-9+]/g, ""))}" style="color:#17161c">${esc(a.phone)}</a></p>` : ""}
</td></tr><tr><td style="padding:14px 22px 22px;font-family:Arial,Helvetica,sans-serif;font-size:12px;color:#85848d;border-top:1px solid #eee">
Jason Aguirre Group · eXp Realty · 5373 W Alabama St, Suite 448, Houston, TX<br>
${esc(es ? "Recibe este aviso porque tiene una cuenta en jasonaguirregroup.company y trabaja con un agente de JAG." : "You get this notice because you have an account on jasonaguirregroup.company and work with a JAG agent.")}
</td></tr></table></td></tr></table></body></html>`;

  const r = await fetch("https://api.resend.com/emails", {
    method: "POST", headers: { Authorization: `Bearer ${RESEND}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: FROM, to: [c.email], reply_to: a?.email || undefined, subject, html }),
  });
  const t = await r.text();
  if (!r.ok) return json({ ok: false, error: "resend " + r.status + " " + t.slice(0, 200) }, 200);
  return json({ ok: true });
});
