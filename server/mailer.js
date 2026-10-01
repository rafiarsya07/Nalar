// ---------------------------------------------------------------------------
// mailer.js — Outgoing email (newsletter welcome + new-post notifications).
//
// Delivery is optional: if the SMTP_* env vars aren't set, every send becomes
// a no-op that just logs a line, so the rest of the app keeps working with no
// configuration. To turn real email on, set in .env:
//
//   SMTP_HOST=smtp.gmail.com
//   SMTP_PORT=465
//   SMTP_USER=you@gmail.com
//   SMTP_PASS=your-app-password        (Gmail: an "App Password", not your login)
//   SMTP_FROM="Nalar <you@gmail.com>"
//   SITE_URL=https://blog.rafiarsya.com
//
// Gmail note: enable 2FA, then create an App Password and use that as SMTP_PASS.
// ---------------------------------------------------------------------------

import nodemailer from "nodemailer";

const {
  SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM,
  SITE_URL = "https://blog.rafiarsya.com",
} = process.env;

const CONFIGURED = Boolean(SMTP_HOST && SMTP_USER && SMTP_PASS);
// The sender always shows up as "Nalar", whatever display name an older .env
// still carries in SMTP_FROM. Only the address part of SMTP_FROM is used.
const BRAND = "Nalar";
const FROM_ADDRESS = ((SMTP_FROM || "").match(/<([^>]+)>/)?.[1] || (SMTP_FROM || "").trim() || SMTP_USER || "").trim();
const FROM = FROM_ADDRESS ? { name: BRAND, address: FROM_ADDRESS } : BRAND;

let transporter = null;
if (CONFIGURED) {
  const port = Number(SMTP_PORT) || 465;
  transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port,
    secure: port === 465, // 465 = implicit TLS; 587 = STARTTLS
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });
  transporter.verify()
    .then(() => console.log("[mailer] SMTP ready —", SMTP_HOST))
    .catch((e) => console.warn("[mailer] SMTP verify failed:", e.message));
} else {
  console.log("[mailer] SMTP not configured — emails will be skipped (set SMTP_* in .env to enable).");
}

export function mailerEnabled() {
  return CONFIGURED;
}

// Low-level single send. Never throws to the caller; returns true/false.
async function sendOne({ to, subject, html, text }) {
  if (!transporter) {
    console.log(`[mailer] (skipped) → ${to} :: ${subject}`);
    return false;
  }
  try {
    await transporter.sendMail({ from: FROM, to, subject, html, text });
    return true;
  } catch (e) {
    console.warn(`[mailer] send to ${to} failed:`, e.message);
    return false;
  }
}

// Shared email shell. Same identity as the site: olive ink, a short gold bar
// under the wordmark (the bar from the logo), serif headline, quiet footer.
// Inline styles only, because email clients ignore <style> blocks.
const C = { ink: "#1a1814", ink2: "#55514a", muted: "#8b8478", rule: "#e7e1d4", paper: "#faf7f0", olive: "#4e6b35", gold: "#c9a227" };
const SERIF = "Georgia,'Times New Roman',serif";
const SANS = "-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const SITE_HOST = SITE_URL.replace(/^https?:\/\//, "");

const button = (href, label) =>
  `<a href="${href}" style="display:inline-block;background:${C.olive};color:#ffffff;text-decoration:none;font-family:${SANS};font-size:14px;font-weight:600;padding:11px 20px;border-radius:6px">${label}</a>`;

const kicker = (label) =>
  `<div style="font-family:${SANS};font-size:11px;font-weight:600;letter-spacing:.14em;text-transform:uppercase;color:${C.olive};margin:0 0 10px">${label}</div>`;

const wrap = (inner, note = `You get this because you subscribed at <a href="${SITE_URL}" style="color:${C.olive}">${SITE_HOST}</a>.`) => `
  <div style="background:${C.paper};padding:28px 12px">
    <div style="max-width:560px;margin:0 auto;background:#ffffff;border:1px solid ${C.rule};border-radius:10px;padding:30px 30px 24px;font-family:${SANS};color:${C.ink};line-height:1.6">
      <a href="${SITE_URL}" style="text-decoration:none;color:${C.ink}">
        <div style="font-family:${SERIF};font-size:26px;font-weight:600;letter-spacing:-.02em;line-height:1">${BRAND}</div>
        <div style="width:30px;height:4px;border-radius:2px;background:${C.gold};margin:8px 0 22px"></div>
      </a>
      ${inner}
      <div style="border-top:1px solid ${C.rule};margin:28px 0 0;padding-top:16px;font-size:12px;color:${C.muted}">
        ${BRAND}, writing to think, by Rafi Arsya.<br/>
        ${note}
      </div>
    </div>
  </div>`;

// Welcome email when someone subscribes.
export async function sendWelcome(to) {
  return sendOne({
    to,
    subject: "Welcome to Nalar",
    text: `Thanks for subscribing to Nalar. You will get one short email whenever a new post goes up.\n\n${SITE_URL}`,
    html: wrap(`
      ${kicker("Subscribed")}
      <div style="font-family:${SERIF};font-size:22px;font-weight:600;line-height:1.25;margin:0 0 12px">Thanks for reading along.</div>
      <p style="font-size:15px;color:${C.ink2};margin:0 0 20px">
        You will get one short email whenever a new post goes up on Nalar. No spam, and you can unsubscribe any time.
      </p>
      ${button(SITE_URL, "Read the latest")}
    `),
  });
}

// Fan-out a new post to every subscriber. Sent one message per address so
// addresses stay private. Returns how many were delivered.
export async function notifyNewPost(post, emails) {
  if (!emails?.length) return 0;
  const url = `${SITE_URL}/p/${post.slug}`;
  const excerpt = (post.body || "")
    .replace(/[#*`>_!\[\]]/g, "").replace(/\(.*?\)/g, "").replace(/\s+/g, " ")
    .trim().slice(0, 180);
  const subject = `New on Nalar: ${post.title}`;
  const html = wrap(`
    ${kicker("New on Nalar")}
    <a href="${url}" style="font-family:${SERIF};font-size:24px;font-weight:600;color:${C.ink};text-decoration:none;line-height:1.22;display:block;margin-bottom:12px">${escapeHtml(post.title)}</a>
    <p style="font-family:${SERIF};font-size:16px;color:${C.ink2};margin:0 0 22px">${escapeHtml(excerpt)}${excerpt.length >= 180 ? "…" : ""}</p>
    ${button(url, "Read the post")}
  `);
  const text = `New post on Nalar: ${post.title}\n\n${excerpt}\n\nRead it: ${url}`;

  let sent = 0;
  for (const to of emails) {
    if (await sendOne({ to, subject, html, text })) sent++;
  }
  console.log(`[mailer] new-post "${post.title}" → notified ${sent}/${emails.length}`);
  return sent;
}

function escapeHtml(s) {
  return String(s || "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// Ping the site owner whenever a reader leaves a new (top-level) comment, so
// it doesn't just sit there until the admin dashboard happens to get opened.
// Goes to ADMIN_EMAIL if set, otherwise falls back to the SMTP account
// itself — no separate config needed for the common case where they're
// the same inbox.
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || SMTP_USER;
export async function notifyNewComment(post, comment) {
  if (!ADMIN_EMAIL) return false;
  const url = `${SITE_URL}/p/${post.slug}#comment-${comment.id}`;
  const preview = (comment.body || "").trim().slice(0, 300);
  const subject = `Nalar: new comment on "${post.title}"`;
  const html = wrap(`
    ${kicker("New comment")}
    <p style="font-size:15px;margin:0 0 6px"><b>${escapeHtml(comment.author)}</b> commented on <a href="${url}" style="color:${C.olive};text-decoration:none">${escapeHtml(post.title)}</a></p>
    ${comment.rating ? `<div style="font-size:14px;color:${C.gold};letter-spacing:2px;margin:0 0 10px">${"★".repeat(comment.rating)}${"☆".repeat(5 - comment.rating)}</div>` : ""}
    <p style="font-family:${SERIF};font-size:16px;color:${C.ink2};margin:0 0 22px;white-space:pre-wrap;border-left:3px solid ${C.gold};padding-left:14px">${escapeHtml(preview)}${preview.length >= 300 ? "…" : ""}</p>
    ${button(url, "Reply on Nalar")}
  `, `Sent to you as the admin of <a href="${SITE_URL}" style="color:${C.olive}">${SITE_HOST}</a>.`);
  const text = `${comment.author} commented on "${post.title}":\n\n${preview}\n\nReply: ${url}`;
  return sendOne({ to: ADMIN_EMAIL, subject, html, text });
}
