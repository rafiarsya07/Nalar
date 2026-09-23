// ---------------------------------------------------------------------------
// db.js — Data layer (PostgreSQL)
//
// The ONLY file that talks to the database. Everything else calls these
// functions. Post status is a small state machine: draft -> scheduled ->
// published. "scheduled" posts auto-flip to "published" once publish_at passes
// (see scheduler.js).
// ---------------------------------------------------------------------------

import pg from "pg";
import crypto from "crypto";

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// Columns selected for list views (no body — we ship an excerpt instead).
const LIST_COLS = `id, title, subtitle, slug, tags, status, views, cover_image, pinned,
                   publish_at, created_at, updated_at, body, series, series_order`;

// --- Public reads ----------------------------------------------------------

// Only truly-published posts (status published AND publish_at in the past or null).
export async function listPublishedPosts() {
  const { rows } = await pool.query(
    `SELECT ${LIST_COLS} FROM posts
      WHERE status = 'published'
        AND (publish_at IS NULL OR publish_at <= now())
      ORDER BY pinned DESC, COALESCE(publish_at, created_at) DESC`
  );
  return rows.map(rowToPost).map(stripBody);
}

// Posts sharing at least one tag with the given post, excluding itself.
export async function relatedPosts(postId, tags, limit = 3) {
  if (!tags || tags.length === 0) return [];
  const { rows } = await pool.query(
    `SELECT ${LIST_COLS} FROM posts
      WHERE status = 'published'
        AND (publish_at IS NULL OR publish_at <= now())
        AND id <> $1
        AND tags && $2
      ORDER BY created_at DESC
      LIMIT $3`,
    [postId, tags, limit]
  );
  return rows.map(rowToPost).map(stripBody);
}

// All published posts in the same series, ordered by series_order (nulls
// last, so an unordered post just falls to the end) then publish date.
// Used to build the "Part X of Y" badge and prev/next-in-series links.
export async function seriesPosts(seriesName) {
  if (!seriesName) return [];
  const { rows } = await pool.query(
    `SELECT id, title, slug, cover_image, series_order, publish_at, created_at FROM posts
      WHERE status = 'published'
        AND (publish_at IS NULL OR publish_at <= now())
        AND series = $1
      ORDER BY series_order ASC NULLS LAST, COALESCE(publish_at, created_at) ASC`,
    [seriesName]
  );
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    slug: r.slug,
    coverImage: r.cover_image || null,
    seriesOrder: r.series_order ?? null,
  }));
}

// Every distinct series with 1+ published posts, each with its ordered
// parts attached — powers the /series index page. A series with only one
// post still gets listed here (it just won't show the in-post series box,
// since that only appears once there's something to navigate between).
export async function listSeriesGroups() {
  const { rows } = await pool.query(
    `SELECT series, MAX(COALESCE(publish_at, created_at)) AS latest
       FROM posts
      WHERE status = 'published'
        AND (publish_at IS NULL OR publish_at <= now())
        AND series IS NOT NULL AND series <> ''
      GROUP BY series
      ORDER BY latest DESC`
  );
  const groups = [];
  for (const r of rows) {
    const posts = await seriesPosts(r.series);
    if (posts.length) groups.push({ name: r.series, count: posts.length, posts });
  }
  return groups;
}

// All published posts carrying a specific tag.
export async function postsByTag(tag) {
  const { rows } = await pool.query(
    `SELECT ${LIST_COLS} FROM posts
      WHERE status = 'published'
        AND (publish_at IS NULL OR publish_at <= now())
        AND $1 = ANY(tags)
      ORDER BY pinned DESC, created_at DESC`,
    [tag]
  );
  return rows.map(rowToPost).map(stripBody);
}

// Distinct tags across published posts, with counts (for a tag cloud).
export async function tagCounts() {
  const { rows } = await pool.query(
    `SELECT tag, count(*)::int AS count
       FROM posts, unnest(tags) AS tag
      WHERE status = 'published'
        AND (publish_at IS NULL OR publish_at <= now())
      GROUP BY tag ORDER BY count DESC, tag ASC`
  );
  return rows;
}

// --- Admin reads -----------------------------------------------------------

export async function listAllPosts() {
  const { rows } = await pool.query(`SELECT ${LIST_COLS} FROM posts ORDER BY pinned DESC, created_at DESC`);
  return rows.map(rowToPost).map(stripBody);
}

// Aggregate stats for the admin dashboard.
export async function adminStats() {
  const { rows } = await pool.query(
    `SELECT
       count(*)::int AS total,
       count(*) FILTER (WHERE status = 'published')::int AS published,
       count(*) FILTER (WHERE status = 'draft')::int AS drafts,
       count(*) FILTER (WHERE status = 'scheduled')::int AS scheduled,
       COALESCE(sum(views), 0)::int AS total_views
     FROM posts`
  );
  const { rows: commentRows } = await pool.query(`SELECT COUNT(*)::int AS count FROM comments`);
  const subs = await subscriberCount();
  return { ...rows[0], total_comments: commentRows[0].count, total_subscribers: subs };
}

// Top posts by views, for the admin "what's popular" panel.
export async function topPosts(limit = 5) {
  const { rows } = await pool.query(
    `SELECT id, title, slug, views,
            (SELECT COUNT(*) FROM comments c WHERE c.post_id = posts.id)::int AS comment_count
       FROM posts
      WHERE status = 'published'
      ORDER BY views DESC
      LIMIT $1`,
    [limit]
  );
  return rows.map((r) => ({ id: r.id, title: r.title, slug: r.slug, views: r.views, commentCount: r.comment_count }));
}

// --- Single post -----------------------------------------------------------

export async function getPostBySlug(slug) {
  const { rows } = await pool.query(`SELECT * FROM posts WHERE slug = $1`, [slug]);
  return rows[0] ? rowToPost(rows[0]) : null;
}

export async function getPostById(id) {
  const { rows } = await pool.query(`SELECT * FROM posts WHERE id = $1`, [id]);
  return rows[0] ? rowToPost(rows[0]) : null;
}

// --- Search ----------------------------------------------------------------

export async function searchPosts(query) {
  const { rows } = await pool.query(
    `SELECT ${LIST_COLS},
            ts_rank(search_vector, plainto_tsquery('english', $1)) AS rank
       FROM posts
      WHERE status = 'published'
        AND (publish_at IS NULL OR publish_at <= now())
        AND search_vector @@ plainto_tsquery('english', $1)
      ORDER BY rank DESC`,
    [query]
  );
  return rows.map(rowToPost).map(stripBody);
}

// --- Writes ----------------------------------------------------------------

export async function createPost({ title, subtitle, slug, body, tags, status, publishAt, coverImage, series, seriesOrder }) {
  const { rows } = await pool.query(
    `INSERT INTO posts (title, subtitle, slug, body, tags, status, publish_at, cover_image, series, series_order)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING *`,
    [title, subtitle || null, slug, body, tags || [], status || "draft", publishAt || null, coverImage || null, series || null, seriesOrder ?? null]
  );
  return rowToPost(rows[0]);
}

export async function updatePost(id, fields) {
  const sets = [];
  const vals = [];
  let i = 1;
  for (const [key, val] of Object.entries(fields)) {
    sets.push(`${columnFor(key)} = $${i++}`);
    vals.push(val);
  }
  if (sets.length === 0) return getPostById(id);
  sets.push(`updated_at = now()`);
  vals.push(id);
  const { rows } = await pool.query(
    `UPDATE posts SET ${sets.join(", ")} WHERE id = $${i} RETURNING *`,
    vals
  );
  return rows[0] ? rowToPost(rows[0]) : null;
}

// --- Draft revision history -------------------------------------------------
// Called with a post's *current* state right before a content-changing edit
// overwrites it. Keeps only the most recent 20 snapshots per post.
export async function saveRevision(post) {
  await pool.query(
    `INSERT INTO post_revisions (post_id, title, subtitle, body, tags, cover_image, series, series_order)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [post.id, post.title, post.subtitle || null, post.body, post.tags || [], post.coverImage || null, post.series || null, post.seriesOrder ?? null]
  );
  await pool.query(
    `DELETE FROM post_revisions WHERE post_id = $1 AND id NOT IN (
       SELECT id FROM post_revisions WHERE post_id = $1 ORDER BY created_at DESC LIMIT 20
     )`,
    [post.id]
  );
}

// Lightweight list for the editor's history panel — no body text, just
// enough to label each entry (title + when).
export async function listRevisions(postId) {
  const { rows } = await pool.query(
    `SELECT id, title, created_at FROM post_revisions WHERE post_id = $1 ORDER BY created_at DESC`,
    [postId]
  );
  return rows.map((r) => ({ id: r.id, title: r.title, createdAt: r.created_at }));
}

// Full content of one revision — used both to preview and to restore.
export async function getRevision(id) {
  const { rows } = await pool.query(`SELECT * FROM post_revisions WHERE id = $1`, [id]);
  if (!rows[0]) return null;
  const r = rows[0];
  return {
    id: r.id,
    postId: r.post_id,
    title: r.title,
    subtitle: r.subtitle || null,
    body: r.body,
    tags: r.tags || [],
    coverImage: r.cover_image || null,
    series: r.series || null,
    seriesOrder: r.series_order ?? null,
    createdAt: r.created_at,
  };
}

export async function deletePost(id) {
  const { rowCount } = await pool.query(`DELETE FROM posts WHERE id = $1`, [id]);
  return rowCount > 0;
}

// Flip a post's pinned state and return the new value. Pinned posts sort
// first everywhere (homepage, tag pages, admin list) — a lightweight way to
// say "this is my best work" without a whole curation system.
export async function togglePostPinned(id) {
  const { rows } = await pool.query(
    `UPDATE posts SET pinned = NOT pinned WHERE id = $1 RETURNING pinned`,
    [id]
  );
  return rows[0] ? rows[0].pinned : null;
}

export async function incrementViews(slug) {
  await pool.query(`UPDATE posts SET views = views + 1 WHERE slug = $1`, [slug]);
}

// The scheduler calls this: flip any scheduled post whose time has come.
// Returns the rows it published so the caller can log them.
export async function publishDuePosts() {
  const { rows } = await pool.query(
    `UPDATE posts
        SET status = 'published', updated_at = now()
      WHERE status = 'scheduled' AND publish_at <= now()
      RETURNING id, title, slug, notified`
  );
  return rows;
}

// --- Users -----------------------------------------------------------------

export async function getUserByUsername(username) {
  const { rows } = await pool.query(`SELECT * FROM users WHERE username = $1`, [username]);
  return rows[0]
    ? { id: rows[0].id, username: rows[0].username, passwordHash: rows[0].password_hash }
    : null;
}

export async function createUser({ username, passwordHash }) {
  try {
    const { rows } = await pool.query(
      `INSERT INTO users (username, password_hash) VALUES ($1, $2) RETURNING *`,
      [username, passwordHash]
    );
    return { id: rows[0].id, username: rows[0].username };
  } catch {
    return null;
  }
}

// --- Comments ----------------------------------------------------------

// Returns top-level comments, each with a `replies` array (admin answers and
// any nested comments). Edit tokens are never sent to the client; ownership
// is checked server-side when an edit/delete comes in.
export async function listComments(postId) {
  const { rows } = await pool.query(
    `SELECT id, parent_id, author, body, rating, is_admin, pinned, created_at, updated_at
       FROM comments
      WHERE post_id = $1 AND approved = TRUE
      ORDER BY created_at ASC`,
    [postId]
  );
  const map = new Map();
  const roots = [];
  for (const r of rows) {
    const c = {
      id: r.id,
      parentId: r.parent_id,
      author: r.author,
      body: r.body,
      rating: r.rating,
      isAdmin: r.is_admin,
      pinned: r.pinned || false,
      createdAt: new Date(r.created_at).getTime(),
      updatedAt: r.updated_at ? new Date(r.updated_at).getTime() : null,
      replies: [],
    };
    map.set(c.id, c);
  }
  for (const c of map.values()) {
    if (c.parentId && map.has(c.parentId)) map.get(c.parentId).replies.push(c);
    else roots.push(c);
  }
  // Pinned top-level comments float up top; replies stay chronological
  // under their own parent regardless (a reply being pinned wouldn't make
  // sense divorced from its thread).
  roots.sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0));
  return roots;
}

// Flip a comment's pinned state and return the new value.
export async function toggleCommentPinned(id) {
  const { rows } = await pool.query(
    `UPDATE comments SET pinned = NOT pinned WHERE id = $1 RETURNING pinned`,
    [id]
  );
  return rows[0] ? rows[0].pinned : null;
}

export async function createComment({ postId, author, email, body, rating, isAdmin = false, parentId = null }) {
  const editToken = crypto.randomBytes(18).toString("hex");
  const { rows } = await pool.query(
    `INSERT INTO comments (post_id, author, email, body, rating, is_admin, parent_id, edit_token)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id, author, body, rating, is_admin, parent_id, created_at, updated_at`,
    [postId, author, email || null, body, rating || null, isAdmin, parentId, editToken]
  );
  const r = rows[0];
  return {
    id: r.id,
    parentId: r.parent_id,
    author: r.author,
    body: r.body,
    rating: r.rating,
    isAdmin: r.is_admin,
    createdAt: new Date(r.created_at).getTime(),
    updatedAt: r.updated_at ? new Date(r.updated_at).getTime() : null,
    replies: [],
    editToken, // returned ONCE to the author, then forgotten by the client side
  };
}

// Edit a comment's body. If `token` is given it must match (anonymous author);
// if `admin` is true the check is skipped. Returns the updated row or null.
export async function updateComment(id, body, { token = null, admin = false } = {}) {
  const where = admin ? `id = $2` : `id = $2 AND edit_token = $3`;
  const params = admin ? [body, id] : [body, id, token];
  const { rows } = await pool.query(
    `UPDATE comments SET body = $1, updated_at = now() WHERE ${where}
     RETURNING id, author, body, rating, is_admin, parent_id, created_at, updated_at`,
    params
  );
  if (!rows[0]) return null;
  const r = rows[0];
  return {
    id: r.id, parentId: r.parent_id, author: r.author, body: r.body,
    rating: r.rating, isAdmin: r.is_admin,
    createdAt: new Date(r.created_at).getTime(),
    updatedAt: r.updated_at ? new Date(r.updated_at).getTime() : null,
  };
}

export async function deleteComment(id) {
  const { rowCount } = await pool.query(`DELETE FROM comments WHERE id = $1`, [id]);
  return rowCount > 0;
}

// Raw row for a single comment — used when posting an admin reply so we can
// find which post the parent belongs to.
export async function getCommentById(id) {
  const { rows } = await pool.query(`SELECT * FROM comments WHERE id = $1`, [id]);
  return rows[0] || null;
}

// Anonymous author deleting their own comment: only succeeds with the token.
export async function deleteCommentByToken(id, token) {
  const { rowCount } = await pool.query(
    `DELETE FROM comments WHERE id = $1 AND edit_token = $2`,
    [id, token]
  );
  return rowCount > 0;
}

// Average rating + count, used on the post page and admin dashboard.
export async function ratingSummary(postId) {
  const { rows } = await pool.query(
    `SELECT COUNT(rating)::int AS count, COALESCE(AVG(rating), 0)::float AS average
       FROM comments WHERE post_id = $1 AND rating IS NOT NULL AND approved = TRUE`,
    [postId]
  );
  return { count: rows[0].count, average: Math.round(rows[0].average * 10) / 10 };
}

// --- Reactions ---------------------------------------------------------

// Counts per emoji for a post, e.g. { "👍": 4, "🔥": 1 }.
export async function reactionCounts(postId) {
  const { rows } = await pool.query(
    `SELECT emoji, COUNT(*)::int AS count FROM reactions WHERE post_id = $1 GROUP BY emoji`,
    [postId]
  );
  return Object.fromEntries(rows.map((r) => [r.emoji, r.count]));
}

// Which emoji(s) this visitor already picked for this post (so the UI can
// show them as already-selected instead of letting the same browser stack
// up infinite reactions).
export async function visitorReactions(postId, visitorId) {
  const { rows } = await pool.query(
    `SELECT emoji FROM reactions WHERE post_id = $1 AND visitor_id = $2`,
    [postId, visitorId]
  );
  return rows.map((r) => r.emoji);
}

// Toggle: if this visitor already reacted with this emoji, remove it;
// otherwise add it. Returns the new state (added: true/false) plus fresh
// counts so the caller can update the UI in one round trip.
export async function toggleReaction(postId, visitorId, emoji) {
  const { rowCount } = await pool.query(
    `DELETE FROM reactions WHERE post_id = $1 AND visitor_id = $2 AND emoji = $3`,
    [postId, visitorId, emoji]
  );
  let added = false;
  if (rowCount === 0) {
    await pool.query(
      `INSERT INTO reactions (post_id, visitor_id, emoji) VALUES ($1, $2, $3)
       ON CONFLICT DO NOTHING`,
      [postId, visitorId, emoji]
    );
    added = true;
  }
  return { added, counts: await reactionCounts(postId) };
}

// --- Newsletter subscribers ---------------------------------------------

export async function addSubscriber(email) {
  try {
    await pool.query(
      `INSERT INTO subscribers (email) VALUES ($1) ON CONFLICT (email) DO NOTHING`,
      [email]
    );
    return true;
  } catch {
    return false;
  }
}

export async function subscriberCount() {
  const { rows } = await pool.query(`SELECT COUNT(*)::int AS count FROM subscribers`);
  return rows[0].count;
}

export async function listSubscribers() {
  const { rows } = await pool.query(`SELECT email, created_at FROM subscribers ORDER BY created_at DESC`);
  return rows.map((r) => ({ email: r.email, createdAt: new Date(r.created_at).getTime() }));
}

// Just the addresses, for fan-out emails.
export async function getSubscriberEmails() {
  const { rows } = await pool.query(`SELECT email FROM subscribers ORDER BY created_at ASC`);
  return rows.map((r) => r.email);
}

// --- Draft share/preview links ----------------------------------------------
// token=null revokes an existing link.
export async function setPreviewToken(id, token) {
  const { rows } = await pool.query(
    `UPDATE posts SET preview_token = $1 WHERE id = $2 RETURNING *`,
    [token, id]
  );
  return rows[0] ? rowToPost(rows[0]) : null;
}
export async function getPostByPreviewToken(token) {
  const { rows } = await pool.query(`SELECT * FROM posts WHERE preview_token = $1`, [token]);
  return rows[0] ? rowToPost(rows[0]) : null;
}

// Mark a post as "subscribers already emailed" so we never double-send.
export async function markNotified(id) {
  await pool.query(`UPDATE posts SET notified = TRUE WHERE id = $1`, [id]);
}

// --- helpers ---------------------------------------------------------------

function rowToPost(r) {
  return {
    id: r.id,
    title: r.title,
    subtitle: r.subtitle || null,
    slug: r.slug,
    body: r.body,
    tags: r.tags || [],
    status: r.status,
    views: r.views,
    coverImage: r.cover_image || null,
    pinned: r.pinned || false,
    series: r.series || null,
    seriesOrder: r.series_order ?? null,
    previewToken: r.preview_token || null,
    publishAt: r.publish_at ? new Date(r.publish_at).getTime() : null,
    createdAt: new Date(r.created_at).getTime(),
    updatedAt: new Date(r.updated_at).getTime(),
    notified: r.notified || false,
    // Reading time: ~200 words per minute, min 1.
    readingTime: r.body ? Math.max(1, Math.round(r.body.split(/\s+/).length / 200)) : 1,
  };
}

function columnFor(key) {
  const map = {
    createdAt: "created_at",
    updatedAt: "updated_at",
    publishAt: "publish_at",
    coverImage: "cover_image",
    seriesOrder: "series_order",
  };
  return map[key] || key;
}

function stripBody(p) {
  const { body, ...rest } = p;
  const excerpt = (body || "")
    .replace(/!\[.*?\]\(.*?\)/g, "")   // remove images ![alt](url)
    .replace(/\[.*?\]\(.*?\)/g, "")    // remove links [text](url)
    .replace(/[#*`>_~]/g, "")          // remove markdown symbols
    .replace(/\s+/g, " ")              // collapse whitespace
    .trim()
    .slice(0, 160)
    .trim();
  return { ...rest, excerpt: excerpt + ((body || "").length > 160 ? "…" : "") };
}