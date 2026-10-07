#!/usr/bin/env python3
"""
Lost Sword Reddit 资讯服务 - Reddit JSON API 版
方案：直接用 Reddit 官方 JSON API（无需认证，Render 可访问）
"""
import json, time, http.server, socketserver, urllib.request, ssl, os

PORT = int(os.environ.get('PORT', 10000))
CACHE_TTL = 300  # 5分钟缓存

cache = {'posts': [], 'ts': 0}

def fetch(url, timeout=15):
    """带重试的 HTTP GET"""
    headers = {
        'User-Agent': 'Mozilla/5.0 (compatible; LostSwordBot/1.0; +https://github.com/XueSa/lostsword-reddit)',
        'Accept': 'application/json',
        'Accept-Language': 'en-US,en;q=0.9',
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
    """从 Reddit JSON API 获取帖子（hot + new 各取一批，去重）"""
    posts = []
    seen_ids = set()

    endpoints = [
        ('hot', 'https://www.reddit.com/r/LostSwordOfficial/hot.json?limit=15'),
        ('new', 'https://www.reddit.com/r/LostSwordOfficial/new.json?limit=15'),
    ]

    for kind, url in endpoints:
        try:
            data = fetch(url, timeout=15)
            children = data.get('data', {}).get('children', [])
            for child in children:
                p = child.get('data', {})
                post_id = p.get('id', '')
                if post_id in seen_ids:
                    continue
                seen_ids.add(post_id)

                created_utc = p.get('created_utc', 0)
                posts.append({
                    'id': post_id,
                    'title': p.get('title', ''),
                    'author': p.get('author', ''),
                    'score': p.get('score', 0),
                    'comments': p.get('num_comments', 0),
                    'created': time.strftime('%Y-%m-%d', time.gmtime(created_utc)),
                    'created_utc': created_utc,
                    'link': f"https://www.reddit.com{p.get('permalink', '')}",
                    'body': p.get('selftext', '')[:400],
                    'flair': p.get('link_flair_text', ''),
                    'source': kind,
                })
        except Exception as e:
            print(f'Fetch {kind} failed: {e}', flush=True)

    # 按 created_utc 降序排序（最新的在前）
    posts.sort(key=lambda x: x.get('created_utc', 0), reverse=True)
    return posts[:20]

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
            if self.path == '/debug':
                # 调试：直接测试 Reddit API
                posts = fetch_posts()
                self._send({'posts': posts, 'ts': int(time.time())})
                return
            self._send({'error': 'not found'}, 404)
        except Exception as e:
            print(f'Error: {e}', flush=True)
            self._send({'error': str(e)}, 500)

    def log_message(self, fmt, *args):
        pass  # 减少日志噪音

# 预热缓存（带重试）
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
