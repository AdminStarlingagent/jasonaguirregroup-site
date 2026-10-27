// jag-offer-tc — hands an offer (or any task) to the transaction coordinator.
// Called by the database (ops.kick_tc → x-jag-token) right after an agent taps "Enviar al TC" on the
// website or texts Lola "tell René to …". Body: { id } (a row in ops.tc_requests).
//   1. JAG-branded email to the TC (ops.settings tc_agent_code, default René) with the offer at a glance,
//      what is still missing, and step-by-step prep instructions (+ the agent's own notes / Lola's steps).
//   2. A Follow Up Boss task assigned to the TC on the client's profile, and a note there.
import { createClient } from "jsr:@supabase/supabase-js@2";

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SRK = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const RESEND = Deno.env.get("RESEND_API_KEY") || "";
const FROM = Deno.env.get("ALERTS_FROM") || "Jason Aguirre Group <alerts@updates.jasonhoustonrealty.com>";
const SITE = "https://jasonaguirregroup.company";
const FUB = "https://api.followupboss.com/v1";
const FUB_PERSON = "https://jasonhoustonrealty.followupboss.com/2/people/view/";
const CLOSINGS = "closings@jasonhoustonrealty.com";
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { "Content-Type": "application/json" } });
const esc = (v: unknown) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
const money = (v: unknown) => { const n = Number(String(v ?? "").replace(/[^0-9.]/g, "")); return v == null || v === "" || !isFinite(n) ? "" : "$" + Math.round(n).toLocaleString("en-US"); };
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
  const ol = (items: string[]) => `<ol style="margin:0;padding-left:20px">${items.map((s) => `<li style="margin:0 0 10px">${s}</li>`).join("")}</ol>`;
  const btn = (href: string, label: string, primary = true) => `<a href="${href}" style="display:inline-block;margin:0 8px 8px 0;background:${primary ? "#c8102e" : "#ffffff"};color:${primary ? "#ffffff" : "#c8102e"};border:2px solid #c8102e;text-decoration:none;font-weight:bold;padding:11px 18px;border-radius:10px;font-size:15px">${esc(label)}</a>`;
  const html = `<!doctype html><html><body style="margin:0;background:#f5f5f7"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f7"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:640px;background:#fff;border-radius:14px"><tr><td style="padding:24px 24px 8px;font-family:Arial,Helvetica,sans-serif;color:#17161c">
<div style="font-size:26px;font-weight:bold;color:#c8102e;letter-spacing:-.5px">JAG <span style="font-size:11px;color:#5f5e68;letter-spacing:2px">REAL ESTATE · eXp Realty</span></div>
<p style="font-size:13px;letter-spacing:.12em;text-transform:uppercase;color:#5f5e68;margin:18px 0 4px;font-weight:bold">${esc(L.from)} ${esc(by.name || "JAG")}</p>
<h1 style="font-size:22px;margin:0 0 8px;line-height:1.25">${esc(heading)}</h1>
${client ? `<p style="margin:0 0 4px;font-size:15px"><b>${L.client}:</b> ${esc(client)}</p>` : ""}${fullAddr ? `<p style="margin:0 0 12px;font-size:15px"><b>${L.prop}:</b> ${esc(fullAddr)}${o.mls ? ` · MLS ${esc(o.mls)}` : ""}</p>` : ""}
<p style="margin:14px 0 6px">${o ? btn(o.link, L.open) : ""}${fubUrl ? btn(fubUrl, L.fub, !o) : ""}${homeUrl ? btn(homeUrl, L.listing, false) : ""}</p>
</td></tr>
${custom.length ? `<tr><td style="padding:8px 24px;font-family:Arial,Helvetica,sans-serif;color:#17161c"><div style="background:#fdecef;border-radius:12px;padding:16px 18px"><div style="font-weight:bold;margin-bottom:8px">${esc(L.notes)} ${esc(by.first || "")}</div>${custom.length > 1 ? ol(custom.map(esc)) : `<div style="white-space:pre-wrap">${esc(custom[0])}</div>`}</div></td></tr>` : ""}
${o ? `<tr><td style="padding:12px 24px;font-family:Arial,Helvetica,sans-serif;color:#17161c">
<h2 style="font-size:16px;margin:8px 0">${L.glance}</h2>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-size:14px;border-collapse:collapse">${rows.map((r) => `<tr><td style="padding:7px 10px 7px 0;color:#5f5e68;border-bottom:1px solid #eee;width:38%;vertical-align:top">${esc(r[0])}</td><td style="padding:7px 0;border-bottom:1px solid #eee;vertical-align:top">${esc(r[1])}</td></tr>`).join("")}</table>
<h2 style="font-size:16px;margin:20px 0 8px">${L.left}</h2>
${missing.length ? `<ul style="margin:0;padding-left:20px;color:#a30d26;font-weight:bold">${missing.map((m) => `<li style="margin:0 0 4px">${esc(m)}</li>`).join("")}</ul>` : `<p style="margin:0;color:#1a5c31;font-weight:bold">${L.none}</p>`}
<h2 style="font-size:16px;margin:20px 0 8px">${L.steps}</h2>${ol(stepsOffer)}
</td></tr>` : ""}
<tr><td style="padding:14px 24px 22px;font-family:Arial,Helvetica,sans-serif;font-size:12px;color:#85848d;border-top:1px solid #eee">
${es ? "Enviado desde JAG (sitio o Lola). Conteste este correo para hablar con" : "Sent from JAG (website or Lola). Reply to this email to reach"} ${esc(by.name || "the agent")}.<br>Jason Aguirre Group · eXp Realty · 5373 W Alabama St, Suite 448, Houston, TX
</td></tr></table></td></tr></table></body></html>`;

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
