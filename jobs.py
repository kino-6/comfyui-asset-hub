from concurrent.futures import FIRST_COMPLETED, Future, ThreadPoolExecutor, wait
import time
if __package__:
    from .work_progress import WorkProgress
else:
    from work_progress import WorkProgress


def run_parallel(job, items, process, cancel, workers, limit=None, completed=None, admission=None):
    """Only keep workers futures alive; the folder iterator can contain millions."""
    iterator = iter(items)
    exhausted = False
    started = time.monotonic()
    previous_elapsed = job.get('elapsed_s', 0)
    job['started'] = started
    job['workers'] = workers
    job['running'] = []
    progress = WorkProgress()
    job['progress'] = []
    unset = object()
    pending_item = unset
    try:
        # Threads are created lazily; the live setting controls actual admission.
        with ThreadPoolExecutor(max_workers=16, thread_name_prefix='asset-hub') as pool:
            active = {}
            while active or not exhausted:
                admission_waiting = False
                capacity = max(0, min(16, job['workers'], limit() if limit else job['workers']))
                job['active_limit'] = capacity
                while not exhausted and len(active) < capacity and not cancel.is_set():
                    if pending_item is unset:
                        try:
                            pending_item = next(iterator)
                        except StopIteration:
                            exhausted = True
                            break
                    item = pending_item
                    try:
                        previous_reason = admission.reason if admission else ''
                        if admission and not admission.acquire(item):
                            job['wait_reason'] = admission.reason
                            admission_waiting = True
                            break
                        if previous_reason and job.get('wait_reason') == previous_reason:
                            job['wait_reason'] = ''
                    except Exception as error:
                        future = Future()
                        future.set_exception(ValueError(f'処理開始前の確認に失敗しました。原本を保持しました。{error}'))
                    else:
                        future = pool.submit(progress.run, process, item)
                    active[future] = item
                    pending_item = unset
                    # Check completed work and publish progress between admissions.
                    # Filling all 16 slots first can hide completions for seconds
                    # when a folder iterator or space preflight performs slow I/O.
                    break
                job['running'] = [item['value'] if isinstance(item, dict) and '_task_seq' in item else item for item in active.values()]
                job['progress'] = progress.snapshot()
                if cancel.is_set():
                    exhausted = True
                if not active:
                    if exhausted:
                        break
                    cancel.wait(.25)
                    continue
                can_submit = not exhausted and not cancel.is_set() and not admission_waiting and len(active) < capacity
                finished, _ = wait(active, return_when=FIRST_COMPLETED, timeout=0 if can_submit else 0.2)
                for future in finished:
                    item = active.pop(future)
                    if admission:
                        admission.release(item)
                    record, failure = None, None
                    try:
                        record = future.result()
                        job['results'].append(record)
                        job['results'] = job['results'][-20:]
                        if isinstance(record, dict) and record.get('skipped'):
                            job['skipped'] = job.get('skipped', 0) + 1
                            if record.get('state') == 'not_smaller':
                                job['not_smaller'] = job.get('not_smaller', 0) + 1
                        else:
                            job['succeeded'] += 1
                    except Exception as error:
                        failure = str(error)
                        value = item['value'] if isinstance(item, dict) and '_task_seq' in item else item
                        name = value.get('name', '') if isinstance(value, dict) else str(value)
                        job['errors'].append(dict(name=name, error=str(error)))
                        job['errors'] = job['errors'][-20:]
                        job['error_count'] += 1
                    job['done'] += 1
                    if completed:
                        completed(item, record, failure)
                if job.get('total') is not None and job['done'] >= job['total']:
                    exhausted = True
                job['elapsed_s'] = round(previous_elapsed + time.monotonic()-started, 2)
            job['status'] = 'cancelled' if cancel.is_set() else 'done'
    finally:
        job['running'] = []
        job['progress'] = []
        if hasattr(iterator, 'close'):
            iterator.close()
