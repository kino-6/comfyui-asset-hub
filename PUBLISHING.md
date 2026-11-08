# Building and checking a distribution

`release-files.json` explicitly lists publishable source files. Its `runtime_files` list controls the optional installer. Add files deliberately to both the appropriate manifest list and `.gitignore`; unknown files are excluded by default.

Python 3.11+ and Node.js 22+ are required for development. Node.js is not required to run the included frontend in ComfyUI.

```sh
python -m pip install -r requirements.txt
npm ci
npm run build
npm run test:progress
python -m unittest discover -s tests -v
python scripts/release.py check
python scripts/release.py stage
python scripts/release.py check-index
```

Review the staged diff before committing. After committing, run `python scripts/release.py check-history` before pushing. The checks inspect actual Git blobs, including reachable history, rather than only the current working tree.

```sh
python scripts/release.py archive --output dist/comfy-asset-hub.zip
```

The ZIP contains reviewed source, the built frontend, third-party notices and `SHA256SUMS`, under a single `comfy-asset-hub/` directory. Existing ZIPs are never overwritten. Extract this directory under ComfyUI's `custom_nodes/`; install dependencies using ComfyUI's Python environment, then restart ComfyUI.

Do not include generated images, actual prompts or workflows, databases, registered folder lists, local settings, logs, test outputs, virtual environments, dependency directories or source maps. The scanner detects common credentials, personal absolute paths, links and unexpected binaries. It cannot guarantee detection of all private information; review newly allowlisted content. Bundled native executables must match the pinned SHA-256 checksums.

CI checks the file list, staged contents and history, runs Python and frontend tests, and verifies that rebuilding produces the committed frontend.

The original code is MIT-licensed. Preserve `LICENSE`, `THIRD_PARTY.md`, and all bundled third-party license and patent notices in distributions.
