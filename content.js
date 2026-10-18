/* global SplitClickSettings */
"use strict";

(function () {
  // Guard against double injection (declarative CS + scripting.executeScript).
  if (globalThis.__SPLIT_CLICK_CS__) return;
  globalThis.__SPLIT_CLICK_CS__ = true;

  /** @type {ReturnType<typeof SplitClickSettings.normalizeSettings>} */
  let settings = SplitClickSettings.normalizeSettings(
    SplitClickSettings.DEFAULT_SETTINGS
  );

  /**
   * Cached Split View membership for this tab. Refreshed by background push
   * and on focus/visibility. Used so plain-click can no-op (native) when not
   * in a split without awaiting async messaging inside the click handler.
   */
  let inSplitCache = false;

  function applySettings(raw) {
    settings = SplitClickSettings.normalizeSettings(raw);
  }

  SplitClickSettings.loadSettings().then(applySettings);

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "sync") return;
    const next = {
      enabled: settings.enabled,
      modifiers: { ...settings.modifiers },
      whenAlreadySplit: settings.whenAlreadySplit,
      plainClickOpen: settings.plainClickOpen,
    };
    if (changes.enabled) next.enabled = changes.enabled.newValue !== false;
    if (changes.modifiers && changes.modifiers.newValue) {
      next.modifiers = changes.modifiers.newValue;
    }
    if (changes.whenAlreadySplit) {
      next.whenAlreadySplit = changes.whenAlreadySplit.newValue;
    }
    if (changes.plainClickOpen) {
      next.plainClickOpen = Boolean(changes.plainClickOpen.newValue);
    }
    applySettings(next);
  });

  function refreshSplitState() {
    chrome.runtime.sendMessage(
      { type: "split-click:getSplitState" },
      (res) => {
        if (chrome.runtime.lastError) return;
        if (res && typeof res.inSplit === "boolean") {
          inSplitCache = res.inSplit;
        }
      }
    );
  }

  chrome.runtime.onMessage.addListener((message) => {
    if (!message || message.type !== "split-click:splitState") return;
    inSplitCache = Boolean(message.inSplit);
  });

  refreshSplitState();
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") refreshSplitState();
  });
  window.addEventListener("focus", refreshSplitState);

  function modifiersMatch(event) {
    const m = settings.modifiers;
    return (
      event.altKey === m.alt &&
      event.ctrlKey === m.ctrl &&
      event.shiftKey === m.shift &&
      event.metaKey === m.meta
    );
  }

  function hasAnyModifier(event) {
    return event.altKey || event.ctrlKey || event.shiftKey || event.metaKey;
  }

  /**
   * @returns {{ intent: "split"|"current", fromPlainClick?: boolean } | null}
   */
  function resolveAction(event) {
    if (event.button !== 0) return null;
    if (!settings.enabled) return null;
    // Always preserve native Ctrl/Cmd+click → background tab.
    if (event.ctrlKey || event.metaKey) return null;

    if (settings.plainClickOpen) {
      if (!hasAnyModifier(event)) {
        // Plain click: only while already in Split View (cache).
        // When not in split → fully native (no preventDefault).
        if (!inSplitCache) return null;
        return { intent: "split", fromPlainClick: true };
      }
      if (modifiersMatch(event)) {
        // In split → current pane (avoid Chrome Alt+Save-as).
        // Not in split → create / enter split (same as classic Alt+click).
        if (inSplitCache) return { intent: "current" };
        return { intent: "split" };
      }
      return null;
    }

    // plainClickOpen OFF: only configured modifier combo → split logic.
    if (modifiersMatch(event)) return { intent: "split" };
    return null;
  }

  function findAnchorFromEvent(event) {
    const path =
      typeof event.composedPath === "function" ? event.composedPath() : [];
    for (const node of path) {
      if (node && node.nodeType === 1 && node.tagName === "A") {
        return /** @type {HTMLAnchorElement} */ (node);
      }
    }
    let el = event.target;
    if (el && el.nodeType === 3) el = el.parentElement;
    while (el && el !== document && el !== window) {
      if (el.tagName === "A") return /** @type {HTMLAnchorElement} */ (el);
      el = el.parentElement || (el.getRootNode && el.getRootNode().host);
    }
    return null;
  }

  function resolveNavigableUrl(anchor) {
    if (!anchor || anchor.hasAttribute("download")) return null;

    const hrefAttr = (anchor.getAttribute("href") || "").trim();
    if (!hrefAttr) return null;
    if (hrefAttr === "#") return null;

    let url;
    try {
      url = new URL(anchor.href, location.href);
    } catch {
      return null;
    }

    const protocol = url.protocol.toLowerCase();
    if (
      protocol === "javascript:" ||
      protocol === "mailto:" ||
      protocol === "tel:" ||
      protocol === "data:" ||
      protocol === "blob:"
    ) {
      return null;
    }

    if (protocol !== "http:" && protocol !== "https:") {
      return null;
    }

    return url.href;
  }

  function onClickCapture(event) {
    const action = resolveAction(event);
    if (!action) return;

    const anchor = findAnchorFromEvent(event);
    if (!anchor) return;

    const url = resolveNavigableUrl(anchor);
    if (!url) return;

    event.preventDefault();
    event.stopPropagation();
    if (typeof event.stopImmediatePropagation === "function") {
      event.stopImmediatePropagation();
    }

    chrome.runtime.sendMessage(
      {
        type: "split-click:open",
        url,
        intent: action.intent,
        fromPlainClick: Boolean(action.fromPlainClick),
      },
      () => {
        void chrome.runtime.lastError;
      }
    );
  }

  window.addEventListener("click", onClickCapture, true);
})();
