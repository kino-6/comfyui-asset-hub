from pathlib import Path
from contextlib import closing
import tempfile
import threading
import unittest

from background import BackgroundLimit
from job_store import JobStore
from jobs import run_parallel


class DurableJobsTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.path = Path(temp.name) / 'jobs.sqlite3'
        self.db = JobStore(self.path)

    def test_restart_recovers_only_unfinished_items_and_settings(self):
        self.db.set_background(False)
        job = self.db.create('archive', [{'name': str(i)} for i in range(4)], 2, False, lambda _: [1])
        self.db.state(job['id'], 'running')
        iterator = self.db.items(job['id'])
        first = next(iterator)
        self.db.complete(job['id'], first, {'id': 'record'}, None)
        next(iterator)  # Claimed when the process was interrupted.
        iterator.close()
        recovered = JobStore(self.path)
        self.assertFalse(recovered.background())
        self.assertEqual(recovered.get(job['id'])['status'], 'paused')
        self.assertEqual(recovered.get(job['id'])['done'], 1)
        resumed = recovered.resume(job['id'], False, lambda _: [1])
        self.assertEqual(resumed['remaining'], 3)
        self.assertEqual([task['value']['name'] for task in recovered.items(job['id'])], ['1', '2', '3'])
        with self.assertRaises(ValueError):
            recovered.resume(job['id'], False, lambda _: [1])

    def test_performance_settings_survive_restart_and_update_active_jobs(self):
        self.assertEqual(self.db.performance(), dict(cpu_target=70, workers=4))
        job = self.db.create('archive', [{'name': 'a'}], 4, True, lambda _: None)
        self.db.state(job['id'], 'running')
        self.db.set_performance(90, 16)
        self.assertEqual(self.db.get(job['id'])['workers'], 16)
        recovered = JobStore(self.path)
        self.assertEqual(recovered.performance(), dict(cpu_target=90, workers=16))
        recovered.set_performance(None, 8)
        self.assertEqual(JobStore(self.path).performance(), dict(cpu_target=None, workers=8))
        recovered.set_background(True)
        self.assertEqual(recovered.performance(), dict(cpu_target=90, workers=8))

    def test_all_errors_persist_and_retry_excludes_successes(self):
        job = self.db.create('archive', [{'name': str(i)} for i in range(127)], 4, True, lambda _: [1])
        for task in self.db.items(job['id']):
            error = 'broken' if task['_task_seq'] <= 125 else None
            self.db.complete(job['id'], task, None if error else {'id': str(task['_task_seq'])}, error)
        self.db.state(job['id'], 'done')
        recovered = JobStore(self.path)
        self.assertEqual(recovered.errors(job['id'])['total'], 125)
        self.assertEqual(len(recovered.errors(job['id'])['errors']), 100)
        self.assertEqual(len(recovered.errors(job['id'], 100)['errors']), 25)
        resumed = recovered.resume(job['id'], True, lambda _: [2])
        self.assertEqual(resumed['done'], 2)
        retry = list(recovered.items(job['id']))
        self.assertEqual(len(retry), 125)
        self.assertTrue(all(task['fingerprint'] == [2] for task in retry))
        self.assertTrue(all(task['_task_seq'] <= 125 for task in retry))

    def test_cancel_preserves_unsubmitted_tasks_for_resume(self):
        job = self.db.create('archive', [{'name': str(i)} for i in range(20)], 1, True, lambda _: None)
        cancel = threading.Event()
        def process(task):
            cancel.set()
            return {'id': task['value']['name']}
        run_parallel(job, self.db.items(job['id']), process, cancel, 1,
                     completed=lambda task, record, error: self.db.complete(job['id'], task, record, error))
        self.db.state(job['id'], 'paused')
        self.assertEqual(self.db.get(job['id'])['remaining'], 19)
        resumed = self.db.resume(job['id'], False, lambda _: None)
        self.assertEqual(resumed['done'], 1)

    def test_existing_journal_migrates_names_without_losing_errors(self):
        job = self.db.create('archive', [{'name': 'original.png'}], 1, True, lambda _: None)
        task = next(self.db.items(job['id']))
        self.db.complete(job['id'], task, None, 'broken')
        with closing(self.db.connect()) as db:
            db.execute('ALTER TABLE tasks DROP COLUMN name')
            db.commit()
        recovered = JobStore(self.path)
        self.assertEqual(recovered.get(job['id'])['error_count'], 1)
        self.assertEqual(recovered.errors(job['id'])['errors'][0]['name'], 'original.png')

    def test_zero_capacity_does_not_claim_tasks_and_can_cancel(self):
        job = self.db.create('archive', [{'name': 'a'}], 1, True, lambda _: None)
        cancel, called = threading.Event(), threading.Event()
        def limit():
            called.set()
            return 0
        worker = threading.Thread(target=run_parallel, args=(job, self.db.items(job['id']), lambda _: self.fail('must not run'), cancel, 1), kwargs={'limit': limit})
        worker.start()
        self.assertTrue(called.wait(3))
        with closing(self.db.connect()) as db:
            self.assertEqual(db.execute('SELECT state FROM tasks').fetchone()[0], 'pending')
        cancel.set()
        worker.join(3)
        self.assertFalse(worker.is_alive())


class BackgroundTests(unittest.TestCase):
    def test_cpu_memory_and_recovery(self):
        sample = [0, 4 * 1024**3]
        clock = [0]
        job = dict(workers=4, background=True)
        gate = BackgroundLimit(job, lambda: tuple(sample), lambda: clock[0])
        self.assertEqual(gate(), 2)
        for now in (2, 4):
            clock[0] = now
            limit = gate()
        self.assertEqual(limit, 4)
        sample[0], clock[0] = 95, 6
        self.assertEqual(gate(), 1)
        clock[0] = 8
        self.assertEqual(gate(), 0)
        self.assertIn('CPU', job['wait_reason'])
        sample[:], clock[0] = [0, 100], 10
        self.assertEqual(gate(), 0)
        self.assertIn('メモリ', job['wait_reason'])
        job['background'] = False
        self.assertEqual(gate(), 0)
        sample[:], clock[0] = [0, 4 * 1024**3], 12
        self.assertEqual(gate(), 4)
        self.assertEqual(job['wait_reason'], '')

    def test_target_changes_ramp_up_without_waiting_for_low_cpu_below_60(self):
        now, sample = [0], [65, 4 * 1024**3]
        job = dict(workers=16, background=True, cpu_target=90)
        gate = BackgroundLimit(job, lambda: tuple(sample), lambda: now[0])
        self.assertEqual(gate(), 2)
        for second, expected in [(2, 5), (4, 8), (6, 11), (8, 14), (10, 16)]:
            now[0] = second
            self.assertEqual(gate(), expected)
        self.assertEqual(job['cpu_percent'], 65)
        job['cpu_target'] = 30
        self.assertEqual(gate(), 12)
        now[0] = 12
        self.assertEqual(gate(), 8)
        job['background'] = False
        self.assertEqual(gate(), 16)
        job['workers'] = 4
        self.assertEqual(gate(), 4)

    def test_target_deadband_and_full_speed(self):
        now, sample = [0], [70, 4 * 1024**3]
        job = dict(workers=8, background=True, cpu_target=70)
        gate = BackgroundLimit(job, lambda: tuple(sample), lambda: now[0])
        for second, cpu in [(2, 67), (4, 73), (6, 70)]:
            now[0], sample[0] = second, cpu
            self.assertEqual(gate(), 2)
        job['background'] = False
        self.assertEqual(gate(), 8)

    def test_running_images_finish_when_resource_limit_blocks_new_submissions(self):
        stop, first, release, completed = (threading.Event() for _ in range(4))
        capacity = [1]
        consumed = []
        job = dict(done=0, succeeded=0, error_count=0, errors=[], results=[], total=2)
        def items():
            for i in range(2):
                consumed.append(i)
                yield i
        def process(item):
            first.set()
            release.wait(3)
            return item
        worker = threading.Thread(target=run_parallel, args=(job, items(), process, stop, 2), kwargs={'limit': lambda: capacity[0], 'completed': lambda *args: completed.set()})
        worker.start()
        self.assertTrue(first.wait(3))
        capacity[0] = 0
        release.set()
        self.assertTrue(completed.wait(3))
        self.assertEqual(consumed, [0])
        capacity[0] = 2
        worker.join(4)
        self.assertFalse(worker.is_alive())
        self.assertEqual(job['done'], 2)


if __name__ == '__main__':
    unittest.main()
