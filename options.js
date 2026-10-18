/* global SplitClickSettings */
"use strict";

(function () {
  const form = document.getElementById("settings-form");
  const modError = document.getElementById("mod-error");
  const statusEl = document.getElementById("status");
  const enabledEl = document.getElementById("enabled");
  const plainClickOpenEl = document.getElementById("plainClickOpen");

  function readModifiersFromForm() {
    const boxes = form.querySelectorAll('input[name="mod"]');
    const modifiers = { alt: false, ctrl: false, shift: false, meta: false };
    boxes.forEach((box) => {
      if (
        box.checked &&
        Object.prototype.hasOwnProperty.call(modifiers, box.value)
      ) {
        modifiers[box.value] = true;
      }
    });
    return modifiers;
  }

  function fillForm(settings) {
    const s = SplitClickSettings.normalizeSettings(settings);
    form.querySelectorAll('input[name="mod"]').forEach((box) => {
      box.checked = Boolean(s.modifiers[box.value]);
    });
    const radio = form.querySelector(
      `input[name="whenAlreadySplit"][value="${s.whenAlreadySplit}"]`
    );
    if (radio) radio.checked = true;
    enabledEl.checked = s.enabled;
    plainClickOpenEl.checked = s.plainClickOpen;
    modError.hidden = true;
  }

  function showStatus(text) {
    statusEl.textContent = text;
    if (showStatus._timer) clearTimeout(showStatus._timer);
    showStatus._timer = setTimeout(() => {
      statusEl.textContent = "";
    }, 2000);
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const modifiers = readModifiersFromForm();
    const hasAny =
      modifiers.alt || modifiers.ctrl || modifiers.shift || modifiers.meta;
    if (!hasAny) {
      modError.hidden = false;
      return;
    }
    modError.hidden = true;

    const whenEl = form.querySelector(
      'input[name="whenAlreadySplit"]:checked'
    );
    const payload = SplitClickSettings.normalizeSettings({
      enabled: enabledEl.checked,
      modifiers,
      whenAlreadySplit: whenEl ? whenEl.value : "otherPane",
      plainClickOpen: plainClickOpenEl.checked,
    });

    await chrome.storage.sync.set({
      enabled: payload.enabled,
      modifiers: payload.modifiers,
      whenAlreadySplit: payload.whenAlreadySplit,
      plainClickOpen: payload.plainClickOpen,
    });
    showStatus("已保存");
  });

  // Live-reflect external changes (e.g. toolbar toggle).
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "sync") return;
    SplitClickSettings.loadSettings().then(fillForm);
  });

  SplitClickSettings.loadSettings().then(fillForm);
})();
