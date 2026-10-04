/**
 * Lost Sword Reddit 资讯服务 - RSS版 + 内存缓存
 */
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
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Accept': 'application/rss+xml, application/xml, text/xml, */*'
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
  return str.replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

function parseRSS(xml) {
  const entries = [];
  for (const tag of ['entry', 'item']) {
    const rx = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, 'g');
    let m;
    while ((m = rx.exec(xml)) !== null) {
      const b = m[1];
      const get = (t) => { const r = new RegExp(`<${t}[^>]*>([\\s\\S]*?)<\\/${t}>`, 'i').exec(b); return r ? stripHtml(r[1]) : ''; };
      const id = get('id') || get('guid');
      const title = get('title');
      const rawAuthor = get('author') || get('dc:creator') || '';
      const author = rawAuthor.split('http')[0].trim();
      const link = (b.match(/<link[^>]+href="([^"]+)"/) || ['', ''])[1] || get('link');
      const updated = get('updated') || get('published') || get('pubDate');
      const content = get('content') || get('description');
      if (id && title) entries.push({ id, title, author, link, updated, content: content.substring(0, 150) });
    }
  }
  return entries;
}

async function fetchPosts() {
  const results = await Promise.allSettled([
    fetch('https://www.reddit.com/r/LostSwordOfficial/hot.rss'),
    fetch('https://www.reddit.com/r/LostSwordOfficial/new.rss'),
  ]);
  const all = [];
  for (const r of results) {
    if (r.status === 'fulfilled' && r.value.status === 200) all.push(...parseRSS(r.value.body));
  }
  const seen = new Set();
  return all.filter(e => { if (seen.has(e.id)) return false; seen.add(e.id); return true; });
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

// 启动预热
(async () => { try { await getPosts(); console.error('[Ready] Cache warmed up'); } catch(e) { console.error('[Ready] Warmup failed:', e.message); } })();

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');
  try {
    if (url.pathname === '/health') {
      res.end(JSON.stringify({ ok: true, ts: Date.now(), posts: cache.posts.length, cacheAge: cache.ts ? Date.now() - cache.ts : null }));
      return;
    }
    if (url.pathname === '/push') {
      const posts = await getPosts();
      res.end(JSON.stringify({ posts: posts.slice(0, 10), ts: Date.now(), total: posts.length }));
      return;
    }
    res.statusCode = 404; res.end(JSON.stringify({ error: 'not found' }));
  } catch(e) { res.statusCode = 500; res.end(JSON.stringify({ error: e.message })); }
});

server.listen(PORT, '0.0.0.0', () => { console.error(`Lost Sword Reddit Service on port ${PORT}`); });
