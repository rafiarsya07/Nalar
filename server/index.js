// ---------------------------------------------------------------------------
// index.js — HTTP server + API
//
// Serves the front-end, exposes a JSON API, renders Markdown server-side, and
// starts the background scheduler for timed publishing.
//
// Route map:
//   PUBLIC
//     GET  /api/posts                  list published posts
//     GET  /api/posts/:slug            one post (rendered) + view++ + related
//                                       + comments + reactions + rating
//     POST /api/posts/:slug/comments   add a comment (no login)
//     POST /api/posts/:slug/react      toggle an emoji reaction (no login)
//     POST /api/subscribe              add an email to the newsletter list
//     GET  /api/search?q=              full-text search
//     GET  /api/tags                   tag cloud with counts
//     GET  /api/tags/:tag              posts for one tag
//     GET  /rss.xml                    RSS 2.0 feed
//   AUTH
//     POST /api/login  /api/logout  GET /api/me
//   ADMIN (requireAuth)
//     GET    /api/admin/posts          all posts incl. drafts/scheduled
//     GET    /api/admin/posts/:id      one full post (for the editor)
//     GET    /api/admin/stats          dashboard counts
//     GET    /api/admin/top-posts      most-viewed published posts
//     GET    /api/admin/subscribers    newsletter subscriber list
//     POST   /api/admin/posts          create
//     PUT    /api/admin/posts/:id      update
//     DELETE /api/admin/posts/:id      delete
//     DELETE /api/admin/comments/:id   remove a comment
//     POST   /api/admin/preview        render Markdown -> HTML (live preview)
//     POST   /api/admin/upload         upload an image (cover or inline)
// ---------------------------------------------------------------------------

import "dotenv/config";
import express from "express";
import cookieParser from "cookie-parser";
import { marked } from "marked";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import crypto from "crypto";

import { readFileSync, existsSync, mkdirSync } from "fs";
import { readFile, writeFile } from "fs/promises";

import * as db from "./db.js";
import { hashPassword, verifyPassword, signToken, requireAuth, isAuthed } from "./auth.js";
import { startScheduler } from "./scheduler.js";
import { upload } from "./upload.js";
import { UPLOAD_DIR } from "./upload.js";
import { sendWelcome, notifyNewPost, notifyNewComment } from "./mailer.js";
import { buildRssFeed } from "./rss.js";
import { buildSitemap } from "./sitemap.js";
import { cached, invalidate } from "./cache.js";
import { loginLimiter, writeLimiter, apiLimiter, searchLimiter } from "./rateLimit.js";

// ---------------------------------------------------------------------------
// Markdown rendering — a small layer on top of `marked`:
//   • GitHub-style callouts:  > [!note] / [!tip] / [!warn]  (first line of a
//     blockquote) become styled <div class="callout">…</div> boxes.
//   • Footnotes:  text[^1] … then  [^1]: the note   at the bottom.
//   • Code fences keep their language class so highlight.js can colour them
//     on the client (rendered monochrome by the page CSS).
// renderMarkdown() is the single entry point used by both the live preview
// and the published-post endpoint, so writing and reading always match.
// ---------------------------------------------------------------------------
const CALLOUT_META = {
  note: { cls: "", label: "Note" },
  info: { cls: "", label: "Info" },
  tip:  { cls: "tip", label: "Tip" },
  warn: { cls: "warn", label: "Warning" },
  warning: { cls: "warn", label: "Warning" },
};

function renderMarkdown(src) {
  src = (src || "").toString();

  // --- collect footnote definitions, strip them from the body ---
  const notes = {};
  src = src.replace(/^\[\^([^\]]+)\]:\s?(.*(?:\n(?! *\[\^).*)*)/gm, (_m, id, text) => {
    notes[id] = text.trim();
    return "";
  });

  // --- a bare YouTube/CodePen URL on its own line -> a responsive embed,
  //     and ==highlight== -> <mark>highlight</mark> ---
  // Neither is standard markdown, so both are converted ourselves before
  // handing off to marked (which passes raw HTML like <div>/<mark> straight
  // through). Fenced code blocks and inline code spans are swapped out
  // first so a literal "==" or URL inside a code sample is never touched.
  const codeStash = [];
  src = src
    .replace(/```[\s\S]*?```/g, (m) => {
      codeStash.push(m);
      return `\u0000${codeStash.length - 1}\u0000`;
    })
    .replace(/`[^`\n]+`/g, (m) => {
      codeStash.push(m);
      return `\u0000${codeStash.length - 1}\u0000`;
    });
  src = src.replace(/^[ \t]*(https?:\/\/\S+)[ \t]*$/gm, (full, url) => {
    const yt = url.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/)([a-zA-Z0-9_-]{6,15})/);
    if (yt) {
      return `<div class="embed embed-video"><iframe src="https://www.youtube-nocookie.com/embed/${yt[1]}" title="YouTube video" loading="lazy" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowfullscreen></iframe></div>`;
    }
    const cp = url.match(/codepen\.io\/([a-zA-Z0-9_-]+)\/pen\/([a-zA-Z0-9_-]+)/);
    if (cp) {
      return `<div class="embed embed-codepen"><iframe src="https://codepen.io/${cp[1]}/embed/${cp[2]}?default-tab=result" title="CodePen embed" loading="lazy" allowtransparency="true" allowfullscreen></iframe></div>`;
    }
    return full;
  });
  src = src.replace(/==([^=\n]+)==/g, (_m, text) => `<mark>${text}</mark>`);
  src = src.replace(/\u0000(\d+)\u0000/g, (_m, i) => codeStash[Number(i)]);

  let html = marked.parse(src);

  // --- callouts: a blockquote whose first line is [!type] ---
  html = html.replace(
    /<blockquote>\s*<p>\s*\[!(\w+)\]\s*(<br\s*\/?>)?\s*([\s\S]*?)<\/blockquote>/gi,
    (full, type, _br, inner) => {
      const meta = CALLOUT_META[type.toLowerCase()];
      if (!meta) return full;
      const body = inner.replace(/<\/p>\s*$/i, "").trim();
      return `<div class="callout ${meta.cls}"><div class="callout-head" data-icon="${type.toLowerCase()}">${meta.label}</div><p>${body}</p></div>`;
    }
  );

  // --- footnote references: text[^id] -> superscript link ---
  const order = [];
  html = html.replace(/\[\^([^\]]+)\]/g, (_m, id) => {
    if (!notes[id]) return _m;
    if (!order.includes(id)) order.push(id);
    const n = order.indexOf(id) + 1;
    return `<sup class="fnref" id="fnref-${id}"><a href="#fn-${id}">${n}</a></sup>`;
  });

  // --- footnote list at the end ---
  if (order.length) {
    const items = order.map((id) =>
      `<li id="fn-${id}">${marked.parseInline(notes[id])} <a class="fn-back" href="#fnref-${id}" title="Back to text">↩</a></li>`
    ).join("");
    html += `<div class="footnotes"><div class="fn-title">Footnotes</div><ol>${items}</ol></div>`;
  }

  return html;
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

// We sit behind exactly one hop — the Cloudflare Tunnel — which sets
// X-Forwarded-For on every request. Without this, Express doesn't trust
// that header, so express-rate-limit refuses to trust the derived client IP
// and throws (ERR_ERL_UNEXPECTED_X_FORWARDED_FOR) instead of just rate
// limiting, taking down every /api/* route behind it.
app.set("trust proxy", 1);

// ---------------------------------------------------------------------------
// SECURITY HEADERS
// Hand-rolled instead of pulling in helmet: this is the whole useful subset
// for a single-page blog, and it stays readable.
//   • CSP  — scripts only from this origin and cdnjs (highlight.js); styles
//            from this origin and Google Fonts. 'unsafe-inline' is required
//            because the app is one self-contained HTML file with inline
//            <style>/<script>. Frames are limited to the two embed providers
//            the Markdown renderer can emit. Nothing else may frame US.
//   • nosniff / Referrer-Policy / Permissions-Policy — cheap, no downside.
//   • HSTS — only over HTTPS (the tunnel terminates TLS in front of us).
// ---------------------------------------------------------------------------
const IS_PROD = process.env.NODE_ENV === "production";
const CSP = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "script-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com data:",
  "img-src 'self' data: blob: https:",
  "connect-src 'self'",
  "media-src 'self'",
  "frame-src https://www.youtube-nocookie.com https://codepen.io",
  "upgrade-insecure-requests",
].join("; ");

app.disable("x-powered-by");
app.use((req, res, next) => {
  res.setHeader("Content-Security-Policy", CSP);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=(), interest-cohort=()");
  res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  if (IS_PROD || req.headers["x-forwarded-proto"] === "https") {
    res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }
  next();
});

// Every cookie this app sets is httpOnly + sameSite=lax; behind the tunnel we
// also want Secure. Rather than repeating the flags at four call sites, wrap
// res.cookie once and let each call pass only what differs.
app.use((req, res, next) => {
  const raw = res.cookie.bind(res);
  res.cookie = (name, value, opts = {}) =>
    raw(name, value, {
      httpOnly: true,
      sameSite: "lax",
      secure: IS_PROD || req.headers["x-forwarded-proto"] === "https",
      path: "/",
      ...opts,
    });
  next();
});

// The RSS stylesheet has to be served as text/xsl for a browser to apply it,
// and it has to be registered before express.static so this route wins.
app.get("/rss.xsl", (req, res) => {
  res.type("text/xsl").sendFile(join(__dirname, "..", "public", "rss.xsl"));
});

app.use(express.json({ limit: "1mb" }));
app.use(cookieParser());
app.use(express.static(join(__dirname, "..", "public")));
// Uploaded images live in server/uploads/, outside the public dir, so they
// need their own static mount. Without this, every /uploads/* URL 404s and
// inline/cover images render broken.
app.use("/uploads", express.static(UPLOAD_DIR, { maxAge: "30d", immutable: true }));

// A loose safety net over the whole API — generous enough that normal
// browsing/typing never trips it, but enough to stop a scraper or bug from
// hammering the DB (and, indirectly, the mini PC's disk) for free.
app.use("/api", apiLimiter);

// The raw index.html, read once at boot. Used as the template for injecting
// per-post Open Graph / Twitter meta tags (see the /p/:slug route below) so
// links shared on Discord/Twitter/WhatsApp show the post's own title, excerpt
// and cover image instead of the site-wide default.
const INDEX_HTML = readFileSync(join(__dirname, "..", "public", "index.html"), "utf8");

function escAttr(s) {
  return String(s ?? "").replace(/"/g, "&quot;");
}

// Swap the <title> and the description/og:*/twitter:* meta tags for
// post-specific values. Matches on the attribute name, not the exact default
// text, so it keeps working even if the site-wide copy changes later.
function injectPostMeta(html, { title, description, url, image }) {
  return html
    .replace(/<title>.*?<\/title>/, `<title>${escAttr(title)}</title>`)
    .replace(
      /(<meta name="description" content=")[^"]*(")/,
      `$1${escAttr(description)}$2`
    )
    .replace(/(<meta property="og:type" content=")[^"]*(")/, `$1article$2`)
    .replace(/(<meta property="og:title" content=")[^"]*(")/, `$1${escAttr(title)}$2`)
    .replace(
      /(<meta property="og:description" content=")[^"]*(")/,
      `$1${escAttr(description)}$2`
    )
    .replace(/(<meta property="og:url" content=")[^"]*(")/, `$1${escAttr(url)}$2`)
    .replace(/(<meta property="og:image" content=")[^"]*(")/, `$1${escAttr(image)}$2`)
    .replace(/(<meta name="twitter:title" content=")[^"]*(")/, `$1${escAttr(title)}$2`)
    .replace(
      /(<meta name="twitter:description" content=")[^"]*(")/,
      `$1${escAttr(description)}$2`
    )
    .replace(/(<meta name="twitter:image" content=")[^"]*(")/, `$1${escAttr(image)}$2`);
}

// Anonymous visitor ID: a long-lived random cookie, separate from the
// view-tracking cookie. This is what lets a single browser "have" a set of
// emoji reactions without any login — same idea as a shopping-cart ID.
function ensureVisitorId(req, res) {
  let vid = req.cookies?.tl_vid;
  if (!vid) {
    vid = crypto.randomBytes(16).toString("hex");
    res.cookie("tl_vid", vid, {
      httpOnly: true, sameSite: "lax", maxAge: 365 * 24 * 60 * 60 * 1000,
    });
  }
  return vid;
}

const ALLOWED_EMOJI = new Set(["👍", "❤️", "🔥", "😮", "😂", "🤔"]);
// Name shown on admin replies in the comment thread.
const ADMIN_DISPLAY_NAME = process.env.ADMIN_DISPLAY_NAME || "Rafi";

function slugify(title) {
  return title.toLowerCase().trim()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-").replace(/-+/g, "-").slice(0, 80);
}

function parseTags(tags) {
  if (Array.isArray(tags)) return tags;
  if (typeof tags === "string")
    return tags.split(",").map((t) => t.trim()).filter(Boolean);
  return [];
}

// Decide a post's status from the editor's intent.
// - "publish now"  -> published, no publish_at
// - "schedule"     -> scheduled + publish_at (if the time is future)
// - otherwise      -> draft
function resolveStatus({ action, publishAt }) {
  if (action === "schedule" && publishAt) {
    const when = new Date(publishAt).getTime();
    if (when > Date.now()) return { status: "scheduled", publishAt: new Date(when).toISOString() };
    // Time already passed -> just publish now.
    return { status: "published", publishAt: null };
  }
  if (action === "publish") return { status: "published", publishAt: null };
  return { status: "draft", publishAt: null };
}

// =========================== PUBLIC ========================================

app.get("/api/posts", async (req, res) => {
  res.json(await cached("posts:published", 30_000, () => db.listPublishedPosts()));
});

// Search is the one public read that always hits the database (no cache), so
// it gets its own limiter on top of the global one, plus a hard length cap:
// a 4KB query string is never a real search, it is someone probing.
app.get("/api/search", searchLimiter, async (req, res) => {
  const q = (req.query.q || "").toString().replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 80);
  if (q.length < 2) return res.json([]);
  res.json(await db.searchPosts(q));
});

app.get("/api/tags", async (req, res) => {
  res.json(await cached("posts:tags", 60_000, () => db.tagCounts()));
});

app.get("/api/tags/:tag", async (req, res) => {
  res.json(await db.postsByTag(req.params.tag));
});

// All series (2+ or even 1-post groups) for the /series index page.
app.get("/api/series", async (req, res) => {
  res.json(await cached("posts:series", 60_000, () => db.listSeriesGroups()));
});

// RSS feed — standard XML, not under /api so feed readers get a clean URL.
app.get("/rss.xml", async (req, res) => {
  const posts = await cached("posts:published", 30_000, () => db.listPublishedPosts());
  const origin = `${req.protocol}://${req.get("host")}`;
  // text/xml rather than application/rss+xml on purpose: browsers only apply
  // the XSL stylesheet (see /rss.xsl) for the former, and every feed reader
  // accepts text/xml. Without this the feed shows up as raw markup.
  res.set("Content-Type", "text/xml; charset=utf-8");
  res.send(buildRssFeed(posts, origin));
});

// Sitemap — same idea as the RSS feed, but for search engine crawlers
// rather than feed readers. Lists the homepage + static pages, every
// published post (with its last-updated date), and every tag page.
app.get("/sitemap.xml", async (req, res) => {
  const posts = await cached("posts:published", 30_000, () => db.listPublishedPosts());
  const tags = await cached("tags:", 30_000, () => db.tagCounts());
  const origin = `${req.protocol}://${req.get("host")}`;
  res.set("Content-Type", "application/xml; charset=utf-8");
  res.send(buildSitemap(posts, tags, origin));
});

// robots.txt — points crawlers at the sitemap. Everything is public content
// (no private areas to disallow other than /admin and /write, which require
// login anyway), so this stays intentionally permissive.
app.get("/robots.txt", (req, res) => {
  const origin = `${req.protocol}://${req.get("host")}`;
  res.set("Content-Type", "text/plain; charset=utf-8");
  res.send(`User-agent: *
Disallow: /admin
Disallow: /write
Disallow: /edit/
Disallow: /preview/
Allow: /

Sitemap: ${origin}/sitemap.xml
`);
});

// Public: view a draft (or scheduled post) via its preview token — no
// login needed, the unguessable token itself is the access control.
app.get("/api/posts/preview/:token", async (req, res) => {
  const post = await db.getPostByPreviewToken(req.params.token);
  if (!post) return res.status(404).json({ error: "This preview link is invalid, or has been revoked." });
  res.json({ ...post, html: renderMarkdown(post.body) });
});

app.get("/api/posts/:slug", async (req, res) => {
  const post = await db.getPostBySlug(req.params.slug);
  const isLive =
    post && post.status === "published" &&
    (!post.publishAt || post.publishAt <= Date.now());
  if (!post || !isLive) return res.status(404).json({ error: "Post not found" });

  // View counting: one view per browser per post per 24h, tracked via a
  // signed-ish cookie (a set of "slug:expiry" pairs). Refreshing or spam-
  // clicking the same post in the same browser within the window no longer
  // inflates the count — it only goes up for a genuinely new visit.
  const seenCookieName = "tl_seen";
  const raw = req.cookies?.[seenCookieName] || "";
  const now = Date.now();
  const entries = raw.split(",").filter(Boolean).map((e) => {
    const [s, exp] = e.split(":");
    return { slug: s, exp: Number(exp) };
  }).filter((e) => e.exp > now); // drop expired entries as we go

  const alreadySeen = entries.some((e) => e.slug === post.slug);
  let views = post.views;

  if (!alreadySeen) {
    await db.incrementViews(req.params.slug);
    views = post.views + 1;
    entries.push({ slug: post.slug, exp: now + 24 * 60 * 60 * 1000 });
    const nextCookie = entries.map((e) => `${e.slug}:${e.exp}`).join(",");
    res.cookie(seenCookieName, nextCookie, {
      httpOnly: true, sameSite: "lax", maxAge: 30 * 24 * 60 * 60 * 1000,
    });
  }

  const related = await db.relatedPosts(post.id, post.tags, 3);

  // Series info: only attached if this post is actually part of a group of
  // 2+ published posts sharing the same `series` name — a lone post with a
  // series name typed in but no siblings yet just renders as a normal post.
  let seriesInfo = null;
  if (post.series) {
    const siblings = await db.seriesPosts(post.series);
    const idx = siblings.findIndex((p) => p.id === post.id);
    if (idx !== -1 && siblings.length > 1) {
      seriesInfo = {
        name: post.series,
        index: idx + 1,
        total: siblings.length,
        posts: siblings.map((p, i) => ({ slug: p.slug, title: p.title, order: i + 1 })),
        prev: idx > 0 ? siblings[idx - 1] : null,
        next: idx < siblings.length - 1 ? siblings[idx + 1] : null,
      };
    }
  }

  const visitorId = ensureVisitorId(req, res);
  const [comments, reactions, myReactions, rating] = await Promise.all([
    db.listComments(post.id),
    db.reactionCounts(post.id),
    db.visitorReactions(post.id, visitorId),
    db.ratingSummary(post.id),
  ]);

  res.json({
    ...post,
    views,
    html: renderMarkdown(post.body),
    related,
    seriesInfo,
    comments,
    reactions,
    myReactions,
    rating,
  });
});

// --- Comments (no login required) ------------------------------------------

app.post("/api/posts/:slug/comments", writeLimiter, async (req, res) => {
  const post = await db.getPostBySlug(req.params.slug);
  if (!post) return res.status(404).json({ error: "Post not found" });

  const { author, email, body, rating } = req.body || {};
  if (!author?.trim() || !body?.trim()) {
    return res.status(400).json({ error: "Name and comment are required" });
  }
  if (body.trim().length > 2000) {
    return res.status(400).json({ error: "Comment is too long (2000 characters max)" });
  }
  if (rating !== undefined && rating !== null && (rating < 1 || rating > 5)) {
    return res.status(400).json({ error: "Rating must be between 1 and 5" });
  }

  const comment = await db.createComment({
    postId: post.id,
    author: author.trim().slice(0, 80),
    email: email?.trim().slice(0, 200) || null,
    body: body.trim(),
    rating: rating ? Number(rating) : null,
  });
  notifyNewComment(post, comment); // background, no await — never blocks the reader's response
  res.status(201).json(comment);
});

// Edit your own comment. Anonymous authors prove ownership with the edit
// token handed back when they posted (kept in their browser's localStorage).
// A logged-in admin can edit any comment without a token.
app.patch("/api/comments/:id", writeLimiter, async (req, res) => {
  const id = Number(req.params.id);
  const { body, token } = req.body || {};
  if (!body?.trim()) return res.status(400).json({ error: "Comment can't be empty" });
  if (body.trim().length > 2000) return res.status(400).json({ error: "Comment is too long (2000 characters max)" });

  const admin = isAuthed(req);
  if (!admin && !token) return res.status(403).json({ error: "Not allowed to edit this comment" });

  const updated = await db.updateComment(id, body.trim(), { token, admin });
  if (!updated) return res.status(403).json({ error: "Not allowed to edit this comment" });
  res.json(updated);
});

// Delete your own comment (token) — or any comment if you're the admin.
app.delete("/api/comments/:id", async (req, res) => {
  const id = Number(req.params.id);
  const token = req.body?.token || req.query?.token;
  if (isAuthed(req)) {
    const ok = await db.deleteComment(id);
    return ok ? res.json({ ok: true }) : res.status(404).json({ error: "Comment not found" });
  }
  if (!token) return res.status(403).json({ error: "Not allowed to delete this comment" });
  const ok = await db.deleteCommentByToken(id, token);
  return ok ? res.json({ ok: true }) : res.status(403).json({ error: "Not allowed to delete this comment" });
});

// Admin reply to a comment (one level deep). Shows up nested under the parent
// with an "Author" badge so readers can see when you've answered them.
app.post("/api/admin/comments/:id/reply", requireAuth, async (req, res) => {
  const parentId = Number(req.params.id);
  const { body } = req.body || {};
  if (!body?.trim()) return res.status(400).json({ error: "Reply can't be empty" });

  const parent = await db.getCommentById(parentId);
  if (!parent) return res.status(404).json({ error: "Comment not found" });

  const reply = await db.createComment({
    postId: parent.post_id,
    author: ADMIN_DISPLAY_NAME,
    email: null,
    body: body.trim(),
    rating: null,
    isAdmin: true,
    parentId,
  });
  res.status(201).json(reply);
});

// --- Reactions (no login required) ------------------------------------------

app.post("/api/posts/:slug/react", writeLimiter, async (req, res) => {
  const post = await db.getPostBySlug(req.params.slug);
  if (!post) return res.status(404).json({ error: "Post not found" });

  const { emoji } = req.body || {};
  if (!ALLOWED_EMOJI.has(emoji)) {
    return res.status(400).json({ error: "Unsupported reaction" });
  }
  const visitorId = ensureVisitorId(req, res);
  const result = await db.toggleReaction(post.id, visitorId, emoji);
  res.json(result);
});

// --- Newsletter --------------------------------------------------------------

app.post("/api/subscribe", writeLimiter, async (req, res) => {
  const email = (req.body?.email || "").trim().toLowerCase();
  const valid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  if (!valid) return res.status(400).json({ error: "Enter a valid email address" });

  const ok = await db.addSubscriber(email);
  if (!ok) return res.status(500).json({ error: "Could not save your subscription" });
  // Fire-and-forget welcome email (no-op if SMTP isn't configured).
  sendWelcome(email).catch(() => {});
  res.status(201).json({ ok: true });
});

// Notify subscribers about a post the first time it becomes published.
// Idempotent via the posts.notified flag, so calling it more than once for
// the same post is harmless. Runs in the background — never blocks the response.
async function maybeNotifyPublished(post) {
  if (!post || post.status !== "published" || post.notified) return;
  await db.markNotified(post.id); // mark first to avoid a double-send race
  try {
    const emails = await db.getSubscriberEmails();
    const full = await db.getPostById(post.id);
    await notifyNewPost(full || post, emails);
  } catch (e) {
    console.warn("[notify] failed:", e.message);
  }
}

// ---------------------------------------------------------------------------
// SPONSOR
// One sponsor card, edited from the dashboard, kept in a small JSON file next
// to the server rather than in Postgres: it is a single row that changes a few
// times a year, and a file needs no migration. Nothing here loads a third
// party script, so the reader is never tracked by a sponsor.
// ---------------------------------------------------------------------------
const DATA_DIR = join(__dirname, "data");
const SPONSOR_FILE = join(DATA_DIR, "sponsor.json");
const EMPTY_SPONSOR = { enabled: false, name: "", blurb: "", url: "", cta: "", emoji: "", image: "" };

async function readSponsor() {
  try {
    const raw = await readFile(SPONSOR_FILE, "utf8");
    return { ...EMPTY_SPONSOR, ...JSON.parse(raw) };
  } catch {
    return { ...EMPTY_SPONSOR };
  }
}

// Everything is clamped and the two URL fields must be http(s) or a path on
// this site, so a bad paste can never turn the card into an injection vector.
function sanitizeSponsor(body) {
  const str = (v, max) => String(v ?? "").replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, max);
  const link = (v) => {
    const s = str(v, 300);
    if (!s) return "";
    if (s.startsWith("/")) return s;
    return /^https?:\/\//i.test(s) ? s : "";
  };
  return {
    enabled: !!body?.enabled,
    name: str(body?.name, 60),
    blurb: str(body?.blurb, 180),
    url: link(body?.url),
    cta: str(body?.cta, 24),
    emoji: str(body?.emoji, 4),
    image: link(body?.image),
  };
}

app.get("/api/sponsor", async (req, res) => {
  const s = await readSponsor();
  // Readers only ever see a card that is switched on and actually filled in.
  if (!s.enabled || !s.name) return res.json(null);
  res.json(s);
});

app.put("/api/admin/sponsor", requireAuth, async (req, res) => {
  const clean = sanitizeSponsor(req.body);
  try {
    if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
    await writeFile(SPONSOR_FILE, JSON.stringify(clean, null, 2), "utf8");
  } catch (e) {
    return res.status(500).json({ error: "Could not save the sponsor file" });
  }
  res.json(clean);
});

// =========================== AUTH ==========================================

app.post("/api/login", loginLimiter, async (req, res) => {
  const { username, password } = req.body || {};
  const user = await db.getUserByUsername(username || "");
  if (!user || !(await verifyPassword(password || "", user.passwordHash))) {
    return res.status(401).json({ error: "Wrong username or password" });
  }
  res.cookie("token", signToken(user), {
    httpOnly: true, sameSite: "lax", maxAge: 7 * 24 * 60 * 60 * 1000,
  });
  res.json({ username: user.username });
});

app.post("/api/logout", (req, res) => {
  res.clearCookie("token");
  res.json({ ok: true });
});

app.get("/api/me", requireAuth, (req, res) => {
  res.json({ username: req.user.username });
});

// =========================== ADMIN =========================================

app.get("/api/admin/posts", requireAuth, async (req, res) => {
  res.json(await db.listAllPosts());
});

app.get("/api/admin/stats", requireAuth, async (req, res) => {
  res.json(await db.adminStats());
});

app.get("/api/admin/top-posts", requireAuth, async (req, res) => {
  res.json(await db.topPosts(5));
});

app.delete("/api/admin/comments/:id", requireAuth, async (req, res) => {
  const ok = await db.deleteComment(Number(req.params.id));
  if (!ok) return res.status(404).json({ error: "Comment not found" });
  res.json({ ok: true });
});

// Pin/unpin toggles — both just flip the current value and hand it back so
// the frontend doesn't need a separate read before it can update its UI.
app.post("/api/admin/posts/:id/pin", requireAuth, async (req, res) => {
  const pinned = await db.togglePostPinned(Number(req.params.id));
  if (pinned === null) return res.status(404).json({ error: "Post not found" });
  invalidate("posts:");
  res.json({ pinned });
});

app.post("/api/admin/comments/:id/pin", requireAuth, async (req, res) => {
  const pinned = await db.toggleCommentPinned(Number(req.params.id));
  if (pinned === null) return res.status(404).json({ error: "Comment not found" });
  res.json({ pinned });
});

app.get("/api/admin/subscribers", requireAuth, async (req, res) => {
  res.json(await db.listSubscribers());
});

// Full post (with body) for loading into the editor.
app.get("/api/admin/posts/:id", requireAuth, async (req, res) => {
  const post = await db.getPostById(Number(req.params.id));
  if (!post) return res.status(404).json({ error: "Post not found" });
  res.json(post);
});

// Live preview: render Markdown without saving anything.
app.post("/api/admin/preview", requireAuth, (req, res) => {
  const body = (req.body?.body || "").toString();
  res.json({ html: renderMarkdown(body) });
});

// Image upload — used for both the cover-image picker and inline images
// dropped into the markdown editor. multer holds the file in memory (see
// uploads.js); processAndSave() re-encodes it to WebP and writes it to
// disk, then we hand back the public URL the front-end either stores as
// coverImage or splices into the body as ![](url).
app.post("/api/admin/upload", requireAuth, (req, res) => {
  upload.single("file")(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message || "Upload failed" });
    if (!req.file) return res.status(400).json({ error: "No image received" });
    res.json({ url: `/uploads/${req.file.filename}` });
  });
});

app.post("/api/admin/posts", requireAuth, async (req, res) => {
  const { title, subtitle, body, tags, action, publishAt, coverImage, series, seriesOrder } = req.body || {};
  if (!title?.trim() || !body?.trim()) {
    return res.status(400).json({ error: "Title and body are required" });
  }
  let slug = slugify(title);
  let n = 1;
  while (await db.getPostBySlug(slug)) slug = `${slugify(title)}-${++n}`;

  const { status, publishAt: pa } = resolveStatus({ action, publishAt });
  const post = await db.createPost({
    title: title.trim(), subtitle: subtitle?.trim() || null, slug, body,
    tags: parseTags(tags), status, publishAt: pa, coverImage,
    series: series?.trim() || null,
    seriesOrder: seriesOrder === "" || seriesOrder == null ? null : Number(seriesOrder),
  });
  maybeNotifyPublished(post); // background, no await
  invalidate("posts:");
  res.status(201).json(post);
});

app.put("/api/admin/posts/:id", requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  const { title, subtitle, body, tags, action, publishAt, coverImage, series, seriesOrder } = req.body || {};

  // Snapshot the pre-edit state before overwriting it — only when body is
  // actually part of this request (a status-only publish/schedule action
  // doesn't touch content, so it doesn't need a revision).
  if (body !== undefined) {
    const before = await db.getPostById(id);
    if (before) await db.saveRevision(before);
  }

  const fields = {};
  if (title !== undefined) fields.title = title.trim();
  if (subtitle !== undefined) fields.subtitle = subtitle?.trim() || null;
  if (body !== undefined) fields.body = body;
  if (tags !== undefined) fields.tags = parseTags(tags);
  if (coverImage !== undefined) fields.coverImage = coverImage || null;
  if (series !== undefined) fields.series = series?.trim() || null;
  if (seriesOrder !== undefined) fields.seriesOrder = seriesOrder === "" || seriesOrder == null ? null : Number(seriesOrder);
  if (action !== undefined) {
    const r = resolveStatus({ action, publishAt });
    fields.status = r.status;
    fields.publishAt = r.publishAt;
  }
  const updated = await db.updatePost(id, fields);
  if (!updated) return res.status(404).json({ error: "Post not found" });
  maybeNotifyPublished(updated); // background, no await
  invalidate("posts:");
  res.json(updated);
});

// Revision history for the editor's "History" panel — newest first.
app.get("/api/admin/posts/:id/revisions", requireAuth, async (req, res) => {
  res.json(await db.listRevisions(Number(req.params.id)));
});

// Restore a revision. Snapshots the current (about-to-be-overwritten) state
// first, so restoring is itself undo-able rather than a one-way trip.
app.post("/api/admin/revisions/:id/restore", requireAuth, async (req, res) => {
  const revision = await db.getRevision(Number(req.params.id));
  if (!revision) return res.status(404).json({ error: "Revision not found" });
  const current = await db.getPostById(revision.postId);
  if (!current) return res.status(404).json({ error: "Post no longer exists" });
  await db.saveRevision(current);
  const updated = await db.updatePost(revision.postId, {
    title: revision.title,
    subtitle: revision.subtitle,
    body: revision.body,
    tags: revision.tags,
    coverImage: revision.coverImage,
    series: revision.series,
    seriesOrder: revision.seriesOrder,
  });
  invalidate("posts:");
  res.json(updated);
});

// Draft share/preview link: an unlisted token so someone without an
// account — a friend, a mentor — can view a draft (or scheduled post)
// before it's actually published, for feedback. Generating a new one
// replaces any existing token (only one active link per post at a time).
app.post("/api/admin/posts/:id/preview-link", requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  const post = await db.getPostById(id);
  if (!post) return res.status(404).json({ error: "Post not found" });
  const updated = await db.setPreviewToken(id, crypto.randomBytes(16).toString("hex"));
  res.json({ token: updated.previewToken });
});
app.delete("/api/admin/posts/:id/preview-link", requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  const post = await db.getPostById(id);
  if (!post) return res.status(404).json({ error: "Post not found" });
  await db.setPreviewToken(id, null);
  res.json({ ok: true });
});

app.delete("/api/admin/posts/:id", requireAuth, async (req, res) => {
  const ok = await db.deletePost(Number(req.params.id));
  if (!ok) return res.status(404).json({ error: "Post not found" });
  invalidate("posts:");
  res.json({ ok: true });
});

// Bulk actions from the dashboard: delete several posts at once, or move a
// set to draft/published in one request. Each id is processed with the same
// single-item db helpers, so behaviour stays identical to acting one by one.
app.post("/api/admin/posts/bulk", requireAuth, async (req, res) => {
  const { ids, action } = req.body || {};
  if (!Array.isArray(ids) || !ids.length) {
    return res.status(400).json({ error: "No posts selected" });
  }
  const numIds = ids.map(Number).filter((n) => Number.isInteger(n));
  let affected = 0;
  if (action === "delete") {
    for (const id of numIds) if (await db.deletePost(id)) affected++;
  } else if (action === "publish" || action === "draft") {
    const fields = action === "publish"
      ? { status: "published", publishAt: null }
      : { status: "draft", publishAt: null };
    for (const id of numIds) if (await db.updatePost(id, fields)) affected++;
  } else {
    return res.status(400).json({ error: "Unknown bulk action" });
  }
  invalidate("posts:");
  res.json({ ok: true, affected });
});

// Serve the SPA shell but with this post's own title/excerpt/cover image
// swapped into the meta tags, so link previews on Discord/Twitter/WhatsApp
// etc. show the actual post instead of the site-wide default. The front-end
// JS then boots normally and renders the article body as usual — this only
// changes what's in <head> before the page ever reaches the browser.
app.get("/p/:slug", async (req, res, next) => {
  try {
    const post = await db.getPostBySlug(req.params.slug);
    const isLive =
      post && post.status === "published" &&
      (!post.publishAt || post.publishAt <= Date.now());
    if (!isLive) return next(); // let the SPA fallback show its own not-found state

    const origin = `${req.protocol}://${req.get("host")}`;
    const html = injectPostMeta(INDEX_HTML, {
      title: `Nalar | ${post.title}`,
      description: post.subtitle || post.excerpt || "Notes on what I build and why — by Rafi Arsya.",
      url: `${origin}/p/${post.slug}`,
      image: post.coverImage
        ? (post.coverImage.startsWith("http") ? post.coverImage : `${origin}${post.coverImage}`)
        : `${origin}/img/og-default.jpg`,
    });
    res.send(html);
  } catch (e) {
    next();
  }
});

// SPA fallback.
app.get(/^(?!\/api).*/, (req, res) => {
  res.sendFile(join(__dirname, "..", "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`Nalar running on http://localhost:${PORT}`);
  startScheduler();
});