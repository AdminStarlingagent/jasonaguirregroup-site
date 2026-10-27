// jag-client-email — one-off emails to clients that aren't Mensajes or alerts.
// Called by the database (ops.kick_client_email → x-jag-token). Body: { kind, id }.
//   kind 'cobuyer_invite': id = jag_client_cobuyers row. "Ana lo invitó a buscar casa juntos en JAG" with an accept button.
import { createClient } from "jsr:@supabase/supabase-js@2";
import { SITE, esc, row, button, agentStrip, h1, lead, callout, shell, C } from "./jag-email.ts";

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SRK = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const RESEND = Deno.env.get("RESEND_API_KEY") || "";
const FROM = Deno.env.get("ALERTS_FROM") || "Jason Aguirre Group <alerts@updates.jasonhoustonrealty.com>";
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ ok: false, error: "POST only" }, 405);
  const db = createClient(SB_URL, SRK);
  const { data: tokOk } = await db.rpc("jag_alerts_token_ok", { p_token: req.headers.get("x-jag-token") || "" });
  if (tokOk !== true) return json({ ok: false, error: "forbidden" }, 403);
  if (!RESEND) return json({ ok: false, error: "RESEND_API_KEY missing" }, 500);
  let b: any = {}; try { b = await req.json(); } catch { /* empty */ }

  if (b.kind === "cobuyer_invite") {
    const { data: k } = await db.from("jag_client_cobuyers").select("*").eq("id", Number(b.id)).maybeSingle();
    if (!k || k.accepted_at || k.declined_at) return json({ ok: false, error: "not pending" });
    const { data: o } = await db.from("jag_clients").select("name,email,lang,agent_code").eq("user_id", k.owner).maybeSingle();
    if (!o) return json({ ok: false, error: "owner gone" });
    const { data: a } = o.agent_code ? await db.from("jag_agents").select("name,first_name,photo_url").eq("code", o.agent_code).maybeSingle() : { data: null };
    const who = String(o.name || "").trim() || o.email;
    const first = String(k.name || "").trim().split(/\s+/)[0] || "";
    const link = SITE + "/account?invite=1#profile";
    const es = o.lang !== "en";
    const subject = es ? `${who} lo invitó a buscar casa juntos en JAG` : `${who} invited you to house-hunt together on JAG`;
    const html = shell({ es, title: subject, preheader: es ? "Guarden casas juntos y hablen con su agente en un solo lugar." : "Save homes together and talk to your agent in one place.",
      body: row(h1(es ? `${first ? first + ", " : ""}${who} lo invitó a buscar casa juntos` : `${first ? first + ", " : ""}${who} invited you to house-hunt together`)
          + lead(es ? `Con su cuenta JAG van a ver las mismas casas guardadas y los mismos mensajes con su agente${a ? " (" + (a.name || a.first_name) + ")" : ""}.`
                    : `With your JAG account you'll both see the same saved homes and the same messages with your agent${a ? " (" + (a.name || a.first_name) + ")" : ""}.`)
          + (a ? agentStrip(a.name || a.first_name, es ? "Su agente · JAG Real Estate" : "Your agent · JAG Real Estate", a.photo_url) : "")
          + callout(`<b>${esc(es ? "Cómo aceptar" : "How to accept")}</b><br>${esc(es ? `Entre con este correo (${k.email}). Si no tiene cuenta, se crea en un minuto. Luego toque “Aceptar”.` : `Sign in with this email (${k.email}). If you don't have an account, it takes a minute. Then tap “Accept”.`)}`)
          + button(link, es ? "Aceptar la invitación" : "Accept the invitation", { full: true })
          + `<p style="margin:14px 0 0;font-size:13.5px;color:${C.muted};text-align:center">${esc(es ? "¿No conoce a esta persona? Ignore este correo." : "Don't know this person? Just ignore this email.")}</p>`
          + `<p style="margin:10px 0 0;font-size:13.5px;color:${C.muted};text-align:center">${esc(es ? `${who} invited you to share a JAG home search. Tap the button to accept.` : `${who} lo invitó a compartir su búsqueda de casas en JAG. Toque el botón para aceptar.`)}</p>`, "0 32px"),
      footerNote: es ? "Recibe este correo porque un cliente de JAG lo invitó a su cuenta." : "You got this email because a JAG client invited you to their account." });
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST", headers: { Authorization: `Bearer ${RESEND}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: FROM, to: [k.email], reply_to: o.email || undefined, subject, html }),
    });
    const t = await r.text();
    await db.from("jag_client_cobuyers").update(r.ok ? { email_error: null } : { email_error: ("resend " + r.status + " " + t).slice(0, 300) }).eq("id", k.id);
    return json({ ok: r.ok });
  }
  return json({ ok: false, error: "unknown kind" }, 400);
});
