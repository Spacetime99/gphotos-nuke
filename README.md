# gphotos-nuke — Resilient Google Photos Bulk Deletion

A resilient, unattended bulk-deletion tool for Google Photos.

This fork builds on the original **gphotos-nuke** project by **Fabio Concina**, updated to cope with the current Google Photos web interface and its heavily virtualized DOM.

It is intended for people who have backed up their Google Photos library and want to remove large numbers of photos without manually selecting thousands of items.

> **Important:** This script moves photos to the Google Photos **Bin/Trash**.  
> It **never empties the Bin automatically**.

---

## Credits

### Original project and implementation

**Fabio Concina**

Original repository:

https://github.com/fabioconcina/gphotos-nuke

### Resilient unattended redesign and real-world testing

**Jonathan Bates — [Spacetime99](https://github.com/Spacetime99)**

### Implementation and engineering assistance

**ChatGPT by OpenAI**

This version was developed through repeated testing against a real Google Photos library containing thousands of photos.

---

# Why this version exists

Google Photos does not currently provide a straightforward **Select All → Delete All** operation for an entire large photo library.

The original `gphotos-nuke` demonstrated that deletion could be automated through the Google Photos web interface.

Testing against the current Google Photos UI exposed several additional problems:

- Google Photos aggressively virtualizes the photo grid.
- DOM elements can disappear or be replaced while they are being selected.
- Stale photo checkbox nodes can remain in the DOM with zero width and height.
- Multiple different photos can have identical accessibility labels/timestamps.
- A photo can disappear between discovery and selection.
- Scrolling can invalidate previously discovered DOM elements.
- An apparently empty DOM does not necessarily mean there are no more photos.
- Selection state must be positively verified before any destructive operation.

This version was redesigned around those behaviours.

---

# What it does

The script continuously:

1. Discovers currently actionable photos.
2. Selects up to 20 photos.
3. Verifies which selections actually succeeded.
4. Drops candidates that disappeared during selection.
5. Checks that the complete current Google Photos selection belongs to the script.
6. Opens the Google Photos deletion control.
7. Verifies the exact **Move to bin / Move to trash** confirmation.
8. Moves the verified batch to the Bin.
9. Rediscovers the live DOM.
10. Automatically scrolls to expose more photos.
11. Repeats.

A disappearing photo does **not** cause the whole process to stop.

If only part of a batch can be positively verified, the script can continue with the verified subset.

---

# Safety model

Bulk deletion is inherently destructive, so the script deliberately separates recoverable UI failures from destructive actions.

The script is designed to tolerate:

- disappearing candidates
- stale DOM nodes
- virtualized elements
- DOM replacement
- failed individual selections
- partial batches
- temporary lack of rendered photos
- changing scroll containers

But before pressing the destructive **Move to Bin** confirmation, it requires the current selection to be accounted for.

If the selection cannot be safely reconciled, the script attempts to clear it and rediscover the page rather than blindly deleting it.

## The Bin is never emptied

This is intentional.

Google Photos normally keeps deleted items in the Bin for a period before permanent deletion. Keeping that separate from the automation provides an additional recovery opportunity.

**Verify your backup before manually emptying the Bin.**

---

# Before using it

## 1. Back up your Google Photos library

Google Takeout is the obvious way to export a complete Google Photos library.

https://takeout.google.com/

Do not rely on the deletion script as part of your backup process.

## 2. Verify the backup

Ideally verify:

- all expected Takeout archives were downloaded
- archives can be opened successfully
- media files are present
- important photographs and videos can actually be opened

Only proceed when you are comfortable that your backup is independent of Google Photos.

---

# How to run

Open:

https://photos.google.com/

Use a Chromium-based browser such as Chrome.

Open **Developer Tools → Console**.

Copy the contents of [`nuke.js`](./nuke.js), paste the script into the Console, and run it.

The console will begin reporting progress, for example:

```text
[gphotos-v8.5] attempting up to 20 candidate(s)
[gphotos-v8.5] ✓ exact selection ownership confirmed
[gphotos-v8.5] ✓ moved verified batch of 20 photo(s) to Bin
[gphotos-v8.5] ✓ batch #12 moved | photos this run=240
```

Google Photos must remain open while the script is operating.

---

# Stop the script

For a graceful stop, enter:

```javascript
window.__stopDelete = true
```

The script checks this flag throughout its wait and processing loops.

To see whether the worker is running:

```javascript
window.__gphotosRunning
```

`true` means the worker is running.

`false` means it has ended.

For an immediate hard stop, reload or close the Google Photos tab.

---

# Browser console warnings

Google Photos itself generates substantial console output.

Messages such as:

```text
ERR_BLOCKED_BY_CLIENT
```

or Chrome performance warnings such as:

```text
[Violation] 'setTimeout' handler took ...
```

do not necessarily indicate that `gphotos-nuke` has failed.

Look specifically for messages beginning with:

```text
[gphotos-v8.5]
```

and check:

```javascript
window.__gphotosRunning
```

---

# Google Photos virtualization

The current Google Photos interface does not keep every photograph represented by a permanent DOM element.

Instead, it creates, removes and replaces elements as the user moves through the library.

For that reason, this version deliberately does **not** assume that:

```text
DOM element == permanent photo identity
```

It continually rediscoveries the live interface and treats old DOM references as disposable.

It also ignores stale photo controls whose rendered dimensions are `0 × 0`.

---

# Duplicate photo labels

Google Photos can expose different photographs with identical accessibility labels, for example:

```text
Photo – Portrait – 3 Jul 2020, 23:16:13
```

Therefore an `aria-label` or timestamp cannot safely be treated as a globally unique photo identifier.

The script uses labels as useful recovery information but performs additional selection-state verification before destructive actions.

---

# Automatic scrolling

When no actionable photos are currently available, the script does **not** assume the library is empty.

Instead, it attempts to locate the active scroll container and continues scrolling through the virtualized library.

An empty rendered window is therefore treated as:

> "Nothing actionable is currently rendered."

not:

> "There are no photos left."

The worker continues until explicitly stopped.

---

# Important limitations

This project automates an undocumented Google Photos web interface.

Google can change that interface at any time.

That means a script that works today may require modification after a Google Photos UI update.

Before using it on an important library:

- make a backup
- verify the backup
- watch the first few batches
- check that the expected photos are moving to the Bin
- stop immediately if behaviour differs from what is documented here

There is no official Google Photos bulk-deletion API behind this project.

---

# Contributing

Testing, bug reports and improvements are welcome.

Particularly useful reports include:

- browser and version
- approximate library size
- the last `[gphotos-v8.5]` messages before a failure
- whether Google Photos changed the DOM during selection
- whether the script recovered automatically
- screenshots of unexpected UI states, with personal information removed

Please **do not post Google authentication tokens, cookies or other account credentials** in issues.

---

# Development history

The resilient version grew out of testing against a multi-thousand-photo Google Photos library.

Several approaches were tested before the current design, including:

- synthetic range selection
- date-group selection
- automatic date-group scrolling
- strict DOM-element identity
- DOM-element reacquisition
- individual-photo verified batching

Testing demonstrated that Google's virtualization makes strict DOM identity too brittle for long unattended runs.

The current architecture instead follows:

```text
discover
   ↓
select what still exists
   ↓
positively verify selection
   ↓
drop vanished candidates
   ↓
verify complete selection ownership
   ↓
move verified selection to Bin
   ↓
discard old DOM state
   ↓
rediscover
   ↓
scroll
   ↓
repeat
```

The central principle is:

> **Be tolerant while discovering and selecting; be conservative at the destructive action.**

---

# Disclaimer

This software performs bulk deletion operations on Google Photos.

Use it entirely at your own risk.

Back up and verify your data before running it. The contributors cannot guarantee compatibility with future versions of Google Photos or recovery of deleted data.

---

# License

This fork retains the licensing of the original **gphotos-nuke** project.

See [`LICENSE`](./LICENSE) for the applicable license terms.

Original project:

https://github.com/fabioconcina/gphotos-nuke
