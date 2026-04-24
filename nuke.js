(async () => {
  const MAX_DELETE_COUNT = Infinity;
  const DRY_RUN = false;
  const BLOCK_IMAGES = true;
  const STEP_TIMEOUT_MS = 5000;
  const SETTLE_MS = 150;
  const STALL_LIMIT = 5;

  const DELETE_BTN_SELECTOR = 'div[data-delete-origin] button';

  if (BLOCK_IMAGES) {
    const BLANK =
      'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
    const shouldBlock = (v) =>
      typeof v === 'string' && v.includes('googleusercontent.com');

    const patchProp = (proto, name, blockValue) => {
      const desc = Object.getOwnPropertyDescriptor(proto, name);
      if (!desc) return;
      Object.defineProperty(proto, name, {
        configurable: true,
        get() {
          return desc.get.call(this);
        },
        set(v) {
          desc.set.call(this, shouldBlock(v) ? blockValue : v);
        },
      });
    };

    patchProp(HTMLImageElement.prototype, 'src', BLANK);
    patchProp(HTMLImageElement.prototype, 'srcset', '');
    patchProp(HTMLSourceElement.prototype, 'srcset', '');

    const origSetAttribute = Element.prototype.setAttribute;
    Element.prototype.setAttribute = function (name, value) {
      if (
        (this instanceof HTMLImageElement || this instanceof HTMLSourceElement) &&
        (name === 'src' || name === 'srcset') &&
        shouldBlock(value)
      ) {
        return origSetAttribute.call(this, name, name === 'src' ? BLANK : '');
      }
      return origSetAttribute.call(this, name, value);
    };

    for (const img of document.querySelectorAll('img')) {
      if (shouldBlock(img.src)) img.src = BLANK;
      if (shouldBlock(img.srcset)) img.srcset = '';
    }

    console.log('[gphotos-nuke] image blocking enabled (googleusercontent.com)');
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const waitFor = (predicate, timeout = STEP_TIMEOUT_MS) =>
    new Promise((resolve, reject) => {
      const started = performance.now();
      const tick = () => {
        let result;
        try {
          result = predicate();
        } catch (e) {
          result = null;
        }
        if (result) return resolve(result);
        if (performance.now() - started > timeout) return reject(new Error('waitFor timeout'));
        requestAnimationFrame(tick);
      };
      tick();
    });

  const queryTiles = () => {
    const mains = document.querySelectorAll('[role="main"]');
    for (const m of mains) {
      const cbs = m.querySelectorAll('[role="checkbox"]');
      if (cbs.length) {
        return Array.from(cbs).filter((el) => !el.closest('[role="dialog"]'));
      }
    }
    return [];
  };

  const findConfirmButton = () => {
    const dialogs = document.querySelectorAll('[role="dialog"]');
    const dialog = dialogs[dialogs.length - 1];
    if (!dialog) return null;
    const textButtons = Array.from(dialog.querySelectorAll('button')).filter(
      (b) => b.textContent.trim().length > 0,
    );
    return textButtons[textButtons.length - 1] || null;
  };

  const rangeSelect = (first, last) => {
    first.click();
    last.dispatchEvent(
      new MouseEvent('click', {
        shiftKey: true,
        bubbles: true,
        cancelable: true,
        view: window,
      }),
    );
  };

  const started = performance.now();
  let cycle = 0;
  let total = 0;
  let stallCount = 0;
  let lastFirstLabel = null;

  console.log('[gphotos-nuke] starting. Set window.__stopDelete = true to abort.');

  while (true) {
    if (window.__stopDelete) {
      console.log('[gphotos-nuke] aborted via __stopDelete');
      break;
    }
    if (total >= MAX_DELETE_COUNT) {
      console.log('[gphotos-nuke] reached MAX_DELETE_COUNT');
      break;
    }

    let tiles;
    try {
      tiles = await waitFor(() => {
        const t = queryTiles();
        return t.length ? t : null;
      });
    } catch {
      console.log('[gphotos-nuke] no more tiles visible - library appears empty');
      break;
    }

    const remaining = MAX_DELETE_COUNT - total;
    const batch = tiles.slice(0, Math.min(tiles.length, remaining));
    const cycleStart = performance.now();
    cycle++;

    // Stall detection - adapted from JuliusBairaktaris/Google-Photos-Deletion-Script
    const firstLabel = batch[0].getAttribute('aria-label') || '';
    if (firstLabel && firstLabel === lastFirstLabel) {
      stallCount++;
      if (stallCount >= STALL_LIMIT) {
        console.warn(
          `[gphotos-nuke] stalled ${STALL_LIMIT} cycles - first tile unchanged ("${firstLabel}"). Likely rate-limited by Google. Reload the page and rerun to continue.`,
        );
        break;
      }
    } else {
      stallCount = 0;
    }
    lastFirstLabel = firstLabel;

    try {
      if (batch.length === 1) {
        batch[0].click();
      } else {
        rangeSelect(batch[0], batch[batch.length - 1]);
      }

      const deleteBtn = await waitFor(() => document.querySelector(DELETE_BTN_SELECTOR));

      if (DRY_RUN) {
        console.log(`[cycle #${cycle}] DRY_RUN: would delete ${batch.length} tiles`);
        document.body.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
        );
        total += batch.length;
        break;
      }

      deleteBtn.click();

      const confirmBtn = await waitFor(() => findConfirmButton());
      confirmBtn.click();

      await waitFor(() => !document.querySelector('[role="dialog"]'));
      await sleep(SETTLE_MS);

      total += batch.length;
      const ms = Math.round(performance.now() - cycleStart);
      console.log(
        `[cycle #${cycle}] selected ${batch.length} tiles (total ${total}) - confirmed in ${ms}ms`,
      );
    } catch (err) {
      console.warn(`[cycle #${cycle}] error: ${err.message} - continuing`);
      await sleep(SETTLE_MS);
    }
  }

  const elapsed = ((performance.now() - started) / 1000).toFixed(1);
  console.log(
    `[gphotos-nuke] done. deleted=${total} cycles=${cycle} elapsed=${elapsed}s`,
  );
  delete window.__stopDelete;
})();
