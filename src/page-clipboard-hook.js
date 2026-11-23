(function () {
  "use strict";

  const MESSAGE_TYPE = "ysw:page-copied-video-url";
  const REQUEST_COPY_TYPE = "ysw:request-copy-link";
  const YOUTUBE_URL_RE = /https?:\/\/(?:www\.)?(?:youtube\.com\/watch\?[^\s"'<>]*v=[\w-]+|youtu\.be\/[\w-]+|youtube\.com\/embed\/[\w-]+)/i;
  let suppressNextClipboardWrite = false;

  function publish(value) {
    const text = String(value || "");
    const match = text.match(YOUTUBE_URL_RE);
    if (!match) return;
    window.postMessage({ type: MESSAGE_TYPE, url: match[0] }, window.location.origin);
  }

  if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
    const originalWriteText = navigator.clipboard.writeText.bind(navigator.clipboard);
    navigator.clipboard.writeText = function writeText(value) {
      publish(value);
      if (suppressNextClipboardWrite) {
        suppressNextClipboardWrite = false;
        return Promise.resolve();
      }
      return originalWriteText(value);
    };
  }

  window.addEventListener("message", function (event) {
    if (event.source !== window || event.data?.type !== REQUEST_COPY_TYPE) return;
    const button = document.querySelector("#copy-link, .copy-link, [aria-label^='Copy link']");
    if (!button || typeof button.click !== "function") return;
    suppressNextClipboardWrite = true;
    button.click();
    window.setTimeout(function () {
      suppressNextClipboardWrite = false;
    }, 250);
  });

  document.addEventListener("copy", function (event) {
    publish(event.clipboardData?.getData("text/plain") || window.getSelection?.().toString() || "");
  }, true);
})();
