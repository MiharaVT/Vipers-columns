/**
 * Unit tests for column editor key helpers (no Obsidian app required).
 */
const Module = require('module');
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
    if (request === 'obsidian') {
        return {
            Plugin: class Plugin {},
            PluginSettingTab: class PluginSettingTab {},
            MarkdownView: class MarkdownView {},
            TFile: class TFile {},
            MarkdownRenderChild: class MarkdownRenderChild {},
            MarkdownRenderer: { render: async () => {}, renderMarkdown: async () => {} },
            Platform: { isMobile: false },
            Setting: class Setting {
                setName() { return this; }
                setDesc() { return this; }
                addDropdown() { return this; }
                addToggle() { return this; }
            },
            normalizePath: (p) => p,
        };
    }
    return origLoad(request, parent, isMain);
};

const plugin = require('./main.js');
const {
    columnBodiesEqual,
    isColumnPlainEnterKey,
    isColumnTabKey,
    bdndSyncSingleColTextHeight,
    insertNewlineInColumnTextarea,
} = plugin._columnEditTest;

function assert(cond, msg) {
    if (!cond) throw new Error(msg);
}

assert(isColumnPlainEnterKey({ key: 'Enter' }), 'plain Enter stays in the textarea');
assert(isColumnPlainEnterKey({ key: 'Enter', shiftKey: true }), 'Shift+Enter is still a newline');
assert(!isColumnPlainEnterKey({ key: 'Enter', ctrlKey: true }), 'Ctrl+Enter is not a cell newline');
assert(!isColumnPlainEnterKey({ key: 'Enter', isComposing: true }), 'IME Enter is ignored');
assert(!isColumnPlainEnterKey({ key: 'Tab' }), 'Tab is not Enter');

assert(isColumnTabKey({ key: 'Tab' }), 'Tab exits the column');
assert(isColumnTabKey({ key: 'Tab', shiftKey: true }), 'Shift+Tab is still a Tab exit');
assert(!isColumnTabKey({ key: 'Tab', ctrlKey: true }), 'Ctrl+Tab is not the exit key');
assert(!isColumnTabKey({ key: 'Enter' }), 'Enter is not Tab');

assert(columnBodiesEqual(['a', 'b'], ['a', 'b']), 'equal bodies');
assert(columnBodiesEqual([''], ['']), 'empty bodies');
assert(!columnBodiesEqual(['a', 'b'], ['a', 'c']), 'different bodies');
assert(!columnBodiesEqual(['a'], ['a', 'b']), 'length mismatch');
assert(!columnBodiesEqual(null, ['a']), 'null prev');

// Minimal DOM mock for 1 Column image-height sync
{
    function FakeEl() {}
    function FakeTextArea() {}
    function FakeImg() {}
    global.HTMLElement = FakeEl;
    global.HTMLTextAreaElement = FakeTextArea;
    global.HTMLImageElement = FakeImg;

    const important = {};
    const textEditor = new FakeTextArea();
    textEditor.style = {
        boxSizing: '',
        setProperty(name, value, priority) {
            if (priority === 'important') important[name] = value;
        },
    };

    const img = new FakeImg();
    img.offsetHeight = 220;
    img.getBoundingClientRect = () => ({ height: 220 });

    const imagePreview = new FakeEl();
    imagePreview.offsetHeight = 220;
    imagePreview.getBoundingClientRect = () => ({ height: 220 });
    imagePreview.querySelector = (sel) => (sel === 'img' ? img : null);

    const root = new FakeEl();
    root.classList = { contains: (c) => c === 'block-dnd-single-col' };
    root.querySelector = (sel) => {
        if (String(sel).includes('image-preview-cell')) return imagePreview;
        if (String(sel).includes('always-show-editor')) return textEditor;
        return null;
    };

    bdndSyncSingleColTextHeight(root);
    assert(important.height === '220px', `text box height should match image (got ${important.height})`);
    assert(important['min-height'] === '220px', 'min-height should match image');
    assert(important['max-height'] === '220px', 'max-height should match image');
    assert(important.resize === 'none', 'single-col text box should not be independently resizable');
}

{
    function FakeTextArea() {}
    global.HTMLTextAreaElement = FakeTextArea;
    const ta = new FakeTextArea();
    ta.value = 'ab';
    ta.selectionStart = 1;
    ta.selectionEnd = 1;
    ta.setSelectionRange = (s, e) => {
        ta.selectionStart = s;
        ta.selectionEnd = e;
    };
    ta.dispatchEvent = () => true;
    insertNewlineInColumnTextarea(ta);
    assert(ta.value === 'a\nb', `Enter should insert newline in-panel (got ${JSON.stringify(ta.value)})`);
    assert(ta.selectionStart === 2 && ta.selectionEnd === 2, 'caret should sit after the newline');
}

console.log('test-column-keys: ok');
