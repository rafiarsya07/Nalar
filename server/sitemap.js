// ---------------------------------------------------------------------------
// sitemap.js — sitemap.xml generation for search engines.
//
// One function: take the list of published posts, the distinct tags, and
// the site's public origin, return an XML string. Same no-dependency
// approach as rss.js — the format is simple enough to template directly.
// ---------------------------------------------------------------------------

function escapeXml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function urlEntry(loc, lastmod, changefreq, priority) {
  return `  <url>
    <loc>${escapeXml(loc)}</loc>
    ${lastmod ? `<lastmod>${lastmod}</lastmod>` : ""}
    <changefreq>${changefreq}</changefreq>
    <priority>${priority}</priority>
  </url>`;
}

export function buildSitemap(posts, tags, origin) {
  const staticPages = [
    { path: "/", changefreq: "daily", priority: "1.0" },
    { path: "/archive", changefreq: "weekly", priority: "0.6" },
    { path: "/about", changefreq: "monthly", priority: "0.5" },
  ];

  const entries = [
    ...staticPages.map((p) => urlEntry(`${origin}${p.path}`, null, p.changefreq, p.priority)),
    ...posts.map((p) =>
      urlEntry(
        `${origin}/p/${p.slug}`,
        new Date(p.updatedAt || p.publishAt || p.createdAt).toISOString(),
        "monthly",
        "0.8"
      )
    ),
    ...(tags || []).map((t) =>
      urlEntry(`${origin}/tag/${encodeURIComponent(t.tag)}`, null, "weekly", "0.4")
    ),
  ].join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${entries}
</urlset>`;
}
