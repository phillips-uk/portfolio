// The Google Ads Check page (/google-ads-audit). Steps: customer ID, invite the Phillips. manager account, wait for the
// invitation, run (Turnstile), then the report with priced fixes. Server side: cloudflare/src/google-ads-check.js.
// Every value from the report goes in with textContent. Prices appear only here, inside a private report.
// GA4 (GTM "Site events to GA4"): ads_check_start, ads_check_complete, ads_check_error, ads_check_fix_select.
// Never the customer ID, the account name or a price in the events.
(function () {
  var $ = function (id) { return document.getElementById(id); };
  var preview = document.body.getAttribute('data-preview') === '1';
  // ?demo=1 in Lewis's signed-in preview: the page looks and reads exactly as a client sees it (no preview banner or
  // preview notes), while the run still uses his access, so an account already under the manager account can be shown.
  var demo = preview && /[?&]demo=1/.test(location.search);
  var status = $('check-status');
  var cid = '';
  var current = null;
  if (preview && !demo) { $('preview-flag').hidden = false; }

  function track(event, params) {
    if (preview) return; // Lewis's own runs and demos stay out of GA4
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
  // Google sign-in: offered when the page says so (Lewis only until Google verifies the app; google-signin.js)
  var signIn = document.body.getAttribute('data-signin') === '1';
  function step(name) {
    $('step-id').hidden = name !== 'id';
    $('step-invite').hidden = name !== 'invite';
    $('step-google').hidden = !(signIn && name === 'id');
    $('step-pick').hidden = name !== 'pick';
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
      say(st === 'ACTIVE' && !demo ? 'Preview: this account is already linked, so the check reads it and leaves the link as it is.' : 'Invitation found. Running the check: this takes about half a minute.');
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

  // A weakness: the tone, the title and the price; what it found, why it matters and where to start sit behind
  // "Why and where to start" (Lewis, 18 Nov 2026: hide text unless it's needed).
  function finding(f, line) {
    var card = el('article', 'find weak ' + f.priority);
    card.appendChild(el('span', 'mk', '!'));
    var body = el('div', 'fb'); card.appendChild(body);
    var h = el('h4', null, f.title);
    h.appendChild(el('span', 'pr ' + f.priority, f.priority === 'high' ? 'Fix first' : f.priority === 'medium' ? 'Worth fixing' : 'Small'));
    body.appendChild(h);
    var d = el('details'); d.appendChild(el('summary', null, 'Why and where to start'));
    d.appendChild(el('p', null, f.detail));
    if (f.why) d.appendChild(el('p', 'why', f.why));
    if (f.start) { var st = el('p', 'start'); st.appendChild(el('b', null, 'Start here: ')); st.appendChild(document.createTextNode(f.start)); d.appendChild(st); }
    if (f.startLink && /^\/[a-z0-9\-\/]*$/.test(f.startLink)) { var a = el('a', 'go', 'Read the guide →'); a.href = f.startLink; d.appendChild(a); }
    body.appendChild(d);
    if (line) {
      var px = el('div', 'px');
      px.appendChild(el('b', null, (line.fromPrice ? 'from ' : '') + GBP.format(line.price)));
      px.appendChild(el('small', null, 'about ' + hrs(line.hours)));
      card.appendChild(px);
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
    if (preview && !demo) {
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
    if (!preview || demo) document.getElementById('contact').scrollIntoView({ behavior: 'smooth' });
  }

  // ---------- how I read your account (ink panel and structure diagram) ----------
  var MODEL = { shop: 'Online shop', leads: 'Enquiries and leads', both: 'Online sales and enquiries', unknown: 'Not clear from the goals' };
  var SHADES = [100, 72, 50, 34, 22, 14];
  function profile(r, cur) {
    var p = r.profile, sec = $('sec-profile');
    sec.hidden = !p || !p.groups || !p.groups.length;
    if (sec.hidden) return;
    $('pf-summary').textContent = p.summary;
    var facts = $('pf-facts'); facts.textContent = '';
    function fact(k, v, sub) { var d = el('div'); d.appendChild(el('dt', null, k)); var dd = el('dd', null, v); if (sub) dd.appendChild(el('small', null, sub)); d.appendChild(dd); facts.appendChild(d); }
    fact('Business', MODEL[p.model] || MODEL.unknown, p.model === 'unknown' ? 'No sale or lead goal set as main' : 'From your main conversion goals');
    if (p.sells && p.sells.length) fact('What you sell', p.sells.slice(0, 3).join(', '), 'From your ' + p.sellsFrom);
    else fact('What you sell', 'Not clear from the account', 'No product types or Search ad groups');
    fact('Sale values', p.tracksValue ? 'Tracked' : 'Not tracked', p.tracksValue ? 'Conversions carry a value' : (p.model === 'leads' ? 'Normal for enquiries' : 'Conversions have no value'));
    fact('Campaign names', p.naming && p.naming.consistent ? 'One pattern' : p.campaigns < 2 ? 'One campaign' : 'No single pattern',
      p.naming && p.naming.consistent ? p.naming.parts + ' parts, split by "' + p.naming.separator + '"' : p.campaigns + ' active campaign' + (p.campaigns === 1 ? '' : 's'));
    // where the money goes: one bar, a shade of the brand per group
    var split = $('pf-split'); split.textContent = '';
    split.setAttribute('aria-label', 'Spend by campaign type: ' + p.groups.map(function (g) { return g.label + ' ' + Math.round(g.share) + '%'; }).join(', '));
    var bar = el('div', 'pf-bar'), leg = el('div', 'pf-legend');
    p.groups.forEach(function (g, i) {
      var c = 'color-mix(in oklab, var(--brand-on-ink) ' + SHADES[Math.min(i, SHADES.length - 1)] + '%, var(--ink))';
      var seg = el('i'); seg.style.flex = String(Math.max(g.share, 0.5)); seg.style.background = c; bar.appendChild(seg);
      var item = el('span'); var sw = el('b'); sw.style.background = c; item.appendChild(sw); item.appendChild(document.createTextNode(g.label + ' '));
      item.appendChild(el('em', null, Math.round(g.share) + '%')); leg.appendChild(item);
    });
    split.appendChild(bar); split.appendChild(leg);
    // the structure: the account, its campaign types, each campaign with its share of spend
    var tree = $('pf-tree'); tree.textContent = '';
    var root = el('div', 'pf-root', r.accountName || 'Your account'); root.appendChild(el('small', null, p.campaigns + ' campaign' + (p.campaigns === 1 ? '' : 's')));
    tree.appendChild(root);
    var groups = el('div', 'pf-groups');
    p.groups.forEach(function (g) {
      var box = el('div', 'pf-group'), gh = el('div', 'pf-gh');
      gh.appendChild(el('b', null, g.label)); gh.appendChild(el('em', null, cur.format(g.spend)));
      box.appendChild(gh);
      g.campaigns.slice(0, 6).forEach(function (c) {
        var row = el('div', 'pf-camp');
        row.appendChild(el('div', 'pf-cn', c.name));
        var cb = el('div', 'pf-cbar'), fill = el('i'); fill.style.width = Math.max(2, c.share) + '%'; cb.appendChild(fill); row.appendChild(cb);
        var meta = el('div', 'pf-cm');
        meta.appendChild(el('span', null, Math.round(c.share) + '% of spend'));
        meta.appendChild(el('span', null, c.conversions + ' conv.' + (c.cpa ? ' · ' + cur.format(c.cpa) + ' each' : '')));
        if (c.inside) meta.appendChild(el('span', null, c.inside));
        row.appendChild(meta); box.appendChild(row);
      });
      if (g.campaigns.length > 6) box.appendChild(el('div', 'pf-cm', '+ ' + (g.campaigns.length - 6) + ' more'));
      groups.appendChild(box);
    });
    tree.appendChild(groups);
  }

  // ---------- words in your searches (n-grams) ----------
  var ngState = { kind: 'wasted', n: 0 };
  function ngrams(r, cur) {
    var d = r.ngrams, sec = $('sec-ngrams');
    sec.hidden = !d || (!d.wasted.length && !d.performing.length);
    if (sec.hidden) return;
    $('ng-lede').textContent = (d.wastedSpend > 0 ? cur.format(d.wastedSpend) + ' went on searches with no conversions. ' : '') +
      'One negative on an off-topic word blocks every search that contains it.';
    var pm = d.pmaxSearchTerms || 0, all = d.searchTerms + pm, hasPmax = r.facts && (r.facts.channels || []).indexOf('PERFORMANCE_MAX') >= 0;
    $('ng-note').textContent = 'From the ' + all + ' search term' + (all === 1 ? '' : 's') + ' that spent ' +
      (pm ? 'in your Search campaigns (' + d.searchTerms + ') and Performance Max (' + pm + ')' : 'in your Search campaigns') +
      ' in the last 30 days. Each word or phrase appears in two or more of them.' + (hasPmax && !pm ? ' Performance Max searches were not available this time.' : '') +
      ' Costing money leaves out words that match what you sell (your products, keywords and campaign names' + (d.ownLeftOut ? ': ' + d.ownLeftOut + ' this time' : '') + '), since those are for bidding, not blocking. A word only shows once it has spent ' +
      (d.costPerConversion ? cur.format(d.minSpend) + ', your average cost per conversion,' : cur.format(d.minSpend || 2)) + ' without a conversion.';
    function draw() {
      var rows = d[ngState.kind].filter(function (x) { return !ngState.n || x.n === ngState.n; });
      var body = $('ng-rows'); body.textContent = '';
      if (!rows.length) {
        var tr = el('tr'), td = el('td', 'empty', ngState.kind === 'wasted' ? 'Nothing here: no off-topic words have spent enough without a conversion to call them waste.' : 'Nothing here yet: no repeated words with conversions.');
        td.colSpan = 5; tr.appendChild(td); body.appendChild(tr); return;
      }
      rows.forEach(function (x) {
        var tr = el('tr');
        tr.appendChild(el('td', null, x.text));
        tr.appendChild(el('td', 'r wide', String(x.terms)));
        tr.appendChild(el('td', 'r wide', String(x.clicks)));
        tr.appendChild(el('td', 'r', cur.format(x.cost)));
        tr.appendChild(el('td', 'r', String(x.conversions)));
        body.appendChild(tr);
      });
    }
    function wire(groupId, key, attr) {
      var btns = $(groupId).querySelectorAll('button');
      btns.forEach(function (b) {
        b.onclick = function () {
          ngState[key] = attr === 'n' ? Number(b.getAttribute('data-n')) : b.getAttribute('data-kind');
          btns.forEach(function (o) { o.setAttribute('aria-pressed', o === b ? 'true' : 'false'); });
          draw();
        };
      });
    }
    wire('ng-kind', 'kind', 'kind'); wire('ng-len', 'n', 'n');
    if (!d.wasted.length && d.performing.length) $('ng-kind').querySelector('[data-kind="performing"]').click(); else draw();
  }

  // ---------- when conversions come in (day by hour) ----------
  var DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  var DAYS_LONG = ['Mondays', 'Tuesdays', 'Wednesdays', 'Thursdays', 'Fridays', 'Saturdays', 'Sundays'];
  var narrow = window.matchMedia('(max-width: 560px)');
  var hmDraw = null, hmWired = false;
  var hour = function (h) { return (h % 12 || 12) + (h < 12 ? 'am' : 'pm'); };
  function heatmap(r) {
    var d = r.dayHour, sec = $('sec-heat');
    sec.hidden = !d || !(d.totalConversions > 0);
    if (sec.hidden) return;
    var dayTot = d.conversions.map(function (row) { return row.reduce(function (s, v) { return s + v; }, 0); });
    var hourTot = d.conversions[0].map(function (_, h) { return d.conversions.reduce(function (s, row) { return s + row[h]; }, 0); });
    var bestDay = dayTot.indexOf(Math.max.apply(null, dayTot)), bestHour = hourTot.indexOf(Math.max.apply(null, hourTot));
    $('hm-lede').textContent = 'Busiest day: ' + DAYS_LONG[bestDay].replace(/s$/, '') + '. Busiest hour: ' + hour(bestHour) + ' to ' + hour((bestHour + 1) % 24) + '.';
    function draw() {
      var block = narrow.matches ? 4 : 1, cols = 24 / block;
      var grid = d.conversions.map(function (row) { var out = []; for (var c = 0; c < cols; c++) { var v = 0; for (var k = 0; k < block; k++) v += row[c * block + k]; out.push(Math.round(v * 10) / 10); } return out; });
      var max = Math.max.apply(null, grid.map(function (row) { return Math.max.apply(null, row); })) || 1;
      var g = $('hm-grid'); g.textContent = ''; g.style.setProperty('--cols', cols);
      g.setAttribute('aria-label', 'Conversions by day and ' + (block > 1 ? 'four-hour block' : 'hour') + ', last 30 days');
      g.appendChild(el('span'));
      for (var c = 0; c < cols; c++) g.appendChild(el('span', 'hh', block > 1 ? hour(c * block) : (c % 3 === 0 ? hour(c) : '')));
      grid.forEach(function (row, di) {
        g.appendChild(el('span', null, DAYS[di]));
        row.forEach(function (v, c) {
          var cell = el('i');
          var pct = v > 0 ? Math.round(15 + 85 * (v / max)) : 0;
          if (pct) cell.style.background = 'color-mix(in oklab, var(--brand) ' + pct + '%, var(--line-soft))';
          cell.title = DAYS[di] + ' ' + (block > 1 ? hour(c * block) + ' to ' + hour((c * block + block) % 24) : hour(c) + ' to ' + hour((c + 1) % 24)) + ': ' + v + ' conversion' + (v === 1 ? '' : 's');
          g.appendChild(cell);
        });
      });
    }
    hmDraw = draw; draw();
    if (!hmWired && narrow.addEventListener) { hmWired = true; narrow.addEventListener('change', function () { if (hmDraw) hmDraw(); }); }
  }

  function show(r, scroll) {
    current = r;
    var cur = money(r.currency || 'GBP');
    $('rep-name').textContent = r.accountName;
    $('rep-meta').textContent = (r.sample ? 'Sample data, not a real account · ' : 'Customer ID ' + r.customerId + ' · ') + 'Checked ' + DATE.format(new Date(r.checkedAt)) + ' · last 30 days' + (r.preview && !demo && r.operations ? ' · ' + r.operations + ' API operations' : '');
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
    r.strengths.forEach(function (s) { var li = el('li', null, s.title); li.title = s.detail || ''; st.appendChild(li); });
    $('weak-count').textContent = String(r.weaknesses.length); $('strong-count').textContent = String(r.strengths.length);
    $('sec-strong').hidden = !r.strengths.length;
    profile(r, cur);
    ngrams(r, cur);
    heatmap(r);
    fixes(r);
    $('report').hidden = false;
    // Paper and white alternate down the sections that are showing, so two of the same never sit together (v3 sec. 5).
    var flip = false;
    document.querySelectorAll('#report > section.rp').forEach(function (sec) {
      if (sec.hidden || sec.classList.contains('rp-ink')) return;
      sec.classList.toggle('rp-white', flip); sec.classList.toggle('rp-paper', !flip); flip = !flip;
    });
    if (!r.sample && location.pathname !== '/google-ads-audit/r/' + r.id) history.replaceState(null, '', '/google-ads-audit/r/' + r.id);
    // Straight to "Your Google Ads report", just under the fixed header, once the new sections have laid out.
    if (scroll) setTimeout(function () {
      var head = document.querySelector('.site-header'), off = (head ? head.getBoundingClientRect().height : 64) + 24;
      var y = $('rep-top').querySelector('.rep-head').getBoundingClientRect().top + window.scrollY - off;
      window.scrollTo({ top: Math.max(0, y), behavior: scroll === 'jump' ? 'auto' : 'smooth' });
    }, 80);
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

  // ---------- after Google sign-in: pick an account, run the check ----------
  var SIGNIN_MSG = {
    cancelled: 'Google sign-in was cancelled. You can try again, or use your customer ID instead.',
    expired: 'That sign-in took too long. Please sign in again.',
    failed: 'Google sign-in didn’t work this time. Please try again, or use your customer ID instead.',
    noscope: 'To check the account, tick the Google Ads permission on Google’s screen. Please sign in again.'
  };
  function signedIn() {
    step('pick');
    var list = $('pick-list'); list.textContent = '';
    say('Finding your Google Ads accounts…');
    fetch('/tools/google-ads-check/oauth/accounts', { credentials: 'same-origin' })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (d) { return { ok: r.ok, d: d }; }); })
      .then(function (res) {
        if (!res.ok) { if (res.d.signin) step('id'); throw new Error(res.d.error || 'I couldn’t list your accounts.'); }
        var accts = res.d.accounts || [];
        if (!accts.length) { say('That Google account can’t open any Google Ads accounts. Try a different Google account, or use your customer ID.', true); return; }
        say(res.d.agency && !preview ? 'This login reaches many accounts. The free check is for one business at a time: for client accounts, ask me about a paid audit below.' : '');
        accts.forEach(function (a) {
          var b = el('button'); b.type = 'button';
          var left = el('span');
          left.appendChild(el('b', null, a.name || 'Unnamed account'));
          left.appendChild(el('small', null, shown(a.id) + (a.test ? ' · test account' : '') + (a.via ? ' · through manager ' + shown(a.via) : '')));
          b.appendChild(left);
          b.appendChild(el('span', 'go', 'Check this one →'));
          b.addEventListener('click', function () { pick(a, b); });
          list.appendChild(b);
        });
      })
      .catch(function (err) { say(err.message, true); });
  }
  function pick(a, btn) {
    Array.prototype.forEach.call(document.querySelectorAll('#pick-list button'), function (x) { x.disabled = true; });
    track('ads_check_start', { connection: 'google' });
    say('Running the check: this takes about half a minute.');
    var items = $('progress').querySelectorAll('li');
    if (items[0]) items[0].textContent = 'Opening the account';
    progress(true);
    post('/tools/google-ads-check/oauth/run', { customerId: a.id, via: a.via || '' }).then(function (res) {
      if (!res.ok || !res.d.report) {
        track('ads_check_error', { error_type: res.status === 429 ? 'limit' : res.d.agency ? 'agency' : res.status === 401 ? 'signin' : 'other' });
        throw new Error(res.d.error || 'Something went wrong. Please try again.');
      }
      say('');
      track('ads_check_complete', { weaknesses: res.d.report.weaknesses.length, connection: 'google' });
      $('step-pick').hidden = true;
      show(res.d.report, true);
    }).catch(function (err) {
      say(err.message, true);
      Array.prototype.forEach.call(document.querySelectorAll('#pick-list button'), function (x) { x.disabled = false; });
    }).then(function () { progress(false); });
  }
  $('pick-other').addEventListener('click', function () {
    post('/tools/google-ads-check/oauth/signout').then(function () { location.href = '/tools/google-ads-check/oauth/start'; });
  });
  $('pick-cancel').addEventListener('click', function () {
    post('/tools/google-ads-check/oauth/signout');
    history.replaceState(null, '', '/google-ads-audit'); say(''); step('id');
  });

  step('id');
  var m = location.pathname.match(/^\/google-ads-audit\/r\/([a-f0-9]{32})\/?$/);
  if (m) {
    say('Loading the report…');
    fetch('/tools/google-ads-check/report/' + m[1], { credentials: 'same-origin' }).then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
      .then(function (res) { if (!res.ok) throw new Error(res.d.error || 'That report could not be loaded.'); say(''); show(res.d.report, 'jump'); })
      .catch(function (err) { say(err.message, true); });
  } else if (signIn && /[?&]signin=1(&|$)/.test(location.search)) {
    signedIn();
  } else if (signIn && /[?&]signin=([a-z]+)/.test(location.search)) {
    say(SIGNIN_MSG[location.search.match(/[?&]signin=([a-z]+)/)[1]] || '', true);
    history.replaceState(null, '', '/google-ads-audit');
  } else if (preview && /[?&]sample=1/.test(location.search)) {
    post('/tools/google-ads-check/sample').then(function (res) { if (res.ok) show(res.d.report, 'jump'); else say(res.d.error, true); });
  }
})();
