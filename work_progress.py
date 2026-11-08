"""Bounded, in-memory per-image telemetry; never stored in the job journal."""
from contextlib import contextmanager
import threading
import time

_local = threading.local()


def reporter():
    return getattr(_local, 'callback', None)


def report(phase, percent=None, name=None):
    callback = reporter()
    if callback:
        callback(phase, percent, name)


@contextmanager
def reporting(callback):
    previous = reporter()
    _local.callback = callback
    try:
        yield
    finally:
        _local.callback = previous


class WorkProgress:
    def __init__(self):
        self.lock = threading.Lock()
        self.active = {}

    def run(self, process, item):
        value = item.get('value', item) if isinstance(item, dict) else item
        name = value.get('name', '') if isinstance(value, dict) else str(value)
        with self.lock:
            slot = next(i for i in range(1, 17) if i not in self.active)
            entry = dict(slot=slot, name=name, phase='確認中', percent=None, started=time.monotonic())
            self.active[slot] = entry

        def update(phase, percent=None, name=None):
            with self.lock:
                if self.active.get(slot) is not entry:
                    return
                if percent is not None:
                    percent = max(0, min(100, int(percent)))
                    if phase == entry['phase'] and entry['percent'] is not None:
                        percent = max(percent, entry['percent'])
                entry.update(phase=phase, percent=percent)
                if name is not None:
                    entry['name'] = name
        try:
            with reporting(update):
                return process(item)
        finally:
            with self.lock:
                self.active.pop(slot, None)

    def snapshot(self):
        now = time.monotonic()
        with self.lock:
            return [dict(slot=e['slot'], name=e['name'], phase=e['phase'], percent=e['percent'],
                         elapsed_s=round(now-e['started'], 1)) for _, e in sorted(self.active.items())]
