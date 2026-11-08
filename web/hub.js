// src/hub.ts
import { app as app2 } from "/scripts/app.js";

// node_modules/@laurigates/comfy-modal-kit/dist/index.js
function installBackGuard(onBack) {
  if (typeof window === "undefined" || typeof history === "undefined")
    return () => {
    };
  let armed = false;
  let disposed = false;
  const arm = () => {
    history.pushState({ cmpBackGuard: true }, "");
    armed = true;
  };
  const dispose = (opts) => {
    if (disposed)
      return;
    disposed = true;
    window.removeEventListener("popstate", onPop);
    if (armed) {
      armed = false;
      if (opts?.pop !== false)
        history.back();
    }
  };
  function onPop() {
    armed = false;
    let handled = false;
    try {
      handled = onBack();
    } catch (e) {
      console.error("[comfy-modal-kit] back handler threw", e);
    }
    if (handled && !disposed) {
      arm();
      return;
    }
    dispose();
  }
  arm();
  window.addEventListener("popstate", onPop);
  return dispose;
}
var ENTITIES = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;"
};
function escapeHTML(s) {
  return String(s).replace(/[&<>"']/g, (c) => ENTITIES[c]);
}
var KEY = Symbol.for("laurigates.comfyModalKit");
function getKit() {
  const g = globalThis;
  let kit = g[KEY];
  if (!kit) {
    kit = {
      fieldProviders: [],
      modelPickers: [],
      activeModal: null,
      pointerClaim: null,
      modalChrome: [],
      pointerGuardInstalled: false,
      hubEntries: [],
      hubLauncherInstalled: false,
      hubToggles: [],
      safeViewListeners: []
    };
    g[KEY] = kit;
  }
  if (!kit.fieldProviders)
    kit.fieldProviders = [];
  if (!kit.modelPickers)
    kit.modelPickers = [];
  if (!kit.modalChrome)
    kit.modalChrome = [];
  if (!kit.hubEntries)
    kit.hubEntries = [];
  if (!kit.hubToggles)
    kit.hubToggles = [];
  if (!kit.safeViewListeners)
    kit.safeViewListeners = [];
  return kit;
}
var SORT_OPTIONS = [
  { value: "mtime:desc", label: "Newest" },
  { value: "mtime:asc", label: "Oldest" },
  { value: "name:asc", label: "Name A\u2192Z" },
  { value: "name:desc", label: "Name Z\u2192A" },
  { value: "size:desc", label: "Largest file" },
  { value: "size:asc", label: "Smallest file" },
  { value: "pixels:desc", label: "Largest resolution" },
  { value: "pixels:asc", label: "Smallest resolution" },
  { value: "rating:desc", label: "Highest rating" },
  { value: "rating:asc", label: "Lowest rating" }
];
var VALID_SORTS = new Set(SORT_OPTIONS.map((o) => o.value));
function isValidSort(value) {
  return VALID_SORTS.has(value);
}
function sortFiles(files, key, dir) {
  const mul = dir === "asc" ? 1 : -1;
  const nameCmp = (a, b) => a.name.localeCompare(b.name, void 0, { numeric: true, sensitivity: "base" });
  const numCmp = (extract) => (a, b) => (extract(a) ?? 0) - (extract(b) ?? 0) || nameCmp(a, b);
  let cmp;
  switch (key) {
    case "name":
      cmp = nameCmp;
      break;
    case "size":
      cmp = numCmp((f) => f.size);
      break;
    case "pixels":
      cmp = numCmp((f) => f.width && f.height ? f.width * f.height : 0);
      break;
    case "rating":
      cmp = numCmp((f) => f.rating);
      break;
    default:
      cmp = numCmp((f) => f.mtime);
      break;
  }
  return [...files].sort((a, b) => mul * cmp(a, b));
}
var IMG_EXTS = /* @__PURE__ */ new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".gif",
  ".bmp",
  ".tiff",
  ".tif",
  ".avif"
]);
var VIDEO_EXTS = /* @__PURE__ */ new Set([
  ".mp4",
  ".webm",
  ".mov",
  ".mkv",
  ".avi",
  ".m4v",
  ".mpg",
  ".mpeg"
]);
var SANDBOXED_TYPES = ["input", "output", "temp"];
function joinAbs(dir, name) {
  const d = (dir || "/").replace(/\/+$/, "");
  return d === "" ? `/${name}` : `${d}/${name}`;
}
var META_FIELDS = [
  { key: "positive", label: "Positive" },
  { key: "negative", label: "Negative" },
  { key: "model", label: "Model" },
  { key: "seed", label: "Seed" },
  { key: "steps", label: "Steps" },
  { key: "cfg", label: "CFG" },
  { key: "sampler", label: "Sampler" },
  { key: "scheduler", label: "Scheduler" }
];
function metaRows(summary) {
  const rows = [];
  if (!summary || typeof summary !== "object")
    return rows;
  const bag = summary;
  for (const { key, label } of META_FIELDS) {
    const v = bag[key];
    if (v === void 0 || v === null)
      continue;
    const value = String(v);
    if (!value.trim())
      continue;
    rows.push({ key, label, value });
  }
  return rows;
}
function metaClipboardText(rows) {
  return rows.map((r) => `${r.label}: ${r.value}`).join(`
`);
}
function createViewStore(namespace) {
  const viewKey = `${namespace}:view`;
  const pendingKey = `${namespace}:view-pending`;
  return {
    load() {
      try {
        if (localStorage.getItem(pendingKey) === "1") {
          localStorage.removeItem(pendingKey);
          localStorage.setItem(viewKey, "folder");
          return { mode: "folder", recovered: true };
        }
        return {
          mode: localStorage.getItem(viewKey) === "flat" ? "flat" : "folder",
          recovered: false
        };
      } catch {
        return { mode: "folder", recovered: false };
      }
    },
    save(mode) {
      try {
        localStorage.setItem(viewKey, mode);
      } catch {
      }
    },
    markPending(pending) {
      try {
        if (pending)
          localStorage.setItem(pendingKey, "1");
        else
          localStorage.removeItem(pendingKey);
      } catch {
      }
    }
  };
}
var CHROME_ATTR = "data-cmp-chrome";
function setActiveModal(handle) {
  installPointerGuard();
  dismissActiveModal();
  getKit().activeModal = handle;
}
function dismissActiveModal() {
  const kit = getKit();
  const active = kit.activeModal;
  if (!active)
    return;
  kit.activeModal = null;
  try {
    active.close();
  } catch (e) {
    console.warn("[comfy-modal-kit] active modal close() threw", e);
  }
}
function isModalActive() {
  return getKit().activeModal !== null;
}
function getActiveModal() {
  return getKit().activeModal;
}
function registerModalChrome(el) {
  const chrome = getKit().modalChrome;
  if (!chrome.includes(el))
    chrome.push(el);
  el.setAttribute?.(CHROME_ATTR, "");
}
function unregisterModalChrome(el) {
  const chrome = getKit().modalChrome;
  for (let i = chrome.length - 1; i >= 0; i--) {
    if (chrome[i] === el)
      chrome.splice(i, 1);
  }
  el.removeAttribute?.(CHROME_ATTR);
}
function isModalChrome(node) {
  if (!node)
    return false;
  for (const el2 of getKit().modalChrome) {
    if (el2.contains?.(node))
      return true;
  }
  const el = node.nodeType === 1 ? node : node.parentElement;
  return !!el?.closest?.(`[${CHROME_ATTR}]`);
}
function installPointerGuard() {
  const kit = getKit();
  if (kit.pointerGuardInstalled)
    return;
  if (typeof window === "undefined")
    return;
  kit.pointerGuardInstalled = true;
  window.addEventListener("pointerdown", pointerGuard, true);
}
function pointerGuard(e) {
  const active = getKit().activeModal;
  if (!active)
    return;
  const target = e.target;
  if (active.element && target && active.element.contains(target)) {
    return;
  }
  if (isModalChrome(target)) {
    return;
  }
  e.stopImmediatePropagation();
  dismissActiveModal();
}
function ensureStyleOnce(id, css) {
  if (typeof document === "undefined")
    return;
  if (document.getElementById(id))
    return;
  const s = document.createElement("style");
  s.id = id;
  s.textContent = css;
  document.head.appendChild(s);
}
var STYLE_ID = "cmn-notify-style";
var CONTAINER_ID = "cmn-notify-container";
function defaultLife(severity) {
  switch (severity) {
    case "error":
      return 0;
    case "warn":
      return 8e3;
    default:
      return 4e3;
  }
}
function defaultCopyable(severity) {
  return severity === "error" || severity === "warn";
}
function notifyClipboardText(summary, detail) {
  return detail ? `${summary}
${detail}` : summary;
}
async function copyTextToClipboard(text) {
  try {
    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
  }
  try {
    if (typeof document === "undefined")
      return false;
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.top = "-1000px";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}
var CSS = `
.cmn-container {
    position: fixed;
    top: 12px;
    right: 12px;
    z-index: 10000;
    display: flex;
    flex-direction: column;
    gap: 8px;
    width: min(380px, calc(100vw - 24px));
    pointer-events: none;
    font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
}
/*
 * While a modal is up, clear the shell header's close button: .cmp-close is a
 * 36px button inside a .cmp-header padded 12px/14px at the dialog's top-right,
 * which lands under the toast's own \xD7 \u2014 worst case a full-viewport dialog like
 * comfyui-image-browser's .ib-dialog (100vw/100vh), where the two \xD7 controls
 * overlap exactly. Applied per raise, so a toast on the bare canvas keeps 12px.
 */
.cmn-container.cmn-modal-inset { top: 64px; }
.cmn-toast {
    pointer-events: auto;
    background: #1a1a1f;
    color: #e8e8ea;
    border: 1px solid #3a3a44;
    border-left-width: 4px;
    border-radius: 8px;
    box-shadow: 0 8px 28px rgba(0, 0, 0, 0.6);
    padding: 10px 12px;
    display: flex;
    flex-direction: column;
    gap: 8px;
    font-size: 13px;
    line-height: 1.4;
    animation: cmn-in 0.16s ease-out;
}
@keyframes cmn-in {
    from { transform: translateY(-8px); opacity: 0; }
    to   { transform: translateY(0);    opacity: 1; }
}
.cmn-toast.cmn-success { border-left-color: #4caf50; }
.cmn-toast.cmn-info    { border-left-color: #6ba6ff; }
.cmn-toast.cmn-warn    { border-left-color: #e0a83a; }
.cmn-toast.cmn-error   { border-left-color: #e0533a; }
.cmn-row {
    display: flex;
    align-items: flex-start;
    gap: 10px;
}
.cmn-text {
    flex: 1;
    min-width: 0;
    word-break: break-word;
}
.cmn-summary { font-weight: 600; }
.cmn-detail  { color: #b8b8c0; margin-top: 2px; white-space: pre-wrap; }
.cmn-close {
    background: transparent;
    color: #aaa;
    border: none;
    cursor: pointer;
    font-size: 18px;
    line-height: 1;
    padding: 0;
    /* Touch-first: a 32px target, with the growth absorbed by a negative margin
       so the toast's visual density is unchanged from the old 24px glyph box. */
    width: 32px;
    height: 32px;
    border-radius: 6px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    margin: -4px -4px 0 0;
    flex-shrink: 0;
}
.cmn-close:hover { color: #fff; }
.cmn-actions { display: flex; gap: 8px; }
.cmn-copy {
    background: #2a2a36;
    color: #d8d8e0;
    border: 1px solid #3a3a44;
    border-radius: 5px;
    /* Touch-first: comfortable tap target, 13px text. */
    min-height: 32px;
    padding: 6px 12px;
    cursor: pointer;
    font-size: 13px;
    font-family: inherit;
    display: inline-flex;
    align-items: center;
    gap: 6px;
}
.cmn-copy:hover  { background: #34343f; color: #fff; }
.cmn-copy.cmn-copied { background: #2f4a30; border-color: #4caf50; color: #cfe8d0; }
`;
function ensureContainer() {
  let c = document.getElementById(CONTAINER_ID);
  if (!c) {
    c = document.createElement("div");
    c.id = CONTAINER_ID;
    c.className = "cmn-container";
    document.body.appendChild(c);
  }
  registerModalChrome(c);
  return c;
}
function notify(opts) {
  const { severity, summary, detail } = opts;
  if (typeof document === "undefined" || !document.body) {
    console.info(`[notify] ${severity}: ${summary}${detail ? ` \u2014 ${detail}` : ""}`);
    return null;
  }
  ensureStyleOnce(STYLE_ID, CSS);
  const container = ensureContainer();
  container.classList.toggle("cmn-modal-inset", isModalActive());
  const life = opts.life ?? defaultLife(severity);
  const copyable = opts.copyable ?? defaultCopyable(severity);
  const toast = document.createElement("div");
  toast.className = `cmn-toast cmn-${severity}`;
  toast.setAttribute("role", severity === "error" ? "alert" : "status");
  let timer;
  const close = () => {
    if (timer)
      clearTimeout(timer);
    toast.remove();
    if (container.childElementCount === 0) {
      unregisterModalChrome(container);
      container.remove();
    }
  };
  const row = document.createElement("div");
  row.className = "cmn-row";
  const text = document.createElement("div");
  text.className = "cmn-text";
  const summaryEl = document.createElement("div");
  summaryEl.className = "cmn-summary";
  summaryEl.textContent = summary;
  text.appendChild(summaryEl);
  if (detail) {
    const detailEl = document.createElement("div");
    detailEl.className = "cmn-detail";
    detailEl.textContent = detail;
    text.appendChild(detailEl);
  }
  const closeBtn = document.createElement("button");
  closeBtn.className = "cmn-close";
  closeBtn.type = "button";
  closeBtn.textContent = "\xD7";
  closeBtn.title = "Dismiss";
  closeBtn.addEventListener("click", close);
  row.append(text, closeBtn);
  toast.appendChild(row);
  if (copyable) {
    const actions = document.createElement("div");
    actions.className = "cmn-actions";
    const copyBtn = document.createElement("button");
    copyBtn.className = "cmn-copy";
    copyBtn.type = "button";
    copyBtn.textContent = "Copy";
    copyBtn.addEventListener("click", async () => {
      const ok = await copyTextToClipboard(notifyClipboardText(summary, detail));
      copyBtn.textContent = ok ? "Copied \u2713" : "Copy failed";
      copyBtn.classList.toggle("cmn-copied", ok);
      setTimeout(() => {
        copyBtn.textContent = "Copy";
        copyBtn.classList.remove("cmn-copied");
      }, 1500);
    });
    actions.appendChild(copyBtn);
    toast.appendChild(actions);
  }
  container.appendChild(toast);
  if (life > 0) {
    timer = setTimeout(close, life);
  }
  return { close, el: toast };
}
var STYLE_ID2 = "cmp-shell-style";
var CSS2 = `
.cmp-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.55);
    z-index: 9998;
    backdrop-filter: blur(2px);
    touch-action: manipulation;
}
.cmp-dialog {
    position: fixed;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    z-index: 9999;
    width: min(960px, calc(100vw - 24px));
    max-height: min(85vh, 800px);
    touch-action: manipulation;
    display: flex;
    flex-direction: column;
    background: #1a1a1f;
    color: #e8e8ea;
    border: 1px solid #3a3a44;
    border-radius: 10px;
    box-shadow: 0 16px 48px rgba(0, 0, 0, 0.7);
    font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
    font-size: 13px;
    overflow: hidden;
}
.cmp-header {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 12px 14px;
    border-bottom: 1px solid #2a2a32;
    background: #21212a;
    flex-shrink: 0;
}
.cmp-title {
    flex: 1;
    font-weight: 600;
    color: #9ec6ff;
    font-size: 14px;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}
.cmp-subtitle {
    color: #888;
    font-weight: 400;
    font-size: 12px;
    margin-left: 6px;
}
.cmp-close {
    background: transparent;
    color: #aaa;
    border: 1px solid #3a3a44;
    border-radius: 4px;
    /* 44px, not 36: docs/modal-ux-drift-catalog.md:71 sets the family's D02
       target at >=44px, and the Touch Tools chooser cannot credibly promise
       >=44px rows while inheriting a 36px close control. */
    width: 44px;
    height: 44px;
    cursor: pointer;
    font-size: 20px;
    line-height: 1;
    flex-shrink: 0;
}
.cmp-close:hover {
    background: #2a2a32;
    color: #fff;
}
.cmp-toolbar {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: center;
    padding: 8px 14px;
    border-bottom: 1px solid #2a2a32;
    background: #1f1f26;
    flex-shrink: 0;
}
.cmp-toolbar:empty {
    display: none;
}
.cmp-searchrow {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 10px 14px;
    border-bottom: 1px solid #2a2a32;
    flex-shrink: 0;
}
.cmp-search {
    flex: 1;
    background: #12121a;
    border: 1px solid #3a3a44;
    border-radius: 4px;
    color: #e8e8ea;
    padding: 8px 12px;
    /* 16px prevents iOS auto-zoom on focus. */
    font-size: 16px;
    font-family: inherit;
    outline: none;
    min-width: 0;
}
.cmp-search:focus {
    border-color: #6ba6ff;
}
.cmp-status {
    color: #888;
    font-size: 12px;
    white-space: nowrap;
}
.cmp-body {
    flex: 1;
    overflow-y: auto;
    -webkit-overflow-scrolling: touch;
    overscroll-behavior: contain;
    padding: 8px;
    position: relative;
}
.cmp-body.is-busy {
    opacity: 0.5;
    pointer-events: none;
}
.cmp-footer {
    padding: 8px 14px;
    border-top: 1px solid #2a2a32;
    color: #777;
    font-size: 11px;
    background: #1f1f26;
    flex-shrink: 0;
    display: flex;
    justify-content: space-between;
    gap: 12px;
}
.cmp-footer:empty {
    display: none;
}
.cmp-footer kbd {
    background: #2a2a36;
    border: 1px solid #3a3a44;
    border-bottom-width: 2px;
    border-radius: 3px;
    padding: 1px 5px;
    font-family: ui-monospace, monospace;
    font-size: 10px;
    color: #b8b8c0;
}
`;
function openModalShell(opts = {}) {
  ensureStyleOnce(STYLE_ID2, CSS2);
  const backdrop = document.createElement("div");
  backdrop.className = "cmp-backdrop";
  const dialog = document.createElement("div");
  dialog.className = "cmp-dialog";
  if (opts.width)
    dialog.style.width = opts.width;
  if (opts.height)
    dialog.style.maxHeight = opts.height;
  const stop = (e) => e.stopPropagation();
  for (const ev of ["pointerdown", "pointerup", "click", "dblclick", "wheel"]) {
    dialog.addEventListener(ev, stop);
  }
  const headerEl = document.createElement("div");
  headerEl.className = "cmp-header";
  const titleEl = document.createElement("div");
  titleEl.className = "cmp-title";
  titleEl.textContent = opts.title || "";
  if (opts.subtitle) {
    const sub = document.createElement("span");
    sub.className = "cmp-subtitle";
    sub.textContent = opts.subtitle;
    titleEl.appendChild(sub);
  }
  const closeBtn = document.createElement("button");
  closeBtn.className = "cmp-close";
  closeBtn.type = "button";
  closeBtn.textContent = "\xD7";
  closeBtn.title = "Close (Esc)";
  headerEl.append(titleEl, closeBtn);
  const toolbarEl = document.createElement("div");
  toolbarEl.className = "cmp-toolbar";
  const searchRow = document.createElement("div");
  searchRow.className = "cmp-searchrow";
  const searchEl = document.createElement("input");
  searchEl.type = "search";
  searchEl.className = "cmp-search";
  searchEl.placeholder = opts.placeholder || "Filter\u2026";
  searchEl.spellcheck = false;
  searchEl.autocomplete = "off";
  const statusEl = document.createElement("div");
  statusEl.className = "cmp-status";
  searchRow.append(searchEl, statusEl);
  if (opts.showSearch === false)
    searchRow.style.display = "none";
  const bodyEl = document.createElement("div");
  bodyEl.className = "cmp-body";
  const footerEl = document.createElement("div");
  footerEl.className = "cmp-footer";
  if (opts.showFooter !== false) {
    const l = document.createElement("div");
    if (opts.footerLeftHTML)
      l.innerHTML = opts.footerLeftHTML;
    const r = document.createElement("div");
    if (opts.footerRightHTML)
      r.innerHTML = opts.footerRightHTML;
    footerEl.append(l, r);
  } else {
    footerEl.style.display = "none";
  }
  dialog.append(headerEl, toolbarEl, searchRow, bodyEl, footerEl);
  let torn = false;
  const teardown = () => {
    if (torn)
      return;
    torn = true;
    try {
      backdrop.remove();
      dialog.remove();
      document.removeEventListener("keydown", onKey, true);
      bodyEl.removeEventListener("scroll", onBodyScroll);
    } finally {
      try {
        opts.onClose?.();
      } catch (e) {
        console.warn("[modal-shell] onClose threw", e);
      }
    }
  };
  const handle = { id: "modal-shell", element: dialog, close: teardown };
  const requestClose = () => {
    if (getActiveModal() === handle) {
      dismissActiveModal();
    } else {
      teardown();
    }
  };
  backdrop.addEventListener("pointerdown", requestClose);
  closeBtn.addEventListener("click", requestClose);
  const onKey = (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      requestClose();
      return;
    }
    try {
      opts.onKeyDown?.(e);
    } catch (err) {
      console.warn("[modal-shell] onKeyDown threw", err);
    }
  };
  document.addEventListener("keydown", onKey, true);
  document.body.append(backdrop, dialog);
  let liveScrollTop = 0;
  const onBodyScroll = () => {
    liveScrollTop = bodyEl.scrollTop;
  };
  bodyEl.addEventListener("scroll", onBodyScroll, { passive: true });
  const controller = {
    backdrop,
    dialog,
    headerEl,
    toolbarEl,
    searchEl,
    statusEl,
    bodyEl,
    scrollHost: bodyEl,
    footerEl,
    setBusy(b) {
      bodyEl.classList.toggle("is-busy", !!b);
    },
    setStatus(s) {
      statusEl.textContent = s || "";
    },
    getScrollTop() {
      if (bodyEl.isConnected)
        liveScrollTop = bodyEl.scrollTop;
      return liveScrollTop;
    },
    close: requestClose,
    _onKey: onKey,
    opts
  };
  setActiveModal(handle);
  if (opts.showSearch !== false) {
    requestAnimationFrame(() => {
      if (getActiveModal() === handle)
        searchEl.focus();
    });
  }
  return controller;
}
var DEFAULT_SELECTOR = "img[data-src], video[data-src]";
function installLazyMedia(container, opts) {
  const noop = () => {
  };
  if (typeof IntersectionObserver === "undefined")
    return noop;
  const els = container.querySelectorAll(opts.selector ?? DEFAULT_SELECTOR);
  if (!els.length)
    return noop;
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting)
        continue;
      const el = e.target;
      const src = el.dataset.src;
      if (src) {
        if (el.tagName === "VIDEO")
          el.preload = "metadata";
        el.src = src;
        el.removeAttribute("data-src");
      }
      io.unobserve(el);
    }
  }, { root: opts.root, rootMargin: opts.rootMargin ?? "300px" });
  for (const el of els)
    io.observe(el);
  return () => io.disconnect();
}
function fuzzyScore(query, target) {
  if (!query)
    return { score: 0, matches: [] };
  if (!target)
    return null;
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  const matches = [];
  let qi = 0;
  let score = 0;
  let consecutive = 0;
  let prevMatchIdx = -1;
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] !== q[qi]) {
      consecutive = 0;
      continue;
    }
    let charScore = 1;
    if (ti === 0) {
      charScore += 5;
    } else {
      const prev = t[ti - 1];
      const orig = target[ti];
      if (prev === "_" || prev === "-" || prev === " " || prev === "." || prev === "/") {
        charScore += 4;
      } else if (prev !== void 0 && prev >= "a" && prev <= "z" && orig !== void 0 && orig >= "A" && orig <= "Z") {
        charScore += 3;
      }
    }
    if (ti === prevMatchIdx + 1) {
      consecutive++;
      charScore += consecutive * 2;
    } else {
      consecutive = 0;
    }
    score += charScore;
    matches.push(ti);
    prevMatchIdx = ti;
    qi++;
  }
  if (qi < q.length)
    return null;
  score -= target.length * 0.01;
  return { score, matches };
}
var MAX_RATING = 5;
function ratingOf(f) {
  const r = f.rating;
  return typeof r === "number" && r > 0 ? Math.min(MAX_RATING, Math.floor(r)) : 0;
}
function nextRating(cur, val) {
  return val === cur ? 0 : val;
}
function ratingRequestBody(addr, rating) {
  if (addr.type === "path") {
    return { type: "path", path: addr.absDir, name: addr.name, rating };
  }
  return { type: addr.type, subfolder: addr.subfolder, name: addr.name, rating };
}
async function postRating(url, addr, rating) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(ratingRequestBody(addr, rating))
  });
  if (!res.ok)
    throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  if (!data.ok)
    throw new Error(data.error || "rating failed");
  return typeof data.rating === "number" ? data.rating : rating;
}
function starsHTML(prefix, rating) {
  const r = ratingOf({ rating });
  let buttons = "";
  for (let i = 1; i <= MAX_RATING; i++) {
    const on = i <= r ? " is-on" : "";
    buttons += `<button type="button" class="${prefix}-star${on}" data-val="${i}" tabindex="-1">\u2605</button>`;
  }
  return `<div class="${prefix}-stars" data-rating="${r}" title="Rate (click the active star to clear)">${buttons}</div>`;
}
function applyStars(row, rating) {
  const r = ratingOf({ rating });
  row.dataset.rating = String(r);
  for (const s of row.querySelectorAll("[data-val]")) {
    s.classList.toggle("is-on", Number(s.dataset.val) <= r);
  }
}
var SAFE_VIEW_SETTINGS = {
  enabled: "TouchTools.SafeView.Enabled",
  keywords: "TouchTools.SafeView.Keywords",
  hide: "TouchTools.SafeView.Hide",
  blurNames: "TouchTools.SafeView.BlurNames",
  matchPrompt: "TouchTools.SafeView.MatchPrompt"
};
var SAFE_VIEW_DEFAULT_KEYWORDS = "nsfw";
var SAFE_VIEW_GLYPH_ON = "\u{1F648}";
var SAFE_VIEW_GLYPH_OFF = "\u{1F441}";
function safeViewSettings() {
  const fire = () => notifySafeViewChange();
  return [
    {
      id: SAFE_VIEW_SETTINGS.enabled,
      category: ["Touch Tools", "Safe View", "Enabled"],
      sortOrder: 100,
      name: "Safe View",
      tooltip: "Blur thumbnails and block out names for files and folders matching your keywords, in the Image Browser, the image picker and ComfyUI's own asset sidebar and lightbox. This is discretion, not security: the blur is CSS and the file is still downloaded, so it defeats someone glancing over your shoulder, not someone with your keyboard.",
      type: "boolean",
      defaultValue: true,
      onChange: fire
    },
    {
      id: SAFE_VIEW_SETTINGS.keywords,
      category: ["Touch Tools", "Safe View", "Keywords"],
      sortOrder: 90,
      name: "Keywords",
      tooltip: "Comma- or space-separated. Matched as WHOLE WORDS against the file name, every folder above it, and the file's XMP keyword tags \u2014 so 'nsfw' matches output/nsfw/pic.png and my_nsfw_pic.png, while 'ass' does not match assets/ or classic.png. Case-insensitive. Empty means nothing is filtered.",
      type: "text",
      defaultValue: SAFE_VIEW_DEFAULT_KEYWORDS,
      onChange: fire
    },
    {
      id: SAFE_VIEW_SETTINGS.hide,
      category: ["Touch Tools", "Safe View", "Hide"],
      sortOrder: 80,
      name: "Remove matches from the listing entirely",
      tooltip: "Off (default): matches stay in the grid, blurred, with a reveal button. On: matches are dropped server-side, so they never reach the browser and the listing count changes. Hiding is filtered above the newest-N cap, so a folder of mostly-sensitive files still returns a full page of the rest.",
      type: "boolean",
      defaultValue: false,
      onChange: fire
    },
    {
      id: SAFE_VIEW_SETTINGS.blurNames,
      category: ["Touch Tools", "Safe View", "Names"],
      sortOrder: 70,
      name: "Block out names too",
      tooltip: "Replaces the file name, its folder label and its tooltip with a solid block. Off leaves names readable under a blurred thumbnail \u2014 which usually defeats the point, since the folder name is often what matched.",
      type: "boolean",
      defaultValue: true,
      onChange: fire
    },
    {
      id: SAFE_VIEW_SETTINGS.matchPrompt,
      category: ["Touch Tools", "Safe View", "Prompt"],
      sortOrder: 60,
      name: "Also match the generation prompt and model",
      tooltip: "Off by default because it is expensive: every file's embedded metadata must be parsed and cached before its verdict is known, and a file with no verdict yet is blurred until the background scan reaches it. On a large library that means a mostly-blurred grid on first enable, clearing as the scan progresses.",
      type: "boolean",
      defaultValue: false,
      onChange: fire
    }
  ];
}
function safeViewSettingHost() {
  const host = globalThis;
  return host.app?.extensionManager?.setting ?? null;
}
var SAFE_VIEW_DEFAULTS = Object.freeze({
  enabled: true,
  keywords: Object.freeze([SAFE_VIEW_DEFAULT_KEYWORDS]),
  hide: false,
  blurNames: true,
  matchPrompt: false
});
function parseKeywords(raw) {
  if (typeof raw !== "string")
    return [];
  const out = [];
  const seen = /* @__PURE__ */ new Set();
  for (const piece of raw.split(/[\s,]+/)) {
    const kw = piece.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (!kw || seen.has(kw))
      continue;
    seen.add(kw);
    out.push(kw);
  }
  return out;
}
function readSafeViewConfig(host = safeViewSettingHost()) {
  if (!host)
    return SAFE_VIEW_DEFAULTS;
  const bool = (id, fallback) => {
    const v = host.get(id);
    return typeof v === "boolean" ? v : fallback;
  };
  const rawKeywords = host.get(SAFE_VIEW_SETTINGS.keywords);
  return {
    enabled: bool(SAFE_VIEW_SETTINGS.enabled, SAFE_VIEW_DEFAULTS.enabled),
    keywords: rawKeywords === void 0 ? SAFE_VIEW_DEFAULTS.keywords : parseKeywords(rawKeywords),
    hide: bool(SAFE_VIEW_SETTINGS.hide, SAFE_VIEW_DEFAULTS.hide),
    blurNames: bool(SAFE_VIEW_SETTINGS.blurNames, SAFE_VIEW_DEFAULTS.blurNames),
    matchPrompt: bool(SAFE_VIEW_SETTINGS.matchPrompt, SAFE_VIEW_DEFAULTS.matchPrompt)
  };
}
function sensitiveKeyword(cfg) {
  return cfg.keywords.length ? cfg.keywords[0] : null;
}
function tokenize(input) {
  if (typeof input !== "string" || input === "")
    return [];
  return input.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t !== "");
}
function isSensitive(target, cfg) {
  if (!cfg.enabled || cfg.keywords.length === 0)
    return false;
  const haystack = /* @__PURE__ */ new Set();
  for (const t of tokenize(target.name))
    haystack.add(t);
  for (const t of tokenize(target.path))
    haystack.add(t);
  for (const tag of target.tags ?? []) {
    for (const t of tokenize(tag))
      haystack.add(t);
  }
  for (const kw of cfg.keywords) {
    if (haystack.has(kw))
      return true;
  }
  if (cfg.matchPrompt) {
    if (target.promptMatch === true)
      return true;
    if (target.promptMatch === "unscanned")
      return true;
  }
  return false;
}
function makeRevealSet() {
  const set = /* @__PURE__ */ new Set();
  const key = (type, subfolder, name) => `${type}:${subfolder}:${name}`;
  return {
    key,
    has: (t, s, n) => set.has(key(t, s, n)),
    reveal: (t, s, n) => {
      set.add(key(t, s, n));
    },
    clear: () => set.clear(),
    get size() {
      return set.size;
    }
  };
}
var SAFE_VIEW_STYLE_ID = "cmk-safe-view-style";
var SAFE_VIEW_BLUR_CLASS = "cmk-sv-blur";
var SAFE_VIEW_SPOILER_CLASS = "cmk-sv-spoiler";
var SPOILER_TITLE_ATTR = "data-cmk-sv-title";
var SAFE_VIEW_CSS = `
.${SAFE_VIEW_BLUR_CLASS} {
    /* Scale past the edges: a blurred element otherwise fades toward its own
       border and leaks a readable silhouette of the content at the rim. */
    filter: blur(18px);
    transform: scale(1.08);
}
.${SAFE_VIEW_SPOILER_CLASS} {
    /* A SOLID BLOCK, never a text blur \u2014 blurred text stays readable at small
       sizes, which is exactly the size a phone grid renders names at. */
    background: #3a3a44;
    color: transparent;
    border-radius: 3px;
    user-select: none;
    -webkit-user-select: none;
    cursor: default;
}
.cmk-sv-reveal {
    position: absolute;
    top: 4px;
    left: 4px;
    z-index: 2;
    /* >=34px is the family's per-card control floor. */
    min-width: 34px;
    min-height: 34px;
    padding: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 15px;
    line-height: 1;
    background: rgba(20, 20, 26, 0.82);
    color: #e8e8ea;
    border: 1px solid #4a4a58;
    border-radius: 8px;
    cursor: pointer;
    touch-action: manipulation;
}
.cmk-sv-reveal:hover {
    background: rgba(40, 40, 52, 0.92);
}
`;
function ensureSafeViewStyle() {
  ensureStyleOnce(SAFE_VIEW_STYLE_ID, SAFE_VIEW_CSS);
}
function setBlurred(el, blurred) {
  ensureSafeViewStyle();
  el.classList.toggle(SAFE_VIEW_BLUR_CLASS, blurred);
}
function setSpoilered(el, spoilered) {
  ensureSafeViewStyle();
  el.classList.toggle(SAFE_VIEW_SPOILER_CLASS, spoilered);
  if (spoilered) {
    const title = el.getAttribute("title");
    if (title !== null) {
      el.setAttribute(SPOILER_TITLE_ATTR, title);
      el.removeAttribute("title");
    }
  } else {
    const parked = el.getAttribute(SPOILER_TITLE_ATTR);
    if (parked !== null) {
      el.setAttribute("title", parked);
      el.removeAttribute(SPOILER_TITLE_ATTR);
    }
  }
}
function makeRevealButton(opts) {
  ensureSafeViewStyle();
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "cmk-sv-reveal";
  btn.textContent = SAFE_VIEW_GLYPH_OFF;
  btn.title = "Reveal";
  btn.setAttribute("aria-label", opts.label ?? "Reveal hidden item");
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    e.preventDefault();
    opts.onReveal();
  });
  return btn;
}
function onSafeViewChange(listener) {
  const list = getKit().safeViewListeners;
  list.push(listener);
  return () => {
    const i = list.indexOf(listener);
    if (i >= 0)
      list.splice(i, 1);
  };
}
function notifySafeViewChange() {
  for (const listener of [...getKit().safeViewListeners]) {
    try {
      listener();
    } catch (e) {
      console.error("[comfy-modal-kit] safe-view listener failed", e);
    }
  }
}
function toggleSafeView(host = safeViewSettingHost()) {
  if (!host)
    return;
  const cfg = readSafeViewConfig(host);
  if (cfg.keywords.length === 0) {
    notify({
      severity: "warn",
      summary: "Safe View has no keywords",
      detail: "Add keywords in Settings \u2192 Touch Tools \u2192 Safe View \u2192 Keywords."
    });
    return;
  }
  host.set(SAFE_VIEW_SETTINGS.enabled, !cfg.enabled);
}
var SCROLL_RESTORE_FRAMES = 12;
var NATIVE_SCROLL_KEYS = /* @__PURE__ */ new Set([
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "PageUp",
  "PageDown",
  "Home",
  "End"
]);
var GESTURE_EVENTS = ["pointerdown", "wheel", "touchstart"];
function defaultIsTypingTarget() {
  const el = typeof document === "undefined" ? null : document.activeElement;
  if (!el)
    return false;
  if (el.isContentEditable)
    return true;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}
function installScrollRestore(host, opts) {
  const frames = Math.max(0, opts?.frames ?? SCROLL_RESTORE_FRAMES);
  const isTyping = opts?.isTypingTarget ?? defaultIsTypingTarget;
  const keyTarget = opts?.keyTarget ?? (typeof window === "undefined" ? null : window);
  let liveScrollTop = 0;
  let userTookOver = false;
  let raf = 0;
  const onScroll = () => {
    liveScrollTop = host.scrollTop;
  };
  host.addEventListener("scroll", onScroll, { passive: true });
  function cancel() {
    if (raf !== 0) {
      cancelAnimationFrame(raf);
      raf = 0;
    }
  }
  function yieldScroller() {
    userTookOver = true;
    cancel();
  }
  for (const ev of GESTURE_EVENTS) {
    host.addEventListener(ev, yieldScroller, { passive: true, capture: true });
  }
  const onKey = (e) => {
    const key = e.key;
    if (!NATIVE_SCROLL_KEYS.has(key) || isTyping())
      return;
    yieldScroller();
  };
  keyTarget?.addEventListener("keydown", onKey, true);
  function current() {
    if (host.isConnected)
      liveScrollTop = host.scrollTop;
    return liveScrollTop;
  }
  function set(top) {
    host.scrollTop = top;
    liveScrollTop = host.scrollTop;
  }
  function restore(target) {
    cancel();
    userTookOver = false;
    set(target);
    if (target <= 0)
      return;
    if (typeof requestAnimationFrame !== "function" || host.clientHeight <= 0)
      return;
    if (frames <= 0)
      return;
    let n = 0;
    const step = () => {
      raf = 0;
      if (userTookOver || !host.isConnected)
        return;
      const max = Math.max(0, host.scrollHeight - host.clientHeight);
      const reachable = Math.min(target, max);
      if (Math.abs(host.scrollTop - reachable) > 1)
        set(reachable);
      if (++n >= frames)
        return;
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
  }
  return {
    host,
    current,
    set,
    restore,
    cancel,
    sync() {
      liveScrollTop = host.scrollTop;
    },
    dispose() {
      cancel();
      host.removeEventListener("scroll", onScroll);
      for (const ev of GESTURE_EVENTS) {
        host.removeEventListener(ev, yieldScroller, true);
      }
      keyTarget?.removeEventListener("keydown", onKey, true);
    }
  };
}
function createScrollMemory() {
  const slots = /* @__PURE__ */ new Map();
  return {
    get(key) {
      return slots.get(key) ?? 0;
    },
    remember(key, top) {
      slots.set(key, top);
    },
    forget(key) {
      slots.delete(key);
    },
    get size() {
      return slots.size;
    }
  };
}
var STYLE_ID3 = "cmp-overlay-style";
var CSS3 = `
.cmp-ov-backdrop {
    position: absolute;
    inset: 0;
    z-index: 5;
    background: rgba(0, 0, 0, 0.55);
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 16px;
    touch-action: manipulation;
}
.cmp-ov-card {
    background: #1c1c24;
    border: 1px solid #33333f;
    border-radius: 10px;
    padding: 18px;
    width: min(520px, calc(100% - 24px));
    max-height: calc(100% - 24px);
    display: flex;
    flex-direction: column;
    gap: 12px;
    box-shadow: 0 12px 40px rgba(0, 0, 0, 0.5);
}
.cmp-ov-title { font-size: 15px; font-weight: 600; color: #e8e8ec; }
.cmp-ov-msg { font-size: 13px; color: #b8b8c0; line-height: 1.5; word-break: break-word; }
.cmp-ov-input {
    font-size: 16px;
    padding: 10px 12px;
    background: #12121a;
    border: 1px solid #3a3a44;
    border-radius: 6px;
    color: #e8e8ec;
    font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
}
.cmp-ov-input:focus { outline: none; border-color: #6ba6ff; }
.cmp-ov-err { font-size: 12px; color: #ff7a7a; min-height: 14px; }
.cmp-ov-actions { display: flex; justify-content: flex-end; gap: 8px; }
.cmp-ov-btn {
    font-size: 13px;
    padding: 9px 16px;
    border-radius: 6px;
    border: 1px solid #3a3a44;
    background: #2a2a36;
    color: #d8d8dc;
    cursor: pointer;
    font-family: inherit;
    min-height: 38px;
}
.cmp-ov-btn:hover { background: #3a3a4a; color: #fff; }
.cmp-ov-primary { background: #2f3a52; color: #9ec6ff; border-color: #4a5878; }
.cmp-ov-primary:hover { background: #3a4868; color: #fff; }
.cmp-ov-danger { background: #4a2230; color: #ff9eb0; border-color: #78384a; }
.cmp-ov-danger:hover { background: #5c2a3c; color: #fff; }
`;
function openShellOverlay(shell, opts = {}) {
  ensureStyleOnce(STYLE_ID3, CSS3);
  const backdrop = document.createElement("div");
  backdrop.className = "cmp-ov-backdrop";
  const card = document.createElement("div");
  card.className = "cmp-ov-card";
  backdrop.appendChild(card);
  const onKey = (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      dismiss();
    }
  };
  let closed = false;
  function close() {
    if (closed)
      return;
    closed = true;
    document.removeEventListener("keydown", onKey, true);
    document.addEventListener("keydown", shell._onKey, true);
    backdrop.remove();
  }
  function dismiss() {
    opts.onDismiss?.();
    close();
  }
  backdrop.addEventListener("pointerdown", (e) => {
    if (e.target === backdrop)
      dismiss();
  });
  document.removeEventListener("keydown", shell._onKey, true);
  document.addEventListener("keydown", onKey, true);
  shell.dialog.appendChild(backdrop);
  return { card, close };
}
function confirmInShell(shell, opts) {
  return new Promise((resolve) => {
    const ov = openShellOverlay(shell, { onDismiss: () => resolve(false) });
    const h = document.createElement("div");
    h.className = "cmp-ov-title";
    h.textContent = opts.title;
    const p = document.createElement("div");
    p.className = "cmp-ov-msg";
    p.textContent = opts.message;
    const row = document.createElement("div");
    row.className = "cmp-ov-actions";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "cmp-ov-btn";
    cancel.textContent = opts.cancelLabel || "Cancel";
    cancel.addEventListener("click", () => {
      ov.close();
      resolve(false);
    });
    const ok = document.createElement("button");
    ok.type = "button";
    ok.className = opts.danger ? "cmp-ov-btn cmp-ov-danger" : "cmp-ov-btn cmp-ov-primary";
    ok.textContent = opts.confirmLabel || "OK";
    const confirm = () => {
      ov.close();
      resolve(true);
    };
    ok.addEventListener("click", confirm);
    if (opts.enterConfirms) {
      ov.card.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          confirm();
        }
      });
    }
    row.append(cancel, ok);
    ov.card.append(h, p, row);
    ok.focus();
  });
}
function promptInShell(shell, opts) {
  return new Promise((resolve) => {
    const ov = openShellOverlay(shell, { onDismiss: () => resolve(null) });
    const h = document.createElement("div");
    h.className = "cmp-ov-title";
    h.textContent = opts.title;
    const input = document.createElement("input");
    input.type = "text";
    input.className = "cmp-ov-input";
    input.value = opts.value || "";
    if (opts.label)
      input.setAttribute("aria-label", opts.label);
    const errEl = document.createElement("div");
    errEl.className = "cmp-ov-err";
    const row = document.createElement("div");
    row.className = "cmp-ov-actions";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "cmp-ov-btn";
    cancel.textContent = "Cancel";
    cancel.addEventListener("click", () => {
      ov.close();
      resolve(null);
    });
    const ok = document.createElement("button");
    ok.type = "button";
    ok.className = "cmp-ov-btn cmp-ov-primary";
    ok.textContent = opts.confirmLabel || "OK";
    function submit() {
      const v = input.value.trim();
      const err = opts.validate?.(v) ?? (v ? null : "Value required");
      if (err) {
        errEl.textContent = err;
        return;
      }
      ov.close();
      resolve(v);
    }
    ok.addEventListener("click", submit);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        submit();
      }
    });
    row.append(cancel, ok);
    ov.card.append(h, input, errEl, row);
    input.focus();
    input.select();
  });
}

// vendor/image-browser/src/api.ts
var EXT_NAME = "comfyui-image-browser";
var BASE_URL = "/image_browser/base";
var LIST_URL = "/image_browser/list";
var THUMB_URL = "/image_browser/thumb";
var FILE_URL = "/image_browser/file";
var METADATA_URL = "/image_browser/metadata";
var DELETE_URL = "/image_browser/delete";
var DELETE_MANY_URL = "/image_browser/delete_many";
var RENAME_URL = "/image_browser/rename";
var MOVE_URL = "/image_browser/move";
var MOVE_DIR_URL = "/image_browser/move_dir";
var MOVE_MANY_URL = "/image_browser/move_many";
var RMDIR_URL = "/image_browser/rmdir";
var MKDIR_URL = "/image_browser/mkdir";
var UPLOAD_URL = "/image_browser/upload";
var PINS_URL = "/image_browser/pins";
var RATING_URL = "/image_browser/rating";
var META_VIDEO_EXTS = /* @__PURE__ */ new Set([".mp4", ".m4v", ".mov", ".webm", ".mkv"]);
var META_EXTS = /* @__PURE__ */ new Set([...IMG_EXTS, ...META_VIDEO_EXTS]);
var SANDBOXED_TYPES2 = [...SANDBOXED_TYPES];
var PATH_READS_DISABLED_MSG = "Reading files by absolute path is off. Turn on Settings \u2192 Touch Tools \u2192 Image Browser \u2192 \u201CAllow absolute-path file reads\u201D to preview and open files outside input/output/temp.";
var BASE_PATHS = null;
function pathReadsAllowed() {
  return BASE_PATHS?.allow_path_reads === true;
}
function invalidateBasePaths() {
  BASE_PATHS = null;
}
async function fetchBasePaths() {
  if (BASE_PATHS) return BASE_PATHS;
  let resolved;
  try {
    const r = await fetch(BASE_URL, { cache: "no-cache" });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();
    if (!data.ok) throw new Error(data.error || "base paths fetch failed");
    resolved = data;
  } catch (e) {
    console.warn(`[${EXT_NAME}] ${BASE_URL} failed`, e);
    resolved = { base_path: "/", input_dir: "", output_dir: "", temp_dir: "" };
  }
  BASE_PATHS = resolved;
  return resolved;
}
async function fetchListing(p) {
  const params = new URLSearchParams();
  if (p.type === "path") {
    params.set("type", "path");
    params.set("path", p.path || "/");
  } else {
    params.set("type", p.type);
    params.set("subfolder", p.subfolder || "");
    if (p.recursive) params.set("recursive", "1");
  }
  if (p.kind && p.kind !== "all") params.set("kind", p.kind);
  if (p.safeHide && p.safeKeywords && p.safeKeywords.length > 0) {
    params.set("safe_kw", p.safeKeywords.join(","));
    params.set("safe_hide", "1");
  }
  if (p.safePrompt && p.safeKeywords && p.safeKeywords.length > 0) {
    params.set("safe_kw", p.safeKeywords.join(","));
    params.set("safe_prompt", "1");
  }
  const r = await fetch(`${LIST_URL}?${params.toString()}`, { cache: "no-cache" });
  const data = await r.json().catch(() => null);
  if (!r.ok) throw new Error(data?.error || `HTTP ${r.status}`);
  if (!data?.ok) throw new Error(data?.error || "listing failed");
  return data;
}
function thumbVersion(mtime, size) {
  return `${mtime}-${size ?? 0}`;
}
function imageThumbURL(type, subfolder, name, absDir, v) {
  if (type === "path") {
    return `${THUMB_URL}?path=${encodeURIComponent(joinAbs(absDir, name))}&v=${encodeURIComponent(v)}`;
  }
  const p = new URLSearchParams({
    type,
    subfolder: subfolder || "",
    name,
    v
  });
  return `${THUMB_URL}?${p.toString()}`;
}
function videoSrcURL(type, subfolder, name, absDir) {
  if (type === "path") {
    return `${FILE_URL}?path=${encodeURIComponent(joinAbs(absDir, name))}`;
  }
  const p = new URLSearchParams({ filename: name, type, subfolder: subfolder || "" });
  return `${type.startsWith("hub:") ? "/asset_hub/file" : "/api/view"}?${p.toString()}`;
}
function fullSrcURL(type, subfolder, name, absDir) {
  if (type === "path") {
    return `${FILE_URL}?path=${encodeURIComponent(joinAbs(absDir, name))}`;
  }
  const p = new URLSearchParams({ filename: name, type, subfolder: subfolder || "" });
  return `${type.startsWith("hub:") ? "/asset_hub/file" : "/api/view"}?${p.toString()}`;
}
async function fetchMetadata(type, subfolder, name, absDir) {
  const params = type === "path" ? new URLSearchParams({ path: joinAbs(absDir, name) }) : new URLSearchParams({ type, subfolder: subfolder || "", name });
  const r = await fetch(`${METADATA_URL}?${params.toString()}`, { cache: "no-cache" });
  let data = {};
  try {
    data = await r.json();
  } catch {
  }
  if (!r.ok || !data.ok) {
    throw new Error(data.error || `HTTP ${r.status}`);
  }
  return {
    ok: true,
    format: data.format || "",
    source: data.source || "none",
    summary: data.summary || {},
    raw: data.raw || {},
    truncated: data.truncated === true
  };
}
var WORKFLOW_RAW_KEYS = ["workflow", "prompt"];
function embeddedWorkflowJSON(meta) {
  const raw = meta?.raw;
  if (!raw) return null;
  for (const k of WORKFLOW_RAW_KEYS) {
    const v = raw[k];
    if (typeof v !== "string") continue;
    const t = v.trim();
    if (t !== "" && t !== "null" && t !== "{}" && t !== "[]") return v;
  }
  return null;
}
async function postJSON(url, body) {
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  let data = {};
  try {
    data = await r.json();
  } catch {
  }
  if (!r.ok || !data.ok) {
    throw new Error(data.error || `HTTP ${r.status}`);
  }
}
function deleteFile(type, subfolder, name) {
  return postJSON(DELETE_URL, { type, subfolder, name });
}
function renameFile(type, subfolder, name, newName) {
  return postJSON(RENAME_URL, { type, subfolder, name, new_name: newName });
}
function moveFile(type, subfolder, name, destType, destSubfolder) {
  return postJSON(MOVE_URL, {
    type,
    subfolder,
    name,
    dest_type: destType,
    dest_subfolder: destSubfolder
  });
}
function moveDir(type, subfolder, name, destType, destSubfolder) {
  return postJSONBatch(MOVE_DIR_URL, {
    type,
    subfolder,
    name,
    dest_type: destType,
    dest_subfolder: destSubfolder
  });
}
async function postJSONBatch(url, body) {
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  let data;
  try {
    data = await r.json();
  } catch {
    throw new Error(`HTTP ${r.status}`);
  }
  if (!r.ok || !data?.ok) {
    const msg = data?.error || `HTTP ${r.status}`;
    throw new Error(msg);
  }
  return data;
}
function deleteMany(items) {
  return postJSONBatch(DELETE_MANY_URL, { items });
}
async function removeDir(type, subfolder, name, recursive = false) {
  const r = await fetch(RMDIR_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type, subfolder, name, recursive })
  });
  let data = {};
  try {
    data = await r.json();
  } catch {
  }
  if (r.ok && data.ok) {
    return { status: "deleted", files: data.files ?? 0, dirs: data.dirs ?? 0 };
  }
  if (r.status === 409 && typeof data.files === "number") {
    return { status: "not_empty", files: data.files, dirs: data.dirs ?? 0 };
  }
  throw new Error(data.error || `HTTP ${r.status}`);
}
function moveMany(items, destType, destSubfolder) {
  return postJSONBatch(MOVE_MANY_URL, {
    items,
    dest_type: destType,
    dest_subfolder: destSubfolder
  });
}
function makeDir(type, subfolder, name) {
  return postJSON(MKDIR_URL, { type, subfolder, name });
}
var UPLOAD_HEADER = "X-Image-Browser-Upload";
async function uploadFiles(type, subfolder, files) {
  const form = new FormData();
  form.append("type", type);
  form.append("subfolder", subfolder);
  for (const f of files) form.append("file", f, f.name);
  const r = await fetch(UPLOAD_URL, {
    method: "POST",
    headers: { [UPLOAD_HEADER]: "1" },
    body: form
  });
  let data;
  try {
    data = await r.json();
  } catch {
    throw new Error(`HTTP ${r.status}`);
  }
  if (!data || typeof data !== "object") throw new Error(`HTTP ${r.status}`);
  return {
    ok: r.ok && data.ok === true,
    uploaded: Array.isArray(data.uploaded) ? data.uploaded : [],
    errors: Array.isArray(data.errors) ? data.errors : [],
    error: data.error ?? (r.ok ? void 0 : `HTTP ${r.status}`)
  };
}
function pinKeyOf(p) {
  return `${p.kind}:${p.type}:${p.subfolder}:${p.name ?? ""}`;
}
async function readPinsResponse(r) {
  let data = {};
  try {
    data = await r.json();
  } catch {
  }
  if (!r.ok || !data.ok) {
    throw new Error(data.error || `HTTP ${r.status}`);
  }
  return { ok: true, max: typeof data.max === "number" ? data.max : 0, pins: data.pins ?? [] };
}
async function fetchPins() {
  return readPinsResponse(await fetch(PINS_URL, { cache: "no-cache" }));
}
async function postPinDelta(op, item) {
  const body = { op };
  if (item) body.item = item;
  const r = await fetch(PINS_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  return readPinsResponse(r);
}
function pinsToFiles(entries) {
  const out = [];
  for (const e of entries) {
    if (e.kind !== "file") continue;
    const name = e.name;
    if (!name) continue;
    const dot = name.lastIndexOf(".");
    out.push({
      name,
      // A missing file has no backend-reported ext; derive it from the pinned
      // name so the card still routes to the right thumbnail kind if it returns.
      ext: (e.ext ?? (dot >= 0 ? name.slice(dot) : "")).toLowerCase(),
      mtime: e.exists ? e.mtime ?? 0 : 0,
      size: e.exists ? e.size ?? 0 : 0,
      width: e.width,
      height: e.height,
      rating: e.exists ? e.rating ?? 0 : 0,
      // Unlike the numeric stats above, an absent value is left ABSENT rather
      // than normalized to []: nothing sorts on it, and "the backend sent no
      // keywords" is a fact the Safe View target should carry through
      // unchanged. A missing pin has no packet to read, so it has none.
      ...e.exists && e.tags ? { tags: e.tags } : {},
      pinType: e.type,
      pinSub: e.subfolder,
      pinKind: "file",
      pinExists: e.exists
    });
  }
  return out;
}

// vendor/image-browser/src/browser.ts
import { app } from "/scripts/app.js";

// vendor/image-browser/src/label.ts
var COUNTER_RE = /_\d{2,6}_?$/;
var TIME_PREFIX_RE = /^\d{6}_/;
var EXT_RE = /\.[A-Za-z0-9]{1,5}$/;
function stripCounter(name) {
  const ext = EXT_RE.exec(name);
  const suffix = ext ? ext[0] : "";
  const stem = suffix ? name.slice(0, -suffix.length) : name;
  if (!stem || !TIME_PREFIX_RE.test(stem)) return name;
  const trimmed = stem.replace(COUNTER_RE, "");
  return trimmed ? trimmed + suffix : name;
}
function splitTail(name, minTail = 8, maxTail = 14) {
  if (name.length <= maxTail) return { head: "", tail: name };
  const from = name.length - maxTail;
  for (let i = from; i <= name.length - minTail; i++) {
    const ch = name[i];
    if (ch === "_" || ch === "-" || ch === "/")
      return { head: name.slice(0, i), tail: name.slice(i) };
  }
  const cut = name.length - minTail;
  return { head: name.slice(0, cut), tail: name.slice(cut) };
}
function labelParts(name, verbatim) {
  if (verbatim) return { head: "", tail: name };
  return splitTail(stripCounter(name));
}

// vendor/image-browser/src/lightbox.ts
var STYLE_ID4 = "ib-lightbox-style";
var SWIPE_MIN_PX = 50;
function neighbour(list, from, dir) {
  for (let i = from + dir; i >= 0 && i < list.length; i += dir) {
    const f = list[i];
    if (f) return f;
  }
  return null;
}
function openLightbox(start, deps) {
  ensureStyleOnce(STYLE_ID4, CSS4);
  const { shell } = deps;
  const root = document.createElement("div");
  root.className = "cmp-ov-backdrop ib-lb";
  root.setAttribute("role", "dialog");
  root.setAttribute("aria-modal", "true");
  root.setAttribute("aria-label", "Image viewer");
  root.innerHTML = `
    <button type="button" class="ib-lb-btn ib-lb-close" data-lb="close" aria-label="Close">\u2715</button>
    <button type="button" class="ib-lb-btn ib-lb-nav ib-lb-prev" data-lb="prev" aria-label="Previous">\u2039</button>
    <div class="ib-lb-stage"></div>
    <button type="button" class="ib-lb-btn ib-lb-nav ib-lb-next" data-lb="next" aria-label="Next">\u203A</button>
    <div class="ib-lb-bar"></div>`;
  const stage = root.querySelector(".ib-lb-stage");
  const bar = root.querySelector(".ib-lb-bar");
  const prevBtn = root.querySelector(".ib-lb-prev");
  const nextBtn = root.querySelector(".ib-lb-next");
  let current = null;
  let closed = false;
  let busy = false;
  function indexOfCurrent() {
    return current ? deps.files().indexOf(current) : -1;
  }
  function show(f) {
    current = f;
    const list = deps.files();
    const i = list.indexOf(f);
    prevBtn.hidden = !neighbour(list, i, -1);
    nextBtn.hidden = !neighbour(list, i, 1);
    stage.innerHTML = "";
    const src = deps.src(f);
    const kind = deps.kind(f);
    if ("blocked" in src) {
      stage.innerHTML = `<div class="ib-lb-msg">\u{1F512} ${escapeHTML(src.blocked)}</div>`;
    } else if (kind === "image") {
      const img = document.createElement("img");
      img.className = "ib-lb-media";
      img.alt = deps.name(f);
      img.draggable = false;
      img.src = src.url;
      stage.appendChild(img);
    } else if (kind === "video") {
      const v = document.createElement("video");
      v.className = "ib-lb-media";
      v.src = src.url;
      v.controls = true;
      v.autoplay = true;
      v.loop = true;
      v.playsInline = true;
      stage.appendChild(v);
    } else {
      stage.innerHTML = `<div class="ib-lb-msg">No preview for this file type.</div>`;
    }
    if (deps.hidden(f)) {
      for (const el of stage.querySelectorAll("img, video")) setBlurred(el, true);
      const btn = makeRevealButton({
        onReveal: () => {
          deps.reveal(f);
          if (current === f) show(f);
        }
      });
      btn.classList.add("ib-lb-reveal");
      stage.appendChild(btn);
    }
    const rating = deps.rating(f);
    const n = list.filter(Boolean).length;
    const pos = list.slice(0, i + 1).filter(Boolean).length;
    bar.innerHTML = `
      ${rating === null ? "" : starsHTML("ib", rating)}
      ${deps.canDelete(f) ? `<button type="button" class="ib-lb-btn" data-lb="delete" title="Delete\u2026" aria-label="Delete">\u{1F5D1}</button>` : ""}
      <button type="button" class="ib-lb-btn" data-lb="tab" title="Open in new tab" aria-label="Open in new tab">\u2197</button>
      <span class="ib-lb-name" title="${escapeHTML(deps.name(f))}">${escapeHTML(deps.name(f))}</span>
      <span class="ib-lb-pos">${pos}/${n}</span>`;
  }
  function step(dir) {
    const next = neighbour(deps.files(), indexOfCurrent(), dir);
    if (next) show(next);
  }
  async function onDelete() {
    const f = current;
    if (!f || busy) return;
    const before = deps.files();
    const at = before.indexOf(f);
    busy = true;
    let gone = false;
    try {
      gone = await deps.remove(f);
    } finally {
      busy = false;
      if (!closed) document.removeEventListener("keydown", shell._onKey, true);
    }
    if (closed || !gone) return;
    const after = deps.files();
    const land = neighbour(after, at - 1, 1) ?? neighbour(after, at, -1);
    if (land) show(land);
    else close();
  }
  function onRate(star) {
    const f = current;
    const row = star.closest(".ib-stars");
    if (!f || !row) return;
    const prev = Number(row.dataset.rating || "0");
    const next = nextRating(prev, Number(star.dataset.val));
    applyStars(row, next);
    deps.rate(f, next).then(
      (confirmed) => {
        if (current === f && row.isConnected) applyStars(row, confirmed);
      },
      () => {
        if (current === f && row.isConnected) applyStars(row, prev);
      }
    );
  }
  root.addEventListener("click", (e) => {
    if (swiped) {
      swiped = false;
      return;
    }
    const t = e.target;
    const star = t.closest(".ib-star");
    if (star) return onRate(star);
    const action = t.closest("[data-lb]")?.dataset.lb;
    if (action === "close") close();
    else if (action === "prev") step(-1);
    else if (action === "next") step(1);
    else if (action === "delete") void onDelete();
    else if (action === "tab" && current) deps.openInTab(current);
    else if (t === root || t === stage) close();
  });
  let swipeX = 0;
  let swipeY = 0;
  let swiping = false;
  let swiped = false;
  root.addEventListener("pointerdown", (e) => {
    swiped = false;
    if (e.target.closest("button, video, .ib-lb-bar")) return;
    swiping = true;
    swipeX = e.clientX;
    swipeY = e.clientY;
  });
  root.addEventListener("pointerup", (e) => {
    if (!swiping) return;
    swiping = false;
    const dx = e.clientX - swipeX;
    const dy = e.clientY - swipeY;
    if (Math.abs(dx) < SWIPE_MIN_PX || Math.abs(dx) < Math.abs(dy)) return;
    swiped = true;
    step(dx < 0 ? 1 : -1);
  });
  root.addEventListener("pointercancel", () => {
    swiping = false;
  });
  function onKey(e) {
    if (busy) return;
    let handled = true;
    if (e.key === "Escape") close();
    else if (e.key === "ArrowLeft") step(-1);
    else if (e.key === "ArrowRight") step(1);
    else if (e.key === "Delete" && current && deps.canDelete(current)) void onDelete();
    else handled = false;
    if (handled) {
      e.preventDefault();
      e.stopPropagation();
    }
  }
  function close() {
    if (closed) return;
    closed = true;
    document.removeEventListener("keydown", onKey, true);
    document.addEventListener("keydown", shell._onKey, true);
    root.remove();
    deps.onClose(current);
  }
  document.removeEventListener("keydown", shell._onKey, true);
  document.addEventListener("keydown", onKey, true);
  shell.dialog.appendChild(root);
  show(start);
  return { close, current: () => current };
}
var CSS4 = `
.ib-lb {
    position: absolute;
    inset: 0;
    z-index: 6;
    background: rgba(0, 0, 0, 0.92);
    display: flex;
    align-items: center;
    justify-content: center;
    touch-action: pan-y pinch-zoom;
    user-select: none;
}
.ib-lb-stage {
    position: absolute;
    inset: 0 0 64px 0;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 12px;
}
.ib-lb-media {
    max-width: 100%;
    max-height: 100%;
    object-fit: contain;
}
.ib-lb-msg { color: #b8b8c0; font-size: 14px; max-width: 420px; text-align: center; line-height: 1.5; }
.ib-lb-reveal { position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); }
.ib-lb-btn {
    min-width: 44px;
    min-height: 44px;
    border-radius: 22px;
    border: 1px solid #3a3a44;
    background: rgba(28, 28, 36, 0.85);
    color: #e8e8ec;
    font-size: 18px;
    cursor: pointer;
    font-family: inherit;
}
.ib-lb-btn:hover { background: #3a3a4a; color: #fff; }
.ib-lb-btn[hidden] { display: none; }
.ib-lb-close { position: absolute; top: 12px; right: 12px; z-index: 1; }
.ib-lb-nav { position: absolute; top: calc(50% - 32px); z-index: 1; font-size: 26px; }
.ib-lb-prev { left: 12px; }
.ib-lb-next { right: 12px; }
.ib-lb-bar {
    position: absolute;
    left: 0;
    right: 0;
    bottom: 0;
    height: 64px;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 10px;
    padding: 0 12px;
    background: rgba(18, 18, 26, 0.9);
    color: #d8d8dc;
    font-size: 13px;
}
.ib-lb-bar .ib-stars { padding: 0; }
.ib-lb-bar .ib-star { font-size: 22px; padding: 8px 5px; min-width: 32px; min-height: 44px; }
.ib-lb-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; max-width: 40%; }
.ib-lb-pos { color: #8a8a96; font-variant-numeric: tabular-nums; }
`;

// vendor/image-browser/src/safe-tag.ts
var TAG_URL = "/image_browser/tag";
function hasSensitiveTag(f, keyword) {
  const want = keyword.toLowerCase();
  return (f.tags ?? []).some((t) => t.toLowerCase() === want);
}
function tagRequestBody(addr, tag, present) {
  return { type: addr.type, subfolder: addr.subfolder, name: addr.name, tag, present };
}
async function postTag(url, addr, tag, present) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(tagRequestBody(addr, tag, present))
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  if (!data.ok) throw new Error(data.error || "tag failed");
  return Array.isArray(data.tags) ? data.tags : [];
}
function markSensitiveHTML(prefix, keyword, marked) {
  const label = marked ? `Unmark sensitive (removes \u2018${keyword}\u2019)` : `Mark sensitive (\u2018${keyword}\u2019)`;
  return `<button type="button" class="${prefix}-act ${prefix}-act-mark${marked ? " is-marked" : ""}" data-action="marksensitive" aria-pressed="${marked}" title="${label}" aria-label="${label}">\u{1F648}</button>`;
}

// vendor/image-browser/src/browser.ts
var STYLE_ID5 = "ib-style";
var SORT_STORAGE_KEY = "comfyui-image-browser:sort";
function loadSavedSort() {
  try {
    const raw = localStorage.getItem(SORT_STORAGE_KEY);
    if (!raw || !isValidSort(raw)) return null;
    const [key, dir] = raw.split(":");
    return { key, dir };
  } catch {
    return null;
  }
}
function saveSort(key, dir) {
  try {
    localStorage.setItem(SORT_STORAGE_KEY, `${key}:${dir}`);
  } catch {
  }
}
var VIEW_NAMESPACE = "comfyui-image-browser";
var viewStore = createViewStore(VIEW_NAMESPACE);
var FILTER_STORAGE_KEY = "comfyui-image-browser:filter";
var VALID_FILTERS = /* @__PURE__ */ new Set(["all", "images", "videos"]);
function loadSavedFilter() {
  try {
    const raw = localStorage.getItem(FILTER_STORAGE_KEY);
    return raw && VALID_FILTERS.has(raw) ? raw : "all";
  } catch {
    return "all";
  }
}
function saveFilter(filter) {
  try {
    localStorage.setItem(FILTER_STORAGE_KEY, filter);
  } catch {
  }
}
var DENSITY_STORAGE_KEY = "comfyui-image-browser:density";
var VALID_DENSITIES = /* @__PURE__ */ new Set(["dense", "grid", "list"]);
var DENSITY_ROOT_MARGIN = {
  dense: "150px",
  grid: "300px",
  list: "600px"
};
var SYNC_CARD_BUDGET = 240;
var CHUNK_CARDS = 240;
function loadSavedDensity() {
  try {
    const raw = localStorage.getItem(DENSITY_STORAGE_KEY);
    return raw && VALID_DENSITIES.has(raw) ? raw : "grid";
  } catch {
    return "grid";
  }
}
function saveDensity(d) {
  try {
    localStorage.setItem(DENSITY_STORAGE_KEY, d);
  } catch {
  }
}
var CARD_MIN_WIDTH = 150;
var ACTIONS_PADDING_X = 12;
var ACTIONS_GAP = 2;
var TOUCH_FLOOR = 44;
var INLINE_ACTION_SLOTS = Math.floor(
  (CARD_MIN_WIDTH - ACTIONS_PADDING_X + ACTIONS_GAP) / (TOUCH_FLOOR + ACTIONS_GAP)
);
var LOAD_NOTE_MS = 3e3;
var LOAD_TICK_MS = 1e3;
function loadingStatusText(elapsedMs) {
  if (elapsedMs < 1e3) return "Loading\u2026";
  return `Loading\u2026 ${Math.floor(elapsedMs / 1e3)}s`;
}
var LOAD_NOTE_FLAT = "Still loading. The first flat listing after a ComfyUI restart reads every file from disk, so a large tree can take a while. Later loads are quick.";
var LOAD_NOTE_FOLDER = "Still loading. The first listing of a large folder after a ComfyUI restart reads every file from disk. Later loads are quick.";
var ACTION_LABELS = {
  open: "Open in new tab",
  pin: "Pin / unpin",
  marksensitive: "Mark sensitive",
  meta: "Metadata",
  workflow: "Load workflow",
  rename: "Rename\u2026",
  move: "Move\u2026",
  delete: "Delete\u2026"
};
function actionRowHTML(controls) {
  const present = controls.filter((c) => c !== "");
  if (present.length <= INLINE_ACTION_SLOTS) return present.join("\n");
  const inline = present.slice(0, INLINE_ACTION_SLOTS - 1);
  const stashed = present.slice(inline.length);
  return `${inline.join("\n")}
    <button type="button" class="ib-act ib-act-more" data-action="more"
      title="${stashed.length} more actions" aria-label="${stashed.length} more actions">\u22EF</button>
    <div class="ib-more-stash" hidden>${stashed.join("\n")}</div>`;
}
var MOVE_DEST_STORAGE_KEY = "comfyui-image-browser:move-dest";
function loadSavedDest() {
  try {
    const raw = localStorage.getItem(MOVE_DEST_STORAGE_KEY);
    if (!raw) return null;
    const i = raw.indexOf(":");
    if (i < 0) return null;
    const type = raw.slice(0, i);
    if (!SANDBOXED_TYPES2.includes(type)) return null;
    return { type, subfolder: raw.slice(i + 1) };
  } catch {
    return null;
  }
}
function saveDest(d) {
  try {
    localStorage.setItem(MOVE_DEST_STORAGE_KEY, `${d.type}:${d.subfolder}`);
  } catch {
  }
}
var scrollMemory = createScrollMemory();
var pinEntries = [];
var pinKeys = /* @__PURE__ */ new Set();
function setPinCache(entries) {
  pinEntries = entries;
  pinKeys = new Set(entries.map(pinKeyOf));
}
function isPinned(item) {
  return pinKeys.has(pinKeyOf(item));
}
function folderPins() {
  return pinEntries.filter((p) => p.kind === "dir");
}
function pinLabel(p) {
  return `${p.type}${p.subfolder ? `/${p.subfolder}` : ""}`;
}
var PINS_STORAGE_KEY = "comfyui-image-browser:pins";
var SCAN_POLL_MS = 3e3;
var SCAN_POLL_MAX = 20;
async function migrateLocalPins() {
  let raw = null;
  try {
    raw = localStorage.getItem(PINS_STORAGE_KEY);
  } catch {
    return;
  }
  if (!raw) return;
  let legacy = [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) legacy = parsed;
  } catch {
    legacy = [];
  }
  for (const p of legacy) {
    const type = p?.type;
    if (!p || typeof p.subfolder !== "string" || !SANDBOXED_TYPES2.includes(type)) continue;
    try {
      setPinCache((await postPinDelta("add", { kind: "dir", type, subfolder: p.subfolder })).pins);
    } catch (e) {
      console.warn(`[${EXT_NAME}] pin migration skipped ${type}/${p.subfolder}`, e);
    }
  }
  try {
    localStorage.removeItem(PINS_STORAGE_KEY);
  } catch {
  }
}
var defaultNotify = notify;
var browserSessions = /* @__PURE__ */ new Map();
function openImageBrowser(options = {}) {
  const notify2 = options.onNotice ?? defaultNotify;
  const stored = options.resumeKey ? browserSessions.get(options.resumeKey) : void 0;
  const resume = stored && SANDBOXED_TYPES2.includes(stored.state.type) ? stored : void 0;
  let restoring = !!resume;
  let clickAnchor = resume?.clickAnchor ?? -1;
  ensureStyleOnce(STYLE_ID5, BROWSER_CSS);
  invalidateBasePaths();
  let pageOffset = resume?.pageOffset ?? 0, pageScope = resume?.pageScope ?? "", lastListing = null, lastQuery = null, loadGeneration = 0;
  let searchTimer;
  const savedView = viewStore.load();
  const state = {
    type: "output",
    subfolder: "",
    absPath: "",
    dirs: [],
    files: [],
    sortKey: "mtime",
    sortDir: "desc",
    query: "",
    viewMode: savedView.mode,
    typeFilter: loadSavedFilter(),
    density: loadSavedDensity()
  };
  const savedSort = loadSavedSort();
  if (savedSort) {
    state.sortKey = savedSort.key;
    state.sortDir = savedSort.dir;
  }
  if (resume) Object.assign(state, resume.state);
  let disposeBackGuard = null;
  const modal = openModalShell({
    title: options.title ?? "Image Browser",
    placeholder: "Filter by filename\u2026",
    // Fill the whole viewport — the browser stands in for the canvas.
    width: "100vw",
    height: "100vh",
    footerLeftHTML: "<kbd>j/k</kbd> navigate \xB7 <kbd>i</kbd> metadata \xB7 <kbd>w</kbd> workflow \xB7 <kbd>b</kbd> safe view \xB7 <kbd>?</kbd> help \xB7 <kbd>Esc</kbd> close",
    footerRightHTML: '<span class="ib-count"></span>',
    // Fires on EVERY teardown path (Esc, × button, backdrop, coordinator
    // dismiss) — the controller.close wrapper does not, so keyboard cleanup
    // must hang off onClose or the window listener leaks after close.
    onClose: () => {
      rememberScroll();
      if (options.resumeKey) {
        const { dirs, files, ...view } = state;
        browserSessions.set(options.resumeKey, {
          state: view,
          pageOffset,
          pageScope,
          searchText: modal.searchEl.value,
          scrollTop: restoring && resume ? resume.scrollTop : scroller.current(),
          selected: structuredClone([...selected]),
          focusIndex,
          clickAnchor
        });
      }
      clearTimeout(searchTimer);
      loadGeneration++;
      options.onClose?.();
      viewStore.markPending(false);
      disposeLazyThumbs();
      cancelChunkJob();
      scroller.dispose();
      window.removeEventListener("keydown", onWindowKey, true);
      disposeBackGuard?.();
      disposeBackGuard = null;
      disposeSafeView();
      cancelScanPoll();
      cancelLoadTicker();
      revealed.clear();
    }
  });
  modal.dialog.classList.add("ib-dialog");
  modal.searchEl.value = resume?.searchText ?? "";
  const root = document.createElement("div");
  root.className = "image-browser-body";
  modal.bodyEl.appendChild(root);
  const tabsEl = document.createElement("div");
  tabsEl.className = "ib-tabs";
  for (const t of ["input", "output", "temp", "path", "pinned"]) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "ib-tab";
    b.dataset.type = t;
    b.textContent = t === "path" ? "browse\u2026" : t === "pinned" ? "\u{1F4CC} pinned" : t;
    tabsEl.appendChild(b);
  }
  const crumbsEl = document.createElement("div");
  crumbsEl.className = "ib-crumbs";
  const sortEl = document.createElement("select");
  sortEl.className = "ib-control";
  sortEl.title = "Sort";
  sortEl.innerHTML = SORT_OPTIONS.map(
    (o) => `<option value="${o.value}">${escapeHTML(o.label)}</option>`
  ).join("");
  if (options.listing) {
    for (const option of [...sortEl.options]) if (!["name", "mtime", "size"].includes(option.value.split(":")[0])) option.remove();
    if (!["name", "mtime", "size"].includes(state.sortKey)) {
      state.sortKey = "mtime";
      state.sortDir = "desc";
    }
  }
  sortEl.value = `${state.sortKey}:${state.sortDir}`;
  const refreshEl = document.createElement("button");
  refreshEl.type = "button";
  refreshEl.className = "ib-control ib-icon";
  refreshEl.title = "Refresh";
  refreshEl.textContent = "\u27F3";
  const viewToggleEl = document.createElement("button");
  viewToggleEl.type = "button";
  viewToggleEl.className = "ib-control ib-icon ib-view-toggle";
  viewToggleEl.title = "Flat view (all subfolders)";
  viewToggleEl.textContent = "\u2263";
  const selectToggleEl = document.createElement("button");
  selectToggleEl.type = "button";
  selectToggleEl.className = "ib-control ib-icon ib-select-toggle";
  selectToggleEl.title = "Select multiple";
  selectToggleEl.textContent = "\u2611";
  const pinToggleEl = document.createElement("button");
  pinToggleEl.type = "button";
  pinToggleEl.className = "ib-control ib-icon ib-pin-toggle";
  pinToggleEl.title = "Pin this folder";
  pinToggleEl.textContent = "\u{1F4CC}";
  const newFolderEl = document.createElement("button");
  newFolderEl.type = "button";
  newFolderEl.className = "ib-control ib-icon ib-newfolder";
  newFolderEl.title = "New folder";
  newFolderEl.textContent = "\u{1F4C1}+";
  const uploadEl = document.createElement("button");
  uploadEl.type = "button";
  uploadEl.className = "ib-control ib-icon ib-upload";
  uploadEl.title = "Upload files here";
  uploadEl.textContent = "\u2B06\uFE0E";
  const uploadInputEl = document.createElement("input");
  uploadInputEl.type = "file";
  uploadInputEl.multiple = true;
  uploadInputEl.accept = "image/*,video/*";
  uploadInputEl.className = "ib-upload-input";
  uploadInputEl.tabIndex = -1;
  uploadInputEl.setAttribute("aria-hidden", "true");
  const pruneEl = document.createElement("button");
  pruneEl.type = "button";
  pruneEl.className = "ib-control ib-prune";
  pruneEl.title = "Remove pins whose file or folder no longer exists";
  pruneEl.textContent = "\u{1F9F9} Prune missing";
  pruneEl.style.display = "none";
  const safeToggleEl = document.createElement("button");
  safeToggleEl.type = "button";
  safeToggleEl.className = "ib-control ib-icon ib-safe-toggle";
  const scanPillEl = document.createElement("button");
  scanPillEl.type = "button";
  scanPillEl.className = "ib-control ib-scan-pill";
  scanPillEl.title = "Files whose generation prompt has not been scanned yet \u2014 blurred until it is. Tap to refresh.";
  scanPillEl.style.display = "none";
  const filterEl = document.createElement("div");
  filterEl.className = "ib-filter";
  const filterGroupEl = document.createElement("div");
  filterGroupEl.className = "ib-filter-group";
  for (const [value, label, title] of [
    ["all", "All", "Show images and videos"],
    ["images", "\u{1F5BC} Images", "Show images only"],
    ["videos", "\u{1F3AC} Videos", "Show videos only"]
  ]) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "ib-filter-seg";
    b.dataset.filter = value;
    b.title = title;
    b.textContent = label;
    filterGroupEl.appendChild(b);
  }
  filterEl.appendChild(filterGroupEl);
  const densityGroupEl = document.createElement("div");
  densityGroupEl.className = "ib-density-group";
  for (const [value, glyph, title] of [
    ["dense", "\u229E", "Small cards \u2014 more per screen"],
    ["grid", "\u25A6", "Medium cards"],
    ["list", "\u2630", "One per row, with details"]
  ]) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "ib-density-seg";
    b.dataset.density = value;
    b.title = title;
    b.setAttribute("aria-label", title);
    b.textContent = glyph;
    densityGroupEl.appendChild(b);
  }
  if (options.compact) {
    densityGroupEl.classList.add("ah-view-switch");
    for (const button of densityGroupEl.querySelectorAll("button")) {
      const title = { dense: "\u5C0F\u3055\u3044\u753B\u50CF", grid: "\u5927\u304D\u3044\u753B\u50CF", list: "\u8A73\u7D30\u4E00\u89A7" }[button.dataset.density];
      button.textContent = title;
      button.title = title;
      button.setAttribute("aria-label", title);
    }
  }
  filterEl.appendChild(densityGroupEl);
  const pinsEl = document.createElement("div");
  pinsEl.className = "ib-pins";
  const loadNoteEl = document.createElement("div");
  loadNoteEl.className = "ib-load-note";
  loadNoteEl.setAttribute("role", "status");
  loadNoteEl.hidden = true;
  if (options.compact) {
    state.typeFilter = "images";
    for (const el of [tabsEl, selectToggleEl, pinToggleEl, newFolderEl, uploadEl, pruneEl, filterEl, pinsEl, scanPillEl, loadNoteEl]) el.classList.add("ah-unused");
  }
  modal.toolbarEl.append(
    tabsEl,
    crumbsEl,
    viewToggleEl,
    selectToggleEl,
    pinToggleEl,
    newFolderEl,
    uploadEl,
    uploadInputEl,
    pruneEl,
    safeToggleEl,
    scanPillEl,
    sortEl,
    refreshEl,
    filterEl,
    pinsEl,
    loadNoteEl
  );
  if (options.compact) modal.toolbarEl.append(densityGroupEl);
  const gridEl = document.createElement("div");
  gridEl.className = "ib-grid";
  root.appendChild(gridEl);
  const scrollHost = modal.bodyEl;
  const scroller = installScrollRestore(scrollHost, { isTypingTarget: () => isInInput() });
  const selBar = document.createElement("div");
  selBar.className = "ib-selbar";
  selBar.innerHTML = `
    <span class="ib-selbar-count"></span>
    <button type="button" class="ib-selbar-btn" data-selbar="pin">\u{1F4CC} Pin</button>
    <button type="button" class="ib-selbar-btn" data-selbar="move">\u21C4 Move\u2026</button>
    <button type="button" class="ib-selbar-btn ib-selbar-danger" data-selbar="delete">\u{1F5D1} Delete</button>
    <button type="button" class="ib-selbar-btn" data-selbar="clear">\u2715</button>`;
  const selBarCount = selBar.querySelector(".ib-selbar-count");
  modal.dialog.appendChild(selBar);
  const countEl = modal.footerEl.querySelector(".ib-count");
  function setCount(visible, total) {
    if (countEl) countEl.textContent = `${visible} / ${total}`;
  }
  const revealed = makeRevealSet();
  let revealLocation = null;
  function safePathOf(f) {
    if (state.type === "path") return state.absPath;
    return `${fileType(f)}/${fileSub(f)}`;
  }
  function safeTargetOf(f) {
    return {
      name: f.name,
      path: safePathOf(f),
      tags: f.tags,
      promptMatch: f.prompt_match
    };
  }
  function isCardHidden(f, cfg) {
    if (!isSensitive(safeTargetOf(f), cfg)) return false;
    return !revealed.has(fileType(f), fileSub(f), f.name);
  }
  function renderSafeToggle(cfg) {
    const active = cfg.enabled && cfg.keywords.length > 0;
    safeToggleEl.classList.toggle("is-active", active);
    safeToggleEl.textContent = active ? SAFE_VIEW_GLYPH_ON : SAFE_VIEW_GLYPH_OFF;
    safeToggleEl.title = active ? "Safe View is on \u2014 matching thumbnails are blurred (b)" : "Safe View is off \u2014 nothing is filtered (b)";
    safeToggleEl.setAttribute("aria-pressed", String(active));
  }
  safeToggleEl.addEventListener("click", () => toggleSafeView());
  let scanPollTimer = null;
  let scanPollsLeft = 0;
  function cancelScanPoll() {
    if (scanPollTimer !== null) {
      clearTimeout(scanPollTimer);
      scanPollTimer = null;
    }
  }
  function renderScanPill(unscanned) {
    cancelScanPoll();
    if (unscanned <= 0) {
      scanPillEl.style.display = "none";
      scanPollsLeft = 0;
      return;
    }
    scanPillEl.style.display = "";
    scanPillEl.textContent = `\u{1F50D} scanning ${unscanned}`;
    if (scanPollsLeft > 0) {
      scanPollsLeft -= 1;
      scanPollTimer = setTimeout(() => {
        scanPollTimer = null;
        void loadAndRender({ preserveScroll: true });
      }, SCAN_POLL_MS);
    }
  }
  scanPillEl.addEventListener("click", () => {
    scanPollsLeft = SCAN_POLL_MAX;
    void loadAndRender({ preserveScroll: true });
  });
  const disposeSafeView = onSafeViewChange(() => {
    void loadAndRender({ preserveScroll: true });
  });
  const selected = new Map(resume ? structuredClone(resume.selected) : []);
  let selectMode = false;
  let focusIndex = resume?.focusIndex ?? -1;
  let visualMode = false;
  let visualAnchor = 0;
  let pendingOp = null;
  let pendingTimer = null;
  let yanked = null;
  let renderedFiles = [];
  const selectedBadge = document.createElement("span");
  selectedBadge.className = "ib-selected-badge";
  selectedBadge.style.display = "none";
  modal.headerEl.appendChild(selectedBadge);
  function isFlat() {
    return state.viewMode === "flat" && SANDBOXED_TYPES2.includes(state.type);
  }
  function fileSub(f) {
    if (f.pinSub !== void 0) return f.pinSub;
    const sp = f.subpath || "";
    if (!sp) return state.subfolder;
    const base = state.subfolder.replace(/\/+$/, "");
    return base ? `${base}/${sp}` : sp;
  }
  function fileType(f) {
    return f.pinType ?? state.type;
  }
  function canWriteFile(f) {
    return SANDBOXED_TYPES2.includes(fileType(f));
  }
  function isPinnedView() {
    return state.type === "pinned";
  }
  function canSelectHere() {
    return SANDBOXED_TYPES2.includes(state.type) || isPinnedView();
  }
  function filePinItem(f) {
    return { kind: "file", type: fileType(f), subfolder: fileSub(f), name: f.name };
  }
  function pinItemOf(p) {
    return p.kind === "file" ? { kind: "file", type: p.type, subfolder: p.subfolder, name: p.name } : { kind: "dir", type: p.type, subfolder: p.subfolder };
  }
  function pinsUnder(type, sub) {
    return pinEntries.filter((p) => p.type === type && (p.subfolder === sub || p.subfolder.startsWith(`${sub}/`))).map(pinItemOf);
  }
  function locationKey() {
    const view = isFlat() ? ":flat" : "";
    const filter = state.typeFilter === "all" ? "" : `:${state.typeFilter}`;
    return state.type === "path" ? `path:${state.absPath}${filter}` : `${state.type}:${state.subfolder}${view}${filter}`;
  }
  function rememberScroll() {
    scrollMemory.remember(locationKey(), scroller.current());
  }
  function navigateUp() {
    rememberScroll();
    if (state.type === "path") {
      const p = (state.absPath || "/").replace(/\/+$/, "");
      if (p === "" || p === "/") return;
      const i = p.lastIndexOf("/");
      state.absPath = i <= 0 ? "/" : p.slice(0, i);
    } else {
      const p = state.subfolder.replace(/\/+$/, "");
      const i = p.lastIndexOf("/");
      state.subfolder = i <= 0 ? "" : p.slice(0, i);
    }
    loadAndRender();
  }
  function navigateInto(name) {
    rememberScroll();
    if (state.type === "path") {
      state.absPath = joinAbs(state.absPath, name);
    } else {
      const base = state.subfolder.replace(/\/+$/, "");
      state.subfolder = base ? `${base}/${name}` : name;
    }
    loadAndRender();
  }
  async function switchType(type) {
    rememberScroll();
    state.type = type;
    state.subfolder = "";
    if (type === "path") {
      const bp = await fetchBasePaths();
      state.absPath = bp.base_path || "/";
    }
    loadAndRender();
  }
  function canGoUp() {
    return state.type === "path" ? !!state.absPath && state.absPath !== "/" : !!state.subfolder;
  }
  disposeBackGuard = installBackGuard(() => {
    const hasOverlay = !!modal.dialog.querySelector(".cmp-ov-backdrop");
    if (hasOverlay) {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", cancelable: true }));
      return true;
    }
    if (canGoUp()) {
      navigateUp();
      return true;
    }
    modal.close();
    return false;
  });
  modal.searchEl.addEventListener("input", () => {
    state.query = modal.searchEl.value.toLowerCase().trim();
    if (options.listing) {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => void loadAndRender(), 250);
    } else renderGrid({ scrollTo: 0 });
  });
  sortEl.addEventListener("change", () => {
    const [k, d] = sortEl.value.split(":");
    state.sortKey = k;
    state.sortDir = d;
    saveSort(k, d);
    if (options.listing) {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => void loadAndRender(), 250);
    } else renderGrid({ scrollTo: 0 });
  });
  refreshEl.addEventListener("click", () => loadAndRender({ preserveScroll: true, rescan: true }));
  newFolderEl.addEventListener("click", () => void onNewFolder());
  uploadEl.addEventListener("click", () => {
    if (!SANDBOXED_TYPES2.includes(state.type)) return;
    uploadInputEl.value = "";
    uploadInputEl.click();
  });
  uploadInputEl.addEventListener("change", () => {
    const files = Array.from(uploadInputEl.files ?? []);
    if (files.length > 0) void onUpload(files);
  });
  viewToggleEl.addEventListener("click", () => {
    if (!SANDBOXED_TYPES2.includes(state.type)) return;
    rememberScroll();
    state.viewMode = state.viewMode === "flat" ? "folder" : "flat";
    viewStore.save(state.viewMode);
    loadAndRender();
  });
  filterEl.addEventListener("click", (e) => {
    const seg = e.target.closest("[data-filter]");
    if (!seg) return;
    const next = seg.dataset.filter;
    if (next === state.typeFilter) return;
    rememberScroll();
    state.typeFilter = next;
    saveFilter(next);
    loadAndRender();
  });
  densityGroupEl.addEventListener("click", (e) => {
    const seg = e.target.closest("[data-density]");
    if (!seg) return;
    const next = seg.dataset.density;
    if (next === state.density) return;
    state.density = next;
    saveDensity(next);
    renderGrid();
  });
  selectToggleEl.addEventListener("click", () => setSelectMode(!selectMode));
  pinToggleEl.addEventListener("click", () => void toggleFolderPinHere());
  pruneEl.addEventListener("click", () => void onPruneMissing());
  pinsEl.addEventListener("click", (e) => {
    const t = e.target;
    const chip = t.closest("[data-pin-type]");
    if (!chip) return;
    const type = chip.dataset.pinType;
    if (!SANDBOXED_TYPES2.includes(type)) return;
    const pin = { kind: "dir", type, subfolder: chip.dataset.pinSub || "" };
    if (t.closest(".ib-pin-x")) {
      void unpinFolder(pin);
      return;
    }
    if (pin.type === state.type && pin.subfolder === state.subfolder) return;
    rememberScroll();
    state.type = pin.type;
    state.subfolder = pin.subfolder;
    loadAndRender();
  });
  selBar.addEventListener("click", (e) => {
    const b = e.target.closest("[data-selbar]");
    if (!b) return;
    const action = b.dataset.selbar;
    if (action === "move") void doMoveSelected();
    else if (action === "delete") void doDelete();
    else if (action === "pin") void doPinSelected();
    else if (action === "clear") {
      setSelectMode(false);
      clearSelection();
    }
  });
  tabsEl.addEventListener("click", (e) => {
    const b = e.target.closest("[data-type]");
    if (!b) return;
    const t = b.dataset.type;
    if (state.type === t) return;
    switchType(t);
  });
  crumbsEl.addEventListener("click", (e) => {
    const c = e.target.closest("[data-sub], [data-abs]");
    if (!c) return;
    rememberScroll();
    if (c.dataset.abs !== void 0) state.absPath = c.dataset.abs || "/";
    else state.subfolder = c.dataset.sub || "";
    loadAndRender();
  });
  gridEl.addEventListener("click", (e) => {
    if (suppressClick) {
      suppressClick = false;
      e.stopPropagation();
      return;
    }
    const target = e.target;
    const actionBtn = target.closest("[data-action]");
    const card = target.closest(".ib-card");
    if (!card) return;
    if (card.classList.contains("is-up")) {
      navigateUp();
      return;
    }
    if (card.classList.contains("is-dir")) {
      if (actionBtn?.dataset.action === "rmdir") {
        e.stopPropagation();
        void onDeleteDir(card.dataset.name);
        return;
      }
      if (actionBtn?.dataset.action === "movedir") {
        e.stopPropagation();
        void onMoveDir(card.dataset.name);
        return;
      }
      navigateInto(card.dataset.name);
      return;
    }
    const idx = Number(card.dataset.idx);
    const f = renderedFiles[idx];
    const subEl = target.closest(".ib-subpath");
    if (subEl) {
      e.stopPropagation();
      rememberScroll();
      state.viewMode = "folder";
      viewStore.save("folder");
      const t = subEl.dataset.pinType;
      if (t && SANDBOXED_TYPES2.includes(t)) state.type = t;
      state.subfolder = subEl.dataset.sub || "";
      loadAndRender();
      return;
    }
    if (!f) return;
    if (options.compact) {
      focusIndex = idx;
      for (const c of fileCards()) c.classList.toggle("is-focused", Number(c.dataset.idx) === idx);
    }
    if (e.shiftKey && canWriteFile(f) && !actionBtn) {
      e.stopPropagation();
      setSelectedRange(clickAnchor < 0 ? idx : clickAnchor, idx, true);
      modal.dialog.dispatchEvent(new Event("hub-user-selection"));
      return;
    }
    if (options.compact && !actionBtn && !target.closest(".ib-star")) {
      e.stopPropagation();
      clickAnchor = idx;
      toggleSelectionAt(idx);
      modal.dialog.dispatchEvent(new Event("hub-user-selection"));
      return;
    }
    if (target.closest("[data-check]")) {
      e.stopPropagation();
      clickAnchor = idx;
      toggleSelectionAt(idx);
      return;
    }
    const star = target.closest(".ib-star");
    if (star) {
      e.stopPropagation();
      const row = star.closest(".ib-stars");
      if (!row || !canWriteFile(f)) return;
      const cur = Number(row.dataset.rating || "0");
      setStarRating(f, row, nextRating(cur, Number(star.dataset.val)));
      return;
    }
    if (actionBtn) {
      e.stopPropagation();
      const action = actionBtn.dataset.action;
      if (action === "more") openMoreSheet(card, f);
      else if (action === "preview") openViewer(f);
      else runCardAction(action, f, actionBtn);
      return;
    }
    if (selectMode && canWriteFile(f)) {
      toggleSelectionAt(idx);
      return;
    }
    openViewer(f);
  });
  let suppressClick = false;
  let dragSel = null;
  let lpTimer = null;
  let lpX = 0;
  let lpY = 0;
  function cancelLongPress() {
    if (lpTimer) {
      clearTimeout(lpTimer);
      lpTimer = null;
    }
  }
  gridEl.addEventListener("pointerdown", (e) => {
    suppressClick = false;
    if (!canSelectHere()) return;
    if (e.shiftKey || options.compact && e.pointerType === "mouse") return;
    if (e.pointerType === "mouse" && e.button !== 0) return;
    const target = e.target;
    const card = target.closest(".ib-card.is-file");
    if (!card) return;
    const idx = Number(card.dataset.idx);
    if (!Number.isFinite(idx)) return;
    const checkEl = target.closest("[data-check]");
    if (checkEl) {
      const f = renderedFiles[idx];
      dragSel = { on: !(f && isSelected(f)), last: idx, moved: false, captureOn: null };
      try {
        checkEl.setPointerCapture(e.pointerId);
        dragSel.captureOn = checkEl;
      } catch {
      }
      return;
    }
    if (e.pointerType === "mouse") return;
    lpX = e.clientX;
    lpY = e.clientY;
    cancelLongPress();
    lpTimer = setTimeout(() => {
      lpTimer = null;
      suppressClick = true;
      if (!selectMode) setSelectMode(true);
      toggleSelectionAt(idx);
    }, 450);
  });
  gridEl.addEventListener("pointermove", (e) => {
    if (dragSel) {
      if (!dragSel.moved) {
        dragSel.moved = true;
        setSelectedRange(dragSel.last, dragSel.last, dragSel.on);
      }
      const el = document.elementFromPoint(e.clientX, e.clientY);
      const card = el instanceof Element ? el.closest(".ib-card.is-file") : null;
      if (card) {
        const idx = Number(card.dataset.idx);
        if (Number.isFinite(idx) && idx !== dragSel.last) {
          setSelectedRange(dragSel.last, idx, dragSel.on);
          dragSel.last = idx;
        }
      }
      return;
    }
    if (lpTimer && (Math.abs(e.clientX - lpX) > 8 || Math.abs(e.clientY - lpY) > 8)) {
      cancelLongPress();
    }
  });
  function endPointerGesture(e) {
    if (dragSel) {
      if (dragSel.moved) suppressClick = true;
      const captureOn = dragSel.captureOn;
      dragSel = null;
      try {
        captureOn?.releasePointerCapture(e.pointerId);
      } catch {
      }
    }
    cancelLongPress();
  }
  gridEl.addEventListener("pointerup", endPointerGesture);
  gridEl.addEventListener("pointercancel", endPointerGesture);
  gridEl.addEventListener("contextmenu", (e) => {
    if (selectMode || suppressClick || lpTimer) e.preventDefault();
  });
  function setStarRating(f, row, next) {
    const prev = Number(row.dataset.rating || "0");
    applyStars(row, next);
    persistRating(f, next, prev).then(
      (confirmed) => {
        if (confirmed !== next) applyStars(row, confirmed);
      },
      () => applyStars(row, prev)
    );
  }
  function persistRating(f, next, prev) {
    f.rating = next;
    const addr = {
      type: fileType(f),
      subfolder: fileSub(f),
      absDir: state.absPath,
      name: f.name
    };
    return postRating(RATING_URL, addr, next).then(
      (confirmed) => {
        f.rating = confirmed;
        return confirmed;
      },
      (e) => {
        reportError("Rating failed", e);
        f.rating = prev;
        throw e;
      }
    );
  }
  async function toggleSensitiveTag(f, btn) {
    const keyword = sensitiveKeyword(readSafeViewConfig());
    if (!keyword) return;
    if (!canWriteFile(f)) return;
    const next = !hasSensitiveTag(f, keyword);
    const button = btn;
    button.disabled = true;
    try {
      f.tags = await postTag(
        TAG_URL,
        { type: fileType(f), subfolder: fileSub(f), name: f.name },
        keyword,
        next
      );
      renderGrid();
    } catch (e) {
      reportError(next ? "Not marked" : "Not unmarked", e);
      button.disabled = false;
    }
  }
  function runCardAction(action, f, btn) {
    if (action === "open") openFull(f);
    else if (action === "meta") void openMetadata(f);
    else if (action === "workflow") void loadWorkflow(f);
    else if (action === "delete") onDelete(f);
    else if (action === "rename") onRename(f);
    else if (action === "move") onMove(f);
    else if (action === "pin") void toggleFilePin(f);
    else if (action === "marksensitive") void toggleSensitiveTag(f, btn);
  }
  function openMoreSheet(card, f) {
    const stashed = Array.from(card.querySelectorAll(".ib-more-stash [data-action]"));
    if (!stashed.length) return;
    const ov = openShellOverlay(modal);
    ov.card.classList.add("ib-more-card");
    const rows = stashed.map((b) => {
      const action = b.dataset.action ?? "";
      const danger = b.classList.contains("ib-act-danger") ? " ib-more-danger" : "";
      return `<button type="button" class="ib-more-row${danger}" data-action="${escapeHTML(action)}">
          <span class="ib-more-glyph">${escapeHTML(b.textContent?.trim() || "")}</span>
          <span>${escapeHTML(ACTION_LABELS[action] ?? action)}</span>
        </button>`;
    }).join("");
    ov.card.innerHTML = `
      <div class="cmp-ov-title">${escapeHTML(f.name)}</div>
      <div class="ib-more-list">${rows}</div>`;
    ov.card.addEventListener("click", (e) => {
      const row = e.target.closest(".ib-more-row");
      if (!row) return;
      e.stopPropagation();
      ov.close();
      runCardAction(row.dataset.action, f, row);
    });
  }
  function prepareFullOpen(f) {
    if (revealed.has(fileType(f), fileSub(f), f.name)) {
    } else if (isCardHidden(f, readSafeViewConfig())) {
      revealed.reveal(fileType(f), fileSub(f), f.name);
      renderGrid();
    }
    if (fileType(f) === "path" && !pathReadsAllowed()) {
      notify2({
        severity: "warn",
        summary: "Absolute-path reads are off",
        detail: PATH_READS_DISABLED_MSG
      });
      return false;
    }
    return true;
  }
  function openFull(f) {
    if (!prepareFullOpen(f)) return;
    const url = fullSrcURL(fileType(f), fileSub(f), f.name, state.absPath);
    window.open(url, "_blank", "noopener");
  }
  function openViewer(f) {
    if (!prepareFullOpen(f)) return;
    const rated = /* @__PURE__ */ new Set();
    openLightbox(f, {
      shell: modal,
      files: () => renderedFiles,
      name: (x) => x.name,
      kind: (x) => {
        const ext = (x.ext || "").toLowerCase();
        return IMG_EXTS.has(ext) ? "image" : VIDEO_EXTS.has(ext) ? "video" : "other";
      },
      src: (x) => fileType(x) === "path" && !pathReadsAllowed() ? { blocked: PATH_READS_DISABLED_MSG } : { url: fullSrcURL(fileType(x), fileSub(x), x.name, state.absPath) },
      rating: (x) => canWriteFile(x) ? ratingOf(x) : null,
      rate: (x, next) => {
        rated.add(x);
        return persistRating(x, next, ratingOf(x));
      },
      canDelete: (x) => canWriteFile(x),
      remove: (x) => onDelete(x),
      hidden: (x) => isCardHidden(x, readSafeViewConfig()),
      reveal: (x) => {
        revealed.reveal(fileType(x), fileSub(x), x.name);
        renderGrid();
      },
      openInTab: (x) => openFull(x),
      onClose: (last) => {
        for (const x of rated) {
          const i2 = renderedFiles.indexOf(x);
          const row = gridEl.querySelector(`.ib-card[data-idx="${i2}"] .ib-stars`);
          if (i2 >= 0 && row) applyStars(row, ratingOf(x));
        }
        const i = last ? renderedFiles.indexOf(last) : -1;
        if (i >= 0) {
          focusIndex = i;
          applyFocus();
        }
      }
    });
  }
  const copyFeedback = /* @__PURE__ */ new WeakMap();
  function copyInto(btn, text, restore) {
    let fb = copyFeedback.get(btn);
    if (!fb) {
      fb = { seq: 0, timer: null };
      copyFeedback.set(btn, fb);
    }
    const slot = fb;
    const seq = ++slot.seq;
    if (slot.timer !== null) {
      clearTimeout(slot.timer);
      slot.timer = null;
    }
    void copyTextToClipboard(text).then((ok) => {
      if (slot.seq !== seq) return;
      btn.textContent = ok ? "Copied \u2713" : "Copy failed";
      btn.classList.toggle("is-copied", ok);
      slot.timer = setTimeout(() => {
        slot.timer = null;
        btn.textContent = restore;
        btn.classList.remove("is-copied");
      }, 1500);
    });
  }
  async function loadWorkflow(f) {
    const sub = fileSub(f);
    const type = fileType(f);
    try {
      const meta = await fetchMetadata(type, sub, f.name, state.absPath);
      const graphJSON = embeddedWorkflowJSON(meta);
      if (!graphJSON) {
        notify2({
          severity: "warn",
          summary: "No workflow in this file",
          detail: `${f.name} carries no embedded graph. Files saved by another tool (or re-encoded, e.g. by a phone gallery or a chat app) lose ComfyUI's metadata.`
        });
        return;
      }
      if (META_VIDEO_EXTS.has((f.ext || "").toLowerCase())) {
        const base = f.name.replace(/\.[^./]+$/, "");
        const file2 = new File([graphJSON], `${base}.json`, { type: "application/json" });
        modal.close();
        await app.handleFile(file2);
        return;
      }
      if (type === "path" && !pathReadsAllowed()) {
        notify2({
          severity: "warn",
          summary: "Absolute-path reads are off",
          detail: PATH_READS_DISABLED_MSG
        });
        return;
      }
      const res = await fetch(fullSrcURL(type, sub, f.name, state.absPath));
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      const file = new File([blob], f.name, { type: blob.type });
      modal.close();
      await app.handleFile(file);
    } catch (e) {
      notify2({
        severity: "error",
        summary: "Could not load workflow",
        detail: `${f.name}: ${e instanceof Error ? e.message : String(e)}`
      });
    }
  }
  async function openMetadata(f) {
    let live = true;
    const ov = openShellOverlay(modal, {
      onDismiss: () => {
        live = false;
      }
    });
    ov.card.classList.add("ib-meta-card");
    const close = () => {
      live = false;
      ov.close();
    };
    const title = `Metadata \u2014 ${escapeHTML(f.name)}`;
    ov.card.innerHTML = `
      <div class="cmp-ov-title">${title}</div>
      <div class="ib-meta-body"><div class="ib-meta-status">Reading metadata\u2026</div></div>
      <div class="cmp-ov-actions">
        <button type="button" class="cmp-ov-btn" data-meta-close>Close</button>
      </div>`;
    ov.card.querySelector("[data-meta-close]")?.addEventListener("click", close);
    let data;
    try {
      data = await fetchMetadata(fileType(f), fileSub(f), f.name, state.absPath);
    } catch (e) {
      close();
      reportError("Metadata read failed", e);
      return;
    }
    if (!live) return;
    const rows = metaRows(data.summary);
    const rawKeys = Object.keys(data.raw);
    const srcLabel = data.source === "comfyui" ? "ComfyUI" : data.source === "a1111" ? "A1111" : "no generation data";
    const rowsHTML = rows.map(
      (r, i) => `
        <div class="ib-meta-row">
          <div class="ib-meta-k">${escapeHTML(r.label)}</div>
          <div class="ib-meta-v">${escapeHTML(r.value)}</div>
          <button type="button" class="ib-meta-copy" data-copy-row="${i}">Copy</button>
        </div>`
    ).join("");
    const emptyHTML = rows.length ? "" : `<div class="ib-meta-empty">${rawKeys.length ? "No recognised generation parameters." : "No generation metadata found."}</div>`;
    const rawJSON = JSON.stringify(data.raw, null, 2);
    const rawHTML = rawKeys.length ? `
        <details class="ib-meta-raw">
          <summary>Raw metadata (${rawKeys.length} key${rawKeys.length === 1 ? "" : "s"})</summary>
          <pre>${escapeHTML(rawJSON)}</pre>
          <button type="button" class="ib-meta-copy" data-copy-raw>Copy JSON</button>
        </details>` : "";
    const noteHTML = data.truncated ? `<div class="ib-meta-note">Some values were truncated by the server.</div>` : "";
    const copyAll = rows.length ? `<button type="button" class="cmp-ov-btn cmp-ov-primary" data-copy-all>Copy all</button>` : "";
    ov.card.innerHTML = `
      <div class="cmp-ov-title">${title}</div>
      <div class="ib-meta-body">
        <div class="ib-meta-src">${escapeHTML(srcLabel)}${data.format ? `<span class="ib-meta-fmt">${escapeHTML(data.format)}</span>` : ""}</div>
        ${emptyHTML}
        ${rowsHTML}
        ${noteHTML}
        ${rawHTML}
      </div>
      <div class="cmp-ov-actions">
        ${copyAll}
        <button type="button" class="cmp-ov-btn" data-meta-close>Close</button>
      </div>`;
    ov.card.querySelector("[data-meta-close]")?.addEventListener("click", close);
    for (const btn of ov.card.querySelectorAll("[data-copy-row]")) {
      const row = rows[Number(btn.dataset.copyRow)];
      const label = btn.textContent || "Copy";
      if (row) btn.addEventListener("click", () => copyInto(btn, row.value, label));
    }
    const rawBtn = ov.card.querySelector("[data-copy-raw]");
    const rawLabel = rawBtn?.textContent || "Copy JSON";
    rawBtn?.addEventListener("click", () => copyInto(rawBtn, rawJSON, rawLabel));
    const allBtn = ov.card.querySelector("[data-copy-all]");
    const allLabel = allBtn?.textContent || "Copy all";
    allBtn?.addEventListener("click", () => copyInto(allBtn, metaClipboardText(rows), allLabel));
  }
  async function onDelete(f) {
    const ok = await confirmInShell(modal, {
      title: "Delete file?",
      message: `Permanently delete "${f.name}"? This cannot be undone.`,
      confirmLabel: "Delete",
      danger: true
    });
    if (!ok) return false;
    const pin = filePinItem(f);
    try {
      await deleteFile(fileType(f), fileSub(f), f.name);
      await followPins([{ from: pin, to: null }]);
      state.files = state.files.filter((x) => x !== f);
      renderGrid();
      return true;
    } catch (e) {
      reportError("Delete failed", e);
      return false;
    }
  }
  async function onRename(f) {
    const name = f.name;
    const dot = name.lastIndexOf(".");
    const ext = dot >= 0 ? name.slice(dot) : "";
    const newName = await promptInShell(modal, {
      title: "Rename file",
      label: "New filename",
      value: name,
      confirmLabel: "Rename",
      validate: (v) => {
        if (!v) return "Filename required";
        if (v.includes("/") || v.includes("\\")) return "No slashes allowed";
        if (v === "." || v === "..") return "Invalid name";
        if (ext && !v.toLowerCase().endsWith(ext.toLowerCase())) return `Keep the ${ext} extension`;
        return null;
      }
    });
    if (!newName || newName === name) return;
    const from = filePinItem(f);
    try {
      await renameFile(fileType(f), fileSub(f), name, newName);
      await followPins([{ from, to: { ...from, name: newName } }]);
      f.name = newName;
      renderGrid();
    } catch (e) {
      reportError("Rename failed", e);
    }
  }
  async function onMove(f) {
    const dest = await pickDestination(modal, {
      type: fileType(f),
      subfolder: fileSub(f)
    });
    if (!dest) return;
    const from = filePinItem(f);
    try {
      await moveFile(fileType(f), fileSub(f), f.name, dest.type, dest.subfolder);
      saveDest(dest);
      await followPins([
        { from, to: { kind: "file", type: dest.type, subfolder: dest.subfolder, name: f.name } }
      ]);
      state.files = state.files.filter((x) => x !== f);
      renderGrid();
      notify2({
        severity: "success",
        summary: "Moved",
        detail: `"${f.name}" \u2192 ${dest.type}${dest.subfolder ? `/${dest.subfolder}` : ""}`
      });
    } catch (e) {
      reportError("Move failed", e);
    }
  }
  function refreshPinButtons() {
    for (const [i, c] of fileCards().entries()) {
      const f = renderedFiles[i];
      const btn = c.querySelector('[data-action="pin"]');
      if (!f || !btn) continue;
      const on = isPinned(filePinItem(f));
      btn.classList.toggle("is-pinned", on);
      btn.title = on ? "Unpin this file" : "Pin this file";
    }
  }
  async function refreshPinnedUI() {
    if (isPinnedView()) {
      await loadAndRender({ preserveScroll: true });
      return;
    }
    renderPins();
    refreshPinButtons();
  }
  async function toggleFolderPinHere() {
    if (!SANDBOXED_TYPES2.includes(state.type)) return;
    const item = { kind: "dir", type: state.type, subfolder: state.subfolder };
    const pinned = isPinned(item);
    try {
      setPinCache((await postPinDelta(pinned ? "remove" : "add", item)).pins);
      renderPins();
    } catch (e) {
      reportError(pinned ? "Unpin failed" : "Pin failed", e);
    }
  }
  async function unpinFolder(item) {
    try {
      setPinCache((await postPinDelta("remove", item)).pins);
      renderPins();
    } catch (e) {
      reportError("Unpin failed", e);
    }
  }
  async function toggleFilePin(f) {
    if (!canWriteFile(f)) return;
    const item = filePinItem(f);
    const pinned = isPinned(item);
    try {
      setPinCache((await postPinDelta(pinned ? "remove" : "add", item)).pins);
      await refreshPinnedUI();
    } catch (e) {
      reportError(pinned ? "Unpin failed" : "Pin failed", e);
    }
  }
  async function doPinSelected() {
    const items = collectSelectedOrFocused();
    if (items.length === 0) return;
    let added = 0;
    const failures = /* @__PURE__ */ new Set();
    for (const it of items) {
      try {
        const res = await postPinDelta("add", {
          kind: "file",
          type: it.type,
          subfolder: it.subfolder,
          name: it.name
        });
        setPinCache(res.pins);
        added++;
      } catch (e) {
        failures.add(e instanceof Error ? e.message : String(e));
      }
    }
    await refreshPinnedUI();
    if (failures.size > 0) {
      reportError(
        `Pinned ${added}, ${items.length - added} failed`,
        new Error(Array.from(failures).join("; "))
      );
      return;
    }
    notify2({ severity: "success", summary: "Pinned", detail: `${added} file(s)` });
  }
  async function onPruneMissing() {
    const before = pinEntries.length;
    try {
      const res = await postPinDelta("prune");
      const removed = before - res.pins.length;
      setPinCache(res.pins);
      await refreshPinnedUI();
      notify2({
        severity: "success",
        summary: "Pins pruned",
        detail: `${removed} missing pin(s) removed`
      });
    } catch (e) {
      reportError("Prune failed", e);
    }
  }
  async function followPins(changes) {
    const live = changes.filter((c) => isPinned(c.from));
    if (live.length === 0) return;
    try {
      for (const c of live) {
        setPinCache((await postPinDelta("remove", c.from)).pins);
        if (c.to) setPinCache((await postPinDelta("add", c.to)).pins);
      }
      renderPins();
    } catch (e) {
      reportError("Pin list not updated for this change", e);
    }
  }
  function renderTabs() {
    for (const b of tabsEl.querySelectorAll(".ib-tab")) {
      b.classList.toggle("is-active", b.dataset.type === state.type);
    }
    const canWrite = SANDBOXED_TYPES2.includes(state.type);
    selectToggleEl.style.display = canSelectHere() ? "" : "none";
    newFolderEl.style.display = canWrite ? "" : "none";
    uploadEl.style.display = canWrite ? "" : "none";
    viewToggleEl.style.display = canWrite ? "" : "none";
    viewToggleEl.classList.toggle("is-active", isFlat());
    viewToggleEl.title = isFlat() ? "Folder view" : "Flat view (all subfolders)";
    for (const b of filterGroupEl.querySelectorAll(".ib-filter-seg")) {
      b.classList.toggle("is-active", b.dataset.filter === state.typeFilter);
    }
  }
  function renderPins() {
    const pins = folderPins();
    const canPin = SANDBOXED_TYPES2.includes(state.type);
    pinToggleEl.style.display = canPin ? "" : "none";
    const herePinned = canPin && isPinned({ kind: "dir", type: state.type, subfolder: state.subfolder });
    pinToggleEl.classList.toggle("is-active", herePinned);
    pinToggleEl.title = herePinned ? "Unpin this folder" : "Pin this folder";
    pruneEl.style.display = isPinnedView() && pinEntries.some((p) => p.exists === false) ? "" : "none";
    pinsEl.innerHTML = "";
    pinsEl.style.display = pins.length ? "" : "none";
    for (const p of pins) {
      const chip = document.createElement("span");
      chip.className = "ib-pin-chip";
      chip.dataset.pinType = p.type;
      chip.dataset.pinSub = p.subfolder;
      if (p.type === state.type && p.subfolder === state.subfolder)
        chip.classList.add("is-current");
      const go = document.createElement("button");
      go.type = "button";
      go.className = "ib-pin-go";
      go.title = `Go to ${pinLabel(p)}`;
      go.textContent = `\u{1F4CC} ${pinLabel(p)}`;
      const x = document.createElement("button");
      x.type = "button";
      x.className = "ib-pin-x";
      x.title = `Unpin ${pinLabel(p)}`;
      x.textContent = "\u2715";
      chip.append(go, x);
      pinsEl.appendChild(chip);
    }
  }
  function renderCrumbs() {
    crumbsEl.innerHTML = "";
    const mk = (text, attr, value) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "ib-crumb";
      b.setAttribute(attr, value);
      b.textContent = text;
      return b;
    };
    if (state.type === "path") {
      crumbsEl.appendChild(mk("/", "data-abs", "/"));
      let acc = "";
      for (const p of state.absPath.split("/").filter(Boolean)) {
        acc = `${acc}/${p}`;
        crumbsEl.appendChild(mk(p, "data-abs", acc));
      }
    } else {
      crumbsEl.appendChild(mk(options.rootLabel?.(state.type) || state.type, "data-sub", ""));
      let acc = "";
      for (const p of state.subfolder.split("/").filter(Boolean)) {
        acc = acc ? `${acc}/${p}` : p;
        crumbsEl.appendChild(mk(p, "data-sub", acc));
      }
    }
  }
  let loadTicker = null;
  function hideLoadNote() {
    loadNoteEl.hidden = true;
    loadNoteEl.textContent = "";
  }
  function cancelLoadTicker() {
    if (loadTicker !== null) {
      clearInterval(loadTicker);
      loadTicker = null;
    }
    hideLoadNote();
  }
  function startLoadTicker(flat) {
    cancelLoadTicker();
    const started = Date.now();
    modal.setStatus(loadingStatusText(0));
    const mine = setInterval(() => {
      const elapsed = Date.now() - started;
      modal.setStatus(loadingStatusText(elapsed));
      if (elapsed >= LOAD_NOTE_MS && loadNoteEl.hidden) {
        loadNoteEl.textContent = flat ? LOAD_NOTE_FLAT : LOAD_NOTE_FOLDER;
        loadNoteEl.hidden = false;
      }
    }, LOAD_TICK_MS);
    loadTicker = mine;
    return () => {
      clearInterval(mine);
      if (loadTicker === mine) {
        loadTicker = null;
        hideLoadNote();
      }
    };
  }
  async function loadAndRender(opts) {
    if (!modal.dialog.isConnected) return;
    const generation = ++loadGeneration;
    modal.dialog.dispatchEvent(new CustomEvent("hub-loading", { detail: { preserve: !!lastQuery && lastQuery.type === state.type && lastQuery.subfolder === state.subfolder && lastQuery.path === state.absPath && lastQuery.query === state.query && lastQuery.kind === state.typeFilter && lastQuery.recursive === isFlat() && lastQuery.sortKey === state.sortKey && lastQuery.sortDir === state.sortDir } }));
    if (!restoring) focusIndex = 0;
    visualMode = false;
    modal.dialog.classList.remove("is-visual");
    clearPending();
    const here = locationKey();
    if (revealLocation !== here) {
      revealed.clear();
      revealLocation = here;
      scanPollsLeft = SCAN_POLL_MAX;
    }
    renderTabs();
    renderCrumbs();
    if (!options.compact) modal.setBusy(true);
    viewStore.markPending(isFlat());
    const safeCfg = readSafeViewConfig();
    renderSafeToggle(safeCfg);
    const stopLoadTicker = startLoadTicker(isFlat());
    try {
      if (isPinnedView()) {
        const res = await fetchPins();
        setPinCache(res.pins);
        state.dirs = [];
        state.files = narrowByKind(pinsToFiles(res.pins), state.typeFilter);
        if (safeCfg.hide) {
          state.files = state.files.filter((f) => !isSensitive(safeTargetOf(f), safeCfg));
        }
        renderScanPill(0);
        modal.setStatus(res.pins.length ? "" : "Nothing pinned yet.");
      } else {
        const query = { type: state.type, subfolder: state.subfolder, path: state.absPath, recursive: isFlat(), kind: state.typeFilter, query: state.query, sortKey: state.sortKey, sortDir: state.sortDir, safeHide: safeCfg.hide, safeKeywords: safeCfg.keywords, safePrompt: safeCfg.matchPrompt };
        const scope = JSON.stringify(query);
        if (scope !== pageScope) {
          restoring = false;
          pageScope = scope;
          pageOffset = 0;
          clickAnchor = -1;
          clearSelection();
        }
        const data = options.listing && state.type !== "path" ? await options.listing({ ...query, offset: pageOffset, refresh: !!opts?.rescan }) : await fetchListing({
          type: state.type,
          subfolder: state.subfolder,
          path: state.absPath,
          recursive: isFlat(),
          kind: state.typeFilter,
          // Sent only when hiding is actually on AND there is something to
          // match, so the default request URL stays byte-identical to what it
          // was before Safe View existed — the same discipline `kind` follows.
          safeHide: safeCfg.hide,
          safeKeywords: safeCfg.keywords,
          // The opt-in prompt tier. Independent of `safeHide`: the two compose,
          // and blur-only is this tier's default mode as it is for the others.
          safePrompt: safeCfg.matchPrompt
        });
        if (generation !== loadGeneration || !modal.dialog.isConnected) return;
        lastListing = data;
        lastQuery = { ...query, token: data.token };
        pageOffset = data.offset || 0;
        modal.dialog.dispatchEvent(new CustomEvent("hub-list", { detail: { ...data, query: lastQuery } }));
        state.dirs = data.dirs || [];
        state.files = data.files || [];
        renderScanPill(data.safe_unscanned ?? 0);
        modal.setStatus(data.exists ? "" : "Directory not found.");
        if (data.truncated) {
          notify2({
            severity: "warn",
            summary: `Showing the newest ${state.files.length}`,
            detail: "This folder's subtree has more files than the flat view returns; older ones are not listed."
          });
        }
      }
    } catch (e) {
      reportError(isPinnedView() ? "Failed to load pins" : "Failed to load directory", e);
      modal.setStatus(`Error: ${e.message}`);
      state.dirs = [];
      state.files = [];
      renderScanPill(0);
    } finally {
      stopLoadTicker();
    }
    if (generation !== loadGeneration || !modal.dialog.isConnected) return;
    modal.setBusy(false);
    renderPins();
    renderPager();
    renderGrid({
      scrollTo: restoring && resume ? resume.scrollTop : opts?.preserveScroll ? void 0 : scrollMemory.get(locationKey())
    });
    restoring = false;
    updateSelectedCount();
    viewStore.markPending(false);
  }
  function narrowByKind(files, filter) {
    if (filter === "all") return files;
    const want = filter === "images" ? IMG_EXTS : VIDEO_EXTS;
    return files.filter((f) => want.has((f.ext || "").toLowerCase()));
  }
  function thumbForFile(f) {
    if (f.pinExists === false) return { kind: "icon", text: "\u26A0" };
    const ext = (f.ext || "").toLowerCase();
    const sub = fileSub(f);
    const type = fileType(f);
    if (IMG_EXTS.has(ext)) {
      return {
        kind: "img",
        src: imageThumbURL(type, sub, f.name, state.absPath, thumbVersion(f.mtime, f.size))
      };
    }
    if (VIDEO_EXTS.has(ext)) {
      if (type === "path" && !pathReadsAllowed()) {
        return { kind: "icon", text: "\u{1F512}", title: PATH_READS_DISABLED_MSG };
      }
      return {
        kind: "video",
        src: videoSrcURL(type, sub, f.name, state.absPath)
      };
    }
    return { kind: "icon", text: "\u{1F4C4}" };
  }
  function syncDensitySegs() {
    for (const b of densityGroupEl.querySelectorAll(".ib-density-seg")) {
      const on = b.dataset.density === state.density;
      b.classList.toggle("is-active", on);
      b.setAttribute("aria-pressed", String(on));
    }
  }
  function renderGrid(opts) {
    cancelChunkJob();
    disposeLazyThumbs();
    const q = state.query;
    syncDensitySegs();
    const nameSpans = (name) => {
      const { head, tail } = labelParts(name, !!q);
      const tailSpan = `<span class="ib-name-tail">${escapeHTML(tail)}</span>`;
      return head ? `<span class="ib-name-head">${escapeHTML(head)}</span>${tailSpan}` : tailSpan;
    };
    const targetScrollTop = opts?.scrollTo ?? scroller.current();
    const safeCfg = readSafeViewConfig();
    const safeKeyword = sensitiveKeyword(safeCfg);
    renderSafeToggle(safeCfg);
    gridEl.innerHTML = "";
    gridEl.dataset.density = state.density;
    const canWrite = SANDBOXED_TYPES2.includes(state.type);
    const flat = isFlat();
    const pinnedView = isPinnedView();
    const showUp = !flat && canGoUp();
    if (showUp) {
      const up = document.createElement("div");
      up.className = "ib-card is-up";
      up.innerHTML = `<div class="ib-thumb ib-thumb-icon">\u2191</div><div class="ib-name">..</div>`;
      gridEl.appendChild(up);
    }
    if (!flat) {
      for (const d of state.dirs) {
        if (q && !d.name.toLowerCase().includes(q)) continue;
        const c = document.createElement("div");
        c.className = "ib-card is-dir";
        c.dataset.name = d.name;
        const dirBtns = canWrite ? `<button type="button" class="ib-dir-move" data-action="movedir" title="Move folder">\u21C4</button><button type="button" class="ib-dir-del" data-action="rmdir" title="Delete folder">\u{1F5D1}</button>` : "";
        c.innerHTML = `<div class="ib-thumb ib-thumb-icon">\u{1F4C1}</div><div class="ib-name" title="${escapeHTML(d.name)}">${nameSpans(d.name)}</div>${dirBtns}`;
        gridEl.appendChild(c);
        if (isSensitive({ name: d.name }, safeCfg)) {
          c.classList.add("is-safe-hidden");
          const icon = c.querySelector(".ib-thumb");
          if (icon) setBlurred(icon, true);
          if (safeCfg.blurNames) {
            const nameEl = c.querySelector(".ib-name");
            if (nameEl) setSpoilered(nameEl, true);
          }
        }
      }
    }
    let files = state.files;
    if (q && !options.listing) {
      const scored = [];
      for (const f of files) {
        const hay = flat && f.subpath ? `${f.subpath}/${f.name}` : f.name;
        const r = fuzzyScore(q, hay);
        if (r) scored.push({ f, score: r.score });
      }
      scored.sort((a, b) => b.score - a.score);
      files = scored.map((x) => x.f);
    } else if (!options.listing) {
      files = sortFiles(files, state.sortKey, state.sortDir);
    }
    renderedFiles = files;
    if (files.length === 0) focusIndex = -1;
    else if (focusIndex < 0) focusIndex = 0;
    else if (focusIndex >= files.length) focusIndex = files.length - 1;
    const ctx = { flat, pinnedView, safeCfg, safeKeyword, nameSpans };
    let visible = 0;
    for (const f of files) if (f) visible++;
    const syncCount = Math.min(files.length, SYNC_CARD_BUDGET);
    appendCards(files, 0, syncCount, ctx, 0);
    if (!visible && !state.dirs.length && !showUp) {
      const el = document.createElement("div");
      el.className = "ib-empty";
      el.textContent = pinnedView ? "No pinned files. Tap \u{1F4CC} on a card to add one." : "No matching files in this folder.";
      gridEl.appendChild(el);
    }
    setCount(visible, state.files.length);
    scroller.restore(targetScrollTop);
    observeThumbChunk(0);
    if (syncCount < files.length) {
      const job = {
        files,
        ctx,
        next: syncCount,
        seq: 1,
        scrollTarget: targetScrollTop,
        lastAsserted: scroller.current(),
        raf: null
      };
      chunkJob = job;
      if (typeof requestAnimationFrame === "function") {
        scheduleChunk(job);
      } else {
        while (job.next < files.length) buildChunk(job);
        chunkJob = null;
      }
    }
  }
  function buildFileCard(f, fi, ctx) {
    const { flat, pinnedView, safeCfg, safeKeyword, nameSpans } = ctx;
    const c = document.createElement("div");
    c.className = "ib-card is-file";
    const canWriteThis = canWriteFile(f);
    const hidden = isCardHidden(f, safeCfg);
    const spoilNames = hidden && safeCfg.blurNames;
    const missing = f.pinExists === false;
    if (flat || pinnedView) c.classList.add("is-flat");
    if (missing) c.classList.add("is-missing");
    if (fi === focusIndex) c.classList.add("is-focused");
    if (isSelected(f)) c.classList.add("is-selected");
    c.dataset.name = f.name;
    c.dataset.ext = (f.ext || "").toLowerCase();
    c.dataset.idx = String(fi);
    const t = thumbForFile(f);
    const dims = f.width && f.height ? `${f.width}\xD7${f.height}` : "";
    const when = new Date(f.mtime * 1e3).toLocaleString();
    const titleText = dims ? `${f.name}
${dims}
${when}` : `${f.name}
${when}`;
    const thumbInner = t.kind === "img" ? `<img loading="lazy" decoding="async" data-src="${t.src}" alt="">` : t.kind === "video" ? `<video muted playsinline preload="none" data-src="${t.src}"></video>` : `<div class="ib-thumb-icon"${t.title ? ` title="${escapeHTML(t.title)}"` : ""}>${t.text}</div>`;
    const hasMeta = META_EXTS.has((f.ext || "").toLowerCase());
    const metaBtn = hasMeta ? `<button type="button" class="ib-act" data-action="meta" title="Metadata (i)">\u24D8</button>` : "";
    const wfBtn = hasMeta ? `<button type="button" class="ib-act" data-action="workflow" title="Load workflow (w)">\u2913</button>` : "";
    const moveBtn = canWriteThis ? `<button type="button" class="ib-act" data-action="move" title="Move">\u21C4</button>` : "";
    const renameBtn = canWriteThis ? `<button type="button" class="ib-act" data-action="rename" title="Rename">\u270E</button>` : "";
    const deleteBtn = canWriteThis ? `<button type="button" class="ib-act ib-act-danger" data-action="delete" title="Delete">\u{1F5D1}</button>` : "";
    const isFilePinned = canWriteThis && isPinned(filePinItem(f));
    const pinBtn = canWriteThis ? `<button type="button" class="ib-act ib-act-pin${isFilePinned ? " is-pinned" : ""}" data-action="pin" title="${isFilePinned ? "Unpin this file" : "Pin this file"}">\u{1F4CC}</button>` : "";
    const markBtn = canWriteThis && !missing && safeKeyword ? markSensitiveHTML("ib", safeKeyword, hasSensitiveTag(f, safeKeyword)) : "";
    const starsRow = canWriteThis ? starsHTML("ib", ratingOf(f)) : ratingOf(f) ? `<div class="ib-stars is-ro" data-rating="${ratingOf(f)}">${"\u2605".repeat(ratingOf(f))}</div>` : "";
    const checkBtn = canWriteThis ? `<button type="button" class="ib-check" data-check aria-label="${spoilNames ? "Select hidden item" : `Select ${escapeHTML(f.name)}`}">\u2713</button>` : "";
    const subLabel = pinnedView ? `<button type="button" class="ib-subpath" data-pin-type="${escapeHTML(fileType(f))}" data-sub="${escapeHTML(fileSub(f))}" title="Go to ${escapeHTML(pinLabel(filePinItem(f)))}">${nameSpans(`${fileType(f)}/${fileSub(f) ? `${fileSub(f)}/` : ""}`)}</button>` : flat ? f.subpath ? `<button type="button" class="ib-subpath" data-sub="${escapeHTML(fileSub(f))}" title="Go to ${escapeHTML(f.subpath)}">${nameSpans(f.subpath)}</button>` : `<div class="ib-subpath is-root" title="Top level">/</div>` : "";
    c.innerHTML = missing ? `
      ${subLabel}
      <div class="ib-thumb">${thumbInner}</div>
      <div class="ib-name" title="${escapeHTML(f.name)}">${nameSpans(f.name)}</div>
      <div class="ib-meta">missing</div>
      <div class="ib-actions">${pinBtn}</div>` : `
      ${subLabel}
      ${checkBtn}
      <div class="ib-thumb">${thumbInner}</div>
      <div class="ib-name" title="${escapeHTML(titleText)}">${nameSpans(f.name)}</div>
      ${dims ? `<div class="ib-meta">${dims}</div>` : ""}
      ${starsRow}
      <div class="ib-actions">${actionRowHTML([
      // PRIORITY ORDER — see actionRowHTML. The two STATEFUL controls come
      // first, because their state is the reason they are on the card at
      // all: 📌 renders filled while pinned and 🙈 pressed while marked,
      // and a control whose state you cannot see without opening a sheet
      // has stopped being an indicator. ↗ open-in-tab follows them rather
      // than leading, because a tap anywhere on the card already opens the
      // full-size lightbox (the grid click handler's fall-through) — so it
      // is the one control whose demotion costs the user nothing.
      // Destructive last, which is the whole point of #90.
      pinBtn,
      markBtn,
      `<button type="button" class="ib-act" data-action="open" title="Open in new tab">\u2197</button>`,
      metaBtn,
      wfBtn,
      renameBtn,
      moveBtn,
      deleteBtn
    ])}</div>`;
    if (options.compact) {
      c.querySelector(".ib-stars")?.remove();
      const actions = c.querySelector(".ib-actions");
      if (actions) actions.innerHTML = '<button type="button" class="ib-act" data-action="preview" title="\u753B\u50CF\u3092\u62E1\u5927">\u62E1\u5927</button>' + wfBtn.replace("\u2913", "\u30B0\u30E9\u30D5").replace("Load workflow (w)", "\u30B0\u30E9\u30D5\u3092\u958B\u304F (W)");
    }
    options.decorateCard?.(c, { ...f, type: fileType(f), subfolder: fileSub(f) });
    if (hidden) applySafeView(c, f, spoilNames);
    return c;
  }
  let chunkJob = null;
  function cancelChunkJob() {
    const job = chunkJob;
    chunkJob = null;
    if (job && job.raf !== null && typeof cancelAnimationFrame === "function") {
      cancelAnimationFrame(job.raf);
    }
  }
  function appendCards(files, from, to, ctx, seq) {
    for (let fi = from; fi < to; fi++) {
      const f = files[fi];
      if (!f) continue;
      const c = buildFileCard(f, fi, ctx);
      c.dataset.chunk = String(seq);
      gridEl.appendChild(c);
    }
  }
  function buildChunk(job) {
    const to = Math.min(job.files.length, job.next + CHUNK_CARDS);
    appendCards(job.files, job.next, to, job.ctx, job.seq);
    observeThumbChunk(job.seq);
    job.next = to;
    job.seq++;
    reassertChunkScroll(job);
  }
  function scheduleChunk(job) {
    job.raf = requestAnimationFrame(() => {
      job.raf = null;
      if (chunkJob !== job) return;
      runChunk(job);
    });
  }
  function runChunk(job) {
    buildChunk(job);
    if (job.next < job.files.length) scheduleChunk(job);
    else chunkJob = null;
  }
  function reassertChunkScroll(job) {
    if (job.scrollTarget <= 0) return;
    const now = scroller.current();
    if (now !== job.lastAsserted) return;
    if (now >= job.scrollTarget) return;
    scroller.restore(job.scrollTarget);
    job.lastAsserted = scroller.current();
  }
  function ensureCardsBuilt(index) {
    const job = chunkJob;
    if (!job || index < job.next) return;
    if (job.raf !== null && typeof cancelAnimationFrame === "function") {
      cancelAnimationFrame(job.raf);
    }
    job.raf = null;
    while (job.next <= index && job.next < job.files.length) buildChunk(job);
    if (job.next < job.files.length) scheduleChunk(job);
    else chunkJob = null;
  }
  function applySafeView(card, f, spoilNames) {
    card.classList.add("is-safe-hidden");
    const thumb2 = card.querySelector(".ib-thumb");
    if (thumb2) setBlurred(thumb2, true);
    if (spoilNames) {
      for (const sel of [".ib-name", ".ib-subpath"]) {
        const el = card.querySelector(sel);
        if (el) setSpoilered(el, true);
      }
    }
    card.appendChild(
      makeRevealButton({
        onReveal: () => {
          revealed.reveal(fileType(f), fileSub(f), f.name);
          renderGrid();
        }
      })
    );
  }
  let lazyThumbDisposers = [];
  function disposeLazyThumbs() {
    for (const dispose of lazyThumbDisposers) dispose();
    lazyThumbDisposers = [];
  }
  function observeThumbChunk(seq) {
    lazyThumbDisposers.push(
      installLazyMedia(gridEl, {
        root: scrollHost,
        rootMargin: DENSITY_ROOT_MARGIN[state.density],
        selector: `[data-chunk="${seq}"] img[data-src], [data-chunk="${seq}"] video[data-src]`
      })
    );
  }
  function reportError(summary, e) {
    const detail = e instanceof Error ? e.message : String(e);
    console.warn(`[${EXT_NAME}] ${summary}:`, e);
    notify2({ severity: "error", summary, detail });
  }
  function isInInput() {
    const el = document.activeElement;
    if (!el) return false;
    const tag = el.tagName;
    return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable;
  }
  function selectionKey(type, subfolder, name) {
    return `${type}:${subfolder}:${name}`;
  }
  function isSelected(f) {
    if (!canWriteFile(f)) return false;
    return selected.has(selectionKey(fileType(f), fileSub(f), f.name));
  }
  function fileCards() {
    return Array.from(gridEl.querySelectorAll(".ib-card.is-file"));
  }
  function gridColumns() {
    const cards = fileCards();
    if (cards.length < 2) return 1;
    const byTop = /* @__PURE__ */ new Map();
    let widest = 1;
    for (const c of cards) {
      const n = (byTop.get(c.offsetTop) ?? 0) + 1;
      byTop.set(c.offsetTop, n);
      if (n > widest) widest = n;
    }
    return widest;
  }
  function applyFocus() {
    ensureCardsBuilt(focusIndex);
    for (const [i, c] of fileCards().entries()) {
      c.classList.toggle("is-focused", i === focusIndex);
    }
    const focused = gridEl.querySelector(".ib-card.is-focused");
    scroller.cancel();
    focused?.scrollIntoView({ block: "nearest", inline: "nearest" });
    scroller.sync();
  }
  function refreshSelectionClasses() {
    for (const [i, c] of fileCards().entries()) {
      const f = renderedFiles[i];
      c.classList.toggle("is-selected", !!f && isSelected(f));
    }
  }
  function moveFocus(delta) {
    const n = renderedFiles.length;
    if (n === 0) return;
    focusIndex = Math.max(0, Math.min(n - 1, focusIndex + delta));
    if (visualMode) extendSelectionTo(focusIndex);
    applyFocus();
  }
  function focusFirst() {
    const n = renderedFiles.length;
    if (n === 0) return;
    focusIndex = 0;
    if (visualMode) extendSelectionTo(focusIndex);
    applyFocus();
  }
  function focusLast() {
    const n = renderedFiles.length;
    if (n === 0) return;
    focusIndex = n - 1;
    if (visualMode) extendSelectionTo(focusIndex);
    applyFocus();
  }
  function updateSelectedCount() {
    const n = selected.size;
    selectedBadge.style.display = n > 0 ? "inline" : "none";
    selectedBadge.textContent = n > 0 ? `${n} selected` : "";
    selBar.classList.toggle("is-visible", n > 0);
    selBarCount.textContent = `${n} selected`;
    modal.dialog.dispatchEvent(new CustomEvent("hub-selection", { detail: { count: n } }));
  }
  function setSelectMode(on) {
    if (on && !canSelectHere()) return;
    selectMode = on;
    selectToggleEl.classList.toggle("is-active", on);
    modal.dialog.classList.toggle("is-selecting", on);
  }
  function selectFile(f) {
    const sub = fileSub(f);
    selected.set(selectionKey(fileType(f), sub, f.name), {
      file: f,
      type: fileType(f),
      subfolder: sub
    });
  }
  function toggleSelectionAt(i) {
    const f = renderedFiles[i];
    if (!f || !canWriteFile(f)) return;
    const key = selectionKey(fileType(f), fileSub(f), f.name);
    if (selected.has(key)) selected.delete(key);
    else selectFile(f);
    refreshSelectionClasses();
    updateSelectedCount();
  }
  function setSelectedRange(a, b, on) {
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    for (let i = lo; i <= hi; i++) {
      const f = renderedFiles[i];
      if (!f || !canWriteFile(f)) continue;
      if (on) selectFile(f);
      else selected.delete(selectionKey(fileType(f), fileSub(f), f.name));
    }
    refreshSelectionClasses();
    updateSelectedCount();
  }
  function extendSelectionTo(i) {
    const lo = Math.min(visualAnchor, i);
    const hi = Math.max(visualAnchor, i);
    for (let k = lo; k <= hi; k++) {
      const f = renderedFiles[k];
      if (!f || !canWriteFile(f)) continue;
      selectFile(f);
    }
    refreshSelectionClasses();
    updateSelectedCount();
  }
  function selectAllVisible() {
    for (const f of renderedFiles) {
      if (!canWriteFile(f)) continue;
      selectFile(f);
    }
    refreshSelectionClasses();
    updateSelectedCount();
  }
  function clearSelection() {
    selected.clear();
    refreshSelectionClasses();
    updateSelectedCount();
  }
  function toggleVisualMode() {
    if (!canSelectHere()) return;
    if (renderedFiles.length === 0) return;
    visualMode = !visualMode;
    if (visualMode) {
      if (focusIndex < 0) focusIndex = 0;
      visualAnchor = focusIndex;
      extendSelectionTo(focusIndex);
    }
    modal.dialog.classList.toggle("is-visual", visualMode);
  }
  function collectSelectedOrFocused() {
    if (selected.size > 0) {
      return Array.from(selected.values()).map((v) => ({
        type: v.type,
        subfolder: v.subfolder,
        name: v.file.name
      }));
    }
    const f = renderedFiles[focusIndex];
    if (!f || !canWriteFile(f)) return [];
    return [{ type: fileType(f), subfolder: fileSub(f), name: f.name }];
  }
  function setPending(op) {
    clearPending();
    pendingOp = op;
    pendingTimer = setTimeout(clearPending, 1500);
    const hint = op === "d" ? "d\u2026 (d/y=delete, n=cancel)" : op === "y" ? "y\u2026 (y=yank)" : "g\u2026 (g=top)";
    modal.setStatus(hint);
  }
  function clearPending() {
    if (pendingTimer) {
      clearTimeout(pendingTimer);
      pendingTimer = null;
    }
    pendingOp = null;
    modal.setStatus("");
  }
  async function doDelete() {
    const items = collectSelectedOrFocused();
    if (items.length === 0) return;
    const count = items.length;
    const ok = await confirmInShell(modal, {
      title: count === 1 ? "Delete file?" : `Delete ${count} files?`,
      message: count === 1 ? `Permanently delete "${items[0]?.name}"? This cannot be undone.` : `Permanently delete ${count} selected files? This cannot be undone.`,
      confirmLabel: "Delete",
      danger: true
    });
    if (!ok) return;
    try {
      const result = await deleteMany(items);
      const errored = new Set((result.errors ?? []).map((e) => e.name));
      const succeeded = new Set(
        items.filter((it) => !errored.has(it.name)).map((it) => selectionKey(it.type, it.subfolder, it.name))
      );
      state.files = state.files.filter(
        (f) => !succeeded.has(selectionKey(fileType(f), fileSub(f), f.name))
      );
      for (const it of items) {
        if (!errored.has(it.name)) selected.delete(selectionKey(it.type, it.subfolder, it.name));
      }
      await followPins(
        items.filter((it) => !errored.has(it.name)).map((it) => ({
          from: { kind: "file", type: it.type, subfolder: it.subfolder, name: it.name },
          to: null
        }))
      );
      updateSelectedCount();
      renderGrid();
      if (result.errors && result.errors.length > 0) {
        const names = result.errors.map((e) => e.name).join(", ");
        reportError(`Deleted ${result.deleted}, ${result.errors.length} failed`, new Error(names));
      } else {
        notify2({ severity: "success", summary: "Deleted", detail: `${result.deleted} file(s)` });
      }
    } catch (e) {
      reportError("Delete failed", e);
    }
  }
  async function doMoveSelected() {
    const items = collectSelectedOrFocused();
    if (items.length === 0) return;
    const dest = await pickDestination(modal, {
      type: state.type,
      subfolder: state.subfolder
    });
    if (!dest) return;
    try {
      const result = await moveMany(items, dest.type, dest.subfolder);
      const errored = new Set((result.errors ?? []).map((er) => er.name));
      for (const it of items) {
        if (!errored.has(it.name)) selected.delete(selectionKey(it.type, it.subfolder, it.name));
      }
      updateSelectedCount();
      if (result.moved > 0) saveDest(dest);
      await followPins(
        items.filter((it) => !errored.has(it.name)).map((it) => ({
          from: { kind: "file", type: it.type, subfolder: it.subfolder, name: it.name },
          to: {
            kind: "file",
            type: dest.type,
            subfolder: dest.subfolder,
            name: it.name
          }
        }))
      );
      if (isFlat() || isPinnedView() || dest.type === state.type && dest.subfolder === state.subfolder) {
        await loadAndRender({ preserveScroll: true });
      } else {
        const succeeded = new Set(
          items.filter((it) => !errored.has(it.name)).map((it) => selectionKey(it.type, it.subfolder, it.name))
        );
        state.files = state.files.filter(
          (f) => !succeeded.has(selectionKey(fileType(f), fileSub(f), f.name))
        );
        renderGrid();
      }
      if (result.errors && result.errors.length > 0) {
        const names = result.errors.map((er) => er.name).join(", ");
        reportError(`Moved ${result.moved}, ${result.errors.length} failed`, new Error(names));
      } else {
        notify2({
          severity: "success",
          summary: "Moved",
          detail: `${result.moved} file(s) \u2192 ${dest.type}${dest.subfolder ? `/${dest.subfolder}` : ""}`
        });
      }
    } catch (e) {
      reportError("Move failed", e);
    }
  }
  async function onNewFolder() {
    if (!SANDBOXED_TYPES2.includes(state.type)) return;
    const existing = new Set(state.dirs.map((d) => d.name));
    const name = await promptInShell(modal, {
      title: "New folder",
      label: `Create in ${state.type}${state.subfolder ? `/${state.subfolder}` : ""}`,
      value: "",
      confirmLabel: "Create",
      validate: (v) => {
        if (!v) return "Folder name required";
        if (v.includes("/") || v.includes("\\")) return "No slashes allowed";
        if (v === "." || v === "..") return "Invalid name";
        if (existing.has(v)) return "A folder with that name already exists";
        return null;
      }
    });
    if (!name) return;
    try {
      await makeDir(state.type, state.subfolder, name);
      await loadAndRender({ preserveScroll: true });
      notify2({ severity: "success", summary: "Folder created", detail: `"${name}"` });
    } catch (e) {
      reportError("Create folder failed", e);
    }
  }
  async function onUpload(files) {
    if (!SANDBOXED_TYPES2.includes(state.type)) return;
    const type = state.type;
    const subfolder = state.subfolder;
    const where = `${type}${subfolder ? `/${subfolder}` : ""}`;
    const ov = openShellOverlay(modal);
    ov.card.innerHTML = `
      <div class="cmp-ov-title">Uploading ${files.length} file(s)\u2026</div>
      <div class="ib-upload-where">to ${escapeHTML(where)}</div>`;
    let result;
    try {
      result = await uploadFiles(type, subfolder, files);
    } catch (e) {
      ov.close();
      reportError("Upload failed", e);
      return;
    }
    ov.close();
    if (result.uploaded.length > 0 && state.type === type && state.subfolder === subfolder) {
      await loadAndRender({ preserveScroll: true });
    }
    const failures = result.errors.map((er) => `${er.name}: ${er.error}`).join("\n");
    if (result.ok && result.errors.length === 0) {
      notify2({
        severity: "success",
        summary: "Uploaded",
        detail: `${result.uploaded.length} file(s) to ${where}`
      });
    } else if (result.uploaded.length > 0) {
      reportError(
        `Uploaded ${result.uploaded.length}, ${result.errors.length} failed`,
        new Error(failures)
      );
    } else {
      reportError("Upload failed", new Error(failures || result.error || "nothing was uploaded"));
    }
  }
  async function onMoveDir(name) {
    if (!SANDBOXED_TYPES2.includes(state.type)) return;
    const srcSub = state.subfolder ? `${state.subfolder}/${name}` : name;
    const dest = await pickDestination(
      modal,
      { type: state.type, subfolder: state.subfolder },
      { type: state.type, subfolder: srcSub }
    );
    if (!dest) return;
    try {
      const result = await moveDir(state.type, state.subfolder, name, dest.type, dest.subfolder);
      saveDest(dest);
      const conflicts = result.errors ?? [];
      if (conflicts.length > 0) {
        await loadAndRender({ preserveScroll: true });
        reportError(
          `Folder merged, ${conflicts.length} item(s) left in place`,
          new Error(conflicts.map((c) => c.name).join(", "))
        );
        return;
      }
      state.dirs = state.dirs.filter((d) => d.name !== name);
      await followPins(pinsUnder(state.type, srcSub).map((from) => ({ from, to: null })));
      renderPins();
      renderGrid();
      notify2({
        severity: "success",
        summary: result.merged ? "Folder merged" : "Folder moved",
        detail: `"${name}" \u2192 ${dest.type}${dest.subfolder ? `/${dest.subfolder}` : ""}`
      });
    } catch (e) {
      reportError("Move folder failed", e);
    }
  }
  async function onDeleteDir(name) {
    if (!SANDBOXED_TYPES2.includes(state.type)) return;
    try {
      const res = await removeDir(state.type, state.subfolder, name, false);
      if (res.status === "not_empty") {
        const parts = [`${res.files} file${res.files === 1 ? "" : "s"}`];
        if (res.dirs > 0) parts.push(`${res.dirs} subfolder${res.dirs === 1 ? "" : "s"}`);
        const ok = await confirmInShell(modal, {
          title: "Delete folder and contents?",
          message: `"${name}" contains ${parts.join(" and ")}. Permanently delete everything inside? This cannot be undone.`,
          confirmLabel: `Delete ${res.files} file${res.files === 1 ? "" : "s"}`,
          danger: true
        });
        if (!ok) return;
        await removeDir(state.type, state.subfolder, name, true);
      }
      state.dirs = state.dirs.filter((d) => d.name !== name);
      const gone = state.subfolder ? `${state.subfolder}/${name}` : name;
      await followPins(pinsUnder(state.type, gone).map((from) => ({ from, to: null })));
      renderPins();
      renderGrid();
      notify2({
        severity: "success",
        summary: "Folder deleted",
        detail: res.status === "not_empty" ? `"${name}" (${res.files} files)` : `"${name}" (empty)`
      });
    } catch (e) {
      reportError("Delete folder failed", e);
    }
  }
  function doYank() {
    if (!canSelectHere()) return;
    const items = collectSelectedOrFocused();
    if (items.length === 0) return;
    yanked = items;
    notify2({
      severity: "info",
      summary: "Yanked",
      detail: `${items.length} file(s) \u2014 press p to move here`
    });
  }
  async function doPaste() {
    if (!SANDBOXED_TYPES2.includes(state.type)) return;
    if (!yanked || yanked.length === 0) {
      notify2({ severity: "info", summary: "Nothing to paste", detail: "Yank files first with yy" });
      return;
    }
    try {
      const result = await moveMany(yanked, state.type, state.subfolder);
      const landed = yanked.filter((it) => !result.errors?.some((e) => e.name === it.name));
      for (const it of landed) selected.delete(selectionKey(it.type, it.subfolder, it.name));
      await followPins(
        landed.map((it) => ({
          from: { kind: "file", type: it.type, subfolder: it.subfolder, name: it.name },
          to: {
            kind: "file",
            type: state.type,
            subfolder: state.subfolder,
            name: it.name
          }
        }))
      );
      yanked = null;
      updateSelectedCount();
      if (result.moved > 0) saveDest({ type: state.type, subfolder: state.subfolder });
      await loadAndRender({ preserveScroll: true });
      if (result.errors && result.errors.length > 0) {
        const names = result.errors.map((e) => e.name).join(", ");
        reportError(`Moved ${result.moved}, ${result.errors.length} failed`, new Error(names));
      } else {
        notify2({ severity: "success", summary: "Moved", detail: `${result.moved} file(s)` });
      }
    } catch (e) {
      reportError("Paste (move) failed", e);
    }
  }
  async function siblingNav(dir) {
    rememberScroll();
    let parentType;
    let parentSub;
    let parentPath;
    let currentName;
    if (state.type === "path") {
      const p = (state.absPath || "/").replace(/\/+$/, "");
      if (p === "" || p === "/") return;
      const i = p.lastIndexOf("/");
      parentPath = i <= 0 ? "/" : p.slice(0, i);
      parentType = "path";
      parentSub = "";
      currentName = p.slice(i + 1);
    } else {
      const p = state.subfolder.replace(/\/+$/, "");
      if (!p) return;
      const i = p.lastIndexOf("/");
      parentSub = i <= 0 ? "" : p.slice(0, i);
      parentType = state.type;
      parentPath = "";
      currentName = p.slice(i + 1);
    }
    try {
      const data = await fetchListing({
        type: parentType,
        subfolder: parentSub,
        path: parentPath
      });
      const dirs = (data.dirs || []).map((d) => d.name).sort();
      const idx = dirs.indexOf(currentName);
      if (idx < 0) return;
      const next = idx + dir;
      if (next < 0 || next >= dirs.length) return;
      const target = dirs[next];
      if (!target) return;
      if (state.type === "path") {
        state.absPath = parentPath === "/" ? `/${target}` : `${parentPath}/${target}`;
      } else {
        state.subfolder = parentSub ? `${parentSub}/${target}` : target;
      }
      focusIndex = 0;
      await loadAndRender();
    } catch (e) {
      reportError("Sibling navigation failed", e);
    }
  }
  function showHelp() {
    const ov = openShellOverlay(modal);
    ov.card.classList.add("ib-help-card");
    ov.card.innerHTML = `
      <div class="cmp-ov-title">Keyboard shortcuts</div>
      <div class="ib-help-body">
        <div class="ib-help-col">
          <div class="ib-help-h">Navigate</div>
          <dl>
            <dt>j / k</dt><dd>down / up row</dd>
            <dt>h / l</dt><dd>left / right</dd>
            <dt>g g</dt><dd>first file</dd>
            <dt>G</dt><dd>last file</dd>
            <dt>K</dt><dd>parent dir</dd>
            <dt>H / L</dt><dd>prev / next sibling</dd>
          </dl>
        </div>
        <div class="ib-help-col">
          <div class="ib-help-h">Select</div>
          <dl>
            <dt>Space</dt><dd>toggle focused</dd>
            <dt>v</dt><dd>visual mode</dd>
            <dt>Ctrl+A</dt><dd>select all visible</dd>
            <dt>Esc</dt><dd>clear selection</dd>
            <dt>long-press</dt><dd>select mode (touch)</dd>
            <dt>drag \u2713</dt><dd>range select (touch)</dd>
          </dl>
        </div>
        <div class="ib-help-col">
          <div class="ib-help-h">Act</div>
          <dl>
            <dt>d d</dt><dd>delete selected</dd>
            <dt>d y</dt><dd>confirm delete</dd>
            <dt>y y</dt><dd>yank (cut) selected</dd>
            <dt>p</dt><dd>paste (move) here</dd>
            <dt>r</dt><dd>rename focused</dd>
            <dt>m</dt><dd>move selected\u2026</dd>
          </dl>
        </div>
        <div class="ib-help-col">
          <div class="ib-help-h">Other</div>
          <dl>
            <dt>Enter / o</dt><dd>open in lightbox (\u2190/\u2192 step, Del delete, Esc close)</dd>
            <dt>i</dt><dd>metadata</dd>
            <dt>w</dt><dd>load workflow</dd>
            <dt>b</dt><dd>safe view on/off</dd>
            <dt>/</dt><dd>focus search</dd>
            <dt>?</dt><dd>this help</dd>
            <dt>Esc</dt><dd>close (priority)</dd>
          </dl>
        </div>
      </div>
      <div class="cmp-ov-actions">
        <button type="button" class="cmp-ov-btn cmp-ov-primary" data-help-close>Close</button>
      </div>`;
    const closeBtn = ov.card.querySelector("[data-help-close]");
    closeBtn?.addEventListener("click", () => ov.close());
  }
  function onWindowKey(e) {
    if (modal.dialog.querySelector(".cmp-ov-backdrop")) return;
    const inInput = isInInput();
    if (e.key === "Escape") {
      if (inInput) {
        document.activeElement?.blur();
      } else if (pendingOp) {
        clearPending();
      } else if (visualMode) {
        visualMode = false;
        modal.dialog.classList.remove("is-visual");
      } else if (selectMode || selected.size > 0) {
        setSelectMode(false);
        clearSelection();
      } else {
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    if (inInput) return;
    if (e.ctrlKey && !e.metaKey && !e.altKey && (e.key === "a" || e.key === "A")) {
      e.preventDefault();
      e.stopPropagation();
      selectAllVisible();
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (pendingOp) {
      const op = pendingOp;
      clearPending();
      if (op === "d" && (e.key === "d" || e.key === "y" || e.key === "Enter")) {
        e.preventDefault();
        e.stopPropagation();
        void doDelete();
        return;
      }
      if (op === "d" && (e.key === "n" || e.key === "Escape")) {
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      if (op === "y" && e.key === "y") {
        e.preventDefault();
        e.stopPropagation();
        doYank();
        return;
      }
      if (op === "g" && e.key === "g") {
        e.preventDefault();
        e.stopPropagation();
        focusFirst();
        return;
      }
    }
    const f = renderedFiles[focusIndex];
    switch (e.key) {
      case "j":
        e.preventDefault();
        e.stopPropagation();
        moveFocus(gridColumns());
        break;
      case "k":
        e.preventDefault();
        e.stopPropagation();
        moveFocus(-gridColumns());
        break;
      case "h":
        e.preventDefault();
        e.stopPropagation();
        moveFocus(-1);
        break;
      case "l":
        e.preventDefault();
        e.stopPropagation();
        moveFocus(1);
        break;
      case "G":
        e.preventDefault();
        e.stopPropagation();
        focusLast();
        break;
      case "K":
        e.preventDefault();
        e.stopPropagation();
        navigateUp();
        break;
      case "H":
        e.preventDefault();
        e.stopPropagation();
        void siblingNav(-1);
        break;
      case "L":
        e.preventDefault();
        e.stopPropagation();
        void siblingNav(1);
        break;
      case "g":
        e.preventDefault();
        e.stopPropagation();
        setPending("g");
        break;
      case "d":
        e.preventDefault();
        e.stopPropagation();
        setPending("d");
        break;
      case "y":
        e.preventDefault();
        e.stopPropagation();
        setPending("y");
        break;
      case "p":
        e.preventDefault();
        e.stopPropagation();
        void doPaste();
        break;
      case " ":
        e.preventDefault();
        e.stopPropagation();
        toggleSelectionAt(focusIndex);
        break;
      case "v":
        e.preventDefault();
        e.stopPropagation();
        toggleVisualMode();
        break;
      case "Enter":
      case "o":
        e.preventDefault();
        e.stopPropagation();
        if (f) openViewer(f);
        break;
      case "w":
        e.preventDefault();
        e.stopPropagation();
        if (f && META_EXTS.has((f.ext || "").toLowerCase())) void loadWorkflow(f);
        break;
      case "i":
        e.preventDefault();
        e.stopPropagation();
        if (f && META_EXTS.has((f.ext || "").toLowerCase())) void openMetadata(f);
        break;
      case "b":
        e.preventDefault();
        e.stopPropagation();
        toggleSafeView();
        break;
      case "r":
        if (f && canWriteFile(f)) {
          e.preventDefault();
          e.stopPropagation();
          void onRename(f);
        }
        break;
      case "m":
        if (selected.size > 0 || f && canWriteFile(f)) {
          e.preventDefault();
          e.stopPropagation();
          void doMoveSelected();
        }
        break;
      case "/":
        e.preventDefault();
        e.stopPropagation();
        modal.searchEl.focus();
        break;
      case "?":
        e.preventDefault();
        e.stopPropagation();
        showHelp();
        break;
      default:
        break;
    }
  }
  window.addEventListener("keydown", onWindowKey, true);
  async function initPins() {
    try {
      await migrateLocalPins();
      setPinCache((await fetchPins()).pins);
      renderPins();
      refreshPinButtons();
    } catch (e) {
      console.warn(`[${EXT_NAME}] pin list unavailable`, e);
    }
  }
  void initPins();
  loadAndRender();
  if (savedView.recovered) {
    notify2({
      severity: "warn",
      summary: "Reopened in folder view",
      detail: "The last flat-view load didn't finish, so the browser fell back to folder view."
    });
  }
  const pager = document.createElement("div");
  pager.className = "ah-pages";
  if (options.listing) modal.toolbarEl.append(pager);
  function renderPager() {
    if (!options.listing) return;
    pager.hidden = !lastListing?.token || state.type === "pinned" || state.type === "path";
    if (pager.hidden) return;
    const total = lastListing.total, count = Math.ceil(total / 200), current = Math.floor(pageOffset / 200) + 1;
    pager.innerHTML = `<button data-prev ${pageOffset === 0 ? "disabled" : ""}>\u524D\u3078</button><span>${total.toLocaleString()}\u4EF6 \xB7 ${total ? current : 0}/${count}\u30DA\u30FC\u30B8</span><button data-next ${pageOffset + 200 >= total ? "disabled" : ""}>\u6B21\u3078</button><span class="ah-note">${lastListing.skipped ? " \xB7 \u8AAD\u53D6\u4E0D\u53EF " + lastListing.skipped + "\u4EF6" : ""}</span>`;
    pager.querySelector("[data-prev]").addEventListener("click", () => {
      pageOffset = Math.max(0, pageOffset - 200);
      void loadAndRender();
    });
    pager.querySelector("[data-next]").addEventListener("click", () => {
      pageOffset += 200;
      void loadAndRender();
    });
  }
  function updateAssets(records) {
    for (const f of state.files) {
      const r = records.find((r2) => r2.item.type === fileType(f) && r2.item.subfolder === fileSub(f) && [r2.item.name, r2.target_name].includes(f.name));
      if (!r) continue;
      const oldKey = selectionKey(fileType(f), fileSub(f), f.name), wasSelected = selected.get(oldKey);
      if (r.state === "compacted") {
        f.name = r.target_name;
        f.ext = ".webp";
        f.size = r.webp_bytes;
      } else if (r.state === "restored") {
        f.name = r.item.name;
        f.ext = ".png";
        f.size = r.original_bytes;
      }
      f.asset = r;
      if (wasSelected) {
        selected.delete(oldKey);
        selected.set(selectionKey(fileType(f), fileSub(f), f.name), wasSelected);
      }
    }
    for (const card of fileCards()) {
      const f = renderedFiles[Number(card.dataset.idx)];
      if (!f) continue;
      card.dataset.name = f.name;
      card.dataset.ext = f.ext || "";
      const name = card.querySelector(".ib-name");
      if (name) {
        name.textContent = f.name;
        name.setAttribute("title", f.name);
      }
      options.decorateCard?.(card, { ...f, type: fileType(f), subfolder: fileSub(f) });
    }
  }
  options.mount?.({ modal, selection: collectSelectedOrFocused, refresh: async () => {
    clearSelection();
    await loadAndRender({ rescan: true });
  }, selectAll: selectAllVisible, clearSelection, navigate: switchType, query: () => lastQuery, pageItems: () => state.files.map((f) => ({ type: fileType(f), subfolder: fileSub(f), name: f.name })), updateAssets });
  return modal;
}
function pickDestination(modal, start, exclude) {
  return new Promise((resolve) => {
    const ov = openShellOverlay(modal, { onDismiss: () => resolve(null) });
    ov.card.classList.add("ib-move-card");
    const excludeParent = exclude ? exclude.subfolder.includes("/") ? exclude.subfolder.slice(0, exclude.subfolder.lastIndexOf("/")) : "" : "";
    const inExcluded = (type, sub) => exclude !== void 0 && type === exclude.type && (sub === exclude.subfolder || sub.startsWith(`${exclude.subfolder}/`));
    const remembered = loadSavedDest();
    const cur = remembered ?? {
      type: SANDBOXED_TYPES2.includes(start.type) ? start.type : "output",
      subfolder: start.subfolder
    };
    const title = document.createElement("div");
    title.className = "cmp-ov-title";
    title.textContent = "Move to\u2026";
    const tabs = document.createElement("div");
    tabs.className = "ib-tabs";
    for (const t of SANDBOXED_TYPES2) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "ib-tab";
      b.dataset.type = t;
      b.textContent = t;
      tabs.appendChild(b);
    }
    const crumbs = document.createElement("div");
    crumbs.className = "ib-crumbs";
    const list = document.createElement("div");
    list.className = "ib-move-list";
    const status = document.createElement("div");
    status.className = "cmp-ov-msg";
    const row = document.createElement("div");
    row.className = "cmp-ov-actions";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "cmp-ov-btn";
    cancel.textContent = "Cancel";
    cancel.addEventListener("click", () => {
      ov.close();
      resolve(null);
    });
    const moveHere = document.createElement("button");
    moveHere.type = "button";
    moveHere.className = "cmp-ov-btn cmp-ov-primary";
    moveHere.addEventListener("click", () => {
      ov.close();
      resolve({ type: cur.type, subfolder: cur.subfolder });
    });
    row.append(cancel, moveHere);
    ov.card.append(title, tabs, crumbs, list, status, row);
    function renderCrumbs() {
      crumbs.innerHTML = "";
      const mk = (text, sub) => {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "ib-crumb";
        b.dataset.sub = sub;
        b.textContent = text;
        return b;
      };
      crumbs.appendChild(mk(cur.type, ""));
      let acc = "";
      for (const p of cur.subfolder.split("/").filter(Boolean)) {
        acc = acc ? `${acc}/${p}` : p;
        crumbs.appendChild(mk(p, acc));
      }
    }
    async function load() {
      for (const b of tabs.querySelectorAll(".ib-tab"))
        b.classList.toggle("is-active", b.dataset.type === cur.type);
      renderCrumbs();
      moveHere.textContent = `Move to ${cur.type}${cur.subfolder ? `/${cur.subfolder}` : ""}`;
      const noop = exclude !== void 0 && cur.type === exclude.type && cur.subfolder === excludeParent;
      moveHere.disabled = noop || inExcluded(cur.type, cur.subfolder);
      list.innerHTML = "";
      status.textContent = "Loading\u2026";
      try {
        const data = await fetchListing({ type: cur.type, subfolder: cur.subfolder });
        if (!data.exists && cur.subfolder) {
          cur.subfolder = "";
          return load();
        }
        status.textContent = "";
        for (const p of folderPins()) {
          if (p.type === cur.type && p.subfolder === cur.subfolder) continue;
          if (inExcluded(p.type, p.subfolder)) continue;
          const r = document.createElement("button");
          r.type = "button";
          r.className = "ib-move-row is-pin";
          r.dataset.pinType = p.type;
          r.dataset.pinSub = p.subfolder;
          r.textContent = `\u{1F4CC} ${pinLabel(p)}`;
          list.appendChild(r);
        }
        if (cur.subfolder) {
          const up = document.createElement("button");
          up.type = "button";
          up.className = "ib-move-row is-up";
          up.textContent = "\u2191 ..";
          list.appendChild(up);
        }
        if (!data.dirs.length && !cur.subfolder) {
          const none = document.createElement("div");
          none.className = "cmp-ov-msg";
          none.textContent = "No subfolders \u2014 move into the root above.";
          list.appendChild(none);
        }
        for (const d of data.dirs) {
          const childSub = cur.subfolder ? `${cur.subfolder}/${d.name}` : d.name;
          if (inExcluded(cur.type, childSub)) continue;
          const r = document.createElement("button");
          r.type = "button";
          r.className = "ib-move-row";
          r.dataset.name = d.name;
          r.textContent = `\u{1F4C1} ${d.name}`;
          list.appendChild(r);
        }
      } catch (e) {
        status.textContent = `Error: ${e.message}`;
      }
    }
    tabs.addEventListener("click", (e) => {
      const b = e.target.closest("[data-type]");
      if (!b) return;
      cur.type = b.dataset.type;
      cur.subfolder = "";
      load();
    });
    crumbs.addEventListener("click", (e) => {
      const c = e.target.closest("[data-sub]");
      if (!c) return;
      cur.subfolder = c.dataset.sub || "";
      load();
    });
    list.addEventListener("click", (e) => {
      const pin = e.target.closest(".is-pin");
      if (pin) {
        const t = pin.dataset.pinType;
        if (!SANDBOXED_TYPES2.includes(t)) return;
        cur.type = t;
        cur.subfolder = pin.dataset.pinSub || "";
        load();
        return;
      }
      const up = e.target.closest(".is-up");
      if (up) {
        const p = cur.subfolder.replace(/\/+$/, "");
        const i = p.lastIndexOf("/");
        cur.subfolder = i <= 0 ? "" : p.slice(0, i);
        load();
        return;
      }
      const r = e.target.closest("[data-name]");
      if (!r) return;
      const base = cur.subfolder.replace(/\/+$/, "");
      cur.subfolder = base ? `${base}/${r.dataset.name}` : r.dataset.name;
      load();
    });
    load();
  });
}
var BROWSER_CSS = `
.ib-dialog {
    width: 100vw !important; height: 100vh !important; max-height: 100vh !important;
    /* Full-bleed: pin to the top-left instead of the shell's 50%/-50% centering.
       On Android, 100vh is the LARGE viewport (URL bar hidden) \u2014 while the URL
       bar is visible the dialog is taller than the visible area and centering
       shoves the header off the top of the screen. */
    top: 0 !important; left: 0 !important; transform: none !important;
    border-radius: 0;
    /* Keep the header/footer clear of notches + gesture bars in fullscreen. */
    padding-top: env(safe-area-inset-top);
    padding-bottom: env(safe-area-inset-bottom);
}
@supports (height: 100dvh) {
    /* Track the dynamic viewport (URL bar show/hide) where supported. */
    .ib-dialog { height: 100dvh !important; max-height: 100dvh !important; }
}
.image-browser-body { display: block; }
/* The pill look is shared by the root tabs and the media-type filter. Shared as
   a comma selector rather than by giving the filter segments the .ib-tab class:
   several tests count .ib-tab dialog-wide and select .ib-tab[data-type=\u2026], so
   reusing the class would make "four tabs" quietly stop meaning four tabs. */
.ib-tabs, .ib-filter-group {
    display: flex; flex-wrap: wrap; gap: 2px; align-items: center;
    background: #1a1a22; border: 1px solid #2a2a32; border-radius: 4px; padding: 2px;
}
.ib-tab, .ib-filter-seg {
    background: transparent; color: #8a8a92; border: 0; border-radius: 3px;
    padding: 6px 12px; font-size: 12px; cursor: pointer; font-family: inherit;
    text-transform: capitalize; min-height: 32px;
}
.ib-tab:hover, .ib-filter-seg:hover { background: #2a2a36; color: #e0e0e4; }
.ib-tab.is-active, .ib-filter-seg.is-active { background: #2f3a52; color: #9ec6ff; }
/* The filter's own full-width toolbar row. The row and the pill must be two
   elements: flex-basis:100% is what breaks the line, and putting it on the pill
   would stretch its border across the whole toolbar instead of hugging the
   three segments. order:10 places it below the crumbs row (order:9 on phones)
   and above the pins row (order:11). */
/* The type filter and the density pill share this row; space-between puts one
   at each end. */
.ib-filter { order: 10; flex-basis: 100%; display: flex; justify-content: space-between; gap: 8px; }
.ib-density-group {
    display: flex; gap: 2px; align-items: center;
    background: #1a1a22; border: 1px solid #2a2a32; border-radius: 4px; padding: 2px;
}
/* 44px in both axes \u2014 the family floor, same as .ib-act and .ib-check. A
   toolbar control is exactly as mis-tappable as a card control. */
.ib-density-seg {
    background: transparent; color: #8a8a92; border: 0; border-radius: 3px;
    min-width: 44px; min-height: 44px; padding: 0;
    font-size: 15px; line-height: 1; cursor: pointer; font-family: inherit;
}
.ib-density-seg:hover { background: #2a2a36; color: #e0e0e4; }
.ib-density-seg.is-active { background: #2f3a52; color: #9ec6ff; }
.ib-crumbs { display: flex; flex-wrap: wrap; gap: 4px; align-items: center; flex: 1; min-width: 0; }
@media (max-width: 700px) {
    /* Narrow screens: crumbs get their own full-width toolbar row. Squeezed to
       the flex leftovers, the crumb buttons overflow their container and paint
       underneath the sort dropdown. */
    .ib-crumbs { order: 9; flex-basis: 100%; }
}
.ib-crumb {
    background: #2a2a36; color: #b8b8c0; border: 1px solid #3a3a44; border-radius: 4px;
    padding: 6px 10px; font-size: 12px; cursor: pointer; font-family: inherit; min-height: 32px;
}
.ib-crumb:hover { background: #3a3a4a; color: #fff; }
.ib-control {
    background: #2a2a36; color: #d8d8dc; border: 1px solid #3a3a44; border-radius: 4px;
    padding: 6px 8px; font-size: 12px; cursor: pointer; font-family: inherit; min-height: 32px;
}
.ib-control:hover { background: #3a3a4a; color: #fff; }
.ib-icon { min-width: 34px; text-align: center; }
/* The upload picker: present for click(), invisible and untouchable. */
.ib-upload-input {
  position: absolute; width: 1px; height: 1px; opacity: 0;
  pointer-events: none; overflow: hidden;
}
.ib-upload-where { opacity: 0.75; word-break: break-all; }
.ib-grid {
    display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
    gap: 10px; padding: 4px;
}
/* ---- Density steps -------------------------------------------------------
   The rule above is the DEFAULT step and is deliberately left untouched:
   card-actions.test.js reads its grid-template-columns back verbatim and
   asserts the INLINE_ACTION_SLOTS arithmetic against a hardcoded 150px card.
   Everything below is additive and scoped to an attribute. */

/* DENSE \u2014 thumb and checkbox only. The action row is not shrunk, it is REMOVED:
   floor((84 - 12 + 2) / (44 + 2)) = 1, i.e. a card whose only control would be
   the \u22EF that costs a slot itself. Per-item actions at this step go through the
   checkbox into the batch bar, or through the lightbox. Hiding the row is also
   what keeps INLINE_ACTION_SLOTS a constant \u2014 a test asserts these are display:
   none so a future edit that un-hides them at 84px trips rather than shipping
   sub-44px destructive buttons (#90 again). */
.ib-grid[data-density="dense"] {
    grid-template-columns: repeat(auto-fill, minmax(84px, 1fr));
    gap: 6px;
    /* Cards take their natural height. Without this a file card sharing a row
       with a (two-column, still-named) folder card is stretched to the folder's
       height \u2014 measured at 209px against the 87px the thumb actually needs, so
       the first row rendered as mostly empty boxes. */
    align-items: start;
}
.ib-grid[data-density="dense"] .ib-actions,
.ib-grid[data-density="dense"] .ib-stars,
.ib-grid[data-density="dense"] .ib-meta,
.ib-grid[data-density="dense"] .ib-card.is-file .ib-name { display: none; }
/* A FOLDER keeps its name and spans two columns. Directories are half of the
   truncation complaint this density scale sits next to, and a nameless folder
   is not a smaller folder card, it is an unusable one. */
.ib-grid[data-density="dense"] .ib-card.is-dir { grid-column: span 2; }
/* ...and the icon block shrinks WITH the step. Keeping the name never required
   keeping the icon block: at span 2 the folder sits on a 84x2+6 = ~180px track,
   so the square reserved a ~180px-tall box for a 32px glyph and the folder card
   came out at 209px against the file tile's 87px \u2014 2.4x, at the step whose
   whole job is fitting more on screen (#106). 44px is the family's tap-target
   floor and comfortably holds the glyph. */
.ib-grid[data-density="dense"] .ib-card.is-up .ib-thumb,
.ib-grid[data-density="dense"] .ib-card.is-dir .ib-thumb { height: 44px; }
/* Vertical scroll must survive a finger that starts on a checkbox. .ib-check is
   touch-action:none so a drag sweeps a range, and at 44px on an ~84px tile that
   is half the card width \u2014 scoped to this step, so the default is untouched.
   pan-y gives the browser the vertical axis back; a horizontal-first drag still
   sweeps, which is the natural direction across a grid row. */
.ib-grid[data-density="dense"] .ib-check { touch-action: pan-y; }

/* LIST \u2014 one ITEM per row, not one image. A single-column grid of the DEFAULT
   card would be a ~390px-tall square showing one file, which openFull already
   does better; the point of the step is the details beside the thumb. Pure CSS
   over the existing markup, so there is no second card template to keep in
   sync.

   Scoped to .ib-card, NOT .ib-card.is-file: a folder is an ITEM, so "one item
   per row" has to mean folders too. Scoping the row layout to files is what
   left a folder card as a full-width square at this step \u2014 395px inside a
   412px band, i.e. one folder filling the whole visible grid (#106). The dir
   card's markup is a strict subset of the file card's (thumb + name, no
   meta/stars/actions), so the shared template needs no dir-specific block; the
   unused areas collapse to zero-height rows. */
.ib-grid[data-density="list"] { grid-template-columns: 1fr; }
.ib-grid[data-density="list"] .ib-card {
    display: grid;
    grid-template-columns: 64px minmax(0, 1fr);
    grid-template-areas:
        "sub   sub"
        "thumb name"
        "thumb meta"
        "thumb stars"
        "thumb acts";
    align-items: start;
    column-gap: 8px;
}
.ib-grid[data-density="list"] .ib-card .ib-subpath { grid-area: sub; }
.ib-grid[data-density="list"] .ib-card .ib-thumb { grid-area: thumb; }
.ib-grid[data-density="list"] .ib-card .ib-name { grid-area: name; }
.ib-grid[data-density="list"] .ib-card .ib-meta { grid-area: meta; }
.ib-grid[data-density="list"] .ib-card .ib-stars { grid-area: stars; }
.ib-grid[data-density="list"] .ib-card .ib-actions { grid-area: acts; }
/* Two children are appended AFTER the template and would otherwise auto-place
   into a new implicit row: the reveal button applySafeView adds, and the
   selection checkbox. Both are absolutely positioned over the thumb, which
   works because .ib-card is already position:relative \u2014 the explicit grid-area
   is what stops the grid reserving a row for them. */
.ib-grid[data-density="list"] .ib-card .cmk-sv-reveal,
.ib-grid[data-density="list"] .ib-card .ib-check { grid-area: thumb; }
/* The row is far wider than 150px, so the name has room to wrap rather than
   elide \u2014 the one place the two-span split is not needed. */
.ib-grid[data-density="list"] .ib-name { display: block; white-space: normal; }
.ib-grid[data-density="list"] .ib-name-head { white-space: normal; overflow: visible; }
/* The file thumb is 64px tall because the 64px column plus aspect-ratio 1/1
   says so. A folder's is not square (see below), so its cap is stated. */
.ib-grid[data-density="list"] .ib-card.is-up .ib-thumb,
.ib-grid[data-density="list"] .ib-card.is-dir .ib-thumb { height: 64px; }
.ib-card {
    background: #21212a; border: 1px solid #2a2a32; border-radius: 6px; overflow: hidden;
    cursor: pointer; display: flex; flex-direction: column;
    transition: transform 0.06s ease, border-color 0.1s ease;
    /* Anchor for the corner overlays (selection check / folder delete); the
       text-selection + touch-callout suppression keeps long-press clean. */
    position: relative;
    user-select: none; -webkit-user-select: none; -webkit-touch-callout: none;
}
.ib-card:hover { border-color: #6ba6ff; transform: translateY(-1px); }
.ib-card.is-up, .ib-card.is-dir { background: #1f1f26; }
/* A FOLDER CARD DOES NOT TAKE ITS ROW'S HEIGHT. The grid stretches items by
   default, so a folder sharing a row with a file card was pulled to the file's
   height \u2014 measured 313px for the ".." card inside a subfolder, against the
   ~207px it needs. Scoped to the card rather than added to .ib-grid, because
   the base .ib-grid rule is read back verbatim by card-actions.test.js. */
.ib-card.is-up, .ib-card.is-dir { align-self: start; }
.ib-thumb {
    aspect-ratio: 1 / 1; display: flex; align-items: center; justify-content: center;
    background: #12121a; overflow: hidden;
}
/* ...but NOT on a folder or the ".." card. The square is what a photo wants; a
   folder's icon block holds a 32px glyph, so on the default 178px track it
   reserved a 178px-tall box that was ~91% empty \u2014 and, because the box tracks
   the TRACK, every compaction step made a folder card bigger rather than
   smaller (#106). Bounded height per step instead: 88 / 44 / 64 for
   grid / dense / list, each stated in its own block. */
.ib-card.is-up .ib-thumb,
.ib-card.is-dir .ib-thumb { aspect-ratio: auto; height: 88px; }
.ib-thumb-icon { font-size: 32px; color: #777; }
.ib-thumb img, .ib-thumb video {
    width: 100%; height: 100%; object-fit: cover; display: block; background: #000;
}
/* Two spans, so the browser elides the HEAD at whatever the real track width is
   and the TAIL \u2014 the part that identifies the file \u2014 never elides. At a wide
   track the head does not overflow and the whole name renders unmarked. See
   src/label.ts for why this is not a computed character budget. */
.ib-name {
    padding: 6px 8px; font-size: 11.5px; color: #d8d8dc;
    display: flex; min-width: 0; overflow: hidden;
    font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
}
.ib-name-head {
    flex: 0 1 auto; min-width: 0;
    white-space: nowrap; text-overflow: ellipsis; overflow: hidden;
}
.ib-name-tail { flex: 0 0 auto; white-space: nowrap; }
/* NEITHER SPAN MAY SET ITS OWN color. Safe View's spoiler paints
   color:transparent on the CONTAINER and the spans inherit it; a colour here
   would leak a hidden name into the clear inside its own block. An explicit
   .cmk-sv-spoiler span rule was tried and
   removed \u2014 the mutation table showed it changed nothing, because inheritance
   already does the work. tests/mutations-label.json mutates a colour ONTO
   .ib-name-head instead, which is the failure that can actually happen. */
.ib-meta { padding: 0 8px 4px; font-size: 10.5px; color: #888; }
/* Flat-view folder label above the thumbnail \u2014 a tap jumps to that folder. */
.ib-subpath {
    display: flex; width: 100%; text-align: left; box-sizing: border-box;
    padding: 5px 8px; font-size: 10px; line-height: 1.3; min-height: 26px;
    color: #8a9bb5; background: transparent; border: 0;
    border-bottom: 1px solid #2a2a32;
    white-space: nowrap; text-overflow: ellipsis; overflow: hidden;
    font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; cursor: pointer;
}
.ib-subpath:hover { color: #9ec6ff; background: #23232e; }
.ib-subpath.is-root { color: #555; cursor: default; }
.ib-subpath.is-root:hover { background: transparent; color: #555; }
.ib-stars { display: flex; justify-content: center; gap: 1px; padding: 0 6px 4px; }
.ib-star {
    appearance: none; background: transparent; border: 0; padding: 5px 4px;
    font-size: 15px; line-height: 1; color: #555; cursor: pointer;
    min-width: 26px; min-height: 26px;
}
.ib-star.is-on, .ib-star:hover { color: #ffd866; }
@media (max-width: 600px) {
    .ib-star { font-size: 18px; padding: 7px 5px; min-width: 30px; min-height: 32px; }
}
.ib-stars.is-ro { color: #ffd866; font-size: 12px; cursor: default; }
/* The card action row. The gap and the horizontal padding here are two of the
   four constants INLINE_ACTION_SLOTS is computed from \u2014 change one and the
   budget is wrong, so tests/js/card-actions.test.js reads them back out of
   this stylesheet rather than trusting the TS literals. */
.ib-actions { display: flex; gap: 2px; padding: 0 6px 6px; margin-top: auto; }
/* min-width AND min-height at the family's >=44px D02 floor (the kit hardcodes
   the same number in modal-shell.ts and hub.ts). flex:1 still lets a button
   GROW on a wide card; what it may no longer do is shrink below the floor \u2014
   which is what put eight ~15px buttons, delete among them, on a 150px card.
   The count is bounded by actionRowHTML so the floor cannot overflow the row. */
.ib-act {
    flex: 1; background: #2a2a36; color: #b8b8c0; border: 1px solid #33333f; border-radius: 4px;
    padding: 6px 0; font-size: 13px; line-height: 1; cursor: pointer; font-family: inherit;
    min-width: 44px; min-height: 44px;
}
.ib-act:hover { background: #3a3a4a; color: #fff; }
.ib-act-danger:hover { background: #5c2a3c; color: #ff9eb0; }
/* Overflow. The stash holds the controls the budget pushed out; it is the
   sheet's source of truth, never rendered. display:none rather than only the
   hidden attribute, because .ib-act above sets a min-width that would
   otherwise still occupy the row in a browser that ignores hidden. */
.ib-more-stash { display: none; }
.ib-more-card { width: min(420px, calc(100% - 24px)); }
/* The sheet's title is the one TOUCH-reachable place the untouched filename
   appears (the card's title attribute needs a hover). The kit's .cmp-ov-title
   sets no wrapping, and a ComfyUI output name is one unbroken token except for
   its hyphens \u2014 so a name joined only by underscores would overflow the card
   rather than wrap, and the full-name surface would truncate too. */
.ib-more-card .cmp-ov-title { overflow-wrap: anywhere; }
.ib-more-list {
    display: flex; flex-direction: column; gap: 2px; max-height: 60vh; overflow-y: auto;
    border: 1px solid #2a2a32; border-radius: 6px; padding: 4px; background: #17171e;
}
/* Full-width rows, comfortably over the floor \u2014 the point of the sheet is that
   a destructive action is a deliberate second tap on a large target instead of
   a 15px neighbour of \u270E rename. */
.ib-more-row {
    display: flex; align-items: center; gap: 10px; text-align: left; width: 100%;
    background: transparent; color: #cfcfd6; border: 0; border-radius: 4px;
    padding: 10px 12px; font-size: 14px; cursor: pointer; font-family: inherit;
    min-width: 44px; min-height: 44px;
}
.ib-more-row:hover { background: #2a2a3a; color: #fff; }
.ib-more-glyph { display: inline-block; min-width: 20px; text-align: center; font-size: 15px; }
.ib-more-danger { color: #ff9eb0; }
.ib-more-danger:hover { background: #5c2a3c; color: #fff; }
.ib-empty { grid-column: 1 / -1; padding: 48px; text-align: center; color: #777; font-style: italic; }
.ib-count { color: #888; }
.ib-move-card { width: min(560px, calc(100% - 24px)); }
.ib-move-list {
    display: flex; flex-direction: column; gap: 2px; max-height: 40vh; overflow-y: auto;
    border: 1px solid #2a2a32; border-radius: 6px; padding: 4px; background: #17171e;
}
.ib-move-row {
    text-align: left; background: transparent; color: #cfcfd6; border: 0; border-radius: 4px;
    padding: 10px 12px; font-size: 13px; cursor: pointer; font-family: inherit; min-height: 40px;
}
.ib-move-row:hover { background: #2a2a3a; color: #fff; }
/* "Move here" is disabled on a folder's own parent/subtree (a no-op or illegal
   destination) \u2014 dim it so the reason for the dead button is legible. */
.ib-move-card .cmp-ov-primary:disabled { opacity: 0.4; cursor: not-allowed; }
.cmp-match { color: #ffd866; font-weight: 700; }
.ib-card.is-focused { outline: 2px solid #6ba6ff; outline-offset: -2px; z-index: 1; }
.ib-card.is-selected { border-color: #ffd866; background: #2a2a1f; }
.ib-card.is-selected.is-focused { outline-color: #ffd866; }
/* Selection checkbox \u2014 the touch affordance for multi-select. Hidden until
   hover on fine pointers; always visible on touch, in select mode, and on
   already-selected cards. touch-action:none makes a drag starting here a
   range-select instead of a scroll. */
/* 34px visible dot inside a 44px HIT BOX. The dot is drawn by ::before so the
   button itself can carry the family's 44px floor (the same one .ib-act is held
   to) without a filled 44px circle covering a quarter of the thumbnail. A miss
   here is not inert \u2014 it falls through to the card, which opens the file. */
.ib-check {
    position: absolute; top: 0; left: 0; z-index: 2;
    width: 44px; height: 44px; min-width: 44px; min-height: 44px;
    padding: 0; border: 0; background: none; border-radius: 50%;
    color: transparent; font-size: 16px; line-height: 1; cursor: pointer;
    display: none; align-items: center; justify-content: center;
    touch-action: none; -webkit-tap-highlight-color: transparent;
}
.ib-check::before {
    content: ""; position: absolute; z-index: -1;
    width: 34px; height: 34px; box-sizing: border-box; border-radius: 50%;
    border: 2px solid rgba(255, 255, 255, 0.7); background: rgba(0, 0, 0, 0.45);
}
.ib-card:hover .ib-check,
.ib-card.is-selected .ib-check,
.ib-dialog.is-selecting .ib-check { display: flex; }
@media (pointer: coarse) { .ib-check { display: flex; } }
.ib-check:hover::before { border-color: #ffd866; }
.ib-check:hover { color: rgba(255, 255, 255, 0.85); }
.ib-card.is-selected .ib-check::before { background: #ffd866; border-color: #ffd866; }
.ib-card.is-selected .ib-check { color: #1a1a22; }
.ib-select-toggle.is-active { background: #2f3a52; color: #9ec6ff; border-color: #4a5878; }
.ib-view-toggle.is-active { background: #2f3a52; color: #9ec6ff; border-color: #4a5878; }
/* Keep the selection checkbox over the thumbnail corner, below the subpath row.
   25px, not 30px: the 44px hit box centres its 34px dot at +5px, so the DOT
   still lands at 30px \u2014 one below .ib-subpath's 26px min-height plus its 4px
   gutter, which is what this constant is really anchored to. */
.ib-card.is-flat .ib-check { top: 25px; }
.ib-pin-toggle.is-active { background: #52452f; color: #ffd866; border-color: #78683a; }
/* Safe View's toolbar toggle. Deliberately NOT the blue "a mode is on" tint the
   flat/select toggles use \u2014 this one says "content is being withheld", and
   reading it at a glance is the whole point of having it in the toolbar rather
   than only in the settings dialog. */
.ib-safe-toggle.is-active { background: #2f3a2f; color: #8fd38f; border-color: #3f5a3f; }
/* The reveal \u{1F441} is a child of the CARD, not of the blurred thumbnail \u2014 the blur
   is a filter on .ib-thumb and would otherwise blur its own escape hatch. It
   shares the checkbox's corner, so it sits on the opposite side; both drop
   below the subpath row on flat/pinned cards for the same reason. */
.ib-card .cmk-sv-reveal { left: auto; right: 4px; }
.ib-card.is-flat .cmk-sv-reveal { top: 30px; }
/* A hidden card must not read as a hover target for its own name. */
.ib-card.is-safe-hidden .ib-name, .ib-card.is-safe-hidden .ib-subpath { cursor: default; }
/* Pinned-folder chips \u2014 a full-width toolbar row of one-tap destinations.
   order:11 keeps them last when the toolbar wraps on phones, below both the
   crumbs row (order:9) and the media-type filter row (order:10). */
.ib-pins {
    order: 11; flex-basis: 100%;
    display: flex; flex-wrap: wrap; gap: 4px; align-items: center;
}
/* The slow-load note: a full-width row under everything else (order:12), so it
   wraps as a sentence instead of being clipped beside the search input.
   [hidden] is restated because the display rule would otherwise beat the UA's. */
.ib-load-note {
    order: 12; flex-basis: 100%;
    font-size: 13px; line-height: 1.4; color: #c8b06a;
}
.ib-load-note[hidden] { display: none; }
.ib-pin-chip { display: inline-flex; align-items: stretch; }
.ib-pin-go {
    background: #23283a; color: #9ec6ff; border: 1px solid #3a4560; border-right: 0;
    border-radius: 4px 0 0 4px; padding: 6px 8px; font-size: 12px; cursor: pointer;
    font-family: inherit; min-height: 32px; max-width: 45vw;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.ib-pin-go:hover { background: #2f3a52; color: #fff; }
.ib-pin-chip.is-current .ib-pin-go { color: #ffd866; border-color: #78683a; }
.ib-pin-chip.is-current .ib-pin-x { border-color: #78683a; }
.ib-pin-x {
    background: #23283a; color: #667; border: 1px solid #3a4560;
    border-radius: 0 4px 4px 0; padding: 6px 8px; font-size: 11px; cursor: pointer;
    font-family: inherit; min-height: 32px; min-width: 28px;
}
.ib-pin-x:hover { background: #5c2a3c; color: #ff9eb0; }
.ib-move-row.is-pin { color: #9ec6ff; }
/* Per-card \u{1F4CC} \u2014 filled while the file is pinned, matching the toolbar toggle's
   active look so "pinned" reads the same in both places. */
.ib-act-pin.is-pinned { background: #52452f; color: #ffd866; border-color: #78683a; }
/* Per-card \u{1F648} \u2014 filled while the file carries the keyword, same "this state is
   on" language as \u{1F4CC} above, in the warning hue the Safe View toggle uses.
   It lives in .ib-actions, a SIBLING of .ib-thumb, so the blur applied to a
   matched thumbnail never reaches it \u2014 marking a file must not blur the control
   that unmarks it. A class rule with no min()/calc(), so getComputedStyle can
   read it in jsdom. */
.ib-act-mark.is-marked { background: #4a2530; color: #ff9eb0; border-color: #7a4a58; }
.ib-act-mark:disabled { cursor: progress; opacity: 0.5; }
/* A pin whose target is gone. Dimmed rather than hidden: "the file moved" and
   "you never pinned it" are different facts, so the card stays \u2014 with only its
   unpin affordance \u2014 until it is pruned. */
.ib-card.is-missing { opacity: 0.45; }
.ib-card.is-missing:hover { border-color: #78384a; transform: none; }
.ib-card.is-missing .ib-meta { color: #c07a8a; font-style: italic; }
.ib-prune { white-space: nowrap; }
.ib-scan-pill { white-space: nowrap; color: #c8b06a; border-color: #4a4230; }
/* Folder delete \u2014 corner overlay on dir cards (write-gated). */
.ib-dir-del {
    position: absolute; top: 4px; right: 4px; z-index: 2;
    width: 34px; height: 34px; padding: 0; border-radius: 6px;
    border: 1px solid rgba(255, 255, 255, 0.2); background: rgba(0, 0, 0, 0.45);
    color: #b8b8c0; font-size: 14px; line-height: 1; cursor: pointer;
}
.ib-dir-del:hover { background: #5c2a3c; color: #ff9eb0; }
/* Folder move \u2014 corner overlay on dir cards, mirroring the delete button on the
   opposite side (write-gated). */
.ib-dir-move {
    position: absolute; top: 4px; left: 4px; z-index: 2;
    width: 34px; height: 34px; padding: 0; border-radius: 6px;
    border: 1px solid rgba(255, 255, 255, 0.2); background: rgba(0, 0, 0, 0.45);
    color: #b8b8c0; font-size: 14px; line-height: 1; cursor: pointer;
}
.ib-dir-move:hover { background: #3a3a4a; color: #fff; }
/* Floating batch-action bar \u2014 appears while a selection exists. */
.ib-selbar {
    position: absolute; left: 50%; transform: translateX(-50%);
    bottom: calc(52px + env(safe-area-inset-bottom, 0px));
    z-index: 4; display: none; align-items: center; gap: 8px;
    max-width: calc(100% - 16px); white-space: nowrap;
    background: #1c1c24; border: 1px solid #3a3a44; border-radius: 24px;
    padding: 8px 12px; box-shadow: 0 8px 24px rgba(0, 0, 0, 0.5);
}
.ib-selbar.is-visible { display: flex; }
.ib-selbar-count { font-size: 12.5px; font-weight: 600; color: #9ec6ff; padding: 0 4px; }
.ib-selbar-btn {
    background: #2a2a36; color: #d8d8dc; border: 1px solid #3a3a44; border-radius: 16px;
    padding: 8px 14px; font-size: 13px; cursor: pointer; font-family: inherit; min-height: 38px;
}
.ib-selbar-btn:hover { background: #3a3a4a; color: #fff; }
.ib-selbar-danger { background: #4a2230; color: #ff9eb0; border-color: #78384a; }
.ib-selbar-danger:hover { background: #5c2a3c; color: #fff; }
.ib-dialog.is-visual .ib-grid { outline: 2px solid #ffd866; outline-offset: -2px; }
.ib-selected-badge {
    background: #2f3a52; color: #9ec6ff; border: 1px solid #4a5878; border-radius: 10px;
    padding: 2px 8px; font-size: 11px; margin-left: 8px; display: inline;
}
.ib-help-card { width: min(640px, calc(100% - 24px)); max-height: calc(100% - 24px); }
.ib-help-body {
    display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
    gap: 12px; overflow-y: auto; padding: 8px 0;
}
.ib-help-col { display: flex; flex-direction: column; gap: 4px; }
.ib-help-h { font-size: 12px; font-weight: 600; color: #9ec6ff; text-transform: uppercase; letter-spacing: 0.5px; }
.ib-help-body dl { margin: 0; display: flex; flex-direction: column; gap: 2px; }
.ib-help-body dt {
    font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
    font-size: 11.5px; color: #ffd866;
}
.ib-help-body dd { margin: 0 0 4px 0; font-size: 11.5px; color: #b8b8c0; }
/* Metadata overlay (the \u24D8 card). The ib-meta-* namespace is distinct from the
   card's own .ib-meta dimensions line \u2014 class selectors match whole tokens, so
   .ib-meta never catches .ib-meta-row and vice versa. */
.ib-meta-card { width: min(680px, calc(100% - 24px)); max-height: calc(100% - 24px); }
.ib-meta-body {
    display: flex; flex-direction: column; gap: 8px;
    overflow-y: auto; padding: 8px 0; -webkit-overflow-scrolling: touch;
}
.ib-meta-status { padding: 14px 2px; font-size: 12.5px; color: #888; font-style: italic; }
.ib-meta-src {
    display: flex; align-items: baseline; gap: 8px; font-size: 11.5px; color: #9ec6ff;
    text-transform: uppercase; letter-spacing: 0.5px;
}
.ib-meta-fmt { color: #777; text-transform: none; letter-spacing: 0; }
.ib-meta-row { display: grid; grid-template-columns: 84px 1fr auto; gap: 8px; align-items: start; }
.ib-meta-k {
    padding-top: 7px; font-size: 11px; color: #8a8a92;
    text-transform: uppercase; letter-spacing: 0.4px;
}
.ib-meta-v {
    /* A long positive prompt scrolls inside its own box instead of pushing the
       Copy buttons and the overlay actions off the card. Selectable: the card is
       a reading surface, unlike the grid (which suppresses selection for
       long-press). */
    max-height: 7.5em; overflow-y: auto;
    padding: 6px 8px; font-size: 12px; line-height: 1.45; color: #d8d8dc;
    background: #17171e; border: 1px solid #2a2a32; border-radius: 4px;
    font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
    white-space: pre-wrap; overflow-wrap: anywhere;
    user-select: text; -webkit-user-select: text;
}
.ib-meta-copy {
    background: #2a2a36; color: #b8b8c0; border: 1px solid #33333f; border-radius: 4px;
    padding: 0 10px; font-size: 12px; cursor: pointer; font-family: inherit; min-height: 32px;
}
.ib-meta-copy:hover { background: #3a3a4a; color: #fff; }
.ib-meta-copy.is-copied { background: #25402f; color: #8fe0a8; border-color: #37624a; }
.ib-meta-empty { padding: 16px 2px; font-size: 12.5px; color: #777; font-style: italic; }
.ib-meta-note { font-size: 11.5px; color: #c8a95c; }
.ib-meta-raw > summary {
    padding: 7px 0; font-size: 12px; color: #9ec6ff; cursor: pointer; min-height: 32px;
}
.ib-meta-raw pre {
    margin: 4px 0 8px; padding: 8px; max-height: 30vh; overflow: auto;
    background: #17171e; border: 1px solid #2a2a32; border-radius: 4px;
    font-size: 11px; color: #b8b8c0; white-space: pre-wrap; overflow-wrap: anywhere;
    user-select: text; -webkit-user-select: text;
}
@media (max-width: 600px) {
    /* Stack the label above the value \u2014 an 84px gutter leaves the prompt column
       unreadably narrow on a phone. */
    .ib-meta-row { grid-template-columns: 1fr auto; }
    .ib-meta-k { grid-column: 1 / -1; padding-top: 0; }
}
`;

// src/relations.ts
var NS = "http://www.w3.org/2000/svg";
var svgElement = (tag, attrs = {}) => {
  const el = document.createElementNS(NS, tag);
  for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, String(value));
  return el;
};
var thumb = (node) => imageThumbURL(node.item.type, node.item.subfolder, node.item.name, "", node.id);
async function openRelations(modal, body, api2) {
  ensureStyleOnce("asset-hub-relations-v1", `
 .ah-relations{width:min(1380px,96vw)!important;max-width:none!important;height:calc(100dvh - 32px);max-height:none!important;display:flex;flex-direction:column;padding:14px!important;gap:10px;color:#e7eeec}
 .ah-relation-head{display:flex;gap:10px;align-items:center;flex-wrap:wrap}.ah-relation-head h2{font-size:18px;margin:0}.ah-relation-head select,.ah-relation-head button,.ah-relation-detail button{background:#2d3a3e;border:1px solid #50635f;color:inherit;border-radius:6px;padding:7px 10px;cursor:pointer}.ah-relation-head [data-close]{margin-left:auto}
 .ah-relation-status{color:#a9bbb5;font-size:12px;min-height:18px}.ah-relation-body{display:grid;grid-template-columns:minmax(0,1fr) 270px;gap:12px;flex:1;min-height:0}.ah-relation-canvas{min-width:0;min-height:0;border:1px solid #38433f;border-radius:8px;background:#14191b;position:relative;overflow:hidden}.ah-relation-canvas svg{width:100%;height:100%;touch-action:none;user-select:none;display:block}.ah-relation-help{position:absolute;bottom:8px;left:10px;color:#8ea39c;font-size:11px;pointer-events:none}.ah-relation-legend{position:absolute;top:8px;left:10px;font-size:11px;pointer-events:none}.ah-relation-empty{position:absolute;inset:40% 10px auto;text-align:center;color:#9eafa9;pointer-events:none}
 .ah-relation-node{cursor:pointer}.ah-relation-node:focus rect{stroke:#fff;stroke-width:3}.ah-relation-detail{overflow:auto;min-width:0;font-size:13px}.ah-relation-detail h3{font-size:14px;overflow-wrap:anywhere;margin:8px 0}.ah-relation-pair{display:flex;gap:8px}.ah-relation-pair img{width:calc(50% - 4px);height:105px;object-fit:contain;background:#121719;border-radius:5px}.ah-relation-detail p{line-height:1.6;overflow-wrap:anywhere}.ah-relation-tags{display:flex;gap:5px;flex-wrap:wrap}.ah-relation-tags span{padding:3px 6px;background:#25453d;border-radius:4px;overflow-wrap:anywhere}.ah-relation-prompt{white-space:pre-wrap;max-height:180px;overflow:auto;color:#a9bbb5}.ah-relation-detail small{color:#9aaba5;line-height:1.5;display:block}.ah-relation-head [data-errors]{color:#e4c391}.ah-relations button:disabled{opacity:.45;cursor:default}
 @media(max-width:850px){.ah-relation-body{grid-template-columns:minmax(0,1fr) 210px}.ah-relation-head{gap:5px}.ah-relation-pair img{height:80px}}
 `);
  let closed = false, jobId = "", center = null, mode = "combined", offset = 0, timer, data = null, selected = null, requestVersion = 0, cancelling = false;
  let positions = /* @__PURE__ */ new Map(), view = { x: 0, y: 0, scale: 1 }, viewTouched = false, layoutCenter = null;
  const dispose = () => {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    resize.disconnect();
    if (jobId) void api2("relations/cancel", { id: jobId }).catch(() => {
    });
  };
  const overlay = openShellOverlay(modal, { onDismiss: dispose }), card = overlay.card;
  card.classList.add("ah-relations");
  card.innerHTML = '<div class="ah-relation-head"><h2>\u753B\u50CF\u306E\u95A2\u9023\u56F3</h2><select aria-label="\u95A2\u9023\u306E\u57FA\u6E96"><option value="combined">\u7DCF\u5408</option><option value="prompt">\u5171\u901A\u30D7\u30ED\u30F3\u30D7\u30C8</option><option value="visual">\u898B\u305F\u76EE\uFF08\u8272\u30FB\u914D\u7F6E\u30FB\u8F2A\u90ED\uFF09</option></select><button data-fit>\u5168\u4F53\u8868\u793A</button><button data-stop>\u89E3\u6790\u3092\u505C\u6B62</button><button data-errors hidden>\u89E3\u6790\u5931\u6557</button><button data-close>\u4E00\u89A7\u3078</button></div><div class="ah-relation-status" role="status">\u89E3\u6790\u3092\u958B\u59CB\u3057\u3066\u3044\u307E\u3059\u2026</div><div class="ah-relation-body"><div class="ah-relation-canvas"><svg aria-label="\u753B\u50CF\u540C\u58EB\u306E\u95A2\u9023\u56F3"></svg><div class="ah-relation-empty">\u753B\u50CF\u3092\u89E3\u6790\u3057\u3066\u3044\u307E\u3059\u2026</div><div class="ah-relation-help">\u753B\u50CF\u30FB\u7DDA\u3092\u30AF\u30EA\u30C3\u30AF\u3067\u5171\u901A\u70B9 \xB7 \u753B\u50CF\u3092\u30C9\u30E9\u30C3\u30B0\u3067\u914D\u7F6E \xB7 \u80CC\u666F\u30C9\u30E9\u30C3\u30B0\uFF0F\u30DB\u30A4\u30FC\u30EB\u3067\u79FB\u52D5\u30FB\u62E1\u5927</div></div><aside class="ah-relation-detail"><p>\u753B\u50CF\u307E\u305F\u306F\u7DDA\u3092\u9078\u3076\u3068\u3001\u5171\u901A\u30D7\u30ED\u30F3\u30D7\u30C8\u3084\u898B\u305F\u76EE\u306E\u8FD1\u3055\u3092\u8868\u793A\u3057\u307E\u3059\u3002</p><small>\u898B\u305F\u76EE\u306F\u8272\u8ABF\u30FB\u914D\u7F6E\u30FB\u8F2A\u90ED\u3067\u6BD4\u8F03\u3057\u307E\u3059\u3002\u88AB\u5199\u4F53\u306E\u610F\u5473\u3092\u5224\u5B9A\u3059\u308B\u6A5F\u80FD\u3067\u306F\u3042\u308A\u307E\u305B\u3093\u3002</small></aside></div>';
  const svg = card.querySelector("svg"), viewport = card.querySelector(".ah-relation-canvas"), detail = card.querySelector("aside"), status = card.querySelector(".ah-relation-status"), empty = card.querySelector(".ah-relation-empty");
  const group = svgElement("g"), edgeLayer = svgElement("g"), nodeLayer = svgElement("g");
  group.append(edgeLayer, nodeLayer);
  svg.append(group);
  const legend = document.createElement("div");
  legend.className = "ah-relation-legend";
  legend.innerHTML = '<span style="color:#65bfa4">\u2501 \u5171\u901A\u8A9E\u53E5</span>\u3000<span style="color:#d3ac6a">\u2501 \u898B\u305F\u76EE</span>\u3000<span style="color:#ad9ad1">\u2501 \u4E21\u65B9</span>';
  viewport.append(legend);
  const stopButton = card.querySelector("[data-stop]");
  const previous = document.createElement("button"), next = document.createElement("button");
  previous.textContent = "\u524D\u306E20\u679A";
  next.textContent = "\u6B21\u306E20\u679A";
  previous.hidden = next.hidden = true;
  stopButton.before(previous, next);
  previous.onclick = () => {
    offset = Math.max(0, offset - 20);
    selected = null;
    viewTouched = false;
    void query();
  };
  next.onclick = () => {
    offset += 20;
    selected = null;
    viewTouched = false;
    void query();
  };
  const resize = new ResizeObserver(() => {
    if (data && !viewTouched) fit();
  });
  resize.observe(viewport);
  card.querySelector("[data-close]").addEventListener("click", () => {
    dispose();
    overlay.close();
  });
  function transform() {
    group.setAttribute("transform", `translate(${view.x} ${view.y}) scale(${view.scale})`);
  }
  function fit() {
    if (!data?.nodes.length) return;
    const points = data.nodes.map((node) => positions.get(node.id));
    const minX = Math.min(...points.map((p) => p.x)) - 65, maxX = Math.max(...points.map((p) => p.x)) + 65, minY = Math.min(...points.map((p) => p.y)) - 52, maxY = Math.max(...points.map((p) => p.y)) + 52;
    const width = viewport.clientWidth, height = viewport.clientHeight;
    view.scale = Math.min(1.6, (width - 40) / (maxX - minX), (height - 55) / (maxY - minY));
    view.x = width / 2 - (minX + maxX) / 2 * view.scale;
    view.y = (height - 20) / 2 - (minY + maxY) / 2 * view.scale;
    transform();
  }
  card.querySelector("[data-fit]").addEventListener("click", () => {
    viewTouched = false;
    fit();
  });
  function arrange() {
    if (layoutCenter !== data.center) {
      positions = /* @__PURE__ */ new Map();
      layoutCenter = data.center;
      viewTouched = false;
    }
    let added = false;
    data.nodes.forEach((node, index) => {
      if (!positions.has(node.id)) {
        added = true;
        const angle = index * 2.39996, radius = 160 * Math.sqrt(index);
        positions.set(node.id, { x: index ? Math.cos(angle) * radius : 0, y: index ? Math.sin(angle) * radius : 0 });
      }
    });
    if (!added) return;
    const ids = data.nodes.map((node) => node.id);
    for (let iteration = 0; iteration < 130; iteration++) {
      const force = new Map(ids.map((id) => [id, { x: 0, y: 0 }]));
      for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
        const a = positions.get(ids[i]), b = positions.get(ids[j]), dx = a.x - b.x, dy = a.y - b.y, d = Math.max(1, Math.hypot(dx, dy)), push = 25e3 / (d * d);
        force.get(ids[i]).x += dx / d * push;
        force.get(ids[i]).y += dy / d * push;
        force.get(ids[j]).x -= dx / d * push;
        force.get(ids[j]).y -= dy / d * push;
      }
      for (const edge of data.edges) {
        const a = positions.get(edge.source), b = positions.get(edge.target), dx = b.x - a.x, dy = b.y - a.y, d = Math.max(1, Math.hypot(dx, dy)), pull = (d - (180 + (1 - edge.score) * 70)) * 0.018;
        force.get(edge.source).x += dx / d * pull;
        force.get(edge.source).y += dy / d * pull;
        force.get(edge.target).x -= dx / d * pull;
        force.get(edge.target).y -= dy / d * pull;
      }
      for (const id of ids) {
        if (id === data.center) continue;
        const p = positions.get(id), f = force.get(id);
        p.x += Math.max(-6, Math.min(6, f.x));
        p.y += Math.max(-6, Math.min(6, f.y));
      }
    }
    for (let pass = 0; pass < 100; pass++) {
      let overlaps = 0;
      for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
        const a = positions.get(ids[i]), b = positions.get(ids[j]), dx = a.x - b.x, dy = a.y - b.y, ox = 124 - Math.abs(dx), oy = 100 - Math.abs(dy);
        if (ox <= 0 || oy <= 0) continue;
        overlaps++;
        const axis = ox < oy ? "x" : "y", distance = (axis === "x" ? ox : oy) + 0.1, direction = (axis === "x" ? dx : dy) >= 0 ? 1 : -1;
        const aFixed = ids[i] === data.center, bFixed = ids[j] === data.center;
        if (!aFixed) a[axis] += direction * distance * (bFixed ? 1 : 0.5);
        if (!bFixed) b[axis] -= direction * distance * (aFixed ? 1 : 0.5);
      }
      if (!overlaps) break;
    }
  }
  function showDetails(node, edge) {
    selected = node.id;
    detail.replaceChildren();
    const pair = document.createElement("div");
    pair.className = "ah-relation-pair";
    const source = edge ? data.nodes.find((candidate) => candidate.id === edge.source) : data.nodes.find((candidate) => candidate.id === data.center);
    for (const picture of [source, node]) {
      if (!picture) continue;
      const image = document.createElement("img");
      image.src = thumb(picture);
      image.alt = picture.item.name;
      pair.append(image);
      if (source?.id === node.id) break;
    }
    detail.append(pair);
    const name = document.createElement("h3");
    name.textContent = node.item.name;
    detail.append(name);
    if (node.image_missing) {
      const missing = document.createElement("p");
      missing.textContent = "\u753B\u50CF\u304C\u79FB\u52D5\u30FB\u524A\u9664\u3055\u308C\u3066\u3044\u307E\u3059\u3002\u4E00\u89A7\u3092\u66F4\u65B0\u3057\u3066\u95A2\u9023\u56F3\u3092\u958B\u304D\u76F4\u3057\u3066\u304F\u3060\u3055\u3044\u3002";
      detail.append(missing);
    }
    if (edge) {
      const from = document.createElement("small");
      from.textContent = `\u6BD4\u8F03\u5143\uFF1A${source.item.name}`;
      detail.append(from);
      const heading = document.createElement("p");
      heading.textContent = "\u5171\u901A\u30D7\u30ED\u30F3\u30D7\u30C8";
      detail.append(heading);
      const tags = document.createElement("div");
      tags.className = "ah-relation-tags";
      if (!edge.common.length) tags.textContent = "\u5171\u901A\u8A9E\u53E5\u306A\u3057";
      for (const term of edge.common) {
        const tag = document.createElement("span");
        tag.textContent = term;
        tags.append(tag);
      }
      detail.append(tags);
      const appearance = document.createElement("p");
      appearance.textContent = `\u898B\u305F\u76EE\u306E\u8FD1\u3055\uFF1A${Math.round(edge.visual * 100)}/100
\u8272\u8ABF ${edge.features.color} \xB7 \u914D\u7F6E ${edge.features.layout} \xB7 \u8F2A\u90ED ${edge.features.shape}`;
      appearance.style.whiteSpace = "pre-line";
      detail.append(appearance);
      const note = document.createElement("small");
      note.textContent = "\u8272\u30FB\u914D\u7F6E\u30FB\u8F2A\u90ED\u306E\u6BD4\u8F03\u5024\u3067\u3059\u3002\u540C\u3058\u88AB\u5199\u4F53\u3067\u3042\u308B\u78BA\u7387\u3067\u306F\u3042\u308A\u307E\u305B\u3093\u3002" + (edge.unknown_prompt ? " \u6B63\u8CA0\u3092\u5224\u5225\u3067\u304D\u306A\u3044\u62BD\u51FA\u30C6\u30AD\u30B9\u30C8\u3092\u542B\u307F\u307E\u3059\u3002" : "");
      detail.append(note);
    }
    const label = document.createElement("p");
    label.textContent = node.prompt_source === "positive" ? "\u6B63\u306E\u30D7\u30ED\u30F3\u30D7\u30C8" : node.prompt_source === "unknown" ? "\u62BD\u51FA\u30C6\u30AD\u30B9\u30C8\uFF08\u6B63\u8CA0\u4E0D\u660E\uFF09" : "\u30D7\u30ED\u30F3\u30D7\u30C8\u60C5\u5831\u306A\u3057";
    detail.append(label);
    if (node.prompt) {
      const prompt = document.createElement("p");
      prompt.className = "ah-relation-prompt";
      prompt.textContent = node.prompt;
      detail.append(prompt);
    }
    if (node.id !== data.center) {
      const focus = document.createElement("button");
      focus.textContent = "\u3053\u306E\u753B\u50CF\u3092\u4E2D\u5FC3\u306B";
      focus.dataset.center = node.id;
      focus.onclick = () => {
        center = node.id;
        offset = 0;
        selected = null;
        void query();
      };
      detail.append(focus);
    } else {
      const hint = document.createElement("small");
      hint.textContent = "\u7DDA\u3084\u753B\u50CF\u3092\u9078\u3076\u3068\u3001\u3053\u306E\u753B\u50CF\u3068\u306E\u5171\u901A\u70B9\u3092\u8868\u793A\u3057\u307E\u3059\u3002";
      detail.append(hint);
    }
    highlight();
  }
  function highlight() {
    for (const node of nodeLayer.querySelectorAll("[data-node]")) {
      const id = node.dataset.node, rect = node.querySelector("rect");
      rect.setAttribute("stroke", id === selected ? "#ffd878" : id === data?.center ? "#8cdabb" : "#526763");
      rect.setAttribute("stroke-width", id === selected || id === data?.center ? "3" : "1");
    }
    for (const edge of edgeLayer.querySelectorAll("[data-edge]")) edge.setAttribute("opacity", selected && selected !== data?.center && !edge.getAttribute("data-edge").split(":").includes(selected) ? ".12" : ".7");
  }
  function draw() {
    edgeLayer.replaceChildren();
    nodeLayer.replaceChildren();
    for (const edge of data.edges) {
      const a = positions.get(edge.source), b = positions.get(edge.target), line = svgElement("line", { x1: a.x, y1: a.y, x2: b.x, y2: b.y, stroke: edge.prompt >= 0.15 ? edge.visual >= 0.88 ? "#ad9ad1" : "#65bfa4" : "#d3ac6a", "stroke-width": 2 + edge.score * 2, opacity: 0.7 });
      line.setAttribute("data-edge", `${edge.source}:${edge.target}`);
      line.style.cursor = "pointer";
      const title = svgElement("title");
      title.textContent = edge.common.length ? `\u5171\u901A\uFF1A${edge.common.join("\u3001")}` : `\u8272\u30FB\u914D\u7F6E\u30FB\u8F2A\u90ED\u306E\u8FD1\u3055 ${Math.round(edge.visual * 100)}/100`;
      line.append(title);
      line.addEventListener("click", () => showDetails(data.nodes.find((node) => node.id === edge.target), edge));
      edgeLayer.append(line);
    }
    for (const node of data.nodes) {
      const p = positions.get(node.id), el = svgElement("g", { transform: `translate(${p.x} ${p.y})`, tabindex: 0, role: "button", "aria-label": node.item.name });
      el.classList.add("ah-relation-node");
      el.setAttribute("data-node", node.id);
      const border = svgElement("rect", { x: -56, y: -44, width: 112, height: 88, rx: 7, fill: "#24322f" }), picture = svgElement("image", { x: -51, y: -39, width: 102, height: 62, href: thumb(node), preserveAspectRatio: "xMidYMid meet" }), name = svgElement("text", { x: 0, y: 37, "text-anchor": "middle", fill: "#e2eae7", "font-size": 10 });
      name.textContent = node.item.name.length > 18 ? node.item.name.slice(0, 16) + "\u2026" : node.item.name;
      const title = svgElement("title");
      title.textContent = node.item.name;
      el.append(border, picture, name, title);
      const inspect = () => {
        const edge = data.edges.find((edge2) => edge2.source === data.center && edge2.target === node.id);
        showDetails(node, edge);
      };
      el.addEventListener("keydown", (event) => {
        const key = event;
        if (key.key === "Enter" || key.key === " ") {
          key.preventDefault();
          inspect();
        }
      });
      el.addEventListener("dblclick", () => {
        center = node.id;
        offset = 0;
        selected = null;
        void query();
      });
      nodeLayer.append(el);
    }
    highlight();
    transform();
  }
  let drag = null;
  svg.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    const target = event.target;
    if (target.closest("[data-edge]")) return;
    drag = { id: target.closest("[data-node]")?.getAttribute("data-node") || null, x: event.clientX, y: event.clientY, moved: false };
    svg.setPointerCapture(event.pointerId);
  });
  svg.addEventListener("pointermove", (event) => {
    if (!drag) return;
    const dx = event.clientX - drag.x, dy = event.clientY - drag.y;
    if (Math.abs(dx) + Math.abs(dy) < 2 && !drag.moved) return;
    drag.moved = true;
    viewTouched = true;
    drag.x = event.clientX;
    drag.y = event.clientY;
    if (drag.id) {
      const p = positions.get(drag.id);
      p.x += dx / view.scale;
      p.y += dy / view.scale;
      draw();
    } else {
      view.x += dx;
      view.y += dy;
      transform();
    }
  });
  svg.addEventListener("pointerup", (event) => {
    if (!drag) return;
    const finished = drag;
    drag = null;
    svg.releasePointerCapture(event.pointerId);
    if (finished.id && !finished.moved) {
      const node = data.nodes.find((n) => n.id === finished.id), edge = data.edges.find((e) => e.source === data.center && e.target === finished.id);
      showDetails(node, edge);
    }
  });
  svg.addEventListener("pointercancel", () => {
    drag = null;
  });
  svg.addEventListener("wheel", (event) => {
    event.preventDefault();
    const rect = svg.getBoundingClientRect(), x = event.clientX - rect.left, y = event.clientY - rect.top, scale = Math.max(0.12, Math.min(4, view.scale * Math.exp(-event.deltaY * 1e-3)));
    view.x = x - (x - view.x) * scale / view.scale;
    view.y = y - (y - view.y) * scale / view.scale;
    view.scale = scale;
    viewTouched = true;
    transform();
  }, { passive: false });
  card.querySelector("select").addEventListener("change", (event) => {
    mode = event.target.value;
    offset = 0;
    selected = null;
    void query();
  });
  card.querySelector("[data-errors]").addEventListener("click", () => {
    detail.replaceChildren();
    const title = document.createElement("h3");
    title.textContent = `\u89E3\u6790\u3067\u304D\u306A\u304B\u3063\u305F\u753B\u50CF ${data.job.error_count}\u4EF6`;
    detail.append(title);
    for (const error of data.job.errors) {
      const p = document.createElement("p");
      p.textContent = `${error.name}\uFF1A${error.error}`;
      detail.append(p);
    }
    if (data.job.error_count > 20) {
      const p = document.createElement("small");
      p.textContent = "\u76F4\u8FD120\u4EF6\u3092\u8868\u793A\u3057\u3066\u3044\u307E\u3059\u3002";
      detail.append(p);
    }
  });
  stopButton.onclick = async () => {
    try {
      if (data?.job.status === "cancelled") {
        await begin();
        return;
      }
      cancelling = true;
      stopButton.disabled = true;
      await api2("relations/cancel", { id: jobId });
      void query();
    } catch (error) {
      status.textContent = error.message;
    }
  };
  async function query() {
    if (!jobId || closed) return;
    clearTimeout(timer);
    const revision = ++requestVersion;
    try {
      const result = await api2("relations/query", { id: jobId, center, mode, offset });
      if (closed || revision !== requestVersion) return;
      if (drag) {
        timer = setTimeout(query, 200);
        return;
      }
      data = result;
      if (result.center) center = result.center;
      offset = result.offset;
      const job = data.job, running = job.status === "running";
      status.textContent = `${running ? "\u89E3\u6790\u4E2D" : job.status === "cancelled" ? "\u89E3\u6790\u3092\u505C\u6B62" : job.status === "error" ? "\u89E3\u6790\u3067\u30A8\u30E9\u30FC" : "\u89E3\u6790\u6E08\u307F"} ${job.done}/${job.total}\u679A \xB7 \u95A2\u9023 ${data.related_total}\u679A${data.related_total ? "\uFF08" + (offset + 1) + "\u2013" + (offset + data.nodes.length - 1) + "\u679A\u76EE\uFF09" : ""}${job.cached ? " \xB7 \u518D\u5229\u7528 " + job.cached + "\u679A" : ""}${job.error_count ? " \xB7 \u5931\u6557 " + job.error_count + "\u4EF6" : ""}`;
      previous.hidden = next.hidden = data.related_total <= 20;
      previous.disabled = offset === 0;
      next.disabled = offset + 20 >= data.related_total;
      stopButton.hidden = job.status === "done" || job.status === "error";
      stopButton.textContent = job.status === "cancelled" ? "\u89E3\u6790\u3092\u518D\u958B" : cancelling ? "\u505C\u6B62\u4E2D\u2026" : "\u89E3\u6790\u3092\u505C\u6B62";
      stopButton.disabled = running && cancelling;
      if (!running) cancelling = false;
      card.querySelector("[data-errors]").hidden = !job.error_count;
      empty.hidden = data.nodes.length > 1;
      empty.textContent = data.nodes.length ? running ? "\u8FD1\u3044\u753B\u50CF\u3092\u63A2\u3057\u3066\u3044\u307E\u3059\u3002\u89E3\u6790\u306E\u9014\u4E2D\u3067\u3082\u57FA\u6E96\u3092\u5207\u308A\u66FF\u3048\u3089\u308C\u307E\u3059\u3002" : "\u95A2\u9023\u3059\u308B\u753B\u50CF\u304C\u898B\u3064\u304B\u308A\u307E\u305B\u3093\u3067\u3057\u305F\u3002\u5225\u306E\u57FA\u6E96\u3084\u4E2D\u5FC3\u753B\u50CF\u3092\u9078\u3093\u3067\u304F\u3060\u3055\u3044\u3002" : running ? "\u753B\u50CF\u3092\u89E3\u6790\u3057\u3066\u3044\u307E\u3059\u2026" : "\u89E3\u6790\u3067\u304D\u308B\u753B\u50CF\u304C\u3042\u308A\u307E\u305B\u3093\u3002";
      if (!drag) {
        arrange();
        draw();
        if (!viewTouched) fit();
      }
      if (!selected || !data.nodes.some((node) => node.id === selected)) {
        selected = data.center;
        if (data.nodes[0]) showDetails(data.nodes[0]);
      }
      if (running) timer = setTimeout(query, 1200);
    } catch (error) {
      if (!closed && revision === requestVersion) status.textContent = error.message;
    }
  }
  async function begin() {
    stopButton.disabled = true;
    const seed = data?.nodes.find((node) => node.id === center)?.item || body.center;
    const started = await api2("relations/start", { ...body, center: seed });
    jobId = started.id;
    if (closed) {
      await api2("relations/cancel", { id: jobId });
      return;
    }
    cancelling = false;
    await query();
  }
  try {
    await begin();
  } catch (error) {
    if (!closed) {
      status.textContent = error.message;
      empty.textContent = "\u89E3\u6790\u3092\u958B\u59CB\u3067\u304D\u307E\u305B\u3093\u3067\u3057\u305F\u3002";
      stopButton.hidden = true;
    }
  }
}

// src/progress.ts
var actionLabels = {
  prepare: "\u5019\u88DC\u4F5C\u6210",
  archive: "\u5727\u7E2E\u30FB\u4FDD\u7BA1",
  commit: "\u4FDD\u7BA1",
  restore: "PNG\u306B\u623B\u3059",
  discard: "\u5019\u88DC\u7834\u68C4"
};
function submittedJobText(job) {
  const action = actionLabels[job.action];
  if (job.status === "queued") return `${action} ${job.total}\u4EF6\u3092\u5F85\u3061\u884C\u5217\u306B\u8FFD\u52A0`;
  return `${action} ${job.done || 0}/${job.total}`;
}
function jobProgressText(job, queued, rate) {
  if (job.status === "running") {
    const parts2 = [`${actionLabels[job.action]} ${job.done}/${job.total}`, `${job.running?.length || 0}/${job.workers}\u4E26\u5217`];
    if (job.stopping) parts2.push("\u51E6\u7406\u4E2D\u306E\u753B\u50CF\u304C\u7D42\u308F\u3063\u305F\u3089\u4E00\u6642\u505C\u6B62");
    else if (job.wait_reason) parts2.push(job.wait_reason);
    else parts2.push(rate === null ? "\u901F\u5EA6\u8A08\u6E2C\u4E2D" : `\u76F4\u8FD1 ${rate.toFixed(1)}\u679A/\u79D2`);
    if (queued) parts2.push(`\u5F85\u3061 ${queued}\u4EF6`);
    return parts2.join(" \xB7 ");
  }
  if (["paused", "cancelled"].includes(job.status)) return `\u4E00\u6642\u505C\u6B62 \xB7 ${job.done}/${job.total}\u4EF6\u51E6\u7406\u6E08\u307F`;
  if (job.status === "error") return `\u51E6\u7406\u505C\u6B62 \xB7 ${job.message || "\u51E6\u7406\u5C65\u6B74\u3092\u78BA\u8A8D\u3057\u3066\u304F\u3060\u3055\u3044"}`;
  const retained = job.not_smaller || 0;
  const skipped = Math.max(0, (job.skipped || 0) - retained);
  const parts = [`${job.succeeded}\u4EF6\u5B8C\u4E86`];
  if (retained) parts.push(`\u539F\u672C\u4FDD\u6301 ${retained}\u4EF6\uFF08\u524A\u6E1B\u306A\u3057\uFF09`);
  if (skipped) parts.push(`${skipped}\u4EF6\u30B9\u30AD\u30C3\u30D7`);
  if (job.error_count) parts.push(`${job.error_count}\u4EF6\u5931\u6557`);
  return parts.join(" \xB7 ");
}
var RecentRate = class {
  key = "";
  samples = [];
  sample(job, now) {
    const key = job?.status === "running" ? `${job.id}:${job.started ?? ""}` : "";
    const count = job?.succeeded ?? 0, last = this.samples.at(-1);
    if (!key || key !== this.key || last && (count < last.count || now - last.at > 6e4 || now < last.at)) this.samples = [];
    this.key = key;
    if (!key) return null;
    if (!last || last.at !== now || !this.samples.length) this.samples.push({ at: now, count });
    while (this.samples.length > 2 && this.samples[1].at <= now - 3e4) this.samples.shift();
    const first = this.samples[0], seconds = (now - first.at) / 1e3;
    return seconds >= 5 ? (count - first.count) / seconds : null;
  }
};

// src/progress-panel.ts
var rememberedOpen = true;
var ProgressPanel = class {
  element = document.createElement("div");
  details = document.createElement("details");
  cpuSelect;
  noticeElement;
  cpu;
  text;
  total;
  meter;
  pause;
  resume;
  history;
  grid;
  summary;
  rows = /* @__PURE__ */ new Map();
  resumableId = "";
  constructor(parent, actions) {
    this.element.className = "ah-toolbar";
    this.element.innerHTML = `
   <select data-cpu-target aria-label="CPU\u76EE\u6A19" title="PC\u5168\u4F53\u306ECPU\u4F7F\u7528\u7387\u306E\u76EE\u5B89\u3002\u753B\u50CF\u751F\u6210\u4E2D\u3082CPU\u30FB\u30E1\u30E2\u30EA\u306E\u4F59\u88D5\u306B\u5FDC\u3058\u3066\u5727\u7E2E\u3092\u7D9A\u3051\u307E\u3059\u3002\u5168\u901F\u306FCPU\u8ABF\u6574\u3092\u89E3\u9664\u3057\u307E\u3059\u3002\u5909\u66F4\u306F\u51E6\u7406\u4E2D\u306B\u3082\u53CD\u6620\u3057\u307E\u3059\u3002">
    <option value="30">CPU\u76EE\u6A19 30%</option><option value="50">CPU\u76EE\u6A19 50%</option>
    <option value="70" selected>CPU\u76EE\u6A19 70%</option><option value="90">CPU\u76EE\u6A19 90%</option><option value="full">\u5168\u901F</option>
   </select>
   <span data-cpu-current class="ah-detail" title="PC\u5168\u4F53\u306E\u5B9F\u6E2CCPU\u4F7F\u7528\u7387\u30022\u79D2\u9593\u9694\u3067\u53D6\u5F97\u3057\u307E\u3059\u3002"></span>
   <span data-total-progress class="ah-total-meter" hidden>\u5168\u4F53<progress class="ah-run-meter" aria-label="\u5168\u4F53\u306E\u51E6\u7406\u9032\u6357" max="1" value="0" hidden></progress></span>
   <span data-progress class="ah-progress"></span>
   <button data-stop hidden>\u4E00\u6642\u505C\u6B62</button><button data-resume hidden>\u518D\u958B</button><button data-jobs>\u51E6\u7406\u5C65\u6B74</button>
   <span class="ah-notice" role="status"></span>`;
    this.cpuSelect = this.element.querySelector("[data-cpu-target]");
    this.noticeElement = this.element.querySelector(".ah-notice");
    this.cpu = this.element.querySelector("[data-cpu-current]");
    this.text = this.element.querySelector("[data-progress]");
    this.total = this.element.querySelector("[data-total-progress]");
    this.meter = this.element.querySelector("progress");
    this.pause = this.element.querySelector("[data-stop]");
    this.resume = this.element.querySelector("[data-resume]");
    this.history = this.element.querySelector("[data-jobs]");
    this.text.title = "\u76F4\u8FD1\u7D0430\u79D2\u306E\u5B8C\u4E86\u679A\u6570\xF7\u5B9F\u6642\u9593\u3002\u5931\u6557\u30FB\u65E2\u51E6\u7406\u30B9\u30AD\u30C3\u30D7\u3092\u9664\u304F\u3002\u958B\u3044\u3066\u304B\u30895\u79D2\u5F8C\u306B\u8868\u793A\u3057\u3001\u5F85\u6A5F\u6642\u9593\u3082\u542B\u3081\u307E\u3059\u3002";
    this.pause.onclick = actions.pause;
    this.resume.onclick = () => actions.resume(this.resumableId);
    this.history.onclick = actions.history;
    this.details.className = "ah-work";
    this.details.open = rememberedOpen;
    this.details.hidden = true;
    this.details.innerHTML = '<summary>\u51E6\u7406\u4E2D\u306E\u753B\u50CF</summary><div class="ah-work-grid"></div>';
    this.details.addEventListener("toggle", () => {
      rememberedOpen = this.details.open;
    });
    this.grid = this.details.querySelector(".ah-work-grid");
    this.summary = this.details.querySelector("summary");
    parent.append(this.element, this.details);
  }
  showSubmitted(job) {
    this.text.textContent = submittedJobText(job);
  }
  render(state, rate) {
    const job = state.job;
    const running = job?.status === "running";
    this.cpu.textContent = running && job.cpu_percent != null ? `CPU\u4F7F\u7528\u7387 ${Math.round(job.cpu_percent)}%` : "";
    this.history.textContent = state.attention ? `\u51E6\u7406\u5C65\u6B74 \xB7 \u8981\u78BA\u8A8D ${state.attention}` : "\u51E6\u7406\u5C65\u6B74";
    this.renderImages(running ? job.progress || [] : []);
    if (!job) return null;
    const text = jobProgressText(job, state.queue.length, rate);
    this.text.textContent = text;
    this.meter.hidden = this.total.hidden = !running;
    this.meter.max = job.total;
    this.meter.value = job.done;
    this.pause.hidden = !running;
    this.pause.disabled = Boolean(job.stopping);
    this.resumableId = job.id;
    this.resume.hidden = running || !["paused", "error"].includes(job.status) || job.done >= job.total;
    return text;
  }
  renderImages(items) {
    this.details.hidden = !items.length;
    this.summary.textContent = `\u51E6\u7406\u4E2D\u306E\u753B\u50CF ${items.length}\u4EF6`;
    const slots = new Set(items.map((item) => item.slot));
    for (const [slot, row] of this.rows) {
      if (!slots.has(slot)) {
        row.remove();
        this.rows.delete(slot);
      }
    }
    for (const item of items) {
      let row = this.rows.get(item.slot);
      if (!row) {
        row = document.createElement("div");
        row.className = "ah-work-item";
        row.dataset.slot = String(item.slot);
        row.innerHTML = '<span class="ah-work-name"></span><span class="ah-work-phase"></span><progress max="100"></progress><span class="ah-work-time"></span>';
        this.rows.set(item.slot, row);
      }
      const name = row.querySelector(".ah-work-name");
      name.textContent = name.title = item.name;
      row.querySelector(".ah-work-phase").textContent = item.phase + (item.percent == null ? "" : ` ${item.percent}%`);
      const meter = row.querySelector("progress");
      meter.setAttribute("aria-label", `${item.name} ${item.phase}`);
      if (item.percent == null) meter.removeAttribute("value");
      else meter.value = item.percent;
      row.querySelector(".ah-work-time").textContent = `${Math.floor(item.elapsed_s || 0)}\u79D2`;
      this.grid.append(row);
    }
  }
};

// src/hub-styles.ts
function ensureHubStyles() {
  ensureStyleOnce("asset-hub-style-v3", `
 .ah-view-switch{display:flex;gap:4px;margin-left:auto}.ah-view-switch .ib-density-seg{width:auto;padding:7px 10px;font-size:12px}
 .ah-asset small{display:block;color:#9baaa7;font-size:11px}.ah-processing{border-color:#d8b66c!important}.ah-processing .ah-asset::before{content:"\u51E6\u7406\u4E2D \xB7 ";color:#f2d595}
 .ah-asset{font-size:12px;color:#a4bfb4;padding:5px 8px;line-height:1.5;min-height:25px}.ah-asset[data-state=compacted]{color:#80d6ae}
 .ah-compact-ui .ib-grid[data-density=grid]{grid-template-columns:repeat(auto-fill,minmax(230px,1fr))}
 .ah-card-primary{background:#315b4b!important}.ah-compact-ui .ib-actions{flex-wrap:wrap}.ah-compact-ui .ib-grid[data-density=dense]{grid-template-columns:repeat(auto-fill,minmax(120px,1fr))}
 .ah-compact-ui .ib-grid[data-density=dense] .ib-actions [data-action]{display:none}
 .ah-compact-ui .ib-grid[data-density=list] .ib-card.is-file{grid-template-columns:64px minmax(130px,1fr) minmax(140px,.7fr) 260px;grid-template-areas:"thumb name asset acts" "thumb meta asset acts";align-items:center;min-height:70px;padding:6px}
 .ah-compact-ui .ib-grid[data-density=list] .ah-asset{grid-area:asset}.ah-compact-ui .ib-grid[data-density=list] .ib-actions{justify-content:flex-end}
 .ah-compact-ui .ib-grid[data-density=list] .ib-thumb{height:64px}
 .ah-run-meter{width:130px;height:6px;accent-color:#67cba2}.ah-record-thumb{width:52px;height:52px;object-fit:contain;background:#15191f;border-radius:4px}
 .ah-unused,.ah-compact-ui .ib-selbar,.ah-compact-ui .ib-selected-badge{display:none!important}
 .ah-compact-ui .ib-check{display:flex}.ah-compact-ui .ib-check::before{border-radius:4px!important}.ah-compact-ui .ib-stars{display:none}.ah-compact-ui .ib-actions{gap:4px}
 .ah-compact-ui .ib-act{white-space:nowrap;min-height:30px;height:32px;font-size:12px;width:auto;min-width:44px;padding:4px 8px}
 .ah-compact-ui .ib-dir-move,.ah-compact-ui .ib-dir-del{display:none!important}
 .ah-toolbar,.ah-pages,.ah-controls{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
 .ah-toolbar{width:100%;padding:4px 0}.ah-toolbar select{max-width:min(340px,40vw)}
 .ah-pages{margin-left:auto;font-size:12px}.ah-progress{font-size:12px;color:#aac7bd;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
 .ah-notice{font-size:12px;color:#ffbc97;overflow-wrap:anywhere}.ah-notice:empty{display:none}
 .ah-total-meter:not([hidden]){display:inline-flex;align-items:center;gap:6px;font-size:12px;color:#aebeb8}
 .ah-work{width:100%;font-size:12px;color:#b7c8c3}.ah-work summary{cursor:pointer;width:fit-content;padding:3px 0}
 .ah-work-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:6px 16px;margin-top:5px}
 .ah-work-item{min-width:0;display:grid;grid-template-columns:minmax(0,1fr) auto;gap:3px 8px}
 .ah-work-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.ah-work-phase{color:#a6d4c3;white-space:nowrap}
 .ah-work-item progress{appearance:none;width:100%;height:4px;border:0;background:#3e4449;align-self:center}
 .ah-work-item progress::-webkit-progress-bar{background:#3e4449}.ah-work-item progress::-webkit-progress-value{background:#8ac9b5}.ah-work-item progress::-moz-progress-bar{background:#8ac9b5}
 .ah-work-time{color:#9aa5ae;text-align:right}
 .ah-background{display:flex;align-items:center;gap:4px;font-size:12px;white-space:nowrap}.ah-task{padding:10px 0;border-bottom:1px solid #ffffff15;display:flex;align-items:center;gap:8px;flex-wrap:wrap}.ah-task span{flex:1;min-width:180px;overflow-wrap:anywhere}
 .ah-toolbar button,.ah-pages button,.ah-panel button,.ah-panel select,.ah-toolbar select,.ah-panel input[data-path]{font:inherit;background:#2d3a3e;border:1px solid #50635f;border-radius:6px;color:#e7eeec;padding:7px 11px;cursor:pointer}
 .ah-panel button:disabled,.ah-toolbar button:disabled,.ah-pages button:disabled{opacity:.4;cursor:default}
 .ah-primary{background:#315f50!important}.ah-count{font-size:12px;color:#b7c8c3;min-width:55px}
 .ah-panel{width:min(1000px,94vw)!important;max-width:94vw!important;max-height:88dvh!important;display:flex;flex-direction:column;gap:12px;color:#eee}
 .ah-head{display:flex;align-items:center;justify-content:space-between;gap:12px}.ah-head h2{margin:0;font-size:20px}
 .ah-records{overflow:auto;min-height:100px;max-height:57dvh;flex:1;overflow-anchor:none}
 .ah-record{user-select:none;display:grid;grid-template-columns:24px 56px minmax(0,1fr) auto;gap:10px;align-items:center;padding:10px 4px;border-bottom:1px solid #ffffff15;cursor:pointer}
 .ah-record strong{display:block;font-size:13px;overflow-wrap:anywhere}.ah-record small{display:block;font-size:12px;color:#aebeb8;margin-top:4px;overflow-wrap:anywhere}
 .ah-record input{width:17px;height:17px;cursor:pointer}.ah-record.is-selected{background:#25433b55}
 .ah-record button{font-size:12px}.ah-state{color:#9edcc3}.ah-detail{font-size:12px;color:#aebeb8;line-height:1.5}.ah-detail summary{cursor:pointer}
 @media(max-width:700px){.ah-record{grid-template-columns:22px minmax(0,1fr)}.ah-record button{grid-column:2}.ah-pages{margin-left:0}}
 `);
}

// src/hub.ts
var mb = (n) => n < 1e6 ? (n / 1e3).toFixed(1) + " KB" : (n / 1e6).toFixed(1) + " MB";
var esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
async function api(tail, body) {
  const response = await fetch("/asset_hub/" + tail, { method: body === void 0 ? "GET" : "POST", headers: body === void 0 ? {} : { "Content-Type": "application/json" }, ...body === void 0 ? {} : { body: JSON.stringify(body) } });
  const result = await response.json();
  if (!response.ok) throw Error(result.error || `HTTP ${response.status}`);
  return result;
}
var labels = { prepared: "\u5019\u88DC", placing: "\u7F6E\u304D\u63DB\u3048\u9014\u4E2D", compacted: "WebP", restoring: "PNG\u3078\u5FA9\u5143\u9014\u4E2D", restored: "PNG", discarded: "\u7834\u68C4", not_smaller: "\u524A\u6E1B\u306A\u3057\u30FB\u539F\u672C\u4FDD\u6301" };
var activeHub = null;
var openingHub = null;
var rememberedAllScope = null;
function openHub() {
  if (activeHub?.dialog.isConnected) return Promise.resolve(activeHub);
  if (openingHub) return openingHub;
  openingHub = createHub().then((modal) => {
    activeHub = modal;
    return modal;
  }).finally(() => {
    openingHub = null;
  });
  return openingHub;
}
async function createHub() {
  const folders = (await api("folders")).roots;
  for (const root of folders) if (!SANDBOXED_TYPES2.includes(root.type)) SANDBOXED_TYPES2.push(root.type);
  const rootLabel = (type) => folders.find((r) => r.type === type)?.path.split(/[\\/]/).filter(Boolean).pop() || { output: "Output", input: "Input", temp: "Temp" }[type] || type;
  let noticeEl;
  let cardAction = () => {
  };
  const assets = /* @__PURE__ */ new Map();
  const decorateCard = (card, file) => {
    let box = card.querySelector(".ah-asset");
    if (!box) {
      box = document.createElement("div");
      box.className = "ah-asset";
      card.querySelector(".ib-actions")?.before(box);
    }
    const r = file.asset;
    if (r) assets.set(r.id, r);
    const noSaving = r?.state === "not_smaller" && r.no_saving_current;
    box.textContent = r?.state === "compacted" ? `WebP \xB7 \u2212${mb(r.saving_bytes)} (${Math.round(100 * r.saving_bytes / r.original_bytes)}%)` : r?.state === "prepared" ? "\u5727\u7E2E\u5019\u88DC" : r?.state === "restored" ? "PNG \xB7 \u5FA9\u5143\u6E08\u307F" : `${(file.ext || "").slice(1).toUpperCase()} \xB7 ${mb(file.size || 0)}`;
    if (r) {
      const sizes = document.createElement("small");
      sizes.textContent = mb(r.original_bytes) + " \u2192 " + mb(r.webp_bytes);
      box.append(sizes);
    }
    if (r?.state === "not_smaller") box.textContent = noSaving ? "PNG \xB7 \u524A\u6E1B\u306A\u3057\uFF08\u539F\u672C\u4FDD\u6301\uFF09" : "PNG \xB7 \u518D\u8A55\u4FA1\u5BFE\u8C61";
    box.dataset.state = r?.state || "";
    box.title = r ? `${mb(r.original_bytes)} \u2192 ${mb(r.webp_bytes)} \xB7 ${r.workflow_nodes}\u30CE\u30FC\u30C9` : file.name;
    let button = card.querySelector("[data-asset-action]");
    if (!button) {
      button = document.createElement("button");
      button.className = "ib-act ah-card-primary";
      button.dataset.assetAction = "";
      card.querySelector(".ib-actions")?.append(button);
    }
    const action = r?.state === "compacted" ? "restore" : r?.state === "prepared" || r?.state === "placing" ? "commit" : file.ext?.toLowerCase() === ".png" ? "archive" : "";
    button.hidden = !action;
    button.textContent = action === "restore" ? "PNG\u306B\u623B\u3059" : action === "commit" ? "\u4FDD\u7BA1" : "\u5727\u7E2E";
    button.disabled = Boolean(noSaving);
    if (noSaving) button.textContent = "\u524A\u6E1B\u306A\u3057";
    button.onclick = (e) => {
      e.stopPropagation();
      cardAction(action, { ...file, asset: r });
    };
  };
  const notice = (value) => {
    if (noticeEl) noticeEl.textContent = typeof value === "string" ? value : value.message || value.detail || value.summary || String(value);
  };
  ensureHubStyles();
  let disposeHub = () => {
  };
  return openImageBrowser({ resumeKey: "asset-hub", onClose: () => disposeHub(), title: "\u7D20\u6750\u5EAB", compact: true, decorateCard, onNotice: notice, rootLabel, listing: (params) => api("list", params), mount({ modal, selection, refresh, selectAll, clearSelection, navigate, query, pageItems, updateAssets }) {
    modal.dialog.classList.add("ah-compact-ui");
    modal.searchEl.placeholder = "\u30D5\u30A9\u30EB\u30C0\u5168\u4F53\u304B\u3089\u30D5\u30A1\u30A4\u30EB\u540D\u3092\u691C\u7D22";
    modal.footerEl.textContent = "\u30AF\u30EA\u30C3\u30AF\u3067\u9078\u629E \xB7 Shift\uFF0B\u30AF\u30EA\u30C3\u30AF\u3067\u7BC4\u56F2\u9078\u629E \xB7 W\u3067\u30B0\u30E9\u30D5";
    let concurrency = 4, performanceRevision = 0, savingPerformance = false;
    let compressionRevision = 0, savingCompression = false;
    let allScope = rememberedAllScope, listing = null, selectedCount = 0, panel = null;
    let selectionPlan = null, selectionRevision = 0, selectionTimer;
    let historyOffset = 0, historyState = "", historyAll = false, historyTotal = 0, historyAnchor = -1;
    const historySelected = /* @__PURE__ */ new Set(), historyStates = /* @__PURE__ */ new Map(), rowCache = /* @__PURE__ */ new Map();
    let galleryDirty = false;
    let historyRows = [], pollTimer, lastJob = "", panelPage = "";
    let firstStatus = true;
    let polling = false, pollRequested = false, statusRevision = 0;
    const recentRate = new RecentRate();
    disposeHub = () => {
      rememberedAllScope = allScope ? { ...allScope } : null;
      clearTimeout(pollTimer);
      clearTimeout(selectionTimer);
      selectionRevision++;
    };
    const status = (progressOnly = false) => api(progressOnly ? "status?progress=1" : `status?offset=${historyOffset}&state=${encodeURIComponent(historyState)}`);
    const bar = document.createElement("div");
    bar.className = "ah-toolbar";
    bar.innerHTML = '<select aria-label="\u30D5\u30A9\u30EB\u30C0"><option value="output">Output</option><option value="input">Input</option><option value="temp">Temp</option></select><button data-folder>\u30D5\u30A9\u30EB\u30C0\u8FFD\u52A0</button><button data-all>\u5168\u9078\u629E</button><button data-clear>\u89E3\u9664</button><span data-count class="ah-count"></span><button data-archive class="ah-primary" title="\u53EF\u9006\u5727\u7E2E\u3057\u3001\u7167\u5408\u5F8C\u306BPNG\u3092WebP\u3078\u7F6E\u304D\u63DB\u3048\u307E\u3059">\u5727\u7E2E 0\u4EF6</button><button data-restore>\u5FA9\u5143 0\u4EF6</button><select data-compression aria-label="\u5727\u7E2E\u65B9\u6CD5" title="\u3069\u3061\u3089\u3082\u53EF\u9006\u5727\u7E2E\u3002\u5909\u66F4\u306F\u6B21\u306B\u51E6\u7406\u3092\u958B\u59CB\u3059\u308B\u753B\u50CF\u304B\u3089\u53CD\u6620\u3057\u3001\u518D\u8D77\u52D5\u5F8C\u3082\u4FDD\u6301\u3057\u307E\u3059\u3002\u30B5\u30A4\u30BA\u512A\u5148\u3067\u3082\u3001\u753B\u50CF\u306B\u3088\u3063\u3066\u5927\u5C0F\u304C\u9006\u8EE2\u3059\u308B\u5834\u5408\u304C\u3042\u308A\u307E\u3059\u3002"><option value="size">\u30B5\u30A4\u30BA\u512A\u5148</option><option value="speed">\u901F\u5EA6\u512A\u5148</option></select><select data-workers aria-label="\u4E26\u5217\u6570"><option value="1">1\u4E26\u5217</option><option value="2">2\u4E26\u5217</option><option value="4">4\u4E26\u5217</option><option value="8">8\u4E26\u5217</option><option value="16">16\u4E26\u5217</option></select><button data-history>\u5C65\u6B74</button>';
    const relationButton = document.createElement("button");
    relationButton.className = "ib-density-seg";
    relationButton.textContent = "\u95A2\u9023\u56F3";
    relationButton.disabled = true;
    relationButton.title = "\u753B\u50CF\u540C\u58EB\u3092\u5171\u901A\u30D7\u30ED\u30F3\u30D7\u30C8\u3084\u898B\u305F\u76EE\u3067\u3064\u306A\u3050\u3002\u8907\u6570\u9078\u629E\u6642\u306F\u9078\u629E\u753B\u50CF\u3001\u672A\u9078\u629E\u30FB1\u679A\u9078\u629E\u6642\u306F\u691C\u7D22\u7D50\u679C\u5168\u4F53\u304B\u3089\u63A2\u3057\u307E\u3059\u3002";
    modal.dialog.querySelector(".ah-view-switch").append(relationButton);
    relationButton.onclick = () => {
      const chosen = selection(), scope = query();
      const items = chosen.length > 1 && !allScope ? chosen : scope?.safeHide ? pageItems() : null;
      void openRelations(modal, items ? { items, center: chosen[0] || items[0] } : { all: { ...scope }, center: chosen[0] || pageItems()[0] }, api);
    };
    modal.toolbarEl.prepend(bar);
    const progressView = new ProgressPanel(modal.toolbarEl, {
      pause: () => void api("cancel", {}).then(() => {
        notice("");
        schedulePoll();
      }).catch(notice),
      resume: (id) => void api(`jobs/${id}/resume`, {}).then((job) => {
        lastJob = "";
        showSubmitted(job);
        schedulePoll();
      }).catch(notice),
      history: () => void openJobs()
    });
    noticeEl = progressView.noticeElement;
    const workerSelect = bar.querySelector("[data-workers]");
    workerSelect.value = String(concurrency);
    workerSelect.title = "\u540C\u6642\u51E6\u7406\u6570\u306E\u4E0A\u9650\u3002\u5909\u66F4\u306F\u5B9F\u884C\u4E2D\u3068\u5F85\u3061\u884C\u5217\u306B\u3082\u53CD\u6620\u3057\u307E\u3059\u3002\u6E1B\u3089\u3057\u305F\u5834\u5408\u3001\u51E6\u7406\u4E2D\u306E\u753B\u50CF\u306F\u5B8C\u4E86\u3055\u305B\u307E\u3059\u3002";
    const cpuSelect = progressView.cpuSelect;
    const compressionSelect = bar.querySelector("[data-compression]");
    compressionSelect.disabled = true;
    compressionSelect.onchange = async () => {
      compressionRevision++;
      savingCompression = true;
      compressionSelect.disabled = true;
      try {
        await api("compression", { compression: compressionSelect.value });
        notice("");
        updateCount();
        await refreshAssets();
      } catch (e) {
        notice(e);
      } finally {
        savingCompression = false;
        schedulePoll();
      }
    };
    workerSelect.disabled = cpuSelect.disabled = true;
    const savePerformance = async () => {
      performanceRevision++;
      savingPerformance = true;
      concurrency = Number(workerSelect.value);
      workerSelect.disabled = cpuSelect.disabled = true;
      try {
        const value = await api("performance", { cpu_target: cpuSelect.value === "full" ? null : Number(cpuSelect.value), workers: Number(workerSelect.value) });
        concurrency = value.workers;
        notice("");
      } catch (e) {
        notice(e);
      } finally {
        savingPerformance = false;
        schedulePoll();
      }
    };
    workerSelect.onchange = cpuSelect.onchange = () => void savePerformance();
    async function refreshAssets() {
      const items = pageItems();
      if (items.length) {
        const data = await api("records", { items });
        updateAssets(data.records);
      }
    }
    cardAction = async (action, file) => {
      try {
        const job = action === "archive" ? await api("prepare", { items: [{ type: file.type, subfolder: file.subfolder, name: file.name }], archive: true, workers: concurrency }) : await api("operate", { action, ids: [file.asset.id], workers: concurrency });
        showSubmitted(job);
        schedulePoll();
      } catch (e) {
        notice(e);
      }
    };
    bar.querySelector("[data-restore]").addEventListener("click", async () => {
      try {
        if (!selectionPlan?.restore) return;
        const plan = selectionPlan.plan;
        selectionPlan = null;
        setActionCounts(0, 0);
        const job = await api("operate", { action: "restore", plan, workers: concurrency });
        allScope = null;
        clearSelection();
        updateCount();
        showSubmitted(job);
        schedulePoll();
      } catch (e) {
        notice(e);
      }
    });
    const rootSelect = bar.querySelector('select[aria-label="\u30D5\u30A9\u30EB\u30C0"]');
    const addRoot = (root) => {
      const option = document.createElement("option");
      option.value = root.type;
      option.textContent = root.path;
      rootSelect.append(option);
    };
    folders.forEach(addRoot);
    const countEl = bar.querySelector("[data-count]");
    function setActionCounts(archive, restore, pending = false) {
      const compress = bar.querySelector("[data-archive]"), expand = bar.querySelector("[data-restore]");
      compress.textContent = pending ? "\u5727\u7E2E \u2026" : `\u5727\u7E2E ${archive}\u4EF6`;
      expand.textContent = pending ? "\u5FA9\u5143 \u2026" : `\u5FA9\u5143 ${restore}\u4EF6`;
      compress.disabled = pending || archive === 0;
      expand.disabled = pending || restore === 0;
      compress.title = "\u9078\u629E\u4E2D\u306EPNG\u3060\u3051\u3092\u5727\u7E2E\u3057\u307E\u3059\u3002\u5909\u63DB\u6E08\u307FWebP\u306F\u5BFE\u8C61\u5916\u3067\u3059\u3002";
      expand.title = "\u9078\u629E\u4E2D\u306E\u7BA1\u7406\u4E0BWebP\u3060\u3051\u3092PNG\u306B\u623B\u3057\u307E\u3059\u3002";
    }
    function updateCount() {
      const revision = ++selectionRevision;
      clearTimeout(selectionTimer);
      selectionPlan = null;
      if (!allScope && !selectedCount) {
        countEl.textContent = "";
        setActionCounts(0, 0);
        return;
      }
      const body = allScope ? { all: { ...allScope } } : { items: selection() };
      countEl.textContent = `\u9078\u629E ${allScope ? listing?.file_count || 0 : selectedCount}\u4EF6 \xB7 \u5BFE\u8C61\u3092\u96C6\u8A08\u4E2D`;
      setActionCounts(0, 0, true);
      selectionTimer = setTimeout(async () => {
        try {
          const result = await api("selection", body);
          if (revision !== selectionRevision || !modal.dialog.isConnected) return;
          selectionPlan = result;
          countEl.textContent = `\u9078\u629E ${result.selected}\u4EF6${result.converted ? " \xB7 \u5909\u63DB\u6E08\u307F " + result.converted + "\u4EF6\uFF08\u5727\u7E2E\u5BFE\u8C61\u5916\uFF09" : ""}${result.unchanged ? " \xB7 \u524A\u6E1B\u306A\u3057 " + result.unchanged + "\u4EF6\uFF08\u5727\u7E2E\u5BFE\u8C61\u5916\uFF09" : ""}${result.other ? " \xB7 \u305D\u306E\u4ED6 " + result.other + "\u4EF6" : ""}`;
          setActionCounts(result.archive, result.restore);
        } catch (e) {
          if (revision === selectionRevision) {
            setActionCounts(0, 0);
            countEl.textContent = "\u5BFE\u8C61\u3092\u53D6\u5F97\u3067\u304D\u307E\u305B\u3093\u3067\u3057\u305F";
            notice(e);
          }
        }
      }, 120);
    }
    updateCount();
    rootSelect.onchange = () => {
      allScope = null;
      void navigate(rootSelect.value);
    };
    bar.querySelector("[data-folder]").addEventListener("click", () => {
      const overlay = openShellOverlay(modal);
      overlay.card.classList.add("ah-panel");
      overlay.card.innerHTML = '<h2>\u30D5\u30A9\u30EB\u30C0\u8FFD\u52A0</h2><input data-path aria-label="\u30D5\u30A9\u30EB\u30C0\u306E\u30D1\u30B9" placeholder="\u753B\u50CF\u30D5\u30A9\u30EB\u30C0\u306E\u7D76\u5BFE\u30D1\u30B9"><div class="ah-controls"><button data-save>\u958B\u304F</button><button data-close>\u9589\u3058\u308B</button><span class="ah-notice"></span></div>';
      overlay.card.querySelector("[data-close]").onclick = () => overlay.close();
      const input = overlay.card.querySelector("[data-path]");
      input.focus();
      const submit = async () => {
        try {
          const root = await api("folders", { path: input.value });
          if (!folders.some((r) => r.type === root.type)) {
            folders.push(root);
            SANDBOXED_TYPES2.push(root.type);
            addRoot(root);
          }
          rootSelect.value = root.type;
          overlay.close();
          await navigate(root.type);
        } catch (e) {
          overlay.card.querySelector(".ah-notice").textContent = e.message;
        }
      };
      overlay.card.querySelector("[data-save]").onclick = submit;
      input.onkeydown = (e) => {
        if (e.key === "Enter") void submit();
      };
    });
    bar.querySelector("[data-all]").disabled = true;
    modal.dialog.addEventListener("hub-loading", ((e) => {
      relationButton.disabled = true;
      if (!e.detail.preserve) {
        allScope = null;
        listing = null;
        clearSelection();
        updateCount();
      }
      bar.querySelector("[data-all]").disabled = true;
    }));
    bar.querySelector("[data-all]").addEventListener("click", () => {
      clearSelection();
      selectAll();
      if (listing?.token && !query()?.safeHide) {
        allScope = { ...query() };
      } else allScope = null;
      updateCount();
    });
    bar.querySelector("[data-clear]").addEventListener("click", () => {
      allScope = null;
      clearSelection();
      updateCount();
    });
    modal.dialog.addEventListener("hub-selection", ((e) => {
      selectedCount = e.detail.count;
      updateCount();
    }));
    modal.dialog.addEventListener("hub-user-selection", () => {
      allScope = null;
      updateCount();
    });
    modal.dialog.addEventListener("hub-list", ((e) => {
      listing = e.detail;
      relationButton.disabled = !listing.file_count;
      bar.querySelector("[data-all]").disabled = !listing.file_count;
      if (allScope) {
        const { token: oldToken, ...previous } = allScope, { token: newToken, ...next } = listing.query;
        allScope = JSON.stringify(previous) === JSON.stringify(next) ? { ...listing.query } : null;
      }
      if (allScope) setTimeout(selectAll, 0);
      rootSelect.value = listing.query.type;
      updateCount();
      setTimeout(() => void refreshAssets().catch(notice), 0);
      bar.querySelector("[data-all]").setAttribute("title", listing.query.safeHide ? "\u3053\u306E\u30DA\u30FC\u30B8\u306E\u8868\u793A\u753B\u50CF\u3092\u5168\u9078\u629E" : "\u30DA\u30FC\u30B8\u5916\u3082\u542B\u3081\u691C\u7D22\u7D50\u679C\u306E\u753B\u50CF\u3092\u5168\u9078\u629E");
    }));
    bar.querySelector("[data-archive]").addEventListener("click", async () => {
      try {
        if (!selectionPlan?.archive) return;
        const plan = selectionPlan.plan;
        selectionPlan = null;
        setActionCounts(0, 0);
        const job = await api("prepare", { plan, archive: true, workers: concurrency });
        allScope = null;
        clearSelection();
        updateCount();
        notice("");
        showSubmitted(job);
        schedulePoll();
      } catch (e) {
        notice(e);
      }
    });
    bar.querySelector("[data-history]").addEventListener("click", () => void openHistory());
    function showSubmitted(job) {
      progressView.showSubmitted(job);
    }
    function schedulePoll() {
      statusRevision++;
      clearTimeout(pollTimer);
      if (polling) {
        pollRequested = true;
        return;
      }
      pollTimer = setTimeout(poll, 100);
    }
    async function poll() {
      if (!modal.dialog.isConnected) return;
      if (polling) {
        pollRequested = true;
        return;
      }
      polling = true;
      let delay = 3e3;
      try {
        const revision = performanceRevision, codecRevision = compressionRevision, requestRevision = statusRevision, historyKey = historyState + ":" + historyOffset;
        const state = await status(!panel), job = state.job, running = job?.status === "running";
        if (!modal.dialog.isConnected || requestRevision !== statusRevision) return;
        const rate = recentRate.sample(job, performance.now());
        delay = running ? 1e3 : 3e3;
        if (codecRevision === compressionRevision && !savingCompression) {
          const available = ["size", "speed"].includes(state.compression);
          if (!available && !compressionSelect.querySelector('[value="unavailable"]')) compressionSelect.add(new Option("\u518D\u8D77\u52D5\u3067\u6709\u52B9", "unavailable"));
          if (available) compressionSelect.querySelector('[value="unavailable"]')?.remove();
          compressionSelect.value = available ? state.compression : "unavailable";
          compressionSelect.disabled = !available;
        }
        if (firstStatus) {
          lastJob = job?.id || "";
          firstStatus = false;
        }
        if (revision === performanceRevision && !savingPerformance) {
          const target = state.performance.cpu_target === null ? "full" : String(state.performance.cpu_target);
          concurrency = running ? job.workers : state.performance.workers;
          if (!Array.from(cpuSelect.options).some((o) => o.value === target)) cpuSelect.add(new Option(`CPU\u76EE\u6A19 ${target}%`, target));
          if (!Array.from(workerSelect.options).some((o) => o.value === String(concurrency))) workerSelect.add(new Option(`${concurrency}\u4E26\u5217`, String(concurrency)));
          cpuSelect.value = target;
          workerSelect.value = String(concurrency);
          workerSelect.disabled = cpuSelect.disabled = false;
        }
        if (running || galleryDirty || job && lastJob !== job.id) await refreshAssets();
        if (!modal.dialog.isConnected || requestRevision !== statusRevision) return;
        const progressText = progressView.render(state, rate);
        for (const card of modal.dialog.querySelectorAll(".ib-card.is-file")) {
          const name = card.dataset.name;
          card.classList.toggle("ah-processing", running && (job.running || []).some((item) => typeof item === "object" ? item.name === name : [assets.get(item)?.item.name, assets.get(item)?.target_name].includes(name)));
        }
        if (job) {
          if (panel) panel.card.querySelector("[data-job]").textContent = progressText;
          if (!running && lastJob !== job.id) {
            lastJob = job.id;
            if (allScope || selectedCount) updateCount();
            galleryDirty = true;
            if (!panel && !selectedCount && !allScope) {
              galleryDirty = false;
              void refresh().catch(notice);
            }
          }
        }
        if (panel && state.records && historyKey === historyState + ":" + historyOffset) renderHistory(state);
      } catch (e) {
        notice(e);
      } finally {
        polling = false;
        if (modal.dialog.isConnected) {
          clearTimeout(pollTimer);
          pollTimer = setTimeout(poll, pollRequested ? 100 : delay);
        }
        pollRequested = false;
      }
    }
    async function openJobs() {
      const overlay = openShellOverlay(modal);
      overlay.card.classList.add("ah-panel");
      let offset = 0, errorKey = "", errorOffset = 0;
      overlay.card.innerHTML = '<div class="ah-head"><h2>\u51E6\u7406\u5C65\u6B74</h2><button data-close>\u9589\u3058\u308B</button></div><div class="ah-records" data-tasks></div><div class="ah-controls"><button data-back hidden>\u4E00\u89A7\u3078</button><button data-prev>\u524D\u3078</button><span data-page></span><button data-next>\u6B21\u3078</button><button data-refresh>\u66F4\u65B0</button></div><span class="ah-notice" role="status"></span>';
      const card = overlay.card, rows = card.querySelector("[data-tasks]");
      card.querySelector("[data-close]").onclick = () => overlay.close();
      const fail = (e) => {
        card.querySelector(".ah-notice").textContent = e.message || String(e);
      };
      const load = async () => {
        try {
          const data = errorKey ? await api(`jobs/${errorKey}/errors?offset=${errorOffset}`) : await api(`jobs?offset=${offset}`);
          if (!card.isConnected) return;
          rows.replaceChildren();
          card.querySelector("[data-back]").hidden = !errorKey;
          const position = errorKey ? errorOffset : offset, size = errorKey ? 100 : 20;
          card.querySelector("[data-page]").textContent = `${data.total}\u4EF6 \xB7 ${data.total ? Math.floor(position / size) + 1 : 0}/${Math.ceil(data.total / size)}`;
          card.querySelector("[data-prev]").disabled = position === 0;
          card.querySelector("[data-next]").disabled = position + size >= data.total;
          if (errorKey) {
            for (const error of data.errors) {
              const row = document.createElement("div");
              row.className = "ah-task";
              row.textContent = `${error.name} \xB7 ${error.error}`;
              rows.append(row);
            }
            return;
          }
          for (const job of data.jobs) {
            const row = document.createElement("div");
            row.className = "ah-task";
            row.dataset.job = job.id;
            const text = document.createElement("span");
            text.textContent = `${new Date(job.created * 1e3).toLocaleString("ja-JP")} \xB7 ${actionLabels[job.action]} \xB7 ${job.done}/${job.total}\u4EF6 \xB7 ${{ running: "\u51E6\u7406\u4E2D", queued: "\u5F85\u6A5F", paused: "\u4E00\u6642\u505C\u6B62", done: "\u5B8C\u4E86", error: "\u505C\u6B62" }[job.status] || job.status}${job.error_count ? " \xB7 \u5931\u6557 " + job.error_count + "\u4EF6" : ""}${job.name ? " \xB7 " + job.name + (job.total > 1 ? " \u307B\u304B" : "") : ""}`;
            row.append(text);
            const button = (label, handler) => {
              const b = document.createElement("button");
              b.textContent = label;
              b.onclick = async () => {
                b.disabled = true;
                try {
                  await handler();
                } catch (e) {
                  fail(e);
                  b.disabled = false;
                }
              };
              row.append(b);
            };
            if (!["running", "queued"].includes(job.status)) {
              if (job.remaining) button("\u518D\u958B", async () => {
                await api(`jobs/${job.id}/resume`, {});
                lastJob = "";
                schedulePoll();
                await load();
              });
              else if (job.error_count) button("\u5931\u6557\u5206\u3092\u518D\u8A66\u884C", async () => {
                await api(`jobs/${job.id}/resume`, { retry: true });
                lastJob = "";
                schedulePoll();
                await load();
              });
            }
            if (job.error_count) button("\u5931\u6557\u306E\u8A73\u7D30", async () => {
              errorKey = job.id;
              errorOffset = 0;
              await load();
            });
            rows.append(row);
          }
        } catch (e) {
          fail(e);
        }
      };
      card.querySelector("[data-back]").onclick = () => {
        errorKey = "";
        void load();
      };
      card.querySelector("[data-prev]").onclick = () => {
        if (errorKey) errorOffset = Math.max(0, errorOffset - 100);
        else offset = Math.max(0, offset - 20);
        void load();
      };
      card.querySelector("[data-next]").onclick = () => {
        if (errorKey) errorOffset += 100;
        else offset += 20;
        void load();
      };
      card.querySelector("[data-refresh]").onclick = () => void load();
      await load();
    }
    function closeHistory() {
      panel?.close();
      panel = null;
      rowCache.clear();
      panelPage = "";
      if (galleryDirty && !selectedCount && !allScope) {
        galleryDirty = false;
        void refresh().catch(notice);
      }
    }
    async function openHistory() {
      if (panel) return;
      panel = openShellOverlay(modal, { onDismiss: () => {
        panel = null;
        rowCache.clear();
        panelPage = "";
      } });
      panel.card.classList.add("ah-panel");
      panel.card.innerHTML = '<div class="ah-head"><h2>\u4FDD\u7BA1\u30FB\u5FA9\u5143</h2><button data-close>\u9589\u3058\u308B</button></div><div class="ah-controls"><select data-state aria-label="\u4FDD\u7BA1\u72B6\u614B"><option value="">\u3059\u3079\u3066</option><option value="prepared">\u5019\u88DC</option><option value="compacted">WebP</option><option value="restored">PNG\u306B\u5FA9\u5143\u6E08\u307F</option></select><button data-all>\u5168\u9078\u629E</button><button data-clear>\u89E3\u9664</button><span data-count class="ah-count"></span><button data-op="commit">\u4FDD\u7BA1</button><button data-op="restore">PNG\u306B\u623B\u3059</button><button data-op="discard">\u5019\u88DC\u7834\u68C4</button></div><div data-metrics class="ah-detail"></div><div data-job class="ah-progress"></div><div class="ah-records"></div><div class="ah-controls"><button data-prev>\u524D\u3078</button><span data-page class="ah-detail"></span><button data-next>\u6B21\u3078</button><span data-error class="ah-notice" role="status"></span></div><details class="ah-detail"><summary>\u4FDD\u7BA1\u306B\u3064\u3044\u3066</summary>\u753B\u7D20\u30FB\u751F\u6210\u60C5\u5831\u3092\u4FDD\u6301\u3057\u3066WebP\u3078\u7F6E\u304D\u63DB\u3048\u307E\u3059\u3002PNG\u306E\u5143\u30D0\u30A4\u30C8\u5217\u3068\u306F\u7570\u306A\u308A\u307E\u3059\u3002PNG\u3067\u53D6\u308A\u51FA\u3059\u969B\u306B\u81EA\u52D5\u5FA9\u5143\u3057\u307E\u3059\u3002\u5C55\u958B\u30AD\u30E3\u30C3\u30B7\u30E5\u306F\u6700\u5927512MB\u3002</details>';
      panel.card.querySelector("[data-close]").onclick = closeHistory;
      const stateSelect = panel.card.querySelector("[data-state]");
      stateSelect.value = historyState;
      stateSelect.onchange = async () => {
        historyState = stateSelect.value;
        historyOffset = 0;
        historyAll = false;
        historySelected.clear();
        await reloadHistory();
      };
      panel.card.querySelector("[data-all]").onclick = () => {
        historyAll = true;
        historySelected.clear();
        historyRows.forEach((r) => historySelected.add(r.id));
        updateHistorySelection();
      };
      panel.card.querySelector("[data-clear]").onclick = () => {
        historyAll = false;
        historySelected.clear();
        updateHistorySelection();
      };
      panel.card.querySelector("[data-prev]").onclick = async () => {
        historyOffset = Math.max(0, historyOffset - 100);
        await reloadHistory();
      };
      panel.card.querySelector("[data-next]").onclick = async () => {
        historyOffset += 100;
        await reloadHistory();
      };
      for (const button of panel.card.querySelectorAll("[data-op]")) button.onclick = () => void operate(button.dataset.op);
      const rows = panel.card.querySelector(".ah-records");
      rows.addEventListener("click", (event) => {
        const target = event.target;
        if (target.closest("button")) return;
        const row = target.closest("[data-id]");
        if (!row) return;
        const index = historyRows.findIndex((r) => r.id === row.dataset.id);
        if (event.shiftKey) {
          for (let i = Math.min(historyAnchor < 0 ? index : historyAnchor, index); i <= Math.max(historyAnchor < 0 ? index : historyAnchor, index); i++) historySelected.add(historyRows[i].id);
        } else {
          const checked = target.tagName === "INPUT" ? target.checked : !historySelected.has(row.dataset.id);
          if (checked) historySelected.add(row.dataset.id);
          else historySelected.delete(row.dataset.id);
          historyAnchor = index;
        }
        historyAll = false;
        updateHistorySelection();
      });
      await reloadHistory();
    }
    async function reloadHistory() {
      try {
        renderHistory(await status());
      } catch (e) {
        notice(e);
      }
    }
    function updateHistorySelection() {
      if (!panel) return;
      for (const [id, row] of rowCache) {
        const checked = historyAll || historySelected.has(id);
        row.input.checked = checked;
        row.el.classList.toggle("is-selected", checked);
      }
      panel.card.querySelector("[data-count]").textContent = historyAll ? `\u5168${historyTotal}\u4EF6` : historySelected.size ? `${historySelected.size}\u4EF6` : "";
    }
    function renderHistory(state) {
      if (!panel) return;
      historyTotal = state.total;
      historyRows = state.records;
      const rows = panel.card.querySelector(".ah-records"), key = historyState + ":" + historyOffset;
      if (panelPage !== key) {
        rows.replaceChildren();
        rowCache.clear();
        historyAnchor = -1;
        panelPage = key;
      }
      const keep = new Set(historyRows.map((r) => r.id));
      for (const [id, row] of rowCache) if (!keep.has(id)) {
        row.el.remove();
        rowCache.delete(id);
      }
      for (let index = 0; index < historyRows.length; index++) {
        const r = historyRows[index];
        historyStates.set(r.id, r.state);
        let row = rowCache.get(r.id);
        if (!row) {
          const el = document.createElement("div");
          el.className = "ah-record";
          el.dataset.id = r.id;
          el.innerHTML = `<input type="checkbox" aria-label="${esc(r.item.name)}"><img class="ah-record-thumb" loading="lazy" alt=""><span><strong></strong><small></small></span><button data-download>PNG\u3067\u53D6\u308A\u51FA\u3059</button>`;
          row = { el, input: el.querySelector("input"), name: el.querySelector("strong"), detail: el.querySelector("small"), download: el.querySelector("button") };
          rowCache.set(r.id, row);
          row.download.onclick = () => void downloadPNG(r.id, row.download);
        }
        row.name.textContent = r.item.name;
        const thumb2 = row.el.querySelector("img");
        const url = imageThumbURL(r.item.type, r.item.subfolder, r.state === "compacted" ? r.target_name : r.item.name, "", r.state + ":" + r.webp_hash);
        if (thumb2.getAttribute("src") !== url) {
          thumb2.src = url;
          thumb2.onerror = () => thumb2.style.opacity = ".2";
          thumb2.onload = () => thumb2.style.opacity = "1";
        }
        row.detail.textContent = `${rootLabel(r.item.type)}${r.item.subfolder ? "/" + r.item.subfolder : ""} \xB7 ${labels[r.state] || r.state} \xB7 ${mb(r.original_bytes)}${r.state === "not_smaller" ? "" : ` \u2192 ${mb(r.webp_bytes)}`}`;
        row.download.hidden = !["prepared", "placing", "compacted"].includes(r.state);
        if (rows.children[index] !== row.el) rows.insertBefore(row.el, rows.children[index] || null);
      }
      panel.card.querySelector("[data-metrics]").textContent = `\u524A\u6E1B ${mb(state.saved_bytes)} \xB7 \u5019\u88DC ${mb(state.staged_bytes)} \xB7 \u5C55\u958B\u30AD\u30E3\u30C3\u30B7\u30E5 ${mb(state.cache_bytes)}`;
      panel.card.querySelector("[data-page]").textContent = `${state.total}\u4EF6 \xB7 ${state.total ? Math.floor(historyOffset / 100) + 1 : 0}/${Math.ceil(state.total / 100)}`;
      panel.card.querySelector("[data-prev]").disabled = historyOffset === 0;
      panel.card.querySelector("[data-next]").disabled = historyOffset + 100 >= state.total;
      panel.card.querySelector("[data-error]").textContent = state.job?.error_count ? `${state.job.error_count}\u4EF6\u5931\u6557 \xB7 ${state.job.errors.at(-1)?.error || ""}` : "";
      updateHistorySelection();
    }
    async function downloadPNG(id, button) {
      if (button.disabled) return;
      button.disabled = true;
      button.textContent = "\u5FA9\u5143\u4E2D\u2026";
      try {
        const response = await fetch("/asset_hub/png/" + id);
        if (!response.ok) throw Error((await response.json()).error);
        const blob = await response.blob(), url = URL.createObjectURL(blob), link = document.createElement("a");
        link.href = url;
        link.download = historyRows.find((r) => r.id === id)?.item.name || "restored.png";
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 6e4);
      } catch (e) {
        notice(e);
      } finally {
        button.disabled = false;
        button.textContent = "PNG\u3067\u53D6\u308A\u51FA\u3059";
      }
    }
    async function operate(action) {
      try {
        const allowed = action === "commit" ? ["prepared", "placing"] : action === "restore" ? ["compacted"] : ["prepared"];
        let body;
        if (historyAll && (!historyState || allowed.includes(historyState))) body = { action, all_state: historyState || "*" };
        else {
          const ids = [...historySelected].filter((id) => allowed.includes(historyStates.get(id) || ""));
          if (!ids.length) {
            panel.card.querySelector("[data-error]").textContent = `${actionLabels[action]}\u3067\u304D\u308B\u753B\u50CF\u3092\u9078\u3093\u3067\u304F\u3060\u3055\u3044\u3002`;
            return;
          }
          body = { action, ids };
        }
        const job = await api("operate", { ...body, workers: concurrency });
        historyAll = false;
        historySelected.clear();
        updateHistorySelection();
        showSubmitted(job);
        schedulePoll();
      } catch (e) {
        if (panel) panel.card.querySelector("[data-error]").textContent = e.message;
        else notice(e);
      }
    }
    void poll();
  } });
}
app2.registerExtension({
  name: "local.asset-hub",
  settings: [...safeViewSettings()],
  commands: [{ id: "asset-hub.open", label: "\u7D20\u6750\u5EAB\u3092\u958B\u304F", function: openHub }],
  menuCommands: [{ path: ["Extensions"], commands: ["asset-hub.open"] }],
  actionBarButtons: [{ icon: "pi pi-images", label: "\u7D20\u6750\u5EAB", tooltip: "\u753B\u50CF\u3068\u751F\u6210\u30B0\u30E9\u30D5\u306E\u7BA1\u7406", onClick: openHub }],
  setup() {
    const legacyButton = document.createElement("button");
    legacyButton.dataset.assetHubLauncher = "";
    legacyButton.textContent = "\u7D20\u6750\u5EAB";
    legacyButton.title = "\u7D20\u6750\u5EAB\u3092\u958B\u304F";
    legacyButton.onclick = () => void openHub();
    const legacyMenu = app2.ui.menuContainer;
    legacyMenu.insertBefore(legacyButton, legacyMenu.children[1] || null);
    app2.extensionManager.registerSidebarTab({
      id: "asset-hub",
      icon: "pi pi-images",
      title: "\u7D20\u6750\u5EAB",
      label: "\u7D20\u6750\u5EAB",
      tooltip: "\u7D20\u6750\u5EAB\u3092\u958B\u304F",
      type: "custom",
      async onToggle() {
        await openHub();
        return true;
      },
      render(element) {
        const button = document.createElement("button");
        button.textContent = "\u7D20\u6750\u5EAB\u3092\u958B\u304F";
        button.onclick = () => void openHub();
        element.replaceChildren(button);
      }
    });
  }
});
export {
  openHub
};
