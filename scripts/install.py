"""Copy manifest-listed runtime files; never restart ComfyUI or install dependencies."""
import argparse
import filecmp
from pathlib import Path

from release import load_manifest, read_source


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--comfy-root', required=True, type=Path, help='ComfyUI directory containing main.py')
    parser.add_argument('--dry-run', action='store_true')
    args = parser.parse_args()
    source = Path(__file__).resolve().parents[1]
    comfy = args.comfy_root.resolve()
    if not (comfy / 'main.py').is_file() or not (comfy / 'custom_nodes').is_dir():
        parser.error('--comfy-root must contain main.py and custom_nodes/')
    dest = comfy / 'custom_nodes' / 'comfy-asset-hub'
    if dest.resolve() == source:
        parser.error('Already installed here; no copy is needed.')
    manifest = load_manifest(source)
    files = read_source(source, manifest)
    for name in manifest['runtime_files']:
        target = dest / name
        if not target.resolve().is_relative_to(dest.absolute()) or dest.resolve() != dest.absolute():
            parser.error('Install destination redirects outside its directory.')
    if not args.dry_run:
        for name in manifest['runtime_files']:
            target = dest / name
            target.parent.mkdir(parents=True, exist_ok=True)
            if not target.is_file() or not filecmp.cmp(source / name, target, shallow=False):
                target.write_bytes(files[name])
    print(f'{"Would copy" if args.dry_run else "Copied"} {len(manifest["runtime_files"])} files to {dest}')


if __name__ == '__main__':
    main()
