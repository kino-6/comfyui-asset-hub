import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
import zipfile


spec = importlib.util.spec_from_file_location('release_checks', Path(__file__).resolve().parents[1] / 'scripts/release.py')
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)


class ReleaseTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.manifest = dict(files=['release-files.json', 'main.py'], runtime_files=['main.py'], binary_sha256={})
        self.save_manifest()
        (self.root / 'main.py').write_text('print("ok")\n', encoding='utf-8')

    def save_manifest(self):
        (self.root / release.MANIFEST).write_text(json.dumps(self.manifest) + '\n', encoding='utf-8')

    def git(self, *args):
        return release.git(self.root, *args)

    def init_git(self):
        self.git('init', '-q')
        self.git('config', 'user.name', 'Release Test')
        self.git('config', 'user.email', 'release-test@example.invalid')
        self.git('config', 'core.autocrlf', 'false')

    def test_export_excludes_private_data_and_is_reproducible(self):
        for name in ['outputs/private.png', '.env', 'folders.json', 'records.sqlite3', 'vendor/other/.git/config']:
            path = self.root / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(b'private fixture')
        files = release.read_source(self.root, release.load_manifest(self.root))
        one = release.archive(self.root, files, self.root / 'dist/one.zip')
        two = release.archive(self.root, files, self.root / 'dist/two.zip')
        self.assertEqual(one.read_bytes(), two.read_bytes())
        with zipfile.ZipFile(one) as archive:
            self.assertEqual(set(archive.namelist()), {'comfy-asset-hub/main.py', 'comfy-asset-hub/release-files.json', 'comfy-asset-hub/SHA256SUMS'})
            self.assertIn(hashlib.sha256(files['main.py']).hexdigest().encode(), archive.read('comfy-asset-hub/SHA256SUMS'))
        self.assertTrue((self.root / 'outputs/private.png').is_file())
        with self.assertRaises(FileExistsError):
            release.archive(self.root, files, one)
        with self.assertRaises(ValueError):
            release.archive(self.root, files, self.root / 'outside.zip')

    def test_forbidden_manifest_paths(self):
        for name in ['../escape', '/absolute', 'outputs/a.txt', '.env.local', 'x.sqlite3-wal', 'src/file.map', 'vendor/pkg/.git/config', 'folders.json']:
            with self.subTest(name=name), self.assertRaises(ValueError):
                release.valid_name(name)

    def test_sensitive_text_is_rejected_without_echoing_value(self):
        samples = [
            'gh' + 'p_' + 'x' * 36,
            'sk-' + 'proj-' + 'x' * 48,
            '-----BEGIN ' + 'OPENSSH PRIVATE KEY-----',
            'C:' + '/Users/' + 'private-person/project',
            '/' + 'home/' + 'private-person/project',
            'password = ' + repr('sensitive-fixture-value'),
            'https://' + 'user:secret@example.invalid',
        ]
        for sample in samples:
            with self.subTest(kind=sample[:3]), self.assertRaises(ValueError) as error:
                release.inspect_bytes('main.py', sample.encode(), self.manifest)
            self.assertNotIn(sample, str(error.exception))
            self.assertIn('redacted', str(error.exception))

    def test_binary_is_pinned_and_unknown_binary_is_rejected(self):
        data = b'\x00\xffbinary'
        with self.assertRaises(ValueError):
            release.inspect_bytes('tool.exe', data, self.manifest)
        self.manifest['binary_sha256']['tool.exe'] = hashlib.sha256(data).hexdigest()
        release.inspect_bytes('tool.exe', data, self.manifest)
        with self.assertRaises(ValueError):
            release.inspect_bytes('tool.exe', data + b'changed', self.manifest)

    def test_staged_secret_is_detected_even_if_worktree_is_clean(self):
        self.init_git()
        (self.root / 'main.py').write_text('gh' + 'p_' + 'x' * 36, encoding='utf-8')
        self.git('add', '.')
        (self.root / 'main.py').write_text('clean', encoding='utf-8')
        release.read_source(self.root, self.manifest)
        with self.assertRaisesRegex(ValueError, 'GitHub token'):
            release.check_index(self.root, self.manifest)

    def test_index_rejects_extra_files_and_checks_history(self):
        self.init_git()
        self.git('add', '.')
        self.assertEqual(release.check_index(self.root, self.manifest), 2)
        self.git('commit', '-qm', 'Clean snapshot')
        self.assertEqual(release.check_history(self.root, self.manifest), 1)
        (self.root / 'extra.txt').write_text('extra', encoding='utf-8')
        self.git('add', 'extra.txt')
        with self.assertRaisesRegex(ValueError, 'Unapproved staged file'):
            release.check_index(self.root, self.manifest)

    def test_removed_secret_is_still_detected_in_history(self):
        self.init_git()
        (self.root / 'main.py').write_text('gh' + 'p_' + 'x' * 36, encoding='utf-8')
        self.git('add', '.')
        self.git('commit', '-qm', 'Synthetic fixture')
        (self.root / 'main.py').write_text('clean', encoding='utf-8')
        self.git('add', '.')
        self.git('commit', '-qm', 'Clean current version')
        release.check_index(self.root, self.manifest)
        with self.assertRaisesRegex(ValueError, 'GitHub token'):
            release.check_history(self.root, self.manifest)

    def test_installer_requires_explicit_destination_and_dry_run_writes_nothing(self):
        import sys
        script = Path(__file__).resolve().parents[1] / 'scripts/install.py'
        result = subprocess.run([sys.executable, str(script)], capture_output=True)
        self.assertNotEqual(result.returncode, 0)
        (self.root / 'main.py').write_text('# fake ComfyUI', encoding='utf-8')
        (self.root / 'custom_nodes').mkdir()
        args = [sys.executable, str(script), '--comfy-root', str(self.root)]
        result = subprocess.run(args + ['--dry-run'], capture_output=True)
        self.assertEqual(result.returncode, 0, result.stderr.decode())
        self.assertEqual(list((self.root / 'custom_nodes').iterdir()), [])
        result = subprocess.run(args, capture_output=True)
        self.assertEqual(result.returncode, 0, result.stderr.decode())
        installed = self.root / 'custom_nodes/comfy-asset-hub'
        manifest = release.load_manifest(script.parents[1])
        self.assertEqual({p.relative_to(installed).as_posix() for p in installed.rglob('*') if p.is_file()}, set(manifest['runtime_files']))


if __name__ == '__main__':
    unittest.main()
