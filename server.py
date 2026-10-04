#!/usr/bin/env python3
"""
Lost Sword Reddit 资讯服务 - Pushshift API版
"""
import json, time, http.server, socketserver, urllib.request, os

PORT = int(os.environ.get('PORT', 3000))
CACHE_TTL = 300

cache = {'posts': [], 'ts': 0}

def fetch(url, timeout=15):
    req = urllib.request.Request(url, headers={'User-Agent': 'LostSwordBot/1.0'})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode())

def fetch_posts():
    params = 'subreddit=LostSwordOfficial&sort_type=created_utc&sort=desc&size=25'
    data = fetch(f'https://api.pullpush.io/reddit/search/submission/?{params}')
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
        if not cache['posts']: raise e
    return cache['posts']

class Handler(http.server.SimpleHTTPRequestHandler):
    def do_GET(self):
        if self.path == '/health':
            self._send({'ok': True, 'ts': int(time.time()), 'posts': len(cache['posts'])}); return
        if self.path == '/push':
            self._send({'posts': get_posts(), 'ts': int(time.time())}); return
        self.send_error(404, 'not found')
    def _send(self, data):
        body = json.dumps(data, ensure_ascii=False).encode()
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Content-Length', len(body))
        self.end_headers()
        self.wfile.write(body)
    def log_message(self, fmt, *args):
        import sys; sys.stderr.write(f'{fmt % args}\n')

try:
    cache['posts'] = fetch_posts(); cache['ts'] = time.time()
    print(f'Cached {len(cache["posts"])} posts', flush=True)
except Exception as e:
    print(f'Warmup failed: {e}', flush=True)

with socketserver.TCPServer(('', PORT), Handler) as httpd:
    print(f'Serving on port {PORT}', flush=True)
    httpd.serve_forever()
