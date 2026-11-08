"""One-time startup migration, before the hub exposes any routes or workers."""
from contextlib import closing
import gzip
import hashlib
import logging
import os
from pathlib import Path
import shutil
import sqlite3
import tempfile
import time
import uuid

if __package__:
    from .record_codec import pack_text, unpack_text, loads
else:
    from record_codec import pack_text, unpack_text, loads

LOG = logging.getLogger(__name__)
FORMAT = 'zlib-json-v1'
HEADROOM = 64 * 1024 * 1024


def required_space(path, factor=3):
    # Backup snapshot, transaction WAL/journal and vacuum work space. The gzip
    # backup is retained, so it is included in the conservative budget too.
    size = path.stat().st_size
    wal = Path(str(path) + '-wal')
    if wal.exists():
        size += wal.stat().st_size
    return size * factor + HEADROOM


def backup_database(path):
    """Caller holds the write reservation. Backup includes committed WAL data."""
    name = f'records-before-compression-{time.time_ns()}-{uuid.uuid4().hex[:8]}.sqlite3.gz'
    target = path.parent / name
    temporary = target.with_suffix(target.suffix + '.part')
    try:
        with tempfile.TemporaryDirectory(prefix='.asset-hub-backup-', dir=path.parent) as folder:
            snapshot = Path(folder) / 'snapshot.sqlite3'
            with closing(sqlite3.connect(path.as_uri() + '?mode=ro', uri=True)) as source:
                with closing(sqlite3.connect(snapshot)) as dest:
                    source.backup(dest)
                    if dest.execute('PRAGMA integrity_check').fetchone()[0] != 'ok':
                        raise ValueError('移行前DBの整合性を確認できません。')
            expected = hashlib.sha256()
            with snapshot.open('rb') as src, temporary.open('xb') as file:
                with gzip.GzipFile(fileobj=file, mode='wb', compresslevel=6, mtime=0) as zipped:
                    while block := src.read(1024 * 1024):
                        expected.update(block)
                        zipped.write(block)
                file.flush()
                os.fsync(file.fileno())
            actual = hashlib.sha256()
            with gzip.open(temporary, 'rb') as restored:
                while block := restored.read(1024 * 1024):
                    actual.update(block)
            if actual.digest() != expected.digest():
                raise ValueError('移行前DBのバックアップ照合に失敗しました。')
        os.replace(temporary, target)
        return name
    finally:
        temporary.unlink(missing_ok=True)


def _digest_row(digest, key, text):
    for value in (key.encode('utf-8'), text.encode('utf-8')):
        digest.update(len(value).to_bytes(8, 'big'))
        digest.update(value)


def convert_records(db):
    expected = hashlib.sha256()
    after = ''
    count = 0
    while rows := db.execute('SELECT id,payload FROM records WHERE id>? ORDER BY id LIMIT 100', (after,)).fetchall():
        for key, value in rows:
            text = unpack_text(value)
            loads(value)  # Never migrate a malformed source record silently.
            _digest_row(expected, key, text)
            packed = pack_text(text)
            if unpack_text(packed) != text:
                raise ValueError('保管記録の圧縮照合に失敗しました。')
            db.execute('UPDATE records SET payload=? WHERE id=?', (packed, key))
        count += len(rows)
        after = rows[-1][0]
        if count % 1000 == 0:
            LOG.info('Asset Hub: verified %s database records', count)
    actual = hashlib.sha256()
    checked = 0
    for key, value in db.execute('SELECT id,payload FROM records ORDER BY id'):
        _digest_row(actual, key, unpack_text(value))
        checked += 1
    if checked != count or actual.digest() != expected.digest():
        raise ValueError('移行後DBの全件照合に失敗しました。')
    return count


def compact_database(db):
    checkpoint = db.execute('PRAGMA wal_checkpoint(TRUNCATE)').fetchone()
    if checkpoint[0]:
        raise OSError('DBを使用中の接続があるため、容量整理を次回起動へ延期します。')
    path = Path(db.execute('PRAGMA database_list').fetchone()[2])
    if shutil.disk_usage(path.parent).free < required_space(path, factor=2):
        raise OSError('DB容量整理用の空き容量が不足しています。次回起動時に再試行します。')
    db.execute('VACUUM')
    db.execute('PRAGMA wal_checkpoint(TRUNCATE)')
    if db.execute('PRAGMA integrity_check').fetchone()[0] != 'ok':
        raise ValueError('容量整理後DBの整合性を確認できません。')


def prepare_database(path):
    """Return whether new writes may use compression; failures preserve access.

    On a pre-commit failure, keep writing legacy JSON until a later startup can
    finish migration. After commit, compressed and legacy rows are both readable;
    an interrupted VACUUM can be retried without recompressing or backing up again.
    """
    path = Path(path).resolve()
    if not path.is_file():
        return True
    ready = False
    try:
        with closing(sqlite3.connect(path, timeout=5)) as db:
            if not db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='records'").fetchone():
                return True
            db.execute('BEGIN IMMEDIATE')
            db.execute('CREATE TABLE IF NOT EXISTS asset_hub_storage (key TEXT PRIMARY KEY, value TEXT)')
            settings = dict(db.execute('SELECT key,value FROM asset_hub_storage'))
            if settings.get('format') not in (None, FORMAT):
                raise RuntimeError('保管DBは未対応の形式です。対応版の素材庫を使用してください。')
            ready = settings.get('format') == FORMAT
            if not ready:
                has_records = db.execute('SELECT 1 FROM records LIMIT 1').fetchone()
                if has_records:
                    if shutil.disk_usage(path.parent).free < required_space(path):
                        raise OSError('DB移行用の空き容量が不足しています。従来形式のまま継続します。')
                    LOG.info('Asset Hub: creating verified database backup before compression')
                    backup = backup_database(path)
                    count = convert_records(db)
                    db.execute("INSERT INTO asset_hub_storage VALUES ('backup',?)", (backup,))
                    db.execute("INSERT INTO asset_hub_storage VALUES ('compact_pending','1')")
                    LOG.info('Asset Hub: all %s database records verified', count)
                db.execute("INSERT INTO asset_hub_storage VALUES ('format',?)", (FORMAT,))
                db.commit()
                ready = True
            else:
                db.commit()
            pending = db.execute("SELECT value FROM asset_hub_storage WHERE key='compact_pending'").fetchone()
            if pending and pending[0] == '1':
                compact_database(db)
                db.execute("UPDATE asset_hub_storage SET value='0' WHERE key='compact_pending'")
                db.commit()
                LOG.info('Asset Hub: database compression and compaction complete; rollback backup retained')
                backup = db.execute("SELECT value FROM asset_hub_storage WHERE key='backup'").fetchone()
                if backup and Path(backup[0]).name == backup[0]:
                    file = path.parent / backup[0]
                    if file.is_file():
                        LOG.info('Asset Hub: database %.2f MB; rollback backup %.2f MB (%s)',
                                 path.stat().st_size / 1e6, file.stat().st_size / 1e6, file.name)
            return True
    except (OSError, ValueError, sqlite3.Error) as error:
        LOG.warning('Asset Hub: database maintenance deferred: %s', error)
        return ready
