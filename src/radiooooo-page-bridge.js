(function () {
  "use strict";

  const STATE_MESSAGE = "ysw:radiooooo-audio-state";
  const SEEK_MESSAGE = "ysw:radiooooo-seek";

  function getHowls() {
    const howler = window.Howler;
    if (!howler || !Array.isArray(howler._howls)) return [];
    return howler._howls.filter(Boolean);
  }

  function getActiveHowl() {
    const howls = getHowls();
    return howls.find((howl) => {
      try {
        return typeof howl.playing === "function" && howl.playing();
      } catch (_) {
        return false;
      }
    }) || howls.find((howl) => {
      try {
        return typeof howl.duration === "function" && howl.duration() > 0;
      } catch (_) {
        return false;
      }
    }) || null;
  }

  function getState() {
    const howl = getActiveHowl();
    if (!howl) return null;
    try {
      const current = typeof howl.seek === "function" ? Number(howl.seek()) : NaN;
      const duration = typeof howl.duration === "function" ? Number(howl.duration()) : NaN;
      const playing = typeof howl.playing === "function" ? Boolean(howl.playing()) : true;
      if (!Number.isFinite(current) || !Number.isFinite(duration) || duration <= 0) return null;
      return { current, duration, playing, source: "howler" };
    } catch (_) {
      return null;
    }
  }

  function publishState() {
    const state = getState();
    if (!state) return;
    window.postMessage({ type: STATE_MESSAGE, state }, "*");
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window || event.data?.type !== SEEK_MESSAGE) return;
    const time = Number(event.data.time);
    if (!Number.isFinite(time)) return;
    const howl = getActiveHowl();
    if (!howl || typeof howl.seek !== "function") return;
    try {
      howl.seek(Math.max(0, time));
      publishState();
    } catch (_) {
      // Radiooooo can swap players during transitions; the next tick will recover.
    }
  });

  window.setInterval(publishState, 180);
  publishState();
})();
