// The Website Check page (/website-check). Posts the address to /tools/website-check/run (cloudflare/src/website-check.js)
// with a Turnstile token, then draws the report. Every value from the report goes in with textContent, never as HTML.
// GA4 (through GTM's "Site events to GA4" trigger): website_check_start, website_check_complete, website_check_error.
// Never the address or anything typed in the events.
(function () {
  var $ = function (id) { return document.getElementById(id); };
  var form = $('check-form'), input = $('check-url'), go = $('check-go'), status = $('check-status');
  var preview = document.body.getAttribute('data-preview') === '1';
  var current = null;

  // ?demo=1 in Lewis's signed-in preview: the page looks as a visitor sees it (no preview banner or options), for
  // /admin#demos/web. ?sample=<id> draws a made-up demo website's report (website-demos.js).
  var demo = preview && /[?&]demo=1/.test(location.search);
  if (preview && !demo) { $('preview-flag').hidden = false; $('fresh-opt').hidden = false; }

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

  // The kind of business (rules v5, Lewis 21 Nov 2026): optional on the form; left blank, the check detects it and the
  // report offers a switch. A chip can be tapped again to clear it.
  var KINDS = { local: 'a local business', national: 'a business with regional or UK-wide customers', shop: 'an online shop' };
  var kindInputs = Array.prototype.slice.call(document.querySelectorAll('#wc-kind input'));
  kindInputs.forEach(function (k) {
    var was = false;
    k.parentNode.addEventListener('pointerdown', function () { was = k.checked; });
    k.addEventListener('click', function () { if (was) { k.checked = false; was = false; } });
  });
  function kind() { var c = kindInputs.filter(function (k) { return k.checked; })[0]; return c ? c.value : ''; }
  function setKind(v) { kindInputs.forEach(function (k) { k.checked = k.value === v; }); }

  function say(msg, err) { status.textContent = msg || ''; status.className = 'check-status' + (err ? ' err' : ''); }

  var askFresh = false; // set by the report's "Check again" (v3 item 1) and the dashboard's
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
        body: JSON.stringify({ url: url, token: t, fresh: (preview && $('check-fresh').checked) || askFresh || undefined, model: kind() || undefined })
      });
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (d) { return { ok: r.ok, status: r.status, d: d }; });
    }).then(function (res) {
      if (!res.ok || !res.d.report) {
        track('website_check_error', { error_type: res.status === 429 ? 'limit' : res.status === 422 ? 'unreachable' : 'other' });
        throw new Error(res.d.error || 'Something went wrong. Please try again.');
      }
      say(res.d.reused ? (askFresh ? 'This site was checked less than an hour ago, so here is that report. You can check again after an hour.' : 'This site was checked in the last 24 hours, so here is that report.') : '');
      track('website_check_complete', { check_result: res.d.reused ? 'reused' : 'new', weaknesses: res.d.report.counts.weaknesses });
      acct = res.d.account || null;
      show(res.d.report, true);
    }).catch(function (err) {
      say(err.message === 'ts' ? 'Please tick the box to show you’re not a bot, then press Check again.' : err.message, true);
    }).then(function () {
      go.disabled = false;
      askFresh = false;
      progress(false);
      token = '';
      if (widget !== null && window.turnstile) turnstile.reset(widget);
    });
  });

  // ---------- report (v3, Lewis 18 Nov 2026: the same treatment as the Google Ads report) ----------
  // Top: domain and four tiles. Ink panel "How I read your site": a one-line read of the business, four facts, how the
  // page looks in Google, its first screen on a phone, and a visitor's path (found, first look, trust, get in touch,
  // counted) built from the findings' groups. Then speed gauges, what's working, what to fix and notes.
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  var DATE = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/London' });
  var GROUP = {};

  var tone = function (s) { return s == null ? '' : s >= 90 ? 'good' : s >= 50 ? 'warn' : 'bad'; };
  var secs = function (ms) { return (Math.round(ms / 100) / 10).toFixed(1) + ' s'; };
  var cut = function (s, n) { s = String(s || ''); return s.length > n ? s.slice(0, n - 1).replace(/\s+\S*$/, '') + '…' : s; };
  var all = function (r) { return (r.strengths || []).concat(r.weaknesses || [], r.notes || []); };
  var byId = function (r, id) { return all(r).filter(function (f) { return f.id === id; })[0]; };

  function finding(f, label) {
    var card = el('article', 'find weak ' + f.priority);
    card.appendChild(el('span', 'mk', '!'));
    var body = el('div', 'fb'); card.appendChild(body);
    var h = el('h4', null, f.title);
    h.appendChild(el('span', 'pr ' + f.priority, f.priority === 'high' ? 'Fix first' : f.priority === 'medium' ? 'Worth fixing' : 'Small'));
    if (label || GROUP[f.group]) h.appendChild(el('span', 'grp', label || GROUP[f.group]));
    body.appendChild(h);
    if (f.start) {
      var sb = el('div', 'start-box'); sb.appendChild(el('span', 'sb-k', 'Start here')); sb.appendChild(el('p', null, f.start));
      // Rules v6: Google's own list for speed (with its estimated saving), or the next accessibility fixes
      if (f.items && f.items.length) {
        if (f.itemsLabel) sb.appendChild(el('span', 'sb-k sb-sub', f.itemsLabel));
        var ol = el('ol', 'sb-list');
        f.items.forEach(function (it) { var li = el('li', null, it.text); if (it.note) li.appendChild(el('span', 'sb-n', it.note)); ol.appendChild(li); });
        sb.appendChild(ol);
      }
      body.appendChild(sb);
    }
    var d = el('details'); d.appendChild(el('summary', null, 'Why it matters'));
    d.appendChild(el('p', null, f.detail));
    if (f.why) d.appendChild(el('p', 'why', f.why));
    if (f.link && /^\/[a-z0-9\-\/]*$/.test(f.link.href)) { var a = el('a', 'go', f.link.label + ' →'); a.href = f.link.href; d.appendChild(a); }
    body.appendChild(d);
    return card;
  }

  function chip(text, ok) { var li = el('li', ok == null ? 'na' : ok ? 'ok' : 'no'); li.appendChild(el('i', null, ok == null ? '·' : ok ? '✓' : '!')); li.appendChild(document.createTextNode(text)); return li; }
  function passes(r, id) { var f = byId(r, id); return f ? f.status === 'strength' : null; }

  function profile(r) {
    var p = r.profile, sec = $('sec-profile');
    sec.hidden = !p;
    if (!p) return;
    $('pf-summary').textContent = p.summary;
    // Which kind of business it was checked as, and a switch to the others (a re-run, or the demo again for a sample)
    var pk = $('pf-kind'); pk.textContent = '';
    var m = r.model || p.model;
    if (m && KINDS[m]) {
      var line = el('span'); line.appendChild(document.createTextNode('Checked as ')); line.appendChild(el('b', null, KINDS[m]));
      line.appendChild(document.createTextNode((r.modelFrom || p.modelFrom) === 'chosen' ? ', as you chose.' : ', from what the page shows.'));
      pk.appendChild(line); pk.appendChild(el('span', null, 'Not right?'));
      Object.keys(KINDS).filter(function (k) { return k !== m; }).forEach(function (k) {
        var b = el('button', null, { local: 'Check as local', national: 'Check as regional or UK-wide', shop: 'Check as a shop' }[k]); b.type = 'button';
        b.addEventListener('click', function () { recheck(r, k); });
        pk.appendChild(b);
      });
    }
    var facts = $('pf-facts'); facts.textContent = '';
    function fact(k, v, sub) { var d = el('div'); d.appendChild(el('dt', null, k)); var dd = el('dd', null, v); if (sub) dd.appendChild(el('small', null, sub)); d.appendChild(dd); facts.appendChild(d); }
    fact('Business', p.kind || 'Not clear from the page', p.kindFrom === 'structured data' ? 'From your structured data' : p.kindFrom === 'Shopify' ? 'From your Shopify store' : p.kindFrom ? 'From the page' : 'No business type in the page code');
    fact('Where', p.place || 'Not named near the top', p.wide && p.place === 'Across the UK' ? 'You say you serve the whole country' : p.place ? 'From the top of the page' : 'Name your town near the top');
    var reach = (p.reach || []).map(function (x) { return x.replace(/^a /, ''); });
    fact('Get in touch', reach.length ? reach.join(', ').replace(/^./, function (c) { return c.toUpperCase(); }) : 'Nothing found', reach.length ? 'On this page' : 'No phone, email or form');
    fact('Built on', p.platform || 'Custom or not detected', p.platform ? 'From the page code' : 'No website builder found in the code');

    // How you look in Google
    var g = p.google || {}, serp = $('wr-serp'); serp.textContent = '';
    var top = el('div', 'sr-top'), fav = el('span', 'sr-fav', ((p.name || g.url || '?').replace(/^www\./, '').charAt(0) || '?').toUpperCase());
    var who = el('span', 'sr-who'); who.appendChild(el('b', null, p.name || g.url)); who.appendChild(el('small', null, 'https://' + g.url));
    top.appendChild(fav); top.appendChild(who); serp.appendChild(top);
    serp.appendChild(g.title ? el('p', 'sr-title', cut(g.title, 66)) : el('p', 'sr-title none', 'No page title, so Google writes its own'));
    serp.appendChild(g.description ? el('p', 'sr-desc', cut(g.description, 158)) : el('p', 'sr-desc none', 'No description, so Google picks a line from the page.'));
    var sc = $('wr-serp-chips'); sc.textContent = '';
    var tl = (g.title || '').length, dl = (g.description || '').length;
    sc.appendChild(chip(tl ? 'Title, ' + tl + ' characters' + (tl > 65 ? ', cut off' : tl < 15 ? ', very short' : '') : 'No title', passes(r, 'title')));
    sc.appendChild(chip(dl ? 'Description, ' + dl + ' characters' + (dl > 170 ? ', cut off' : '') : 'No description', dl ? dl >= 50 && dl <= 170 : false));
    var ni = byId(r, 'noindex'); sc.appendChild(chip(ni ? 'Asks Google not to list it' : 'Google may list it', !ni));

    // The first screen on a phone
    var fs = p.firstScreen || {}, scr = $('wr-screen'); scr.textContent = '';
    var bar = el('div', 'ph-bar'); bar.appendChild(el('b', null, p.name || g.url)); bar.appendChild(el('span', 'ph-menu')); scr.appendChild(bar);
    scr.appendChild(fs.h1 ? el('p', 'ph-h1', cut(fs.h1, 70)) : el('p', 'ph-h1 none', 'No main heading'));
    if (p.place && p.place !== 'Across the UK') scr.appendChild(el('p', 'ph-place', p.place));
    scr.appendChild(fs.cta ? el('span', 'ph-cta', (fs.cta.kind === 'call' ? '☎ ' : '') + cut(fs.cta.text, 26)) : el('span', 'ph-cta none', 'No contact button'));
    var lines = el('div', 'ph-lines'); for (var i = 0; i < 3; i++) lines.appendChild(el('i')); scr.appendChild(lines);
    var pc = $('wr-phone-chips'); pc.textContent = '';
    pc.appendChild(chip('Fits a phone screen', passes(r, 'viewport')));
    pc.appendChild(chip(fs.h1 ? 'Says what you do' : 'No main heading', passes(r, 'what-you-do')));
    pc.appendChild(chip(fs.cta ? 'Contact at the top' : 'No contact at the top', passes(r, 'contact-top')));

    // A visitor's path
    var STAGES = [
      ['Found', 'Google and AI assistants can find and read it', ['search', 'technical', 'ai']],
      ['First look', 'Fast, fits the phone, says what you do', ['speed', 'mobile', 'first']],
      ['Trust', 'Reviews and proof on the page', ['proof']],
      ['Get in touch', 'Easy to call, email or ask', ['contact']],
      ['Counted', 'Enquiries can be measured', ['measure']]
    ];
    var J = $('wr-journey'); J.textContent = '';
    STAGES.forEach(function (st, i) {
      var fs2 = (r.strengths || []).concat(r.weaknesses || []).filter(function (f) { return st[2].indexOf(f.group) !== -1; });
      var ok = fs2.filter(function (f) { return f.status === 'strength'; }).length;
      var weak = (r.weaknesses || []).filter(function (f) { return st[2].indexOf(f.group) !== -1; });
      var worst = weak[0];
      var li = el('li', 'wj ' + (!fs2.length ? 'na' : !weak.length ? 'good' : weak.some(function (f) { return f.priority === 'high'; }) ? 'bad' : 'warn'));
      li.appendChild(el('span', 'wj-n', String(i + 1)));
      li.appendChild(el('b', null, st[0]));
      li.appendChild(el('small', null, st[1]));
      var segs = el('span', 'wj-segs');
      fs2.forEach(function (f) { segs.appendChild(el('i', f.status === 'strength' ? 'ok' : f.priority)); });
      li.appendChild(segs);
      li.appendChild(el('span', 'wj-score', fs2.length ? ok + ' of ' + fs2.length + ' checks pass' : 'Not checked'));
      li.appendChild(el('span', 'wj-next', worst ? 'Next: ' + worst.title : fs2.length ? 'All good' : ''));
      J.appendChild(li);
    });
  }

  function gauge(label, s) {
    var card = el('div', 'wr-gauge ' + tone(s && s.performance));
    var v = s && s.performance != null ? s.performance : null;
    var NS = 'http://www.w3.org/2000/svg', svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 120 120'); svg.setAttribute('aria-hidden', 'true');
    var bg = document.createElementNS(NS, 'circle'), fg = document.createElementNS(NS, 'circle');
    [bg, fg].forEach(function (c) { c.setAttribute('cx', '60'); c.setAttribute('cy', '60'); c.setAttribute('r', '50'); c.setAttribute('fill', 'none'); c.setAttribute('stroke-width', '10'); });
    bg.setAttribute('class', 'g-bg'); fg.setAttribute('class', 'g-fg');
    var len = 2 * Math.PI * 50; fg.setAttribute('stroke-dasharray', len.toFixed(1)); fg.setAttribute('stroke-dashoffset', (len * (1 - (v || 0) / 100)).toFixed(1));
    fg.setAttribute('stroke-linecap', 'round'); fg.setAttribute('transform', 'rotate(-90 60 60)');
    svg.appendChild(bg); svg.appendChild(fg);
    var dial = el('div', 'g-dial'); dial.appendChild(svg); dial.appendChild(el('b', null, v == null ? 'n/a' : String(v)));
    card.appendChild(dial);
    var txt = el('div', 'g-txt'); txt.appendChild(el('h4', null, label));
    txt.appendChild(el('p', 'g-verdict', v == null ? 'Google’s test didn’t answer this time' : v >= 90 ? 'Fast' : v >= 50 ? 'Could be faster' : 'Slow'));
    var ul = el('ul', 'g-facts');
    if (s && s.lcp != null) ul.appendChild(el('li', null, 'Main content shows in ' + secs(s.lcp)));
    if (s && s.tbt != null) ul.appendChild(el('li', null, 'Busy for ' + Math.round(s.tbt) + ' ms while loading'));
    if (s && s.cls != null) ul.appendChild(el('li', null, 'Layout shift ' + s.cls.toFixed(2) + (s.cls > 0.1 ? ' (jumps while loading)' : '')));
    txt.appendChild(ul); card.appendChild(txt);
    return card;
  }
  function speed(r) {
    var m = r.speed && r.speed.mobile, d = r.speed && r.speed.desktop;
    $('sec-speed').hidden = !m && !d;
    if (!m && !d) return;
    var g = $('wr-gauges'); g.textContent = '';
    g.appendChild(gauge('On a phone', m)); g.appendChild(gauge('On a computer', d));
    var ms = m && m.performance;
    $('sp-lede').textContent = ms == null ? 'Google’s speed test, on a phone and a computer.' : ms >= 90 ? ((r.model || (r.profile && r.profile.model)) === 'local' ? 'Quick on a phone, where most local searches happen.' : 'Quick on a phone, where most visitors arrive.') : 'Most visitors arrive on a phone, and slow pages lose them before they read anything.';
    var f = m && m.field, box = $('wr-field'); box.textContent = '';
    box.hidden = !(f && (f.lcp != null || f.inp != null || f.cls != null));
    if (box.hidden) return;
    box.appendChild(el('span', 'wf-k', 'Real visitors on phones, last 28 days'));
    var row = el('div', 'wf-row');
    function vital(name, val, good, txt) { var v = el('div', 'wf ' + (good ? 'ok' : 'no')); v.appendChild(el('small', null, name)); v.appendChild(el('b', null, txt)); v.appendChild(el('span', null, good ? 'Good' : 'Needs work')); row.appendChild(v); }
    if (f.lcp != null) vital('Main content shows', f.lcp, f.lcp <= 2500, secs(f.lcp));
    if (f.inp != null) vital('Taps respond in', f.inp, f.inp <= 200, Math.round(f.inp) + ' ms');
    if (f.cls != null) vital('Layout shift', f.cls, f.cls <= 0.1, f.cls.toFixed(2));
    box.appendChild(row);
  }

  // v3 motion (spec 1e): blocks rise in turn as they come into view, numbers count up, the speed rings draw and the
  // path bars grow. Only when the page's head script set .motion-ready (it doesn't for reduced motion or ?motion=off),
  // so otherwise everything is simply there. The real figures are always in the HTML.
  function animate() {
    var root = document.documentElement;
    // A report drawn in a background tab simply appears: there's nobody watching, and hidden tabs pause animation.
    if (!root.classList.contains('motion-ready') || !('IntersectionObserver' in window) || document.visibilityState === 'hidden') return;
    var rings = Array.prototype.slice.call(document.querySelectorAll('#report .g-fg'));
    rings.forEach(function (g) { g.setAttribute('data-to', g.getAttribute('stroke-dashoffset')); g.setAttribute('stroke-dashoffset', g.getAttribute('stroke-dasharray')); });
    var nums = Array.prototype.slice.call(document.querySelectorAll('#rep-areas .ar b, #report .g-dial b')).filter(function (b) { return /^\d+$/.test(b.textContent); });
    nums.forEach(function (b) { b.setAttribute('data-to', b.textContent); b.textContent = '0'; });
    document.querySelectorAll('#report .wj-segs').forEach(function (row) { Array.prototype.forEach.call(row.children, function (i, n) { i.style.setProperty('--i', n); }); });
    function count(b) {
      var to = +b.getAttribute('data-to'), t0 = null;
      function step(t) { if (t0 === null) t0 = t; var k = Math.min(1, (t - t0) / 900); b.textContent = String(Math.round(to * (1 - Math.pow(1 - k, 3)))); if (k < 1) requestAnimationFrame(step); }
      requestAnimationFrame(step);
      setTimeout(function () { b.textContent = String(to); }, 1100); // lands on the real figure even if frames are slowed
    }
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (en.isIntersecting) show1(en.target);
      });
    }, { rootMargin: '0px 0px -6% 0px', threshold: 0.06 });
    var waiting = [];
    function show1(el) {
      if (waiting.indexOf(el) === -1) return;
      waiting.splice(waiting.indexOf(el), 1); io.unobserve(el);
      el.classList.add('in');
      nums.forEach(function (b) { if (el.contains(b)) count(b); });
      rings.forEach(function (g) { if (el.contains(g)) setTimeout(function () { g.setAttribute('stroke-dashoffset', g.getAttribute('data-to')); }, 60); });
      setTimeout(function () { el.classList.remove('rv', 'in'); el.style.removeProperty('--d'); }, 1400);
    }
    // Belt and braces: a plain scroll check reveals anything in view (or jumped past) that the observer missed.
    var tick = null;
    window.addEventListener('scroll', function () {
      if (tick || !waiting.length) return;
      tick = setTimeout(function () { tick = null; waiting.slice().forEach(function (el) { if (el.getBoundingClientRect().top < window.innerHeight * 0.94) show1(el); }); }, 120);
    }, { passive: true });
    var seen = new Map();
    document.querySelectorAll('#rep-areas > .ar, #pf-summary, #pf-facts > div, #report .wr-view, #wr-journey > .wj, #report .wr-gauge, #wr-field, #rep-strong > li, #rep-weak > .find, #rep-notes > .wr-note, #fix-rows > .fix-row, #options > .option, #report .ask-card').forEach(function (el) {
      var i = seen.get(el.parentNode) || 0; seen.set(el.parentNode, i + 1);
      el.style.setProperty('--d', ((i % 6) * 0.045).toFixed(3) + 's');
      el.classList.add('rv');
      waiting.push(el);
      io.observe(el);
    });
  }

  // ---------- price list (Lewis, 18 Nov 2026: pricing like the Google Ads report) ----------
  // One line per kind of job, smallest first; ticking them adds up a one-off price. No checkout yet: the button
  // fills in the question form with the jobs and the report link, the same as the Google Ads report.
  var GBP = new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP', maximumFractionDigits: 0 });
  // 15 min, 1 hour, 2 hours 30 min: AI-assisted jobs are often under an hour (Lewis, 19 Nov 2026)
  var START_T = 'Set-up (charged once)', START_S = 'I get access, review your site and plan the jobs you tick';
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
  function fixes(r) {
    var q = r.quote, rows = $('fix-rows'); rows.textContent = '';
    var has = !!(q && q.lines && q.lines.length);
    $('sec-fix').hidden = !has;
    $('sec-ask').hidden = has; // the price list carries its own "ask me" line
    if (!has) return;
    if (q.start && q.start.price) rows.appendChild(startRow(q));
    q.lines.slice().sort(function (a, b) { return a.price - b.price; }).forEach(function (l) {
      var row = el('label', 'fix-row');
      var cb = el('input'); cb.type = 'checkbox'; cb.checked = !!l.ticked; cb.value = l.id; row.appendChild(cb);
      var t = el('span'); t.appendChild(el('span', 't', l.fixLabel));
      var sub = el('span', 's', l.covers && l.covers.length ? l.covers.join(' · ') : l.title); sub.style.display = 'block'; var tag = aiTag(l); if (tag) sub.appendChild(tag); t.appendChild(sub);
      row.appendChild(t);
      row.appendChild(el('span', 'h', hrs(l.hours)));
      row.appendChild(el('span', 'p', (l.fromPrice ? 'from ' : '') + GBP.format(l.price)));
      rows.appendChild(row);
      cb.addEventListener('change', function () { options(r); track('website_check_fix_select'); });
    });
    options(r);
  }
  function chosen(r) {
    var ids = Array.prototype.map.call(document.querySelectorAll('#fix-rows input:checked'), function (i) { return i.value; });
    return r.quote.lines.filter(function (l) { return ids.indexOf(l.id) !== -1; });
  }
  function options(r) {
    var q = r.quote, list = chosen(r);
    var sum = withStart(q, list, list.reduce(function (a, l) { return a + l.price; }, 0), list.reduce(function (a, l) { return a + l.hours; }, 0));
    var total = sum.total, hours = sum.hours;
    var box = $('options'); box.textContent = '';
    var once = el('div', 'option best');
    once.appendChild(el('h4', null, 'Fix these once'));
    once.appendChild(el('div', 'big', GBP.format(total)));
    once.appendChild(el('p', null, list.length ? list.length + (list.length === 1 ? ' job, ' : ' jobs, ') + 'about ' + hrs(hours) + (q.start && q.start.price ? ' including set-up' : '') + '. Paid in advance. I re-run the check when they’re done.' : 'Tick the jobs you’d like done.'));
    var b = el('button', null, 'Ask me to do these'); b.type = 'button'; b.disabled = !list.length;
    b.addEventListener('click', function () { ask(list); });
    once.appendChild(b);
    box.appendChild(once);
    $('fix-fine').textContent = (q.holdForReview ? 'I’ll confirm the price within one working day before anything is charged. ' : '') +
      'Prices hold until ' + DATE.format(new Date(q.validUntil + 'T12:00:00Z')) + '. No VAT is added. Most fixes depend on how your site is built, so I’ll confirm access first.';
  }
  function ask(list) {
    var f = document.querySelector('#contact form.enquiry');
    if (f && current) {
      var biz = f.querySelector('[name="business"]'), msg = f.querySelector('[name="message"]');
      if (biz && !biz.value) biz.value = current.domain;
      var q = current.quote || {}, sum = withStart(q, list, list.reduce(function (a, l) { return a + l.price; }, 0), 0);
      if (msg) msg.value = 'I’d like these website fixes done:\n' + list.map(function (l) { return '- ' + l.fixLabel + ' (' + GBP.format(l.price) + ')'; }).join('\n') +
        (q.start && q.start.price ? '\n- ' + START_T + ' (' + GBP.format(q.start.price) + ')\nTotal: ' + GBP.format(sum.total) : '') +
        '\n\nMy report: ' + location.origin + '/website-check/r/' + current.id + '\n\n';
    }
    track('website_check_fix_ask', { jobs: list.length });
    var c = document.getElementById('contact'); if (c) c.scrollIntoView({ behavior: 'smooth' });
  }

  function recheck(r, k) {
    setKind(k);
    track('website_check_switch_kind', { kind: k });
    if (r.sample) { loadSample(k); return; }
    if (!input.value.trim()) input.value = r.url || r.domain;
    window.scrollTo({ top: 0, behavior: 'smooth' });
    if (form.requestSubmit) form.requestSubmit(); else go.click();
  }

  // The pages the site scan read (rules v7): one line up front, the full list behind "See every page".
  function pages(r) {
    var sc = r.scan, sec = $('sec-pages');
    sec.hidden = !(sc && sc.list && sc.list.length > 1);
    if (sec.hidden) return;
    var broken = sc.list.filter(function (p) { return p.status >= 400 || !p.status; }).length;
    var moved = sc.list.filter(function (p) { return p.hops > 0 && p.status && p.status < 400; }).length;
    $('pages-count').textContent = String(sc.pages);
    $('pages-lede').textContent = 'From your menu' + (sc.sitemapPages ? ' and your sitemap' : '') + '. ' +
      (broken ? broken + (broken === 1 ? ' doesn’t load' : ' don’t load') : 'All of them load') + (moved ? ', ' + moved + ' redirect' : '') + '.';
    var tb = $('pages-rows'); tb.textContent = '';
    sc.list.forEach(function (p) {
      var tr = el('tr'), td = el('td'); td.appendChild(el('span', 'pg-path', p.path || '/'));
      if (p.title) td.appendChild(el('span', 'pg-t', cut(p.title, 70)));
      tr.appendChild(td);
      var ok = p.status >= 200 && p.status < 400;
      var ans = !p.status ? 'No answer' : p.status >= 400 ? 'Not working (' + p.status + ')' : p.hops ? 'Redirects' : 'Loads';
      if (ok && p.noindex) ans += ', asks Google not to list it';
      tr.appendChild(el('td', ok ? null : 'pg-no', ans));
      tr.appendChild(el('td', 'r', p.words != null ? String(p.words) : ''));
      tb.appendChild(tr);
    });
  }

  // ---------- v2 step 4 (22 Nov 2026): area scores, top five fixes, the rest by area ----------
  var TOP = 5;
  function areaFor(r, f) { return (r.areaOf && r.areaOf[f.id]) || 'technical'; }
  function areaLabel(r, id) { var a = (r.areas || []).filter(function (x) { return x.id === id; })[0]; return a ? a.label : null; }
  function areas(r) {
    var box = $('rep-areas'); box.textContent = '';
    (r.areas || []).forEach(function (a) {
      var b = el('button', 'tile ar'); b.type = 'button'; b.setAttribute('data-area', a.id);
      b.appendChild(el('small', null, a.label));
      b.appendChild(el('b', null, a.score == null ? 'n/a' : String(a.score)));
      var bar = el('i'); bar.style.setProperty('--v', (a.score || 0) + '%'); bar.setAttribute('aria-hidden', 'true'); b.appendChild(bar);
      b.appendChild(el('span', null, a.fixes ? a.fixes + ' to fix' : a.score == null ? 'Not measured' : 'No fixes found'));
      b.setAttribute('aria-label', a.label + ': ' + (a.score == null ? 'not scored' : a.score + ' out of 100') + ', ' + (a.fixes ? a.fixes + ' to fix' : 'no fixes found'));
      b.addEventListener('click', function () { jumpTo(a.id); track('website_check_area', { area: a.id }); });
      box.appendChild(b);
    });
    box.hidden = !(r.areas && r.areas.length);
  }
  function jumpTo(id) {
    var card = document.querySelector('#rep-weak .find[data-area="' + id + '"]');
    var more = $('area-' + id);
    var target = card || more || $('sec-weak');
    if (!card && more) more.open = true;
    target.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  function fixList(r) {
    var weak = r.weaknesses || [];
    var wk = $('rep-weak'), rest = $('rep-rest'); wk.textContent = ''; rest.textContent = '';
    weak.slice(0, TOP).forEach(function (f) { var c = finding(f, areaLabel(r, areaFor(r, f))); c.setAttribute('data-area', areaFor(r, f)); wk.appendChild(c); });
    var left = weak.slice(TOP);
    if (left.length) {
      rest.appendChild(el('span', 'area-rest-k', 'More fixes, by area'));
      (r.areas || []).forEach(function (a) {
        var mine = left.filter(function (f) { return areaFor(r, f) === a.id; });
        if (!mine.length) return;
        var d = el('details'); d.id = 'area-' + a.id;
        var s = el('summary', null, a.label); s.appendChild(el('span', null, mine.length + ' more')); d.appendChild(s);
        var list = el('div', 'finds'); mine.forEach(function (f) { list.appendChild(finding(f, areaLabel(r, a.id))); }); d.appendChild(list);
        rest.appendChild(d);
      });
    }
    $('weak-count').textContent = String(weak.length);
    $('weak-lede').textContent = weak.length > TOP ? 'Most important first: five here, the rest by area below. Each says where to start.' : 'Most important first. Each one says where to start.';
    $('sec-weak').hidden = !weak.length;
  }

  // Accounts (Accounts Plan step 1): a signed-in visitor's checks are kept automatically; a report opened from a link can
  // be saved; while signed out, the button goes to the account page and comes back here. Hidden while accounts are off.
  var acct = null;
  function saveUi(r) {
    var top = $('rep-save'), keep = $('sec-keep'), ks = $('keep-save');
    var on = !!acct && !r.sample;
    top.hidden = !on; keep.hidden = !on;
    if (!on) return;
    top.disabled = ks.disabled = false;
    top.classList.toggle('done', !!(acct.signedIn && acct.saved));
    function both(label, fn) { top.textContent = ks.textContent = label; top.onclick = ks.onclick = fn; }
    if (!acct.signedIn) {
      $('keep-h').textContent = 'Keep this report';
      $('keep-p').textContent = 'Save it to your free account, then check again after you’ve made changes to see what improved.';
      both('Sign in to save', function () { track('website_check_signin_to_save'); location.href = '/account/?next=' + encodeURIComponent('/website-check/r/' + r.id); });
      return;
    }
    if (acct.saved) {
      $('keep-h').textContent = 'Saved to your account';
      $('keep-p').textContent = 'Check again after you’ve made changes to see what improved.';
      both('See your checks', function () { location.href = '/account/'; });
      return;
    }
    $('keep-h').textContent = 'Keep this report';
    $('keep-p').textContent = 'Save it to your account, then check again after you’ve made changes to see what improved.';
    both('Save to my account', function () {
      top.disabled = ks.disabled = true;
      fetch('/account/save', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify({ id: r.id }) })
        .then(function (x) { return x.json().then(function (d) { if (!x.ok) throw new Error(d.error); }); })
        .then(function () { acct.saved = true; track('website_check_saved'); saveUi(r); }, function (e) { top.disabled = ks.disabled = false; say(e.message || 'That didn’t save. Please try again.', true); });
    });
  }
  $('keep-copy').addEventListener('click', function () { $('rep-copy').click(); this.textContent = 'Link copied'; var b = this; setTimeout(function () { b.textContent = 'Copy the link'; }, 2500); });

  // Signed in or not, shown under the check box (only while accounts are on for this visitor)
  fetch('/account/me', { credentials: 'same-origin' }).then(function (x) { return x.ok ? x.json() : null; }).then(function (d) {
    if (!d) return;
    var bar = $('acct-bar'); bar.textContent = '';
    if (d.account) {
      bar.appendChild(document.createTextNode('Signed in as ')); bar.appendChild(el('b', null, d.account.email)); bar.appendChild(document.createTextNode('. Your checks are saved.'));
      var a = el('a', null, 'Your checks →'); a.href = '/account/'; bar.appendChild(a);
    } else {
      bar.appendChild(document.createTextNode('Keep your checks and see how your scores change.'));
      var s2 = el('a', null, 'Sign in →'); s2.href = '/account/?next=/website-check/'; bar.appendChild(s2);
    }
    bar.hidden = false;
  }).catch(function () {});

  // Before and after (v3 item 1): what changed since this site was last checked as the same kind of business
  function compare(r) {
    var c = r.compare, box = $('rep-compare'); box.textContent = '';
    $('rep-fresh').hidden = !!r.sample;
    box.hidden = !c;
    if (!c) return;
    var head = el('div', 'cmp-h');
    head.appendChild(el('span', 'cmp-k', 'Since the last check on ' + DATE.format(new Date(c.checkedAt))));
    var parts = [];
    parts.push(c.fixed.length ? c.fixed.length + ' fixed' : 'Nothing fixed yet');
    if (c.added.length) parts.push(c.added.length + ' new');
    if (c.still) parts.push(c.still + ' still to do');
    head.appendChild(el('b', null, parts.join(' · ')));
    box.appendChild(head);
    if (c.fixed.length || c.added.length) {
      var d = el('details', 'rp-more-info'); d.appendChild(el('summary', null, 'See what changed'));
      var ul = el('ul', 'cmp-list');
      c.fixed.forEach(function (f) { var li = el('li', 'fixed'); li.appendChild(el('i', null, '✓')); li.appendChild(document.createTextNode(f.title)); ul.appendChild(li); });
      c.added.forEach(function (f) { var li = el('li', 'new'); li.appendChild(el('i', null, '!')); li.appendChild(document.createTextNode(f.title)); ul.appendChild(li); });
      d.appendChild(ul); box.appendChild(d);
    }
    if (!c.sameRules) box.appendChild(el('p', 'cmp-note', 'I’ve added checks since then, so the scores aren’t compared.'));
    // Score changes on the area tiles
    (c.areas || []).forEach(function (a) {
      var diff = a.after - a.before;
      var tileEl = document.querySelector('#rep-areas .ar[data-area="' + a.id + '"] b');
      if (!tileEl || !diff) return;
      var t = el('em', 'ar-d', (diff > 0 ? '+' : '−') + Math.abs(diff));
      t.setAttribute('aria-label', (diff > 0 ? 'up ' : 'down ') + Math.abs(diff) + ' points since the last check');
      t.title = (diff > 0 ? 'Up ' : 'Down ') + Math.abs(diff) + ' points since the last check';
      tileEl.appendChild(t);
    });
  }

  function show(r, scroll) {
    current = r;
    (r.groups || []).forEach(function (g) { GROUP[g[0]] = g[1]; });
    $('rep-domain').textContent = r.domain;
    $('rep-meta').textContent = (r.sample ? 'Demo website, made up · ' : '') + 'Checked ' + DATE.format(new Date(r.checkedAt)) + (r.page && r.page.title ? ' · “' + r.page.title.slice(0, 80) + '”' : '');
    areas(r);
    compare(r);
    saveUi(r);
    profile(r);
    speed(r);
    var strong = r.strengths || [];
    var ok = $('rep-strong'); ok.textContent = '';
    strong.forEach(function (f) { ok.appendChild(el('li', null, f.title)); });
    $('strong-count').textContent = String(strong.length);
    $('strong-lede').textContent = (strong.length === 1 ? 'One check passed.' : strong.length + ' checks passed.') + ' Keep these as they are.';
    $('sec-strong').hidden = !strong.length;
    fixList(r);
    var nt = $('rep-notes'); nt.textContent = '';
    (r.notes || []).forEach(function (f) { var n = el('details', 'wr-note'); n.appendChild(el('summary', null, f.title)); n.appendChild(el('p', null, f.detail)); if (f.start) n.appendChild(el('p', 'why', f.start)); nt.appendChild(n); });
    $('sec-notes').hidden = !(r.notes || []).length;
    pages(r);
    fixes(r);
    $('report').hidden = false;
    animate();
    // Paper and white alternate down the sections that are showing (v3 sec. 5).
    var flip = false;
    document.querySelectorAll('#report > section.rp').forEach(function (sec) {
      if (sec.hidden || sec.classList.contains('rp-ink')) return;
      sec.classList.toggle('rp-white', flip); sec.classList.toggle('rp-paper', !flip); flip = !flip;
    });
    var path = '/website-check/r/' + r.id;
    if (!r.sample && location.pathname !== path) history.replaceState(null, '', path);
    // Straight to "Your website report", just under the fixed header, once the sections have laid out.
    if (scroll) setTimeout(function () {
      var head = document.querySelector('.site-header'), off = (head ? head.getBoundingClientRect().height : 64) + 24;
      var y = $('rep-top').querySelector('.rep-head').getBoundingClientRect().top + window.scrollY - off;
      window.scrollTo({ top: Math.max(0, y), behavior: scroll === 'jump' ? 'auto' : 'smooth' });
    }, 80);
  }

  $('rep-copy').addEventListener('click', function () {
    var link = location.origin + '/website-check/r/' + (current && current.id);
    var b = this;
    (navigator.clipboard ? navigator.clipboard.writeText(link) : Promise.reject()).then(function () { b.textContent = 'Link copied'; }, function () { b.textContent = link; });
    setTimeout(function () { b.textContent = 'Copy the link'; }, 2500);
  });
  // A fresh check of the same site as the same kind of business, so the report can show what changed.
  $('rep-fresh').addEventListener('click', function () {
    if (!current || current.sample) return;
    if (current.model && current.modelFrom === 'chosen') setKind(current.model);
    input.value = current.url || current.domain;
    askFresh = true;
    track('website_check_again');
    window.scrollTo({ top: 0, behavior: 'smooth' });
    if (form.requestSubmit) form.requestSubmit(); else go.click();
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
  $('rep-ask-2').addEventListener('click', function () {
    var f = document.querySelector('#contact form.enquiry');
    if (!f || !current) return;
    var biz = f.querySelector('[name="business"]'), msg = f.querySelector('[name="message"]');
    if (biz && !biz.value) biz.value = current.domain;
    if (msg && !msg.value) msg.value = 'About my Website Check report: ' + location.origin + '/website-check/r/' + current.id + '\n\n';
  });

  // "Check again" from the account dashboard: /website-check/?check=<domain>&kind=<kind> runs a fresh check of that site as
  // the same kind of business, so the report shows what changed (Accounts Plan step 2)
  (function () {
    var q = new URLSearchParams(location.search), site = q.get('check');
    if (!site || !/^[a-z0-9.-]{3,253}$/i.test(site)) return;
    history.replaceState(null, '', '/website-check/');
    input.value = site;
    if (q.get('kind') && KINDS[q.get('kind')]) setKind(q.get('kind'));
    askFresh = true;
    track('website_check_again_dashboard');
    setTimeout(function () { if (form.requestSubmit) form.requestSubmit(); else go.click(); }, 50);
  })();

  // A demo website's report (Lewis's preview only)
  var sm = preview && location.search.match(/[?&]sample=([a-z0-9]+)/);
  function loadSample(k) {
    if (!sm) return;
    say('Loading the demo…');
    fetch('/tools/website-check/sample', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify({ variant: sm[1], model: k || undefined }) })
      .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
      .then(function (res) { if (!res.ok) throw new Error(res.d.error || 'The demo could not be loaded.'); say(''); show(res.d.report, 'jump'); })
      .catch(function (err) { say(err.message, true); });
  }
  loadSample();

  // A saved report (the share link)
  var m = location.pathname.match(/^\/website-check\/r\/([a-f0-9]{32})\/?$/);
  if (m) {
    say('Loading the report…');
    fetch('/tools/website-check/report/' + m[1], { credentials: 'same-origin' }).then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
      .then(function (res) { if (!res.ok) throw new Error(res.d.error || 'That report could not be loaded.'); say(''); acct = res.d.account || null; show(res.d.report, 'jump'); })
      .catch(function (err) { say(err.message, true); });
  }
})();
