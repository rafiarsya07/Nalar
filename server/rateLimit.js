// ---------------------------------------------------------------------------
// rateLimit.js — request throttling for endpoints that are cheap to abuse.
//
// Three tiers:
//   - loginLimiter    tight, per-IP. Slows down password guessing.
//   - writeLimiter    for anonymous writes (comments, reactions, subscribe).
//   - apiLimiter      loose net over the rest of /api, just so a scraper or
//                     misbehaving script can't hammer the DB for free.
// ---------------------------------------------------------------------------

import rateLimit from "express-rate-limit";

const standardHandler = (req, res) => {
  res.status(429).json({ error: "Too many requests — please slow down and try again shortly." });
};

export const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 min
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  handler: standardHandler,
});

export const writeLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  handler: standardHandler,
});

// Search hits the DB on every call and is trivially scriptable, so it gets a
// tighter, shorter window of its own: bursty typing is fine, a scraper is not.
export const searchLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 min
  limit: 40,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) =>
    res.status(429).json({ error: "Too many searches — give it a few seconds and try again." }),
});

export const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 300,
  standardHeaders: true,
  legacyHeaders: false,
  handler: standardHandler,
});
