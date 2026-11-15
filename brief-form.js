// The Monday Brief sign-up form (/updates/, issue pages, guides). Posts to /subscribe (cloudflare/src/brief.js),
// which emails a confirmation link: nobody is on the list until they click it (double opt-in).
// On success it pushes newsletter_signup to the dataLayer (GTM sends it to GA4) and shows "check your inbox".
(function () {
  var started = Date.now();
  var forms = document.querySelectorAll('form.brief-signup');
  if (!forms.length) return;

  function done(form) {
    var box = document.createElement('div');
    box.className = 'brief-done';
    box.setAttribute('role', 'status');
    box.innerHTML = '<b>Check your inbox.</b><span>I’ve sent you an email with a link to confirm. Nothing arrives until you click it. If it isn’t there in a few minutes, look in spam or promotions.</span>';
    form.replaceWith(box);
  }

  // Without JavaScript the form posts itself and comes back with ?brief=check or ?brief=error.
  var params = new URLSearchParams(location.search);
  if (params.get('brief') === 'check') { done(forms[0]); }

  forms.forEach(function (form) {
    var status = form.querySelector('.brief-status');
    var button = form.querySelector('button[type="submit"]');
    var label = button ? button.textContent : 'Get the Brief';
    if (params.get('brief') === 'error' && status) status.textContent = 'That didn’t go through. Please check your email address and try again.';

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var email = form.email.value.trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) { status.textContent = 'Please check your email address.'; form.email.focus(); return; }
      var data = { email: email, company_url: form.company_url.value, page: location.pathname, location: form.getAttribute('data-location') || '', elapsed: Date.now() - started };
      button.disabled = true;
      button.textContent = 'Sending…';
      status.textContent = '';
      fetch('/subscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) })
        .then(function (res) { return res.json().catch(function () { return { ok: false }; }); })
        .then(function (out) {
          if (!out || !out.ok) throw new Error(out && out.error ? out.error : '');
          window.dataLayer = window.dataLayer || [];
          window.dataLayer.push({ event: 'newsletter_signup', form_location: data.location || undefined });
          done(form);
        })
        .catch(function (err) {
          button.disabled = false;
          button.textContent = label;
          status.textContent = (err && err.message) || 'That didn’t go through. Please try again in a minute.';
        });
    });
  });
})();
