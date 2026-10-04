/**
 * Lost Sword Reddit 资讯服务 - RSS版
 * 不需要任何API认证，直接抓Reddit RSS
 */
const http = require('http');
const https = require('https');
const fs = require('fs');
const { DOMParser } = require('linkedom');

const PORT = process.env.PORT || 3000;
const CACHE_FILE = '/tmp/ls_cache.json';

function fetch(url, timeout = 15000) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; LostSwordBot/1.0)',
        'Accept': 'application/rss+xml, application/xml, text/xml, */*'
      }
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return resolve(fetch(res.headers.location, timeout));
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', e => reject(e));
    req.setTimeout(timeout, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

function parseRSS(xml) {
  const entries = [];
  // 简单正则解析 <entry>...</entry>
  const entryMatches = xml.match(/<entry>([\s\S]*?)<\/entry>/g) || [];
  for (const entry of entryMatches) {
    const get = (tag) => {
      const m = entry.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`));
      return m ? m[1].replace(/<[^>]+>/g, '').trim() : '';
    };
    const id = get('id');
    const title = get('title');
    const author = get('author');
    const link = (entry.match(/<link[^>]+href="([^"]+)"/) || ['', ''])[1];
    const updated = get('updated');
    const content = get('content');
    if (id && title) {
      entries.push({ id, title, author, link, updated, content: content.substring(0, 200) });
    }
  }
  // 也尝试解析旧版 reddit RSS 的 <item>
  const itemMatches = xml.match(/<item>([\s\S]*?)<\/item>/g) || [];
  for (const item of itemMatches) {
    const get = (tag) => {
      const m = item.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`));
      return m ? m[1].replace(/<[^>]+>/g, '').trim() : '';
    };
    const title = get('title');
    const link = (item.match(/<link>(.*?)<\/link>/s) || ['', ''])[1].trim() || get('link');
    const author = get('creator') || get('author');
    const pubDate = get('pubDate');
    const description = get('description');
    if (title) {
      entries.push({ id: link || title, title, author, link, updated: pubDate, content: description.substring(0, 200) });
    }
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
      res.end(JSON.stringify({ status, body_len: body.length, entries_found: entries.length, entries: entries.slice(0, 3) }, null, 2));
      return;
    }
    if (url.pathname === '/push') {
      const rssUrls = [
        'https://www.reddit.com/r/LostSwordOfficial/hot.rss',
        'https://www.reddit.com/r/LostSwordOfficial/new.rss',
        'https://www.reddit.com/r/LostSwordOfficial/.rss',
      ];
      const results = await Promise.allSettled(rssUrls.map(u => fetch(u, 15000)));
      const allEntries = [];
      for (const r of results) {
        if (r.status === 'fulfilled') {
          allEntries.push(...parseRSS(r.value.body));
        }
      }
      const seen = new Set();
      const deduped = allEntries.filter(e => { if (seen.has(e.id)) return false; seen.add(e.id); return true; });
      const newHash = computeHash(deduped.map(e => e.id).join('|'));
      saveCache({ postHash: newHash, codeHash: '', lastPush: Date.now() });
      res.end(JSON.stringify({ posts: deduped.slice(0, 10), ts: Date.now(), total_entries: deduped.length }));
      return;
    }
    res.statusCode = 404; res.end(JSON.stringify({ error: 'not found' }));
  } catch(e) { res.statusCode = 500; res.end(JSON.stringify({ error: e.message })); }
});

server.listen(PORT, '0.0.0.0', () => { console.error(`Lost Sword Reddit RSS Service on port ${PORT}`); });
