from pathlib import Path
from types import SimpleNamespace
import tempfile
import threading
import io
import struct
import zlib
import unittest
from unittest.mock import patch

from PIL import Image
from PIL import PngImagePlugin

from disk_space import DiskReservations, requirements, volume, png_budget
from job_store import JobStore
from jobs import run_parallel
from storage import Storage
import native_webp


class ReuseTests(unittest.TestCase):
    def test_preflight_snapshot_avoids_second_read_and_restores_pixels_and_metadata(self):
        info = PngImagePlugin.PngInfo()
        info.add_text('workflow', '{"nodes":[],"links":[]}')
        Image.new('RGBA', (256, 256), (12, 34, 56, 0)).save(self.source, pnginfo=info, compress_level=0)
        task = {}
        expected = requirements(self.store, 'archive', self.item)
        self.assertEqual(requirements(self.store, 'archive', self.item, task), expected)
        snapshot = task.pop('_input_snapshot')
        self.assertEqual(snapshot['data'], self.source.read_bytes())
        with self.store.prepared_input(snapshot), patch.object(Path, 'read_bytes', side_effect=AssertionError('must reuse preflight bytes')):
            record = self.store.archive(self.item)
        self.assertNotIn('data', snapshot)
        self.store.restore(record['id'])
        with Image.open(self.source) as restored:
            self.assertEqual(restored.tobytes(), bytes((12, 34, 56, 0)) * (256 * 256))
            self.assertEqual(restored.info['workflow'], '{"nodes":[],"links":[]}')

    def test_snapshot_rejects_changed_source_and_releases_data_on_failure(self):
        task = {}
        requirements(self.store, 'archive', self.item, task)
        snapshot = task.pop('_input_snapshot')
        Image.new('RGB', (9, 9), '#445566').save(self.source)
        changed = self.source.read_bytes()
        with self.assertRaisesRegex(ValueError, '見積もり後'), self.store.prepared_input(snapshot):
            self.store.archive(self.item)
        self.assertEqual(self.source.read_bytes(), changed)
        self.assertNotIn('data', snapshot)
        self.assertEqual(list(self.store.stage.iterdir()), [])

    def test_snapshot_keeps_post_encode_source_hash_check(self):
        task = {}
        Image.new('RGB', (256, 256)).save(self.source, compress_level=0)
        requirements(self.store, 'archive', self.item, task)
        snapshot = task.pop('_input_snapshot')
        import storage
        real_digest = storage.digest
        def modify_before_check(path):
            if Path(path) == self.source:
                self.source.write_bytes(b'changed during compression')
            return real_digest(path)
        with self.assertRaisesRegex(ValueError, '原本が更新'), self.store.prepared_input(snapshot), patch('storage.digest', side_effect=modify_before_check):
            self.store.archive(self.item)
        self.assertEqual(self.source.read_bytes(), b'changed during compression')
        self.assertEqual(list(self.store.stage.iterdir()), [])
        self.assertNotIn('data', snapshot)

    def test_snapshot_limit_keeps_streaming_fallback(self):
        task = {}
        with patch('storage.INPUT_SNAPSHOT_LIMIT', 8):
            self.assertTrue(requirements(self.store, 'archive', self.item, task))
        self.assertNotIn('_input_snapshot', task)
        self.assertIsInstance(self.store.archive(self.item), dict)

    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.item = dict(type='output', subfolder='', name='tiny.png')
        self.source = self.root / 'tiny.png'
        Image.new('RGB', (8, 8), '#112233').save(self.source)
        self.store = Storage(self.root / 'state', lambda item: self.root / item['name'])

    def test_result_survives_restart_and_skips_native_encoder(self):
        before = self.source.read_bytes()
        result = self.store.archive(self.item)
        self.assertEqual(result['state'], 'not_smaller')
        self.assertEqual(self.source.read_bytes(), before)
        self.assertEqual(list(self.store.stage.iterdir()), [])
        reopened = Storage(self.root / 'state', self.store.resolve)
        with patch.object(native_webp, 'encode', side_effect=AssertionError('must not encode again')):
            again = reopened.archive(self.item)
        self.assertEqual(again['id'], result['id'])
        self.assertTrue(again['skipped'])
        plan = reopened.selection_targets([self.item])
        self.assertEqual(plan['archive'], [])
        self.assertEqual(plan['unchanged'], 1)
        self.assertEqual(requirements(reopened, 'archive', self.item), [])

    def test_changed_image_and_changed_engine_are_reevaluated(self):
        first = self.store.archive(self.item)
        Image.new('RGB', (9, 9), '#446688').save(self.source)
        self.assertEqual(self.store.selection_targets([self.item])['archive'], [self.item])
        second = self.store.archive(self.item)
        self.assertNotEqual(first['source_hash'], second['source_hash'])
        self.store.encoder_key += '-updated-engine'
        self.assertEqual(self.store.selection_targets([self.item])['archive'], [self.item])
        third = self.store.archive(self.item)
        self.assertNotEqual(third['id'], second['id'])
        self.assertEqual(third['encoder_key'], self.store.encoder_key)

    def test_manual_candidate_discard_is_not_a_no_saving_result(self):
        Image.new('RGB', (256, 256)).save(self.source, compress_level=0)
        prepared = self.store.prepare(self.item)
        self.assertGreater(prepared['saving_bytes'], 0)
        self.store.discard(prepared['id'])
        self.assertEqual(self.store.selection_targets([self.item])['archive'], [self.item])

    def test_job_checkpoint_counts_retained_originals_after_restart(self):
        ledger = JobStore(self.root / 'jobs.sqlite3')
        job = ledger.create('archive', [self.item], 1, True, lambda _: None)
        run_parallel(job, ledger.items(job['id']), lambda task: self.store.public(self.store.archive(task['value'])), threading.Event(), 1,
                     completed=lambda task, result, error: ledger.complete(job['id'], task, result, error))
        ledger.state(job['id'], 'done')
        recovered = JobStore(ledger.path).get(job['id'])
        self.assertEqual((recovered['done'], recovered['skipped'], recovered['not_smaller']), (1, 1, 1))
        self.assertEqual(recovered['remaining'], 0)


class SpaceTests(unittest.TestCase):
    def test_fragmented_png_scan_is_sequential_and_keeps_metadata_budget(self):
        def chunk(kind, data):
            return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data))
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / 'fragmented.png'
            ordinary = Path(temp) / 'ordinary.png'
            Image.new('RGB', (512, 512), '#123456').save(ordinary, compress_level=0)
            original = ordinary.read_bytes()
            pos, idat = 8, b''
            while pos < len(original):
                length = int.from_bytes(original[pos:pos+4], 'big')
                if original[pos+4:pos+8] == b'IDAT':
                    idat += original[pos+8:pos+8+length]
                pos += length + 12
            tail = chunk(b'tEXt', b'Comment\0' + b'x' * 8192)
            path.write_bytes(original[:33] + b''.join(chunk(b'IDAT', idat[i:i+512]) for i in range(0, len(idat), 512)) + tail + chunk(b'IEND', b''))
            counters = dict(read=0, seek=0)
            class Raw(io.FileIO):
                def readinto(self, buffer):
                    counters['read'] += 1
                    return super().readinto(buffer)
                def seek(self, *args):
                    counters['seek'] += 1
                    return super().seek(*args)
            def open_scan(name, mode, buffering=-1):
                return io.BufferedReader(Raw(name, mode), buffer_size=buffering)
            with patch('disk_space.open', open_scan, create=True):
                budget, metadata = png_budget(path)
            self.assertEqual(metadata, len(tail) * 2 + 1024**2)
            self.assertEqual(budget, int(512 * 512 * 4 * 1.1) + metadata)
            self.assertEqual(counters['seek'], 0)
            self.assertLessEqual(counters['read'], 2)
            # Animation and truncated trailing chunks must still be rejected.
            path.write_bytes(path.read_bytes()[:-12] + chunk(b'acTL', struct.pack('>II', 2, 0)) + chunk(b'IEND', b''))
            with self.assertRaisesRegex(ValueError, 'アニメーション'):
                png_budget(path)
            path.write_bytes(original[:-12] + struct.pack('>I', 100) + b'tEXt' + b'cut')
            with self.assertRaisesRegex(ValueError, '途中'):
                png_budget(path)

    def test_same_volume_sums_stage_and_destination_and_limits_parallelism(self):
        free = [100]
        disk = DiskReservations(lambda _: [('stage', 30), ('destination', 30)], space=lambda _: SimpleNamespace(free=free[0]),
                                identify=lambda path: ('same-volume', path), headroom=10)
        a, b = {}, {}
        self.assertTrue(disk.acquire(a))
        self.assertFalse(disk.acquire(b))
        self.assertIn('空き容量', disk.reason)
        disk.release(a)
        self.assertTrue(disk.acquire(b))
        disk.release(b)
        self.assertEqual(disk.held, {})

    def test_different_volumes_both_require_space(self):
        free = {'stage': 100, 'destination': 20}
        disk = DiskReservations(lambda _: [('stage', 30), ('destination', 30)], space=lambda path: SimpleNamespace(free=free[path]),
                                identify=lambda path: (path, path), headroom=10)
        task = {}
        self.assertFalse(disk.acquire(task))
        free['destination'] = 50
        self.assertTrue(disk.acquire(task))

    def test_wait_then_resume_and_release_when_processing_fails(self):
        free, seen = [0], threading.Event()
        job = dict(done=0, succeeded=0, error_count=0, errors=[], results=[], total=1)
        disk = DiskReservations(lambda _: [('target', 30)], space=lambda _: (seen.set() or SimpleNamespace(free=free[0])),
                                identify=lambda path: (path, path), headroom=10)
        def fail(_):
            raise ValueError('broken')
        worker = threading.Thread(target=run_parallel, args=(job, [{}], fail, threading.Event(), 1), kwargs={'admission': disk})
        worker.start()
        self.assertTrue(seen.wait(3))
        self.assertEqual(job['done'], 0)
        free[0] = 100
        worker.join(3)
        self.assertFalse(worker.is_alive())
        self.assertEqual(job['error_count'], 1)
        self.assertEqual(disk.held, {})

    def test_space_wait_can_pause_without_losing_durable_target(self):
        with tempfile.TemporaryDirectory() as directory:
            ledger = JobStore(Path(directory) / 'jobs.sqlite3')
            job = ledger.create('archive', [{'name': 'a'}], 1, True, lambda _: None)
            stop, waiting = threading.Event(), threading.Event()
            disk = DiskReservations(lambda _: [('target', 30)], space=lambda _: (waiting.set() or SimpleNamespace(free=0)),
                                    identify=lambda path: (path, path), headroom=10)
            worker = threading.Thread(target=run_parallel, args=(job, ledger.items(job['id']), lambda _: self.fail('must not run'), stop, 1), kwargs={'admission': disk})
            worker.start()
            self.assertTrue(waiting.wait(3))
            stop.set()
            worker.join(3)
            ledger.state(job['id'], 'paused')
            self.assertEqual(ledger.resume(job['id'], False, lambda _: None)['remaining'], 1)
            self.assertEqual(disk.held, {})

    def test_planner_includes_stage_and_output_and_restore_cache(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / 'source.png'
            Image.new('RGB', (256, 256)).save(source, compress_level=0)
            store = Storage(root / 'state', lambda item: source)
            item = dict(type='output', subfolder='', name='source.png')
            plan = requirements(store, 'archive', item)
            self.assertEqual([p for p, _ in plan], [store.stage, root])
            self.assertTrue(all(n > 256*256*4 for _, n in plan))
            prepared = store.prepare(item)
            restore = requirements(store, 'restore', prepared['id'])
            self.assertEqual([p for p, _ in restore], [store.cache, root])
            self.assertEqual(volume(root)[0], volume(store.stage)[0])


if __name__ == '__main__':
    unittest.main()
