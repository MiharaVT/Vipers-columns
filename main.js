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
    showHandleOnHover: true,
    /** One of: alt | control | meta | shift */
    handleRevealModifier: 'alt',
    /** When true, mobile ignores hotkey and always shows handles when the row is visible */
    alwaysShowHandlesMobile: true
};

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

/** Wiki embeds `![[path|wxh]]` compatible with the Zotion plugin (read-only mimic; keeps column bodies consistent). */
const BDND_WIKI_EMBED_RE_SOURCE = '!\\[\\[([^\\]#|]+?)(?:\\|(\\d+)(?:x(\\d+))?)?\\]\\]';

const BDND_IMAGE_ACCEPT_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp']);

function bdndWikiMatchFromExec(m) {
    const widthTok = m[2];
    const heightTok = m[3];
    return {
        fullFrom: m.index,
        fullTo: m.index + m[0].length,
        linkPathRaw: m[1] ?? '',
        width: widthTok !== undefined ? parseInt(widthTok, 10) : null,
        height: heightTok !== undefined ? parseInt(heightTok, 10) : null,
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
            const n = bdndRenderWikiImagesDirect(app, md, previewEl, sourcePath);
            if (n === 0) {
                const dv = document.createElement('div');
                dv.className = 'block-dnd-col-preview-fallback';
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
 * Build a half-width (image | text) pair for "1 Column".
 * Handles cursor on the image (text below), on the text (image above),
 * or a single line that already mixes both.
 */
function resolveOneColumnPair(doc, blockStartLine0, blockEndLine0) {
    const startLine = doc.line(blockStartLine0 + 1);
    const endLine = doc.line(blockEndLine0 + 1);
    const selected = doc.sliceString(startLine.from, endLine.to);
    const selectedTrim = selected.trim();

    // Same line already mixes text + image — never keep them concatenated.
    const mixed = splitMixedImageText(selectedTrim);
    if (mixed && (mixed.sideText || selectedTrim !== mixed.imageMd)) {
        if (mixed.sideText) {
            return {
                left: mixed.imageMd,
                right: mixed.sideText,
                from: startLine.from,
                to: endLine.to,
            };
        }
    }

    // Cursor/block is an image (or embed line): pull following text into the right slot.
    if (isWikiImageLine(selectedTrim)) {
        const side = findAdjacentMatchingLine(doc, blockEndLine0, 'after', isSimpleSideParagraphLine);
        return {
            left: selectedTrim,
            right: side ? side.text.trim() : '',
            from: startLine.from,
            to: side ? side.line.to : endLine.to,
        };
    }

    // Cursor/block is plain text: pull a preceding image into the left slot.
    if (isSimpleSideParagraphLine(selectedTrim)) {
        const img = findAdjacentMatchingLine(doc, blockStartLine0, 'before', isWikiImageLine);
        if (img) {
            return {
                left: img.text.trim(),
                right: selectedTrim,
                from: img.line.from,
                to: endLine.to,
            };
        }
        const side = findAdjacentMatchingLine(doc, blockEndLine0, 'after', isSimpleSideParagraphLine);
        return {
            left: selectedTrim,
            right: side ? side.text.trim() : '',
            from: startLine.from,
            to: side ? side.line.to : endLine.to,
        };
    }

    // Selection may be multi-line (image + text). Split the first embed from the rest.
    {
        const re = new RegExp(BDND_WIKI_EMBED_RE_SOURCE);
        const m = re.exec(selected);
        if (m) {
            const hit = bdndWikiMatchFromExec(m);
            const sideText = (selected.slice(0, hit.fullFrom) + selected.slice(hit.fullTo))
                .split('\n')
                .map((l) => l.trim())
                .filter(Boolean)
                .join('\n');
            return {
                left: hit.raw,
                right: sideText,
                from: startLine.from,
                to: endLine.to,
            };
        }
    }

    // Fallback: selected block on the left; following simple paragraph on the right.
    const side = findAdjacentMatchingLine(doc, blockEndLine0, 'after', isSimpleSideParagraphLine);
    return {
        left: selected,
        right: side ? side.text.trim() : '',
        from: startLine.from,
        to: side ? side.line.to : endLine.to,
    };
}

function bodyLooksLikeImageOnly(body) {
    const lines = (body || '').split('\n').map((l) => l.trim()).filter(Boolean);
    if (!lines.length) return false;
    if (lines.every(isWikiImageLine)) return true;
    // A single wiki embed anywhere with no other non-empty prose
    const embeds = (body || '').match(new RegExp(BDND_WIKI_EMBED_RE_SOURCE, 'g')) || [];
    if (embeds.length === 0) return false;
    const without = (body || '').replace(new RegExp(BDND_WIKI_EMBED_RE_SOURCE, 'g'), '').trim();
    return without.length === 0;
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
        const dest = app.metadataCache.getFirstLinkpathDest(hit.linkPathRaw, sourcePath || '');
        if (!(dest instanceof obsidian.TFile) || !bdndIsPreviewImageExt(dest.extension)) {
            continue;
        }
        const img = document.createElement('img');
        img.className = 'block-dnd-col-direct-img';
        img.alt = dest.basename;
        img.draggable = false;
        try {
            img.src = app.vault.getResourcePath(dest);
        } catch {
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

    /** Deferred focus so LP / CM can run first, then we focus the column textarea */
    columnEditorFocusHack = null;

    /** Deferred textarea focus timer — cleared on any pointerdown so main-note clicks are not overridden */
    columnFocusDeferTimer = null;

    /** Cancel pending column textarea focus when focus moves elsewhere (e.g. Tab) without pointerdown */
    columnFocusClearOnFocusIn = null;

    boundModifierKeySync = null;
    boundWindowBlurForModifiers = null;

    /** Desktop: true while configured modifier flag is down (altKey / ctrlKey / …). */
    modifierRevealActive = false;

    /** Keep caret indicator aligned while cm-scroller scrolls during drag */
    dragScrollRefreshBound = null;

    async onload() {
        await this.loadSettings();
        
        this.isMobile = obsidian.Platform.isMobile;
        this.handleGutterInsetPx = this.isMobile ? 42 : 46;
        this.handleSlotLeftPx = this.isMobile ? 6 : 10;

        this.addSettingTab(new BlockDndSettingTab(this.app, this));
        this.addStyles();

        this.registerMarkdownCodeBlockProcessor(BLOCK_DND_COLUMNS_LANG, async (source, el, ctx) => {
            await this.renderColumnCodeBlock(source, el, ctx);
        });

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

            if (t.closest('.block-dnd-col-gutter')) return;

            let targetTa = t.closest('.block-dnd-col-editor');
            if (!targetTa) {
                const cell = t.closest('.block-dnd-col-cell');
                if (cell) targetTa = cell.querySelector('.block-dnd-col-editor');
            }
            if (!(targetTa instanceof HTMLTextAreaElement)) return;

            this.columnFocusDeferTimer = window.setTimeout(() => {
                this.columnFocusDeferTimer = null;
                try {
                    if (!document.contains(targetTa)) return;
                    if (document.activeElement === targetTa) return;
                    targetTa.focus({ preventScroll: true });
                } catch {
                    /* noop */
                }
            }, 0);
        };
        document.addEventListener('pointerdown', this.columnEditorFocusHack, true);

        this.columnFocusClearOnFocusIn = (ev) => {
            if (this.columnFocusDeferTimer === null) return;
            const tar = ev.target;
            if (!(tar instanceof HTMLElement)) return;
            if (tar.classList.contains('block-dnd-col-editor')) return;
            clearTimeout(this.columnFocusDeferTimer);
            this.columnFocusDeferTimer = null;
        };
        document.addEventListener('focusin', this.columnFocusClearOnFocusIn, true);

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
            this.columnEditorFocusHack = null;
        }
        if (this.columnFocusClearOnFocusIn) {
            document.removeEventListener('focusin', this.columnFocusClearOnFocusIn, true);
            this.columnFocusClearOnFocusIn = null;
        }
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
    }

    async saveSettings() {
        await this.saveData(this.settings);
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
                min-height: 0;
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
                background: var(--background-primary-alt);
                border: 1px solid var(--background-modifier-border);
                border-radius: var(--radius-s, 4px);
                resize: vertical;
                outline: none;
                pointer-events: auto !important;
                cursor: text;
                -webkit-user-select: text;
                user-select: text;
            }

            .block-dnd-columns-root .block-dnd-col-editor:focus {
                box-shadow: inset 0 0 0 1px var(--interactive-accent);
                border-color: var(--interactive-accent);
                background: var(--background-primary-alt);
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
                opacity: 0;
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

        const cm = editor.cm;
        const headPos = cm.state.selection.main.head;

        this.blocks = this.parseBlocksFromDOM();
        let blockIdx = null;

        // Primary: use screen coords of cursor to find the closest .cm-line DOM element,
        // then match it against parsed blocks. This works even when document line numbers
        // diverge from DOM element indices (e.g. after a column fence widget).
        const coords = cm.coordsAtPos(headPos);
        if (coords) {
            const lineEls = Array.from(cmContent.querySelectorAll('.cm-line'));
            let closestEl = null;
            let closestDist = Infinity;
            for (const el of lineEls) {
                const rect = el.getBoundingClientRect();
                const midY = (rect.top + rect.bottom) / 2;
                const dist = Math.abs(coords.top - midY);
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

        // Fallback: match document line number against DOM indices (works when no fences above)
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

        this.replaceBlockWithColumns(blockIdx, columnCount);
    }

    replaceBlockWithColumns(blockIndex, columnCount) {
        const editor = this.activeView?.editor;
        const cmView = editor?.cm;
        const block = this.blocks[blockIndex];
        if (!editor || !cmView || !block || columnCount < 1 || columnCount > 5) {
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
            return;
        }

        const doc = cmView.state.doc;
        let from = doc.line(blockStartLine + 1).from;
        let to = doc.line(blockEndLine + 1).to;

        const id = randomBlockId();
        const n = columnCount === 1 ? 2 : columnCount;
        const widths = equalWidthPercents(n);
        let bodies;

        if (columnCount === 1) {
            // Half-width row: image (or block) on the left, text on the right,
            // top-aligned and inline — never stacked above/below each other.
            const pair = resolveOneColumnPair(doc, blockStartLine, blockEndLine);
            from = pair.from;
            to = pair.to;
            let leftBody = pair.left;
            let rightBody = pair.right;
            // Safety: if text slot still contains a wiki image, peel it out so the
            // picture does not vanish into the raw text box (see user report).
            const rightMixed = splitMixedImageText(rightBody);
            if (rightMixed?.imageMd) {
                if (!bodyLooksLikeImageOnly(leftBody)) leftBody = rightMixed.imageMd;
                rightBody = rightMixed.sideText;
            }
            const leftMixed = splitMixedImageText(leftBody);
            if (leftMixed?.sideText && bodyLooksLikeImageOnly(leftMixed.imageMd)) {
                leftBody = leftMixed.imageMd;
                if (!rightBody) rightBody = leftMixed.sideText;
            }
            bodies = [leftBody, rightBody];
        } else {
            const extracted = cmView.state.sliceDoc(from, to);
            bodies = Array.from({ length: n }, (_, i) => {
                if (i === 0) return extracted;
                return `_Column ${i + 1}_`;
            });
        }

        const meta = columnCount === 1 ? { id, n, widths, singleCol: true } : { id, n, widths };
        const inner = serializeColumnFence(meta, bodies);
        const oldSlice = cmView.state.sliceDoc(from, to);
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

    async flushColumnBodiesFromRoot(uuid, root, sourcePath) {
        const textareas = root.querySelectorAll('.block-dnd-col-editor');
        const newBodies = Array.from(textareas).map(t => t.value);

        const activeView = this.app.workspace.getActiveViewOfType(obsidian.MarkdownView);
        const md =
            activeView?.file?.path === sourcePath ? activeView.editor?.getValue() : null;

        if (!md) {
            const file = this.app.vault.getAbstractFileByPath(sourcePath);
            if (!(file instanceof obsidian.TFile)) return;
            const diskMd = await this.app.vault.read(file);
            const range = findFenceRangeById(diskMd, uuid);
            if (!range) return;
            const parsed = parseColumnFenceSource(range.inner);
            if (!parsed) return;
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
            await this._persistColumnFence(sourcePath, meta, newBodies);
            return;
        }

        const range = findFenceRangeById(md, uuid);
        if (!range) return;
        const parsed = parseColumnFenceSource(range.inner);
        if (!parsed) return;

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

        await this._persistColumnFence(sourcePath, meta, newBodies);
    }

    async persistColumnFenceWidths(sourcePath, uuid, widthsNorm, bodiesSnapshot, metaBase) {
        const n = widthsNorm.length;
        const meta = { ...metaBase, id: uuid, n, widths: widthsNorm };
        await this._persistColumnFence(sourcePath, meta, bodiesSnapshot, 'block-dnd.resize-col');
    }

    async renderColumnCodeBlock(source, el, ctx) {
        el.innerHTML = '';
        el.classList.add('block-dnd-columns-embed');
        el.style.pointerEvents = 'auto';
        el.style.position = 'relative';
        el.style.zIndex = '6';

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
            const imageOnly = bodyLooksLikeImageOnly(bodyText);
            // Half-width text slot: always show a resizable text box at the top
            // beside the image (drag the bottom edge to grow downward).
            // Image slots stay in preview mode so the picture does not "disappear"
            // into raw ![[...]] source on click.
            const alwaysShowEditor = !!meta.singleCol && i > 0 && !imageOnly;
            if (alwaysShowEditor) wrap.classList.add('always-show-editor');
            if (imageOnly) wrap.classList.add('image-preview-cell');

            const previewEl = document.createElement('div');
            previewEl.className = 'block-dnd-col-preview markdown-rendered';

            const ta = document.createElement('textarea');
            ta.className = 'block-dnd-col-editor';
            ta.value = bodyText;
            ta.rows = Math.min(14, Math.max(alwaysShowEditor ? 4 : 3, (ta.value || '').split('\n').length));
            if (alwaysShowEditor) {
                ta.style.minHeight = '4.5em';
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

            const enterEditMode = () => {
                if (imageOnly) return;
                wrap.classList.add('is-editing');
            };
            const leaveEditMode = () => {
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
                if (e.key !== 'Enter' || e.shiftKey) return;
                if (e.ctrlKey || e.metaKey || e.altKey) return;
                if (e.isComposing) return;
                e.preventDefault();
                e.stopPropagation();
                if (typeof e.stopImmediatePropagation === 'function') e.stopImmediatePropagation();
                const list = root.querySelectorAll('.block-dnd-col-editor');
                const idx = Array.prototype.indexOf.call(list, ta);
                if (idx < 0) return;
                if (idx < list.length - 1) {
                    const next = list[idx + 1];
                    if (next instanceof HTMLTextAreaElement) {
                        const nextWrap = next.closest('.block-dnd-col-editor-wrap');
                        if (nextWrap) nextWrap.classList.add('is-editing');
                        next.focus({ preventScroll: true });
                    }
                    return;
                }
                const prevTimer = this.columnBodyPersistTimers.get(meta.id);
                if (prevTimer) clearTimeout(prevTimer);
                this.columnBodyPersistTimers.delete(meta.id);
                void (async () => {
                    try {
                        await this.flushColumnBodiesFromRoot(meta.id, root, ctx.sourcePath);
                        leaveEditMode();
                        const mv = this.app.workspace.getActiveViewOfType(obsidian.MarkdownView);
                        if (!mv?.editor?.cm || mv.file?.path !== ctx.sourcePath) return;
                        const cm = mv.editor.cm;
                        const md = mv.editor.getValue();
                        const range = findFenceRangeById(md, meta.id);
                        if (!range) return;
                        const insertAt = Math.min(range.to, cm.state.doc.length);
                        cm.dispatch({
                            changes: { from: insertAt, to: insertAt, insert: '\n\n' },
                            selection: { anchor: insertAt + 2, head: insertAt + 2 },
                            userEvent: 'block-dnd.column-exit-enter'
                        });
                        cm.focus();
                    } catch {
                        /* noop */
                    }
                })();
            }, true);

            ta.addEventListener('input', () => {
                this.scheduleColumnBodyPersist(meta.id, root, ctx.sourcePath);
            });
            ta.addEventListener('blur', () => {
                const prev = this.columnBodyPersistTimers.get(meta.id);
                if (prev) clearTimeout(prev);
                this.columnBodyPersistTimers.delete(meta.id);
                void this.flushColumnBodiesFromRoot(meta.id, root, ctx.sourcePath);
                window.setTimeout(() => {
                    if (document.activeElement !== ta) leaveEditMode();
                }, 0);
            });

            ta.addEventListener('input', () => {
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
                    ta.rows = Math.min(14, Math.max(alwaysShowEditor ? 4 : 3, (ta.value || '').split('\n').length));
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
}

module.exports = BlockDndPlugin;
