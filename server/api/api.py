#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Магнат: вход по почте с одноразовым кодом и синхронизация данных.

Один процесс, только stdlib Python 3.12 (Ubuntu 24.04), ни одной зависимости.
Запуск всегда `python3 -I api.py <команда>` и всегда от пользователя
magnat-api: root этот файл не запускает (magnat.sh зовёт его через runuser).

Секции: Config, Util, Store (миграции), Limits, Mailer, Letters, Routes,
Maintenance, HTTP, CLI, Selftest.

Протокол (подробно — спецификация аккаунта, §3):
  * каждый ответ — JSON, Cache-Control: no-store, Content-Length, без CORS;
  * ожидаемые исходы — 200 {ok:true,...} или {ok:false, err:'<код>'};
    нарушения протокола — 400 bad, 403 origin, 404 nope, 405 method,
    411 length, 413 big, 415 type, 503 busy; сбой обработчика — 500 server;
  * время в ответах (`at`, `pin`) — секунды Unix, UTC;
  * сессия — cookie `__Host-mg` (HttpOnly; Secure; SameSite=Strict; Path=/ —
    префикс __Host- требует именно Path=/, иначе браузер её отбросит).

Команды:
  serve                         — служба (по умолчанию);
  check --db LIVE               — копия живой БД, миграции, прогон
                                  code→login→sync→versions; «api-check-ok»;
  selftest                      — проверки без сети; «selftest ok …»;
  backup --db SRC --out -       — онлайн-копия, integrity_check, файл в stdout;
  verify FILE                   — «integrity=ok accounts=N newest=YYYY-MM-DD»;
  maintain --db DB              — прореживание и чистка, «maintain-ok …»;
  replay --db DB                — надгробия из deletions.log + удаление
                                  всех сессий, «replay-ok …»;
  stats --db DB                 — JSON для magnat status, без персональных данных;
  mailtest --creds - --to ADDR  — проверочное письмо; «mail-ok» или
                                  «mail-fail <auth|connect|tls|config|other> <Класс>»;
  alert --creds - --kind K --text T — письмо-тревога на SUPPORT (тот же вывод);
  user show|export|delete EMAIL --db DB [--creds -] — запросы людей о данных.
Учётные данные почты приходят только через stdin (`--creds -`), никогда в argv.

В журнал (stderr) попадают только строки `start v=… schema=…`,
`smtp error <Класс>`, `stats …` и `err <Класс> api.py:<строка>`. Никогда —
адрес, IP, код, токен или документ. IP живёт только в памяти (≤24 ч, ради
лимитов) и не пишется ни в БД, ни в журнал.
"""

import contextlib
import fcntl
import hashlib
import hmac
import html
import http.client
import http.server
import io
import ipaddress
import json
import os
import re
import secrets
import shutil
import signal
import smtplib
import socket
import socketserver
import sqlite3
import ssl
import sys
import tempfile
import threading
import time
import unicodedata
import urllib.parse
import zlib
from collections import deque
from email.message import EmailMessage
from email.utils import formataddr, formatdate, make_msgid

# ═══════════════════════════ Config ═══════════════════════════

OPEN = False        # R3 «включай»: True — код получает любой адрес (вместе с ACCOUNT_ON в app.html)
PAYMENTS = False    # Платега (§13): маршруты оплаты появятся вместе с миграцией 2
SCHEMA = 1          # схема, которую знает этот код (последняя миграция)

SITE = 'https://magnat-planer.ru/'
COOKIE = '__Host-mg'
DAY = 86400
REASONS = ('edit', 'merge', 'first', 'join', 'reset', 'restore')
PIN_REASONS = ('reset', 'restore', 'join')
MAX_SESSIONS = 10
RENEW_AFTER = 7 * DAY
PIN_FOR = 90 * DAY
SYNC_BODY = 1536 * 1024      # 1,5 МБ тела /api/sync
SMALL_BODY = 2048            # 2 КБ остальных маршрутов
READ_HEADERS = 15            # секунд на заголовки (slowloris)
READ_BODY = 60               # секунд на всё тело
MAX_CONNS = 48               # соединений с потоком (TasksMax=64)


def _num(env, k, d, lo, hi, kind=int):
    try:
        v = kind(env.get(k, d))
    except (TypeError, ValueError):
        return d
    return v if lo <= v <= hi else d


class Cfg:
    """Настройки из окружения (безопасные значения по умолчанию, тесты их переопределяют)."""

    def __init__(self, env=None):
        env = os.environ if env is None else env
        self.listen = env.get('MAGNAT_LISTEN', '127.0.0.1:8787')
        self.db = env.get('MAGNAT_DB', '/var/lib/magnat-api/magnat.db')
        self.state = env.get('MAGNAT_STATE', '/var/lib/magnat-api')
        self.origin = env.get('MAGNAT_ORIGIN', 'https://magnat-planer.ru')
        cd = env.get('CREDENTIALS_DIRECTORY', '')
        self.smtp_file = env.get('MAGNAT_SMTP_FILE') or (os.path.join(cd, 'smtp') if cd else '')
        o = env.get('MAGNAT_OPEN', '').strip().lower()
        self.open = OPEN if o == '' else o in ('1', 'true', 'yes', 'on')
        self.code_ttl = _num(env, 'MAGNAT_CODE_TTL', 900, 1, DAY)
        self.code_tries = _num(env, 'MAGNAT_CODE_TRIES', 5, 1, 100)
        self.code_gap = _num(env, 'MAGNAT_CODE_GAP', 60, 0, 3600)
        self.mail_day = _num(env, 'MAGNAT_MAIL_DAY', 300, 0, 10 ** 6)
        self.mail_min = _num(env, 'MAGNAT_MAIL_MIN', 30, 0, 10 ** 6)
        self.doc_max = _num(env, 'MAGNAT_DOC_MAX', 1048576, 1, 64 * 1048576)
        self.acct_bytes = _num(env, 'MAGNAT_ACCT_BYTES', 20971520, 0, 10 ** 10)
        self.push_day = _num(env, 'MAGNAT_PUSH_DAY', 500, 0, 10 ** 6)
        self.park_day = _num(env, 'MAGNAT_PARK_DAY', 20, 0, 10 ** 6)
        self.idle_days = _num(env, 'MAGNAT_SESSION_IDLE_DAYS', 180, 1, 10000)
        self.max_days = _num(env, 'MAGNAT_SESSION_MAX_DAYS', 400, 1, 10000)
        self.inactive_days = _num(env, 'MAGNAT_INACTIVE_DAYS', 730, 1, 100000)
        self.disk_min_mb = _num(env, 'MAGNAT_DISK_MIN_MB', 1024, 0, 10 ** 9)
        self.limit_scale = _num(env, 'MAGNAT_LIMIT_SCALE', 1.0, 1e-6, 1000.0, float)
        self.now_shift = _num(env, 'MAGNAT_NOW_SHIFT', 0, -10 ** 10, 10 ** 10)


# ═══════════════════════════ Util ═══════════════════════════

RE_ACCT = re.compile(r'a_[0-9a-f]{16}')
RE_RID = re.compile(r'r_[0-9a-f]{16}')
RE_SID = re.compile(r's_[0-9a-f]{12}')
RE_DEV = re.compile(r'd_[0-9a-f]{16}')
RE_HEX = re.compile(r'[0-9a-f]{64}')
RE_CODE = re.compile(r'[0-9]{6}')
RE_TOKEN = re.compile(r'[A-Za-z0-9_-]{43}')
RE_LABEL = re.compile(r'[A-Za-zА-Яа-яЁё0-9 ·._()-]{1,40}')
RE_DOCKEY = re.compile(r'[a-zA-Z][A-Za-z0-9]{0,30}')
RE_YMD = re.compile(r'[0-9]{4}-[0-9]{2}-[0-9]{2}')
RE_LOCAL = re.compile(r"[a-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}")
RE_DOMAIN = re.compile(r'[a-z0-9-]+(\.[a-z0-9-]+)+')
RE_KIND = re.compile(r'[a-z0-9_]{1,32}')


def day(t):
    return time.strftime('%Y-%m-%d', time.gmtime(t))


def day_start(t):
    return t - t % DAY


def month(t):
    return time.strftime('%Y-%m', time.gmtime(t))


def minute_key(t):
    return time.strftime('%Y%m%d%H%M', time.gmtime(t))


def sha256h(b):
    return hashlib.sha256(b).hexdigest()


def same(a, b):
    """Сравнение секретов и хэшей за постоянное время."""
    if not isinstance(a, str) or not isinstance(b, str):
        return False
    return hmac.compare_digest(a.encode(), b.encode())


def out(s):
    sys.stdout.write(s + '\n')
    sys.stdout.flush()


def log(s):
    """Журнал службы. Сюда — только строки без персональных данных."""
    try:
        sys.stderr.write(s + '\n')
        sys.stderr.flush()
    except Exception:
        pass


def exc_line(tp, tb):
    """`err <Класс> api.py:<строка>` — без текста исключения (там бывают IP и адреса)."""
    line = 0
    while tb is not None:
        if os.path.basename(tb.tb_frame.f_code.co_filename) == 'api.py':
            line = tb.tb_lineno
        tb = tb.tb_next
    return 'err %s api.py:%d' % (getattr(tp, '__name__', 'Exception'), line)


def log_exc(tp, tb):
    log(exc_line(tp, tb))


def install_hooks():
    sys.excepthook = lambda tp, v, tb: log_exc(tp, tb)
    threading.excepthook = lambda a: log_exc(a.exc_type, a.exc_traceback)


def plural(n, one, few, many):
    if n % 10 == 1 and n % 100 != 11:
        return one
    if 2 <= n % 10 <= 4 and not 12 <= n % 100 <= 14:
        return few
    return many


def minutes(ttl):
    m = max(1, (ttl + 59) // 60)
    return '%d %s' % (m, plural(m, 'минуту', 'минуты', 'минут'))


def norm_email(v):
    """Нормализация адреса (§3): (адрес, None) или (None, 'bad_email'|'bad_local')."""
    if not isinstance(v, str):
        return None, 'bad_email'
    s = v.strip()
    if not s or len(s) > 254:
        return None, 'bad_email'
    for ch in s:
        if ch.isspace() or unicodedata.category(ch).startswith('C'):
            return None, 'bad_email'
    s = s.lower()
    local, at, dom = s.rpartition('@')
    if not at or not local or not dom:
        return None, 'bad_email'
    if not RE_LOCAL.fullmatch(local):
        if any(ord(ch) > 127 for ch in local):
            return None, 'bad_local'
        return None, 'bad_email'
    try:
        dom = dom.encode('idna').decode('ascii').lower()
    except UnicodeError:
        return None, 'bad_email'
    if not RE_DOMAIN.fullmatch(dom) or len(dom.rsplit('.', 1)[1]) < 2:
        return None, 'bad_email'
    r = local + '@' + dom
    if len(r) > 254:
        return None, 'bad_email'
    return r, None


def _no_dups(pairs):
    d = {}
    for k, v in pairs:
        if k in d:
            raise ValueError('dup')
        d[k] = v
    return d


def _no_const(x):
    raise ValueError('const')


def strict_json(raw):
    """Строгий JSON: только UTF-8, без NaN/Infinity и повторных ключей."""
    if isinstance(raw, (bytes, bytearray)):
        raw = bytes(raw).decode('utf-8')
    try:
        return json.loads(raw, object_pairs_hook=_no_dups, parse_constant=_no_const)
    except RecursionError:
        raise ValueError('deep')


def check_doc(doc):
    """Проверка документа синхронизации: (dict, None) или (None, код ошибки)."""
    try:
        d = strict_json(doc)
    except (ValueError, UnicodeError):
        return None, 'bad_doc'
    if not isinstance(d, dict) or len(d) > 64:
        return None, 'bad_doc'
    for k in d:
        if not RE_DOCKEY.fullmatch(k):
            return None, 'bad_doc'
    if 'demoData' in d:
        return None, 'demo'
    if 'body' in d:
        return None, 'body'
    if not isinstance(d.get('habits'), list) or not isinstance(d.get('checks'), dict):
        return None, 'bad_doc'
    return d, None


def doc_sum(d):
    """sum = {h, d, t, f, last}: привычки, дни с отметками, задачи, записи финансов, последняя отметка."""
    hs, ch, ts, fin = d.get('habits'), d.get('checks'), d.get('tasks'), d.get('finance')
    days = [k for k, v in ch.items() if isinstance(v, list) and v and RE_YMD.fullmatch(k)] if isinstance(ch, dict) else []
    ent = fin.get('entries') if isinstance(fin, dict) else None
    return {'h': len(hs) if isinstance(hs, list) else 0, 'd': len(days),
            't': len(ts) if isinstance(ts, list) else 0,
            'f': len(ent) if isinstance(ent, list) else 0, 'last': max(days) if days else ''}


def jdump(o):
    return json.dumps(o, ensure_ascii=False, separators=(',', ':'))


def jload(s, d=None):
    try:
        return json.loads(s)
    except (TypeError, ValueError):
        return d


def inflate(blob):
    return zlib.decompress(blob).decode('utf-8') if blob is not None else None


def load_key(state):
    """secret.key: 32 байта, создаётся один раз с O_EXCL 0600. В git и бэкапы не попадает."""
    p = os.path.join(state, 'secret.key')
    try:
        with open(p, 'rb') as f:
            k = f.read()
    except FileNotFoundError:
        k = secrets.token_bytes(32)
        try:
            fd = os.open(p, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        except FileExistsError:
            with open(p, 'rb') as f:
                k = f.read()
        else:
            with os.fdopen(fd, 'wb') as f:
                f.write(k)
                f.flush()
                os.fsync(f.fileno())
    if len(k) != 32:
        raise RuntimeError('secret.key повреждён')
    return k


def file_uri(path, mode):
    return 'file:%s?mode=%s' % (urllib.parse.quote(os.path.abspath(path)), mode)


def tree_version():
    return os.path.basename(os.path.dirname(os.path.realpath(__file__)))


# ═══════════════════════════ Store ═══════════════════════════

# Только добавление: selftest и 06 падают на DROP, RENAME, ALTER … DROP.
# В каждом SELECT и INSERT колонки названы явно — старый api.py после отката
# работает на новой БД.
MIGRATIONS = [
    (1, (
        'CREATE TABLE meta(k TEXT PRIMARY KEY, v TEXT NOT NULL)',
        'CREATE TABLE accounts(id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, created INTEGER NOT NULL, '
        'seen TEXT NOT NULL, head_rid TEXT, head_rev INTEGER NOT NULL DEFAULT 0, head_sv INTEGER NOT NULL DEFAULT 0, '
        'bytes INTEGER NOT NULL DEFAULT 0)',
        'CREATE TABLE sessions(token_h TEXT PRIMARY KEY, sid TEXT NOT NULL UNIQUE, '
        'account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE, dev TEXT NOT NULL, label TEXT NOT NULL, '
        'created INTEGER NOT NULL, renewed INTEGER NOT NULL, seen TEXT NOT NULL, expires INTEGER NOT NULL, last_rid TEXT)',
        'CREATE INDEX sessions_acc ON sessions(account_id)',
        'CREATE TABLE revisions(rid TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE, '
        "rev INTEGER NOT NULL, parent TEXT, kind TEXT NOT NULL CHECK(kind IN ('push','parked')), reason TEXT NOT NULL, "
        'dev TEXT NOT NULL, seq INTEGER NOT NULL, sv INTEGER NOT NULL, at INTEGER NOT NULL, hash TEXT NOT NULL, '
        "size INTEGER NOT NULL, sum TEXT NOT NULL, label TEXT NOT NULL, keep TEXT NOT NULL DEFAULT '', pin_until INTEGER, blob BLOB)",
        "CREATE UNIQUE INDEX rev_op ON revisions(account_id, dev, seq) WHERE kind='push'",
        'CREATE INDEX rev_dev ON revisions(account_id, dev, seq)',
        'CREATE INDEX rev_at ON revisions(account_id, at)',
        'CREATE TABLE codes(id INTEGER PRIMARY KEY, email_h TEXT NOT NULL, purpose TEXT NOT NULL, code_h TEXT NOT NULL, '
        'created INTEGER NOT NULL, expires INTEGER NOT NULL, tries INTEGER NOT NULL DEFAULT 0, '
        'last_try INTEGER NOT NULL DEFAULT 0, state INTEGER NOT NULL DEFAULT 4)',
        'CREATE INDEX codes_e ON codes(email_h, purpose, created)',
        'CREATE TABLE mail_count(k TEXT PRIMARY KEY, n INTEGER NOT NULL)',
        'CREATE TABLE deletions(email_h TEXT NOT NULL, at INTEGER NOT NULL)',
        'CREATE TABLE stats(k TEXT PRIMARY KEY, n INTEGER NOT NULL)',
    )),
    # (2, ...) — Платега (§13): orders, payment_events, subscriptions. Только CREATE.
]
# Состояния кода: 0 живой, 1 использован, 2 заменён, 3 сожжён, 4 отправляется.
LIVE, USED, REPLACED, BURNED, SENDING = 0, 1, 2, 3, 4


def migrations_clean():
    bad = re.compile(r'\b(DROP|RENAME)\b', re.I)
    return all(not bad.search(s) for _, stmts in MIGRATIONS for s in stmts)


class Store:
    """Одно соединение SQLite за замком; каждая запись — BEGIN IMMEDIATE."""

    def __init__(self, path, migrate=True, create=True):
        self.path = path
        self.lock = threading.Lock()
        uri = file_uri(path, 'rwc' if create else 'rw')
        self.db = sqlite3.connect(uri, uri=True, timeout=5, isolation_level=None, check_same_thread=False)
        try:
            self.db.execute('PRAGMA busy_timeout=5000')
            if self.db.execute('SELECT count(*) FROM sqlite_master').fetchone()[0] == 0:
                self.db.execute('PRAGMA auto_vacuum=INCREMENTAL')
            self.db.execute('PRAGMA journal_mode=WAL')
            self.db.execute('PRAGMA synchronous=FULL')
            self.db.execute('PRAGMA foreign_keys=ON')
            self.db.execute('PRAGMA secure_delete=ON')   # удалённое затирается, а не лежит в свободных страницах
            self.schema = self.migrate() if migrate else self.read_schema()
        except Exception:
            self.db.close()
            raise

    @contextlib.contextmanager
    def tx(self):
        with self.lock:
            self.db.execute('BEGIN IMMEDIATE')
            try:
                yield self.db
            except BaseException:
                self.db.execute('ROLLBACK')
                raise
            try:
                self.db.execute('COMMIT')
            except BaseException:
                if self.db.in_transaction:
                    self.db.execute('ROLLBACK')
                raise

    @contextlib.contextmanager
    def ro(self):
        with self.lock:
            self.db.execute('BEGIN')
            try:
                yield self.db
            finally:
                self.db.execute('COMMIT')

    def read_schema(self):
        with self.ro() as c:
            if not c.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='meta'").fetchone():
                return 0
            r = c.execute("SELECT v FROM meta WHERE k='schema'").fetchone()
            return int(r[0]) if r else 0

    def migrate(self):
        with self.tx() as c:
            cur = 0
            if c.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='meta'").fetchone():
                r = c.execute("SELECT v FROM meta WHERE k='schema'").fetchone()
                cur = int(r[0]) if r else 0
            for ver, stmts in MIGRATIONS:
                if ver > cur:
                    for s in stmts:
                        c.execute(s)
                    cur = ver
                    c.execute("INSERT INTO meta(k, v) VALUES('schema', ?) ON CONFLICT(k) DO UPDATE SET v=excluded.v", (str(cur),))
            if not c.execute("SELECT 1 FROM meta WHERE k='db_id'").fetchone():
                c.execute("INSERT INTO meta(k, v) VALUES('db_id', ?)", (secrets.token_hex(8),))
                c.execute("INSERT OR IGNORE INTO meta(k, v) VALUES('created', ?)", (str(int(time.time())),))
            return cur

    def close(self):
        with self.lock:
            self.db.close()


def sqlite_copy(src, dst):
    """Онлайн-копия через backup API; копия — один файл (journal DELETE). Возвращает integrity_check."""
    s = sqlite3.connect(file_uri(src, 'rw'), uri=True, timeout=30)
    try:
        d = sqlite3.connect(dst)
        try:
            s.backup(d)
            d.execute('PRAGMA journal_mode=DELETE')
            return d.execute('PRAGMA integrity_check').fetchone()[0]
        finally:
            d.close()
    finally:
        s.close()


def rm_db(path):
    for suf in ('', '-wal', '-shm', '-journal'):
        try:
            os.unlink(path + suf)
        except FileNotFoundError:
            pass


# ═══════════════════════════ Limits ═══════════════════════════

class Limiter:
    """Скользящие окна только в памяти. Ключи — HMAC с солью процесса: IP в открытом виде не хранится.

    Память ограничена: MAX_KEYS ключей (~0,9 КБ каждый — около 18 МБ при MemoryMax=150M). Ключ
    живёт не дольше своего окна. Сверх предела вытесняются самые давно не тронутые ключи, а не все
    сразу: сброс всего дал бы атакующему обнулить лимиты потоком новых адресов (ревью R1, 11.10).
    """

    MAX_KEYS = 20000

    def __init__(self, scale=1.0):
        self.scale = scale
        self.lock = threading.Lock()
        self.d = {}      # ключ → deque моментов; порядок словаря — от давно не тронутых к свежим
        self.w = {}      # ключ → самое длинное окно, с которым ключ проверялся
        self.salt = secrets.token_bytes(16)

    def key(self, kind, value):
        return kind + ':' + hmac.new(self.salt, value.encode(), hashlib.sha256).hexdigest()[:24]

    def win(self, w):
        return max(1.0, w * self.scale)

    def hit(self, rules, add=True, now=None):
        """rules = [(ключ, предел, окно в секундах)]. 0 — можно (и засчитано), иначе retryIn."""
        now = time.monotonic() if now is None else now
        with self.lock:
            worst = 0
            for k, lim, w in rules:
                w = self.win(w)
                q = self.d.get(k)
                if q:
                    while q and q[0] <= now - w:
                        q.popleft()
                    if len(q) >= lim:
                        worst = max(worst, int(q[-lim] + w - now) + 1)
            if worst or not add:
                return worst
            self._put([(k, self.win(w)) for k, _, w in rules], now)
            return 0

    def add(self, keys, now=None):
        now = time.monotonic() if now is None else now
        with self.lock:
            self._put([(k, 0.0) for k in keys], now)

    def _put(self, items, now):
        for k, w in items:
            q = self.d.pop(k, None)          # pop + вставка = ключ становится самым свежим
            if q is None:
                q = deque()
            q.append(now)
            self.d[k] = q
            if w > self.w.get(k, 0.0):
                self.w[k] = w
        if len(self.d) > self.MAX_KEYS:
            self._purge(now)
            while len(self.d) > self.MAX_KEYS:
                k = next(iter(self.d))
                del self.d[k]
                self.w.pop(k, None)

    def _purge(self, now):
        for k in list(self.d):
            q = self.d[k]
            cut = now - (self.w.get(k) or self.win(DAY))
            while q and q[0] <= cut:
                q.popleft()
            if not q:
                del self.d[k]
                self.w.pop(k, None)

    def purge(self, now=None):
        with self.lock:
            self._purge(time.monotonic() if now is None else now)


# ═══════════════════════════ Mailer ═══════════════════════════

def parse_smtp_env(txt):
    """smtp.env: только KEY=VALUE, без shell. Неполный или странный файл — почта не настроена (None)."""
    d = {}
    for line in (txt or '').splitlines():
        line = line.strip()
        if not line or line[0] == '#':
            continue
        k, eq, v = line.partition('=')
        if not eq:
            continue
        v = v.strip()
        if len(v) >= 2 and v[0] == v[-1] and v[0] in '"\'':
            v = v[1:-1]
        d[k.strip()] = v
    host = d.get('SMTP_HOST', '').strip().lower()
    if not re.fullmatch(r'[a-z0-9.-]{1,253}', host):
        return None
    try:
        port = int(d.get('SMTP_PORT') or 465)
    except ValueError:
        return None
    if not 0 < port < 65536 or (host != '127.0.0.1' and port not in (465, 587)):
        return None
    user, e1 = norm_email(d.get('SMTP_USER', ''))
    support, e2 = norm_email(d.get('SUPPORT', ''))
    pw = d.get('SMTP_PASS', '')
    if e1 or e2 or not pw:
        return None
    return {'SMTP_HOST': host, 'SMTP_PORT': port, 'SMTP_USER': user, 'SMTP_PASS': pw, 'SUPPORT': support}


def smtp_send(conf, msg):
    """SMTP_SSL на 465, STARTTLS на 587; без TLS — только 127.0.0.1. Таймаут 10 с."""
    host, port = conf['SMTP_HOST'], conf['SMTP_PORT']
    me = 'magnat-planer.ru'
    if host == '127.0.0.1':
        s = smtplib.SMTP(host, port, local_hostname=me, timeout=10)
    elif port == 465:
        s = smtplib.SMTP_SSL(host, 465, local_hostname=me, timeout=10, context=ssl.create_default_context())
    else:
        s = smtplib.SMTP(host, port, local_hostname=me, timeout=10)
        s.ehlo()
        s.starttls(context=ssl.create_default_context())
        s.ehlo()
    try:
        s.login(conf['SMTP_USER'], conf['SMTP_PASS'])
        s.send_message(msg, from_addr=conf['SMTP_USER'], to_addrs=[str(msg['To'])])
    finally:
        try:
            s.quit()
        except Exception:
            s.close()


def mail_fault(e):
    """Вид ошибки почты для подсказки владельцу (без текста ответа сервера)."""
    if isinstance(e, smtplib.SMTPAuthenticationError):
        return 'auth'
    if isinstance(e, (ssl.SSLError, ssl.CertificateError)):
        return 'tls'
    if isinstance(e, (smtplib.SMTPConnectError, smtplib.SMTPServerDisconnected, ConnectionError,
                      socket.timeout, socket.gaierror, TimeoutError)):
        return 'connect'
    if isinstance(e, OSError) and not isinstance(e, smtplib.SMTPException):
        return 'connect'
    return 'other'


class Mailer:
    """Учётные данные из файла (LoadCredential); перечитывается, когда файл меняется."""

    def __init__(self, path):
        self.path = path
        self.lock = threading.Lock()
        self.sig = None
        self.c = None

    def conf(self):
        if not self.path:
            return None
        try:
            st = os.stat(self.path)
        except OSError:
            return None
        sig = (st.st_mtime_ns, st.st_size, st.st_ino)
        with self.lock:
            if sig != self.sig:
                try:
                    with open(self.path, encoding='utf-8') as f:
                        txt = f.read(65536)
                except (OSError, UnicodeError):
                    txt = ''
                self.c, self.sig = parse_smtp_env(txt), sig
            return self.c

    def send(self, conf, msg):
        smtp_send(conf, msg)


class FakeMailer:
    """Почтальон для check и selftest: ничего не отправляет, письма копит в памяти."""

    CONF = {'SMTP_HOST': '127.0.0.1', 'SMTP_PORT': 25, 'SMTP_USER': 'box@example.ru',
            'SMTP_PASS': 'x', 'SUPPORT': 'support@example.ru'}

    def __init__(self, conf=None):
        self.c = dict(conf or self.CONF)
        self.sent = []
        self.fail = None
        self.delay = 0
        self.lock = threading.Lock()

    def conf(self):
        return self.c

    def send(self, conf, msg):
        if self.delay:
            time.sleep(self.delay)
        if self.fail is not None:
            raise self.fail
        with self.lock:
            self.sent.append(msg)

    def last_code(self, to):
        with self.lock:
            for m in reversed(self.sent):
                if str(m['To']) == to:
                    r = re.search(r'[0-9]{6}', str(m['Subject']))
                    if r:
                        return r.group(0)
        return None


# ═══════════════════════════ Letters ═══════════════════════════

FOOT = 'Вопросы — ответь на это письмо.\n—\nМагнат · magnat-planer.ru'

LOGIN_TEXT = ('Привет!\n\nКод для входа в Магнат: {c}\n\nВведи его в приложении. Код действует {ttl} и подходит '
              'только для одного входа.\n\nЕсли это был не ты — просто удали письмо: без кода в аккаунт никто не '
              'войдёт. Никому не сообщай код — даже поддержке Магната.\n\n' + FOOT +
              '\nПисьмо пришло, потому что этот адрес ввели для входа на magnat-planer.ru.')

DELETE_TEXT = ('Кто-то (надеемся, ты) хочет удалить аккаунт Магнат и все записи на сервере. Код: {c}, действует '
               '{ttl}. Если это не ты — не вводи код и смени пароль от почты. Записи останутся на месте.\n\n' + FOOT)


def _letter(conf, to, subject, text, page=None):
    m = EmailMessage()
    m['From'] = formataddr(('Магнат', conf['SMTP_USER']))
    m['Reply-To'] = conf['SUPPORT']
    m['To'] = to
    m['Subject'] = subject
    m['Date'] = formatdate(usegmt=True)
    m['Message-ID'] = make_msgid(domain=conf['SMTP_USER'].rpartition('@')[2])
    m['Auto-Submitted'] = 'auto-generated'
    m.set_content(text, cte='quoted-printable')
    if page is not None:
        m.add_alternative(page, subtype='html', cte='quoted-printable')
    return m


def _page(paras, big=None):
    p = ''.join('<p style="margin:0 0 14px">%s</p>' % html.escape(x).replace('\n', '<br>') for x in paras)
    if big is not None:
        p = p.replace('{BIG}', '<span style="display:block;font:bold 32px/1.3 \'Courier New\',Courier,monospace;'
                               'letter-spacing:6px;margin:6px 0">%s</span>' % html.escape(big))
    return ('<!doctype html><html><body style="margin:0;padding:24px;font:16px/1.5 Arial,Helvetica,sans-serif;'
            'color:#1d1d1f;background:#ffffff">%s<p style="margin:0;color:#6e6e73;font-size:13px">'
            '<a href="%s" style="color:#6e6e73">magnat-planer.ru</a></p></body></html>') % (p, SITE)


def letter_code(conf, to, c, purpose, ttl):
    if purpose == 'delete':
        text = DELETE_TEXT.format(c=c, ttl=minutes(ttl))
        page = _page(['Кто-то (надеемся, ты) хочет удалить аккаунт Магнат и все записи на сервере.',
                      'Код для удаления: {BIG}',
                      'Код действует %s. Если это не ты — не вводи код и смени пароль от почты. '
                      'Записи останутся на месте.' % minutes(ttl), 'Вопросы — ответь на это письмо.'], c)
        return _letter(conf, to, 'Код для удаления аккаунта Магнат: %s' % c, text, page)
    text = LOGIN_TEXT.format(c=c, ttl=minutes(ttl))
    page = _page(['Привет!', 'Код для входа в Магнат: {BIG}',
                  'Введи его в приложении. Код действует %s и подходит только для одного входа.' % minutes(ttl),
                  'Если это был не ты — просто удали письмо: без кода в аккаунт никто не войдёт. '
                  'Никому не сообщай код — даже поддержке Магната.',
                  'Вопросы — ответь на это письмо.',
                  'Письмо пришло, потому что этот адрес ввели для входа на magnat-planer.ru.'], c)
    return _letter(conf, to, '%s — код входа в Магнат' % c, text, page)


def letter_check(conf, to):
    return _letter(conf, to, 'Проверка: почта Магната настроена',
                   'Почта для кодов работает. Это письмо можно удалить.\n—\nМагнат · magnat-planer.ru')


def letter_alert(conf, kind, text):
    body = '%s\n\nПодробности — magnat status на сервере. Вид тревоги: %s.\n—\nМагнат · magnat-planer.ru' % (text, kind)
    return _letter(conf, conf['SUPPORT'], 'Магнат: %s' % text, body)


def letter_export(conf, to, data, when):
    m = _letter(conf, to, 'Твои данные в Магнате',
                'Привет!\n\nВо вложении — всё, что Магнат хранит на сервере о твоём аккаунте: адрес, устройства, '
                'данные и список версий. Данные «Тела» на сервер не попадают — они только на телефоне.\n\n' + FOOT)
    m.add_attachment(jdump(data).encode('utf-8'), maintype='application', subtype='json',
                     filename='magnat-%s.json' % day(when))
    return m


# ═══════════════════════════ Routes ═══════════════════════════

class Bad(Exception):
    """Нарушение протокола — 400 bad (честный клиент так не делает)."""


class Resp:
    __slots__ = ('status', 'obj', 'headers')

    def __init__(self, status, obj, headers=None):
        self.status, self.obj, self.headers = status, obj, list(headers or [])


def ok(**kw):
    o = {'ok': True}
    o.update(kw)
    return Resp(200, o)


def fail(err, status=200, **kw):
    o = {'ok': False, 'err': err}
    o.update(kw)
    return Resp(status, o)


def f_str(b, k, rx=None, opt=False, maxlen=200):
    v = b.get(k)
    if v is None and opt:
        return None
    if not isinstance(v, str) or len(v) > maxlen or (rx is not None and not rx.fullmatch(v)):
        raise Bad()
    return v


def f_int(b, k, lo, hi, opt=False):
    v = b.get(k)
    if v is None and opt:
        return None
    if type(v) is not int or not lo <= v <= hi:
        raise Bad()
    return v


def set_cookie(tok, age):
    return '%s=%s; Path=/; Max-Age=%d; HttpOnly; Secure; SameSite=Strict' % (COOKIE, tok, max(0, int(age)))


CLEAR_COOKIE = '%s=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict' % COOKIE


class Sess:
    __slots__ = ('token_h', 'sid', 'acct', 'dev', 'label', 'email', 'expires')

    def __init__(self, *a):
        self.token_h, self.sid, self.acct, self.dev, self.label, self.email, self.expires = a


class Ctx:
    """Один запрос: время, ключи IP для лимитов (только в памяти), cookie."""

    def __init__(self, app, headers, peer):
        self.app = app
        self.headers = headers
        self.now = app.now()
        self.ipk, self.netk = app.client_keys(peer, headers)
        self.cookies = []
        self.had_cookie = False
        self.sess = None     # /api/sync: сессия, проверенная в handle() ещё до чтения тела

    def token(self):
        for h in self.headers.get_all('Cookie') or []:
            for part in h.split(';'):
                k, _, v = part.strip().partition('=')
                if k == COOKIE:
                    self.had_cookie = True
                    if RE_TOKEN.fullmatch(v):
                        return v
        return None


# Лимиты на сессию: (предел, окно в секундах)
SESSION_LIMITS = {'sync': (30, 60), 'ver': (20, 60), 'me': (60, 60), 'sess': (60, 60), 'del': (3, DAY)}


class App:
    def __init__(self, cfg, store, key, mailer):
        self.cfg, self.store, self.key, self.mailer = cfg, store, key, mailer
        self.lim = Limiter(cfg.limit_scale)
        self.inflight = threading.BoundedSemaphore(16)
        self.sync_sem = threading.Semaphore(2)     # 366 МБ памяти на всю машину (замер 12.10)
        self.smtp_sem = threading.Semaphore(2)
        self.version = tree_version()
        self.hlock = threading.Lock()
        self.hourly = {'codes': 0, 'logins': 0, 'syncs': 0, 'limited': 0}
        self.limited_unsaved = 0
        # путь → (обработчик, предел тела, вид): json — Origin + JSON; form — Origin + обычная форма;
        # hook — уведомление платёжного сервиса: без Origin и cookie, проверка — в самом обработчике.
        self.routes = {
            '/api/code': (self.r_code, SMALL_BODY, 'json'),
            '/api/login': (self.r_login, SMALL_BODY, 'json'),
            '/api/me': (self.r_me, SMALL_BODY, 'json'),
            '/api/sync': (self.r_sync, SYNC_BODY, 'json'),
            '/api/versions': (self.r_versions, SMALL_BODY, 'json'),
            '/api/version': (self.r_version, SMALL_BODY, 'json'),
            '/api/sessions': (self.r_sessions, SMALL_BODY, 'json'),
            '/api/logout': (self.r_logout, SMALL_BODY, 'json'),
            '/api/delete': (self.r_delete, SMALL_BODY, 'json'),
        }
        if PAYMENTS:  # §13: включаются вместе с миграцией 2 и privacy.html
            self.routes['/api/checkout'] = (self.r_checkout, SMALL_BODY, 'form')
            self.routes['/api/platega/callback'] = (self.r_platega_callback, 16384, 'hook')

    # ── время, ключи, счётчики ──

    def now(self):
        return int(time.time()) + self.cfg.now_shift

    def email_h(self, em):
        return hmac.new(self.key, ('e:' + em).encode(), hashlib.sha256).hexdigest()

    def code_h(self, purpose, em, c):
        return hmac.new(self.key, ('c:%s:%s:%s' % (purpose, em, c)).encode(), hashlib.sha256).hexdigest()

    def client_keys(self, peer, headers):
        """IP = последнее значение X-Forwarded-For, только если пир 127.0.0.1. IPv6 — /64, подсеть /24 и /48."""
        ip = peer or ''
        if ip in ('127.0.0.1', '::1', '::ffff:127.0.0.1'):
            vals = headers.get_all('X-Forwarded-For') or []
            if vals:
                last = ','.join(vals).split(',')[-1].strip()
                if last:
                    ip = last
        try:
            a = ipaddress.ip_address(ip.strip('[]'))
        except ValueError:
            try:
                a = ipaddress.ip_address(peer)
            except ValueError:
                a = ipaddress.ip_address('0.0.0.0')
        if a.version == 6 and a.ipv4_mapped is not None:
            a = a.ipv4_mapped
        if a.version == 4:
            k, n = str(a), str(ipaddress.ip_network('%s/24' % a, strict=False))
        else:
            k = str(ipaddress.ip_network('%s/64' % a, strict=False))
            n = str(ipaddress.ip_network('%s/48' % a, strict=False))
        return self.lim.key('ip', k), self.lim.key('net', n)

    def count(self, name, n=1):
        with self.hlock:
            self.hourly[name] = self.hourly.get(name, 0) + n
            if name == 'limited':
                self.limited_unsaved += n

    def stat(self, c, name, n=1):
        c.execute('INSERT INTO stats(k, n) VALUES(?, ?) ON CONFLICT(k) DO UPDATE SET n=n+excluded.n',
                  ('%s:%s' % (month(self.now()), name), n))

    def slow(self, retry):
        self.count('limited')
        return fail('slow', retryIn=max(1, int(retry)))

    def paused(self):
        return os.path.exists(os.path.join(self.cfg.state, 'mail.off'))

    def allowed(self, em):
        if self.cfg.open:
            return True
        conf = self.mailer.conf()
        return bool(conf) and em in (conf['SMTP_USER'], conf['SUPPORT'])

    def disk_ok(self):
        try:
            free = shutil.disk_usage(os.path.dirname(os.path.abspath(self.cfg.db))).free
        except OSError:
            return False
        return free >= self.cfg.disk_min_mb * 1048576

    def srate(self, sid, group):
        lim, w = SESSION_LIMITS[group]
        return self.lim.hit([('s%s:%s' % (group, sid), lim, w)])

    # ── платежи: крючки (§13), пока пустые ──

    def subscription(self, acct):
        """sub для /api/me: {plan, status, until} из таблицы subscriptions (миграция 2). Пока None."""
        return None

    def cancel_subscription(self, acct):
        """Перед удалением аккаунта — отмена подписки в Платеге. Удаление идёт в любом случае."""
        return True

    def poll_payments(self):
        """maintain: запасной опрос заказов, висящих в PENDING (как у бота VPN)."""
        return 0

    def r_checkout(self, ctx, b):
        """POST /api/checkout (§13): форма checkout.html, цена из своей таблицы, заказ до внешнего вызова."""
        return fail('nope', 404)

    def r_platega_callback(self, ctx, b):
        """POST /api/platega/callback (§13): без Origin и cookie, compare_digest по заголовкам."""
        return fail('nope', 404)

    # ── вход в маршрут ──

    def handle(self, method, target, headers, read, peer):
        path = target.split('?', 1)[0]
        if path == '/api/health':
            return self.health(method, headers, peer)
        rt = self.routes.get(path)
        if rt is None:
            return fail('nope', 404)
        fn, limit, kind = rt
        if method != 'POST':
            r = fail('method', 405)
            r.headers.append(('Allow', 'POST'))
            return r
        if self.store is None:
            return fail('down', 503)
        if kind != 'hook':
            org = headers.get_all('Origin') or []
            if len(org) != 1 or org[0] != self.cfg.origin:
                return fail('origin', 403)
            sfs = headers.get_all('Sec-Fetch-Site') or []
            if any(v != 'same-origin' for v in sfs):
                return fail('origin', 403)
        if headers.get('Transfer-Encoding') is not None:
            return fail('length', 411)
        cls = headers.get_all('Content-Length') or []
        if not cls:
            return fail('length', 411)
        if len(cls) != 1 or not re.fullmatch(r'[0-9]{1,9}', cls[0].strip()):
            return fail('bad', 400)
        n = int(cls[0].strip())
        if n > limit:
            return fail('big', 413)
        ct = (headers.get('Content-Type') or '').strip().lower()
        if not ct.startswith('application/x-www-form-urlencoded' if kind == 'form' else 'application/json'):
            return fail('type', 415)
        # Ревью R1 (11.10): место «в работе» (16 на всех) не держим, пока клиент шлёт тело.
        # Малые тела (≤ 2 КБ) читаются заранее — медленный клиент держит только своё соединение.
        # /api/sync — только со входом: сессию проверяем ДО тела, чужой без cookie не встаёт в
        # очередь и не заставляет читать и разбирать полтора мегабайта.
        ctx = Ctx(self, headers, peer)
        sem = None
        raw = None
        if path == '/api/sync':
            ctx.sess = self.session(ctx)
            if ctx.sess is None:
                return fail('auth')
            sem = self.sync_sem
            if not sem.acquire(timeout=5):
                return fail('busy', 503)
        else:
            raw = read(n)
        if not self.inflight.acquire(blocking=False):
            if sem is not None:
                sem.release()
            return fail('busy', 503)
        try:
            if raw is None:
                raw = read(n)
            try:
                if kind == 'form':
                    body = {k: v[0] for k, v in urllib.parse.parse_qs(raw.decode('utf-8'), max_num_fields=50,
                                                                     strict_parsing=bool(raw)).items()}
                else:
                    body = strict_json(raw)
            except (ValueError, UnicodeError):
                return fail('bad', 400)
            if not isinstance(body, dict):
                return fail('bad', 400)
            try:
                r = fn(ctx, body)
            except Bad:
                return fail('bad', 400)
            except sqlite3.OperationalError as e:
                if 'locked' in str(e) or 'busy' in str(e):
                    return fail('busy', 503)
                raise
            r.headers.extend(('Set-Cookie', v) for v in ctx.cookies)
            return r
        finally:
            self.inflight.release()
            if sem is not None:
                sem.release()

    def health(self, method, headers, peer):
        if method not in ('GET', 'HEAD'):
            r = fail('method', 405)
            r.headers.append(('Allow', 'GET'))
            return r
        if headers.get('X-Forwarded-For') is not None or peer not in ('127.0.0.1', '::1'):
            return fail('nope', 404)
        try:
            if self.store is None:
                raise RuntimeError()
            with self.store.ro() as c:
                sch = int(c.execute("SELECT v FROM meta WHERE k='schema'").fetchone()[0])
            if sch < SCHEMA:
                raise RuntimeError()
        except Exception:
            return Resp(503, {'ok': False, 'db': False})
        return ok(v=self.version, schema=sch, db=True, smtp=self.mailer.conf() is not None,
                  open=self.cfg.open, paused=self.paused())

    # ── сессия ──

    def session(self, ctx):
        tok = ctx.token()
        if not tok:
            return None
        th = sha256h(tok.encode())
        now = ctx.now
        with self.store.ro() as c:
            row = c.execute('SELECT s.token_h, s.sid, s.account_id, s.dev, s.label, a.email, s.expires, s.renewed, '
                            's.seen, a.seen FROM sessions s JOIN accounts a ON a.id=s.account_id WHERE s.token_h=?',
                            (th,)).fetchone()
        if row is None or not same(row[0], th):
            return None
        if row[6] <= now or row[8] < day(now - self.cfg.idle_days * DAY):
            return None
        today = day(now)
        renew = row[7] < now - RENEW_AFTER
        if row[8] != today or row[9] != today or renew:
            with self.store.tx() as c:
                c.execute('UPDATE sessions SET seen=?, renewed=? WHERE token_h=?',
                          (today, now if renew else row[7], th))
                c.execute('UPDATE accounts SET seen=? WHERE id=? AND seen<>?', (today, row[2], today))
        if renew:
            ctx.cookies.append(set_cookie(tok, row[6] - now))
        return Sess(row[0], row[1], row[2], row[3], row[4], row[5], row[6])

    def _head(self, c, acct):
        row = c.execute('SELECT a.head_sv, r.rid, r.rev, r.at, r.label, r.sum FROM accounts a '
                        'JOIN revisions r ON r.rid=a.head_rid WHERE a.id=?', (acct,)).fetchone()
        if row is None:
            return None
        return {'rid': row[1], 'rev': row[2], 'sv': row[0], 'at': row[3], 'label': row[4], 'sum': jload(row[5], {})}

    # ── коды ──

    def _attempt(self, c, eh, purpose, em, guess, now):
        """Одна попытка ввода кода внутри BEGIN IMMEDIATE: ('ok'|'locked'|'expired'|'tries_over'|'replaced'|'code', extra)."""
        cfg = self.cfg
        lw = int(max(1, 3600 * cfg.limit_scale))
        tot, last = c.execute('SELECT COALESCE(SUM(tries), 0), COALESCE(MAX(last_try), 0) FROM codes '
                              'WHERE email_h=? AND created>?', (eh, now - int(max(1, DAY * cfg.limit_scale)))).fetchone()
        if tot >= 15 and last > now - lw:
            return 'locked', {'retryIn': max(1, last + lw - now)}
        row = c.execute('SELECT id, code_h FROM codes WHERE email_h=? AND purpose=? AND state=? AND expires>? '
                        'ORDER BY id DESC LIMIT 1', (eh, purpose, LIVE, now)).fetchone()
        if row is None:
            nr = c.execute('SELECT state, tries FROM codes WHERE email_h=? AND purpose=? AND expires>? '
                           'ORDER BY id DESC LIMIT 1', (eh, purpose, now)).fetchone()
            if nr is not None and nr[0] == BURNED and nr[1] >= cfg.code_tries:
                return 'tries_over', {}
            return 'expired', {}
        cur = c.execute('UPDATE codes SET tries=tries+1, last_try=? WHERE id=? AND state=? AND tries<?',
                        (now, row[0], LIVE, cfg.code_tries))
        if cur.rowcount != 1:
            c.execute('UPDATE codes SET state=? WHERE id=? AND state=?', (BURNED, row[0], LIVE))
            return 'tries_over', {}
        tries = c.execute('SELECT tries FROM codes WHERE id=?', (row[0],)).fetchone()[0]
        want = self.code_h(purpose, em, guess)
        if same(want, row[1]):
            c.execute('UPDATE codes SET state=? WHERE id=?', (USED, row[0]))
            return 'ok', {}
        if tries >= cfg.code_tries:
            c.execute('UPDATE codes SET state=? WHERE id=?', (BURNED, row[0]))
        left = max(0, cfg.code_tries - tries)
        for (h,) in c.execute('SELECT code_h FROM codes WHERE email_h=? AND purpose=? AND state=? AND expires>?',
                              (eh, purpose, REPLACED, now)).fetchall():
            if same(want, h):
                return 'replaced', {'left': left}
        return 'code', {'left': left}

    def r_code(self, ctx, b):
        purpose = b.get('purpose', 'login')
        if purpose not in ('login', 'delete'):
            raise Bad()
        if purpose == 'delete':
            s = self.session(ctx)
            if s is None:
                return fail('auth')
            em = s.email
        else:
            v = b.get('email')
            if not isinstance(v, str):
                raise Bad()
            em, e = norm_email(v[:1000])
            if e:
                return fail(e)
        if not self.allowed(em):
            return fail('closed')
        if self.paused():
            return fail('paused')
        conf = self.mailer.conf()
        if not conf:
            return fail('mail_off')
        r = self.lim.hit([('c10:' + ctx.ipk, 10, 600), ('c24:' + ctx.ipk, 30, DAY), ('cn24:' + ctx.netk, 150, DAY)])
        if r:
            return self.slow(r)
        cfg, now = self.cfg, ctx.now
        eh = self.email_h(em)
        c6 = '%06d' % secrets.randbelow(10 ** 6)
        with self.store.tx() as c:
            last = c.execute('SELECT MAX(created) FROM codes WHERE email_h=?', (eh,)).fetchone()[0]
            if last is not None and now - last < cfg.code_gap:
                return fail('wait', retryIn=max(1, last + cfg.code_gap - now))
            for lim, w in ((5, 3600), (10, DAY)):
                w = int(max(1, w * cfg.limit_scale))
                r = c.execute('SELECT created FROM codes WHERE email_h=? AND created>? ORDER BY created DESC '
                              'LIMIT 1 OFFSET ?', (eh, now - w, lim - 1)).fetchone()
                if r is not None:
                    return self.slow(r[0] + w - now)
            dk, mk = 'day:' + day(now), 'min:' + minute_key(now)
            nd = c.execute('SELECT n FROM mail_count WHERE k=?', (dk,)).fetchone()
            if nd is not None and nd[0] >= cfg.mail_day:
                return fail('mail_cap')
            nm = c.execute('SELECT n FROM mail_count WHERE k=?', (mk,)).fetchone()
            if nm is not None and nm[0] >= cfg.mail_min:
                return fail('busy', retryIn=60)
            cid = c.execute('INSERT INTO codes(email_h, purpose, code_h, created, expires, tries, last_try, state) '
                            'VALUES(?, ?, ?, ?, ?, 0, 0, ?)',
                            (eh, purpose, self.code_h(purpose, em, c6), now, now + cfg.code_ttl, SENDING)).lastrowid
            for k in (dk, mk):
                c.execute('INSERT INTO mail_count(k, n) VALUES(?, 1) ON CONFLICT(k) DO UPDATE SET n=n+1', (k,))
        # Отправка вне замка БД. Очереди нет: код не может прийти позже, уже мёртвым.
        if not self.smtp_sem.acquire(timeout=5):
            with self.store.tx() as c:
                c.execute('UPDATE codes SET state=? WHERE id=?', (BURNED, cid))
            return fail('busy', retryIn=30)
        err = None
        try:
            self.mailer.send(conf, letter_code(conf, em, c6, purpose, cfg.code_ttl))
        except Exception as e:
            err = type(e).__name__
        finally:
            self.smtp_sem.release()
        with self.store.tx() as c:
            if err is None:
                c.execute('UPDATE codes SET state=? WHERE id=?', (LIVE, cid))
                c.execute('UPDATE codes SET state=? WHERE email_h=? AND purpose=? AND state=? AND id<>?',
                          (REPLACED, eh, purpose, LIVE, cid))
                self.stat(c, 'codes_sent')
            else:
                c.execute('UPDATE codes SET state=? WHERE id=?', (BURNED, cid))
                c.execute("INSERT INTO meta(k, v) VALUES('mail_err', ?) ON CONFLICT(k) DO UPDATE SET v=excluded.v",
                          ('%d %s' % (now, err),))
                self.stat(c, 'mail_fail')
        if err is not None:
            log('smtp error ' + err)
            return fail('mail_fail')
        self.count('codes')
        return ok(ttl=cfg.code_ttl, resend=cfg.code_gap)

    def _guess_limits(self, ctx):
        return [('f1:' + ctx.ipk, 30, 3600), ('fn1:' + ctx.netk, 100, 3600)]

    def r_login(self, ctx, b):
        v = b.get('email')
        if not isinstance(v, str):
            raise Bad()
        em, e = norm_email(v[:1000])
        if e:
            return fail(e)
        guess = f_str(b, 'code', maxlen=32)
        dev = f_str(b, 'dev', RE_DEV)
        label = b.get('label')
        if not isinstance(label, str) or not RE_LABEL.fullmatch(label):
            label = 'Браузер'
        if not RE_CODE.fullmatch(guess):
            return fail('code')
        if not self.allowed(em):
            return fail('closed')
        rules = self._guess_limits(ctx)
        r = self.lim.hit(rules, add=False)
        if r:
            return self.slow(r)
        now, cfg = ctx.now, self.cfg
        eh = self.email_h(em)
        with self.store.tx() as c:
            res, extra = self._attempt(c, eh, 'login', em, guess, now)
            if res != 'ok':
                self.stat(c, 'logins_bad')
            else:
                row = c.execute('SELECT id FROM accounts WHERE email=?', (em,)).fetchone()
                today = day(now)
                if row is None:
                    acct = 'a_' + secrets.token_hex(8)
                    c.execute('INSERT INTO accounts(id, email, created, seen) VALUES(?, ?, ?, ?)',
                              (acct, em, now, today))
                else:
                    acct = row[0]
                    c.execute('UPDATE accounts SET seen=? WHERE id=?', (today, acct))
                tok = secrets.token_urlsafe(32)
                th = sha256h(tok.encode())
                c.execute('INSERT INTO sessions(token_h, sid, account_id, dev, label, created, renewed, seen, expires) '
                          'VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)',
                          (th, 's_' + secrets.token_hex(6), acct, dev, label, now, now, today,
                           now + cfg.max_days * DAY))
                n = c.execute('SELECT COUNT(*) FROM sessions WHERE account_id=?', (acct,)).fetchone()[0]
                if n > MAX_SESSIONS:
                    c.execute('DELETE FROM sessions WHERE token_h IN (SELECT token_h FROM sessions WHERE account_id=? '
                              'AND token_h<>? ORDER BY seen ASC, renewed ASC LIMIT ?)', (acct, th, n - MAX_SESSIONS))
                self.stat(c, 'logins_ok')
                head = self._head(c, acct)
        if res != 'ok':
            if res in ('code', 'replaced', 'expired', 'tries_over'):
                self.lim.add([k for k, _, _ in rules])
            if res == 'locked':
                self.count('limited')
            return fail(res, **extra)
        self.count('logins')
        ctx.cookies.append(set_cookie(tok, cfg.max_days * DAY))
        return ok(acct=acct, email=em, head=head)

    def r_me(self, ctx, b):
        s = self.session(ctx)
        if s is None:
            return ok(auth=False)
        r = self.srate(s.sid, 'me')
        if r:
            return self.slow(r)
        with self.store.ro() as c:
            head = self._head(c, s.acct)
        return ok(auth=True, acct=s.acct, email=s.email, head=head, sub=self.subscription(s.acct))

    # ── синхронизация ──

    def r_sync(self, ctx, b):
        pv = b.get('pv')
        if type(pv) is not int or pv != 1:
            raise Bad()
        acct = f_str(b, 'acct', RE_ACCT)
        dev = f_str(b, 'dev', RE_DEV)
        sv = f_int(b, 'sv', 0, 10 ** 6)
        base = f_str(b, 'base', RE_RID, opt=True)
        seq = f_int(b, 'seq', 0, 2 ** 53, opt=True)
        h = f_str(b, 'hash', RE_HEX, opt=True)
        oh = f_str(b, 'outHash', RE_HEX, opt=True)
        doc = b.get('doc')
        if doc is not None and not isinstance(doc, str):
            raise Bad()
        reason = b.get('reason', 'edit')
        if reason not in REASONS:
            raise Bad()
        if doc is not None and seq is None:
            raise Bad()
        s = ctx.sess or self.session(ctx)
        if s is None:
            return fail('auth')
        r = self.srate(s.sid, 'sync')
        if r:
            return self.slow(r)
        self.count('syncs')
        if acct != s.acct or dev != s.dev:
            return fail('acct')
        p = None
        if doc is not None:
            try:
                raw = doc.encode('utf-8')
            except UnicodeError:
                return fail('bad_doc')
            if len(raw) > self.cfg.doc_max:
                return fail('big')
            if h is None or not same(sha256h(raw), h):
                return fail('hash')
            d, e = check_doc(doc)
            if e:
                return fail(e)
            p = {'h': h, 'size': len(raw), 'sum': doc_sum(d), 'blob': zlib.compress(raw, 6)}
        with self.store.tx() as c:
            return self._sync_tx(c, ctx, s, sv, base, seq, h, oh, p, reason)

    def _seqmax(self, c, acct, dev):
        return c.execute('SELECT MAX(seq) FROM revisions WHERE account_id=? AND dev=?', (acct, dev)).fetchone()[0] or 0

    def _known(self, c, acct, base):
        return base is not None and c.execute("SELECT 1 FROM revisions WHERE rid=? AND account_id=? AND kind='push'",
                                              (base, acct)).fetchone() is not None

    def _insert_rev(self, c, acct, kind, parent, rev, reason, s, seq, sv, now, p):
        rid = 'r_' + secrets.token_hex(8)
        c.execute('INSERT INTO revisions(rid, account_id, rev, parent, kind, reason, dev, seq, sv, at, hash, size, sum, '
                  'label, keep, pin_until, blob) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
                  (rid, acct, rev, parent, kind, reason, s.dev, seq, sv, now, p['h'], p['size'], jdump(p['sum']),
                   s.label, '', None, p['blob']))
        return rid

    def _park(self, c, s, base, head_rev, reason, seq, sv, now, p):
        """Отложить документ (kind='parked'). None — не отложен (лимит, квота, диск): синхронизация не встаёт."""
        acct = s.acct
        r = c.execute("SELECT rid FROM revisions WHERE account_id=? AND kind='parked' AND hash=? AND at>? "
                      'ORDER BY at DESC LIMIT 1', (acct, p['h'], now - DAY)).fetchone()
        if r is not None:
            return r[0]
        n = c.execute("SELECT COUNT(*) FROM revisions WHERE account_id=? AND kind='parked' AND at>=?",
                      (acct, day_start(now))).fetchone()[0]
        if n >= self.cfg.park_day or not self.disk_ok():
            return None
        ab = c.execute('SELECT bytes FROM accounts WHERE id=?', (acct,)).fetchone()[0]
        if ab + len(p['blob']) > self.cfg.acct_bytes:
            return None
        rid = self._insert_rev(c, acct, 'parked', base, head_rev, reason, s, seq, sv, now, p)
        c.execute('UPDATE accounts SET bytes=bytes+? WHERE id=?', (len(p['blob']), acct))
        return rid

    def _quota(self, c, acct, add, now):
        ds = day_start(now)
        n = c.execute("SELECT COUNT(*) FROM revisions WHERE account_id=? AND kind='push' AND at>=?",
                      (acct, ds)).fetchone()[0]
        if n >= self.cfg.push_day:
            return self.slow(ds + DAY - now)
        if not self.disk_ok():
            return fail('disk')
        ab = c.execute('SELECT bytes FROM accounts WHERE id=?', (acct,)).fetchone()[0]
        if ab + add > self.cfg.acct_bytes:
            self._thin(c, acct, now)
            ab = c.execute('SELECT bytes FROM accounts WHERE id=?', (acct,)).fetchone()[0]
            if ab + add > self.cfg.acct_bytes:
                return fail('quota')
        return None

    def _push(self, c, s, head_rid, head_rev, sv, seq, reason, now, p):
        acct = s.acct
        rid = self._insert_rev(c, acct, 'push', head_rid, head_rev + 1, reason, s, seq, sv, now, p)
        freed = 0
        prev = None if head_rid is None else c.execute(
            'SELECT dev, sum, keep, pin_until, LENGTH(blob) FROM revisions WHERE rid=?', (head_rid,)).fetchone()
        if prev is not None:
            pd = int((jload(prev[1], {}) or {}).get('d') or 0)
            pinned = prev[3] is not None and prev[3] > now
            # закрепить прежнюю голову: сброс/возврат/выбор при входе или защита от сжатия
            if reason in PIN_REASONS or (pd >= 14 and p['sum']['d'] < pd / 2):
                c.execute('UPDATE revisions SET pin_until=? WHERE rid=?', (now + PIN_FOR, head_rid))
                pinned = True
            lastcp = c.execute("SELECT MAX(at) FROM revisions WHERE account_id=? AND keep='cp'", (acct,)).fetchone()[0]
            if prev[0] != s.dev or lastcp is None or lastcp < now - 3600 or pinned or prev[2] == 'cp':
                c.execute("UPDATE revisions SET keep='cp' WHERE rid=?", (head_rid,))
            elif prev[4] is not None and c.execute('SELECT 1 FROM sessions WHERE last_rid=? AND sid<>? LIMIT 1',
                                                   (head_rid, s.sid)).fetchone() is None:
                c.execute('UPDATE revisions SET blob=NULL WHERE rid=?', (head_rid,))
                freed = prev[4]
        c.execute('UPDATE accounts SET head_rid=?, head_rev=?, head_sv=MAX(head_sv, ?), bytes=bytes+?-? WHERE id=?',
                  (rid, head_rev + 1, sv, len(p['blob']), freed, acct))
        c.execute('UPDATE sessions SET last_rid=? WHERE sid=?', (rid, s.sid))
        self.stat(c, 'pushes')
        if reason == 'join':
            self.stat(c, 'joins')
        return rid

    def _pull(self, c, acct, dev, known, parked):
        row = c.execute('SELECT r.blob FROM accounts a JOIN revisions r ON r.rid=a.head_rid WHERE a.id=?',
                        (acct,)).fetchone()
        return ok(st='pull', head=self._head(c, acct), doc=inflate(row[0]), known=known, parked=parked,
                  seqMax=self._seqmax(c, acct, dev))

    def _sync_tx(self, c, ctx, s, sv, base, seq, h, oh, p, reason):
        now, acct, dev = ctx.now, s.acct, s.dev
        if c.execute('SELECT 1 FROM sessions WHERE sid=?', (s.sid,)).fetchone() is None:
            return fail('auth')
        row = c.execute('SELECT head_rid, head_rev, head_sv FROM accounts WHERE id=?', (acct,)).fetchone()
        if row is None:
            return fail('auth')
        head_rid, head_rev, head_sv = row
        hs = [x for x in (h, oh) if x]
        reuse, unknown = None, False
        if p is not None:
            seqmax = self._seqmax(c, acct, dev)
            pr = c.execute("SELECT rid, rev, hash, blob FROM revisions WHERE account_id=? AND dev=? AND seq=? "
                           "AND kind='push'", (acct, dev, seq)).fetchone()
            if pr is not None:
                if any(same(pr[2], x) for x in hs):
                    # потерянный ответ или keepalive: уже применено — ровно один раз
                    return ok(st='dup', mine={'rid': pr[0], 'rev': pr[1]}, doc=inflate(pr[3]), head=self._head(c, acct))
                unknown = True
            else:
                for prid, phash in c.execute("SELECT rid, hash FROM revisions WHERE account_id=? AND dev=? AND seq=? "
                                             "AND kind='parked' ORDER BY at DESC", (acct, dev, seq)).fetchall():
                    if any(same(phash, x) for x in hs):
                        reuse = prid
                        break
                if reuse is None and seq <= seqmax:
                    unknown = True
        if head_rid is not None and sv < head_sv:
            return fail('old_app', sv=head_sv)
        if head_rid is None:
            if p is None:
                return ok(st='empty', seqMax=self._seqmax(c, acct, dev))
            q = self._quota(c, acct, len(p['blob']), now)
            if q is not None:
                return q
            self._push(c, s, None, head_rev, sv, seq, reason, now, p)
            return ok(st='ok', head=self._head(c, acct))
        if unknown:
            pk = self._park(c, s, base, head_rev, reason, seq, sv, now, p)
            self.stat(c, 'pulls_merge')
            return self._pull(c, acct, dev, False, pk)
        if p is None:
            if base == head_rid:
                return ok(st='same', head=self._head(c, acct))
            return self._pull(c, acct, dev, self._known(c, acct, base), None)
        if base == head_rid:
            hh = c.execute('SELECT hash FROM revisions WHERE rid=?', (head_rid,)).fetchone()[0]
            if same(hh, h):
                return ok(st='same', head=self._head(c, acct))
            q = self._quota(c, acct, len(p['blob']), now)
            if q is not None:
                return q
            self._push(c, s, head_rid, head_rev, sv, seq, reason, now, p)
            return ok(st='ok', head=self._head(c, acct))
        pk = reuse if reuse is not None else self._park(c, s, base, head_rev, reason, seq, sv, now, p)
        self.stat(c, 'pulls_merge')
        return self._pull(c, acct, dev, self._known(c, acct, base), pk)

    # ── версии, устройства, выход, удаление ──

    def r_versions(self, ctx, b):
        s = self.session(ctx)
        if s is None:
            return fail('auth')
        r = self.srate(s.sid, 'ver')
        if r:
            return self.slow(r)
        now = ctx.now
        with self.store.ro() as c:
            rows = c.execute('SELECT rid, rev, at, kind, reason, label, sum, pin_until FROM revisions '
                             'WHERE account_id=? AND blob IS NOT NULL ORDER BY at DESC, rowid DESC LIMIT 100',
                             (s.acct,)).fetchall()
        return ok(list=[{'rid': x[0], 'rev': x[1], 'at': x[2], 'kind': x[3], 'reason': x[4], 'label': x[5],
                         'sum': jload(x[6], {}), 'pin': x[7] if x[7] is not None and x[7] > now else None}
                        for x in rows])

    def r_version(self, ctx, b):
        rid = f_str(b, 'rid', RE_RID)
        s = self.session(ctx)
        if s is None:
            return fail('auth')
        r = self.srate(s.sid, 'ver')
        if r:
            return self.slow(r)
        with self.store.ro() as c:
            row = c.execute('SELECT at, blob FROM revisions WHERE rid=? AND account_id=? AND blob IS NOT NULL',
                            (rid, s.acct)).fetchone()
        if row is None:
            return fail('gone')
        return ok(rid=rid, at=row[0], doc=inflate(row[1]))

    def r_sessions(self, ctx, b):
        s = self.session(ctx)
        if s is None:
            return fail('auth')
        r = self.srate(s.sid, 'sess')
        if r:
            return self.slow(r)
        with self.store.ro() as c:
            rows = c.execute('SELECT sid, label, seen FROM sessions WHERE account_id=? AND expires>? AND seen>=? '
                             'ORDER BY seen DESC, renewed DESC',
                             (s.acct, ctx.now, day(ctx.now - self.cfg.idle_days * DAY))).fetchall()
        return ok(list=[{'sid': x[0], 'label': x[1], 'seen': x[2], 'me': x[0] == s.sid} for x in rows])

    def r_logout(self, ctx, b):
        everyone = b.get('all', False)
        if not isinstance(everyone, bool):
            raise Bad()
        sid = f_str(b, 'sid', RE_SID, opt=True)
        s = self.session(ctx)
        if s is None:
            if ctx.had_cookie:
                ctx.cookies.append(CLEAR_COOKIE)
            return ok()
        mine = False
        with self.store.tx() as c:
            if everyone:
                c.execute('DELETE FROM sessions WHERE account_id=? AND sid<>?', (s.acct, s.sid))
            elif sid is not None:
                c.execute('DELETE FROM sessions WHERE account_id=? AND sid=?', (s.acct, sid))
                mine = sid == s.sid
            else:
                c.execute('DELETE FROM sessions WHERE sid=?', (s.sid,))
                mine = True
        if mine:
            ctx.cookies.append(CLEAR_COOKIE)
        return ok()

    def r_delete(self, ctx, b):
        guess = f_str(b, 'code', maxlen=32)
        s = self.session(ctx)
        if s is None:
            return fail('auth')
        r = self.srate(s.sid, 'del')
        if r:
            return self.slow(r)
        if not RE_CODE.fullmatch(guess):
            return fail('code')
        rules = self._guess_limits(ctx)
        r = self.lim.hit(rules, add=False)
        if r:
            return self.slow(r)
        eh = self.email_h(s.email)
        with self.store.tx() as c:
            res, extra = self._attempt(c, eh, 'delete', s.email, guess, ctx.now)
        if res != 'ok':
            if res in ('code', 'replaced', 'expired', 'tries_over'):
                self.lim.add([k for k, _, _ in rules])
            return fail(res, **extra)
        self.cancel_subscription(s.acct)
        self.delete_account(s.acct, s.email, ctx.now)
        ctx.cookies.append(CLEAR_COOKIE)
        return ok()

    # ── надгробия ──

    def _log_path(self):
        return os.path.join(self.cfg.state, 'deletions.log')

    @contextlib.contextmanager
    def _log_lock(self):
        fd = os.open(os.path.join(self.cfg.state, 'deletions.lock'), os.O_RDWR | os.O_CREAT, 0o600)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX)
            yield
        finally:
            os.close(fd)

    def delete_account(self, acct, em, now):
        """Надгробие (файл, потом таблица) и каскадное удаление: ревизии и сессии уходят вместе с аккаунтом."""
        eh = self.email_h(em)
        with self._log_lock():
            with open(self._log_path(), 'a', encoding='ascii') as f:
                f.write('%d\t%s\n' % (now, eh))
                f.flush()
                os.fsync(f.fileno())
        with self.store.tx() as c:
            c.execute('INSERT INTO deletions(email_h, at) VALUES(?, ?)', (eh, now))
            c.execute('DELETE FROM accounts WHERE id=?', (acct,))
            c.execute('DELETE FROM codes WHERE email_h=?', (eh,))
            self.stat(c, 'deletes')
        self.checkpoint()

    def checkpoint(self):
        """Старые кадры WAL с удалёнными данными — прочь из файла."""
        with self.store.lock:
            try:
                self.store.db.execute('PRAGMA wal_checkpoint(TRUNCATE)')
            except sqlite3.Error:
                pass

    def read_tombstones(self):
        t = {}
        try:
            with open(self._log_path(), encoding='ascii', errors='replace') as f:
                for line in f:
                    a, _, eh = line.strip().partition('\t')
                    if a.isdigit() and RE_HEX.fullmatch(eh):
                        t[eh] = max(t.get(eh, 0), int(a))
        except FileNotFoundError:
            pass
        return t

    def replay(self):
        """После восстановления БД: надгробия из deletions.log и удаление ВСЕХ сессий."""
        tomb = self.read_tombstones()
        gone = 0
        with self.store.tx() as c:
            for acct, em, created in c.execute('SELECT id, email, created FROM accounts').fetchall():
                at = tomb.get(self.email_h(em))
                if at is not None and created <= at:  # секунды: удалить сразу после создания — тоже до надгробия
                    c.execute('DELETE FROM accounts WHERE id=?', (acct,))
                    gone += 1
            have = set(c.execute('SELECT email_h, at FROM deletions').fetchall())
            for eh, at in tomb.items():
                if (eh, at) not in have:
                    c.execute('INSERT INTO deletions(email_h, at) VALUES(?, ?)', (eh, at))
            n = c.execute('DELETE FROM sessions').rowcount
        return gone, n

    # ── хранение и чистка ──

    def _thin(self, c, acct, now):
        """Правило хранения блобов (§4) для одного аккаунта; возвращает число вычищенных блобов."""
        head = c.execute('SELECT head_rid FROM accounts WHERE id=?', (acct,)).fetchone()[0]
        keep = {head}
        for (r,) in c.execute('SELECT last_rid FROM sessions WHERE account_id=? AND last_rid IS NOT NULL AND expires>? '
                              'AND seen>=?', (acct, now, day(now - self.cfg.idle_days * DAY))).fetchall():
            keep.add(r)
        cands = [(rid, at, rowid) for rid, at, pin, rowid in
                 c.execute('SELECT rid, at, pin_until, rowid FROM revisions WHERE account_id=? AND blob IS NOT NULL',
                           (acct,)).fetchall()
                 if rid not in keep and not (pin is not None and pin > now)]
        old = [x for x in cands if x[1] < now - 2 * DAY]      # всё за 48 ч остаётся
        newest = {}                                           # старше — самая новая за день UTC, до 30 дней
        for rid, at, rowid in old:
            d = day(at)
            if d not in newest or (at, rowid) > newest[d][1:]:
                newest[d] = (rid, at, rowid)
        drop = [rid for rid, at, rowid in old if not (at >= now - 30 * DAY and newest[day(at)][0] == rid)]
        for rid in drop:
            c.execute('UPDATE revisions SET blob=NULL WHERE rid=?', (rid,))
        c.execute('DELETE FROM revisions WHERE account_id=? AND blob IS NULL AND at<? AND rid IS NOT ?',
                  (acct, now - 180 * DAY, head))
        c.execute('UPDATE accounts SET bytes=(SELECT COALESCE(SUM(LENGTH(blob)), 0) FROM revisions WHERE account_id=?) '
                  'WHERE id=?', (acct, acct))
        return len(drop)

    def cleanup(self, now=None):
        """Лёгкая чистка (каждый час в службе): коды старше суток, мёртвые сессии, старые счётчики писем."""
        now = self.now() if now is None else now
        with self.store.tx() as c:
            a = c.execute('DELETE FROM codes WHERE created<?', (now - DAY,)).rowcount
            b = c.execute('DELETE FROM sessions WHERE expires<? OR seen<?',
                          (now, day(now - self.cfg.idle_days * DAY))).rowcount
            c.execute("DELETE FROM mail_count WHERE (k LIKE 'day:%' AND k<?) OR (k LIKE 'min:%' AND k<?)",
                      ('day:' + day(now - 2 * DAY), 'min:' + minute_key(now - 3600)))
            with self.hlock:
                lim, self.limited_unsaved = self.limited_unsaved, 0
            if lim:
                self.stat(c, 'limited', lim)
        return a, b

    def maintain(self):
        """Ночное обслуживание (после успешного бэкапа)."""
        now = self.now()
        codes, sess = self.cleanup(now)
        thinned = 0
        with self.store.ro() as c:
            accts = [r[0] for r in c.execute('SELECT id FROM accounts').fetchall()]
        for acct in accts:
            with self.store.tx() as c:
                if c.execute('SELECT 1 FROM accounts WHERE id=?', (acct,)).fetchone():
                    thinned += self._thin(c, acct, now)
        with self.store.ro() as c:
            old = c.execute('SELECT id, email FROM accounts WHERE seen<?',
                            (day(now - self.cfg.inactive_days * DAY),)).fetchall()
        for acct, em in old:
            self.cancel_subscription(acct)
            self.delete_account(acct, em, now)
        cut = now - 45 * DAY
        with self.store.tx() as c:
            c.execute('DELETE FROM deletions WHERE at<?', (cut,))
            c.execute('DELETE FROM stats WHERE substr(k, 1, 7)<?', (month(now - 400 * DAY),))
        with self._log_lock():
            try:
                with open(self._log_path(), encoding='ascii', errors='replace') as f:
                    lines = f.readlines()
            except FileNotFoundError:
                lines = None
            if lines is not None:
                keep = [x for x in lines if x.partition('\t')[0].strip().isdigit() and int(x.partition('\t')[0]) >= cut]
                if len(keep) != len(lines):
                    tmp = self._log_path() + '.tmp'
                    with open(tmp, 'w', encoding='ascii') as f:
                        f.writelines(keep)
                        f.flush()
                        os.fsync(f.fileno())
                    os.replace(tmp, self._log_path())
        self.poll_payments()
        with self.store.lock:
            self.store.db.execute('PRAGMA incremental_vacuum')
            self.store.db.execute('PRAGMA optimize')
        self.checkpoint()
        return {'codes': codes, 'sessions': sess, 'thinned': thinned, 'inactive': len(old)}

    def maint_loop(self, stop):
        last = time.monotonic()
        while not stop.wait(60):
            try:
                self.lim.purge()
                if self.store is None:
                    try:
                        self.store = Store(self.cfg.db)
                    except Exception:
                        continue
                if time.monotonic() - last >= 3600:
                    last = time.monotonic()
                    self.cleanup()
                    with self.hlock:
                        h, self.hourly = self.hourly, {'codes': 0, 'logins': 0, 'syncs': 0, 'limited': 0}
                    log('stats codes=%d logins=%d syncs=%d limited=%d' % (h['codes'], h['logins'], h['syncs'],
                                                                         h['limited']))
            except Exception:
                log_exc(*sys.exc_info()[::2])

    def stats(self):
        """Для magnat status: только числа, без адресов и идентификаторов."""
        now = self.now()
        m = month(now)
        with self.store.ro() as c:
            q = lambda sql, *a: c.execute(sql, a).fetchone()[0]
            r = {'schema': self.store.schema, 'accounts': q('SELECT COUNT(*) FROM accounts'),
                 'active7': q('SELECT COUNT(*) FROM accounts WHERE seen>=?', day(now - 7 * DAY)),
                 'sessions': q('SELECT COUNT(*) FROM sessions'), 'revisions': q('SELECT COUNT(*) FROM revisions'),
                 'blobs': q('SELECT COALESCE(SUM(LENGTH(blob)), 0) FROM revisions'),
                 'mail_today': q("SELECT COALESCE(MAX(n), 0) FROM mail_count WHERE k=?", 'day:' + day(now)),
                 'mail_day': self.cfg.mail_day,
                 'month': {k.split(':', 1)[1]: n for k, n in
                           c.execute('SELECT k, n FROM stats WHERE substr(k, 1, 7)=?', (m,)).fetchall()}}
            me = c.execute("SELECT v FROM meta WHERE k='mail_err'").fetchone()
        r['mail_err'] = me[0] if me else None
        r['db_bytes'] = sum(os.path.getsize(self.store.path + s) for s in ('', '-wal')
                            if os.path.exists(self.store.path + s))
        r['open'] = self.cfg.open
        r['paused'] = self.paused()
        return r


# ═══════════════════════════ HTTP ═══════════════════════════

class Gone(Exception):
    """Соединение оборвалось посреди тела — отвечать некому."""


class Reaper:
    """Обрывает соединения, которые слишком долго шлют заголовки или тело (slowloris)."""

    def __init__(self):
        self.lock = threading.Lock()
        self.d = {}
        threading.Thread(target=self._run, daemon=True).start()

    def set(self, sock, deadline):
        with self.lock:
            self.d[sock] = deadline

    def drop(self, sock):
        with self.lock:
            self.d.pop(sock, None)

    def _run(self):
        while True:
            time.sleep(0.5)
            now = time.monotonic()
            with self.lock:
                late = [s for s, t in self.d.items() if t <= now]
                for s in late:
                    del self.d[s]
            for s in late:
                try:
                    s.shutdown(socket.SHUT_RDWR)
                except OSError:
                    pass


BUSY = (b'HTTP/1.0 503 Service Unavailable\r\nContent-Type: application/json; charset=utf-8\r\n'
        b'Cache-Control: no-store\r\nContent-Length: 27\r\nConnection: close\r\n\r\n{"ok":false,"err":"busy"}\r\n')


class Handler(http.server.BaseHTTPRequestHandler):
    timeout = READ_HEADERS          # на каждое чтение сокета
    protocol_version = 'HTTP/1.0'   # одно соединение — один запрос: потоков не больше, чем запросов
    server_version = 'magnat'
    sys_version = ''

    def setup(self):
        super().setup()
        self.server.reaper.set(self.connection, time.monotonic() + READ_HEADERS)

    def finish(self):
        try:
            super().finish()
        finally:
            self.server.reaper.drop(self.connection)

    def log_message(self, format, *args):
        pass  # журнала запросов нет: IP и пути не пишем

    def send_response(self, code, message=None):
        self.send_response_only(code, message)
        self.send_header('Date', self.date_time_string())

    def send_error(self, code, message=None, explain=None):
        err = {400: 'bad', 404: 'nope', 405: 'method', 408: 'bad', 413: 'big', 414: 'big', 431: 'big',
               501: 'method'}.get(int(code), 'bad')
        self.close_connection = True
        self._reply(fail(err, 405 if int(code) == 501 else int(code)))

    def _read(self, n):
        self.server.reaper.set(self.connection, time.monotonic() + READ_BODY)
        buf = bytearray()
        while len(buf) < n:
            try:
                ch = self.rfile.read(min(65536, n - len(buf)))
            except (OSError, ValueError):
                raise Gone()
            if not ch:
                raise Gone()
            buf += ch
        self.server.reaper.drop(self.connection)
        self.got_body = True
        return bytes(buf)

    def _reply(self, r):
        body = jdump(r.obj).encode('utf-8')
        try:
            self.send_response(r.status)
            self.send_header('Content-Type', 'application/json; charset=utf-8')
            self.send_header('Cache-Control', 'no-store')
            self.send_header('Content-Length', str(len(body)))
            self.send_header('X-Content-Type-Options', 'nosniff')
            for k, v in r.headers:
                self.send_header(k, v)
            self.send_header('Connection', 'close')
            self.end_headers()
            if getattr(self, 'command', '') != 'HEAD':
                self.wfile.write(body)
        except OSError:
            pass
        self.close_connection = True

    def _drain(self):
        """Ранний отказ (413, 403…) при непрочитанном теле: дочитать до 4 МБ за ≤5 с, чтобы клиент увидел ответ."""
        cl = (self.headers.get('Content-Length') or '').strip()
        if not re.fullmatch(r'[0-9]{1,7}', cl) or not 0 < int(cl) <= 4 << 20:
            return
        n = int(cl)
        self.server.reaper.set(self.connection, time.monotonic() + 5)
        try:
            while n > 0:
                ch = self.rfile.read(min(65536, n))
                if not ch:
                    break
                n -= len(ch)
        except (OSError, ValueError):
            pass
        self.server.reaper.drop(self.connection)

    def _go(self):
        app = self.server.app
        self.close_connection = True
        self.got_body = False
        path = self.path.split('?', 1)[0]
        if path == '/api/health':
            self.server.reaper.drop(self.connection)
            return self._reply(app.health(self.command, self.headers, self.client_address[0]))
        try:
            r = app.handle(self.command, self.path, self.headers, self._read, self.client_address[0])
        except Gone:
            return
        except Exception:
            log_exc(*sys.exc_info()[::2])
            r = fail('server', 500)
        self.server.reaper.drop(self.connection)
        self._reply(r)
        if not self.got_body:
            self._drain()

    do_GET = do_POST = do_HEAD = do_PUT = do_DELETE = do_PATCH = do_OPTIONS = _go


class Server(http.server.ThreadingHTTPServer):
    daemon_threads = True
    block_on_close = False
    request_queue_size = 64

    def __init__(self, addr, app, bind=True):
        self.app = app
        self.reaper = Reaper()
        self.clock = threading.Lock()
        self.conns = 0
        super().__init__(addr, Handler, bind_and_activate=bind)

    def server_bind(self):
        socketserver.TCPServer.server_bind(self)
        self.server_name, self.server_port = 'localhost', self.server_address[1]

    def process_request(self, request, client_address):
        with self.clock:
            full = self.conns >= MAX_CONNS
            if not full:
                self.conns += 1
        if full:
            try:
                request.setblocking(False)
                request.send(BUSY)
            except OSError:
                pass
            self.shutdown_request(request)
            return
        try:
            super().process_request(request, client_address)
        except BaseException:
            with self.clock:
                self.conns -= 1
            raise

    def process_request_thread(self, request, client_address):
        try:
            super().process_request_thread(request, client_address)
        finally:
            with self.clock:
                self.conns -= 1

    def handle_error(self, request, client_address):
        log_exc(*sys.exc_info()[::2])


def parse_listen(s):
    host, _, port = s.rpartition(':')
    host = host.strip('[]')
    if host not in ('127.0.0.1', '::1', 'localhost'):
        raise ValueError('API слушает только 127.0.0.1')
    return ('127.0.0.1' if host == 'localhost' else host), int(port)


# ═══════════════════════════ CLI ═══════════════════════════

VALUED = ('db', 'out', 'creds', 'to', 'kind', 'text')


def parse_args(argv):
    pos, opts, i = [], {}, 0
    while i < len(argv):
        a = argv[i]
        if a.startswith('--') and a[2:] in VALUED:
            if i + 1 >= len(argv):
                raise ValueError('нет значения для ' + a)
            opts[a[2:]] = argv[i + 1]
            i += 2
        elif a.startswith('--'):
            raise ValueError('неизвестный ключ ' + a)
        else:
            pos.append(a)
            i += 1
    return pos, opts


def read_creds(opts):
    src = opts.get('creds')
    if src is None:
        return None
    if src == '-':
        return parse_smtp_env(sys.stdin.read(65536))
    with open(src, encoding='utf-8') as f:
        return parse_smtp_env(f.read(65536))


def open_app(opts, migrate=True, need_key=True):
    cfg = Cfg()
    if opts.get('db'):
        cfg.db = opts['db']
    if not os.path.exists(cfg.db):
        raise RuntimeError('базы нет')
    store = Store(cfg.db, migrate=migrate, create=False)
    key = load_key(cfg.state) if need_key else secrets.token_bytes(32)
    return App(cfg, store, key, FakeMailer())


def cmd_serve(pos, opts):
    cfg = Cfg()
    install_hooks()
    host, port = parse_listen(cfg.listen)
    try:
        os.makedirs(os.path.join(cfg.state, 'tmp'), mode=0o700, exist_ok=True)
    except OSError:
        pass
    key = load_key(cfg.state)
    try:
        store = Store(cfg.db)
    except Exception:
        log_exc(*sys.exc_info()[::2])
        store = None
    app = App(cfg, store, key, Mailer(cfg.smtp_file))
    srv = Server((host, port), app)
    log('start v=%s schema=%d' % (app.version, store.schema if store else 0))
    stop = threading.Event()
    threading.Thread(target=app.maint_loop, args=(stop,), daemon=True).start()

    def bye(*a):
        stop.set()
        threading.Thread(target=srv.shutdown, daemon=True).start()
    signal.signal(signal.SIGTERM, bye)
    signal.signal(signal.SIGINT, bye)
    srv.serve_forever(poll_interval=0.5)
    srv.server_close()
    if app.store is not None:
        app.store.close()
    return 0


class Probe:
    """Маленький HTTP-клиент для check: настоящий запрос через настоящий обработчик."""

    def __init__(self, port, origin):
        self.port, self.origin, self.tok = port, origin, None

    def __call__(self, path, body):
        data = jdump(body).encode('utf-8')
        h = {'Origin': self.origin, 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-origin',
             'X-Forwarded-For': '192.0.2.1'}
        if self.tok:
            h['Cookie'] = '%s=%s' % (COOKIE, self.tok)
        cn = http.client.HTTPConnection('127.0.0.1', self.port, timeout=20)
        try:
            cn.request('POST', path, body=data, headers=h)
            r = cn.getresponse()
            raw = r.read()
            for k, v in r.getheaders():
                if k.lower() == 'set-cookie' and v.startswith(COOKIE + '='):
                    self.tok = v.split(';', 1)[0].split('=', 1)[1] or None
            if r.status != 200:
                raise RuntimeError('status %d' % r.status)
            return json.loads(raw)
        finally:
            cn.close()


def cmd_check(pos, opts):
    """Предполётная проверка выпуска на копии живой БД (живую не трогает, писем не шлёт)."""
    cfg = Cfg()
    live = opts.get('db') or cfg.db
    tmpd = os.path.join(cfg.state, 'tmp')
    os.makedirs(tmpd, mode=0o700, exist_ok=True)
    work = tempfile.mkdtemp(prefix='check-', dir=tmpd)
    dst = os.path.join(work, 'check.db')
    step, store, srv = 'copy', None, None
    try:
        if os.path.exists(live):
            if sqlite_copy(live, dst) != 'ok':
                raise RuntimeError('integrity')
        step = 'migrate'
        store = Store(dst)
        cfg.db, cfg.state, cfg.open, cfg.disk_min_mb = dst, work, True, 0
        cfg.mail_day = cfg.mail_min = 10 ** 6   # потолки живой БД не должны блокировать выкладку
        cfg.origin = 'https://check.invalid'
        mailer = FakeMailer()
        app = App(cfg, store, secrets.token_bytes(32), mailer)
        srv = Server(('127.0.0.1', 0), app)
        threading.Thread(target=srv.serve_forever, kwargs={'poll_interval': 0.2}, daemon=True).start()
        call = Probe(srv.server_address[1], cfg.origin)
        em = 'check-%s@example.ru' % secrets.token_hex(4)
        dev = 'd_' + secrets.token_hex(8)
        step = 'code'
        r = call('/api/code', {'email': em, 'purpose': 'login'})
        assert r.get('ok'), r
        step = 'login'
        r = call('/api/login', {'email': em, 'code': mailer.last_code(em), 'dev': dev, 'label': 'check'})
        assert r.get('ok') and call.tok and r['head'] is None, r
        acct = r['acct']
        step = 'sync'
        doc = jdump({'habits': [{'id': 1, 'ico': '', 'name': 'Проверка', 'since': ''}], 'checks': {'2026-01-01': [1]},
                     'tasks': [], 'taskBank': 0, 'finance': {'income': 0, 'entries': []}})
        h = sha256h(doc.encode('utf-8'))
        r = call('/api/sync', {'pv': 1, 'acct': acct, 'dev': dev, 'sv': 1, 'base': None, 'seq': 1, 'hash': h,
                               'outHash': None, 'doc': doc, 'reason': 'first'})
        assert r.get('ok') and r['st'] == 'ok', r
        rid = r['head']['rid']
        r = call('/api/sync', {'pv': 1, 'acct': acct, 'dev': dev, 'sv': 1, 'base': rid, 'seq': None, 'hash': None,
                               'outHash': None, 'doc': None, 'reason': 'edit'})
        assert r.get('ok') and r['st'] == 'same', r
        step = 'versions'
        r = call('/api/versions', {})
        assert r.get('ok') and r['list'] and r['list'][0]['rid'] == rid, r
        r = call('/api/version', {'rid': rid})
        assert r.get('ok') and r['doc'] == doc, r
        step = 'me'
        r = call('/api/me', {})
        assert r.get('ok') and r['auth'] and r['head']['rid'] == rid, r
        step = 'logout'
        r = call('/api/logout', {})
        assert r.get('ok') and call.tok is None, r
        out('api-check-ok')
        return 0
    except Exception as e:
        out('api-check-fail %s %s' % (step, type(e).__name__))
        return 1
    finally:
        if srv is not None:
            srv.shutdown()
            srv.server_close()
        if store is not None:
            store.close()
        shutil.rmtree(work, ignore_errors=True)


def cmd_backup(pos, opts):
    cfg = Cfg()
    src = opts.get('db') or cfg.db
    dest = opts.get('out', '-')
    if not os.path.exists(src):
        log('backup-fail nodb')
        return 1
    tmpd = os.path.join(cfg.state, 'tmp')
    os.makedirs(tmpd, mode=0o700, exist_ok=True)
    tmp = os.path.join(tmpd, 'backup-%s.db' % secrets.token_hex(6))
    try:
        if sqlite_copy(src, tmp) != 'ok':
            log('backup-fail integrity')
            return 1
        with open(tmp, 'rb') as f:
            if dest == '-':
                shutil.copyfileobj(f, sys.stdout.buffer, 1 << 20)
                sys.stdout.buffer.flush()
            else:
                fd = os.open(dest, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
                with os.fdopen(fd, 'wb') as g:
                    shutil.copyfileobj(f, g, 1 << 20)
        return 0
    finally:
        rm_db(tmp)


def cmd_verify(pos, opts):
    if len(pos) != 1:
        raise ValueError('verify FILE')
    try:
        c = sqlite3.connect(file_uri(pos[0], 'ro'), uri=True)
        try:
            ic = c.execute('PRAGMA integrity_check').fetchone()[0]
            if ic != 'ok':
                out('integrity=bad')
                return 1
            n = c.execute('SELECT COUNT(*) FROM accounts').fetchone()[0]
            ts = c.execute('SELECT MAX(at) FROM revisions').fetchone()[0]
            seen = c.execute('SELECT MAX(seen) FROM accounts').fetchone()[0]
        finally:
            c.close()
    except sqlite3.Error:
        out('integrity=bad')
        return 1
    newest = max([x for x in (day(ts) if ts else None, seen) if x] or ['-'])
    out('integrity=ok accounts=%d newest=%s' % (n, newest))
    return 0


def cmd_maintain(pos, opts):
    app = open_app(opts)
    try:
        r = app.maintain()
    finally:
        app.store.close()
    out('maintain-ok ' + ' '.join('%s=%d' % kv for kv in sorted(r.items())))
    return 0


def cmd_replay(pos, opts):
    app = open_app(opts)
    try:
        gone, n = app.replay()
    finally:
        app.store.close()
    out('replay-ok accounts=%d sessions=%d' % (gone, n))
    return 0


def cmd_stats(pos, opts):
    cfg = Cfg()
    path = opts.get('db') or cfg.db
    if not os.path.exists(path):
        out(jdump({'db': False}))
        return 1
    app = open_app(opts, migrate=False, need_key=False)
    try:
        out(jdump(app.stats()))
    finally:
        app.store.close()
    return 0


def _send_cli(conf, msg, okword):
    try:
        smtp_send(conf, msg)
    except Exception as e:
        out('mail-fail %s %s' % (mail_fault(e), type(e).__name__))
        return 1
    out(okword)
    return 0


def cmd_mailtest(pos, opts):
    conf = read_creds(opts)
    to, e = norm_email(opts.get('to', ''))
    if conf is None or e:
        out('mail-fail config -')
        return 1
    return _send_cli(conf, letter_check(conf, to), 'mail-ok')


def cmd_alert(pos, opts):
    conf = read_creds(opts)
    kind = opts.get('kind', '')
    text = ' '.join(opts.get('text', '').split())[:200]
    if conf is None or not RE_KIND.fullmatch(kind) or not text:
        out('mail-fail config -')
        return 1
    return _send_cli(conf, letter_alert(conf, kind, text), 'mail-ok')


def cmd_user(pos, opts):
    if len(pos) != 2 or pos[0] not in ('show', 'export', 'delete'):
        raise ValueError('user show|export|delete EMAIL --db DB')
    act = pos[0]
    em, e = norm_email(pos[1])
    if e:
        out('Это не похоже на адрес почты.')
        return 1
    conf = read_creds(opts) if act == 'export' else None
    if act == 'export' and conf is None:
        out('mail-fail config -')
        return 1
    app = open_app(opts, need_key=(act == 'delete'))
    try:
        with app.store.ro() as c:
            row = c.execute('SELECT id, created, seen FROM accounts WHERE email=?', (em,)).fetchone()
            if row is None:
                out('Аккаунта с этим адресом нет.')
                return 0
            acct = row[0]
            devs = c.execute('SELECT label, seen, created FROM sessions WHERE account_id=? ORDER BY seen DESC',
                             (acct,)).fetchall()
            vers = c.execute('SELECT at, kind, reason, label FROM revisions WHERE account_id=? ORDER BY at DESC',
                             (acct,)).fetchall()
            size = c.execute('SELECT COALESCE(SUM(LENGTH(blob)), 0) FROM revisions WHERE account_id=?',
                             (acct,)).fetchone()[0]
            hb = c.execute('SELECT r.blob FROM accounts a JOIN revisions r ON r.rid=a.head_rid WHERE a.id=?',
                           (acct,)).fetchone()
        if act == 'show':
            out('Аккаунт есть: создан %s, последний заход %s.' % (day(row[1]), row[2]))
            out('Устройства (%d): %s' % (len(devs), '; '.join('%s — %s' % (d[0], d[1]) for d in devs) or 'нет'))
            out('Версий: %d, место на сервере: %d КБ.' % (len(vers), (size + 1023) // 1024))
            return 0
        if act == 'export':
            data = {'service': 'magnat-planer.ru', 'exported': day(app.now()),
                    'account': {'email': em, 'created': day(row[1]), 'seen': row[2]},
                    'devices': [{'label': d[0], 'seen': d[1], 'since': day(d[2])} for d in devs],
                    'data': jload(inflate(hb[0])) if hb and hb[0] is not None else None,
                    'versions': [{'at': v[0], 'kind': v[1], 'reason': v[2], 'label': v[3]} for v in vers]}
            return _send_cli(conf, letter_export(conf, em, data, app.now()), 'export-ok')
        app.cancel_subscription(acct)
        app.delete_account(acct, em, app.now())
        out('Аккаунт удалён, надгробие записано.')
        return 0
    finally:
        app.store.close()


# ═══════════════════════════ Selftest ═══════════════════════════

def mkheaders(d):
    m = http.client.HTTPMessage()
    for k, v in d.items():
        if v is not None:
            m[k] = v
    return m


class TClient:
    """Клиент selftest: зовёт App.handle напрямую, без сокетов."""

    def __init__(self, app, ip='192.0.2.10'):
        self.app, self.ip, self.tok, self.last = app, ip, None, None

    def call(self, path, body=None, raw=None, method='POST', hdr=None, ip=None):
        data = raw if raw is not None else jdump({} if body is None else body).encode('utf-8')
        h = {'Origin': self.app.cfg.origin, 'Content-Type': 'application/json', 'Content-Length': str(len(data)),
             'Sec-Fetch-Site': 'same-origin', 'X-Forwarded-For': ip or self.ip}
        if self.tok:
            h['Cookie'] = '%s=%s' % (COOKIE, self.tok)
        h.update(hdr or {})
        r = self.app.handle(method, path, mkheaders(h), lambda n: data[:n], '127.0.0.1')
        for k, v in r.headers:
            if k == 'Set-Cookie' and v.startswith(COOKIE + '='):
                self.tok = v.split(';', 1)[0].split('=', 1)[1] or None
                self.last = v
        return r


def tdoc(days=1, habits=1, extra=None, start='2026-01-01'):
    t0 = time.mktime(time.strptime(start, '%Y-%m-%d'))
    d = {'habits': [{'id': i + 1, 'ico': '', 'name': 'П%d' % i, 'since': ''} for i in range(habits)],
         'checks': {day(int(t0) + i * DAY): [1] for i in range(days)}, 'tasks': [], 'taskBank': 0,
         'finance': {'income': 0, 'entries': []}}
    d.update(extra or {})
    return jdump(d)


class SelfTest:
    def __init__(self):
        self.n = 0
        self.bad = []
        self.dirs = []

    def ok(self, cond, name):
        self.n += 1
        if not cond:
            self.bad.append(name)

    def app(self, **over):
        d = tempfile.mkdtemp(prefix='magnat-selftest-')
        self.dirs.append(d)
        env = {'MAGNAT_STATE': d, 'MAGNAT_DB': os.path.join(d, 'm.db'), 'MAGNAT_ORIGIN': 'https://t.invalid',
               'MAGNAT_OPEN': '1', 'MAGNAT_DISK_MIN_MB': '0', 'MAGNAT_CODE_GAP': '0'}
        env.update({k: str(v) for k, v in over.items()})
        cfg = Cfg(env)
        return App(cfg, Store(cfg.db), secrets.token_bytes(32), FakeMailer())

    def login(self, app, em, dev=None, ip='192.0.2.10'):
        cl = TClient(app, ip)
        r = cl.call('/api/code', {'email': em, 'purpose': 'login'})
        assert r.obj.get('ok'), r.obj
        dev = dev or 'd_' + secrets.token_hex(8)
        r = cl.call('/api/login', {'email': em, 'code': app.mailer.last_code(em), 'dev': dev, 'label': 'Тест'})
        assert r.obj.get('ok'), r.obj
        cl.acct, cl.dev, cl.seq = r.obj['acct'], dev, 0
        return cl

    def push(self, cl, doc, base, reason='edit', seq=None, outh=None, sv=1):
        if seq is None:
            cl.seq += 1
            seq = cl.seq
        h = sha256h(doc.encode('utf-8'))
        return cl.call('/api/sync', {'pv': 1, 'acct': cl.acct, 'dev': cl.dev, 'sv': sv, 'base': base, 'seq': seq,
                                     'hash': h, 'outHash': outh, 'doc': doc, 'reason': reason}).obj

    def pull(self, cl, base, sv=1):
        return cl.call('/api/sync', {'pv': 1, 'acct': cl.acct, 'dev': cl.dev, 'sv': sv, 'base': base, 'seq': None,
                                     'hash': None, 'outHash': None, 'doc': None, 'reason': 'edit'}).obj

    def run(self):
        try:
            for name in sorted(n for n in dir(self) if n.startswith('t_')):
                try:
                    getattr(self, name)()
                except Exception as e:
                    self.bad.append('%s: %s %s' % (name, type(e).__name__, str(e)[:200]))
        finally:
            for d in self.dirs:
                shutil.rmtree(d, ignore_errors=True)
        return not self.bad

    # ── порядок в handle(): медленное тело не держит место, sync без входа не читает тело ──

    def t_slow_body_holds_no_slot(self):
        app = self.app()
        go, entered = threading.Event(), threading.Event()
        data = jdump({'email': 'slow@mail.ru', 'purpose': 'login'}).encode()

        def slow(n):
            entered.set()
            go.wait(5)
            return data[:n]
        h = mkheaders({'Origin': app.cfg.origin, 'Content-Type': 'application/json', 'Content-Length': str(len(data)),
                       'Sec-Fetch-Site': 'same-origin', 'X-Forwarded-For': '192.0.2.77'})
        th = threading.Thread(target=lambda: app.handle('POST', '/api/code', h, slow, '127.0.0.1'))
        th.start()
        entered.wait(5)
        free = app.inflight._value
        go.set()
        th.join(5)
        self.ok(free == 16, 'пока тело идёт медленно, места «в работе» свободны: %s из 16' % free)

    def t_sync_auth_before_body(self):
        app = self.app()
        touched = []

        def boom(n):
            touched.append(n)
            return b'{}'
        h = mkheaders({'Origin': app.cfg.origin, 'Content-Type': 'application/json', 'Content-Length': '1000000',
                       'Sec-Fetch-Site': 'same-origin', 'X-Forwarded-For': '192.0.2.78'})
        r = app.handle('POST', '/api/sync', h, boom, '127.0.0.1')
        self.ok(r.obj.get('err') == 'auth' and not touched, 'sync без входа: отказ auth, тело не читалось')
        self.ok(app.sync_sem._value == 2, 'sync без входа очередь не занял')

    # ── лимиты, которых не касались другие проверки (ревью R1, 11.10) ──

    def t_limits_more(self):
        ok = self.ok
        app = self.app()
        app.inflight = threading.BoundedSemaphore(64)
        cl = self.login(app, 'lim@example.ru')
        for path, n, name in (('/api/me', 60, 'me'), ('/api/sessions', 60, 'sessions'), ('/api/versions', 20, 'versions')):
            rs = [cl.call(path, {}).obj for _ in range(n + 1)]
            ok(all(x.get('err') != 'slow' for x in rs[:n]) and rs[n].get('err') == 'slow' and rs[n].get('retryIn', 0) > 0,
               'сессия: %s — %d в минуту' % (name, n))
        rs = [self.pull(cl, None) for _ in range(31)]
        ok(all(x.get('err') != 'slow' for x in rs[:30]) and rs[30].get('err') == 'slow', 'сессия: sync — 30 в минуту')
        rs = [cl.call('/api/delete', {'code': '000000'}).obj for _ in range(4)]
        ok(all(x.get('err') != 'slow' for x in rs[:3]) and rs[3].get('err') == 'slow', 'сессия: удаление — 3 в сутки')
        # угадывание кода: 30 неверных в час с одного IP, 100 — с одной подсети
        app2 = self.app()
        app2.inflight = threading.BoundedSemaphore(64)
        TClient(app2, '192.0.2.200').call('/api/code', {'email': 'g@example.ru'})
        good = app2.mailer.last_code('g@example.ru')
        wrong = '%06d' % ((int(good) + 1) % 10 ** 6)
        ip = TClient(app2, '198.51.100.7')
        rs = [ip.call('/api/login', {'email': 'g%d@example.ru' % i, 'code': wrong, 'dev': 'd_' + '3' * 16, 'label': 'x'}).obj
              for i in range(31)]
        # без выданного кода ответ — expired, он тоже засчитывается как неверная попытка
        ok(all(x.get('err') != 'slow' for x in rs[:30]) and rs[30].get('err') == 'slow', 'угадывание: 30 в час на IP')
        rs = [TClient(app2, '203.0.113.%d' % (i % 200 + 1)).call(
            '/api/login', {'email': 'n%d@example.ru' % i, 'code': wrong, 'dev': 'd_' + '4' * 16, 'label': 'x'}).obj
            for i in range(101)]
        ok(all(x.get('err') != 'slow' for x in rs[:100]) and rs[100].get('err') == 'slow', 'угадывание: 100 в час на подсеть')
        # коды: 150 в сутки на подсеть (по 10 с IP — меньше лимитов IP)
        app3 = self.app(MAGNAT_MAIL_MIN=1000)        # общий потолок 30 писем в минуту здесь не проверяется
        app3.inflight = threading.BoundedSemaphore(64)
        rs = []
        for i in range(151):
            rs.append(TClient(app3, '203.0.113.%d' % (i // 10 + 1)).call('/api/code', {'email': 's%d@example.ru' % i}).obj)
        ok(all(x.get('ok') for x in rs[:150]) and rs[150].get('err') == 'slow', 'коды: 150 в сутки на подсеть')
        # надгробия удалённых аккаунтов живут 45 дней
        app4 = self.app()
        with app4.store.tx() as c:
            c.execute('INSERT INTO deletions(email_h, at) VALUES(?, ?)', ('old', app4.now() - 46 * DAY))
            c.execute('INSERT INTO deletions(email_h, at) VALUES(?, ?)', ('new', app4.now() - 44 * DAY))
        app4.maintain()
        with app4.store.ro() as c:
            left = sorted(r[0] for r in c.execute('SELECT email_h FROM deletions'))
        ok(left == ['new'], 'надгробия: старше 45 дней чистятся, моложе — живут: %s' % left)

    # ── лимиты: память ограничена, поток новых ключей не обнуляет горячий ──

    def t_limiter_bounded(self):
        L = Limiter()
        L.MAX_KEYS = 500
        hot = L.key('ip', '203.0.113.7')
        for _ in range(3):
            L.hit([(hot, 3, 600)])
        self.ok(L.hit([(hot, 3, 600)]) > 0, 'горячий ключ упёрся в предел')
        for i in range(5000):                         # поток новых адресов
            L.hit([(L.key('ip', '198.51.%d.%d' % (i // 250, i % 250)), 3, 600)])
            if i % 100 == 0:
                L.hit([(hot, 3, 600)], add=False)
                L.add([hot])                          # горячий ключ трогают — он свежий
        self.ok(len(L.d) <= 500 and len(L.w) <= 500, 'ключей не больше предела: %d' % len(L.d))
        self.ok(L.hit([(hot, 3, 600)]) > 0, 'поток новых ключей не снял предел с горячего')
        L2 = Limiter()
        k = L2.key('em', 'a@b.ru')
        L2.hit([(k, 5, 60)], now=1000.0)
        L2.purge(now=1000.0 + 61)
        self.ok(k not in L2.d, 'ключ с окном 60 с вычищен через минуту, а не через сутки')

    # ── адреса, HMAC ──

    def t_email(self):
        ok = self.ok
        ok(norm_email('  Ivan.Petrov@Example.RU ') == ('ivan.petrov@example.ru', None), 'адрес: регистр и пробелы')
        ok(norm_email('a@b.ru\r\nBcc: x@y.ru')[1] == 'bad_email', 'адрес: CRLF')
        ok(norm_email('a@b.ru\n')[0] == 'a@b.ru', 'адрес: перевод строки по краю срезается')
        ok(norm_email('a b@c.ru')[1] == 'bad_email', 'адрес: пробел внутри')
        ok(norm_email('a​@c.ru')[1] == 'bad_email', 'адрес: невидимый символ')
        ok(norm_email('иван@mail.ru')[1] == 'bad_local', 'адрес: кириллица до @')
        ok(norm_email('ivan@пример.рф') == ('ivan@xn--e1afmkfd.xn--p1ai', None), 'адрес: IDNA')
        long = 'a' * 64 + '@' + 'b' * 63 + '.' + 'c' * 63 + '.' + 'd' * 59 + '.ru'
        ok(len(long) == 255 and norm_email(long)[1] == 'bad_email', 'адрес: 255 символов')
        ok(norm_email('a@b')[1] == 'bad_email' and norm_email('a@b.c')[1] == 'bad_email', 'адрес: домен')
        ok(norm_email('a@@b.ru')[1] == 'bad_email' and norm_email(None)[1] == 'bad_email', 'адрес: мусор')
        ok(norm_email('a@b..ru')[1] == 'bad_email', 'адрес: пустая метка домена')

    def t_hmac(self):
        app = self.app()
        e1, e2 = app.email_h('a@b.ru'), app.email_h('a@b.ru')
        ok = self.ok
        ok(e1 == e2 and RE_HEX.fullmatch(e1), 'HMAC адреса стабилен')
        ok(app.code_h('login', 'a@b.ru', '123456') != app.code_h('delete', 'a@b.ru', '123456'), 'HMAC кода зависит от цели')
        other = App(app.cfg, app.store, secrets.token_bytes(32), app.mailer)
        ok(other.email_h('a@b.ru') != e1, 'HMAC зависит от secret.key')
        calls = []
        real = hmac.compare_digest

        def spy(a, b):
            calls.append(1)
            return real(a, b)
        hmac.compare_digest = spy
        try:
            cl = TClient(app)
            cl.call('/api/code', {'email': 'h@example.ru'})
            c6 = app.mailer.last_code('h@example.ru')
            r = cl.call('/api/login', {'email': 'h@example.ru', 'code': c6, 'dev': 'd_' + '0' * 16, 'label': 'x'})
        finally:
            hmac.compare_digest = real
        ok(r.obj.get('ok') and calls, 'код сверяется через hmac.compare_digest')
        ok(r.obj.get('email') == 'h@example.ru' and r.obj.get('head') is None, 'вход: ответ')
        ok('HttpOnly' in cl.last and 'Secure' in cl.last and 'SameSite=Strict' in cl.last and 'Path=/;' in cl.last
           and 'Max-Age=34560000' in cl.last and cl.last.startswith('__Host-mg='), 'cookie: флаги')

    # ── ворота HTTP ──

    def t_gates(self):
        app = self.app()
        cl = TClient(app)
        ok = self.ok
        st = lambda **k: cl.call('/api/me', {}, **k)
        ok(st().status == 200, 'ворота: честный запрос')
        ok(st(hdr={'Origin': 'https://evil.example'}).obj == {'ok': False, 'err': 'origin'}, 'ворота: чужой Origin')
        ok(st(hdr={'Origin': None}).status == 403, 'ворота: нет Origin')
        ok(st(hdr={'Sec-Fetch-Site': 'cross-site'}).status == 403, 'ворота: Sec-Fetch-Site')
        ok(st(hdr={'Content-Type': 'text/plain'}).status == 415, 'ворота: text/plain')
        ok(st(hdr={'Content-Length': None}).status == 411, 'ворота: нет длины')
        ok(st(hdr={'Transfer-Encoding': 'chunked'}).status == 411, 'ворота: chunked')
        ok(cl.call('/api/me', raw=b'{' + b' ' * 3000 + b'}').status == 413, 'ворота: 2 КБ')
        ok(cl.call('/api/sync', raw=b' ' * (SYNC_BODY + 1)).status == 413, 'ворота: 1,5 МБ')
        ok(st(method='GET').status == 405, 'ворота: GET')
        ok(cl.call('/api/nope', {}).status == 404, 'ворота: неизвестный путь')
        ok(PAYMENTS or (cl.call('/api/checkout', {}).status == 404 and
                        cl.call('/api/platega/callback', {}).status == 404), 'Платега: маршрутов ещё нет')
        ok(cl.call('/api/me', raw=b'[]').status == 400 and cl.call('/api/me', raw=b'{"a":1,"a":2}').status == 400
           and cl.call('/api/me', raw=b'{"a":NaN}').status == 400, 'ворота: строгий JSON')
        for _ in range(16):
            app.inflight.acquire()
        ok(st().obj == {'ok': False, 'err': 'busy'} and st().status == 503, 'ворота: 16 в работе — 503 busy')
        ok(app.health('GET', mkheaders({}), '127.0.0.1').status == 200, 'ворота: health не ждёт очереди')
        for _ in range(16):
            app.inflight.release()
        h = app.health('GET', mkheaders({}), '127.0.0.1')
        ok(h.status == 200 and h.obj['db'] and h.obj['schema'] == SCHEMA, 'health: локально подробно')
        ok(app.health('GET', mkheaders({'X-Forwarded-For': '1.2.3.4'}), '127.0.0.1').status == 404,
           'health: через Caddy — 404')

    def t_closed(self):
        app = self.app(MAGNAT_OPEN='0')
        cl = TClient(app)
        ok = self.ok
        ok(cl.call('/api/code', {'email': 'stranger@example.ru'}).obj.get('err') == 'closed', 'закрыто: чужой адрес')
        ok(not app.mailer.sent, 'закрыто: письма нет')
        with app.store.ro() as c:
            ok(c.execute('SELECT COUNT(*) FROM codes').fetchone()[0] == 0, 'закрыто: ничего не хранится')
        ok(cl.call('/api/code', {'email': 'Support@Example.RU'}).obj.get('ok'), 'закрыто: ящик поддержки можно')
        ok(cl.call('/api/code', {'email': 'box@example.ru'}).obj.get('ok'), 'закрыто: ящик кодов можно')
        app.mailer.c = None
        ok(cl.call('/api/code', {'email': 'box@example.ru'}).obj.get('err') == 'closed', 'закрыто: без почты — closed')
        app2 = self.app()
        app2.mailer.c = None
        ok(TClient(app2).call('/api/code', {'email': 'x@example.ru'}).obj.get('err') == 'mail_off', 'почта не настроена')
        app2.mailer.c = dict(FakeMailer.CONF)
        open(os.path.join(app2.cfg.state, 'mail.off'), 'w').close()
        ok(TClient(app2).call('/api/code', {'email': 'x@example.ru'}).obj.get('err') == 'paused', 'пауза почты')

    # ── коды: атомарность, резерв, лимиты ──

    def t_attempts(self):
        app = self.app()
        app.inflight = threading.BoundedSemaphore(64)   # здесь проверяется БД, а не потолок запросов
        em = 'race@example.ru'
        TClient(app).call('/api/code', {'email': em})
        good = app.mailer.last_code(em)
        wrong = '%06d' % ((int(good) + 1) % 10 ** 6)
        res = []

        def guess(i):
            r = TClient(app, '198.51.100.%d' % (i % 250 + 1)).call(
                '/api/login', {'email': em, 'code': wrong, 'dev': 'd_' + '1' * 16, 'label': 'x'})
            res.append(r.obj.get('err'))
        ts = [threading.Thread(target=guess, args=(i,)) for i in range(50)]
        for t in ts:
            t.start()
        for t in ts:
            t.join()
        with app.store.ro() as c:
            tries, state = c.execute('SELECT tries, state FROM codes').fetchone()
        self.ok(tries == 5 and res.count('code') == 5 and res.count('tries_over') == 45 and state == BURNED,
                'попытки: из 50 потоков засчитано ровно 5')
        r = TClient(app, '203.0.113.9').call('/api/login', {'email': em, 'code': good, 'dev': 'd_' + '1' * 16,
                                                            'label': 'x'})
        self.ok(r.obj.get('err') == 'tries_over', 'попытки: потом даже верный — tries_over')

    def t_codes(self):
        app = self.app(MAGNAT_CODE_GAP=60)
        ok = self.ok
        cl = TClient(app)
        em = 'c@example.ru'
        ok(cl.call('/api/code', {'email': em}).obj == {'ok': True, 'ttl': 900, 'resend': 60}, 'код: ответ')
        r = cl.call('/api/code', {'email': em}).obj
        ok(r.get('err') == 'wait' and 0 < r.get('retryIn', 0) <= 60, 'код: пауза 60 с')
        first = app.mailer.last_code(em)
        app.cfg.now_shift += 61
        cl.call('/api/code', {'email': em})
        second = app.mailer.last_code(em)
        lg = lambda c6, **k: cl.call('/api/login', {'email': em, 'code': c6, 'dev': 'd_' + '2' * 16, 'label': 'x'},
                                     **k).obj
        if first != second:
            r = lg(first)
            ok(r.get('err') == 'replaced' and r.get('left') == 4, 'код: старый — replaced')
        wrong = '%06d' % ((int(second) + 7) % 10 ** 6)
        if wrong == first:
            wrong = '%06d' % ((int(second) + 8) % 10 ** 6)
        r = lg(wrong)
        ok(r.get('err') == 'code' and r.get('left') in (3, 4), 'код: неверный, left убывает')
        ok(lg('12345').get('err') == 'code' and lg('12a456').get('err') == 'code', 'код: не 6 цифр')
        ok(lg(second).get('ok'), 'код: верный')
        ok(lg(second).get('err') == 'expired', 'код: повтор — expired')
        app.cfg.now_shift += 61
        cl.call('/api/code', {'email': em})
        c3 = app.mailer.last_code(em)
        app.cfg.now_shift += 901
        ok(lg(c3).get('err') == 'expired', 'код: истёк')
        # лимиты по адресу: 5 в час
        app.cfg.code_gap = 0
        em2 = 'h5@example.ru'
        rs = [TClient(app, '192.0.2.%d' % (i + 50)).call('/api/code', {'email': em2}).obj for i in range(6)]
        ok(all(x.get('ok') for x in rs[:5]) and rs[5].get('err') == 'slow' and rs[5].get('retryIn', 0) > 0,
           'код: 5 в час на адрес')
        # IP: 10 за 10 минут
        cl2 = TClient(app, '203.0.113.77')
        rs = [cl2.call('/api/code', {'email': 'ip%d@example.ru' % i}).obj for i in range(11)]
        ok(all(x.get('ok') for x in rs[:10]) and rs[10].get('err') == 'slow', 'код: 10 за 10 мин на IP')
        r = cl2.call('/api/code', {'email': 'ipx@example.ru'}, hdr={'X-Forwarded-For': '1.1.1.1, 203.0.113.77'}).obj
        ok(r.get('err') == 'slow', 'код: подделка XFF не обходит лимит')
        ok(TClient(app, '2001:db8:1:2::1').call('/api/code', {'email': 'v6@example.ru'}).obj.get('ok'), 'код: IPv6')

    def t_locked(self):
        app = self.app()
        em = 'lock@example.ru'
        bad = 0
        for k in range(3):
            TClient(app, '192.0.2.%d' % (k + 1)).call('/api/code', {'email': em})
            good = app.mailer.last_code(em)
            for i in range(5):
                w = '%06d' % ((int(good) + 1 + i) % 10 ** 6)
                r = TClient(app, '198.51.100.%d' % (k * 10 + i)).call(
                    '/api/login', {'email': em, 'code': w, 'dev': 'd_' + '3' * 16, 'label': 'x'}).obj
                bad += r.get('err') in ('code', 'tries_over')
        TClient(app, '192.0.2.99').call('/api/code', {'email': em})
        r = TClient(app, '198.51.100.200').call('/api/login', {'email': em, 'code': app.mailer.last_code(em),
                                                                'dev': 'd_' + '3' * 16, 'label': 'x'}).obj
        self.ok(bad == 15 and r.get('err') == 'locked' and r.get('retryIn', 0) > 0, 'вход: 15 неверных — locked')

    def t_reserve(self):
        app = self.app()
        app.mailer.fail = smtplib.SMTPAuthenticationError(535, b'no')
        cl = TClient(app)
        em = 'rsv@example.ru'
        old, buf = sys.stderr, io.StringIO()
        sys.stderr = buf
        try:
            r = cl.call('/api/code', {'email': em}).obj
        finally:
            sys.stderr = old
        self.ok(buf.getvalue() == 'smtp error SMTPAuthenticationError\n', 'журнал: только класс ошибки почты')
        with app.store.ro() as c:
            cnt = dict(c.execute('SELECT k, n FROM mail_count').fetchall())
            st = c.execute('SELECT state FROM codes').fetchall()
            me = c.execute("SELECT v FROM meta WHERE k='mail_err'").fetchone()
        ok = self.ok
        ok(r.get('err') == 'mail_fail', 'резерв: сбой SMTP — mail_fail')
        ok(sorted(cnt.values()) == [1, 1], 'резерв: счётчики писем увеличены и остались')
        ok(st == [(BURNED,)] and me and me[0].endswith('SMTPAuthenticationError'), 'резерв: код мёртв, mail_err записан')
        app.mailer.fail = None
        app.cfg.mail_day = 1
        r = cl.call('/api/code', {'email': 'cap@example.ru'}).obj
        ok(r.get('err') == 'mail_cap', 'резерв: дневной потолок писем')
        app.cfg.mail_day, app.cfg.mail_min = 300, 1
        r = cl.call('/api/code', {'email': 'cap2@example.ru'}).obj
        ok(r.get('err') == 'busy' and r.get('retryIn') == 60, 'резерв: потолок в минуту')

    # ── синхронизация ──

    def t_sync(self):
        app = self.app()
        ok = self.ok
        a = self.login(app, 's@example.ru')
        ok(self.pull(a, None) == {'ok': True, 'st': 'empty', 'seqMax': 0}, 'sync: пусто')
        d1 = tdoc(3)
        r = self.push(a, d1, None, 'first')
        ok(r.get('st') == 'ok' and r['head']['rev'] == 1 and r['head']['sum']['d'] == 3, 'sync: первая ревизия')
        h1 = r['head']['rid']
        ok(self.pull(a, h1).get('st') == 'same', 'sync: same')
        r = self.push(a, d1, h1)
        ok(r.get('st') == 'same', 'sync: тот же документ — same')
        d2 = tdoc(4)
        r = self.push(a, d2, h1)
        ok(r.get('st') == 'ok' and r['head']['rev'] == 2, 'sync: CAS принят')
        h2, s2 = r['head']['rid'], a.seq
        r = self.pull(a, h1)
        ok(r.get('st') == 'pull' and r['doc'] == d2 and r['known'] is True and r['parked'] is None, 'sync: pull')
        # потерянный ответ: тот же seq, outHash = отправленный
        d2b = tdoc(5)
        r = self.push(a, d2b, h1, seq=s2, outh=sha256h(d2.encode()))
        ok(r.get('st') == 'dup' and r['mine'] == {'rid': h2, 'rev': 2} and r['doc'] == d2, 'sync: dup')
        r = self.push(a, d2, h1, seq=s2)
        ok(r.get('st') == 'dup', 'sync: dup по hash')
        # CAS отклонён: база устарела → отложено
        d3 = tdoc(6)
        r = self.push(a, d3, h1)
        ok(r.get('st') == 'pull' and r['parked'] and r['known'] and r['seqMax'] == a.seq, 'sync: CAS отклонён, отложено')
        p3, s3 = r['parked'], a.seq
        r = self.push(a, d3, h1, seq=s3)
        ok(r.get('st') == 'pull' and r['parked'] == p3, 'sync: повтор отложенного не плодит копий')
        # отложенный повтор с правильной базой — принимается как обычный
        r = self.push(a, d3, h2, seq=s3)
        ok(r.get('st') == 'ok' and r['head']['rev'] == 3, 'sync: отложенный повтор принят')
        h3 = r['head']['rid']
        # повтор seq с другим документом
        r = self.push(a, tdoc(7), h3, seq=s2)
        ok(r.get('st') == 'pull' and r['known'] is False and r['parked'], 'sync: seq использован повторно')
        r = self.push(a, tdoc(8), h3, seq=2)
        ok(r.get('st') == 'pull' and r['known'] is False, 'sync: seq ≤ seqMax без совпадений')
        r = self.push(a, tdoc(9), 'r_' + 'f' * 16)
        ok(r.get('st') == 'pull' and r['known'] is False and r['parked'], 'sync: неизвестная база')
        with app.store.ro() as c:
            n = c.execute("SELECT COUNT(*) FROM revisions WHERE kind='push'").fetchone()[0]
            sm = c.execute('SELECT MAX(seq) FROM revisions').fetchone()[0]
        ok(n == 3 and sm == a.seq, 'sync: ровно три ревизии, seqMax')
        ok(self.pull(a, h3, sv=0).get('err') == 'old_app' and self.push(a, tdoc(2), h3, sv=0).get('err') == 'old_app',
           'sync: old_app и для pull')
        b = self.login(app, 'other@example.ru')
        bad = {'pv': 1, 'acct': b.acct, 'dev': a.dev, 'sv': 1, 'base': None, 'seq': None, 'hash': None,
               'outHash': None, 'doc': None, 'reason': 'edit'}
        ok(a.call('/api/sync', bad).obj.get('err') == 'acct', 'sync: чужой acct')
        bad['acct'] = a.acct
        bad['dev'] = 'd_' + 'e' * 16
        ok(a.call('/api/sync', bad).obj.get('err') == 'acct', 'sync: чужой dev')
        # IDOR
        ok(b.call('/api/version', {'rid': h3}).obj.get('err') == 'gone', 'IDOR: чужая версия')
        ok(all(x['rid'] != h3 for x in b.call('/api/versions', {}).obj['list']), 'IDOR: чужой список')
        sid_a = [x['sid'] for x in a.call('/api/sessions', {}).obj['list'] if x['me']][0]
        b.call('/api/logout', {'sid': sid_a})
        ok(a.call('/api/me', {}).obj.get('auth') is True, 'IDOR: чужую сессию не выйти')
        vs = a.call('/api/versions', {}).obj['list']
        ok(h3 in [x['rid'] for x in vs] and [x['at'] for x in vs] == sorted((x['at'] for x in vs), reverse=True)
           and all(set(x) == {'rid', 'rev', 'at', 'kind', 'reason', 'label', 'sum', 'pin'} for x in vs)
           and vs[0]['kind'] == 'parked', 'versions: свои, новые сверху, с отложенными')
        ok(a.call('/api/version', {'rid': h3}).obj.get('doc') == d3, 'version: документ')

    def t_doccheck(self):
        app = self.app(MAGNAT_DOC_MAX=4000)
        a = self.login(app, 'doc@example.ru')
        ok = self.ok
        ok(self.push(a, tdoc(1, extra={'demoData': True}), None).get('err') == 'demo', 'документ: demoData')
        ok(self.push(a, tdoc(1, extra={'body': {}}), None).get('err') == 'body', 'документ: body')
        ok(self.push(a, tdoc(1, extra={'_sync': 1}), None).get('err') == 'bad_doc', 'документ: ключ')
        ok(self.push(a, jdump({'habits': {}, 'checks': {}}), None).get('err') == 'bad_doc', 'документ: habits')
        ok(self.push(a, jdump({'habits': [], 'checks': []}), None).get('err') == 'bad_doc', 'документ: checks')
        ok(self.push(a, jdump({'habits': [], 'checks': {}, **{'k%d' % i: 1 for i in range(63)}}), None).get(
            'err') == 'bad_doc', 'документ: больше 64 ключей')
        ok(self.push(a, '[1]', None).get('err') == 'bad_doc', 'документ: не объект')
        ok(self.push(a, tdoc(1, extra={'pad': 'x' * 5000}), None).get('err') == 'big', 'документ: DOC_MAX')
        d = tdoc(1)
        r = a.call('/api/sync', {'pv': 1, 'acct': a.acct, 'dev': a.dev, 'sv': 1, 'base': None, 'seq': 1,
                                 'hash': '0' * 64, 'outHash': None, 'doc': d, 'reason': 'first'}).obj
        ok(r.get('err') == 'hash', 'документ: hash')
        ok(self.push(a, tdoc(1, extra={'newKey': [1, 2]}), None).get('st') == 'ok', 'документ: неизвестный ключ можно')

    def t_pin(self):
        app = self.app()
        a = self.login(app, 'pin@example.ru')
        ok = self.ok
        h = self.push(a, tdoc(20), None, 'first')['head']['rid']
        r = self.push(a, tdoc(5), h)
        with app.store.ro() as c:
            pin = c.execute('SELECT pin_until FROM revisions WHERE rid=?', (h,)).fetchone()[0]
        ok(r.get('st') == 'ok' and pin and pin > app.now() + 80 * DAY, 'закрепление: сжатие дней')
        h2 = r['head']['rid']
        r = self.push(a, tdoc(6), h2)
        with app.store.ro() as c:
            pin = c.execute('SELECT pin_until FROM revisions WHERE rid=?', (h2,)).fetchone()[0]
        ok(pin is None, 'закрепление: обычная правка не закрепляет')
        h3 = r['head']['rid']
        for reason in ('join', 'reset', 'restore'):
            r = self.push(a, tdoc(7 + len(reason)), h3, reason)
            with app.store.ro() as c:
                pin = c.execute('SELECT pin_until FROM revisions WHERE rid=?', (h3,)).fetchone()[0]
            ok(pin and pin > app.now(), 'закрепление: ' + reason)
            h3 = r['head']['rid']
        vs = a.call('/api/versions', {}).obj['list']
        ok(any(x['pin'] for x in vs), 'versions: pin виден')

    def t_checkpoints(self):
        app = self.app()
        a = self.login(app, 'cp@example.ru')
        b = TClient(app)
        r = b.call('/api/code', {'email': 'cp@example.ru'})
        dev_b = 'd_' + 'b' * 16
        r = b.call('/api/login', {'email': 'cp@example.ru', 'code': app.mailer.last_code('cp@example.ru'),
                                  'dev': dev_b, 'label': 'B'})
        b.acct, b.dev, b.seq = r.obj['acct'], dev_b, 0
        r1 = self.push(a, tdoc(1), None, 'first')['head']['rid']
        r2 = self.push(a, tdoc(2), r1)['head']['rid']
        r3 = self.push(a, tdoc(3), r2)['head']['rid']
        r4 = self.push(b, tdoc(4), r3)['head']['rid']
        app.cfg.now_shift += 2 * 3600
        r5 = self.push(b, tdoc(5), r4)['head']['rid']
        with app.store.ro() as c:
            got = {rid: (keep, blob) for rid, keep, blob in
                   c.execute('SELECT rid, keep, blob IS NOT NULL FROM revisions').fetchall()}
            ab = c.execute('SELECT bytes FROM accounts').fetchone()[0]
            real = c.execute('SELECT SUM(LENGTH(blob)) FROM revisions').fetchone()[0]
        self.ok(got[r1] == ('cp', 1) and got[r2] == ('', 0) and got[r3] == ('cp', 1) and got[r4] == ('cp', 1)
                and got[r5] == ('', 1), 'контрольные точки: другое устройство, час, без лишних блобов')
        self.ok(ab == real, 'accounts.bytes верен')

    def t_retention(self):
        app = self.app(MAGNAT_NOW_SHIFT=40 * DAY)
        a = self.login(app, 'ret@example.ru')
        N = app.now()
        blob = zlib.compress(b'{}', 6)
        D = day_start(N) - 5 * DAY
        rows = {'h': (N - 40 * DAY, None), 's': (N - 35 * DAY, None), 'p': (N - 50 * DAY, N + DAY),
                'p2': (N - 50 * DAY, N - 1), 'a1': (N - 3600, None), 'a2': (N - 47 * 3600, None),
                'd1': (D + 3600, None), 'd2': (D + 7200, None), 'e1': (N - 29 * DAY, None),
                'f1': (N - 31 * DAY, None), 'k1': (N - 10 * DAY, None), 'z': (N - 40 * DAY + 5, None),
                'b1': (day_start(N - 2 * DAY) + 1, None), 'b2': (day_start(N - 2 * DAY) + 2, None)}
        ids = {}
        with app.store.tx() as c:
            for i, (k, (at, pin)) in enumerate(sorted(rows.items())):
                ids[k] = 'r_%016x' % (i + 1)
                c.execute('INSERT INTO revisions(rid, account_id, rev, parent, kind, reason, dev, seq, sv, at, hash, '
                          'size, sum, label, keep, pin_until, blob) VALUES(?, ?, ?, NULL, ?, ?, ?, ?, 1, ?, ?, 2, ?, ?, '
                          '?, ?, ?)', (ids[k], a.acct, i + 1, 'parked' if k == 'k1' else 'push', 'edit', a.dev,
                                       i + 1, at, '0' * 64, '{}', 'x', 'cp', pin, blob))
            for k, at in (('old', N - 200 * DAY), ('old2', N - 100 * DAY)):
                ids[k] = 'r_%016x' % (len(ids) + 1)
                c.execute('INSERT INTO revisions(rid, account_id, rev, parent, kind, reason, dev, seq, sv, at, hash, '
                          'size, sum, label, keep, pin_until, blob) VALUES(?, ?, 0, NULL, ?, ?, ?, ?, 1, ?, ?, 2, ?, ?, '
                          "'', NULL, NULL)", (ids[k], a.acct, 'push', 'edit', a.dev, 100 + len(ids), at, '0' * 64,
                                              '{}', 'x'))
            c.execute('UPDATE accounts SET head_rid=? WHERE id=?', (ids['h'], a.acct))
            c.execute('UPDATE sessions SET last_rid=? WHERE account_id=?', (ids['s'], a.acct))
            c.execute('INSERT INTO sessions(token_h, sid, account_id, dev, label, created, renewed, seen, expires, '
                      "last_rid) VALUES('t', 's_000000000000', ?, ?, 'x', 0, 0, ?, ?, ?)",
                      (a.acct, a.dev, day(N), N - 10, ids['z']))
        app.maintain()
        with app.store.ro() as c:
            got = dict(c.execute('SELECT rid, blob IS NOT NULL FROM revisions').fetchall())
            ab = c.execute('SELECT bytes FROM accounts WHERE id=?', (a.acct,)).fetchone()[0]
        inv = {v: k for k, v in ids.items()}
        alive = sorted(inv[r] for r, b in got.items() if b)
        bare = sorted(inv[r] for r, b in got.items() if not b)
        self.ok(alive == sorted(['h', 's', 'p', 'a1', 'a2', 'd2', 'e1', 'k1', 'b2']), 'хранение: блобы ровно по правилу %s' % alive)
        self.ok(bare == sorted(['p2', 'd1', 'f1', 'z', 'old2', 'b1']), 'хранение: строки без блоба %s' % bare)
        self.ok(ab == len(blob) * 9, 'хранение: bytes пересчитан')

    def t_quota(self):
        app = self.app()
        a = self.login(app, 'q@example.ru')
        ok = self.ok
        h = self.push(a, tdoc(1), None, 'first')['head']['rid']
        app.cfg.push_day = 1
        r = self.push(a, tdoc(2), h)
        ok(r.get('err') == 'slow' and r.get('retryIn', 0) > 0, 'квота: push в день')
        app.cfg.push_day = 500
        app.cfg.disk_min_mb = 10 ** 9
        ok(self.push(a, tdoc(2), h).get('err') == 'disk', 'квота: диск')
        app.cfg.disk_min_mb = 0
        with app.store.ro() as c:
            ab = c.execute('SELECT bytes FROM accounts').fetchone()[0]
        app.cfg.acct_bytes = ab + 10
        ok(self.push(a, tdoc(30), h).get('err') == 'quota', 'квота: 20 МБ на аккаунт')
        # прореживание освобождает место: старая контрольная точка уходит
        app.cfg.acct_bytes = 10 ** 9
        h2 = self.push(a, tdoc(3), h)['head']['rid']
        app.cfg.now_shift += 40 * DAY
        with app.store.ro() as c:
            ab = c.execute('SELECT bytes FROM accounts').fetchone()[0]
            hb = c.execute('SELECT LENGTH(blob) FROM revisions WHERE rid=?', (h2,)).fetchone()[0]
        nd = tdoc(4)
        app.cfg.acct_bytes = hb + len(zlib.compress(nd.encode(), 6)) + 1
        ok(ab > hb and self.push(a, nd, h2).get('st') == 'ok', 'квота: проредить и принять')
        app.cfg.acct_bytes = 10 ** 9
        app.cfg.park_day = 1
        h3 = self.pull(a, None)['head']['rid']
        r1 = self.push(a, tdoc(11), h)
        r2 = self.push(a, tdoc(12), h)
        ok(r1.get('st') == 'pull' and r1['parked'] and r2.get('st') == 'pull' and r2['parked'] is None
           and r2['head']['rid'] == h3, 'квота: лимит откладываний — pull без parked')

    # ── схема ──

    def t_migrations(self):
        app = self.app()
        with app.store.ro() as c:
            names = {r[0] for r in c.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()}
            av = c.execute('PRAGMA auto_vacuum').fetchone()[0]
            jm = c.execute('PRAGMA journal_mode').fetchone()[0]
            sd = c.execute('PRAGMA secure_delete').fetchone()[0]
            fk = c.execute('PRAGMA foreign_keys').fetchone()[0]
        self.ok({'meta', 'accounts', 'sessions', 'revisions', 'codes', 'mail_count', 'deletions', 'stats'} <= names
                and app.store.schema == SCHEMA, 'миграции на пустой БД')
        self.ok(av == 2 and jm == 'wal' and sd == 1 and fk == 1, 'PRAGMA: auto_vacuum, WAL, secure_delete, FK')
        self.ok(migrations_clean(), 'в MIGRATIONS нет DROP/RENAME')
        bad = re.compile(r'\b(DROP|RENAME)\b', re.I)
        self.ok(bad.search('ALTER TABLE x DROP COLUMN y') and bad.search('ALTER TABLE x RENAME TO y'),
                'проверка миграций ловит DROP/RENAME')

    def t_future_schema(self):
        app = self.app()
        path = app.cfg.db
        with app.store.tx() as c:
            c.execute("UPDATE meta SET v='99' WHERE k='schema'")
            for t in ('accounts', 'sessions', 'revisions', 'codes'):
                c.execute('ALTER TABLE %s ADD COLUMN extra_future TEXT' % t)
        app.store.close()
        st = Store(path)
        app2 = App(app.cfg, st, app.key, app.mailer)
        a = self.login(app2, 'future@example.ru')
        r = self.push(a, tdoc(2), None, 'first')
        h = app2.health('GET', mkheaders({}), '127.0.0.1')
        self.ok(st.schema == 99 and r.get('st') == 'ok' and h.status == 200 and h.obj['schema'] == 99,
                'БД со schema=99 и лишней колонкой работает')
        self.ok(a.call('/api/versions', {}).obj.get('ok') and app2.maintain() is not None, 'и versions, и maintain')

    # ── выход, удаление, надгробия ──

    def t_logout(self):
        app = self.app()
        ok = self.ok
        a = self.login(app, 'out@example.ru')
        b = self.login(app, 'out@example.ru')
        c3 = self.login(app, 'out@example.ru')
        ls = a.call('/api/sessions', {}).obj['list']
        ok(len(ls) == 3 and sum(x['me'] for x in ls) == 1, 'sessions: список')
        sid_b = [x['sid'] for x in b.call('/api/sessions', {}).obj['list'] if x['me']][0]
        a.call('/api/logout', {'sid': sid_b})
        ok(b.call('/api/me', {}).obj == {'ok': True, 'auth': False} and a.tok, 'logout: одно устройство')
        a.call('/api/logout', {'all': True})
        ok(c3.call('/api/me', {}).obj.get('auth') is False and a.call('/api/me', {}).obj.get('auth'),
           'logout: все другие')
        old = a.tok
        r = a.call('/api/logout', {})
        ok(r.obj == {'ok': True} and a.tok is None and 'Max-Age=0' in a.last, 'logout: текущая, cookie очищена')
        a.tok = old
        ok(a.call('/api/me', {}).obj.get('auth') is False, 'logout: старая cookie — без входа')
        ok(TClient(app).call('/api/logout', {}).obj == {'ok': True}, 'logout: без сессии')
        many = []
        for i in range(12):
            app.cfg.now_shift += DAY + 3600
            many.append(self.login(app, 'many@example.ru', ip='192.0.2.%d' % (100 + i)))
        with app.store.ro() as c:
            n = c.execute('SELECT COUNT(*) FROM sessions s JOIN accounts a ON a.id=s.account_id '
                          "WHERE a.email='many@example.ru'").fetchone()[0]
        ok(n == MAX_SESSIONS and many[-1].call('/api/me', {}).obj['auth'], 'не больше 10 сессий')

    def t_renew(self):
        app = self.app()
        a = self.login(app, 'renew@example.ru')
        a.last = None
        a.call('/api/me', {})
        self.ok(a.last is None, 'продление: свежая сессия cookie не трогает')
        app.cfg.now_shift += 8 * DAY
        a.call('/api/me', {})
        self.ok(a.last is not None and 'Max-Age=' in a.last, 'продление: через 7 дней cookie заново')
        app.cfg.now_shift += 181 * DAY
        self.ok(a.call('/api/me', {}).obj.get('auth') is False, 'сессия: 180 дней простоя')

    def t_delete(self):
        app = self.app()
        ok = self.ok
        a = self.login(app, 'del@example.ru')
        keep = self.login(app, 'keep@example.ru')
        self.push(a, tdoc(3), None, 'first')
        snap = os.path.join(app.cfg.state, 'snap.db')
        ok(sqlite_copy(app.cfg.db, snap) == 'ok', 'бэкап: integrity ok')
        ok(TClient(app).call('/api/code', {'purpose': 'delete'}).obj.get('err') == 'auth', 'удаление: код без сессии')
        ok(a.call('/api/code', {'purpose': 'delete'}).obj.get('ok'), 'удаление: код по сессии')
        c6 = app.mailer.last_code('del@example.ru')
        ok('удаления' in str(app.mailer.sent[-1]['Subject']), 'удаление: своё письмо')
        r = a.call('/api/login', {'email': 'del@example.ru', 'code': c6, 'dev': a.dev, 'label': 'x'}).obj
        ok(r.get('err') == 'expired', 'удаление: код удаления не входит')
        ok(a.call('/api/delete', {'code': '000000' if c6 != '000000' else '111111'}).obj.get('err') == 'code',
           'удаление: неверный код')
        r = a.call('/api/delete', {'code': c6})
        ok(r.obj == {'ok': True} and a.tok is None, 'удаление: успех, cookie очищена')
        eh = app.email_h('del@example.ru')
        with app.store.ro() as c:
            left = [c.execute(q, (v,)).fetchone()[0] for q, v in (
                ('SELECT COUNT(*) FROM accounts WHERE id=?', a.acct),
                ('SELECT COUNT(*) FROM revisions WHERE account_id=?', a.acct),
                ('SELECT COUNT(*) FROM sessions WHERE account_id=?', a.acct),
                ('SELECT COUNT(*) FROM codes WHERE email_h=?', eh))]
            tomb = c.execute('SELECT COUNT(*) FROM deletions WHERE email_h=?', (eh,)).fetchone()[0]
        ok(left == [0, 0, 0, 0] and tomb == 1, 'удаление: каскад и надгробие в таблице')
        with open(os.path.join(app.cfg.state, 'deletions.log')) as f:
            lines = f.read().split('\n')
        ok(len(lines) == 2 and lines[0].endswith('\t' + eh) and 'del@' not in lines[0], 'удаление: строка в deletions.log')
        # восстановление старой копии: надгробие применяется, все сессии удаляются
        st = Store(snap)
        app2 = App(app.cfg, st, app.key, app.mailer)
        with st.ro() as c:
            had = c.execute('SELECT COUNT(*) FROM accounts').fetchone()[0]
        app2.cfg = app.cfg
        gone, n = app2.replay()
        with st.ro() as c:
            now_n = c.execute('SELECT COUNT(*) FROM accounts').fetchone()[0]
            ns = c.execute('SELECT COUNT(*) FROM sessions').fetchone()[0]
        ok(had == 2 and gone == 1 and now_n == 1 and ns == 0 and n == 1, 'replay: надгробие и ВСЕ сессии')
        ok(keep.call('/api/me', {}).obj.get('auth') is True, 'replay: живая БД не тронута')
        with st.tx() as c:
            c.execute("INSERT INTO accounts(id, email, created, seen) VALUES('a_0000000000000001', 'del@example.ru', ?, ?)",
                      (app.now() + 10, day(app.now())))
        ok(app2.replay()[0] == 0, 'replay: аккаунт, созданный после удаления, остаётся')
        st.close()

    # ── приватность ──

    def t_privacy(self):
        app = self.app()
        em, ip = 'priv@example.ru', '203.0.113.200'
        a = self.login(app, em, ip=ip)
        self.push(a, tdoc(2), None, 'first')
        TClient(app, ip).call('/api/code', {'email': 'unconfirmed@example.ru'})
        app.cleanup()
        st = app.stats()
        blob = jdump(st)
        ok = self.ok
        ok('@' not in blob and ip not in blob and a.tok not in blob and a.acct not in blob, 'stats: без персональных данных')
        with app.store.ro() as c:
            keys = [r[0] for r in c.execute('SELECT k FROM stats').fetchall()]
        ok(keys and all(re.fullmatch(r'[0-9]{4}-[0-9]{2}:[a-z_]+', k) for k in keys), 'stats: ключи без данных')
        with open(app.cfg.db, 'rb') as f:
            raw = f.read()
        if os.path.exists(app.cfg.db + '-wal'):
            with open(app.cfg.db + '-wal', 'rb') as f:
                raw += f.read()
        ok(ip.encode() not in raw and b'192.0.2.10' not in raw, 'БД: нет IP')
        ok(b'unconfirmed@' not in raw and a.tok.encode() not in raw, 'БД: нет токена и неподтверждённого адреса')
        # сбой обработчика: в журнал — одна строка без данных
        code = app.mailer.last_code(em)
        secret_bits = (ip, em, code, a.tok)
        old = sys.stderr
        buf = io.StringIO()
        sys.stderr = buf
        try:
            srv = Server(('127.0.0.1', 0), app, bind=False)
            try:
                raise ValueError(' '.join(secret_bits))
            except ValueError:
                srv.handle_error(None, (ip, 5555))
            srv.socket.close()
            saved = app.routes['/api/me']

            def boom(ctx, b):
                raise KeyError(' '.join(secret_bits))
            app.routes['/api/me'] = (boom, SMALL_BODY, 'json')
            try:
                r = TClient(app, ip).call('/api/me', {})
            except KeyError:
                log_exc(*sys.exc_info()[::2])
                r = None
            finally:
                app.routes['/api/me'] = saved
            install_hooks()
            t = threading.Thread(target=lambda: (_ for _ in ()).throw(RuntimeError(' '.join(secret_bits))))
            t.start()
            t.join()
        finally:
            sys.stderr = old
            sys.excepthook = sys.__excepthook__
            threading.excepthook = threading.__excepthook__
        lines = buf.getvalue().splitlines()
        ok(len(lines) == 3 and all(re.fullmatch(r'err [A-Za-z]+ api\.py:[0-9]+', x) for x in lines),
           'журнал: сбой — одна строка «err Класс api.py:N» %r' % lines[:3])
        ok(not any(s and s in buf.getvalue() for s in secret_bits), 'журнал: нет IP, почты, кода и токена')
        ok(r is None, 'обработчик: исключение уходит наверх (HTTP-слой отвечает 500)')


def cmd_selftest(pos, opts):
    t = SelfTest()
    t0 = time.monotonic()
    good = t.run()
    if good:
        out('selftest ok (%d проверок, %.1f с)' % (t.n, time.monotonic() - t0))
        return 0
    for b in t.bad:
        out('selftest FAIL: ' + b)
    out('selftest failed (%d из %d)' % (len(t.bad), t.n))
    return 1


COMMANDS = {'serve': cmd_serve, 'check': cmd_check, 'selftest': cmd_selftest, 'backup': cmd_backup,
            'verify': cmd_verify, 'maintain': cmd_maintain, 'replay': cmd_replay, 'stats': cmd_stats,
            'mailtest': cmd_mailtest, 'alert': cmd_alert, 'user': cmd_user}


def main(argv):
    cmd = argv[0] if argv else 'serve'
    fn = COMMANDS.get(cmd)
    if fn is None:
        out('команды: ' + ', '.join(sorted(COMMANDS)))
        return 2
    try:
        pos, opts = parse_args(argv[1:])
    except ValueError as e:
        out('ошибка: %s' % e)
        return 2
    try:
        return fn(pos, opts)
    except ValueError as e:
        out('ошибка: %s' % e)
        return 2
    except RuntimeError as e:
        out('ошибка: %s' % e)
        return 1
    except (sqlite3.Error, OSError) as e:
        out('ошибка: %s' % type(e).__name__)
        return 1


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
