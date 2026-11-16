// The "Ask me a question" form in each page's contact section. Posts to /enquiry (cloudflare/src/enquiry.js).
// Spam: Cloudflare Turnstile (since 16 Nov 2026), checked again on the server. It loads when the form comes near the
// screen and stays invisible unless Cloudflare wants a tick. The widget's site key is public; its secret is the
// TURNSTILE_SECRET Worker secret. Anywhere but phillips-uk.com (local dev) it uses Cloudflare's always-pass test key.
// On success it pushes generate_lead to the dataLayer (GTM sends it to GA4) and replaces the form with a thank-you.
// Never a name, an address or what someone typed in the event: only form_location.
(function () {
  var started = Date.now();
  var forms = document.querySelectorAll('form.enquiry');
  if (!forms.length) return;

  var SITEKEY = /(^|\.)phillips-uk\.com$/.test(location.hostname) ? '0x4AAAAAAGDEt8LCJ4VVlwit' : '1x00000000000000000000AA';
  var TICK = 'Please tick the box above to show you’re not a bot, then press Send.';

  function done(form, name) {
    var box = document.createElement('div');
    box.className = 'enquiry-done';
    box.setAttribute('role', 'status');
    box.innerHTML = '<p class="enquiry-done-title"></p><p>I&rsquo;ll reply by email. If it&rsquo;s urgent, you can also message me on LinkedIn.</p>';
    box.querySelector('.enquiry-done-title').textContent = name ? 'Thanks, ' + name + '. Your question has reached me.' : 'Thanks. Your question has reached me.';
    form.replaceWith(box);
  }

  // Without JavaScript the form posts itself and comes back with ?sent=1.
  var params = new URLSearchParams(location.search);
  if (params.get('sent') === '1') { forms.forEach(function (f) { done(f, ''); }); return; }

  // Turnstile: one widget per form, rendered into a box just above the Send button.
  var widgets = [];
  var loading = false;
  window.phTurnstile = function () {
    forms.forEach(function (form, i) {
      var box = form.querySelector('.enquiry-ts');
      var status = form.querySelector('.enquiry-status');
      if (!box || !window.turnstile) return;
      widgets[i] = turnstile.render(box, {
        sitekey: SITEKEY,
        action: 'enquiry',
        appearance: 'interaction-only',
        theme: 'light',
        'before-interactive-callback': function () { box.classList.add('shown'); },
        'after-interactive-callback': function () { if (status.textContent === TICK) status.textContent = ''; }
      });
    });
  };
  function loadTurnstile() {
    if (loading) return;
    loading = true;
    var s = document.createElement('script');
    s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit&onload=phTurnstile';
    s.async = true;
    s.defer = true;
    document.head.appendChild(s);
  }
  forms.forEach(function (form) {
    var box = document.createElement('div');
    box.className = 'enquiry-ts';
    form.insertBefore(box, form.querySelector('.enquiry-foot'));
    form.addEventListener('focusin', loadTurnstile);
  });
  if ('IntersectionObserver' in window) {
    var io = new IntersectionObserver(function (entries) {
      if (entries.some(function (e) { return e.isIntersecting; })) { io.disconnect(); loadTurnstile(); }
    }, { rootMargin: '800px 0px' });
    forms.forEach(function (f) { io.observe(f); });
  } else {
    loadTurnstile();
  }

  // Wait up to about 8 seconds for Turnstile's answer (it is usually ready long before the form is filled in).
  function token(i, status) {
    return new Promise(function (resolve) {
      var tries = 0;
      (function poll() {
        var t = window.turnstile && widgets[i] !== undefined ? turnstile.getResponse(widgets[i]) : '';
        if (t || tries++ > 32) return resolve(t || '');
        var box = forms[i].querySelector('.enquiry-ts');
        if (box && box.classList.contains('shown')) status.textContent = TICK;
        setTimeout(poll, 250);
      })();
    });
  }

  forms.forEach(function (form, i) {
    var status = form.querySelector('.enquiry-status');
    var button = form.querySelector('button[type="submit"]');
    if (params.get('error') === '1' && status) status.textContent = 'That didn’t send. Please check the details and try again.';

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var data = {
        name: form.name.value.trim(),
        email: form.email.value.trim(),
        business: form.business.value.trim(),
        message: form.message.value.trim(),
        company_url: form.company_url.value,
        page: location.pathname,
        location: form.getAttribute('data-location') || '',
        elapsed: Date.now() - started
      };
      if (!data.name) { status.textContent = 'Please add your name.'; form.name.focus(); return; }
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(data.email)) { status.textContent = 'Please check your email address.'; form.email.focus(); return; }
      if (data.message.length < 5) { status.textContent = 'Please add your question.'; form.message.focus(); return; }

      loadTurnstile();
      button.disabled = true;
      button.textContent = 'Sending…';
      status.textContent = '';
      token(i, status).then(function (t) {
        data.token = t;
        return fetch('/enquiry', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
      })
        .then(function (res) { return res.json().catch(function () { return { ok: false }; }); })
        .then(function (out) {
          if (!out || !out.ok) throw new Error(out && out.error ? out.error : '');
          window.dataLayer = window.dataLayer || [];
          window.dataLayer.push({ event: 'generate_lead', form_location: data.location || undefined, link_location: undefined });
          done(form, data.name.split(' ')[0]);
        })
        .catch(function (err) {
          button.disabled = false;
          button.textContent = 'Send my question';
          status.textContent = (err && err.message) || 'That didn’t send. Please try again, or message me on LinkedIn.';
          // A Turnstile answer works once, so get a fresh one for the next try.
          if (window.turnstile && widgets[i] !== undefined) turnstile.reset(widgets[i]);
        });
    });
  });
})();
