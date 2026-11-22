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

  // ---------- the saved checks ----------
  function home(d) {
    show('acct-home');
    $('acct-who').textContent = 'Signed in as ' + d.account.email;
    var list = $('acct-list'); list.textContent = '';
    $('acct-empty').hidden = d.checks.length > 0;
    d.checks.forEach(function (c) {
      var li = el('li', 'acct-item');
      var a = el('a', 'acct-link'); a.href = c.tool === 'website' ? '/website-check/r/' + c.id : '/google-ads-audit';
      a.appendChild(el('b', null, c.domain));
      a.appendChild(el('span', null, (c.tool === 'website' ? 'Website Check' : 'Google Ads Check') + ' · ' + DATE.format(new Date(c.checked_at)) + (c.fixes != null ? ' · ' + (c.fixes ? c.fixes + ' to fix' : 'nothing to fix') : '')));
      li.appendChild(a);
      if (c.scores && c.scores.length) {
        var sc = el('ul', 'acct-scores');
        c.scores.forEach(function (s) { if (s.score == null) return; var x = el('li'); x.appendChild(el('small', null, AREAS[s.id] || s.id)); x.appendChild(el('b', null, String(s.score))); sc.appendChild(x); });
        li.appendChild(sc);
      }
      list.appendChild(li);
    });
  }
  $('acct-out').addEventListener('click', function () {
    api('/account/logout', {}).catch(function () {}).then(function () {
      if (window.google && window.google.accounts && window.google.accounts.id) window.google.accounts.id.disableAutoSelect();
      go('/account/');
    });
  });
})();
