/* global SplitClickSettings */
"use strict";

importScripts("settings.js");

const BADGE_OFF = { text: "OFF", color: "#6B7280" };
const BADGE_ON = { text: "", color: "#0F4C5C" };
const CONTENT_FILES = ["settings.js", "content.js"];

async function syncActionBadge(enabled) {
  if (enabled) {
    await chrome.action.setBadgeText({ text: BADGE_ON.text });
    await chrome.action.setTitle({
      title: "Split Click：已启用（点击禁用）",
    });
  } else {
    await chrome.action.setBadgeText({ text: BADGE_OFF.text });
    await chrome.action.setBadgeBackgroundColor({ color: BADGE_OFF.color });
    await chrome.action.setTitle({
      title: "Split Click：已禁用（点击启用）",
    });
  }
}

async function refreshBadgeFromStorage() {
  const settings = await SplitClickSettings.loadSettings();
  await syncActionBadge(settings.enabled);
}

function isInjectableUrl(url) {
  if (!url || typeof url !== "string") return false;
  try {
    const protocol = new URL(url).protocol;
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

function tabIsInSplit(tab) {
  return Boolean(tab && typeof tab.splitViewId === "number" && tab.splitViewId !== -1);
}

/**
 * Push split membership to content scripts in a tab (all frames receive
 * tabs.sendMessage when listeners exist).
 */
async function pushSplitState(tabId) {
  if (typeof tabId !== "number") return;
  try {
    const tab = await chrome.tabs.get(tabId);
    const inSplit = tabIsInSplit(tab);
    await chrome.tabs.sendMessage(tabId, {
      type: "split-click:splitState",
      inSplit,
      splitViewId: inSplit ? tab.splitViewId : -1,
    });
  } catch {
    // No receiving end yet (not injected / restricted page).
  }
}

async function injectIntoTab(tabId) {
  if (typeof tabId !== "number") return false;
  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      files: CONTENT_FILES,
      injectImmediately: true,
    });
    await pushSplitState(tabId);
    return true;
  } catch (err) {
    console.debug(
      "[Split Click] inject skipped for tab",
      tabId,
      err && err.message ? err.message : err
    );
    return false;
  }
}

async function injectIntoAllHttpTabs() {
  const tabs = await chrome.tabs.query({});
  const jobs = [];
  for (const tab of tabs) {
    if (tab.id != null && isInjectableUrl(tab.url)) {
      jobs.push(injectIntoTab(tab.id));
    }
  }
  await Promise.all(jobs);
}

async function ensureTabAndSiblingInjected(tab) {
  if (!tab || typeof tab.id !== "number") return;
  await injectIntoTab(tab.id);
  const sibling = await findSplitSibling(tab);
  if (sibling && typeof sibling.id === "number") {
    await injectIntoTab(sibling.id);
  }
}

async function openAdjacentTab(tab, url, reason) {
  console.warn("[Split Click] Split View fallback:", reason);
  const createProps = { url, active: true };
  if (tab && typeof tab.index === "number") {
    createProps.index = tab.index + 1;
  }
  if (tab && typeof tab.windowId === "number") {
    createProps.windowId = tab.windowId;
  }
  const created = await chrome.tabs.create(createProps);
  if (created && created.id != null) {
    await injectIntoTab(created.id);
  }
  return created;
}

async function findSplitSibling(tab) {
  if (!tabIsInSplit(tab)) {
    return null;
  }
  try {
    const siblings = await chrome.tabs.query({
      windowId: tab.windowId,
      splitViewId: tab.splitViewId,
    });
    return siblings.find((t) => t.id !== tab.id) || null;
  } catch (err) {
    console.warn("[Split Click] splitViewId query failed; scanning window:", err);
    const tabs = await chrome.tabs.query({ windowId: tab.windowId });
    return (
      tabs.find(
        (t) => t.id !== tab.id && t.splitViewId === tab.splitViewId
      ) || null
    );
  }
}

async function createSplitWith(tab, url) {
  try {
    const created = await chrome.tabs.create({
      url,
      splitWithTabId: tab.id,
    });
    if (created && created.id != null) {
      await injectIntoTab(created.id);
    }
    if (tab && tab.id != null) {
      await injectIntoTab(tab.id);
    }
    // Both panes are now in a split — refresh caches.
    if (tab && tab.id != null) await pushSplitState(tab.id);
    if (created && created.id != null) await pushSplitState(created.id);
    return created;
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    return openAdjacentTab(tab, url, message);
  }
}

async function updateTabUrl(tabId, url, modeLabel) {
  try {
    await chrome.tabs.update(tabId, { url, active: true });
    await injectIntoTab(tabId);
    return { ok: true, mode: modeLabel };
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    throw new Error(`tabs.update failed: ${message}`);
  }
}

/**
 * @param {chrome.runtime.MessageSender} sender
 * @param {string} url
 * @param {"split"|"current"} intent
 * @param {boolean} fromPlainClick
 */
async function handleOpenInSplit(sender, url, intent, fromPlainClick) {
  const settings = await SplitClickSettings.loadSettings();
  if (!settings.enabled) {
    return { ok: false, reason: "disabled" };
  }

  const tab = sender && sender.tab;
  if (!tab || typeof tab.id !== "number") {
    console.warn("[Split Click] Missing sender.tab; cannot open split.");
    return { ok: false, reason: "no-sender-tab" };
  }

  let current;
  try {
    current = await chrome.tabs.get(tab.id);
  } catch (err) {
    console.warn("[Split Click] tabs.get failed:", err);
    return { ok: false, reason: "tab-gone" };
  }

  void ensureTabAndSiblingInjected(current);

  const splitViewId =
    typeof current.splitViewId === "number" ? current.splitViewId : -1;
  const inSplit = splitViewId !== -1;

  // Keep content cache truthful for the next click.
  void pushSplitState(current.id);

  // Modifier combo while already split (plainClickOpen): current pane only.
  if (intent === "current") {
    try {
      return await updateTabUrl(current.id, url, "update-current-modifier");
    } catch (err) {
      console.warn("[Split Click] current-pane update failed:", err);
      return { ok: false, reason: err.message };
    }
  }

  // Safety: plain-click must never create a new split. If content cache was
  // stale (thought in-split), navigate this tab only — like native click.
  if (fromPlainClick && !inSplit) {
    try {
      return await updateTabUrl(current.id, url, "plain-not-split-fallback");
    } catch (err) {
      return { ok: false, reason: err.message };
    }
  }

  if (inSplit) {
    if (settings.whenAlreadySplit === "currentPane") {
      try {
        return await updateTabUrl(current.id, url, "update-current");
      } catch (err) {
        await openAdjacentTab(current, url, err.message);
        return { ok: true, mode: "fallback" };
      }
    }

    if (settings.whenAlreadySplit === "otherPane") {
      const other = await findSplitSibling(current);
      if (other) {
        try {
          return await updateTabUrl(other.id, url, "update-other");
        } catch (err) {
          await openAdjacentTab(current, url, err.message);
          return { ok: true, mode: "fallback" };
        }
      }
      console.warn(
        "[Split Click] Already in split but sibling not found; creating new."
      );
    }
  }

  // Not in split (modifier-triggered), or alwaysNew / missing sibling.
  await createSplitWith(current, url);
  return { ok: true, mode: "create-split" };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message.type !== "string") return;

  if (message.type === "split-click:getSplitState") {
    const tab = sender && sender.tab;
    if (!tab || typeof tab.id !== "number") {
      sendResponse({ inSplit: false, splitViewId: -1 });
      return;
    }
    chrome.tabs
      .get(tab.id)
      .then((fresh) => {
        const inSplit = tabIsInSplit(fresh);
        sendResponse({
          inSplit,
          splitViewId: inSplit ? fresh.splitViewId : -1,
        });
      })
      .catch(() => sendResponse({ inSplit: false, splitViewId: -1 }));
    return true;
  }

  if (message.type !== "split-click:open") {
    return;
  }

  const openUrl = typeof message.url === "string" ? message.url : "";
  const intent = message.intent === "current" ? "current" : "split";
  const fromPlainClick = Boolean(message.fromPlainClick);
  handleOpenInSplit(sender, openUrl, intent, fromPlainClick)
    .then((result) => sendResponse(result))
    .catch((err) => {
      console.error("[Split Click] handler error:", err);
      sendResponse({
        ok: false,
        reason: err && err.message ? err.message : String(err),
      });
    });
  return true;
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  // splitViewId changes when entering/leaving Split View; also refresh on load.
  if (
    changeInfo.splitViewId !== undefined ||
    changeInfo.status === "complete" ||
    changeInfo.url
  ) {
    pushSplitState(tabId);
  }
});

chrome.tabs.onActivated.addListener(({ tabId }) => {
  pushSplitState(tabId);
});

if (chrome.tabs.onAttached) {
  chrome.tabs.onAttached.addListener((tabId) => {
    pushSplitState(tabId);
  });
}

chrome.action.onClicked.addListener(async () => {
  const settings = await SplitClickSettings.loadSettings();
  const enabled = !settings.enabled;
  await chrome.storage.sync.set({ enabled });
  await syncActionBadge(enabled);
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "sync") return;
  if (changes.enabled) {
    const enabled = changes.enabled.newValue !== false;
    syncActionBadge(enabled);
  }
});

chrome.runtime.onInstalled.addListener(() => {
  refreshBadgeFromStorage();
  injectIntoAllHttpTabs();
});

chrome.runtime.onStartup.addListener(() => {
  refreshBadgeFromStorage();
  injectIntoAllHttpTabs();
});

refreshBadgeFromStorage();
injectIntoAllHttpTabs();
