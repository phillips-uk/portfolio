// The Website Check page (/website-check). Posts the address to /tools/website-check/run (cloudflare/src/website-check.js)
// with a Turnstile token, then draws the report. Every value from the report goes in with textContent, never as HTML.
// GA4 (through GTM's "Site events to GA4" trigger): website_check_start, website_check_complete, website_check_error.
// Never the address or anything typed in the events.
(function () {
  var $ = function (id) { return document.getElementById(id); };
  var form = $('check-form'), input = $('check-url'), go = $('check-go'), status = $('check-status');
  var preview = document.body.getAttribute('data-preview') === '1';
  var current = null;

  if (preview) { $('preview-flag').hidden = false; $('fresh-opt').hidden = false; }

  function track(event, params) {
    window.dataLayer = window.dataLayer || [];
    var o = { event: event };
    for (var k in params || {}) o[k] = params[k];
    window.dataLayer.push(o);
  }

  // ---------- Turnstile (same widget as the contact form, its own action) ----------
  var SITEKEY = /(^|\.)phillips-uk\.com$/.test(location.hostname) ? '0x4AAAAAAGDEt8LCJ4VVlwit' : '1x00000000000000000000AA';
  var widget = null, token = '', waiting = null, loading = false;
  window.phCheckTurnstile = function () {
    widget = turnstile.render($('check-ts'), {
      sitekey: SITEKEY, action: 'website_check', appearance: 'interaction-only', theme: 'light',
      callback: function (t) { token = t; if (waiting) { var w = waiting; waiting = null; w(); } },
      'expired-callback': function () { token = ''; },
      'error-callback': function () { token = ''; }
    });
  };
  function loadTurnstile() {
    if (loading || preview) return; // Lewis's preview is signed in, so no bot check
    loading = true;
    var s = document.createElement('script');
    s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit&onload=phCheckTurnstile';
    s.async = true; s.defer = true;
    document.head.appendChild(s);
  }
  input.addEventListener('focus', loadTurnstile);
  input.addEventListener('input', loadTurnstile, { once: true });
  function withToken() {
    return new Promise(function (resolve, reject) {
      if (preview) return resolve('');
      loadTurnstile();
      if (token) return resolve(token);
      waiting = function () { resolve(token); };
      setTimeout(function () { if (waiting) { waiting = null; reject(new Error('ts')); } }, 20000);
    });
  }

  // ---------- progress ----------
  var timers = [];
  function progress(on) {
    var list = $('progress');
    timers.forEach(clearTimeout); timers = [];
    var items = list.querySelectorAll('li');
    items.forEach(function (li) { li.className = ''; });
    list.hidden = !on;
    if (!on) return;
    [0, 2500, 5000, 8000].forEach(function (ms, i) {
      timers.push(setTimeout(function () {
        items.forEach(function (li, j) { li.className = j < i ? 'done' : j === i ? 'on' : ''; });
      }, ms));
    });
  }

  function say(msg, err) { status.textContent = msg || ''; status.className = 'check-status' + (err ? ' err' : ''); }

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var url = input.value.trim();
    if (!url) { say('Enter your website’s address.', true); input.focus(); return; }
    go.disabled = true;
    say('Checking. This takes up to a minute while Google measures the speed.');
    progress(true);
    track('website_check_start');
    withToken().then(function (t) {
      return fetch('/tools/website-check/run', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin',
        body: JSON.stringify({ url: url, token: t, fresh: preview && $('check-fresh').checked })
      });
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (d) { return { ok: r.ok, status: r.status, d: d }; });
    }).then(function (res) {
      if (!res.ok || !res.d.report) {
        track('website_check_error', { error_type: res.status === 429 ? 'limit' : res.status === 422 ? 'unreachable' : 'other' });
        throw new Error(res.d.error || 'Something went wrong. Please try again.');
      }
      say(res.d.reused ? 'This site was checked in the last 24 hours, so here is that report.' : '');
      track('website_check_complete', { check_result: res.d.reused ? 'reused' : 'new', weaknesses: res.d.report.counts.weaknesses });
      show(res.d.report, true);
    }).catch(function (err) {
      say(err.message === 'ts' ? 'Please tick the box to show you’re not a bot, then press Check again.' : err.message, true);
    }).then(function () {
      go.disabled = false;
      progress(false);
      token = '';
      if (widget !== null && window.turnstile) turnstile.reset(widget);
    });
  });

  // ---------- report ----------
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  var DATE = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/London' });
  var GROUP = {};

  function tile(label, value, sub, tone) {
    var t = el('div', 'tile' + (tone ? ' ' + tone : ''));
    t.appendChild(el('small', null, label));
    t.appendChild(el('b', null, value));
    if (sub) t.appendChild(el('span', null, sub));
    return t;
  }
  var tone = function (s) { return s == null ? '' : s >= 90 ? 'good' : s >= 50 ? 'warn' : 'bad'; };

  function finding(f) {
    var kind = f.status === 'weakness' ? 'weak ' + f.priority : f.status === 'strength' ? 'strong' : 'note';
    var card = el('article', 'find ' + kind);
    card.appendChild(el('span', 'mk', f.status === 'weakness' ? '!' : f.status === 'strength' ? '✓' : 'i'));
    var body = el('div', 'fb');
    card.appendChild(body);
    var h = el('h4', null, f.title);
    if (f.status === 'weakness') h.appendChild(el('span', 'pr ' + f.priority, f.priority === 'high' ? 'Fix first' : f.priority === 'medium' ? 'Worth fixing' : 'Small'));
    if (GROUP[f.group]) h.appendChild(el('span', 'grp', GROUP[f.group]));
    body.appendChild(h);
    body.appendChild(el('p', null, f.detail));
    if (f.why) body.appendChild(el('p', 'why', f.why));
    if (f.start && f.status !== 'strength') {
      var s = el('p', 'start');
      s.appendChild(el('b', null, 'Start here: '));
      s.appendChild(document.createTextNode(f.start));
      body.appendChild(s);
      if (f.link && /^\/[a-z0-9\-\/]*$/.test(f.link.href)) {
        var a = el('a', 'go', f.link.label + ' →');
        a.href = f.link.href;
        body.appendChild(a);
      }
    }
    return card;
  }

  function show(r, scroll) {
    current = r;
    (r.groups || []).forEach(function (g) { GROUP[g[0]] = g[1]; });
    $('rep-domain').textContent = r.domain;
    $('rep-meta').textContent = 'Checked ' + DATE.format(new Date(r.checkedAt)) + (r.page && r.page.title ? ' · “' + r.page.title.slice(0, 80) + '”' : '');
    var tiles = $('rep-tiles'); tiles.textContent = '';
    var m = r.speed && r.speed.mobile, d = r.speed && r.speed.desktop;
    tiles.appendChild(tile('Speed on a phone', m && m.performance != null ? String(m.performance) : 'n/a', 'out of 100', tone(m && m.performance)));
    tiles.appendChild(tile('Speed on a computer', d && d.performance != null ? String(d.performance) : 'n/a', 'out of 100', tone(d && d.performance)));
    tiles.appendChild(tile('To fix', String(r.counts.weaknesses), r.counts.high ? r.counts.high + ' to fix first' : 'none urgent', r.counts.high ? 'bad' : r.counts.weaknesses ? 'warn' : 'good'));
    tiles.appendChild(tile('Working well', String(r.counts.strengths), 'keep these', 'good'));
    [['rep-weak', 'sec-weak', r.weaknesses], ['rep-strong', 'sec-strong', r.strengths], ['rep-notes', 'sec-notes', r.notes]].forEach(function (x) {
      var box = $(x[0]); box.textContent = '';
      (x[2] || []).forEach(function (f) { box.appendChild(finding(f)); });
      $(x[1]).hidden = !(x[2] || []).length;
    });
    $('report').hidden = false;
    var path = '/website-check/r/' + r.id;
    if (location.pathname !== path) history.replaceState(null, '', path);
    if (scroll) $('report').scrollIntoView({ behavior: scroll === 'jump' ? 'auto' : 'smooth', block: 'start' });
  }

  $('rep-copy').addEventListener('click', function () {
    var link = location.origin + '/website-check/r/' + (current && current.id);
    var b = this;
    (navigator.clipboard ? navigator.clipboard.writeText(link) : Promise.reject()).then(function () { b.textContent = 'Link copied'; }, function () { b.textContent = link; });
    setTimeout(function () { b.textContent = 'Copy the link'; }, 2500);
  });
  $('rep-again').addEventListener('click', function () {
    history.replaceState(null, '', '/website-check/');
    $('report').hidden = true; say(''); input.value = ''; input.focus();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });
  // "Ask me about this report": the contact form gets the site and the report link.
  $('rep-ask').addEventListener('click', function () {
    var f = document.querySelector('#contact form.enquiry');
    if (!f || !current) return;
    var biz = f.querySelector('[name="business"]'), msg = f.querySelector('[name="message"]');
    if (biz && !biz.value) biz.value = current.domain;
    if (msg && !msg.value) msg.value = 'About my Website Check report: ' + location.origin + '/website-check/r/' + current.id + '\n\n';
  });

  // A saved report (the share link)
  var m = location.pathname.match(/^\/website-check\/r\/([a-f0-9]{32})\/?$/);
  if (m) {
    say('Loading the report…');
    fetch('/tools/website-check/report/' + m[1], { credentials: 'same-origin' }).then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
      .then(function (res) { if (!res.ok) throw new Error(res.d.error || 'That report could not be loaded.'); say(''); show(res.d.report, 'jump'); })
      .catch(function (err) { say(err.message, true); });
  }
})();
