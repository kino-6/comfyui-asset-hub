"""Reserve estimated temporary space per filesystem before admitting an image."""
import ctypes
import hashlib
from ctypes import wintypes
from pathlib import Path
import os
import shutil

from PIL import Image


MIB = 1024 * 1024
HEADROOM = 64 * MIB


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


def png_budget(path):
    """Read dimensions/metadata, without decoding the image's pixels."""
    with Image.open(path) as image:
        width, height = image.size
        if image.format != 'PNG' or image.mode not in ('RGB', 'RGBA') or max(width, height) > 16383:
            raise ValueError('圧縮対象外の画像です。')
        metadata = sum(len(value.encode('utf-8')) if isinstance(value, str) else len(value) if isinstance(value, bytes) else 0
                       for value in image.info.values())
    ancillary = 0
    with open(path, 'rb') as stream:
        if stream.read(8) != b'\x89PNG\r\n\x1a\n':
            raise ValueError('PNGではありません。')
        length = path.stat().st_size
        while stream.tell() + 12 <= length:
            header = stream.read(8)
            count = int.from_bytes(header[:4], 'big')
            if stream.tell() + count + 4 > length:
                raise ValueError('PNGが途中で切れています。')
            if header[4:] == b'acTL':
                raise ValueError('アニメーションPNGは対象外です。')
            if header[4:] == b'IHDR':
                data = stream.read(count)
                if count != 13 or data[8] != 8 or data[9] not in (2, 6):
                    raise ValueError('圧縮対象外の画像です。')
                stream.seek(4, 1)
                continue
            if header[4:] not in (b'IDAT', b'IHDR', b'IEND'):
                ancillary += count + 12
            stream.seek(count + 4, 1)
            if header[4:] == b'IEND':
                break
    metadata = max(metadata * 3, ancillary * 2) + MIB
    return int(width * height * 4 * 1.1) + metadata, metadata


def requirements(store, action, item):
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
            candidate, metadata = png_budget(source)
        except (OSError, ValueError, SyntaxError):
            return []  # Invalid images fail without creating an output file.
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
