(function () {
  "use strict";

  const PAGE_MESSAGE_TYPE = "ysw:page-copied-video-url";
  const REQUEST_COPY_TYPE = "ysw:request-copy-link";
  const EXTENSION_MESSAGE_TYPE = "ysw:captured-video-url";
  const AUTO_COPY_COOLDOWN_MS = 2500;
  let lastAutoCopyAt = 0;
  let lastAutoCopyKey = "";

  function isYouTubeUrl(value) {
    return /^https?:\/\/(?:www\.)?(?:youtube\.com|youtu\.be)\//i.test(String(value || ""));
  }

  function sendCapturedUrl(url) {
    if (!isYouTubeUrl(url)) return;
    try {
      browser.runtime.sendMessage({
        type: EXTENSION_MESSAGE_TYPE,
        url
      }).catch(() => {});
    } catch (_) {
      // Reloading the extension invalidates scripts already running in an open tab.
    }
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window || event.data?.type !== PAGE_MESSAGE_TYPE) return;
    sendCapturedUrl(event.data.url);
  });

  function getActivePageKey() {
    const title = document.querySelector("#lg-info-div h1, #lg-info-div h2, [class*='title']")?.textContent || "";
    const activeListItem = document.querySelector("[class*='active'], [aria-current='true']")?.textContent || "";
    return `${location.href}|${title.trim()}|${activeListItem.trim()}`;
  }

  function requestAutomaticCopy(force) {
    const now = Date.now();
    const key = getActivePageKey();
    if (!force && key === lastAutoCopyKey && now - lastAutoCopyAt < AUTO_COPY_COOLDOWN_MS) {
      return;
    }
    const button = document.querySelector("#copy-link, .copy-link, [aria-label^='Copy link']");
    if (!button) return;
    lastAutoCopyAt = now;
    lastAutoCopyKey = key;
    window.postMessage({ type: REQUEST_COPY_TYPE }, window.location.origin);
  }

  const script = document.createElement("script");
  script.src = browser.runtime.getURL("src/page-clipboard-hook.js");
  script.async = false;
  script.onload = () => {
    script.remove();
    window.setTimeout(() => requestAutomaticCopy(true), 500);
  };
  (document.documentElement || document.head).appendChild(script);

  const observer = new MutationObserver(() => requestAutomaticCopy(false));
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    characterData: true
  });

  window.addEventListener("popstate", () => window.setTimeout(() => requestAutomaticCopy(true), 250));
  window.setInterval(() => requestAutomaticCopy(false), 3000);
})();
