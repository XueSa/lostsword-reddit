cat > /opt/render/project/src/server.py << 'ENDOFSERVER'
#!/usr/bin/env python3
import json, time, http.server, socketserver, os, urllib.request

PORT = int(os.environ.get('PORT', 10000))
CACHE_TTL = 300
INGEST_SECRET = os.environ.get('INGEST_SECRET', 'c207f687cdc0b0d5b2c339c07de8c9de')

CACHE = {'posts': [], 'ts': 0, 'last_ingest': 0}

def fetch_reddit_json(url, timeout=15):
    headers = {'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json'}
    last_err = None
    for attempt in range(3):
        try:
            req = urllib.request.Request(url, headers=headers)
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return json.loads(r.read().decode())
        except Exception as e:
            last_err = e
            if attempt < 2: time.sleep(2)
    raise last_err

def fetch_posts_from_pullpush():
    url = 'https://api.pullpush.io/reddit/search/submission/?subreddit=LostSwordOfficial&sort_type=created_utc&sort=desc&size=20'
    data = fetch_reddit_json(url)
    posts = []
    for p in data.get('data', []):
        posts.append({
            'id': p.get('id', ''), 'title': p.get('title', ''),
            'author': p.get('author', ''), 'score': p.get('score', 0),
            'comments': p.get('num_comments', 0),
            'created': time.strftime('%Y-%m-%d', time.gmtime(p.get('created_utc', 0))),
            'created_utc': p.get('created_utc', 0),
            'link': 'https://www.reddit.com' + p.get('permalink', ''),
            'body': p.get('selftext', '')[:500],
            'flair': p.get('link_flair_text', ''),
            'is_self': bool(p.get('selftext', '')),
        })
    return posts

def get_posts():
    now = time.time()
    if CACHE['posts'] and (now - CACHE['ts']) < CACHE_TTL:
        return CACHE['posts']
    try:
        CACHE['posts'] = fetch_posts_from_pullpush()
        CACHE['ts'] = now
        print(f'Pullpush: {len(CACHE["posts"])} posts', flush=True)
    except Exception as e:
        print(f'Pullpush error: {e}', flush=True)
        if not CACHE['posts']: CACHE['posts'] = []
    return CACHE['posts']

class Handler(http.server.BaseHTTPRequestHandler):
    def _send(self, data, status=200):
        body = json.dumps(data, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type, X-Ingest-Secret')
        self.send_header('Content-Length', len(body))
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self._send({}, 204)

    def do_POST(self):
        try:
            if self.path == '/ingest':
                secret = self.headers.get('X-Ingest-Secret', '')
                if secret != INGEST_SECRET:
                    self._send({'error': 'unauthorized'}, 401)
                    return
                length = int(self.headers.get('Content-Length', 0))
                posts = json.loads(self.rfile.read(length).decode())
                if not isinstance(posts, list):
                    self._send({'error': 'expected array'}, 400)
                    return
                CACHE['posts'] = posts
                CACHE['ts'] = time.time()
                CACHE['last_ingest'] = time.time()
                print(f'Ingested {len(posts)} posts', flush=True)
                self._send({'ok': True, 'count': len(posts)})
                return
            self._send({'error': 'not found'}, 404)
        except Exception as e:
            print(f'POST error: {e}', flush=True)
            self._send({'error': str(e)}, 500)

    def do_GET(self):
        try:
            if self.path in ('/health', '/'):
                self._send({'ok': True, 'ts': int(time.time()), 'posts': len(CACHE['posts']), 'last_ingest': int(CACHE.get('last_ingest', 0)), 'cache_age': int(time.time() - CACHE['ts'])})
                return
            if self.path == '/push':
                self._send({'posts': get_posts(), 'ts': int(time.time())})
                return
            self._send({'error': 'not found'}, 404)
        except Exception as e:
            print(f'GET error: {e}', flush=True)
            self._send({'error': str(e)}, 500)

    def log_message(self, fmt, *args): pass

print(f'INGEST_SECRET: {bool(INGEST_SECRET)}', flush=True)
print(f'Serving on port {PORT}', flush=True)
with socketserver.TCPServer(('', PORT), Handler) as httpd:
    httpd.serve_forever()
ENDOFSERVER
