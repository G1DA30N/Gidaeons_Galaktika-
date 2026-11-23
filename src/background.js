(function () {
  "use strict";

  const capturedVideoUrls = new Map();
  const activeSessions = new Map();
  const pendingRequests = new Map();
  const clientRequestPorts = new Set();
  const CAPTURE_TTL_MS = 10 * 60 * 1000;
  const SESSION_TTL_MS = 45 * 1000;
  const NATIVE_HOST = "gidaeons_galaktika_host";
  const EXTENSION_ID = browser.runtime?.id || "unknown-extension-id";
  let nativePort = null;
  let nativeRequestSequence = 0;

  function isYouTubeUrl(value) {
    return /^https?:\/\/(?:www\.)?(?:youtube\.com|youtu\.be)\//i.test(String(value || ""));
  }

  function rememberCapturedVideoUrl(sender, url) {
    const tabId = sender?.tab?.id;
    if (typeof tabId !== "number" || !isYouTubeUrl(url)) return { ok: false };
    capturedVideoUrls.set(tabId, { url, capturedAt: Date.now() });
    return { ok: true };
  }

  function getCapturedVideoUrl(sender) {
    const tabId = sender?.tab?.id;
    if (typeof tabId !== "number") return { ok: false, url: "" };
    const cached = capturedVideoUrls.get(tabId);
    if (!cached || Date.now() - cached.capturedAt > CAPTURE_TTL_MS) {
      capturedVideoUrls.delete(tabId);
      return { ok: false, url: "" };
    }
    return { ok: true, url: cached.url };
  }

  function sessionKey(sender, clientId = "") {
    const tabId = sender?.tab?.id;
    const frameId = Number.isFinite(sender?.frameId) ? sender.frameId : 0;
    return typeof tabId === "number" ? `${tabId}:${frameId}:${clientId}` : `extension:${clientId}`;
  }

  function nativeError(message) {
    return {
      ok: false,
      status: 0,
      statusText: "NativeMessagingError",
      body: {
        error: message,
        nativeHost: NATIVE_HOST,
        extensionId: EXTENSION_ID,
        hint: "Run Install-Galaktika-Helper.cmd, reload the add-on, and try again."
      },
      transport: "native-messaging"
    };
  }

  function rejectPending(message) {
    for (const pending of pendingRequests.values()) {
      clearTimeout(pending.timeout);
      pending.resolve(nativeError(message));
    }
    pendingRequests.clear();
  }

  function refreshPendingTimeout(requestId, pending) {
    clearTimeout(pending.timeout);
    pending.timeout = setTimeout(() => {
      pendingRequests.delete(requestId);
      pending.resolve(nativeError(`Native helper request timed out while running ${pending.action}.`));
      maybeDisconnectNative();
    }, pending.timeoutMs);
  }

  function connectNative() {
    if (nativePort) return nativePort;
    const port = browser.runtime.connectNative(NATIVE_HOST);
    nativePort = port;

    port.onMessage.addListener((message) => {
      const requestId = String(message?.requestId || "");
      const pending = pendingRequests.get(requestId);
      if (!pending) return;
      refreshPendingTimeout(requestId, pending);
      if (message?.event === "native-keepalive") return;
      if (message?.event === "waveform-progress" || message?.event === "download-progress") {
        const target = pending.progressTarget;
        if (target?.progressId && Number.isFinite(target.tabId)) {
          browser.tabs.sendMessage(target.tabId, {
            type: "ysw:native-progress",
            progressId: target.progressId,
            event: message.event,
            body: message.body
          }, { frameId: target.frameId }).catch(() => {
            // The page or frame may have navigated while native decoding continues.
          });
        }
        return;
      }
      clearTimeout(pending.timeout);
      pendingRequests.delete(requestId);
      pending.resolve(message);
      maybeDisconnectNative();
    });

    port.onDisconnect.addListener(() => {
      if (nativePort !== port) return;
      const detail = browser.runtime.lastError?.message || "The native helper disconnected.";
      nativePort = null;
      rejectPending(detail);
    });
    return port;
  }

  function disconnectNative(reason = "The native helper was disconnected.") {
    const port = nativePort;
    nativePort = null;
    if (pendingRequests.size) rejectPending(reason);
    if (port) {
      try { port.disconnect(); } catch (_) { /* Already disconnected. */ }
    }
  }

  function pruneSessions() {
    const now = Date.now();
    for (const [key, seenAt] of activeSessions) {
      if (now - seenAt > SESSION_TTL_MS) activeSessions.delete(key);
    }
  }

  function maybeDisconnectNative() {
    pruneSessions();
    if (activeSessions.size === 0 && pendingRequests.size === 0 && clientRequestPorts.size === 0) {
      disconnectNative("Galaktika closed; active helper work was cancelled.");
    }
  }

  function requestNative(action, params = {}, timeoutMs = 30000, progressTarget = null) {
    return new Promise((resolve) => {
      let port;
      try {
        port = connectNative();
      } catch (error) {
        resolve(nativeError(error?.message || String(error)));
        return;
      }

      const requestId = `${Date.now()}-${++nativeRequestSequence}`;
      const pending = {
        resolve,
        timeout: 0,
        timeoutMs: Math.max(1000, Number(timeoutMs) || 30000),
        progressTarget,
        action
      };
      pendingRequests.set(requestId, pending);
      refreshPendingTimeout(requestId, pending);
      try {
        port.postMessage({ requestId, action, params, progress: Boolean(progressTarget) });
      } catch (error) {
        clearTimeout(pending.timeout);
        pendingRequests.delete(requestId);
        resolve(nativeError(error?.message || String(error)));
        disconnectNative();
      }
    });
  }

  function parseNativeUrl(value) {
    const url = new URL(value);
    if (url.protocol !== "galaktika-native:" || url.hostname !== "helper") {
      throw new Error("Only Galaktika native helper requests are accepted.");
    }
    const params = {};
    for (const [key, paramValue] of url.searchParams) params[key] = paramValue;
    return { action: url.pathname.replace(/^\//, ""), params };
  }

  async function handleNativeUrl(message, sender) {
    let request;
    try {
      request = parseNativeUrl(message.url);
    } catch (error) {
      return nativeError(error?.message || String(error));
    }

    const clientId = request.params.clientId || "";
    const key = sessionKey(sender, clientId);
    if (request.action === "session/open") {
      activeSessions.set(key, Date.now());
      try {
        connectNative();
        return { ok: true, status: 200, body: { ok: true, transport: "native-messaging" }, transport: "native-messaging" };
      } catch (error) {
        activeSessions.delete(key);
        return nativeError(error?.message || String(error));
      }
    }
    if (request.action === "session/close") {
      activeSessions.delete(key);
      // A native save picker can make Thorium report the page as hidden. Do not
      // tear down the shared host until an in-flight picker/download responds.
      maybeDisconnectNative();
      return { ok: true, status: 200, body: { ok: true }, transport: "native-messaging" };
    }

    if (sender?.tab && !activeSessions.has(key)) {
      return {
        ok: false,
        status: 409,
        statusText: "InactiveSession",
        body: { error: "Galaktika is not visible in this browser tab. No helper work was started." },
        transport: "native-messaging"
      };
    }
    activeSessions.set(key, Date.now());
    delete request.params.clientId;
    const progressTarget = message.progressId && Number.isFinite(sender?.tab?.id)
      ? {
          progressId: String(message.progressId),
          tabId: sender.tab.id,
          frameId: Number.isFinite(sender.frameId) ? sender.frameId : 0
        }
      : null;
    if (["waveform", "original-info", "download-wav", "download-mp3", "download-mp4", "download-game", "download-aac", "download-original"].includes(request.action)) {
      try {
        const stores = await browser.cookies.getAllCookieStores();
        const store = stores.find((item) => item.tabIds.includes(sender?.tab?.id));
        if (!store) throw new Error("Cannot locate this tab's cookie store. Refresh the page and try again.");
        const cookies = await browser.cookies.getAll({ domain: "youtube.com", storeId: store.id });
        // Cookies never enter page messages, URLs, extension storage, or logs.
        request.params.sessionCookies = cookies.filter((cookie) => !cookie.partitionKey).map(
          ({ domain, path, secure, expirationDate, name, value, hostOnly }) =>
            ({ domain, path, secure, expirationDate, name, value, hostOnly })
        );
      } catch (error) {
        return nativeError(`Cannot read YouTube session cookies: ${error?.message || error}. Reload Galaktika and allow its cookies permission.`);
      }
    }
    return requestNative(request.action, request.params, message.timeoutMs, progressTarget);
  }

  function handleMessage(message, sender) {
    if (!message) return false;
    if (message.type === "ysw:captured-video-url") {
      return Promise.resolve(rememberCapturedVideoUrl(sender, message.url));
    }
    if (message.type === "ysw:get-captured-video-url") {
      return Promise.resolve(getCapturedVideoUrl(sender));
    }
    if (message.type === "ysw:native-request") {
      return handleNativeUrl(message, sender);
    }
    if (message.type === "ysw:native-status") {
      pruneSessions();
      return Promise.resolve({
        ok: true,
        connected: Boolean(nativePort),
        activeSessions: activeSessions.size,
        pendingRequests: pendingRequests.size,
        transport: "native-messaging"
      });
    }
    if (message.type === "ysw:cancel-waveform-work") {
      const pending = [...pendingRequests.values()];
      const hasWaveform = pending.some((request) => request.action === "waveform");
      const hasOtherWork = pending.some((request) => request.action !== "waveform");
      if (hasWaveform && !hasOtherWork) {
        disconnectNative("MARCH started; waveform generation was cancelled to prioritize downloads.");
      }
      return Promise.resolve({ ok: true, cancelled: hasWaveform && !hasOtherWork });
    }
    if (message.type === "ysw:skip-march-download") {
      const tabId = sender?.tab?.id;
      const frameId = Number.isFinite(sender?.frameId) ? sender.frameId : 0;
      const downloadActions = new Set([
        "download-wav", "download-mp3", "download-mp4", "download-game", "download-aac", "download-original"
      ]);
      const targets = [...pendingRequests.entries()]
        .filter(([, pending]) => downloadActions.has(pending.action) &&
          pending.progressTarget?.tabId === tabId && pending.progressTarget?.frameId === frameId)
        .map(([requestId]) => requestId);
      const savedPaths = Array.isArray(message.paths)
        ? message.paths.filter((path) => typeof path === "string" && path.length <= 32768)
        : [];
      return Promise.all(targets.map((requestId) => requestNative(
        "cancel-request",
        { targetRequestId: requestId },
        10000
      ))).then(async (responses) => {
        const cleanup = savedPaths.length
          ? await requestNative("cleanup-march-files", { paths: savedPaths }, 10000)
          : { ok: true, body: { removed: 0 } };
        return {
          ok: responses.every((response) => response?.ok) && cleanup?.ok,
          cancelled: responses.filter((response) => response?.body?.cancelled).length,
          removed: Number(cleanup?.body?.removed || 0)
        };
      });
    }
    if (message.type === "ysw:native-command") {
      if (message.command === "stop") {
        activeSessions.clear();
        disconnectNative("The helper was stopped from the Galaktika toolbar.");
        return Promise.resolve({ ok: true, running: false });
      }
      const action = message.command === "diagnose" ? "diagnose" : "health";
      return requestNative(action, {}, 10000).then((response) => ({
        ...(response.body || {}),
        ok: response.ok,
        running: Boolean(nativePort),
        error: response.body?.error,
        nativeHost: NATIVE_HOST,
        extensionId: EXTENSION_ID
      }));
    }
    return false;
  }

  browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
    const response = handleMessage(message, sender);
    if (response === false || response === undefined) return false;
    Promise.resolve(response).then(
      sendResponse,
      (error) => sendResponse(nativeError(error?.message || String(error)))
    );
    return true;
  });

  browser.runtime.onConnect.addListener((clientPort) => {
    if (clientPort.name !== "ysw:native-request") return;
    clientRequestPorts.add(clientPort);
    let requestReceived = false;
    clientPort.onMessage.addListener((message) => {
      if (message?.type === "ysw:native-request-keepalive") return;
      if (requestReceived || message?.type !== "ysw:native-request") return;
      requestReceived = true;
      Promise.resolve(handleNativeUrl(message, clientPort.sender)).then(
        (response) => {
          try { clientPort.postMessage(response); } catch (_) { /* The page navigated or closed. */ }
        },
        (error) => {
          try { clientPort.postMessage(nativeError(error?.message || String(error))); } catch (_) { /* Port closed. */ }
        }
      );
    });
    clientPort.onDisconnect.addListener(() => {
      clientRequestPorts.delete(clientPort);
      maybeDisconnectNative();
    });
  });

  browser.tabs?.onRemoved?.addListener((tabId) => {
    capturedVideoUrls.delete(tabId);
    for (const key of activeSessions.keys()) {
      if (key.startsWith(`${tabId}:`)) activeSessions.delete(key);
    }
    if (activeSessions.size === 0) {
      disconnectNative("The Galaktika tab closed; active helper work was cancelled.");
    }
  });

  setInterval(() => {
    pruneSessions();
    maybeDisconnectNative();
  }, 10000);
})();
