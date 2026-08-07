/* ============================================================
   JAG lead capture → Supabase (feeds the /admin.html CRM).
   Safe no-op until configured: paste your two Supabase values
   below and every form on the site starts logging inquiries.
   The Web3Forms email path is never blocked by this.
   ============================================================ */
window.JAG_CRM = {
  url: "https://nyaxywghbpphjhwcmspd.supabase.co",  /* jag-crm  (Project Settings → API → Project URL) */
  anonKey: "sb_publishable_a3LN_l283LN8J-bJTEO8hQ_U40t09eh"  /* Supabase publishable key          (Project Settings → API → anon public) */
};

window.jagCapture = function(type, data){
  try{
    var c = window.JAG_CRM || {};
    if(!c.url || !c.anonKey || !data) return;
    var name = data.__name || data['Legal Full Name'] ||
      [ (data['First Name']||data.firstName||''), (data['Last Name']||data.lastName||'') ].join(' ').trim() ||
      data.name || null;
    var body = {
      type: type,
      name: name || null,
      email: data.Email || data.email || null,
      phone: data.Phone || data.phone || null,
      lang: data['Preferred Language'] || data.language || null,
      source: location.pathname + location.search,
      payload: data
    };
    fetch(c.url.replace(/\/+$/,'') + '/rest/v1/jag_leads', {
      method: 'POST',
      headers: {
        apikey: c.anonKey,
        Authorization: 'Bearer ' + c.anonKey,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal'
      },
      body: JSON.stringify(body)
    }).catch(function(){});
  }catch(e){}
};

/* Secure variant: inserts the lead, gets its id back, then stores tax IDs
   through the encrypted vault RPC. The full number never rides in payload. */
window.jagCaptureSecure = function(type, data, secure){
  try{
    var c = window.JAG_CRM || {};
    if(!c.url || !c.anonKey || !data) return;
    var name = data.__name || data['Legal Full Name'] ||
      [ (data['First Name']||data.firstName||''), (data['Last Name']||data.lastName||'') ].join(' ').trim() ||
      data.name || null;
    var body = {
      type: type,
      name: name || null,
      email: data.Email || data.email || null,
      phone: data.Phone || data.phone || null,
      lang: data['Preferred Language'] || data.language || null,
      source: location.pathname + location.search,
      payload: data
    };
    var base = c.url.replace(/\/+$/,'');
    /* Generate the lead id HERE — the anon key can insert but (correctly) cannot
       read rows back, so asking for the inserted row rejects the whole insert. */
    var id = (window.crypto && crypto.randomUUID) ? crypto.randomUUID()
      : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g,function(ch){
          var r=Math.random()*16|0, v=ch==='x'?r:(r&0x3|0x8); return v.toString(16);
        });
    body.id = id;
    fetch(base + '/rest/v1/jag_leads', {
      method: 'POST',
      headers: {
        apikey: c.anonKey,
        Authorization: 'Bearer ' + c.anonKey,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal'
      },
      body: JSON.stringify(body)
    }).then(function(r){
      if(!r.ok || !secure) return;
      Object.keys(secure).forEach(function(which){
        fetch(base + '/rest/v1/rpc/jag_store_tax_id', {
          method: 'POST',
          headers: {
            apikey: c.anonKey,
            Authorization: 'Bearer ' + c.anonKey,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ p_lead_id: id, p_which: which, p_value: secure[which] })
        }).catch(function(){});
      });
    }).catch(function(){});
  }catch(e){}
};
