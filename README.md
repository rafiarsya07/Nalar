# Nalar

Writing to think. *Nalar* is Indonesian for reason, the habit of thinking
something all the way through, and this is where Rafi Arsya does that in
public. The front end reads like an editorial notebook: Fraunces headlines,
Source Serif 4 at 21px for the body, small mono labels, warm paper, and a
gold bar (the one from the logo) as the recurring mark. Three reading themes.

A full-stack personal blog with a built-from-scratch CMS, no off-the-shelf
platform. Write in Markdown with live preview, save drafts, schedule posts
to publish automatically, edit anytime, and browse by tag. Reading is
public; writing is behind authentication.

What landed in the September 2026 rebuild:

- **Recommendations** that run entirely in the reader's browser. Every post
  opened is written to `localStorage` with its tags; the tags are weighted by
  how recently they were read (21 day half life) and used to score every other
  post. Nothing is sent to the server and there is no profile stored anywhere.
  See `recordRead`, `tagAffinity` and `scorePosts` in `public/index.html`.
- **One sponsor slot**, edited from the dashboard and stored in
  `server/data/sponsor.json` (gitignored, so a deploy never clobbers the live
  one). `GET /api/sponsor` is public and returns null unless the card is both
  switched on and filled in; `PUT /api/admin/sponsor` saves it and clamps every
  field. No ad network, no third party script, nothing that follows readers.
- **Dashboard panels**: needs attention (posts missing covers, subtitles or
  tags, stale drafts, anything publishing this week, each one a filter for the
  post list), publishing cadence for the last eight months, and the sponsor
  editor with a live preview.

## Features

- **Markdown editor with live preview**, rendered output side by side as you type
- **Formatting toolbar and shortcuts**: bold, italic, heading, link, quote, code, list buttons, plus Ctrl/Cmd+B/I/K
- **Local autosave and word count**: drafts are saved to the browser as you write, with a restore prompt if you come back; live word/character count and reading time estimate
- **Three publish modes**: publish now, save as draft, or **schedule** for a future date
- **Scheduled publishing**: a background job flips scheduled posts live when their time comes
- **Full edit flow**: open any post, change content or status, republish
- **Admin dashboard**: counts for total, published, scheduled, drafts, total views, comments and subscribers; **filter by status, search, and bulk publish, draft, or delete**
- **Reader comfort**: a floating Reading panel (font size, column width, serif/sans, light/dark), table of contents, reading progress bar, and back to top
- **Rich article rendering**: copy to clipboard code blocks with syntax highlighting, click to zoom image lightbox, GitHub style callouts (`> [!note]` / `[!tip]` / `[!warn]`), and footnotes (`text[^1]` … `[^1]: …`)
- **Tags**: tag cloud on the home page, click any tag to filter
- **Related posts**: shown under each article based on shared tags
- **Reactions, ratings and comments**: emoji reactions and star ratings (no login), threaded reader comments
- **Cover images**, **full text search**, **per post view tracking**, **RSS feed**, **email subscriptions**

## What it demonstrates

- **REST API design**: a clean split of public reads and authenticated writes
- **Authentication**: bcrypt password hashing, a signed JWT in an httpOnly cookie, server side route guards
- **PostgreSQL**: a real schema, parameterized queries, a generated `tsvector` column plus a GIN index for search, an atomic view counter, array columns for tags
- **A post status state machine**: draft, then scheduled, then published
- **Background jobs**: an in-process scheduler that publishes due posts every minute
- **A clean data access layer**: all SQL lives in `server/db.js`

## Stack

Node.js and Express, PostgreSQL (`pg`), bcryptjs and jsonwebtoken, marked, a
vanilla JS single page front end (no framework, no build step), and dotenv.

## Run it locally

Requires PostgreSQL running.

```bash
npm install
cp .env.example .env        # then edit with your DB details

# create the database (once, in psql):
#   CREATE USER nalar WITH PASSWORD 'changeme';
#   CREATE DATABASE nalar OWNER nalar;

npm run init-db             # create / migrate tables
npm run seed                # admin user + sample posts
npm start                   # http://localhost:3000
```

Sign in at `/login` with the `ADMIN_USER` and `ADMIN_PASS` from your `.env`.
Reading the blog needs no login, that's only for writing.

## Project layout

```
server/
  index.js     Express app + all API routes
  db.js        the ONLY file that runs SQL
  auth.js      bcrypt + JWT helpers, requireAuth middleware
  scheduler.js background job for timed publishing
  init-db.js   schema create / migrate (run once)
  seed.js      admin user + sample posts
public/
  index.html   the entire front-end (reader + dashboard + editor)
```

## How scheduled publishing works

When you schedule a post, it's saved with `status = 'scheduled'` and a
`publish_at` timestamp, and stays hidden from readers. `scheduler.js` runs
every minute and asks the database for any scheduled post whose time has
passed, then flips it to `published`. It also runs once at startup to catch
anything that came due while the server was off.

## Deploying

Runs anywhere Node 20+ and PostgreSQL run. Keep it alive with PM2
(`pm2 start server/index.js --name nalar`) and put it behind a reverse proxy
or tunnel of your choice.

## Front end: the editorial redesign (Oct 2026)

`public/index.html` reads like an editorial notebook. Warm paper, olive ink,
Fraunces for display type, Instrument Sans for the interface, Source Serif 4
for articles and JetBrains Mono for small labels. The fonts are served from
`public/fonts/` (no Google Fonts request) and the two needed first are
preloaded. Meta details are separated by hairline rules drawn in CSS
(`metaLine()`), not by typed separator characters. Three reading themes
(paper, sepia, night) are cycled from the header; the choice lives in
`localStorage` under `nalar_theme` and is applied before first paint. Older
`tl_*` keys are migrated to `nalar_*` automatically on the first visit.

The whole look is defined in the "EDITORIAL LAYER" block at the end of the
`<style>` element, so it can be read and tuned in one place.

Layout notes worth knowing before editing it:

- The homepage runs masthead, featured post, "start with these three" (or
  recommendations for returning readers), then the full list. Most read and
  topics live in the sidebar only, so nothing is listed twice. The list
  reveals 8 posts per "show more" click rather than rendering everything.
- highlight.js is loaded on demand, only when a post contains code.
- Long text is capped in two places. CSS clamps titles and excerpts; JS
  clips the strings themselves via `clip()` and renders tags through
  `tagChips()`, which shows at most 2 or 3 tags and folds the rest into a
  "+N" pill.
- Anything user supplied that ends up inside an inline `onclick` goes
  through `jsq()`, which escapes quotes, backslashes and angle brackets. Use
  it for tags, slugs and titles. `esc()` alone is not enough there.
- One sidebar rail on the right only. `mountSidebar()` fetches once and
  `renderSidebar()` redraws it, so the show more toggles are plain state
  flips rather than new requests.

## Security additions

- **Security headers** (`server/index.js`): Content Security Policy,
  `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`,
  `Permissions-Policy`, `Cross-Origin-Resource-Policy`, and HSTS over HTTPS.
  Scripts are limited to this origin plus cdnjs (highlight.js), styles and
  fonts to this origin, and frames to YouTube nocookie and CodePen,
  which are the only embeds the Markdown renderer can emit. Adding a new CDN
  or embed provider means editing the `CSP` array.
- **Cookie hardening**: one middleware wraps `res.cookie` so every cookie
  the app sets gets `httpOnly`, `sameSite=lax`, `path=/` and, over HTTPS,
  `secure`.
- **Search throttling**: the client enforces a 2 character minimum, a
  420ms debounce, an 80 character cap and a 12 requests per 10 seconds token
  bucket with a visible cooldown. The server backs that up with
  `searchLimiter` (40 requests per minute) and its own length cap on `q`.

## Performance & resilience additions

- **In-process caching** (`server/cache.js`): the published posts listing,
  tag cloud, and RSS feed are cached for 30 to 60 seconds and invalidated on
  any write (create/update/delete/pin/bulk actions, and the scheduler's
  auto-publish tick). No Redis dependency, a single instance blog doesn't
  need one.
- **Rate limiting** (`server/rateLimit.js`, via `express-rate-limit`):
  login attempts, anonymous comments/reactions/edits, and newsletter
  subscriptions are throttled per IP; a loose limiter also covers the rest
  of `/api` as a safety net against scraping.
- **Per-post Open Graph / Twitter meta**: `GET /p/:slug` serves the SPA
  shell with that post's own title, excerpt, and cover image injected into
  `<head>`, so links shared on Discord/Twitter/WhatsApp show a real preview
  instead of the site wide default.
- **Automated backups** (`deploy/backup.sh`): dumps the database, gzips it,
  rotates local copies older than `KEEP_DAYS`, and (if `RCLONE_REMOTE` is
  set) pushes a copy to another machine. It reads `DATABASE_URL` from `.env`,
  so it always dumps the database the app uses. Meant to run daily via cron.
- **CI/CD**: not set up yet. A `.github/workflows/ci.yml` that installs
  deps and syntax checks server files on every push (with an optional
  SSH-deploy step once `DEPLOY_*` secrets exist) is a
  reasonable next step, but isn't in this repo yet.
