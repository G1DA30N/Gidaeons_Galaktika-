const ENABLED_KEY = "galaktikaEnabled";
const SITE_URLS = {
  youtube: "https://www.youtube.com/",
  samplette: "https://samplette.io/",
  radiooooo: "https://app.radiooooo.com/"
};

const statusEl = document.getElementById("status");
const helperLight = document.getElementById("helper-light");
const hintEl = document.getElementById("hint");
const enabledToggle = document.getElementById("enabled-toggle");
const youtubeButton = document.getElementById("open-youtube");
const sampletteButton = document.getElementById("open-samplette");
const radioooooButton = document.getElementById("open-radiooooo");
let activeTabId = null;
let pageToggleState = null;
let globallyEnabled = true;

function setStatus(text, hint = "") {
  statusEl.textContent = text;
  hintEl.textContent = hint;
}

function setHelperLight(state) {
  helperLight.classList.toggle("status-running", state === "running");
  helperLight.classList.toggle("status-stopped", state === "stopped");
  helperLight.classList.toggle("status-checking", state === "checking");
}

async function helperStatus() {
  return browser.runtime.sendMessage({ type: "ysw:native-status" });
}

async function getActivePageToggleState() {
  try {
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    activeTabId = Number.isFinite(tab?.id) ? tab.id : null;
    if (activeTabId === null) return null;
    return await browser.tabs.sendMessage(
      activeTabId,
      { type: "ysw:get-page-toggle-state" },
      { frameId: 0 }
    );
  } catch (_) {
    return null;
  }
}

async function setLongVideoOverride(enabled) {
  if (activeTabId === null) return null;
  try {
    return await browser.tabs.sendMessage(
      activeTabId,
      { type: "ysw:set-long-video-override", enabled },
      { frameId: 0 }
    );
  } catch (_) {
    return null;
  }
}

function nativeErrorHint(error) {
  const message = error?.message || String(error || "Unknown native messaging error.");
  return `${message} Run Install-Galaktika-Helper.cmd, reload Galaktika, then try again.`;
}

async function refresh() {
  const [settings, currentPageState] = await Promise.all([
    browser.storage.local.get({ [ENABLED_KEY]: true }),
    getActivePageToggleState()
  ]);
  globallyEnabled = settings[ENABLED_KEY] !== false;
  pageToggleState = currentPageState;
  enabledToggle.checked = globallyEnabled && !pageToggleState?.excluded;
  setHelperLight("checking");
  if (pageToggleState?.excluded) {
    setHelperLight("stopped");
    setStatus("Long video excluded", "Turn on to enable Galaktika for this video.");
    return;
  }
  try {
    const status = await helperStatus();
    const activeSessions = Number(status?.activeSessions || 0);
    const pendingRequests = Number(status?.pendingRequests || 0);
    setHelperLight(status?.connected ? "running" : "stopped");
    setStatus(
      status?.connected ? "Helper connected" : "Helper sleeping",
      status?.connected
        ? `${activeSessions} visible session${activeSessions === 1 ? "" : "s"}; ${pendingRequests} active request${pendingRequests === 1 ? "" : "s"}.`
        : "Starts automatically when Galaktika is visible."
    );
  } catch (error) {
    setHelperLight("stopped");
    setStatus("Could not read helper status", nativeErrorHint(error));
  }
}

enabledToggle.addEventListener("change", async () => {
  const enabled = enabledToggle.checked;
  enabledToggle.disabled = true;
  try {
    pageToggleState = await getActivePageToggleState() || pageToggleState;
    if (enabled) {
      if (!globallyEnabled) {
        await browser.storage.local.set({ [ENABLED_KEY]: true });
      }
      await setLongVideoOverride(true);
      setStatus("Galaktika enabled", pageToggleState?.longVideo ? "Enabled for this video." : "");
    } else if (pageToggleState?.longVideo && pageToggleState?.override) {
      await setLongVideoOverride(false);
      setStatus("Long video excluded", "Galaktika remains enabled for compatible videos.");
    } else {
      await setLongVideoOverride(false);
      await browser.storage.local.set({ [ENABLED_KEY]: false });
      setStatus("Galaktika disabled", "Open tabs will hide the waveform shortly.");
    }
    await refresh();
  } finally {
    enabledToggle.disabled = false;
  }
});

youtubeButton.addEventListener("click", () => browser.tabs.create({ url: SITE_URLS.youtube }));
sampletteButton.addEventListener("click", () => browser.tabs.create({ url: SITE_URLS.samplette }));
radioooooButton.addEventListener("click", () => browser.tabs.create({ url: SITE_URLS.radiooooo }));

refresh();
