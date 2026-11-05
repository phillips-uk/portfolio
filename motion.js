// Scroll and depth effects for phillips-uk.com (styles in motion.css). Only runs when the head script has set
// .motion-ready on <html>, which it skips for visitors who prefer reduced motion.
(function () {
  var root = document.documentElement;
  if (!root.classList.contains('motion-ready')) return;
  window.__phMotion = true;

  var finePointer = window.matchMedia('(hover: hover) and (pointer: fine)').matches;
  var header = document.querySelector('.site-header');
  var hero = document.querySelector('.hero');
  var shot = document.querySelector('.headshot-wrap');

  // Progress bar
  var bar = document.createElement('div');
  bar.className = 'scroll-progress';
  bar.setAttribute('aria-hidden', 'true');
  document.body.appendChild(bar);

  // Hero glows
  var glows = [];
  if (hero) {
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

  // Headshot tilts toward the pointer
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
      ['--rx', '--ry', '--sx', '--sy'].forEach(function (p) { shot.style.setProperty(p, p.indexOf('r') === 2 ? '0deg' : '0px'); });
    });
  }

  // Tool cards tilt a little under the pointer
  if (finePointer) {
    document.querySelectorAll('.tool-card').forEach(function (card) {
      card.addEventListener('pointermove', function (e) {
        var r = card.getBoundingClientRect();
        var dx = (e.clientX - r.left) / r.width - 0.5;
        var dy = (e.clientY - r.top) / r.height - 0.5;
        card.style.transform = 'perspective(1000px) rotateX(' + (dy * -5).toFixed(2) + 'deg) rotateY(' + (dx * 6).toFixed(2) + 'deg) translateY(-4px)';
      });
      card.addEventListener('pointerleave', function () { card.style.transform = ''; });
    });
  }

  if (!('IntersectionObserver' in window)) return;

  // Rise into place. Only things below the fold are hidden first, so nothing on screen ever blinks.
  var groups = ['.sec-rule', '.sec-heading', '.sec-subhead', '.work-card', '.analysis-card', '.logo-cell',
    '.range-col', '.tool-card', '.guide-card', '.contact-header', '.contact-item'];
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
  }, { rootMargin: '0px 0px -8% 0px', threshold: 0.08 });

  var pending = [];
  var fold = window.innerHeight;
  groups.forEach(function (sel) {
    var seen = new Map();
    document.querySelectorAll(sel).forEach(function (el) {
      if (el.closest('.hero')) return;
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

  // Anything jumped past (a menu link, a fast flick) shows at once instead of waiting to be scrolled back to.
  function catchUp() {
    for (var i = pending.length - 1; i >= 0; i--) {
      var el = pending[i];
      if (el.getBoundingClientRect().bottom < 0) {
        reveal.unobserve(el);
        pending.splice(i, 1);
        el.classList.add('now', 'in');
        el.classList.remove('rv', 'now', 'in');
        el.style.removeProperty('--d');
      }
    }
    if (!pending.length) window.removeEventListener('scroll', onCatchUp);
  }
  var catchTick = false;
  function onCatchUp() { if (!catchTick) { catchTick = true; requestAnimationFrame(function () { catchTick = false; catchUp(); }); } }
  window.addEventListener('scroll', onCatchUp, { passive: true });

  // Numbers count up the first time they are seen. The real figure is in the HTML, so search engines and
  // visitors without JavaScript always get it.
  var counter = new IntersectionObserver(function (entries) {
    entries.forEach(function (en) {
      if (!en.isIntersecting) return;
      counter.unobserve(en.target);
      var el = en.target;
      var m = el.getAttribute('data-final').match(/^(\D*?)(\d+(?:\.\d+)?)(.*)$/);
      var to = parseFloat(m[2]);
      var decimals = (m[2].split('.')[1] || '').length;
      var wait = el.closest('.hero') ? 450 : 120;
      setTimeout(function () {
        var t0 = performance.now(), dur = 1300;
        (function tick(now) {
          var k = Math.min(1, (now - t0) / dur);
          var eased = 1 - Math.pow(1 - k, 3);
          el.textContent = m[1] + (to * eased).toFixed(decimals) + m[3];
          if (k < 1) requestAnimationFrame(tick);
          else el.textContent = el.getAttribute('data-final');
        })(t0);
      }, wait);
    });
  }, { threshold: 0.6 });

  document.querySelectorAll('.stat-n, .kpi-n, .analysis-result').forEach(function (el) {
    var text = el.textContent.trim();
    if (el.children.length || !/^\D*?\d+(?:\.\d+)?\D*$/.test(text)) return;
    el.setAttribute('data-final', text);
    counter.observe(el);
  });
})();
