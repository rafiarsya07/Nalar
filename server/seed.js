// seed.js — admin user + sample posts. Run: npm run seed
import "dotenv/config";
import pg from "pg";
import { hashPassword } from "./auth.js";

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const ADMIN_USER = process.env.ADMIN_USER || "rafi";
const ADMIN_PASS = process.env.ADMIN_PASS || "admin123";

const samples = [
  {
    title: "Why I gave CampusBay a JWT dual-token strategy",
    slug: "campusbay-jwt-dual-token",
    tags: ["auth", "backend", "security"],
    status: "published",
    body: `When I built CampusBay's auth, a single long-lived token felt wrong. If it leaks, the attacker has weeks of access and no way to cut it off.

## The setup

I split the problem in two: a **short-lived access token** the API checks on every request, and a **longer-lived refresh token** that mints new ones.

The piece people skip is **logout**. A JWT is stateless, so logging out doesn't invalidate anything on its own. To make logout real, I keep a **Redis blacklist** of revoked tokens with a TTL matching the token's remaining life.

> The token must verify cryptographically *and* not be on the blacklist.

Small amount of code, big jump in control.`,
  },
  {
    title: "Making a multiplayer game where the client can't cheat",
    slug: "arena-duel-server-authoritative",
    tags: ["realtime", "game-dev", "architecture"],
    status: "published",
    body: `The first version of Arena Duel let the client report its own actions. Predictably, a cheater's dream.

## Server as the single source of truth

I rebuilt it so the **server owns all state**. The client sends only *intent*; the server decides what happens. Every rule — cooldowns, timing, valid moves — is enforced server-side through an explicit state machine:

\`\`\`
waiting -> countdown -> selecting -> resolving -> ended
\`\`\`

A modified client can lie all it wants; the server doesn't believe it.`,
  },
  {
    title: "What actually broke the first time I deployed this",
    slug: "first-deploy-what-broke",
    tags: ["devops", "postgresql"],
    status: "draft",
    body: `Draft — notes on the first deploy: port conflicts, a process manager over npm start, and the database that would not start...`,
  },
];

try {
  await pool.query("TRUNCATE posts RESTART IDENTITY CASCADE");
  await pool.query("TRUNCATE users RESTART IDENTITY CASCADE");

  const passwordHash = await hashPassword(ADMIN_PASS);
  await pool.query(
    "INSERT INTO users (username, password_hash) VALUES ($1, $2)",
    [ADMIN_USER, passwordHash]
  );

  for (const p of samples) {
    await pool.query(
      `INSERT INTO posts (title, slug, body, tags, status, published)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [p.title, p.slug, p.body, p.tags, p.status, p.status === "published"]
    );
  }

  console.log(`Seeded. Admin login -> username: ${ADMIN_USER}  password: ${ADMIN_PASS}`);
  console.log("(2 published, 1 draft)");
} catch (err) {
  console.error("Seed failed:", err.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
