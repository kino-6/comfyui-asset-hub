"""Exercise the real queue, executor and durable journal without ComfyUI."""
import asyncio
from pathlib import Path
import tempfile
import threading
import unittest
import native_webp

from job_manager import JobManager
from job_store import JobStore


class ControlledStorage:
    def __init__(self):
        self.entered = threading.Event()
        self.release = threading.Event()
        self.calls = []
        self.fail = set()

    def get(self, key):
        return {'item': {'name': key}}

    def public(self, record):
        return record

    def discard(self, key):
        self.calls.append(key)
        if key == 'hold':
            self.entered.set()
            if not self.release.wait(5):
                raise TimeoutError('test did not release work')
        if key in self.fail:
            raise ValueError('controlled failure')
        return {'id': key}


class JobManagerTests(unittest.IsolatedAsyncioTestCase):
    async def test_only_other_work_mode_lowers_codec_priority_and_modes_persist(self):
        priorities = []
        original = self.store.discard
        def capture(key):
            priorities.append(getattr(native_webp._priority, 'background', False))
            return original(key)
        self.store.discard = capture
        for mode, target in [('background', None), ('normal', None), ('cpu', 90)]:
            await self.manager.set_performance(target, 1, mode)
            job = await self.manager.start('discard', [mode], workers=1)
            await self.drain()
            self.assertEqual(job['mode'], mode)
            self.assertEqual(self.journal.performance()['mode'], mode)
        self.assertEqual(priorities, [True, False, False])
        for mode, target in [('bad', None), ('cpu', None), ('normal', 70), ('background', 70)]:
            with self.assertRaises(ValueError):
                await self.manager.set_performance(target, 1, mode)
        self.assertEqual(self.journal.performance()['mode'], 'cpu')

    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.journal = JobStore(Path(self.temp.name) / 'jobs.sqlite3')
        self.journal.set_performance(None, 1)
        self.store = ControlledStorage()
        self.manager = JobManager(self.store, self.journal)

    async def asyncTearDown(self):
        self.store.release.set()
        await self.drain()

    async def drain(self):
        while self.manager.worker_active:
            await asyncio.wait_for(asyncio.shield(self.manager.worker_task), 8)

    async def hold(self):
        job = await self.manager.start('discard', ['hold', 'remaining'], workers=1)
        self.assertTrue(await asyncio.to_thread(self.store.entered.wait, 3))
        return job

    async def test_queue_runs_after_current_job_and_settings_apply_to_both(self):
        first = await self.hold()
        second = await self.manager.start('discard', ['queued'], workers=1)
        self.assertEqual(second['status'], 'queued')
        self.assertEqual(self.store.calls, ['hold'])
        await self.manager.set_performance(90, 2)
        for job in (first, second):
            self.assertEqual((job['cpu_target'], job['workers'], job['background']), (90, 2, True))
        await self.manager.set_performance(None, 1)
        self.store.release.set()
        await self.drain()
        self.assertEqual(self.store.calls, ['hold', 'remaining', 'queued'])
        for job in (first, second):
            self.assertEqual(self.journal.get(job['id'])['status'], 'done')
        self.assertEqual(self.manager.snapshot()['queue'], [])
        self.assertEqual(self.journal.performance(), {'mode': 'normal', 'cpu_target': None, 'workers': 1})

    async def test_pause_finishes_inflight_and_resume_preserves_completed_count(self):
        first = await self.hold()
        second = await self.manager.start('discard', ['queued'], workers=1)
        await self.manager.stop()
        self.assertTrue(first['stopping'])
        self.assertEqual(self.manager.snapshot()['queue'], [])
        self.assertEqual(self.journal.get(second['id'])['status'], 'paused')
        self.store.release.set()
        await self.drain()
        paused = self.journal.get(first['id'])
        self.assertEqual((paused['status'], paused['done'], paused['remaining']), ('paused', 1, 1))
        resumed = await self.manager.resume(first['id'])
        self.assertEqual(resumed['done'], 1)
        await self.drain()
        await self.manager.resume(second['id'])
        await self.drain()
        self.assertEqual(self.store.calls, ['hold', 'remaining', 'queued'])
        self.assertEqual(self.manager.snapshot()['attention'], 0)

    async def test_failed_item_retries_without_repeating_successful_items(self):
        self.store.fail.add('bad')
        job = await self.manager.start('discard', ['good', 'bad'], workers=1)
        await self.drain()
        self.assertEqual(job['error_count'], 1)
        self.assertEqual(self.manager.snapshot()['attention'], 1)
        self.store.fail.clear()
        await self.manager.resume(job['id'], retry=True)
        await self.drain()
        self.assertEqual(self.store.calls, ['good', 'bad', 'bad'])
        result = self.journal.get(job['id'])
        self.assertEqual((result['succeeded'], result['error_count']), (2, 0))

    async def test_invalid_settings_do_not_change_persisted_settings(self):
        for target, workers in [(True, 1), (9, 1), (96, 1), (70, True), (70, 0), (70, 17)]:
            with self.assertRaises(ValueError):
                await self.manager.set_performance(target, workers)
        with self.assertRaises(ValueError):
            await self.manager.set_background('yes')
        self.assertEqual(self.journal.performance(), {'mode': 'normal', 'cpu_target': None, 'workers': 1})
        await self.manager.set_background(True)
        self.assertTrue(self.manager.snapshot()['background'])
        await self.manager.set_background(False)
        snapshot = self.manager.snapshot()
        snapshot['performance']['workers'] = 16
        self.assertEqual(self.manager.snapshot()['performance']['workers'], 1)

    async def test_compression_defaults_to_size_and_persists_independently(self):
        self.assertEqual(self.manager.snapshot()['compression'], 'size')
        await self.manager.set_compression('speed')
        recovered = JobManager(self.store, JobStore(self.journal.path))
        self.assertEqual(recovered.snapshot()['compression'], 'speed')
        for value in (None, 'lossy', 20, {}, []):
            with self.assertRaises(ValueError):
                await recovered.set_compression(value)
        self.assertEqual(self.journal.compression(), 'speed')
        await recovered.set_compression('size')
        self.assertEqual(self.journal.compression(), 'size')
        self.assertEqual(self.journal.performance(), {'mode': 'normal', 'cpu_target': None, 'workers': 1})
