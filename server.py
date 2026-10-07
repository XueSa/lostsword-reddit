#!/usr/bin/env python3
"""
Lost Sword Reddit 资讯服务
数据源：Pullpush.io Reddit API（带正确的 User-Agent）
"""
import json, time, http.server, socketserver, urllib.request, os

PORT = int(os.environ.get('PORT', 10000))
CACHE_TTL = 300  # 5分钟

cache = {'posts': [], 'ts': 0}

def fetch(url, timeout=15):
    """带重试的 HTTP GET"""
    headers = {
        # Pullpush 要求真实的 User-Agent，否则 403
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json',
    }
    last_err = None
    for attempt in range(3):
        try:
            req = urllib.request.Request(url, headers=headers)
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return json.loads(r.read().decode())
        except Exception as e:
            last_err = e
            if attempt < 2:
                time.sleep(2)
    raise last_err

def fetch_posts():
    """从 Pullpush.io 获取 LostSwordOfficial 帖子"""
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
        })
    return posts

def get_posts():
    now = time.time()
    if cache['posts'] and (now - cache['ts']) < CACHE_TTL:
        return cache['posts']
    try:
        cache['posts'] = fetch_posts()
        cache['ts'] = now
        print(f'Fetched {len(cache["posts"])} posts', flush=True)
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
                return
            if self.path == '/push':
                posts = get_posts()
                self._send({'posts': posts, 'ts': int(time.time())})
                return
            self._send({'error': 'not found'}, 404)
        except Exception as e:
            print(f'Error: {e}', flush=True)
            self._send({'error': str(e)}, 500)

    def log_message(self, fmt, *args):
        pass

# 预热缓存
for attempt in range(3):
    try:
        cache['posts'] = fetch_posts()
        cache['ts'] = time.time()
        print(f'Cached {len(cache["posts"])} posts', flush=True)
        break
    except Exception as e:
        print(f'Warmup attempt {attempt+1} failed: {e}', flush=True)
        if attempt < 2:
            time.sleep(3)

print(f'Serving on port {PORT}', flush=True)
with socketserver.TCPServer(('', PORT), Handler) as httpd:
    httpd.serve_forever()
