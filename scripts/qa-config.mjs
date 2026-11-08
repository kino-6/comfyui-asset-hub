import fs from 'node:fs';
import path from 'node:path';

// Do not search for installations or load private .env files automatically.
if (!process.env.COMFYUI_ROOT) throw Error('Set COMFYUI_ROOT to the ComfyUI directory before running E2E tests.');
export const comfy = path.resolve(process.env.COMFYUI_ROOT);
if (!fs.existsSync(path.join(comfy, 'main.py'))) throw Error('COMFYUI_ROOT must contain main.py.');
export const python = process.env.COMFYUI_PYTHON || path.join(comfy, process.platform === 'win32' ? 'venv/Scripts/python.exe' : 'venv/bin/python');
if (!fs.existsSync(python)) throw Error('Set COMFYUI_PYTHON to the Python executable with ComfyUI dependencies.');
export const port = Number(process.env.ASSET_HUB_QA_PORT || 8190);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw Error('Invalid ASSET_HUB_QA_PORT.');
export const base = `http://127.0.0.1:${port}`;
