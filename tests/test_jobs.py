import importlib.util
from pathlib import Path
import threading
import unittest
from work_progress import report, reporter

spec = importlib.util.spec_from_file_location('hub_jobs_test', Path(__file__).resolve().parents[1] / 'jobs.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class ParallelTests(unittest.TestCase):
    def test_per_image_progress_is_separate_and_cleared_after_failure(self):
        ready, release = threading.Barrier(3), threading.Event()
        job = self.job()
        def process(item):
            report('圧縮中', item['percent'])
            report('圧縮中', item['percent'] - 10)
            ready.wait(3)
            release.wait(3)
            if item['name'] == 'b.png':
                raise ValueError('test failure')
            return item
        items = [dict(name='a.png', percent=35), dict(name='b.png', percent=70)]
        thread = threading.Thread(target=module.run_parallel, args=(job, items, process, threading.Event(), 2))
        thread.start()
        try:
            ready.wait(3)
            import time
            until = time.monotonic() + 3
            while len(job.get('progress', [])) != 2 and time.monotonic() < until:
                time.sleep(.01)
            rows = {r['name']: r for r in job['progress']}
            self.assertEqual(rows['a.png']['percent'], 35)
            self.assertEqual(rows['b.png']['percent'], 70)
            self.assertNotEqual(rows['a.png']['slot'], rows['b.png']['slot'])
            self.assertIsNone(reporter())
        finally:
            release.set()
            thread.join(4)
        self.assertFalse(thread.is_alive())
        self.assertEqual(job['progress'], [])
        self.assertEqual(job['error_count'], 1)

    def job(self):
        return dict(done=0, succeeded=0, error_count=0, errors=[], results=[])

    def test_parallel_workers_overlap_and_one_error_does_not_stop_others(self):
        barrier = threading.Barrier(4)
        def process(item):
            barrier.wait(timeout=5)
            if item == 2:
                raise ValueError('bad image')
            return item
        job = self.job()
        module.run_parallel(job, range(4), process, threading.Event(), 4)
        self.assertEqual(job['succeeded'], 3)
        self.assertEqual(job['error_count'], 1)
        self.assertEqual(job['done'], 4)

    def test_cancel_does_not_consume_the_remaining_folder_iterator(self):
        stop = threading.Event()
        barrier = threading.Barrier(4)
        consumed = []
        def items():
            for i in range(10000):
                consumed.append(i)
                yield i
        def process(item):
            barrier.wait(timeout=5)
            stop.set()
            return item
        job = self.job()
        module.run_parallel(job, items(), process, stop, 4)
        self.assertEqual(len(consumed), 4)
        self.assertEqual(job['status'], 'cancelled')
        self.assertEqual(job['done'], 4)

    def test_live_worker_increase_and_decrease_without_restarting_job(self):
        job = self.job()
        first, four, release, stop = (threading.Event() for _ in range(4))
        lock = threading.Lock()
        entered = []
        def process(item):
            with lock:
                entered.append(item)
                first.set()
                if len(entered) == 4:
                    four.set()
            release.wait(5)
            return item
        thread = threading.Thread(target=module.run_parallel, args=(job, range(5), process, stop, 1),
                                  kwargs={'limit': lambda: job['workers']})
        thread.start()
        try:
            self.assertTrue(first.wait(3))
            job['workers'] = 4
            self.assertTrue(four.wait(3))
            job['workers'] = 0
            release.set()
            stop.set()
        finally:
            release.set()
            stop.set()
            thread.join(5)
        self.assertFalse(thread.is_alive())
        self.assertCountEqual(entered, [0, 1, 2, 3])
        self.assertEqual(job['done'], 4)
