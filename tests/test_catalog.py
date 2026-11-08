import importlib.util
import json
from pathlib import Path
import tempfile
import unittest


spec = importlib.util.spec_from_file_location('hub_catalog_test', Path(__file__).resolve().parents[1] / 'catalog.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class CatalogTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.files = self.root / 'images'
        self.files.mkdir()
        self.catalog = module.Catalog(self.root / 'index', lambda _: self.files, {'images': {'.png', '.jpg'}, 'videos': {'.mp4'}})
        self.scope = dict(type='hub:test', subfolder='', recursive=False)

    def test_global_search_and_page_boundaries(self):
        for i in range(513):
            (self.files / f'image-{i:04}.png').touch()
        snapshot = self.catalog.scan(self.scope)
        pages = [self.catalog.page(snapshot, dict(offset=n, sortKey='name', sortDir='asc')) for n in (0, 200, 400)]
        self.assertEqual([len(p['files']) for p in pages], [200, 200, 113])
        self.assertEqual(len({f['name'] for p in pages for f in p['files']}), 513)
        self.assertEqual(self.catalog.page(snapshot, dict(query='0512'))['total'], 1)

    def test_selection_snapshot_survives_refresh_but_stale_new_selection_is_rejected(self):
        (self.files / 'before.png').touch()
        old = self.catalog.scan(self.scope)
        total, items = self.catalog.selected(old['token'], {})
        (self.files / 'after.png').touch()
        self.catalog.scan(self.scope, refresh=True)
        self.assertEqual(total, 1)
        self.assertEqual([i['name'] for i in items], ['before.png'])
        with self.assertRaises(ValueError):
            self.catalog.selected(old['token'], {})

    def test_literal_search_recursive_png_selection_and_video_filter(self):
        nested = self.files / '日本語'
        nested.mkdir()
        (nested / '100%_画像.png').touch()
        (nested / 'other.jpg').touch()
        (nested / 'movie.mp4').touch()
        snapshot = self.catalog.scan({**self.scope, 'recursive': True})
        self.assertEqual(self.catalog.page(snapshot, {'query': '%_'})['total'], 1)
        total, items = self.catalog.selected(snapshot['token'], {'query': '日本語'})
        self.assertEqual(total, 1)
        self.assertEqual(next(items)['subfolder'], '日本語')
        items.close()
        self.assertEqual(self.catalog.page(snapshot, {'kind': 'videos'})['png_count'], 0)

    def test_symlink_outside_root_is_not_indexed(self):
        outside = self.root / 'outside'
        outside.mkdir()
        (outside / 'private.png').touch()
        try:
            (self.files / 'link').symlink_to(outside, target_is_directory=True)
        except OSError:
            self.skipTest('symlink permission unavailable')
        snapshot = self.catalog.scan({**self.scope, 'recursive': True})
        self.assertEqual(snapshot['count'], 0)
