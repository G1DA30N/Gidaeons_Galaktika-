(function () {
  "use strict";

  if (globalThis.browser) {
    globalThis.GALAKTIKA_BROWSER_FAMILY = "firefox";
    return;
  }
  if (globalThis.chrome) {
    globalThis.browser = globalThis.chrome;
    globalThis.GALAKTIKA_BROWSER_FAMILY = "chromium";
    return;
  }
  throw new Error("Galaktika could not find a supported WebExtension API.");
})();
