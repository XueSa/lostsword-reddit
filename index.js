/**
 * Lost Sword Reddit 资讯服务
 * 部署在 Render.com（美国俄勒冈节点），直接抓取 Reddit
 */

const http = require('http');
const https = require('https');
const fs = require('fs');

const PORT = process.env.PORT || 3000;
const CACHE_FILE = '/tmp/ls_cache.json';
const USER_AGENT = 'LostSwordBot/1.0 (by u/LostSwordBot)';

function fetch(url, timeout = 15000) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, {
      headers: { 'User-Agent': USER_AGENT, 'Accept': 'application/json' }
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return resolve(fetch(res.headers.location, timeout));
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    req.setTimeout(timeout, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

async function fetchRedditPosts() {
  const results = [];
  const urls = [
    'https://www.reddit.com/r/LostSwordOfficial/hot.json?limit=10',
    'https://www.reddit.com/r/LostSwordOfficial/new.json?limit=10',
  ];
  await Promise.allSettled(urls.map(async (url) => {
    try {
      const { status, body } = await fetch(url);
      if (status !== 200) return;
      const data = JSON.parse(body);
      const children = data?.data?.children || [];
      for (const c of children) {
        const p = c.data;
        results.push({
          id: p.id,
          title: p.title,
          author: p.author,
          score: p.score,
          comments: p.num_comments,
          permalink: `https://reddit.com${p.permalink}`,
          flair: p.link_flair_text || null,
          created: new Date(p.created_utc * 1000).toISOString(),
        });
      }
    } catch(e) { console.error('fetch posts error:', e.message); }
  }));
  const seen = new Set();
  return results.filter(p => { if (seen.has(p.id)) return false; seen.add(p.id); return true; });
}

async function searchCodes() {
  try {
    const { status, body } = await fetch(
      'https://www.reddit.com/search.json?q=lostsword+redeem+OR+gift+OR+code&sort=relevance&t=month&limit=15'
    );
    if (status !== 200) return [];
    const data = JSON.parse(body);
    return (data?.data?.children || []).map(c => {
      const p = c.data;
      return { id: p.id, title: p.title, author: p.author, score: p.score,
               permalink: `https://reddit.com${p.permalink}`, text: p.selftext?.substring(0, 400) || '' };
    }).slice(0, 10);
  } catch(e) { console.error('search codes error:', e.message); return []; }
}

function loadCache() {
  try { if (fs.existsSync(CACHE_FILE)) return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')); }
  catch(e) {} return { postHash: '', codeHash: '', lastPush: 0 };
}

function saveCache(data) { try { fs.writeFileSync(CACHE_FILE, JSON.stringify(data), 'utf8'); } catch(e) {} }

function computeHash(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) { hash = ((hash << 5) - hash) + str.charCodeAt(i); hash = hash & hash; }
  return Math.abs(hash).toString(16);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');
  try {
    if (url.pathname === '/health') { res.end(JSON.stringify({ ok: true, ts: Date.now() })); return; }
    if (url.pathname === '/check') {
      const cache = loadCache();
      const [posts, codes] = await Promise.all([fetchRedditPosts(), searchCodes()]);
      const newPostHash = computeHash(posts.map(p => p.id).join('|'));
      const newCodeHash = computeHash(codes.map(c => c.id).join('|'));
      const changed = newPostHash !== cache.postHash || newCodeHash !== cache.codeHash;
     if (changed) saveCache({ ...cache, postHash: newPostHash, codeHash: newCodeHash });
      res.end(JSON.stringify({ changed, posts: posts.slice(0, 10), codes: codes.slice(0, 5),
        postHash: newPostHash, codeHash: newCodeHash, ts: Date.now(),
        message: changed ? 'changes detected' : 'no changes' }));
      return;
    }
    if (url.pathname === '/push') {
      const [posts, codes] = await Promise.all([fetchRedditPosts(), searchCodes()]);
      const newPostHash = computeHash(posts.map(p => p.id).join('|'));
      const newCodeHash = computeHash(codes.map(c => c.id).join('|'));
      saveCache({ postHash: newPostHash, codeHash: newCodeHash, lastPush: Date.now() });
      res.end(JSON.stringify({ posts: posts.slice(0, 10), codes: codes.slice(0, 5),
        postHash: newPostHash, codeHash: newCodeHash, ts: Date.now() }));
      return;
    }
    res.statusCode = 404; res.end(JSON.stringify({ error: 'not found' }));
  } catch(e) { res.statusCode = 500; res.end(JSON.stringify({ error: e.message })); }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Lost Sword Reddit Service running on port ${PORT}`);
  console.log('Endpoints: /health | /check | /push');
});
