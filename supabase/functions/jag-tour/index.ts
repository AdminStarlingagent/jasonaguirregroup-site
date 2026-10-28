// jag-tour — showings: Follow Up Boss updates and the client's tour email.
// Called only by the database (ops.kick_tour → x-jag-token). Body:
//   { action: "fub", email, phone, tags?: string[], note?: { subject, body }, task?: { name, fub_user_id } }
//       finds the client in FUB (email, then phone); adds tags, a note, and an optional task for the showing agent,
//       who is also added as a collaborator on the client (best effort). Clients not in FUB are skipped.
//   { action: "schedule", tour_id, update? }
//       emails the client their confirmed homes and times (Spanish first), reply-to the showing agent, + FUB note.
//   preview: true on "schedule" returns the email HTML instead of sending.
import { createClient } from "npm:@supabase/supabase-js@2";
import { SITE, esc, money, tel, row, button, eyebrow, h1, h2, lead, agentStrip, callout, homeCard, shell, C } from "./jag-email.ts";

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SRK = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const RESEND = Deno.env.get("RESEND_API_KEY") || "";
const FROM = Deno.env.get("ALERTS_FROM") || "Jason Aguirre Group <alerts@updates.jasonhoustonrealty.com>";
const FUB = "https://api.followupboss.com/v1";
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { "Content-Type": "application/json" } });
const digits = (p: unknown) => String(p || "").replace(/\D/g, "").replace(/^1(?=\d{10}$)/, "");

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ ok: false, error: "POST only" }, 405);
  const db = createClient(SB_URL, SRK);
  const { data: tokOk } = await db.rpc("jag_alerts_token_ok", { p_token: req.headers.get("x-jag-token") || "" });
  if (tokOk !== true) return json({ ok: false, error: "forbidden" }, 403);
  let b: any = {}; try { b = await req.json(); } catch { /* empty */ }

  const clean = (k: string) => String(k || "").trim().replace(/^basic\s+/i, "").replace(/:$/, "").trim();
  let key = clean(Deno.env.get("FUB_API_KEY") || "");
  if (!key) { const { data } = await db.rpc("jag_fub_key"); key = clean((data as string) || ""); }
  const H = { Authorization: "Basic " + btoa(key + ":"), "X-System": "JAG-Website", "Content-Type": "application/json" };
  async function fub(path: string, init: RequestInit = {}) {
    for (let a = 0; a < 3; a++) {
      const r = await fetch(FUB + path, { ...init, headers: { ...H, ...(init.headers || {}) } });
      if (r.status === 429) { await new Promise((ok) => setTimeout(ok, 1500 * (a + 1))); continue; }
      const t = await r.text(); let j: any = null; try { j = t ? JSON.parse(t) : null; } catch { j = null; }
      if (!r.ok) throw new Error(`FUB ${init.method || "GET"} ${path.split("?")[0]} ${r.status}`);
      return j;
    }
    throw new Error("FUB rate limit");
  }
  async function findPerson(email: string, phone: string) {
    if (!key) return null;
    const qs = [/@/.test(email) ? "email=" + encodeURIComponent(email.trim().toLowerCase()) : "", digits(phone).length === 10 ? "phone=" + digits(phone) : ""].filter(Boolean);
    for (const q of qs) {
      try { const j = await fub(`/people?${q}&limit=1&fields=id,tags,collaborators`); if (j && j.people && j.people[0]) return j.people[0]; } catch { /* next */ }
    }
    return null;
  }
  async function fubUpdate(o: { email?: string; phone?: string; tags?: string[]; note?: { subject?: string; body?: string }; task?: { name?: string; fub_user_id?: number } }) {
    const out: Record<string, unknown> = {};
    const p = await findPerson(String(o.email || ""), String(o.phone || ""));
    if (!p) return { ok: true, skipped: "not_in_fub" };
    out.person = p.id;
    const add = (o.tags || []).filter((t) => t && !(p.tags || []).includes(t));
    if (add.length) { try { await fub(`/people/${p.id}`, { method: "PUT", body: JSON.stringify({ tags: [...(p.tags || []), ...add] }) }); out.tags = add; } catch (e) { out.tags_err = String((e as Error).message); } }
    if (o.note && o.note.body) {
      try { await fub(`/notes`, { method: "POST", body: JSON.stringify({ personId: p.id, subject: String(o.note.subject || "JAG app").slice(0, 120), body: String(o.note.body).slice(0, 3000), isHtml: false }) }); out.note = true; }
      catch (e) { out.note_err = String((e as Error).message); }
    }
    if (o.task && o.task.name) {
      const uid = Number(o.task.fub_user_id) || undefined;
      const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago" }).format(new Date());
      try { const t = await fub(`/tasks`, { method: "POST", body: JSON.stringify({ personId: p.id, assignedUserId: uid, name: String(o.task.name).slice(0, 140), type: "Follow Up", dueDate: today }) }); out.task = t && t.id; }
      catch (e) { out.task_err = String((e as Error).message); }
      // the showing agent as a collaborator (co-agent) on the client, when FUB allows it
      if (uid && !(p.collaborators || []).some((c: any) => Number(c.id) === uid)) {
        try {
          await fub(`/people/${p.id}`, { method: "PUT", body: JSON.stringify({ collaborators: [...(p.collaborators || []).map((c: any) => ({ id: c.id })), { id: uid }] }) });
          out.collaborator = uid;
        } catch (e) { out.collab_err = String((e as Error).message); }
      }
    }
    return { ok: true, ...out };
  }

  try {
    if (b.action === "fub") return json(await fubUpdate(b));

    if (b.action === "schedule") {
      const id = Number(b.tour_id); if (!id) return json({ ok: false, error: "tour_id" }, 400);
      const { data: t } = await db.from("jag_tours").select("*").eq("id", id).single();
      if (!t) return json({ ok: false, error: "not found" }, 404);
      const [{ data: c }, { data: hs }, { data: a }] = await Promise.all([
        db.from("jag_clients").select("user_id,name,email,phone,lang").eq("user_id", t.user_id).single(),
        db.from("jag_tour_homes").select("*").eq("tour_id", id).in("status", ["confirmed", "declined"]),
        db.from("jag_agents").select("code,name,first_name,email,phone,photo_url,fub_user_id").eq("code", t.showing_agent).maybeSingle(),
      ]);
      if (!c || !/@/.test(String(c.email || ""))) return json({ ok: false, error: "no client email" });
      const es = (c.lang || "es") !== "en";
      const T = (s: string, e: string) => es ? s : e;
      const first = String(c.name || "").trim().split(/\s+/)[0] || "";
      const First = first ? first.charAt(0).toUpperCase() + first.slice(1) : "";
      const ag = a ? (a.first_name || a.name) : "JAG";
      const day = new Date(t.tour_date + "T12:00:00Z").toLocaleDateString(es ? "es-MX" : "en-US", { weekday: "long", month: "long", day: "numeric", timeZone: "UTC" });
      const time = (s: string | null) => s ? new Date(s).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/Chicago" }) : "";
      const ok = (hs || []).filter((h: any) => h.status === "confirmed").sort((x: any, y: any) => String(x.start_at || "9").localeCompare(String(y.start_at || "9")) || x.position - y.position);
      const no = (hs || []).filter((h: any) => h.status === "declined");
      if (!ok.length) return json({ ok: false, error: "nothing confirmed" });
      const page = `${SITE}/tour#${t.token}`;
      const maps = (h: any) => "https://www.google.com/maps/dir/?api=1&destination=" + encodeURIComponent([h.snap?.addr, h.snap?.city, "TX", h.snap?.zip].filter(Boolean).join(", "));
      const route = "https://www.google.com/maps/dir/" + ok.map((h: any) => encodeURIComponent([h.snap?.addr, h.snap?.city, "TX", h.snap?.zip].filter(Boolean).join(", "))).join("/");
      const cards = ok.map((h: any) => {
        const s = h.snap || {};
        const specs = [s.beds != null ? s.beds + T(" rec", " bd") : "", s.baths != null ? s.baths + T(" baños", " ba") : ""].filter(Boolean).join(" · ");
        return homeCard({ url: maps(h), photo: s.photo || null, priceHtml: `<div style="font-size:22px;line-height:1.2;font-weight:800;color:${C.red}">🕑 ${esc(time(h.start_at) || T("Hora por confirmar", "Time TBD"))}</div>`
          + (money(s.price) ? `<div style="font-size:15px;font-weight:700;margin-top:2px">${money(s.price)}</div>` : ""),
          specs, addr: [s.addr, s.city].filter(Boolean).join(", "), mls: h.mls || undefined, btn: T("Cómo llegar", "Directions") });
      }).join("");
      const subject = (b.update ? T("🔄 Cambio en su recorrido", "🔄 Change to your tour") : T("🏡 Su recorrido", "🏡 Your home tour")) + " · " + day;
      const html = shell({ es, title: subject, preheader: ok.map((h: any) => (time(h.start_at) ? time(h.start_at) + " " : "") + (h.snap?.addr || "")).join(" · "),
        body: row(agentStrip(a ? a.name : "JAG", T("Su agente de recorridos · JAG Real Estate", "Your showing agent · JAG Real Estate"), a && a.photo_url)
            + eyebrow(b.update ? T("Recorrido actualizado", "Tour updated") : T("Recorrido confirmado", "Tour confirmed"))
            + `<div style="height:6px;line-height:6px;font-size:0">&nbsp;</div>`
            + h1(T(`${First ? First + ", su" : "Su"} recorrido es el ${day}`, `${First ? First + ", your" : "Your"} tour is on ${day}`))
            + lead(T(`${ag} confirmó ${ok.length === 1 ? "esta casa" : "estas " + ok.length + " casas"}. Llegue unos minutos antes y traiga una identificación.`,
                     `${ag} confirmed ${ok.length === 1 ? "this home" : "these " + ok.length + " homes"}. Arrive a few minutes early and bring an ID.`))
            + button(page, T("Ver mi recorrido", "See my tour")) + (ok.length > 1 ? button(route, T("Ruta en el mapa", "Route on the map"), { kind: "outline" }) : "")
            + (a && a.phone ? button("tel:" + tel(a.phone), T("Llamar a ", "Call ") + ag, { kind: "outline" }) : ""), "0 32px")
          + row(cards, "8px 32px 0")
          + (no.length ? row(callout(`<b>${esc(T(no.length === 1 ? "1 casa no está disponible" : no.length + " casas no están disponibles", no.length === 1 ? "1 home isn't available" : no.length + " homes aren't available"))}</b><div style="color:${C.muted};font-size:14px;margin-top:4px">${esc(no.map((h: any) => h.snap?.addr || "MLS " + h.mls).join(" · "))}</div><div style="margin-top:6px">${esc(T(ag + " le busca otra opción.", ag + " will look for another option."))}</div>`, "gray"), "0 32px") : "")
          + row(h2(T("Después de cada casa", "After each home"))
            + `<p style="margin:0 0 12px;color:${C.muted};font-size:15px">${esc(T("Le preguntaremos qué le pareció (10 segundos). Si le encanta una, puede empezar su oferta desde su teléfono en la misma página.", "We'll ask what you thought (10 seconds). If you love one, you can start your offer from your phone on the same page."))}</p>`, "0 32px"),
        footerNote: T(`Usted pidió este recorrido en su cuenta JAG. Conteste este correo para hablar con ${ag}.`, `You asked for this tour in your JAG account. Reply to this email to reach ${ag}.`) });
      if (b.preview === true) return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
      if (!RESEND) return json({ ok: false, error: "resend" });
      const r = await fetch("https://api.resend.com/emails", {
        method: "POST", headers: { Authorization: `Bearer ${RESEND}`, "Content-Type": "application/json" },
        body: JSON.stringify({ from: FROM, to: [c.email], reply_to: (a && a.email) || undefined, subject, html }),
      });
      const sent = r.ok;
      const note = [`${b.update ? "Tour updated" : "Tour confirmed"} for ${new Date(t.tour_date + "T12:00:00Z").toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" })} with ${a ? a.name : "the showing agent"}:`,
        ...ok.map((h: any) => `${time(h.start_at) || "TBD"} ${h.snap?.addr || "MLS " + h.mls}${h.mls ? " (MLS " + h.mls + ")" : ""}`),
        ...(no.length ? ["Not available: " + no.map((h: any) => h.snap?.addr || "MLS " + h.mls).join(", ")] : []),
        sent ? "Schedule emailed to the client" + "." : "Schedule email failed.", "Tour page: " + page].join("\n");
      const f = await fubUpdate({ email: c.email, phone: c.phone, note: { subject: "🏡 Showing schedule", body: note } }).catch((e) => ({ ok: false, error: String(e) }));
      return json({ ok: sent, email: sent ? "sent" : "resend " + r.status, fub: f });
    }
    return json({ ok: false, error: "unknown action" }, 400);
  } catch (e) { return json({ ok: false, error: String((e as Error).message).slice(0, 300) }); }
});
