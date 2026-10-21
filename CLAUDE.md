# phillips-uk.com — project rules

Lewis Phillips's portfolio and tools site. Full history, standards and design workflow live in Obsidian: `01_Brand/03_Portfolio/phillips-uk.com — Web Build.md` (read it before larger changes) and `01_Brand/Phillips. Design System.md`.

## Cost rule (hard limit)

Stay inside free tiers. Never enable a paid service, change a plan, buy anything, or run something billed per use (a real audit calls Claude, OpenAI or PageSpeed Insights) without telling Lewis the possible cost and getting a yes first. Dry-run flags are not proof of zero cost.

## Hosting and deploy

**The site runs on a Cloudflare Worker (`phillips-uk`, account `9cd423eee8986ecc6f22f6fa3a17878b`, same as Before You Pay) since 2026-10-20. Netlify is suspended, so never run `netlify deploy`.**

Pushing to GitHub does **not** deploy. After pushing `main`, deploy from the repo root:

```bash
CLOUDFLARE_ACCOUNT_ID=9cd423eee8986ecc6f22f6fa3a17878b npx wrangler deploy
```

Then check `https://www.phillips-uk.com/` returns 200 and `/audit` returns 301.

- `wrangler.jsonc`: Worker config. `run_worker_first: true`, R2 binding `BLOBS` (bucket `phillips-blobs`), queue `phillips-jobs`, custom domains `www.phillips-uk.com` and `phillips-uk.com`.
- `cloudflare/src/worker.js`: router. Apex to www and http to https redirects, `/audit` redirects, `/auth/callback`, `/r/:id`, `/.netlify/functions/<name>`, then static assets.
- `cloudflare/src/netlify-adapter.js`: runs `netlify/functions/*.js` unchanged (copied from Before You Pay).
- `cloudflare/src/shims/netlify-blobs.cjs`: `@netlify/blobs` replaced by R2 (store name becomes a key prefix).
- **Background functions** (`*-background`) are queued and return 202. The consumer never retries, so a paid API call is never repeated.
- **New function:** add the file to `netlify/functions/` and add it to the `loaders` map in `worker.js`, or it returns 404.
- **New public file:** fine as is. **New non-public file at the repo root:** add it to `.assetsignore`, or it is served to the world.
- `_redirects` must contain only relative URLs; Cloudflare rejects the deploy otherwise. `netlify.toml` is no longer used for serving.
- Secrets live on the Worker (`npx wrangler secret list` / `secret put NAME`). Never print or commit them, never copy them into Obsidian.
- Local test: `npx wrangler dev --port 8787 --local --persist-to <folder outside the repo>` with test-only values in `.dev.vars` (git-ignored). Without `--persist-to` the dev server reloads in a loop.
- DNS is on Cloudflare (Free plan). Email is Google Workspace plus Resend, so never delete MX or TXT records. DNS changes are made by Lewis in the dashboard.

## Page standards (summary, full detail in the Obsidian note)

- Static HTML and vanilla JS only. No new React/Babel pages.
- `<meta name="viewport" content="width=device-width, initial-scale=1.0">` right after the charset on every page.
- Mobile-first: every multi-column grid collapses at 900px; use the shared hamburger drawer pattern.
- Every public page: title `Page | Phillips.`, meta description, canonical and OG tags on `https://www.phillips-uk.com/...`, one `<h1>`, GTM `GTM-WS5CP6NW` (Search Console is verified through it, never remove it).
- Raw Claude Design exports go in `_design/` (git-ignored), never deployed.

## End of session

Add a dated line to the build timeline in the Obsidian Web Build note: what changed, what was deployed, what is still pending. Make sure `git status` is clean and `main` is pushed.
