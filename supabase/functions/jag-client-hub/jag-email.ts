// JAG Real Estate email design — the one look every JAG email uses (client notices, home alerts, lead emails, TC emails).
// Logo header + red rule, white body, dark footer with the office line. Table layout + inline styles so it holds up in
// Gmail, Outlook and Apple Mail. Canonical copy lives in supabase/functions/_shared/jag-email.ts; each function keeps an
// identical copy next to its index.ts (run supabase/sync-email-brand.sh after editing).

export const SITE = "https://jasonaguirregroup.company";
export const CDN = "https://cdn.repliers.io/";
export const OFFICE = "(832) 702-3574";
export const OFFICE_TEL = "+18327023574";
export const ADDRESS = "5373 W Alabama St, Suite 448, Houston, TX 77056";
export const C = { ink: "#17161c", red: "#c8102e", redDark: "#a30d26", redTint: "#fdecef", muted: "#6a6972", card: "#f5f5f7", line: "#e8e8ec", ok: "#1a5c31", okTint: "#e9f5ec" };
export const FONT = "'Plus Jakarta Sans',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

export const esc = (v: unknown) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
export const money = (n: unknown) => {
  if (n == null || n === "") return "";
  const v = Number(String(n).replace(/[^0-9.]/g, ""));
  return isFinite(v) && v > 0 ? "$" + Math.round(v).toLocaleString("en-US") : "";
};
export const phoneFmt = (p: unknown) => {
  const d = String(p || "").replace(/\D/g, "").replace(/^1(?=\d{10}$)/, "");
  return d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : String(p || "");
};
export const tel = (p: unknown) => { const d = String(p || "").replace(/\D/g, "").replace(/^1(?=\d{10}$)/, ""); return d.length === 10 ? "+1" + d : d; };

/** A body row (white). pad = CSS padding. */
export const row = (html: string, pad = "8px 32px") =>
  `<tr><td bgcolor="#ffffff" style="background:#ffffff;padding:${pad};font-family:${FONT};color:${C.ink};font-size:15px;line-height:1.55">${html}</td></tr>`;

/** Buttons: primary (red), dark (ink), outline (red border). full = full width block. */
export function button(href: string, label: string, opts: { kind?: "primary" | "dark" | "outline"; full?: boolean } = {}) {
  const k = opts.kind || "primary";
  const bg = k === "primary" ? C.red : k === "dark" ? C.ink : "#ffffff";
  const fg = k === "outline" ? C.red : "#ffffff";
  const border = k === "outline" ? `2px solid ${C.red}` : `2px solid ${bg}`;
  const a = `<a href="${esc(href)}" style="display:${opts.full ? "block" : "inline-block"};padding:${opts.full ? "14px 20px" : "11px 18px"};font-family:${FONT};font-size:${opts.full ? 16 : 15}px;font-weight:700;color:${fg};text-decoration:none;border-radius:10px;text-align:center">${esc(label)}</a>`;
  return opts.full
    ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" bgcolor="${bg}" style="background:${bg};border:${border};border-radius:10px">${a}</td></tr></table>`
    : `<table role="presentation" cellpadding="0" cellspacing="0" style="display:inline-table;margin:0 8px 8px 0"><tr><td bgcolor="${bg}" style="background:${bg};border:${border};border-radius:10px">${a}</td></tr></table>`;
}

/** Small uppercase label (red by default). */
export const eyebrow = (t: string, color = C.red) =>
  `<div style="font-family:${FONT};font-size:11px;letter-spacing:2px;font-weight:700;text-transform:uppercase;color:${color}">${esc(t)}</div>`;

export const h1 = (t: string) => `<h1 style="margin:0 0 8px;font-family:${FONT};font-size:24px;line-height:1.25;font-weight:800;letter-spacing:-.4px;color:${C.ink}">${esc(t)}</h1>`;
export const h2 = (t: string) => `<h2 style="margin:22px 0 10px;font-family:${FONT};font-size:17px;line-height:1.3;font-weight:800;color:${C.ink}">${esc(t)}</h2>`;
export const lead = (t: string) => `<p style="margin:0 0 16px;font-family:${FONT};font-size:15px;line-height:1.55;color:${C.muted}">${esc(t)}</p>`;

/** Agent strip: photo (or initial), name, subline. */
export function agentStrip(name: string, sub: string, photo?: string | null) {
  const ok = /^https:\/\//.test(String(photo || ""));
  const av = ok
    ? `<img src="${esc(photo)}" width="48" height="48" alt="" style="display:block;width:48px;height:48px;border-radius:24px;object-fit:cover;border:0">`
    : `<table role="presentation" cellpadding="0" cellspacing="0"><tr><td width="48" height="48" align="center" bgcolor="${C.ink}" style="width:48px;height:48px;border-radius:24px;font-family:${FONT};font-size:19px;font-weight:700;color:#ffffff">${esc(String(name || "J").charAt(0).toUpperCase())}</td></tr></table>`;
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 18px"><tr><td style="padding-right:12px">${av}</td>
<td style="font-family:${FONT}"><div style="font-size:15px;font-weight:700;color:${C.ink}">${esc(name)}</div><div style="font-size:13px;color:${C.muted}">${esc(sub)}</div></td></tr></table>`;
}

/** Quote box (agent's note). */
export const quote = (text: string, by?: string) =>
  `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 16px"><tr><td style="background:${C.card};border-left:4px solid ${C.red};border-radius:0 12px 12px 0;padding:14px 18px;font-family:${FONT};font-size:16px;line-height:1.55;color:${C.ink};white-space:pre-wrap">${esc(text)}${by ? `<div style="font-size:13px;color:${C.muted};margin-top:8px;white-space:normal">— ${esc(by)}</div>` : ""}</td></tr></table>`;

/** Tinted callout box with raw inner HTML. */
export const callout = (inner: string, tone: "red" | "gray" | "green" = "gray") => {
  const bg = tone === "red" ? C.redTint : tone === "green" ? C.okTint : C.card;
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 16px"><tr><td style="background:${bg};border-radius:12px;padding:16px 18px;font-family:${FONT};font-size:15px;line-height:1.55;color:${C.ink}">${inner}</td></tr></table>`;
};

/** Home card. label: small red line above the price (e.g. "Casa nueva", "Bajó de precio"). priceHtml overrides the price line. */
export function homeCard(h: { url: string; photo?: string | null; price?: unknown; priceHtml?: string; specs?: string; addr?: string; mls?: string; label?: string; btn?: string }) {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid ${C.line};border-radius:14px;overflow:hidden;margin:0 0 18px">
${h.photo ? `<tr><td style="padding:0"><a href="${esc(h.url)}"><img src="${CDN}${esc(h.photo)}?class=large" width="536" alt="${esc(h.addr || "")}" style="display:block;width:100%;max-width:536px;height:auto;border:0"></a></td></tr>` : ""}
<tr><td style="padding:16px 18px 18px;font-family:${FONT};color:${C.ink}">
${h.label ? `<div style="font-size:12px;font-weight:700;letter-spacing:.5px;color:${C.red};margin-bottom:4px">${h.label}</div>` : ""}
${h.priceHtml || (money(h.price) ? `<div style="font-size:26px;line-height:1.2;font-weight:800;letter-spacing:-.5px">${money(h.price)}</div>` : "")}
${h.specs ? `<div style="font-size:15px;font-weight:600;margin:4px 0 2px">${esc(h.specs)}</div>` : ""}
${h.addr ? `<div style="font-size:14px;color:${C.muted}">${esc(h.addr)}</div>` : ""}
${h.mls ? `<div style="font-size:12px;color:${C.muted};margin-top:6px">MLS #${esc(h.mls)}</div>` : ""}
${h.btn ? `<div style="margin-top:14px">${button(h.url, h.btn, { full: true })}</div>` : ""}
</td></tr></table>`;
}

/** Label / value table (offer at a glance). */
export const facts = (rows: [string, string][]) =>
  `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-family:${FONT};font-size:14px;border-collapse:collapse">${rows.map((r) =>
    `<tr><td style="padding:8px 10px 8px 0;color:${C.muted};border-bottom:1px solid ${C.line};width:38%;vertical-align:top">${esc(r[0])}</td><td style="padding:8px 0;border-bottom:1px solid ${C.line};vertical-align:top;font-weight:600">${esc(r[1])}</td></tr>`).join("")}</table>`;

/** Numbered steps with red number badges. Items are trusted HTML (escape before passing). */
export const steps = (items: string[]) =>
  `<table role="presentation" width="100%" cellpadding="0" cellspacing="0">${items.map((s, i) =>
    `<tr><td width="34" valign="top" style="padding:0 10px 14px 0"><table role="presentation" cellpadding="0" cellspacing="0"><tr><td width="26" height="26" align="center" bgcolor="${C.red}" style="width:26px;height:26px;border-radius:13px;font-family:${FONT};font-size:13px;font-weight:800;color:#ffffff">${i + 1}</td></tr></table></td>
<td valign="top" style="padding:3px 0 14px;font-family:${FONT};font-size:15px;line-height:1.55;color:${C.ink}">${s}</td></tr>`).join("")}</table>`;

/**
 * The whole email. body = body rows (use row()). es = Spanish copy in the footer.
 * footerNote = why they got it (escaped here). links = extra footer links (e.g. unsubscribe) as [label, href].
 * team = true for internal emails (TC, staff): smaller footer, no "search homes" links.
 */
export function shell(o: { es: boolean; title: string; preheader?: string; body: string; footerNote?: string; links?: [string, string][]; team?: boolean; width?: number; extra?: string }) {
  const T = (s: string, e: string) => o.es ? s : e;
  const w = o.width || 600;
  const nav: [string, string][] = o.team ? [] : [[T("Buscar casas", "Search homes"), SITE + "/homes"], [T("Mi cuenta", "My account"), SITE + "/account"]];
  const footLinks = [...nav, [OFFICE, "tel:" + OFFICE_TEL] as [string, string], ...(o.links || [])]
    .map(([l, h]) => `<a href="${esc(h)}" style="color:#ffffff;text-decoration:none;font-weight:600">${esc(l)}</a>`).join(" &nbsp;·&nbsp; ");
  const pre = o.preheader ? `<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:${C.card}">${esc(o.preheader)}${"&#8199;&#65279;&#847;".repeat(20)}</div>` : "";
  return `<!doctype html><html lang="${o.es ? "es" : "en"}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light only"><meta name="supported-color-schemes" content="light">
<link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;600;700;800&display=swap" rel="stylesheet">
<title>${esc(o.title)}</title></head>
<body style="margin:0;padding:0;background:${C.card}">${pre}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" bgcolor="${C.card}" style="background:${C.card}"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:${w}px">
<tr><td align="center" bgcolor="#ffffff" style="background:#ffffff;border-radius:16px 16px 0 0;padding:26px 24px 18px;border-bottom:3px solid ${C.red}">
<a href="${SITE}" style="text-decoration:none"><img src="${SITE}/email-logo.png" width="132" alt="JAG Real Estate" style="display:block;width:132px;height:auto;border:0;font-family:${FONT};font-size:24px;font-weight:800;color:${C.ink}"></a>
<div style="font-family:${FONT};font-size:11px;letter-spacing:2px;font-weight:600;color:${C.muted};margin-top:8px">eXp REALTY</div>
</td></tr>
<tr><td bgcolor="#ffffff" style="background:#ffffff;height:22px;line-height:22px;font-size:0">&nbsp;</td></tr>
${o.body}
<tr><td bgcolor="#ffffff" style="background:#ffffff;height:26px;line-height:26px;font-size:0">&nbsp;</td></tr>
${o.extra || ""}
<tr><td bgcolor="${C.ink}" style="background:${C.ink};border-radius:0 0 16px 16px;padding:24px 32px;font-family:${FONT};color:#c9c8d0;font-size:12px;line-height:1.6;text-align:center">
<div style="font-size:14px;font-weight:800;letter-spacing:3px;color:#ffffff">JAG <span style="color:${C.red}">·</span> REAL ESTATE</div>
<div style="margin:4px 0 12px">Jason Aguirre Group · eXp Realty</div>
<div>${footLinks}</div>
<div style="margin-top:12px;color:#9a99a3">${esc(ADDRESS)}${o.footerNote ? "<br>" + esc(o.footerNote) : ""}</div>
</td></tr>
</table></td></tr></table></body></html>`;
}
