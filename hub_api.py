import asyncio
import json
import os
from pathlib import Path
import uuid
from urllib.parse import quote

from aiohttp import web
import folder_paths
from server import PromptServer
from .browser import image_browser as browser
from .storage import Storage
from .catalog import Catalog
from .job_store import JobStore
from .job_manager import JobManager
from .relations import RelationIndex, RelationJob, related_graph


def resolve(item):
    if not isinstance(item, dict) or any(not isinstance(item.get(k, ''), str) for k in ('type', 'subfolder', 'name')):
        raise ValueError('素材の指定が不正です。')
    target, error = browser._resolve_sandboxed_file(item.get('type', ''), item.get('subfolder', ''), item.get('name', ''))
    if error:
        raise ValueError(error)
    return target


store = Storage(Path(folder_paths.get_user_directory()) / 'asset-hub', resolve)
roots_file = store.directory / 'folders.json'
roots = json.loads(roots_file.read_text('utf-8')) if roots_file.exists() else {}
browser.REGISTERED_ROOTS.update(roots)
browser.SANDBOXED_TYPES.extend(roots)


def resolve_dir(scope):
    kind = scope.get('type', '')
    if kind not in browser.SANDBOXED_TYPES:
        raise ValueError('登録したフォルダを選んでください。')
    base, error = browser._resolve_listing_base(kind, scope.get('subfolder', ''), '')
    if error:
        raise ValueError(error)
    if not browser._contained_after_realpath(base, browser.root_directory(kind)):
        raise ValueError('登録フォルダの外は参照できません。')
    return base


catalog = Catalog(store.directory / 'catalog', resolve_dir, {'images': browser.IMG_EXTS, 'videos': browser.VIDEO_EXTS})
job_store = JobStore(store.directory / 'jobs.sqlite3')
job_manager = JobManager(store, job_store)
selection_plans = {}
routes = PromptServer.instance.routes


def resolve_relation(item):
    path = Path(resolve(item))
    if not path.is_file():
        for record in store.for_items([item]):
            if record['state'] == 'compacted':
                item = {**item, 'name': record['target_name']}
                path = Path(resolve(item))
                break
            if record['state'] == 'restored':
                item = dict(record['item'])
                path = Path(resolve(item))
                break
    return item, path


relation_index = RelationIndex(store.directory, resolve_relation)
relation_job = None
relation_task = None
relation_start_lock = asyncio.Lock()


@routes.post('/asset_hub/relations/start')
@browser._guard_mutation
async def start_relations(request):
    global relation_job, relation_task
    try:
        data = await request.json()
        if data.get('all'):
            scope = data['all']
            _, iterator = await asyncio.to_thread(catalog.selected, scope['token'], scope, None)
            items = await asyncio.to_thread(list, iterator)
        else:
            items = data.get('items')
        if not isinstance(items, list) or not items:
            raise ValueError('関連図に表示する画像がありません。')
        def validate_items():
            for item in items:
                resolve(item)
            seed = data.get('center')
            if seed:
                items.sort(key=lambda item: item != seed)
        await asyncio.to_thread(validate_items)
        async with relation_start_lock:
            if relation_task and not relation_task.done():
                relation_job.cancel.set()
                await relation_task
            relation_job = RelationJob(len(items))
            relation_task = asyncio.create_task(asyncio.to_thread(relation_index.run, relation_job, items))
            return web.json_response(relation_job.summary(), status=202)
    except (ValueError, OSError, KeyError, TypeError) as error:
        return web.json_response(dict(error=str(error)), status=400)


@routes.post('/asset_hub/relations/query')
@browser._guard_mutation
async def query_relations(request):
    try:
        data = await request.json()
        job = relation_job
        if not job or job.id != data.get('id'):
            raise ValueError('別の関連図が開かれました。一覧から開き直してください。')
        offset = int(data.get('offset', 0))
        def result():
            graph = related_graph(job, data.get('center'), data.get('mode', 'combined'), offset=offset)
            for node in graph['nodes']:
                try:
                    node['item'], path = resolve_relation(node['item'])
                    node['image_missing'] = not path.is_file()
                except (ValueError, OSError):
                    node['image_missing'] = True
            return graph
        return web.json_response(await asyncio.to_thread(result))
    except (ValueError, TypeError) as error:
        return web.json_response(dict(error=str(error)), status=400)


@routes.post('/asset_hub/relations/cancel')
@browser._guard_mutation
async def cancel_relations(request):
    data = await request.json()
    if relation_job and relation_job.id == data.get('id'):
        relation_job.cancel.set()
    return web.json_response(dict(ok=True))


@routes.get('/asset_hub/status')
async def status(request):
    try:
        offset = max(0, int(request.query.get('offset', 0)))
        state = request.query.get('state', '')
        def result():
            progress = job_manager.snapshot()
            if request.query.get('progress') == '1':
                return progress
            def size(folder, pattern):
                total = 0
                for p in folder.glob(pattern):
                    try:
                        total += p.stat().st_size
                    except FileNotFoundError:
                        pass
                return total
            summary = store.summary(state)
            return dict(**progress, records=[store.public(r) for r in store.listing(offset, 100, state)], **summary, offset=offset,
                        cache_limit=store.cache_limit, cache_bytes=size(store.cache, '*.png'), staged_bytes=size(store.stage, '*.webp'))
        return web.json_response(await asyncio.to_thread(result))
    except ValueError as error:
        return web.json_response(dict(error=str(error)), status=400)


@routes.post('/asset_hub/records')
@browser._guard_mutation
async def item_records(request):
    try:
        data = await request.json()
        items = data.get('items', [])
        if not isinstance(items, list) or len(items) > 200:
            raise ValueError('表示ページの200件まで指定できます。')
        for item in items:
            resolve(item)
        return web.json_response(dict(records=await asyncio.to_thread(store.for_items, items)))
    except (ValueError, KeyError) as error:
        return web.json_response(dict(error=str(error)), status=400)


@routes.post('/asset_hub/prepare')
@browser._guard_mutation
async def prepare(request):
    try:
        data = await request.json()
        action = 'archive' if data.get('archive') else 'prepare'
        if data.get('plan'):
            plan = selection_plans.get(data['plan'])
            if plan is None:
                raise ValueError('選択内容を更新してください。')
            return web.json_response(await job_manager.start(action, plan['archive'], workers=data.get('workers', 4)), status=202)
        if data.get('all'):
            total, items = await asyncio.to_thread(catalog.selected, data['all']['token'], data['all'])
            return web.json_response(await job_manager.start(action, items, total, data.get('workers',4)), status=202)
        return web.json_response(await job_manager.start(action, data.get('items'), workers=data.get('workers',4)), status=202)
    except (ValueError, KeyError) as error:
        return web.json_response(dict(error=str(error)), status=400)


@routes.post('/asset_hub/operate')
@browser._guard_mutation
async def operate(request):
    try:
        data = await request.json()
        action = data.get('action')
        if action not in ('commit', 'restore', 'discard'):
            raise ValueError('操作が不正です。')
        expected = {'commit': ('prepared', 'placing'), 'restore': ('compacted',), 'discard': ('prepared',)}
        state = data.get('all_state')
        if data.get('plan'):
            if action != 'restore':
                raise ValueError('この選択は復元に使用してください。')
            plan = selection_plans.get(data['plan'])
            if plan is None:
                raise ValueError('選択内容を更新してください。')
            ids = plan['restore']
        elif data.get('all_scope'):
            scope = data['all_scope']
            _, iterator = await asyncio.to_thread(catalog.selected, scope['token'], scope, None)
            records = await asyncio.to_thread(store.for_items, iterator)
            ids = [r['id'] for r in records if r['state'] in expected[action]]
        elif data.get('items'):
            records = await asyncio.to_thread(store.for_items, data['items'])
            ids = [r['id'] for r in records if r['state'] in expected[action]]
        elif state == '*':
            ids = []
            for eligible in expected[action]:
                ids.extend(await asyncio.to_thread(store.ids, eligible))
        elif state:
            if state not in expected[action]:
                raise ValueError('選択した状態ではこの操作を実行できません。')
            ids = await asyncio.to_thread(store.ids, state)
        else:
            ids = data.get('ids')
        return web.json_response(await job_manager.start(action, ids, workers=data.get('workers',4)), status=202)
    except (ValueError, KeyError) as error:
        return web.json_response(dict(error=str(error)), status=400)


@routes.post('/asset_hub/selection')
@browser._guard_mutation
async def selection(request):
    try:
        data = await request.json()
        if data.get('all'):
            scope = data['all']
            _, items = await asyncio.to_thread(catalog.selected, scope['token'], scope, None)
        else:
            items = data.get('items', [])
            if not isinstance(items, list):
                raise ValueError('選択内容が不正です。')
        def collect():
            try:
                return store.selection_targets(items)
            finally:
                if hasattr(items, 'close'):
                    items.close()
        plan = await asyncio.to_thread(collect)
        key = uuid.uuid4().hex
        selection_plans[key] = plan
        while len(selection_plans) > 8:
            del selection_plans[next(iter(selection_plans))]
        return web.json_response(dict(plan=key, selected=plan['selected'], archive=len(plan['archive']), restore=len(plan['restore']), converted=plan['converted'], other=plan['other'], unchanged=plan['unchanged']))
    except (ValueError, OSError, KeyError) as error:
        return web.json_response(dict(error=str(error)), status=400)


@routes.post('/asset_hub/cancel')
@browser._guard_mutation
async def stop(request):
    await job_manager.stop()
    return web.json_response(dict(ok=True))


@routes.post('/asset_hub/compression')
@browser._guard_mutation
async def compression_setting(request):
    try:
        data = await request.json()
        return web.json_response(await job_manager.set_compression(data.get('compression')))
    except ValueError as error:
        return web.json_response(dict(error=str(error)), status=400)


@routes.post('/asset_hub/background')
@browser._guard_mutation
async def background_setting(request):
    try:
        data = await request.json()
        return web.json_response(await job_manager.set_background(data.get('enabled')))
    except ValueError as error:
        return web.json_response(dict(error=str(error)), status=400)


@routes.post('/asset_hub/performance')
@browser._guard_mutation
async def performance_setting(request):
    try:
        data = await request.json()
        if 'cpu_target' not in data:
            raise ValueError('CPU目標は10〜95%、指定しない場合はnullで指定してください。')
        return web.json_response(await job_manager.set_performance(data['cpu_target'], data.get('workers'), data.get('mode')))
    except ValueError as error:
        return web.json_response(dict(error=str(error)), status=400)


@routes.get('/asset_hub/jobs')
async def job_history(request):
    try:
        return web.json_response(await asyncio.to_thread(job_store.list, max(0, int(request.query.get('offset', 0)))))
    except ValueError as error:
        return web.json_response(dict(error=str(error)), status=400)


@routes.get('/asset_hub/jobs/{key}/errors')
async def job_errors(request):
    try:
        return web.json_response(await asyncio.to_thread(job_store.errors, request.match_info['key'], max(0, int(request.query.get('offset', 0)))))
    except ValueError as error:
        return web.json_response(dict(error=str(error)), status=400)


@routes.post('/asset_hub/jobs/{key}/resume')
@browser._guard_mutation
async def resume_job(request):
    try:
        data = await request.json()
        job = await job_manager.resume(request.match_info['key'], bool(data.get('retry')))
        return web.json_response(job, status=202)
    except (ValueError, OSError) as error:
        return web.json_response(dict(error=str(error)), status=400)


@routes.get('/asset_hub/folders')
async def folders(request):
    return web.json_response(dict(roots=[dict(type=k, path=v) for k, v in roots.items()]))


@routes.post('/asset_hub/folders')
@browser._guard_mutation
async def add_folder(request):
    try:
        data = await request.json()
        value = data.get('path', '').strip().strip('"')
        if not os.path.isabs(value):
            raise ValueError('ComfyUIが動いているPCのフォルダの絶対パスを指定してください。')
        path = Path(value).resolve(strict=True)
        if not path.is_dir():
            raise ValueError('フォルダではありません。')
        kind = next((k for k, v in roots.items() if os.path.normcase(v) == os.path.normcase(str(path))), None)
        if kind is None:
            kind = 'hub:' + uuid.uuid4().hex
            roots[kind] = str(path)
            temp = roots_file.with_suffix('.tmp')
            temp.write_text(json.dumps(roots, ensure_ascii=False, indent=2), 'utf-8')
            os.replace(temp, roots_file)
            browser.REGISTERED_ROOTS[kind] = str(path)
            browser.SANDBOXED_TYPES.append(kind)
        return web.json_response(dict(type=kind, path=str(path)))
    except (ValueError, OSError, TypeError) as error:
        return web.json_response(dict(error=str(error)), status=400)


@routes.post('/asset_hub/list')
@browser._guard_mutation
async def listing(request):
    try:
        data = await request.json()
        snapshot = await asyncio.to_thread(catalog.scan, data, data.get('refresh', False))
        result = await asyncio.to_thread(catalog.page, snapshot, data)
        # Reuse metadata/Safe View readers only for this page, never the whole folder.
        base = resolve_dir(data)
        def enrich():
            found = []
            for f in result['files']:
                path = os.path.join(base, f['subpath'], f['name'])
                try:
                    found.append((f['mtime'], f['subpath'], f['name'], f['ext'], path, os.stat(path)))
                except OSError:
                    pass
            keywords = set(data.get('safeKeywords') or [])
            files, _, unscanned = browser._probe_newest(found, browser.IMG_EXTS, 200, False, with_subpath=bool(data.get('recursive')),
                hide_keywords=keywords if data.get('safeHide') else set(), hide_prefix=base,
                prompt_keywords=keywords if data.get('safePrompt') else set())
            by_name = {(f.get('subpath', ''), f['name']): f for f in files}
            result['files'] = [by_name[(f['subpath'], f['name'])] for f in result['files'] if (f['subpath'], f['name']) in by_name]
            result['safe_unscanned'] = unscanned
        await asyncio.to_thread(enrich)
        return web.json_response(result)
    except (ValueError, OSError, KeyError) as error:
        return web.json_response(dict(error=str(error)), status=400)


@routes.get('/asset_hub/file')
async def file(request):
    try:
        target = resolve(dict(type=request.query.get('type', ''), subfolder=request.query.get('subfolder', ''), name=request.query.get('filename', '')))
        return web.FileResponse(target)
    except (ValueError, OSError) as error:
        return web.json_response(dict(error=str(error)), status=400)


@routes.get('/asset_hub/png/{key}')
async def png(request):
    try:
        key = request.match_info['key']
        # A managed id is the only route to the cache; no caller-supplied paths.
        record = store.get(key)
        file = await asyncio.to_thread(store.export_png, key)
        return web.FileResponse(file, headers={'Content-Disposition': "attachment; filename=restored.png; filename*=UTF-8''" + quote(record['item']['name']), 'Cache-Control': 'no-store'})
    except (ValueError, OSError) as error:
        return web.json_response(dict(error=str(error)), status=400)
