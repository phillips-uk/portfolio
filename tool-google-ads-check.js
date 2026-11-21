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

  // ---------- the optional target and brand name (21 Nov 2026) ----------
  // One target (cost per conversion in pounds, or return on ad spend in %) and a brand name. Both optional.
  $('t-type').addEventListener('change', function () { $('t-value').placeholder = this.value === 'roas' ? 'e.g. 400' : 'e.g. 40'; });
  function targetInput() {
    var o = {}, v = $('t-value').value.replace(/[^0-9.]/g, ''), b = $('t-brand').value.trim();
    if (v && Number(v) > 0) o.target = { type: $('t-type').value, value: v };
    if (b) o.brand = b;
    return o;
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
      return withToken().then(function (t) { var o = targetInput(); o.customerId = cid; o.token = t; return post('/tools/google-ads-check/run', o); });
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
  var current_money = null;
  var DATE = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/London' });
  var money = function (cur) { return new Intl.NumberFormat('en-GB', { style: 'currency', currency: cur || 'GBP', maximumFractionDigits: 0 }); };
  var GBP = money('GBP');
  // 15 min, 1 hour, 2 hours 30 min: AI-assisted jobs are often under an hour (Lewis, 19 Nov 2026)
  var START_T = 'Set-up (charged once)', START_S = 'I get access, review your account and plan the fixes you tick';
  var hrs = function (h) {
    var m = Math.round(h * 60), H = Math.floor(m / 60), r = m % 60;
    if (!H) return r + ' min';
    return H + (H === 1 ? ' hour' : ' hours') + (r ? ' ' + r + ' min' : '');
  };
  // The set-up: one hour, charged once whatever is ticked. Reports saved before 19 Nov 2026 have none.
  function startRow(q) {
    var row = el('div', 'fix-row fix-start');
    row.appendChild(el('span', 'fix-dot'));
    var t = el('span'); t.appendChild(el('span', 't', START_T)); var sub = el('span', 's', START_S); sub.style.display = 'block'; t.appendChild(sub); row.appendChild(t);
    row.appendChild(el('span', 'h', hrs(q.start.hours)));
    row.appendChild(el('span', 'p', GBP.format(q.start.price)));
    return row;
  }
  function aiTag(l) { return l.ai ? el('span', 'fix-ai', 'AI-assisted') : null; }
  function withStart(q, list, total, hours) {
    var on = !!(q.start && q.start.price && list.length);
    return { total: total + (on ? q.start.price : 0), hours: hours + (on ? q.start.hours : 0) };
  }

  function tile(label, value, sub, tone) {
    var t = el('div', 'tile' + (tone ? ' ' + tone : ''));
    t.appendChild(el('small', null, label)); t.appendChild(el('b', null, value)); if (sub) t.appendChild(el('span', null, sub));
    return t;
  }

  // A weakness (Lewis, 18 Nov 2026): the tone and the title; on the right, what it could cost over the next 30 days
  // where the last 30 show it solidly (else nothing, no price, no selling); "Start here" always showing, on its own
  // raised panel, since that is what people scan for; what was found and why it matters behind "Why it matters".
  function finding(f) {
    var card = el('article', 'find weak ' + f.priority);
    card.id = 'find-' + f.id;
    card.appendChild(el('span', 'mk', '!'));
    var body = el('div', 'fb'); card.appendChild(body);
    var h = el('h4', null, f.title);
    h.appendChild(el('span', 'pr ' + f.priority, f.priority === 'high' ? 'Fix first' : f.priority === 'medium' ? 'Worth fixing' : 'Small'));
    body.appendChild(h);
    if (f.start) {
      var sb = el('div', 'start-box'); sb.appendChild(el('span', 'sb-k', 'Start here')); sb.appendChild(el('p', null, f.start));
      body.appendChild(sb);
    }
    var d = el('details'); d.appendChild(el('summary', null, 'Why it matters'));
    d.appendChild(el('p', null, f.detail));
    if (f.why) d.appendChild(el('p', 'why', f.why));
    if (f.startLink && /^\/[a-z0-9\-\/]*$/.test(f.startLink)) { var a = el('a', 'go', 'Read the guide →'); a.href = f.startLink; d.appendChild(a); }
    body.appendChild(d);
    if (f.atStake && f.atStake.amount > 0) {
      var px = el('div', 'px');
      px.appendChild(el('small', 'px-k', 'Next 30 days'));
      px.appendChild(el('b', null, 'up to ' + current_money.format(f.atStake.amount)));
      px.appendChild(el('small', null, f.atStake.basis));
      card.appendChild(px);
    }
    return card;
  }

  function fixes(r) {
    // The price list is back (Lewis, 18 Nov 2026: the cheaper, duller fixes are good business), smallest jobs first.
    if (!$('fix-rows')) return;
    var q = r.quote, rows = $('fix-rows'); rows.textContent = '';
    if (!q || !q.lines.length) { $('sec-fix').hidden = true; return; }
    $('sec-fix').hidden = false;
    if (q.start && q.start.price) rows.appendChild(startRow(q));
    q.lines.slice().sort(function (a, b) { return a.price - b.price; }).forEach(function (l) {
      var row = el('label', 'fix-row');
      var cb = el('input'); cb.type = 'checkbox'; cb.checked = false; cb.value = l.id; row.appendChild(cb);
      var t = el('span'); t.appendChild(el('span', 't', l.title)); var sub = el('span', 's', l.fixLabel); sub.style.display = 'block'; var tag = aiTag(l); if (tag) sub.appendChild(tag); t.appendChild(sub); row.appendChild(t);
      row.appendChild(el('span', 'h', hrs(l.hours)));
      row.appendChild(el('span', 'p', (l.fromPrice ? 'from ' : '') + GBP.format(l.price)));
      rows.appendChild(row);
      cb.addEventListener('change', function () { options(r); track('ads_check_fix_select'); });
    });
    // Nothing ticked to start with (Lewis, 21 Nov 2026); Select all and Deselect all above the list.
    function setAll(on) {
      Array.prototype.forEach.call(document.querySelectorAll('#fix-rows input[type=checkbox]'), function (i) { i.checked = on; });
      options(r); track('ads_check_fix_select');
    }
    if ($('fix-all')) $('fix-all').onclick = function () { setAll(true); };
    if ($('fix-none')) $('fix-none').onclick = function () { setAll(false); };
    options(r);
  }
  function ticked(r) {
    var ids = Array.prototype.map.call(document.querySelectorAll('#fix-rows input:checked'), function (i) { return i.value; });
    return r.quote.lines.filter(function (l) { return ids.indexOf(l.id) !== -1; });
  }
  function options(r) {
    var q = r.quote, chosen = ticked(r);
    var sum = withStart(q, chosen, chosen.reduce(function (a, l) { return a + l.price; }, 0), chosen.reduce(function (a, l) { return a + l.hours; }, 0));
    var total = sum.total, hours = sum.hours;
    var from = chosen.some(function (l) { return l.fromPrice; });
    var box = $('options'); box.textContent = '';
    box.className = 'options' + (q.retainer ? '' : ' one');
    var monthlyBetter = !!q.retainer && total > q.retainer.fee * q.retainer.suggestMonths;

    var once = el('div', 'option' + (monthlyBetter ? '' : ' best'));
    once.appendChild(el('h4', null, 'Fix these once'));
    once.appendChild(el('div', 'big', chosen.length ? (from ? 'from ' : '') + GBP.format(total) : GBP.format(0)));
    once.appendChild(el('p', null, chosen.length ? chosen.length + (chosen.length === 1 ? ' fix, ' : ' fixes, ') + 'about ' + hrs(hours) + (q.start && q.start.price ? ' including set-up' : '') + '. Paid in advance. I re-run the check when they’re done.' : 'Tick the fixes you’d like done.'));
    var b1 = el('button', null, r.flags && r.flags.checkout ? 'Pay and book these fixes' : 'Ask me to do these'); b1.type = 'button'; b1.disabled = !chosen.length;
    b1.addEventListener('click', function () { buy('once', chosen, total); });
    once.appendChild(b1);
    box.appendChild(once);

    if (q.retainer) {
      var mo = el('div', 'option' + (monthlyBetter ? ' best' : ''));
      if (monthlyBetter) mo.appendChild(el('span', 'tag', 'Better value for this account'));
      mo.appendChild(el('h4', null, 'Monthly management'));
      mo.appendChild(el('div', 'big', GBP.format(q.retainer.fee) + ' a month'));
      mo.appendChild(el('p', null, 'I become your Google Ads specialist: a plan for the next 3 to 6 months, these fixes over time, and the account kept in shape. ' + (q.retainer.atMinimum ? 'This is my minimum monthly fee. ' : 'For an account this size, the fee is based on about ' + (function (h) { h = Math.max(1, Math.round(h)); return h + (h === 1 ? ' hour' : ' hours'); })(q.retainer.hours) + ' of work a month. ') + q.retainer.minMonths + '-month minimum, paid monthly in advance, then cancel any time.'));
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
      var q = current.quote || {}, startLine = kind === 'once' && q.start && q.start.price ? '\n- ' + START_T + '\nTotal: ' + GBP.format(amount) : '';
      msg.value = (kind === 'once' ? 'I’d like these fixes done:\n' + lines + startLine : 'I’m interested in the small business monthly option.' + (lines ? '\nFixes I ticked:\n' + lines : '')) +
        '\n\nMy report: ' + location.origin + '/google-ads-audit/r/' + current.id + '\n\n';
    }
    if (!preview || demo) document.getElementById('contact').scrollIntoView({ behavior: 'smooth' });
  }


  // ---------- in short: the written headline and the ranked list (rules write both, no AI) ----------
  var IMPACT = { high: 'Bigger impact', medium: 'Medium impact', low: 'Smaller impact' };
  var EFFORT = { quick: 'Under an hour', medium: 'A few hours', larger: 'A day or more' };
  function summary(r, cur) {
    var sec = $('sec-summary');
    sec.hidden = !(r.headline && r.headline.length);
    if (sec.hidden) return;
    var lede = $('sum-lede'); lede.textContent = '';
    r.headline.forEach(function (t) { lede.appendChild(el('span', null, t)); });
    var y = r.yardstick;
    $('sum-meta').textContent = !y ? '' : 'Judged against ' + (y.source === 'target' ? 'your target' : 'your account’s average') + ' of ' +
      (y.kind === 'roas' ? Math.round(y.value * 100) + '% return on ad spend' : cur.format(y.value) + ' a conversion') + (y.source === 'target' ? '' : ' over the last 30 days');
    $('sum-meta').hidden = !y;
    var plan = r.plan || [], byId = {};
    r.weaknesses.forEach(function (w) { byId[w.id] = w; });
    $('sum-plan-box').hidden = !plan.length;
    function row(p) {
      var li = el('li'), a = el('a'); a.href = '#find-' + p.id;
      a.appendChild(el('span', 'n', String(p.rank)));
      a.appendChild(el('span', 't', p.title));
      var tags = el('span', 'tags');
      tags.appendChild(el('span', 'tg imp ' + p.impact, IMPACT[p.impact] || ''));
      if (p.effort) { var e = el('span', 'tg', EFFORT[p.effort]); e.title = 'Rough time to fix: ' + hrs(p.hours); tags.appendChild(e); }
      a.appendChild(tags);
      var m = el('span', 'm');
      var w = byId[p.id];
      if (p.atStake) {
        m.textContent = cur.format(p.atStake);
        m.appendChild(el('small', null, p.overlap ? 'additional amount at stake' : p.mayOverlap ? 'may include spend counted above' : 'at stake, next 30 days'));
        if (w && w.atStake) m.title = p.mayOverlap ? 'These products each spent more than your account’s average cost per conversion without making a sale. The product report doesn’t show which campaigns the spend came from, so I can’t tell how much is already counted above.' : w.atStake.basis + (p.overlap ? '. ' + cur.format(p.gross) + ' at stake in total over the next 30 days, including the amount already counted above.' : '');
      } else if (p.overlap) {
        m.className = 'm over';
        m.appendChild(el('small', null, 'already counted above'));
        m.title = cur.format(p.gross) + ' at stake over the next 30 days. The full amount was already counted above.';
      }
      a.appendChild(m);
      li.appendChild(a);
      return li;
    }
    var top = $('sum-plan'), rest = $('sum-plan-rest'), more = $('sum-more'), SHOW = 5;
    top.textContent = ''; rest.textContent = '';
    plan.slice(0, SHOW).forEach(function (p) { top.appendChild(row(p)); });
    plan.slice(SHOW).forEach(function (p) { rest.appendChild(row(p)); });
    more.hidden = plan.length <= SHOW;
    more.querySelector('summary').textContent = 'Show all ' + plan.length;
  }

  // ---------- how it's moving: funnel, 13 months, devices and networks, change history ----------
  var MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var trDraw = null, trWired = false;
  function pctx(x, dp) { return x == null ? 'n/a' : (x * 100).toFixed(dp == null ? 1 : dp) + '%'; }
  function trend(r, cur) {
    var t = r.trend, sec = $('sec-trend');
    sec.hidden = !t || (!t.funnel && !(t.months && t.months.length));
    if (sec.hidden) return;
    var roas = t.kind === 'roas';
    var f = t.funnel;
    $('tr-lede').textContent = f && f.lever ? f.lever.text : 'The last 30 days against the 60 days before, and the last 13 months by month.';
    var box = $('tr-funnel'); box.textContent = ''; box.hidden = !f;
    if (f) {
      var R = f.recent, P = f.prior, lev = f.lever && f.lever.key;
      var parts = [
        ['ctr', 'Click-through rate', pctx(R.ctr, 2), pctx(P.ctr, 2)],
        ['cpc', 'Cost per click', R.cpc != null ? cur.format(R.cpc).replace(/\.00$/, '') : 'n/a', P.cpc != null ? cur.format(P.cpc) : 'n/a'],
        ['cvr', 'Conversion rate', pctx(R.cvr), pctx(P.cvr)],
        roas ? ['roas', 'Return on ad spend', R.roas != null ? Math.round(R.roas * 100) + '%' : 'n/a', P.roas != null ? Math.round(P.roas * 100) + '%' : 'n/a']
             : ['cpa', 'Cost per conversion', R.cpa != null ? cur.format(R.cpa) : 'n/a', P.cpa != null ? cur.format(P.cpa) : 'n/a']
      ];
      var money2 = new Intl.NumberFormat('en-GB', { style: 'currency', currency: r.currency || 'GBP', minimumFractionDigits: 2, maximumFractionDigits: 2 });
      parts[1][2] = R.cpc != null ? money2.format(R.cpc) : 'n/a'; parts[1][3] = P.cpc != null ? money2.format(P.cpc) : 'n/a';
      parts.forEach(function (p) {
        var tl = tile(p[1], p[2], '60 days before: ' + p[3]);
        if (lev === p[0]) { tl.classList.add('lever'); tl.appendChild(el('em', null, 'Biggest change')); }
        box.appendChild(tl);
      });
    }
    // the 13 months: spend as bars, cost per conversion (or return) as a line, this month so far lighter
    var months = t.months || [];
    $('tr-chart-card').hidden = !months.length;
    var key = $('tr-key'); key.textContent = '';
    if (months.length) {
      var k1 = el('span'); k1.appendChild(el('b')); k1.appendChild(document.createTextNode('Spend')); key.appendChild(k1);
      var k2 = el('span'); k2.appendChild(el('i')); k2.appendChild(document.createTextNode(roas ? 'Return on ad spend' : 'Cost per conversion')); key.appendChild(k2);
      key.appendChild(el('span', null, 'This month so far is lighter.'));
    }
    function draw() {
      var host = $('tr-chart'); host.textContent = '';
      if (!months.length) return;
      var NS = 'http://www.w3.org/2000/svg';
      var W = Math.max(300, Math.round(host.clientWidth || 720)), H = W < 480 ? 200 : 240, padB = 26, padT = 16, padX = 6;
      var svg = document.createElementNS(NS, 'svg'); svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H); svg.setAttribute('width', W); svg.setAttribute('height', H);
      var n = months.length, slot = (W - padX * 2) / n, bw = Math.max(6, slot * 0.62);
      var maxS = Math.max.apply(null, months.map(function (m) { return m.spend; })) || 1;
      var vals = months.map(function (m) { return roas ? m.roas : m.cpa; });
      var vv = vals.filter(function (v) { return v != null; });
      var maxV = vv.length ? Math.max.apply(null, vv) * 1.15 : 1;
      var plotH = H - padB - padT;
      function mk(tag, attrs, style) { var e = document.createElementNS(NS, tag); for (var a in attrs) e.setAttribute(a, attrs[a]); if (style) e.setAttribute('style', style); return e; }
      svg.appendChild(mk('line', { x1: 0, x2: W, y1: H - padB + 0.5, y2: H - padB + 0.5 }, 'stroke: var(--line); stroke-width: 1'));
      var pts = [];
      months.forEach(function (m, i) {
        var x = padX + i * slot + (slot - bw) / 2, h = Math.max(1, (m.spend / maxS) * plotH);
        var bar = mk('rect', { x: x.toFixed(1), y: (H - padB - h).toFixed(1), width: bw.toFixed(1), height: h.toFixed(1), rx: 3 },
          'fill: color-mix(in oklab, var(--brand) ' + (m.partial ? 18 : 45) + '%, var(--surface))' + (m.partial ? '; stroke: color-mix(in oklab, var(--brand) 45%, var(--surface)); stroke-dasharray: 3 2' : ''));
        var mo = Number(m.month.slice(5, 7)) - 1, yr = m.month.slice(2, 4);
        var tip = document.createElementNS(NS, 'title');
        tip.textContent = MON[mo] + ' 20' + yr + (m.partial ? ' (so far)' : '') + ': ' + cur.format(m.spend) + ' spend, ' + m.conversions + ' conversions' + (vals[i] != null ? ', ' + (roas ? Math.round(vals[i] * 100) + '% return' : cur.format(vals[i]) + ' each') : '');
        bar.appendChild(tip); svg.appendChild(bar);
        if (W >= 480 || i % 2 === 0 || i === n - 1) {
          var lb = mk('text', { x: (x + bw / 2).toFixed(1), y: H - 8, 'text-anchor': 'middle' }, 'font: 500 11px var(--mono, monospace); fill: var(--muted)');
          lb.textContent = W < 480 ? MON[mo].charAt(0) : MON[mo]; svg.appendChild(lb);
        }
        if (vals[i] != null && !m.partial) pts.push([x + bw / 2, padT + plotH - (vals[i] / maxV) * plotH]);
      });
      if (pts.length > 1) {
        svg.appendChild(mk('polyline', { points: pts.map(function (p) { return p[0].toFixed(1) + ',' + p[1].toFixed(1); }).join(' '), fill: 'none' }, 'stroke: var(--text); stroke-width: 2; stroke-linejoin: round; stroke-linecap: round'));
        pts.forEach(function (p) { svg.appendChild(mk('circle', { cx: p[0].toFixed(1), cy: p[1].toFixed(1), r: 3 }, 'fill: var(--surface); stroke: var(--text); stroke-width: 2')); });
      }
      host.appendChild(svg);
      var first = months[0], last = months[n - 1];
      host.setAttribute('aria-label', 'Spend and ' + (roas ? 'return on ad spend' : 'cost per conversion') + ' by month, ' + MON[Number(first.month.slice(5, 7)) - 1] + ' ' + first.month.slice(0, 4) + ' to ' + MON[Number(last.month.slice(5, 7)) - 1] + ' ' + last.month.slice(0, 4));
    }
    trDraw = draw; draw();
    if (!trWired && narrow.addEventListener) { trWired = true; narrow.addEventListener('change', function () { if (trDraw) trDraw(); }); }

    // devices and networks, 90 days
    var sg = r.segments, segBox = $('tr-seg');
    segBox.hidden = !sg || !((sg.devices || []).length);
    if (!segBox.hidden) {
      $('tr-seg-k').textContent = roas ? 'Return' : 'Per conversion';
      var body = $('tr-seg-rows'); body.textContent = '';
      function sub(label) { var tr = el('tr', 'sub'), td = el('td', null, label); td.colSpan = 5; tr.appendChild(td); body.appendChild(tr); }
      function line(x) {
        var tr = el('tr');
        tr.appendChild(el('td', null, x.label));
        tr.appendChild(el('td', 'r', cur.format(x.spend)));
        tr.appendChild(el('td', 'r', Math.round(x.share) + '%'));
        tr.appendChild(el('td', 'r', String(x.conversions >= 100 ? Math.round(x.conversions) : x.conversions)));
        tr.appendChild(el('td', 'r', roas ? (x.roas != null ? Math.round(x.roas * 100) + '%' : 'n/a') : (x.cpa != null ? cur.format(x.cpa) : 'none')));
        body.appendChild(tr);
      }
      sub('Devices'); sg.devices.forEach(line);
      if ((sg.networks || []).length > 1) { sub('Networks'); sg.networks.forEach(line); }
    }

    // change history, 28 days
    var ch = r.changes, chBox = $('tr-chg');
    chBox.hidden = !ch;
    if (ch) {
      var txt;
      if (!ch.total) txt = 'The change history shows no changes in the last 28 days.';
      else {
        var types = ch.byType.slice(0, 3).map(function (x) { return x.label.toLowerCase() + ' (' + x.n + ')'; });
        var list = types.length > 1 ? types.slice(0, -1).join(', ') + ' and ' + types[types.length - 1] : types[0];
        txt = (ch.truncated ? 'At least ' : '') + ch.total + ' change' + (ch.total === 1 ? '' : 's') + (ch.last ? ', the latest on ' + DATE.format(new Date(ch.last + 'T12:00:00Z')).replace(/ \d{4}$/, '') : '') + '. ' +
          'Most were to ' + list + '. ' +
          (ch.auto ? ch.auto + (ch.auto === 1 ? ' was' : ' were') + ' made by Google’s automatically applied recommendations. ' : '') +
          ch.campaignsChanged + ' of your ' + ch.campaignsSpending + ' campaign' + (ch.campaignsSpending === 1 ? '' : 's') + ' that spent had at least one change.';
      }
      $('tr-chg-text').textContent = txt;
    }
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
    // the structure, kept simple (Lewis, 18 Nov): one card per campaign type, biggest spend first, each campaign on one line.
    // Asset groups fold behind a one-line strength count, and the smaller campaign types fold behind "Show more".
    var tree = $('pf-tree'); tree.textContent = '';
    tree.appendChild(el('div', 'pf-th', 'Your ' + p.campaigns + ' campaign' + (p.campaigns === 1 ? '' : 's') + ', biggest spend first'));
    var total = p.groups.reduce(function (s, g) { return s + (g.spend || 0); }, 0) || 1;
    // bars are scaled to the biggest campaign, so a 26-campaign account still shows readable bars (the % stays true)
    var top = Math.max.apply(null, p.groups.map(function (g) { return Math.max.apply(null, g.campaigns.map(function (c) { return c.share || 0; }).concat(0)); }).concat(1));
    var plural = function (n, w) { return n + ' ' + w + (n === 1 ? '' : 's'); };
    var cap = function (s) { s = String(s || '').toLowerCase(); return s.charAt(0).toUpperCase() + s.slice(1); };
    function fold(label, kids, cls) {
      var d = el('details', cls), s = el('summary', null, label); d.appendChild(s);
      kids.forEach(function (k) { d.appendChild(k); });
      return d;
    }
    function camp(c) {
      var row = el('div', 'pf-row');
      row.appendChild(el('div', 'pf-cn', c.name));
      var cb = el('div', 'pf-cbar'), fill = el('i'); fill.style.width = Math.max(2, (c.share || 0) / top * 100) + '%'; cb.appendChild(fill); row.appendChild(cb);
      row.appendChild(el('span', 'pf-n', Math.round(c.share) + '%'));
      row.appendChild(el('span', 'pf-n', c.conversions + ' conv.'));
      row.appendChild(el('span', 'pf-n', c.cpa ? cur.format(c.cpa) + ' each' : ''));
      if (c.children && c.children.length) {
        var tally = {};
        c.children.forEach(function (k) { if (k.strength) { var t = cap(k.strength); tally[t] = (tally[t] || 0) + 1; } });
        var parts = ['Excellent', 'Good', 'Average', 'Poor'].filter(function (t) { return tally[t]; }).map(function (t) { return tally[t] + ' ' + t; });
        var ul = el('ul', 'pf-ag-list');
        c.children.forEach(function (k) {
          var li = el('li');
          li.appendChild(el('span', 'pf-agn', k.name));
          li.appendChild(k.strength ? el('span', 'pf-st ' + k.strength.toLowerCase(), cap(k.strength)) : el('span'));
          li.appendChild(el('span', 'pf-n', k.share != null ? Math.round(k.share) + '% · ' + k.conversions + ' conv.' : ''));
          ul.appendChild(li);
        });
        row.appendChild(fold(plural(c.children.length, 'asset group') + (parts.length ? ': ' + parts.join(', ') : ''), [ul], 'pf-fold pf-sub'));
      } else if (c.inside) {
        row.appendChild(el('div', 'pf-ci', c.inside));
      }
      return row;
    }
    function group(g) {
      var box = el('div', 'pf-group'), gh = el('div', 'pf-gh');
      gh.appendChild(el('b', null, g.label));
      gh.appendChild(el('span', null, plural(g.campaigns.length, 'campaign')));
      gh.appendChild(el('em', null, cur.format(g.spend) + ' · ' + Math.round(g.spend / total * 100) + '%'));
      box.appendChild(gh);
      var rows = g.campaigns.map(camp), KEEP = 5;
      if (rows.length > KEEP + 1) {
        rows.slice(0, KEEP).forEach(function (r) { box.appendChild(r); });
        box.appendChild(fold('Show ' + plural(rows.length - KEEP, 'more campaign'), rows.slice(KEEP), 'pf-fold'));
      } else rows.forEach(function (r) { box.appendChild(r); });
      return box;
    }
    var groups = el('div', 'pf-groups'), SHOW = 4;
    var cards = p.groups.map(group);
    if (cards.length > SHOW + 1) {
      cards.slice(0, SHOW).forEach(function (c) { groups.appendChild(c); });
      var rest = p.groups.slice(SHOW), restSpend = rest.reduce(function (s, g) { return s + (g.spend || 0); }, 0);
      groups.appendChild(fold('Show ' + plural(rest.length, 'more campaign type') + ' (' + cur.format(restSpend) + ', ' + Math.round(restSpend / total * 100) + '% of spend)', cards.slice(SHOW), 'pf-fold pf-more'));
    } else cards.forEach(function (c) { groups.appendChild(c); });
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
        tr.appendChild(el('td', 'r', String(x.conversions >= 100 ? Math.round(x.conversions) : x.conversions)));
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
    $('rep-meta').textContent = (r.sample ? 'Sample data, not a real account · ' : 'Customer ID ' + r.customerId + ' · ') + 'Checked ' + DATE.format(new Date(r.checkedAt)) + ' · last 30 days' + (r.trend ? ', trends over 13 months' : '') + (r.preview && !demo && r.operations ? ' · ' + r.operations + ' API operations' : '');
    var f = r.facts || {}, tiles = $('rep-tiles'); tiles.textContent = '';
    tiles.appendChild(tile('Spend, last 30 days', f.spend30 != null ? cur.format(f.spend30) : 'n/a', (f.activeCampaigns || 0) + ' active campaigns'));
    tiles.appendChild(tile('Conversions', f.conversions30 != null ? String(Math.round(f.conversions30 * 10) / 10) : 'n/a', f.costPerConversion30 ? cur.format(f.costPerConversion30) + ' each' : ''));
    var high = r.weaknesses.filter(function (w) { return w.priority === 'high'; }).length;
    tiles.appendChild(tile('To fix', String(r.weaknesses.length), high ? high + ' to fix first' : 'none urgent', high ? 'bad' : r.weaknesses.length ? 'warn' : 'good'));
    tiles.appendChild(tile('Working well', String(r.strengths.length), 'keep these', 'good'));
    var byId = {}; ((r.quote && r.quote.lines) || []).forEach(function (l) { byId[l.id] = l; });
    var wk = $('rep-weak'); wk.textContent = '';
    current_money = cur; r.weaknesses.forEach(function (w) { wk.appendChild(finding(w)); });
    $('sec-weak').hidden = !r.weaknesses.length;
    var st = $('rep-strong'); st.textContent = '';
    r.strengths.forEach(function (s) { var li = el('li', null, s.title); li.title = s.detail || ''; st.appendChild(li); });
    $('weak-count').textContent = String(r.weaknesses.length); $('strong-count').textContent = String(r.strengths.length);
    $('sec-strong').hidden = !r.strengths.length;
    summary(r, cur);
    profile(r, cur);
    trend(r, cur);
    ngrams(r, cur);
    heatmap(r);
    fixes(r);
    $('report').hidden = false;
    if (trDraw) trDraw(); // the chart needs the report on screen to know its width
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
  } else if (preview && /[?&]sample=[a-z0-9]+/.test(location.search)) {
    var qs = function (k) { var x = location.search.match(new RegExp('[?&]' + k + '=([^&]+)')); return x ? decodeURIComponent(x[1]) : ''; };
    var sb = { variant: qs('sample') };
    if (qs('cpa')) sb.target = { type: 'cpa', value: qs('cpa') }; else if (qs('roas')) sb.target = { type: 'roas', value: qs('roas') };
    if (qs('brand')) sb.brand = qs('brand');
    post('/tools/google-ads-check/sample', sb).then(function (res) { if (res.ok) show(res.d.report, 'jump'); else say(res.d.error, true); });
  }
})();
