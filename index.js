const http = require('http');
const https = require('https');

const PORT = process.env.PORT || 3000;
const CACHE_TTL_MS = 5 * 60 * 1000;

let cache = { posts: [], ts: 0 };

function fetch(url, timeout = 15000) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, {
      headers: {
        'User-Agent': 'LostSwordBot/1.0 (+https://github.com/LostSword)',
        'Accept': 'application/rss+xml, application/xml, text/xml, */*',
        'Cache-Control': 'no-cache'
      }
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', e => reject(e));
    req.setTimeout(timeout, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

function stripHtml(str) {
  return (str || '')
    .replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/\n{3,}/g, '\n\n').trim();
}

function parseRSSEntries(xml) {
  const entries = [];
  if (!xml || xml.length < 50) return entries;
  for (const tag of ['entry', 'item']) {
    let pos = 0, count = 0;
    while (count < 100) {
      const open = xml.indexOf(`<${tag}>`, pos);
      if (open === -1) break;
      const close = xml.indexOf(`</${tag}>`, open);
      if (close === -1) break;
      const block = xml.substring(open + tag.length + 2, close);
      const linkAttr = (block.match(/<link[^>]+href=["']([^"']+)["']/) || [])[1]
        || (block.match(/<link>([^<]+)<\/link>/) || [])[1] || '';
      const get = (t) => {
        const m = new RegExp(`<${t}[^>]*>([\\s\\S]*?)<\\/${t}>`, 'i').exec(block);
        return m ? stripHtml(m[1]) : '';
      };
      const id = get('id') || get('guid') || linkAttr;
      const title = get('title');
      const rawAuthor = get('author') || get('dc:creator') || '';
      const author = rawAuthor.split('http')[0].trim();
      const updated = get('updated') || get('published') || get('pubDate');
      if (title) entries.push({ id, title, author, link: linkAttr, updated });
      pos = close + tag.length + 3;
      count++;
    }
  }
  return entries;
}

function extractBody(html) {
  if (!html) return '';
  // old.reddit.com 格式
  const m = html.match(/<div[^>]+class="usertext-body[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
  if (m) return stripHtml(m[1]).substring(0, 400);
  // 新版 reddit
  const m2 = html.match(/<div[^>]+data-testid="post-text"[^>]*>([\s\S]*?)<\/div>/i);
  if (m2) return stripHtml(m2[1]).substring(0, 400);
  return '';
}

async function enrichWithBody(posts) {
  const top = posts.slice(0, 5);
  const results = await Promise.allSettled(
    top.map(async (p) => {
      // 试 old.reddit.com
      const oldUrl = p.link.replace('://www.reddit.com', '://old.reddit.com');
      try {
        const { status, body } = await fetch(oldUrl, 12000);
        if (status === 200) {
          const text = extractBody(body);
          if (text) return { ...p, body: text };
        }
      } catch(e) {}
      // 备用：直接用新链接
      try {
        const { status, body } = await fetch(p.link, 10000);
        if (status === 200) {
          const text = extractBody(body);
          if (text) return { ...p, body: text };
        }
      } catch(e) {}
      return p;
    })
  );
  const enrichedMap = {};
  for (const r of results) {
    if (r.status === 'fulfilled' && r.value?.link) enrichedMap[r.value.link] = r.value;
  }
  return posts.map(p => enrichedMap[p.link] || p);
}

async function fetchPosts() {
  const results = await Promise.allSettled([
    fetch('https://www.reddit.com/r/LostSwordOfficial/hot.rss'),
    fetch('https://www.reddit.com/r/LostSwordOfficial/new.rss'),
  ]);
  const all = [];
  for (const r of results) {
   if (r.status === 'fulfilled' && r.value.status === 200 && r.value.body)
      all.push(...parseRSSEntries(r.value.body));
  }
  const seen = new Set();
  const deduped = all.filter(e => {
    const key = e.link || e.id;
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return await enrichWithBody(deduped);
}

async function getPosts() {
  const now = Date.now();
  if (cache.posts.length > 0 && (now - cache.ts) < CACHE_TTL_MS) return cache.posts;
  try {
    cache.posts = await fetchPosts();
    cache.ts = now;
  } catch(e) { if (cache.posts.length === 0) throw e; }
  return cache.posts;
}

(async () => {
  console.error('[Startup] Warming cache...');
  try {
    const posts = await fetchPosts();
    cache.posts = posts;
    cache.ts = Date.now();
    console.error(`[Startup] Got ${posts.length} posts`);
    const withBody = posts.filter(p => p.body).length;
    console.error(`[Startup] ${withBody} posts have body text`);
  } catch(e) { console.error('[Startup] Failed:', e.message); }
})();

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');
  try {
    if (url.pathname === '/health') {
      res.end(JSON.stringify({ ok: true, ts: Date.now(), posts: cache.posts.length }));
      return;
    }
    if (url.pathname === '/push') {
      const posts = await getPosts();
      res.end(JSON.stringify({ posts: posts.slice(0, 10), ts: Date.now() }));
      return;
    }
    res.statusCode = 404; res.end(JSON.stringify({ error: 'not found' }));
  } catch(e) { res.statusCode = 500; res.end(JSON.stringify({ error: e.message })); }
});

server.listen(PORT, '0.0.0.0', () => console.error(`Reddit Service on ${PORT}`));
