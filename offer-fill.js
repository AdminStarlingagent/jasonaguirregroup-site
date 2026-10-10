/* ============================================================
   JAG offer drafts: fills the TREC One to Four Family Residential
   Contract (Resale) 20-19 and, when the buyer is financing, the
   Third Party Financing Addendum 40-11. Used by offer-draft.html.
   Field names below are the PDF's own (many are mislabeled inside
   TREC's file; each one was matched to its spot on the page).
   The result is a flat PDF for review, then upload to the e-sign app.
   ============================================================ */
(function (root) {
  'use strict';

  var LEAD_PAINT_YEAR = 1978;

  function num(v) {
    if (v === null || v === undefined || v === '') return null;
    var n = Number(String(v).replace(/[$,%\s]/g, ''));
    return isFinite(n) ? n : null;
  }
  function money(v) {
    var n = num(v);
    if (n === null) return '';
    var cents = Math.round(n * 100) % 100 !== 0;
    return n.toLocaleString('en-US', { minimumFractionDigits: cents ? 2 : 0, maximumFractionDigits: 2 });
  }
  function str(v) { return v === null || v === undefined ? '' : String(v).trim(); }
  function isTrue(v) { return v === true || /^(true|yes|y|1)$/i.test(str(v)); }
  function isFalse(v) { return v === false || /^(false|no|n|0)$/i.test(str(v)); }

  /* Split text into lines of at most `widths[i]` characters, breaking on spaces. */
  function wrap(text, widths) {
    var words = str(text).replace(/\s+/g, ' ').split(' ');
    var lines = [], line = '', i = 0;
    words.forEach(function (w) {
      var max = widths[Math.min(i, widths.length - 1)];
      if (!line) line = w;
      else if ((line + ' ' + w).length <= max) line += ' ' + w;
      else { lines.push(line); line = w; i++; }
    });
    if (line) lines.push(line);
    return { lines: lines, overflow: lines.length > widths.length };
  }

  /* Everything the form needs, derived once from defaults + this offer's terms. */
  function compute(defaults, terms) {
    var d = Object.assign({}, defaults || {}, terms || {});
    var price = num(d.sales_price);
    var type = str(d.loan_type).toLowerCase();
    if (/conv/.test(type)) type = 'conventional';
    else if (/fha/.test(type)) type = 'fha';
    else if (/va/.test(type)) type = 'va';
    else if (/usda|rural/.test(type)) type = 'usda';
    else if (/cash/.test(type)) type = 'cash';
    var loan = null;
    if (type === 'cash') loan = 0;
    else if (num(d.loan_amount) !== null) loan = num(d.loan_amount);
    else if (price !== null && str(d.down_payment)) {
      var dp = str(d.down_payment);
      loan = /%/.test(dp) || num(dp) <= 100 ? Math.round(price * (1 - num(dp) / 100)) : price - num(dp);
    }
    var street = str(d.address);
    var cityLine = [str(d.city), [str(d.state) || 'TX', str(d.zip)].join(' ').trim()].filter(Boolean).join(', ');
    var full = street && str(d.city) && street.indexOf(',') === -1 ? street + ', ' + cityLine : street;
    var closing = null;
    if (/^\d{4}-\d{2}-\d{2}$/.test(str(d.closing_date))) {
      var p = str(d.closing_date).split('-');
      var dt = new Date(Date.UTC(+p[0], +p[1] - 1, +p[2]));
      closing = { md: dt.toLocaleDateString('en-US', { month: 'long', day: 'numeric', timeZone: 'UTC' }), yy: p[0].slice(2) };
    }
    var yearBuilt = num(d.year_built);
    return {
      d: d, price: price, type: type, loan: loan,
      cash: price !== null && loan !== null ? price - loan : null,
      financed: type && type !== 'cash',
      street: street, full: full, cityShort: street + (str(d.city) ? ', ' + str(d.city) : ''),
      closing: closing,
      closingLong: closing ? closing.md + ', 20' + closing.yy : '',
      yearBuilt: yearBuilt,
      hoa: isTrue(d.hoa),
      leadPaint: yearBuilt !== null && yearBuilt < LEAD_PAINT_YEAR
    };
  }

  /* Things that look wrong (from past offers listing agents sent back). Not blockers. */
  function warnings(c) {
    var d = c.d, w = [], em = num(d.earnest_money), opt = num(d.option_fee);
    if (c.price !== null && c.price < 50000) w.push('Sales price looks too low ($' + money(c.price) + '). Check for a missing digit.');
    if (c.price !== null && em !== null && em > c.price * 0.05) w.push('Earnest money is more than 5% of the price ($' + money(em) + '). Check for an extra digit.');
    if (c.price !== null && em !== null && em > 0 && em < c.price * 0.002) w.push('Earnest money looks very low ($' + money(em) + ').');
    if (opt !== null && em !== null && opt > em) w.push('Option fee is larger than earnest money. Check both.');
    if (c.price !== null && c.loan !== null && c.loan > c.price) w.push('Loan amount is more than the sales price.');
    if (c.type === 'fha' && c.price !== null && c.loan !== null && c.loan > c.price * 0.965 + 1) w.push('FHA loan is above 96.5% of the price. Use the base loan, without financed MIP.');
    if (num(d.option_days) !== null && num(d.option_days) > 20) w.push('Option period over 20 days. Double-check.');
    if (c.closing) {
      var p = str(d.closing_date).split('-'), days = (Date.UTC(+p[0], +p[1] - 1, +p[2]) - Date.now()) / 864e5;
      if (days < 14) w.push('Closing date is less than 2 weeks away.');
      if (days > 120) w.push('Closing date is more than 4 months away.');
    }
    if (str(d.district_notices) === '' && /mud|wcid|pid|district/i.test(str(d.special_provisions) + ' ' + str(d.addition))) w.push('Looks like a utility district: add the MUD/district notice in Closing.');
    return w;
  }

  /* Which PDFs this offer needs, in the order they go in the package. */
  function forms(c) {
    var f = [{ key: 'contract', label: 'Resale contract', form: 'TREC 20-19' }];
    if (c.financed) f.push({ key: 'tpfa', label: 'Third Party Financing Addendum', form: 'TREC 40-11' });
    if (c.hoa) f.push({ key: 'hoa', label: 'HOA addendum', form: 'TREC 36-11' });
    if (c.leadPaint) f.push({ key: 'lead', label: 'Lead-based paint addendum', form: 'TREC 56-0' });
    return f;
  }

  /* The email Jason sends listing agents with an offer, built from the same terms. */
  function offerEmail(c, attachments) {
    var d = c.d, lines = [];
    var first = str(d.listing_agent).split(' ')[0];
    var fin;
    if (c.type === 'cash') fin = 'Cash';
    else {
      var name = { fha: 'FHA', conventional: 'Conventional', va: 'VA', usda: 'USDA' }[c.type] || str(d.loan_type);
      var down = c.price !== null && c.loan !== null ? c.price - c.loan : null;
      var pct = down !== null && c.price ? Math.round(down / c.price * 1000) / 10 : null;
      fin = name + (pct !== null ? ', ' + pct + '% down ($' + money(down) + ')' : '');
    }
    var contrib = [];
    if (num(d.seller_concession)) contrib.push('up to $' + money(d.seller_concession) + " toward buyer's expenses");
    if (str(d.comp_payer) === 'seller' && num(d.comp_value) !== null)
      contrib.push(str(d.comp_type) === 'amount' ? '$' + money(d.comp_value) + ' buyer broker compensation' : num(d.comp_value) + '% buyer broker compensation');
    if (num(d.service_contract)) contrib.push('up to $' + money(d.service_contract) + ' toward a residential service contract');
    lines.push('Hi' + (first ? ' ' + first : '') + ',', '');
    lines.push('Attached is an offer from my ' + (/ and |&/.test(str(d.buyer_names)) ? 'buyers' : 'buyer') + ', ' + (str(d.buyer_names) || '[buyer]') + ', on ' + (c.street || '[property]') + '.', '');
    lines.push('Key terms:');
    lines.push('- Price: $' + (c.price !== null ? money(c.price) : '[price]'));
    lines.push('- Financing: ' + (fin || '[financing]'));
    lines.push('- Earnest money: $' + (money(d.earnest_money) || '[ ]') + ' | Option: $' + (money(d.option_fee) || '[ ]') + ' for ' + (str(d.option_days) || '[ ]') + ' days');
    lines.push('- Closing: On or before ' + (c.closingLong || '[date]'));
    if (str(d.title_company)) lines.push('- Title: ' + str(d.title_company) + ", owner's policy at " + (str(d.title_paid_by) === 'buyer' ? "buyer's" : "seller's") + ' expense');
    if (contrib.length) lines.push('- Seller to contribute ' + contrib.join(', ').replace(/, ([^,]*)$/, ', and $1'));
    if (str(d.special_provisions)) lines.push('- Special provisions: ' + str(d.special_provisions));
    if (attachments && attachments.length) lines.push('', 'Included: ' + attachments.join(', ') + '.');
    lines.push('', 'Please confirm receipt, and let me know if you need anything else.', '', 'Thank you,');
    [str(d.buyer_agent) || 'Jason Aguirre', str(d.buyer_team), str(d.buyer_firm) ? str(d.buyer_firm).replace(/, LLC$/, '') : '', str(d.buyer_agent_phone)]
      .filter(Boolean).forEach(function (l) { lines.push(l); });
    return { subject: 'Offer – ' + (c.full || c.street), body: lines.join('\n') };
  }

  /* Short labels of what still needs a human before signatures (shown on the page). */
  function missing(c) {
    var d = c.d, m = [];
    function need(ok, label) { if (!ok) m.push(label); }
    need(str(d.buyer_names), 'Buyer full legal names');
    need(str(d.seller_names), 'Seller names');
    need(c.street && str(d.city) && str(d.zip), 'Property address, city and ZIP');
    need(str(d.county), 'County');
    need(str(d.lot) || str(d.block) || str(d.addition), 'Legal description (lot, block, subdivision)');
    need(c.price !== null, 'Sales price');
    need(c.type, 'Loan type');
    need(c.loan !== null, 'Loan amount or down payment');
    need(num(d.earnest_money) !== null, 'Earnest money');
    need(num(d.option_fee) !== null, 'Option fee');
    need(num(d.option_days) !== null, 'Option days');
    need(str(d.title_company), 'Title company');
    need(c.closing, 'Closing date');
    need(str(d.survey), 'Survey choice');
    need(num(d.objection_days) !== null, 'Title objection days (6D)');
    need(str(d.sd_status), "Seller's Disclosure (received or not)");
    need(str(d.water_status), "Seller's Water Disclosure (7I)");
    need(str(d.hoa) !== '', 'HOA yes or no');
    need(c.yearBuilt !== null, 'Year built (lead-based paint addendum)');
    need(str(d.comp_payer) && num(d.comp_value) !== null, "Buyer's agent compensation (12B)");
    need(str(d.buyer_agent_license), "Agent's license number");
    need(str(d.buyer_firm_license), 'Broker firm license number');
    if (c.financed) {
      need(num(d.rate_cap) !== null, 'Interest rate cap (financing addendum)');
      need(num(d.orig_cap) !== null, 'Origination charges cap (financing addendum)');
      need(str(d.approval_days), 'Buyer Approval days, or "none" (financing addendum)');
    }
    if (c.hoa) {
      need(str(d.hoa_name), 'HOA name (HOA addendum)');
      need(str(d.hoa_option) && (/^(received|not_required)$/.test(str(d.hoa_option)) || num(d.hoa_days) !== null), 'Subdivision information choice and days (HOA addendum)');
      need(num(d.hoa_fee_cap) !== null, 'HOA transfer fees cap (HOA addendum)');
    }
    if (c.leadPaint) need(str(d.lead_inspection), 'Lead-based paint inspection: waive or inspect (lead addendum)');
    return m;
  }

  function filler(form, notes) {
    function text(name, value, size) {
      var v = str(value);
      if (!v) return;
      try {
        var f = form.getTextField(name);
        var max = f.getMaxLength();
        if (max && v.length > max) v = v.slice(0, max);
        f.setFontSize(size || 9);
        f.setText(v);
      } catch (e) { notes.push('Could not fill "' + name + '": ' + e.message); }
    }
    function box(name, on) {
      if (!on) return;
      try { form.getCheckBox(name).check(); }
      catch (e) { notes.push('Could not check "' + name + '": ' + e.message); }
    }
    function lines(names, value, widths, label) {
      if (!str(value)) return;
      var w = wrap(value, widths);
      names.forEach(function (n, i) { text(n, w.lines[i]); });
      if (w.overflow) notes.push(label + ' is too long for the form lines; put the rest in an addendum.');
    }
    return { text: text, box: box, lines: lines };
  }

  function fillContract(PDFLib, doc, c, notes) {
    var form = doc.getForm(), f = filler(form, notes), d = c.d;
    var T = f.text, B = f.box;

    ['Page 2 of 10', 'Page 3 of 10', 'Contract Concerning', 'Contract Concerning_2', 'Contract Concerning_3',
     'Page 7 of 10', 'Contract Concerning_4', 'Address of Property', 'Addr of Prop', 'Address of Property_2',
     'Address of Property_26'].forEach(function (n) { T(n, c.full); });

    /* 1-2 Parties and property */
    T('1 PARTIES The parties to this contract are', d.seller_names);
    T('Seller and', d.buyer_names);
    T('A LAND Lot', d.lot); T('Block', d.block); T('undefined', d.addition);
    T('Addition City of', d.city); T('County of', d.county);
    T('Texas known as', c.full);
    f.lines(['be removed prior to delivery of possession', 'undefined_2'], d.exclusions, [45, 95], 'Exclusions');

    /* 3 Sales price */
    if (c.price !== null) {
      T('undefined_3', money(c.cash));
      if (c.financed && c.loan) { B('B Sum of all financing described in the attached', true); T('undefined_4', money(c.loan)); }
      T('undefined_5', money(c.price));
    }

    /* 5 Earnest money and option */
    T('undefined_6', d.title_company);
    f.lines(['other party in writing before entering into a contract of sale  Disclose if applicable', 'undefined_7'],
            d.title_company_address, [30, 28], 'Title company address');
    T('as earnest money to', money(d.earnest_money));
    T('as earnest money to 2', money(d.option_fee));
    if (num(d.additional_earnest) !== null) { T('earnest money of', money(d.additional_earnest)); T('to escrow agent within', d.additional_earnest_days); }
    T('the Title Company and Buyers lenders Check one box only', d.option_days);

    /* 6 Title and survey */
    B('Sellers_2', str(d.title_paid_by) !== 'buyer');
    B('Buyers expense no later', str(d.title_paid_by) === 'buyer');
    T('insurance Title Policy issued by', d.title_company);
    var sh = str(d.shortages).toLowerCase();
    if (sh === 'none') B('2Within', true);
    if (sh === 'buyer' || sh === 'seller') { B('3Within', true); B(sh === 'buyer' ? 'is' : 'is not', true); }
    var sv = str(d.survey);
    if (sv === 'existing') {
      B('Buyer', true); T('than 3 days prior to Closing Date', d.survey_days);
      B(str(d.survey_new_paid_by) === 'seller' ? 'Within one' : 'Within two', true);
    } else if (sv === 'new_buyer') { B('Within three', true); T('3 days prior', d.survey_days); }
    else if (sv === 'new_seller') { B('Within four', true); T('receipt or the date specified in this paragraph whichever is earlier', d.survey_days); }
    T('Commitment other than items 6A1 through 9 above or which prohibit the following use', d.prohibited_use);
    T('the Commitment Exception Documents and the survey Buyers failure to object within the', d.objection_days);
    if (isTrue(d.hoa)) B('1Within', true);
    if (isFalse(d.hoa)) B('2 Within', true);

    /* 7 Property condition */
    var sd = str(d.sd_status);
    if (sd === 'received') B('1 Buyer accepts the Property As Is', true);
    if (sd === 'not_received') { B('2 Buyer accepts the Property As Is provided Seller at Sellers expense shall complete the', true); T('Within', d.sd_days); }
    if (sd === 'not_required') B('upon', true);
    if (str(d.repairs)) {
      B('As Is except', true);
      f.lines(['following specific repairs and treatments', 'undefined_13'], d.repairs, [50, 95], 'Repairs list');
    } else B('As Is', true);
    T('service contract in an amount not exceeding0', money(d.service_contract));
    var ws = str(d.water_status);
    if (ws === 'received') B('Seller as List Brok Sub agent2', true);
    if (ws === 'not_received') { B('Dollar Amt2', true); T('service contract in an amount not exceeding1', d.water_days); }
    if (ws === 'not_required') {
      B('Dollar Amt', true);
      f.lines(['service contract in an amount not exceeding3', 'service contract in an amount not exceeding'], d.water_provider, [55, 85], 'Water provider');
    }

    /* 8 Broker disclosure, 9 closing, 10 possession, 11 special provisions */
    f.lines(['Brokers and Sales4', 'Brokers and Sales', 'Brokers and Sales 2'], d.broker_disclosure, [14, 100, 100], 'Broker disclosure');
    if (c.closing) { T('A The closing of the sale will be on or before', c.closing.md); T('20', c.closing.yy); }
    B('will', str(d.possession) !== 'lease');
    B('will not be credited to the Sales Price at closing Time is of the', str(d.possession) === 'lease');
    f.lines(['Text3', 'Text3 2', 'Text3 3'], d.special_provisions, [40, 100, 100], 'Special provisions');

    /* 12 Seller contribution and brokerage compensation */
    T('acknowledged by Seller and Buyers agreement to pay Seller 1', money(d.seller_concession));
    var cp = str(d.comp_payer), ct = str(d.comp_type) === 'amount' ? 'amount' : 'pct', cv = num(d.comp_value);
    if (cv !== null && (cp === 'seller' || cp === 'buyer')) {
      var shown = ct === 'amount' ? money(cv) : String(cv);
      if (cp === 'seller') {
        B('Seller as List Brok Sub agent', true);
        if (ct === 'amount') { B('Seller as List Brok Sub agent27', true); T('acknowledged by Seller and Buyers agreement to pay Seller 130', shown); }
        else { B('Seller only as Sellers agent', true); T('acknowledged by Seller and Buyers agreement to pay Seller 31', shown); }
      } else {
        B('Dollar Amt4', true);
        if (ct === 'amount') { B('Dollar Amt5', true); T('acknowledged by Seller and Buyers agreement to pay Seller 32', shown); }
        else { B('Percentage', true); T('acknowledged by Seller and Buyers agreement to pay Seller 40', shown); }
      }
    }

    /* 21 Notices */
    f.lines(['when mailed to handdelivered at or transmitted by fax or electronic transmission as follow15', 'at7'], d.buyer_notice_address, [38, 48], 'Buyer notice address');
    T('Phone 5217', d.buyer_phone);
    T('undefined_2013', d.buyer_email);
    f.lines(['when mailed to handdelivered at or transmitted by fax or electronic transmission as follows', 'at'], d.buyer_firm_address, [38, 48], 'Broker address');
    T('Phone 52', d.buyer_agent_phone);
    T('undefined_20', d.buyer_agent_email);
    T('undefined_19', d.listing_agent_address);
    T('undefined numb 21', d.listing_agent_phone);
    T('undefined numb 22', d.listing_agent_email);

    /* 22 Addenda */
    B('Addendum for Reservation of Oil Gas', c.financed);                       /* Third Party Financing Addendum */
    B('Addendum for BackUp Contract', isTrue(d.appraisal_addendum));          /* Right to Terminate Due to Lender's Appraisal */
    B('Loan Assumption Addendum_2', c.yearBuilt !== null && c.yearBuilt < LEAD_PAINT_YEAR); /* Lead-based paint */
    B('Check Box9', isTrue(d.hoa));                                            /* Mandatory HOA membership */
    if (str(d.district_notices)) {
      B('PID', true);
      f.lines(['Brokers and Sales20', 'Brokers and Sales21'], d.district_notices, [55, 105], 'District notices');
    }

    /* Broker contact information: buyer's side */
    T('Associates Email Address', d.buyer_firm);
    T('Listing Associates Email Address', d.buyer_firm_address);
    T('Phone', d.buyer_firm_license);
    T('Licensed Supervisor of Associate', d.buyer_agent);
    T('License No_3', d.buyer_team);
    T('License No_6', d.buyer_agent_email);
    T('Other Brokers Address', d.buyer_agent_phone);
    T('Phone_2', d.buyer_agent_license);
    T('Licensed Supervisor of Listing Associate', d.buyer_supervisor);
    T('City', d.buyer_supervisor_phone);
    T('State', d.buyer_supervisor_license);
    /* listing side, when known */
    T('Other Broker Firm', d.listing_firm);
    T('License No_4', d.listing_agent);
    T('License No_2', d.listing_agent_email);
    T('List Assoc Name', d.listing_agent_phone);
  }

  function fillTpfa(PDFLib, doc, c, notes) {
    var form = doc.getForm(), f = filler(form, notes), d = c.d, T = f.text, B = f.box;
    T('Street Address and City', c.cityShort);
    T('Address of Property', c.cityShort);
    var amt = money(c.loan);
    if (c.type === 'conventional') {
      B('1 Conventional Financing', true); B('a A first mortgage loan in the principal amount of', true);
      T('years with interest not to exceed', amt);
      T('any financed PMI premium due in full in 1', d.loan_years);
      T('any financed PMI premium due in full in 2', d.rate_cap);
      T('per annum for the first', d.rate_years);
      T('shown on Buyers Loan Estimate for the loan not to exceed', d.orig_cap);
    } else if (c.type === 'fha') {
      B('3 FHA Insured Financing A Section', true);
      T('undefined', d.fha_section);
      T('excluding any financed MIP amortizable monthly for not less', amt);
      T('than', d.loan_years);
      T('years with interest not to exceed_2', d.rate_cap);
      T('Text1', d.rate_years);
      T('not to exceed', d.orig_cap);
    } else if (c.type === 'va') {
      B('6 Reverse Mortgage Financing A reverse mortgage loan also known as a Home Equity', true);
      T('excluding_2', amt);
      T('any financed Funding Fee amortizable monthly for not less than', d.loan_years);
      T('not to exceed_2', d.rate_cap);
      T('per annum for the first_3', d.rate_years);
      if (num(d.orig_cap) !== null) notes.push('VA origination cap must be written in by hand on the financing addendum (that blank shares a field with section G in TREC\'s file).');
    } else if (c.type === 'usda') {
      B('4 VA Guaranteed Financing A VA guaranteed loan of not less than', true);
      T('Charges as shown on Buyers Loan Estimate for the loan not to exceed', amt);
      T('years', d.loan_years);
      T('with interest not to exceed', d.rate_cap);
      T('excluding any financed Funding Fee amortizable monthly for not less than', d.rate_years);
      T('Estimate for the loan not to exceed', d.orig_cap);
    }
    var ad = str(d.approval_days).toLowerCase();
    if (ad === 'none' || ad === '0') B('This contract is subject to Buyer obtaining Buyer Approval If Buyer cannot obtain Buyer', true);
    else if (num(ad) !== null) { B('Check Box2', true); T('Conversion Mortgage loan in the original principal amount of', ad); }
    if (c.type === 'fha' || c.type === 'va') T('value of the Property established by the Department of Veterans Affairs', money(c.price));
  }

  /* TREC 36-11, Addendum for Property Subject to Mandatory Membership in a Property Owners Association. */
  function fillHoa(PDFLib, doc, c, notes) {
    var form = doc.getForm(), f = filler(form, notes), d = c.d, T = f.text, B = f.box;
    T('Street Address and City', c.cityShort);
    T('Name of Property Owners Association Association and Phone Number', [str(d.hoa_name), str(d.hoa_phone)].filter(Boolean).join(', '));
    var o = str(d.hoa_option);
    if (o === 'seller_delivers') { B('1 Within', true); T('the Subdivision Information to the Buyer If Seller delivers the Subdivision Information Buyer may terminate', d.hoa_days); }
    if (o === 'buyer_obtains') { B('undefined', true); T('copy of the Subdivision Information to the Seller', d.hoa_days); }
    if (o === 'received') {
      B('3Buyer has received and approved the Subdivision Information before signing the contract Buyer', true);
      B(isTrue(d.hoa_resale_cert) ? 'does' : 'does not require an updated resale certificate If Buyer requires an updated resale certificate Seller at', true);
    }
    if (o === 'not_required') B('4Buyer does not require delivery of the Subdivision Information', true);
    T('D DEPOSITS FOR RESERVES Buyer shall pay any deposits for reserves required at closing by the Association', money(d.hoa_fee_cap));
    if (str(d.hoa_info_paid_by) === 'buyer') B('Buyer', true);
    if (str(d.hoa_info_paid_by) === 'seller') B('Seller shall pay the Title Company the cost of obtaining the', true);
  }

  /* TREC 56-0, lead-based paint addendum (replaced OP-L on 7/1/2026). The buyer side fills C and D;
     the seller completes B. */
  function fillLead(PDFLib, doc, c, notes) {
    var form = doc.getForm(), f = filler(form, notes), d = c.d, B = f.box;
    f.text('Street Address and City', c.cityShort);
    var li = str(d.lead_inspection);
    B('Check Box11', li === 'waive');
    B('Check Box12', li === 'inspect');
    B('Check Box13', isTrue(d.lead_info_received));
    B('Check Box14', str(d.lead_pamphlet) === '' || isTrue(d.lead_pamphlet));
  }

  /* Fields stay fillable (not flattened) so the agent can still fix a blank in the e-sign app.
     Each form is its own PDF, the way SkySlope and DigiSign expect TREC forms. */
  async function finish(PDFLib, doc, title) {
    doc.getForm().updateFieldAppearances();
    doc.setTitle(title);
    doc.setProducer('Jason Aguirre Group offer draft');
    return doc.save({ useObjectStreams: false });
  }

  var FILLERS = { contract: fillContract, tpfa: fillTpfa, hoa: fillHoa, lead: fillLead };

  /* blanks: { contract, tpfa, hoa, lead } as ArrayBuffer/Uint8Array of the blank TREC PDFs.
     only: optional form key to build just that one. */
  async function build(PDFLib, blanks, defaults, terms, only) {
    var c = compute(defaults, terms), notes = [], out = {};
    var list = forms(c).filter(function (x) { return !only || x.key === only; });
    for (var i = 0; i < list.length; i++) {
      var x = list[i];
      if (!blanks[x.key]) continue;
      var doc = await PDFLib.PDFDocument.load(blanks[x.key]);
      FILLERS[x.key](PDFLib, doc, c, notes);
      out[x.key] = await finish(PDFLib, doc, x.form + ' draft - ' + (c.full || 'property'));
    }
    out.notes = notes; out.missing = missing(c); out.warnings = warnings(c); out.forms = forms(c); out.computed = c;
    return out;
  }

  var api = { build: build, compute: compute, missing: missing, warnings: warnings, forms: forms, offerEmail: offerEmail, money: money, num: num };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.JAGOfferFill = api;
})(this);
