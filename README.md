# gphotos-nuke

A single-file JavaScript snippet that wipes your Google Photos library by automating the web UI. Paste it into your browser's console, walk away, come back to an empty library.

**Roughly 150 to 400 photos per minute, unattended.** A 10,000-photo library clears in 25 min to 1 h; 50,000 in 2 to 6 h. See [Performance](#performance) for measured numbers.

No install, no extension, no OAuth, no external tool. Works in Chrome, Safari, Firefox, and Edge. Works in any UI language.

---

## ⚠️ Read this before you run it

- **This deletes every photo and video in your main library.** That is the entire point, but it's irreversible after 60 days.
- Deleted items land in **Google Photos Trash** first. You have **60 days** to recover them before they are permanently purged.
- If you want a backup, **run [Google Takeout](https://takeout.google.com/) first** and wait for the archive before starting.
- The script does **not** empty the Trash. If you want immediate permanent deletion, empty the Trash manually afterwards (or wait 60 days).
- Try the **dry-run mode first** (step 4 below) to confirm the script still works with the current Google Photos UI before letting it loose on your library.

---

## Why a DOM script and not the Google Photos API

Since **March 31, 2025**, the Google Photos Library API only lets third-party apps see media they themselves uploaded. There is no `mediaItems.delete` endpoint in the API anyway - the only way to trash an item programmatically would be removing it from its last album. The Picker API that replaced the old read flow has no deletion capability either.

In 2026, automating the web UI is the only working approach for "delete my entire library."

---

## Quick start

1. Open <https://photos.google.com> in any desktop browser.
2. **Zoom out to the minimum** - press Ctrl/Cmd + `-` until the page stops shrinking. This packs more tiles per batch, which is the single biggest speed multiplier.
3. Open the DevTools console:
   - **Chrome / Edge / Firefox**: Ctrl/Cmd + Shift + J (or right-click → Inspect → Console).
   - **Safari**: enable the Develop menu in Settings → Advanced, then Cmd + Option + C. Safari asks you to type `allow pasting` the first time you paste into the console.
4. **Dry run first** (no changes made). Open [`nuke.js`](./nuke.js), change the top two constants:
   ```js
   const MAX_DELETE_COUNT = 10;
   const DRY_RUN = true;
   ```
   Select the entire file, copy, paste into the console, press Enter. You should see a log line like:
   ```
   [cycle #1] DRY_RUN: would delete 42 tiles
   ```
   Nothing is actually deleted. If you see this, the script is working against your current UI.
5. **Live run.** Restore the constants to their defaults:
   ```js
   const MAX_DELETE_COUNT = Infinity;
   const DRY_RUN = false;
   ```
   Paste the full file again, press Enter. Watch the `[cycle #N] selected K tiles (total M) - confirmed in Tms` logs.
6. **Abort mid-run** at any time by typing this into the console and pressing Enter:
   ```js
   window.__stopDelete = true;
   ```
   The script finishes its current cycle and exits cleanly.

---

## Performance

Two back-to-back runs on a M4 MacBook Air running Safari (Italian UI) with `BLOCK_IMAGES = true`:

```
[gphotos-nuke] done. deleted=475 cycles=22 elapsed=74.1s  avg=6.4 tiles/s (385/min)
[gphotos-nuke] done. deleted=378 cycles=26 elapsed=157.6s avg=2.4 tiles/s (144/min)
```

Run 1 hit **385 photos/min**. Run 2, starting immediately after, dropped to **144/min**, almost certainly because Google's backend started throttling deletes. Expect your first minutes to be fast and the rate to fall off on longer sweeps. Extrapolated wall-time windows:

| Library size | Fast end (400/min) | Throttled end (150/min) |
| ---: | --- | --- |
| 1,000 photos | ~3 min | ~7 min |
| 10,000 photos | ~25 min | ~1.1 h |
| 50,000 photos | ~2.1 h | ~5.5 h |
| 100,000 photos | ~4.2 h | ~11 h |

Throughput depends on four things, in roughly descending order of impact:

1. **Google's rate limiter.** On long sweeps Google slows deletes down to protect their backend. Nothing the script can do about it except detect the stall and halt cleanly; reload the page and rerun to continue.
2. **Zoom level.** More tiles per batch equals fewer cycles equals more photos per second. Zoom out all the way (step 2 of Quick start).
3. **`BLOCK_IMAGES`.** Thumbnails being rendered add real CPU load and make the grid slow to reflow between cycles.
4. **Network latency.** Each cycle waits for the confirm dialog and the post-delete grid refresh, both network-bound.

Every run's final log line reports the actual rate so you can tune against it.

## Tunables

All at the top of [`nuke.js`](./nuke.js):

| Constant | Default | What it does |
| --- | --- | --- |
| `MAX_DELETE_COUNT` | `Infinity` | Stop after N items. Set to a small number for a test run. |
| `DRY_RUN` | `false` | Select + log but skip the actual delete. Safe way to verify the script. |
| `BLOCK_IMAGES` | `true` | Monkey-patches `HTMLImageElement` so thumbnails are replaced with a 1×1 transparent GIF before the network request happens. Massive speedup, especially on Safari (which has no DevTools "Block URL" feature). Turn off if the grid layout collapses weirdly. |
| `STEP_TIMEOUT_MS` | `5000` | Give-up threshold waiting for UI state changes. Raise on very slow networks. |
| `SETTLE_MS` | `150` | Post-confirm yield before the next cycle starts. |
| `STALL_LIMIT` | `5` | Halt after this many cycles in a row where the top-of-grid tile hasn't changed. Catches the case where Google is temporarily rate-limiting deletions so you don't loop forever thinking you're making progress. Adapted from [JuliusBairaktaris/Google-Photos-Deletion-Script](https://github.com/JuliusBairaktaris/Google-Photos-Deletion-Script). |

---

## Troubleshooting

**"no more tiles visible - library appears empty" on the first cycle, but photos are clearly on the page.**
Google has changed the DOM. Run this in the console to inspect the tile structure:

```js
document.querySelectorAll('[role="main"]').forEach((m, i) =>
  console.log(`main[${i}] checkboxes=${m.querySelectorAll('[role="checkbox"]').length}`)
);
```

If neither `main` contains checkboxes, the tile anchor has moved - open an issue with the output and I'll update the selector.

**"waitFor timeout" after the first delete.**
The confirm dialog's button layout has changed. The current strategy is "last text-bearing button in the last `[role="dialog"]`". If Google added extra buttons to the dialog, this heuristic may miss. Inspect the dialog in DevTools and open an issue.

**Grid layout looks broken with overlapping rows.**
`BLOCK_IMAGES = true` replaces thumbnails with 1×1 placeholders, which can confuse Google Photos' aspect-ratio logic. Set `BLOCK_IMAGES = false` and use the browser-level block instead (Chrome DevTools → Network tab → Block request URL → `*.googleusercontent.com`).

**Safari rejects the paste.**
Type `allow pasting` in the console, press Enter, then paste again.

**The script runs but is slow.**
Check you zoomed out all the way (step 2 of Quick start) - this is the biggest lever. Open Activity Monitor; if the Safari/Chrome helper is pegged at 100% CPU rendering thumbnails, confirm `BLOCK_IMAGES` is `true` and reload the page before pasting (the patch only affects images loaded after the script runs).

---

## How it works

The script is ~180 lines of vanilla JS, no dependencies. Rough flow per cycle:

1. Query `[role="checkbox"]` inside the `[role="main"]` landmark that contains the photo grid.
2. Click the first checkbox; shift-click the last. Google's grid treats this as a range-select and checks everything in between - O(1) clicks regardless of batch size.
3. Wait for the toolbar delete button (`div[data-delete-origin] button`) to appear.
4. Click it. Wait for the `[role="dialog"]` confirm modal.
5. Click the last text-bearing button in that dialog (Google's Material convention places the destructive action last, which keeps the script locale-independent).
6. Wait for the dialog to dismiss, then loop.

All waits are `requestAnimationFrame`-polled predicates rather than fixed sleeps, so each cycle ends the moment the next DOM state arrives - not on a timer.

Selectors are intentionally ARIA-role-based and locale-agnostic. They will eventually drift when Google re-skins the UI. When that happens, the failure mode is a clean timeout, not a silent wrong-thing-clicked.

---

## Prior art and alternatives

This isn't a new idea - several projects solve the same problem in different shapes. This one exists because none of them exactly matched what I wanted (single file, no install, locale-agnostic, fast enough without browser-specific tricks, works in Safari). Credit where due:

- **[mrishab/google-photos-delete-tool](https://github.com/mrishab/google-photos-delete-tool)** - the original console script most other tools derive from, this one included. Uses generated class selectors like `.ckGgle` (which Google churns), per-tile clicks (O(N) per cycle), fixed 10s/2s sleeps, English UI only. If you already have it installed and it works for you, you don't need this one.

- **[shtse8/Google-Photos-Delete-Tool](https://github.com/shtse8/Google-Photos-Delete-Tool)** - the most polished option overall. Ships as a **Chrome extension** with a proper UI, plus a script-injection fallback. If you want a click-to-run experience and are on Chrome, start here. Extension-only means no Safari/Firefox.

- **[JuliusBairaktaris/Google-Photos-Deletion-Script](https://github.com/JuliusBairaktaris/Google-Photos-Deletion-Script)** - a modern async/await rewrite of the console-script approach, similar in spirit to this project. Closest cousin.

- **[xob0t/Google-Photos-Toolkit](https://github.com/xob0t/Google-Photos-Toolkit)** - a **userscript** (Tampermonkey-style) with a much broader scope: filter, search, organize, and delete. If you want more than just "delete everything," this is the toolkit-grade option.

### What's specifically different about this one

- **Single file, no install.** Copy, paste, run. No extension permissions prompt, no userscript manager, no npm.
- **Shift-click range selection.** Per-cycle click count is O(1) regardless of batch size - select first tile, shift-click last, done. Most of the scripts above click each tile individually.
- **Locale-agnostic selectors.** Targets ARIA roles (`[role="checkbox"]`, `[role="dialog"]`, `[role="main"]`) and structural positions (last text-bearing button in the confirm dialog). No English-only string matching, no brittle generated class names like `.ckGgle` that Google churns.
- **Event-driven waits.** Every step uses `requestAnimationFrame`-polled predicates instead of fixed `setTimeout` sleeps, so each cycle finishes the moment the UI actually transitions.
- **Works in Safari at full speed.** The `BLOCK_IMAGES` option monkey-patches image loading in-page, so you get the Chrome-DevTools-"Block request URL" speedup in any browser.
- **Dry-run mode.** Verify the script matches the current Google Photos DOM before trusting it with your library.
- **Stall detection.** Halts cleanly if Google rate-limits deletions, so you don't loop forever with no progress. Idea adapted from JuliusBairaktaris/Google-Photos-Deletion-Script above.

If you hit a selector break and want a drop-in replacement while waiting for a fix here, try one of the above. They're all solving the same problem from slightly different angles.

---

## License

MIT.

---

## Contributing

Fork, patch the selectors, open a PR. The only thing that changes over time is Google's DOM - if you hit a timeout, inspect the grid / toolbar / dialog with DevTools and update the three anchors in [`nuke.js`](./nuke.js):

- `queryTiles()` - how to find photo-tile checkboxes.
- `DELETE_BTN_SELECTOR` - the toolbar delete button.
- `findConfirmButton()` - the confirm button in the delete dialog.
