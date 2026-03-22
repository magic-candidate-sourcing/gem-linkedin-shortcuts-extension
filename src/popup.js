"use strict";

const enabledCheckbox = document.getElementById("enabled");
const gemStatusDisplayModeSelect = document.getElementById("gemStatusDisplayMode");
const statusEl = document.getElementById("status");
const optionsBtn = document.getElementById("open-options");
const LINKEDIN_BOOTSTRAP_FILES = ["src/content_bootstrap.js"];
const FULL_RUNTIME_FILES = ["src/content.js"];
const SUPPORTED_TAB_PATTERNS = [
  /^https:\/\/www\.linkedin\.com\/(?:in|pub)\//i,
  /^https:\/\/www\.linkedin\.com\/talent(?:\/[^/]+)?\/profile\//i,
  /^https:\/\/(?:www|app)\.gem\.com\/(?:candidate|projects)\//i,
  /^https:\/\/mail\.google\.com\/mail\//i,
  /^https:\/\/github\.com\//i
];

function generateRunId() {
  if (crypto && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function setStatus(text, isError = false) {
  statusEl.textContent = text;
  statusEl.style.color = isError ? "#a61d24" : "#4f5358";
}

function isRecoverableContentError(message) {
  return /context invalidated|Receiving end does not exist/i.test(String(message || ""));
}

function getUnsupportedTabMessage() {
  return "Open a LinkedIn, Gem candidate, Gem project, GitHub profile, or Gmail thread tab and retry. If that tab is already supported, refresh it after the extension update.";
}

function isSupportedTabUrl(url) {
  const value = String(url || "").trim();
  return SUPPORTED_TAB_PATTERNS.some((pattern) => pattern.test(value));
}

function isLinkedInTabUrl(url) {
  const value = String(url || "").trim();
  return (
    /^https:\/\/www\.linkedin\.com\/(?:in|pub)\//i.test(value) ||
    /^https:\/\/www\.linkedin\.com\/talent(?:\/[^/]+)?\/profile\//i.test(value)
  );
}

function sendRuntimeMessage(payload) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(payload, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(response);
    });
  });
}

function sendTabMessage(tabId, payload) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, payload, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(response);
    });
  });
}

async function getCurrentTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs?.[0] || null;
}

function pingContent(tabId) {
  return sendTabMessage(tabId, { type: "PING" });
}

function getContentScriptFilesForTab(tab) {
  return isLinkedInTabUrl(tab?.url || "") ? LINKEDIN_BOOTSTRAP_FILES : FULL_RUNTIME_FILES;
}

function injectContentScripts(tabId, tab) {
  return chrome.scripting.executeScript({
    target: { tabId },
    files: getContentScriptFilesForTab(tab)
  });
}

async function ensureContentScriptReady(tab) {
  const tabId = Number(tab?.id);
  if (!Number.isInteger(tabId) || tabId < 0) {
    throw new Error("No active tab found.");
  }

  try {
    const response = await pingContent(tabId);
    if (response?.ok) {
      return;
    }
  } catch (error) {
    if (!isRecoverableContentError(error.message || "")) {
      throw error;
    }
  }

  const tabUrl = String(tab?.url || "").trim();
  if (tabUrl && !isSupportedTabUrl(tabUrl)) {
    throw new Error(getUnsupportedTabMessage());
  }

  try {
    await injectContentScripts(tabId, tab);
  } catch (_error) {
    throw new Error(getUnsupportedTabMessage());
  }

  const response = await pingContent(tabId);
  if (!response?.ok) {
    throw new Error("Couldn't initialize the page helper. Reload the tab and retry.");
  }
}

async function sendActionToContent(tabId, actionId) {
  const runId = generateRunId();
  let response = await sendTabMessage(tabId, { type: "TRIGGER_ACTION", actionId, source: "popup", runId });
  if (response?.deferred) {
    await new Promise((resolve) => window.setTimeout(resolve, 40));
    response = await sendTabMessage(tabId, { type: "TRIGGER_ACTION", actionId, source: "popup", runId });
  }
  return response;
}

async function syncSettingsToActiveTab(settings) {
  const activeTab = await getCurrentTab();
  if (!activeTab || !isSupportedTabUrl(activeTab.url || "")) {
    return;
  }
  await ensureContentScriptReady(activeTab);
  await sendTabMessage(activeTab.id, { type: "SETTINGS_UPDATED", settings });
}

async function repairActiveTabIfSupported() {
  const activeTab = await getCurrentTab();
  if (!activeTab || !isSupportedTabUrl(activeTab.url || "")) {
    return false;
  }
  await ensureContentScriptReady(activeTab);
  return true;
}

async function loadState() {
  const response = await sendRuntimeMessage({ type: "GET_SETTINGS" });
  if (!response?.ok) {
    throw new Error(response?.message || "Could not load settings");
  }
  const settings = deepMerge(DEFAULT_SETTINGS, response.settings || {});
  enabledCheckbox.checked = !!settings.enabled;
  gemStatusDisplayModeSelect.value = normalizeGemStatusDisplayMode(
    settings.gemStatusDisplayMode,
    settings.showGemStatusBadge !== false
  );
}

async function updateSettingsPatch(patch, successMessage, successEvent, failureEvent) {
  try {
    const response = await sendRuntimeMessage({ type: "GET_SETTINGS" });
    if (!response?.ok) {
      throw new Error(response?.message || "Could not load settings");
    }
    const settings = deepMerge(DEFAULT_SETTINGS, response.settings || {});
    Object.assign(settings, patch || {});
    settings.gemStatusDisplayMode = normalizeGemStatusDisplayMode(
      settings.gemStatusDisplayMode,
      settings.showGemStatusBadge !== false
    );
    settings.showGemStatusBadge = isGemStatusDisplayEnabled(settings.gemStatusDisplayMode);
    const saveResponse = await sendRuntimeMessage({ type: "SAVE_SETTINGS", settings });
    if (!saveResponse?.ok) {
      throw new Error(saveResponse?.message || "Could not save settings");
    }
    syncSettingsToActiveTab(settings).catch(() => {});
    setStatus(successMessage);
    sendRuntimeMessage({
      type: "LOG_EVENT",
      payload: {
        source: "extension.popup",
        event: successEvent,
        message: successMessage
      }
    }).catch(() => {});
  } catch (error) {
    setStatus(error.message, true);
    sendRuntimeMessage({
      type: "LOG_EVENT",
      payload: {
        source: "extension.popup",
        level: "error",
        event: failureEvent,
        message: error.message || "Failed to update popup setting."
      }
    }).catch(() => {});
  }
}

enabledCheckbox.addEventListener("change", async () => {
  await updateSettingsPatch(
    { enabled: enabledCheckbox.checked },
    enabledCheckbox.checked ? "Enabled" : "Disabled",
    "popup.enabled_toggled",
    "popup.enabled_toggle_failed"
  );
});

gemStatusDisplayModeSelect.addEventListener("change", async () => {
  const nextMode = normalizeGemStatusDisplayMode(gemStatusDisplayModeSelect.value, true);
  await updateSettingsPatch(
    {
      gemStatusDisplayMode: nextMode,
      showGemStatusBadge: isGemStatusDisplayEnabled(nextMode)
    },
    `Gem status display: ${formatGemStatusDisplayModeLabel(nextMode)}.`,
    "popup.status_badge_toggled",
    "popup.status_badge_toggle_failed"
  );
});

document.querySelectorAll("button[data-action]").forEach((button) => {
  button.addEventListener("click", async () => {
    const actionId = button.getAttribute("data-action");
    try {
      const activeTab = await getCurrentTab();
      await ensureContentScriptReady(activeTab);
      const tabId = Number(activeTab?.id);
      await sendActionToContent(tabId, actionId);
      setStatus("Action sent.");
    } catch (error) {
      const message = error.message || "Failed to send action.";
      if (isRecoverableContentError(message)) {
        setStatus(getUnsupportedTabMessage(), true);
      } else {
        setStatus(message, true);
      }
      sendRuntimeMessage({
        type: "LOG_EVENT",
        payload: {
          source: "extension.popup",
          level: "error",
          event: "popup.action_send_failed",
          actionId,
          message
        }
      }).catch(() => {});
    }
  });
});

optionsBtn.addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});

loadState()
  .then(() => repairActiveTabIfSupported().catch(() => {}))
  .catch((error) => setStatus(error.message, true));
