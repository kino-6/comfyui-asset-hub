import hashlib
import json
import os
from pathlib import Path
import sqlite3
import threading
import time
import uuid
from contextlib import closing


class Catalog:
    """Disk-backed file names/stat index. Never decodes images during a scan."""

    def __init__(self, directory, resolve_dir, extensions):
        self.directory = Path(directory)
        self.directory.mkdir(parents=True, exist_ok=True)
        self.resolve_dir = resolve_dir
        self.extensions = extensions
        self.lock = threading.Lock()
        self.snapshots = {}

    def scan(self, scope, refresh=False):
        base = Path(self.resolve_dir(scope)).resolve()
        key = hashlib.sha256(json.dumps([str(base), scope['type'], scope.get('subfolder', ''), bool(scope.get('recursive'))]).encode()).hexdigest()
        with self.lock:
            if key in self.snapshots and not refresh:
                return self.snapshots[key]
            path = self.directory / (key + '.sqlite3')
            started = time.monotonic()
            with closing(sqlite3.connect(path)) as db:
                db.execute('PRAGMA journal_mode=WAL')
                db.execute('CREATE TABLE IF NOT EXISTS files (name TEXT, subpath TEXT, search TEXT, ext TEXT, size INTEGER, mtime REAL, directory INTEGER)')
                db.execute('DELETE FROM files')
                pending = ['']
                count = 0
                skipped = 0
                while pending:
                    sub = pending.pop()
                    try:
                        with os.scandir(base / sub) as entries:
                            for entry in entries:
                                if entry.name.startswith('.') or entry.name in ('__pycache__', 'clipspace'):
                                    continue
                                try:
                                    if entry.is_symlink() or Path(entry.path).is_junction():
                                        continue
                                    directory = entry.is_dir(follow_symlinks=False)
                                    if directory and scope.get('recursive'):
                                        pending.append((Path(sub) / entry.name).as_posix())
                                        continue
                                    ext = Path(entry.name).suffix.lower()
                                    if not directory and ext not in (self.extensions["images"] | self.extensions["videos"]):
                                        continue
                                    st = entry.stat(follow_symlinks=False)
                                    db.execute('INSERT INTO files VALUES (?,?,?,?,?,?,?)', (entry.name, sub, (sub + '/' + entry.name).casefold(), ext, st.st_size, st.st_mtime, int(directory)))
                                    count += 1
                                except OSError:
                                    skipped += 1
                    except OSError:
                        if not sub:
                            raise
                        skipped += 1
                db.execute('CREATE INDEX IF NOT EXISTS file_order ON files(directory,mtime,name)')
                db.execute('CREATE INDEX IF NOT EXISTS file_name ON files(name)')
                db.commit()
            result = dict(token=uuid.uuid4().hex, path=str(path), count=count, seconds=time.monotonic()-started, skipped=skipped, scope=dict(scope))
            self.snapshots[key] = result
            return result

    def snapshot(self, token):
        for s in self.snapshots.values():
            if s['token'] == token:
                return s
        raise ValueError('一覧が更新されています。全選択をやり直してください。')

    def where(self, query, png_only=False):
        sql, args = 'instr(search, ?) > 0', [str(query.get('query', '')).casefold().strip()]
        if png_only:
            sql += ' AND directory=0 AND ext=?'
            args.append('.png')
        elif query.get('kind') in ('images', 'videos'):
            exts = self.extensions[query['kind']] if isinstance(self.extensions, dict) else []
            sql += ' AND (directory=1 OR ext IN (' + ','.join('?' for _ in exts) + '))'
            args.extend(exts)
        return sql, args

    def page(self, snapshot, query):
        where, args = self.where(query)
        offset = max(0, int(query.get('offset', 0)))
        sort = {'name': 'search', 'mtime': 'mtime', 'size': 'size'}.get(query.get('sortKey'), 'mtime')
        order = 'ASC' if query.get('sortDir') == 'asc' else 'DESC'
        with closing(sqlite3.connect(snapshot['path'])) as db:
            total = db.execute('SELECT count(*) FROM files WHERE '+where, args).fetchone()[0]
            file_count = db.execute('SELECT count(*) FROM files WHERE ('+where+') AND directory=0', args).fetchone()[0]
            offset = min(offset, max(0, ((total-1)//200)*200))
            rows = db.execute(f'SELECT name,subpath,ext,size,mtime,directory FROM files WHERE {where} ORDER BY directory DESC,{sort} {order},subpath,name LIMIT 200 OFFSET ?', [*args, offset]).fetchall()
            png_where, png_args = self.where(query, True)
            png_count = db.execute('SELECT count(*) FROM files WHERE '+png_where, png_args).fetchone()[0] if query.get('kind') != 'videos' else 0
        dirs, files = [], []
        for name, subpath, ext, size, mtime, directory in rows:
            (dirs if directory else files).append(dict(name=name, subpath=subpath, ext=ext, size=size, mtime=mtime))
        return dict(ok=True, exists=True, dirs=dirs, files=files, total=total, file_count=file_count, png_count=png_count, offset=offset, limit=200,
                    token=snapshot['token'], scan_seconds=snapshot['seconds'], skipped=snapshot['skipped'])

    def selected(self, token, query, extension='.png'):
        where, args = self.where(query, extension is not None)
        if extension is not None:
            args[-1] = extension
        else:
            where += ' AND directory=0'
        if query.get('kind') == 'videos':
            raise ValueError('動画表示には圧縮対象の画像がありません。')
        with self.lock:
            snapshot = self.snapshot(token)
            db = sqlite3.connect(snapshot['path'], check_same_thread=False)
            db.execute('BEGIN')
            total = db.execute('SELECT count(*) FROM files WHERE '+where, args).fetchone()[0]
        if not total:
            db.close()
            raise ValueError('対象の画像がありません。')
        scope = snapshot['scope']
        def items():
            try:
                yield None
                for name, sub in db.execute('SELECT name,subpath FROM files WHERE '+where+' ORDER BY subpath,name', args):
                    yield dict(type=scope['type'], subfolder='/'.join(p for p in (scope.get('subfolder', ''), sub) if p), name=name)
            finally:
                db.close()
        iterator = items()
        next(iterator)
        return total, iterator
