/* ============================================================
   JAG loan-file formatter — shared by admin.html (lender email)
   and lender.html (secure lender page), so the lender always
   sees an application grouped the same way.
   ============================================================ */
window.JAG_FILE = (function(){
  'use strict';

  /* never shown to a lender */
  var SKIP = { access_key:1, botcheck:1, from_name:1, subject:1, __name:1,
               'SMS Consent':1, 'Source Page':1, 'Submitted At':1 };

  var SECTIONS = [
    ['Borrower', [
      'First Name','Middle Name','Last Name','Date of Birth','Phone','Email',
      'Preferred Language','Legally Married','Loan Goal','Qualifying With',
      'Work Permit Status','SSN','ITIN' ]],
    ['Employment and income', [
      'Work Status','Employer','Job Title','Employer City','Job Start Year',
      'Time at Job/Business','Pay Type','Pay Rate','Hours per Week','Salary',
      'Business Name','Business Type','Previous Employer','Gross Monthly Income' ]],
    ['Housing', [
      'Mailing Address','Years at Current Address','Own or Rent','Monthly Rent',
      'Previous Address' ]],
    ['Co-borrower', [
      'Co-borrower','Co-borrower Name','Co-borrower DOB','Co-borrower Phone',
      'Co-borrower Relationship','Co-borrower Qualifying With','Co-borrower SSN',
      'Co-borrower ITIN','Co-borrower Work Status','Co-borrower Employer',
      'Co-borrower Job Start Year','Co-borrower Pay Rate','Co-borrower Hours per Week',
      'Co-borrower Monthly Income','Combined Monthly Income' ]]
  ];

  var TAX_KEYS = { 'SSN':'borrower', 'ITIN':'borrower',
                   'Co-borrower SSN':'coborrower', 'Co-borrower ITIN':'coborrower' };

  function has(v){ return !(v == null || v === ''); }
  function str(v){ return (v !== null && typeof v === 'object') ? JSON.stringify(v) : String(v); }

  /* "•••-••-0739 (encrypted on file)" → "0739" ; anything else → '' */
  function last4(v){
    var m = /(\d{4})\s*\(encrypted on file\)/.exec(String(v == null ? '' : v));
    return m ? m[1] : '';
  }

  /* [{title, rows:[{key,label,value,tax:'borrower'|'coborrower'|null,last4}]}] */
  function sections(payload){
    var p = payload || {}, used = {}, out = [];
    SECTIONS.forEach(function(sec){
      var rows = [];
      sec[1].forEach(function(k){
        if(!has(p[k])) return;
        used[k] = 1;
        rows.push({ key:k, label:k, value:str(p[k]), tax:TAX_KEYS[k] || null, last4:last4(p[k]) });
      });
      if(rows.length) out.push({ title:sec[0], rows:rows });
    });
    var other = [];
    Object.keys(p).forEach(function(k){
      if(used[k] || SKIP[k] || !has(p[k])) return;
      other.push({ key:k, label:k, value:str(p[k]), tax:null, last4:'' });
    });
    if(other.length) out.push({ title:'Other details', rows:other });
    return out;
  }

  function qualifier(p){
    var q = String((p || {})['Qualifying With'] || '');
    if(/ITIN/i.test(q)) return 'ITIN';
    if(/SSN|Social/i.test(q)) return 'SSN';
    if(/Work Permit/i.test(q)) return 'Work permit';
    if(/Green Card|Resident/i.test(q)) return 'Green card';
    return '';
  }

  function subject(lead){
    var p = lead.payload || {};
    var bits = [qualifier(p), lead.lang || p['Preferred Language'] || ''].filter(Boolean);
    return 'New Application \u2013 ' + (lead.name || 'Client') + (bits.length ? ' (' + bits.join(', ') + ')' : '');
  }

  function fmtDay(iso){
    try{ return new Date(iso).toLocaleDateString('en-US', { month:'short', day:'numeric', year:'numeric' }); }
    catch(e){ return ''; }
  }

  /* Plain-text email. opts: {link, expires_at, note, compact} */
  function emailBody(lead, opts){
    opts = opts || {};
    var p = lead.payload || {}, L = [];
    var idWord = qualifier(p) === 'ITIN' ? 'ITIN' : 'Social Security number';
    L.push('Hi,');
    L.push('');
    L.push('New home loan application from the Jason Aguirre Group at eXp Realty.');
    if(opts.link){
      L.push('The complete file, including the full ' + idWord + ', is on our secure page:');
      L.push('');
      L.push(opts.link);
      L.push('');
      L.push('The link works until ' + fmtDay(opts.expires_at) + '. We will text you the 6-digit PIN that unlocks the full number.');
    }
    if(has(opts.note)){
      L.push('');
      L.push('NOTE FROM OUR TEAM');
      L.push(String(opts.note).trim());
    }
    if(!opts.compact){
      sections(p).forEach(function(sec){
        L.push('');
        L.push(sec.title.toUpperCase());
        sec.rows.forEach(function(r){
          var v = r.value;
          if(r.tax && r.last4) v = 'ending in ' + r.last4 + ' (full number on the secure page)';
          L.push(r.label + ': ' + v);
        });
      });
    }else{
      L.push('');
      L.push('The full application summary is on the secure page.');
    }
    L.push('');
    L.push('Thank you,');
    L.push('Jason Aguirre Group | eXp Realty');
    return L.join('\n');
  }

  /* ---------- branded HTML email ----------
     Tables + inline styles only: this HTML is copied to the clipboard and pasted into Gmail,
     then read in Gmail / Outlook / Apple Mail, all of which strip <style> blocks and classes. */
  function escH(v){
    return String(v == null ? '' : v).replace(/[&<>"']/g, function(c){
      return { '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c];
    });
  }
  function emailHtml(lead, opts){
    opts = opts || {};
    var p = lead.payload || {}, q = qualifier(p);
    var idWord = q === 'ITIN' ? 'ITIN' : 'Social Security number';
    var INK = '#17161c', RED = '#c8102e', MUTED = '#63626b', LINE = '#e4e4ea', HAIR = '#ececf1';
    var F = "font-family:'Plus Jakarta Sans','Segoe UI',Helvetica,Arial,sans-serif;";
    var T = '<table role="presentation" cellpadding="0" cellspacing="0" border="0" ';
    var h = [];

    var lang = lead.lang || p['Preferred Language'] || '';
    var facts = [];
    if(q) facts.push('Qualifying with ' + (q === 'SSN' ? 'a Social Security number' : q === 'ITIN' ? 'an ITIN' : 'a ' + q.toLowerCase()) + '.');
    if(lang) facts.push('Prefers ' + lang + '.');
    if(lead.created_at) facts.push('Applied ' + fmtDay(lead.created_at) + '.');

    h.push(T + 'width="600" style="width:600px;max-width:100%;border-collapse:collapse;border:1px solid ' + LINE + ';background:#ffffff;' + F + '">');

    /* header band with the JAG lockup */
    h.push('<tr><td bgcolor="' + INK + '" style="background:' + INK + ';padding:20px 28px;">' +
      T + 'width="100%"><tr>' +
        '<td valign="bottom">' + T + '>' +
          '<tr><td style="' + F + 'font-size:8px;line-height:10px;letter-spacing:3px;font-weight:700;color:#b9b8c2;">EST. 2018</td></tr>' +
          '<tr><td style="' + F + 'font-size:27px;line-height:30px;letter-spacing:-1px;font-weight:800;color:#ffffff;padding:1px 0 3px;">JAG</td></tr>' +
          '<tr><td style="' + F + 'font-size:8px;line-height:10px;letter-spacing:3.4px;font-weight:700;color:#ffffff;border-top:2px solid ' + RED + ';padding-top:4px;">HOME LOANS</td></tr>' +
        '</table></td>' +
        '<td align="right" valign="bottom" style="' + F + 'font-size:13px;line-height:18px;color:#b9b8c2;">New loan application</td>' +
      '</tr></table></td></tr>');

    /* who */
    h.push('<tr><td style="padding:28px 28px 0;">' +
      '<div style="' + F + 'font-size:26px;line-height:30px;letter-spacing:-.5px;font-weight:800;color:' + INK + ';">' + escH(lead.name || 'Client') + '</div>' +
      (facts.length ? '<div style="' + F + 'font-size:14px;line-height:21px;color:' + MUTED + ';padding-top:6px;">' + escH(facts.join(' ')) + '</div>' : '') +
      '</td></tr>');

    /* secure file button */
    if(opts.link){
      h.push('<tr><td style="padding:20px 28px 0;">' +
        T + '><tr><td bgcolor="' + RED + '" style="background:' + RED + ';border-radius:4px;">' +
          '<a href="' + escH(opts.link) + '" target="_blank" style="display:inline-block;padding:13px 22px;' + F + 'font-size:15px;line-height:18px;font-weight:700;color:#ffffff;text-decoration:none;">Open the secure file</a>' +
        '</td></tr></table>' +
        '<div style="' + F + 'font-size:13px;line-height:20px;color:' + MUTED + ';padding-top:12px;">The full ' + idWord + ' is on the secure page. The link works until ' + escH(fmtDay(opts.expires_at)) +
          ', and we will text you the 6-digit PIN that unlocks the number.</div>' +
        '<div style="' + F + 'font-size:12px;line-height:18px;color:' + MUTED + ';padding-top:6px;word-break:break-all;">Button not opening? Use this link: <a href="' + escH(opts.link) + '" target="_blank" style="color:' + MUTED + ';word-break:break-all;">' + escH(opts.link) + '</a></div>' +
        '</td></tr>');
    }

    /* note from the team */
    if(has(opts.note)){
      h.push('<tr><td style="padding:22px 28px 0;">' + T + 'width="100%"><tr>' +
        '<td style="border-left:3px solid ' + RED + ';padding:2px 0 2px 14px;">' +
          '<div style="' + F + 'font-size:12.5px;line-height:18px;font-weight:700;color:' + MUTED + ';">Note from our team</div>' +
          '<div style="' + F + 'font-size:15px;line-height:23px;color:' + INK + ';">' + escH(String(opts.note).trim()).replace(/\n/g, '<br>') + '</div>' +
        '</td></tr></table></td></tr>');
    }

    /* the file, grouped */
    sections(p).forEach(function(sec){
      h.push('<tr><td style="padding:26px 28px 0;">' + T + 'width="100%" style="border-collapse:collapse;">');
      h.push('<tr><td colspan="2" style="' + F + 'font-size:15px;line-height:20px;font-weight:800;color:' + INK + ';padding:0 0 8px;border-bottom:1px solid ' + LINE + ';">' + escH(sec.title) + '</td></tr>');
      sec.rows.forEach(function(r){
        var v = escH(r.value);
        if(r.tax && r.last4) v = 'Ending in ' + escH(r.last4) + ' <span style="font-weight:400;color:' + MUTED + ';">(full number on the secure page)</span>';
        h.push('<tr>' +
          '<td width="40%" valign="top" style="' + F + 'font-size:14px;line-height:20px;color:' + MUTED + ';padding:8px 12px 8px 0;border-bottom:1px solid ' + HAIR + ';">' + escH(r.label) + '</td>' +
          '<td valign="top" style="' + F + 'font-size:14px;line-height:20px;font-weight:600;color:' + INK + ';padding:8px 0;border-bottom:1px solid ' + HAIR + ';">' + v + '</td>' +
        '</tr>');
      });
      h.push('</table></td></tr>');
    });

    /* footer */
    h.push('<tr><td style="padding:26px 28px 26px;">' + T + 'width="100%"><tr>' +
      '<td style="border-top:1px solid ' + LINE + ';padding-top:16px;' + F + 'font-size:12.5px;line-height:19px;color:' + MUTED + ';">' +
        '<strong style="color:' + INK + ';">Jason Aguirre Group</strong> at eXp Realty, (832) 702-3574<br>' +
        'Confidential. This email contains a client&#39;s personal and financial information, shared at the client&#39;s request for loan pre-qualification only. If it reached you by mistake, please delete it and let us know.' +
      '</td></tr></table></td></tr>');

    h.push('</table><br>');
    return h.join('');
  }

  return { sections:sections, subject:subject, emailBody:emailBody, emailHtml:emailHtml, last4:last4, fmtDay:fmtDay };
})();
