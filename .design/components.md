# Figma to code: components map, Phillips. (phillips-uk.com)

Which Figma component is which piece of code, and which v5 template each page family uses. Figma file: the group design file (`7YVrt8qdoW6C1K0arY6aXI`), components on page "03 Components", sections on "04 Sections", this site's templates on **"05 Templates · Phillips."** (page `355:13241`, frames named `PX ... (draft)`), Brand mode **"Phillips."** (amber `#985830`). Written 25 Nov 2026 for the v5 redesign (prep only: nothing is built yet, so every row is **to build**).

When Lewis changes a component in Figma, look it up here, change the code named on the right, run the checks at the end of this file, and update this map if a class or file moves. When code changes something you can see, change the Figma component to match and note the date here.

Status: **same** (the code matches), **close** (the code exists, details in the notes), **to build** (nothing in code yet).

## Foundations

| Figma | Code | Status |
|---|---|---|
| Variables: Brand (mode "Phillips.") | `tokens/brand.css` | Same. 53 tokens match, 0 different (`node scripts/figma-tokens.cjs`, 25 Nov 2026). The Figma mode's `brand/wash` and `brand/hover` were set to the site's pins (`#F5EBD9`, `#7A3F1F`) on 25 Nov 2026, as The Director's Office and Search Desk did. Worked out in code: `--brand-top`, `--scrim`. Only in Figma: `--brand-line`, `--brand-button-on-ink(-text)`, `--stone`, `--stage`, `--icon(-muted)` and the dashboard sizes; add them to `tokens/` when a part needs them. |
| Variables: Colour (Light), Space | `tokens/modes.css`, `tokens/system.css` (copied unchanged from Before You Pay) | Same. |
| Text styles `v5/*` | the v5 core (`tokens/v5-core.css`, copied from the phillips-group repo, never edited) | To build: the core goes inside the tokens block of the page stylesheets through `scripts/build-tokens.js`. |
| Logo (Brand=Phillips., Tone=On paper) | the P. tile and the name (`/logo/phillips-lockup.svg` today) | To build: the v5 header and footer use the lockup on paper; the reversed lockup goes. |

## Page templates

Each page family to its v5 template (Figma frames at 1440, 768 and 375):

| Figma template | Phillips. pages | Notes |
|---|---|---|
| PX Homepage | `/` (`index.html`) | Hero with Lewis's photo and the two check buttons; Split (two ways to work together, Ely photo); Split (the five services, trades photo); Figures (track record); Card grid (work: Lee Renée, Myia Bonner, The Pommier); Panel with picture (how it starts); FAQ; Contact; Footer. |
| PX Service page · Google Ads | `/google-ads/`, `/consultancy/`, `/local-seo/`, `/marketing-systems/`, `/web-design/` | Deeper hero (breadcrumb, H1 52) with a report screenshot; Trio; Split (what is included); Split (accounts or work); Panel with picture (the report or tool for that service); FAQ; Split (how I take it on); Contact. Each page keeps its own words and its own picture; marketing-systems keeps its driveway quote calculator (`#drive-calc`) inside a V5 Tool panel. |
| PX Hub · Free checks | `/free-checks/`; also `/work/` and `/guides/` with the same parts | Free checks: Split per tool (screenshot, arrow link), Panel (Search Desk), Contact. Work: Card grid of V5 Case cards with real site screenshots. Insights hub: the latest Brief (the Worker's `[data-brief-latest]`), the filter pills and a Card grid of guides. |
| PX Form · Google Ads Check (tool start) | `/google-ads-audit` (`cloudflare/private/google-ads-check.html`), `/website-check/` (`website-check.html`) | Deeper hero with the **V5 Tool panel** (Search Desk's shared part, `355:14369`): two choice chips (Sign in with Google, Customer ID), the field, "Add a target" fold, Start my check, and "What you get" in the result card. Then the example (Panel), what it checks (Split), FAQ and Contact. The Website Check uses the same shell with one field (the address) and the kind switch. |
| PX Report · Google Ads Check | the report both tools draw into `#report` (`tool-google-ads-check.js`, `tool-website-check.js`) | Hero with a V5 Record card (this report); "Report (reading)" blocks: what to do in order (V5 Numbered step), how it's moving (the report's own chart), what's working (V5 Tick row), prefer me to do them (V5 Checkbox row), why there's no AI; Closing strip. The scripts write the report markup, so the build restyles their classes in `tools.css` (or moves them onto v5 classes in the same scripts). |
| PX Guide · Google Ads audit checklist | the 7 guides under `/guides/` | Deeper hero; Quick answer as a solo Panel; Reading sections; each guide's own diagrams and tables kept as they are (only the shell changes: they sit in a "Diagram" block in the reading column); the Brief sign-up; Closing strip. |
| PX About | `/about/` | Hero (photo), Figures, Split (the story, The Pommier), Split (strengths, Myia Bonner screenshot), Contact. |
| PX Form · Message sent | the contact section after Send, on every page with the form | The V5 Done card replaces the form (`contact-form.js` writes `.enquiry-done`). |
| PX Legal · Privacy notice | `/privacy/`, `/terms/` | Hero without a photo, Reading sections on the tight spacing, the approved wording unchanged. |
| PX 404 | `/404` (`404.html`) | Hero (photo), Trio (where to next: free checks, work, insights), Closing strip. |
| (no new template) | `/updates/` and every Brief page (`cloudflare/private/brief-page.html` + `brief.js`) | The Brief shell takes the v5 header, footer and reading column; the issue markup `brief.js` writes (`brief-*`, `bi-*`) is restyled in `brief.css`. See the hand-over's "For the backend session" for markup changes. |
| (no new template) | `/account/` (`account.html`) | The Form template: a deeper hero and the sign-in card (V5 Field, V5 Button, Google's own button). |

## Components

| Figma component | Code | Status | Phillips. notes |
|---|---|---|---|
| V5 Header (Size=Desktop, Phone) | `.vhd` from `scripts/v5-chrome.cjs` `header()` | To build | Logo left, one small button **"Free checks"** (40 high). Today's Services, Work, About and Insights links move to the footer (as on The Director's Office), unless Lewis wants two of them back through the header's optional text links (Search Desk's addition, logged in `figma-new-parts.md`). The hamburger drawer (`#nav-toggle`, `#nav-drawer`) goes. |
| Section · Hero (Tone=Light) with V5 Hero photo | `.vh.hero`, `.vh-grid`, `.vh-photo` from `heroPhoto()` | To build | Homepage, About, 404: Lewis's photo. Service pages, hub and guides: a screenshot of the site's own reports (Kind=Screenshot), cropped from the top left. Phones: text first, photo second (decision for Lewis). |
| Section · Hero with V5 Breadcrumb (the deeper hero) | `.vh.vd-hero.hero` + `.vd-crumb` from `crumb()` | To build | Service pages, tools, report, guides. H1 52 on desktop. |
| Section · Trio with V5 Trio item and V5 Seal | `.vm` from `trio()` | To build | Service pages and 404. Seals: Chart, Record, Identity, Source, Quote and Learning (The Director's Office's marks, free for any site). No Phillips. seals drawn yet. |
| Section · Split (White, Cream) with V5 Split picture and V5 Tick row | `.vf-grid`, `.vf` from `tickRows()` | To build | The main pattern on every page. Up to six rows; the picture is a photo or a screenshot. |
| V5 Arrow link | `.v-go` from `go()` | To build | Under a split's intro ("Check my Google Ads →"), never inside a sentence. |
| Section · Panel (With picture, Solo) with V5 Panel screenshot | `.vp-sec > .vp`, `.vp-shot` | To build | The report example, how it starts, Search Desk, the guide's quick answer. |
| Section · Figures with V5 Figure | `.vfigs` from `figures()` | To build | Homepage and About: 11 yrs, £900k, 8, 4. |
| Section · Card grid with V5 Case card | `.vcards` / `.vd-card` | To build | Work (real site screenshots), guides hub. |
| Section · FAQ with V5 Question row | `.vq` from `faq()` | To build | Keep the FAQPage JSON-LD in step with the questions shown. |
| Section · Reading | `.v-sec.tight.vlegal` + `.vread`, `data-reading` | To build | Legal pages and guides. |
| Section · Closing strip | `.vt` on `bg-stone` from `strip()` | To build | Report, guides, 404. Pages with the contact form end on the Contact section instead. |
| Contact section (page frame "Section · Contact (form, #contact)", built from V5 Field, V5 Text area, V5 Button) | `.vfield.field`, `.vb.vb-p`, inside `section#contact` | To build | The form markup changes class only: `form.enquiry`, `action="/enquiry"`, `data-location`, the fields `name`, `email`, `business`, `message`, the trap `company_url`, `.enquiry-foot` (Turnstile goes in before it), `.enquiry-status` and `button[type=submit]` all stay (`.design/contract.md`). Use `class="vfield field"` and the stronger error selector from `v5-kit.md`. |
| V5 Done card | `.vdone` | To build | `contact-form.js` writes `.enquiry-done` with `.enquiry-done-title`; the build either adds `vdone` to that markup (front end, `contact-form.js`) or styles `.enquiry-done` like `.vdone`. |
| Brief sign-up (page frame "Section · Brief sign-up (#brief)", V5 Field and V5 Button) | `form.brief-signup` | To build | Fields `email`, `company_url`, `.brief-status`, `data-location` stay. |
| V5 Tool panel (Search Desk's part, `355:14369`) | `.vtool` (search-desk's stylesheet; copy it into the core when it lands there) | To build | The Google Ads Check start: Choice 1 "Sign in with Google" (default; shows Google's own button, `--gsi-*` colours), Choice 2 "Customer ID" (`#cid`), the target fold (`#t-type`, `#t-value`, `#t-brand`), "Start my check" (primary), the result card as "What you get". Every id in the contract stays. |
| V5 Record card with V5 Fact row | `.vrec` from `record()` | To build | The report's "This report" card. |
| V5 Numbered step, V5 Checkbox row, V5 Tick row | `.vst` / `.vchk` / `.vf` | To build | Inside the report blocks. |
| V5 Footer (Desktop, Phone) with V5 Group footer row | `.vgf` from `v5-chrome.cjs` `footer({ here: 'phillips' })` | To build | Columns: Services (5), Free checks (Google Ads Check, Website Check, Guides, The Monday Brief), Phillips. (Work, About, Ask me a question). The Desktop footer's columns gained one hidden extra link row each on 25 Nov 2026 (logged). Bottom line: Privacy, Terms, Cookie settings (`data-cookie-settings`), "Powered by Phillips.". Legal line from the company record. No address in the footer. |
| Logo (Phillips., On paper) | `.vhd-logo` | To build | The P. tile and "Phillips." |

## Forms, tools, sign-in and GA4 events (what the redesign must keep; `.design/contract.md` has every hook)

- **"Ask me a question"** (homepage, about, work, free checks, the five service pages, both tool pages): `form.enquiry` posts JSON to `POST /enquiry` (`cloudflare/src/enquiry.js`) from `contact-form.js`; without JavaScript it posts the form itself. Fields `name`, `email`, `business` (optional), `message`, the trap `company_url`, the timer `elapsed` (3 seconds), the page and `data-location`. Turnstile: live sitekey `0x4AAAAAAGDEt8LCJ4VVlwit`, the always-pass test key off phillips-uk.com, interaction-only, rendered into `.enquiry-ts` before `.enquiry-foot`. On success: **`generate_lead`** with `form_location` only. Every CTA links to `#contact` or `/#contact`; never "Book a call".
- **The Monday Brief sign-up** (Insights hub, the 7 guides, every Brief page): `form.brief-signup` posts to `/subscribe` (`brief-form.js`), double opt-in. **`newsletter_signup`** with `form_location` only; **`newsletter_confirm`** on the confirmation page the Worker writes. The hub's latest issue goes into `[data-brief-latest]` (the Worker's `withLatestIssue`).
- **Google Ads Check** (`/google-ads-audit`, `tool-google-ads-check.js`): Sign in with Google (open to everyone since 24 Nov 2026; `#step-google`, `#gsi-btn` linking `/tools/google-ads-check/oauth/start`, the Worker's `data-signin` on `<body>`; reviewers' cookie via `?review=`), or the customer ID and the manager-account invite (`#step-id`, `#id-form`, `#cid`, `#step-invite`), Turnstile (`#check-ts`), progress (`#progress`), the report (`#report` and its ids), Copy the link, Print or save as PDF. Events: **`ads_check_start`**, **`ads_check_complete`**, **`ads_check_error`**, **`ads_check_fix_select`**, off in Lewis's preview (`data-preview`). Never a customer ID, account name or price in an event.
- **Website Check** (`/website-check/`, `tool-website-check.js`): `#check-form` (`url`), the kind switch, Turnstile, the report, save to an account. Events: **`website_check_start`**, **`website_check_complete`**, **`website_check_error`**, **`website_check_fix_select`**, `website_check_fix_ask`, `website_check_switch_kind`, `website_check_area`, `website_check_signin_to_save`, `website_check_saved`, `website_check_again`, `website_check_again_dashboard`. Never an address in an event.
- **Accounts** (`/account/`, `tool-account.js`, private preview): email link or Google Identity Services (`accounts.google.com/gsi/client`, `#gsi-btn`), the three states `#acct-signin`, `#acct-confirm`, `#acct-home`; the Worker adds `data-google` and `data-preview` to `<body>`.
- **The address:** only on `/privacy/`, written in by `email.js` from `<a data-email>contact at phillips-uk dot com</a>`. No address anywhere else, including the footer (the footer note in `CLAUDE.md` predates the 22 Nov footer). No page script pushes `contact_click`.
- **Cookies:** every footer's Cookie settings has `data-cookie-settings`; the Worker adds the consent defaults and `/consent.js` to every tagged page, and GTM `GTM-WS5CP6NW` where a page lacks it.
- **Search:** JSON-LD `@id`s `https://www.phillips-uk.com/#business` and `/about/#lewis` (and `/#faq`, `/guides/#page`), canonical and OG tags on every indexed page, one `<h1>` and one `<main>`. `llms.txt` stays in step; IndexNow ping after a deploy that changes pages.

## What leaves on v5 pages (for the build)

- `agency.css`, `motion.css`, `footer.css` and `guides.css`'s v3 layer on v5 pages; `motion.js` (and `?motion=off`) where `v5.js`'s fade replaces it. The contract's class hooks that only `motion.js` reads (`.hero`, `.card`, `.feature`, `.step` and the like) go with it; rerun the contract in the same commit.
- DM Mono (`body.v5{--mono:var(--body)}`), the mono tags with a dot, eyebrows, the second headline colour, the hamburger drawer.
- `fold.js` and `showcase.js` where V5 Show more, the fold and the case cards replace them.
- `report.css` and `report-pdf.js` belong only to the retired landing page audit; the live tools' reports are styled in `tools.css`.

## Checks before any redesign commit

1. `node scripts/design-contract.cjs --check`: every script hook is still on its page, and the always-kept and structure lists hold.
2. `node scripts/figma-tokens.cjs`: no "DIFFERENT" lines.
3. `node scripts/test-tokens.cjs` (with `v5-core.css` inside the tokens block) and `node scripts/build-tokens.js --check`.
4. `node scripts/check-v5-system.cjs` (copied from the pilot when the build starts): every v5 page at 1440, 768 and 375, no findings.
5. The Figma audit (`.design/figma-audit.js`) on "05 Templates · Phillips.", no findings (25 Nov 2026: 30 frames, none).
6. The repo's own tests (`node cloudflare/src/ads-check/rules.test.mjs`, the ads-check flow and Google sign-in tests) and the local Worker: the form sends with the Turnstile test keys, `generate_lead` fires with no personal data, the Brief sign-up, both tools to a report (on test data only: a real run calls paid APIs), the consent banner.
