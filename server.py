#!/usr/bin/env python3
"""
Lost Sword Reddit 资讯服务 - Pushshift API版
"""
import json, time, http.server, socketserver, urllib.request, os

PORT = int(os.environ.get('PORT', 3000))
CACHE_TTL = 300

cache = {'posts': [], 'ts': 0}

def fetch(url, timeout=10):
    req = urllib.request.Request(url, headers={
        'User-Agent': 'LostSwordBot/1.0 (+https://github.com/LostSword)'
    })
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode())

def fetch_posts():
    url = 'https://api.pullpush.io/reddit/search/submission/?subreddit=LostSwordOfficial&sort_type=created_utc&sort=desc&size=20'
    data = fetch(url, timeout=10)
    posts = []
    for p in data.get('data', []):
        posts.append({
            'id': p.get('id', ''),
            'title': p.get('title', ''),
            'author': p.get('author', ''),
            'score': p.get('score', 0),
            'comments': p.get('num_comments', 0),
            'created': time.strftime('%Y-%m-%d', time.gmtime(p.get('created_utc', 0))),
            'link': f"https://www.reddit.com{p.get('permalink', '')}",
            'body': p.get('selftext', '')[:400],
        })
    return posts

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

class Handler(http.server.SimpleHTTPRequestHandler):
    def do_GET(self):
        try:
            if self.path == '/health':
                self._send({'ok': True, 'ts': int(time.time()), 'posts': len(cache['posts'])})
                return
            if self.path == '/push':
                posts = get_posts()
                self._send({'posts': posts, 'ts': int(time.time())})
                return
            self.send_error(404, 'not found')
        except Exception as e:
            print(f'Error: {e}', flush=True)
            self._send({'error': str(e), 'posts': cache.get('posts', [])})

    def _send(self, data):
        body = json.dumps(data, ensure_ascii=False).encode()
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Content-Length', len(body))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):
        pass

try:
    posts = fetch_posts()
    cache['posts'] = posts
    cache['ts'] = time.time()
    print(f'Cached {len(posts)} posts', flush=True)
except Exception as e:
    print(f'Warmup failed: {e}', flush=True)

with socketserver.TCPServer(('', PORT), Handler) as httpd:
    print(f'Serving on port {PORT}', flush=True)
    httpd.serve_forever()
