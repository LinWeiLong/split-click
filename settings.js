/**
 * Shared defaults & normalization for Split Click.
 * Loaded via importScripts (background) or as a preceding content/options script.
 */
(function (global) {
  const WHEN_ALREADY_SPLIT = Object.freeze([
    "otherPane",
    "currentPane",
    "alwaysNew",
  ]);

  const DEFAULT_SETTINGS = Object.freeze({
    enabled: true,
    modifiers: Object.freeze({
      alt: true,
      ctrl: false,
      shift: false,
      meta: false,
    }),
    /**
     * When the current tab is already in a split:
     * - "otherPane": navigate the sibling pane (default)
     * - "currentPane": navigate the current pane in place
     * - "alwaysNew": try to create a new split via splitWithTabId
     */
    whenAlreadySplit: "otherPane",
    /**
     * When true, only while ALREADY in Split View:
     * - plain left-click → whenAlreadySplit logic (default other pane)
     * - configured modifier (default Alt) → current pane (avoid Save-as)
     * When NOT in a split: plain click stays fully native; modifier creates split.
     * When false: only the configured modifier combo triggers (create / whenAlreadySplit).
     */
    plainClickOpen: false,
  });

  function normalizeSettings(raw) {
    const src = raw && typeof raw === "object" ? raw : {};
    const mods =
      src.modifiers && typeof src.modifiers === "object" ? src.modifiers : {};
    const modifiers = {
      alt: Boolean(mods.alt),
      ctrl: Boolean(mods.ctrl),
      shift: Boolean(mods.shift),
      meta: Boolean(mods.meta),
    };
    // Enforce non-empty subset — fall back to Alt-only.
    if (
      !modifiers.alt &&
      !modifiers.ctrl &&
      !modifiers.shift &&
      !modifiers.meta
    ) {
      modifiers.alt = true;
    }
    const whenAlreadySplit = WHEN_ALREADY_SPLIT.includes(src.whenAlreadySplit)
      ? src.whenAlreadySplit
      : "otherPane";
    return {
      enabled: src.enabled !== false,
      modifiers,
      whenAlreadySplit,
      plainClickOpen: Boolean(src.plainClickOpen),
    };
  }

  async function loadSettings() {
    const stored = await chrome.storage.sync.get(null);
    return normalizeSettings(stored);
  }

  global.SplitClickSettings = {
    DEFAULT_SETTINGS,
    WHEN_ALREADY_SPLIT,
    normalizeSettings,
    loadSettings,
  };
})(typeof self !== "undefined" ? self : globalThis);
