// Scroll and depth effects for phillips-uk.com (styles in motion.css). Only runs when the head script has set
// .motion-ready on <html>, which it skips for visitors who prefer reduced motion. Works on any page: the hero is
// the element marked data-hero (or .hero on the homepage), and each page's own cards are listed below.
(function () {
  var root = document.documentElement;
  if (!root.classList.contains('motion-ready')) return;
  window.__phMotion = true;

  var finePointer = window.matchMedia('(hover: hover) and (pointer: fine)').matches;
  var header = document.querySelector('header');
  var hero = document.querySelector('[data-hero], .hero');
  var shot = document.querySelector('.headshot-wrap');

  // Progress bar
  var bar = document.createElement('div');
  bar.className = 'scroll-progress';
  bar.setAttribute('aria-hidden', 'true');
  document.body.appendChild(bar);

  // Hero glows
  var glows = [];
  if (hero) {
    hero.classList.add('ph-hero');
    ['g1', 'g2'].forEach(function (name) {
      var g = document.createElement('div');
      g.className = 'hero-glow ' + name;
      g.setAttribute('aria-hidden', 'true');
      hero.insertBefore(g, hero.firstChild);
      glows.push(g);
    });
  }

  // Scroll-driven parts, one frame at a time
  var ticking = false;
  function update() {
    ticking = false;
    var y = window.scrollY || 0;
    var max = document.documentElement.scrollHeight - window.innerHeight;
    bar.style.setProperty('--sp', max > 0 ? Math.min(1, y / max).toFixed(4) : '0');
    if (header) header.classList.toggle('is-scrolled', y > 8);
    if (y < window.innerHeight * 1.3) {
      if (glows[0]) glows[0].style.transform = 'translate3d(0,' + (y * 0.28).toFixed(1) + 'px,0)';
      if (glows[1]) glows[1].style.transform = 'translate3d(0,' + (y * -0.14).toFixed(1) + 'px,0)';
      if (shot) shot.style.setProperty('--py', (y * -0.07).toFixed(1) + 'px');
    }
  }
  function onScroll() { if (!ticking) { ticking = true; requestAnimationFrame(update); } }
  window.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', onScroll, { passive: true });
  update();

  // Homepage headshot tilts toward the pointer
  if (finePointer && hero && shot) {
    hero.addEventListener('pointermove', function (e) {
      var r = shot.getBoundingClientRect();
      var dx = Math.max(-1, Math.min(1, (e.clientX - (r.left + r.width / 2)) / (r.width * 1.5)));
      var dy = Math.max(-1, Math.min(1, (e.clientY - (r.top + r.height / 2)) / (r.height * 1.5)));
      shot.style.setProperty('--ry', (dx * 7).toFixed(2) + 'deg');
      shot.style.setProperty('--rx', (dy * -7).toFixed(2) + 'deg');
      shot.style.setProperty('--sx', (dx * -12).toFixed(1) + 'px');
      shot.style.setProperty('--sy', (dy * -12).toFixed(1) + 'px');
    });
    hero.addEventListener('pointerleave', function () {
      shot.style.setProperty('--rx', '0deg'); shot.style.setProperty('--ry', '0deg');
      shot.style.setProperty('--sx', '0px'); shot.style.setProperty('--sy', '0px');
    });
  }

  // Tool and package cards tilt a little under the pointer
  if (finePointer) {
    document.querySelectorAll('.tool-card, .pack').forEach(function (card) {
      card.addEventListener('pointermove', function (e) {
        var r = card.getBoundingClientRect();
        var dx = (e.clientX - r.left) / r.width - 0.5;
        var dy = (e.clientY - r.top) / r.height - 0.5;
        card.style.transform = 'perspective(1000px) rotateX(' + (dy * -4).toFixed(2) + 'deg) rotateY(' + (dx * 5).toFixed(2) + 'deg) translateY(-4px)';
      });
      card.addEventListener('pointerleave', function () { card.style.transform = ''; });
    });
  }

  if (!('IntersectionObserver' in window)) return;

  // Rise into place. Only things below the fold are hidden first, so nothing on screen ever blinks.
  // Specific cards come first; the general section rules only pick up blocks that hold none of them.
  var specific = [
    '.sec-rule', '.sec-heading', '.sec-subhead', '.work-card', '.analysis-card', '.logo-cell', '.range-col',
    '.tool-card', '.guide-card', '.contact-header', '.contact-item',
    '.check-card', '.list-card', '.cs-list-card', '.cross-card', '.ca-step', '.faq-item', '.me-row', '.url-trust-item',
    '.article-body', '.issue-block', '.priority-item', '.consent-step', '.trigger-step', '.arch-cell', '.symptoms-table', '.related-card',
    '.pack', '.band .card', '.step'
  ];
  var general = [
    '.sec-cream > .page-w > *', '.sec-white > .page-w > *', '.read-w > *', '.related-section .page-w > *',
    '.end-cta > *', 'section > .page-w > *'
  ];
  var pending = [];
  var reveal = new IntersectionObserver(function (entries) {
    entries.forEach(function (en) {
      if (!en.isIntersecting) return;
      var el = en.target;
      reveal.unobserve(el);
      pending.splice(pending.indexOf(el), 1);
      el.classList.add('in');
      var done = function (ev) {
        if (ev.target !== el || ev.propertyName !== 'transform') return;
        el.removeEventListener('transitionend', done);
        el.classList.remove('rv', 'in');
        el.style.removeProperty('--d');
      };
      el.addEventListener('transitionend', done);
    });
  }, { rootMargin: '0px 0px -8% 0px', threshold: 0.06 });

  var fold = window.innerHeight;
  function mark(selectors, strict) {
    selectors.forEach(function (sel) {
      var seen = new Map();
      document.querySelectorAll(sel).forEach(function (el) {
        if (el.classList.contains('rv') || el.closest('.rv') || (hero && hero.contains(el)) || (header && header.contains(el))) return;
        if (strict && el.querySelector('.rv')) return;
        if (el.getBoundingClientRect().top < fold) return;
        var parent = el.parentNode;
        var i = seen.get(parent) || 0;
        seen.set(parent, i + 1);
        el.style.setProperty('--d', ((i % 4) * 0.08).toFixed(2) + 's');
        el.classList.add('rv');
        pending.push(el);
        reveal.observe(el);
      });
    });
  }
  mark(specific, false);
  mark(general, true);

  // Anything jumped past (a menu link, a fast flick) shows at once instead of waiting to be scrolled back to.
  var catchTick = false;
  function catchUp() {
    catchTick = false;
    for (var i = pending.length - 1; i >= 0; i--) {
      var el = pending[i];
      if (el.getBoundingClientRect().bottom < 0) {
        reveal.unobserve(el);
        pending.splice(i, 1);
        el.classList.remove('rv', 'in');
        el.style.removeProperty('--d');
      }
    }
    if (!pending.length) window.removeEventListener('scroll', onCatchUp);
  }
  function onCatchUp() { if (!catchTick) { catchTick = true; requestAnimationFrame(catchUp); } }
  window.addEventListener('scroll', onCatchUp, { passive: true });

  // Numbers count up the first time they are seen. The real figure is in the HTML, so search engines and
  // visitors without JavaScript always get it.
  var NUM = /^(\D*?)(\d[\d,]*(?:\.\d+)?)(\D*)$/;
  var counter = new IntersectionObserver(function (entries) {
    entries.forEach(function (en) {
      if (!en.isIntersecting) return;
      counter.unobserve(en.target);
      var el = en.target;
      var final = el.getAttribute('data-final');
      var m = final.match(NUM);
      var commas = m[2].indexOf(',') !== -1;
      var to = parseFloat(m[2].replace(/,/g, ''));
      var decimals = (m[2].split('.')[1] || '').length;
      var wait = hero && hero.contains(el) ? 450 : 120;
      setTimeout(function () {
        var t0 = performance.now(), dur = 1300;
        (function tick(now) {
          var k = Math.min(1, (now - t0) / dur);
          var v = to * (1 - Math.pow(1 - k, 3));
          var shown = commas ? Math.round(v).toLocaleString('en-GB') : v.toFixed(decimals);
          el.textContent = m[1] + shown + m[3];
          if (k < 1) requestAnimationFrame(tick); else el.textContent = final;
        })(t0);
      }, wait);
    });
  }, { threshold: 0.6 });

  document.querySelectorAll('.stat-n, .kpi-n, .analysis-result, .price b, .compare b').forEach(function (el) {
    var text = el.textContent.trim();
    if (el.children.length || !NUM.test(text)) return;
    el.setAttribute('data-final', text);
    counter.observe(el);
  });
})();
