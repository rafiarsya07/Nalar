<?xml version="1.0" encoding="UTF-8"?>
<!--
  A browser opening /rss.xml gets this stylesheet applied and sees a readable
  page. Feed readers ignore it entirely and parse the raw RSS underneath, so
  nothing about the feed itself changes.
-->
<xsl:stylesheet version="1.0"
  xmlns:xsl="http://www.w3.org/1999/XSL/Transform"
  xmlns:atom="http://www.w3.org/2005/Atom">
  <xsl:output method="html" encoding="UTF-8" indent="yes"/>

  <xsl:template match="/">
    <html lang="en">
      <head>
        <meta charset="UTF-8"/>
        <meta name="viewport" content="width=device-width, initial-scale=1"/>
        <title><xsl:value-of select="/rss/channel/title"/> feed</title>
        <style>
          @font-face{font-family:"Fraunces";font-weight:100 900;font-display:swap;src:url(/fonts/fraunces-latin-wght-normal.woff2) format("woff2")}
          @font-face{font-family:"Instrument Sans";font-weight:400 700;font-display:swap;src:url(/fonts/instrument-sans-latin-wght-normal.woff2) format("woff2")}
          @font-face{font-family:"Source Serif 4";font-weight:200 900;font-display:swap;src:url(/fonts/source-serif-4-latin-wght-normal.woff2) format("woff2")}
          :root{--bg:#fbf8f2;--ink:#1a1814;--ink2:#55514a;--muted:#8a8274;--rule:#e4ddcf;--accent:#4e6b35;--gold:#b8921c}
          *{box-sizing:border-box;margin:0}
          body{background:var(--bg);color:var(--ink);font-family:"Instrument Sans",system-ui,sans-serif;line-height:1.6}
          .wrap{max-width:680px;margin:0 auto;padding:48px 24px 80px}
          .brand{display:flex;align-items:center;gap:10px;margin-bottom:34px}
          .brand img{width:30px;height:30px;border-radius:8px;display:block}
          .brand span{font-family:Fraunces,Georgia,serif;font-size:24px;font-weight:600;letter-spacing:-.02em}
          .note{border:1px solid var(--rule);border-top:3px solid var(--gold);border-radius:6px;padding:18px 20px;background:#faf7f1;margin-bottom:34px}
          .note h1{font-family:Fraunces,Georgia,serif;font-size:21px;font-weight:600;letter-spacing:-.02em;margin-bottom:8px}
          .note p{font-size:14.5px;color:var(--ink2);margin-bottom:10px}
          .note p:last-child{margin-bottom:0}
          .url{display:flex;gap:8px;align-items:center;margin-top:12px}
          .url code{flex:1;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12.5px;
            background:#fff;border:1px solid var(--rule);border-radius:8px;padding:9px 12px;overflow-wrap:anywhere}
          h2.sec{font-size:13px;font-weight:600;color:var(--muted);margin-bottom:6px}
          .item{padding:20px 0;border-bottom:1px solid var(--rule)}
          .item:last-child{border-bottom:none}
          .item a{font-family:Fraunces,Georgia,serif;font-size:21px;font-weight:600;letter-spacing:-.02em;color:var(--ink);text-decoration:none;line-height:1.3;display:block}
          .item a:hover{text-decoration:underline;text-underline-offset:3px}
          .item .date{font-size:12.5px;color:var(--muted);margin-bottom:6px}
          .item .desc{font-family:"Source Serif 4",Georgia,serif;font-size:16px;color:var(--ink2);margin-top:7px}
          .tags{margin-top:9px;display:flex;flex-wrap:wrap;gap:7px}
          .tags span{font-size:12px;color:var(--ink2);background:#faf7f1;border-radius:12px;padding:3px 10px}
          footer{margin-top:40px;padding-top:20px;border-top:1px solid var(--rule);font-size:12.5px;color:var(--muted)}
          footer a{color:var(--accent)}
          @media (prefers-color-scheme:dark){
            :root{--bg:#131211;--ink:#eae5db;--ink2:#b9b2a5;--muted:#8c8578;--rule:#2e2b26;--accent:#9db97a;--gold:#d6b24c}
            .note,.tags span{background:#1a1917}
            .url code{background:#1a1917}
          }
        </style>
      </head>
      <body>
        <div class="wrap">
          <div class="brand">
            <img src="/img/logo-icon.png" alt=""/>
            <span><xsl:value-of select="/rss/channel/title"/></span>
          </div>

          <div class="note">
            <h1>This page is a feed, not an article</h1>
            <p>You are looking at the RSS feed. Paste the address below into a
               feed reader such as Feedly, NetNewsWire, Inoreader or Thunderbird
               and you will get every new post automatically, with no email and
               no algorithm in between.</p>
            <div class="url">
              <code><xsl:value-of select="/rss/channel/atom:link/@href"/></code>
            </div>
            <p style="margin-top:12px">
              <a href="/" style="color:var(--accent)">Go to the site instead</a>
            </p>
          </div>

          <h2 class="sec">
            Latest posts in this feed
          </h2>
          <xsl:for-each select="/rss/channel/item">
            <div class="item">
              <div class="date"><xsl:value-of select="pubDate"/></div>
              <a href="{link}"><xsl:value-of select="title"/></a>
              <div class="desc"><xsl:value-of select="description"/></div>
              <div class="tags">
                <xsl:for-each select="category">
                  <span>#<xsl:value-of select="."/></span>
                </xsl:for-each>
              </div>
            </div>
          </xsl:for-each>

          <footer>
            <xsl:value-of select="/rss/channel/description"/>
            <br/>
            <a href="/">Open the site</a>
          </footer>
        </div>
      </body>
    </html>
  </xsl:template>
</xsl:stylesheet>
