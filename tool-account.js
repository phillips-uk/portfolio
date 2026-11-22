// The account page (cloudflare/src/accounts.js, Accounts Plan step 1, 22 Nov 2026): the sign-in card (Google, or an
// email link), the "one more step" card an email link opens, and the list of saved checks.
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var body = document.body;
  var preview = body.getAttribute('data-preview') === '1';
  var google = body.getAttribute('data-google') === '1';
  var params = new URLSearchParams(location.search);
  var next = params.get('next') || '';
  var CLIENT_ID = '339165209514-jn3kstpi7on9jtl160afc8el2j5a4h1m.apps.googleusercontent.com';
  var SITEKEY = /(^|\.)phillips-uk\.com$/.test(location.hostname) ? '0x4AAAAAAGDEt8LCJ4VVlwit' : '1x00000000000000000000AA';
  var DATE = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/London' });
  var AREAS = { seo: 'Search', speed: 'Speed', ux: 'User experience', technical: 'Technical', ai: 'AI search', trust: 'Trust' };

  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function api(path, data) {
    return fetch(path, { method: data ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', body: data ? JSON.stringify(data) : undefined })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (d) { if (!r.ok) throw new Error(d.error || 'Something went wrong. Please try again.'); return d; }); });
  }
  function show(id) { ['acct-signin', 'acct-confirm', 'acct-home'].forEach(function (x) { $(x).hidden = x !== id; }); }
  function go(to) { location.href = to || '/account/'; }
  if (preview) $('preview-flag').hidden = false;

  // ---------- an email link: one more press, so a mail scanner opening the link can't use it ----------
  var t = params.get('t');
  if (t) {
    show('acct-confirm');
    history.replaceState(null, '', '/account/login');
    $('acct-confirm-go').addEventListener('click', function () {
      var b = this; b.disabled = true; $('acct-confirm-status').textContent = 'Signing in…';
      api('/account/login/confirm', { t: t }).then(function (d) { go(d.next); })
        .catch(function (e) { b.disabled = false; $('acct-confirm-status').textContent = e.message; $('acct-confirm-status').className = 'check-status err'; });
    });
    return;
  }

  // ---------- signed in, or the sign-in card ----------
  api('/account/me').then(function (d) { if (d.account) home(d); else signin(); }).catch(signin);

  var widget = null, token = '';
  function signin() {
    show('acct-signin');
    if (google) {
      $('acct-google').hidden = false;
      (function render() {
        if (!window.google || !window.google.accounts || !window.google.accounts.id) { setTimeout(render, 200); return; }
        window.google.accounts.id.initialize({ client_id: CLIENT_ID, callback: function (resp) {
          say('Checking…');
          api('/account/login/google', { credential: resp.credential, next: next }).then(function (d) { go(d.next); }).catch(function (e) { say(e.message, true); });
        }, auto_select: false });
        window.google.accounts.id.renderButton($('gsi-btn'), { theme: 'outline', size: 'large', text: 'signin_with', shape: 'pill', width: 300 });
      })();
    }
    if (!preview) loadTurnstile();
  }
  function say(msg, err) { $('acct-status').textContent = msg || ''; $('acct-status').className = 'check-status' + (err ? ' err' : ''); }
  function loadTurnstile() {
    var s = document.createElement('script');
    s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
    s.onload = function () {
      widget = window.turnstile.render('#acct-ts', { sitekey: SITEKEY, action: 'account_login', appearance: 'interaction-only', theme: 'light', callback: function (v) { token = v; } });
    };
    document.head.appendChild(s);
  }
  $('acct-form').addEventListener('submit', function (e) {
    e.preventDefault();
    var email = $('acct-email').value.trim();
    if (!/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(email)) { say('Enter a valid email address.', true); return; }
    var b = $('acct-go'); b.disabled = true; say('Sending…');
    api('/account/login/email', { email: email, token: token, next: next }).then(function (d) { say(d.message); $('acct-email').value = ''; })
      .catch(function (err) { say(err.message, true); })
      .then(function () { b.disabled = false; token = ''; if (widget !== null && window.turnstile) window.turnstile.reset(widget); });
  });

  // ---------- the dashboard (Accounts Plan step 2): one row per site, scores over time ----------
  var ORDER = ['seo', 'speed', 'ux', 'technical', 'ai', 'trust'];
  var KIND = { local: 'local', national: 'regional or UK-wide', shop: 'online shop' };
  var SHORT = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', timeZone: 'Europe/London' });
  var svgNS = 'http://www.w3.org/2000/svg';
  function svg(tag, attrs) { var e = document.createElementNS(svgNS, tag); for (var k in attrs) e.setAttribute(k, attrs[k]); return e; }

  // A small line of one area's score across checks, oldest to newest (single series: the area name above it says what it is)
  function spark(points, label) {
    var w = 120, h = 34, pad = 4;
    var box = svg('svg', { viewBox: '0 0 ' + w + ' ' + h, width: w, height: h, role: 'img', 'aria-label': label + ': ' + points.map(function (p) { return p.v; }).join(', ') });
    box.appendChild(svg('line', { x1: 0, x2: w, y1: h - pad, y2: h - pad, class: 'sp-base' }));
    var step = points.length > 1 ? (w - pad * 2) / (points.length - 1) : 0;
    var xy = points.map(function (p, i) { return [pad + i * step, pad + (1 - p.v / 100) * (h - pad * 2)]; });
    if (xy.length > 1) box.appendChild(svg('polyline', { points: xy.map(function (q) { return q.join(','); }).join(' '), class: 'sp-line' }));
    xy.forEach(function (q, i) {
      var c = svg('circle', { cx: q[0], cy: q[1], r: i === xy.length - 1 ? 3.5 : 2.5, class: i === xy.length - 1 ? 'sp-dot last' : 'sp-dot' });
      var t = svg('title', {}); t.textContent = SHORT.format(new Date(points[i].at)) + ': ' + points[i].v; c.appendChild(t);
      box.appendChild(c);
    });
    return box;
  }
  function scoreOf(c, id) { var s = (c.scores || []).filter(function (x) { return x.id === id; })[0]; return s && s.score != null ? s.score : null; }

  function siteCard(domain, list) {
    var latest = list[0];
    var same = list.filter(function (c) { return (c.model || null) === (latest.model || null); }); // compare like with like
    var prev = same[1];
    var li = el('li', 'dash-site');
    var head = el('div', 'dash-head');
    var t = el('div');
    var a = el('a', 'dash-name', domain); a.href = '/website-check/r/' + latest.id; t.appendChild(a);
    t.appendChild(el('span', 'dash-meta', 'Last checked ' + DATE.format(new Date(latest.checked_at)) + (latest.model && KIND[latest.model] ? ' · as ' + KIND[latest.model] : '') + ' · ' + (latest.fixes ? latest.fixes + ' to fix' : 'nothing to fix')));
    head.appendChild(t);
    var acts = el('div', 'dash-acts');
    var again = el('a', 'btn-filled', 'Check again'); again.href = '/website-check/?check=' + encodeURIComponent(domain) + (latest.model ? '&kind=' + latest.model : '');
    var open = el('a', 'btn-outline', 'Latest report'); open.href = '/website-check/r/' + latest.id;
    acts.appendChild(again); acts.appendChild(open); head.appendChild(acts);
    li.appendChild(head);

    var grid = el('ul', 'dash-areas');
    ORDER.forEach(function (id) {
      var v = scoreOf(latest, id); if (v == null) return;
      var cell = el('li');
      cell.appendChild(el('small', null, AREAS[id]));
      var b = el('b', null, String(v));
      var pv = prev ? scoreOf(prev, id) : null;
      if (pv != null && pv !== v) { var d = el('em', null, (v > pv ? '+' : '−') + Math.abs(v - pv)); d.title = (v > pv ? 'Up ' : 'Down ') + Math.abs(v - pv) + ' since ' + DATE.format(new Date(prev.checked_at)); b.appendChild(d); }
      cell.appendChild(b);
      var pts = same.slice().reverse().map(function (c) { return { v: scoreOf(c, id), at: c.checked_at }; }).filter(function (p) { return p.v != null; });
      if (pts.length > 1) cell.appendChild(spark(pts, AREAS[id]));
      grid.appendChild(cell);
    });
    li.appendChild(grid);
    if (same.length < 2) li.appendChild(el('p', 'dash-hint', 'Check again after you’ve made changes and your progress shows here.'));

    if (list.length > 1) {
      var more = el('details', 'dash-more'); more.appendChild(el('summary', null, 'Earlier reports (' + (list.length - 1) + ')'));
      var ul = el('ul');
      list.slice(1).forEach(function (c) { var x = el('li'); var l = el('a', null, DATE.format(new Date(c.checked_at))); l.href = '/website-check/r/' + c.id; x.appendChild(l); x.appendChild(el('span', null, (c.fixes ? c.fixes + ' to fix' : 'nothing to fix') + (c.model && KIND[c.model] ? ' · as ' + KIND[c.model] : ''))); ul.appendChild(x); });
      more.appendChild(ul); li.appendChild(more);
    }
    return li;
  }

  function adsCard(c) {
    var li = el('li', 'dash-site dash-ads');
    var head = el('div', 'dash-head'), t = el('div');
    var a = el('a', 'dash-name', c.domain); a.href = '/google-ads-audit/r/' + c.id; t.appendChild(a);
    t.appendChild(el('span', 'dash-meta', 'Google Ads Check · ' + DATE.format(new Date(c.checked_at)) + ' · ' + (c.fixes ? c.fixes + ' to fix' : 'nothing to fix')));
    head.appendChild(t);
    var acts = el('div', 'dash-acts'); var o = el('a', 'btn-outline', 'Open report'); o.href = '/google-ads-audit/r/' + c.id; acts.appendChild(o); head.appendChild(acts);
    li.appendChild(head);
    return li;
  }

  function home(d) {
    show('acct-home');
    $('acct-who').textContent = 'Signed in as ' + d.account.email;
    var list = $('acct-list'); list.textContent = '';
    var web = d.checks.filter(function (c) { return c.tool === 'website'; });
    var ads = d.checks.filter(function (c) { return c.tool === 'ads'; });
    $('acct-empty').hidden = d.checks.length > 0;
    var sites = {}, order = [];
    web.forEach(function (c) { if (!sites[c.domain]) { sites[c.domain] = []; order.push(c.domain); } sites[c.domain].push(c); });
    order.forEach(function (dm) { list.appendChild(siteCard(dm, sites[dm])); });
    var adsBox = $('acct-ads'); adsBox.textContent = '';
    $('acct-ads-sec').hidden = !ads.length;
    var seen = {};
    ads.forEach(function (c) { if (seen[c.domain]) return; seen[c.domain] = 1; adsBox.appendChild(adsCard(c)); });
  }
  $('acct-out').addEventListener('click', function () {
    api('/account/logout', {}).catch(function () {}).then(function () {
      if (window.google && window.google.accounts && window.google.accounts.id) window.google.accounts.id.disableAutoSelect();
      go('/account/');
    });
  });
})();
