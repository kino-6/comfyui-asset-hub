# Comfy Asset Hub — 素材庫

Browse, archive and restore generated images inside ComfyUI. Reclaim disk space with **verified lossless WebP**, while keeping generation metadata and the ability to restore PNGs.

[日本語の使い方](docs/USAGE.ja.md) · [Known limitations](KNOWN_ISSUES.md) · [Third-party credits](THIRD_PARTY.md)

## What it does

- Browse registered folders without moving images. Thumbnails, search, pagination, Shift selection and select-all across search results.
- Convert supported PNGs to lossless WebP. Compare decoded pixels, generation metadata and ICC profiles before replacing the PNG; keep the original when archiving would not save space.
- Restore PNGs individually or in batches. Resume interrupted jobs and inspect per-image progress and errors.
- Choose size or speed priority, concurrency and a CPU usage target. Processing runs locally; it does not use an external image service or alter ComfyUI's GPU settings.
- Explore connections between images through shared prompt terms and visual features (color, layout and edges). This is not semantic image recognition.

The UI is currently **Japanese**. Windows x64 is the primary tested platform and includes official libwebp executables. Other platforms use Pillow; their performance and full UI integration have not been verified.

## Install

Requires an existing ComfyUI installation with **Python 3.11+**. The built frontend is included: **Node.js is not needed to use the extension**.

From your ComfyUI directory:

```sh
git clone https://github.com/kino-6/comfyui-asset-hub.git custom_nodes/comfy-asset-hub
```

Install dependencies using **the same Python environment that runs ComfyUI**, if they are not already installed:

```sh
python -m pip install -r custom_nodes/comfy-asset-hub/requirements.txt
```

For Windows portable ComfyUI, run this from the portable root instead:

```powershell
.\python_embeded\python.exe -m pip install -r .\ComfyUI\custom_nodes\comfy-asset-hub\requirements.txt
```

Restart ComfyUI and reload the browser. Open the sidebar image icon labeled **素材庫** (Asset Hub). The **Extensions → 素材庫を開く** menu is also available. If upgrading an existing manual installation, use the same extension folder; do not install a second copy alongside it.

## First use

1. Choose **Output**, or use **フォルダ追加** to register an image folder on the computer running ComfyUI.
2. Select images (Shift-click for a range; **全選択** selects matching results across pages).
3. Keep **サイズ優先** (size priority), then click **圧縮 N件** to archive. The button counts eligible images; already archived images are skipped.
4. Use **復元 N件** to restore selected archives, or **PNGで取り出す** to download one restored PNG.

Compression replaces the PNG after verification, without a confirmation dialog. The filename changes to WebP. Try a copied folder first to check compatibility with your own downstream tools.

**通常** (Normal) is the default: use the selected concurrency and let the OS schedule CPU time. **他作業優先** (Prefer other work) keeps that concurrency but starts Windows codec child processes below normal priority; this does not change ComfyUI itself and currently has no priority effect on the Pillow backend on other platforms. **CPU目標** explicitly enables the optional overall CPU target controller, with normal process priority. Memory and disk-space checks apply in every mode. Priority changes apply to the next image; in-flight images finish before a pause takes effect.

Explicitly saved CPU targets from older versions are preserved; select Normal to stop CPU-based throttling. The old Full-speed option becomes Normal. An implicit old 70% default is not retained as a CPU restriction.

## What “lossless” means here

Pixels (including RGB values behind transparency), generation metadata and ICC profiles are verified. PNG restoration recreates pixels and saved ancillary chunks, **not the original PNG byte stream**. Only static 8-bit RGB/RGBA PNGs are eligible; formats such as 16-bit, palette PNG and APNG are rejected rather than converted with reduced fidelity.

**Keep the archived WebPs and ComfyUI's user-directory `asset-hub/` data together.** Full restoration needs the archive records, not just the WebP files. Back up both while ComfyUI is stopped. Uninstalling the extension does not restore images automatically; restore first if you need PNG paths again.

Existing archive databases are compacted on startup after a verified compressed backup is created. This can delay the first startup. Backups remain in `asset-hub/records-before-compression-*.sqlite3.gz`; they describe the migration-time state, not subsequent archives. See the [data and backup instructions](docs/USAGE.ja.md#データ).

Compression savings and speed depend on image contents, dimensions, hardware and settings. There is no fixed savings guarantee. This is an initial public release; see [tested scope and limitations](KNOWN_ISSUES.md).

## Development

Use Python 3.11+ and Node.js 22+:

```sh
python -m pip install -r requirements.txt
npm ci
npm run build
npm run test:progress
python -m unittest discover -s tests -v
python scripts/release.py check
```

The [Japanese manual](docs/USAGE.ja.md#開発と検証) describes isolated UI tests using synthetic images. [PUBLISHING.md](PUBLISHING.md) describes the explicit file allowlist and package checks. No personal images, local configuration, credentials or development history are included.

## License

Original code: [MIT](LICENSE), Copyright (c) 2026 kino-6. Image browsing builds on ComfyUI Image Browser by Lauri Gates; bundled third-party components retain their own licenses and notices. See [THIRD_PARTY.md](THIRD_PARTY.md).
