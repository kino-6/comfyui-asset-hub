"""Read-only image relationships: shared prompt terms and visible image features."""
from collections import Counter
from contextlib import closing
import hashlib
import json
import math
import os
from pathlib import Path
import re
import sqlite3
import threading
import uuid

import numpy as np
from PIL import Image, ImageFilter, ImageOps


VERSION = 1
QUALITY = {'masterpiece', 'best quality', 'high quality', 'highres', 'absurdres', 'score_9', 'score_8_up', 'score_7_up'}
TEXT_KEYS = {'text', 'text_g', 'text_l', 'prompt', 'positive_prompt'}


def address(item):
    return json.dumps(item, sort_keys=True, ensure_ascii=False)


def parse_json(value):
    if isinstance(value, dict):
        return value
    try:
        return json.loads(value) if isinstance(value, str) else None
    except (ValueError, TypeError):
        return None


def node_inputs(node):
    inputs = node.get('inputs') if isinstance(node, dict) else None
    return inputs if isinstance(inputs, dict) else {}


def prompt_text(image):
    raw = image.info.get('prompt')
    workflow = parse_json(image.info.get('workflow'))
    exif = image.getexif()
    for tag, prefix in ((272, 'prompt:'), (271, 'workflow:')):
        value = exif.get(tag, '')
        if isinstance(value, str) and value.startswith(prefix):
            if tag == 272 and raw is None:
                raw = value[len(prefix):]
            elif tag == 271 and workflow is None:
                workflow = parse_json(value[len(prefix):])
    graph = parse_json(raw)
    if not isinstance(graph, dict) and isinstance(workflow, dict):
        links = {str(link[0]): [str(link[1]), link[2]] for link in workflow.get('links', []) if isinstance(link, list) and len(link) >= 3}
        graph = {}
        for node in workflow.get('nodes', []):
            if not isinstance(node, dict) or 'id' not in node:
                continue
            inputs = {port['name']: links[str(port['link'])] for port in node.get('inputs', []) if isinstance(port, dict) and str(port.get('link')) in links}
            if 'text' in node.get('type', '').lower() or node.get('type') == 'PrimitiveNode':
                inputs['text'] = '\n'.join(v for v in node.get('widgets_values', []) if isinstance(v, str))
            graph[str(node['id'])] = dict(inputs=inputs)
    if isinstance(graph, dict):
        def trace(value, seen):
            if isinstance(value, str):
                return [value]
            if not isinstance(value, list) or len(value) != 2 or str(value[0]) in seen:
                return []
            key = str(value[0])
            seen.add(key)
            node = graph.get(key, {})
            if not isinstance(node, dict):
                return []
            result = []
            for name, content in node_inputs(node).items():
                if name in TEXT_KEYS and isinstance(content, str):
                    result.append(content)
                elif isinstance(content, list):
                    result.extend(trace(content, seen))
            return result
        positive, conditioned = [], False
        for node in graph.values():
            if not isinstance(node, dict):
                continue
            inputs = node_inputs(node)
            if 'positive' in inputs:
                conditioned = True
                positive.extend(trace(inputs['positive'], set()))
            if isinstance(inputs.get('positive_prompt'), str):
                positive.append(inputs['positive_prompt'])
        if positive or conditioned:
            return '\n'.join(dict.fromkeys(positive))[:16000], 'positive'
        texts = [value for node in graph.values() if isinstance(node, dict)
                 for name, value in node_inputs(node).items() if name in TEXT_KEYS and isinstance(value, str)]
        return '\n'.join(dict.fromkeys(texts))[:16000], 'unknown'
    parameters = image.info.get('parameters', '')
    if isinstance(parameters, str) and parameters:
        return re.split(r'\n(?:Negative prompt:|Steps:)', parameters, maxsplit=1)[0][:16000], 'positive'
    return (raw[:16000], 'unknown') if isinstance(raw, str) else ('', 'none')


def terms(text):
    found = set()
    for phrase in re.split(r'[,;\n|、。]+', text.casefold()):
        phrase = re.sub(r'<[^>]*>|:\s*[\d.]+', ' ', phrase)
        phrase = re.sub(r'[()\[\]{}]', ' ', phrase)
        phrase = ' '.join(phrase.split()).strip()
        if not phrase or phrase in QUALITY:
            continue
        words = re.findall(r'[a-z][a-z0-9_-]+|[\u3040-\u30ff\u3400-\u9fff]+', phrase)
        if len(phrase) <= 80 and len(words) <= 6:
            found.add(phrase)
        found.update(word for word in words if word not in QUALITY)
        if len(found) >= 256:
            break
    return sorted(found)[:256]


def describe(path):
    with Image.open(path) as source:
        if getattr(source, 'n_frames', 1) != 1:
            raise ValueError('関連図は静止画のみ対応しています。')
        text, source_kind = prompt_text(source)
        picture = ImageOps.exif_transpose(source)
        picture.thumbnail((128, 128), Image.Resampling.LANCZOS)
        rgba = picture.convert('RGBA')
        visible = Image.new('RGBA', rgba.size, (128, 128, 128, 255))
        visible.alpha_composite(rgba)
        rgb = visible.convert('RGB')
        hsv = np.asarray(rgb.convert('HSV'), dtype=np.int32)
        bins = (hsv[:, :, 0] // 16) * 16 + (hsv[:, :, 1] // 64) * 4 + hsv[:, :, 2] // 64
        histogram = np.bincount(bins.ravel(), minlength=256).astype(np.float32)
        histogram = np.sqrt(histogram / histogram.sum())
        layout = np.asarray(rgb.resize((8, 8), Image.Resampling.BOX), dtype=np.float32).ravel() / 255
        edges = np.asarray(rgb.convert('L').filter(ImageFilter.FIND_EDGES).resize((8, 8), Image.Resampling.BOX), dtype=np.float32).ravel()
        edges /= max(float(np.linalg.norm(edges)), 1e-8)
        return dict(prompt=text, prompt_source=source_kind, terms=terms(text),
                    color=histogram.tolist(), layout=layout.tolist(), shape=edges.tolist())


class RelationJob:
    def __init__(self, total):
        self.id = uuid.uuid4().hex
        self.total, self.done, self.cached, self.error_count = total, 0, 0, 0
        self.status, self.errors = 'running', []
        self.entries, self.frequencies = [], Counter()
        self.cancel = threading.Event()
        self.lock = threading.Lock()

    def summary(self):
        return dict(id=self.id, status=self.status, total=self.total, done=self.done, cached=self.cached,
                    indexed=len(self.entries), error_count=self.error_count, errors=list(self.errors))


class RelationIndex:
    def __init__(self, directory, resolve):
        self.resolve = resolve
        self.path = Path(directory) / 'relations.sqlite3'
        with closing(sqlite3.connect(self.path)) as db:
            db.execute('PRAGMA journal_mode=WAL')
            db.execute('CREATE TABLE IF NOT EXISTS features (path TEXT PRIMARY KEY, stamp TEXT, payload TEXT, vector BLOB)')
            db.commit()

    def read(self, item):
        item, path = self.resolve(item)
        path = Path(path)
        stat = path.stat()
        stamp = json.dumps([VERSION, stat.st_dev, stat.st_ino, stat.st_size, stat.st_mtime_ns, stat.st_ctime_ns])
        key = os.path.normcase(str(path.resolve()))
        with closing(sqlite3.connect(self.path)) as db:
            row = db.execute('SELECT payload,vector FROM features WHERE path=? AND stamp=?', (key, stamp)).fetchone()
        if row:
            features = json.loads(row[0])
            vector = np.frombuffer(row[1], dtype='<f2').astype(np.float32)
        else:
            features = describe(path)
            after = path.stat()
            if (after.st_size, after.st_mtime_ns, after.st_ino, after.st_ctime_ns) != (stat.st_size, stat.st_mtime_ns, stat.st_ino, stat.st_ctime_ns):
                raise ValueError('解析中に画像が変更されました。再度、関連図を開いてください。')
            vector = np.concatenate([features.pop(name) for name in ('color', 'layout', 'shape')]).astype('<f2')
            with closing(sqlite3.connect(self.path)) as db:
                db.execute('INSERT OR REPLACE INTO features VALUES (?,?,?,?)', (key, stamp, json.dumps(features, ensure_ascii=False), vector.tobytes()))
                db.commit()
            vector = vector.astype(np.float32)
        entry = dict(id=hashlib.sha256(key.encode()).hexdigest()[:24], item=dict(item), **features)
        entry.update(color=vector[:256], layout=vector[256:448], shape=vector[448:])
        entry['terms'] = frozenset(entry['terms'])
        return entry, bool(row)

    def run(self, job, items):
        seen = set()
        try:
            for item in items:
                if job.cancel.is_set():
                    break
                try:
                    entry, cached = self.read(item)
                    with job.lock:
                        if entry['id'] not in seen:
                            job.entries.append(entry)
                            job.frequencies.update(entry['terms'])
                            seen.add(entry['id'])
                        job.cached += int(cached)
                except (OSError, ValueError, KeyError, TypeError, Image.DecompressionBombError) as error:
                    with job.lock:
                        job.error_count += 1
                        job.errors = [*job.errors[-19:], dict(name=item.get('name', ''), error=str(error))]
                with job.lock:
                    job.done += 1
        except Exception as error:
            with job.lock:
                job.status = 'error'
                job.error_count += 1
                job.errors = [*job.errors[-19:], dict(name='関連図の解析', error=str(error))]
        finally:
            with job.lock:
                if job.status != 'error':
                    job.status = 'cancelled' if job.cancel.is_set() else 'done'


def visual_similarity(a, b):
    color = float(np.dot(a['color'], b['color']))
    layout = 1 - float(np.mean(np.abs(a['layout'] - b['layout'])))
    shape = float(np.dot(a['shape'], b['shape']))
    if not np.any(a['shape']) and not np.any(b['shape']):
        shape = 1.0
    visual = min(1.0, .45 * color + .35 * layout + .2 * shape)
    return visual, dict(color=round(color * 100), layout=round(layout * 100), shape=round(shape * 100))


def related_graph(job, center=None, mode='combined', limit=20, offset=0):
    if mode not in ('combined', 'prompt', 'visual'):
        raise ValueError('関連の基準を指定してください。')
    with job.lock:
        entries, frequencies, summary = list(job.entries), dict(job.frequencies), job.summary()
    if not entries:
        return dict(job=summary, center=None, nodes=[], edges=[], related_total=0, offset=0)
    origin = next((entry for entry in entries if entry['id'] == center), entries[0])
    weights = {word: (1 + math.log((len(entries) + 1) / (count + 1))) ** 2 for word, count in frequencies.items()}
    norms = {entry['id']: math.sqrt(sum(weights[word] for word in entry['terms'])) for entry in entries}

    def compare(a, b):
        shared = a['terms'] & b['terms']
        text = sum(weights[word] for word in shared) / max(1e-8, norms[a['id']] * norms[b['id']])
        visual, components = visual_similarity(a, b)
        strength = max(0, (visual - .85) / .15)
        score = text if mode == 'prompt' else strength if mode == 'visual' else max(text, strength)
        phrases = sorted(shared, key=lambda term: (-weights[term], -len(term), term))
        phrases = [phrase for phrase in phrases if not any(phrase != other and phrase in other for other in phrases)][:10]
        return dict(source=a['id'], target=b['id'], score=round(score, 4), prompt=round(text, 4), visual=round(visual, 4),
                    common=phrases, features=components, unknown_prompt=bool(shared) and (a['prompt_source'] == 'unknown' or b['prompt_source'] == 'unknown'))
    ranked = [(entry, compare(origin, entry)) for entry in entries if entry['id'] != origin['id']]
    ranked = sorted((pair for pair in ranked if pair[1]['score'] >= .15), key=lambda pair: (-pair[1]['score'], pair[0]['id']))
    related_total = len(ranked)
    offset = min(max(0, offset), max(0, ((related_total - 1) // limit) * limit))
    ranked = ranked[offset:offset + limit]
    nodes = [origin, *(entry for entry, _ in ranked)]
    edges = [edge for _, edge in ranked]
    # A sparse neighborhood, rather than all-to-all links or thousands of DOM nodes.
    extras = []
    for i, a in enumerate(nodes[1:]):
        for b in nodes[i + 2:]:
            edge = compare(a, b)
            if edge['score'] >= .35:
                extras.append(edge)
    degrees = Counter()
    for edge in sorted(extras, key=lambda edge: -edge['score']):
        if degrees[edge['source']] < 2 and degrees[edge['target']] < 2:
            edges.append(edge)
            degrees.update([edge['source'], edge['target']])
    public = [dict(id=entry['id'], item=entry['item'], prompt=entry['prompt'], prompt_source=entry['prompt_source']) for entry in nodes]
    return dict(job=summary, center=origin['id'], nodes=public, edges=edges, related_total=related_total, offset=offset)
