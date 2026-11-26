// v5.js: the "plain and proven" pages (body.v5; Obsidian note 146). Three jobs, nothing else:
// 1. A soft fade as blocks marked data-v5 come into view (off for reduced motion; without JS everything just shows).
// 2. The phone action bar (.vbar): shows once the element marked data-vbar-after has scrolled away; hides over a closing strip or the footer.
// 3. "Show all" buttons (data-v5-more="#list", or empty for the button's own parent): take .cap off the list, then go.
(function () {
  var b = document.body;
  b.classList.add('js');
  var io = 'IntersectionObserver' in window;
  var calm = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var els = [].slice.call(document.querySelectorAll('[data-v5]'));
  if (!io || calm) {
    els.forEach(function (e) { e.classList.add('in'); });
  } else {
    var o = new IntersectionObserver(function (es) {
      es.forEach(function (e) { if (e.isIntersecting) { e.target.classList.add('in'); o.unobserve(e.target); } });
    }, { rootMargin: '0px 0px -8% 0px' });
    els.forEach(function (e) { o.observe(e); });
  }

  [].forEach.call(document.querySelectorAll('[data-v5-more]'), function (btn) {
    btn.addEventListener('click', function () {
      var sel = btn.getAttribute('data-v5-more'), t = sel ? document.querySelector(sel) : btn.parentElement;
      if (t) t.classList.remove('cap');
      var next = t && t.querySelector(sel ? 'li:nth-child(' + (window.innerWidth < 761 ? 11 : 21) + ') a' : 'a:nth-child(12)');
      btn.parentNode.removeChild(btn);
      if (next) next.focus();
    });
  });

  var bar = document.querySelector('.vbar'), after = document.querySelector('[data-vbar-after]');
  if (!bar || !after || !io) return;
  var past = false, atFoot = false;
  var set = function () { bar.classList.toggle('on', past && !atFoot); bar.setAttribute('aria-hidden', past && !atFoot ? 'false' : 'true'); };
  new IntersectionObserver(function (es) { var e = es[0]; past = !e.isIntersecting && e.boundingClientRect.top < 0; set(); }).observe(after);
  // Hidden while a closing strip (.vt, which repeats the button) or the footer is on screen, so two copies of the same
  // button never stack and the bar never covers the end of the page (Lewis, 24 Nov 2026).
  var stops = [].slice.call(document.querySelectorAll('.vt, #site-footer')), seen = new Set();
  if (stops.length) {
    var so = new IntersectionObserver(function (es) { es.forEach(function (e) { if (e.isIntersecting) seen.add(e.target); else seen.delete(e.target); }); atFoot = seen.size > 0; set(); });
    stops.forEach(function (el) { so.observe(el); });
  }
  set();
})();
