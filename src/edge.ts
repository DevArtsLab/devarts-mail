// Host-based edge routing:
//   docs.<domain>     -> reverse-proxy to the public Notion site
//   <domain> / www.   -> DevArts Lab landing page
//   mail.<domain> / workers.dev -> the mail app (handled by caller)

import type { Env } from "./types";

const NOTION_ORIGIN = "https://www.notion.so";

const DROP_RESPONSE_HEADERS = new Set([
  "content-encoding",
  "content-length",
  "transfer-encoding",
  "content-security-policy",
  "content-security-policy-report-only",
  "set-cookie",
  "x-frame-options",
  "report-to",
  "nel",
]);

// docs.<domain> -> Notion public site, served under our hostname.
export async function proxyNotion(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname === "/" ? `/${env.NOTION_PAGE_ID}` : url.pathname;
  const upstream = new URL(path + url.search, NOTION_ORIGIN);

  const headers = new Headers();
  for (const [k, v] of request.headers) {
    const lk = k.toLowerCase();
    if (["host", "cookie", "cf-connecting-ip", "cf-ray", "cf-visitor", "x-forwarded-for", "x-forwarded-proto"].includes(lk)) continue;
    headers.set(k, v);
  }
  headers.set("host", "www.notion.so");

  const upstreamResp = await fetch(upstream.toString(), {
    method: request.method === "POST" ? "GET" : request.method,
    headers,
    redirect: "follow",
  });

  const outHeaders = new Headers();
  for (const [k, v] of upstreamResp.headers) {
    if (DROP_RESPONSE_HEADERS.has(k.toLowerCase())) continue;
    outHeaders.set(k, v);
  }
  const loc = upstreamResp.headers.get("location");
  if (loc) outHeaders.set("location", rewriteNotionUrl(loc, env.DOCS_HOSTNAME));

  const ct = upstreamResp.headers.get("content-type") || "";
  if (ct.includes("text/html")) {
    const html = await upstreamResp.text();
    outHeaders.set("content-type", "text/html; charset=utf-8");
    return new Response(rewriteHtml(html, env.DOCS_HOSTNAME), {
      status: upstreamResp.status,
      headers: outHeaders,
    });
  }
  return new Response(upstreamResp.body, { status: upstreamResp.status, headers: outHeaders });
}

function rewriteNotionUrl(value: string, docsHost: string): string {
  return value
    .replace(/https:\/\/(www\.)?notion\.so/gi, `https://${docsHost}`)
    .replace(/https:\/\/[a-z0-9-]+\.notion\.site/gi, `https://${docsHost}`);
}

function rewriteHtml(html: string, docsHost: string): string {
  return rewriteNotionUrl(html, docsHost).replace(
    /<head>/i,
    '<head><link rel="icon" href="data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22><rect width=%22100%22 height=%22100%22 rx=%2220%22 fill=%22%23f6821f%22/><text x=%2250%22 y=%2268%22 font-size=%2260%22 text-anchor=%22middle%22 fill=%22white%22 font-family=%22sans-serif%22 font-weight=%22bold%22>D</text></svg>">',
  );
}

// apex / www -> minimal DevArts Lab landing page (template).
export function landingPage(env: Env): Response {
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>DevArts Lab</title>
<meta name="description" content="DevArts Lab - independent engineering studio">
<style>
  :root { --bg:#0b0d10; --panel:#12151a; --border:#23272e; --text:#e6e8eb; --muted:#8b9199; --accent:#f6821f; }
  * { box-sizing:border-box; margin:0; }
  body { background:var(--bg); color:var(--text); font:15px/1.6 -apple-system,"Inter","Segoe UI",system-ui,sans-serif;
         min-height:100vh; display:flex; flex-direction:column; }
  header { padding:20px 32px; display:flex; align-items:center; gap:10px; border-bottom:1px solid var(--border); }
  .logo { width:28px; height:28px; border-radius:8px; background:var(--accent); color:#fff; display:grid;
          place-items:center; font-weight:700; }
  main { flex:1; display:grid; place-items:center; padding:48px 24px; }
  .hero { text-align:center; max-width:560px; }
  h1 { font-size:40px; font-weight:700; letter-spacing:-0.02em; }
  h1 em { color:var(--accent); font-style:normal; }
  p.sub { color:var(--muted); margin:12px 0 36px; font-size:16px; }
  .cards { display:grid; grid-template-columns:repeat(auto-fit,minmax(160px,1fr)); gap:12px; }
  .card { background:var(--panel); border:1px solid var(--border); border-radius:12px; padding:20px;
          text-decoration:none; color:var(--text); transition:border-color .15s, transform .15s; }
  .card:hover { border-color:var(--accent); transform:translateY(-2px); }
  .card b { display:block; margin-bottom:4px; }
  .card span { color:var(--muted); font-size:13px; }
  footer { padding:18px 32px; border-top:1px solid var(--border); color:var(--muted); font-size:12px;
           display:flex; justify-content:space-between; }
  footer a { color:var(--muted); }
</style>
</head>
<body>
<header><div class="logo">D</div><b>DevArts Lab</b></header>
<main>
  <div class="hero">
    <h1>Dev<em>Arts</em> Lab</h1>
    <p class="sub">Independent engineering studio. Self-hosted mail, calendar, and docs on Cloudflare.</p>
    <div class="cards">
      <a class="card" href="https://mail.${env.MAIL_DOMAIN}"><b>Mail</b><span>mail.${env.MAIL_DOMAIN}</span></a>
      <a class="card" href="https://${env.DOCS_HOSTNAME}"><b>Docs</b><span>${env.DOCS_HOSTNAME}</span></a>
      <a class="card" href="https://github.com/DevArtsLab"><b>GitHub</b><span>github.com/DevArtsLab</span></a>
    </div>
  </div>
</main>
<footer><span>&copy; ${new Date().getUTCFullYear()} DevArts Lab</span><a href="mailto:contact@${env.MAIL_DOMAIN}">contact@${env.MAIL_DOMAIN}</a></footer>
</body>
</html>`;
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
}
