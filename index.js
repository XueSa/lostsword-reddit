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
        'Accept': 'application/rss+xml, application/xml, text/xml, application/json, */*',
        'Accept-Language': 'en-US,en;q=0.9',
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
    let pos = 0;
    let count = 0;
    while (count < 100) {
      const open = xml.indexOf(`<${tag}>`, pos);
      if (open === -1) break;
      const close = xml.indexOf(`</${tag}>`, open);
      if (close === -1) break;
      const block = xml.substring(open + tag.length + 2, close);

      // 提取 link 属性
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

async function fetchPosts() {
  const urls = [
    { url: 'https://www.reddit.com/r/LostSwordOfficial/hot.rss', key: 'hot' },
    { url: 'https://www.reddit.com/r/LostSwordOfficial/new.rss', key: 'new' },
  ];

  const results = await Promise.allSettled(
    urls.map(({ url }) => fetch(url, 15000))
  );

  const all = [];
  for (const r of results) {
    if (r.status === 'fulfilled' && r.value.status === 200 && r.value.body) {
      const entries = parseRSSEntries(r.value.body);
      all.push(...entries);
    }
  }

  // 去重
  const seen = new Set();
  return all.filter(e => {
    const key = e.link || e.id;
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
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
  } catch(e) {
    console.error('[Startup] Failed:', e.message);
  }
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
