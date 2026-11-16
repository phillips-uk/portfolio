// The Google Ads Check page (/google-ads-audit). Steps: customer ID, invite the Phillips. manager account, wait for the
// invitation, run (Turnstile), then the report with priced fixes. Server side: cloudflare/src/google-ads-check.js.
// Every value from the report goes in with textContent. Prices appear only here, inside a private report.
// GA4 (GTM "Site events to GA4"): ads_check_start, ads_check_complete, ads_check_error, ads_check_fix_select.
// Never the customer ID, the account name or a price in the events.
(function () {
  var $ = function (id) { return document.getElementById(id); };
  var preview = document.body.getAttribute('data-preview') === '1';
  var status = $('check-status');
  var cid = '';
  var current = null;
  if (preview) { $('preview-flag').hidden = false; }

  function track(event, params) {
    window.dataLayer = window.dataLayer || [];
    var o = { event: event };
    for (var k in params || {}) o[k] = params[k];
    window.dataLayer.push(o);
  }
  function say(msg, err) { status.textContent = msg || ''; status.className = 'check-status' + (err ? ' err' : ''); }
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function post(path, body) {
    return fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify(body || {}) })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (d) { return { ok: r.ok, status: r.status, d: d }; }); });
  }
  var shown = function (v) { return v.replace(/^(\d{3})(\d{3})(\d{4})$/, '$1-$2-$3'); };

  // ---------- Turnstile ----------
  var SITEKEY = /(^|\.)phillips-uk\.com$/.test(location.hostname) ? '0x4AAAAAAGDEt8LCJ4VVlwit' : '1x00000000000000000000AA';
  var widget = null, token = '', waiting = null, loading = false;
  window.phAdsTurnstile = function () {
    widget = turnstile.render($('check-ts'), {
      sitekey: SITEKEY, action: 'ads_check', appearance: 'interaction-only', theme: 'light',
      callback: function (t) { token = t; if (waiting) { var w = waiting; waiting = null; w(); } },
      'expired-callback': function () { token = ''; }, 'error-callback': function () { token = ''; }
    });
  };
  function loadTurnstile() {
    if (loading || preview) return; // Lewis's preview is signed in, so no bot check
    loading = true;
    var s = document.createElement('script');
    s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit&onload=phAdsTurnstile';
    s.async = true; s.defer = true;
    document.head.appendChild(s);
  }
  function withToken() {
    return new Promise(function (resolve, reject) {
      if (preview) return resolve('');
      loadTurnstile();
      if (token) return resolve(token);
      waiting = function () { resolve(token); };
      setTimeout(function () { if (waiting) { waiting = null; reject(new Error('Please tick the box to show you’re not a bot, then press the button again.')); } }, 20000);
    });
  }

  // ---------- steps ----------
  function step(name) {
    $('step-id').hidden = name !== 'id';
    $('step-invite').hidden = name !== 'invite';
    $('step-google').hidden = !(preview && name === 'id');
  }
  $('id-form').addEventListener('submit', function (e) {
    e.preventDefault();
    var v = $('cid').value.replace(/\D/g, '');
    if (v.length !== 10) { say('Enter your 10-digit customer ID, like 123-456-7890.', true); return; }
    cid = v; say(''); step('invite'); loadTurnstile();
    track('ads_check_start');
  });
  $('back').addEventListener('click', function () { step('id'); say(''); $('cid').focus(); });

  var timers = [];
  function progress(on) {
    var list = $('progress'), items = list.querySelectorAll('li');
    timers.forEach(clearTimeout); timers = [];
    items.forEach(function (li) { li.className = ''; });
    list.hidden = !on;
    if (!on) return;
    [0, 3000, 8000, 14000, 20000].forEach(function (ms, i) {
      timers.push(setTimeout(function () { items.forEach(function (li, j) { li.className = j < i ? 'done' : j === i ? 'on' : ''; }); }, ms));
    });
  }

  $('sent').addEventListener('click', function () {
    var btn = this;
    btn.disabled = true;
    say('Looking for your invitation…');
    post('/tools/google-ads-check/link', { customerId: cid }).then(function (res) {
      if (!res.ok) throw new Error(res.d.error || 'Something went wrong. Please try again.');
      var st = res.d.status;
      if (st === 'NONE') throw new Error('I can’t see the invitation from ' + shown(cid) + ' yet. It can take a minute to arrive: check it went to 495-618-4074, then press the button again.');
      if (st === 'ACTIVE' && !preview) throw new Error('This account is already linked to my manager account, so I can’t run the free check on it. Ask me a question below instead.');
      say(st === 'ACTIVE' ? 'Preview: this account is already linked, so the check reads it and leaves the link as it is.' : 'Invitation found. Running the check: this takes about half a minute.');
      progress(true);
      return withToken().then(function (t) { return post('/tools/google-ads-check/run', { customerId: cid, token: t }); });
    }).then(function (res) {
      if (!res) return;
      if (!res.ok || !res.d.report) {
        track('ads_check_error', { error_type: res.status === 429 ? 'limit' : res.d.agency ? 'agency' : res.status === 409 ? 'link' : 'other' });
        throw new Error(res.d.error || 'Something went wrong. Please try again.');
      }
      say('');
      track('ads_check_complete', { weaknesses: res.d.report.weaknesses.length });
      show(res.d.report, true);
    }).catch(function (err) { say(err.message, true); })
      .then(function () { btn.disabled = false; progress(false); token = ''; if (widget !== null && window.turnstile) turnstile.reset(widget); });
  });

  // ---------- report ----------
  var DATE = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/London' });
  var money = function (cur) { return new Intl.NumberFormat('en-GB', { style: 'currency', currency: cur || 'GBP', maximumFractionDigits: 0 }); };
  var GBP = money('GBP');
  var hrs = function (h) { return (h % 1 ? h.toFixed(1) : String(h)) + (h === 1 ? ' hour' : ' hours'); };

  function tile(label, value, sub, tone) {
    var t = el('div', 'tile' + (tone ? ' ' + tone : ''));
    t.appendChild(el('small', null, label)); t.appendChild(el('b', null, value)); if (sub) t.appendChild(el('span', null, sub));
    return t;
  }

  function finding(f, line) {
    var weak = !!line || f.fixType;
    var card = el('article', 'find ' + (weak ? 'weak ' + f.priority : 'strong'));
    card.appendChild(el('span', 'mk', weak ? '!' : '✓'));
    var body = el('div', 'fb'); card.appendChild(body);
    var h = el('h4', null, f.title);
    if (weak) h.appendChild(el('span', 'pr ' + f.priority, f.priority === 'high' ? 'Fix first' : f.priority === 'medium' ? 'Worth fixing' : 'Small'));
    body.appendChild(h);
    body.appendChild(el('p', null, f.detail));
    if (weak) {
      if (f.why) body.appendChild(el('p', 'why', f.why));
      if (f.start) { var s = el('p', 'start'); s.appendChild(el('b', null, 'Start here: ')); s.appendChild(document.createTextNode(f.start)); body.appendChild(s); }
      if (f.startLink && /^\/[a-z0-9\-\/]*$/.test(f.startLink)) { var a = el('a', 'go', 'Read more →'); a.href = f.startLink; body.appendChild(a); }
      if (line) {
        var c = el('p', 'cost');
        c.appendChild(document.createTextNode('If I fix it: about ' + hrs(line.hours) + ', '));
        c.appendChild(el('b', null, (line.fromPrice ? 'from ' : '') + GBP.format(line.price)));
        c.appendChild(document.createTextNode(' (' + line.itemLabel + ': ' + line.items + ')'));
        body.appendChild(c);
      }
    }
    return card;
  }

  function fixes(r) {
    var q = r.quote, rows = $('fix-rows'); rows.textContent = '';
    if (!q || !q.lines.length) { $('sec-fix').hidden = true; return; }
    $('sec-fix').hidden = false;
    q.lines.forEach(function (l) {
      var row = el('label', 'fix-row');
      var cb = el('input'); cb.type = 'checkbox'; cb.checked = !!l.ticked; cb.value = l.id; row.appendChild(cb);
      var t = el('span'); t.appendChild(el('span', 't', l.title)); t.appendChild(el('span', 's', ' ' + l.fixLabel)); t.querySelector('.s').style.display = 'block'; row.appendChild(t);
      row.appendChild(el('span', 'h', hrs(l.hours)));
      row.appendChild(el('span', 'p', (l.fromPrice ? 'from ' : '') + GBP.format(l.price)));
      rows.appendChild(row);
      cb.addEventListener('change', function () { options(r); track('ads_check_fix_select'); });
    });
    options(r);
  }
  function ticked(r) {
    var ids = Array.prototype.map.call(document.querySelectorAll('#fix-rows input:checked'), function (i) { return i.value; });
    return r.quote.lines.filter(function (l) { return ids.indexOf(l.id) !== -1; });
  }
  function options(r) {
    var q = r.quote, chosen = ticked(r);
    var total = chosen.reduce(function (a, l) { return a + l.price; }, 0);
    var hours = chosen.reduce(function (a, l) { return a + l.hours; }, 0);
    var from = chosen.some(function (l) { return l.fromPrice; });
    var box = $('options'); box.textContent = '';
    box.className = 'options' + (q.retainer ? '' : ' one');
    var monthlyBetter = !!q.retainer && total > q.retainer.fee * q.retainer.suggestMonths;

    var once = el('div', 'option' + (monthlyBetter ? '' : ' best'));
    once.appendChild(el('h4', null, 'Fix these once'));
    once.appendChild(el('div', 'big', chosen.length ? (from ? 'from ' : '') + GBP.format(total) : GBP.format(0)));
    once.appendChild(el('p', null, chosen.length ? chosen.length + (chosen.length === 1 ? ' fix, ' : ' fixes, ') + 'about ' + hrs(hours) + '. Paid in advance. I re-run the check when they’re done.' : 'Tick the fixes you’d like done.'));
    var b1 = el('button', null, r.flags && r.flags.checkout ? 'Pay and book these fixes' : 'Ask me to do these'); b1.type = 'button'; b1.disabled = !chosen.length;
    b1.addEventListener('click', function () { buy('once', chosen, total); });
    once.appendChild(b1);
    box.appendChild(once);

    if (q.retainer) {
      var mo = el('div', 'option' + (monthlyBetter ? ' best' : ''));
      if (monthlyBetter) mo.appendChild(el('span', 'tag', 'Better value for this account'));
      mo.appendChild(el('h4', null, 'Small business monthly'));
      mo.appendChild(el('div', 'big', GBP.format(q.retainer.fee) + ' a month'));
      mo.appendChild(el('p', null, 'I become your Google Ads specialist: a plan for the next 3 to 6 months, these fixes over time, and the account kept in shape. ' + q.retainer.minMonths + '-month minimum, paid monthly in advance, then cancel any time.'));
      var b2 = el('button', null, r.flags && r.flags.checkout ? 'Start monthly' : 'Ask me about monthly'); b2.type = 'button';
      b2.addEventListener('click', function () { buy('monthly', chosen, q.retainer.fee); });
      mo.appendChild(b2);
      box.appendChild(mo);
    }
    $('fix-fine').textContent = (q.holdForReview ? 'I’ll confirm the price within one working day before anything is charged. ' : '') +
      'Prices hold until ' + DATE.format(new Date(q.validUntil + 'T12:00:00Z')) + '. No VAT is added. Questions first? Ask me below.';
  }

  // Checkout waits on the Phillips. Stripe account (FLAGS.checkout). Until then the buttons fill in the question form.
  function buy(kind, chosen, amount) {
    if (preview) {
      var cp = $('checkout-preview'); cp.textContent = ''; cp.hidden = false;
      cp.appendChild(el('h4', null, 'Preview: what happens once Stripe and Google sign-in are switched on'));
      var ol = el('ol');
      [kind === 'once' ? 'Stripe Checkout for ' + GBP.format(amount) + ', paid in advance, ' + chosen.length + ' line items (one per fix, with its hours).' : 'A Stripe subscription at ' + GBP.format(amount) + ' a month; the cancel button appears after the third payment.',
       'The customer signs in with Google again and approves the exact list of changes for the settings and negatives fixes.',
       'Hands-on fixes (ads, tracking, structure): the tool sends a link request from the manager account with Standard access, and the customer accepts it in Google Ads.',
       'Every change is recorded before and after; the job lands in /admin as a card with this report, and you log the actual hours against the estimate.'
      ].forEach(function (t) { ol.appendChild(el('li', null, t)); });
      cp.appendChild(ol);
      cp.appendChild(el('p', null, 'Switched off now: the buttons open the question form for visitors.'));
    }
    var f = document.querySelector('#contact form.enquiry');
    if (f && current) {
      var biz = f.querySelector('[name="business"]'), msg = f.querySelector('[name="message"]');
      if (biz && !biz.value) biz.value = current.accountName;
      var lines = chosen.map(function (l) { return '- ' + l.title; }).join('\n');
      msg.value = (kind === 'once' ? 'I’d like these fixes done:\n' + lines : 'I’m interested in the small business monthly option.' + (lines ? '\nFixes I ticked:\n' + lines : '')) +
        '\n\nMy report: ' + location.origin + '/google-ads-audit/r/' + current.id + '\n\n';
    }
    if (!preview) document.getElementById('contact').scrollIntoView({ behavior: 'smooth' });
  }

  function show(r, scroll) {
    current = r;
    var cur = money(r.currency || 'GBP');
    $('rep-name').textContent = r.accountName;
    $('rep-meta').textContent = (r.sample ? 'Sample data, not a real account · ' : 'Customer ID ' + r.customerId + ' · ') + 'Checked ' + DATE.format(new Date(r.checkedAt)) + ' · last 30 days' + (r.preview && r.operations ? ' · ' + r.operations + ' API operations' : '');
    var f = r.facts || {}, tiles = $('rep-tiles'); tiles.textContent = '';
    tiles.appendChild(tile('Spend, last 30 days', f.spend30 != null ? cur.format(f.spend30) : 'n/a', (f.activeCampaigns || 0) + ' active campaigns'));
    tiles.appendChild(tile('Conversions', f.conversions30 != null ? String(Math.round(f.conversions30 * 10) / 10) : 'n/a', f.costPerConversion30 ? cur.format(f.costPerConversion30) + ' each' : ''));
    var high = r.weaknesses.filter(function (w) { return w.priority === 'high'; }).length;
    tiles.appendChild(tile('To fix', String(r.weaknesses.length), high ? high + ' to fix first' : 'none urgent', high ? 'bad' : r.weaknesses.length ? 'warn' : 'good'));
    tiles.appendChild(tile('Working well', String(r.strengths.length), 'keep these', 'good'));
    var byId = {}; ((r.quote && r.quote.lines) || []).forEach(function (l) { byId[l.id] = l; });
    var wk = $('rep-weak'); wk.textContent = '';
    r.weaknesses.forEach(function (w) { wk.appendChild(finding(w, byId[w.id])); });
    $('sec-weak').hidden = !r.weaknesses.length;
    var st = $('rep-strong'); st.textContent = '';
    r.strengths.forEach(function (s) { st.appendChild(finding(s, null)); });
    $('sec-strong').hidden = !r.strengths.length;
    fixes(r);
    $('report').hidden = false;
    if (!r.sample && location.pathname !== '/google-ads-audit/r/' + r.id) history.replaceState(null, '', '/google-ads-audit/r/' + r.id);
    if (scroll) $('report').scrollIntoView({ behavior: scroll === 'jump' ? 'auto' : 'smooth', block: 'start' });
  }

  $('rep-copy').addEventListener('click', function () {
    var b = this, link = location.origin + '/google-ads-audit/r/' + (current && current.id);
    (navigator.clipboard ? navigator.clipboard.writeText(link) : Promise.reject()).then(function () { b.textContent = 'Link copied'; }, function () { b.textContent = link; });
    setTimeout(function () { b.textContent = 'Copy the link'; }, 2500);
  });
  $('rep-print').addEventListener('click', function () { window.print(); });
  $('rep-ask').addEventListener('click', function () {
    var f = document.querySelector('#contact form.enquiry');
    if (!f || !current) return;
    var biz = f.querySelector('[name="business"]'), msg = f.querySelector('[name="message"]');
    if (biz && !biz.value) biz.value = current.accountName;
    if (msg && !msg.value) msg.value = 'About my Google Ads Check report: ' + location.origin + '/google-ads-audit/r/' + current.id + '\n\n';
  });

  step('id');
  var m = location.pathname.match(/^\/google-ads-audit\/r\/([a-f0-9]{32})\/?$/);
  if (m) {
    say('Loading the report…');
    fetch('/tools/google-ads-check/report/' + m[1], { credentials: 'same-origin' }).then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
      .then(function (res) { if (!res.ok) throw new Error(res.d.error || 'That report could not be loaded.'); say(''); show(res.d.report, 'jump'); })
      .catch(function (err) { say(err.message, true); });
  } else if (preview && /[?&]sample=1/.test(location.search)) {
    post('/tools/google-ads-check/sample').then(function (res) { if (res.ok) show(res.d.report, 'jump'); else say(res.d.error, true); });
  }
})();
