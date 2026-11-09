"""Bound new CPU work by measured CPU load and available system memory."""
import time
import math

import psutil


def sample_load():
    return psutil.cpu_percent(interval=None), psutil.virtual_memory().available


class BackgroundLimit:
    def __init__(self, job, sample=sample_load, clock=time.monotonic):
        self.job, self.sample, self.clock = job, sample, clock
        self.next_sample = self.clock() + 2
        self.capacity = min(2, job['workers'])
        self.cpu = 0
        _, self.available = self.sample()  # Establish the per-thread sampling baseline.
        self.settings = self.configuration()

    def configuration(self):
        mode = self.job.get('mode', 'cpu' if self.job.get('background', False) else 'normal')
        return mode, self.job.get('cpu_target', 70), self.job['workers']

    def __call__(self):
        settings = self.configuration()
        adjust = settings != self.settings
        self.settings = settings
        mode, target, workers = settings
        if self.clock() >= self.next_sample:
            self.next_sample = self.clock() + 2
            self.cpu, self.available = self.sample()
            self.job['cpu_percent'] = round(self.cpu, 1)
            adjust = True
        if self.available < 1024**3:
            self.capacity = 0
            self.job['wait_reason'] = 'メモリの空きを待機中'
            return 0
        if mode != 'cpu':
            self.capacity = workers
            self.job['wait_reason'] = ''
            return workers
        if adjust:
            difference = target - self.cpu
            if difference >= 5:
                self.capacity += min(4, math.ceil(difference / 10))
            elif difference <= -5:
                self.capacity -= max(1, math.ceil(-difference / 10))
        self.capacity = max(0, min(workers, self.capacity))
        self.job['wait_reason'] = 'CPUの空きを待機中' if not self.capacity else ''
        return self.capacity
