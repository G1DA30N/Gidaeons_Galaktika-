(function () {
  "use strict";

  const STATE_MESSAGE = "ysw:cratedigrs-player-state";
  const SEEK_MESSAGE = "ysw:cratedigrs-seek";
  const players = new Set();
  const passivePlayers = new Map();
  let playerConstructor = null;

  function safeCall(player, method, fallback) {
    try {
      return typeof player?.[method] === "function" ? player[method]() : fallback;
    } catch (_) {
      return fallback;
    }
  }

  function publishPlayer(player, configuredVideoId) {
    const current = Number(safeCall(player, "getCurrentTime", NaN));
    const duration = Number(safeCall(player, "getDuration", NaN));
    const playerState = Number(safeCall(player, "getPlayerState", -1));
    const videoData = safeCall(player, "getVideoData", {}) || {};
    const videoId = String(videoData.video_id || configuredVideoId || "").trim();
    if (!/^[\w-]{11}$/.test(videoId) || !Number.isFinite(duration) || duration <= 0) return;

    window.postMessage({
      type: STATE_MESSAGE,
      state: {
        videoId,
        current: Number.isFinite(current) ? Math.max(0, current) : 0,
        duration,
        playing: playerState === 1 || playerState === 3,
        playerState,
        title: String(videoData.title || "")
      }
    }, "*");
  }

  function rememberPlayer(player, configuredVideoId) {
    const entry = { player, configuredVideoId: String(configuredVideoId || "") };
    players.add(entry);
    window.setTimeout(() => publishPlayer(player, entry.configuredVideoId), 0);
    return entry;
  }

  function publishPassivePlayer(source, info) {
    const previous = passivePlayers.get(source) || {};
    const videoData = info?.videoData || {};
    const next = {
      videoId: String(videoData.video_id || previous.videoId || "").trim(),
      title: String(videoData.title || previous.title || ""),
      current: Number.isFinite(Number(info?.currentTime)) ? Number(info.currentTime) : Number(previous.current || 0),
      duration: Number.isFinite(Number(info?.duration)) ? Number(info.duration) : Number(previous.duration || 0),
      playerState: Number.isFinite(Number(info?.playerState)) ? Number(info.playerState) : Number(previous.playerState ?? -1)
    };
    passivePlayers.set(source, next);
    if (!/^[\w-]{11}$/.test(next.videoId) || next.duration <= 0) return;
    window.postMessage({
      type: STATE_MESSAGE,
      state: {
        videoId: next.videoId,
        current: Math.max(0, next.current || 0),
        duration: next.duration,
        playing: next.playerState === 1 || next.playerState === 3,
        playerState: next.playerState,
        title: next.title
      }
    }, "*");
  }

  function youtubeIframes() {
    return document.querySelectorAll('iframe[src*="youtube.com/embed/"], iframe[src*="youtube-nocookie.com/embed/"]');
  }

  function requestIframeUpdates() {
    for (const iframe of youtubeIframes()) {
      try {
        iframe.contentWindow?.postMessage(JSON.stringify({
          event: "listening",
          id: iframe.id || "",
          channel: "galaktika"
        }), "*");
      } catch (_) {
        // An iframe can disappear while CrateDigrs loads the next record.
      }
    }
  }

  function wrapPlayerConstructor() {
    const YT = window.YT;
    const OriginalPlayer = YT?.Player;
    if (typeof OriginalPlayer !== "function" || OriginalPlayer === playerConstructor || OriginalPlayer.__galaktikaWrapped) return;

    function GalaktikaPlayer(element, options = {}) {
      const configuredVideoId = options.videoId || "";
      const originalEvents = options.events || {};
      const wrappedOptions = {
        ...options,
        events: {
          ...originalEvents,
          onReady(event) {
            rememberPlayer(event?.target, configuredVideoId);
            publishPlayer(event?.target, configuredVideoId);
            originalEvents.onReady?.(event);
          },
          onStateChange(event) {
            publishPlayer(event?.target, configuredVideoId);
            originalEvents.onStateChange?.(event);
          }
        }
      };
      const player = new OriginalPlayer(element, wrappedOptions);
      rememberPlayer(player, configuredVideoId);
      return player;
    }

    Object.setPrototypeOf(GalaktikaPlayer, OriginalPlayer);
    GalaktikaPlayer.prototype = OriginalPlayer.prototype;
    Object.defineProperty(GalaktikaPlayer, "__galaktikaWrapped", { value: true });
    YT.Player = GalaktikaPlayer;
    playerConstructor = GalaktikaPlayer;
  }

  let readyCallback = null;
  try {
    Object.defineProperty(window, "onYouTubeIframeAPIReady", {
      configurable: true,
      get() {
        return function (...args) {
          wrapPlayerConstructor();
          return readyCallback?.apply(this, args);
        };
      },
      set(callback) {
        readyCallback = typeof callback === "function" ? callback : null;
      }
    });
  } catch (_) {
    // The polling fallback below still captures players on browsers that lock this property.
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window) {
      if (!/^https:\/\/(?:www\.)?youtube(?:-nocookie)?\.com$/i.test(event.origin)) return;
      let message = event.data;
      try {
        if (typeof message === "string") message = JSON.parse(message);
      } catch (_) {
        return;
      }
      if ((message?.event === "infoDelivery" || message?.event === "initialDelivery") && message.info) {
        publishPassivePlayer(event.source, message.info);
      }
      return;
    }
    if (event.data?.type !== SEEK_MESSAGE) return;
    const time = Number(event.data.time);
    if (!Number.isFinite(time)) return;
    for (const entry of players) {
      try {
        const duration = Number(entry.player?.getDuration?.());
        if (!Number.isFinite(duration) || duration <= 0) continue;
        entry.player.seekTo(Math.max(0, Math.min(time, duration)), true);
        publishPlayer(entry.player, entry.configuredVideoId);
      } catch (_) {
        // CrateDigrs replaces its iframe while shuffling; stale players are harmless.
      }
    }
    for (const iframe of youtubeIframes()) {
      try {
        iframe.contentWindow?.postMessage(JSON.stringify({
          event: "command",
          func: "seekTo",
          args: [Math.max(0, time), true],
          id: iframe.id || ""
        }), "*");
      } catch (_) {
        // The iframe was replaced while handling the seek.
      }
    }
  });

  let iframePoll = 0;
  window.setInterval(() => {
    wrapPlayerConstructor();
    for (const entry of players) publishPlayer(entry.player, entry.configuredVideoId);
    iframePoll += 1;
    if (iframePoll % 5 === 0) requestIframeUpdates();
  }, 180);
  wrapPlayerConstructor();
  requestIframeUpdates();
})();
