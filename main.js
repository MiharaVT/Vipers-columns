/*
 * Viper's Columns — Obsidian plugin
 * Block drag-and-drop, column fences, and related editing in Live Preview.
 */

const obsidian = require('obsidian');

const BLOCK_DND_COLUMNS_LANG = 'block-dnd-columns';
const COLUMN_BODY_SEP = '\n---\n';
const MIN_COL_WIDTH_PCT = 12;

/** Modifier keys that must be held (desktop) to reveal drag handles */
const HANDLE_REVEAL_MODIFIER_CODES = {
    alt: ['AltLeft', 'AltRight'],
    control: ['ControlLeft', 'ControlRight'],
    meta: ['MetaLeft', 'MetaRight'],
    shift: ['ShiftLeft', 'ShiftRight']
};

/** Sync modifier-held state from KeyboardEvent (works when Obsidian swallows KeyY codes). */
function readRevealModifierHeld(e, modifierSetting) {
    const m = modifierSetting || 'alt';
    if (m === 'alt') return !!e.altKey;
    if (m === 'control') return !!e.ctrlKey;
    if (m === 'meta') return !!e.metaKey;
    if (m === 'shift') return !!e.shiftKey;
    return false;
}

const DEFAULT_SETTINGS = {
    /**
     * When false, Notion-style block drag handles (⋮⋮) never appear.
     * Column layouts still work via the right-click menu.
     */
    enableBlockDragHandles: false,
    showHandleOnHover: true,
    /** One of: alt | control | meta | shift */
    handleRevealModifier: 'alt',
    /** When true, mobile ignores hotkey and always shows handles when the row is visible */
    alwaysShowHandlesMobile: true,
    /**
     * When true, Obsidian's built-in `</>` edit-block button is shown on column
     * fences. When false, it is hidden for Viper's Columns blocks only.
     */
    showColumnEditButton: true
};

const VIPERS_COLUMNS_HIDE_EDIT_BUTTON_CLASS = 'vipers-columns-hide-edit-button';

function randomBlockId() {
    return 'bdnd-' + Math.random().toString(36).slice(2, 12) + Math.random().toString(36).slice(2, 12);
}

function equalWidthPercents(n) {
    if (n < 1) return [100];
    const base = 100 / n;
    const arr = [];
    let sum = 0;
    for (let i = 0; i < n - 1; i++) {
        const v = Math.round(base * 1000) / 1000;
        arr.push(v);
        sum += v;
    }
    arr.push(Math.round((100 - sum) * 1000) / 1000);
    return arr;
}

function parseColumnFenceSource(source) {
    const nl = source.indexOf('\n');
    if (nl === -1) return null;
    const metaLine = source.slice(0, nl).trim();
    const inner = source.slice(nl + 1);
    let meta;
    try {
        meta = JSON.parse(metaLine);
    } catch {
        return null;
    }
    if (!meta.id || typeof meta.n !== 'number' || !Array.isArray(meta.widths)) return null;
    let bodies = inner.split(COLUMN_BODY_SEP);
    if (bodies.length === 1 && meta.n > 1 && !inner.includes('\n---\n')) {
        bodies = Array.from({ length: meta.n }, (_, i) => (i === 0 ? bodies[0] : ''));
    }
    while (bodies.length < meta.n) bodies.push('');
    if (bodies.length > meta.n) {
        bodies = [...bodies.slice(0, meta.n - 1), bodies.slice(meta.n - 1).join(COLUMN_BODY_SEP)];
    }
    return { meta, bodies };
}

function serializeColumnFence(meta, bodies) {
    return JSON.stringify(meta) + '\n' + bodies.join(COLUMN_BODY_SEP);
}

function columnBodiesEqual(a, b) {
    if (!a || !b || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
        if (String(a[i] ?? '') !== String(b[i] ?? '')) return false;
    }
    return true;
}

function isColumnPlainEnterKey(e) {
    return e.key === 'Enter' && !e.ctrlKey && !e.metaKey && !e.altKey && !e.isComposing;
}

function isColumnTabKey(e) {
    return e.key === 'Tab' && !e.ctrlKey && !e.metaKey && !e.altKey && !e.isComposing;
}

/** Insert a newline at the caret without letting Obsidian/CM handle Enter. */
function insertNewlineInColumnTextarea(ta) {
    if (!(ta instanceof HTMLTextAreaElement)) return;
    const start = typeof ta.selectionStart === 'number' ? ta.selectionStart : ta.value.length;
    const end = typeof ta.selectionEnd === 'number' ? ta.selectionEnd : start;
    const value = ta.value ?? '';
    ta.value = value.slice(0, start) + '\n' + value.slice(end);
    const caret = start + 1;
    try {
        ta.setSelectionRange(caret, caret);
    } catch {
        /* noop */
    }
    // Notify listeners (row sizing / preview) without relying on the browser Enter default.
    try {
        ta.dispatchEvent(new Event('input', { bubbles: true }));
    } catch {
        /* noop */
    }
}

function captureColumnEditorFocus(root) {
    const ae = document.activeElement;
    if (!(ae instanceof HTMLTextAreaElement) || !ae.classList.contains('block-dnd-col-editor')) {
        return null;
    }
    if (!(root instanceof HTMLElement) || !root.contains(ae)) return null;
    const list = root.querySelectorAll('.block-dnd-col-editor');
    const idx = Array.prototype.indexOf.call(list, ae);
    if (idx < 0) return null;
    return {
        idx,
        start: typeof ae.selectionStart === 'number' ? ae.selectionStart : (ae.value || '').length,
        end: typeof ae.selectionEnd === 'number' ? ae.selectionEnd : (ae.value || '').length,
    };
}

function restoreColumnEditorFocus(uuid, focus) {
    if (!focus || typeof focus.idx !== 'number') return;
    const tryRestore = () => {
        const newRoot = document.querySelector(
            `.block-dnd-columns-root[data-block-dnd-id="${uuid}"]`
        );
        if (!(newRoot instanceof HTMLElement)) return false;
        const list = newRoot.querySelectorAll('.block-dnd-col-editor');
        const ta = list[focus.idx];
        if (!(ta instanceof HTMLTextAreaElement)) return false;
        try {
            ta.focus({ preventScroll: true });
            const len = (ta.value || '').length;
            const start = Math.max(0, Math.min(len, focus.start ?? len));
            const end = Math.max(0, Math.min(len, focus.end ?? start));
            ta.setSelectionRange(start, end);
        } catch {
            /* noop */
        }
        return document.activeElement === ta;
    };
    if (tryRestore()) return;
    requestAnimationFrame(() => {
        if (tryRestore()) return;
        window.setTimeout(tryRestore, 50);
        window.setTimeout(tryRestore, 160);
    });
}

/**
 * Place the caret in a textarea near a click after mousedown preventDefault
 * (which otherwise leaves the caret at the end / previous offset).
 */
function setTextareaCaretFromClick(ta, clientX, clientY) {
    if (!(ta instanceof HTMLTextAreaElement) || typeof ta.setSelectionRange !== 'function') return;
    try {
        const rect = ta.getBoundingClientRect();
        const style = window.getComputedStyle(ta);
        const paddingLeft = parseFloat(style.paddingLeft) || 0;
        const paddingTop = parseFloat(style.paddingTop) || 0;
        const x = clientX - rect.left - paddingLeft + ta.scrollLeft;
        const y = clientY - rect.top - paddingTop + ta.scrollTop;
        const fontSize = parseFloat(style.fontSize) || 16;
        const lineHeight = parseFloat(style.lineHeight) || fontSize * 1.5;
        const line = Math.max(0, Math.floor(y / Math.max(1, lineHeight)));
        const lines = String(ta.value || '').split('\n');
        if (line >= lines.length) {
            ta.setSelectionRange(ta.value.length, ta.value.length);
            return;
        }
        const ctx2d = setTextareaCaretFromClick._ctx || (setTextareaCaretFromClick._ctx = document.createElement('canvas').getContext('2d'));
        if (ctx2d) ctx2d.font = style.font || `${style.fontSize} ${style.fontFamily}`;
        const text = lines[line];
        let col = text.length;
        if (ctx2d) {
            for (let i = 0; i <= text.length; i++) {
                const w = ctx2d.measureText(text.slice(0, i)).width;
                if (w >= x) {
                    const prev = i === 0 ? 0 : ctx2d.measureText(text.slice(0, i - 1)).width;
                    col = x - prev < w - x ? Math.max(0, i - 1) : i;
                    break;
                }
            }
        }
        col = Math.max(0, Math.min(text.length, col));
        let abs = 0;
        for (let i = 0; i < line; i++) abs += lines[i].length + 1;
        abs += col;
        ta.setSelectionRange(abs, abs);
    } catch {
        /* noop */
    }
}

/**
 * Wiki embeds `![[path]]` / `![[path|316]]` / `![[path|316x200]]` / `![[path|alias]]`.
 * Pipe suffix may be dimensions or an alias — dimensions are parsed when numeric.
 */
const BDND_WIKI_EMBED_RE_SOURCE = '!\\[\\[([^\\]#|]+?)(?:\\|([^\\]]*))?\\]\\]';

const BDND_IMAGE_ACCEPT_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp']);

function bdndWikiMatchFromExec(m) {
    const pipe = m[2];
    let width = null;
    let height = null;
    if (pipe) {
        const dim = String(pipe).match(/^(\d+)(?:x(\d+))?$/);
        if (dim) {
            width = parseInt(dim[1], 10);
            height = dim[2] !== undefined ? parseInt(dim[2], 10) : null;
        }
    }
    return {
        fullFrom: m.index,
        fullTo: m.index + m[0].length,
        linkPathRaw: m[1] ?? '',
        width,
        height,
        pipe: pipe ?? null,
        raw: m[0],
    };
}

function bdndFindWikiEmbedContaining(doc, pos) {
    const re = new RegExp(BDND_WIKI_EMBED_RE_SOURCE, 'g');
    let cm;
    while ((cm = re.exec(doc)) !== null) {
        const hit = bdndWikiMatchFromExec(cm);
        if (pos >= hit.fullFrom && pos < hit.fullTo) return hit;
    }
    return null;
}

function bdndIsPreviewImageExt(ext) {
    return BDND_IMAGE_ACCEPT_EXT.has(ext.toLowerCase());
}

function bdndImageSrcLikelyFromFile(src, file, app) {
    if (src.includes(encodeURIComponent(file.path))) return true;
    try {
        const rp = app.vault.getResourcePath(file);
        if (rp && src.includes(rp)) return true;
    } catch {
        /* noop */
    }
    if (file.name && src.includes(file.name)) return true;
    return false;
}

/** Map Obsidian-rendered `<img>` in a column preview back to a wiki embed in `doc`. */
function bdndFindWikiEmbedForImgSrc(doc, img, app, sourceNotePath) {
    const src = img.currentSrc || img.src || '';
    const re = new RegExp(BDND_WIKI_EMBED_RE_SOURCE, 'g');
    let cm;
    while ((cm = re.exec(doc)) !== null) {
        const hit = bdndWikiMatchFromExec(cm);
        const dest = app.metadataCache.getFirstLinkpathDest(hit.linkPathRaw, sourceNotePath);
        if (dest instanceof obsidian.TFile && bdndIsPreviewImageExt(dest.extension) && bdndImageSrcLikelyFromFile(src, dest, app)) {
            return hit;
        }
    }
    return null;
}

/** Follow the Zotion plugin's settings when enabled; sane defaults otherwise. Falls back if that plugin isn't loaded. */
function getBdndZotionCompatSettings(app) {
    const zPlugin = app?.plugins?.plugins?.['zotion'];
    const s = zPlugin?.settings ?? {};
    return {
        onlyPng: !!s.onlyPng,
        defaultDropWidth: typeof s.defaultDropWidth === 'number' ? s.defaultDropWidth : 400,
        minWidth: typeof s.minWidth === 'number' ? s.minWidth : 80,
        maxWidth: typeof s.maxWidth === 'number' ? s.maxWidth : 2000,
        minHeight: typeof s.minHeight === 'number' ? s.minHeight : 60,
        maxHeight: typeof s.maxHeight === 'number' ? s.maxHeight : 2000,
        snap: typeof s.snap === 'number' ? s.snap : 1,
    };
}

function bdndClamp(n, lo, hi) {
    return Math.max(lo, Math.min(hi, n));
}

function bdndSnap(v, snap) {
    if (snap <= 1) return Math.round(v);
    return Math.round(v / snap) * snap;
}

function bdndApplyDefaultWidth(embed, width) {
    const wiki = /^(!\[\[)([^\]|]+)(?:\|\d+(?:x\d+)?)?(\]\])$/;
    const mWiki = embed.match(wiki);
    if (mWiki) return `${mWiki[1]}${mWiki[2]}|${width}${mWiki[3]}`;
    return embed;
}

async function bdndBuildImageEmbedMarkdown(app, file, sourceNotePath, defaultWidth) {
    let linkMd = await app.fileManager.generateMarkdownLink(file, sourceNotePath);
    let embed = linkMd;
    if (!embed.startsWith('!')) {
        if (embed.startsWith('[[')) embed = `!${embed}`;
        else if (embed.startsWith('[')) embed = `!${embed}`;
        else embed = `![[${obsidian.normalizePath(file.path)}]]`;
    }
    if (defaultWidth > 0) embed = bdndApplyDefaultWidth(embed, defaultWidth);
    return embed;
}

function bdndAllowColumnImageExt(ext, onlyPng) {
    const e = ext.toLowerCase();
    if (onlyPng) return e === 'png';
    return BDND_IMAGE_ACCEPT_EXT.has(e);
}

function bdndCollectDroppedFiles(evt, app, sourcePath) {
    const list = [];
    const dm = app.dragManager?.draggable;
    if (dm?.type === 'file' && dm.file instanceof obsidian.TFile) list.push(dm.file);
    if (dm?.type === 'link' && dm.file instanceof obsidian.TFile) list.push(dm.file);
    if (dm?.type === 'files' && Array.isArray(dm.files)) {
        for (const f of dm.files) {
            if (f instanceof obsidian.TFile) list.push(f);
        }
    }
    const dt = evt.dataTransfer;
    if (sourcePath && dt?.getData) {
        const plain = dt.getData('text/plain')?.trim?.();
        if (plain) {
            let dest = null;
            const wiki = plain.match(/^\[\[([^\]]+)\]\]$/);
            if (wiki?.[1]) dest = app.metadataCache.getFirstLinkpathDest(wiki[1], sourcePath);
            if (!dest) {
                const np = obsidian.normalizePath(plain.replace(/\\/g, '/'));
                dest = app.vault.getAbstractFileByPath(np) ?? app.metadataCache.getFirstLinkpathDest(plain, sourcePath);
            }
            if (dest instanceof obsidian.TFile) list.push(dest);
        }
    }
    if (dt?.files?.length) {
        for (let i = 0; i < dt.files.length; i++) {
            const blob = dt.files.item(i);
            const fp = blob?.path;
            if (!fp || typeof fp !== 'string') continue;
            const baseRaw = app.vault.adapter?.getBasePath?.() ?? app.vault.adapter?.basePath;
            if (!baseRaw) continue;
            const base = obsidian.normalizePath(String(baseRaw).replace(/\\/g, '/'));
            const normAbs = obsidian.normalizePath(fp.replace(/\\/g, '/'));
            if (!normAbs.startsWith(base)) continue;
            const rel = normAbs.slice(base.length).replace(/^\/+/, '');
            const af = rel ? app.vault.getAbstractFileByPath(rel) : null;
            if (af instanceof obsidian.TFile) list.push(af);
        }
    }
    const seen = new Set();
    return list.filter((f) => {
        if (seen.has(f.path)) return false;
        seen.add(f.path);
        return true;
    });
}

function textareaReplaceSlice(ta, from, to, insert) {
    const v = ta.value;
    const next = v.slice(0, from) + insert + v.slice(to);
    if (next === v) return;
    const delta = insert.length - (to - from);
    const anchor = ta.selectionDirection === 'backward' ? ta.selectionEnd : ta.selectionStart;
    ta.value = next;
    const caret = bdndClamp(typeof anchor === 'number' ? anchor : from + insert.length, 0, next.length);
    const pos = caret >= from + (to - from) ? caret + delta : caret;
    try {
        ta.setSelectionRange(Math.min(pos, next.length), Math.min(pos, next.length));
    } catch {
        /* noop */
    }
    ta.dispatchEvent(new Event('input', { bubbles: true }));
}

function bdndReplacementWikiDims(hit, width, height) {
    const inner = hit.linkPathRaw;
    const w = Math.round(width);
    const hOk = height !== null && height !== undefined && !Number.isNaN(height) && height > 0;
    if (hOk) return `![[${inner}|${w}x${Math.round(height)}]]`;
    return `![[${inner}|${w}]]`;
}

/** Markdown preview under each column cell, drop-to-embed, and wiki image resize (compatible with the Zotion plugin; reuses its CSS classes). */
function bdndRegDom(component, el, type, handler, options) {
    if (typeof component.registerDomEvent === 'function') {
        component.registerDomEvent(el, type, handler, options);
        return;
    }
    el.addEventListener(type, handler, options);
    if (typeof component.register === 'function') {
        component.register(() => el.removeEventListener(type, handler, options));
    }
}

function bdndAttachColumnZotionCompat(ctx) {
    const { app, sourcePath, ta, previewEl, markdownChild, refreshRows } = ctx;

    let selectedImg = null;
    let overlay = null;
    let dragResize = null;
    let rebuildTimer = null;

    function removeOverlay() {
        if (overlay) {
            overlay.remove();
            overlay = null;
        }
        selectedImg = null;
    }

    function makeHandle(axis) {
        const h = document.createElement('div');
        h.className = 'zotion-resize-handle zotion-handle-' + axis;
        h.setAttribute('data-zotion-handle', axis);
        return h;
    }

    function ensureOverlay() {
        if (overlay) return;
        const el = document.createElement('div');
        el.className = 'zotion-resize-overlay';
        ['se', 'e', 'w', 'n', 's'].forEach((axis) => el.appendChild(makeHandle(axis)));
        document.body.appendChild(el);
        overlay = el;
    }

    function updateOverlayRect() {
        if (!overlay || !selectedImg) return;
        const rect = selectedImg.getBoundingClientRect();
        overlay.style.position = 'fixed';
        overlay.style.left = `${rect.left}px`;
        overlay.style.top = `${rect.top}px`;
        overlay.style.width = `${rect.width}px`;
        overlay.style.height = `${rect.height}px`;
        overlay.style.pointerEvents = 'none';
        overlay.style.zIndex = '10050';
        overlay.querySelectorAll('.zotion-resize-handle').forEach((h) => {
            if (!(h instanceof HTMLElement)) return;
            h.style.pointerEvents = 'auto';
            h.style.position = 'absolute';
            h.style.width = '11px';
            h.style.height = '11px';
            h.style.boxSizing = 'border-box';
        });
        const place = (axis, styles) => {
            const hx = overlay?.querySelector(`[data-zotion-handle="${axis}"]`);
            if (!(hx instanceof HTMLElement)) return;
            Object.assign(hx.style, styles);
        };
        place('se', { right: '-3px', bottom: '-3px' });
        place('e', { right: '-3px', top: '50%', transform: 'translateY(-50%)' });
        place('w', { left: '-3px', top: '50%', transform: 'translateY(-50%)' });
        place('n', { top: '-3px', left: '50%', transform: 'translateX(-50%)' });
        place('s', { bottom: '-3px', left: '50%', transform: 'translateX(-50%)' });
    }

    async function rebuildPreview() {
        if (!(previewEl?.isConnected)) return;
        const md = ta.value ?? '';
        while (previewEl.firstChild) previewEl.firstChild.remove();
        removeOverlay();

        // Wiki embeds inside column code-block widgets often render blank via
        // MarkdownRenderer. Draw image-only bodies (and image fallbacks) directly.
        if (bodyLooksLikeImageOnly(md)) {
            bdndRenderWikiImagesDirect(app, md, previewEl, sourcePath);
            if (!previewEl.firstChild) {
                const dv = document.createElement('div');
                dv.className = 'block-dnd-col-image-placeholder';
                dv.textContent = md.trim() || '[Image unavailable]';
                previewEl.appendChild(dv);
            }
            if (typeof refreshRows === 'function') refreshRows();
            updateOverlayRect();
            return;
        }

        try {
            if (typeof obsidian.MarkdownRenderer.render === 'function') {
                await obsidian.MarkdownRenderer.render(app, md, previewEl, sourcePath, markdownChild);
            } else {
                await obsidian.MarkdownRenderer.renderMarkdown(md, previewEl, sourcePath, markdownChild);
            }
            // If renderer left embeds empty, paint wiki images ourselves.
            const hasImg = previewEl.querySelector('img');
            if (!hasImg && new RegExp(BDND_WIKI_EMBED_RE_SOURCE).test(md)) {
                bdndRenderWikiImagesDirect(app, md, previewEl, sourcePath);
            }
        } catch {
            if (bdndRenderWikiImagesDirect(app, md, previewEl, sourcePath) === 0) {
                const dv = document.createElement('div');
                dv.className = 'block-dnd-col-preview-fallback';
                dv.textContent = '[Preview unavailable]';
                previewEl.appendChild(dv);
            }
        }
        if (typeof refreshRows === 'function') refreshRows();
        updateOverlayRect();
    }

    function queueRebuild() {
        if (rebuildTimer !== null) clearTimeout(rebuildTimer);
        rebuildTimer = window.setTimeout(() => {
            rebuildTimer = null;
            void rebuildPreview();
        }, 140);
    }

    function resolveHit(img) {
        const doc = ta.value ?? '';
        return bdndFindWikiEmbedForImgSrc(doc, img, app, sourcePath);
    }

    function selectImg(img) {
        selectedImg = img;
        ensureOverlay();
        updateOverlayRect();
    }

    function teardownResizeDrag() {
        window.removeEventListener('pointermove', onResizeMove, true);
        window.removeEventListener('pointerup', onResizeUp, true);
        dragResize = null;
        if (selectedImg) {
            selectedImg.style.cursor = '';
            selectedImg.style.removeProperty('transform-origin');
        }
    }

    function onResizeMove(ev) {
        if (!dragResize) return;
        ev.preventDefault();
        const zs = getBdndZotionCompatSettings(app);
        const { img, kind, startX, startY, startW, startH } = dragResize;
        const dx = ev.clientX - startX;
        const dy = ev.clientY - startY;

        if (kind === 'e') {
            const nw = bdndSnap(bdndClamp(startW + dx, zs.minWidth, zs.maxWidth), zs.snap);
            img.style.width = `${nw}px`;
            img.style.height = `${startH}px`;
        } else if (kind === 'w') {
            const nw = bdndSnap(bdndClamp(startW - dx, zs.minWidth, zs.maxWidth), zs.snap);
            img.style.width = `${nw}px`;
            img.style.height = `${startH}px`;
        } else if (kind === 'n') {
            const nh = bdndSnap(bdndClamp(startH - dy, zs.minHeight, zs.maxHeight), zs.snap);
            img.style.height = `${nh}px`;
            img.style.width = `${startW}px`;
        } else if (kind === 's') {
            const nh = bdndSnap(bdndClamp(startH + dy, zs.minHeight, zs.maxHeight), zs.snap);
            img.style.height = `${nh}px`;
            img.style.width = `${startW}px`;
        } else if (kind === 'se') {
            const scale = 1 + (dx / startW + dy / startH) / 2;
            const nw = bdndSnap(bdndClamp(startW * scale, zs.minWidth, zs.maxWidth), zs.snap);
            const nh = bdndSnap(bdndClamp(startH * scale, zs.minHeight, zs.maxHeight), zs.snap);
            img.style.width = `${nw}px`;
            img.style.height = `${nh}px`;
        }

        updateOverlayRect();
    }

    function onResizeUp(ev) {
        if (!dragResize) return;
        ev.preventDefault();
        const { img, kind } = dragResize;
        teardownResizeDrag();

        const zs = getBdndZotionCompatSettings(app);
        const rect = img.getBoundingClientRect();
        const dispW = bdndSnap(bdndClamp(Math.round(rect.width), zs.minWidth, zs.maxWidth), zs.snap);
        const dispH = bdndSnap(bdndClamp(Math.round(rect.height), zs.minHeight, zs.maxHeight), zs.snap);

        img.style.width = '';
        img.style.height = '';

        const hit = resolveHit(img);
        if (!hit) {
            removeOverlay();
            void rebuildPreview();
            return;
        }

        let nw;
        let nh;
        if (kind === 'e' || kind === 'w') {
            nw = dispW;
            nh = hit.height !== null && hit.height > 0 ? hit.height : null;
        } else if (kind === 'n' || kind === 's') {
            nh = dispH;
            nw = hit.width !== null && hit.width > 0 ? hit.width : dispW;
        } else {
            nw = dispW;
            nh = dispH;
        }

        const replacement = bdndReplacementWikiDims(hit, nw, nh);
        if (replacement === hit.raw) {
            updateOverlayRect();
            return;
        }

        textareaReplaceSlice(ta, hit.fullFrom, hit.fullTo, replacement);
        void rebuildPreview();
    }

    function beginResizeDrag(kind, clientX, clientY) {
        if (!selectedImg) return;
        teardownResizeDrag();
        const r = selectedImg.getBoundingClientRect();
        dragResize = {
            img: selectedImg,
            kind,
            startX: clientX,
            startY: clientY,
            startW: r.width,
            startH: r.height,
        };
        if (kind === 'w') selectedImg.style.transformOrigin = 'right center';
        else selectedImg.style.removeProperty('transform-origin');
        const cursors = { e: 'ew-resize', w: 'ew-resize', n: 'ns-resize', s: 'ns-resize', se: 'nwse-resize' };
        selectedImg.style.cursor = cursors[kind] || '';

        window.addEventListener('pointermove', onResizeMove, true);
        window.addEventListener('pointerup', onResizeUp, true);
    }

    bdndRegDom(
        markdownChild,
        window,
        'pointerdown',
        (ev) => {
            const target = ev.target;
            if (!(target instanceof Element)) return;

            const axis = target.getAttribute('data-zotion-handle');
            if (target.classList.contains('zotion-resize-handle') && axis && overlay?.contains(target)) {
                ev.preventDefault();
                ev.stopPropagation();
                if (selectedImg) beginResizeDrag(axis, ev.clientX, ev.clientY);
                return;
            }

            if (previewEl.contains(target)) {
                const ig = target.closest('img');
                if (ig instanceof HTMLImageElement && ev.button === 0) {
                    ev.preventDefault();
                    ev.stopPropagation();
                    selectImg(ig);
                    return;
                }
                if (!overlay?.contains(target)) removeOverlay();
                return;
            }

            removeOverlay();
        },
        { capture: true }
    );

    bdndRegDom(markdownChild, ta, 'scroll', updateOverlayRect, { passive: true });
    bdndRegDom(markdownChild, previewEl, 'scroll', updateOverlayRect, { passive: true });

    bdndRegDom(markdownChild, ta, 'dragover', (e) => {
        e.preventDefault();
        const zs = getBdndZotionCompatSettings(app);
        if (zs.onlyPng) e.dataTransfer.dropEffect = 'copy';
        else e.dataTransfer.dropEffect = 'copy';
    });

    bdndRegDom(markdownChild, ta, 'drop', async (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        const zs = getBdndZotionCompatSettings(app);
        const dropped = bdndCollectDroppedFiles(ev, app, sourcePath);
        const imgs = dropped.filter((f) => bdndAllowColumnImageExt(f.extension, zs.onlyPng));
        if (!imgs.length) return;

        try {
            const chunks = [];
            for (const f of imgs) {
                const mdChunk = await bdndBuildImageEmbedMarkdown(app, f, sourcePath, zs.defaultDropWidth);
                if (mdChunk) chunks.push(mdChunk);
            }
            if (!chunks.length) return;

            let join = chunks.length === 1 ? chunks[0] : chunks.join('\n');
            join = `\n${join}\n`;

            const startAt = ta.selectionStart ?? ta.value.length;
            const endAt = ta.selectionEnd ?? startAt;

            textareaReplaceSlice(ta, startAt, endAt, join);
            void rebuildPreview();
        } catch {
            /* noop */
        }
    });

    bdndRegDom(markdownChild, ta, 'input', () => queueRebuild());
    bdndRegDom(markdownChild, ta, 'focus', updateOverlayRect);
    bdndRegDom(markdownChild, ta, 'blur', () => {
        queueRebuild();
    });

    if (typeof markdownChild.register === 'function') {
        markdownChild.register(() => {
            if (rebuildTimer !== null) {
                clearTimeout(rebuildTimer);
                rebuildTimer = null;
            }
            teardownResizeDrag();
            removeOverlay();
        });
    }

    void rebuildPreview();
}

function isWikiImageLine(text) {
    const t = (text || '').trim();
    if (!t) return false;
    if (/^!\[.*\]\([^)]+\)$/.test(t)) return true;
    try {
        const re = new RegExp('^(?:' + BDND_WIKI_EMBED_RE_SOURCE + ')$');
        return re.test(t);
    } catch {
        return /^!\[\[.+\]\]$/.test(t);
    }
}

function isSimpleSideParagraphLine(text) {
    const t = (text || '').trim();
    if (!t) return false;
    if (isWikiImageLine(t)) return false;
    if (new RegExp(BDND_WIKI_EMBED_RE_SOURCE).test(t)) return false;
    if (
        t.startsWith('```') ||
        t.startsWith('#') ||
        t.startsWith('>') ||
        t.startsWith('|') ||
        t.startsWith('- ') ||
        t.startsWith('* ') ||
        t.startsWith('+ ') ||
        /^\d+\.\s/.test(t) ||
        t.startsWith('![')
    ) {
        return false;
    }
    return true;
}

/** If a line mixes text + a wiki image, split them so they never mash into one cell. */
function splitMixedImageText(text) {
    const raw = text || '';
    const re = new RegExp(BDND_WIKI_EMBED_RE_SOURCE);
    const m = re.exec(raw);
    if (!m) return null;
    const hit = bdndWikiMatchFromExec(m);
    const before = raw.slice(0, hit.fullFrom).trim();
    const after = raw.slice(hit.fullTo).trim();
    const sideText = [before, after].filter(Boolean).join(' ');
    return { imageMd: hit.raw, sideText };
}

/**
 * Walk forward or backward from a line, skipping up to two blank lines,
 * and return the first matching line via `matchFn`.
 */
function findAdjacentMatchingLine(doc, fromLine0, direction, matchFn) {
    const step = direction === 'before' ? -1 : 1;
    let line0 = fromLine0 + step;
    let skippedBlank = 0;
    while (line0 >= 0 && line0 < doc.lines) {
        const line = doc.line(line0 + 1);
        const raw = line.text;
        const t = raw.trim();
        if (!t) {
            skippedBlank++;
            if (skippedBlank > 2) return null;
            line0 += step;
            continue;
        }
        if (!matchFn(raw)) return null;
        return { text: raw, line0, line };
    }
    return null;
}

/**
 * Find a wiki image line near a document line (Live Preview often resolves the
 * cursor to a neighbor line of the embed widget).
 */
function findWikiImageLineNear(doc, centerLine0, radius = 5) {
    if (typeof centerLine0 !== 'number' || centerLine0 < 0) return null;
    for (let d = 0; d <= radius; d++) {
        const candidates = d === 0 ? [centerLine0] : [centerLine0 - d, centerLine0 + d];
        for (const line0 of candidates) {
            if (line0 < 0 || line0 >= doc.lines) continue;
            const line = doc.line(line0 + 1);
            if (isWikiImageLine(line.text)) {
                return { line0, line, imageMd: line.text.trim(), sideText: '' };
            }
            const mixed = splitMixedImageText(line.text);
            if (mixed?.imageMd) {
                return {
                    line0,
                    line,
                    imageMd: mixed.imageMd,
                    sideText: mixed.sideText || '',
                };
            }
        }
    }
    return null;
}

/**
 * Build a half-width (image | text) pair for "1 Column".
 * Image-first: locate a nearby ![[...]] in the document and always keep it on
 * the left so the replace range cannot delete the picture.
 */
function resolveOneColumnPair(doc, blockStartLine0, blockEndLine0, cursorLine0) {
    const centers = [];
    if (typeof cursorLine0 === 'number') centers.push(cursorLine0);
    if (typeof blockStartLine0 === 'number') centers.push(blockStartLine0);
    if (typeof blockEndLine0 === 'number') centers.push(blockEndLine0);
    // Also search the midpoint of the DOM block range.
    if (
        typeof blockStartLine0 === 'number' &&
        typeof blockEndLine0 === 'number' &&
        blockEndLine0 !== blockStartLine0
    ) {
        centers.push(Math.round((blockStartLine0 + blockEndLine0) / 2));
    }

    let img = null;
    for (const c of centers) {
        img = findWikiImageLineNear(doc, c, 6);
        if (img) break;
    }

    if (img) {
        let right = img.sideText || '';
        let from = img.line.from;
        let to = img.line.to;

        if (!right) {
            const after = findAdjacentMatchingLine(doc, img.line0, 'after', isSimpleSideParagraphLine);
            if (after) {
                right = after.text.trim();
                to = after.line.to;
            } else {
                const before = findAdjacentMatchingLine(doc, img.line0, 'before', isSimpleSideParagraphLine);
                if (before) {
                    right = before.text.trim();
                    from = before.line.from;
                }
            }
        }

        return {
            left: img.imageMd,
            right,
            from,
            to,
        };
    }

    // No image nearby — only wrap the selected block (do not expand in ways that
    // could delete a distant embed).
    const startLine = doc.line(Math.max(0, blockStartLine0) + 1);
    const endLine = doc.line(Math.max(blockStartLine0, blockEndLine0) + 1);
    const selected = doc.sliceString(startLine.from, endLine.to);
    return {
        left: selected,
        right: '',
        from: startLine.from,
        to: endLine.to,
    };
}

function bodyLooksLikeImageOnly(body) {
    const lines = (body || '').split('\n').map((l) => l.trim()).filter(Boolean);
    if (!lines.length) return false;
    if (lines.every(isWikiImageLine)) return true;
    const embeds = (body || '').match(new RegExp(BDND_WIKI_EMBED_RE_SOURCE, 'g')) || [];
    if (embeds.length === 0) return false;
    const without = (body || '').replace(new RegExp(BDND_WIKI_EMBED_RE_SOURCE, 'g'), '').trim();
    return without.length === 0;
}

/** Resolve a wiki link path to a vault image file (handles +/ prefixes, basenames). */
function bdndResolveImageFile(app, linkPathRaw, sourcePath) {
    const raw = (linkPathRaw || '').trim();
    if (!raw || !app) return null;

    const candidates = [];
    const push = (p) => {
        if (p && !candidates.includes(p)) candidates.push(p);
    };
    push(raw);
    push(raw.replace(/^\+\//, ''));
    push(raw.replace(/^\//, ''));
    try {
        push(obsidian.normalizePath(raw));
        push(obsidian.normalizePath(raw.replace(/^\+\//, '')));
    } catch {
        /* noop */
    }
    const base = raw.split('/').pop();
    if (base) push(base);

    for (const c of candidates) {
        try {
            const dest = app.metadataCache.getFirstLinkpathDest(c, sourcePath || '');
            if (dest instanceof obsidian.TFile && bdndIsPreviewImageExt(dest.extension)) return dest;
        } catch {
            /* noop */
        }
        try {
            const af = app.vault.getAbstractFileByPath(obsidian.normalizePath(c));
            if (af instanceof obsidian.TFile && bdndIsPreviewImageExt(af.extension)) return af;
        } catch {
            /* noop */
        }
    }

    if (base) {
        try {
            const files = app.vault.getFiles();
            const hits = files.filter(
                (f) =>
                    bdndIsPreviewImageExt(f.extension) &&
                    (f.name === base || f.path === raw || f.path.endsWith('/' + base))
            );
            if (hits.length >= 1) return hits[0];
        } catch {
            /* noop */
        }
    }
    return null;
}

/**
 * Render wiki image embeds with vault resource URLs.
 * MarkdownRenderer often leaves column-cell embeds blank in Live Preview.
 */
function bdndRenderWikiImagesDirect(app, md, el, sourcePath) {
    const re = new RegExp(BDND_WIKI_EMBED_RE_SOURCE, 'g');
    let match;
    let rendered = 0;
    while ((match = re.exec(md || '')) !== null) {
        const hit = bdndWikiMatchFromExec(match);
        const dest = bdndResolveImageFile(app, hit.linkPathRaw, sourcePath);
        if (!(dest instanceof obsidian.TFile)) {
            // Keep a visible placeholder so the embed is not "gone".
            const ph = document.createElement('div');
            ph.className = 'block-dnd-col-image-placeholder';
            ph.textContent = hit.raw;
            el.appendChild(ph);
            continue;
        }
        const img = document.createElement('img');
        img.className = 'block-dnd-col-direct-img';
        img.alt = dest.basename;
        img.draggable = false;
        try {
            img.src = app.vault.getResourcePath(dest);
        } catch {
            const ph = document.createElement('div');
            ph.className = 'block-dnd-col-image-placeholder';
            ph.textContent = hit.raw;
            el.appendChild(ph);
            continue;
        }
        if (hit.width && hit.width > 0) img.style.width = `${hit.width}px`;
        if (hit.height && hit.height > 0) img.style.height = `${hit.height}px`;
        else img.style.height = 'auto';
        img.style.maxWidth = '100%';
        img.style.display = 'block';
        img.style.position = 'relative';
        el.appendChild(img);
        rendered++;
    }
    return rendered;
}

/** Ensure every wiki embed in oldSlice still appears in column bodies. */
function bdndPreserveEmbedsInBodies(oldSlice, bodies) {
    const embeds = oldSlice.match(new RegExp(BDND_WIKI_EMBED_RE_SOURCE, 'g')) || [];
    if (!embeds.length) return bodies;
    const next = bodies.slice();
    let joined = next.join('\n');
    for (const emb of embeds) {
        if (joined.includes(emb)) continue;
        next[0] = next[0] ? `${emb}\n${next[0]}` : emb;
        joined = next.join('\n');
    }
    return next;
}

function bdndPathsLooselyMatch(a, b) {
    if (!a || !b) return false;
    if (a === b) return true;
    const na = a.replace(/\\/g, '/');
    const nb = b.replace(/\\/g, '/');
    if (na === nb) return true;
    if (na.endsWith('/' + nb) || nb.endsWith('/' + na)) return true;
    const ba = na.split('/').pop();
    const bb = nb.split('/').pop();
    return !!ba && ba === bb;
}

/** Find a document line whose wiki embed matches an Obsidian embed `src` path. */
function findDocLineForImagePath(doc, srcPath) {
    if (!srcPath) return null;
    for (let i = 1; i <= doc.lines; i++) {
        const line = doc.line(i);
        const re = new RegExp(BDND_WIKI_EMBED_RE_SOURCE, 'g');
        let m;
        while ((m = re.exec(line.text)) !== null) {
            const hit = bdndWikiMatchFromExec(m);
            if (!bdndPathsLooselyMatch(hit.linkPathRaw, srcPath)) continue;
            const sideText = (line.text.slice(0, hit.fullFrom) + line.text.slice(hit.fullTo)).trim();
            return {
                line0: i - 1,
                line,
                imageMd: hit.raw,
                imagePath: hit.linkPathRaw,
                width: hit.width,
                sideText,
            };
        }
    }
    return null;
}

/**
 * Resolve the image the user actually right-clicked in Live Preview.
 * Prefer `.internal-embed[src]` under the click — not the editor cursor.
 */
function resolveClickedImageTarget(app, cmView, pointerContext) {
    if (!pointerContext || !cmView) return null;
    if (Date.now() - (pointerContext.time || 0) > 8000) return null;

    const doc = cmView.state.doc;
    let el = pointerContext.target;
    if (!(el instanceof Element)) {
        el = document.elementFromPoint(pointerContext.x, pointerContext.y);
    }
    if (!(el instanceof Element)) return null;

    const embed =
        el.closest('.internal-embed, .image-embed, .media-embed, span.cm-hmd-internal-link') ||
        null;
    const imgEl = el.closest('img') || embed?.querySelector?.('img');

    let srcPath = '';
    if (embed) {
        srcPath =
            embed.getAttribute('src') ||
            embed.getAttribute('alt') ||
            embed.getAttribute('data-path') ||
            '';
    }
    // Some LP embeds only expose a resource URL on <img>; map it back to a vault file.
    if (!srcPath && imgEl instanceof HTMLImageElement && app?.vault) {
        const current = imgEl.currentSrc || imgEl.src || '';
        if (current) {
            try {
                const files = app.vault.getFiles();
                for (const f of files) {
                    if (!bdndIsPreviewImageExt(f.extension)) continue;
                    if (bdndImageSrcLikelyFromFile(current, f, app)) {
                        srcPath = f.path;
                        break;
                    }
                }
            } catch {
                /* noop */
            }
        }
    }

    // Walk up to a cm-line / embed block and map to a document position.
    let lineFromDom = null;
    const domProbe = embed || imgEl || el;
    try {
        const pos = cmView.posAtDOM(domProbe);
        if (typeof pos === 'number') {
            lineFromDom = doc.lineAt(pos);
        }
    } catch {
        try {
            const lineEl = domProbe.closest?.('.cm-line');
            if (lineEl) {
                const pos = cmView.posAtDOM(lineEl);
                if (typeof pos === 'number') lineFromDom = doc.lineAt(pos);
            }
        } catch {
            /* noop */
        }
    }

    if (srcPath) {
        const found = findDocLineForImagePath(doc, srcPath);
        if (found) return found;
        // Reconstruct markdown even if the source line lookup failed.
        let width = null;
        if (imgEl instanceof HTMLImageElement) {
            const w = Math.round(imgEl.getBoundingClientRect().width);
            if (w > 0) width = w;
        }
        const imageMd = width ? `![[${srcPath}|${width}]]` : `![[${srcPath}]]`;
        if (lineFromDom) {
            return {
                line0: lineFromDom.number - 1,
                line: lineFromDom,
                imageMd,
                imagePath: srcPath,
                width,
                sideText: '',
            };
        }
        return {
            line0: null,
            line: null,
            imageMd,
            imagePath: srcPath,
            width,
            sideText: '',
            // No line — caller must locate/replace carefully
            synthetic: true,
        };
    }

    if (lineFromDom) {
        const t = lineFromDom.text;
        if (isWikiImageLine(t)) {
            const re = new RegExp(BDND_WIKI_EMBED_RE_SOURCE);
            const m = re.exec(t);
            const hit = m ? bdndWikiMatchFromExec(m) : null;
            return {
                line0: lineFromDom.number - 1,
                line: lineFromDom,
                imageMd: t.trim(),
                imagePath: hit?.linkPathRaw || t.trim(),
                width: hit?.width ?? null,
                sideText: '',
            };
        }
        const mixed = splitMixedImageText(t);
        if (mixed) {
            const re = new RegExp(BDND_WIKI_EMBED_RE_SOURCE);
            const m = re.exec(t);
            const hit = m ? bdndWikiMatchFromExec(m) : null;
            return {
                line0: lineFromDom.number - 1,
                line: lineFromDom,
                imageMd: mixed.imageMd,
                imagePath: hit?.linkPathRaw || mixed.imageMd,
                width: hit?.width ?? null,
                sideText: mixed.sideText,
            };
        }
    }

    return null;
}

/** Append a resolved <img> (or placeholder) into el from a vault link path. */
function bdndAppendResolvedImage(app, el, imagePath, sourcePath, width, height) {
    const path = (imagePath || '').trim();
    if (!path) return false;

    const finishImg = (img) => {
        if (width && width > 0) img.style.width = `${width}px`;
        if (height && height > 0) img.style.height = `${height}px`;
        else img.style.height = 'auto';
        img.style.maxWidth = '100%';
        img.style.minHeight = '48px';
        img.style.display = 'block';
        img.style.position = 'relative';
        el.appendChild(img);
        return true;
    };

    // Already a usable URL (resource / http / data).
    if (/^(https?:|app:|data:|blob:|capacitor:)/i.test(path)) {
        const img = document.createElement('img');
        img.className = 'block-dnd-col-direct-img';
        img.draggable = false;
        img.src = path;
        return finishImg(img);
    }

    const dest = bdndResolveImageFile(app, path, sourcePath);
    if (!(dest instanceof obsidian.TFile)) {
        const ph = document.createElement('div');
        ph.className = 'block-dnd-col-image-placeholder';
        ph.textContent = `![[${path}]]`;
        el.appendChild(ph);
        return false;
    }
    const img = document.createElement('img');
    img.className = 'block-dnd-col-direct-img';
    img.alt = dest.basename;
    img.draggable = false;
    try {
        img.src = app.vault.getResourcePath(dest);
    } catch {
        const ph = document.createElement('div');
        ph.className = 'block-dnd-col-image-placeholder';
        ph.textContent = `![[${path}]]`;
        el.appendChild(ph);
        return false;
    }
    return finishImg(img);
}

/**
 * 1 Column: make the side text box the same height as the image
 * (same vertical span as the stretchy gutter between them).
 */
function bdndSyncSingleColTextHeight(root) {
    if (!(root instanceof HTMLElement) || !root.classList.contains('block-dnd-single-col')) return;
    const imagePreview = root.querySelector(
        ':scope > .block-dnd-col-cell .image-preview-cell .block-dnd-col-preview'
    );
    const textEditor = root.querySelector(
        ':scope > .block-dnd-col-cell .always-show-editor .block-dnd-col-editor'
    );
    if (!(imagePreview instanceof HTMLElement) || !(textEditor instanceof HTMLTextAreaElement)) return;

    const img = imagePreview.querySelector('img');
    let h = 0;
    if (img instanceof HTMLImageElement) {
        h = img.offsetHeight || img.getBoundingClientRect().height || 0;
    }
    if (h < 1) {
        h = imagePreview.offsetHeight || imagePreview.getBoundingClientRect().height || 0;
    }
    if (h < 1) return;

    const px = `${Math.round(h)}px`;
    textEditor.style.boxSizing = 'border-box';
    // Beat the general `min-height: 3.2em !important` editor rule.
    textEditor.style.setProperty('height', px, 'important');
    textEditor.style.setProperty('min-height', px, 'important');
    textEditor.style.setProperty('max-height', px, 'important');
    textEditor.style.setProperty('resize', 'none', 'important');
    textEditor.style.setProperty('overflow', 'auto', 'important');
}

function bdndAttachSingleColHeightSync(root, hostChild) {
    if (!(root instanceof HTMLElement) || !root.classList.contains('block-dnd-single-col')) return;

    const sync = () => bdndSyncSingleColTextHeight(root);
    let raf = null;
    const schedule = () => {
        if (raf != null) cancelAnimationFrame(raf);
        raf = requestAnimationFrame(() => {
            raf = null;
            sync();
        });
    };

    sync();
    // Image decode / layout often settles after the first paint.
    window.setTimeout(sync, 0);
    window.setTimeout(sync, 120);
    window.setTimeout(sync, 400);

    const imagePreview = root.querySelector(
        ':scope > .block-dnd-col-cell .image-preview-cell .block-dnd-col-preview'
    );
    const observed = new Set();
    const ro =
        typeof ResizeObserver !== 'undefined'
            ? new ResizeObserver(() => {
                  schedule();
              })
            : null;

    const watchEl = (el) => {
        if (!(el instanceof Element) || !ro || observed.has(el)) return;
        observed.add(el);
        try {
            ro.observe(el);
        } catch {
            /* noop */
        }
        if (el instanceof HTMLImageElement) {
            el.addEventListener('load', schedule);
        }
    };

    watchEl(root);
    if (imagePreview) {
        watchEl(imagePreview);
        imagePreview.querySelectorAll('img').forEach((img) => watchEl(img));
    }

    const mo =
        imagePreview && typeof MutationObserver !== 'undefined'
            ? new MutationObserver(() => {
                  if (imagePreview) {
                      imagePreview.querySelectorAll('img').forEach((img) => watchEl(img));
                  }
                  schedule();
              })
            : null;
    if (mo && imagePreview) {
        mo.observe(imagePreview, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ['style', 'src', 'width', 'height', 'class'],
        });
    }

    if (hostChild && typeof hostChild.register === 'function') {
        hostChild.register(() => {
            if (raf != null) cancelAnimationFrame(raf);
            if (ro) ro.disconnect();
            if (mo) mo.disconnect();
        });
    }
}

/** Full fence string; match trailing newline of replaced span so content below does not shift. */
function wrapColumnFenceInner(inner, oldSliceEndsWithNewline) {
    let fence = '```' + BLOCK_DND_COLUMNS_LANG + '\n' + inner + '\n```';
    if (oldSliceEndsWithNewline && !fence.endsWith('\n')) fence += '\n';
    return fence;
}

function normalizePercents(widths, minPct = MIN_COL_WIDTH_PCT) {
    if (!widths || widths.length === 0) return [100];
    const w = widths.map(x => Math.max(minPct, Number(x) || minPct));
    const sum = w.reduce((a, b) => a + b, 0);
    return w.map(x => Math.round((x / sum) * 10000) / 100);
}

function findClosingFenceLineStart(markdown, searchFrom) {
    let i = searchFrom;
    while (i < markdown.length) {
        const lineEnd = markdown.indexOf('\n', i);
        const line = lineEnd === -1 ? markdown.slice(i) : markdown.slice(i, lineEnd);
        if (/^```\s*$/.test(line)) {
            return i;
        }
        if (lineEnd === -1) break;
        i = lineEnd + 1;
    }
    return -1;
}

function findFenceRangeById(markdown, uuid) {
    const openRe = new RegExp('^```\\s*' + BLOCK_DND_COLUMNS_LANG + '\\s*$', 'gm');
    let m;
    while ((m = openRe.exec(markdown)) !== null) {
        const startFence = m.index;
        let innerStart = m.index + m[0].length;
        if (markdown[innerStart] === '\r') innerStart++;
        if (markdown[innerStart] !== '\n') continue;
        innerStart++;

        const closeStart = findClosingFenceLineStart(markdown, innerStart);
        if (closeStart === -1) break;

        const inner = markdown.slice(innerStart, closeStart);
        const parsed = parseColumnFenceSource(inner);
        if (parsed && parsed.meta.id === uuid) {
            const lineEndAfterClose = markdown.indexOf('\n', closeStart);
            const endExclusive = lineEndAfterClose === -1 ? markdown.length : lineEndAfterClose + 1;
            return { from: startFence, to: endExclusive, innerStart, innerEnd: closeStart, inner };
        }
    }
    return null;
}

/** Column fence whose drop zone includes targetLine0 (insert-before index), or null. */
function findColumnFenceTouchingTargetLine(md, targetLine0) {
    const openRe = new RegExp('^```\\s*' + BLOCK_DND_COLUMNS_LANG + '\\s*$', 'gm');
    let m;
    while ((m = openRe.exec(md)) !== null) {
        const startFence = m.index;
        let innerStart = m.index + m[0].length;
        if (md[innerStart] === '\r') innerStart++;
        if (md[innerStart] !== '\n') continue;
        innerStart++;

        const closeStart = findClosingFenceLineStart(md, innerStart);
        if (closeStart === -1) break;

        const lineEndAfterClose = md.indexOf('\n', closeStart);
        const endExclusive = lineEndAfterClose === -1 ? md.length : lineEndAfterClose + 1;

        const startLineIdx = md.slice(0, startFence).split('\n').length - 1;
        const endLineIdx = md.slice(0, closeStart).split('\n').length - 1;

        if (targetLine0 >= startLineIdx && targetLine0 <= endLineIdx + 1) {
            const inner = md.slice(innerStart, closeStart);
            const parsed = parseColumnFenceSource(inner);
            if (parsed) {
                return {
                    from: startFence,
                    to: endExclusive,
                    innerStart,
                    innerEnd: closeStart,
                    inner,
                    startLineIdx,
                    endLineIdx,
                    parsed
                };
            }
        }
    }
    return null;
}

function cmLinePairExclusiveExtent(cm, lineA0, lineB0) {
    const doc = cm.state.doc;
    const lo = Math.min(lineA0, lineB0);
    const hi = Math.max(lineA0, lineB0);
    const from = doc.line(lo + 1).from;
    const to = hi + 2 <= doc.lines ? doc.line(hi + 2).from : doc.length;
    return { from, to };
}

class BlockDndPlugin extends obsidian.Plugin {
    settings = DEFAULT_SETTINGS;
    dragState = null;
    activeView = null;
    handlesContainer = null;
    dropIndicator = null;
    lineObserver = null;
    debounceTimeout = null;
    isMobile = false;
    longPressTimeout = null;
    blocks = [];
    handleWrappers = new Map();
    hideTimeouts = new Map();
    isHovering = false;
    
    // Mobile-specific
    selectedBlockIndex = null;
    mobileGlobalTapHandler = null;
    
    // Store references for cleanup
    blockEventCleanups = [];

    /** Debounced persist for column body edits (uuid → timeout id) */
    columnBodyPersistTimers = new Map();

    /** Fence id currently being rewritten (ignore synthetic blur from remount) */
    _columnPersistRemounting = null;

    /** Deferred focus so LP / CM can run first, then we focus the column textarea */
    columnEditorFocusHack = null;

    /** Document-capture Enter guard so column textareas never lose the key to CM */
    columnEditorKeyGuard = null;

    /** Deferred textarea focus timer — cleared on any pointerdown so main-note clicks are not overridden */
    columnFocusDeferTimer = null;

    boundModifierKeySync = null;
    boundWindowBlurForModifiers = null;

    /** Desktop: true while configured modifier flag is down (altKey / ctrlKey / …). */
    modifierRevealActive = false;

    /** Keep caret indicator aligned while cm-scroller scrolls during drag */
    dragScrollRefreshBound = null;

    /**
     * Last editor right-click (cursor is often NOT on the image when the menu opens).
     * { x, y, time, target }
     */
    lastPointerContext = null;

    async onload() {
        await this.loadSettings();
        
        this.isMobile = obsidian.Platform.isMobile;
        this.handleGutterInsetPx = this.isMobile ? 42 : 46;
        this.handleSlotLeftPx = this.isMobile ? 6 : 10;

        this.addSettingTab(new BlockDndSettingTab(this.app, this));
        this.addStyles();
        this.applyColumnEditButtonVisibility();

        this.registerMarkdownCodeBlockProcessor(BLOCK_DND_COLUMNS_LANG, async (source, el, ctx) => {
            await this.renderColumnCodeBlock(source, el, ctx);
        });

        // Capture the actual right-click target — editor selection often stays elsewhere
        // when the user right-clicks a Live Preview image embed.
        this.registerDomEvent(
            document,
            'contextmenu',
            (e) => {
                const view = this.app.workspace.getActiveViewOfType(obsidian.MarkdownView);
                if (!view?.contentEl?.contains(e.target)) return;
                this.lastPointerContext = {
                    x: e.clientX,
                    y: e.clientY,
                    time: Date.now(),
                    target: e.target instanceof Element ? e.target : null,
                };
            },
            true
        );

        this.registerEvent(
            this.app.workspace.on('editor-menu', (menu, editor, view) => {
                if (!(view instanceof obsidian.MarkdownView) || !view.file) return;

                menu.addItem((item) => {
                    item.setTitle('Column');
                    item.setIcon('layout');
                    const submenu = item.setSubmenu();
                    if (!submenu || typeof submenu.addItem !== 'function') return;
                    for (let n = 1; n <= 5; n++) {
                        const count = n;
                        submenu.addItem((subItem) => {
                            subItem.setTitle(count === 1 ? '1 Column' : `${count} Columns`);
                            subItem.onClick(() => {
                                this.addColumnsFromEditorContextMenu(view, editor, count);
                            });
                        });
                    }
                });
            })
        );

        this.registerEvent(
            this.app.workspace.on('active-leaf-change', () => {
                this.cleanup();
                setTimeout(() => this.setup(), 100);
            })
        );
        
        this.registerEvent(
            this.app.workspace.on('layout-change', () => {
                this.resetDragState();
                setTimeout(() => this.setup(), 100);
            })
        );
        
        this.app.workspace.onLayoutReady(() => {
            setTimeout(() => this.setup(), 300);
        });

        this.columnEditorFocusHack = (ev) => {
            if (this.columnFocusDeferTimer !== null) {
                clearTimeout(this.columnFocusDeferTimer);
                this.columnFocusDeferTimer = null;
            }

            const t = ev.target;
            if (!(t instanceof HTMLElement)) return;
            if (!t.closest('.block-dnd-columns-embed, .block-dnd-columns-root')) return;
            if (t.closest('.block-dnd-col-gutter')) return;
            if (t.closest('.zotion-resize-handle')) return;
            if (ev.type === 'mousedown' && ev.defaultPrevented) return;

            const wrapHit = t.closest('.block-dnd-col-editor-wrap');
            if (wrapHit && wrapHit.classList.contains('image-preview-cell') && !t.closest('.block-dnd-col-editor')) {
                // Let image cells handle click/dblclick; contenteditable=false keeps the fence closed.
                return;
            }

            const alreadyEditing = t.closest('.block-dnd-col-editor');
            if (alreadyEditing && document.activeElement === alreadyEditing) {
                // Already in the cell — allow native click/drag text selection.
                return;
            }

            // Prevent Live Preview from placing the caret inside the fence.
            // That unmounts the column widget and the cell text appears to vanish.
            if (ev.cancelable) ev.preventDefault();

            let targetTa = t.closest('.block-dnd-col-editor');
            if (!targetTa) {
                const cell = t.closest('.block-dnd-col-cell');
                if (cell) targetTa = cell.querySelector(':scope > .block-dnd-col-editor-wrap:not(.image-preview-cell) .block-dnd-col-editor');
            }
            if (!(targetTa instanceof HTMLTextAreaElement)) return;

            const editorWrap = targetTa.closest('.block-dnd-col-editor-wrap');
            if (editorWrap) editorWrap.classList.add('is-editing');
            const cell = targetTa.closest('.block-dnd-col-cell');
            if (cell) cell.classList.add('is-editing-cell');

            const clientX = ev.clientX;
            const clientY = ev.clientY;
            const clickedEditorDirectly = !!t.closest('.block-dnd-col-editor');
            const root = targetTa.closest('.block-dnd-columns-root');
            const fenceId = root?.dataset?.blockDndId;

            this.columnFocusDeferTimer = window.setTimeout(() => {
                this.columnFocusDeferTimer = null;
                try {
                    if (!document.contains(targetTa)) return;
                    if (fenceId) this.keepCmCaretOutsideColumnFence(fenceId);
                    targetTa.focus({ preventScroll: true });
                    if (clickedEditorDirectly && typeof clientX === 'number') {
                        setTextareaCaretFromClick(targetTa, clientX, clientY);
                    } else {
                        const len = targetTa.value.length;
                        try {
                            targetTa.setSelectionRange(len, len);
                        } catch {
                            /* noop */
                        }
                    }
                } catch {
                    /* noop */
                }
            }, 0);
        };
        document.addEventListener('pointerdown', this.columnEditorFocusHack, true);
        document.addEventListener('mousedown', this.columnEditorFocusHack, true);

        // Capture Enter at document level so Obsidian/CM cannot steal it from a
        // focused column textarea (which felt like "newline then kick out").
        this.columnEditorKeyGuard = (e) => {
            const t = e.target;
            if (!(t instanceof HTMLTextAreaElement) || !t.classList.contains('block-dnd-col-editor')) {
                return;
            }
            if (!isColumnPlainEnterKey(e)) return;
            e.preventDefault();
            e.stopPropagation();
            if (typeof e.stopImmediatePropagation === 'function') e.stopImmediatePropagation();
            insertNewlineInColumnTextarea(t);
        };
        document.addEventListener('keydown', this.columnEditorKeyGuard, true);

        this.boundModifierKeySync = (e) => this.onModifierKeyboardSync(e);
        this.boundWindowBlurForModifiers = () => this.clearModifierHoldState();
        window.addEventListener('keydown', this.boundModifierKeySync, true);
        window.addEventListener('keyup', this.boundModifierKeySync, true);
        window.addEventListener('blur', this.boundWindowBlurForModifiers);
    }

    onunload() {
        if (this.columnFocusDeferTimer !== null) {
            clearTimeout(this.columnFocusDeferTimer);
            this.columnFocusDeferTimer = null;
        }
        if (this.boundModifierKeySync) {
            window.removeEventListener('keydown', this.boundModifierKeySync, true);
            window.removeEventListener('keyup', this.boundModifierKeySync, true);
            this.boundModifierKeySync = null;
        }
        if (this.boundWindowBlurForModifiers) {
            window.removeEventListener('blur', this.boundWindowBlurForModifiers);
            this.boundWindowBlurForModifiers = null;
        }
        if (this.columnEditorFocusHack) {
            document.removeEventListener('pointerdown', this.columnEditorFocusHack, true);
            document.removeEventListener('mousedown', this.columnEditorFocusHack, true);
            this.columnEditorFocusHack = null;
        }
        if (this.columnEditorKeyGuard) {
            document.removeEventListener('keydown', this.columnEditorKeyGuard, true);
            this.columnEditorKeyGuard = null;
        }
        document.body.classList.remove(VIPERS_COLUMNS_HIDE_EDIT_BUTTON_CLASS);
        this.cleanup();
        this.removeStyles();
    }

    async loadSettings() {
        const data = await this.loadData();
        this.settings = { ...DEFAULT_SETTINGS, ...data };
        const mod = this.settings.handleRevealModifier;
        if (!HANDLE_REVEAL_MODIFIER_CODES[mod]) {
            this.settings.handleRevealModifier = DEFAULT_SETTINGS.handleRevealModifier;
        }
        if (typeof this.settings.showColumnEditButton !== 'boolean') {
            this.settings.showColumnEditButton = DEFAULT_SETTINGS.showColumnEditButton;
        }
        if (typeof this.settings.enableBlockDragHandles !== 'boolean') {
            this.settings.enableBlockDragHandles = DEFAULT_SETTINGS.enableBlockDragHandles;
        }
    }

    async saveSettings() {
        await this.saveData(this.settings);
        this.applyColumnEditButtonVisibility();
    }

    /**
     * Toggle Obsidian's `</>` edit-block button for column fences only
     * (does not affect other code blocks / embeds).
     */
    applyColumnEditButtonVisibility() {
        const hide = this.settings?.showColumnEditButton === false;
        document.body.classList.toggle(VIPERS_COLUMNS_HIDE_EDIT_BUTTON_CLASS, hide);
    }

    addStyles() {
        const styleEl = document.createElement('style');
        styleEl.id = 'vipers-columns-styles';
        
        const handleSize = this.isMobile ? 28 : 20;
        const innerPad = this.isMobile ? 2 : 2;
        const wrapperW = handleSize + innerPad * 2;
        const wrapperH = handleSize + innerPad * 2;
        const gutterInset = Number(this.handleGutterInsetPx) || 62;

        styleEl.textContent = `
            /* Room for grip handle inside scroll area (LP + source) */
            .markdown-source-view.mod-cm6 .block-dnd-editor-wrapper .cm-scroller > .cm-contentContainer {
                padding-inline-start: ${gutterInset}px !important;
            }

            .block-dnd-handles-container {
                position: absolute;
                top: 0;
                left: 0;
                width: 100%;
                pointer-events: none;
                z-index: 60;
                overflow: visible;
            }
            
            .block-dnd-handle-wrapper {
                position: absolute;
                width: ${wrapperW}px;
                height: ${wrapperH}px;
                display: flex;
                align-items: center;
                justify-content: center;
                pointer-events: auto;
                opacity: 0;
                transition: opacity 0.15s ease, transform 0.15s ease;
                -webkit-tap-highlight-color: transparent;
                transform: scale(0.8);
                z-index: 65;
            }

            .block-dnd-handle-row {
                display: flex;
                flex-direction: row;
                align-items: center;
                justify-content: center;
                pointer-events: auto;
            }

            .block-dnd-columns-embed {
                pointer-events: auto !important;
                position: relative;
                z-index: 6;
                width: 100%;
                max-width: 100%;
            }

            /* Hide Obsidian's </> edit-block button on column fences only */
            body.vipers-columns-hide-edit-button .cm-embed-block:has(.block-dnd-columns-embed) > .edit-block-button,
            body.vipers-columns-hide-edit-button .cm-embed-block:has(.block-dnd-columns-root) > .edit-block-button,
            body.vipers-columns-hide-edit-button .cm-embed-block:has(.block-dnd-columns-embed) .edit-block-button,
            body.vipers-columns-hide-edit-button .cm-preview-code-block:has(.block-dnd-columns-embed) .edit-block-button,
            body.vipers-columns-hide-edit-button .cm-embed-block:has(.block-language-block-dnd-columns) .edit-block-button {
                display: none !important;
                visibility: hidden !important;
                opacity: 0 !important;
                pointer-events: none !important;
            }

            .block-dnd-columns-root {
                display: flex !important;
                flex-direction: row;
                flex-wrap: nowrap;
                align-items: flex-start;
                width: 100%;
                max-width: 100%;
                gap: 0;
                margin: 0.5em 0;
                pointer-events: auto !important;
                position: relative;
                z-index: 7;
                box-sizing: border-box;
            }

            /* 1 Column: stretch like the gutter so the text box matches image height */
            .block-dnd-columns-root.block-dnd-single-col {
                align-items: stretch !important;
            }

            .block-dnd-columns-root .block-dnd-col-cell {
                min-width: 0;
                max-width: 100%;
                overflow: hidden;
                box-sizing: border-box;
                pointer-events: auto !important;
                display: flex;
                flex-direction: column;
                align-items: stretch;
                justify-content: flex-start;
                align-self: flex-start;
            }

            .block-dnd-columns-root.block-dnd-single-col .block-dnd-col-cell {
                align-self: stretch !important;
            }

            .block-dnd-columns-root.block-dnd-single-col .block-dnd-col-editor-wrap {
                flex: 1 1 auto;
                min-height: 0;
                height: 100%;
                gap: 0;
            }

            .block-dnd-columns-root.block-dnd-single-col .image-preview-cell .block-dnd-col-preview {
                padding: 0;
            }

            .block-dnd-columns-root.block-dnd-single-col .always-show-editor .block-dnd-col-editor {
                flex: 1 1 auto !important;
                align-self: stretch;
                min-height: 0 !important;
                resize: none !important;
                overflow: auto !important;
            }

            .block-dnd-col-editor-wrap {
                display: flex;
                flex-direction: column;
                gap: 6px;
                width: 100%;
                min-width: 0;
                position: relative;
            }

            .block-dnd-columns-root .block-dnd-col-preview {
                display: block;
                width: 100%;
                min-height: 1.5em;
                margin: 0;
                padding: 4px 0;
                box-sizing: border-box;
                font-family: var(--font-text-theme);
                font-size: var(--font-text-size);
                line-height: var(--line-height-normal);
                color: var(--text-normal);
                cursor: text;
                pointer-events: auto !important;
                overflow: hidden;
            }

            .block-dnd-columns-root .block-dnd-col-preview > :first-child {
                margin-top: 0;
            }

            .block-dnd-columns-root .block-dnd-col-preview p {
                margin-block-start: 0;
                margin-block-end: 0.5em;
            }

            /* Keep embeds inside the column — do not let them drop below the row */
            .block-dnd-columns-root .block-dnd-col-preview img,
            .block-dnd-columns-root .block-dnd-col-preview .block-dnd-col-direct-img,
            .block-dnd-columns-root .block-dnd-col-preview .internal-embed,
            .block-dnd-columns-root .block-dnd-col-preview .image-embed,
            .block-dnd-columns-root .block-dnd-col-preview .media-embed {
                display: block !important;
                position: relative !important;
                width: auto !important;
                max-width: 100% !important;
                height: auto !important;
                margin: 0 !important;
                float: none !important;
                vertical-align: top;
            }

            .block-dnd-col-editor-wrap.image-preview-cell .block-dnd-col-preview {
                cursor: default;
                min-height: 3em;
            }

            .block-dnd-columns-root .block-dnd-col-image-placeholder {
                display: block;
                width: 100%;
                min-height: 3em;
                padding: 8px;
                box-sizing: border-box;
                border: 1px dashed var(--background-modifier-border);
                border-radius: var(--radius-s, 4px);
                color: var(--text-muted);
                font-size: var(--font-ui-smaller);
                word-break: break-all;
            }

            .block-dnd-col-editor-wrap:not(.is-editing):not(.always-show-editor) .block-dnd-col-editor {
                position: absolute;
                width: 1px;
                height: 1px;
                min-height: 0;
                margin: -1px;
                padding: 0;
                overflow: hidden;
                clip: rect(0, 0, 0, 0);
                border: 0;
                opacity: 0;
                pointer-events: none;
                resize: none;
            }

            .block-dnd-col-editor-wrap.is-editing .block-dnd-col-preview,
            .block-dnd-col-editor-wrap.always-show-editor .block-dnd-col-preview {
                display: none;
            }

            .block-dnd-columns-root .block-dnd-col-editor {
                display: block;
                width: 100%;
                flex: 0 0 auto;
                min-height: 3.2em;
                margin: 0;
                padding: 6px 8px;
                box-sizing: border-box;
                font-family: var(--font-text-theme);
                font-size: var(--font-text-size);
                line-height: var(--line-height-normal);
                color: var(--text-normal);
                /* Fully transparent panels — wallpaper / note shows through. */
                background: transparent !important;
                border: 1px solid color-mix(in srgb, var(--background-modifier-border) 55%, transparent);
                border-radius: var(--radius-s, 4px);
                resize: vertical;
                outline: none;
                pointer-events: auto !important;
                cursor: text;
                -webkit-user-select: text;
                user-select: text;
            }

            /* Explicitly undo the clipped 1px hide so text cannot vanish on click-to-edit */
            .block-dnd-col-editor-wrap.is-editing .block-dnd-col-editor,
            .block-dnd-col-editor-wrap.always-show-editor .block-dnd-col-editor {
                position: relative !important;
                width: 100% !important;
                height: auto;
                min-height: 3.2em !important;
                margin: 0 !important;
                padding: 6px 8px !important;
                overflow: auto !important;
                clip: auto !important;
                clip-path: none !important;
                opacity: 1 !important;
                pointer-events: auto !important;
                resize: vertical !important;
                border: 1px solid color-mix(in srgb, var(--background-modifier-border) 55%, transparent);
                background: transparent !important;
            }

            .block-dnd-col-cell.is-editing-cell,
            .block-dnd-col-editor-wrap.is-editing,
            .block-dnd-col-editor-wrap.always-show-editor {
                overflow: visible;
            }

            .block-dnd-columns-root .block-dnd-col-editor:hover,
            .block-dnd-columns-root .block-dnd-col-editor:focus {
                background: transparent !important;
            }

            .block-dnd-columns-root .block-dnd-col-editor:focus {
                box-shadow: inset 0 0 0 1px var(--interactive-accent);
                border-color: var(--interactive-accent);
            }

            .block-dnd-columns-root .block-dnd-col-gutter {
                display: flex;
                align-items: stretch;
                align-self: stretch;
                justify-content: center;
                cursor: col-resize;
                touch-action: none;
                flex: 0 0 auto;
                position: relative;
                /* Always findable with transparent panels; brighter on hover/drag. */
                opacity: 0.65;
                transition: opacity 0.12s ease;
                min-height: 3.2em;
            }

            .block-dnd-columns-root:hover .block-dnd-col-gutter,
            .block-dnd-columns-root:focus-within .block-dnd-col-gutter,
            .block-dnd-columns-root .block-dnd-col-gutter.block-dnd-gutter-active {
                opacity: 1;
            }

            .block-dnd-columns-root .block-dnd-col-gutter-line {
                width: 2px;
                align-self: stretch;
                min-height: 2rem;
                background: var(--background-modifier-border);
                border-radius: 1px;
                pointer-events: none;
            }

            .block-dnd-columns-root:hover .block-dnd-col-gutter-line,
            .block-dnd-columns-root:focus-within .block-dnd-col-gutter-line,
            .block-dnd-columns-root .block-dnd-col-gutter.block-dnd-gutter-active .block-dnd-col-gutter-line {
                background: var(--text-faint);
            }

            .block-dnd-columns-root .block-dnd-col-gutter.block-dnd-gutter-active .block-dnd-col-gutter-line {
                background: var(--interactive-accent);
            }

            @media print {
                .block-dnd-columns-root .block-dnd-col-gutter {
                    display: none;
                }
            }
            
            .block-dnd-handle-wrapper.visible {
                opacity: 1;
                transform: scale(1);
            }

            .block-dnd-editor-wrapper:not(.block-dnd-handles-revealed) .block-dnd-handle-wrapper {
                opacity: 0 !important;
                visibility: hidden !important;
                pointer-events: none !important;
            }
            
            .block-dnd-handle {
                width: ${handleSize}px;
                height: ${handleSize}px;
                border-radius: 6px;
                cursor: grab;
                display: flex;
                align-items: center;
                justify-content: center;
                background: var(--background-secondary);
                border: 1px solid var(--background-modifier-border);
                transition: all 0.15s ease;
                touch-action: manipulation;
                -webkit-user-select: none;
                user-select: none;
                -webkit-touch-callout: none;
            }
            
            .block-dnd-handle:hover {
                background: var(--background-modifier-hover);
            }
            
            .block-dnd-handle:active,
            .block-dnd-handle.active {
                cursor: grabbing;
                background: var(--interactive-accent);
                border-color: var(--interactive-accent);
                transform: scale(1.1);
            }
            
            .block-dnd-handle:active svg,
            .block-dnd-handle.active svg {
                color: var(--text-on-accent);
            }
            
            .block-dnd-handle svg {
                width: ${handleSize - 6}px;
                height: ${handleSize - 6}px;
                color: var(--text-muted);
                pointer-events: none;
            }
            
            .block-dnd-drop-indicator {
                position: fixed;
                pointer-events: none;
                z-index: 10055;
                display: none;
                background: var(--interactive-accent);
                border-radius: 1px;
                box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.1);
                animation: block-dnd-drop-indicator-pulse 0.85s ease-in-out infinite;
            }
            
            .block-dnd-drop-indicator.visible {
                display: block;
            }

            @keyframes block-dnd-drop-indicator-pulse {
                0%, 100% { opacity: 1; }
                50% { opacity: 0.4; }
            }

            .block-dnd-dragging {
                opacity: 0.3 !important;
                background: var(--background-modifier-active-hover) !important;
            }
            
            .block-dnd-editor-wrapper {
                position: relative;
            }
            
            .block-dnd-dragging-active {
                -webkit-user-select: none;
                user-select: none;
            }
            
            /* Mobile: selected block highlight */
            .block-dnd-selected {
                background: var(--background-modifier-hover) !important;
                border-radius: 4px;
            }
            
            ${this.isMobile ? `
                .block-dnd-handle {
                    box-shadow: 0 2px 8px rgba(0,0,0,0.15);
                }
            ` : ''}
        `;
        document.head.appendChild(styleEl);
    }

    removeStyles() {
        const styleEl = document.getElementById('vipers-columns-styles');
        if (styleEl) styleEl.remove();
    }

    shouldRevealHandles() {
        if (!this.settings.enableBlockDragHandles) return false;
        if (this.isMobile) {
            return !!this.settings.alwaysShowHandlesMobile;
        }
        return !!this.modifierRevealActive;
    }

    syncHandleRevealClass() {
        const reveal = this.shouldRevealHandles();
        document.querySelectorAll('.block-dnd-editor-wrapper').forEach((cm) => {
            cm.classList.toggle('block-dnd-handles-revealed', reveal);
        });

        if (!this.isMobile && this.handlesContainer && !this.settings.showHandleOnHover) {
            if (this.shouldRevealHandles()) {
                this.handlesContainer.querySelectorAll('.block-dnd-handle-wrapper').forEach((w) => {
                    w.classList.add('visible');
                });
            } else {
                this.handlesContainer.querySelectorAll('.block-dnd-handle-wrapper').forEach((w) => {
                    w.classList.remove('visible');
                });
            }
        }
    }

    onModifierKeyboardSync(e) {
        if (this.isMobile) return;
        const want = this.settings.handleRevealModifier || 'alt';
        const held = readRevealModifierHeld(e, want);
        if (held !== this.modifierRevealActive) {
            this.modifierRevealActive = held;
            if (!held) this.syncHandleRevealClass();
        }
    }

    clearModifierHoldState() {
        this.modifierRevealActive = false;
        this.syncHandleRevealClass();
    }

    resetDragState() {
        if (this.longPressTimeout) {
            clearTimeout(this.longPressTimeout);
            this.longPressTimeout = null;
        }

        if (this.cmScroller && this.dragScrollRefreshBound) {
            this.cmScroller.removeEventListener('scroll', this.dragScrollRefreshBound);
            this.dragScrollRefreshBound = null;
        }
        
        this.dragState = null;
        
        if (this.dropIndicator) {
            this.dropIndicator.classList.remove('visible');
            this.dropIndicator.style.display = 'none';
        }
        
        document.querySelectorAll('.block-dnd-dragging').forEach(el => {
            el.classList.remove('block-dnd-dragging');
        });
        document.querySelectorAll('.block-dnd-handle.active').forEach(el => {
            el.classList.remove('active');
        });
        document.body.classList.remove('block-dnd-dragging-active');
        
        document.removeEventListener('mousemove', this.onDrag);
        document.removeEventListener('mouseup', this.endDrag);
        document.removeEventListener('touchmove', this.globalTouchMove);
        document.removeEventListener('touchend', this.globalTouchEnd);
        document.removeEventListener('touchcancel', this.globalTouchEnd);
    }

    setup() {
        // Drag handles are optional — columns work without them via right-click.
        if (!this.settings.enableBlockDragHandles) {
            this.cleanup();
            return;
        }

        const view = this.app.workspace.getActiveViewOfType(obsidian.MarkdownView);
        if (!view) return;
        
        this.activeView = view;
        
        const cmEditor = view.contentEl.querySelector('.cm-editor');
        const cmScroller = view.contentEl.querySelector('.cm-scroller');
        const cmContent = view.contentEl.querySelector('.cm-content');
        
        if (!cmEditor || !cmScroller || !cmContent) return;
        
        this.cmContent = cmContent;
        this.cmScroller = cmScroller;
        
        cmEditor.classList.add('block-dnd-editor-wrapper');
        
        this.handlesContainer = document.createElement('div');
        this.handlesContainer.className = 'block-dnd-handles-container';
        cmScroller.insertBefore(this.handlesContainer, cmScroller.firstChild);
        
        this.dropIndicator = document.createElement('div');
        this.dropIndicator.className = 'block-dnd-drop-indicator';
        this.dropIndicator.setAttribute('aria-hidden', 'true');
        document.body.appendChild(this.dropIndicator);
        
        this.setupObservers(cmContent, cmScroller);
        this.renderHandles();

        if (this.isMobile) {
            this.setupMobileTapToSelect();
            this.setupGlobalTouchListeners();
        }
    }
    
    // Get current text selection as line range
    getSelectionLineRange() {
        const editor = this.activeView?.editor;
        if (!editor) return null;
        
        const from = editor.getCursor('from');
        const to = editor.getCursor('to');
        
        // No selection (just cursor)
        if (from.line === to.line && from.ch === to.ch) {
            return null;
        }
        
        return {
            fromLine: Math.min(from.line, to.line),
            toLine: Math.max(from.line, to.line)
        };
    }
    
    setupGlobalTouchListeners() {
        this.globalTouchMove = (e) => {
            if (this.dragState) {
                e.preventDefault();
                const touch = e.touches[0];
                if (touch) {
                    this.updateIndicator(touch.clientX, touch.clientY);
                }
            }
        };
        
        this.globalTouchEnd = (e) => {
            if (this.longPressTimeout) {
                clearTimeout(this.longPressTimeout);
                this.longPressTimeout = null;
            }
            
            document.querySelectorAll('.block-dnd-handle.active').forEach(h => h.classList.remove('active'));
            
            if (this.dragState) {
                this.endDrag();
            }
        };
        
        document.addEventListener('touchmove', this.globalTouchMove, { passive: false });
        document.addEventListener('touchend', this.globalTouchEnd, { passive: true });
        document.addEventListener('touchcancel', this.globalTouchEnd, { passive: true });
    }

    cleanup() {
        this.resetDragState();
        
        this.columnBodyPersistTimers.forEach(t => clearTimeout(t));
        this.columnBodyPersistTimers.clear();

        if (this.lineObserver) {
            this.lineObserver.disconnect();
            this.lineObserver = null;
        }
        
        this.hideTimeouts.forEach(timeout => clearTimeout(timeout));
        this.hideTimeouts.clear();
        this.handleWrappers.clear();
        
        this.cleanupBlockEvents();
        this.cleanupMobileTapHandler();
        
        if (this.globalTouchMove) {
            document.removeEventListener('touchmove', this.globalTouchMove);
            this.globalTouchMove = null;
        }
        if (this.globalTouchEnd) {
            document.removeEventListener('touchend', this.globalTouchEnd);
            document.removeEventListener('touchcancel', this.globalTouchEnd);
            this.globalTouchEnd = null;
        }
        
        if (this.handlesContainer) {
            this.handlesContainer.remove();
            this.handlesContainer = null;
        }
        
        if (this.dropIndicator) {
            this.dropIndicator.remove();
            this.dropIndicator = null;
        }
        
        document.querySelectorAll('.block-dnd-editor-wrapper').forEach(el => {
            el.classList.remove('block-dnd-editor-wrapper');
            el.classList.remove('block-dnd-handles-revealed');
        });
        
        document.querySelectorAll('.block-dnd-selected').forEach(el => {
            el.classList.remove('block-dnd-selected');
        });
        
        this.blocks = [];
        this.isHovering = false;
        this.selectedBlockIndex = null;
    }
    
    cleanupBlockEvents() {
        this.blockEventCleanups.forEach(cleanup => cleanup());
        this.blockEventCleanups = [];
    }
    
    cleanupMobileTapHandler() {
        if (this.mobileGlobalTapHandler && this.cmScroller) {
            this.cmScroller.removeEventListener('touchstart', this.mobileGlobalTapHandler);
            this.mobileGlobalTapHandler = null;
        }
    }
    
    setupMobileTapToSelect() {
        if (!this.cmScroller) return;
        
        this.mobileGlobalTapHandler = (e) => {
            if (this.dragState) return;
            
            const target = e.target;
            if (target.closest('.block-dnd-handle') || target.closest('.block-dnd-handle-wrapper')) {
                return;
            }
            
            const lineEl = target.closest('.cm-line');
            if (!lineEl) {
                this.deselectBlock();
                return;
            }
            
            let tappedBlockIndex = null;
            for (let i = 0; i < this.blocks.length; i++) {
                const block = this.blocks[i];
                if (block.elements.includes(lineEl)) {
                    tappedBlockIndex = i;
                    break;
                }
            }
            
            if (tappedBlockIndex !== null && !this.blocks[tappedBlockIndex].isEmpty) {
                if (this.selectedBlockIndex === tappedBlockIndex) {
                    this.deselectBlock();
                } else {
                    this.selectBlock(tappedBlockIndex);
                }
            } else {
                this.deselectBlock();
            }
        };
        
        this.cmScroller.addEventListener('touchstart', this.mobileGlobalTapHandler, { passive: true });
    }
    
    selectBlock(blockIndex) {
        this.deselectBlock();
        
        this.selectedBlockIndex = blockIndex;
        const block = this.blocks[blockIndex];
        
        if (!block) return;
        
        block.elements.forEach(el => {
            if (el?.classList) el.classList.add('block-dnd-selected');
        });
        
        const wrapper = this.handleWrappers.get(blockIndex);
        if (wrapper) {
            wrapper.classList.add('visible');
        }
    }
    
    deselectBlock() {
        if (this.selectedBlockIndex !== null) {
            const block = this.blocks[this.selectedBlockIndex];
            if (block) {
                block.elements.forEach(el => {
                    if (el?.classList) el.classList.remove('block-dnd-selected');
                });
            }
            
            const wrapper = this.handleWrappers.get(this.selectedBlockIndex);
            if (wrapper) {
                wrapper.classList.remove('visible');
            }
        }
        
        this.selectedBlockIndex = null;
    }

    setupObservers(cmContent, cmScroller) {
        this.lineObserver = new MutationObserver(() => {
            if (!this.dragState) {
                this.debounceRender();
            }
        });
        
        this.lineObserver.observe(cmContent, {
            childList: true,
            subtree: true,
            characterData: true
        });
        
        cmScroller.addEventListener('scroll', () => {
            if (!this.dragState) {
                this.debounceRender();
            }
        });
    }

    debounceRender() {
        if (this.debounceTimeout) clearTimeout(this.debounceTimeout);
        this.debounceTimeout = setTimeout(() => {
            if (!this.dragState) {
                this.renderHandles();
            }
        }, 100);
    }
    
    forceRender() {
        if (this.debounceTimeout) clearTimeout(this.debounceTimeout);
        this.isHovering = false;
        this.selectedBlockIndex = null;
        if (!this.settings.enableBlockDragHandles) return;
        this.renderHandles();
    }

    getBlockType(lineEl) {
        if (!lineEl) return 'unknown';
        
        if (lineEl.querySelector('.internal-embed, .cm-embed-block, .dataview')) return 'embed';
        
        const classes = lineEl.className || '';
        
        if (classes.includes('HyperMD-callout') || lineEl.querySelector('.callout')) return 'callout';
        if (classes.includes('HyperMD-codeblock')) return 'code';
        if (classes.includes('HyperMD-table-row')) return 'table';
        if (classes.includes('HyperMD-list-line')) return 'list';
        if (classes.includes('HyperMD-header') || lineEl.querySelector('.cm-header')) return 'heading';
        if (classes.includes('HyperMD-quote')) return 'quote';
        if (classes.includes('HyperMD-hr')) return 'hr';
        
        return 'paragraph';
    }

    isSameBlock(type1, type2) {
        if (type1 === 'code' && type2 === 'code') return true;
        if (type1 === 'table' && type2 === 'table') return true;
        if (type1 === 'callout' && (type2 === 'callout' || type2 === 'quote')) return true;
        if (type1 === 'quote' && type2 === 'quote') return true;
        return false;
    }

    parseBlocksFromDOM() {
        if (!this.cmContent) return [];
        
        const lineEls = Array.from(this.cmContent.querySelectorAll('.cm-line'));
        const blocks = [];
        
        let i = 0;
        while (i < lineEls.length) {
            const lineEl = lineEls[i];
            if (!lineEl) {
                i++;
                continue;
            }
            
            const text = lineEl.textContent || '';
            const hasWidget = lineEl.querySelector('.internal-embed, .cm-embed-block, .dataview, .cm-widget');
            const isEmpty = text.trim() === '' && !hasWidget;
            
            const type = isEmpty ? 'empty' : this.getBlockType(lineEl);
            const startIdx = i;
            let endIdx = i;
            
            if (!isEmpty) {
                while (endIdx + 1 < lineEls.length) {
                    const nextEl = lineEls[endIdx + 1];
                    if (!nextEl) break;
                    
                    const nextText = nextEl.textContent || '';
                    const nextHasWidget = nextEl.querySelector('.internal-embed, .cm-embed-block, .dataview, .cm-widget');
                    const nextIsEmpty = nextText.trim() === '' && !nextHasWidget;
                    
                    if (nextIsEmpty) break;
                    
                    const nextType = this.getBlockType(nextEl);
                    if (this.isSameBlock(type, nextType)) {
                        endIdx++;
                    } else {
                        break;
                    }
                }
            }
            
            const elements = lineEls.slice(startIdx, endIdx + 1).filter(el => el != null);
            
            if (elements.length > 0) {
                blocks.push({
                    startIdx,
                    endIdx,
                    type,
                    isEmpty,
                    elements,
                    firstLineEl: elements[0]
                });
            }
            
            i = endIdx + 1;
        }
        
        return blocks;
    }

    renderHandles() {
        if (!this.handlesContainer || !this.activeView || !this.cmContent || !this.cmScroller) return;
        
        this.hideTimeouts.forEach(timeout => clearTimeout(timeout));
        this.hideTimeouts.clear();
        
        this.cleanupBlockEvents();
        
        document.querySelectorAll('.block-dnd-selected').forEach(el => {
            el.classList.remove('block-dnd-selected');
        });
        
        this.handlesContainer.innerHTML = '';
        this.handleWrappers.clear();
        
        const editor = this.activeView.editor;
        if (!editor) return;
        
        this.blocks = this.parseBlocksFromDOM();
        
        const scrollerRect = this.cmScroller.getBoundingClientRect();
        const scrollTop = this.cmScroller.scrollTop;

        const handleSize = this.isMobile ? 28 : 20;
        const innerPad = 2;
        const wrapperW = handleSize + innerPad * 2;
        const wrapperH = handleSize + innerPad * 2;

        this.blocks.forEach((block, blockIndex) => {
            if (block.isEmpty) return;

            const lineEl = block.firstLineEl;
            if (!lineEl || !lineEl.isConnected) return;

            const lineRect = lineEl.getBoundingClientRect();

            if (lineRect.bottom < scrollerRect.top || lineRect.top > scrollerRect.bottom) {
                return;
            }

            const top = lineRect.top - scrollerRect.top + scrollTop;

            const left = Number(this.handleSlotLeftPx) || 10;

            const wrapper = document.createElement('div');
            wrapper.className = 'block-dnd-handle-wrapper';
            wrapper.style.top = `${top}px`;
            wrapper.style.left = `${left}px`;
            wrapper.style.width = `${wrapperW}px`;
            wrapper.style.height = `${wrapperH}px`;

            const row = document.createElement('div');
            row.className = 'block-dnd-handle-row';

            const handle = document.createElement('div');
            handle.className = 'block-dnd-handle';
            handle.innerHTML = this.getHandleIcon();
            handle.dataset.blockIndex = blockIndex;

            row.appendChild(handle);
            wrapper.appendChild(row);

            if (this.isMobile) {
                const handleTouchStart = (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    e.stopImmediatePropagation();

                    const currentBlock = this.blocks[blockIndex];
                    if (currentBlock) {
                        this.onMobileHandleTouchStart(e, currentBlock, blockIndex, handle, wrapper);
                    }
                };

                handle.addEventListener('touchstart', handleTouchStart, { passive: false, capture: true });
            } else {
                handle.addEventListener('mousedown', (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    const currentBlock = this.blocks[blockIndex];
                    if (currentBlock) {
                        this.startDrag(e, currentBlock, blockIndex);
                    }
                });

                const showHandle = () => {
                    this.isHovering = true;
                    const timeout = this.hideTimeouts.get(blockIndex);
                    if (timeout) {
                        clearTimeout(timeout);
                        this.hideTimeouts.delete(blockIndex);
                    }
                    wrapper.classList.add('visible');
                };

                const hideHandle = () => {
                    const timeout = setTimeout(() => {
                        wrapper.classList.remove('visible');
                        this.hideTimeouts.delete(blockIndex);
                        const anyVisible = document.querySelector('.block-dnd-handle-wrapper.visible');
                        if (!anyVisible) {
                            this.isHovering = false;
                        }
                    }, 200);
                    this.hideTimeouts.set(blockIndex, timeout);
                };

                if (this.settings.showHandleOnHover) {
                    wrapper.addEventListener('mouseenter', showHandle);
                    wrapper.addEventListener('mouseleave', hideHandle);

                    block.elements.forEach(el => {
                        if (el?.addEventListener) {
                            const enterHandler = () => showHandle();
                            const leaveHandler = () => hideHandle();

                            el.addEventListener('mouseenter', enterHandler);
                            el.addEventListener('mouseleave', leaveHandler);

                            this.blockEventCleanups.push(() => {
                                el.removeEventListener('mouseenter', enterHandler);
                                el.removeEventListener('mouseleave', leaveHandler);
                            });
                        }
                    });
                } else if (this.shouldRevealHandles()) {
                    wrapper.classList.add('visible');
                }
            }

            this.handlesContainer.appendChild(wrapper);
            this.handleWrappers.set(blockIndex, wrapper);
        });
        
        if (this.isMobile && this.selectedBlockIndex !== null && this.blocks[this.selectedBlockIndex]) {
            this.selectBlock(this.selectedBlockIndex);
        }

        this.syncHandleRevealClass();
    }

    getHandleIcon() {
        return `<svg viewBox="0 0 24 24" fill="currentColor">
            <circle cx="9" cy="6" r="1.5"/>
            <circle cx="15" cy="6" r="1.5"/>
            <circle cx="9" cy="12" r="1.5"/>
            <circle cx="15" cy="12" r="1.5"/>
            <circle cx="9" cy="18" r="1.5"/>
            <circle cx="15" cy="18" r="1.5"/>
        </svg>`;
    }
    
    onMobileHandleTouchStart(e, block, blockIndex, handle, wrapper) {
        const touch = e.touches[0];
        this.touchStartPos = { x: touch.clientX, y: touch.clientY };
        
        handle.classList.add('active');
        
        this.longPressTimeout = setTimeout(() => {
            if (navigator.vibrate) navigator.vibrate(50);
            const currentBlock = this.blocks[blockIndex];
            if (currentBlock) {
                this.startDrag(e, currentBlock, blockIndex, true);
            }
        }, 150);
    }

    startDrag(e, block, blockIndex, isTouch = false) {
        const editor = this.activeView?.editor;
        if (!editor) {
            this.resetDragState();
            return;
        }
        
        if (!block.elements || block.elements.length === 0) {
            this.resetDragState();
            return;
        }
        
        const firstEl = block.elements[0];
        const lastEl = block.elements[block.elements.length - 1];
        
        if (!firstEl?.isConnected || !lastEl?.isConnected) {
            this.resetDragState();
            this.forceRender();
            return;
        }
        
        const clientY = isTouch ? e.touches[0].clientY : e.clientY;
        
        const cmView = editor.cm;
        let blockStartLine = null, blockEndLine = null;
        
        if (cmView) {
            try {
                blockStartLine = cmView.state.doc.lineAt(cmView.posAtDOM(firstEl)).number - 1;
                blockEndLine = cmView.state.doc.lineAt(cmView.posAtDOM(lastEl)).number - 1;
            } catch (err) {
                this.resetDragState();
                this.forceRender();
                return;
            }
        }
        
        if (blockStartLine === null || blockEndLine === null) {
            this.resetDragState();
            return;
        }
        
        if (isTouch && (!e.touches || !e.touches[0])) {
            this.resetDragState();
            return;
        }
        
        // Check if there's a text selection that includes this block
        const selection = this.getSelectionLineRange();
        let startLine = blockStartLine;
        let endLine = blockEndLine;
        let elementsToMark = block.elements;
        
        if (selection) {
            // Check if the block's first line is within the selection
            if (blockStartLine >= selection.fromLine && blockStartLine <= selection.toLine) {
                // Use the full selection range
                startLine = selection.fromLine;
                endLine = selection.toLine;
                
                // Mark all lines in selection as dragging
                const lineEls = this.cmContent.querySelectorAll('.cm-line');
                elementsToMark = [];
                for (let i = startLine; i <= endLine && i < lineEls.length; i++) {
                    elementsToMark.push(lineEls[i]);
                }
            }
        }
        
        this.hideTimeouts.forEach(timeout => clearTimeout(timeout));
        this.hideTimeouts.clear();
        
        this.isHovering = false;
        
        if (this.isMobile) {
            this.deselectBlock();
        }
        
        const clientX = isTouch ? e.touches[0].clientX : e.clientX;

        this.dragState = {
            block: { elements: elementsToMark },
            blockIndex,
            editor,
            startY: clientY,
            isTouch,
            startLine,
            endLine
        };
        
        elementsToMark.forEach(el => {
            if (el?.classList && el.isConnected) {
                el.classList.add('block-dnd-dragging');
            }
        });
        
        document.querySelectorAll('.block-dnd-handle-wrapper').forEach(w => {
            w.classList.remove('visible');
        });
        
        document.body.classList.add('block-dnd-dragging-active');
        
        if (!this.dragScrollRefreshBound && this.cmScroller) {
            this.dragScrollRefreshBound = () => {
                const s = this.dragState;
                if (s && s.lastClientX !== undefined && s.lastClientY !== undefined) {
                    this.updateIndicator(s.lastClientX, s.lastClientY);
                }
            };
            this.cmScroller.addEventListener('scroll', this.dragScrollRefreshBound, { passive: true });
        }

        if (!isTouch) {
            document.addEventListener('mousemove', this.onDrag);
            document.addEventListener('mouseup', this.endDrag);
        }

        this.updateIndicator(clientX, clientY);
    }

    onDrag = (e) => {
        if (!this.dragState) return;
        e.preventDefault();
        this.updateIndicator(e.clientX, e.clientY);
    }

    /**
     * Hit-testing: `posAtCoords` + `coordsAtPos` only (no .cm-line DOM walk).
     * `targetLine` is the insert-before index (0..lineCount) so merge / extend / moveLines stay correct:
     * use the hit line from `lineAt(pos)`, then if the pointer is in the lower half of that line's
     * screen band, treat the drop as after the line (insert-before index + 1).
     */
    updateIndicator(clientX, clientY) {
        if (!this.dragState || !this.dropIndicator) return;

        const cm = this.dragState.editor?.cm;
        if (!cm || typeof cm.posAtCoords !== 'function') {
            return;
        }

        const pos = cm.posAtCoords({ x: clientX, y: clientY }, -1);
        if (pos === null) {
            this.dropIndicator.classList.remove('visible');
            this.dropIndicator.style.display = 'none';
            return;
        }

        this.dragState.lastClientX = clientX;
        this.dragState.lastClientY = clientY;

        const doc = cm.state.doc;
        const hitLine = doc.lineAt(pos);
        let targetLine = hitLine.number - 1;
        const lineBand = cm.coordsAtPos(hitLine.from);
        if (lineBand) {
            const midY = (lineBand.top + lineBand.bottom) / 2;
            if (clientY >= midY) {
                targetLine = Math.min(targetLine + 1, doc.lines);
            }
        }

        this.dragState.targetLine = targetLine;

        let caretPos;
        if (targetLine >= doc.lines) {
            caretPos = doc.length;
        } else {
            caretPos = doc.line(targetLine + 1).from;
        }

        const coords = cm.coordsAtPos(caretPos);
        if (!coords) {
            this.dropIndicator.classList.remove('visible');
            this.dropIndicator.style.display = 'none';
            return;
        }

        const caretW = 2;
        const lineH = coords.bottom - coords.top;
        const h = Math.max(lineH, 16);

        this.dropIndicator.classList.add('visible');
        this.dropIndicator.style.display = 'block';
        this.dropIndicator.style.position = 'fixed';
        this.dropIndicator.style.left = `${coords.left - caretW / 2}px`;
        this.dropIndicator.style.width = `${caretW}px`;
        this.dropIndicator.style.top = `${coords.top}px`;
        this.dropIndicator.style.height = `${h}px`;
    }

    endDrag = () => {
        if (!this.dragState) {
            this.resetDragState();
            return;
        }
        
        const { block, editor, startLine, endLine, targetLine } = this.dragState;
        
        block.elements?.forEach(el => {
            if (el?.classList && el.isConnected) {
                el.classList.remove('block-dnd-dragging');
            }
        });
        
        document.body.classList.remove('block-dnd-dragging-active');
        
        if (this.dropIndicator) {
            this.dropIndicator.classList.remove('visible');
            this.dropIndicator.style.display = 'none';
        }
        
        document.removeEventListener('mousemove', this.onDrag);
        document.removeEventListener('mouseup', this.endDrag);

        if (this.cmScroller && this.dragScrollRefreshBound) {
            this.cmScroller.removeEventListener('scroll', this.dragScrollRefreshBound);
            this.dragScrollRefreshBound = null;
        }
        
        // Check if we should move - don't move inside the dragged range
        const shouldMove = targetLine !== undefined && 
            (targetLine < startLine || targetLine > endLine + 1);
        
        this.dragState = null;
        
        try {
            const singlePara = startLine === endLine && this.isParagraphLineForMerge(startLine);

            if (singlePara && !shouldMove) {
                if (this.tryMergeAdjacentParagraphLinesIntoColumns(editor, startLine, endLine, targetLine)) {
                    this.forceRender();
                    return;
                }
                this.forceRender();
                return;
            }

            if (shouldMove) {
                if (singlePara && this.tryExtendColumnBlockWithDrag(editor, startLine, endLine, targetLine)) {
                    this.forceRender();
                    return;
                }
                if (singlePara) {
                    const md = editor.getValue();
                    const fTouch = findColumnFenceTouchingTargetLine(md, targetLine);
                    const onColumnDrop =
                        fTouch &&
                        (startLine < fTouch.startLineIdx || startLine > fTouch.endLineIdx) &&
                        targetLine >= fTouch.startLineIdx &&
                        targetLine <= fTouch.endLineIdx + 1;
                    if (onColumnDrop && fTouch.parsed.meta.n >= 5) {
                        this.forceRender();
                        return;
                    }
                }
                this.moveLines(editor, startLine, endLine, targetLine);
            } else {
                this.forceRender();
            }
        } catch (err) {
            console.error('[Viper\'s Columns] Move error:', err);
            this.forceRender();
        }
    }

    addColumnsFromEditorContextMenu(markdownView, editor, columnCount) {
        if (!(markdownView instanceof obsidian.MarkdownView) || !editor?.cm) return;
        if (columnCount < 1 || columnCount > 5) return;

        const cmContent = markdownView.contentEl.querySelector('.cm-content');
        if (!cmContent) return;

        this.activeView = markdownView;
        this.cmContent = cmContent;
        this.cmScroller = markdownView.contentEl.querySelector('.cm-scroller');

        // "1 Column" = image | text side-by-side. Use the right-click target so we
        // wrap the image the user clicked, not wherever the cursor happens to be.
        if (columnCount === 1) {
            this.replaceWithOneColumnBesideImage(editor);
            return;
        }

        const cm = editor.cm;
        const headPos = cm.state.selection.main.head;

        this.blocks = this.parseBlocksFromDOM();
        let blockIdx = null;

        // Prefer click coords when available; else cursor coords.
        const ptr = this.lastPointerContext;
        const clickX = ptr && Date.now() - ptr.time < 8000 ? ptr.x : null;
        const clickY = ptr && Date.now() - ptr.time < 8000 ? ptr.y : null;
        const coords =
            clickX != null && clickY != null
                ? { left: clickX, top: clickY }
                : cm.coordsAtPos(headPos);
        if (coords) {
            const lineEls = Array.from(cmContent.querySelectorAll('.cm-line'));
            let closestEl = null;
            let closestDist = Infinity;
            for (const el of lineEls) {
                const rect = el.getBoundingClientRect();
                const midY = (rect.top + rect.bottom) / 2;
                const midX = (rect.left + rect.right) / 2;
                const dist =
                    clickX != null
                        ? Math.hypot(coords.left - midX, coords.top - midY)
                        : Math.abs(coords.top - midY);
                if (dist < closestDist) {
                    closestDist = dist;
                    closestEl = el;
                }
            }
            if (closestEl) {
                for (let i = 0; i < this.blocks.length; i++) {
                    if (this.blocks[i].elements.includes(closestEl)) {
                        blockIdx = i;
                        break;
                    }
                }
            }
        }

        if (blockIdx === null) {
            const line0 = cm.state.doc.lineAt(headPos).number - 1;
            for (let i = 0; i < this.blocks.length; i++) {
                const b = this.blocks[i];
                if (line0 >= b.startIdx && line0 <= b.endIdx) {
                    blockIdx = i;
                    break;
                }
            }
        }

        if (blockIdx === null) return;

        const cursorLine0 = cm.state.doc.lineAt(headPos).number - 1;
        this.replaceBlockWithColumns(blockIdx, columnCount, cursorLine0);
    }

    /**
     * Half-width layout: keep the clicked image on the left (path stored in meta)
     * and a resizable text box on the right. Never drops the image from the note.
     */
    replaceWithOneColumnBesideImage(editor) {
        const cmView = editor?.cm;
        if (!cmView) return;
        const doc = cmView.state.doc;
        const headPos = cmView.state.selection.main.head;
        const cursorLine0 = doc.lineAt(headPos).number - 1;

        let clicked = resolveClickedImageTarget(this.app, cmView, this.lastPointerContext);

        // Fall back to document scan near the cursor / selection.
        let pair = null;
        if (clicked?.imageMd && clicked.line) {
            let right = clicked.sideText || '';
            let from = clicked.line.from;
            let to = clicked.line.to;
            if (!right) {
                const after = findAdjacentMatchingLine(doc, clicked.line0, 'after', isSimpleSideParagraphLine);
                if (after) {
                    right = after.text.trim();
                    to = after.line.to;
                } else {
                    const before = findAdjacentMatchingLine(
                        doc,
                        clicked.line0,
                        'before',
                        isSimpleSideParagraphLine
                    );
                    if (before) {
                        right = before.text.trim();
                        from = before.line.from;
                    }
                }
            }
            pair = {
                left: clicked.imageMd,
                right,
                from,
                to,
                imagePath: clicked.imagePath,
                imageWidth: clicked.width,
            };
        } else if (clicked?.imageMd && clicked.imagePath) {
            // Synthetic path from embed src with no reliable line — search whole doc.
            const found = findDocLineForImagePath(doc, clicked.imagePath);
            if (found) {
                let right = found.sideText || '';
                let from = found.line.from;
                let to = found.line.to;
                if (!right) {
                    const after = findAdjacentMatchingLine(
                        doc,
                        found.line0,
                        'after',
                        isSimpleSideParagraphLine
                    );
                    if (after) {
                        right = after.text.trim();
                        to = after.line.to;
                    }
                }
                pair = {
                    left: found.imageMd,
                    right,
                    from,
                    to,
                    imagePath: found.imagePath,
                    imageWidth: found.width ?? clicked.width,
                };
            } else {
                // Insert a new column fence at the cursor that still references the image.
                const line = doc.lineAt(headPos);
                pair = {
                    left: clicked.imageMd,
                    right: '',
                    from: line.from,
                    to: line.to,
                    imagePath: clicked.imagePath,
                    imageWidth: clicked.width,
                    insertOnly: true,
                };
            }
        } else {
            pair = resolveOneColumnPair(doc, cursorLine0, cursorLine0, cursorLine0);
            const re = new RegExp(BDND_WIKI_EMBED_RE_SOURCE);
            const m = re.exec(pair.left || '');
            if (m) {
                const hit = bdndWikiMatchFromExec(m);
                pair.imagePath = hit.linkPathRaw;
                pair.imageWidth = hit.width;
            }
        }

        if (!pair) return;

        let from = pair.from;
        let to = pair.to;
        let leftBody = pair.left || '';
        let rightBody = pair.right || '';

        // If left still isn't an image but we know imagePath, force wiki markdown in.
        if (pair.imagePath && !bodyLooksLikeImageOnly(leftBody)) {
            leftBody =
                pair.imageWidth && pair.imageWidth > 0
                    ? `![[${pair.imagePath}|${pair.imageWidth}]]`
                    : `![[${pair.imagePath}]]`;
        }

        const id = randomBlockId();
        const n = 2;
        const widths = equalWidthPercents(n);
        let bodies = [leftBody, rightBody];

        const oldSlice = pair.insertOnly ? '' : cmView.state.sliceDoc(from, to);
        if (!pair.insertOnly) {
            bodies = bdndPreserveEmbedsInBodies(oldSlice, bodies);
        }

        // Last resort: if the replace range still contains embeds missing from bodies
        // (shouldn't happen), abort rather than delete the picture.
        if (!pair.insertOnly) {
            const oldEmbeds = oldSlice.match(new RegExp(BDND_WIKI_EMBED_RE_SOURCE, 'g')) || [];
            const joined = bodies.join('\n');
            for (const emb of oldEmbeds) {
                if (!joined.includes(emb)) {
                    console.error(
                        "[Viper's Columns] Refusing to apply 1 Column — would delete image:",
                        emb
                    );
                    return;
                }
            }
        }

        // Persist vault path in meta so the renderer does not depend on MarkdownRenderer.
        let imagePath = pair.imagePath || null;
        let imageWidth = pair.imageWidth || null;
        if (!imagePath) {
            const re = new RegExp(BDND_WIKI_EMBED_RE_SOURCE);
            const m = re.exec(bodies[0] || '');
            if (m) {
                const hit = bdndWikiMatchFromExec(m);
                imagePath = hit.linkPathRaw;
                imageWidth = hit.width;
            }
        }

        const meta = {
            id,
            n,
            widths,
            singleCol: true,
            ...(imagePath ? { imagePath, imageWidth } : {}),
        };
        const inner = serializeColumnFence(meta, bodies);
        const fence = wrapColumnFenceInner(inner, pair.insertOnly ? false : oldSlice.endsWith('\n'));

        const charAfterTo = cmView.state.doc.sliceString(to, Math.min(to + 1, cmView.state.doc.length));
        const needsTrailingNewline = !fence.endsWith('\n') && charAfterTo !== '\n';
        const insertText = needsTrailingNewline ? fence + '\n' : fence;
        const cursorBelowFence = from + (fence.endsWith('\n') ? fence.length : fence.length + 1);

        cmView.dispatch({
            changes: { from, to, insert: insertText },
            selection: { anchor: cursorBelowFence, head: cursorBelowFence },
            userEvent: 'block-dnd.columns'
        });

        setTimeout(() => this.forceRender(), 60);
    }

    replaceBlockWithColumns(blockIndex, columnCount, cursorLine0) {
        const editor = this.activeView?.editor;
        const cmView = editor?.cm;
        const block = this.blocks[blockIndex];
        if (!editor || !cmView || !block || columnCount < 1 || columnCount > 5) {
            return;
        }

        // 1 Column has a dedicated path (click-target + imagePath meta).
        if (columnCount === 1) {
            this.replaceWithOneColumnBesideImage(editor);
            return;
        }

        const firstEl = block.elements[0];
        const lastEl = block.elements[block.elements.length - 1];

        let blockStartLine;
        let blockEndLine;
        try {
            blockStartLine = cmView.state.doc.lineAt(cmView.posAtDOM(firstEl)).number - 1;
            blockEndLine = cmView.state.doc.lineAt(cmView.posAtDOM(lastEl)).number - 1;
        } catch {
            const fallback =
                typeof cursorLine0 === 'number'
                    ? cursorLine0
                    : cmView.state.doc.lineAt(cmView.state.selection.main.head).number - 1;
            blockStartLine = fallback;
            blockEndLine = fallback;
        }

        const doc = cmView.state.doc;
        const from = doc.line(blockStartLine + 1).from;
        const to = doc.line(blockEndLine + 1).to;

        const id = randomBlockId();
        const n = columnCount;
        const widths = equalWidthPercents(n);
        const extracted = cmView.state.sliceDoc(from, to);
        let bodies = Array.from({ length: n }, (_, i) => {
            if (i === 0) return extracted;
            return `_Column ${i + 1}_`;
        });

        const oldSlice = cmView.state.sliceDoc(from, to);
        bodies = bdndPreserveEmbedsInBodies(oldSlice, bodies);

        const meta = { id, n, widths };
        const inner = serializeColumnFence(meta, bodies);
        let fence = wrapColumnFenceInner(inner, oldSlice.endsWith('\n'));

        // Land the CM cursor outside the fence so Live Preview renders the column
        // widget (with markdown preview) instead of showing raw fence source.
        const charAfterTo = cmView.state.doc.sliceString(to, Math.min(to + 1, cmView.state.doc.length));
        const needsTrailingNewline = !fence.endsWith('\n') && charAfterTo !== '\n';
        let insertText = fence;
        if (needsTrailingNewline) {
            insertText = fence + '\n';
        }
        const cursorBelowFence = from + (fence.endsWith('\n') ? fence.length : fence.length + 1);

        cmView.dispatch({
            changes: { from, to, insert: insertText },
            selection: { anchor: cursorBelowFence, head: cursorBelowFence },
            userEvent: 'block-dnd.columns'
        });

        // Do not auto-focus the column textarea — that forced raw ![[...]] source
        // into view. Preview mode shows the rendered image with text beside it.
        setTimeout(() => this.forceRender(), 60);
    }

    async _persistColumnFence(sourcePath, meta, bodies, userEvent = 'block-dnd.column-edit') {
        const inner = serializeColumnFence(meta, bodies);

        const activeView = this.app.workspace.getActiveViewOfType(obsidian.MarkdownView);
        const activeFile = activeView?.file;

        if (activeView && activeFile && activeFile.path === sourcePath && activeView.editor?.cm) {
            const md = activeView.editor.getValue();
            const range = findFenceRangeById(md, meta.id);
            if (!range) return;

            const oldSlice = md.slice(range.from, range.to);
            const fence = wrapColumnFenceInner(inner, oldSlice.endsWith('\n'));

            const cm = activeView.editor.cm;
            cm.dispatch({
                changes: { from: range.from, to: range.to, insert: fence },
                userEvent
            });
            return;
        }

        const file = this.app.vault.getAbstractFileByPath(sourcePath);
        if (file instanceof obsidian.TFile) {
            const md = await this.app.vault.read(file);
            const range = findFenceRangeById(md, meta.id);
            if (!range) return;

            const oldSlice = md.slice(range.from, range.to);
            const fence = wrapColumnFenceInner(inner, oldSlice.endsWith('\n'));

            const next = md.slice(0, range.from) + fence + md.slice(range.to);
            await this.app.vault.modify(file, next);
        }
    }

    scheduleColumnBodyPersist(uuid, root, sourcePath) {
        const prev = this.columnBodyPersistTimers.get(uuid);
        if (prev) clearTimeout(prev);

        const tid = window.setTimeout(async () => {
            this.columnBodyPersistTimers.delete(uuid);
            await this.flushColumnBodiesFromRoot(uuid, root, sourcePath);
        }, 420);

        this.columnBodyPersistTimers.set(uuid, tid);
    }

    async flushColumnBodiesFromRoot(uuid, root, sourcePath, opts = {}) {
        if (!root) return;
        const textareas = root.querySelectorAll('.block-dnd-col-editor');
        const newBodies = Array.from(textareas).map(t => t.value);
        // A remount can fire blur on a torn-down widget with 0 textareas —
        // never persist that, or column text is wiped.
        if (!newBodies.length) return;

        // Rewriting the fence remounts the Live Preview widget. If the user is
        // still editing a cell, capture caret so we can put them back.
        const focus =
            opts.restoreFocus === false ? null : captureColumnEditorFocus(root);

        const activeView = this.app.workspace.getActiveViewOfType(obsidian.MarkdownView);
        const md =
            activeView?.file?.path === sourcePath ? activeView.editor?.getValue() : null;

        let parsed;
        if (!md) {
            const file = this.app.vault.getAbstractFileByPath(sourcePath);
            if (!(file instanceof obsidian.TFile)) return;
            const diskMd = await this.app.vault.read(file);
            const range = findFenceRangeById(diskMd, uuid);
            if (!range) return;
            parsed = parseColumnFenceSource(range.inner);
        } else {
            const range = findFenceRangeById(md, uuid);
            if (!range) return;
            parsed = parseColumnFenceSource(range.inner);
        }
        if (!parsed) return;

        if (parsed.meta.n && newBodies.length !== parsed.meta.n) return;

        const hadContent = (parsed.bodies || []).some((b) => String(b || '').trim());
        const allEmpty = newBodies.every((b) => !String(b || '').trim());
        if (hadContent && allEmpty) return;
        if (columnBodiesEqual(parsed.bodies, newBodies)) return;

        const nCols = newBodies.length;
        let w = (parsed.meta.widths || []).map(Number).filter(x => !Number.isNaN(x));
        if (w.length !== nCols) w = equalWidthPercents(nCols);
        w = normalizePercents(w);
        const meta = {
            ...parsed.meta,
            id: uuid,
            n: nCols,
            widths: w
        };

        this._columnPersistRemounting = uuid;
        try {
            await this._persistColumnFence(sourcePath, meta, newBodies);
        } finally {
            window.setTimeout(() => {
                if (this._columnPersistRemounting === uuid) this._columnPersistRemounting = null;
            }, 200);
        }

        if (focus) restoreColumnEditorFocus(uuid, focus);
    }

    async persistColumnFenceWidths(sourcePath, uuid, widthsNorm, bodiesSnapshot, metaBase) {
        const n = widthsNorm.length;
        const meta = { ...metaBase, id: uuid, n, widths: widthsNorm };
        await this._persistColumnFence(sourcePath, meta, bodiesSnapshot, 'block-dnd.resize-col');
    }

    keepCmCaretOutsideColumnFence(uuid, sourcePath) {
        try {
            const mv = this.app.workspace.getActiveViewOfType(obsidian.MarkdownView);
            if (!mv?.editor?.cm) return;
            if (sourcePath && mv.file?.path !== sourcePath) return;
            const cm = mv.editor.cm;
            const md = mv.editor.getValue();
            const range = findFenceRangeById(md, uuid);
            if (!range) return;
            const head = cm.state.selection.main.head;
            if (head >= range.from && head < range.to) {
                const pos = Math.min(range.to, cm.state.doc.length);
                cm.dispatch({
                    selection: { anchor: pos, head: pos },
                    userEvent: 'block-dnd.keep-outside-fence'
                });
            }
        } catch {
            /* noop */
        }
    }

    async exitColumnEditToNote(uuid, root, sourcePath, opts = {}) {
        const prevTimer = this.columnBodyPersistTimers.get(uuid);
        if (prevTimer) clearTimeout(prevTimer);
        this.columnBodyPersistTimers.delete(uuid);
        try {
            // Tab exits the columns — do not restore focus into a remounted cell.
            await this.flushColumnBodiesFromRoot(uuid, root, sourcePath, { restoreFocus: false });
        } catch {
            /* noop */
        }
        const mv = this.app.workspace.getActiveViewOfType(obsidian.MarkdownView);
        if (!mv?.editor?.cm || mv.file?.path !== sourcePath) return;
        const cm = mv.editor.cm;
        const md = mv.editor.getValue();
        const range = findFenceRangeById(md, uuid);
        if (!range) {
            cm.focus();
            return;
        }
        let pos;
        if (opts.before) {
            pos = Math.max(0, range.from);
        } else {
            pos = Math.min(range.to, cm.state.doc.length);
        }
        cm.dispatch({
            selection: { anchor: pos, head: pos },
            userEvent: 'block-dnd.column-exit-tab'
        });
        cm.focus();
    }

    async renderColumnCodeBlock(source, el, ctx) {
        el.innerHTML = '';
        el.classList.add('block-dnd-columns-embed');
        el.style.pointerEvents = 'auto';
        el.style.position = 'relative';
        el.style.zIndex = '6';
        // Nested non-editable region so Live Preview does not put the caret
        // inside the fence (which unmounts the widget and clears cell text).
        el.setAttribute('contenteditable', 'false');

        const trimmed = source.replace(/\s+$/, '');
        const parsed = parseColumnFenceSource(trimmed);
        if (!parsed) {
            const pre = document.createElement('pre');
            pre.textContent = source;
            el.appendChild(pre);
            return;
        }

        let { meta, bodies } = parsed;
        const n = meta.n;
        let widths = (meta.widths || []).map(Number).filter(x => !Number.isNaN(x));
        if (widths.length !== n) {
            widths = equalWidthPercents(n);
        }
        widths = normalizePercents(widths);

        const root = document.createElement('div');
        root.className = 'block-dnd-columns-root';
        root.dataset.blockDndId = meta.id;
        if (ctx.sourcePath) root.dataset.sourcePath = ctx.sourcePath;
        root.setAttribute('contenteditable', 'false');
        if (meta.singleCol) root.classList.add('block-dnd-single-col');
        el.appendChild(root);

        const gutterTrackPx = this.isMobile ? 16 : 14;

        // Flex row keeps image + text truly inline and top-aligned (grid was
        // letting embeds visually drop below the row in Live Preview).
        const applyTracks = (perc) => {
            const cells = root.querySelectorAll(':scope > .block-dnd-col-cell');
            const gutters = root.querySelectorAll(':scope > .block-dnd-col-gutter');
            cells.forEach((cell, idx) => {
                if (!(cell instanceof HTMLElement)) return;
                const pct = perc[idx] ?? 0;
                cell.style.flexGrow = String(pct);
                cell.style.flexShrink = '1';
                cell.style.flexBasis = '0';
                cell.style.minWidth = '0';
                cell.style.maxWidth = 'none';
            });
            gutters.forEach((gutter) => {
                if (!(gutter instanceof HTMLElement)) return;
                gutter.style.flexGrow = '0';
                gutter.style.flexShrink = '0';
                gutter.style.flexBasis = `${gutterTrackPx}px`;
                gutter.style.width = `${gutterTrackPx}px`;
                gutter.style.alignSelf = 'stretch';
            });
        };

        let syncHostChild = null;

        for (let i = 0; i < n; i++) {
            const cell = document.createElement('div');
            cell.className = 'block-dnd-col-cell';
            if (i < n - 1) cell.style.paddingRight = '14px';
            if (i > 0) cell.style.paddingLeft = '14px';
            root.appendChild(cell);

            const wrap = document.createElement('div');
            wrap.className = 'block-dnd-col-editor-wrap';
            cell.appendChild(wrap);

            const bodyText = bodies[i] ?? '';
            // meta.imagePath is the durable reference written when creating 1 Column
            // from a right-clicked Live Preview embed (body markdown alone is not enough).
            const metaImagePath = i === 0 && meta.imagePath ? String(meta.imagePath) : '';
            const imageOnly = !!metaImagePath || bodyLooksLikeImageOnly(bodyText);
            // Image slots stay in preview mode so the picture does not "disappear"
            // into raw ![[...]] source on click.
            // Text cells always show a real textarea (same as 1 Column's side box).
            // 1 Column text box height is synced to the image (see bdndSyncSingleColTextHeight).
            const alwaysShowEditor = !imageOnly;
            if (alwaysShowEditor) wrap.classList.add('always-show-editor');
            if (imageOnly) wrap.classList.add('image-preview-cell');

            const previewEl = document.createElement('div');
            previewEl.className = 'block-dnd-col-preview markdown-rendered';

            // Paint meta image immediately (does not wait on MarkdownRenderer / input hooks).
            if (metaImagePath) {
                bdndAppendResolvedImage(
                    this.app,
                    previewEl,
                    metaImagePath,
                    ctx.sourcePath,
                    meta.imageWidth || null,
                    null
                );
            }

            const ta = document.createElement('textarea');
            ta.className = 'block-dnd-col-editor';
            ta.value = bodyText || (metaImagePath ? `![[${metaImagePath}${meta.imageWidth ? '|' + meta.imageWidth : ''}]]` : '');
            if (alwaysShowEditor && meta.singleCol) {
                // Avoid rows-based intrinsic height fighting image-height sync.
                ta.rows = 1;
                ta.style.resize = 'none';
                ta.style.overflow = 'auto';
            } else {
                ta.rows = Math.min(14, Math.max(alwaysShowEditor ? 4 : 3, (ta.value || '').split('\n').length));
                if (alwaysShowEditor) {
                    ta.style.minHeight = '4.5em';
                }
            }
            ta.spellcheck = true;
            ta.autocomplete = 'off';
            ta.setAttribute('aria-label', `Column ${i + 1}`);

            const markdownChild = new obsidian.MarkdownRenderChild(previewEl);
            if (typeof ctx.addChild === 'function') {
                ctx.addChild(markdownChild);
            } else if (typeof this.addChild === 'function') {
                this.addChild(markdownChild);
            }
            syncHostChild = markdownChild;

            const enterEditMode = () => {
                if (imageOnly) return;
                wrap.classList.add('is-editing');
                cell.classList.add('is-editing-cell');
            };
            const leaveEditMode = () => {
                cell.classList.remove('is-editing-cell');
                if (alwaysShowEditor) return;
                wrap.classList.remove('is-editing');
            };

            previewEl.addEventListener('pointerdown', (e) => {
                e.stopPropagation();
            });
            previewEl.addEventListener('mousedown', (e) => {
                e.stopPropagation();
            });
            previewEl.addEventListener('click', (e) => {
                e.stopPropagation();
                if (imageOnly) return;
                enterEditMode();
                ta.focus({ preventScroll: true });
                try {
                    const len = ta.value.length;
                    ta.setSelectionRange(len, len);
                } catch {
                    /* noop */
                }
            });
            // Double-click image cell if raw markdown edit is needed.
            previewEl.addEventListener('dblclick', (e) => {
                if (!imageOnly) return;
                e.stopPropagation();
                wrap.classList.add('is-editing');
                ta.focus({ preventScroll: true });
            });

            ta.addEventListener('pointerdown', (e) => {
                e.stopPropagation();
            });
            ta.addEventListener('mousedown', (e) => {
                e.stopPropagation();
            });
            ta.addEventListener('click', (e) => {
                e.stopPropagation();
            });
            ta.addEventListener('focus', () => {
                enterEditMode();
            });

            ta.addEventListener('keydown', (e) => {
                if (e.key === 'Escape') {
                    e.preventDefault();
                    e.stopPropagation();
                    ta.blur();
                    return;
                }
                if (isColumnTabKey(e)) {
                    e.preventDefault();
                    e.stopPropagation();
                    if (typeof e.stopImmediatePropagation === 'function') e.stopImmediatePropagation();
                    void this.exitColumnEditToNote(meta.id, root, ctx.sourcePath, {
                        before: !!e.shiftKey,
                    });
                    leaveEditMode();
                    return;
                }
                if (isColumnPlainEnterKey(e)) {
                    // Own the newline: never let Enter leave the column panel.
                    e.preventDefault();
                    e.stopPropagation();
                    if (typeof e.stopImmediatePropagation === 'function') e.stopImmediatePropagation();
                    insertNewlineInColumnTextarea(ta);
                }
            }, true);

            // Do NOT persist on every keystroke. Rewriting the fence remounts the
            // Live Preview widget and kicks focus out of the panel (Enter looked
            // like "newline then exit"). Save on blur / Tab instead.
            ta.addEventListener('blur', () => {
                if (this._columnPersistRemounting === meta.id) return;
                const prev = this.columnBodyPersistTimers.get(meta.id);
                if (prev) clearTimeout(prev);
                this.columnBodyPersistTimers.delete(meta.id);
                window.setTimeout(() => {
                    if (this._columnPersistRemounting === meta.id) return;
                    const next = document.activeElement;
                    const stayingInColumns =
                        next instanceof HTMLTextAreaElement &&
                        next.classList.contains('block-dnd-col-editor') &&
                        (root.contains(next) ||
                            !!next.closest(`.block-dnd-columns-root[data-block-dnd-id="${meta.id}"]`));
                    void this.flushColumnBodiesFromRoot(meta.id, root, ctx.sourcePath, {
                        restoreFocus: stayingInColumns,
                    });
                    if (!stayingInColumns && document.activeElement !== ta) leaveEditMode();
                }, 0);
            });

            ta.addEventListener('input', () => {
                if (meta.singleCol && alwaysShowEditor) {
                    ta.rows = 1;
                    return;
                }
                ta.rows = Math.min(14, Math.max(3, (ta.value || '').split('\n').length));
            });

            wrap.appendChild(previewEl);
            wrap.appendChild(ta);

            bdndAttachColumnZotionCompat({
                app: this.app,
                sourcePath: ctx.sourcePath,
                ta,
                previewEl,
                markdownChild,
                refreshRows: () => {
                    if (meta.singleCol && alwaysShowEditor) {
                        ta.rows = 1;
                        bdndSyncSingleColTextHeight(root);
                        return;
                    }
                    ta.rows = Math.min(14, Math.max(alwaysShowEditor ? 4 : 3, (ta.value || '').split('\n').length));
                    if (meta.singleCol) bdndSyncSingleColTextHeight(root);
                },
            });

            if (i < n - 1) {
                const gutterEl = document.createElement('div');
                gutterEl.className = 'block-dnd-col-gutter';

                const gutterLine = document.createElement('div');
                gutterLine.className = 'block-dnd-col-gutter-line';
                gutterEl.appendChild(gutterLine);

                root.appendChild(gutterEl);

                const gi = i;

                gutterEl.addEventListener('pointerdown', (ev) => {
                    ev.preventDefault();
                    ev.stopPropagation();

                    gutterEl.classList.add('block-dnd-gutter-active');

                    let perc = normalizePercents([...widths]);

                    const totalGutter = (n - 1) * gutterTrackPx;

                    const onMove = (e) => {
                        const rect = root.getBoundingClientRect();
                        const colsPx = Math.max(1, rect.width - totalGutter);
                        const deltaPct = (e.movementX / colsPx) * 100;
                        let a = perc[gi] + deltaPct;
                        let b = perc[gi + 1] - deltaPct;
                        const minPct = MIN_COL_WIDTH_PCT;
                        if (a < minPct) {
                            b -= minPct - a;
                            a = minPct;
                        }
                        if (b < minPct) {
                            a -= minPct - b;
                            b = minPct;
                        }
                        perc[gi] = a;
                        perc[gi + 1] = b;
                        perc = normalizePercents(perc);
                        applyTracks(perc);
                        if (meta.singleCol) bdndSyncSingleColTextHeight(root);
                    };

                    const onUp = async () => {
                        gutterEl.classList.remove('block-dnd-gutter-active');

                        document.removeEventListener('pointermove', onMove);
                        document.removeEventListener('pointerup', onUp);
                        document.removeEventListener('pointercancel', onUp);
                        try {
                            gutterEl.releasePointerCapture(ev.pointerId);
                        } catch {
                            /* noop */
                        }

                        const latestPerc = normalizePercents(perc);
                        for (let k = 0; k < widths.length; k++) widths[k] = latestPerc[k];

                        let bodiesLive = Array.from(root.querySelectorAll('.block-dnd-col-editor')).map(t => t.value);
                        if (bodiesLive.length !== n) {
                            bodiesLive = [...bodies];
                            const mdSnapshot = this.app.workspace.getActiveViewOfType(obsidian.MarkdownView)?.editor?.getValue();
                            if (mdSnapshot) {
                                const range = findFenceRangeById(mdSnapshot, meta.id);
                                if (range) {
                                    const fresh = parseColumnFenceSource(range.inner);
                                    if (fresh) bodiesLive = fresh.bodies;
                                }
                            }
                        }

                        await this.persistColumnFenceWidths(ctx.sourcePath, meta.id, latestPerc, bodiesLive, meta);
                    };

                    gutterEl.setPointerCapture(ev.pointerId);
                    document.addEventListener('pointermove', onMove);
                    document.addEventListener('pointerup', onUp);
                    document.addEventListener('pointercancel', onUp);
                });
            }
        }

        applyTracks(widths);

        if (meta.singleCol) {
            bdndAttachSingleColHeightSync(root, syncHostChild);
        }

        const plugin = this;
        const sourcePath = ctx.sourcePath;
        const blockId = meta.id;

        const columnChromePointerDown = (ev) => {
            const t = ev.target;
            if (!(t instanceof HTMLElement)) return;
            if (t.closest('.block-dnd-col-editor') || t.closest('.block-dnd-col-gutter')) return;
            if (t.closest('.block-dnd-col-preview')) return;
            if (t.closest('.block-dnd-col-cell')) {
                ev.stopPropagation();
                return;
            }

            ev.preventDefault();
            ev.stopPropagation();
            if (typeof ev.stopImmediatePropagation === 'function') ev.stopImmediatePropagation();

            const mv = plugin.app.workspace.getActiveViewOfType(obsidian.MarkdownView);
            if (!mv?.editor?.cm || mv.file?.path !== sourcePath) return;

            const cm = mv.editor.cm;
            cm.focus();

            try {
                const md = mv.editor.getValue();
                const range = findFenceRangeById(md, blockId);
                if (range) {
                    const anchor = Math.min(range.to, cm.state.doc.length);
                    cm.dispatch({
                        selection: { anchor, head: anchor },
                        userEvent: 'block-dnd.focus-main'
                    });
                }
            } catch {
                /* noop */
            }
        };

        el.addEventListener('pointerdown', columnChromePointerDown, true);
        el.addEventListener('mousedown', columnChromePointerDown, true);
    }

    isParagraphLineForMerge(lineIdx0) {
        const els = this.cmContent?.querySelectorAll('.cm-line');
        const el = els?.[lineIdx0];
        if (!el) return false;
        const text = el.textContent || '';
        if (!text.trim()) return false;
        return this.getBlockType(el) === 'paragraph';
    }

    tryMergeAdjacentParagraphLinesIntoColumns(editor, startLine, endLine, targetLine) {
        if (targetLine === undefined) return false;
        const cm = editor?.cm;
        if (!cm || startLine !== endLine) return false;
        if (!this.isParagraphLineForMerge(startLine)) return false;

        const docLines = cm.state.doc.lines;
        let lineA;
        let lineB;
        if (targetLine === startLine + 1 && startLine + 1 < docLines) {
            lineA = startLine;
            lineB = startLine + 1;
        } else if (targetLine === startLine && startLine > 0) {
            lineA = startLine - 1;
            lineB = startLine;
        } else {
            return false;
        }

        if (!this.isParagraphLineForMerge(lineA) || !this.isParagraphLineForMerge(lineB)) return false;

        const { from, to } = cmLinePairExclusiveExtent(cm, lineA, lineB);
        const oldSlice = cm.state.doc.sliceString(from, to);
        const t0 = cm.state.doc.sliceString(cm.state.doc.line(lineA + 1).from, cm.state.doc.line(lineA + 1).to);
        const t1 = cm.state.doc.sliceString(cm.state.doc.line(lineB + 1).from, cm.state.doc.line(lineB + 1).to);

        const id = randomBlockId();
        const inner = serializeColumnFence({ id, n: 2, widths: equalWidthPercents(2) }, [t0, t1]);
        const fenceOut = wrapColumnFenceInner(inner, oldSlice.endsWith('\n'));

        cm.dispatch({
            changes: { from, to, insert: fenceOut },
            userEvent: 'block-dnd.column-merge-adjacent'
        });
        if (this.isMobile && navigator.vibrate) navigator.vibrate(30);
        return true;
    }

    tryExtendColumnBlockWithDrag(editor, startLine, endLine, targetLine) {
        if (targetLine === undefined) return false;
        const cm = editor?.cm;
        if (!cm || startLine !== endLine) return false;
        if (!this.isParagraphLineForMerge(startLine)) return false;

        const md = editor.getValue();
        const f0 = findColumnFenceTouchingTargetLine(md, targetLine);
        if (!f0 || f0.parsed.meta.n >= 5) return false;

        if (!(startLine < f0.startLineIdx || startLine > f0.endLineIdx)) return false;

        const lineArr = md.split('\n');
        const dragged = lineArr[startLine];
        lineArr.splice(startLine, 1);
        const newTarget = targetLine > startLine ? targetLine - 1 : targetLine;
        const newMd = lineArr.join('\n');

        const f = findColumnFenceTouchingTargetLine(newMd, newTarget);
        if (!f) return false;

        const prepend = newTarget <= f.startLineIdx;
        const bodies = prepend ? [dragged, ...f.parsed.bodies] : [...f.parsed.bodies, dragged];
        const meta = {
            ...f.parsed.meta,
            id: f.parsed.meta.id,
            n: bodies.length,
            widths: equalWidthPercents(bodies.length)
        };
        const inner = serializeColumnFence(meta, bodies);
        const oldSlice = newMd.slice(f.from, f.to);
        const fenceOut = wrapColumnFenceInner(inner, oldSlice.endsWith('\n'));
        const nextMd = newMd.slice(0, f.from) + fenceOut + newMd.slice(f.to);

        cm.dispatch({
            changes: { from: 0, to: cm.state.doc.length, insert: nextMd },
            userEvent: 'block-dnd.column-drag-extend'
        });
        if (this.isMobile && navigator.vibrate) navigator.vibrate(30);
        return true;
    }

    moveLines(editor, startLine, endLine, targetLine) {
        const cmView = editor.cm;
        if (!cmView) {
            this.forceRender();
            return;
        }
        
        const lineCount = endLine - startLine + 1;
        const movingDown = targetLine > endLine;
        
        const lines = editor.getValue().split('\n');
        const blockLines = lines.splice(startLine, lineCount);
        
        let insertAt = targetLine;
        if (movingDown) {
            insertAt = targetLine - lineCount;
        }
        
        lines.splice(insertAt, 0, ...blockLines);
        
        const newContent = lines.join('\n');
        const doc = cmView.state.doc;

        let anchor = 0;
        for (let i = 0; i < insertAt; i++) {
            anchor += lines[i].length + 1;
        }
        if (insertAt < 0 || insertAt > lines.length) {
            anchor = newContent.length;
        }

        let preOffsetFromScrollerTop = null;
        if (this.cmContent && this.cmScroller) {
            const lineElsBefore = this.cmContent.querySelectorAll('.cm-line');
            const preEl = lineElsBefore[startLine];
            if (preEl) {
                preOffsetFromScrollerTop = preEl.getBoundingClientRect().top - this.cmScroller.getBoundingClientRect().top;
            }
        }

        const restoreBlockScrollPosition = () => {
            if (preOffsetFromScrollerTop === null || !this.cmContent || !this.cmScroller) return;
            const lineElsAfter = this.cmContent.querySelectorAll('.cm-line');
            const postEl = lineElsAfter[insertAt];
            if (!postEl) return;
            const postOffset = postEl.getBoundingClientRect().top - this.cmScroller.getBoundingClientRect().top;
            this.cmScroller.scrollTop += postOffset - preOffsetFromScrollerTop;
        };
        
        cmView.dispatch({
            changes: {
                from: 0,
                to: doc.length,
                insert: newContent
            },
            selection: { anchor, head: anchor },
            userEvent: 'block.move'
        });
        
        requestAnimationFrame(() => {
            restoreBlockScrollPosition();
        });
        setTimeout(() => {
            restoreBlockScrollPosition();
            this.forceRender();
        }, 50);
        
        if (this.isMobile && navigator.vibrate) {
            navigator.vibrate(30);
        }
    }
}

class BlockDndSettingTab extends obsidian.PluginSettingTab {
    constructor(app, plugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display() {
        const { containerEl } = this;
        containerEl.empty();
        
        containerEl.createEl('h2', { text: 'Viper\'s Columns' });

        new obsidian.Setting(containerEl)
            .setName('Enable block drag handles')
            .setDesc(
                'Show the ⋮⋮ drag handles for moving text blocks (Notion-style). Off by default — column layouts still work from the right-click Column menu.'
            )
            .addToggle((toggle) =>
                toggle.setValue(!!this.plugin.settings.enableBlockDragHandles).onChange(async (value) => {
                    this.plugin.settings.enableBlockDragHandles = value;
                    await this.plugin.saveSettings();
                    this.plugin.cleanup();
                    setTimeout(() => this.plugin.setup(), 50);
                    this.display();
                })
            );

        if (this.plugin.settings.enableBlockDragHandles) {
            new obsidian.Setting(containerEl)
                .setName('Hold to show block handles')
                .setDesc(
                    'On desktop, drag handles only appear while this modifier is held (together with hovering a block, unless disabled below). Right‑click in the note editor and choose Column → 1–5 Columns to insert a column layout. Detection uses Alt/Ctrl/Win/Shift flags; on Windows, Alt can activate the menu bar — prefer Ctrl or Win/Cmd.'
                )
                .addDropdown((dropdown) =>
                    dropdown
                        .addOption('alt', 'Alt')
                        .addOption('control', 'Ctrl')
                        .addOption('meta', 'Win / Command')
                        .addOption('shift', 'Shift')
                        .setValue(this.plugin.settings.handleRevealModifier || 'alt')
                        .onChange(async (value) => {
                            this.plugin.settings.handleRevealModifier = value;
                            await this.plugin.saveSettings();
                            this.plugin.clearModifierHoldState();
                            this.plugin.forceRender();
                        })
                );

            new obsidian.Setting(containerEl)
                .setName('Always show handles on mobile')
                .setDesc(
                    'When off, block handles are hidden on phones/tablets (there is no modifier hold). When on, handles behave like before.'
                )
                .addToggle((toggle) =>
                    toggle.setValue(!!this.plugin.settings.alwaysShowHandlesMobile).onChange(async (value) => {
                        this.plugin.settings.alwaysShowHandlesMobile = value;
                        await this.plugin.saveSettings();
                        this.plugin.forceRender();
                    })
                );

            new obsidian.Setting(containerEl)
                .setName('Show handle on hover')
                .setDesc(
                    'When on (desktop), handles fade in when the pointer enters the block; still requires holding the modifier above. Does not apply when always showing on mobile.'
                )
                .addToggle((toggle) =>
                    toggle.setValue(this.plugin.settings.showHandleOnHover).onChange(async (value) => {
                        this.plugin.settings.showHandleOnHover = value;
                        await this.plugin.saveSettings();
                        this.plugin.forceRender();
                    })
                );
        }

        new obsidian.Setting(containerEl)
            .setName('Show column source edit button')
            .setDesc(
                'Obsidian’s built-in </> button on column blocks (opens the raw fence source). Turn off to hide it for Viper\'s Columns only — other code blocks and embeds are unchanged.'
            )
            .addToggle((toggle) =>
                toggle.setValue(this.plugin.settings.showColumnEditButton !== false).onChange(async (value) => {
                    this.plugin.settings.showColumnEditButton = value;
                    await this.plugin.saveSettings();
                })
            );
    }
}

module.exports = BlockDndPlugin;
BlockDndPlugin._columnEditTest = {
    columnBodiesEqual,
    isColumnPlainEnterKey,
    isColumnTabKey,
    bdndSyncSingleColTextHeight,
    insertNewlineInColumnTextarea,
};
