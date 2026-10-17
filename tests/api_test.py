#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Проверки server/api/api.py на настоящем HTTP.

Служба запускается как в бою (`python3 -I api.py serve`) на свободном порту
127.0.0.1, со своей временной БД; почта — поддельный SMTP на 127.0.0.1
(stdlib smtpd в 3.12 нет — свой маленький на socketserver), Платега —
поддельный http.server на 127.0.0.1 (MAGNAT_PLATEGA_URL). Сеть наружу
не нужна. Запуск: `python3 -I tests/api_test.py` (код выхода 0 — зелёное).
"""

import base64
import email
import email.policy
import hashlib
import http.client
import http.server
import json
import os
import re
import shutil
import socket
import socketserver
import sqlite3
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import uuid

HERE = os.path.dirname(os.path.abspath(__file__))
API = os.path.join(HERE, '..', 'server', 'api', 'api.py')   # тесты живут в tests/: на сервер едет только api.py
PY = sys.executable
ORIGIN = 'https://magnat.test'
BOX, SUPPORT = 'box@example.ru', 'support@example.ru'
PASSWORD = 'abcdefghijklmnop'


# ───────────────────────── поддельный SMTP ─────────────────────────

class SMTPHandler(socketserver.StreamRequestHandler):
    def w(self, s):
        self.wfile.write(s.encode() + b'\r\n')

    def line(self):
        x = self.rfile.readline()
        if not x:
            raise EOFError()
        return x.decode('utf-8', 'replace').rstrip('\r\n')

    def handle(self):
        srv = self.server
        if srv.mode == 'drop':
            return
        if srv.mode == 'slow':
            time.sleep(srv.slow)
        try:
            self.w('220 fake ESMTP')
            mail = {}
            while True:
                cmd = self.line()
                up = cmd.upper()
                if up.startswith('EHLO'):
                    self.w('250-fake')
                    self.w('250-AUTH PLAIN LOGIN')
                    self.w('250 8BITMIME')
                elif up.startswith('HELO'):
                    self.w('250 fake')
                elif up.startswith('AUTH PLAIN'):
                    parts = cmd.split(' ')
                    data = parts[2] if len(parts) > 2 else (self.w('334 '), self.line())[1]
                    _, user, pw = base64.b64decode(data).decode().split('\0')
                    srv.auths.append((user, pw))
                    self.w('535 5.7.8 nope' if srv.mode == '535' else '235 ok')
                elif up.startswith('AUTH LOGIN'):
                    self.w('334 VXNlcm5hbWU6')
                    user = base64.b64decode(self.line()).decode()
                    self.w('334 UGFzc3dvcmQ6')
                    pw = base64.b64decode(self.line()).decode()
                    srv.auths.append((user, pw))
                    self.w('535 5.7.8 nope' if srv.mode == '535' else '235 ok')
                elif up.startswith('MAIL FROM'):
                    mail = {'from': cmd[10:].strip(), 'to': []}
                    self.w('250 ok')
                elif up.startswith('RCPT TO'):
                    mail['to'].append(cmd[8:].strip().strip('<>'))
                    self.w('250 ok')
                elif up == 'DATA':
                    self.w('354 go')
                    buf = []
                    while True:
                        x = self.rfile.readline()
                        if x in (b'.\r\n', b''):
                            break
                        buf.append(x[1:] if x.startswith(b'..') else x)
                    mail['raw'] = b''.join(buf)
                    with srv.lock:
                        srv.mails.append(mail)
                    self.w('250 queued')
                elif up == 'QUIT':
                    self.w('221 bye')
                    return
                else:
                    self.w('250 ok')
        except (EOFError, OSError):
            return


class FakeSMTP(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True

    def __init__(self, mode='ok', slow=0):
        self.mode, self.slow = mode, slow
        self.mails, self.auths = [], []
        self.lock = threading.Lock()
        super().__init__(('127.0.0.1', 0), SMTPHandler)
        threading.Thread(target=self.serve_forever, daemon=True).start()

    @property
    def port(self):
        return self.server_address[1]

    def stop(self):
        self.shutdown()
        self.server_close()

    def msgs(self, to):
        with self.lock:
            return [email.message_from_bytes(m['raw'], policy=email.policy.default)
                    for m in self.mails if to in m['to']]

    def last_code(self, to):
        ms = self.msgs(to)
        return re.match(r'[0-9]{6}', str(ms[-1]['Subject'])).group(0) if ms else None

    def last_any_code(self, to):
        ms = self.msgs(to)
        return re.search(r'[0-9]{6}', str(ms[-1]['Subject'])).group(0) if ms else None


# ───────────────────────── поддельная Платега ─────────────────────────

MID, SECRET = 'mid-3fa85f64-5717', 'Sx-never-in-logs-9c1e2b'


class PlategaHandler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def reply(self, code, obj, hdr=()):
        b = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(b)))
        for k, v in hdr:
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(b)

    def keys_ok(self):
        return self.headers.get('X-MerchantId') == MID and self.headers.get('X-Secret') == SECRET

    def do_POST(self):
        srv = self.server
        n = int(self.headers.get('Content-Length') or 0)
        body = json.loads(self.rfile.read(n) or b'{}')
        with srv.lock:
            srv.reqs.append(('POST', self.path, {k.lower(): v for k, v in self.headers.items()}, body))
        if not self.keys_ok():
            return self.reply(401, {'message': 'unauthorized'})
        if srv.mode == 'down':
            return self.reply(500, {'message': 'oops'})
        if srv.mode == 'redirect':
            return self.reply(302, {}, [('Location', 'http://127.0.0.1:%d/stolen' % srv.server_address[1])])
        tx = str(uuid.uuid4())
        with srv.lock:
            srv.st[tx] = 'PENDING'
        url = ('http://' if srv.mode == 'http' else 'https://') + 'pay.platega.test/' + tx
        # своя ссылка формы — первой (как читает бот ГенаVPN), второе поле — приманка: прочли не то — видно сразу
        key, other = ('url', 'redirect') if self.path == '/v2/transaction/process' else ('redirect', 'url')
        self.reply(200, {'transactionId': tx, 'status': 'PENDING', key: url, other: 'https://decoy.platega.test/' + tx,
                         'expiresIn': '00:30:00'})

    def do_GET(self):
        srv = self.server
        with srv.lock:
            srv.reqs.append(('GET', self.path, {k.lower(): v for k, v in self.headers.items()}, None))
        if srv.delay:
            time.sleep(srv.delay)
        if srv.gdown:
            return self.reply(500, {'message': 'oops'})
        tx = self.path.rpartition('/')[2]
        if not self.path.startswith('/transaction/') or tx not in srv.st:
            return self.reply(404, {'message': 'not found'})
        if not self.keys_ok():
            return self.reply(401, {'message': 'unauthorized'})
        self.reply(200, {'id': tx, 'status': srv.st[tx], 'paymentDetails': {'amount': 299, 'currency': 'RUB'}})


class FakePlatega(http.server.ThreadingHTTPServer):
    """Платега на 127.0.0.1: создание (универсальная /v2 и со способом), статус GET, журнал запросов."""
    daemon_threads = True

    def __init__(self):
        self.lock = threading.Lock()
        self.reqs = []       # (метод, путь, заголовки, тело)
        self.st = {}         # номер платежа → статус для GET
        self.mode = 'ok'     # ok | down (500) | http (ссылка не https) | redirect (302 на чужой адрес)
        self.gdown = False   # статус (GET) отвечает 500
        self.delay = 0
        super().__init__(('127.0.0.1', 0), PlategaHandler)
        threading.Thread(target=self.serve_forever, daemon=True).start()

    @property
    def url(self):
        return 'http://127.0.0.1:%d' % self.server_address[1]

    def stop(self):
        self.shutdown()
        self.server_close()

    def last_tx(self):
        with self.lock:
            return list(self.st)[-1]

    def gets(self, tx):
        with self.lock:
            return [r for r in self.reqs if r[0] == 'GET' and r[1] == '/transaction/' + tx]


def platega_env(method=''):
    return 'PLATEGA_MERCHANT_ID=%s\nPLATEGA_SECRET=%s\nPLATEGA_METHOD=%s\n' % (MID, SECRET, method)


# ───────────────────────── служба ─────────────────────────

def free_port():
    s = socket.socket()
    s.bind(('127.0.0.1', 0))
    p = s.getsockname()[1]
    s.close()
    return p


def smtp_env(port, user=BOX, support=SUPPORT, pw=PASSWORD):
    return 'SMTP_HOST=127.0.0.1\nSMTP_PORT=%d\nSMTP_USER=%s\nSMTP_PASS=%s\nSUPPORT=%s\n' % (port, user, pw, support)


class Api:
    def __init__(self, smtp=None, state=None, platega=None, **env):
        self.state = state or tempfile.mkdtemp(prefix='magnat-api-test-')
        self.db = os.path.join(self.state, 'magnat.db')
        self.smtp_file = os.path.join(self.state, 'smtp.env')
        self.platega_file = os.path.join(self.state, 'platega.env')    # нет файла — ключей нет
        for path, txt in ((self.smtp_file, smtp_env(smtp.port) if smtp is not None else None),
                          (self.platega_file, platega)):
            if txt is not None and not os.path.exists(path):
                fd = os.open(path, os.O_WRONLY | os.O_CREAT, 0o600)
                os.write(fd, txt.encode())
                os.close(fd)
        self.env_over = env
        self.errs = []          # журналы всех запусков (тест перезапускает службу)
        self.start()

    def env(self):
        e = {'PATH': os.environ.get('PATH', '/usr/bin:/bin'), 'MAGNAT_LISTEN': '127.0.0.1:%d' % self.port,
             'MAGNAT_DB': self.db, 'MAGNAT_STATE': self.state, 'MAGNAT_ORIGIN': ORIGIN,
             'MAGNAT_SMTP_FILE': self.smtp_file, 'MAGNAT_PLATEGA_FILE': self.platega_file, 'MAGNAT_DISK_MIN_MB': '0'}
        e.update({k: str(v) for k, v in self.env_over.items()})
        return e

    def start(self):
        self.port = free_port()
        self.p = subprocess.Popen([PY, '-I', API, 'serve'], env=self.env(), stdout=subprocess.PIPE,
                                  stderr=subprocess.PIPE)
        t = time.monotonic()
        while time.monotonic() - t < 10:
            try:
                if req(self.port, 'GET', '/api/health', ip=None)[0] == 200:
                    return
            except OSError:
                time.sleep(0.05)
        raise RuntimeError('служба не поднялась: %r' % (self.p.poll(),))

    def stop(self):
        self.p.terminate()
        o, e = self.p.communicate(timeout=10)
        self.out = o.decode('utf-8', 'replace')
        self.err = e.decode('utf-8', 'replace')
        self.errs.append(self.out + self.err)
        return self.out, self.err

    def cli(self, *args, stdin=None):
        r = subprocess.run([PY, '-I', API] + list(args), env=self.env(), input=stdin, capture_output=True,
                           timeout=60)
        return r.returncode, r.stdout, r.stderr

    def sql(self, q, *a):
        c = sqlite3.connect(self.db, timeout=10)
        try:
            r = c.execute(q, a).fetchall()
            c.commit()           # тест иногда двигает время заказа (checked), как будто прошла минута
            return r
        finally:
            c.close()

    def raw_db(self):
        b = b''
        for s in ('', '-wal'):
            if os.path.exists(self.db + s):
                with open(self.db + s, 'rb') as f:
                    b += f.read()
        return b


def req(port, method, path, body=None, headers=None, raw=None, cookie=None, ip='192.0.2.10', timeout=30):
    data = raw if raw is not None else (None if body is None else json.dumps(body).encode())
    h = {}
    if method == 'POST':
        h = {'Origin': ORIGIN, 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-origin'}
    if ip:
        h['X-Forwarded-For'] = ip
    if cookie:
        h['Cookie'] = '__Host-mg=' + cookie
    h.update(headers or {})
    h = {k: v for k, v in h.items() if v is not None}
    c = http.client.HTTPConnection('127.0.0.1', port, timeout=timeout)
    try:
        c.request(method, path, body=data, headers=h)
        r = c.getresponse()
        b = r.read()
        hs = r.getheaders()
    finally:
        c.close()
    try:
        obj = json.loads(b)
    except ValueError:
        obj = b
    return r.status, hs, obj


def cookie_of(hs):
    for k, v in hs:
        if k.lower() == 'set-cookie' and v.startswith('__Host-mg='):
            return v
    return None


class Client:
    def __init__(self, api, ip='192.0.2.10'):
        self.api, self.ip, self.tok, self.set = api, ip, None, None

    def __call__(self, path, body=None, **kw):
        kw.setdefault('ip', self.ip)
        st, hs, obj = req(self.api.port, 'POST', path, {} if body is None else body, cookie=self.tok, **kw)
        c = cookie_of(hs)
        if c:
            self.set = c
            self.tok = c.split(';', 1)[0].split('=', 1)[1] or None
        self.status, self.headers = st, hs
        return obj

    def login(self, smtp, em, dev=None):
        r = self('/api/code', {'email': em, 'purpose': 'login'})
        assert r.get('ok'), r
        self.dev = dev or 'd_' + os.urandom(8).hex()
        r = self('/api/login', {'email': em, 'code': smtp.last_code(em), 'dev': self.dev, 'label': 'Тест'})
        assert r.get('ok'), r
        self.acct, self.seq = r['acct'], 0
        return r

    def push(self, doc, base, reason='edit', seq=None, out=None, sv=1):
        if seq is None:
            self.seq += 1
            seq = self.seq
        h = hashlib.sha256(doc.encode()).hexdigest()
        return self('/api/sync', {'pv': 1, 'acct': self.acct, 'dev': self.dev, 'sv': sv, 'base': base, 'seq': seq,
                                  'hash': h, 'outHash': out, 'doc': doc, 'reason': reason})

    def pull(self, base, sv=1):
        return self('/api/sync', {'pv': 1, 'acct': self.acct, 'dev': self.dev, 'sv': sv, 'base': base, 'seq': None,
                                  'hash': None, 'outHash': None, 'doc': None, 'reason': 'edit'})


def doc(days=1, extra=None):
    d = {'habits': [{'id': 1, 'ico': '', 'name': 'Зарядка', 'since': ''}],
         'checks': {'2026-09-%02d' % (i + 1): [1] for i in range(days)}, 'tasks': [], 'taskBank': 0,
         'finance': {'income': 0, 'entries': []}}
    d.update(extra or {})
    return json.dumps(d, ensure_ascii=False, separators=(',', ':'))


def slowloris(port, result):
    """Заголовки по байту раз в 2 с (каждое чтение укладывается в таймаут 15 с): служба обязана
    оборвать соединение сама, через ~15 с от начала, не дожидаясь конца заголовков."""
    s = socket.create_connection(('127.0.0.1', port))
    t0 = time.monotonic()
    head = b'POST /api/me HTTP/1.1\r\nHost: x\r\nX-Pad: ' + b'a' * 40
    tail = None
    try:
        for ch in head:
            s.sendall(bytes([ch]))
            s.settimeout(2)
            try:
                tail = s.recv(1024)
                break
            except socket.timeout:
                pass
            if time.monotonic() - t0 > 40:
                break
    except OSError:
        tail = b''
    result['cut'] = time.monotonic() - t0
    result['tail'] = tail
    s.close()


# ───────────────────────── проверки ─────────────────────────

class ClosedMode(unittest.TestCase):
    """R1: API закрыт (OPEN=False) — код получают только два ящика владельца."""

    @classmethod
    def setUpClass(cls):
        cls.smtp = FakeSMTP()
        cls.api = Api(cls.smtp)

    @classmethod
    def tearDownClass(cls):
        cls.api.stop()
        cls.smtp.stop()
        shutil.rmtree(cls.api.state, ignore_errors=True)

    def test_health(self):
        st, hs, r = req(self.api.port, 'GET', '/api/health', ip=None)
        self.assertEqual(st, 200)
        self.assertEqual(r, {'ok': True, 'v': 'api', 'schema': 2, 'db': True, 'smtp': True, 'open': False,
                             'paused': False, 'pay': False, 'payKeys': False})
        st, hs, r = req(self.api.port, 'GET', '/api/health', ip='203.0.113.1')
        self.assertEqual((st, r), (404, {'ok': False, 'err': 'nope'}))

    def test_closed_for_strangers(self):
        n = len(self.smtp.mails)
        c = Client(self.api, '192.0.2.21')
        self.assertEqual(c('/api/code', {'email': 'stranger@example.ru'}), {'ok': False, 'err': 'closed'})
        self.assertEqual(c('/api/login', {'email': 'stranger@example.ru', 'code': '123456',
                                          'dev': 'd_' + '0' * 16, 'label': 'x'}), {'ok': False, 'err': 'closed'})
        self.assertEqual(len(self.smtp.mails), n)
        self.assertNotIn(b'stranger', self.api.raw_db())

    def test_owner_login_and_cookie(self):
        c = Client(self.api, '192.0.2.22')
        r = c('/api/code', {'email': ' Support@Example.RU '})
        self.assertEqual(r, {'ok': True, 'ttl': 900, 'resend': 60})
        m = self.smtp.msgs(SUPPORT)[-1]
        self.assertEqual(self.smtp.auths[-1], (BOX, PASSWORD))
        self.assertEqual(str(m['To']), SUPPORT)
        self.assertEqual(str(m['Reply-To']), SUPPORT)
        self.assertIn('Магнат', str(m['From']))
        self.assertIn(BOX, str(m['From']))
        self.assertRegex(str(m['Subject']), r'^[0-9]{6} — код входа в Магнат$')
        self.assertTrue(m['Date'] and str(m['Message-ID']).endswith('@example.ru>'))
        self.assertEqual(str(m['Auto-Submitted']), 'auto-generated')
        text = m.get_body(('plain',)).get_content()
        page = m.get_body(('html',)).get_content()
        code = self.smtp.last_code(SUPPORT)
        self.assertIn('Код для входа в Магнат: %s' % code, text)
        self.assertIn('Код действует 15 минут', text)
        self.assertNotIn('<img', page.lower())
        self.assertEqual(set(re.findall(r'https?://[^"\'\s<>]+', page + text)), {'https://magnat-planer.ru/'})
        r = c('/api/login', {'email': SUPPORT, 'code': code, 'dev': 'd_' + '1' * 16, 'label': 'iPhone · Safari'})
        self.assertTrue(r['ok'] and r['email'] == SUPPORT and r['head'] is None and re.fullmatch(r'a_[0-9a-f]{16}',
                                                                                              r['acct']))
        self.assertRegex(c.set, r'^__Host-mg=[A-Za-z0-9_-]{43}; Path=/; Max-Age=34560000; HttpOnly; Secure; '
                                r'SameSite=Strict$')
        r = c('/api/me', {})
        self.assertEqual((r['auth'], r['acct'], r['sub']), (True, r['acct'], None))
        self.assertNotIn(c.tok.encode(), self.api.raw_db())

    def test_protocol_gates(self):
        p = self.api.port
        ok = lambda **k: req(p, 'POST', '/api/me', {}, **k)
        st, hs, r = ok()
        self.assertEqual((st, r), (200, {'ok': True, 'auth': False}))
        h = {k.lower(): v for k, v in hs}
        self.assertEqual(h['content-type'], 'application/json; charset=utf-8')
        self.assertEqual(h['cache-control'], 'no-store')
        self.assertNotIn('server', h)
        self.assertFalse(any(k.startswith('access-control') for k in h))
        self.assertEqual(ok(headers={'Origin': 'https://evil.example'})[::2], (403, {'ok': False, 'err': 'origin'}))
        self.assertEqual(ok(headers={'Origin': None})[0], 403)
        self.assertEqual(ok(headers={'Sec-Fetch-Site': 'cross-site'})[0], 403)
        self.assertEqual(ok(headers={'Content-Type': 'text/plain'})[::2], (415, {'ok': False, 'err': 'type'}))
        self.assertEqual(req(p, 'GET', '/api/me')[::2], (405, {'ok': False, 'err': 'method'}))
        self.assertEqual(req(p, 'POST', '/api/what', {})[::2], (404, {'ok': False, 'err': 'nope'}))
        self.assertEqual(req(p, 'POST', '/api/me', raw=b'{"a":' + b'1' * 3000 + b'}')[::2],
                         (413, {'ok': False, 'err': 'big'}))
        self.assertEqual(req(p, 'POST', '/api/me', raw=b'{"a":1,"a":2}')[::2], (400, {'ok': False, 'err': 'bad'}))
        # без Content-Length — руками, http.client его ставит сам
        s = socket.create_connection(('127.0.0.1', p))
        s.sendall(('POST /api/me HTTP/1.1\r\nHost: x\r\nOrigin: %s\r\nContent-Type: application/json\r\n\r\n{}'
                   % ORIGIN).encode())
        s.settimeout(10)
        got = b''
        while True:
            x = s.recv(4096)
            if not x:
                break
            got += x
        s.close()
        self.assertTrue(got.startswith(b'HTTP/1.0 411') and got.endswith(b'{"ok":false,"err":"length"}'), got)

    def test_sync_body_limit(self):
        st, hs, r = req(self.api.port, 'POST', '/api/sync', raw=b'{"pad":"' + b'x' * (1536 * 1024) + b'"}')
        self.assertEqual((st, r), (413, {'ok': False, 'err': 'big'}))


class OpenMode(unittest.TestCase):
    """Вход открыт (MAGNAT_OPEN=1): коды, лимиты, синхронизация, удаление, приватность."""

    @classmethod
    def setUpClass(cls):
        cls.smtp = FakeSMTP()
        cls.api = Api(cls.smtp, MAGNAT_OPEN=1, MAGNAT_CODE_TTL=4, MAGNAT_CODE_GAP=2, MAGNAT_DOC_MAX=20000,
                      MAGNAT_MAIL_MIN=1000)
        cls.loris = {}
        cls.loris_t = threading.Thread(target=slowloris, args=(cls.api.port, cls.loris), daemon=True)
        cls.loris_t.start()
        cls.secrets = set()    # никогда не в БД и не в журнале: коды, токены, неподтверждённые и удалённые адреса

    @classmethod
    def tearDownClass(cls):
        cls.api.stop()
        cls.smtp.stop()
        shutil.rmtree(cls.api.state, ignore_errors=True)

    def test_codes(self):
        c = Client(self.api, '192.0.2.31')
        em = 'codes@example.ru'
        self.assertTrue(c('/api/code', {'email': em})['ok'])
        r = c('/api/code', {'email': em})
        self.assertEqual(r['err'], 'wait')
        self.assertTrue(1 <= r['retryIn'] <= 2)
        first = self.smtp.last_code(em)
        time.sleep(2.1)
        self.assertTrue(c('/api/code', {'email': em})['ok'])
        second = self.smtp.last_code(em)
        dev = 'd_' + '2' * 16
        lg = lambda x: c('/api/login', {'email': em, 'code': x, 'dev': dev, 'label': 'x'})
        if first != second:
            self.assertEqual(lg(first), {'ok': False, 'err': 'replaced', 'left': 4})
        wrongs = [w for w in ('%06d' % ((int(second) + k) % 10 ** 6) for k in range(1, 9)) if w != first][:4]
        lefts = [lg(w).get('left') for w in wrongs]
        self.assertEqual(lefts[-1], 0)
        self.assertEqual(lefts, sorted(lefts, reverse=True))
        self.assertEqual(lg(second), {'ok': False, 'err': 'tries_over'})
        time.sleep(2.1)
        self.assertTrue(c('/api/code', {'email': em})['ok'])
        third = self.smtp.last_code(em)
        time.sleep(4.2)
        self.assertEqual(lg(third), {'ok': False, 'err': 'expired'})
        self.assertEqual(c('/api/code', {'email': 'иван@example.ru'}), {'ok': False, 'err': 'bad_local'})
        self.assertEqual(c('/api/code', {'email': 'a@b.ru\r\nBcc: c@d.ru'}), {'ok': False, 'err': 'bad_email'})
        self.secrets.update((first, second, third, em))

    def test_code_reuse_and_ip_limit(self):
        c = Client(self.api, '198.51.100.40')
        em = 'reuse@example.ru'
        r = c.login(self.smtp, em)
        code = self.smtp.last_code(em)
        self.assertEqual(c('/api/login', {'email': em, 'code': code, 'dev': c.dev, 'label': 'x'}),
                         {'ok': False, 'err': 'expired'})
        res = [c('/api/code', {'email': 'ip%d@example.ru' % i}) for i in range(10)]
        self.assertEqual([x.get('err') for x in res], [None] * 9 + ['slow'])
        r = c('/api/code', {'email': 'ipz@example.ru'}, headers={'X-Forwarded-For': '1.2.3.4, 198.51.100.40'})
        self.assertEqual(r['err'], 'slow')
        self.assertGreater(r['retryIn'], 0)
        self.secrets.update((code, c.tok, 'ip3@example.ru', 'ipz@example.ru'))

    def test_sync_cas_and_idempotency(self):
        a = Client(self.api, '192.0.2.33')
        a.login(self.smtp, 'sync@example.ru')
        self.secrets.add(a.tok)
        self.assertEqual(a.pull(None), {'ok': True, 'st': 'empty', 'seqMax': 0})
        d1 = doc(3)
        r = a.push(d1, None, 'first')
        self.assertEqual((r['st'], r['head']['rev'], r['head']['sum']), ('ok', 1, {'h': 1, 'd': 3, 't': 0, 'f': 0,
                                                                                   'last': '2026-09-03'}))
        h1 = r['head']['rid']
        d2 = doc(4)
        r = a.push(d2, h1)
        h2, s2 = r['head']['rid'], a.seq
        self.assertEqual(r['st'], 'ok')
        # ответ потерян, клиент шлёт тот же seq с outHash — второй ревизии нет
        r = a.push(doc(5), h1, seq=s2, out=hashlib.sha256(d2.encode()).hexdigest())
        self.assertEqual((r['st'], r['mine']['rid'], r['doc']), ('dup', h2, d2))
        # CAS: устаревшая база — отложено, pull с головой
        r = a.push(doc(6), h1)
        self.assertEqual((r['st'], r['doc'], r['known'], r['seqMax']), ('pull', d2, True, a.seq))
        self.assertTrue(r['parked'])
        r = a.push(doc(7), h2, seq=s2)
        self.assertEqual((r['st'], r['known']), ('pull', False))
        self.assertEqual(self.api.sql("SELECT COUNT(*) FROM revisions WHERE kind='push' AND account_id=?",
                                      a.acct)[0][0], 2)
        self.assertEqual(a.pull(h2, sv=0), {'ok': False, 'err': 'old_app', 'sv': 1})
        self.assertEqual(a.push(doc(1, {'demoData': True}), h2)['err'], 'demo')
        self.assertEqual(a.push(doc(1, {'body': {'w': 80}}), h2)['err'], 'body')
        self.assertEqual(a.push(doc(1, {'pad': 'x' * 30000}), h2)['err'], 'big')
        b = Client(self.api, '192.0.2.34')
        b.login(self.smtp, 'sync2@example.ru')
        self.assertEqual(b('/api/version', {'rid': h2}), {'ok': False, 'err': 'gone'})
        r = b('/api/sync', {'pv': 1, 'acct': a.acct, 'dev': b.dev, 'sv': 1, 'base': None, 'seq': None, 'hash': None,
                            'outHash': None, 'doc': None, 'reason': 'edit'})
        self.assertEqual(r, {'ok': False, 'err': 'acct'})
        self.assertEqual(a('/api/version', {'rid': h2})['doc'], d2)

    def test_parallel_pushes(self):
        a = Client(self.api, '192.0.2.35')
        a.login(self.smtp, 'race@example.ru')
        h = a.push(doc(2), None, 'first')['head']['rid']
        res = []

        def one(i):
            d = doc(3 + i)
            st, hs, r = req(self.api.port, 'POST', '/api/sync', {
                'pv': 1, 'acct': a.acct, 'dev': a.dev, 'sv': 1, 'base': h, 'seq': 100 + i,
                'hash': hashlib.sha256(d.encode()).hexdigest(), 'outHash': None, 'doc': d, 'reason': 'edit'},
                cookie=a.tok, ip='192.0.2.35')
            res.append((st, r.get('st') or r.get('err')))
        ts = [threading.Thread(target=one, args=(i,)) for i in range(20)]
        for t in ts:
            t.start()
        for t in ts:
            t.join()
        sts = sorted(x[1] for x in res)
        self.assertTrue(all(x[0] == 200 for x in res), res)
        self.assertEqual(sts.count('ok'), 1, res)
        self.assertEqual(sts.count('pull'), 19, res)

    def test_parallel_codes(self):
        res = []

        def one(i):
            res.append(req(self.api.port, 'POST', '/api/code', {'email': 'par%d@example.ru' % i},
                           ip='203.0.113.%d' % (i + 1))[0])
        ts = [threading.Thread(target=one, args=(i,)) for i in range(20)]
        for t in ts:
            t.start()
        for t in ts:
            t.join()
        # письма уходят по два: часть запросов может получить 503 busy (клиент повторит), но не 500
        self.assertEqual(len(res), 20)
        self.assertTrue(set(res) <= {200, 503} and res.count(200) >= 16, res)

    def test_sessions_logout_restart(self):
        em = 'dev@example.ru'
        a = Client(self.api, '192.0.2.36')
        a.login(self.smtp, em)
        time.sleep(2.1)
        b = Client(self.api, '192.0.2.37')
        b.login(self.smtp, em)
        ls = a('/api/sessions', {})['list']
        self.assertEqual(len(ls), 2)
        sid_b = [x['sid'] for x in ls if not x['me']][0]
        self.assertEqual(a('/api/logout', {'sid': sid_b}), {'ok': True})
        self.assertEqual(b('/api/me', {}), {'ok': True, 'auth': False})
        old = a.tok
        self.assertEqual(a('/api/logout', {}), {'ok': True})
        self.assertIn('Max-Age=0', a.set)
        a.tok = old
        self.assertEqual(a('/api/me', {})['auth'], False)

    def test_y_slowloris(self):
        self.loris_t.join(60)
        self.assertTrue(13 <= self.loris.get('cut', 0) <= 17, self.loris)
        self.assertEqual(self.loris.get('tail'), b'', self.loris)

    def test_zz_restart_keeps_session(self):
        a = Client(self.api, '192.0.2.38')
        a.login(self.smtp, 'restart@example.ru')
        self.api.stop()
        self.api.start()
        self.assertTrue(a('/api/me', {})['auth'])
        self.secrets.add(a.tok)

    def test_delete_account(self):
        em = 'gone@example.ru'
        a = Client(self.api, '192.0.2.39')
        a.login(self.smtp, em)
        a.push(doc(2), None, 'first')
        time.sleep(2.1)
        self.assertEqual(a('/api/code', {'purpose': 'delete'})['ok'], True)
        code = self.smtp.last_any_code(em)
        self.assertIn('удаления', str(self.smtp.msgs(em)[-1]['Subject']))
        old = a.tok
        self.assertEqual(a('/api/delete', {'code': code}), {'ok': True})
        self.assertIn('Max-Age=0', a.set)
        self.assertEqual(self.api.sql('SELECT COUNT(*) FROM accounts WHERE email=?', em)[0][0], 0)
        self.assertEqual(self.api.sql('SELECT COUNT(*) FROM revisions WHERE account_id=?', a.acct)[0][0], 0)
        self.assertEqual(self.api.sql('SELECT COUNT(*) FROM deletions')[0][0], 1)
        with open(os.path.join(self.api.state, 'deletions.log')) as f:
            line = f.read()
        self.assertRegex(line, r'^[0-9]+\t[0-9a-f]{64}\n$')
        a.tok = old
        self.assertEqual(a('/api/me', {})['auth'], False)
        self.secrets.update((code, old, em))

    def test_zzz_privacy(self):
        raw = self.api.raw_db()
        for s in [b'192.0.2.', b'198.51.100.', b'203.0.113.', b'127.0.0.1', b'stranger'] + [
                x.encode() for x in self.secrets if x]:
            self.assertFalse(s in raw, 'в байтах БД есть %r' % s)
        out, err = self.api.stop()
        self.api.start()
        self.assertIn('start v=api schema=2', err)
        for s in list(self.secrets) + ['192.0.2.', '198.51.100.', '203.0.113.', '@']:
            if s:
                self.assertNotIn(s, out + err)
        for line in err.splitlines():
            self.assertRegex(line, r'^(start v=\S+ schema=\d+|smtp error \w+|stats .*|err \w+ api\.py:\d+)$')


DAY = 86400
TERMS = '2026-10-17'
CONSENT = 'Оплачиваю доступ к Магнату на 30 дней — 299 ₽, разово, без автосписаний. Принимаю соглашение.'


class PayMode(unittest.TestCase):
    """Оплата включена (MAGNAT_PAYMENTS=1), ключи Платеги заданы, Платега — поддельная на 127.0.0.1."""

    @classmethod
    def setUpClass(cls):
        cls.smtp = FakeSMTP()
        cls.pg = FakePlatega()
        cls.api = Api(cls.smtp, platega=platega_env(), MAGNAT_OPEN=1, MAGNAT_PAYMENTS=1, MAGNAT_PLATEGA_URL=cls.pg.url,
                      MAGNAT_TICK=0.2, MAGNAT_MAIL_MIN=1000, MAGNAT_CODE_GAP=0)
        cls.n = 0

    @classmethod
    def tearDownClass(cls):
        cls.api.stop()
        cls.smtp.stop()
        cls.pg.stop()
        shutil.rmtree(cls.api.state, ignore_errors=True)

    def client(self):
        PayMode.n += 1                 # своя подсеть /24 на каждого покупателя: лимиты оформления не мешают
        return Client(self.api, '198.18.%d.7' % PayMode.n)

    def checkout(self, c, em, plan='month', **kw):
        body = {'plan': plan, 'email': em, 'telegram': '', 'consent': CONSENT, 'terms': TERMS}
        body.update(kw)
        return c('/api/checkout', body)

    def hook(self, tx, status='CONFIRMED', mid=MID, secret=SECRET, ip='203.0.113.80', **extra):
        body = dict({'id': tx, 'status': status}, **extra)
        return req(self.api.port, 'POST', '/api/platega/callback', body, ip=ip,
                   headers={'Origin': None, 'Sec-Fetch-Site': None, 'X-MerchantId': mid, 'X-Secret': secret})

    def order(self, pub):
        return self.api.sql('SELECT id, tx, status, until, email, tg, ip FROM orders WHERE pub=?', pub)[0]

    def until(self, em):
        r = self.api.sql('SELECT until FROM access WHERE email=?', em)
        return r[0][0] if r else None

    def pay(self, em, plan='month', c=None):
        """Оформить и оплатить через колбэк: (ключ заказа, номер платежа, срок)."""
        r = self.checkout(c or self.client(), em, plan)
        self.assertTrue(r.get('ok'), r)
        tx = self.pg.last_tx()
        self.pg.st[tx] = 'CONFIRMED'
        self.assertEqual(self.hook(tx)[::2], (200, {'ok': True}))
        return r['o'], tx, self.until(em)

    def wait(self, cond, sec=8):
        t = time.monotonic()
        while time.monotonic() - t < sec:
            if cond():
                return True
            time.sleep(0.1)
        return False

    def test_a_health(self):
        st, hs, r = req(self.api.port, 'GET', '/api/health', ip=None)
        self.assertEqual((st, r['schema'], r['pay'], r['payKeys']), (200, 2, True, True))

    def test_checkout_callback_order(self):
        em = 'buyer@example.ru'
        c = self.client()
        r = self.checkout(c, ' Buyer@Example.ru ', telegram='@buyer_tg')
        self.assertTrue(r['ok'] and r['url'].startswith('https://pay.platega.test/') and
                        re.fullmatch(r'[A-Za-z0-9_-]{22}', r['o']), r)
        self.assertEqual(set(r), {'ok', 'url', 'o'})
        m, path, h, body = self.pg.reqs[-1]
        oid, tx = self.order(r['o'])[:2]
        self.assertEqual((m, path, h['x-merchantid'], h['x-secret'], h['content-type']),
                         ('POST', '/v2/transaction/process', MID, SECRET, 'application/json'))
        self.assertEqual(body, {'paymentDetails': {'amount': 299, 'currency': 'RUB'},
                                'description': 'Магнат — доступ на 30 дней (заказ %d)' % oid,
                                'return': 'https://magnat-planer.ru/checkout.html?o=' + r['o'],
                                'failedUrl': 'https://magnat-planer.ru/checkout.html?o=' + r['o'] + '&fail=1',
                                'payload': r['o'], 'metadata': {'orderId': str(oid)}})
        self.assertEqual(self.order(r['o'])[1:], (self.pg.last_tx(), 'pending', None, em, '@buyer_tg', c.ip))
        self.assertEqual(c('/api/order', {'o': r['o']}), {'ok': True, 'status': 'pending', 'plan': 'month',
                                                          'email': 'b•••@example.ru'})
        # неверный ключ: 403, доступа нет, Платегу не спрашивали
        self.pg.st[tx] = 'CONFIRMED'
        for kw in ({'secret': 'wrong'}, {'mid': 'other'}, {'secret': None}):
            self.assertEqual(self.hook(tx, **kw)[::2], (403, {'ok': False, 'err': 'origin'}))
        self.assertIsNone(self.until(em))
        self.assertEqual(self.pg.gets(tx), [])
        # тело говорит CONFIRMED, Платега на GET — PENDING: доступа нет
        self.pg.st[tx] = 'PENDING'
        self.assertEqual(self.hook(tx)[::2], (200, {'ok': True}))
        g = self.pg.gets(tx)
        self.assertEqual(len(g), 1)
        self.assertEqual((g[0][2]['x-merchantid'], g[0][2]['x-secret']), (MID, SECRET))
        self.assertIsNone(self.until(em))
        self.assertEqual(self.order(r['o'])[2], 'pending')
        # верный
        self.pg.st[tx] = 'CONFIRMED'
        t0 = int(time.time())
        self.assertEqual(self.hook(tx)[::2], (200, {'ok': True}))
        u = self.until(em)
        self.assertTrue(t0 + 30 * DAY - 1 <= u <= int(time.time()) + 30 * DAY + 1, (u, t0))
        self.assertEqual(self.order(r['o'])[2:4], ('paid', u))
        self.assertTrue(self.wait(lambda: self.smtp.msgs(em)))
        ms = self.smtp.msgs(em)
        self.assertEqual(len(ms), 1)
        self.assertTrue(str(ms[0]['Subject']).startswith('Оплата прошла — доступ к Магнату до '))
        text = ms[0].get_body(('plain',)).get_content()
        self.assertIn('заказ %d' % oid, text)
        self.assertIn('автосписаний нет', text)
        # повтор колбэка — ни дня сверху, второго письма нет
        self.assertEqual(self.hook(tx)[::2], (200, {'ok': True}))
        self.assertEqual(self.until(em), u)
        self.assertEqual(self.api.sql("SELECT COUNT(*) FROM payment_events WHERE order_id=? AND status='paid'", oid)[0][0], 1)
        time.sleep(0.3)
        self.assertEqual(len(self.smtp.msgs(em)), 1)
        self.assertEqual(c('/api/order', {'o': r['o']}), {'ok': True, 'status': 'paid', 'plan': 'month', 'until': u,
                                                          'email': 'b•••@example.ru'})
        self.assertEqual(c('/api/order', {'o': 'Z' * 22}), {'ok': False, 'err': 'order'})
        # номер не знаем ни мы, ни Платега (GET не дал статуса) — 503: ничего не узнали, Платега повторит
        # (не больше трёх раз); в журнале «callback unknown»
        self.assertEqual(self.hook(str(uuid.uuid4()))[::2], (503, {'ok': False, 'err': 'platega'}))

    def test_checkout_bad(self):
        c = self.client()
        n = len(self.pg.reqs)
        for kw in ({'plan': 'week'}, {'telegram': '@1x'}, {'consent': 'да'}, {'consent': None}):
            self.assertEqual(self.checkout(c, 'bad@example.ru', **kw), {'ok': False, 'err': 'bad'}, kw)
            self.assertEqual(c.status, 400)
        self.assertEqual(self.checkout(c, 'не почта'), {'ok': False, 'err': 'email'})
        self.assertEqual(self.checkout(c, 'bad@example.ru', terms='2026-10-13'), {'ok': False, 'err': 'terms'})
        self.assertEqual(req(self.api.port, 'GET', '/api/checkout')[::2], (405, {'ok': False, 'err': 'method'}))
        self.assertEqual(req(self.api.port, 'POST', '/api/checkout', {}, headers={'Origin': 'https://evil.example'})[0], 403)
        self.assertEqual(len(self.pg.reqs), n)
        self.assertEqual(self.api.sql("SELECT COUNT(*) FROM orders WHERE email='bad@example.ru'")[0][0], 0)

    def test_extend_from_remaining(self):
        em = 'ext@example.ru'
        _, _, u1 = self.pay(em)
        _, _, u2 = self.pay(em, 'year')
        self.assertEqual(u2, u1 + 365 * DAY)
        self.assertEqual(self.api.sql('SELECT plan FROM access WHERE email=?', em)[0][0], 'year')

    def test_order_page_polls(self):
        em = 'page@example.ru'
        c = self.client()
        pub = self.checkout(c, em)['o']
        tx = self.pg.last_tx()
        self.pg.st[tx] = 'CONFIRMED'
        self.assertEqual(c('/api/order', {'o': pub})['status'], 'pending')     # проверяли только что — не спрашиваем
        self.assertEqual(self.pg.gets(tx), [])
        self.api.sql('UPDATE orders SET checked=checked-20 WHERE pub=?', pub)
        self.assertEqual(c('/api/order', {'o': pub})['status'], 'paid')
        self.assertEqual(len(self.pg.gets(tx)), 1)
        self.assertIsNotNone(self.until(em))

    def test_background_polls(self):
        em = 'bg@example.ru'
        pub = self.checkout(self.client(), em)['o']
        tx = self.pg.last_tx()
        self.pg.st[tx] = 'CONFIRMED'
        time.sleep(0.5)
        self.assertEqual(self.order(pub)[2], 'pending')                       # моложе минуты с проверки — ждём
        self.api.sql('UPDATE orders SET checked=checked-120 WHERE pub=?', pub)
        self.assertTrue(self.wait(lambda: self.order(pub)[2] == 'paid'), self.order(pub))
        self.assertEqual(self.api.sql("SELECT src FROM payment_events WHERE status='paid' AND tx=?", tx), [('poll',)])

    def test_race_one_grant(self):
        em = 'race@example.ru'
        c = self.client()
        pub = self.checkout(c, em)['o']
        oid, tx = self.order(pub)[:2]
        self.pg.st[tx] = 'CONFIRMED'
        self.pg.delay = 0.4
        try:
            self.api.sql('UPDATE orders SET checked=checked-120 WHERE pub=?', pub)  # фон тоже возьмётся
            t0 = int(time.time())
            ts = [threading.Thread(target=f) for f in (lambda: self.hook(tx), lambda: self.hook(tx),
                                                       lambda: c('/api/order', {'o': pub}), lambda: self.hook(tx))]
            for t in ts:
                t.start()
            for t in ts:
                t.join()
            self.assertTrue(self.wait(lambda: self.order(pub)[2] == 'paid'))
            time.sleep(0.6)
        finally:
            self.pg.delay = 0
        u = self.until(em)
        self.assertTrue(t0 + 30 * DAY - 1 <= u <= t0 + 30 * DAY + 3, (u, t0))
        self.assertEqual(self.api.sql("SELECT COUNT(*) FROM payment_events WHERE order_id=? AND status='paid'", oid)[0][0], 1)
        self.assertEqual(len(self.smtp.msgs(em)), 1)

    def test_chargeback(self):
        em = 'back@example.ru'
        p1, tx1, u1 = self.pay(em)
        _, _, u2 = self.pay(em, 'year')
        n = len(self.smtp.msgs(SUPPORT))
        self.pg.st[tx1] = 'CHARGEBACKED'
        self.assertEqual(self.hook(tx1, 'CHARGEBACKED')[::2], (200, {'ok': True}))
        self.assertEqual(self.hook(tx1, 'CHARGEBACKED')[::2], (200, {'ok': True}))
        self.assertEqual(self.order(p1)[2], 'chargeback')
        self.assertEqual(self.until(em), u2 - 30 * DAY)
        self.assertTrue(self.wait(lambda: len(self.smtp.msgs(SUPPORT)) == n + 1))
        self.assertTrue(str(self.smtp.msgs(SUPPORT)[-1]['Subject']).startswith('Магнат: банк вернул деньги по заказу'))
        self.assertEqual(Client(self.api)('/api/order', {'o': p1})['status'], 'failed')

    def test_me_sub(self):
        em = 'sub@example.ru'
        a = Client(self.api, '192.0.2.90')
        a.login(self.smtp, em)
        self.assertIsNone(a('/api/me', {})['sub'])
        _, _, u = self.pay(em)
        self.assertEqual(a('/api/me', {})['sub'], {'plan': 'month', 'until': u, 'active': True})

    def test_delete_forgets_orders(self):
        em, tg = 'gone-pay@example.ru', '@gone_pay'
        a = Client(self.api, '192.0.2.91')
        a.login(self.smtp, em)
        c = self.client()
        pub = self.checkout(c, em, telegram=tg)['o']
        tx = self.pg.last_tx()
        self.pg.st[tx] = 'CONFIRMED'
        self.hook(tx)
        self.assertIsNotNone(self.until(em))
        self.assertTrue(a('/api/code', {'purpose': 'delete'})['ok'])
        self.assertEqual(a('/api/delete', {'code': self.smtp.last_any_code(em)}), {'ok': True})
        self.assertEqual(self.order(pub)[2:], ('paid', self.order(pub)[3], None, None, None))
        self.assertEqual(self.api.sql('SELECT amount_kop FROM orders WHERE pub=?', pub), [(29900,)])
        self.assertIsNone(self.until(em))
        raw = self.api.raw_db()
        for s in (em, tg, c.ip):
            self.assertNotIn(s.encode(), raw)

    def test_cli(self):
        em = 'cli-pay@example.ru'
        pub, tx, u = self.pay(em)
        oid = self.order(pub)[0]
        rc, o, e = self.api.cli('grant', 'grant@example.ru', '10', '--db', self.api.db, '--note', 'не включился')
        self.assertEqual(rc, 0, o + e)
        self.assertRegex(o.decode().strip(), r'^grant-ok until=\d{4}-\d{2}-\d{2}$')
        self.assertTrue(10 * DAY - 60 <= self.until('grant@example.ru') - time.time() <= 10 * DAY + 60)
        for bad in ('-5', '0', '3661', 'x'):
            self.assertEqual(self.api.cli('grant', 'grant@example.ru', bad, '--db', self.api.db)[0], 2, bad)
        self.assertEqual(self.api.cli('grant', 'не почта', '5', '--db', self.api.db)[0], 1)
        rc, o, e = self.api.cli('orders', '--db', self.api.db, '--month', time.strftime('%Y-%m', time.gmtime(time.time())))
        out = o.decode()
        self.assertEqual(rc, 0, out + e.decode())
        self.assertRegex(out, r'(?m)^\d\d\.\d\d\.\d{4} \d\d:\d\d UTC · 299 ₽ · месяц · заказ %d · c•••@example\.ru$' % oid)
        self.assertRegex(out, r'(?m)^Итого за \d{4}-\d\d: \d+ оплат\w* на [\d ]+ ₽\.$')
        for who in re.findall(r'(\S+)@', out):
            self.assertRegex(who, r'^.•••$')               # адреса только маской
        self.assertNotIn('grant@', out)
        self.assertEqual(self.api.cli('orders', '--db', self.api.db, '--month', '2026-13')[0], 2)
        rc, o, e = self.api.cli('orders', '--db', self.api.db, '--month', '2001-01')
        self.assertEqual((rc, o.decode().strip()), (0, 'За 2001-01 оплат нет.'))
        rc, o, e = self.api.cli('stats', '--db', self.api.db)
        st = json.loads(o)
        self.assertTrue(st['pay_on'] and st['pay_keys'] and st['pay_paid_month'] >= 1 and st['pay_last_callback'] > 0
                        and st['access_active'] >= 2 and st['pay_sum_month_kop'] >= 29900, st)
        self.assertNotIn(b'@', o)
        self.assertNotIn(SECRET.encode(), o + e)
        # запросы людей: заказы без аккаунта видны и стираются
        rc, o, e = self.api.cli('user', 'show', em, '--db', self.api.db)
        out = o.decode()
        self.assertIn('Аккаунта с этим адресом нет.', out)
        self.assertRegex(out, r'Заказы \(1\): \d\d\.\d\d\.\d{4} · месяц · 299 ₽ · оплачен · заказ %d' % oid)
        self.assertIn('Доступ: до ', out)
        self.assertNotIn(em, out)
        rc, o, e = self.api.cli('user', 'export', em, '--db', self.api.db, '--creds', '-',
                                stdin=smtp_env(self.smtp.port).encode())
        self.assertEqual((rc, o.strip()), (0, b'export-ok'))
        att = [p for p in self.smtp.msgs(em)[-1].iter_attachments()][0]
        data = json.loads(att.get_content())
        self.assertEqual((data['account'], data['orders'][0]['order'], data['orders'][0]['status'], data['access']['until']),
                         (None, oid, 'paid', u))
        log = os.path.join(self.api.state, 'deletions.log')

        def lines():
            if not os.path.exists(log):
                return 0
            with open(log) as f:
                return f.read().count('\n')

        n_log, n_tab = lines(), self.api.sql('SELECT COUNT(*) FROM deletions')[0][0]
        rc, o, e = self.api.cli('user', 'delete', em, '--db', self.api.db)
        self.assertEqual(rc, 0)
        self.assertIn('заказы (1) отвязаны', o.decode())
        self.assertIn('надгробие записано', o.decode())
        self.assertEqual(self.order(pub)[4:], (None, None, None))
        self.assertIsNone(self.until(em))
        # след, как у удаления аккаунта: восстановленная копия не вернёт почту в заказы (replay)
        self.assertEqual((lines(), self.api.sql('SELECT COUNT(*) FROM deletions')[0][0]), (n_log + 1, n_tab + 1))

    # ── ревью оплаты 17.10 ──

    def alerts(self, part):
        return [m for m in self.smtp.msgs(SUPPORT) if part in str(m['Subject'])]

    def test_callback_503_and_retry(self):
        # Колбэк, который ничего не сделал, — 503: Платега повторит (200 значил бы «принято»).
        em = 'retry503@example.ru'
        pub, tx, u = self.pay(em)
        self.pg.st[tx] = 'CHARGEBACKED'
        self.pg.gdown = True
        try:
            self.assertEqual(self.hook(tx, 'CHARGEBACKED')[::2], (503, {'ok': False, 'err': 'platega'}))
        finally:
            self.pg.gdown = False
        self.assertEqual(self.order(pub)[2], 'paid')
        self.assertEqual(self.hook(tx, 'CHARGEBACKED')[::2], (200, {'ok': True}))
        self.assertEqual(self.order(pub)[2], 'chargeback')
        self.assertEqual(self.until(em), u - 30 * DAY)
        rs = [self.hook(tx, secret='guess%d' % i, ip='198.18.250.9')[0] for i in range(20)]
        st, _, r = self.hook(tx, ip='198.18.250.9')
        self.assertEqual(rs, [403] * 20)
        self.assertEqual((st, r['ok'], r['err']), (503, False, 'slow'))
        self.assertGreater(r['retryIn'], 0)

    def test_old_order_platega_down(self):
        # Счёт старше суток, Платега молчит на GET: не expired, не каждый тик; «оплачено» в уведомлении — тревога.
        pub = self.checkout(self.client(), 'old-down@example.ru')['o']
        oid, tx = self.order(pub)[:2]
        self.pg.st[tx] = 'CONFIRMED'
        part = 'по заказу %d, но за сутки не подтвердила' % oid
        self.pg.gdown = True
        try:
            self.assertEqual(self.hook(tx)[::2], (503, {'ok': False, 'err': 'platega'}))
            self.api.sql('UPDATE orders SET at=at-?, checked=checked-1000 WHERE pub=?', DAY + 100, pub)
            self.assertTrue(self.wait(lambda: len(self.alerts(part)) == 1), 'тревоги нет')
            time.sleep(0.6)
            self.assertEqual(self.order(pub)[2], 'pending')
            self.assertEqual(len(self.pg.gets(tx)), 2)           # колбэк и фон; следующий вопрос — через 15 минут
        finally:
            self.pg.gdown = False
        self.api.sql('UPDATE orders SET checked=checked-1000 WHERE pub=?', pub)
        self.assertTrue(self.wait(lambda: self.order(pub)[2] == 'paid'), self.order(pub))
        self.assertEqual(len(self.alerts(part)), 1)

    def test_paid_recheck_chargeback(self):
        # Оплаченный раз в сутки перепроверяется фоном: возврат банком без уведомления не теряется.
        em = 'recheck@example.ru'
        pub, tx, u = self.pay(em)
        self.pg.st[tx] = 'CHARGEBACKED'
        self.api.sql('UPDATE orders SET checked=checked-? WHERE pub=?', DAY + 10, pub)
        self.assertTrue(self.wait(lambda: self.order(pub)[2] == 'chargeback'), self.order(pub))
        self.assertEqual(self.until(em), u - 30 * DAY)
        self.assertEqual(self.api.sql("SELECT src FROM payment_events WHERE status='chargeback' AND tx=?", tx), [('poll',)])

    def test_paid_without_email(self):
        # Почту заказа стёрли, пока счёт ждал: деньги пришли — тревога владельцу, страница без срока и почты.
        c = self.client()
        pub = self.checkout(c, 'wiped@example.ru')['o']
        oid, tx = self.order(pub)[:2]
        self.api.sql('UPDATE orders SET email=NULL WHERE pub=?', pub)
        self.pg.st[tx] = 'CONFIRMED'
        self.assertEqual(self.hook(tx)[::2], (200, {'ok': True}))
        self.assertEqual(c('/api/order', {'o': pub}), {'ok': True, 'status': 'paid', 'plan': 'month', 'email': ''})
        self.assertTrue(self.wait(lambda: self.alerts('оплачен заказ %d без почты — выдай вручную (magnat grant) или '
                                                      'верни деньги' % oid)))

    def test_pay_window(self):
        # Медленная Платега держит своё окно (4 места), а не все 16 мест API: вход и /api/me живы.
        pub = self.checkout(self.client(), 'window@example.ru')['o']
        tx = self.pg.last_tx()
        res = []
        self.pg.delay = 4
        try:
            ts = [threading.Thread(target=lambda: res.append(self.hook(tx, 'PENDING')[::2])) for _ in range(4)]
            for t in ts:
                t.start()
            time.sleep(1.5)
            t0 = time.monotonic()
            busy = self.hook(tx)[::2]
            co = self.checkout(self.client(), 'window2@example.ru')
            me = Client(self.api, '192.0.2.95')('/api/me', {})
            dt = time.monotonic() - t0
            for t in ts:
                t.join()
        finally:
            self.pg.delay = 0
        self.assertEqual(busy, (503, {'ok': False, 'err': 'busy'}))
        self.assertEqual(co, {'ok': False, 'err': 'platega'})
        self.assertEqual(self.api.sql("SELECT COUNT(*) FROM orders WHERE email='window2@example.ru'")[0][0], 0)
        self.assertEqual(me, {'ok': True, 'auth': False})
        self.assertLess(dt, 2)
        self.assertEqual(res, [(200, {'ok': True})] * 4)
        self.assertEqual(self.order(pub)[2], 'pending')

    def test_refund_cli(self):
        # magnat refund: заказ refunded, доступ снят, повтор — не 0; orders — «чек аннулировать», --full — адрес.
        em = 'refund-cli@example.ru'
        pub, tx, u = self.pay(em)
        oid = self.order(pub)[0]
        rc, o, e = self.api.cli('refund', str(oid), '--db', self.api.db)
        self.assertEqual((rc, o.decode().strip()), (0, 'refund-ok order=%d until=нет' % oid), e)
        self.assertEqual(self.order(pub)[2], 'refunded')
        self.assertLessEqual(self.until(em), time.time() + 1)
        self.assertEqual(self.api.sql("SELECT status FROM payment_events WHERE order_id=? AND src='admin'", oid),
                         [('refunded',)])
        rc, o, e = self.api.cli('refund', str(oid), '--db', self.api.db)
        self.assertEqual((rc, o.decode().strip()), (1, 'Заказ %d уже возвращён.' % oid))
        self.assertEqual(self.api.cli('refund', '0x', '--db', self.api.db)[0], 2)
        self.assertEqual(self.hook(tx)[::2], (200, {'ok': True}))         # CONFIRMED снова — не воскрешает
        self.assertEqual(self.order(pub)[2], 'refunded')
        self.assertEqual(Client(self.api)('/api/order', {'o': pub})['status'], 'failed')
        m = time.strftime('%Y-%m', time.gmtime(self.api.sql('SELECT paid_at FROM orders WHERE id=?', oid)[0][0]))
        rc, o, e = self.api.cli('orders', '--db', self.api.db, '--month', m)
        out = o.decode()
        n = self.api.sql("SELECT COUNT(*) FROM orders WHERE status='paid' AND strftime('%Y-%m', paid_at, 'unixepoch')=?", m)
        self.assertRegex(out, r'(?m)^.* · заказ %d · r•••@example\.ru · возврат — чек аннулировать$' % oid)
        self.assertRegex(out, r'(?m)^Итого за %s: %d оплат' % (m, n[0][0]))
        rc, o, e = self.api.cli('orders', '--db', self.api.db, '--month', m, '--full')
        self.assertEqual(rc, 0)
        self.assertIn('заказ %d · %s · возврат — чек аннулировать' % (oid, em), o.decode())

    def test_unknown_paid_alert(self):
        # Уведомление по счёту, которого нет в базе (копия старше оплаты), а GET — оплачен: тревога, одна на номер.
        ghost = str(uuid.uuid4())
        self.pg.st[ghost] = 'CONFIRMED'
        for _ in range(2):
            self.assertEqual(self.hook(ghost)[::2], (200, {'ok': True}))
        self.assertTrue(self.wait(lambda: self.alerts(ghost)))
        time.sleep(0.3)
        self.assertEqual(len(self.alerts(ghost)), 1)
        self.assertEqual(len(self.pg.gets(ghost)), 2)

    def test_maintain_retention(self):
        # maintain: неоплаченный старше 30 дней с оформления — без почты, Telegram, IP и тела уведомления; старше 5 лет — прочь.
        now = int(time.time())
        ins = ("INSERT INTO orders(pub, at, email, tg, plan, days, amount_kop, consent, terms_ed, ip, tx, status, checked, "
               "paid_at, until, updated) VALUES(?, ?, 'old-unpaid@example.ru', '@old_unpaid', 'month', 30, 29900, 'c', ?, "
               "'198.18.251.1', NULL, ?, 0, NULL, NULL, ?)")
        for pub, st, at, upd in (('ret-failed-31', 'failed', 31, 1), ('ret-expired-29', 'expired', 29, 29),
                                 ('ret-paid-ancient', 'paid', 1828, 1828)):
            self.api.sql(ins, pub, now - at * DAY, TERMS, st, now - upd * DAY)
            self.api.sql("INSERT INTO payment_events(order_id, tx, status, src, at, raw) SELECT id, NULL, 'CONFIRMED', "
                         "'callback', at, '{\"id\":\"x\"}' FROM orders WHERE pub=?", pub)
        rc, o, e = self.api.cli('maintain', '--db', self.api.db)
        self.assertEqual(rc, 0, o + e)
        self.assertRegex(o.decode(), r'orders_dropped=1 .*unpaid_wiped=1$')
        row = lambda pub: self.api.sql('SELECT o.email, o.tg, o.ip, e.raw FROM orders o JOIN payment_events e ON '
                                       'e.order_id=o.id WHERE o.pub=?', pub)
        self.assertEqual(row('ret-failed-31'), [(None, None, None, None)])
        self.assertEqual(row('ret-expired-29'), [('old-unpaid@example.ru', '@old_unpaid', '198.18.251.1', '{"id":"x"}')])
        self.assertEqual(row('ret-paid-ancient'), [])
        self.assertEqual(self.api.sql('SELECT COUNT(*) FROM payment_events WHERE order_id NOT IN (SELECT id FROM orders)'),
                         [(0,)])

    def test_zy_reminder_once(self):
        em = 'remind@example.ru'
        rc, o, e = self.api.cli('grant', em, '2', '--db', self.api.db)
        self.assertEqual(rc, 0, o + e)
        self.api.stop()
        self.api.start()                     # письма о сроке — на первом шаге фона после старта
        self.assertTrue(self.wait(lambda: self.smtp.msgs(em)), 'напоминание не пришло')
        m = self.smtp.msgs(em)[0]
        self.assertTrue(str(m['Subject']).startswith('Доступ к Магнату заканчивается '))
        self.assertIn('https://magnat-planer.ru/checkout.html?plan=month', m.get_body(('plain',)).get_content())
        self.assertTrue(self.api.sql('SELECT warned FROM access WHERE email=?', em)[0][0].endswith(':soon'))
        self.api.stop()
        self.api.start()
        time.sleep(1.5)
        self.assertEqual(len(self.smtp.msgs(em)), 1)

    def test_zz_secret_and_journal(self):
        raw = self.api.raw_db()
        self.assertNotIn(SECRET.encode(), raw)
        self.api.stop()
        self.api.start()
        logs = ''.join(self.api.errs)
        self.assertNotIn(SECRET, logs)
        self.assertNotIn('@', logs)
        self.assertIn('callback unknown', logs)
        for line in logs.splitlines():
            self.assertRegex(line, r'^(start v=\S+ schema=\d+|smtp error \w+|stats .*|platega \w+ \w+|callback unknown|'
                                   r'err \w+ api\.py:\d+)$')


class PayFaults(unittest.TestCase):
    """Ключей нет, Платега лежит, отдаёт не https или перенаправляет; форма со способом оплаты."""

    def test_faults(self):
        pg = FakePlatega()
        off = Api(None, MAGNAT_PAYMENTS=1, MAGNAT_PLATEGA_URL=pg.url)
        on = Api(None, platega=platega_env(), MAGNAT_PAYMENTS=1, MAGNAT_PLATEGA_URL=pg.url)
        sbp = Api(None, platega=platega_env('2'), MAGNAT_PAYMENTS=1, MAGNAT_PLATEGA_URL=pg.url)
        body = {'plan': 'month', 'email': 'f@example.ru', 'telegram': '', 'consent': CONSENT, 'terms': TERMS}
        try:
            self.assertEqual(Client(off)('/api/checkout', body), {'ok': False, 'err': 'pay_off'})
            self.assertFalse(req(off.port, 'GET', '/api/health', ip=None)[2]['payKeys'])
            self.assertEqual(off.sql('SELECT COUNT(*) FROM orders')[0][0], 0)
            self.assertEqual(pg.reqs, [])
            for i, mode in enumerate(('down', 'http', 'redirect')):
                pg.mode = mode
                self.assertEqual(Client(on, '192.0.2.%d' % (i + 1))('/api/checkout', body),
                                 {'ok': False, 'err': 'platega'}, mode)
                self.assertEqual(on.sql('SELECT status, tx FROM orders ORDER BY id DESC LIMIT 1'), [('failed', None)], mode)
            self.assertFalse(any(r[1] == '/stolen' for r in pg.reqs), 'перенаправление выполнено — ключ ушёл бы чужим')
            # счета не создаются: magnat status видит сбои за сутки и класс последнего — без тела ответа и ключа
            rc, o, e = on.cli('stats', '--db', on.db)
            st = json.loads(o)
            self.assertEqual((rc, st['pay_failed_day'], st['pay_err']), (0, 3, 'http302'))
            self.assertTrue(time.time() - 60 < st['pay_err_at'] <= time.time() + 1, st['pay_err_at'])
            self.assertNotIn(SECRET.encode(), o + e)
            self.assertRegex(on.sql("SELECT v FROM meta WHERE k='pay_err'")[0][0], r'^\d+ http302$')
            pg.mode = 'ok'
            r = Client(sbp)('/api/checkout', body)
            # форма со способом: ссылка — redirect (url в ответе — приманка поддельной Платеги)
            self.assertTrue(r['ok'] and r['url'].startswith('https://pay.platega.test/'), r)
            self.assertEqual((pg.reqs[-1][1], pg.reqs[-1][3]['paymentMethod']), ('/transaction/process', 2))
            r = Client(on, '192.0.2.40')('/api/checkout', body)
            self.assertTrue(r['ok'] and r['url'].startswith('https://pay.platega.test/'), r)
        finally:
            outs = [a.stop() for a in (off, on, sbp)]
            pg.stop()
            for a in (off, on, sbp):
                shutil.rmtree(a.state, ignore_errors=True)
        err = outs[1][1]
        self.assertIn('platega create http500', err)
        self.assertIn('platega create http302', err)
        self.assertNotIn(SECRET, ''.join(o + e for o, e in outs))


class MailFaults(unittest.TestCase):
    def test_535_burns_code(self):
        smtp = FakeSMTP('535')
        api = Api(smtp, MAGNAT_OPEN=1)
        try:
            c = Client(api, '192.0.2.50')
            self.assertEqual(c('/api/code', {'email': 'x@example.ru'}), {'ok': False, 'err': 'mail_fail'})
            self.assertEqual(api.sql('SELECT state FROM codes'), [(3,)])
            self.assertEqual(api.sql("SELECT COUNT(*) FROM mail_count")[0][0], 2)
            self.assertRegex(api.sql("SELECT v FROM meta WHERE k='mail_err'")[0][0], r'^\d+ SMTPAuthenticationError$')
        finally:
            out, err = api.stop()
            smtp.stop()
            shutil.rmtree(api.state, ignore_errors=True)
        self.assertIn('smtp error SMTPAuthenticationError', err)
        self.assertNotIn('x@example.ru', err)

    def test_mail_off_and_paused(self):
        api = Api(None, MAGNAT_OPEN=1)
        try:
            open(api.smtp_file, 'w').close()
            self.assertEqual(Client(api)('/api/code', {'email': 'x@example.ru'}), {'ok': False, 'err': 'mail_off'})
            st, hs, r = req(api.port, 'GET', '/api/health', ip=None)
            self.assertEqual((st, r['ok'], r['smtp']), (200, True, False))
            open(os.path.join(api.state, 'mail.off'), 'w').close()
            self.assertEqual(Client(api)('/api/code', {'email': 'x@example.ru'}), {'ok': False, 'err': 'paused'})
            self.assertTrue(req(api.port, 'GET', '/api/health', ip=None)[2]['paused'])
        finally:
            api.stop()
            shutil.rmtree(api.state, ignore_errors=True)

    def test_busy_503(self):
        smtp = FakeSMTP('slow', slow=4)
        api = Api(smtp, MAGNAT_OPEN=1)
        res = []
        try:
            def one(i):
                res.append(req(api.port, 'POST', '/api/code', {'email': 'busy%d@example.ru' % i},
                               ip='198.51.100.%d' % (i + 1))[::2])
            ts = [threading.Thread(target=one, args=(i,)) for i in range(20)]
            for t in ts:
                t.start()
                time.sleep(0.02)
            for t in ts:
                t.join()
        finally:
            api.stop()
            smtp.stop()
            shutil.rmtree(api.state, ignore_errors=True)
        sts = [st for st, _ in res]
        self.assertNotIn(500, sts)
        self.assertIn((503, {'ok': False, 'err': 'busy'}), res)
        self.assertTrue(any(r == {'ok': False, 'err': 'busy', 'retryIn': 30} for _, r in res), res)


class Cli(unittest.TestCase):
    def test_cli(self):
        smtp = FakeSMTP()
        api = Api(smtp, MAGNAT_OPEN=1)
        try:
            a = Client(api, '192.0.2.60')
            a.login(smtp, 'cli@example.ru')
            a.push(doc(3), None, 'first')
            rc, o, e = api.cli('backup', '--db', api.db, '--out', '-')
            self.assertEqual(rc, 0, e)
            self.assertTrue(o.startswith(b'SQLite format 3\0'))
            bk = os.path.join(api.state, 'tmp', 'restore.db')
            with open(bk, 'wb') as f:
                f.write(o)
            self.assertEqual(os.listdir(os.path.join(api.state, 'tmp')), ['restore.db'])
            rc, o, e = api.cli('verify', bk)
            self.assertEqual((rc, o.decode().strip()), (0, 'integrity=ok accounts=1 newest=%s' %
                                                         time.strftime('%Y-%m-%d', time.gmtime())))
            rc, o, e = api.cli('stats', '--db', api.db)
            st = json.loads(o)
            self.assertEqual((rc, st['accounts'], st['month']['logins_ok'], st['month']['pushes']), (0, 1, 1, 1))
            self.assertNotIn(b'@', o)
            rc, o, e = api.cli('check', '--db', api.db)
            self.assertEqual((rc, o.strip()), (0, b'api-check-ok'))
            self.assertEqual(api.sql('SELECT COUNT(*) FROM accounts')[0][0], 1)
            rc, o, e = api.cli('maintain', '--db', api.db)
            self.assertEqual(rc, 0, o + e)
            self.assertTrue(o.startswith(b'maintain-ok'))
            rc, o, e = api.cli('user', 'show', 'CLI@example.ru', '--db', api.db)
            self.assertIn('Аккаунт есть', o.decode())
            self.assertNotIn(b'cli@', o)
            creds = smtp_env(smtp.port).encode()
            rc, o, e = api.cli('user', 'export', 'cli@example.ru', '--db', api.db, '--creds', '-', stdin=creds)
            self.assertEqual((rc, o.strip()), (0, b'export-ok'))
            m = smtp.msgs('cli@example.ru')[-1]
            att = [p for p in m.iter_attachments()][0]
            self.assertRegex(att.get_filename(), r'^magnat-\d{4}-\d{2}-\d{2}\.json$')
            data = json.loads(att.get_content())
            self.assertEqual(data['data']['checks'], json.loads(doc(3))['checks'])
            rc, o, e = api.cli('mailtest', '--creds', '-', '--to', SUPPORT, stdin=creds)
            self.assertEqual((rc, o.strip()), (0, b'mail-ok'))
            self.assertEqual(str(smtp.msgs(SUPPORT)[-1]['Subject']), 'Проверка: почта Магната настроена')
            self.assertNotIn(PASSWORD.encode(), o + e)
            rc, o, e = api.cli('alert', '--creds', '-', '--kind', 'api_down', '--text', 'API не отвечает', stdin=creds)
            self.assertEqual((rc, o.strip()), (0, b'mail-ok'))
            self.assertEqual(str(smtp.msgs(SUPPORT)[-1]['Subject']), 'Магнат: API не отвечает')
            bad = FakeSMTP('535')
            rc, o, e = api.cli('mailtest', '--creds', '-', '--to', SUPPORT, stdin=smtp_env(bad.port).encode())
            bad.stop()
            self.assertEqual((rc, o.strip()), (1, b'mail-fail auth SMTPAuthenticationError'))
            rc, o, e = api.cli('mailtest', '--creds', '-', '--to', SUPPORT, stdin=smtp_env(free_port()).encode())
            self.assertEqual(rc, 1)
            self.assertTrue(o.startswith(b'mail-fail connect'), o)
            rc, o, e = api.cli('user', 'delete', 'cli@example.ru', '--db', api.db)
            self.assertEqual(rc, 0)
            self.assertEqual(api.sql('SELECT COUNT(*) FROM accounts')[0][0], 0)
            self.assertEqual(a('/api/me', {})['auth'], False)
            # восстановление старой копии: надгробие применяется, сессий нет
            api.stop()
            os.replace(bk, api.db)
            for s in ('-wal', '-shm'):
                if os.path.exists(api.db + s):
                    os.unlink(api.db + s)
            rc, o, e = api.cli('replay', '--db', api.db)
            self.assertEqual((rc, o.strip()), (0, b'replay-ok accounts=1 sessions=0'))
            self.assertEqual(api.sql('SELECT COUNT(*) FROM accounts')[0][0], 0)
            api.start()
        finally:
            api.stop()
            smtp.stop()
            shutil.rmtree(api.state, ignore_errors=True)

    def test_selftest(self):
        r = subprocess.run([PY, '-I', API, 'selftest'], capture_output=True, timeout=120)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertTrue(r.stdout.startswith(b'selftest ok'))


if __name__ == '__main__':
    unittest.main(verbosity=2)
