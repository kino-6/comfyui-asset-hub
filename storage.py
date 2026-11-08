import base64
import hashlib
import io
import json
import os
from pathlib import Path
import shutil
import sqlite3
from contextlib import closing
from functools import wraps
import struct
import threading
import time
import uuid
import zlib

from PIL import Image, __version__ as pillow_version, features

if __package__:
    from . import native_webp
    from .work_progress import report
    from .record_codec import dumps as record_dumps, loads as record_loads
    from .database_migration import prepare_database, FORMAT
else:
    import native_webp
    from work_progress import report
    from record_codec import dumps as record_dumps, loads as record_loads
    from database_migration import prepare_database, FORMAT


def digest(path):
    with open(path, 'rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def file_stamp(path):
    stat = path.stat()
    return [stat.st_dev, stat.st_ino, stat.st_size, stat.st_mtime_ns, stat.st_ctime_ns]


def png_chunks(data):
    if data[:8] != b'\x89PNG\r\n\x1a\n':
        raise ValueError('PNGではありません。')
    pos = 8
    chunks = []
    while pos + 12 <= len(data):
        length = int.from_bytes(data[pos:pos + 4], 'big')
        chunk = data[pos:pos + length + 12]
        if len(chunk) != length + 12 or zlib.crc32(chunk[4:-4]) != int.from_bytes(chunk[-4:], 'big'):
            raise ValueError('PNGの整合性を確認できません。')
        chunks.append((chunk[4:8], chunk))
        pos += len(chunk)
        if chunk[4:8] == b'IEND':
            if pos != len(data):
                raise ValueError('PNG末尾に追加データがあります。原本を保持してください。')
            return chunks
    raise ValueError('PNGが途中で切れています。')


def embedded(image):
    exif = image.getexif()
    result = {}
    for tag, name in ((271, 'workflow'), (272, 'prompt')):
        value = exif.get(tag, '')
        if isinstance(value, str) and value.startswith(name + ':'):
            result[name] = json.loads(value[len(name) + 1:])
    return result


def place_exclusive(source, target):
    # 'xb' keeps a concurrent file creation from turning into an overwrite.
    with open(target, 'xb') as dest:
        try:
            with open(source, 'rb') as src:
                shutil.copyfileobj(src, dest, 1024 * 1024)
            dest.flush()
            os.fsync(dest.fileno())
        except BaseException:
            dest.close()
            Path(target).unlink(missing_ok=True)
            raise


def asset_locked(method):
    @wraps(method)
    def locked(self, item):
        path = Path(self.resolve(item)) if isinstance(item, dict) else self.source(self.get(item))
        report('確認中', name=path.name)
        address = os.path.normcase(str(path.resolve()))
        with self.asset_locks[hash(address) % len(self.asset_locks)]:
            # Freeze the codec AND cache identity for this image, including nested
            # archive -> prepare -> commit calls while the UI changes the default.
            outer = not hasattr(self._encoding_context, 'value')
            if outer:
                self._encoding_context.value = self._profiles[self.compression]
            try:
                return method(self, item)
            finally:
                if outer:
                    del self._encoding_context.value
    return locked


class Storage:
    def __init__(self, directory, resolve, cache_limit=512 * 1024 * 1024, encoder=None):
        self.encoder = encoder or ('native' if native_webp.supported() else 'pillow')
        if self.encoder not in ('native', 'pillow'):
            raise ValueError('Unknown encoder')
        if self.encoder == 'native':
            binaries = [native_webp.TOOLS / name for name in ('cwebp.exe', 'webpmux.exe')]
            engine = [digest(path) if path.is_file() else 'missing' for path in binaries]
            method, quality = native_webp.METHOD, native_webp.QUALITY
        else:
            engine = [pillow_version, features.version('webp')]
            method, quality = 4, 80
        def profile(m, q):
            key = json.dumps([self.encoder, engine, f'lossless-exact-m{m}-q{q}-metadata-v1'], sort_keys=True)
            return m, q, key
        self._profiles = {'size': profile(method, quality), 'speed': profile(1, 20)}
        self.compression = 'size'
        self._encoding_context = threading.local()
        self.directory = Path(directory)
        self.directory.mkdir(parents=True, exist_ok=True)
        self.stage = self.directory / 'staging'
        self.cache = self.directory / 'cache'
        self.stage.mkdir(exist_ok=True)
        self.cache.mkdir(exist_ok=True)
        self.index = self.directory / 'records.sqlite3'
        self.compress_records = prepare_database(self.index)
        self.resolve = resolve
        self.cache_limit = cache_limit
        self.lock = threading.RLock()
        self.cache_lock = threading.RLock()
        self.cache_in_use = set()
        self.asset_locks = [threading.RLock() for _ in range(128)]
        with closing(sqlite3.connect(self.index)) as db:
            db.execute('PRAGMA journal_mode=WAL')
            db.execute('CREATE TABLE IF NOT EXISTS records (id TEXT PRIMARY KEY, created REAL, state TEXT, item TEXT, source_hash TEXT, saving INTEGER, payload TEXT)')
            db.execute('CREATE INDEX IF NOT EXISTS record_item ON records(item,source_hash,state)')
            db.execute('CREATE INDEX IF NOT EXISTS record_state ON records(state,created)')
            # Unfiltered history needs its own order index; otherwise every poll
            # scans the large metadata payload table before returning 100 rows.
            db.execute("CREATE INDEX IF NOT EXISTS record_recent ON records(created DESC,id) WHERE state!='discarded'")
            db.execute('CREATE TABLE IF NOT EXISTS asset_addresses (address TEXT PRIMARY KEY, id TEXT, created REAL)')
            if db.execute('PRAGMA user_version').fetchone()[0] < 1:
                for row in db.execute('SELECT payload FROM records').fetchall():
                    self._addresses(db, record_loads(row[0]))
                db.execute('PRAGMA user_version=1')
            db.execute('CREATE TABLE IF NOT EXISTS migration (done INTEGER)')
            legacy = self.directory / 'records.json'
            if legacy.exists() and not db.execute('SELECT done FROM migration').fetchone():
                for record in json.loads(legacy.read_text('utf-8')).values():
                    self._write(db, record)
                db.execute('INSERT INTO migration VALUES (1)')
            if self.compress_records:
                db.execute('CREATE TABLE IF NOT EXISTS asset_hub_storage (key TEXT PRIMARY KEY, value TEXT)')
                db.execute("INSERT OR IGNORE INTO asset_hub_storage VALUES ('format',?)", (FORMAT,))
            db.commit()
        self.prune_cache()

    @property
    def encoding_profile(self):
        return getattr(self._encoding_context, 'value', self._profiles[self.compression])

    @property
    def encoder_key(self):
        return self.encoding_profile[2]

    @encoder_key.setter
    def encoder_key(self, key):
        method, quality, _ = self._profiles[self.compression]
        self._profiles[self.compression] = (method, quality, key)

    def _write(self, db, record):
        db.execute('INSERT OR REPLACE INTO records VALUES (?,?,?,?,?,?,?)',
                   (record['id'], record['created'], record['state'], json.dumps(record['item'], sort_keys=True),
                    record['source_hash'], record['saving_bytes'],
                    record_dumps(record) if self.compress_records else json.dumps(record, ensure_ascii=False)))
        self._addresses(db, record)

    def _addresses(self, db, record):
        for name in (record['item']['name'], record['target_name']):
            item = {**record['item'], 'name': name}
            db.execute('INSERT INTO asset_addresses VALUES (?,?,?) ON CONFLICT(address) DO UPDATE SET id=excluded.id, created=excluded.created WHERE excluded.created>=asset_addresses.created',
                       (json.dumps(item, sort_keys=True), record['id'], record['created']))

    def for_items(self, items):
        records = {}
        with closing(sqlite3.connect(self.index)) as db:
            for item in items:
                row = db.execute('SELECT r.payload FROM asset_addresses a JOIN records r ON r.id=a.id WHERE a.address=?', (json.dumps(item, sort_keys=True),)).fetchone()
                if row:
                    record = record_loads(row[0])
                    records[record['id']] = self.public(record)
        return list(records.values())

    def selection_targets(self, items):
        archive, restore, seen = [], [], set()
        converted = other = unchanged = 0
        with closing(sqlite3.connect(self.index)) as db:
            for item in items:
                path = Path(self.resolve(item))
                row = db.execute('SELECT r.payload FROM asset_addresses a JOIN records r ON r.id=a.id WHERE a.address=?', (json.dumps(item, sort_keys=True),)).fetchone()
                record = record_loads(row[0]) if row else None
                # The catalog may still name the PNG just replaced by a running job.
                if not path.is_file() and record and record['state'] == 'compacted':
                    path = self.source(record, True)
                address = os.path.normcase(str(path.resolve()))
                if address in seen:
                    continue
                seen.add(address)
                if not path.is_file():
                    other += 1
                elif path.suffix.lower() == '.png':
                    if self.no_saving_current(record, path):
                        unchanged += 1
                    else:
                        archive.append(dict(item))
                elif record and record['state'] == 'compacted' and path == self.source(record, True):
                    restore.append(record['id'])
                    converted += 1
                else:
                    other += 1
        return dict(selected=len(seen), archive=archive, restore=restore, converted=converted, other=other, unchanged=unchanged)

    def no_saving_current(self, record, path):
        if not record or record['state'] != 'not_smaller' or record.get('encoder_key') != self.encoder_key:
            return False
        try:
            return file_stamp(path) == record.get('source_stamp')
        except OSError:
            return False

    def save(self, record):
        with self.lock, closing(sqlite3.connect(self.index)) as db:
            self._write(db, record)
            db.commit()

    def get(self, key):
        with closing(sqlite3.connect(self.index)) as db:
            row = db.execute('SELECT payload FROM records WHERE id=?', (key,)).fetchone()
        if not row:
            raise ValueError('保管記録が見つかりません。')
        return record_loads(row[0])

    def listing(self, offset=0, limit=None, state=''):
        with closing(sqlite3.connect(self.index)) as db:
            sql = 'SELECT payload FROM records WHERE state=?' if state else "SELECT payload FROM records WHERE state!='discarded'"
            args = [state] if state else []
            sql += ' ORDER BY created DESC,id'
            if limit is not None:
                sql += ' LIMIT ? OFFSET ?'
                args.extend([limit, offset])
            return [record_loads(row[0]) for row in db.execute(sql, args)]

    def summary(self, state=''):
        with closing(sqlite3.connect(self.index)) as db:
            total = db.execute('SELECT count(*) FROM records WHERE state=?', (state,)).fetchone()[0] if state else db.execute("SELECT count(*) FROM records WHERE state!='discarded'").fetchone()[0]
            saved = db.execute("SELECT coalesce(sum(saving),0) FROM records WHERE state='compacted'").fetchone()[0]
        return dict(total=total, saved_bytes=saved)

    def ids(self, state):
        if state not in ('prepared', 'compacted', 'placing', 'restored'):
            raise ValueError('保管状態を指定してください。')
        with closing(sqlite3.connect(self.index)) as db:
            return [row[0] for row in db.execute('SELECT id FROM records WHERE state=? ORDER BY created,id', (state,))]

    def public(self, r):
        result = {k: v for k, v in r.items() if k not in ('before', 'after', 'metadata', 'pixel_hash', 'encoder_key', 'source_stamp')}
        if r['state'] == 'not_smaller':
            result['no_saving_current'] = self.no_saving_current(r, self.source(r))
        return result

    def source(self, r, compressed=False):
        item = dict(r['item'])
        if compressed:
            item['name'] = r['target_name']
        return Path(self.resolve(item))

    @asset_locked
    def archive(self, item):
        for record in self.for_items([item]):
            if record['state'] == 'placing':
                return self.commit(record['id'])
            if record['state'] == 'not_smaller':
                previous = self.get(record['id'])
                source = Path(self.resolve(item))
                if previous.get('encoder_key') == self.encoder_key and source.is_file():
                    stamp = file_stamp(source)
                    if digest(source) == previous['source_hash'] and file_stamp(source) == stamp:
                        if previous.get('source_stamp') != stamp:
                            previous['source_stamp'] = stamp
                            self.save(previous)
                        return {**previous, 'skipped': True, 'skip_reason': 'not_smaller_cached'}
        if not Path(self.resolve(item)).is_file():
            for record in self.for_items([item]):
                if record['state'] == 'compacted' and digest(self.source(record, True)) == record['webp_hash']:
                    return {**record, 'skipped': True}
        record = self.prepare(item)
        if record['saving_bytes'] > 0:
            return self.commit(record['id'])
        return {**self._discard(record, 'not_smaller'), 'skipped': True, 'skip_reason': 'not_smaller'}

    @asset_locked
    def prepare(self, item):
        source = Path(self.resolve(item))
        if source.suffix.lower() != '.png':
            raise ValueError('圧縮候補を作れるのはPNGです。')
        source_stamp = file_stamp(source)
        report('読込中')
        data = source.read_bytes()
        source_hash = hashlib.sha256(data).hexdigest()
        with closing(sqlite3.connect(self.index)) as db:
            existing = db.execute("SELECT payload FROM records WHERE item=? AND source_hash=? AND state IN ('prepared','placing')", (json.dumps(item, sort_keys=True), source_hash)).fetchall()
        for row in existing:
            r = record_loads(row[0])
            if (self.stage / (r['id'] + '.webp')).exists():
                return r
        chunks = png_chunks(data)
        if any(k == b'acTL' for k, _ in chunks):
            raise ValueError('アニメーションPNGは対象外です。')
        ihdr = chunks[0][1][8:-4]
        if len(ihdr) != 13 or ihdr[8] != 8 or ihdr[9] not in (2, 6):
            raise ValueError('8bit RGB/RGBA PNGだけを可逆保管します。')
        before, after, seen = [], [], False
        for kind, raw in chunks:
            if kind == b'IDAT':
                seen = True
            elif kind not in (b'IHDR', b'IEND'):
                if not kind[0] & 32:
                    raise ValueError('未対応の必須PNGチャンクがあります。')
                (after if seen else before).append(base64.b64encode(raw).decode('ascii'))
        key = uuid.uuid4().hex
        target = self.stage / (key + '.webp')
        try:
            with Image.open(io.BytesIO(data)) as original:
                metadata = {k: json.loads(original.info[k]) for k in ('workflow', 'prompt') if k in original.info}
                exif = Image.Exif()
                for tag, name in ((271, 'workflow'), (272, 'prompt')):
                    if name in metadata:
                        exif[tag] = name + ':' + json.dumps(metadata[name], ensure_ascii=True, separators=(',', ':'))
                pixels = hashlib.sha256(original.tobytes()).hexdigest()
                report('圧縮中')
                if self.encoder == 'native':
                    encoding = native_webp.encode(data, target, exif, original.info.get('icc_profile', b''), method=self.encoding_profile[0], quality=self.encoding_profile[1])
                else:
                    started = time.perf_counter()
                    method, quality, _ = self.encoding_profile
                    original.save(target, format='WEBP', lossless=True, exact=True, method=method, quality=quality, exif=exif,
                                  icc_profile=original.info.get('icc_profile', b''))
                    encoding = dict(backend='pillow', method=method, quality=quality, lossless=True, exact=True,
                                    seconds=round(time.perf_counter()-started, 4))
                report('照合中')
                with Image.open(target) as check:
                    if hashlib.sha256(check.convert(original.mode).tobytes()).hexdigest() != pixels or embedded(check) != metadata:
                        raise ValueError('変換後の画素・生成情報が一致しません。原本を保持しました。')
                    if check.info.get('icc_profile', b'') != original.info.get('icc_profile', b''):
                        raise ValueError('色プロファイルが一致しません。')
                record = dict(id=key, item=dict(item), state='prepared', created=time.time(), encoding=encoding, encoder_key=self.encoder_key,
                              source_hash=source_hash, webp_hash=digest(target), pixel_hash=pixels,
                              original_bytes=len(data), webp_bytes=target.stat().st_size,
                              mode=original.mode, width=original.width, height=original.height,
                              target_name=source.stem + '.webp', before=before, after=after, metadata=metadata)
            record['workflow_nodes'] = len(metadata.get('workflow', {}).get('nodes', []))
            record['workflow_links'] = len(metadata.get('workflow', {}).get('links', []))
            if digest(source) != source_hash or file_stamp(source) != source_stamp:
                raise ValueError('変換中に原本が更新されました。やり直してください。')
            record['source_stamp'] = source_stamp
            record['record_bytes'] = record['saving_bytes'] = 0
            for _ in range(3):
                record['record_bytes'] = len(json.dumps(record, ensure_ascii=False).encode('utf-8'))
                record['saving_bytes'] = record['original_bytes'] - record['webp_bytes'] - record['record_bytes']
            report('記録中')
            self.save(record)
            return record
        except BaseException:
            target.unlink(missing_ok=True)
            raise

    @asset_locked
    def commit(self, key):
        report('照合中')
        r = self.get(key)
        if r['state'] == 'compacted' and digest(self.source(r, True)) == r['webp_hash']:
            return {**r, 'skipped': True}
        if r['state'] not in ('prepared', 'placing'):
            raise ValueError('置き換え可能な候補ではありません。')
        if r['saving_bytes'] <= 0:
            raise ValueError('容量が減らないため、原本を保持します。')
        source, dest = self.source(r), self.source(r, True)
        staged = self.stage / (key + '.webp')
        if digest(staged) != r['webp_hash']:
            raise ValueError('圧縮候補が変更されています。')
        if source.exists() and digest(source) != r['source_hash']:
            raise ValueError('原本が更新されています。置き換えを中止しました。')
        if not source.exists() and r['state'] != 'placing':
            raise ValueError('原本が見つかりません。')
        if dest.exists():
            if r['state'] != 'placing' or digest(dest) != r['webp_hash']:
                raise ValueError('同名のWebPが存在します。上書きしません。')
        else:
            report('保存中')
            r['state'] = 'placing'
            self.save(r)
            place_exclusive(staged, dest)
        report('照合中')
        if digest(dest) != r['webp_hash']:
            raise ValueError('保管先の内容が一致しません。原本を保持します。')
        if source.exists():
            if digest(source) != r['source_hash']:
                raise ValueError('原本が更新されています。原本を保持します。')
            source.unlink()
        r['state'] = 'compacted'
        report('記録中')
        self.save(r)
        staged.unlink(missing_ok=True)
        return r

    def prune_cache(self, keep=None):
        files = sorted(self.cache.glob('*.png'), key=lambda p: p.stat().st_mtime)
        total = sum(p.stat().st_size for p in files)
        for p in files:
            if total <= self.cache_limit:
                break
            if p != keep and p.stem not in self.cache_in_use:
                size = p.stat().st_size
                p.unlink(missing_ok=True)
                total -= size

    @asset_locked
    def export_png(self, key):
        report('照合中')
        r = self.get(key)
        webp = self.source(r, True) if r['state'] in ('compacted', 'placing', 'restoring') else self.stage / (key + '.webp')
        if not webp.exists() or digest(webp) != r['webp_hash']:
            raise ValueError('保管ファイルが移動・変更されています。')
        cached = self.cache / (key + '.png')
        if cached.exists() and r.get('cache_hash') == digest(cached):
            os.utime(cached, None)
            return cached
        report('PNG展開中')
        with Image.open(webp) as encoded:
            image = encoded.convert(r['mode'])
            if hashlib.sha256(image.tobytes()).hexdigest() != r['pixel_hash']:
                raise ValueError('保管画像の画素が一致しません。')
            out = io.BytesIO()
            image.save(out, format='PNG')
            chunks = png_chunks(out.getvalue())
            raw = (b'\x89PNG\r\n\x1a\n' + chunks[0][1]
                   + b''.join(base64.b64decode(s) for s in r['before'])
                   + b''.join(c for k, c in chunks if k == b'IDAT')
                   + b''.join(base64.b64decode(s) for s in r['after']) + chunks[-1][1])
            if len(raw) > self.cache_limit:
                raise ValueError('PNGが展開キャッシュ上限512MBを超えます。')
            report('照合中')
            with Image.open(io.BytesIO(raw)) as restored:
                if hashlib.sha256(restored.tobytes()).hexdigest() != r['pixel_hash']:
                    raise ValueError('PNG復元時に画素が一致しません。')
                if {k: json.loads(restored.info[k]) for k in ('workflow', 'prompt') if k in restored.info} != r['metadata']:
                    raise ValueError('PNG復元時に生成情報が一致しません。')
        tmp = cached.with_suffix('.part')
        report('保存中')
        tmp.write_bytes(raw)
        os.replace(tmp, cached)
        r['cache_hash'] = digest(cached)
        self.save(r)
        with self.cache_lock:
            self.prune_cache(cached)
        return cached


    @asset_locked
    def restore(self, key):
        r = self.get(key)
        source, webp = self.source(r), self.source(r, True)
        if r['state'] == 'restored' and source.exists() and digest(source) == r.get('restore_hash', r.get('cache_hash')):
            return {**r, 'skipped': True}
        if r['state'] not in ('compacted', 'restoring'):
            raise ValueError('保管済みの画像ではありません。')
        with self.cache_lock:
            self.cache_in_use.add(key)
        try:
            if r['state'] == 'restoring' and source.exists():
                if digest(source) != r['restore_hash']:
                    raise ValueError('復元途中のPNGが一致しません。両方の画像を保持しました。')
                png = self.cache / (key + '.png')
            else:
                png = self.export_png(key)
                if source.exists():
                    raise ValueError('同名のPNGが存在します。上書きしません。')
                r = self.get(key)
                r['restore_hash'] = r['cache_hash']
                r['state'] = 'restoring'
                self.save(r)
                report('保存中')
                place_exclusive(png, source)
            if webp.exists():
                report('照合中')
                if digest(webp) != r['webp_hash']:
                    raise ValueError('WebPが更新されています。両方の画像を保持しました。')
                webp.unlink()
            r['state'] = 'restored'
            report('記録中')
            self.save(r)
            with self.cache_lock:
                png.unlink(missing_ok=True)
            return r
        finally:
            with self.cache_lock:
                self.cache_in_use.discard(key)
                self.prune_cache()



    @asset_locked
    def discard(self, key):
        r = self.get(key)
        if r['state'] == 'discarded':
            return {**r, 'skipped': True}
        if r['state'] != 'prepared':
            raise ValueError('原本を保持している候補だけを破棄できます。')
        return self._discard(r, 'discarded')

    def _discard(self, r, state):
        report('原本保持・整理中')
        key = r['id']
        (self.stage / (key + '.webp')).unlink(missing_ok=True)
        with self.cache_lock:
            (self.cache / (key + '.png')).unlink(missing_ok=True)
        r['state'] = state
        self.save(r)
        return r
