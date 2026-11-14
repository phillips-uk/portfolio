# phillips-uk.com — project rules

Lewis Phillips's portfolio and tools site. Full history, standards and design workflow live in Obsidian: `01_Phillips/03_Portfolio/phillips-uk.com — Web Build.md` (read it before larger changes) and `01_Phillips/Phillips. Design System.md`.

## Scope

This repo is the main Phillips. business: phillips-uk.com, the admin (`/admin`: clients, the prospects sales funnel, invite links) and the private pages (rate card, Search Desk demo, prospect prototypes). Its notes are in the vault under `01_Phillips/`. Search Desk itself, Before You Pay, The Director's Office and Phillips Group are separate repos with their own sessions: don't edit them from here. The `/desk` route only forwards to the Search Desk Worker. Rules for every project: `~/.claude/CLAUDE.md`.

Lewis reviews changes on the live site, so after a change: commit, push `main`, then deploy (below).

## Cost rule (hard limit)

Stay inside free tiers. Never enable a paid service, change a plan, buy anything, or run something billed per use (a real audit calls Claude, OpenAI or PageSpeed Insights) without telling Lewis the possible cost and getting a yes first. Dry-run flags are not proof of zero cost.

## Hosting and deploy

**The site runs on a Cloudflare Worker (`phillips-uk`, account `9cd423eee8986ecc6f22f6fa3a17878b`, same as Before You Pay) since 2026-10-20. Netlify is suspended, so never run `netlify deploy`.**

Pushing to GitHub does **not** deploy. After pushing `main`, deploy from the repo root:

```bash
CLOUDFLARE_ACCOUNT_ID=9cd423eee8986ecc6f22f6fa3a17878b npx wrangler deploy
```

Then check `https://www.phillips-uk.com/` returns 200 and `/audit` redirects (302 to `/google-ads/` while the free tools are paused, see `PAUSED` in `cloudflare/src/worker.js`; 301 to `/google-ads-audit` once they are back).

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
- **Invite pages** (`rate-card.js`) load gtag.js directly with only the path as `page_location`, so invite tokens never reach Google, and send `proposal_view`. `/admin` and Search Desk (`/desk`) are not tagged.
- **A new event:** push it from the page (`dataLayer.push({ event: 'name', ... })`), then Lewis or a browser session adds the name to the GTM trigger "Site events to GA4" and publishes. Key events and funnels: vault `01_Phillips/07_Analytics/03_Key Events & Conversions.md`. GTM and GA4 sign-in is lewisdp87@gmail.com.
- Contact links must stay `mailto:contact@phillips-uk.com` or `mailto:lewis@phillips-uk.com`, or `contact_click` stops counting.
- **The contact form** ("Ask me a question", since 2026-11-14) is in the contact section of the homepage, Work and the five service pages (`contact-form.js`, styles in `agency.css`). It posts to `/enquiry` (`cloudflare/src/enquiry.js`): each question is saved to R2 under `admin/enquiries/`, added to the /admin funnel as a Lead card, and emailed to contact@ through Resend when the `RESEND_API_KEY` secret is set. Spam: hidden `company_url` trap, under 3 seconds on the page, more than 5 an hour from one connection. On success the page pushes `generate_lead` (with `form_location`); add it to the GTM trigger "Site events to GA4" and mark it a key event in GA4. CTAs link to `#contact` (guides and About to `/#contact`); never "Book a call".

## Page standards (summary, full detail in the Obsidian note)

- Static HTML and vanilla JS only. No new React/Babel pages.
- `<meta name="viewport" content="width=device-width, initial-scale=1.0">` right after the charset on every page.
- Mobile-first: every multi-column grid collapses at 900px; use the shared hamburger drawer pattern.
- Every public page: title `Page | Phillips.`, meta description, canonical and OG tags on `https://www.phillips-uk.com/...`, one `<h1>`, GTM `GTM-WS5CP6NW` (Search Console is verified through it, never remove it).
- Raw Claude Design exports go in `_design/` (git-ignored), never deployed.

## End of session

Add a dated line to the build timeline in the Obsidian Web Build note: what changed, what was deployed, what is still pending. Make sure `git status` is clean and `main` is pushed.
