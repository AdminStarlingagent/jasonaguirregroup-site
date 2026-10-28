// jag-offer-tc — hands an offer (or any task) to the transaction coordinator.
// Called by the database (ops.kick_tc → x-jag-token) right after an agent tells Lola about an offer in the
// Agent Hub, taps "Send to the JAG team" on a listing, or texts Lola "tell the TC to …". Body: { id } (ops.tc_requests).
//   Offers: email to Katherine + the TC inbox (ops.settings tc_emails), the agent copied, with the listing, the offer,
//     a ready-to-send email to the listing agent (buyer interest + title company / seller names) and SkySlope steps.
//   Other tasks: email to the TC (ops.settings tc_agent_code).
//   Both: a Follow Up Boss task for the TC on the client's profile, and a note there.
import { createClient } from "npm:@supabase/supabase-js@2";
import { SITE, OFFICE, esc, money, row, button, eyebrow, h1, h2, facts, steps, callout, agentStrip, shell, C } from "./jag-email.ts";

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
  const preview = b.preview === true; // returns the email html instead of sending (testing)
  const { data: P } = await db.rpc("ops_tc_payload", { p_id: id });
  if (!P || !P.ok) return json({ ok: false, error: "not found" }, 404);
  const mark = async (ok: boolean, extra: Record<string, unknown> = {}) => { if (!preview) await db.rpc("ops_tc_mark", { p_id: id, p_ok: ok, ...extra }); };
  const tc = P.tc || {}, by = P.by || {}, o = P.offer, t = (o && o.terms) || {};
  // offers go to Katherine + the TC inbox; other tasks to the TC
  const toPeople: { email: string; first?: string }[] = o && Array.isArray(P.tc_to) && P.tc_to.length ? P.tc_to : (tc.email ? [{ email: tc.email, first: tc.first }] : []);
  const to = toPeople.map((p) => p.email);
  if (!to.length) { await mark(false, { p_error: "no TC email (ops.settings tc_emails / jag_agents)" }); return json({ ok: false, error: "tc email" }); }
  const toNames = toPeople.map((p) => p.email === CLOSINGS ? "the TC" : (p.first || p.email)).sort((a, b) => (a === "the TC" ? 1 : 0) - (b === "the TC" ? 1 : 0));
  const toLabel = toNames.length > 1 ? toNames.slice(0, -1).join(", ") + " and " + toNames[toNames.length - 1] : toNames[0];

  // ---------- Follow Up Boss: find the client ----------
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

  // ---------- email (team emails are in English; a plain task follows the TC's language) ----------
  const es = !o && tc.lang === "es";
  const L = es ? {
    task: "Tarea nueva", notes: "Notas de", client: "Cliente", prop: "Propiedad", fub: "Ver en Follow Up Boss", listing: "Ver la casa",
  } : {
    task: "New task", notes: "Notes from", client: "Client", prop: "Property", fub: "Open in Follow Up Boss", listing: "See the listing",
  };
  const fullAddr = o ? [o.property, [t.city, ["TX", t.zip].filter(Boolean).join(" ")].filter(Boolean).join(", ")].filter(Boolean).join(", ") : "";
  const homeUrl = o && o.mls ? `${SITE}/homes#${encodeURIComponent(o.mls)}` : "";
  const fubUrl = personId ? FUB_PERSON + personId : "";
  const client = P.client || (o && o.client) || t.buyer_names || "";
  const cad = CAD[String(t.county || "").toLowerCase()] || "";
  const lt = String(t.loan_type || "").toLowerCase();
  const pct = (v: unknown) => String(v).match(/%|^\d{1,2}(\.\d+)?$/) ? String(v).replace(/%?$/, "%") : money(v);
  const loanLine = t.loan_type ? (LOAN[lt] || t.loan_type) + (lt !== "cash" && t.down_payment ? ` · ${pct(t.down_payment)} down` : "") : "";
  const dateLine = (d: unknown) => /^\d{4}-\d{2}-\d{2}$/.test(String(d || "")) ? new Date(d + "T12:00:00Z").toLocaleDateString("en-US", { weekday: "short", month: "long", day: "numeric", year: "numeric", timeZone: "UTC" }) : String(d || "");
  const missing: string[] = (o && o.missing) || [];
  // "ask listing agent", "TBD", "seller's choice" typed as the title company = we don't know it yet
  const titleTbd = !String(t.title_company || "").trim() || /\b(ask|tbd|tba|unknown|listing agent|seller'?s? (choice|pick))\b/i.test(String(t.title_company));
  if (titleTbd && !missing.includes("title company")) missing.push("title company");
  const askTitle = titleTbd, askSellers = missing.includes("seller names");
  const laFirst = String(t.listing_agent || "").trim().split(/\s+/)[0] || "";
  const agent = by.first || "the agent";

  const listingRows: [string, string][] = o ? ([
    ["Address", fullAddr + (o.mls ? ` · MLS ${o.mls}` : "")],
    ["List price", t.list_price ? money(t.list_price) + (t.days_on_market ? ` · ${t.days_on_market} days on market` : "") : ""],
    ["Legal", [t.lot ? "Lot " + t.lot : "", t.block ? "Block " + t.block : "", t.addition || ""].filter(Boolean).join(", ") + (t.county ? ` (${t.county} County)` : "")],
    ["Year built", t.year_built ? String(t.year_built) : ""],
    ["HOA", String(t.hoa) === "true" ? ["Yes", t.hoa_name, t.hoa_phone].filter(Boolean).join(" · ") : String(t.hoa) === "false" ? "No" : ""],
    ["MUD / districts", t.district_notices || ""],
    ["Listing agent", [t.listing_agent, t.listing_firm].filter(Boolean).join(", ")],
    ["Listing agent contact", [t.listing_agent_email, t.listing_agent_phone].filter(Boolean).join(" · ")],
    ["Title company", titleTbd ? "Ask the listing agent (step 1)" : t.title_company],
    ["Seller name(s)", t.seller_names || "Ask the listing agent (step 1)"],
  ] as [string, string][]).filter((r) => r[1]) : [];
  const offerRows: [string, string][] = o ? ([
    ["Buyer(s)", t.buyer_names || ""],
    ["Buyer contact", [t.buyer_email, t.buyer_phone].filter(Boolean).join(" · ")],
    ["Offer price", money(t.sales_price)],
    ["Financing", loanLine],
    ["Seller concession", money(t.seller_concession) || "None"],
    ["Earnest money", money(t.earnest_money)],
    ["Option", [money(t.option_fee), t.option_days ? t.option_days + " days" : ""].filter(Boolean).join(" · ")],
    ["Closing", dateLine(t.closing_date)],
    ["Home warranty", money(t.service_contract) || "None"],
    ["Showing agent", by.name || ""],
  ] as [string, string][]).filter((r) => r[1]) : [];

  // ---------- the email to the listing agent (TC sends it from closings@) ----------
  let laBlock = "";
  if (o) {
    const asks = [
      askTitle ? "The title company and escrow officer the seller wants to use (name, email, phone)" : `Is ${t.title_company} OK with the seller for title? If not, which title company and escrow officer?`,
      "Seller name(s) exactly as they appear on title",
      "The Seller's Disclosure Notice" + (String(t.hoa) === "true" || t.district_notices ? " and any HOA / MUD documents" : ""),
      "The existing survey and T-47, if they have them",
      "Anything the seller is looking for in an offer (closing date, leaseback, multiple offers or a deadline)",
    ];
    const subj = `Buyer interest: ${fullAddr || o.property}${o.mls ? ` (MLS ${o.mls})` : ""}`;
    const body = `Hi${laFirst ? " " + laFirst : ""},\n\n` +
      `I'm with the Jason Aguirre Group at eXp Realty. ${by.first ? by.first + " on our team" : "Our team"} showed ${o.property} to our buyer, and they're interested. We're getting an offer ready for you.\n\n` +
      `So we can write it correctly, could you send us:\n${asks.map((a) => "- " + a).join("\n")}\n\n` +
      `Thank you!\n\nJason Aguirre Group | eXp Realty\n${OFFICE} | ${CLOSINGS}`;
    const q = (s: string) => encodeURIComponent(s);
    const laEmail = String(t.listing_agent_email || "").trim();
    const gmail = `https://mail.google.com/mail/?authuser=${q(CLOSINGS)}&view=cm&fs=1&to=${q(laEmail)}&cc=${q(by.email || "")}&su=${q(subj)}&body=${q(body)}`;
    const mailto = `mailto:${laEmail}?cc=${q(by.email || "")}&subject=${q(subj)}&body=${q(body)}`;
    laBlock = h2("1. Email the listing agent first")
      + `<p style="margin:0 0 12px;font-size:14px;color:${C.muted}">Showing agents usually don't have the title company or the seller names. This email says our buyer is interested and asks for them${laEmail ? "" : ". HAR has no email for this agent, so call or text them, or add their email to the draft"}.</p>`
      + (laEmail ? button(gmail, "Write it in Gmail (closings@)") + button(mailto, "Open in my email app", { kind: "outline" }) : "")
      + (!laEmail && t.listing_agent_phone ? button("tel:+1" + digits(t.listing_agent_phone), "Call " + (laFirst || "the listing agent") + " " + t.listing_agent_phone, { kind: "outline" }) : "")
      + callout(`<div style="font-size:12px;font-weight:800;letter-spacing:1px;text-transform:uppercase;color:${C.muted};margin-bottom:6px">${laEmail ? "To " + esc(laEmail) + " · " : ""}${esc(subj)}</div><div style="white-space:pre-wrap;font-size:14px">${esc(body)}</div>`, "gray");
  }

  // ---------- SkySlope steps ----------
  const yb = parseInt(String(t.year_built || ""), 10);
  const addenda = [
    lt && lt !== "cash" ? "Third Party Financing Addendum" : "",
    String(t.hoa) === "true" ? "HOA Addendum" : "",
    t.district_notices ? "MUD / district notice" : "",
    yb && yb < 1978 ? "Lead-Based Paint Addendum (built " + yb + ")" : "",
  ].filter(Boolean);
  const link = (href: string, label: string) => `<a href="${esc(href)}" style="color:${C.red};font-weight:700">${esc(label)}</a>`;
  const stepsOffer = o ? [
    `<b>Email the listing agent</b> (section 1 above) for the title company, seller names and the seller's disclosure.`,
    `<b>Start the offer in SkySlope</b> for ${esc(fullAddr || o.property)}: One to Four Family Resale Contract${addenda.length ? " + " + esc(addenda.join(", ")) : ""}. Copy the numbers from <b>The offer</b> below, or from ${link(o.link, "the offer draft")} (everything from HAR is already in it).`,
    `<b>Fill in what the listing agent sends</b>${missing.length ? ": " + esc(missing.join(", ")) : " (title company and seller names, if they differ from above)"}.${askSellers && cad ? ` If they're slow, seller names are on the tax record: ${link(cad, "look up the address")}.` : ""}`,
    `<b>Send it for signatures in SkySlope</b>${t.buyer_email || t.buyer_phone ? ` to ${esc([t.buyer_email, t.buyer_phone].filter(Boolean).join(" / "))}` : ""}, and text the client that it's coming.`,
    `<b>Once signed, send it to the listing agent</b>${t.listing_agent_email ? ` (${esc(t.listing_agent_email)})` : ""} with the pre-approval or proof of funds, Cc ${CLOSINGS}. Call or text to confirm they got it.`,
    `<b>Reply all to this email</b> when it's out, and mark the Follow Up Boss task done, so ${esc(agent)} knows.`,
  ] : [];

  // the agent's / Lola's own notes: one per line, numbers stripped
  const custom = String(P.steps || "").split(/\n+/).map((s) => s.replace(/^\s*(\d+[.)]|[-•*])\s*/, "").trim()).filter(Boolean);
  const heading = o ? `New offer: ${o.property}` : (P.title || L.task);
  const subject = o ? `New offer: ${o.property}${client ? " · " + client : ""}${t.sales_price ? " · " + money(t.sales_price) : ""} (from ${by.first || "JAG"})`
    : `${P.title || L.task}${client ? " · " + client : ""} (${by.first || "JAG"})`;
  const html = shell({ es, team: true, width: 640, title: subject,
    preheader: [client, fullAddr, missing.length ? "Needs: " + missing.join(", ") : ""].filter(Boolean).join(" · "),
    body: row(agentStrip(by.name || "JAG", o ? `Told Lola about an offer · for ${toLabel}` : (es ? `Le manda esto a ${tc.first || "TC"} · JAG Real Estate` : `Sending this to ${tc.first || "the TC"} · JAG Real Estate`))
        + eyebrow(o ? "Offer to prepare" : (es ? "Tarea para el TC" : "Task for the TC"))
        + `<div style="height:6px;line-height:6px;font-size:0">&nbsp;</div>` + h1(o ? o.property : (P.title || L.task))
        + (client ? `<div style="font-size:15px;margin:0 0 2px"><span style="color:${C.muted}">${L.client}:</span> <b>${esc(client)}</b></div>` : "")
        + (fullAddr ? `<div style="font-size:15px;margin:0 0 14px"><span style="color:${C.muted}">${L.prop}:</span> ${esc(fullAddr)}${o.mls ? ` · MLS ${esc(o.mls)}` : ""}</div>` : `<div style="height:8px"></div>`)
        + (o ? button(o.link, "Open the offer draft") : "") + (fubUrl ? button(fubUrl, L.fub, { kind: o ? "outline" : "primary" }) : "") + (homeUrl ? button(homeUrl, L.listing, { kind: "outline" }) : ""), "0 32px")
      + (custom.length ? row(callout(`<div style="font-weight:800;margin-bottom:10px">${esc(L.notes)} ${esc(by.first || "")}</div>` + (custom.length > 1 ? steps(custom.map(esc)) : `<div style="white-space:pre-wrap">${esc(custom[0])}</div>`), "red"), "14px 32px 0") : "")
      + (o ? row(laBlock
        + h2("The listing") + facts(listingRows)
        + h2("The offer") + facts(offerRows)
        + h2("Still needed") + (missing.length ? callout(`<ul style="margin:0;padding-left:20px;color:${C.redDark};font-weight:700">${missing.map((m) => `<li style="margin:0 0 4px">${esc(m)}</li>`).join("")}</ul>`, "red") : callout(`<b style="color:${C.ok}">Nothing. Just review and prepare.</b>`, "green"))
        + h2("2. Prepare it in SkySlope, step by step") + steps(stepsOffer), "4px 32px 0") : ""),
    footerNote: o ? `Sent from the JAG Agent Hub (Lola). Reply all to reach ${by.name || "the agent"} and the team.`
      : `${es ? "Enviado desde JAG (sitio o Lola). Conteste este correo para hablar con" : "Sent from JAG (website or Lola). Reply to this email to reach"} ${by.name || (es ? "el agente" : "the agent")}.` });

  if (preview) return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
  if (!RESEND) { await mark(false, { p_error: "RESEND_API_KEY missing" }); return json({ ok: false, error: "resend" }); }
  const cc = by.email && !to.some((e) => e.toLowerCase() === String(by.email).toLowerCase()) ? [by.email] : [];
  const replyTo = o ? [...new Set([by.email, ...to].filter(Boolean))] : (by.email || undefined);
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST", headers: { Authorization: `Bearer ${RESEND}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: FROM, to, cc, reply_to: replyTo, subject, html }),
  });
  if (!r.ok) { const e = (await r.text()).slice(0, 200); await mark(false, { p_error: "resend " + r.status + " " + e }); return json({ ok: false, error: "resend " + r.status }); }

  // FUB task + note (best effort; the email already went out)
  let taskId: number | null = null;
  if (key && personId) {
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago" }).format(new Date());
    const name = (o ? `Prepare offer: ${o.property}` : (P.title || custom[0] || L.task)).slice(0, 120) + ` (${by.first || "JAG"})`;
    try {
      const tr = await fetch(`${FUB}/tasks`, { method: "POST", headers: H, body: JSON.stringify({ personId, assignedUserId: tc.fub_user_id || undefined, name, type: "Follow Up", dueDate: today }) });
      const tj = await tr.json().catch(() => ({})); taskId = tj.id || null; if (!tr.ok) fubNotes.push("task " + tr.status);
    } catch (e) { fubNotes.push("task " + String(e).slice(0, 60)); }
    const note = [heading, client ? "Client: " + client : "", o && t.sales_price ? "Offer: " + money(t.sales_price) + (loanLine ? " · " + loanLine : "") : "",
      o ? "Draft: " + o.link : "", missing.length ? "Still needed: " + missing.join(", ") : "",
      custom.length ? "Notes: " + custom.join(" / ") : "", `Sent to ${o ? toLabel : (tc.name || "the TC")} by ${by.name || "JAG"}.`].filter(Boolean).join("\n");
    try { await fetch(`${FUB}/notes`, { method: "POST", headers: H, body: JSON.stringify({ personId, subject: o ? "Offer sent to the TC" : "Sent to the TC", body: note, isHtml: false }) }); } catch { /* fine */ }
  }
  await mark(true, { p_fub_person_id: personId, p_task_id: taskId });
  return json({ ok: true, to, person: personId, task: taskId, fub: fubNotes });
});
