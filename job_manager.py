"""Application-level job lifecycle, independent of HTTP and ComfyUI.

JobStore owns durable checkpoints; run_parallel owns per-image execution.
This manager owns the current job, queue, cancellation and live settings.
"""
import asyncio
from pathlib import Path
import threading

if __package__:
    from .background import BackgroundLimit
    from .disk_space import DiskReservations, requirements
    from .jobs import run_parallel
    from .native_webp import background_priority
else:
    from background import BackgroundLimit
    from disk_space import DiskReservations, requirements
    from jobs import run_parallel
    from native_webp import background_priority


class JobManager:
    def __init__(self, store, journal):
        self.store = store
        self.journal = journal
        self.store.compression = journal.compression()
        recent = journal.list(limit=1)['jobs']
        self.current = recent[0] if recent else None
        self.pending = []
        self.worker_active = False
        self.cancel = threading.Event()
        self.background = journal.background()
        self.performance = journal.performance()
        self.settings_lock = asyncio.Lock()
        self.worker_task = None

    def snapshot(self):
        return dict(job=dict(self.current) if self.current else None,
                    queue=list(self.pending), background=self.background,
                    performance=dict(self.performance), compression=self.store.compression,
                    attention=self.journal.attention())

    def fingerprint(self, item):
        try:
            path = Path(self.store.resolve(item))
            if not path.exists():
                return None
            stat = path.stat()
            return [stat.st_dev, stat.st_ino, stat.st_size, stat.st_mtime_ns]
        except (ValueError, OSError) as error:
            return dict(error=str(error))

    def label(self, item):
        if isinstance(item, dict):
            return item.get('name', '')
        try:
            return self.store.get(item)['item']['name']
        except ValueError:
            return str(item)

    async def start(self, action, items, total=None, workers=4):
        workers = int(workers)
        if not 1 <= workers <= 16:
            raise ValueError('並列数は1〜16で指定してください。')
        if total is None:
            if not isinstance(items, list) or not items:
                raise ValueError('素材を選択してください。')
            total = len(items)
        if total < 1:
            if hasattr(items, 'close'):
                items.close()
            raise ValueError('対象のPNGがありません。')
        job = await asyncio.to_thread(self.journal.create, action, items, workers,
                                      self.background, self.fingerprint, self.label)
        await self._enqueue(job)
        return job

    async def resume(self, key, retry=False):
        async with self.settings_lock:
            job = await asyncio.to_thread(self.journal.resume, key, retry,
                                          self.fingerprint, self.performance['workers'])
            await self._enqueue(job)
        return job

    async def stop(self):
        self.cancel.set()
        if self.worker_active and self.current:
            self.current['stopping'] = True
        queued = list(self.pending)
        self.pending.clear()
        for job in queued:
            job['status'] = 'paused'
            await asyncio.to_thread(self.journal.state, job['id'], 'paused')

    async def set_compression(self, profile):
        async with self.settings_lock:
            await asyncio.to_thread(self.journal.set_compression, profile)
            self.store.compression = profile
        return dict(compression=profile)

    async def set_background(self, enabled):
        if not isinstance(enabled, bool):
            raise ValueError('有効・無効を指定してください。')
        async with self.settings_lock:
            await asyncio.to_thread(self.journal.set_background, enabled)
            self.background = enabled
            self.performance.update(await asyncio.to_thread(self.journal.performance))
            if self.current:
                self.current.update(background=enabled, cpu_target=self._cpu_target())
        return dict(enabled=self.background)

    async def set_performance(self, target, workers):
        if target is not None and (type(target) is not int or not 10 <= target <= 95):
            raise ValueError('CPU目標は10〜95%、全速はnullで指定してください。')
        if type(workers) is not int or not 1 <= workers <= 16:
            raise ValueError('並列数は1〜16で指定してください。')
        async with self.settings_lock:
            await asyncio.to_thread(self.journal.set_performance, target, workers)
            self.performance.update(cpu_target=target, workers=workers)
            self.background = target is not None
            active = [self.current] if self.current and self.worker_active else []
            for job in active + self.pending:
                job.update(background=self.background, cpu_target=self._cpu_target(), workers=workers)
        return dict(self.performance)

    def _cpu_target(self):
        target = self.performance['cpu_target']
        return target if target is not None else 70

    async def _enqueue(self, job):
        if self.worker_active:
            self.pending.append(job)
        else:
            await self._activate(job)

    async def _activate(self, job):
        self.current = job
        self.worker_active = True
        job.update(status='running', background=self.background, cpu_target=self._cpu_target())
        self.cancel.clear()
        try:
            await asyncio.to_thread(self.journal.state, job['id'], 'running')
        except Exception:
            self.worker_active = False
            job['status'] = 'error'
            raise
        self.worker_task = asyncio.create_task(self._run(job))

    def _process(self, job, task):
        item = task['value']
        if isinstance(item, dict) and self.fingerprint(item) != task['fingerprint']:
            # An earlier queued job may already have replaced this PNG.
            if Path(self.store.resolve(item)).exists():
                raise ValueError('待機中に原本が変更されました。確認後に失敗分を再試行してください。')
        with background_priority(job['background']):
            return self.store.public(getattr(self.store, job['action'])(item))

    def _work(self, job):
        disk = DiskReservations(lambda task: requirements(self.store, job['action'], task['value']))
        run_parallel(
            job, self.journal.items(job['id']), lambda task: self._process(job, task),
            self.cancel, job['workers'], limit=BackgroundLimit(job), admission=disk,
            completed=lambda task, record, error: self.journal.complete(job['id'], task, record, error),
        )

    async def _run(self, job):
        try:
            await asyncio.to_thread(self._work, job)
        except Exception as error:
            job['errors'].append(dict(name=job['name'], error=str(error)))
            job['error_count'] += 1
            job.update(status='error', message=str(error))
        finally:
            if job['status'] == 'cancelled':
                job['status'] = 'paused' if job['done'] < job['total'] else 'done'
            try:
                await asyncio.to_thread(self.journal.state, job['id'], job['status'],
                                        job.get('elapsed_s'), job.get('message', ''))
            finally:
                job['remaining'] = job['total'] - job['done']
                self.worker_active = False
            if self.pending:
                await self._activate(self.pending.pop(0))
