// jag-offer-tc — hands an offer (or any task) to the transaction coordinator.
// Called by the database (ops.kick_tc → x-jag-token) right after an agent taps "Enviar al TC" on the
// website or texts Lola "tell René to …". Body: { id } (a row in ops.tc_requests).
//   1. JAG-branded email to the TC (ops.settings tc_agent_code, default René) with the offer at a glance,
//      what is still missing, and step-by-step prep instructions (+ the agent's own notes / Lola's steps).
//   2. A Follow Up Boss task assigned to the TC on the client's profile, and a note there.
import { createClient } from "jsr:@supabase/supabase-js@2";
import { SITE, esc, money, row, button, eyebrow, h1, h2, facts, steps, callout, agentStrip, shell, C } from "./jag-email.ts";

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SRK = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const RESEND = Deno.env.get("RESEND_API_KEY") || "";
const FROM = Deno.env.get("ALERTS_FROM") || "Jason Aguirre Group <alerts@updates.jasonhoustonrealty.com>";
const FUB = "https://api.followupboss.com/v1";
const FUB_PERSON = "https://jasonhoustonrealty.followupboss.com/2/people/view/";
const CLOSINGS = "closings@jasonhoustonrealty.com";
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { "Content-Type": "application/json" } });
const digits = (p: unknown) => String(p || "").replace(/\D/g, "").replace(/^1(?=\d{10}$)/, "");

// county appraisal districts (seller names come from the tax record)
const CAD: Record<string, string> = {
  harris: "https://hcad.org/property-search/", "fort bend": "https://www.fbcad.org/", montgomery: "https://mcad-tx.org/",
  galveston: "https://www.galvestoncad.org/", brazoria: "https://www.brazoriacad.org/",
};
const LOAN: Record<string, string> = { conventional: "Conventional", fha: "FHA", va: "VA", usda: "USDA", cash: "Cash" };

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ ok: false, error: "POST only" }, 405);
  const db = createClient(SB_URL, SRK);
  const { data: tokOk } = await db.rpc("jag_alerts_token_ok", { p_token: req.headers.get("x-jag-token") || "" });
  if (tokOk !== true) return json({ ok: false, error: "forbidden" }, 403);
  let b: any = {}; try { b = await req.json(); } catch { /* empty */ }
  const id = Number(b.id); if (!id) return json({ ok: false, error: "id required" }, 400);
  const { data: P } = await db.rpc("ops_tc_payload", { p_id: id });
  if (!P || !P.ok) return json({ ok: false, error: "not found" }, 404);
  const mark = async (ok: boolean, extra: Record<string, unknown> = {}) => { await db.rpc("ops_tc_mark", { p_id: id, p_ok: ok, ...extra }); };
  const tc = P.tc || {}, by = P.by || {}, o = P.offer, t = (o && o.terms) || {};
  if (!tc.email) { await mark(false, { p_error: "TC has no email (jag_agents)" }); return json({ ok: false, error: "tc email" }); }

  // ---------- Follow Up Boss: find the client, add a task for the TC + a note ----------
  const clean = (k: string) => String(k || "").trim().replace(/^basic\s+/i, "").replace(/:$/, "").trim();
  let key = clean(Deno.env.get("FUB_API_KEY") || "");
  if (!key) { const { data } = await db.rpc("jag_fub_key"); key = clean((data as string) || ""); }
  const H = { Authorization: "Basic " + btoa(key + ":"), "X-System": "JAG-Website", "Content-Type": "application/json" };
  let personId: number | null = Number(P.fub_person_id || (o && o.fub_person_id)) || null;
  const fubNotes: string[] = [];
  if (key && !personId) {
    const tries = [t.buyer_email ? "email=" + encodeURIComponent(t.buyer_email) : "", digits(t.buyer_phone).length === 10 ? "phone=" + digits(t.buyer_phone) : ""].filter(Boolean);
    for (const q of tries) {
      try { const r = await fetch(`${FUB}/people?${q}&limit=1&fields=id`, { headers: H }); const j = await r.json(); if (j.people && j.people[0]) { personId = j.people[0].id; break; } } catch { /* next */ }
    }
  }

  // ---------- email ----------
  const es = tc.lang === "es";
  const L = es ? {
    hi: "Hola", newOffer: "Oferta nueva para preparar", task: "Tarea nueva", from: "De parte de", open: "Abrir el borrador de la oferta",
    glance: "La oferta", left: "Falta llenar", none: "Nada. Solo revise y prepare.", steps: "Cómo prepararla, paso a paso", notes: "Notas de",
    client: "Cliente", prop: "Propiedad", fub: "Ver en Follow Up Boss", listing: "Ver la casa", sign: "Para firmar",
  } : {
    hi: "Hi", newOffer: "New offer to prepare", task: "New task", from: "From", open: "Open the offer draft",
    glance: "The offer at a glance", left: "Still needed", none: "Nothing. Just review and prepare.", steps: "How to prepare it, step by step", notes: "Notes from",
    client: "Client", prop: "Property", fub: "Open in Follow Up Boss", listing: "See the home", sign: "To sign",
  };
  const fullAddr = o ? [o.property, [t.city, ["TX", t.zip].filter(Boolean).join(" ")].filter(Boolean).join(", ")].filter(Boolean).join(", ") : "";
  const homeUrl = o && o.mls ? `${SITE}/homes#${encodeURIComponent(o.mls)}` : "";
  const fubUrl = personId ? FUB_PERSON + personId : "";
  const client = P.client || (o && o.client) || t.buyer_names || "";
  const cad = CAD[String(t.county || "").toLowerCase()] || "";
  const loanLine = t.loan_type ? (LOAN[String(t.loan_type).toLowerCase()] || t.loan_type) + (String(t.loan_type).toLowerCase() !== "cash" && t.down_payment ? ` · ${String(t.down_payment).match(/%|^\d{1,2}(\.\d+)?$/) ? String(t.down_payment).replace(/%?$/, "%") : money(t.down_payment)} down` : "") : "";
  const rows: [string, string][] = o ? [
    [es ? "Comprador(es)" : "Buyer(s)", t.buyer_names || ""],
    [es ? "Contacto del comprador" : "Buyer contact", [t.buyer_email, t.buyer_phone].filter(Boolean).join(" · ")],
    [es ? "Precio" : "Price", money(t.sales_price)],
    [es ? "Financiamiento" : "Financing", loanLine],
    [es ? "Arras (earnest money)" : "Earnest money", money(t.earnest_money)],
    [es ? "Opción" : "Option", [money(t.option_fee), t.option_days ? t.option_days + (es ? " días" : " days") : ""].filter(Boolean).join(" · ")],
    [es ? "Concesión del vendedor" : "Seller concession", money(t.seller_concession)],
    [es ? "Garantía de casa" : "Home warranty", money(t.service_contract)],
    [es ? "Título" : "Title company", t.title_company || ""],
    [es ? "Cierre" : "Closing", /^\d{4}-\d{2}-\d{2}$/.test(String(t.closing_date || "")) ? new Date(t.closing_date + "T12:00:00Z").toLocaleDateString(es ? "es-MX" : "en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" }) : (t.closing_date || "")],
    [es ? "Legal" : "Legal", [t.lot ? "Lot " + t.lot : "", t.block ? "Block " + t.block : "", t.addition || ""].filter(Boolean).join(", ") + (t.county ? ` (${t.county} County)` : "")],
    ["HOA", String(t.hoa) === "true" ? [es ? "Sí" : "Yes", t.hoa_name, t.hoa_phone].filter(Boolean).join(" · ") : String(t.hoa) === "false" ? "No" : ""],
    [es ? "MUD / distritos" : "MUD / districts", t.district_notices || ""],
    [es ? "Agente del vendedor" : "Listing agent", [t.listing_agent, t.listing_firm].filter(Boolean).join(", ")],
    [es ? "Contacto del agente" : "Listing agent contact", [t.listing_agent_email, t.listing_agent_phone].filter(Boolean).join(" · ")],
    [es ? "Notas del agente" : "Agent notes", t.special_provisions || ""],
  ].filter((r) => r[1]) as [string, string][] : [];
  const missing: string[] = (o && o.missing) || [];
  const agent = by.first || "the agent";
  const stepsOffer = o ? (es ? [
    `Abra el borrador (botón de arriba). Llene lo que está en <b>Falta llenar</b>.${missing.some((m) => /seller/.test(m)) ? ` Los nombres de los vendedores salen del registro de impuestos${cad ? `: <a href="${cad}">busque la dirección aquí</a>` : " del condado"}.` : ""}`,
    `Revise lo que vino de HAR (descripción legal, HOA, agente del vendedor)${homeUrl ? ` contra <a href="${homeUrl}">la casa</a>` : ""}. Si algo no cuadra, corríjalo en el borrador.`,
    "En el borrador, baje los PDFs con <b>Download</b> en cada forma (contrato 20-19 y las adendas que aparecen). Todavía no los mande al agente del vendedor.",
    `Súbalos a DigiSign (o SkySlope) y agregue a cada comprador como firmante: firma e iniciales en cada página. ${esc(agent)} firma la sección del corredor.`,
    `Mándelos a firmar${t.buyer_email || t.buyer_phone ? ` a ${esc([t.buyer_email, t.buyer_phone].filter(Boolean).join(" / "))}` : ""} y avísele al cliente por texto que le llegó.`,
    `Ya firmados: mande la oferta al agente del vendedor${t.listing_agent_email ? ` (${esc(t.listing_agent_email)})` : ""} con copia a ${CLOSINGS}, con la pre-aprobación o comprobante de fondos. Confirme por texto o llamada que la recibió.`,
    `Marque la tarea como hecha en Follow Up Boss y conteste este correo para que ${esc(agent)} sepa que ya salió.`,
  ] : [
    `Open the draft (button above). Fill in everything under <b>Still needed</b>.${missing.some((m) => /seller/.test(m)) ? ` Seller names come from the tax record${cad ? `: <a href="${cad}">look up the address here</a>` : " (county appraisal district)"}.` : ""}`,
    `Check what came from HAR (legal description, HOA, listing agent)${homeUrl ? ` against <a href="${homeUrl}">the listing</a>` : ""}. Fix anything that doesn't match right in the draft.`,
    "In the draft, use <b>Download</b> on each form (20-19 contract plus the addenda it lists). Don't email the listing agent yet.",
    `Upload them to DigiSign (or SkySlope) and add each buyer as a signer: signature and initials on every page. ${esc(agent)} signs the broker section.`,
    `Send for signature${t.buyer_email || t.buyer_phone ? ` to ${esc([t.buyer_email, t.buyer_phone].filter(Boolean).join(" / "))}` : ""} and text the client that it's on its way.`,
    `Once signed: email the offer to the listing agent${t.listing_agent_email ? ` (${esc(t.listing_agent_email)})` : ""}, Cc ${CLOSINGS}, with the pre-approval or proof of funds. Text or call to confirm they got it.`,
    `Mark the task done in Follow Up Boss and reply to this email so ${esc(agent)} knows it went out.`,
  ]) : [];
  // the agent's / Lola's own steps: one per line, numbers stripped
  const custom = String(P.steps || "").split(/\n+/).map((s) => s.replace(/^\s*(\d+[.)]|[-•*])\s*/, "").trim()).filter(Boolean);
  const heading = o ? `${L.newOffer}: ${o.property}` : (P.title || L.task);
  const subject = o ? `${es ? "Preparar oferta" : "Prepare offer"}: ${o.property}${client ? " · " + client : ""} (${by.first || "JAG"})` : `${P.title || L.task}${client ? " · " + client : ""} (${by.first || "JAG"})`;
  const stepsHtml = stepsOffer.map((x) => x.replace(/<a href="([^"]+)">/g, `<a href="$1" style="color:${C.red};font-weight:700">`));
  const html = shell({ es, team: true, width: 640, title: subject,
    preheader: [client, fullAddr, missing.length ? (es ? "Falta: " : "Needs: ") + missing.join(", ") : ""].filter(Boolean).join(" · "),
    body: row(agentStrip(by.name || "JAG", es ? `Le manda esto a ${tc.first || "TC"} · JAG Real Estate` : `Sending this to ${tc.first || "the TC"} · JAG Real Estate`)
        + eyebrow(o ? (es ? "Oferta para preparar" : "Offer to prepare") : (es ? "Tarea para el TC" : "Task for the TC"))
        + `<div style="height:6px;line-height:6px;font-size:0">&nbsp;</div>` + h1(o ? o.property : (P.title || L.task))
        + (client ? `<div style="font-size:15px;margin:0 0 2px"><span style="color:${C.muted}">${L.client}:</span> <b>${esc(client)}</b></div>` : "")
        + (fullAddr ? `<div style="font-size:15px;margin:0 0 14px"><span style="color:${C.muted}">${L.prop}:</span> ${esc(fullAddr)}${o.mls ? ` · MLS ${esc(o.mls)}` : ""}</div>` : `<div style="height:8px"></div>`)
        + (o ? button(o.link, L.open) : "") + (fubUrl ? button(fubUrl, L.fub, { kind: o ? "outline" : "primary" }) : "") + (homeUrl ? button(homeUrl, L.listing, { kind: "outline" }) : ""), "0 32px")
      + (custom.length ? row(callout(`<div style="font-weight:800;margin-bottom:10px">${esc(L.notes)} ${esc(by.first || "")}</div>` + (custom.length > 1 ? steps(custom.map(esc)) : `<div style="white-space:pre-wrap">${esc(custom[0])}</div>`), "red"), "14px 32px 0") : "")
      + (o ? row(h2(L.glance) + facts(rows)
        + h2(L.left) + (missing.length ? callout(`<ul style="margin:0;padding-left:20px;color:${C.redDark};font-weight:700">${missing.map((m) => `<li style="margin:0 0 4px">${esc(m)}</li>`).join("")}</ul>`, "red") : callout(`<b style="color:${C.ok}">${L.none}</b>`, "green"))
        + h2(L.steps) + steps(stepsHtml), "4px 32px 0") : ""),
    footerNote: `${es ? "Enviado desde JAG (sitio o Lola). Conteste este correo para hablar con" : "Sent from JAG (website or Lola). Reply to this email to reach"} ${by.name || (es ? "el agente" : "the agent")}.` });

  if (!RESEND) { await mark(false, { p_error: "RESEND_API_KEY missing" }); return json({ ok: false, error: "resend" }); }
  const cc = by.email && by.email.toLowerCase() !== String(tc.email).toLowerCase() ? [by.email] : [];
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST", headers: { Authorization: `Bearer ${RESEND}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: FROM, to: [tc.email], cc, reply_to: by.email || undefined, subject, html }),
  });
  if (!r.ok) { const e = (await r.text()).slice(0, 200); await mark(false, { p_error: "resend " + r.status + " " + e }); return json({ ok: false, error: "resend " + r.status }); }

  // FUB task + note (best effort; the email already went out)
  let taskId: number | null = null;
  if (key && personId) {
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago" }).format(new Date());
    const name = (o ? `${es ? "Preparar oferta" : "Prepare offer"}: ${o.property}` : (P.title || custom[0] || L.task)).slice(0, 120) + ` (${by.first || "JAG"})`;
    try {
      const tr = await fetch(`${FUB}/tasks`, { method: "POST", headers: H, body: JSON.stringify({ personId, assignedUserId: tc.fub_user_id || undefined, name, type: "Follow Up", dueDate: today }) });
      const tj = await tr.json().catch(() => ({})); taskId = tj.id || null; if (!tr.ok) fubNotes.push("task " + tr.status);
    } catch (e) { fubNotes.push("task " + String(e).slice(0, 60)); }
    const note = [heading, client ? "Client: " + client : "", o ? "Draft: " + o.link : "", missing.length ? "Still needed: " + missing.join(", ") : "",
      custom.length ? "Notes: " + custom.join(" / ") : "", `Sent to ${tc.name || "the TC"} by ${by.name || "JAG"}.`].filter(Boolean).join("\n");
    try { await fetch(`${FUB}/notes`, { method: "POST", headers: H, body: JSON.stringify({ personId, subject: "Sent to the TC", body: note, isHtml: false }) }); } catch { /* fine */ }
  }
  await mark(true, { p_fub_person_id: personId, p_task_id: taskId });
  return json({ ok: true, to: tc.name, person: personId, task: taskId, fub: fubNotes });
});
