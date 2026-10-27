// jag-client-email — one-off emails to clients that aren't Mensajes or alerts.
// Called by the database (ops.kick_client_email → x-jag-token). Body: { kind, id }.
//   kind 'cobuyer_invite': id = jag_client_cobuyers row. "Ana lo invitó a buscar casa juntos en JAG" with an accept button.
//   kind 'investor_invite': id = jag_investors row. Private invite to the investor portal (jasonaguirregroup.company/invest), Spanish + English.
import { createClient } from "jsr:@supabase/supabase-js@2";
import { SITE, esc, row, button, agentStrip, h1, h2, lead, callout, shell, steps, eyebrow, C } from "./jag-email.ts";

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
  if (b.kind === "investor_invite") {
    const { data: i } = await db.from("jag_investors").select("*").eq("id", Number(b.id)).maybeSingle();
    if (!i || !i.active) return json({ ok: false, error: "not active" });
    const { data: jason } = await db.from("jag_agents").select("name,first_name,email,photo_url").eq("code", "jason").maybeSingle();
    const first = String(i.name || "").trim().split(/\s+/)[0] || "";
    const link = SITE + "/invest";
    const subject = "Su acceso al Portal de Inversionista JAG · Your JAG Investor Portal access";
    const what = (es: boolean) => steps(es ? [
      "Escriba la dirección de la propiedad (mayoreo o fuera del mercado).",
      "Vea los datos de la casa y las casas vendidas cerca en HAR, con el valor después de remodelar: peor, medio y mejor caso.",
      "Ponga su precio, remodelación, préstamo y meses: vea su costo total, ganancia, margen y su oferta máxima.",
      "Pídale a Lola su opinión del trato.",
    ] : [
      "Type the property address (wholesale or off-market).",
      "See the home's details and nearby HAR sold homes, with the after-repair value: worst, mid and best case.",
      "Enter your price, rehab, loan and months: see your all-in cost, profit, margin and max offer.",
      "Ask Lola for her take on the deal.",
    ]);
    const html = shell({ es: true, title: subject, preheader: "Invitación privada: análisis de flips con casas vendidas de HAR. Private invite: flip analysis from HAR sold homes.",
      body: row(eyebrow("Solo por invitación · Invite only") + h1(`${first ? first + ", " : ""}su Portal de Inversionista está listo`)
          + lead("Jason lo invitó a probar (beta) el portal privado de inversionistas de JAG. Es solo para usted: nadie más lo ve.")
          + (jason ? agentStrip(jason.name || "Jason Aguirre", "Jason Aguirre Group · eXp Realty", jason.photo_url) : "")
          + what(true)
          + callout(`<b>Cómo entrar</b><br>${esc(`Toque el botón y entre con este correo (${i.email}). Le llega un código para entrar; si no tiene cuenta, se crea en un minuto.`)}`)
          + button(link, "Abrir mi Portal de Inversionista", { full: true })
          + `<div style="border-top:1px solid ${C.line};margin-top:26px"></div>`
          + h2(`${first ? first + ", y" : "Y"}our Investor Portal is ready`)
          + lead("Jason invited you to beta-test JAG's private investor portal. It's only for you — no one else can see it.")
          + what(false)
          + callout(`<b>How to get in</b><br>${esc(`Tap the button and sign in with this email (${i.email}). You'll get a code to sign in; if you don't have an account yet, it takes a minute.`)}`)
          + button(link, "Open my Investor Portal", { full: true, kind: "outline" })
          + `<p style="margin:14px 0 0;font-size:13px;color:${C.muted};text-align:center">${esc("Los valores son estimados con casas vendidas, no son un avalúo. · Values are estimates from sold homes, not an appraisal.")}</p>`, "0 32px"),
      footerNote: "Recibe este correo porque Jason Aguirre lo invitó al Portal de Inversionista. · You got this email because Jason Aguirre invited you to the Investor Portal." });
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST", headers: { Authorization: `Bearer ${RESEND}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: FROM, to: [i.email], reply_to: (jason && jason.email) || i.invited_by || undefined, subject, html }),
    });
    const t = await r.text();
    await db.from("jag_investors").update(r.ok ? { email_error: null, email_sent_at: new Date().toISOString() } : { email_error: ("resend " + r.status + " " + t).slice(0, 300) }).eq("id", i.id);
    return json({ ok: r.ok });
  }
  return json({ ok: false, error: "unknown kind" }, 400);
});
