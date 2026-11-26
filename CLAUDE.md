# phillips-uk.com — project rules

Lewis Phillips's portfolio and tools site. Full history, standards and design workflow live in Obsidian: `01_Phillips/03_Portfolio/phillips-uk.com — Web Build.md` (read it before larger changes) and `01_Phillips/Phillips. Design System.md`.

## Scope

This repo is the main Phillips. business: phillips-uk.com, the admin (`/admin`: clients, the prospects sales funnel, invite links) and the private pages (rate card, Search Desk demo, prospect prototypes). Its notes are in the vault under `01_Phillips/`. Search Desk itself, Before You Pay, The Director's Office, Index Point (`CODE/indexpoint`) and Phillips Group are separate repos with their own sessions: don't edit them from here. The `/desk` route only forwards to the Search Desk Worker. Rules for every project: `~/.claude/CLAUDE.md`.

**Before any setup task** (accounts, Search Console, Bing, GA4, listings, automations), read vault `01_Phillips/00_Phillips. Setup Map.md`: it records what is already done and under which sign-in. Update it when anything changes.

Lewis reviews changes on the live site, so after a change: commit, push `main`, then deploy (below).

## Cost rule (hard limit)

Stay inside free tiers. Never enable a paid service, change a plan, buy anything, or run something billed per use (a real audit calls Claude, OpenAI or PageSpeed Insights) without telling Lewis the possible cost and getting a yes first. Dry-run flags are not proof of zero cost.

## Hosting and deploy

**The site runs on a Cloudflare Worker (`phillips-uk`, account `9cd423eee8986ecc6f22f6fa3a17878b`, same as Before You Pay) since 2026-10-20. Netlify is suspended, so never run `netlify deploy`.**

Pushing to GitHub does **not** deploy. After pushing `main`, deploy from the repo root:

```bash
CLOUDFLARE_ACCOUNT_ID=9cd423eee8986ecc6f22f6fa3a17878b npx wrangler deploy
```

Then check `https://www.phillips-uk.com/` returns 200 and `/audit` 301s to `/google-ads-audit` (the free tools are public again since 16 Nov 2026).

- `wrangler.jsonc`: Worker config. `run_worker_first: true`, R2 binding `BLOBS` (bucket `phillips-blobs`), queue `phillips-jobs`, custom domains `www.phillips-uk.com` and `phillips-uk.com`.
- `cloudflare/src/worker.js`: router. Apex to www and http to https redirects, `/audit` redirects, `/auth/callback`, `/r/:id`, `/.netlify/functions/<name>`, then static assets.
- `cloudflare/src/netlify-adapter.js`: runs `netlify/functions/*.js` unchanged (copied from Before You Pay).
- `cloudflare/src/shims/netlify-blobs.cjs`: `@netlify/blobs` replaced by R2 (store name becomes a key prefix).
- **Background functions** (`*-background`) are queued and return 202. The consumer never retries, so a paid API call is never repeated.
- **New function:** add the file to `netlify/functions/` and add it to the `loaders` map in `worker.js`, or it returns 404.
- **New public file:** fine as is. **New non-public file at the repo root:** add it to `.assetsignore`, or it is served to the world.
- `_redirects` must contain only relative URLs; Cloudflare rejects the deploy otherwise. `netlify.toml` is no longer used for serving.
- Secrets live on the Worker (`npx wrangler secret list` / `secret put NAME`). Never print or commit them, never copy them into Obsidian.
- Local test: `npx wrangler dev --port 8787 --local --local-upstream localhost:8787 --persist-to <folder outside the repo>` with test-only values in `.dev.vars` (git-ignored). Without `--persist-to` the dev server reloads in a loop; without `--local-upstream` every request 301s to `https://www.phillips-uk.com`. The `phillips-uk-dev` preview in `.claude/launch.json` (local, not committed) runs exactly this. The admin needs `ADMIN_SESSION_KEY` in `.dev.vars`; sign-in is Google, so test the admin API with a locally minted test cookie and delete `.dev.vars` afterwards.
- DNS is on Cloudflare (Free plan). Email is Google Workspace plus Resend, so never delete MX or TXT records. DNS changes are made by Lewis in the dashboard.

## Analytics (GA4 `G-P8648KZWNP`, GTM `GTM-WS5CP6NW`)

- **Every public page is tagged automatically:** the Worker adds the GTM container to any HTML page it serves that lacks it (`withGtm` in `cloudflare/src/worker.js`). A new page needs nothing; never paste a second container into a page.
- **Cookie banner** (since 22 Nov 2026, group standard without advertising, because GTM fires GA4 only; version 12 since 22 Nov 2026): the Worker puts the Consent Mode defaults first in every tagged page's `<head>` and `/consent.js` at the end (`cloudflare/src/consent.js`); a choice posts to `/api/consent`, which sets the 180-day `ph_consent` cookie. Statistics on until turned off, advertising always denied. Footer bottom line: Privacy, Terms, Cookie settings (`data-cookie-settings`). If ad tags are ever added to GTM, take the advertising choice from The Director's Office's `consent.js` first. Wording: vault `01_Phillips/02_Website/07_Cookie Banner Copy.md`; raise `VERSION` when it changes.
- **Invite pages** (`rate-card.js`) load gtag.js directly with only the path as `page_location`, so invite tokens never reach Google, and send `proposal_view`. `/admin` and Search Desk (`/desk`) are not tagged.
- **A new event:** push it from the page (`dataLayer.push({ event: 'name', ... })`), then Lewis or a browser session adds the name to the GTM trigger "Site events to GA4" and publishes. Key events and funnels: vault `01_Phillips/07_Analytics/03_Key Events & Conversions.md`. GTM and GA4 sign-in is lewisdp87@gmail.com.
- **No email addresses on pages** (Lewis, 16 Nov 2026). Every contact route is the "Ask me a question" form: `#contact` on pages that have it, `/#contact` elsewhere, `https://www.phillips-uk.com/#contact` on invite pages. Never add a `mailto:` link or a written-out address to a page, a button, JSON-LD, `llms.txt` or an error message. The one address left (the legal minimum, "option A") is in the footer legal line and on /privacy, written in by `email.js` from an `<a data-email>contact at phillips-uk dot com</a>` placeholder (the page loads `/email.js?v=1`), so it is never in the served HTML. JSON-LD uses a `contactPoint` with the form URL, never `email`. `generate_lead` is the lead key event; `contact_click` (a click on that legal-line address) is an ordinary event, not a key event.
- **The contact form** ("Ask me a question", since 2026-11-14) is in the contact section of the homepage, Work, About and the five service pages (`contact-form.js`, styles in `agency.css`). It posts to `/enquiry` (`cloudflare/src/enquiry.js`): each question is saved to R2 under `admin/enquiries/`, added to the /admin funnel as a Lead card, and emailed to contact@ (Reply-To the sender) through Resend when the `RESEND_API_KEY` secret is set. Spam: Cloudflare Turnstile checked on the server (widget "Phillips. contact form (phillips-uk.com)", managed, shown as interaction-only; secret `TURNSTILE_SECRET`; localhost uses Cloudflare's test keys), hidden `company_url` trap, under 3 seconds on the page, more than 5 an hour from one connection. Trap and timer get a fake "sent". On success the page pushes `generate_lead` (only `form_location`, never what was typed), which is in the GTM trigger "Site events to GA4" and is the key event. CTAs link to `#contact` (guides and About to `/#contact`); never "Book a call".
- **The paused tools' sign-in gate** asks `/tool-access` (`cloudflare/src/tool-access.js`) whether a Google account may use them, so no page holds a list of allowed addresses.

## The free tools (public since 2026-11-16)

- **Google Ads Check** at `/google-ads-audit` (`cloudflare/src/google-ads-check.js`, rules in `cloudflare/src/ads-check/`) and **Website Check** at `/website-check/` (`cloudflare/src/website-check.js`, rules in `website-check-rules.js`). Fixed written rules, no AI. Plan and history: vault `01_Phillips/04_Products/Free Tools Relaunch Plan.md`.
- `TOOLS_PUBLIC` in `cloudflare/src/tools-gate.js` switches each tool between public and private (private: only someone signed in to /admin). Old tool addresses 301 to the new ones (`MOVED` in `worker.js`); creative scoring is retired.
- Google Ads reads go through the Phillips. manager account (495-618-4074) with the **Phillips Tools** Cloud project's OAuth client (`phillips-tools-uk`, Basic access): Worker secrets `GOOGLE_ADS_CLIENT_ID`, `_CLIENT_SECRET`, `_REFRESH_TOKEN`, set with `cloudflare/scripts/google-ads-connect.mjs`. Read-only apart from accepting and ending the visitor's manager link. Speed: `PAGESPEED_API_KEY` from the same project.
- Prices appear only inside private reports, from the calculator at `/admin#pricing` (`cloudflare/src/pricing.js`). Site pages stay price-free. Google sign-in, Stripe checkout and applying fixes are behind `FLAGS` in `google-ads-check.js`, switched off.
- GA4 events (in the GTM trigger "Site events to GA4" since version 11): `website_check_start`, `website_check_complete`, `website_check_error`, `ads_check_start`, `ads_check_complete`, `ads_check_error`, `ads_check_fix_select`. Never an address, customer ID, account name or price in an event.
- **Google sign-in** (`cloudflare/src/google-signin.js`, since 16 Nov 2026): hidden from everyone for now (Lewis, 16 Nov 2026: until we're ready). `FLAGS.googleSignInPreview` shows it to Lewis signed in to /admin (to record Google's review video); `FLAGS.googleSignIn` opens it to everyone once Google verifies the app. While Google reviews it, reviewers get in through `/google-ads-audit?review=<SIGNIN_REVIEW_CODE>` (`cloudflare/src/signin-review.js`, Worker secret `SIGNIN_REVIEW_CODE`): a signed 30-day cookie shows the sign-in in that browser only. Delete the secret once sign-in is public. Online access only (no refresh token); the access token sits in an encrypted 15-minute HttpOnly cookie and is cleared when the check runs. Nothing is stored. The privacy notice's "Sign in with Google" section must keep matching this.
- Tests: `node cloudflare/src/ads-check/rules.test.mjs`, and with `node --import ./cloudflare/test/html-loader.mjs`: `cloudflare/test/ads-check-flow.test.mjs` and `cloudflare/test/google-signin.test.mjs`.

## The Monday Brief (since 2026-11-15)

- Weekly "what's changed in marketing" issue at `/updates/` and by email at 07:00 UK every Monday (`cloudflare/src/brief.js`, template `cloudflare/private/brief-page.html`, `brief.css`, `brief-form.js`). Sign-up is double opt-in; confirmed addresses go to the Resend segment "The Monday Brief". Privacy notice at `/privacy/`.
- **Email paused until the first real subscriber** (Lewis, 15 Nov 2026: keep the writing on). The weekly draft, notes and Monday 07:00 run all happen, but an approved issue is only published on the website until someone other than Lewis's own addresses confirms. That sets `startedAt` in `brief/config.json` and emails Lewis; from then on issues are emailed too. Each week's folder also gets a LinkedIn post draft (`linkedin.md`) that Lewis posts himself.
- **Insights:** the nav item "Insights" goes to `/guides/`, the hub for both strands: the latest Brief (filled in by the Worker, `withLatestIssue`) and sign-up at the top, guides below. Addresses stay `/guides/...` and `/updates/...`.
- **Email list** (`/admin#list`, since 2026-11-17): every Brief sign-up from R2 `brief/subscribers/`, newest first, with where each signed up and a CSV download. Unsubscribes live in Resend (each email's unsubscribe link goes there), so `GET /admin/api/brief/subscribers` reads the segment's contacts to mark them; read-only, it never emails anyone. Lewis's own addresses (`OWN`) are shown but not counted.
- **Never approve, publish or send an issue for Lewis.** A draft is `brief/issues/<Monday>.json` in R2; Lewis approves it in `/admin#brief`; the Monday cron sends only an approved, unchanged issue, once. How to draft and the file format: vault `01_Phillips/02_Website/The Monday Brief/00_How to draft an issue.md`.
- Cron triggers use day names (`MON`, `FRI`, `SUN`): Cloudflare numbers weekdays differently from standard cron. The code acts on the London day and hour.
- Resend free plans: 3,000 transactional emails a month (shared with the contact form), 1,000 marketing contacts. Past 1,000 subscribers is Lewis's decision.
- Events `newsletter_signup` and `newsletter_confirm` are in the GTM trigger "Site events to GA4" (version 10).

## Design (Design Spec v3, since 16 Nov 2026)

- **The source of truth is Design Spec v3**, one system for every brand where only the colour changes: vault `04_Projects/Before You Pay/Brand Assets/Web Design/BYP-DESIGN-SPEC.md` (sections 1b to 1e, section 2, Part B). Before You Pay is the reference build. The older `01_Phillips/Phillips. Design System.md` is history; where it disagrees, the spec wins for type, space, depth, motion and components, and Phillips. keeps its colour, mark, name and voice.
- **Tokens:** `tokens/system.css` and `tokens/modes.css` are copied unchanged from Before You Pay; `tokens/brand.css` is Phillips. (`--brand: #985830` plus pins for hover, wash and on-ink). `node scripts/build-tokens.js` copies them between the `tokens:start` and `tokens:end` markers of `agency.css`, `guides.css`, `cloudflare/private/admin.html` and `cloudflare/private/rate-card.html`. Never edit the copied block; edit `tokens/` and rerun, then bump `?v=` where the file is loaded. `tokens/` and `scripts/` are in `.assetsignore`.
- **Colours are token names only** (`var(--brand)`, `var(--text)`, `var(--line)`, `var(--e1)`, the six tones `--ok --info --attn --bad --party --off`). No hex in CSS apart from white text, colour mixes and the named `--dev-*` (drawn MacBook, iPhone, Safari) and `--gsi-*` (Google's button) colours. `node scripts/test-tokens.cjs` checks this, light only, and that the shared admin menu block is unchanged. `scripts/map-colours.cjs` moves a page in the old palette onto tokens.
- **Type:** Manrope (reading, headlines 800), hosted in `/fonts/` with its licence. v3 pages also use DM Mono (labels, uppercase); v5 pages have no mono (Lewis, 26 Nov 2026: `body.v5{--mono:var(--body)}`, labels and tags in Manrope, DM Mono out of their font loading). Buttons are pills (brand button with thickness, line button at depth 1); cards use the surface recipe (`--card-fill`, `--card-rim`, `--e1`, lifting to `--e2`); tags are mono with a dot in one of the six tones; dark moments are `--ink`/`--ink-panel`.
- **Hero on tablets and phones (Lewis, 25 Nov 2026: "v5 photo order on phones wins"):** v5 pages use the v5 hero order, as Before You Pay and phillips-group.uk do: headline, lede and buttons, then the photo. The 17 Nov v3 rule (the picture first, `.hero-grid > :not(:first-child) { order: -1 }` in `agency.css`) applies only to v3 pages until they move to v5.
- **Imagery (Lewis, 26 Nov 2026: "stock photos are fine"; replaces the 17 Nov "no stock photos"):** our own work and tools first (screenshots of the site's own reports and client sites, the photo of Lewis), then free-licence stock photos (Unsplash, Pexels and similar), credited where the licence asks and edited to the brand. Each picture shows what its section is about. No AI-generated people. Credits for the homepage photos: `images/home/CREDITS.md`. Drawn line illustrations (`.ill`, inline SVG on token colours) stay on v3 pages; whether v5 service heroes keep them, shown still, or use real pictures of our own work is still Lewis's call (open, 26 Nov 2026).
- **Light only:** never copy `modes-dark.css` or `modes-glass.css` from Before You Pay, never add an appearance setting.
- **Guides** keep their own `<style>` for layout and diagrams and load `/guides.css` after it (tokens plus the shared v3 layer). `?motion=off` stills the motion for screenshots on v3 pages. **Motion on v5 (Lewis, 26 Nov 2026):** `motion.js`, `motion.css` and `?motion=off` come off v5 pages, the guides included; a guide diagram that relied on them is shown still; the v5 core's own fade (`v5.js`, blocks marked `data-v5`) is the only motion.

## Page standards (summary, full detail in the Obsidian note)

- Static HTML and vanilla JS only. No new React/Babel pages.
- `<meta name="viewport" content="width=device-width, initial-scale=1.0">` right after the charset on every page.
- Mobile-first: every multi-column grid collapses at 900px; use the shared hamburger drawer pattern.
- Every public page: title `Page | Phillips.`, meta description, canonical and OG tags on `https://www.phillips-uk.com/...`, one `<h1>`, GTM `GTM-WS5CP6NW` (Search Console is verified through it, never remove it).
- Raw Claude Design exports go in `_design/` (git-ignored), never deployed.
- **AI search (local LLM strategy, since 2026-11-15):** the business and Lewis are single entities in JSON-LD (`https://www.phillips-uk.com/#business`, `https://www.phillips-uk.com/about/#lewis`); new pages point `provider`/`author` at those `@id`s instead of repeating details. Keep `llms.txt` in step when a service page, guide or key fact changes. After a deploy that changes pages, ping IndexNow (key file `c16543d0048f2c95ad3738e0c5b0a2a7.txt` at the root) with the changed URLs. Answers in FAQs open with one sentence that stands on its own. Strategy: vault `01_Phillips/02_Website/04_Local LLM Strategy.md`.

## End of session

Add a dated line to the build timeline in the Obsidian Web Build note: what changed, what was deployed, what is still pending. Make sure `git status` is clean and `main` is pushed.
