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
const FROM = SMTP_FROM || (SMTP_USER ? `Nalar <${SMTP_USER}>` : "Nalar");

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

const wrap = (inner) => `
  <div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:560px;margin:0 auto;color:#1c1d1a;line-height:1.6">
    <div style="font-size:20px;font-weight:600;letter-spacing:-.03em;margin-bottom:18px"><span style="display:inline-block;width:24px;height:24px;line-height:24px;text-align:center;border-radius:6px;background:#4e6b35;color:#fff;font-size:14px;margin-right:8px">N</span>Nalar</div>
    ${inner}
    <hr style="border:none;border-top:1px solid #e6e4d9;margin:26px 0"/>
    <div style="font-size:12px;color:#92938a">
      You're getting this because you subscribed at
      <a href="${SITE_URL}" style="color:#4e6b35">${SITE_URL.replace(/^https?:\/\//, "")}</a>.
    </div>
  </div>`;

// Welcome email when someone subscribes.
export async function sendWelcome(to) {
  return sendOne({
    to,
    subject: "You are subscribed to Nalar",
    text: `Thanks for subscribing to Nalar. You will get an email whenever a new post goes up. ${SITE_URL}`,
    html: wrap(`
      <p style="font-size:16px;margin:0 0 14px">Thanks for subscribing 👋</p>
      <p style="font-size:15px;color:#55564f;margin:0 0 18px">
        You will get one short email whenever a new post goes up. No spam, unsubscribe any time.
      </p>
      <a href="${SITE_URL}" style="display:inline-block;background:#4e6b35;color:#fff;text-decoration:none;font-size:14px;padding:10px 18px;border-radius:8px">Read the latest →</a>
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
  const subject = `New post: ${post.title}`;
  const html = wrap(`
    <div style="font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:#92938a;margin-bottom:8px">New post</div>
    <a href="${url}" style="font-size:22px;font-weight:700;color:#1c1d1a;text-decoration:none;line-height:1.25;display:block;margin-bottom:12px">${escapeHtml(post.title)}</a>
    <p style="font-size:15px;color:#55564f;margin:0 0 20px">${escapeHtml(excerpt)}${excerpt.length >= 180 ? "…" : ""}</p>
    <a href="${url}" style="display:inline-block;background:#4e6b35;color:#fff;text-decoration:none;font-size:14px;padding:10px 18px;border-radius:8px">Read it →</a>
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
  const subject = `New comment on "${post.title}"`;
  const html = wrap(`
    <div style="font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:#92938a;margin-bottom:8px">New comment</div>
    <p style="font-size:15px;margin:0 0 4px"><b>${escapeHtml(comment.author)}</b> commented on <a href="${url}" style="color:#4e6b35;text-decoration:none">${escapeHtml(post.title)}</a>${comment.rating ? ` &middot; ${"★".repeat(comment.rating)}${"☆".repeat(5 - comment.rating)}` : ""}</p>
    <p style="font-size:15px;color:#55564f;margin:0 0 20px;white-space:pre-wrap;border-left:3px solid #e6e4d9;padding-left:14px">${escapeHtml(preview)}${preview.length >= 300 ? "…" : ""}</p>
    <a href="${url}" style="display:inline-block;background:#4e6b35;color:#fff;text-decoration:none;font-size:14px;padding:10px 18px;border-radius:8px">Reply on the site →</a>
  `);
  const text = `${comment.author} commented on "${post.title}":\n\n${preview}\n\nReply: ${url}`;
  return sendOne({ to: ADMIN_EMAIL, subject, html, text });
}
