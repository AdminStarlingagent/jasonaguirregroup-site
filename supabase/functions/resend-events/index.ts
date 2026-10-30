// resend-events — Resend's webhook for JAG emails (bounces, spam complaints, deliveries).
//   POST from Resend (signed with Svix): verified with the signing secret saved in jag_kv 'resend_webhook', then
//     public.jag_email_event: a hard bounce or a complaint puts the address on jag_email_suppress, stops Lola's weekly emails
//     and screened-lead home emails for them, notes it on their profile + Follow Up Boss.
//   POST ?action=setup with header x-ops (ops secret): registers this URL as a Resend webhook (email.bounced, email.complained,
//     email.delivered, email.delivery_delayed) and saves its signing secret. Run once.
//   GET ?action=status with x-ops: whether it's set up, plus counts.
import { createClient } from "jsr:@supabase/supabase-js@2";

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SRK = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const RESEND = Deno.env.get("RESEND_API_KEY") || "";
const SELF = SB_URL + "/functions/v1/resend-events";
const EVENTS = ["email.bounced", "email.complained", "email.delivered", "email.delivery_delayed"];
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { "Content-Type": "application/json" } });

function b64(s: string) { return Uint8Array.from(atob(s), (c) => c.charCodeAt(0)); }
async function verify(secret: string, id: string, ts: string, body: string, sigHeader: string) {
  if (!secret || !id || !ts || !sigHeader) return false;
  const age = Math.abs(Date.now() / 1000 - Number(ts));
  if (!isFinite(age) || age > 600) return false;
  const key = await crypto.subtle.importKey("raw", b64(secret.replace(/^whsec_/, "")), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${id}.${ts}.${body}`)));
  const want = btoa(String.fromCharCode(...mac));
  return sigHeader.split(" ").some((p) => { const [v, s] = p.split(","); return v === "v1" && s === want; });
}

Deno.serve(async (req) => {
  const db = createClient(SB_URL, SRK);
  const url = new URL(req.url);
  const action = url.searchParams.get("action");
  if (action === "setup" || action === "status") {
    const { data: sec } = await db.rpc("jag_ops_secret");
    if (!sec || req.headers.get("x-ops") !== sec) return json({ ok: false }, 403);
    const { data: kv } = await db.from("jag_kv").select("v").eq("k", "resend_webhook").maybeSingle();
    if (action === "status") {
      const { count: ev } = await db.from("jag_email_events").select("id", { count: "exact", head: true });
      const { count: sup } = await db.from("jag_email_suppress").select("email", { count: "exact", head: true });
      return json({ ok: true, set_up: !!(kv && kv.v && kv.v.secret), webhook_id: kv?.v?.id || null, events: ev, suppressed: sup });
    }
    if (kv && kv.v && kv.v.secret && url.searchParams.get("force") !== "1") return json({ ok: true, already: true, webhook_id: kv.v.id });
    const r = await fetch("https://api.resend.com/webhooks", { method: "POST", headers: { Authorization: `Bearer ${RESEND}`, "Content-Type": "application/json" },
      body: JSON.stringify({ endpoint: SELF, events: EVENTS }) });
    const t = await r.text(); let j: any = {}; try { j = JSON.parse(t); } catch { /* text */ }
    if (!r.ok) return json({ ok: false, status: r.status, error: t.slice(0, 400) }, 502);
    let secret = j.signing_secret || j.secret || "";
    if (!secret && j.id) {   // some API versions only return the secret on a read
      const g = await fetch("https://api.resend.com/webhooks/" + j.id, { headers: { Authorization: `Bearer ${RESEND}` } });
      const gj: any = await g.json().catch(() => ({}));
      secret = gj.signing_secret || gj.secret || "";
    }
    await db.from("jag_kv").upsert({ k: "resend_webhook", v: { id: j.id || null, secret, endpoint: SELF, events: EVENTS, at: new Date().toISOString() }, updated_at: new Date().toISOString() });
    return json({ ok: true, webhook_id: j.id || null, has_secret: !!secret });
  }
  if (req.method !== "POST") return json({ ok: false, error: "POST only" }, 405);
  const body = await req.text();
  const { data: kv } = await db.from("jag_kv").select("v").eq("k", "resend_webhook").maybeSingle();
  const ok = await verify(String(kv?.v?.secret || ""), req.headers.get("svix-id") || "", req.headers.get("svix-timestamp") || "", body, req.headers.get("svix-signature") || "");
  if (!ok) return json({ ok: false, error: "bad signature" }, 401);
  let e: any = {}; try { e = JSON.parse(body); } catch { return json({ ok: false }, 400); }
  const d = e.data || {};
  const to: string[] = Array.isArray(d.to) ? d.to : d.to ? [d.to] : [];
  const bounce = d.bounce || {};
  const out: unknown[] = [];
  for (const addr of to.length ? to : [""]) {
    const { data } = await db.rpc("jag_email_event", { p: {
      type: e.type, email: String(addr || "").replace(/^.*<([^>]+)>.*$/, "$1"), resend_id: d.email_id || d.id || null, subject: d.subject || null,
      bounce_type: bounce.type || bounce.subType || null, detail: bounce.message || bounce.subType || d.reason || null,
      data: { created_at: e.created_at || null, from: d.from || null, bounce: d.bounce || null, tags: d.tags || null },
    } });
    out.push(data);
  }
  return json({ ok: true, out });
});
