#!/usr/bin/env python3
"""
Lost Sword Reddit 资讯服务 v4 - 多数据源 + 诊断
"""
import json, time, http.server, socketserver, urllib.request, ssl, os

PORT = int(os.environ.get('PORT', 10000))
CACHE_TTL = 300

cache = {'posts': [], 'ts': 0}

def fetch(url, headers=None, timeout=15):
    h = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json',
        'Accept-Language': 'en-US,en;q=0.9',
    }
    if headers:
        h.update(headers)
    last_err = None
    for attempt in range(3):
        try:
            req = urllib.request.Request(url, headers=h)
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return json.loads(r.read().decode())
        except Exception as e:
            last_err = e
            if attempt < 2:
                time.sleep(2)
    raise last_err

def fetch_from_reddit_json():
    """方案A: Reddit 原生 JSON API"""
    endpoints = [
        'https://www.reddit.com/r/LostSwordOfficial/hot.json?limit=15',
        'https://www.reddit.com/r/LostSwordOfficial/new.json?limit=10',
    ]
    posts = []
    seen = set()
    for url in endpoints:
        try:
            data = fetch(url, timeout=15)
            for child in data.get('data', {}).get('children', []):
                p = child.get('data', {})
                pid = p.get('id', '')
                if pid in seen:
                    continue
                seen.add(pid)
                posts.append({
                    'id': pid,
                    'title': p.get('title', ''),
                    'author': p.get('author', ''),
                    'score': p.get('score', 0),
                    'comments': p.get('num_comments', 0),
                    'created': time.strftime('%Y-%m-%d', time.gmtime(p.get('created_utc', 0))),
                    'created_utc': p.get('created_utc', 0),
                    'link': f"https://www.reddit.com{p.get('permalink', '')}",
                    'body': p.get('selftext', '')[:400],
                    'flair': p.get('link_flair_text', ''),
                    'source': 'reddit-json',
                })
        except Exception as e:
            print(f'Reddit JSON {url[:50]} failed: {e}', flush=True)
    posts.sort(key=lambda x: x.get('created_utc', 0), reverse=True)
    return posts[:20]

def fetch_from_pullpush():
    """方案B: Pullpush API"""
    url = (
        'https://api.pullpush.io/reddit/search/submission/'
        '?subreddit=LostSwordOfficial'
        '&sort_type=created_utc'
        '&sort=desc'
        '&size=20'
    )
    data = fetch(url, timeout=15)
    posts = []
    for p in data.get('data', []):
        posts.append({
            'id': p.get('id', ''),
            'title': p.get('title', ''),
            'author': p.get('author', ''),
            'score': p.get('score', 0),
            'comments': p.get('num_comments', 0),
            'created': time.strftime('%Y-%m-%d', time.gmtime(p.get('created_utc', 0))),
            'created_utc': p.get('created_utc', 0),
            'link': f"https://www.reddit.com{p.get('permalink', '')}",
            'body': p.get('selftext', '')[:400],
            'flair': p.get('link_flair_text', ''),
            'source': 'pullpush',
        })
    return posts

def fetch_posts():
    # 先试 Reddit JSON API（Render 可能能访问）
    try:
        posts = fetch_from_reddit_json()
        if posts:
            print(f'Got {len(posts)} from Reddit JSON API', flush=True)
            return posts
    except Exception as e:
        print(f'Reddit JSON failed: {e}', flush=True)

    # 备用 Pullpush
    try:
        posts = fetch_from_pullpush()
        if posts:
            print(f'Got {len(posts)} from Pullpush', flush=True)
            return posts
    except Exception as e:
        print(f'Pullpush also failed: {e}', flush=True)

    return []

def get_posts():
    now = time.time()
    if cache['posts'] and (now - cache['ts']) < CACHE_TTL:
        return cache['posts']
    try:
        cache['posts'] = fetch_posts()
        cache['ts'] = now
    except Exception as e:
        print(f'Fetch error: {e}', flush=True)
        if not cache['posts']:
            cache['posts'] = []
    return cache['posts']

class Handler(http.server.BaseHTTPRequestHandler):
    def _send(self, data, status=200):
        body = json.dumps(data, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Content-Length', len(body))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        try:
            if self.path == '/health' or self.path == '/':
                self._send({'ok': True, 'ts': int(time.time()), 'posts': len(cache['posts'])})
            elif self.path == '/push':
                posts = get_posts()
                self._send({'posts': posts, 'ts': int(time.time())})
            elif self.path == '/diag':
                results = []
                tests = [
                    ('reddit-json-hot', 'https://www.reddit.com/r/LostSwordOfficial/hot.json?limit=1', 15),
                    ('reddit-json-new', 'https://www.reddit.com/r/LostSwordOfficial/new.json?limit=1', 15),
                    ('pullpush', 'https://api.pullpush.io/reddit/search/submission/?subreddit=LostSwordOfficial&sort_type=created_utc&sort=desc&size=1', 15),
                    ('httpbin', 'https://httpbin.org/get', 10),
                ]
                for name, url, timeout in tests:
                    try:
                        req = urllib.request.Request(url, headers={
                            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0 Safari/537.36',
                            'Accept': 'application/json',
                        })
                        start = time.time()
                        with urllib.request.urlopen(req, timeout=timeout) as r:
                            results.append({'name': name, 'status': r.status, 'elapsed': round(time.time()-start, 2)})
                    except Exception as e:
                        results.append({'name': name, 'error': str(e)[:100]})
                self._send({'diag': results, 'ts': int(time.time())})
            else:
                self._send({'error': 'not found'}, 404)
        except Exception as e:
            self._send({'error': str(e)}, 500)

    def log_message(self, fmt, *args):
        pass

# 预热
for attempt in range(3):
    try:
        cache['posts'] = fetch_posts()
        cache['ts'] = time.time()
        print(f'Cached {len(cache["posts"])} posts', flush=True)
        break
    except Exception as e:
        print(f'Warmup {attempt+1} failed: {e}', flush=True)
        if attempt < 2:
            time.sleep(3)

print(f'Serving on port {PORT}', flush=True)
with socketserver.TCPServer(('', PORT), Handler) as httpd:
    httpd.serve_forever()
