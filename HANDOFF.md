# Handoff: Viper's Columns (MiharaVT/Vipers-columns)

**Status:** Working as of 2026-08-28. User confirmed **1 Column** keeps the image visible beside the text box after v1.0.5.

**Repo:** https://github.com/MiharaVT/Vipers-columns  
**Default branch:** `main` (PRs #1–#6 merged; this handoff lands as **PR #7**)  
**Plugin id:** `vipers-columns`  
**Display name:** Viper's Columns  
**Current version:** `1.0.5` (`manifest.json`)

---

## What this plugin is

Obsidian plugin for:

- Right-click → **Column** → 1–5 columns (Live Preview code fence `block-dnd-columns`)
- Notion-style block drag-and-drop with modifier-key handles
- Optional compatibility with a separate **Zotion** plugin (resize CSS classes / settings lookup) — do not rename those interop hooks

Install folder: `<vault>/.obsidian/plugins/vipers-columns/`  
Files: `main.js`, `manifest.json`, `styles.css` (`data.json` is optional defaults)

---

## PR history

| PR | Version | Summary |
| --- | --- | --- |
| [#1](https://github.com/MiharaVT/Vipers-columns/pull/1) | 1.0.0 | Initial upload; rebrand Zotion Columns → **Viper's Columns** |
| [#2](https://github.com/MiharaVT/Vipers-columns/pull/2) | 1.0.1 | Column markdown preview; 1 Column pulls following text |
| [#3](https://github.com/MiharaVT/Vipers-columns/pull/3) | 1.0.2 | Flex row layout so image/text stay inline |
| [#4](https://github.com/MiharaVT/Vipers-columns/pull/4) | 1.0.3 | Direct wiki-embed rendering; split mixed text+image |
| [#5](https://github.com/MiharaVT/Vipers-columns/pull/5) | 1.0.4 | Preserve embeds; stronger path resolve; stop cell collapse |
| [#6](https://github.com/MiharaVT/Vipers-columns/pull/6) | **1.0.5** | **Fix that worked:** right-click target + `imagePath` in meta |
| [#7](https://github.com/MiharaVT/Vipers-columns/pull/7) | — | Add this `HANDOFF.md` + always-open-next-PR skill (docs) |

---

## Fix that worked (v1.0.5) — do not regress

**Bug:** Choosing Column → 1 Column made the image disappear (empty text box only).

**Root cause:** Logic used the **editor cursor**, not the **right-clicked image**. In Live Preview those often differ, so the embed was never captured into the column fence.

**Solution (keep these):**

1. `document` `contextmenu` capture → `lastPointerContext` `{ x, y, time, target }`
2. `resolveClickedImageTarget()` reads `.internal-embed[src]` / `<img>` under the click (maps resource URLs back to vault files when needed)
3. Dedicated `replaceWithOneColumnBesideImage()` for **1 Column**
4. Persist `imagePath` (+ optional `imageWidth`) on fence **meta** JSON
5. Left cell paints via `bdndAppendResolvedImage()` / vault `getResourcePath` — not only `MarkdownRenderer` inside the code block
6. Refuse apply if a wiki embed in the replaced range would be dropped from bodies

**1 Column UX:** half-width row — image left, resizable text box right (top-aligned). Right-click **on the image** → Column → 1 Column.

---

## Important code map

- [`main.js`](main.js) — plugin runtime; column fence lang `block-dnd-columns`
- [`manifest.json`](manifest.json) — bump **version on every plugin PR**
- [`styles.css`](styles.css) — extra LP styles
- [`README.md`](README.md) — install/usage
- [`HANDOFF.md`](HANDOFF.md) — this file
- [`.cursor/skills/always-open-pr/SKILL.md`](.cursor/skills/always-open-pr/SKILL.md) — must open the next PR for every repo update

Key symbols:

- `replaceWithOneColumnBesideImage`
- `resolveClickedImageTarget` / `lastPointerContext`
- `bdndAppendResolvedImage` / `bdndResolveImageFile`
- `bdndPreserveEmbedsInBodies`
- Zotion interop: `getBdndZotionCompatSettings`, `zotion-resize-*` classes — leave alone

---

## Conventions for future agents

1. **Always open the next PR** when editing this existing repo. If the last PR was `#N`, ship the update as `#N+1` (new branch from `main`). See `.cursor/skills/always-open-pr/SKILL.md`.
2. **Bump `manifest.json` version on every plugin code PR** (next plugin bump would be `1.0.6`).
3. New work: branch `cursor/<descriptive-name>-bad7` off `main`.
4. Do not rebrand as Zotion; product name is **Viper's Columns** / id `vipers-columns`.
5. Do not leave handoffs only in an agent store — put them in the repo and open a PR.
6. Obsidian is not available in the cloud VM — verify with the user in their vault after plugin file updates + full reload.

---

## How the user verifies

1. Copy `main.js`, `manifest.json`, `styles.css` into the vault plugin folder  
2. Reload Obsidian (or disable/enable the plugin)  
3. Right-click the **image** → Column → **1 Column**  
4. Expect: image visible on the left, text box on the right at the top of the image  

**Confirmed working** by user after v1.0.5 / PR #6.
