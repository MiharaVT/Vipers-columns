# Viper's Columns

A plugin for Obsidian that enables column layouts via right-click, plus Notion-style drag and drop for text blocks.

## Features

- 🖱️ **Drag and Drop Blocks** - Move paragraphs, headings, lists, and code blocks by dragging
- 📐 **Column Layouts** - Right-click any block → Column → choose 1–5 Columns
- 👆 **Notion-style Handles** - Hover over any line to reveal the drag handle
- 📱 **Mobile Support** - Full touch support for mobile devices with long-press to drag
- ⚡ **Smooth Animations** - Polished visual feedback during drag operations
- 🎯 **Precise Positioning** - Visual drop indicator shows exactly where your block will land

## Installation

### Manual Installation

1. Download `main.js`, `manifest.json`, and `styles.css`
2. Create a folder named `vipers-columns` in your vault's `.obsidian/plugins/` directory
3. Place the downloaded files in the `vipers-columns` folder
4. Reload Obsidian
5. Enable the plugin in Settings → Community Plugins

## Usage

### Inserting Columns (Desktop & Mobile)

1. Place your cursor in any block
2. Right-click in the editor
3. Choose **Column** from the context menu
4. Select **1 Column** through **5 Columns**

**1 Column** makes a half-width row with the image on the left and a text box on the right, top-aligned beside the image (not above/below it). Works whether you right-click the image or the text next to it. Drag the bottom edge of the text box to grow it downward. Column cells show a rendered preview for images; click a cell to edit markdown.

### Drag and Drop (Desktop)

1. Open any note in edit mode
2. Hold **Alt** (configurable) and hover over any line to reveal the drag handle (⋮⋮) on the left
3. Click and drag the handle to move the block
4. Drop it at the desired position — dropping a paragraph onto another merges them into a 2-column layout

### Mobile

1. Long-press on any line to select it
2. Drag your finger to move the block
3. Release to drop it at the new position

## Settings

- **Hold to show block handles** - Modifier key required to reveal drag handles (Alt / Ctrl / Win / Shift)
- **Always show handles on mobile** - Show handles without a modifier key on touch devices
- **Show handle on hover** - Toggle whether drag handles appear on hover (default: enabled)

## Compatibility

- Requires Obsidian v1.0.0 or higher
- Works on desktop (Windows, macOS, Linux) and mobile (iOS, Android)
- Compatible with most themes and other plugins
- Optionally integrates with the Zotion plugin for image resize and drop-to-embed in column cells

## Credits

Based on Blocks DnD by Nikita. Previously packaged as Zotion Columns; now branded as Viper's Columns.
