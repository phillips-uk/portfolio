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

  // ---------- report (v3, Lewis 18 Nov 2026: the same treatment as the Google Ads report) ----------
  // Top: domain and four tiles. Ink panel "How I read your site": a one-line read of the business, four facts, how the
  // page looks in Google, its first screen on a phone, and a visitor's path (found, first look, trust, get in touch,
  // counted) built from the findings' groups. Then speed gauges, what's working, what to fix and notes.
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
  var secs = function (ms) { return (Math.round(ms / 100) / 10).toFixed(1) + ' s'; };
  var cut = function (s, n) { s = String(s || ''); return s.length > n ? s.slice(0, n - 1).replace(/\s+\S*$/, '') + '…' : s; };
  var all = function (r) { return (r.strengths || []).concat(r.weaknesses || [], r.notes || []); };
  var byId = function (r, id) { return all(r).filter(function (f) { return f.id === id; })[0]; };

  function finding(f) {
    var card = el('article', 'find weak ' + f.priority);
    card.appendChild(el('span', 'mk', '!'));
    var body = el('div', 'fb'); card.appendChild(body);
    var h = el('h4', null, f.title);
    h.appendChild(el('span', 'pr ' + f.priority, f.priority === 'high' ? 'Fix first' : f.priority === 'medium' ? 'Worth fixing' : 'Small'));
    if (GROUP[f.group]) h.appendChild(el('span', 'grp', GROUP[f.group]));
    body.appendChild(h);
    if (f.start) {
      var sb = el('div', 'start-box'); sb.appendChild(el('span', 'sb-k', 'Start here')); sb.appendChild(el('p', null, f.start));
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
      ['First look', 'Fast, fits the phone, says what and where', ['speed', 'mobile', 'first']],
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
    $('sp-lede').textContent = ms == null ? 'Google’s speed test, on a phone and a computer.' : ms >= 90 ? 'Quick on a phone, where most local searches happen.' : 'Most visitors arrive on a phone, and slow pages lose them before they read anything.';
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
    var nums = Array.prototype.slice.call(document.querySelectorAll('#rep-tiles .tile b, #report .g-dial b')).filter(function (b) { return /^\d+$/.test(b.textContent); });
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
    document.querySelectorAll('#rep-tiles > .tile, #pf-summary, #pf-facts > div, #report .wr-view, #wr-journey > .wj, #report .wr-gauge, #wr-field, #rep-strong > li, #rep-weak > .find, #rep-notes > .wr-note, #fix-rows > .fix-row, #options > .option, #report .ask-card').forEach(function (el) {
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

  function show(r, scroll) {
    current = r;
    (r.groups || []).forEach(function (g) { GROUP[g[0]] = g[1]; });
    $('rep-domain').textContent = r.domain;
    $('rep-meta').textContent = (r.sample ? 'Demo website, made up · ' : '') + 'Checked ' + DATE.format(new Date(r.checkedAt)) + (r.page && r.page.title ? ' · “' + r.page.title.slice(0, 80) + '”' : '');
    var tiles = $('rep-tiles'); tiles.textContent = '';
    var m = r.speed && r.speed.mobile, d = r.speed && r.speed.desktop;
    tiles.appendChild(tile('Speed on a phone', m && m.performance != null ? String(m.performance) : 'n/a', 'out of 100', tone(m && m.performance)));
    tiles.appendChild(tile('Speed on a computer', d && d.performance != null ? String(d.performance) : 'n/a', 'out of 100', tone(d && d.performance)));
    tiles.appendChild(tile('To fix', String(r.counts.weaknesses), r.counts.high ? r.counts.high + ' to fix first' : 'none urgent', r.counts.high ? 'bad' : r.counts.weaknesses ? 'warn' : 'good'));
    tiles.appendChild(tile('Working well', String(r.counts.strengths), 'keep these', 'good'));
    profile(r);
    speed(r);
    var ok = $('rep-strong'); ok.textContent = '';
    (r.strengths || []).forEach(function (f) { ok.appendChild(el('li', null, f.title)); });
    $('strong-count').textContent = String((r.strengths || []).length);
    $('sec-strong').hidden = !(r.strengths || []).length;
    var wk = $('rep-weak'); wk.textContent = '';
    (r.weaknesses || []).forEach(function (f) { wk.appendChild(finding(f)); });
    $('weak-count').textContent = String((r.weaknesses || []).length);
    $('sec-weak').hidden = !(r.weaknesses || []).length;
    var nt = $('rep-notes'); nt.textContent = '';
    (r.notes || []).forEach(function (f) { var n = el('details', 'wr-note'); n.appendChild(el('summary', null, f.title)); n.appendChild(el('p', null, f.detail)); if (f.start) n.appendChild(el('p', 'why', f.start)); nt.appendChild(n); });
    $('sec-notes').hidden = !(r.notes || []).length;
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

  // A demo website's report (Lewis's preview only)
  var sm = preview && location.search.match(/[?&]sample=([a-z0-9]+)/);
  if (sm) {
    say('Loading the demo…');
    fetch('/tools/website-check/sample', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify({ variant: sm[1] }) })
      .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
      .then(function (res) { if (!res.ok) throw new Error(res.d.error || 'The demo could not be loaded.'); say(''); show(res.d.report, 'jump'); })
      .catch(function (err) { say(err.message, true); });
  }

  // A saved report (the share link)
  var m = location.pathname.match(/^\/website-check\/r\/([a-f0-9]{32})\/?$/);
  if (m) {
    say('Loading the report…');
    fetch('/tools/website-check/report/' + m[1], { credentials: 'same-origin' }).then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
      .then(function (res) { if (!res.ok) throw new Error(res.d.error || 'That report could not be loaded.'); say(''); show(res.d.report, 'jump'); })
      .catch(function (err) { say(err.message, true); });
  }
})();
