"""Pinned Windows libwebp tools; no shell, downloads, or codec fallback on errors."""
import ctypes
from contextlib import contextmanager, ExitStack
from ctypes import wintypes
from pathlib import Path
import platform
import os
import re
import subprocess
import sys
import time
import threading
if __package__:
    from .work_progress import reporter, report
else:
    from work_progress import reporter, report


TOOLS = Path(__file__).resolve().parent / 'vendor/libwebp/windows-x64/bin'
# Fixed, measured lossless effort profile. These values never change pixels.
METHOD = 1
QUALITY = 50
_priority = threading.local()


@contextmanager
def background_priority(enabled):
    _priority.background = enabled
    try:
        yield
    finally:
        _priority.background = False


def supported():
    return sys.platform == 'win32' and platform.machine().lower() in ('amd64', 'x86_64')


class ProgressPipe:
    """Drain cwebp diagnostics while communicate handles stdin and timeout."""
    def __init__(self, callback):
        self.callback = callback
        self.tail = bytearray()

    def __enter__(self):
        read_fd, write_fd = os.pipe()
        self.reader, self.writer = os.fdopen(read_fd, 'rb'), os.fdopen(write_fd, 'wb')
        self.thread = threading.Thread(target=self.drain, daemon=True, name='asset-hub-codec-progress')
        self.thread.start()
        return self

    def drain(self):
        pending = b''
        while chunk := self.reader.read1(4096):
            self.tail.extend(chunk)
            del self.tail[:-16384]
            lines = re.split(rb'[\r\n]', pending + chunk)
            pending = lines.pop()[-4096:]
            for line in lines:
                match = re.match(rb'^\[[^\r\n]*\]:\s*(\d{1,3})\s*%', line)
                if match:
                    self.callback('圧縮中', min(100, int(match[1])))

    def __exit__(self, *args):
        self.writer.close()
        self.thread.join()
        self.reader.close()


def run_tool(name, arguments, stage, data=None, timeout=300):
    tool = TOOLS / (name + '.exe')
    if not tool.is_file():
        raise ValueError(f'{stage}: 同梱の{name}.exeがありません。素材庫を再配置してください。原本を保持しました。')
    try:
        with ExitStack() as resources:
            callback = reporter() if name == 'cwebp' else None
            progress = resources.enter_context(ProgressPipe(callback)) if callback else None
            if progress:
                arguments = ['-progress', *(arg for arg in arguments if arg != '-quiet')]
            child = resources.enter_context(subprocess.Popen([str(tool), *map(str, arguments)], stdin=subprocess.PIPE if data is not None else subprocess.DEVNULL,
                              stdout=subprocess.PIPE, stderr=progress.writer if progress else subprocess.PIPE,
                              creationflags=subprocess.CREATE_NO_WINDOW | (subprocess.BELOW_NORMAL_PRIORITY_CLASS if getattr(_priority, 'background', False) else 0)))
            if progress:
                progress.writer.close()  # Only the child now owns the write end.
            try:
                _, stderr = child.communicate(data, timeout=timeout)
            except subprocess.TimeoutExpired:
                child.kill()
                child.communicate()
                raise ValueError(f'{stage}: 制限時間を超えました。原本を保持しました。') from None
            except BaseException:
                child.kill()
                child.communicate()
                raise
            if progress:
                progress.thread.join()
                stderr = bytes(progress.tail)
            if child.returncode:
                detail = stderr.decode('utf-8', errors='replace').strip()[-1000:]
                raise ValueError(f'{stage}: {name}終了コード{child.returncode}。原本を保持しました。{detail}')
            times = [wintypes.FILETIME() for _ in range(4)]
            get_times = ctypes.WinDLL('kernel32', use_last_error=True).GetProcessTimes
            get_times.argtypes = [wintypes.HANDLE] + [ctypes.POINTER(wintypes.FILETIME)] * 4
            get_times.restype = wintypes.BOOL
            if not get_times(int(child._handle), *(ctypes.byref(t) for t in times)):
                raise ctypes.WinError(ctypes.get_last_error())
            return sum((t.dwHighDateTime << 32) + t.dwLowDateTime for t in times[2:]) / 10_000_000
    except OSError as error:
        raise ValueError(f'{stage}: {name}を実行できません。原本を保持しました。{error}') from error


def encode(png, target, exif, icc, timeout=300, *, method=None, quality=None):
    method = METHOD if method is None else method
    quality = QUALITY if quality is None else quality
    start = time.perf_counter()
    report('圧縮中', 0)
    # Encode the already-read immutable PNG snapshot, not a path that may change.
    cpu = run_tool('cwebp', ['-quiet', '-lossless', '-exact', '-q', str(quality), '-m', str(method),
                            '-metadata', 'icc' if icc else 'none', '-o', target, '--', '-'],
                   'WebP圧縮', png, timeout)
    metadata = target.with_suffix('.exif')
    exif_bytes = exif.tobytes()
    # Match Pillow's WebP EXIF payload (TIFF data, without JPEG's EXIF marker).
    if exif_bytes.startswith(b'Exif\x00\x00'):
        exif_bytes = exif_bytes[6:]
    try:
        report('生成情報を保存中')
        try:
            metadata.write_bytes(exif_bytes)
        except OSError as error:
            raise ValueError(f'付随情報の一時保存: 書き込めません。原本を保持しました。{error}') from error
        cpu += run_tool('webpmux', ['-set', 'exif', metadata, target, '-o', target],
                        '生成情報の埋め込み', timeout=timeout)
    finally:
        metadata.unlink(missing_ok=True)
    return dict(backend='cwebp-1.6.0-windows-x64', method=method, quality=quality, lossless=True, exact=True,
                seconds=round(time.perf_counter() - start, 4), child_cpu_seconds=round(cpu, 4))
