import io
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
import threading
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import patch, MagicMock

from PIL import Image, ImageCms, PngImagePlugin

import native_webp
from work_progress import reporting
from storage import Storage, embedded


@unittest.skipUnless(native_webp.supported(), 'Windows x64 integration')
class NativeWebPTests(unittest.TestCase):
    def test_switch_during_encode_keeps_each_images_profile_and_pixels(self):
        entered, release = threading.Event(), threading.Event()
        encode = native_webp.encode
        def hold_first(*args, **kwargs):
            if kwargs['quality'] == 50:
                entered.set()
                if not release.wait(5):
                    raise TimeoutError('test did not release codec')
            return encode(*args, **kwargs)
        second = {**self.item, 'name': 'speed.png'}
        (self.base / second['name']).write_bytes(self.original)
        with patch.object(native_webp, 'encode', side_effect=hold_first), ThreadPoolExecutor(2) as pool:
            first = pool.submit(self.store.archive, self.item)
            try:
                self.assertTrue(entered.wait(3))
                self.store.compression = 'speed'
                fast = pool.submit(self.store.archive, second).result(4)
            finally:
                release.set()
            size = first.result(4)
        for record, quality in ((size, 50), (fast, 20)):
            self.assertEqual((record['encoding']['method'], record['encoding']['quality']), (1, quality))
            self.assertIn(f'm1-q{quality}-metadata-v1', record['encoder_key'])
            with Image.open(self.store.source(record, True)) as image, Image.open(io.BytesIO(self.original)) as original:
                self.assertEqual(image.tobytes(), original.tobytes())
                self.assertEqual(embedded(image), self.metadata)
                self.assertEqual(image.info['icc_profile'], self.icc)
            self.store.restore(record['id'])
            with Image.open(self.store.source(record)) as restored, Image.open(io.BytesIO(self.original)) as original:
                self.assertEqual(restored.tobytes(), original.tobytes())

    def test_switching_profile_rechecks_no_saving_but_never_existing_webp(self):
        record = self.store.archive(self.item)
        self.store.compression = 'speed'
        with patch.object(native_webp, 'encode', side_effect=AssertionError('existing archive must not be encoded')):
            self.assertEqual(self.store.archive(self.item)['id'], record['id'])
        tiny = {**self.item, 'name': 'tiny.png'}
        path = self.base / tiny['name']
        Image.new('RGB', (8, 8), '#112233').save(path)
        old = self.store.archive(tiny)
        self.assertEqual(old['state'], 'not_smaller')
        self.store.compression = 'size'
        self.assertFalse(self.store.no_saving_current(old, path))
        with patch.object(native_webp, 'encode', wraps=native_webp.encode) as encode:
            new = self.store.archive(tiny)
            self.store.archive(tiny)
            self.assertEqual(encode.call_count, 1)
        self.assertIn('m1-q50', new['encoder_key'])

    def test_live_codec_progress_preserves_bitstream_and_reports_stages(self):
        events = []
        with reporting(lambda phase, percent=None, name=None: events.append((phase, percent, name))):
            record = self.store.archive(self.item)
        values = [percent for phase, percent, _ in events if phase == '圧縮中' and percent is not None]
        self.assertTrue(any(0 < value < 100 for value in values), values)
        self.assertIn('照合中', [e[0] for e in events])
        self.assertIn('保存中', [e[0] for e in events])
        self.assertIn(self.path.name, [e[2] for e in events])
        copy = {**self.item, 'name': 'without-progress.png'}
        (self.base / copy['name']).write_bytes(self.original)
        plain = self.store.archive(copy)
        self.assertEqual(self.store.source(record, True).read_bytes(), self.store.source(plain, True).read_bytes())

    def test_progress_pipe_parses_carriage_returns_and_bounds_diagnostics(self):
        values = []
        with native_webp.ProgressPipe(lambda phase, percent: values.append(percent)) as progress:
            for piece in (b'[-]: 1', b'2 %\r[-]: 44 %\r\n', b'other statistic: 82 %\n', b'x' * 20000):
                progress.writer.write(piece)
                progress.writer.flush()
        self.assertEqual(values, [12, 44])
        self.assertEqual(len(progress.tail), 16384)

    def test_codec_error_with_live_progress_returns_diagnostics(self):
        with reporting(lambda *args: None):
            with self.assertRaisesRegex(ValueError, 'WebP圧縮.*終了コード'):
                native_webp.run_tool('cwebp', ['-invalid-option'], 'WebP圧縮')

    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.base = Path(temp.name)
        self.path = self.base / '日本語 画像.png'
        self.store = Storage(self.base / '保管 場所', lambda item: self.base / item['name'])
        self.item = dict(type='output', subfolder='', name=self.path.name)
        self.icc = ImageCms.ImageCmsProfile(ImageCms.createProfile('sRGB')).tobytes()
        self.metadata = {'workflow': {'nodes': [], 'links': [], 'extra': '日本語'}, 'prompt': {'1': {'class_type': 'Test'}}}
        info = PngImagePlugin.PngInfo()
        for name, value in self.metadata.items():
            info.add_text(name, json.dumps(value, ensure_ascii=False))
        image = Image.new('RGBA', (128, 128), (53, 77, 91, 0))
        image.putpixel((20, 20), (12, 21, 44, 255))
        image.save(self.path, pnginfo=info, icc_profile=self.icc, compress_level=0)
        self.original = self.path.read_bytes()

    def test_native_unicode_icc_metadata_and_pixels_roundtrip(self):
        with patch.object(native_webp, 'run_tool', wraps=native_webp.run_tool) as calls:
            record = self.store.archive(self.item)
        args = next(call.args[1] for call in calls.call_args_list if call.args[0] == 'cwebp')
        self.assertEqual(args[args.index('-m') + 1], '1')
        self.assertEqual(args[args.index('-q') + 1], '50')
        self.assertIn('-lossless', args)
        self.assertIn('-exact', args)
        self.assertNotIn('-near_lossless', args)
        self.assertEqual((record['encoding']['method'], record['encoding']['quality']), (1, 50))
        self.assertIn('lossless-exact-m1-q50-metadata-v1', self.store.encoder_key)
        self.assertEqual(record['encoding']['backend'], 'cwebp-1.6.0-windows-x64')
        with Image.open(self.store.source(record, True)) as image:
            self.assertEqual(image.info['icc_profile'], self.icc)
            self.assertEqual(embedded(image), self.metadata)
        self.store.restore(record['id'])
        with Image.open(self.path) as restored, Image.open(io.BytesIO(self.original)) as original:
            self.assertEqual(restored.tobytes(), original.tobytes())
            self.assertEqual(restored.info['icc_profile'], self.icc)
            for name, value in self.metadata.items():
                self.assertEqual(json.loads(restored.info[name]), value)

    def test_mux_failure_keeps_original_and_cleans_partial_stage(self):
        real_run = native_webp.run_tool
        def fail_mux(name, args, stage, data=None, timeout=300):
            if name == 'webpmux':
                args = ['-invalid-option']
            return real_run(name, args, stage, data=data, timeout=timeout)
        with patch.object(native_webp, 'run_tool', side_effect=fail_mux):
            with self.assertRaisesRegex(ValueError, '生成情報の埋め込み.*終了コード'):
                self.store.archive(self.item)
        self.assertEqual(self.path.read_bytes(), self.original)
        self.assertEqual(list(self.store.stage.iterdir()), [])
        self.assertEqual(self.store.summary()['total'], 0)

    def test_timeout_kills_worker_and_keeps_original(self):
        child = MagicMock()
        child.__enter__.return_value = child
        child.communicate.side_effect = [subprocess.TimeoutExpired('cwebp', 300), (b'', b'')]
        with patch.object(native_webp.subprocess, 'Popen', return_value=child), reporting(lambda *args: None):
            with self.assertRaisesRegex(ValueError, 'WebP圧縮.*制限時間'):
                self.store.archive(self.item)
        child.kill.assert_called_once()
        self.assertEqual(self.path.read_bytes(), self.original)
        self.assertEqual(list(self.store.stage.iterdir()), [])

    def test_missing_binary_does_not_silently_change_encoder(self):
        with patch.object(native_webp, 'TOOLS', self.base / 'absent'):
            with self.assertRaisesRegex(ValueError, 'cwebp.exeがありません'):
                self.store.archive(self.item)
        self.assertEqual(self.path.read_bytes(), self.original)

    def test_metadata_write_failure_keeps_original(self):
        real_write = Path.write_bytes
        def disk_full(path, data):
            if path.suffix == '.exif':
                raise OSError('simulated disk full')
            return real_write(path, data)
        with patch.object(Path, 'write_bytes', disk_full):
            with self.assertRaisesRegex(ValueError, '付随情報の一時保存'):
                self.store.archive(self.item)
        self.assertEqual(self.path.read_bytes(), self.original)
        self.assertEqual(list(self.store.stage.iterdir()), [])

    def test_previous_pillow_archive_can_still_restore(self):
        self.store.encoder = 'pillow'
        record = self.store.archive(self.item)
        self.store.encoder = 'native'
        self.store.restore(record['id'])
        with Image.open(self.path) as restored, Image.open(io.BytesIO(self.original)) as original:
            self.assertEqual(restored.tobytes(), original.tobytes())

    def test_previous_native_archive_is_not_reencoded_and_can_restore(self):
        for method, quality in ((4, 80), (1, 20)):
            with self.subTest(method=method, quality=quality):
                item = {**self.item, 'name': f'previous-m{method}-q{quality}.png'}
                path = self.base / item['name']
                path.write_bytes(self.original)
                with patch.object(native_webp, 'METHOD', method), patch.object(native_webp, 'QUALITY', quality):
                    previous = Storage(self.store.directory, self.store.resolve, encoder='native')
                    record = previous.archive(item)
                self.assertEqual(record['state'], 'compacted')
                self.assertEqual((record['encoding']['method'], record['encoding']['quality']), (method, quality))
                self.assertNotEqual(previous.encoder_key, self.store.encoder_key)
                with patch.object(native_webp, 'encode', side_effect=AssertionError('must not reencode existing WebP')):
                    reused = self.store.archive(item)
                    self.assertEqual(reused['id'], record['id'])
                    self.assertTrue(reused['skipped'])
                    self.store.restore(record['id'])
                with Image.open(path) as restored, Image.open(io.BytesIO(self.original)) as original:
                    self.assertEqual(restored.tobytes(), original.tobytes())

    def test_old_no_saving_result_is_rechecked_once_for_new_profile(self):
        Image.new('RGB', (8, 8), '#112233').save(self.path)
        with patch.object(native_webp, 'METHOD', 1), patch.object(native_webp, 'QUALITY', 20):
            previous = Storage(self.store.directory, self.store.resolve, encoder='native')
            old = previous.archive(self.item)
        self.assertEqual(old['state'], 'not_smaller')
        self.assertFalse(self.store.no_saving_current(old, self.path))
        with patch.object(native_webp, 'encode', wraps=native_webp.encode) as encode:
            current = self.store.archive(self.item)
            self.assertEqual(encode.call_count, 1)
        self.assertEqual(current['state'], 'not_smaller')
        self.assertEqual(current['encoder_key'], self.store.encoder_key)
        with patch.object(native_webp, 'encode', side_effect=AssertionError('must reuse new result')):
            self.assertEqual(self.store.archive(self.item)['id'], current['id'])

    def test_pillow_profile_stays_unchanged(self):
        fallback = Storage(self.base / 'pillow', self.store.resolve, encoder='pillow')
        self.assertIn('lossless-exact-m4-q80-metadata-v1', fallback.encoder_key)
        record = fallback.archive(self.item)
        self.assertEqual((record['encoding']['method'], record['encoding']['quality']), (4, 80))


if __name__ == '__main__':
    unittest.main()
