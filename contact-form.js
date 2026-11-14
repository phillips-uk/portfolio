// The "Ask me a question" form in each page's contact section. Posts to /enquiry (cloudflare/src/enquiry.js).
// On success it pushes generate_lead to the dataLayer (GTM sends it to GA4) and replaces the form with a thank-you.
(function () {
  var started = Date.now();
  var forms = document.querySelectorAll('form.enquiry');
  if (!forms.length) return;

  function done(form, name) {
    var box = document.createElement('div');
    box.className = 'enquiry-done';
    box.setAttribute('role', 'status');
    box.innerHTML = '<p class="enquiry-done-title"></p><p>I&rsquo;ll reply by email. If it&rsquo;s urgent, you can also message me on LinkedIn.</p>';
    box.querySelector('.enquiry-done-title').textContent = name ? 'Thanks, ' + name + '. Your question has reached me.' : 'Thanks. Your question has reached me.';
    form.replaceWith(box);
  }

  // Without JavaScript the form posts itself and comes back with ?sent=1 or ?error=1.
  var params = new URLSearchParams(location.search);
  if (params.get('sent') === '1') forms.forEach(function (f) { done(f, ''); });

  forms.forEach(function (form) {
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

      button.disabled = true;
      button.textContent = 'Sending…';
      status.textContent = '';
      fetch('/enquiry', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) })
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
        });
    });
  });
})();
