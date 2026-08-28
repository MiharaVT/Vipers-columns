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
const { columnBodiesEqual, isColumnPlainEnterKey, isColumnTabKey } = plugin._columnEditTest;

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

console.log('test-column-keys: ok');
