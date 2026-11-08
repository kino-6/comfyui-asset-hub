from pathlib import Path
import hashlib
import json
import tempfile
import unittest
from unittest.mock import patch

import numpy as np
from PIL import Image, ImageDraw, PngImagePlugin

from relations import RelationIndex, RelationJob, prompt_text, related_graph, terms
from storage import Storage


def make_image(path, color, positive, negative='blue ocean, low quality'):
    image = Image.new('RGB', (96, 96), color)
    ImageDraw.Draw(image).ellipse((20, 20, 70, 70), fill='#eeeeee')
    info = PngImagePlugin.PngInfo()
    graph = {'1': {'class_type': 'CLIPTextEncode', 'inputs': {'text': positive}},
             '2': {'class_type': 'CLIPTextEncode', 'inputs': {'text': negative}},
             '3': {'class_type': 'KSampler', 'inputs': {'positive': ['1', 0], 'negative': ['2', 0]}}}
    info.add_text('prompt', json.dumps(graph))
    image.save(path, pnginfo=info, compress_level=0)


class RelationTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.resolve = lambda item: (item, self.root / item['name'])
        self.index = RelationIndex(self.root, self.resolve)
        self.items = [dict(type='output', subfolder='', name=name+'.png') for name in ('a', 'b', 'c', 'd')]
        make_image(self.root/'a.png', '#b82210', 'red dress, portrait, masterpiece')
        make_image(self.root/'b.png', '#b82210', 'green valley, landscape')
        make_image(self.root/'c.png', '#1022b8', 'red dress, portrait')
        make_image(self.root/'d.png', '#20b840', 'spaceship, galaxy')

    def run_job(self):
        job = RelationJob(len(self.items))
        self.index.run(job, self.items)
        return job

    def test_positive_prompt_excludes_negative_and_quality_only_terms(self):
        with Image.open(self.root/'a.png') as image:
            text, source = prompt_text(image)
        self.assertEqual(source, 'positive')
        self.assertIn('red dress', terms(text))
        self.assertNotIn('ocean', terms(text))
        self.assertNotIn('masterpiece', terms(text))
        self.assertIn('赤い服', terms('赤い服、森、青い空'))

    def test_text_and_visual_connections_have_different_evidence(self):
        job = self.run_job()
        prompt = related_graph(job, mode='prompt')
        self.assertEqual({node['item']['name'] for node in prompt['nodes']}, {'a.png', 'c.png'})
        self.assertIn('red dress', prompt['edges'][0]['common'])
        visual = related_graph(job, mode='visual')
        self.assertEqual({node['item']['name'] for node in visual['nodes']}, {'a.png', 'b.png'})
        self.assertEqual(visual['edges'][0]['common'], [])
        self.assertGreater(visual['edges'][0]['visual'], .99)

    def test_workflow_only_and_parameters_metadata_keep_positive_text(self):
        image = Image.new('RGB', (8, 8))
        image.info['workflow'] = json.dumps(dict(nodes=[
            dict(id=1, type='CLIPTextEncode', inputs=[], widgets_values=['red dress']),
            dict(id=2, type='CLIPTextEncode', inputs=[], widgets_values=['blue ocean']),
            dict(id=3, type='KSampler', inputs=[dict(name='positive', link=5), dict(name='negative', link=6)])],
            links=[[5, 1, 0, 3, 0, 'CONDITIONING'], [6, 2, 0, 3, 1, 'CONDITIONING']]))
        self.assertEqual(prompt_text(image), ('red dress', 'positive'))
        image.info = dict(parameters='赤い服、森\nNegative prompt: 青い海\nSteps: 20')
        self.assertEqual(prompt_text(image), ('赤い服、森', 'positive'))

    def test_recenter_finds_connections_from_new_origin(self):
        job = self.run_job()
        b = next(entry for entry in job.entries if entry['item']['name'] == 'b.png')
        graph = related_graph(job, center=b['id'], mode='visual')
        self.assertEqual(graph['center'], b['id'])
        self.assertEqual(graph['nodes'][0]['item']['name'], 'b.png')
        self.assertIn('a.png', [node['item']['name'] for node in graph['nodes']])

    def test_cached_features_persist_and_changed_image_is_recomputed(self):
        first, cached = self.index.read(self.items[0])
        self.assertFalse(cached)
        reopened = RelationIndex(self.root, self.resolve)
        with patch('relations.describe', side_effect=AssertionError('must reuse features')):
            second, cached = reopened.read(self.items[0])
        self.assertTrue(cached)
        self.assertEqual(first['prompt'], second['prompt'])
        make_image(self.root/'a.png', '#aaff11', 'green leaves')
        changed, cached = reopened.read(self.items[0])
        self.assertFalse(cached)
        self.assertNotEqual(first['prompt'], changed['prompt'])

    def test_managed_webp_keeps_same_prompt_and_visual_features(self):
        png, _ = self.index.read(self.items[0])
        store = Storage(self.root/'storage', lambda item: self.root/item['name'])
        result = store.archive(self.items[0])
        self.assertEqual(result['state'], 'compacted')
        webp, _ = self.index.read({**self.items[0], 'name': result['target_name']})
        self.assertEqual(png['prompt'], webp['prompt'])
        for key in ('color', 'layout', 'shape'):
            np.testing.assert_allclose(png[key], webp[key])

    def test_analysis_is_read_only_and_broken_image_does_not_stop_others(self):
        before = {item['name']: (hashlib.sha256((self.root/item['name']).read_bytes()).hexdigest(), (self.root/item['name']).stat().st_mtime_ns) for item in self.items}
        (self.root/'bad.png').write_bytes(b'broken')
        self.items.insert(1, dict(type='output', subfolder='', name='bad.png'))
        job = self.run_job()
        self.assertEqual((job.done, job.error_count, len(job.entries)), (5, 1, 4))
        for name, (digest, mtime) in before.items():
            self.assertEqual(hashlib.sha256((self.root/name).read_bytes()).hexdigest(), digest)
            self.assertEqual((self.root/name).stat().st_mtime_ns, mtime)

    def test_cancel_stops_after_current_image_and_neighborhood_is_bounded(self):
        job = RelationJob(4)
        original = self.index.read
        def one(item):
            job.cancel.set()
            return original(item)
        with patch.object(self.index, 'read', side_effect=one):
            self.index.run(job, self.items)
        self.assertEqual((job.done, job.status), (1, 'cancelled'))
        resumed = self.run_job()
        self.assertEqual((resumed.done, resumed.cached, resumed.status), (4, 1, 'done'))
        entry = job.entries[0]
        job.entries = [{**entry, 'id': str(i)} for i in range(300)]
        job.frequencies = {term: 300 for term in entry['terms']}
        graph = related_graph(job, center='250')
        self.assertEqual(graph['center'], '250')
        self.assertEqual(len(graph['nodes']), 21)
        self.assertLessEqual(len(graph['edges']), 40)
        another = related_graph(job, center='250', offset=20)
        self.assertEqual(another['related_total'], 299)
        self.assertEqual(another['offset'], 20)
        self.assertFalse({n['id'] for n in graph['nodes'][1:]} & {n['id'] for n in another['nodes'][1:]})


if __name__ == '__main__':
    unittest.main()
