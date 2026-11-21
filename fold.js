// Phones: feature, point, step, flow and analysis cards show their title only; tap the title to open the text.
// Design Spec v3 section 1a (less text). Without this script, or on wider screens, everything shows.
(function () {
  var SEL = '.features .feature, .why-points .why-point, .engage .card, .steps .step, .flow-node, .grid-2 > .card:not(.work-card)';
  var mq = window.matchMedia('(max-width: 760px)');
  document.documentElement.classList.add('svc-fold');
  function toggle(item, h) {
    var open = !item.classList.contains('open');
    item.classList.toggle('open', open);
    h.setAttribute('aria-expanded', String(open));
  }
  function setup() {
    document.querySelectorAll(SEL).forEach(function (item) {
      var h = item.querySelector('h3');
      if (!h || !item.querySelector('p')) return;
      if (mq.matches) {
        if (item.classList.contains('fold')) return;
        item.classList.add('fold');
        h.setAttribute('role', 'button');
        h.setAttribute('tabindex', '0');
        h.setAttribute('aria-expanded', 'false');
        h._fold = function () { toggle(item, h); };
        h._key = function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(item, h); } };
        h.addEventListener('click', h._fold);
        h.addEventListener('keydown', h._key);
      } else if (item.classList.contains('fold')) {
        item.classList.remove('fold', 'open');
        ['role', 'tabindex', 'aria-expanded'].forEach(function (a) { h.removeAttribute(a); });
        h.removeEventListener('click', h._fold);
        h.removeEventListener('keydown', h._key);
      }
    });
  }
  setup();
  if (mq.addEventListener) mq.addEventListener('change', setup);
})();
