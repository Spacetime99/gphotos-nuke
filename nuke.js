/*
 * gphotos-nuke — resilient unattended Google Photos deletion
 *
 * Original project:
 *   Copyright (c) Fabio Concina
 *   https://github.com/fabioconcina/gphotos-nuke
 *
 * Resilient unattended deletion redesign, real-world testing,
 * debugging and contribution:
 *   Jonathan Bates (spacetime99)
 *
 * Implementation and engineering assistance:
 *   ChatGPT by OpenAI
 *
 * This version builds on the original gphotos-nuke project and its
 * approach to automating deletion from the Google Photos web UI.
 *
 * Major changes in this version include:
 *   - individual-photo selection and verification
 *   - resilience to Google Photos' virtualised DOM
 *   - detection and exclusion of stale 0x0 checkbox nodes
 *   - recovery from DOM replacement during selection
 *   - tolerance of disappearing candidates
 *   - partial verified batches rather than aborting a whole batch
 *   - current-selection ownership checks before deletion
 *   - automatic recovery from stale/unknown selections
 *   - automatic scrolling through the virtualised photo grid
 *   - continuous unattended operation
 *   - exact "Move to bin/trash" confirmation matching
 *
 * SAFETY:
 *   This script moves photos to Google Photos Bin.
 *   It NEVER empties the Bin.
 *
 * Licensed under the same MIT License as the original project.
 *
 * Version: 8.5
 */

(async () => {

  /*
   * ============================================================
   * GOOGLE PHOTOS BULK DELETE — V8.5
   * ============================================================
   *
   * Design:
   *
   *   DISCOVER
   *      ↓
   *   SELECT up to 20
   *      ↓
   *   candidate disappears? SKIP IT
   *      ↓
   *   verify COMPLETE CURRENT SELECTION
   *      ↓
   *   MOVE VERIFIED SELECTION TO BIN
   *      ↓
   *   discard old DOM state
   *      ↓
   *   REDISCOVER
   *      ↓
   *   nothing available? AUTO-SCROLL
   *      ↓
   *   repeat forever
   *
   *
   * IMPORTANT SAFETY PROPERTY:
   *
   * V8.5 NEVER empties the Bin.
   *
   *
   * Graceful stop:
   *
   *     window.__stopDelete = true
   *
   *
   * Status:
   *
   *     window.__gphotosRunning
   *
   *
   * Hard stop:
   *
   *     Reload the Google Photos tab.
   *
   * ============================================================
   */


  // ============================================================
  // CONFIG
  // ============================================================

  const MAX_BATCH = 20;

  const BETWEEN_CLICKS_MS = 100;
  const BETWEEN_BATCHES_MS = 700;

  const SELECT_CONFIRM_MS = 1200;
  const DELETE_TIMEOUT_MS = 30000;
  const DIALOG_TIMEOUT_MS = 15000;

  const SCROLL_STEP = 250;
  const SCROLL_SETTLE_MS = 650;

  /*
   * If a scroll target doesn't move, progressively try larger
   * steps. This is NOT interpreted as end-of-library.
   */
  const SCROLL_STEPS = [
    250,
    250,
    500,
    500,
    750,
    1000
  ];

  const NO_PHOTO_PAUSE_MS = 1200;

  /*
   * Every so often, if we're apparently stuck, force a larger
   * scroll attempt rather than sitting on the same virtual window.
   */
  const STUCK_CYCLE_PAUSE_MS = 3000;


  // ============================================================
  // STATE
  // ============================================================

  window.__stopDelete = false;
  window.__gphotosRunning = true;

  const started = performance.now();

  let batchesMoved = 0;
  let photosMoved = 0;

  let candidatesSkipped = 0;
  let recoveries = 0;
  let scrollAttempts = 0;

  let idleCycles = 0;


  // ============================================================
  // LOGGING
  // ============================================================

  const log = (...args) =>
    console.log("[gphotos-v8.5]", ...args);

  const warn = (...args) =>
    console.warn("[gphotos-v8.5]", ...args);

  const error = (...args) =>
    console.error("[gphotos-v8.5]", ...args);


  // ============================================================
  // BASIC HELPERS
  // ============================================================

  const sleep = ms =>
    new Promise(resolve => setTimeout(resolve, ms));


  const stopRequested = () =>
    window.__stopDelete === true;


  async function interruptibleSleep(ms) {

    const end =
      performance.now() + ms;


    while (
      performance.now() < end
    ) {

      if (stopRequested())
        throw new Error("USER_STOP");


      await sleep(
        Math.min(
          200,
          Math.max(
            0,
            end - performance.now()
          )
        )
      );
    }
  }


  async function waitFor(
    fn,
    timeout,
    description
  ) {

    const start =
      performance.now();


    while (
      performance.now() - start < timeout
    ) {

      if (stopRequested())
        throw new Error("USER_STOP");


      try {

        const result =
          fn();


        if (result)
          return result;

      } catch (_) {

        /*
         * DOM replacement during polling is normal.
         */

      }


      await interruptibleSleep(100);
    }


    throw new Error(
      `TIMEOUT: ${description}`
    );
  }


  // ============================================================
  // PHOTO IDENTIFICATION
  // ============================================================

  function photoLabel(el) {

    return (
      el?.getAttribute?.("aria-label") ||
      ""
    );
  }


  function looksLikePhoto(el) {

    return /^Photo\s*[–-]/i.test(
      photoLabel(el)
    );
  }


  function isActionablePhoto(el) {

    if (!el)
      return false;


    if (!el.isConnected)
      return false;


    if (!looksLikePhoto(el))
      return false;


    if (el.closest('[role="dialog"]'))
      return false;


    const rect =
      el.getBoundingClientRect();


    /*
     * Critical lesson from V8:
     *
     * Google's virtualised grid leaves stale 0×0 checkbox nodes
     * behind.
     *
     * Off-screen is fine.
     * 0×0 is not.
     */

    return (
      rect.width > 0 &&
      rect.height > 0
    );
  }


  function allActionablePhotos() {

    return [
      ...document.querySelectorAll(
        '[role="main"] [role="checkbox"]'
      )
    ].filter(
      isActionablePhoto
    );
  }


  function isSelected(el) {

    return (
      isActionablePhoto(el) &&
      el.getAttribute("aria-checked") === "true"
    );
  }


  function selectedPhotos() {

    return allActionablePhotos()
      .filter(isSelected);
  }


  function unselectedPhotos() {

    return allActionablePhotos()
      .filter(
        el =>
          el.getAttribute("aria-checked") !== "true"
      );
  }


  // ============================================================
  // RECORDS
  // ============================================================

  /*
   * Records are intentionally disposable.
   *
   * They only need to survive one selection cycle.
   */

  function makeRecord(el) {

    return {

      el,

      label:
        photoLabel(el),

      selected:
        false,

      skipped:
        false

    };
  }


  // ============================================================
  // REACQUIRE AFTER GOOGLE REPLACES A NODE
  // ============================================================

  function matchingLivePhotos(record) {

    return allActionablePhotos()
      .filter(
        el =>
          photoLabel(el) ===
          record.label
      );
  }


  function reacquireSelected(record) {

    /*
     * Original element still exists.
     */

    if (isSelected(record.el))
      return record.el;


    /*
     * Google replaced it.
     *
     * We only reacquire based on POSITIVE selected state.
     */

    const matches =
      matchingLivePhotos(record);


    const selectedMatches =
      matches.filter(isSelected);


    /*
     * Exactly one selected match:
     *
     * excellent evidence this is the replacement.
     */

    if (selectedMatches.length === 1) {

      record.el =
        selectedMatches[0];

      return record.el;
    }


    /*
     * More than one identical label is selected.
     *
     * Don't guess.
     */

    return null;
  }


  // ============================================================
  // SELECT ONE CANDIDATE
  // ============================================================

  async function trySelect(record) {

    if (stopRequested())
      throw new Error("USER_STOP");


    /*
     * Candidate disappeared BEFORE we touched it.
     *
     * THIS IS NOT AN ERROR.
     *
     * V8.4 used to terminate here.
     * V8.5 simply drops it.
     */

    if (!isActionablePhoto(record.el)) {

      candidatesSkipped++;

      log(
        `↷ candidate vanished before selection — skipping: "${record.label}"`
      );

      record.skipped = true;

      return false;
    }


    /*
     * Unexpectedly already selected.
     *
     * Don't claim ownership of it.
     */

    if (isSelected(record.el)) {

      warn(
        `candidate already selected — not claiming it: "${record.label}"`
      );

      record.skipped = true;

      return false;
    }


    const clickedElement =
      record.el;


    clickedElement.click();


    const startedWaiting =
      performance.now();


    while (
      performance.now() -
        startedWaiting <
      SELECT_CONFIRM_MS
    ) {

      if (stopRequested())
        throw new Error("USER_STOP");


      /*
       * Same node survived.
       */

      if (isSelected(record.el)) {

        record.selected = true;

        return true;
      }


      /*
       * Google replaced it.
       */

      if (
        !record.el.isConnected ||
        !isActionablePhoto(record.el)
      ) {

        const replacement =
          reacquireSelected(record);


        if (replacement) {

          record.selected = true;

          log(
            `✓ reacquired selected replacement: "${record.label}"`
          );

          return true;
        }


        /*
         * IMPORTANT:
         *
         * We clicked this candidate, therefore uncertainty about
         * whether that click selected something is different from
         * a candidate disappearing BEFORE the click.
         *
         * We don't keep clicking blindly.
         */

        break;
      }


      await interruptibleSleep(75);
    }


    /*
     * Final positive-state recovery.
     */

    const replacement =
      reacquireSelected(record);


    if (replacement) {

      record.selected = true;

      log(
        `✓ recovered selected replacement: "${record.label}"`
      );

      return true;
    }


    /*
     * We cannot positively establish that this photo is selected.
     *
     * Do NOT terminate the worker.
     *
     * But also do NOT include this record in the deletion set.
     */

    candidatesSkipped++;

    record.skipped = true;


    warn(
      `↷ selection not positively confirmed — dropping candidate: "${record.label}"`
    );


    return false;
  }


  // ============================================================
  // CURRENT SELECTION OWNERSHIP
  // ============================================================

  /*
   * This is the central safety check.
   *
   * Before pressing Bin:
   *
   *     EVERY currently selected actionable photo
   *
   * must correspond to a record V8.5 successfully selected.
   *
   * We don't merely ask:
   *
   *     "Are my 8 records selected?"
   *
   * We ask:
   *
   *     "Are these EXACTLY the photos currently selected?"
   */


  function resolveOwnedSelection(records) {

    const owned =
      [];


    for (const record of records) {

      if (!record.selected)
        continue;


      let el =
        null;


      if (isSelected(record.el)) {

        el =
          record.el;

      } else {

        el =
          reacquireSelected(record);

      }


      if (el) {

        record.el = el;

        owned.push(record);

      } else {

        /*
         * A previously confirmed selection vanished.
         *
         * Drop it from the intended deletion set.
         */

        record.selected = false;
      }
    }


    const actualSelected =
      selectedPhotos();


    const ownedElements =
      new Set(
        owned.map(
          record => record.el
        )
      );


    const foreign =
      actualSelected.filter(
        el =>
          !ownedElements.has(el)
      );


    return {

      owned,

      actualSelected,

      foreign,

      exact:
        foreign.length === 0 &&
        actualSelected.length ===
          owned.length

    };
  }


  // ============================================================
  // CLEAR CURRENT SELECTION
  // ============================================================

  /*
   * Recovery mechanism.
   *
   * If we cannot account for the complete current selection,
   * we DO NOT terminate the whole worker.
   *
   * We clear selection, rediscover and continue.
   */

  async function clearCurrentSelection() {

    const selected =
      selectedPhotos();


    if (!selected.length)
      return true;


    warn(
      `recovery: clearing ${selected.length} selected photo(s)`
    );


    for (const el of selected) {

      if (!isSelected(el))
        continue;


      el.click();

      await interruptibleSleep(80);
    }


    await interruptibleSleep(300);


    const remaining =
      selectedPhotos();


    if (!remaining.length) {

      log(
        "✓ recovery cleared current selection"
      );

      recoveries++;

      return true;
    }


    /*
     * Try once more on whatever remains.
     */

    warn(
      `recovery: ${remaining.length} selection(s) remained — second clear pass`
    );


    for (const el of remaining) {

      if (isSelected(el)) {

        el.click();

        await interruptibleSleep(100);
      }
    }


    await interruptibleSleep(400);


    const finalRemaining =
      selectedPhotos();


    if (!finalRemaining.length) {

      log(
        "✓ recovery cleared selection on second pass"
      );

      recoveries++;

      return true;
    }


    /*
     * THIS is a genuine safety boundary.
     *
     * We cannot safely press Bin while unknown selections exist.
     *
     * We still don't kill the JavaScript worker permanently.
     * Caller can wait/retry.
     */

    error(
      `recovery could not clear ${finalRemaining.length} selected photo(s)`
    );


    return false;
  }


  // ============================================================
  // BUILD A USEFUL BATCH
  // ============================================================

  async function buildSelectedBatch() {

    /*
     * Start every batch from a known state.
     */

    const preexisting =
      selectedPhotos();


    if (preexisting.length) {

      warn(
        `found ${preexisting.length} pre-existing selection(s); clearing before new batch`
      );


      const cleared =
        await clearCurrentSelection();


      if (!cleared)
        return [];
    }


    /*
     * Snapshot up to MAX_BATCH candidates.
     *
     * Snapshot becoming stale is EXPECTED.
     */

    const candidates =
      unselectedPhotos()
        .slice(
          0,
          MAX_BATCH
        )
        .map(makeRecord);


    if (!candidates.length)
      return [];


    log(
      `attempting up to ${candidates.length} candidate(s)`
    );


    const selectedRecords =
      [];


    for (const record of candidates) {

      if (stopRequested())
        throw new Error("USER_STOP");


      /*
       * If Google virtualised this candidate away,
       * trySelect() simply returns false.
       */

      let selected = false;


      try {

        selected =
          await trySelect(record);

      } catch (e) {

        if (
          e.message === "USER_STOP"
        ) {
          throw e;
        }


        /*
         * Candidate-level exceptions do NOT kill worker.
         */

        warn(
          `↷ candidate error — skipping: ${e.message}`
        );


        selected = false;
      }


      if (selected) {

        selectedRecords.push(
          record
        );
      }


      await interruptibleSleep(
        BETWEEN_CLICKS_MS
      );
    }


    return selectedRecords;
  }


  // ============================================================
  // DIALOG HELPERS
  // ============================================================

  function dialogs() {

    return [
      ...document.querySelectorAll(
        '[role="dialog"]'
      )
    ];
  }


  function findMoveToBinConfirmation() {

    const ds =
      dialogs();


    if (!ds.length)
      return null;


    const dialog =
      ds[ds.length - 1];


    const buttons =
      [
        ...dialog.querySelectorAll(
          "button"
        )
      ];


    return buttons.find(
      button => {

        const text =
          (
            button.innerText ||
            button.textContent ||
            button.getAttribute(
              "aria-label"
            ) ||
            ""
          )
            .replace(/\s+/g, " ")
            .trim();


        return (
          /^move to bin$/i.test(text) ||
          /^move to trash$/i.test(text)
        );
      }
    ) || null;
  }


  function findToolbarBinButton() {

    /*
     * Known selector from working versions.
     */

    const known =
      document.querySelector(
        'div[data-delete-origin] button'
      );


    if (known)
      return known;


    /*
     * Conservative fallback.
     *
     * Toolbar only — never dialog.
     */

    const buttons =
      [
        ...document.querySelectorAll(
          '[role="main"] button, header button'
        )
      ];


    const candidates =
      buttons.filter(
        button => {

          if (
            button.closest(
              '[role="dialog"]'
            )
          ) {
            return false;
          }


          const text =
            (
              button.getAttribute(
                "aria-label"
              ) ||
              button.title ||
              button.innerText ||
              ""
            )
              .replace(/\s+/g, " ")
              .trim();


          return (
            /^delete$/i.test(text) ||
            /^bin$/i.test(text) ||
            /^trash$/i.test(text) ||
            /^move to bin$/i.test(text) ||
            /^move to trash$/i.test(text)
          );
        }
      );


    /*
     * Fallback only if unambiguous.
     */

    return (
      candidates.length === 1
        ? candidates[0]
        : null
    );
  }


  // ============================================================
  // DELETE VERIFIED SELECTION
  // ============================================================

  async function deleteOwnedSelection(
    selectedRecords
  ) {

    if (!selectedRecords.length)
      return 0;


    /*
     * ----------------------------------------------------------
     * OWNERSHIP CHECK #1
     * ----------------------------------------------------------
     */

    let state =
      resolveOwnedSelection(
        selectedRecords
      );


    /*
     * Some records may have disappeared after being selected.
     *
     * That's okay.
     *
     * Delete the subset we can still positively own.
     */

    selectedRecords =
      state.owned;


    if (!selectedRecords.length) {

      warn(
        "all selected records disappeared — rediscovering"
      );

      await clearCurrentSelection();

      return 0;
    }


    /*
     * Unknown/foreign selections are NOT okay.
     *
     * Recover instead of terminating.
     */

    if (!state.exact) {

      warn(
        `selection ownership mismatch: owned=${state.owned.length}, actual=${state.actualSelected.length}, foreign=${state.foreign.length}`
      );


      await clearCurrentSelection();

      return 0;
    }


    log(
      `✓ exact selection ownership confirmed: ${selectedRecords.length}/${selectedRecords.length}`
    );


    // ----------------------------------------------------------
    // FIND TOOLBAR BIN
    // ----------------------------------------------------------

    let binButton = null;


    try {

      binButton =
        await waitFor(
          findToolbarBinButton,
          DIALOG_TIMEOUT_MS,
          "toolbar Bin button"
        );

    } catch (e) {

      if (
        e.message === "USER_STOP"
      ) {
        throw e;
      }


      warn(
        "Bin button unavailable — clearing selection and retrying later"
      );


      await clearCurrentSelection();

      return 0;
    }


    /*
     * ----------------------------------------------------------
     * OWNERSHIP CHECK #2
     *
     * Immediately before opening delete dialog.
     * ----------------------------------------------------------
     */

    state =
      resolveOwnedSelection(
        selectedRecords
      );


    selectedRecords =
      state.owned;


    if (
      !selectedRecords.length ||
      !state.exact
    ) {

      warn(
        "selection changed before Bin — clearing and rediscovering"
      );


      await clearCurrentSelection();

      return 0;
    }


    const intendedCount =
      selectedRecords.length;


    if (stopRequested())
      throw new Error("USER_STOP");


    // ----------------------------------------------------------
    // OPEN DIALOG
    // ----------------------------------------------------------

    binButton.click();


    let confirm = null;


    try {

      confirm =
        await waitFor(
          findMoveToBinConfirmation,
          DIALOG_TIMEOUT_MS,
          'exact "Move to bin" confirmation'
        );

    } catch (e) {

      if (
        e.message === "USER_STOP"
      ) {
        throw e;
      }


      warn(
        "expected confirmation did not appear — recovering"
      );


      /*
       * Try Escape to dismiss anything unexpected.
       */

      document.dispatchEvent(
        new KeyboardEvent(
          "keydown",
          {
            key: "Escape",
            code: "Escape",
            bubbles: true
          }
        )
      );


      await interruptibleSleep(300);


      await clearCurrentSelection();

      return 0;
    }


    /*
     * ----------------------------------------------------------
     * FINAL DESTRUCTIVE-ACTION CHECK
     * ----------------------------------------------------------
     *
     * Dialog is now open.
     *
     * We still require exact ownership of the selected set.
     */

    state =
      resolveOwnedSelection(
        selectedRecords
      );


    if (
      !state.exact ||
      state.owned.length !==
        intendedCount
    ) {

      warn(
        "selection changed while confirmation dialog was open — cancelling"
      );


      document.dispatchEvent(
        new KeyboardEvent(
          "keydown",
          {
            key: "Escape",
            code: "Escape",
            bubbles: true
          }
        )
      );


      await interruptibleSleep(300);


      await clearCurrentSelection();

      return 0;
    }


    if (stopRequested())
      throw new Error("USER_STOP");


    /*
     * ==========================================================
     * DESTRUCTIVE CLICK
     * ==========================================================
     */

    confirm.click();


    /*
     * No rollback from this point.
     */


    try {

      await waitFor(
        () =>
          dialogs().length === 0,
        DELETE_TIMEOUT_MS,
        "confirmation dialog to close"
      );

    } catch (e) {

      if (
        e.message === "USER_STOP"
      ) {
        throw e;
      }


      /*
       * Confirmation was already clicked.
       *
       * Do NOT click it again.
       *
       * Just let main loop rediscover state.
       */

      warn(
        "confirmation dialog state uncertain after click — rediscovering without re-clicking"
      );
    }


    /*
     * Give Google time to update its virtual grid.
     */

    await interruptibleSleep(400);


    log(
      `✓ moved verified batch of ${intendedCount} photo(s) to Bin`
    );


    return intendedCount;
  }


  // ============================================================
  // SCROLL DISCOVERY
  // ============================================================

  function canScroll(el) {

    if (!el)
      return false;


    try {

      const style =
        getComputedStyle(el);


      const overflow =
        style.overflowY || "";


      return (
        /(auto|scroll|overlay)/i.test(
          overflow
        ) &&
        el.scrollHeight >
          el.clientHeight + 5
      );

    } catch (_) {

      return false;
    }
  }


  function findScroller() {

    /*
     * Start from live photo if possible.
     */

    const photos =
      allActionablePhotos();


    if (photos.length) {

      let node =
        photos[0].parentElement;


      while (
        node &&
        node !== document.body &&
        node !==
          document.documentElement
      ) {

        if (canScroll(node))
          return node;


        node =
          node.parentElement;
      }
    }


    /*
     * Try main and ancestors.
     */

    const main =
      document.querySelector(
        '[role="main"]'
      );


    if (main) {

      let node = main;


      while (
        node &&
        node !== document.body &&
        node !==
          document.documentElement
      ) {

        if (canScroll(node))
          return node;


        node =
          node.parentElement;
      }
    }


    /*
     * Document fallback.
     */

    const doc =
      document.scrollingElement;


    if (
      doc &&
      doc.scrollHeight >
        doc.clientHeight + 5
    ) {
      return doc;
    }


    return null;
  }


  // ============================================================
  // AUTO SCROLL
  // ============================================================

  async function autoScroll() {

    scrollAttempts++;


    const step =
      SCROLL_STEPS[
        (scrollAttempts - 1) %
        SCROLL_STEPS.length
      ] || SCROLL_STEP;


    /*
     * Re-discover every time.
     */

    const scroller =
      findScroller();


    if (!scroller) {

      const before =
        window.scrollY;


      window.scrollBy(
        0,
        step
      );


      await interruptibleSleep(
        SCROLL_SETTLE_MS
      );


      const after =
        window.scrollY;


      log(
        `auto-scroll #${scrollAttempts}: window ${Math.round(before)} → ${Math.round(after)} | step=${step}`
      );


      return (
        after !== before
      );
    }


    const before =
      scroller.scrollTop;


    const max =
      Math.max(
        0,
        scroller.scrollHeight -
          scroller.clientHeight
      );


    const target =
      Math.min(
        max,
        before + step
      );


    scroller.scrollTop =
      target;


    /*
     * Encourage virtualised listeners.
     */

    try {

      scroller.dispatchEvent(
        new Event(
          "scroll",
          {
            bubbles: true
          }
        )
      );

    } catch (_) {}


    await interruptibleSleep(
      SCROLL_SETTLE_MS
    );


    const after =
      scroller.scrollTop;


    log(
      `auto-scroll #${scrollAttempts}: ${Math.round(before)} → ${Math.round(after)} | max=${Math.round(max)} | step=${step}`
    );


    return (
      after !== before
    );
  }


  // ============================================================
  // RECOVERY / IDLE LOOP
  // ============================================================

  async function recoverAndContinue() {

    idleCycles++;


    /*
     * First let Google settle.
     */

    await interruptibleSleep(
      NO_PHOTO_PAUSE_MS
    );


    if (
      unselectedPhotos().length
    ) {

      idleCycles = 0;

      return;
    }


    /*
     * Scroll.
     */

    await autoScroll();


    /*
     * Google may need another beat to populate.
     */

    await interruptibleSleep(
      300
    );


    if (
      unselectedPhotos().length
    ) {

      log(
        `✓ auto-scroll exposed ${unselectedPhotos().length} actionable photo(s)`
      );


      idleCycles = 0;

      return;
    }


    /*
     * No movement/new photos is NOT completion.
     */

    if (
      idleCycles % 10 === 0
    ) {

      warn(
        `still searching for more photos — idle cycles=${idleCycles}; continuing`
      );


      await interruptibleSleep(
        STUCK_CYCLE_PAUSE_MS
      );
    }
  }


  // ============================================================
  // MAIN WORKER
  // ============================================================

  log(
    "============================================================"
  );

  log(
    "V8.5 STARTED — resilient unattended worker"
  );

  log(
    `Maximum batch size: ${MAX_BATCH}`
  );

  log(
    "Vanished candidates are skipped, NOT fatal"
  );

  log(
    "Partial verified batches ARE moved to Bin"
  );

  log(
    "DOM replacement is expected"
  );

  log(
    "Automatic scrolling enabled"
  );

  log(
    "No-photo state is NOT interpreted as completion"
  );

  log(
    "Bin will NEVER be emptied"
  );

  log(
    "Stop with: window.__stopDelete = true"
  );

  log(
    "============================================================"
  );


  try {

    while (!stopRequested()) {

      /*
       * --------------------------------------------------------
       * 1. FIND SOMETHING TO WORK ON
       * --------------------------------------------------------
       */

      if (
        !unselectedPhotos().length
      ) {

        await recoverAndContinue();

        continue;
      }


      idleCycles = 0;


      /*
       * --------------------------------------------------------
       * 2. BUILD WHATEVER VERIFIED BATCH SURVIVES
       * --------------------------------------------------------
       */

      let selectedRecords = [];


      try {

        selectedRecords =
          await buildSelectedBatch();

      } catch (e) {

        if (
          e.message === "USER_STOP"
        ) {
          throw e;
        }


        warn(
          `batch construction issue: ${e.message} — recovering and continuing`
        );


        await clearCurrentSelection();

        await interruptibleSleep(500);

        continue;
      }


      /*
       * Nothing survived this snapshot.
       *
       * Not fatal.
       */

      if (!selectedRecords.length) {

        log(
          "no candidates survived this pass — rediscovering"
        );


        await clearCurrentSelection();

        await recoverAndContinue();

        continue;
      }


      /*
       * --------------------------------------------------------
       * 3. DELETE THE VERIFIED SURVIVING SUBSET
       * --------------------------------------------------------
       */

      let moved = 0;


      try {

        moved =
          await deleteOwnedSelection(
            selectedRecords
          );

      } catch (e) {

        if (
          e.message === "USER_STOP"
        ) {
          throw e;
        }


        /*
         * Batch-level issue.
         *
         * STILL NOT A REASON TO TERMINATE THE WORKER.
         */

        warn(
          `batch recovery: ${e.message}`
        );


        await clearCurrentSelection();

        await interruptibleSleep(700);

        continue;
      }


      /*
       * --------------------------------------------------------
       * 4. ACCOUNT + THROW AWAY OLD DOM STATE
       * --------------------------------------------------------
       */

      if (moved > 0) {

        batchesMoved++;
        photosMoved += moved;


        const elapsedMinutes =
          (
            performance.now() -
            started
          ) / 60000;


        log(
          `✓ batch #${batchesMoved} moved | this batch=${moved} | photos this run=${photosMoved} | skipped=${candidatesSkipped} | recoveries=${recoveries} | ${elapsedMinutes.toFixed(1)} min`
        );


        /*
         * Old records intentionally die here.
         *
         * Next iteration starts from the LIVE DOM.
         */

        await interruptibleSleep(
          BETWEEN_BATCHES_MS
        );

      } else {

        /*
         * Nothing deleted.
         *
         * Don't stop.
         */

        await interruptibleSleep(500);
      }
    }


    log(
      "STOP REQUEST RECEIVED"
    );


  } catch (e) {

    if (
      e.message === "USER_STOP"
    ) {

      warn(
        "STOPPED BY USER"
      );

    } else {

      /*
       * Truly unexpected top-level exception.
       */

      error(
        `UNEXPECTED TOP-LEVEL FAILURE: ${e.stack || e.message || e}`
      );
    }


  } finally {

    window.__gphotosRunning = false;


    const elapsedMinutes =
      (
        performance.now() -
        started
      ) / 60000;


    log(
      "============================================================"
    );

    log(
      `V8.5 ENDED — batches=${batchesMoved}, photos moved=${photosMoved}, skipped=${candidatesSkipped}, recoveries=${recoveries}, scroll attempts=${scrollAttempts}, elapsed=${elapsedMinutes.toFixed(1)} min`
    );

    log(
      "Bin has NOT been emptied."
    );

    log(
      "============================================================"
    );
  }

})();
