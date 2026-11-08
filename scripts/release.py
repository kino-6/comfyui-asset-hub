"""Allowlisted source export and pre-push checks. Findings never print secret values."""
import argparse
import hashlib
import json
from pathlib import Path, PurePosixPath
import re
import subprocess
import sys
import zipfile


ROOT = Path(__file__).resolve().parents[1]
MANIFEST = 'release-files.json'
FORBIDDEN_PARTS = {'.git', '.env', '.local', '.venv', 'venv', 'node_modules', '__pycache__',
                   'outputs', 'dist', 'cache', 'staging', 'catalog', 'archive-output'}
FORBIDDEN_SUFFIXES = {'.db', '.sqlite', '.sqlite3', '.log', '.pyc', '.map', '.pem', '.key',
                      '.png', '.jpg', '.jpeg', '.webp', '.safetensors', '.pt', '.zip'}
PATTERNS = {
    'personal Windows path': re.compile(r'[A-Za-z]:[\\/]+(?:Users|LocalWork|Documents and Settings)[\\/]', re.I),
    'personal Unix path': re.compile(r'/(?:Users|home)/[A-Za-z0-9_.-]+/'),
    'private key': re.compile(r'-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----'),
    'GitHub token': re.compile(r'\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})'),
    'service token': re.compile(r'\b(?:sk-(?:proj-|ant-)?[A-Za-z0-9_-]{24,}|hf_[A-Za-z0-9]{24,}|AKIA[A-Z0-9]{16})'),
    'credential in URL': re.compile(r'https?://[^\s/@:]+:[^\s/@]+@'),
    'literal credential': re.compile(r'''(?i)(?:api[_-]?key|access[_-]?token|client[_-]?secret|password)\s*[:=]\s*["'][^"'\s]{12,}["']'''),
}


def valid_name(name):
    parts = PurePosixPath(name).parts
    if (not parts or name != PurePosixPath(name).as_posix() or ':' in name or '\\' in name
            or name.startswith('/') or '..' in parts or any(p in FORBIDDEN_PARTS for p in parts)
            or any(p.startswith('.env') for p in parts)
            or PurePosixPath(name).suffix.lower() in FORBIDDEN_SUFFIXES
            or name.endswith(('-wal', '-shm')) or PurePosixPath(name).name in {'folders.json', 'records.json'}):
        raise ValueError(f'Forbidden release path: {name}')


def load_manifest(root):
    manifest = json.loads((root / MANIFEST).read_text('utf-8'))
    names = manifest['files']
    if not isinstance(names, list) or len(names) != len(set(names)) or MANIFEST not in names:
        raise ValueError('Invalid or duplicate release manifest entries')
    for name in names:
        valid_name(name)
    if not set(manifest['runtime_files']) <= set(names):
        raise ValueError('Runtime files must be release files')
    if not set(manifest['binary_sha256']) <= set(names):
        raise ValueError('Binary pins must be release files')
    return manifest


def inspect_bytes(name, data, manifest):
    digest = manifest['binary_sha256'].get(name)
    if digest:
        if hashlib.sha256(data).hexdigest() != digest:
            raise ValueError(f'Pinned binary checksum mismatch: {name}')
        return
    try:
        text = data.decode('utf-8-sig')
    except UnicodeDecodeError:
        raise ValueError(f'Unapproved binary: {name}') from None
    if '\x00' in text:
        raise ValueError(f'Unapproved binary: {name}')
    for label, pattern in PATTERNS.items():
        match = pattern.search(text)
        if match:
            line = text.count('\n', 0, match.start()) + 1
            raise ValueError(f'{name}:{line}: {label} (value redacted)')


def read_source(root, manifest):
    root = root.resolve()
    files = {}
    for name in manifest['files']:
        path = root / name
        # Refuse symlinks and Windows junctions, including parents.
        for part in [path, *path.parents]:
            if part == root:
                break
            if part.is_symlink() or (hasattr(part, 'is_junction') and part.is_junction()):
                raise ValueError(f'Linked release path: {name}')
        if not path.resolve().is_relative_to(root) or not path.is_file():
            raise ValueError(f'Missing or escaping release file: {name}')
        data = path.read_bytes()
        inspect_bytes(name, data, manifest)
        files[name] = data
    return files


def git(root, *args):
    result = subprocess.run(['git', *args], cwd=root, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if result.returncode:
        raise ValueError(f'Git check failed ({args[0]}). Initialize the repository or check its state.')
    return result.stdout


def check_index(root, manifest):
    names = set()
    for entry in git(root, 'ls-files', '--stage', '-z').split(b'\0'):
        if not entry:
            continue
        metadata, raw_name = entry.split(b'\t', 1)
        mode, oid, stage = metadata.decode().split()
        name = raw_name.decode('utf-8')
        if name not in manifest['files'] or mode not in {'100644', '100755'} or stage != '0':
            raise ValueError(f'Unapproved staged file or mode: {name}')
        valid_name(name)
        inspect_bytes(name, git(root, 'cat-file', 'blob', oid), manifest)
        names.add(name)
    if names != set(manifest['files']):
        raise ValueError('Git index does not match the complete release manifest')
    if git(root, 'show', ':' + MANIFEST) != (root / MANIFEST).read_bytes():
        raise ValueError('Staged release manifest differs from working copy')
    return len(names)


def check_history(root, manifest):
    checked = set()
    commits = git(root, 'rev-list', '--all').decode().splitlines()
    if not commits:
        raise ValueError('No commits to check')
    for commit in commits:
        for entry in git(root, 'ls-tree', '-r', '-z', commit).split(b'\0'):
            if not entry:
                continue
            metadata, raw_name = entry.split(b'\t', 1)
            mode, kind, oid = metadata.decode().split()
            name = raw_name.decode('utf-8')
            if name not in manifest['files'] or kind != 'blob' or mode not in {'100644', '100755'}:
                raise ValueError(f'Unapproved file in history: {name}')
            if (name, oid) not in checked:
                inspect_bytes(name, git(root, 'cat-file', 'blob', oid), manifest)
                checked.add((name, oid))
        inspect_bytes('commit metadata', git(root, 'cat-file', 'commit', commit), manifest)
    return len(commits)


def archive(root, files, output):
    target = output.absolute()
    if not target.resolve().is_relative_to((root / 'dist').resolve()) or target.suffix != '.zip':
        raise ValueError('Archive must be a .zip inside this project dist/')
    target.parent.mkdir(parents=True, exist_ok=True)
    sums = ''.join(f'{hashlib.sha256(data).hexdigest()}  {name}\n' for name, data in sorted(files.items()))
    # Exclusive creation; no deletion or overwrite of previous artifacts.
    with target.open('xb') as stream, zipfile.ZipFile(stream, 'w', compression=zipfile.ZIP_DEFLATED) as output_zip:
        for name, data in sorted({**files, 'SHA256SUMS': sums.encode()}.items()):
            info = zipfile.ZipInfo('comfy-asset-hub/' + name, date_time=(2020, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o100644 << 16
            output_zip.writestr(info, data)
    return target


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=['check', 'stage', 'check-index', 'check-history', 'archive'])
    parser.add_argument('--output', type=Path, default=ROOT / 'dist/comfy-asset-hub.zip')
    args = parser.parse_args()
    try:
        manifest = load_manifest(ROOT)
        if args.command in {'check', 'stage', 'archive'}:
            files = read_source(ROOT, manifest)
        if args.command == 'stage':
            git(ROOT, 'add', '--', *manifest['files'])
            check_index(ROOT, manifest)
        elif args.command == 'check-index':
            check_index(ROOT, manifest)
        elif args.command == 'check-history':
            print(f'Checked {check_history(ROOT, manifest)} commits')
        elif args.command == 'archive':
            print(archive(ROOT, files, args.output))
        print(f'PASS {args.command}: {len(manifest["files"])} allowlisted files')
    except (ValueError, OSError, KeyError, TypeError) as error:
        print(f'BLOCKED: {error}', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
