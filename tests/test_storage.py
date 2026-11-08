import importlib.util
import json
import sqlite3
from contextlib import closing
from pathlib import Path
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import patch

from PIL import Image, PngImagePlugin

root = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('hub_storage_test', root / 'storage.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class StorageTests(unittest.TestCase):
    def test_large_history_uses_order_index_and_preserves_pagination(self):
        with closing(sqlite3.connect(self.store.index)) as db:
            db.executemany('INSERT INTO records VALUES (?,?,?,?,?,?,?)', [
                (str(i), i // 2, 'discarded' if i % 7 == 0 else 'compacted', '{}', '', i,
                 json.dumps(dict(id=str(i), padding='x' * 4096))) for i in range(1200)])
            # Upgrade an existing database, as on a real installation.
            db.execute('DROP INDEX record_recent')
            db.commit()
        upgraded = module.Storage(self.store.directory, self.store.resolve)
        with closing(sqlite3.connect(upgraded.index)) as db:
            query = "SELECT payload FROM records WHERE state!='discarded' ORDER BY created DESC,id LIMIT 100 OFFSET 100"
            plan = ' '.join(row[3] for row in db.execute('EXPLAIN QUERY PLAN ' + query))
            self.assertIn('record_recent', plan)
            self.assertNotIn('TEMP B-TREE', plan)
        expected = sorted((i for i in range(1200) if i % 7), key=lambda i: (-(i // 2), str(i)))
        self.assertEqual([r['id'] for r in upgraded.listing(100, 100)], [str(i) for i in expected[100:200]])
        self.assertEqual(upgraded.summary()['total'], len(expected))

    def test_archive_recovers_after_source_removed_before_commit_checkpoint(self):
        real_save = self.store.save
        def interrupt(record):
            if record['state'] == 'compacted':
                raise KeyboardInterrupt('simulated crash')
            return real_save(record)
        with patch.object(self.store, 'save', side_effect=interrupt):
            with self.assertRaises(KeyboardInterrupt):
                self.store.archive(self.item)
        self.assertFalse((self.base / 'sample.png').exists())
        recovered = self.store.archive(self.item)
        self.assertEqual(recovered['state'], 'compacted')
        self.store.restore(recovered['id'])
        self.assertTrue((self.base / 'sample.png').exists())

    def test_restore_recovers_after_webp_removed_before_checkpoint(self):
        record = self.store.archive(self.item)
        real_save = self.store.save
        def interrupt(value):
            if value['state'] == 'restored':
                raise KeyboardInterrupt('simulated crash')
            return real_save(value)
        with patch.object(self.store, 'save', side_effect=interrupt):
            with self.assertRaises(KeyboardInterrupt):
                self.store.restore(record['id'])
        self.assertEqual(self.store.get(record['id'])['state'], 'restoring')
        self.assertEqual(self.store.restore(record['id'])['state'], 'restored')
        self.assertTrue(self.store.restore(record['id'])['skipped'])

    def test_selection_distinguishes_png_converted_webp_and_other_files(self):
        original = (self.base / 'sample.png').read_bytes()
        converted = self.store.archive(self.item)
        pending = {**self.item, 'name': 'new.png'}
        (self.base / pending['name']).write_bytes(original)
        other = {**self.item, 'name': 'other.jpg'}
        Image.new('RGB', (8, 8)).save(self.base / other['name'])
        # Include both the stale PNG address and its current WebP address.
        plan = self.store.selection_targets([self.item, {**self.item, 'name': converted['target_name']}, pending, other])
        self.assertEqual(plan['selected'], 3)
        self.assertEqual(plan['archive'], [pending])
        self.assertEqual(plan['restore'], [converted['id']])
        self.assertEqual(plan['converted'], 1)
        self.assertEqual(plan['other'], 1)

    def test_archive_already_completed_while_queued_is_skipped(self):
        record = self.store.archive(self.item)
        before = (self.base / record['target_name']).stat().st_mtime_ns
        again = self.store.archive(self.item)
        self.assertTrue(again['skipped'])
        self.assertEqual(again['id'], record['id'])
        self.assertEqual((self.base / record['target_name']).stat().st_mtime_ns, before)

    def test_parallel_archive_restore_and_asset_lookup(self):
        original = (self.base / 'sample.png').read_bytes()
        items = [{**self.item, 'name': f'copy-{i}.png'} for i in range(8)]
        for item in items:
            (self.base / item['name']).write_bytes(original)
        with ThreadPoolExecutor(max_workers=4) as workers:
            records = list(workers.map(self.store.archive, items))
            self.assertTrue(all(r['state'] == 'compacted' for r in records))
            webps = [{**r['item'], 'name': r['target_name']} for r in records]
            self.assertEqual(len(self.store.for_items(webps)), 8)
            restored = list(workers.map(self.store.restore, [r['id'] for r in records]))
        self.assertTrue(all(r['state'] == 'restored' for r in restored))
        with Image.open(self.base / 'sample.png') as reference:
            for item in items:
                with Image.open(self.base / item['name']) as image:
                    self.assertEqual(image.tobytes(), reference.tobytes())

    def test_duplicate_parallel_prepare_uses_one_record(self):
        with ThreadPoolExecutor(max_workers=4) as workers:
            records = list(workers.map(self.store.prepare, [self.item]*4))
        self.assertEqual(len({r['id'] for r in records}), 1)

    def test_legacy_history_migrates_once_without_losing_new_records(self):
        record = self.store.prepare(self.item)
        directory = self.base / 'legacy'
        directory.mkdir()
        (directory / 'records.json').write_text(json.dumps({record['id']: record}), 'utf-8')
        migrated = module.Storage(directory, self.store.resolve)
        self.assertEqual(migrated.get(record['id']), record)
        record['state'] = 'restored'
        migrated.save(record)
        reopened = module.Storage(directory, self.store.resolve)
        self.assertEqual(reopened.get(record['id'])['state'], 'restored')

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        def resolve(item):
            name = item['name']
            if item['type'] != 'output' or Path(name).name != name or '..' in name:
                raise ValueError('outside root')
            return self.base / name
        self.store = module.Storage(self.base / 'state', resolve, cache_limit=2_000_000)
        self.item = {'type': 'output', 'subfolder': '', 'name': 'sample.png'}
        self.graph = {'nodes': [{'id': 1, 'type': 'テスト'}], 'links': []}
        info = PngImagePlugin.PngInfo()
        info.add_text('workflow', json.dumps(self.graph, ensure_ascii=False))
        info.add_text('prompt', json.dumps({'1': {'class_type': 'テスト'}}))
        info.add_itxt('comment', '保持する付随情報')
        im = Image.new('RGBA', (256, 256), (12, 34, 56, 0))
        im.putpixel((10, 10), (222, 33, 44, 127))
        im.save(self.base / 'sample.png', pnginfo=info, compress_level=0)

    def test_lossless_roundtrip_including_hidden_rgb_unicode_and_png_chunks(self):
        original = (self.base / 'sample.png').read_bytes()
        r = self.store.prepare(self.item)
        self.assertEqual((self.base / 'sample.png').read_bytes(), original)
        self.assertGreater(r['saving_bytes'], 0)
        self.store.commit(r['id'])
        self.assertFalse((self.base / 'sample.png').exists())
        self.assertFalse((self.store.stage / (r['id'] + '.webp')).exists())
        export = self.store.export_png(r['id'])
        with Image.open(export) as result:
            self.assertEqual(result.getpixel((0, 0)), (12, 34, 56, 0))
            self.assertEqual(json.loads(result.info['workflow']), self.graph)
            self.assertEqual(result.info['comment'], '保持する付随情報')
        self.store.restore(r['id'])
        self.assertFalse((self.base / 'sample.webp').exists())
        restored = module.png_chunks((self.base / 'sample.png').read_bytes())
        old = module.png_chunks(original)
        self.assertEqual([c for k, c in old if k not in (b'IHDR', b'IDAT', b'IEND')],
                         [c for k, c in restored if k not in (b'IHDR', b'IDAT', b'IEND')])

    def test_modified_original_is_not_removed(self):
        r = self.store.prepare(self.item)
        source = self.base / 'sample.png'
        source.write_bytes(source.read_bytes() + b'changed')
        with self.assertRaises(ValueError):
            self.store.commit(r['id'])
        self.assertTrue(source.exists())

    def test_existing_webp_is_not_overwritten(self):
        r = self.store.prepare(self.item)
        target = self.base / 'sample.webp'
        target.write_bytes(b'existing file')
        with self.assertRaises(ValueError):
            self.store.commit(r['id'])
        self.assertEqual(target.read_bytes(), b'existing file')
        self.assertTrue((self.base / 'sample.png').exists())

    def test_tampered_archive_is_not_exported(self):
        r = self.store.prepare(self.item)
        self.store.commit(r['id'])
        (self.base / 'sample.webp').write_bytes(b'changed')
        with self.assertRaises(ValueError):
            self.store.export_png(r['id'])

    def test_discard_keeps_source_and_frees_candidate(self):
        r = self.store.prepare(self.item)
        self.store.discard(r['id'])
        self.assertTrue((self.base / 'sample.png').exists())
        self.assertEqual(list(self.store.stage.iterdir()), [])

    def test_16bit_and_palette_are_not_silently_reduced(self):
        for mode in ('I;16', 'P'):
            Image.new(mode, (64, 64)).save(self.base / 'sample.png')
            with self.assertRaises(ValueError):
                self.store.prepare(self.item)

    def test_cache_limit_removes_older_exports(self):
        self.store.cache_limit = 200
        for name in ('old.png', 'new.png'):
            (self.store.cache / name).write_bytes(b'x' * 150)
        self.store.prune_cache(self.store.cache / 'new.png')
        self.assertFalse((self.store.cache / 'old.png').exists())
        self.assertTrue((self.store.cache / 'new.png').exists())


if __name__ == '__main__':
    unittest.main()
