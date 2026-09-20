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

  return { sections:sections, subject:subject, emailBody:emailBody, last4:last4, fmtDay:fmtDay };
})();
