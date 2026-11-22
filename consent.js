// Cookie banner and Cookie settings for phillips-uk.com (22 Nov 2026). A copy of Phillips Group's (phillips-group repo,
// public/consent.js, approved 16 Nov 2026), which is the group standard (The Director's Office, Before You Pay) without
// the advertising part: the GTM container (GTM-WS5CP6NW, version 11) fires Google Analytics only, no ad tags, so the
// only optional use is site usage statistics. If advertising tags are ever added to GTM, take the advertising choice
// from The Director's Office's version first. If the wording changes, raise VERSION.
// Wording: vault 01_Phillips/02_Website/07_Cookie Banner Copy.md (adapted from Phillips Group's to "I").
// The Worker sets window.phConsent and Google Consent Mode defaults before this file loads (cloudflare/src/consent.js).
// - Statistics are on until the visitor turns them off. The banner shows until a choice is made.
// - No thanks: statistics off (GA4 switched off, its _ga cookies removed). Accept all: on. Preferences: choose.
// - A choice updates Google at once and goes to /api/consent, which sets the 180-day ph_consent cookie from the server
//   (a cookie set by page script lasts 7 days at most in Safari). Nothing is recorded.
// - Any element with data-cookie-settings opens Cookie settings (the footer link on every page).
(function () {
  if (window.__phConsentUi) return;
  window.__phConsentUi = true;

  var VERSION = "2026-11-22a";
  var GA_ID = "G-P8648KZWNP";
  var COOKIE = "ph_consent";
  var c = window.phConsent || { stats: true, chosen: false, version: null };
  window.phConsent = c;
  function gtag() { (window.dataLayer = window.dataLayer || []).push(arguments); }

  var T = {
    title: "I value your privacy.",
    text: "I use cookies and similar technologies, along with information about your activity on this website, to run the site and to see how it is used, so I can improve it.",
    no: "No thanks", prefs: "Preferences", yes: "Accept all", policy: "Privacy notice",
    pLabel: "Cookie preferences",
    pTitle: "Choose what I can use.",
    pIntro: "Your choice is saved on this device for six months. You can change it any time from Cookie settings at the bottom of every page.",
    essential: "Essential", essentialText: "Needed for the site to work, such as spam protection on forms, keeping you signed in and remembering this choice.", alwaysOn: "Always on",
    stats: "Site usage statistics", statsText: "Google Analytics counts visits and the pages people use, so I can improve the site. Not used for advertising.",
    save: "Save choices", cancel: "Cancel", how: "How I use cookies",
    tYes: "Thanks. You can change this any time in Cookie settings.",
    tNo: "Statistics are off. You can change this any time in Cookie settings.",
    tSave: "Saved. Your cookie choices are updated.",
  };

  // Design Spec v3 (2026-11-16): every colour is a token from the page's stylesheet (tokens/*.css, copied into each page
  // by scripts/build-tokens.js), so the banner follows the brand. A choice is a centred card resting at level 3 that
  // rises in; the brand button (the group's ink) and the line button rise 1px on hover and press in; the switch is the
  // spec's (46 by 28, brand when on, the knob springs across); Cookie settings scales in over a soft blur at level 4;
  // the toast is an ink pill that springs up. All of it is still for reduced motion.
  var CSS =
    ".ph-cc,.ph-cc *,.ph-cp,.ph-cp *,.ph-ct{box-sizing:border-box;font-family:var(--body);letter-spacing:normal;text-transform:none}" +
    ".ph-cc{position:fixed;left:0;right:0;bottom:0;z-index:1000;display:flex;justify-content:center;padding:0 16px 16px;pointer-events:none}" +
    ".ph-cc-card{pointer-events:auto;width:100%;max-width:640px;color:var(--text);border:1px solid transparent;background:var(--card-fill) padding-box,var(--card-rim) border-box;border-radius:var(--r-md);padding:24px 24px 20px;text-align:center;box-shadow:var(--e3);animation:phCcUp var(--d4) var(--ease-out) both}" +
    ".ph-cc h2,.ph-cp h2{margin:0;font-size:19px;font-weight:800;line-height:1.25;letter-spacing:-.02em;color:var(--text)}" +
    ".ph-cc p,.ph-cp p{margin:0}" +
    ".ph-cc-text{margin:14px auto 0 !important;max-width:34em;font-size:14.5px;line-height:1.55;color:var(--text-2)}" +
    ".ph-cc-btns{display:flex;justify-content:center;gap:10px;margin-top:20px}" +
    ".ph-cc-btn{min-width:150px;min-height:var(--control-h);padding:11px 18px;border-radius:var(--r-pill);border:1px solid transparent;font-size:15px;font-weight:800;line-height:1.2;cursor:pointer;color:var(--brand-ink);background:linear-gradient(180deg,var(--brand-top),var(--brand));box-shadow:inset 0 1px 0 rgba(255,255,255,.22),0 1px 2px rgba(0,0,0,.18),0 8px 18px -10px var(--brand-glow);transition:transform var(--d2) var(--ease-out),box-shadow var(--d2) var(--ease-out),background-color var(--d2),border-color var(--d2),color var(--d2)}" +
    ".ph-cc-btn:hover{transform:translateY(-1px);background:linear-gradient(180deg,var(--brand),var(--brand-hover));box-shadow:inset 0 1px 0 rgba(255,255,255,.18),0 2px 4px rgba(0,0,0,.2),0 14px 26px -12px var(--brand-glow)}" +
    ".ph-cc-btn:active{transform:scale(.97);transition-duration:var(--d1)}" +
    ".ph-cc-btn--line,.ph-cc-btn--line:hover{background:var(--surface);border-color:var(--line-2);color:var(--text);box-shadow:var(--e1)}.ph-cc-btn--line:hover{border-color:var(--text-2);box-shadow:var(--e2)}" +
    ".ph-cc-btn:focus-visible,.ph-cc a:focus-visible,.ph-cp a:focus-visible,.ph-sw:focus-visible{outline:3px solid var(--brand);outline-offset:3px}" +
    ".ph-cc-link{display:inline-block;margin-top:20px;font-size:13.5px;font-weight:500 !important;color:var(--text-2) !important;text-decoration:underline;text-underline-offset:2px}" +
    ".ph-cp{position:fixed;inset:0;z-index:1001;display:flex;align-items:center;justify-content:center;padding:16px;background:var(--scrim);-webkit-backdrop-filter:blur(4px);backdrop-filter:blur(4px);animation:phCpFade var(--d3) var(--ease-out) both}" +
    ".ph-cp-card{width:100%;max-width:520px;max-height:calc(100vh - 32px);overflow:auto;background:var(--bg);color:var(--text);border:1px solid var(--line);border-radius:var(--r-md);padding:28px 24px 22px;text-align:center;box-shadow:var(--e4);animation:phCpIn var(--d4) var(--ease-spring) both}" +
    ".ph-cp-label{font-family:var(--mono) !important;font-size:11.5px;letter-spacing:.12em !important;text-transform:uppercase !important;color:var(--brand);margin-bottom:12px !important}" +
    ".ph-cp-intro{margin-top:12px !important;font-size:14.5px;line-height:1.55;color:var(--text-2)}" +
    ".ph-cp-opt{margin-top:18px;padding-top:18px;border-top:1px solid var(--line)}" +
    ".ph-cp-opt h3{margin:0;font-size:16px;font-weight:700;color:var(--text)}" +
    ".ph-cp-opt p{margin-top:6px !important;font-size:14px;line-height:1.5;color:var(--text-2)}" +
    ".ph-cp-on{display:inline-block;margin-top:10px;font-size:13px;font-weight:700;color:var(--muted)}" +
    ".ph-sw{position:relative;display:inline-block;width:46px;height:28px;margin-top:10px;border-radius:var(--r-pill);border:0;background:var(--line-2);cursor:pointer;box-shadow:inset 0 1px 3px rgba(0,0,0,.18);transition:background-color var(--d3) var(--ease-out);vertical-align:middle}" +
    ".ph-sw::after{content:'';position:absolute;top:3px;left:3px;width:22px;height:22px;border-radius:50%;background:var(--surface);box-shadow:0 1px 2px rgba(0,0,0,.2),0 3px 8px -2px rgba(0,0,0,.25);transition:transform var(--d3) var(--ease-spring),width var(--d2) var(--ease-out)}" +
    ".ph-sw:active::after{width:28px}" +
    ".ph-sw[aria-checked=true]{background:var(--brand)}.ph-sw[aria-checked=true]::after{transform:translateX(18px);background:var(--brand-ink)}.ph-sw[aria-checked=true]:active::after{transform:translateX(12px)}" +
    ".ph-cp-btns{display:flex;justify-content:center;gap:10px;margin-top:24px}" +
    ".ph-cp .ph-cc-link{margin-top:18px}" +
    ".ph-ct{position:fixed;left:50%;bottom:20px;z-index:1002;transform:translate(-50%,24px) scale(.96);width:max-content;max-width:calc(100vw - 32px);padding:12px 18px;border:1px solid var(--ink-line);border-radius:var(--r-pill);background:linear-gradient(180deg,var(--ink-2),var(--ink));color:#fff;font-size:14px;font-weight:700;line-height:1.4;text-align:center;opacity:0;box-shadow:inset 0 1px 0 rgba(255,255,255,.12),var(--e3);transition:transform var(--d3) var(--ease-spring),opacity var(--d2);pointer-events:none}" +
    ".ph-ct.is-on{opacity:1;transform:translate(-50%,0)}" +
    "@keyframes phCcUp{from{opacity:0;transform:translateY(14px)}}" +
    "@keyframes phCpFade{from{opacity:0}}" +
    "@keyframes phCpIn{from{opacity:0;transform:translateY(14px) scale(.96)}}" +
    "@media (max-width:560px){.ph-cc{padding:0 10px 10px}.ph-cc-card{padding:18px 14px 14px;border-radius:18px}.ph-cc h2{font-size:17px}.ph-cc-text{margin-top:10px !important;font-size:13.5px}.ph-cc-btns{gap:8px;margin-top:16px}.ph-cc-btn{min-width:0;flex:1 1 0;padding:11px 8px;font-size:14px}.ph-cc-link{margin-top:14px;font-size:13px}.ph-cp-card{padding:24px 18px 18px}.ph-cp-btns .ph-cc-btn{flex:1 1 0}.ph-ct{border-radius:var(--r-sm)}}" +
    "@media (max-width:359px){.ph-cc-btns{flex-direction:column}}" +
    "@media (prefers-reduced-motion:reduce){.ph-ct,.ph-sw,.ph-sw::after,.ph-cc-btn{transition:none}.ph-cc-card,.ph-cp,.ph-cp-card{animation:none}}" +
    // ?motion=off stills it too, as on the rest of the site (spec 1e, for screenshots)
    (/[?&]motion=off\b/.test(location.search) ? ".ph-cc-card,.ph-cp,.ph-cp-card{animation:none}.ph-ct,.ph-sw,.ph-sw::after,.ph-cc-btn{transition:none}" : "");

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function button(cls, text, onClick) {
    var b = el("button", cls, text);
    b.type = "button";
    b.addEventListener("click", onClick);
    return b;
  }
  function link(cls, text, href) { var a = el("a", cls, text); a.href = href; return a; }

  var styled = false;
  function style() {
    if (styled) return;
    styled = true;
    var s = document.createElement("style");
    s.textContent = CSS;
    document.head.appendChild(s);
  }

  function dropCookies(test) {
    var host = location.hostname, domains = ["", host, "." + host];
    var parts = host.split(".");
    if (parts.length > 2) domains.push("." + parts.slice(-2).join("."));
    document.cookie.split("; ").forEach(function (kv) {
      var name = kv.split("=")[0];
      if (!test(name)) return;
      domains.forEach(function (d) {
        document.cookie = name + "=; Max-Age=0; Path=/" + (d ? "; Domain=" + d : "");
      });
    });
  }

  var toastTimer;
  function toast(text) {
    style();
    var t = document.querySelector(".ph-ct") || document.body.appendChild(el("div", "ph-ct"));
    t.setAttribute("role", "status");
    t.textContent = text;
    requestAnimationFrame(function () { t.classList.add("is-on"); });
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.remove("is-on"); }, 4200);
  }

  function apply(stats) {
    var was = c.stats;
    c.stats = stats; c.chosen = true; c.version = VERSION;
    var secure = location.protocol === "https:" ? "; Secure" : "";
    document.cookie = COOKIE + "=" + (stats ? 1 : 0) + "." + VERSION + "; Max-Age=15552000; Path=/; SameSite=Lax" + secure;
    window["ga-disable-" + GA_ID] = !stats;
    gtag("consent", "update", { analytics_storage: stats ? "granted" : "denied" });
    if (!stats && was) dropCookies(function (n) { return n === "_ga" || n.indexOf("_ga_") === 0; });
    try {
      fetch("/api/consent", {
        method: "POST", credentials: "same-origin", keepalive: true,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ statistics: stats, wording: VERSION }),
      });
    } catch (e) { /* the cookie set above still holds the choice */ }
  }

  // Banner
  var banner;
  function closeBanner() { if (banner) { banner.remove(); banner = null; } }
  function showBanner() {
    style();
    banner = el("div", "ph-cc");
    banner.setAttribute("role", "region");
    banner.setAttribute("aria-label", T.pLabel);
    var card = el("div", "ph-cc-card");
    card.appendChild(el("h2", "", T.title));
    card.appendChild(el("p", "ph-cc-text", T.text));
    var btns = el("div", "ph-cc-btns");
    btns.appendChild(button("ph-cc-btn", T.no, function () { apply(false); closeBanner(); toast(T.tNo); }));
    btns.appendChild(button("ph-cc-btn ph-cc-btn--line", T.prefs, function () { openPrefs(); }));
    btns.appendChild(button("ph-cc-btn", T.yes, function () { apply(true); closeBanner(); toast(T.tYes); }));
    card.appendChild(btns);
    card.appendChild(link("ph-cc-link", T.policy, "/privacy/#cookies"));
    banner.appendChild(card);
    document.body.appendChild(banner);
  }

  // Preferences
  var prefs, lastFocus;
  function sw(label, on) {
    var b = el("button", "ph-sw");
    b.type = "button";
    b.setAttribute("role", "switch");
    b.setAttribute("aria-label", label);
    b.setAttribute("aria-checked", on ? "true" : "false");
    b.addEventListener("click", function () { b.setAttribute("aria-checked", b.getAttribute("aria-checked") === "true" ? "false" : "true"); });
    return b;
  }
  function closePrefs() {
    if (!prefs) return;
    prefs.remove(); prefs = null;
    document.removeEventListener("keydown", onKey);
    if (lastFocus && lastFocus.focus) lastFocus.focus();
  }
  function onKey(e) {
    if (e.key === "Escape") { closePrefs(); return; }
    if (e.key !== "Tab" || !prefs) return;
    var f = prefs.querySelectorAll("button:not([disabled]), a[href]");
    if (!f.length) return;
    if (e.shiftKey && document.activeElement === f[0]) { e.preventDefault(); f[f.length - 1].focus(); }
    else if (!e.shiftKey && document.activeElement === f[f.length - 1]) { e.preventDefault(); f[0].focus(); }
  }
  function openPrefs() {
    style();
    closePrefs();
    lastFocus = document.activeElement;
    prefs = el("div", "ph-cp");
    var card = el("div", "ph-cp-card");
    card.setAttribute("role", "dialog");
    card.setAttribute("aria-modal", "true");
    card.setAttribute("aria-labelledby", "ph-cp-h");
    card.appendChild(el("p", "ph-cp-label", T.pLabel));
    var h = el("h2", "", T.pTitle);
    h.id = "ph-cp-h";
    h.tabIndex = -1;
    card.appendChild(h);
    card.appendChild(el("p", "ph-cp-intro", T.pIntro));

    var o1 = el("div", "ph-cp-opt");
    o1.appendChild(el("h3", "", T.essential));
    o1.appendChild(el("p", "", T.essentialText));
    o1.appendChild(el("span", "ph-cp-on", T.alwaysOn));
    card.appendChild(o1);

    var o2 = el("div", "ph-cp-opt");
    o2.appendChild(el("h3", "", T.stats));
    o2.appendChild(el("p", "", T.statsText));
    var s1 = sw(T.stats, c.stats);
    o2.appendChild(s1);
    card.appendChild(o2);

    var btns = el("div", "ph-cp-btns");
    btns.appendChild(button("ph-cc-btn", T.save, function () {
      apply(s1.getAttribute("aria-checked") === "true");
      closePrefs(); closeBanner(); toast(T.tSave);
    }));
    btns.appendChild(button("ph-cc-btn ph-cc-btn--line", T.cancel, closePrefs));
    card.appendChild(btns);
    card.appendChild(link("ph-cc-link", T.how, "/privacy/#cookies"));

    prefs.appendChild(card);
    prefs.addEventListener("click", function (e) { if (e.target === prefs) closePrefs(); });
    document.body.appendChild(prefs);
    document.addEventListener("keydown", onKey);
    h.focus();
  }

  function start() {
    document.addEventListener("click", function (e) {
      var t = e.target && e.target.closest && e.target.closest("[data-cookie-settings]");
      if (!t) return;
      e.preventDefault();
      openPrefs();
    });
    if (!c.chosen) showBanner();
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
})();
