// Website showcases on /work/ and /about/ (styles in agency.css). Each showcase holds a few real pages of a client's
// site in a MacBook Pro and an iPhone. While it is on screen it moves to the next page every few seconds, and each
// page scrolls gently. The page buttons switch pages by hand. Hovering pauses it; reduced motion keeps it still.
(function () {
  var reduce = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
  document.querySelectorAll('[data-showcase]').forEach(function (fig) {
    var tabs = fig.querySelectorAll('[data-tab]');
    var views = fig.querySelectorAll('.shot-view');
    var n = tabs.length, i = 0, visible = false, started = false, hold = 0;
    if (!n) return;
    function sizes() { views.forEach(function (v) { v.style.setProperty('--view-h', v.clientHeight + 'px'); }); }
    function show(k) {
      i = (k + n) % n;
      views.forEach(function (v) {
        v.querySelectorAll('.pg').forEach(function (p, j) {
          var on = j === i;
          p.classList.toggle('is-on', on);
          p.classList.remove('run');
          if (on && !reduce && started) { void p.offsetWidth; p.classList.add('run'); }
        });
      });
      tabs.forEach(function (t, j) { t.setAttribute('aria-selected', j === i ? 'true' : 'false'); });
    }
    tabs.forEach(function (t, j) { t.addEventListener('click', function () { hold = Date.now() + 14000; started = true; show(j); }); });
    sizes();
    window.addEventListener('resize', sizes, { passive: true });
    fig.querySelectorAll('img').forEach(function (img) { img.addEventListener('load', sizes); });
    show(0);
    if (reduce || !('IntersectionObserver' in window)) return;
    new IntersectionObserver(function (es) {
      visible = es[0].isIntersecting;
      if (visible && !started) { started = true; show(i); }
    }, { threshold: 0.35 }).observe(fig);
    setInterval(function () {
      if (!visible || Date.now() < hold || fig.matches(':hover')) return;
      show(i + 1);
    }, 7600);
  });
})();
