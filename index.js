/**
 * Lost Sword Reddit 资讯服务 - RSS版
 */
const http = require('http');
const https = require('https');
const fs = require('fs');

const PORT = process.env.PORT || 3000;
const CACHE_FILE = '/tmp/ls_cache.json';

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
  return str.replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim();
}

function parseRSS(xml) {
  const entries = [];
  // 解析 <entry>...</entry> (新版 reddit)
  const entryRegex = /<entry>([\s\S]*?)<\/entry>/g;
  let match;
  while ((match = entryRegex.exec(xml)) !== null) {
    const block = match[1];
    const get = (tag) => {
      const m = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i').exec(block);
      return m ? stripHtml(m[1]) : '';
    };
    const id = get('id') || get('guid');
    const title = get('title');
    const author = get('author') || get('dc:creator');
    const link = (block.match(/<link[^>]+href="([^"]+)"/) || ['', ''])[1];
    const updated = get('updated') || get('published');
    const content = get('content') || get('description');
    if (id && title) entries.push({ id, title, author, link, updated, content: content.substring(0, 200) });
  }
  // 解析 <item>...</item> (旧版 reddit RSS)
  const itemRegex = /<item>([\s\S]*?)<\/item>/g;
  while ((match = itemRegex.exec(xml)) !== null) {
    const block = match[1];
    const get = (tag) => {
      const m = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i').exec(block);
      return m ? stripHtml(m[1]) : '';
    };
    const title = get('title');
    const link = get('link') || (block.match(/<link>([\s\S]*?)<\/link>/s) || ['', ''])[1].trim();
    const author = get('dc:creator') || get('author');
    const pubDate = get('pubDate') || get('updated');
    const description = get('description') || get('content');
    if (title) entries.push({ id: link || title, title, author, link, updated: pubDate, content: description.substring(0, 200) });
  }
  return entries;
}

function loadCache() {
  try { if (fs.existsSync(CACHE_FILE)) return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')); } catch(e) {}
  return { postHash: '', codeHash: '', lastPush: 0 };
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
    if (url.pathname === '/test-rss') {
      const { status, body } = await fetch('https://www.reddit.com/r/LostSwordOfficial/hot.rss', 15000);
      const entries = parseRSS(body);
      res.end(JSON.stringify({ status, body_len: body.length, entries: entries.slice(0, 3) }, null, 2));
      return;
    }
    if (url.pathname === '/push') {
      const rssUrls = [
        'https://www.reddit.com/r/LostSwordOfficial/hot.rss',
        'https://www.reddit.com/r/LostSwordOfficial/new.rss',
      ];
      const results = await Promise.allSettled(rssUrls.map(u => fetch(u, 15000)));
      const allEntries = [];
      for (const r of results) {
        if (r.status === 'fulfilled' && r.value.status === 200) {
          allEntries.push(...parseRSS(r.value.body));
        }
      }
      const seen = new Set();
      const deduped = allEntries.filter(e => { if (seen.has(e.id)) return false; seen.add(e.id); return true; });
      const newHash = computeHash(deduped.map(e => e.id).join('|'));
      saveCache({ postHash: newHash, codeHash: '', lastPush: Date.now() });
      res.end(JSON.stringify({ posts: deduped.slice(0, 10), ts: Date.now(), total: deduped.length }));
      return;
    }
    res.statusCode = 404; res.end(JSON.stringify({ error: 'not found' }));
  } catch(e) { res.statusCode = 500; res.end(JSON.stringify({ error: e.message })); }
});

server.listen(PORT, '0.0.0.0', () => { console.error(`Lost Sword Reddit RSS Service on port ${PORT}`); });
