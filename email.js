// The one email address left on phillips-uk.com: the footer legal line on every page and the /privacy notice
// (option A, Lewis, 16 Nov 2026). It is written in here, so it is never in the HTML a crawler reads; everywhere else the
// route is the "Ask me a question" form. A page marks the spot with <a data-email>contact at phillips-uk dot com</a>
// (that text is what shows without JavaScript) and loads this file. Pages drawn later by React are filled in as they appear.
(function () {
  var addr = ['contact', 'phillips-uk.com'].join('@');
  function fill() {
    var spots = document.querySelectorAll('a[data-email]');
    for (var i = 0; i < spots.length; i++) {
      spots[i].href = 'mailto:' + addr;
      spots[i].textContent = addr;
      spots[i].removeAttribute('data-email');
    }
  }
  fill();
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fill);
  if (window.MutationObserver && document.querySelector('script[type="text/babel"]')) {
    new MutationObserver(function () { if (document.querySelector('a[data-email]')) fill(); })
      .observe(document.documentElement, { childList: true, subtree: true });
  }
})();
