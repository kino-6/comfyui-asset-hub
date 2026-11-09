"""Reserve estimated temporary space per filesystem before admitting an image."""
import ctypes
import hashlib
import io
from ctypes import wintypes
from pathlib import Path
import os
import shutil

from PIL import Image


MIB = 1024 * 1024
HEADROOM = 64 * MIB
PNG_SCAN_BUFFER = MIB


def volume(path):
    path = Path(path).resolve()
    while not path.exists():
        path = path.parent
    if os.name != 'nt':
        return str(path.stat().st_dev), path
    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    mount, identity = ctypes.create_unicode_buffer(32768), ctypes.create_unicode_buffer(32768)
    get_mount = kernel.GetVolumePathNameW
    get_mount.argtypes = [wintypes.LPCWSTR, wintypes.LPWSTR, wintypes.DWORD]
    get_mount.restype = wintypes.BOOL
    if not get_mount(str(path), mount, len(mount)):
        raise ctypes.WinError(ctypes.get_last_error())
    get_identity = kernel.GetVolumeNameForVolumeMountPointW
    get_identity.argtypes = [wintypes.LPCWSTR, wintypes.LPWSTR, wintypes.DWORD]
    get_identity.restype = wintypes.BOOL
    # UNC shares do not necessarily expose a volume GUID.
    key = identity.value if get_identity(mount.value, identity, len(identity)) else mount.value
    return key.casefold(), path


def png_budget(path, data=None):
    """Read dimensions/metadata without decoding pixels or seeking per PNG chunk.

    Small read/seek pairs serialize admission and are costly on slower volumes.
    Consume IDAT in bounded, sequential buffers so the OS can read ahead.
    """
    with Image.open(io.BytesIO(data) if data is not None else path) as image:
        width, height = image.size
        if image.format != 'PNG' or image.mode not in ('RGB', 'RGBA') or max(width, height) > 16383:
            raise ValueError('圧縮対象外の画像です。')
        metadata = sum(len(value.encode('utf-8')) if isinstance(value, str) else len(value) if isinstance(value, bytes) else 0
                       for value in image.info.values())
    ancillary = 0
    with (io.BytesIO(data) if data is not None else open(path, 'rb', buffering=PNG_SCAN_BUFFER)) as stream:
        if stream.read(8) != b'\x89PNG\r\n\x1a\n':
            raise ValueError('PNGではありません。')
        length = len(data) if data is not None else os.fstat(stream.fileno()).st_size
        position = 8
        while position + 12 <= length:
            header = stream.read(8)
            if len(header) != 8:
                raise ValueError('PNGが途中で切れています。')
            count = int.from_bytes(header[:4], 'big')
            position += count + 12
            if position > length:
                raise ValueError('PNGが途中で切れています。')
            if header[4:] == b'acTL':
                raise ValueError('アニメーションPNGは対象外です。')
            if header[4:] == b'IHDR':
                if count != 13:
                    raise ValueError('圧縮対象外の画像です。')
                ihdr = stream.read(count)
                if len(ihdr) != 13 or ihdr[8] != 8 or ihdr[9] not in (2, 6):
                    raise ValueError('圧縮対象外の画像です。')
                remaining = 4
            else:
                remaining = count + 4
            if header[4:] not in (b'IDAT', b'IHDR', b'IEND'):
                ancillary += count + 12
            while remaining:
                block = stream.read(min(remaining, PNG_SCAN_BUFFER))
                if not block:
                    raise ValueError('PNGが途中で切れています。')
                remaining -= len(block)
            if header[4:] == b'IEND':
                break
        else:
            raise ValueError('PNGが途中で切れています。')
    metadata = max(metadata * 3, ancillary * 2) + MIB
    return int(width * height * 4 * 1.1) + metadata, metadata


def requirements(store, action, item, prepared_task=None):
    if action == 'discard':
        return []
    if isinstance(item, dict):
        source = Path(store.resolve(item))
        records = store.for_items([item])
        record = records[0] if records else None
        if record and record['state'] == 'placing':
            return [(source.parent, record['webp_bytes']), (store.directory, MIB)]
        if not source.is_file():
            return []  # Normal processing reports missing files or skips converted ones.
        if action == 'archive' and record and record.get('no_saving_current'):
            with source.open('rb') as stream:
                if hashlib.file_digest(stream, 'sha256').hexdigest() == record['source_hash']:
                    return []
        try:
            snapshot = store.read_input_snapshot(source) if prepared_task is not None else None
            candidate, metadata = png_budget(source, snapshot['data'] if snapshot else None)
        except (OSError, ValueError, SyntaxError):
            return []  # Invalid images fail without creating an output file.
        if snapshot:
            prepared_task['_input_snapshot'] = snapshot
        # The metadata record and SQLite journal can coexist with the candidate.
        plan = [(store.stage, candidate + 2 * metadata)]
        if action == 'archive':
            plan.append((source.parent, candidate))
        return plan
    record = store.get(item)
    if action == 'commit':
        return [(store.source(record, True).parent, record['webp_bytes']), (store.directory, MIB)] if record['state'] != 'compacted' else []
    if action == 'restore' and record['state'] != 'restored':
        metadata = sum(len(value) for value in record.get('before', []) + record.get('after', [])) + MIB
        png = int(record['width'] * record['height'] * 4 * 1.1) + metadata
        return [(store.cache, png), (store.source(record).parent, png)]
    return []


class DiskReservations:
    def __init__(self, plan, space=shutil.disk_usage, identify=volume, headroom=HEADROOM):
        self.plan, self.space, self.identify, self.headroom = plan, space, identify, headroom
        self.held = {}
        self.preview = None
        self.reason = ''

    def acquire(self, item):
        token = id(item)
        if not self.preview or self.preview[0] != token:
            grouped = {}
            for path, amount in self.plan(item):
                key, existing = self.identify(path)
                previous = grouped.get(key, (existing, 0))[1]
                grouped[key] = (existing, previous + amount)
            self.preview = token, grouped
        grouped = self.preview[1]
        for key, (path, amount) in grouped.items():
            reserved = sum(plan.get(key, (path, 0))[1] for plan in self.held.values())
            free = self.space(path).free
            required = self.headroom + reserved + amount
            if free < required:
                label = Path(path).drive or str(path)
                self.reason = f'空き容量待ち · {label} 必要 {required / 1e6:.0f} MB / 空き {free / 1e6:.0f} MB'
                if self.held:
                    self.reason += f'（{len(self.held)}枚処理中）'
                return False
        self.held[token] = grouped
        self.preview = None
        self.reason = ''
        return True

    def release(self, item):
        self.held.pop(id(item), None)
