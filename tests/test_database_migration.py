from contextlib import closing
import gzip
import io
import json
from pathlib import Path
import sqlite3
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import zlib

from PIL import Image, PngImagePlugin

import database_migration as migration
import record_codec as codec
from storage import Storage, png_chunks


class RecordCodecTests(unittest.TestCase):
    def test_legacy_compressed_and_large_records_are_lossless(self):
        for value in ({'short': '日本語'}, {'text': '復元用の情報' * 1000}):
            text = json.dumps(value, ensure_ascii=False)
            self.assertEqual(codec.loads(text), value)
            self.assertEqual(codec.loads(codec.dumps(value)), value)
        with patch.object(codec, 'MAX_RECORD', 128):
            text = json.dumps({'large': 'x' * 200})
            self.assertEqual(codec.pack_text(text), text)
            with self.assertRaises(ValueError):
                codec.unpack_text(codec.MAGIC + zlib.compress(b'x' * 200))

    def test_truncation_trailing_data_unknown_versions_and_invalid_utf8_fail(self):
        valid = codec.dumps({'text': 'x' * 1000})
        for value in (valid[:-1], valid + b'extra', b'AHZ2' + valid[4:],
                      codec.MAGIC + zlib.compress(b'\xff')):
            with self.subTest(value=value[:8]), self.assertRaises(ValueError):
                codec.loads(value)


class DatabaseMigrationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.path = self.root / 'records.sqlite3'
        with closing(sqlite3.connect(self.path)) as db, db:
            db.execute('CREATE TABLE records(id TEXT PRIMARY KEY, payload TEXT, untouched TEXT)')
            db.execute('CREATE TABLE addresses(id TEXT, name TEXT)')
            self.rows = [(f'{i:04}', json.dumps({'id': i, 'text': '日本語 metadata ' * 1000}, ensure_ascii=False), 'keep') for i in range(100)]
            db.executemany('INSERT INTO records VALUES (?,?,?)', self.rows)
            db.execute("INSERT INTO addresses VALUES ('0000','image.webp')")

    def read_rows(self):
        with closing(sqlite3.connect(self.path)) as db, db:
            return db.execute('SELECT id,payload,untouched FROM records ORDER BY id').fetchall()

    def test_full_migration_backup_compaction_and_second_start(self):
        original_bytes = self.path.stat().st_size
        # Keep committed data in WAL while the backup is made.
        keeper = sqlite3.connect(self.path)
        self.addCleanup(keeper.close)
        keeper.execute('PRAGMA journal_mode=WAL')
        keeper.execute("UPDATE addresses SET name='committed-in-wal.webp'")
        keeper.commit()
        self.assertTrue(migration.prepare_database(self.path))
        backups = list(self.root.glob('*.sqlite3.gz'))
        self.assertEqual(len(backups), 1)
        old_path = self.root/'old.sqlite3'
        old_path.write_bytes(gzip.decompress(backups[0].read_bytes()))
        with closing(sqlite3.connect(old_path)) as old, old:
            self.assertEqual(old.execute('SELECT * FROM records ORDER BY id').fetchall(), self.rows)
            self.assertEqual(old.execute('SELECT name FROM addresses').fetchone()[0], 'committed-in-wal.webp')
        self.assertEqual([(key,codec.unpack_text(value),extra) for key,value,extra in self.read_rows()], self.rows)
        self.assertLess(self.path.stat().st_size + backups[0].stat().st_size, original_bytes)
        with patch.object(migration, 'backup_database', side_effect=AssertionError('must not repeat backup')):
            self.assertTrue(migration.prepare_database(self.path))

    def test_backup_failure_keeps_original_and_defers_new_compressed_writes(self):
        with patch.object(migration, 'backup_database', side_effect=OSError('disk failure')):
            self.assertFalse(migration.prepare_database(self.path))
        self.assertEqual(self.read_rows(), self.rows)

    def test_insufficient_space_keeps_legacy_records(self):
        with patch.object(migration.shutil, 'disk_usage', return_value=SimpleNamespace(free=0)):
            self.assertFalse(migration.prepare_database(self.path))
        self.assertEqual(self.read_rows(), self.rows)
        self.assertFalse(list(self.root.glob('*.gz')))

    def test_interruption_before_commit_rolls_back_all_changed_rows(self):
        def interrupt(db):
            db.execute('UPDATE records SET payload=? WHERE id=?', (codec.dumps({'changed': True}), '0000'))
            raise KeyboardInterrupt('simulated shutdown')
        with patch.object(migration, 'convert_records', side_effect=interrupt):
            with self.assertRaises(KeyboardInterrupt):
                migration.prepare_database(self.path)
        self.assertEqual(self.read_rows(), self.rows)
        self.assertTrue(migration.prepare_database(self.path))

    def test_compaction_failure_retries_without_repeating_conversion(self):
        with patch.object(migration, 'compact_database', side_effect=OSError('busy')):
            self.assertTrue(migration.prepare_database(self.path))
        with closing(sqlite3.connect(self.path)) as db, db:
            self.assertEqual(db.execute("SELECT value FROM asset_hub_storage WHERE key='compact_pending'").fetchone()[0], '1')
        with patch.object(migration, 'convert_records', side_effect=AssertionError('must not reconvert')):
            self.assertTrue(migration.prepare_database(self.path))
        self.assertEqual(len(list(self.root.glob('*.gz'))), 1)
        self.assertEqual([(key,codec.unpack_text(value),extra) for key,value,extra in self.read_rows()], self.rows)

    def test_other_writers_are_excluded_during_backup(self):
        real = migration.backup_database
        def check(path):
            with closing(sqlite3.connect(path, timeout=.01)) as writer, writer:
                with self.assertRaises(sqlite3.OperationalError):
                    writer.execute('BEGIN IMMEDIATE')
            return real(path)
        with patch.object(migration, 'backup_database', side_effect=check):
            self.assertTrue(migration.prepare_database(self.path))

    def test_unknown_future_format_is_not_modified(self):
        with closing(sqlite3.connect(self.path)) as db, db:
            db.execute('CREATE TABLE asset_hub_storage(key TEXT PRIMARY KEY,value TEXT)')
            db.execute("INSERT INTO asset_hub_storage VALUES ('format','future-format')")
        with self.assertRaises(RuntimeError):
            migration.prepare_database(self.path)
        self.assertEqual(self.read_rows(), self.rows)


class StorageMigrationTests(unittest.TestCase):
    def test_existing_archive_restores_after_startup_migration(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            path = root/'image.png'
            info = PngImagePlugin.PngInfo()
            info.add_text('workflow', json.dumps({'nodes': [], 'extra': '日本語' * 500}))
            info.add_text('prompt', '{}')
            info.add_itxt('comment', '復元時も保持する')
            Image.new('RGBA', (256,256), (53,77,91,0)).save(path, pnginfo=info, compress_level=0)
            original = path.read_bytes()
            store = Storage(root/'state', lambda item: root/item['name'])
            self.assertFalse(list(store.directory.glob('*.gz')))
            record = store.archive(dict(type='output', subfolder='', name=path.name))
            with closing(sqlite3.connect(store.index)) as db, db:
                self.assertEqual(db.execute('SELECT typeof(payload) FROM records').fetchone()[0], 'blob')
                db.execute('UPDATE records SET payload=?', (json.dumps(record,ensure_ascii=False),))
                db.execute('DROP TABLE asset_hub_storage')  # Emulate the previous release.
            with patch.object(migration.shutil, 'disk_usage', return_value=SimpleNamespace(free=0)):
                deferred = Storage(store.directory, store.resolve)
            self.assertFalse(deferred.compress_records)
            deferred.save(record)
            with closing(sqlite3.connect(store.index)) as db:
                self.assertEqual(db.execute('SELECT typeof(payload) FROM records').fetchone()[0], 'text')
            self.assertFalse(list(store.directory.glob('*.gz')))
            migrated = Storage(store.directory, store.resolve)
            self.assertEqual(migrated.get(record['id']), record)
            self.assertTrue(list(store.directory.glob('*.gz')))
            self.assertEqual(migrated.for_items([record['item']])[0]['id'], record['id'])
            self.assertEqual(migrated.listing()[0]['id'], record['id'])
            migrated.restore(record['id'])
            with Image.open(io.BytesIO(original)) as a, Image.open(path) as b:
                self.assertEqual(a.tobytes(),b.tobytes())
                self.assertEqual(a.info,b.info)
            ancillary=lambda data:[c for k,c in png_chunks(data) if k not in (b'IHDR',b'IDAT',b'IEND')]
            self.assertEqual(ancillary(original),ancillary(path.read_bytes()))
