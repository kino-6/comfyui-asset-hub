"""Durable job inputs, per-image checkpoints, and complete error history."""
from contextlib import closing
import json
from pathlib import Path
import sqlite3
import time
import uuid


class JobStore:
    def __init__(self, path):
        self.path = Path(path)
        with closing(self.connect()) as db:
            db.executescript('''
                PRAGMA journal_mode=WAL;
                CREATE TABLE IF NOT EXISTS jobs (
                    id TEXT PRIMARY KEY, action TEXT, workers INTEGER, background INTEGER,
                    status TEXT, created REAL, elapsed REAL DEFAULT 0, message TEXT DEFAULT '');
                CREATE TABLE IF NOT EXISTS tasks (
                    job TEXT, seq INTEGER, value TEXT, fingerprint TEXT, state TEXT DEFAULT 'pending',
                    result TEXT, error TEXT, name TEXT, PRIMARY KEY(job,seq));
                CREATE INDEX IF NOT EXISTS task_state ON tasks(job,state,seq);
                CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY,value TEXT);
            ''')
            if 'name' not in {r[1] for r in db.execute('PRAGMA table_info(tasks)')}:
                db.execute('ALTER TABLE tasks ADD COLUMN name TEXT')
            # An interrupted process cannot still own tasks. Resume is explicit.
            db.execute("UPDATE jobs SET status='paused',message='再起動前の処理を再開できます' WHERE status IN ('running','queued')")
            db.execute("UPDATE tasks SET state='pending' WHERE state='running'")
            db.commit()

    def connect(self):
        return sqlite3.connect(self.path, timeout=30)

    def compression(self):
        with closing(self.connect()) as db:
            row = db.execute("SELECT value FROM settings WHERE key='compression'").fetchone()
        return json.loads(row[0]) if row else 'size'

    def set_compression(self, profile):
        if profile not in ('size', 'speed'):
            raise ValueError('圧縮方法はサイズ優先または速度優先を指定してください。')
        with closing(self.connect()) as db:
            db.execute("INSERT OR REPLACE INTO settings VALUES ('compression',?)", (json.dumps(profile),))
            db.commit()

    def background(self):
        with closing(self.connect()) as db:
            row = db.execute("SELECT value FROM settings WHERE key='background'").fetchone()
        return json.loads(row[0]) if row else True

    def set_background(self, enabled):
        with closing(self.connect()) as db:
            db.execute("INSERT OR REPLACE INTO settings VALUES ('background',?)", (json.dumps(enabled),))
            db.execute("UPDATE jobs SET background=? WHERE status IN ('running','queued')", (int(enabled),))
            db.commit()

    def performance(self):
        with closing(self.connect()) as db:
            values = {key: json.loads(value) for key, value in db.execute('SELECT key,value FROM settings')}
        return dict(cpu_target=values.get('cpu_target', 70) if values.get('background', True) else None,
                    workers=values.get('workers', 4))

    def set_performance(self, target, workers):
        with closing(self.connect()) as db:
            values = [('background', target is not None), ('workers', workers)]
            if target is not None:
                values.append(('cpu_target', target))
            db.executemany('INSERT OR REPLACE INTO settings VALUES (?,?)', [(key, json.dumps(value)) for key, value in values])
            db.execute("UPDATE jobs SET background=?,workers=? WHERE status IN ('running','queued')", (int(target is not None), workers))
            db.commit()

    def create(self, action, items, workers, background, fingerprint, label=None):
        key = uuid.uuid4().hex
        try:
            with closing(self.connect()) as db:
                db.execute('INSERT INTO jobs(id,action,workers,background,status,created) VALUES (?,?,?,?,?,?)',
                           (key, action, workers, int(background), 'queued', time.time()))
                count = 0
                for count, item in enumerate(items, 1):
                    stamp = fingerprint(item) if isinstance(item, dict) else None
                    name = label(item) if label else item.get('name', '') if isinstance(item, dict) else str(item)
                    db.execute('INSERT INTO tasks(job,seq,value,fingerprint,name) VALUES (?,?,?,?,?)',
                               (key, count, json.dumps(item, ensure_ascii=False), json.dumps(stamp), name))
                if not count:
                    raise ValueError('対象の画像がありません。')
                db.commit()
        finally:
            if hasattr(items, 'close'):
                items.close()
        return self.get(key)

    def get(self, key):
        with closing(self.connect()) as db:
            row = db.execute('SELECT action,workers,background,status,created,elapsed,message FROM jobs WHERE id=?', (key,)).fetchone()
            if row is None:
                raise ValueError('処理が見つかりません。')
            counts = dict(db.execute('SELECT state,count(*) FROM tasks WHERE job=? GROUP BY state', (key,)))
            first = db.execute('SELECT name FROM tasks WHERE job=? ORDER BY seq LIMIT 1', (key,)).fetchone()
            results = [json.loads(r[0]) for r in db.execute('SELECT result FROM tasks WHERE job=? AND result IS NOT NULL ORDER BY seq DESC LIMIT 20', (key,))][::-1]
            errors = self._errors(db, key, 0, 20)
        done = sum(counts.get(s, 0) for s in ('succeeded', 'skipped', 'not_smaller', 'error'))
        return dict(id=key, action=row[0], workers=row[1], background=bool(row[2]), status=row[3], created=row[4], elapsed_s=row[5], message=row[6],
                    total=sum(counts.values()), done=done, succeeded=counts.get('succeeded', 0), skipped=counts.get('skipped', 0)+counts.get('not_smaller', 0), not_smaller=counts.get('not_smaller', 0),
                    error_count=counts.get('error', 0), remaining=counts.get('pending', 0)+counts.get('running', 0),
                    results=results, errors=errors, running=[], name=first[0] if first and first[0] else '')

    def list(self, offset=0, limit=20):
        with closing(self.connect()) as db:
            keys = [r[0] for r in db.execute('SELECT id FROM jobs ORDER BY created DESC LIMIT ? OFFSET ?', (limit, offset))]
            total = db.execute('SELECT count(*) FROM jobs').fetchone()[0]
        return dict(jobs=[self.get(key) for key in keys], total=total, offset=offset)

    def attention(self):
        with closing(self.connect()) as db:
            return db.execute("SELECT count(*) FROM jobs WHERE status IN ('paused','error') OR EXISTS (SELECT 1 FROM tasks WHERE tasks.job=jobs.id AND state='error')").fetchone()[0]

    def state(self, key, status, elapsed=None, message=''):
        with closing(self.connect()) as db:
            db.execute('UPDATE jobs SET status=?,message=?,elapsed=coalesce(?,elapsed) WHERE id=?', (status, message, elapsed, key))
            db.commit()

    def items(self, key):
        after = 0
        while True:
            with closing(self.connect()) as db:
                row = db.execute("SELECT seq,value,fingerprint FROM tasks WHERE job=? AND state='pending' AND seq>? ORDER BY seq LIMIT 1", (key, after)).fetchone()
                if row is None:
                    return
                db.execute("UPDATE tasks SET state='running' WHERE job=? AND seq=?", (key, row[0]))
                db.commit()
            after = row[0]
            yield dict(_task_seq=row[0], value=json.loads(row[1]), fingerprint=json.loads(row[2]))

    def complete(self, key, task, record, error):
        state = 'error' if error is not None else 'skipped' if record.get('skipped') else 'succeeded'
        if state == 'skipped' and record.get('state') == 'not_smaller':
            state = 'not_smaller'
        with closing(self.connect()) as db:
            db.execute('UPDATE tasks SET state=?,result=?,error=? WHERE job=? AND seq=?',
                       (state, json.dumps(record, ensure_ascii=False) if record else None, error, key, task['_task_seq']))
            db.commit()

    def resume(self, key, retry, fingerprint, workers=None):
        job = self.get(key)
        if job['status'] in ('running', 'queued'):
            raise ValueError('すでに実行中か待ち行列にあります。')
        if retry and job['remaining']:
            raise ValueError('残りの処理を再開してから、失敗分を再試行してください。')
        with closing(self.connect()) as db:
            if workers is not None:
                db.execute('UPDATE jobs SET workers=? WHERE id=?', (workers, key))
            if retry:
                for seq, value in db.execute("SELECT seq,value FROM tasks WHERE job=? AND state='error'", (key,)).fetchall():
                    item = json.loads(value)
                    stamp = fingerprint(item) if isinstance(item, dict) else None
                    db.execute("UPDATE tasks SET state='pending',error=NULL,fingerprint=? WHERE job=? AND seq=?", (json.dumps(stamp), key, seq))
            db.execute("UPDATE tasks SET state='pending' WHERE job=? AND state='running'", (key,))
            if not db.execute("SELECT count(*) FROM tasks WHERE job=? AND state='pending'", (key,)).fetchone()[0]:
                raise ValueError('再開する画像がありません。')
            db.execute("UPDATE jobs SET status='queued',message='' WHERE id=?", (key,))
            db.commit()
        return self.get(key)

    def _errors(self, db, key, offset, limit):
        errors = []
        for seq, raw, error, name in db.execute("SELECT seq,value,error,name FROM tasks WHERE job=? AND state='error' ORDER BY seq LIMIT ? OFFSET ?", (key, limit, offset)):
            value = json.loads(raw)
            errors.append(dict(seq=seq, name=name or (value.get('name', '') if isinstance(value, dict) else value), error=error))
        return errors

    def errors(self, key, offset=0):
        with closing(self.connect()) as db:
            total = db.execute("SELECT count(*) FROM tasks WHERE job=? AND state='error'", (key,)).fetchone()[0]
            return dict(errors=self._errors(db, key, offset, 100), total=total, offset=offset)
