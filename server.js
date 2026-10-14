const http = require('http');
const https = require('https');
const { parseHTML } = require('linkedom');

const PORT = process.env.PORT || 10000;
const INGEST_SECRET = process.env.INGEST_SECRET || 'c207f687cdc0b0d5b2c339c07de8c9de';

let CACHE = { posts: [], ts: 0, last_ingest: 0 };

function httpGet(url, timeout = 15000) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    const req = client.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9',
      }
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.setTimeout(timeout, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

async function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' }
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { reject(new Error('JSON parse error')); }
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

// 从 Reddit HTML 页面提取帖子正文和图片
async function extractRedditPost(url) {
  const { status, body } = await httpGet(url);
  if (status !== 200) throw new Error(`HTTP ${status}`);

  const { document } = parseHTML(body);
  const { window } = document;

  // 找帖子正文
  let postText = '';
  const selectors = [
    '[data-testid="post-text"]',
    '.usertext-body',
    '[data-testid="content-gaps"]',
    '.Comment',
  ];
  for (const sel of selectors) {
    const el = window.document.querySelector(sel);
    if (el) {
      postText = el.textContent;
      if (postText.length > 50) break;
    }
  }

  // 找图片
  const images = [];
  const imgEls = window.document.querySelectorAll('img[src]');
  for (const img of imgEls) {
    const src = img.getAttribute('src') || '';
    if (src && !src.includes('redditstatic') && !src.includes('emoji') && src.startsWith('http')) {
      images.push(src);
    }
  }

  return { postText, images };
}

// 从 Pullpush 获取帖子列表基本信息（body 不截断）
async function fetchFromPullpush() {
  const url = 'https://api.pullpush.io/reddit/search/submission/?author=LostSwordGlobal&sort_type=created_utc&sort=desc&size=15';
  const data = await fetchJSON(url);
  return (data.data || []).map(p => ({
    id: p.id,
    title: p.title,
    author: p.author,
    score: p.score,
    comments: p.num_comments,
    created: new Date(p.created_utc * 1000).toISOString().slice(0, 10),
    created_utc: p.created_utc,
    link: 'https://www.reddit.com' + p.permalink,
    body: p.selftext || '',
    flair: p.link_flair_text || '',
    images: [],
  }));
}

function getPosts() {
  const now = Date.now();
  if (CACHE.posts.length && (now - CACHE.ts) < 300000) {
    return Promise.resolve(CACHE.posts);
  }
  return fetchFromPullpush().then(posts => {
    CACHE = { posts, ts: now, last_ingest: CACHE.last_ingest };
    console.log(`Fetched ${posts.length} posts`);
    return posts;
  }).catch(err => {
    console.error('fetch error:', err.message);
    return CACHE.posts.length ? CACHE.posts : [];
  });
}

// ─── HTTP server ─────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const path = url.pathname;

  const send = (data, status = 200) => {
    const body = JSON.stringify(data);
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Content-Length': Buffer.byteLength(body),
    });
    res.end(body);
  };

  try {
    if (path === '/health' || path === '/') {
      send({
        ok: true,
        ts: Math.floor(Date.now() / 1000),
        posts: CACHE.posts.length,
        last_ingest: CACHE.last_ingest,
        cache_age: CACHE.ts ? Math.floor((Date.now() - CACHE.ts) / 1000) : 0,
      });
    } else if (path === '/push') {
      const posts = await getPosts();
      send({ posts, ts: Math.floor(Date.now() / 1000) });
    } else if (path === '/post') {
      const redditUrl = url.searchParams.get('url');
      if (!redditUrl) { send({ error: 'missing url param' }, 400); return; }
      const { postText, images } = await extractRedditPost(redditUrl);
      send({ url: redditUrl, postText, images });
    } else if (path === '/ingest') {
      const secret = req.headers['x-ingest-secret'] || '';
      if (secret !== INGEST_SECRET) { send({ error: 'unauthorized' }, 401); return; }
      let body = '';
      await new Promise(resolve => {
        req.on('data', c => body += c);
        req.on('end', resolve);
      });
      const posts = JSON.parse(body);
      if (!Array.isArray(posts)) { send({ error: 'expected array' }, 400); return; }
      CACHE = { posts, ts: Date.now(), last_ingest: Math.floor(Date.now() / 1000) };
      send({ ok: true, posts: posts.length, ts: Math.floor(Date.now() / 1000) });
    } else {
      send({ error: 'not found' }, 404);
    }
  } catch(e) {
    console.error('ERROR:', e.message);
    send({ error: e.message }, 500);
  }
});

server.listen(PORT, () => {
  console.log(`Listening on port ${PORT}`);
  getPosts().then(posts => {
    console.log(`Warmed up: ${posts.length} posts`);
  }).catch(e => {
    console.log('Warmup failed:', e.message);
  });
});
