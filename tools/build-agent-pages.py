#!/usr/bin/env python3
"""Builds the shareable agent profile pages: agente/<code>.html (served at jasonaguirregroup.company/agente/<code>).

Each one is a copy of agente.html with the agent baked in, plus its own link preview (WhatsApp / Facebook / iMessage
show the agent's name, title and photo). Run it after adding a new agent to the public team:

    python3 tools/build-agent-pages.py            # reads the agents from Supabase (public profile lookup)
    python3 tools/build-agent-pages.py jason monica   # just these

agente.html?a=<code> works for any agent even without a built page.
"""
import html, json, os, sys, urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
API = "https://nyaxywghbpphjhwcmspd.supabase.co"
KEY = "sb_publishable_a3LN_l283LN8J-bJTEO8hQ_U40t09eh"
SITE = "https://jasonaguirregroup.company"


def rpc(name, args):
    req = urllib.request.Request(f"{API}/rest/v1/rpc/{name}", data=json.dumps(args).encode(), method="POST",
                                 headers={"apikey": KEY, "Authorization": f"Bearer {KEY}", "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read())


def main():
    codes = sys.argv[1:]
    if not codes:
        codes = [m["card"]["code"] for m in rpc("jag_team_public", {})]
    tpl = open(os.path.join(ROOT, "agente.html"), encoding="utf-8").read()
    os.makedirs(os.path.join(ROOT, "agente"), exist_ok=True)
    for code in codes:
        p = rpc("jag_agent_profile", {"p_code": code})
        if not p.get("ok"):
            print("skip", code, "(no public profile)")
            continue
        a = p["agent"]
        closed = (p.get("stats") or {}).get("closed") or 0
        title = f"{a['name']} — {a.get('title_es') or 'Agente'} · Jason Aguirre Group"
        desc = (f"{closed} familias ayudadas. " if closed else "") + f"Videos, casas vendidas y zonas de {a['first_name']}. eXp Realty · Houston."
        img = a.get("photo_url") or f"{SITE}/og-image.png"
        url = f"{SITE}/agente/{code}"
        og = "\n".join([
            f'<link rel="canonical" href="{url}">',
            f'<meta property="og:type" content="profile">',
            f'<meta property="og:title" content="{html.escape(title)}">',
            f'<meta property="og:description" content="{html.escape(desc)}">',
            f'<meta property="og:image" content="{html.escape(img)}">',
            f'<meta property="og:url" content="{url}">',
            f'<meta name="twitter:card" content="summary">',
            f'<script>window.AGENT_CODE={json.dumps(code)};</script>',
        ])
        page = tpl.replace("<!--OG-->", og, 1)
        page = page.replace("<title>Nuestro equipo — Jason Aguirre Group · eXp Realty</title>", f"<title>{html.escape(title)}</title>", 1)
        page = page.replace('content="Conozca a su agente del Jason Aguirre Group: videos, casas vendidas y las zonas donde trabaja. eXp Realty · Houston."',
                            f'content="{html.escape(desc)}"', 1)
        out = os.path.join(ROOT, "agente", f"{code}.html")
        open(out, "w", encoding="utf-8").write(page)
        print("built", out)


if __name__ == "__main__":
    main()
