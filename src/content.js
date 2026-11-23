(function () {
  "use strict";

  // The supported digging sites own their embedded YouTube players. Galaktika's
  // top-page adapters track those players, so never mount a second UI inside them.
  if (/youtube(?:-nocookie)?\.com$/i.test(location.hostname) &&
      location.pathname.startsWith("/embed/") &&
      /^https:\/\/(?:www\.)?(?:cratedigrs\.com|sampleroulette\.io|samplette\.io)\//i.test(document.referrer || "")) {
    return;
  }

  const ROOT_ID = "yt-searchable-waveform-root";
  const SLOT_ID = "yt-searchable-waveform-slot";
  const MARCH_SESSION_KEY = "gidaeons-galaktika-march";
  const EXCLUDED_NOTICE_ID = "yt-searchable-waveform-excluded";
  const ENABLED_KEY = "galaktikaEnabled";
  const EXCLUDE_LONG_VIDEOS_KEY = "galaktikaExcludeLongVideos";
  const LONG_VIDEO_LIMIT_KEY = "galaktikaLongVideoLimit";
  const DEFAULT_EXCLUDE_LONG_VIDEOS = true;
  const DEFAULT_LONG_VIDEO_LIMIT = "1:00";
  const BINS_PER_SECOND = 10;
  const FFT_SIZE = 2048;
  const PREFETCH_ENDPOINTS = [
    "galaktika-native://helper/waveform"
  ];
  const WAV_DOWNLOAD_ENDPOINTS = [
    "galaktika-native://helper/download-wav"
  ];
  const MP3_DOWNLOAD_ENDPOINTS = [
    "galaktika-native://helper/download-mp3"
  ];
  const ORIGINAL_INFO_ENDPOINTS = [
    "galaktika-native://helper/original-info"
  ];
  const ORIGINAL_DOWNLOAD_ENDPOINTS = [
    "galaktika-native://helper/download-original"
  ];
  const MP4_DOWNLOAD_ENDPOINTS = [
    "galaktika-native://helper/download-mp4"
  ];
  const GAME_DOWNLOAD_ENDPOINTS = [
    "galaktika-native://helper/download-game"
  ];
  const AAC_DOWNLOAD_ENDPOINTS = [
    "galaktika-native://helper/download-aac"
  ];
  const DIRECT_WAVEFORM_ENDPOINTS = [
    "galaktika-native://helper/waveform-url"
  ];
  const DIRECT_DOWNLOAD_ENDPOINTS = [
    "galaktika-native://helper/download-url"
  ];
  const CHOOSE_DOWNLOAD_DIR_ENDPOINTS = [
    "galaktika-native://helper/choose-download-dir"
  ];
  const CHOOSE_DOWNLOAD_FILE_ENDPOINTS = [
    "galaktika-native://helper/choose-download-file"
  ];
  const SETTINGS_ENDPOINTS = [
    "galaktika-native://helper/settings"
  ];
  const VALIDATE_SETTINGS_ENDPOINTS = [
    "galaktika-native://helper/validate-settings"
  ];
  const SET_SETTINGS_ENDPOINTS = [
    "galaktika-native://helper/set-settings"
  ];
  const SESSION_OPEN_ENDPOINTS = [
    "galaktika-native://helper/session/open"
  ];
  const SESSION_CLOSE_ENDPOINTS = [
    "galaktika-native://helper/session/close"
  ];
  const PREFETCH_TIMEOUT_MS = 180000;
  const HELPER_PROBE_TIMEOUT_MS = 5000;
  const DIRECTORY_PICKER_TIMEOUT_MS = 300000;
  const SETTINGS_VALIDATION_TIMEOUT_MS = 150000;
  const HELPER_SESSION_HEARTBEAT_MS = 15000;
  const PREVIEW_WAVEFORM_BINS = 2400;
  const HIGH_RES_WAVEFORM_BINS = 16000;
  const MAX_WAVEFORM_BAR_HEIGHT = 108;
  const MIN_VISIBLE_PEAK = 0.025;
  const MAX_ZOOM = 256;
  const INIT_RETRY_MS = 1200;
  const nativeProgressHandlers = new Map();
  let nativeProgressSequence = 0;
  const RADIOOOOO_BOTTOM_SPACE = 190;
  const GALAXY_VERTEX_SHADER = `
    attribute vec2 aPosition;
    void main() {
      gl_Position = vec4(aPosition, 0.0, 1.0);
    }
  `;
  const GALAXY_FRAGMENT_SHADER = `
    precision mediump float;
    uniform vec2 iResolution;
    uniform float iTime;
    uniform vec4 uAudio;

    float field(in vec3 p, float s) {
      float strength = 7.0 + 0.03 * log(1.0e-6 + fract(sin(iTime) * 4373.11));
      float accum = s / 4.0;
      float prev = 0.0;
      float tw = 0.0;
      for (int i = 0; i < 26; ++i) {
        float mag = dot(p, p);
        p = abs(p) / mag + vec3(-0.5, -0.4, -1.5);
        float w = exp(-float(i) / 7.0);
        accum += w * exp(-strength * pow(abs(mag - prev), 2.2));
        tw += w;
        prev = mag;
      }
      return max(0.0, 5.0 * accum / tw - 0.7);
    }

    float field2(in vec3 p, float s) {
      float strength = 7.0 + 0.03 * log(1.0e-6 + fract(sin(iTime) * 4373.11));
      float accum = s / 4.0;
      float prev = 0.0;
      float tw = 0.0;
      for (int i = 0; i < 18; ++i) {
        float mag = dot(p, p);
        p = abs(p) / mag + vec3(-0.5, -0.4, -1.5);
        float w = exp(-float(i) / 7.0);
        accum += w * exp(-strength * pow(abs(mag - prev), 2.2));
        tw += w;
        prev = mag;
      }
      return max(0.0, 5.0 * accum / tw - 0.7);
    }

    vec3 nrand3(vec2 co) {
      vec3 a = fract(cos(co.x * 8.3e-3 + co.y) * vec3(1.3e5, 4.7e5, 2.9e5));
      vec3 b = fract(sin(co.x * 0.3e-3 + co.y) * vec3(8.1e5, 1.0e5, 0.1e5));
      return mix(a, b, 0.5);
    }

    void main() {
      vec2 uv = 2.0 * gl_FragCoord.xy / iResolution.xy - 1.0;
      vec2 uvs = uv * iResolution.xy / max(iResolution.x, iResolution.y);
      vec4 freqs = max(uAudio, vec4(0.18, 0.22, 0.28, 0.32));

      vec3 p = vec3(uvs / 4.0, 0.0) + vec3(1.0, -1.3, 0.0);
      p += 0.2 * vec3(sin(iTime / 16.0), sin(iTime / 12.0), sin(iTime / 128.0));
      float t = field(p, freqs.z);
      float v = (1.0 - exp((abs(uv.x) - 1.0) * 6.0)) * (1.0 - exp((abs(uv.y) - 1.0) * 6.0));

      vec3 p2 = vec3(uvs / (4.0 + sin(iTime * 0.11) * 0.2 + 0.2 + sin(iTime * 0.15) * 0.3 + 0.4), 1.5) + vec3(2.0, -1.3, -1.0);
      p2 += 0.25 * vec3(sin(iTime / 16.0), sin(iTime / 12.0), sin(iTime / 128.0));
      float t2 = field2(p2, freqs.w);
      vec4 c2 = mix(0.4, 1.0, v) * vec4(1.3 * t2 * t2 * t2, 1.8 * t2 * t2, t2 * freqs.x, t2);

      vec2 seed = floor(p.xy * 2.0 * iResolution.x);
      vec3 rnd = nrand3(seed);
      vec4 starcolor = vec4(pow(rnd.y, 40.0));

      vec2 seed2 = floor(p2.xy * 2.0 * iResolution.x);
      vec3 rnd2 = nrand3(seed2);
      starcolor += vec4(pow(rnd2.y, 40.0));

      vec4 galaxy = mix(freqs.w - 0.3, 1.0, v) * vec4(1.5 * freqs.z * t * t * t, 1.2 * freqs.y * t * t, freqs.w * t, 1.0) + c2 + starcolor;
      gl_FragColor = vec4(galaxy.rgb * 0.85, 1.0);
    }
  `;

  let app = null;
  let lastUrl = location.href;
  let initTimer = 0;
  let extensionEnabled = true;
  let excludedPageUrl = "";
  let longVideoExcludedKey = "";
  let longVideoOverrideKey = "";
  let crateDigrsPlayerState = null;
  let crateDigrsPlayerStateAt = 0;

  function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  async function readEnabledSetting() {
    try {
      const settings = await browser.storage.local.get({ [ENABLED_KEY]: true });
      extensionEnabled = settings[ENABLED_KEY] !== false;
    } catch (_) {
      extensionEnabled = true;
    }
    return extensionEnabled;
  }

  function parseHourMinuteLimit(value) {
    const match = String(value || "").trim().match(/^(\d{1,3}):([0-5]\d)$/);
    if (!match) return NaN;
    const seconds = (Number(match[1]) * 60 + Number(match[2])) * 60;
    return seconds > 0 ? seconds : NaN;
  }

  function normalizedHourMinuteLimit(value) {
    const match = String(value || "").trim().match(/^(\d{1,3}):([0-5]\d)$/);
    if (!match || !Number.isFinite(parseHourMinuteLimit(value))) {
      throw new Error("Use H:MM for the long-video limit, for example 1:00.");
    }
    return `${Number(match[1])}:${match[2]}`;
  }

  async function readVideoExclusionSettings() {
    const defaults = {
      [EXCLUDE_LONG_VIDEOS_KEY]: DEFAULT_EXCLUDE_LONG_VIDEOS,
      [LONG_VIDEO_LIMIT_KEY]: DEFAULT_LONG_VIDEO_LIMIT
    };
    try {
      const stored = await browser.storage.local.get(defaults);
      const limit = Number.isFinite(parseHourMinuteLimit(stored[LONG_VIDEO_LIMIT_KEY]))
        ? normalizedHourMinuteLimit(stored[LONG_VIDEO_LIMIT_KEY])
        : DEFAULT_LONG_VIDEO_LIMIT;
      return {
        enabled: stored[EXCLUDE_LONG_VIDEOS_KEY] !== false,
        limit,
        seconds: parseHourMinuteLimit(limit)
      };
    } catch (_) {
      return {
        enabled: DEFAULT_EXCLUDE_LONG_VIDEOS,
        limit: DEFAULT_LONG_VIDEO_LIMIT,
        seconds: parseHourMinuteLimit(DEFAULT_LONG_VIDEO_LIMIT)
      };
    }
  }

  function parseMediaClock(value) {
    const parts = String(value || "").trim().split(":");
    if (parts.length < 2 || parts.length > 3 || parts.some((part) => !/^\d{1,2}$/.test(part))) return NaN;
    const numbers = parts.map(Number);
    if (numbers.slice(1).some((part) => part > 59)) return NaN;
    return numbers.reduce((total, part) => total * 60 + part, 0);
  }

  async function resolveVideoDuration(video) {
    for (let attempt = 0; attempt < 24; attempt += 1) {
      const displayed = parseMediaClock(document.querySelector(".ytp-time-duration")?.textContent);
      if (Number.isFinite(displayed) && displayed > 0) return displayed;
      const duration = Number(video?.duration);
      if (Number.isFinite(duration) && duration > 0) return duration;
      await wait(125);
    }
    return 0;
  }

  function formatTime(seconds) {
    if (!Number.isFinite(seconds)) return "0:00";
    const total = Math.max(0, Math.floor(seconds));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = String(total % 60).padStart(2, "0");
    return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
  }

  function sanitizeDownloadName(value, fallback = "Galaktika download") {
    const cleaned = String(value || "")
      .replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")
      .replace(/\s+/g, " ")
      .replace(/\s+-\s+YouTube$/i, "")
      .trim()
      .replace(/[. ]+$/g, "");
    return cleaned || fallback;
  }

  function abbreviateVideoTitle(value) {
    const parts = String(value || "").match(/[\p{L}\p{Nd}]+/gu) || [];
    const abbreviated = parts.map((word) => /^\p{Nd}+$/u.test(word)
      ? word
      : [...word][0].toLocaleUpperCase()).join("");
    return abbreviated || "YT";
  }

  function getPlayerHost() {
    const video = getVideo();
    return video?.closest("#player") ||
      video?.closest("ytd-player") ||
      document.querySelector("#player") ||
      document.querySelector("#movie_player") ||
      document.querySelector("ytd-player");
  }

  function getPlayerBlock() {
    const video = getVideo();
    const playerFromVideo = video?.closest("#player") ||
      video?.closest("#player-container-inner") ||
      video?.closest("#player-container-outer") ||
      video?.closest("ytd-player");

    return document.querySelector("ytd-watch-flexy #primary-inner #player") ||
      document.querySelector("ytd-watch-flexy #above-the-fold #player") ||
      document.querySelector("ytd-watch-flexy #player-container-outer") ||
      document.querySelector("ytd-watch-flexy #player-container-inner") ||
      document.querySelector("ytd-watch-flexy #player-full-bleed-container") ||
      document.querySelector("ytd-watch-flexy #player") ||
      playerFromVideo ||
      document.querySelector("#player") ||
      document.querySelector("ytd-player") ||
      getPlayerHost();
  }

  function getVideo() {
    return document.querySelector("video.html5-main-video") ||
      document.querySelector("#movie_player video") ||
      document.querySelector(".html5-video-container video") ||
      document.querySelector("ytd-player video") ||
      document.querySelector("video");
  }

  function isEmbedPage() {
    return location.pathname.startsWith("/embed/");
  }

  function isRadioooooPage() {
    return location.hostname === "app.radiooooo.com";
  }

  function isCrateDigrsPage() {
    return /^(?:www\.)?cratedigrs\.com$/i.test(location.hostname);
  }

  function isSampleRoulettePage() {
    return /^(?:www\.)?sampleroulette\.io$/i.test(location.hostname) && location.pathname.startsWith("/dig");
  }

  function isSamplettePage() {
    return /^(?:www\.)?samplette\.io$/i.test(location.hostname);
  }

  function isExternalYoutubePage() {
    return isCrateDigrsPage() || isSampleRoulettePage() || isSamplettePage();
  }

  function isExternalPlayerPage() {
    return isRadioooooPage() || isExternalYoutubePage();
  }

  function isYoutubePlaylistPage() {
    if (!/(?:^|\.)youtube(?:-nocookie)?\.com$/i.test(location.hostname)) return false;
    const url = new URL(location.href);
    return Boolean(url.searchParams.get("list")) && (location.pathname.startsWith("/watch") || isEmbedPage());
  }

  function isMarchSupportedPage() {
    return isExternalYoutubePage() || isYoutubePlaylistPage();
  }

  function injectRadioooooBridge() {
    if (!isRadioooooPage() || document.getElementById("ysw-radiooooo-page-bridge")) return;
    const script = document.createElement("script");
    script.id = "ysw-radiooooo-page-bridge";
    script.src = browser.runtime.getURL("src/radiooooo-page-bridge.js");
    script.onload = () => script.remove();
    (document.documentElement || document.head || document.body).appendChild(script);
  }

  function injectCrateDigrsBridge() {
    if (!isCrateDigrsPage() || document.getElementById("ysw-cratedigrs-page-bridge")) return;
    const script = document.createElement("script");
    script.id = "ysw-cratedigrs-page-bridge";
    script.src = browser.runtime.getURL("src/cratedigrs-page-bridge.js");
    script.async = false;
    script.onload = () => script.remove();
    (document.documentElement || document.head || document.body).appendChild(script);
  }

  function injectSampleRouletteBridge() {
    if (!isSampleRoulettePage() || document.getElementById("ysw-sampleroulette-page-bridge")) return;
    const script = document.createElement("script");
    script.id = "ysw-sampleroulette-page-bridge";
    script.src = browser.runtime.getURL("src/sampleroulette-page-bridge.js");
    script.async = false;
    script.onload = () => script.remove();
    (document.documentElement || document.head || document.body).appendChild(script);
  }

  function isSupportedPage() {
    return location.pathname.startsWith("/watch") || isEmbedPage() || isExternalPlayerPage();
  }

  function getNativeInsertionAnchor() {
    return document.querySelector("ytd-watch-flexy #player-container-outer") ||
      document.querySelector("ytd-watch-flexy #player-container-inner") ||
      document.querySelector("ytd-watch-flexy #player-full-bleed-container") ||
      document.querySelector("ytd-watch-flexy #primary-inner > #player") ||
      document.querySelector("ytd-watch-flexy #above-the-fold #player") ||
      document.querySelector("ytd-watch-flexy #player") ||
      getPlayerBlock() ||
      getPlayerHost();
  }

  function getNativeTitleAnchor() {
    return document.querySelector("ytd-watch-flexy #below ytd-watch-metadata") ||
      document.querySelector("ytd-watch-flexy ytd-watch-metadata") ||
      document.querySelector("ytd-watch-flexy #below ytd-video-primary-info-renderer") ||
      document.querySelector("ytd-watch-flexy ytd-video-primary-info-renderer") ||
      document.querySelector("ytd-watch-flexy #primary-inner > #below") ||
      document.querySelector("ytd-watch-flexy #below") ||
      document.querySelector("#primary-inner > #below") ||
      document.querySelector("#below");
  }

  function getNativeFallbackParent() {
    return document.querySelector("ytd-watch-flexy #primary-inner") ||
      document.querySelector("ytd-watch-flexy #primary") ||
      document.querySelector("#primary-inner") ||
      document.querySelector("#primary") ||
      document.body;
  }

  function getNativeBelowAnchor() {
    return document.querySelector("ytd-watch-flexy #primary-inner > #below") ||
      document.querySelector("ytd-watch-flexy #primary > #primary-inner > #below") ||
      document.querySelector("#primary-inner > #below") ||
      document.querySelector("ytd-watch-flexy #below") ||
      document.querySelector("#below");
  }

  function getNativeSlot() {
    let slot = document.getElementById(SLOT_ID);
    if (!slot) {
      slot = document.createElement("div");
      slot.id = SLOT_ID;
    }

    // Keep Galaktika outside YouTube's metadata component. YouTube frequently
    // replaces that component during SPA navigation and responsive layout changes.
    const belowAnchor = getNativeBelowAnchor();
    if (belowAnchor?.parentElement) {
      if (slot.parentElement !== belowAnchor.parentElement || slot.nextElementSibling !== belowAnchor) {
        belowAnchor.parentElement.insertBefore(slot, belowAnchor);
      }
      slot.dataset.yswPlacement = "before-below";
      return slot;
    }

    const anchor = getNativeInsertionAnchor();
    if (anchor?.parentElement) {
      if (slot.previousElementSibling !== anchor || slot.parentElement !== anchor.parentElement) {
        anchor.insertAdjacentElement("afterend", slot);
      }
      slot.dataset.yswPlacement = "after-player";
      return slot;
    }

    const primary = getNativeFallbackParent();
    if (slot.parentElement !== primary) {
      primary.insertBefore(slot, primary.firstChild);
    }
    slot.dataset.yswPlacement = "primary-fallback";
    return slot;
  }

  function placeNativeRoot(root) {
    const slot = getNativeSlot();
    if (root.parentElement !== slot) {
      slot.replaceChildren(root);
    }
    return true;
  }

  function getExternalPageAnchor() {
    if (isCrateDigrsPage()) {
      return document.querySelector("#crate-roulette-player-target")?.closest('[class*="grid-cols-12"]') ||
        document.querySelector("#crate-roulette-player-container")?.closest('[class*="grid-cols-12"]');
    }
    if (isSampleRoulettePage()) {
      return document.querySelector("#video-player")?.closest(".main-section") ||
        document.querySelector("#video-player")?.closest(".container");
    }
    if (isSamplettePage()) {
      return document.querySelector("#main-row") ||
        document.querySelector("#youtube-player-container")?.closest("#embed-col");
    }
    return null;
  }

  function placeExternalPageRoot(root) {
    const anchor = getExternalPageAnchor();
    if (!anchor?.parentElement) return false;
    let slot = document.getElementById(SLOT_ID);
    if (!slot) {
      slot = document.createElement("div");
      slot.id = SLOT_ID;
    }
    if (slot.previousElementSibling !== anchor || slot.parentElement !== anchor.parentElement) {
      anchor.insertAdjacentElement("afterend", slot);
    }
    slot.dataset.yswPlacement = isCrateDigrsPage()
      ? "cratedigrs"
      : isSampleRoulettePage()
        ? "sampleroulette"
        : "samplette";
    const anchorWidth = Math.round(anchor.getBoundingClientRect().width);
    if (anchorWidth > 0) slot.style.setProperty("--ysw-external-width", `${anchorWidth}px`);
    if (root.parentElement !== slot) slot.replaceChildren(root);
    return true;
  }

  function removeLongVideoNotice() {
    document.getElementById(EXCLUDED_NOTICE_ID)?.remove();
  }

  function showLongVideoNotice(videoKey, duration, limit) {
    const slot = getNativeSlot();
    let notice = document.getElementById(EXCLUDED_NOTICE_ID);
    if (!notice) {
      notice = document.createElement("section");
      notice.id = EXCLUDED_NOTICE_ID;
      notice.setAttribute("role", "status");

      const message = document.createElement("span");
      message.className = "ysw-excluded-message";
      notice.appendChild(message);

      const enableButton = document.createElement("button");
      enableButton.type = "button";
      enableButton.className = "ysw-excluded-enable";
      enableButton.textContent = "Enable for this video";
      enableButton.addEventListener("click", () => {
        longVideoOverrideKey = notice.dataset.videoKey || currentVideoKey();
        excludedPageUrl = "";
        removeLongVideoNotice();
        scheduleInit(0);
      });
      notice.appendChild(enableButton);
    }

    const message = notice.querySelector(".ysw-excluded-message");
    if (message) {
      message.textContent = `Galaktika is paused for this ${formatTime(duration)} video (limit ${limit}).`;
    }
    notice.dataset.videoKey = videoKey;
    if (notice.parentElement !== slot) slot.replaceChildren(notice);
  }

  function getWaveformHeight() {
    return isEmbedPage() || isExternalPlayerPage() ? 86 : 118;
  }

  function isDirectMediaUrl(value) {
    return /^https?:\/\/[^?#]+\.(aac|flac|m4a|mp3|mp4|ogg|opus|wav|webm)([?#].*)?$/i.test(String(value || ""));
  }

  function getLatestRadioooooMediaUrl() {
    if (!isRadioooooPage() || !performance?.getEntriesByType) return "";
    const entries = performance.getEntriesByType("resource")
      .map((entry) => entry.name || "")
      .filter((name) => /radiooooo-track\.b-cdn\.net\/.*\.mp3/i.test(name));
    return entries[entries.length - 1] || "";
  }

  async function waitForRadioooooMediaUrl() {
    for (let i = 0; i < 80; i += 1) {
      const mediaUrl = getLatestRadioooooMediaUrl();
      if (mediaUrl) return mediaUrl;
      await wait(250);
    }
    return getLatestRadioooooMediaUrl();
  }

  function getRadioooooTitle() {
    return getRadioooooMetadata().title;
  }

  function parseClock(value) {
    const match = String(value || "").match(/^(\d{1,2}):(\d{2})$/);
    if (!match) return NaN;
    return Number(match[1]) * 60 + Number(match[2]);
  }

  function getRadioooooClocks() {
    const text = document.body?.innerText || "";
    const matches = [...text.matchAll(/\b(\d{1,2}:\d{2})\b/g)].map((match) => match[1]);
    if (matches.length < 2) return null;
    const current = parseClock(matches[0]);
    const duration = parseClock(matches[matches.length - 1]);
    if (!Number.isFinite(current) || !Number.isFinite(duration) || duration <= 0) return null;
    return { current: clamp(current, 0, duration), duration };
  }

  function getRadioooooMetadata() {
    const lines = (document.body?.innerText || document.title || "")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    const clockIndex = lines.findIndex((line) => /^\d{1,2}:\d{2}$/.test(line));
    const title = lines.slice(Math.max(0, clockIndex + 1), clockIndex + 8)
      .find((line) => !/^\d{1,2}:\d{2}$/.test(line) && !/^DISCOVERED BY$/i.test(line) && line.length > 1 && line.length < 90) ||
      document.title.split("|")[0].trim() ||
      "Radiooooo track";
    const detail = lines[lines.indexOf(title) + 1] || "";
    const artist = detail.split(/[–—-]/)[0]?.trim() || "";
    const album = detail.replace(artist, "").replace(/^[\s–—-]+/, "").trim();
    const countryYear = lines.find((line) => /^[A-Z][A-Z\s]+ \d{4}$/.test(line)) || "";
    const year = countryYear.match(/\b(\d{4})\b/)?.[1] || "";
    const country = countryYear.replace(/\d{4}/, "").trim();
    return { title, artist, album, year, country };
  }

  function getVisibleTextNodes(pattern) {
    const nodes = [];
    if (!document.body) return nodes;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const node = walker.currentNode;
      const text = node.nodeValue.trim();
      if (!pattern.test(text)) continue;
      const parent = node.parentElement;
      if (!parent) continue;
      const style = window.getComputedStyle(parent);
      if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) continue;
      const rect = parent.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) continue;
      nodes.push({ text, rect, parent });
    }
    return nodes;
  }

  function getRadioooooClockPair() {
    const clocks = getVisibleTextNodes(/^\d{1,2}:\d{2}$/)
      .map((item) => ({ ...item, seconds: parseClock(item.text) }))
      .filter((item) => Number.isFinite(item.seconds));
    let best = null;
    let bestScore = -Infinity;
    for (const left of clocks) {
      for (const right of clocks) {
        if (right === left || right.rect.left <= left.rect.left || right.seconds <= left.seconds) continue;
        const leftY = (left.rect.top + left.rect.bottom) / 2;
        const rightY = (right.rect.top + right.rect.bottom) / 2;
        const yGap = Math.abs(leftY - rightY);
        if (yGap > 24) continue;
        const span = right.rect.left - left.rect.right;
        const score = span - yGap * 18;
        if (score > bestScore) {
          bestScore = score;
          best = { current: left.seconds, duration: right.seconds, currentRect: left.rect, durationRect: right.rect };
        }
      }
    }
    return best;
  }

  function getRadioooooClocks() {
    const pair = getRadioooooClockPair();
    if (!pair || pair.duration <= 0) return null;
    return { current: clamp(pair.current, 0, pair.duration), duration: pair.duration };
  }

  function getRadioooooProgressElements() {
    if (!isRadioooooPage()) return null;
    const indicator = document.querySelector(".audio-player .progress .indicator, .progress .indicator");
    const progress = indicator?.closest(".progress");
    if (!indicator || !progress) return null;
    const progressRect = progress.getBoundingClientRect();
    const indicatorRect = indicator.getBoundingClientRect();
    if (progressRect.width <= 0 || progressRect.height <= 0) return null;
    return { progress, indicator, progressRect, indicatorRect };
  }

  function getRadioooooIndicatorState() {
    const elements = getRadioooooProgressElements();
    if (!elements) return null;
    const clocks = getRadioooooClocks();
    const duration = clocks?.duration || 0;
    if (!duration) return null;

    const styleWidth = window.getComputedStyle(elements.indicator).width;
    const inlineWidth = elements.indicator.style.width || "";
    const percentMatch = inlineWidth.match(/([\d.]+)%/);
    let ratio = percentMatch
      ? Number(percentMatch[1]) / 100
      : parseFloat(styleWidth) / Math.max(1, elements.progressRect.width);
    if (!Number.isFinite(ratio)) {
      ratio = elements.indicatorRect.width / Math.max(1, elements.progressRect.width);
    }
    ratio = clamp(ratio, 0, 1);

    return {
      current: clamp(ratio * duration, 0, duration),
      duration,
      playing: true,
      source: "progress-indicator"
    };
  }

  function getRadioooooProgressRect() {
    const elements = getRadioooooProgressElements();
    const pair = getRadioooooClockPair();
    if (elements) {
      return {
        rect: elements.progressRect,
        element: elements.progress,
        indicator: elements.indicator,
        pair
      };
    }
    if (!pair) return null;
    const visualLeft = Math.min(pair.currentRect.left, pair.currentRect.right) - 14;
    const visualRight = Math.max(pair.durationRect.left, pair.durationRect.right) + 14;
    const minY = pair.currentRect.top - 18;
    const maxY = pair.currentRect.bottom + 28;
    const candidates = [...document.querySelectorAll("div, span, button")]
      .map((element) => ({ element, rect: element.getBoundingClientRect() }))
      .filter(({ rect }) => {
        const y = (rect.top + rect.bottom) / 2;
        return rect.width > 80 &&
          rect.height >= 2 &&
          rect.height <= 26 &&
          rect.left >= visualLeft - 160 &&
          rect.right <= visualRight + 160 &&
          y >= minY &&
          y <= maxY;
      })
      .sort((a, b) => {
        const aContains = a.rect.left <= pair.currentRect.left && a.rect.right >= pair.durationRect.right ? 1 : 0;
        const bContains = b.rect.left <= pair.currentRect.left && b.rect.right >= pair.durationRect.right ? 1 : 0;
        return (bContains - aContains) || (b.rect.width - a.rect.width);
      });

    const best = candidates[0];
    if (best) return { rect: best.rect, element: best.element, pair };
    return {
      rect: {
        left: visualLeft,
        right: visualRight,
        top: pair.currentRect.top,
        bottom: pair.currentRect.bottom,
        width: Math.max(1, visualRight - visualLeft),
        height: Math.max(1, pair.currentRect.height)
      },
      element: pair.currentRect.parent,
      pair
    };
  }

  function getRadioooooMetadata() {
    const titleText = document.title.split("|")[0].trim();
    const titleParts = titleText.split(/\s+(?:-|\u2013|\u2014)\s+/).map((part) => part.trim()).filter(Boolean);
    if (titleParts.length >= 2 && !/^(slow|fast|weird)$/i.test(titleParts[0])) {
      const countryYear = document.title.match(/\|\s*([^|]+?)\s*(\d{4})\b/);
      return {
        title: titleParts[0],
        artist: titleParts[1],
        album: "",
        year: countryYear?.[2] || "",
        country: countryYear?.[1]?.trim() || ""
      };
    }

    const lines = (document.body?.innerText || document.title || "")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    const clockIndex = lines.findIndex((line) => /^\d{1,2}:\d{2}$/.test(line));
    const titleSearchStart = clockIndex >= 0 ? clockIndex + 1 : 0;
    const title = lines.slice(titleSearchStart, titleSearchStart + 10)
      .find((line) => !/^\d{1,2}:\d{2}$/.test(line) && !/^(SLOW|FAST|WEIRD|EXPLORE|DISCOVERED BY)$/i.test(line) && line.length > 1 && line.length < 90) ||
      titleParts[0] ||
      "Radiooooo track";
    const detail = lines[lines.indexOf(title) + 1] || "";
    const detailParts = detail.split(/\s+(?:-|\u2013|\u2014)\s+/).map((part) => part.trim()).filter(Boolean);
    const artist = detailParts[0] || titleParts[1] || "";
    const album = detailParts.slice(1).join(" - ");
    const countryYear = lines.find((line) => /^[A-Z][A-Z\s]+ \d{4}$/.test(line)) || "";
    const year = countryYear.match(/\b(\d{4})\b/)?.[1] || "";
    const country = countryYear.replace(/\d{4}/, "").trim();
    return { title, artist, album, year, country };
  }

  function getRadioooooMetadataParam() {
    const meta = getRadioooooMetadata();
    return [meta.title, meta.artist, meta.album, meta.year, meta.country].join("||");
  }

  function getRadioooooDownloadFilename() {
    const meta = getRadioooooMetadata();
    const name = [meta.artist, meta.title].filter(Boolean).join(" - ") || meta.title || "Radiooooo track";
    const extension = mediaExtensionFromUrl(getLatestRadioooooMediaUrl()) || ".mp3";
    return `${sanitizeDownloadName(name, "Radiooooo track")}${extension}`;
  }

  function mediaExtensionFromUrl(mediaUrl) {
    try {
      const suffix = new URL(mediaUrl).pathname.match(/\.[a-z0-9]{2,5}$/i)?.[0] || "";
      return suffix || ".mp3";
    } catch (_) {
      return ".mp3";
    }
  }

  function getVideoWatchUrl() {
    if (isRadioooooPage()) {
      return getLatestRadioooooMediaUrl();
    }
    if (isSamplettePage()) {
      const href = document.querySelector('#watch-on-youtube[href*="youtube.com/watch"], #youtube-player-header a[href*="youtube.com/watch"], a[href*="youtube.com/watch?v="]')?.href || "";
      if (isResolvedWatchUrl(href)) return href;
      return "";
    }
    if (isExternalYoutubePage()) {
      const stateVideoId = String(crateDigrsPlayerState?.videoId || "");
      if (/^[\w-]{11}$/.test(stateVideoId)) {
        return `https://www.youtube.com/watch?v=${encodeURIComponent(stateVideoId)}`;
      }
      const iframeSrc = document.querySelector('iframe[src*="youtube.com/embed/"], iframe[src*="youtube-nocookie.com/embed/"]')?.src || "";
      const iframeVideoId = iframeSrc.match(/\/embed\/([\w-]{11})(?:[/?#]|$)/)?.[1] || "";
      if (iframeVideoId) return `https://www.youtube.com/watch?v=${encodeURIComponent(iframeVideoId)}`;
      return "";
    }
    const url = new URL(location.href);
    let videoId = url.searchParams.get("v");
    if (!videoId && isEmbedPage()) {
      videoId = location.pathname.split("/embed/")[1]?.split(/[/?#]/)[0] || "";
    }
    if (!videoId) {
      videoId = getActivePlayerVideoId();
    }
    if (videoId) {
      return `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`;
    }
    return url.toString();
  }

  function getActivePlayerVideoId() {
    const initialVideoId = window.ytInitialPlayerResponse?.videoDetails?.videoId || "";
    if (initialVideoId) return initialVideoId;

    try {
      const playerVideoId = document.querySelector("#movie_player")?.getVideoData?.()?.video_id || "";
      if (playerVideoId) return playerVideoId;
    } catch (_) {
      // The player API can be unavailable during early iframe startup.
    }

    return document.querySelector('meta[itemprop="videoId"]')?.content || "";
  }

  async function waitForVideoWatchUrl() {
    if (isExternalYoutubePage()) {
      for (let i = 0; i < 120; i += 1) {
        const videoUrl = getVideoWatchUrl();
        if (isResolvedWatchUrl(videoUrl)) return videoUrl;
        await wait(250);
      }
      return getVideoWatchUrl();
    }
    if (!isEmbedPage()) {
      return getVideoWatchUrl();
    }

    for (let i = 0; i < 40; i += 1) {
      const videoUrl = getVideoWatchUrl();
      if (/^https:\/\/www\.youtube\.com\/watch\?v=/.test(videoUrl)) {
        return videoUrl;
      }
      const capturedUrl = await getCapturedVideoUrl();
      if (capturedUrl) {
        return capturedUrl;
      }
      await wait(250);
    }
    return await getCapturedVideoUrl() || getVideoWatchUrl();
  }

  function isResolvedWatchUrl(value) {
    return /^https:\/\/www\.youtube\.com\/watch\?v=[^&]+/.test(String(value || ""));
  }

  async function getCapturedVideoUrl() {
    try {
      const response = await sendRuntimeMessage({ type: "ysw:get-captured-video-url" });
      return response?.url || "";
    } catch (_) {
      return "";
    }
  }

  async function waitForVideo() {
    if (isExternalPlayerPage()) {
      if (app?.video) return { host: document.body || document.documentElement, video: app.video };
      const host = document.body || document.documentElement;
      const virtualMedia = new EventTarget();
      virtualMedia.duration = 0;
      virtualMedia.currentTime = 0;
      virtualMedia.paused = true;
      virtualMedia.play = () => Promise.resolve();
      return { host, video: virtualMedia };
    }

    for (let i = 0; i < 80; i += 1) {
      const host = getPlayerHost();
      const video = getVideo();
      const playerBlock = getPlayerBlock();
      if (video) return { host: host || playerBlock || video.parentElement, video };
      await wait(250);
    }
    return null;
  }

  function sendRuntimeMessage(message) {
    return browser.runtime.sendMessage(message);
  }

  function sendNativePortRequest(message) {
    return new Promise((resolve, reject) => {
      let settled = false;
      let port;
      let keepAliveTimer = 0;
      try {
        port = browser.runtime.connect({ name: "ysw:native-request" });
      } catch (error) {
        reject(error);
        return;
      }

      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        clearInterval(keepAliveTimer);
        callback(value);
        try { port.disconnect(); } catch (_) { /* Already disconnected. */ }
      };
      port.onMessage.addListener((response) => finish(resolve, response));
      port.onDisconnect.addListener(() => {
        if (settled) return;
        const detail = browser.runtime.lastError?.message || "The Galaktika extension request port closed before the helper responded.";
        finish(reject, new Error(detail));
      });
      try {
        port.postMessage(message);
        // Thorium may suspend an MV3 worker while a native file picker is open.
        // Traffic on this port keeps the worker and its native-host connection alive.
        keepAliveTimer = setInterval(() => {
          if (settled) return;
          try {
            port.postMessage({ type: "ysw:native-request-keepalive" });
          } catch (error) {
            finish(reject, error);
          }
        }, 15000);
      } catch (error) {
        finish(reject, error);
      }
    });
  }

  function currentVideoKey() {
    if (!isSupportedPage() || isRadioooooPage()) return "";
    const videoUrl = getVideoWatchUrl();
    return isResolvedWatchUrl(videoUrl) ? videoUrl : location.href;
  }

  function currentPageToggleState() {
    const videoKey = currentVideoKey();
    const longVideo = Boolean(videoKey && longVideoExcludedKey === videoKey);
    const override = Boolean(videoKey && longVideoOverrideKey === videoKey);
    return {
      ok: true,
      supported: isSupportedPage(),
      videoKey,
      longVideo,
      override,
      excluded: longVideo && !override
    };
  }

  browser.runtime.onMessage.addListener((message) => {
    if (message?.type === "ysw:native-progress") {
      const handler = nativeProgressHandlers.get(String(message.progressId || ""));
      if (handler) handler(message.body, message.event);
      return false;
    }
    if (message?.type === "ysw:get-page-toggle-state") {
      return Promise.resolve(currentPageToggleState());
    }
    if (message?.type === "ysw:set-long-video-override") {
      const videoKey = currentVideoKey();
      longVideoOverrideKey = message.enabled && videoKey ? videoKey : "";
      excludedPageUrl = "";
      app?.destroy();
      app = null;
      scheduleInit(0);
      return Promise.resolve({ ...currentPageToggleState(), override: Boolean(longVideoOverrideKey) });
    }
    return false;
  });

  async function fetchHelperJson(url, timeoutMs, onProgress = null) {
    const progressId = typeof onProgress === "function"
      ? `${Date.now()}-${++nativeProgressSequence}`
      : "";
    if (progressId) nativeProgressHandlers.set(progressId, onProgress);
    try {
      return await sendNativePortRequest({
        type: "ysw:native-request",
        url,
        timeoutMs,
        progressId
      });
    } catch (error) {
      return {
        ok: false,
        status: 0,
        statusText: error?.name || "NativeMessagingError",
        transport: "native-messaging",
        body: { error: error?.message || String(error) }
      };
    } finally {
      if (progressId) nativeProgressHandlers.delete(progressId);
    }
  }

  function createUi() {
    const svgNs = "http://www.w3.org/2000/svg";
    const add = (parent, tagName, className, attrs = {}) => {
      const element = document.createElement(tagName);
      if (className) element.className = className;
      Object.entries(attrs).forEach(([name, value]) => {
        element.setAttribute(name, value);
      });
      parent.appendChild(element);
      return element;
    };
    const addButton = (parent, className, title, ariaLabel) => add(parent, "button", className, {
      type: "button",
      title,
      "aria-label": ariaLabel
    });
    const addSvg = (parent, paths) => {
      const svg = document.createElementNS(svgNs, "svg");
      svg.setAttribute("viewBox", "0 0 24 24");
      svg.setAttribute("aria-hidden", "true");
      svg.setAttribute("focusable", "false");
      paths.forEach((pathData) => {
        const path = document.createElementNS(svgNs, "path");
        path.setAttribute("d", pathData);
        svg.appendChild(path);
      });
      parent.appendChild(svg);
      return svg;
    };

    const root = document.createElement("section");
    root.id = ROOT_ID;

    add(root, "canvas", "ysw-galaxy-bg", { "aria-hidden": "true" });
    const loadingBar = add(root, "div", "ysw-loading-bar", { "aria-hidden": "true" });
    add(loadingBar, "span", "ysw-loading-trail");
    add(loadingBar, "span", "ysw-loading-star");

    const toolbar = add(root, "div", "ysw-toolbar");
    const brand = addButton(toolbar, "ysw-brand ysw-collapse-toggle", "Collapse or restore Galaktika", "Collapse or restore Galaktika");
    add(brand, "img", "ysw-logo", {
      src: browser.runtime.getURL("assets/galaktika-96.png"),
      alt: "",
      "aria-hidden": "true"
    });
    const titleWrap = add(brand, "div", "ysw-title-wrap");
    add(titleWrap, "div", "ysw-title").textContent = "Gidaeon's Galaktika";
    add(titleWrap, "div", "ysw-time-readout").textContent = "0:00 / 0:00";
    add(toolbar, "div", "ysw-status").textContent = "Waiting for audio...";

    addButton(toolbar, "ysw-format-button ysw-march", "Automatically download each sample and advance to the next", "Start or stop MARCH automatic downloading").textContent = "MARCH";
    addButton(toolbar, "ysw-format-button ysw-march-skip", "Cancel, clean up, and skip the current MARCH item", "Skip the current MARCH item").textContent = "SKIP";
    addButton(toolbar, "ysw-format-button ysw-download-original", "Download original YouTube audio without transcoding", "Download original YouTube audio without transcoding").textContent = "OG";
    addButton(toolbar, "ysw-format-button ysw-download-wav", "Choose folder and download best quality WAV", "Choose folder and download best quality WAV").textContent = "WAV";
    addButton(toolbar, "ysw-format-button ysw-download-mp3", "Choose folder and download MP3", "Choose folder and download MP3").textContent = "MP3";
    addButton(toolbar, "ysw-format-button ysw-download-aac", "Download Unity-ready 48 kHz AAC audio in M4A at the source bitrate", "Download Unity-ready M4A audio").textContent = "AAC";
    addButton(toolbar, "ysw-format-button ysw-download-mp4", "Choose folder and download MP4 video", "Choose folder and download MP4 video").textContent = "MP4";
    addButton(toolbar, "ysw-format-button ysw-download-game", "Download tiny game-ready MP4 (12 fps, 160 px height)", "Download tiny game-ready MP4").textContent = "GAME";
    const settingsButton = addButton(toolbar, "ysw-icon-button ysw-settings", "Settings", "Settings");
    addSvg(settingsButton, [
      "M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z",
      "M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06A1.7 1.7 0 0 0 15 19.4a1.7 1.7 0 0 0-1 .6 1.7 1.7 0 0 0-.4 1.1V21a2 2 0 1 1-4 0v-.09A1.7 1.7 0 0 0 8.6 19a1.7 1.7 0 0 0-1.88.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-.6-1 1.7 1.7 0 0 0-1.1-.4H2.8a2 2 0 1 1 0-4h.09A1.7 1.7 0 0 0 4 8.6a1.7 1.7 0 0 0-.34-1.88l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-.6 1.7 1.7 0 0 0 .4-1.1V2.8a2 2 0 1 1 4 0v.09A1.7 1.7 0 0 0 15.4 4a1.7 1.7 0 0 0 1.88-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.7 1.7 0 0 0 19.4 9c.4.1.75.32 1 .6.3.3.44.68.4 1.1v.09a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.31.21z"
    ]);

    const settingsPanel = add(root, "form", "ysw-settings-panel", { hidden: "" });
    add(settingsPanel, "div", "ysw-settings-title").textContent = "Galaktika Settings";
    const settingsGrid = add(settingsPanel, "div", "ysw-settings-grid");
    const sourceFormatLabel = add(settingsGrid, "label");
    add(sourceFormatLabel, "span").textContent = "Prefetch format selector";
    add(sourceFormatLabel, "input", "ysw-source-format", { type: "text", maxlength: "500", spellcheck: "false" });
    const wavFormatLabel = add(settingsGrid, "label");
    add(wavFormatLabel, "span").textContent = "WAV format selector";
    add(wavFormatLabel, "input", "ysw-best-wav-format", { type: "text", maxlength: "500", spellcheck: "false" });
    const cookiesLabel = add(settingsGrid, "label");
    add(cookiesLabel, "span").textContent = "Cookies browser";
    add(cookiesLabel, "input", "ysw-cookies-browser", { type: "text", maxlength: "80", spellcheck: "false" });
    const componentsLabel = add(settingsGrid, "label");
    add(componentsLabel, "span").textContent = "Remote components (bundled or override)";
    add(componentsLabel, "input", "ysw-remote-components", {
      type: "text",
      maxlength: "160",
      spellcheck: "false",
      title: "Use bundled for the official yt-dlp executable, or enter an explicit remote component override"
    });
    const poTokenBrowserLabel = add(settingsGrid, "label");
    add(poTokenBrowserLabel, "span").textContent = "PO-token Chromium path";
    add(poTokenBrowserLabel, "input", "ysw-po-token-browser", {
      type: "text",
      maxlength: "500",
      spellcheck: "false",
      placeholder: "auto",
      title: "Use auto to prefer Thorium, or provide a Chrome/Chromium executable path"
    });
    const exclusionLabel = add(settingsGrid, "label", "ysw-exclusion-setting");
    add(exclusionLabel, "span").textContent = "Long-video exclusion";
    const exclusionControls = add(exclusionLabel, "span", "ysw-exclusion-controls");
    add(exclusionControls, "input", "ysw-exclude-long-videos", {
      type: "checkbox",
      title: "Exclude videos longer than the configured H:MM limit"
    });
    add(exclusionControls, "span").textContent = "Exclude over";
    add(exclusionControls, "input", "ysw-long-video-limit", {
      type: "text",
      value: DEFAULT_LONG_VIDEO_LIMIT,
      maxlength: "6",
      inputmode: "numeric",
      pattern: "[0-9]{1,3}:[0-5][0-9]",
      placeholder: "1:00",
      title: "Hours and minutes, for example 1:00 for one hour",
      spellcheck: "false"
    });
    add(exclusionControls, "span", "ysw-exclusion-format").textContent = "H:MM";
    const prefetchLabel = add(settingsPanel, "label");
    add(prefetchLabel, "span").textContent = "Prefetch command";
    add(prefetchLabel, "textarea", "ysw-command-preview ysw-prefetch-command", { rows: "3", readonly: "", spellcheck: "false" });
    const downloadLabel = add(settingsPanel, "label");
    add(downloadLabel, "span").textContent = "Download command";
    add(downloadLabel, "textarea", "ysw-command-preview ysw-wav-command", { rows: "3", readonly: "", spellcheck: "false" });
    add(settingsPanel, "div", "ysw-settings-validation", { role: "status", "aria-live": "polite" }).textContent = "Settings have not been validated yet.";
    const settingsActions = add(settingsPanel, "div", "ysw-settings-actions");
    addButton(settingsActions, "ysw-settings-reset", "Validate and restore defaults", "Validate and restore default settings").textContent = "Reset";
    addButton(settingsActions, "ysw-settings-validate", "Validate commands without saving", "Validate commands without saving").textContent = "Validate";
    addButton(settingsActions, "ysw-settings-save", "Save settings without command verification", "Save settings without command verification").textContent = "Save";
    addButton(settingsActions, "ysw-settings-close", "Close settings", "Close settings").textContent = "Close";

    add(root, "div", "ysw-marker-lane", { title: "Click to add a marker pin. Click a pin to remove it." });
    add(root, "canvas", "ysw-canvas", { height: "96" });
    const messagePanel = add(root, "details", "ysw-message-panel");
    const summary = add(messagePanel, "summary");
    add(summary, "span", "ysw-message-label").textContent = "Messages";
    add(summary, "span", "ysw-message-preview").textContent = "Waiting for audio...";
    add(messagePanel, "div", "ysw-message-body").textContent = "Waiting for audio...";
    return root;
  }

  class WaveformApp {
    constructor(host, video) {
      this.host = host;
      this.playerBlock = getPlayerBlock();
      this.video = video;
      this.root = createUi();
      this.bgCanvas = this.root.querySelector(".ysw-galaxy-bg");
      this.loadingBar = this.root.querySelector(".ysw-loading-bar");
      this.canvas = this.root.querySelector(".ysw-canvas");
      this.ctx = this.canvas.getContext("2d");
      this.status = this.root.querySelector(".ysw-status");
      this.timeReadout = this.root.querySelector(".ysw-time-readout");
      this.collapseButton = this.root.querySelector(".ysw-collapse-toggle");
      this.markerLane = this.root.querySelector(".ysw-marker-lane");
      this.messagePreview = this.root.querySelector(".ysw-message-preview");
      this.messageBody = this.root.querySelector(".ysw-message-body");
      this.messagePanel = this.root.querySelector(".ysw-message-panel");
      this.marchButton = this.root.querySelector(".ysw-march");
      this.marchSkipButton = this.root.querySelector(".ysw-march-skip");
      this.downloadButton = this.root.querySelector(".ysw-download-wav");
      this.downloadMp3Button = this.root.querySelector(".ysw-download-mp3");
      this.downloadOriginalButton = this.root.querySelector(".ysw-download-original");
      this.downloadMp4Button = this.root.querySelector(".ysw-download-mp4");
      this.downloadGameButton = this.root.querySelector(".ysw-download-game");
      this.downloadAacButton = this.root.querySelector(".ysw-download-aac");
      this.downloadButtons = [this.downloadOriginalButton, this.downloadButton, this.downloadMp3Button, this.downloadAacButton, this.downloadMp4Button, this.downloadGameButton];
      this.settingsButton = this.root.querySelector(".ysw-settings");
      this.settingsPanel = this.root.querySelector(".ysw-settings-panel");
      this.settingsPrefetchCommand = this.root.querySelector(".ysw-prefetch-command");
      this.settingsWavCommand = this.root.querySelector(".ysw-wav-command");
      this.settingsSourceFormat = this.root.querySelector(".ysw-source-format");
      this.settingsBestWavFormat = this.root.querySelector(".ysw-best-wav-format");
      this.settingsCookiesBrowser = this.root.querySelector(".ysw-cookies-browser");
      this.settingsRemoteComponents = this.root.querySelector(".ysw-remote-components");
      this.settingsPoTokenBrowser = this.root.querySelector(".ysw-po-token-browser");
      this.settingsExcludeLongVideos = this.root.querySelector(".ysw-exclude-long-videos");
      this.settingsLongVideoLimit = this.root.querySelector(".ysw-long-video-limit");
      this.settingsValidation = this.root.querySelector(".ysw-settings-validation");
      this.settingsResetButton = this.root.querySelector(".ysw-settings-reset");
      this.settingsValidateButton = this.root.querySelector(".ysw-settings-validate");
      this.settingsSaveButton = this.root.querySelector(".ysw-settings-save");
      this.settingsCloseButton = this.root.querySelector(".ysw-settings-close");
      this.peaks = new Float32Array(1);
      this.prefetchedPeaks = false;
      this.prefetchComplete = false;
      this.prefetchError = "";
      this.prefetchInProgress = false;
      this.prefetchRequestId = 0;
      this.streamingWaveformActive = false;
      this.highResWaveformReady = false;
      this.highResWaveformInProgress = false;
      this.highResWaveformUrl = "";
      this.downloadInProgress = false;
      this.downloadProgress = null;
      this.marchActive = false;
      this.marchFastMode = false;
      this.marchAwaitingFormat = false;
      this.marchDefaultFormat = "";
      this.marchDirectory = "";
      this.marchCurrentUrl = "";
      this.marchCurrentOverrides = [];
      this.marchCurrentSavedPaths = [];
      this.marchPendingOverrides = [];
      this.marchAcceptingOverrides = false;
      this.marchSkipRequested = false;
      this.marchRunToken = 0;
      this.audioReady = false;
      this.destroyed = false;
      this.resizeObserver = null;
      this.audioContext = null;
      this.source = null;
      this.analyser = null;
      this.timeData = null;
      this.raf = 0;
      this.bgRaf = 0;
      this.bgGl = null;
      this.bgProgram = null;
      this.bgStartAt = performance.now();
      this.lastRms = 0.18;
      this.visibilityInterval = 0;
      this.videoUrlMonitorInterval = 0;
      this.currentVideoUrl = "";
      this.zoom = 1;
      this.viewportStart = 0;
      this.isPanning = false;
      this.panStartX = 0;
      this.panStartY = 0;
      this.panStartViewport = 0;
      this.rightPointerDown = false;
      this.rightPointerDragged = false;
      this.contextMenuTime = 0;
      this.markers = [];
      this.shortcutsActive = false;
      this.bgRaf = 0;
      this.bgGl = null;
      this.bgProgram = null;
      this.bgStartAt = performance.now();
      this.lastRms = 0.18;
      this.silentFrameCount = 0;
      this.lastAudioSetupAt = 0;
      this.collapsed = false;
      this.pendingPrefetchUrl = "";
      this.radioooooBridgeState = null;
      this.radioooooBridgeStateAt = 0;
      this.radioooooClockAnchor = null;
      this.helperClientId = `galaktika-${Date.now()}-${Math.random().toString(16).slice(2)}`;
      this.helperSessionInterval = 0;
      this.helperSessionReady = false;
    }

    mount() {
      document.getElementById(ROOT_ID)?.remove();
      injectRadioooooBridge();
      injectCrateDigrsBridge();
      injectSampleRouletteBridge();
      this.placeRoot();
      this.bind();
      this.resize();
      this.startGalaxyBackground();
      this.setupAudio();
      this.draw();
      this.activateVisibleSession();
      void this.restoreMarchState();
      this.visibilityInterval = window.setInterval(() => this.repairVisibility(), 1000);
      this.videoUrlMonitorInterval = window.setInterval(() => this.checkForVideoUrlChange(), 1000);
    }

    placeRoot() {
      this.root.classList.toggle("ysw-embed-mode", isEmbedPage());
      this.root.classList.toggle("ysw-radiooooo-mode", isRadioooooPage());
      this.root.classList.toggle("ysw-cratedigrs-mode", isCrateDigrsPage());
      this.root.classList.toggle("ysw-sampleroulette-mode", isSampleRoulettePage());
      this.root.classList.toggle("ysw-samplette-mode", isSamplettePage());
      this.playerBlock = getPlayerBlock();
      if (isRadioooooPage()) {
        document.body.appendChild(this.root);
        document.documentElement.style.setProperty("--ysw-radiooooo-space", `${this.collapsed ? 42 : RADIOOOOO_BOTTOM_SPACE}px`);
        document.body.classList.add("ysw-radiooooo-page-active");
        this.repairVisibility();
        return;
      }
      if (isExternalYoutubePage()) {
        if (!placeExternalPageRoot(this.root)) document.body.appendChild(this.root);
        this.repairVisibility();
        return;
      }
      if (isEmbedPage()) {
        document.body.appendChild(this.root);
        this.repairVisibility();
        return;
      }

      placeNativeRoot(this.root);
      this.repairVisibility();
    }

    bind() {
      this.onResize = () => this.resize();
      this.onClick = (event) => this.seekFromCanvas(event);
      this.onWheel = (event) => this.zoomFromWheel(event);
      this.onContextMenu = (event) => this.blockNativeContextMenu(event);
      this.onPointerDown = (event) => this.startPan(event);
      this.onPointerMove = (event) => this.panWaveform(event);
      this.onPointerUp = (event) => this.endPan(event);
      this.onDocumentPointerDown = (event) => this.hideContextMenuOnOutsideClick(event);
      this.onDuration = () => this.ensurePeakBuffer();
      this.onPlay = () => this.resumeAudio();
      this.onCollapseToggle = () => this.toggleCollapsed();
      this.onMarch = () => this.toggleMarch();
      this.onMarchSkip = () => this.skipMarchItem();
      this.onDownloadWav = () => this.handleFormatClick("wav");
      this.onDownloadMp3 = () => this.handleFormatClick("mp3");
      this.onDownloadOriginal = () => this.handleFormatClick("og");
      this.onDownloadMp4 = () => this.handleFormatClick("mp4");
      this.onDownloadGame = () => this.handleFormatClick("game");
      this.onDownloadAac = () => this.handleFormatClick("aac");
      this.onSettings = () => this.toggleSettingsPanel();
      this.onSettingsClose = () => this.hideSettingsPanel();
      this.onSettingsValidate = () => this.validateOrSaveSettings(false);
      this.onSettingsSave = () => this.validateOrSaveSettings(true);
      this.onSettingsReset = () => this.resetSettings();
      this.onSettingsSubmit = (event) => {
        event.preventDefault();
        this.validateOrSaveSettings(true);
      };
      this.onSettingsInput = (event) => {
        if (event.target === this.settingsExcludeLongVideos) {
          this.settingsLongVideoLimit.disabled = !this.settingsExcludeLongVideos.checked;
        }
        this.markSettingsUnvalidated();
      };
      this.onVisibilityChange = () => this.handleVisibilityChange();
      this.onMarkerLaneClick = (event) => this.handleMarkerLaneClick(event);
      this.onShortcutKey = (event) => this.handleShortcut(event);
      this.onShortcutFocus = () => this.activateShortcuts();
      this.onShortcutBlur = () => this.deactivateShortcuts();
      this.onWindowMessage = (event) => this.handleWindowMessage(event);

      this.root.tabIndex = 0;
      this.resizeObserver = new ResizeObserver(this.onResize);
      const resizeTarget = this.host || getPlayerBlock() || this.video;
      if (resizeTarget) {
        this.resizeObserver.observe(resizeTarget);
      }
      window.addEventListener("resize", this.onResize);
      this.canvas.addEventListener("click", this.onClick);
      this.canvas.addEventListener("wheel", this.onWheel, { passive: false });
      this.canvas.addEventListener("contextmenu", this.onContextMenu);
      this.root.addEventListener("contextmenu", this.onContextMenu);
      this.canvas.addEventListener("pointerdown", this.onPointerDown);
      this.canvas.addEventListener("pointermove", this.onPointerMove);
      this.canvas.addEventListener("pointerup", this.onPointerUp);
      this.canvas.addEventListener("pointercancel", this.onPointerUp);
      this.collapseButton.addEventListener("click", this.onCollapseToggle);
      this.marchButton.addEventListener("click", this.onMarch);
      this.marchSkipButton.addEventListener("click", this.onMarchSkip);
      this.downloadButton.addEventListener("click", this.onDownloadWav);
      this.downloadMp3Button.addEventListener("click", this.onDownloadMp3);
      this.downloadOriginalButton.addEventListener("click", this.onDownloadOriginal);
      this.downloadMp4Button.addEventListener("click", this.onDownloadMp4);
      this.downloadGameButton.addEventListener("click", this.onDownloadGame);
      this.downloadAacButton.addEventListener("click", this.onDownloadAac);
      this.settingsButton.addEventListener("click", this.onSettings);
      this.settingsCloseButton.addEventListener("click", this.onSettingsClose);
      this.settingsValidateButton.addEventListener("click", this.onSettingsValidate);
      this.settingsSaveButton.addEventListener("click", this.onSettingsSave);
      this.settingsResetButton.addEventListener("click", this.onSettingsReset);
      this.settingsPanel.addEventListener("input", this.onSettingsInput);
      this.settingsPanel.addEventListener("submit", this.onSettingsSubmit);
      this.markerLane.addEventListener("click", this.onMarkerLaneClick);
      this.root.addEventListener("mouseenter", this.onShortcutFocus);
      this.root.addEventListener("mouseleave", this.onShortcutBlur);
      this.root.addEventListener("focusin", this.onShortcutFocus);
      this.root.addEventListener("focusout", this.onShortcutBlur);
      document.addEventListener("keydown", this.onShortcutKey, true);
      document.addEventListener("pointerdown", this.onDocumentPointerDown, true);
      window.addEventListener("message", this.onWindowMessage);
      document.addEventListener("visibilitychange", this.onVisibilityChange);
      this.video.addEventListener("durationchange", this.onDuration);
      this.video.addEventListener("loadedmetadata", this.onDuration);
      this.video.addEventListener("play", this.onPlay);
    }

    destroy() {
      this.destroyed = true;
      this.marchActive = false;
      this.marchRunToken += 1;
      cancelAnimationFrame(this.raf);
      cancelAnimationFrame(this.bgRaf);
      clearInterval(this.visibilityInterval);
      clearInterval(this.videoUrlMonitorInterval);
      clearInterval(this.helperSessionInterval);
      this.closeHelperSession();
      this.resizeObserver?.disconnect();
      window.removeEventListener("resize", this.onResize);
      this.canvas.removeEventListener("click", this.onClick);
      this.canvas.removeEventListener("wheel", this.onWheel);
      this.canvas.removeEventListener("contextmenu", this.onContextMenu);
      this.root.removeEventListener("contextmenu", this.onContextMenu);
      this.canvas.removeEventListener("pointerdown", this.onPointerDown);
      this.canvas.removeEventListener("pointermove", this.onPointerMove);
      this.canvas.removeEventListener("pointerup", this.onPointerUp);
      this.canvas.removeEventListener("pointercancel", this.onPointerUp);
      this.collapseButton.removeEventListener("click", this.onCollapseToggle);
      this.marchButton.removeEventListener("click", this.onMarch);
      this.marchSkipButton.removeEventListener("click", this.onMarchSkip);
      this.downloadButton.removeEventListener("click", this.onDownloadWav);
      this.downloadMp3Button.removeEventListener("click", this.onDownloadMp3);
      this.downloadOriginalButton.removeEventListener("click", this.onDownloadOriginal);
      this.downloadMp4Button.removeEventListener("click", this.onDownloadMp4);
      this.downloadGameButton.removeEventListener("click", this.onDownloadGame);
      this.downloadAacButton.removeEventListener("click", this.onDownloadAac);
      this.settingsButton.removeEventListener("click", this.onSettings);
      this.settingsCloseButton.removeEventListener("click", this.onSettingsClose);
      this.settingsValidateButton.removeEventListener("click", this.onSettingsValidate);
      this.settingsSaveButton.removeEventListener("click", this.onSettingsSave);
      this.settingsResetButton.removeEventListener("click", this.onSettingsReset);
      this.settingsPanel.removeEventListener("input", this.onSettingsInput);
      this.settingsPanel.removeEventListener("submit", this.onSettingsSubmit);
      this.markerLane.removeEventListener("click", this.onMarkerLaneClick);
      this.root.removeEventListener("mouseenter", this.onShortcutFocus);
      this.root.removeEventListener("mouseleave", this.onShortcutBlur);
      this.root.removeEventListener("focusin", this.onShortcutFocus);
      this.root.removeEventListener("focusout", this.onShortcutBlur);
      document.removeEventListener("keydown", this.onShortcutKey, true);
      document.removeEventListener("pointerdown", this.onDocumentPointerDown, true);
      window.removeEventListener("message", this.onWindowMessage);
      document.removeEventListener("visibilitychange", this.onVisibilityChange);
      this.video.removeEventListener("durationchange", this.onDuration);
      this.video.removeEventListener("loadedmetadata", this.onDuration);
      this.video.removeEventListener("play", this.onPlay);
      document.body?.classList.remove("ysw-radiooooo-page-active");
      document.documentElement.style.removeProperty("--ysw-radiooooo-space");
      this.root.remove();
      this.audioContext?.close?.();
    }

    isVisibleSessionEligible() {
      return !this.destroyed && !this.collapsed && !document.hidden && this.root.isConnected;
    }

    addClientId(url) {
      const requestUrl = new URL(url);
      requestUrl.searchParams.set("clientId", this.helperClientId);
      return requestUrl;
    }

    async touchHelperSession() {
      if (!this.isVisibleSessionEligible()) return false;
      for (const endpoint of SESSION_OPEN_ENDPOINTS) {
        try {
          const response = await fetchHelperJson(this.addClientId(endpoint).toString(), HELPER_PROBE_TIMEOUT_MS);
          if (response?.ok) {
            this.helperSessionReady = true;
            return true;
          }
        } catch (_) {
          // The native host may still be starting; the next heartbeat will retry.
        }
      }

      this.helperSessionReady = false;
      return false;
    }

    async ensureHelperSession() {
      if (!this.isVisibleSessionEligible()) return false;
      return this.touchHelperSession();
    }

    activateVisibleSession() {
      clearInterval(this.helperSessionInterval);
      this.helperSessionInterval = 0;
      if (!this.isVisibleSessionEligible()) return;
      this.touchHelperSession();
      this.helperSessionInterval = window.setInterval(() => {
        if (this.isVisibleSessionEligible()) {
          this.touchHelperSession();
        }
      }, HELPER_SESSION_HEARTBEAT_MS);
    }

    closeHelperSession() {
      this.helperSessionReady = false;
      for (const endpoint of SESSION_CLOSE_ENDPOINTS) {
        try {
          fetchHelperJson(this.addClientId(endpoint).toString(), 1500);
        } catch (_) {
          // The helper may already be stopped.
        }
      }
    }

    handleVisibilityChange() {
      if (document.hidden) {
        clearInterval(this.helperSessionInterval);
        this.helperSessionInterval = 0;
        this.closeHelperSession();
        return;
      }

      this.activateVisibleSession();
      if (!this.marchFastMode && !this.collapsed && !this.prefetchedPeaks && !this.prefetchInProgress) {
        const videoUrl = this.pendingPrefetchUrl || this.currentVideoUrl || getVideoWatchUrl();
        if (isResolvedWatchUrl(videoUrl) || isDirectMediaUrl(videoUrl)) {
          this.loadPrefetchedWaveform(videoUrl);
        }
      }
    }

    timeFromClientX(clientX) {
      const duration = this.video.duration || 0;
      if (!duration) return 0;
      const rect = this.canvas.getBoundingClientRect();
      const canvasRatio = clamp((clientX - rect.left) / rect.width, 0, 1);
      return clamp(this.viewportStart + canvasRatio / this.zoom, 0, 1) * duration;
    }

    markerTimeFromClientX(clientX) {
      const duration = this.video.duration || 0;
      if (!duration) return 0;
      const rect = this.markerLane.getBoundingClientRect();
      const laneRatio = clamp((clientX - rect.left) / rect.width, 0, 1);
      return clamp(this.viewportStart + laneRatio / this.zoom, 0, 1) * duration;
    }

    laneTimeFromClientX(lane, clientX) {
      const duration = this.video.duration || 0;
      if (!duration) return 0;
      const rect = lane.getBoundingClientRect();
      const laneRatio = clamp((clientX - rect.left) / rect.width, 0, 1);
      return clamp(this.viewportStart + laneRatio / this.zoom, 0, 1) * duration;
    }

    getBpmGridInfo() {
      return null;
    }

    renderBpmPins() {
      return;
    }

    renderMarkers() {
      const duration = this.video.duration || 0;
      const visibleSpan = 1 / this.zoom;
      this.markerLane.textContent = "";
      for (const marker of this.markers) {
        if (!duration) continue;
        const ratio = marker.time / duration;
        if (ratio < this.viewportStart || ratio > this.viewportStart + visibleSpan) continue;

        const pin = document.createElement("button");
        pin.type = "button";
        pin.className = "ysw-marker-pin";
        pin.style.left = `${((ratio - this.viewportStart) / visibleSpan) * 100}%`;
        pin.title = `Remove marker at ${formatTime(marker.time)}`;
        pin.dataset.markerId = marker.id;
        this.markerLane.appendChild(pin);
      }
    }

    handleBpmLaneContextMenu(event) {
      return;
    }

    lockContextBpmPin() {
      return;
    }

    startBpmPinDrag(event) {
      return;
    }

    dragBpmPin(event) {
      return;
    }

    endBpmPinDrag(event) {
      return;
    }

    handleMarkerLaneClick(event) {
      const pin = event.target.closest?.(".ysw-marker-pin");
      if (pin) {
        this.markers = this.markers.filter((marker) => marker.id !== pin.dataset.markerId);
        this.renderMarkers();
        return;
      }

      const time = this.markerTimeFromClientX(event.clientX);
      if (!Number.isFinite(time)) return;
      this.markers.push({
        id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
        time
      });
      this.markers.sort((a, b) => a.time - b.time);
      this.renderMarkers();
    }

    toggleMarkerAtCurrentTime() {
      const duration = this.video.duration || 0;
      const time = this.video.currentTime || 0;
      if (!duration || !Number.isFinite(time)) return;

      this.toggleMarkerAtTime(time);
    }

    addMarkerAtTime(time) {
      const duration = this.video.duration || 0;
      if (!duration || !Number.isFinite(time)) return;
      const markerTime = clamp(time, 0, duration);
      const tolerance = Math.max(0.25, duration * 0.0015);
      const existing = this.markers.find((marker) => Math.abs(marker.time - markerTime) <= tolerance);
      if (existing) return;

      this.markers.push({
        id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
        time: markerTime
      });
      this.markers.sort((a, b) => a.time - b.time);
      this.renderMarkers();
    }

    toggleMarkerAtTime(time) {
      const duration = this.video.duration || 0;
      if (!duration || !Number.isFinite(time)) return;
      const markerTime = clamp(time, 0, duration);
      const tolerance = Math.max(0.25, duration * 0.0015);
      const existing = this.markers.find((marker) => Math.abs(marker.time - markerTime) <= tolerance);
      if (existing) {
        this.markers = this.markers.filter((marker) => marker.id !== existing.id);
      } else {
        this.markers.push({
          id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
          time: markerTime
        });
      }
      this.markers.sort((a, b) => a.time - b.time);
      this.renderMarkers();
    }

    seekToAdjacentMarker(direction) {
      if (!this.markers.length) return;
      const current = this.video.currentTime || 0;
      const sorted = [...this.markers].sort((a, b) => a.time - b.time);
      const previousLeeway = 0.85;
      const marker = direction < 0
        ? [...sorted].reverse().find((item) => item.time < current - previousLeeway) || sorted[sorted.length - 1]
        : sorted.find((item) => item.time > current + 0.05) || sorted[0];
      if (!marker) return;
      this.setMediaCurrentTime(marker.time);
      this.video.play();
    }

    activateShortcuts() {
      this.shortcutsActive = true;
      this.root.classList.add("ysw-shortcuts-active");
    }

    deactivateShortcuts() {
      if (this.root.matches(":hover")) return;
      this.shortcutsActive = false;
      this.root.classList.remove("ysw-shortcuts-active");
    }

    toggleCollapsed() {
      this.collapsed = !this.collapsed;
      this.root.classList.toggle("ysw-collapsed", this.collapsed);
      this.collapseButton.setAttribute(
        "aria-label",
        this.collapsed ? "Restore Galaktika" : "Collapse Galaktika"
      );
      this.collapseButton.title = this.collapsed ? "Restore Galaktika" : "Collapse Galaktika";
      if (this.collapsed) {
        clearInterval(this.helperSessionInterval);
        this.helperSessionInterval = 0;
        this.closeHelperSession();
        this.prefetchRequestId += 1;
        this.prefetchInProgress = false;
        this.highResWaveformInProgress = false;
        this.stopLiveAudioProcessing();
        this.updateLoadingIndicator();
        this.hideSettingsPanel();
        this.messagePanel.open = false;
        this.hideContextMenu();
        return;
      }
      this.resize();
      this.repairVisibility();
      this.activateVisibleSession();
      if (this.marchFastMode) return;
      this.setupAudio();
      const videoUrl = this.pendingPrefetchUrl || this.currentVideoUrl || getVideoWatchUrl();
      if (!this.prefetchedPeaks && (isResolvedWatchUrl(videoUrl) || isDirectMediaUrl(videoUrl))) {
        this.loadPrefetchedWaveform(videoUrl);
      } else if (this.prefetchedPeaks && !this.highResWaveformReady) {
        this.requestHighResolutionWaveformIfNeeded();
      }
    }

    handleShortcut(event) {
      if (!this.shortcutsActive && !this.root.matches(":hover")) return;
      if (event.ctrlKey || event.altKey || event.metaKey) return;
      const target = event.target;
      if (target?.closest?.("input, textarea, select, [contenteditable='true']")) return;

      const key = event.key;
      if (key === "`") {
        event.preventDefault();
        this.activateShortcuts();
        this.setStatus("Galaktika shortcuts active.", true);
        return;
      }
      if (key === "[") {
        event.preventDefault();
        this.seekToAdjacentMarker(-1);
        return;
      }
      if (key === "]") {
        event.preventDefault();
        this.seekToAdjacentMarker(1);
        return;
      }
      if (key === ";") {
        event.preventDefault();
        this.toggleMarkerAtCurrentTime();
        return;
      }
      if (key === "Home") {
        event.preventDefault();
        this.setMediaCurrentTime(0);
        this.video.play();
      }
    }

    blockNativeContextMenu(event) {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation?.();
      return false;
    }

    resize() {
      if (!this.root.isConnected) {
        this.placeRoot();
      }
      const widthSource = getPlayerBlock() || this.host || this.video;
      const externalSlot = isExternalYoutubePage() ? document.getElementById(SLOT_ID) : null;
      const rect = isEmbedPage()
        ? { width: window.innerWidth || widthSource.getBoundingClientRect().width }
        : isRadioooooPage()
          ? { width: window.innerWidth || 960 }
        : isExternalYoutubePage()
          ? { width: externalSlot?.getBoundingClientRect().width || getExternalPageAnchor()?.getBoundingClientRect().width || window.innerWidth || 960 }
        : widthSource.getBoundingClientRect();
      const width = Math.max(280, Math.round(rect.width));
      const height = getWaveformHeight();
      const dpr = window.devicePixelRatio || 1;
      this.root.style.width = `${width}px`;
      this.root.style.maxWidth = `${width}px`;
      this.root.style.opacity = "1";
      this.root.style.visibility = "visible";
      this.root.style.display = "block";
      this.canvas.style.width = `${width}px`;
      this.canvas.style.height = `${height}px`;
      this.canvas.width = Math.round(width * dpr);
      this.canvas.height = Math.round(height * dpr);
      this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      this.resizeGalaxyBackground();
      this.renderMarkers();
      this.renderBpmPins();
      this.drawFrame();
      if (isRadioooooPage()) {
        document.documentElement.style.setProperty("--ysw-radiooooo-space", `${this.root.getBoundingClientRect().height || (this.collapsed ? 42 : RADIOOOOO_BOTTOM_SPACE)}px`);
      }
    }

    createShader(gl, type, source) {
      const shader = gl.createShader(type);
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        throw new Error(gl.getShaderInfoLog(shader) || "Galaxy shader compile failed.");
      }
      return shader;
    }

    startGalaxyBackground() {
      try {
        const gl = this.bgCanvas.getContext("webgl", {
          alpha: true,
          antialias: false,
          depth: false,
          stencil: false
        });
        if (!gl) return;

        const vertex = this.createShader(gl, gl.VERTEX_SHADER, GALAXY_VERTEX_SHADER);
        const fragment = this.createShader(gl, gl.FRAGMENT_SHADER, GALAXY_FRAGMENT_SHADER);
        const program = gl.createProgram();
        gl.attachShader(program, vertex);
        gl.attachShader(program, fragment);
        gl.linkProgram(program);
        if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
          throw new Error(gl.getProgramInfoLog(program) || "Galaxy shader link failed.");
        }

        const buffer = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
          -1, -1,
          1, -1,
          -1, 1,
          -1, 1,
          1, -1,
          1, 1
        ]), gl.STATIC_DRAW);

        gl.useProgram(program);
        const position = gl.getAttribLocation(program, "aPosition");
        gl.enableVertexAttribArray(position);
        gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);

        this.bgGl = gl;
        this.bgProgram = program;
        this.bgResolutionUniform = gl.getUniformLocation(program, "iResolution");
        this.bgTimeUniform = gl.getUniformLocation(program, "iTime");
        this.bgAudioUniform = gl.getUniformLocation(program, "uAudio");
        this.resizeGalaxyBackground();
        this.drawGalaxyBackground();
      } catch (error) {
        console.warn("Gidaeon's Galaktika shader disabled:", error);
      }
    }

    resizeGalaxyBackground() {
      if (!this.bgCanvas) return;
      const dpr = window.devicePixelRatio || 1;
      const rect = this.root.getBoundingClientRect();
      const width = Math.max(1, Math.round(rect.width * dpr));
      const height = Math.max(1, Math.round(rect.height * dpr));
      if (this.bgCanvas.width !== width || this.bgCanvas.height !== height) {
        this.bgCanvas.width = width;
        this.bgCanvas.height = height;
        this.bgGl?.viewport(0, 0, width, height);
      }
    }

    drawGalaxyBackground() {
      if (this.destroyed || !this.bgGl || !this.bgProgram) return;
      const gl = this.bgGl;
      const time = (performance.now() - this.bgStartAt) / 1000;
      const audio = clamp(this.lastRms || 0.18, 0.05, 1);

      this.resizeGalaxyBackground();
      gl.useProgram(this.bgProgram);
      gl.uniform2f(this.bgResolutionUniform, this.bgCanvas.width, this.bgCanvas.height);
      gl.uniform1f(this.bgTimeUniform, time);
      gl.uniform4f(
        this.bgAudioUniform,
        clamp(audio * 0.85 + 0.12, 0.05, 1),
        clamp(audio * 1.05 + 0.10, 0.05, 1),
        clamp(audio * 1.25 + 0.18, 0.05, 1),
        clamp(audio * 1.45 + 0.22, 0.05, 1)
      );
      gl.drawArrays(gl.TRIANGLES, 0, 6);
      this.bgRaf = requestAnimationFrame(() => this.drawGalaxyBackground());
    }

    repairVisibility() {
      if (this.destroyed) return;
      if (!this.root.isConnected) {
        this.placeRoot();
        return;
      }

      if (isEmbedPage()) {
        this.root.classList.add("ysw-embed-mode");
        if (this.root.parentElement !== document.body) {
          document.body.appendChild(this.root);
        }
      } else if (isRadioooooPage()) {
        this.root.classList.add("ysw-radiooooo-mode");
        document.body.classList.add("ysw-radiooooo-page-active");
        document.documentElement.style.setProperty("--ysw-radiooooo-space", `${this.root.getBoundingClientRect().height || (this.collapsed ? 42 : RADIOOOOO_BOTTOM_SPACE)}px`);
        if (this.root.parentElement !== document.body) {
          document.body.appendChild(this.root);
        }
      } else if (isExternalYoutubePage()) {
        this.root.classList.toggle("ysw-cratedigrs-mode", isCrateDigrsPage());
        this.root.classList.toggle("ysw-sampleroulette-mode", isSampleRoulettePage());
        this.root.classList.toggle("ysw-samplette-mode", isSamplettePage());
        placeExternalPageRoot(this.root);
      } else {
        this.root.classList.remove("ysw-embed-mode");
        this.root.classList.remove("ysw-radiooooo-mode");
        this.root.classList.remove("ysw-cratedigrs-mode");
        this.root.classList.remove("ysw-sampleroulette-mode");
        this.root.classList.remove("ysw-samplette-mode");
        document.body.classList.remove("ysw-radiooooo-page-active");
        placeNativeRoot(this.root);
      }

      const computed = window.getComputedStyle(this.root);
      if (computed.display === "none" || computed.visibility === "hidden" || Number(computed.opacity) < 0.99) {
        this.root.style.setProperty("display", "block", "important");
        this.root.style.setProperty("visibility", "visible", "important");
        this.root.style.setProperty("opacity", "1", "important");
      }
    }

    ensurePeakBuffer() {
      if (this.prefetchedPeaks) return;
      const duration = this.video.duration || 0;
      const size = Math.max(1, Math.ceil(duration * BINS_PER_SECOND));
      if (size !== this.peaks.length) {
        const next = new Float32Array(size);
        next.set(this.peaks.slice(0, Math.min(this.peaks.length, size)));
        this.peaks = next;
      }
    }

    resetWaveformForNewVideo(videoUrl) {
      this.prefetchRequestId += 1;
      this.currentVideoUrl = videoUrl;
      this.pendingPrefetchUrl = videoUrl;
      this.prefetchedPeaks = false;
      this.prefetchComplete = false;
      this.prefetchError = "";
      this.prefetchInProgress = false;
      this.highResWaveformReady = false;
      this.highResWaveformInProgress = false;
      this.highResWaveformUrl = "";
      this.streamingWaveformActive = false;
      this.silentFrameCount = 0;
      this.updateLoadingIndicator();
      this.zoom = 1;
      this.viewportStart = 0;
      this.isPanning = false;
      this.markers = [];
      this.renderMarkers();
      this.hideContextMenu();
      const duration = this.video.duration || 0;
      this.peaks = new Float32Array(Math.max(1, Math.ceil(duration * BINS_PER_SECOND)));
      this.setStatus(this.marchFastMode
        ? "MARCH detected the next item. Preparing its download..."
        : "New video detected. Prefetching waveform... live waveform active.", true);
      this.drawFrame();
    }

    updateLoadingIndicator() {
      const isLoading = this.prefetchInProgress || this.highResWaveformInProgress || this.downloadInProgress;
      const hasDownloadProgress = this.downloadInProgress && Number.isFinite(this.downloadProgress);
      this.root.classList.toggle("ysw-loading-active", Boolean(isLoading));
      this.root.classList.toggle("ysw-loading-download", Boolean(this.downloadInProgress));
      this.root.classList.toggle("ysw-loading-determinate", Boolean(hasDownloadProgress));
      if (hasDownloadProgress) {
        this.root.style.setProperty("--ysw-loading-progress", String(clamp(this.downloadProgress, 0, 100)));
      } else {
        this.root.style.removeProperty("--ysw-loading-progress");
      }
    }

    async checkForVideoUrlChange() {
      if (this.destroyed || !isSupportedPage()) return;

      const nativeUrl = isRadioooooPage() ? getLatestRadioooooMediaUrl() : getVideoWatchUrl();
      let detectedUrl = nativeUrl;
      if (isEmbedPage()) {
        const capturedUrl = await getCapturedVideoUrl();
        detectedUrl = isResolvedWatchUrl(capturedUrl) ? capturedUrl : nativeUrl;
      }
      if ((!isResolvedWatchUrl(detectedUrl) && !isDirectMediaUrl(detectedUrl)) || detectedUrl === this.currentVideoUrl) {
        return;
      }

      if (!isExternalPlayerPage()) {
        this.video = getVideo() || this.video;
      }
      this.resetWaveformForNewVideo(detectedUrl);
      if (!this.marchFastMode) this.setupAudio();
      if (!this.marchFastMode && !this.collapsed && !document.hidden) {
        this.loadPrefetchedWaveform(detectedUrl);
      }
    }

    setupAudio() {
      try {
        if (this.collapsed || this.marchFastMode) {
          this.stopLiveAudioProcessing();
          return;
        }
        if (isExternalPlayerPage()) {
          this.audioReady = false;
          const waitingMessage = isCrateDigrsPage()
            ? "Waiting for a playable CrateDigrs record..."
            : isSampleRoulettePage()
              ? "Waiting for a playable SampleRoulette sample..."
              : isSamplettePage()
                ? "Waiting for a playable Samplette selection..."
                : "Waiting for Radiooooo media URL...";
          this.setStatus(waitingMessage, true);
          return;
        }
        this.lastAudioSetupAt = performance.now();
        this.audioContext?.close?.();
        const capture = this.video.captureStream || this.video.mozCaptureStream;
        if (!capture) {
          this.setStatus("This browser cannot capture the video audio stream.", true);
          return;
        }

        const stream = capture.call(this.video);
        this.audioContext = new AudioContext();
        this.source = this.audioContext.createMediaStreamSource(stream);
        this.analyser = this.audioContext.createAnalyser();
        this.analyser.fftSize = FFT_SIZE;
        this.timeData = new Uint8Array(this.analyser.fftSize);
        this.source.connect(this.analyser);
        this.audioReady = true;
        this.silentFrameCount = 0;
        this.setStatus("Live waveform active.", false);
        this.resumeAudio();
      } catch (_) {
        this.setStatus("Audio capture was blocked.", false);
      }
    }

    stopLiveAudioProcessing() {
      this.audioReady = false;
      this.source?.disconnect?.();
      this.analyser?.disconnect?.();
      this.audioContext?.close?.();
      this.audioContext = null;
      this.source = null;
      this.analyser = null;
      this.timeData = null;
    }

    setStatus(message, force) {
      this.updateLoadingIndicator();
      const updateMessagePanel = (value) => {
        this.messagePreview.textContent = value;
        this.messageBody.textContent = value;
        if (/failed|error|blocked|missing|skipped/i.test(value)) {
          this.messagePanel.classList.add("ysw-message-error");
        } else {
          this.messagePanel.classList.remove("ysw-message-error");
        }
      };

      if (!force && this.prefetchError) {
        const messageText = `${this.prefetchError} | Live waveform active.`;
        this.status.textContent = "Live waveform active. Check messages.";
        updateMessagePanel(messageText);
        return;
      }
      if (!force && this.prefetchInProgress && this.audioReady) {
        this.status.textContent = "Prefetching waveform... live waveform active.";
        updateMessagePanel("Prefetching waveform... live waveform active.");
        return;
      }
      this.status.textContent = /failed|error|blocked|missing|skipped/i.test(message) && message.length > 80
        ? "Issue detected. Open messages."
        : message;
      updateMessagePanel(message);
    }

    formatPrefetchFailure(response, requestUrl) {
      const body = response?.body || {};
      const status = response?.status
        ? `${response.statusText || "request failed"} (${response.status})`
        : (response?.statusText || "request failed");
      const detail = body.backgroundError
        ? `${body.error || body.message || "No helper error body was returned."} (background: ${body.backgroundError})`
        : (body.error || body.message || "No helper error body was returned.");
      const receivedUrl = body.receivedUrl ? ` Received URL: ${body.receivedUrl}` : "";
      const transport = response?.transport ? ` using ${response.transport}` : "";
      return `Prefetch failed via browser native messaging${transport}: ${status}: ${detail}${receivedUrl}`;
    }

    formatHelperFailure(action, response, requestUrl) {
      if (response?.status === 404) {
        return `${action} failed: native helper action not found. Run Install-Galaktika-Helper.cmd and reload the add-on.`;
      }
      return this.formatPrefetchFailure(response, requestUrl).replace("Prefetch", action);
    }

    resumeAudio() {
      if (this.audioContext?.state === "suspended") {
        this.audioContext.resume();
      }
    }

    handleWindowMessage(event) {
      const externalYoutubeStateType = isCrateDigrsPage()
        ? "ysw:cratedigrs-player-state"
        : "ysw:sampleroulette-player-state";
      if (isExternalYoutubePage() && event.source === window && event.data?.type === externalYoutubeStateType) {
        const state = event.data.state || {};
        const current = Number(state.current);
        const duration = Number(state.duration);
        const videoId = String(state.videoId || "");
        if (!/^[\w-]{11}$/.test(videoId) || !Number.isFinite(current) || !Number.isFinite(duration) || duration <= 0) return;
        crateDigrsPlayerState = {
          videoId,
          current: clamp(current, 0, duration),
          duration,
          playing: Boolean(state.playing),
          playerState: Number(state.playerState),
          title: String(state.title || "")
        };
        crateDigrsPlayerStateAt = performance.now();
        return;
      }
      if (!isRadioooooPage() || event.source !== window || event.data?.type !== "ysw:radiooooo-audio-state") return;
      const state = event.data.state || {};
      const current = Number(state.current);
      const duration = Number(state.duration);
      if (!Number.isFinite(current) || !Number.isFinite(duration) || duration <= 0) return;
      this.radioooooBridgeState = {
        current: clamp(current, 0, duration),
        duration,
        playing: Boolean(state.playing),
        source: state.source || "page"
      };
      this.radioooooBridgeStateAt = performance.now();
    }

    getRadioooooBridgeState() {
      if (!this.radioooooBridgeState || performance.now() - this.radioooooBridgeStateAt > 1200) return null;
      return this.radioooooBridgeState;
    }

    getRadioooooInterpolatedState() {
      const state = this.getRadioooooBridgeState();
      if (!state) return null;
      const elapsed = state.playing ? (performance.now() - this.radioooooBridgeStateAt) / 1000 : 0;
      return {
        ...state,
        current: clamp(state.current + elapsed, 0, state.duration)
      };
    }

    getRadioooooClockInterpolatedState(clocks) {
      const now = performance.now();
      const anchor = this.radioooooClockAnchor;
      const needsAnchor = !anchor ||
        anchor.duration !== clocks.duration ||
        clocks.current !== anchor.observedCurrent ||
        Math.abs(clocks.current - clamp(anchor.current + ((now - anchor.at) / 1000), 0, anchor.duration)) > 1.75;

      if (needsAnchor) {
        this.radioooooClockAnchor = {
          current: clocks.current,
          observedCurrent: clocks.current,
          duration: clocks.duration,
          at: now
        };
      }

      const nextAnchor = this.radioooooClockAnchor;
      return {
        current: clamp(nextAnchor.current + ((now - nextAnchor.at) / 1000), 0, nextAnchor.duration),
        duration: nextAnchor.duration,
        playing: true,
        source: "clock-interpolated"
      };
    }

    draw() {
      if (this.destroyed) return;
      if (!this.marchFastMode) {
        this.syncRadioooooClock();
        this.capturePeak();
        this.drawFrame();
      }
      this.raf = requestAnimationFrame(() => this.draw());
    }

    syncRadioooooClock() {
      if (isExternalYoutubePage()) {
        if (!crateDigrsPlayerState || performance.now() - crateDigrsPlayerStateAt > 1200) return;
        const elapsed = crateDigrsPlayerState.playing ? (performance.now() - crateDigrsPlayerStateAt) / 1000 : 0;
        this.video.currentTime = clamp(crateDigrsPlayerState.current + elapsed, 0, crateDigrsPlayerState.duration);
        this.video.duration = crateDigrsPlayerState.duration;
        this.video.paused = !crateDigrsPlayerState.playing;
        return;
      }
      if (!isRadioooooPage()) return;
      const indicatorState = getRadioooooIndicatorState();
      if (indicatorState) {
        this.video.currentTime = indicatorState.current;
        this.video.duration = indicatorState.duration;
        this.video.paused = !indicatorState.playing;
        this.radioooooClockAnchor = {
          current: indicatorState.current,
          observedCurrent: Math.floor(indicatorState.current),
          duration: indicatorState.duration,
          at: performance.now()
        };
        return;
      }
      const bridgeState = this.getRadioooooInterpolatedState();
      if (bridgeState) {
        this.video.currentTime = bridgeState.current;
        this.video.duration = bridgeState.duration;
        this.video.paused = !bridgeState.playing;
        return;
      }
      const clocks = getRadioooooClocks();
      if (!clocks) return;
      const interpolated = this.getRadioooooClockInterpolatedState(clocks);
      this.video.currentTime = interpolated.current;
      this.video.duration = interpolated.duration;
      this.video.paused = !interpolated.playing;
    }

    seekRadioooooToTime(time) {
      if (isExternalYoutubePage()) {
        const duration = this.video.duration || crateDigrsPlayerState?.duration || 0;
        if (!duration || !Number.isFinite(time)) return false;
        const targetTime = clamp(time, 0, duration);
        const messageType = isCrateDigrsPage() ? "ysw:cratedigrs-seek" : "ysw:sampleroulette-seek";
        window.postMessage({ type: messageType, time: targetTime }, "*");
        this.video.currentTime = targetTime;
        return true;
      }
      const duration = this.video.duration || getRadioooooClocks()?.duration || 0;
      if (!duration || !Number.isFinite(time)) return false;
      const ratio = clamp(time / duration, 0, 1);
      window.postMessage({ type: "ysw:radiooooo-seek", time: ratio * duration }, "*");
      this.video.currentTime = ratio * duration;
      this.radioooooClockAnchor = {
        current: ratio * duration,
        observedCurrent: Math.floor(ratio * duration),
        duration,
        at: performance.now()
      };
      const bridgeState = this.getRadioooooBridgeState();
      if (bridgeState) {
        return true;
      }
      const progress = getRadioooooProgressRect();
      if (!progress) {
        this.video.currentTime = ratio * duration;
        return false;
      }

      const left = progress.rect.left;
      const right = progress.rect.right;
      const x = left + Math.max(1, right - left) * ratio;
      const clickX = clamp(x, 1, window.innerWidth - 1);
      const yCandidates = [
        (progress.rect.top + progress.rect.bottom) / 2,
        progress.pair ? (progress.pair.currentRect.top + progress.pair.currentRect.bottom) / 2 : (progress.rect.top + progress.rect.bottom) / 2,
        progress.rect.top - 4,
        progress.rect.bottom + 4
      ];
      for (const y of yCandidates) {
        const clickY = clamp(y, 1, window.innerHeight - 1);
        const target = document.elementFromPoint(clickX, clickY) || progress.element;
        for (const type of ["pointerover", "pointermove", "pointerdown", "mousedown", "pointerup", "mouseup", "click", "dblclick"]) {
          const eventInit = {
            bubbles: true,
            cancelable: true,
            clientX: clickX,
            clientY: clickY,
            view: window
          };
          target.dispatchEvent(new MouseEvent(type, {
            ...eventInit,
            detail: type === "dblclick" ? 2 : 1
          }));
        }
      }
      this.video.currentTime = ratio * duration;
      return true;
    }

    setMediaCurrentTime(time) {
      if (isExternalPlayerPage()) {
        this.seekRadioooooToTime(time);
      } else {
        this.video.currentTime = time;
      }
    }

    capturePeak() {
      if (this.collapsed) return;
      if (this.prefetchedPeaks) return;
      if (!this.audioReady || !this.analyser || this.video.paused || !Number.isFinite(this.video.currentTime)) return;

      this.ensurePeakBuffer();
      this.analyser.getByteTimeDomainData(this.timeData);

      let sum = 0;
      let peakDelta = 0;
      for (let i = 0; i < this.timeData.length; i += 1) {
        const normalized = (this.timeData[i] - 128) / 128;
        peakDelta = Math.max(peakDelta, Math.abs(normalized));
        sum += normalized * normalized;
      }

      if (peakDelta < 0.002) {
        this.silentFrameCount += 1;
        if (this.silentFrameCount > 90 && performance.now() - this.lastAudioSetupAt > 2500) {
          this.setupAudio();
        }
      } else {
        this.silentFrameCount = 0;
      }

      const rms = Math.sqrt(sum / this.timeData.length);
      this.lastRms = rms;
      const index = clamp(Math.floor(this.video.currentTime * BINS_PER_SECOND), 0, this.peaks.length - 1);
      this.peaks[index] = Math.max(this.peaks[index], rms);
    }

    drawFrame() {
      const width = this.canvas.clientWidth || 320;
      const height = getWaveformHeight();
      const ctx = this.ctx;
      if (!ctx) return;

      ctx.clearRect(0, 0, width, height);
      ctx.fillStyle = "rgba(15, 17, 21, 0.48)";
      ctx.fillRect(0, 0, width, height);

      const mid = height / 2;
      const duration = this.video.duration || 0;
      const playedRatio = duration ? clamp(this.video.currentTime / duration, 0, 1) : 0;
      const zoomText = this.zoom > 1 ? ` | ${this.zoom.toFixed(this.zoom < 10 ? 1 : 0)}x` : "";
      this.timeReadout.textContent = `${formatTime(this.video.currentTime)} / ${formatTime(duration)}${zoomText}`;
      const visibleSpan = 1 / this.zoom;
      this.viewportStart = clamp(this.viewportStart, 0, Math.max(0, 1 - visibleSpan));
      const viewportEnd = this.viewportStart + visibleSpan;
      const playedX = width * ((playedRatio - this.viewportStart) / visibleSpan);

      ctx.fillStyle = "rgba(28, 38, 51, 0.56)";
      ctx.fillRect(0, 0, clamp(playedX, 0, width), height);
      this.drawBeatGrid(ctx, width, height, duration, this.viewportStart, visibleSpan);

      const startPeak = Math.floor(this.viewportStart * this.peaks.length);
      const endPeak = Math.max(startPeak + 1, Math.ceil(viewportEnd * this.peaks.length));
      const visiblePeaks = Math.max(1, endPeak - startPeak);
      const step = Math.max(1, Math.ceil(visiblePeaks / width));
      let visibleMaxPeak = 0;
      for (let x = 0; x < width; x += 1) {
        const peakIndex = startPeak + Math.floor((x / width) * visiblePeaks);
        for (let j = 0; j < step; j += 1) {
          visibleMaxPeak = Math.max(visibleMaxPeak, this.peaks[peakIndex + j] || 0);
        }
      }

      const gain = visibleMaxPeak > 0 ? 1 / Math.max(visibleMaxPeak, MIN_VISIBLE_PEAK) : 1;
      const maxBarHeight = Math.max(12, Math.min(MAX_WAVEFORM_BAR_HEIGHT, height - 6));
      for (let x = 0; x < width; x += 1) {
        const peakIndex = startPeak + Math.floor((x / width) * visiblePeaks);
        let peak = 0;
        for (let j = 0; j < step; j += 1) {
          peak = Math.max(peak, this.peaks[peakIndex + j] || 0);
        }
        const bar = clamp(peak * gain * maxBarHeight, 2, maxBarHeight);
        ctx.fillStyle = x <= playedX ? "#61d394" : "#46a3ff";
        ctx.fillRect(x, mid - bar / 2, 1, bar);
      }

      if (playedX >= 0 && playedX <= width) {
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(playedX - 1, 0, 2, height);
      }

      if (this.zoom > 1) {
        const railWidth = Math.max(36, width / this.zoom);
        const railX = this.viewportStart * width;
        ctx.fillStyle = "rgba(255, 255, 255, 0.22)";
        ctx.fillRect(railX, 3, railWidth, 3);
      }

    }

    drawBeatGrid(ctx, width, height, duration, viewportStart, visibleSpan) {
      return;
    }

    seekFromCanvas(event) {
      if (this.isPanning || event.button === 2) return;
      const duration = this.video.duration || 0;
      if (!duration) return;
      const rect = this.canvas.getBoundingClientRect();
      const canvasRatio = clamp((event.clientX - rect.left) / rect.width, 0, 1);
      const ratio = clamp(this.viewportStart + canvasRatio / this.zoom, 0, 1);
      this.setMediaCurrentTime(ratio * duration);
      this.video.play();
    }

    zoomFromWheel(event) {
      if (!event.shiftKey) return;
      event.preventDefault();
      const rect = this.canvas.getBoundingClientRect();
      const cursorRatio = clamp((event.clientX - rect.left) / rect.width, 0, 1);
      const anchorRatio = clamp(this.viewportStart + cursorRatio / this.zoom, 0, 1);
      const zoomFactor = event.deltaY < 0 ? 1.28 : 1 / 1.28;
      const nextZoom = clamp(this.zoom * zoomFactor, 1, MAX_ZOOM);
      this.zoom = nextZoom < 1.03 ? 1 : nextZoom;
      const nextSpan = 1 / this.zoom;
      this.viewportStart = clamp(anchorRatio - cursorRatio * nextSpan, 0, Math.max(0, 1 - nextSpan));
      if (this.zoom === 1) {
        this.viewportStart = 0;
      }
      this.renderMarkers();
      this.renderBpmPins();
      this.drawFrame();
      this.requestHighResolutionWaveformIfNeeded();
    }

    startPan(event) {
      if (event.button !== 2) return;
      event.preventDefault();
      this.rightPointerDown = true;
      this.rightPointerDragged = false;
      this.panStartX = event.clientX;
      this.panStartY = event.clientY;
      this.panStartViewport = this.viewportStart;
      this.contextMenuTime = this.timeFromClientX(event.clientX);
      this.hideContextMenu();
      if (this.zoom > 1) {
        this.isPanning = true;
        this.canvas.classList.add("ysw-panning");
      }
      this.canvas.setPointerCapture?.(event.pointerId);
    }

    panWaveform(event) {
      if (!this.rightPointerDown) return;
      event.preventDefault();
      const moved = Math.hypot(event.clientX - this.panStartX, event.clientY - this.panStartY);
      if (moved > 4) {
        this.rightPointerDragged = true;
      }
      if (!this.isPanning || this.zoom <= 1) return;
      const width = this.canvas.clientWidth || 1;
      const deltaRatio = (event.clientX - this.panStartX) / width / this.zoom;
      const maxStart = Math.max(0, 1 - (1 / this.zoom));
      this.viewportStart = clamp(this.panStartViewport - deltaRatio, 0, maxStart);
      this.renderMarkers();
      this.renderBpmPins();
      this.drawFrame();
    }

    endPan(event) {
      if (!this.rightPointerDown && !this.isPanning) return;
      event.preventDefault();
      const shouldOpenMenu = event.button === 2 && !this.rightPointerDragged;
      this.isPanning = false;
      this.rightPointerDown = false;
      this.canvas.classList.remove("ysw-panning");
      this.canvas.releasePointerCapture?.(event.pointerId);
      if (shouldOpenMenu) {
        this.showContextMenu(event.clientX, event.clientY);
      }
    }

    showContextMenu(clientX, clientY, mode = "waveform") {
      return;
    }

    hideContextMenu() {
      return;
    }

    hideContextMenuOnOutsideClick(event) {
      return;
    }

    async recalculateAnalysisFromContext() {
      return;
    }

    async fetchWaveform(videoUrl, bins, onProgress = null) {
      const endpoints = isDirectMediaUrl(videoUrl) ? DIRECT_WAVEFORM_ENDPOINTS : PREFETCH_ENDPOINTS;
      const requestUrls = endpoints.map((endpoint) => {
        const requestUrl = this.addClientId(endpoint);
        requestUrl.searchParams.set("url", videoUrl);
        requestUrl.searchParams.set("bins", String(bins));
        if (isRadioooooPage()) {
          requestUrl.searchParams.set("title", getRadioooooMetadataParam());
        }
        return requestUrl.toString();
      });

      let response = null;
      let lastRequestUrl = "";
      const failures = [];
      for (const requestUrl of requestUrls) {
        lastRequestUrl = requestUrl;
        try {
          response = await fetchHelperJson(requestUrl, PREFETCH_TIMEOUT_MS, onProgress);
        } catch (error) {
          response = {
            ok: false,
            status: 0,
            statusText: error?.name || "Exception",
            body: { error: error?.message || String(error) }
          };
        }
        if (response?.ok) break;
        failures.push(this.formatPrefetchFailure(response, requestUrl));
      }

      const data = response?.body;
      if (!response?.ok) {
        return {
          ok: false,
          error: failures.join(" / ") || this.formatPrefetchFailure(response, lastRequestUrl)
        };
      }
      if (!Array.isArray(data.peaks) || !data.peaks.length) {
        return {
          ok: false,
          error: "Prefetch failed: helper returned no waveform peaks."
        };
      }
      return { ok: true, data };
    }

    applyWaveformData(data) {
      this.peaks = Float32Array.from(data.peaks.map((value) => clamp(Number(value) || 0, 0, 1)));
      if (isExternalPlayerPage() && Number.isFinite(Number(data.duration))) {
        this.video.duration = Number(data.duration);
      }
      this.prefetchedPeaks = true;
      this.streamingWaveformActive = false;
      this.drawFrame();
    }

    applyStreamingWaveformProgress(progress, requestId, videoUrl) {
      if (
        this.destroyed || this.marchFastMode || requestId !== this.prefetchRequestId || this.currentVideoUrl !== videoUrl ||
        !progress || !Array.isArray(progress.peaks)
      ) return;

      const totalBins = clamp(Math.trunc(Number(progress.totalBins) || 0), 1, HIGH_RES_WAVEFORM_BINS);
      const startBin = clamp(Math.trunc(Number(progress.startBin) || 0), 0, totalBins);
      if (!this.streamingWaveformActive || this.peaks.length !== totalBins || startBin === 0) {
        this.peaks = new Float32Array(totalBins);
        this.streamingWaveformActive = true;
        this.prefetchedPeaks = true;
      }
      const writable = Math.min(progress.peaks.length, totalBins - startBin);
      for (let index = 0; index < writable; index += 1) {
        this.peaks[startBin + index] = clamp(Number(progress.peaks[index]) || 0, 0, 1);
      }
      if (isExternalPlayerPage() && Number.isFinite(Number(progress.duration))) {
        this.video.duration = Number(progress.duration);
      }
      const completedBins = clamp(Math.trunc(Number(progress.completedBins) || 0), 0, totalBins);
      const percent = Math.round((completedBins / totalBins) * 100);
      this.setStatus(`Streaming waveform... ${percent}%`, true);
      this.drawFrame();
    }

    async loadPrefetchedWaveform(knownVideoUrl) {
      if (this.marchFastMode) return false;
      const videoUrl = knownVideoUrl || (isRadioooooPage() ? await waitForRadioooooMediaUrl() : await waitForVideoWatchUrl());
      if (this.marchFastMode) return false;
      if (isResolvedWatchUrl(videoUrl) || isDirectMediaUrl(videoUrl)) {
        this.currentVideoUrl = videoUrl;
        this.pendingPrefetchUrl = videoUrl;
      }
      if (!this.isVisibleSessionEligible()) {
        this.prefetchInProgress = false;
        this.highResWaveformInProgress = false;
        this.updateLoadingIndicator();
        return false;
      }
      if (isRadioooooPage() && !isDirectMediaUrl(videoUrl)) {
        this.setStatus("Waiting for Radiooooo media URL. Start a track if nothing is playing.", true);
        return false;
      }
      if (isExternalYoutubePage() && !isResolvedWatchUrl(videoUrl)) {
        this.setStatus(isCrateDigrsPage()
          ? "Waiting for CrateDigrs to load a playable record..."
          : isSampleRoulettePage()
            ? "Waiting for SampleRoulette to load a playable sample..."
            : "Waiting for Samplette to load a playable selection...", true);
        return false;
      }
      const requestId = ++this.prefetchRequestId;

      this.prefetchComplete = false;
      this.prefetchError = "";
      this.prefetchInProgress = true;
      this.highResWaveformReady = false;
      this.highResWaveformInProgress = false;
      this.highResWaveformUrl = "";
      this.setStatus(this.audioReady ? "Prefetching preview waveform... live waveform active." : "Prefetching preview waveform...", true);

      try {
        if (!await this.ensureHelperSession()) {
          throw new Error("The local helper could not start or Galaktika is not visible.");
        }
        const result = await this.fetchWaveform(videoUrl, PREVIEW_WAVEFORM_BINS, (progress) => {
          this.applyStreamingWaveformProgress(progress, requestId, videoUrl);
        });
        if (this.destroyed || requestId !== this.prefetchRequestId || this.currentVideoUrl !== videoUrl) return false;
        if (!result.ok) {
          this.prefetchComplete = true;
          this.prefetchInProgress = false;
          this.streamingWaveformActive = false;
          this.prefetchedPeaks = false;
          this.ensurePeakBuffer();
          this.prefetchError = result.error;
          this.setStatus(this.prefetchError, true);
          return false;
        }

        const data = result.data;
        if (this.destroyed || requestId !== this.prefetchRequestId || this.currentVideoUrl !== videoUrl) return false;
        this.applyWaveformData(data);
        this.prefetchComplete = true;
        this.prefetchInProgress = false;
        this.prefetchError = "";
        const readyText = data.sampleRate
          ? `Preview waveform ready (${PREVIEW_WAVEFORM_BINS} bins, ${data.sampleRate} Hz).`
          : `Preview waveform ready (${PREVIEW_WAVEFORM_BINS} bins).`;
        this.setStatus(`${readyText} Refining high-res waveform...`, true);
        this.requestHighResolutionWaveformIfNeeded();
        return true;
      } catch (error) {
        this.prefetchComplete = true;
        this.prefetchInProgress = false;
        this.streamingWaveformActive = false;
        this.prefetchedPeaks = false;
        this.ensurePeakBuffer();
        this.prefetchError = error?.name === "AbortError"
          ? "Prefetch failed: request timed out."
          : `Prefetch failed: ${error?.message || String(error)}`;
        this.setStatus(this.prefetchError, true);
        return false;
      }
    }

    async requestHighResolutionWaveformIfNeeded() {
      if (this.marchFastMode || this.prefetchInProgress || !this.prefetchedPeaks || this.highResWaveformReady || this.highResWaveformInProgress) return;
      if (!this.isVisibleSessionEligible()) return;
      const videoUrl = this.currentVideoUrl || (isRadioooooPage() ? await waitForRadioooooMediaUrl() : await waitForVideoWatchUrl());
      if ((!isResolvedWatchUrl(videoUrl) && !isDirectMediaUrl(videoUrl)) || videoUrl !== this.currentVideoUrl) return;

      this.highResWaveformInProgress = true;
      this.highResWaveformUrl = videoUrl;
      this.updateLoadingIndicator();
      this.setStatus(`Refining high-res waveform (${HIGH_RES_WAVEFORM_BINS} bins)...`, true);

      try {
        if (!await this.ensureHelperSession()) return;
        const result = await this.fetchWaveform(videoUrl, HIGH_RES_WAVEFORM_BINS);
        if (this.marchFastMode) return;
        if (!result.ok) {
          this.setStatus(`High-res refinement failed: ${result.error}`, true);
          return;
        }
        if (this.destroyed || this.marchFastMode || this.currentVideoUrl !== videoUrl) return;

        this.applyWaveformData(result.data);
        this.highResWaveformReady = true;
        this.setStatus(`High-res waveform ready (${HIGH_RES_WAVEFORM_BINS} bins).`, true);
      } catch (error) {
        this.setStatus(`High-res refinement failed: ${error?.message || String(error)}`, true);
      } finally {
        this.highResWaveformInProgress = false;
        this.updateLoadingIndicator();
      }
    }

    async fetchSettingsPayload() {
      let response = null;
      let lastRequestUrl = "";
      const failures = [];
      for (const endpoint of SETTINGS_ENDPOINTS) {
        lastRequestUrl = this.addClientId(endpoint).toString();
        response = await fetchHelperJson(lastRequestUrl, HELPER_PROBE_TIMEOUT_MS);
        if (response?.ok) break;
        failures.push(this.formatHelperFailure("Settings", response, lastRequestUrl));
      }
      if (!response?.ok) {
        throw new Error(failures.join(" / ") || this.formatHelperFailure("Settings", response, lastRequestUrl));
      }
      return response.body;
    }

    populateSettings(payload) {
      const settings = payload?.settings || {};
      this.settingsSourceFormat.value = settings.sourceAudioFormat || "";
      this.settingsBestWavFormat.value = settings.bestWavFormat || "";
      this.settingsCookiesBrowser.value = settings.cookiesBrowser || "";
      this.settingsRemoteComponents.value = settings.remoteComponents || "";
      this.settingsPoTokenBrowser.value = settings.poTokenBrowserPath || "auto";
      this.settingsPrefetchCommand.value = payload?.commands?.prefetch || "";
      this.settingsWavCommand.value = payload?.commands?.downloadWav || "";
      if (payload?.validation?.message) {
        this.settingsValidation.textContent = payload.validation.message;
        this.settingsValidation.classList.toggle("ysw-validation-ok", payload.validation.mode !== "unverified");
        this.settingsValidation.classList.remove("ysw-validation-error");
      }
    }

    populateVideoExclusionSettings(settings) {
      this.settingsExcludeLongVideos.checked = settings?.enabled !== false;
      this.settingsLongVideoLimit.value = settings?.limit || DEFAULT_LONG_VIDEO_LIMIT;
      this.settingsLongVideoLimit.disabled = !this.settingsExcludeLongVideos.checked;
    }

    videoExclusionSettingsFromControls(reset = false) {
      const enabled = reset ? DEFAULT_EXCLUDE_LONG_VIDEOS : this.settingsExcludeLongVideos.checked;
      const limit = reset
        ? DEFAULT_LONG_VIDEO_LIMIT
        : enabled || Number.isFinite(parseHourMinuteLimit(this.settingsLongVideoLimit.value))
          ? normalizedHourMinuteLimit(this.settingsLongVideoLimit.value)
          : DEFAULT_LONG_VIDEO_LIMIT;
      return { enabled, limit, seconds: parseHourMinuteLimit(limit) };
    }

    markSettingsUnvalidated() {
      this.settingsValidation.textContent = "Changes have not been validated or saved.";
      this.settingsValidation.classList.remove("ysw-validation-ok", "ysw-validation-error");
    }

    setSettingsBusy(busy) {
      this.settingsResetButton.disabled = busy;
      this.settingsValidateButton.disabled = busy;
      this.settingsSaveButton.disabled = busy;
      this.settingsCloseButton.disabled = busy;
    }

    settingsRequestUrl(endpoint, extra = {}) {
      const requestUrl = this.addClientId(endpoint);
      requestUrl.searchParams.set("sourceAudioFormat", this.settingsSourceFormat.value);
      requestUrl.searchParams.set("bestWavFormat", this.settingsBestWavFormat.value);
      requestUrl.searchParams.set("cookiesBrowser", this.settingsCookiesBrowser.value);
      requestUrl.searchParams.set("remoteComponents", this.settingsRemoteComponents.value);
      requestUrl.searchParams.set("poTokenBrowserPath", this.settingsPoTokenBrowser.value);
      const videoUrl = getVideoWatchUrl();
      if (isResolvedWatchUrl(videoUrl)) requestUrl.searchParams.set("url", videoUrl);
      Object.entries(extra).forEach(([key, value]) => requestUrl.searchParams.set(key, value));
      return requestUrl.toString();
    }

    async validateOrSaveSettings(save, extra = {}) {
      let videoExclusionSettings;
      try {
        videoExclusionSettings = this.videoExclusionSettingsFromControls(extra.reset === "1");
      } catch (error) {
        const message = error?.message || String(error);
        this.settingsValidation.textContent = `${message} Nothing was saved.`;
        this.settingsValidation.classList.add("ysw-validation-error");
        this.setStatus(`${save ? "Settings save" : "Settings validation"} failed: ${message}`, true);
        return false;
      }
      if (!await this.ensureHelperSession()) {
        this.settingsValidation.textContent = `${save ? "Save" : "Validation"} could not start because the helper is unavailable or Galaktika is not visible.`;
        this.settingsValidation.classList.add("ysw-validation-error");
        return false;
      }

      this.setSettingsBusy(true);
      this.settingsValidation.textContent = save
        ? "Saving settings without command verification..."
        : "Validating commands...";
      this.settingsValidation.classList.remove("ysw-validation-ok", "ysw-validation-error");
      const endpoints = save ? SET_SETTINGS_ENDPOINTS : VALIDATE_SETTINGS_ENDPOINTS;
      const failures = [];
      try {
        for (const endpoint of endpoints) {
          const requestUrl = this.settingsRequestUrl(endpoint, extra);
          const response = await fetchHelperJson(requestUrl, SETTINGS_VALIDATION_TIMEOUT_MS);
          if (response?.ok) {
            if (save) {
              await browser.storage.local.set({
                [EXCLUDE_LONG_VIDEOS_KEY]: videoExclusionSettings.enabled,
                [LONG_VIDEO_LIMIT_KEY]: videoExclusionSettings.limit
              });
            }
            this.populateSettings(response.body);
            this.populateVideoExclusionSettings(videoExclusionSettings);
            this.setStatus(save ? "Settings saved without command verification." : "yt-dlp commands validated; settings were not saved.", true);
            return true;
          }
          failures.push(response?.body?.error || response?.statusText || "Unknown validation error");
        }
        const message = failures.join(" / ") || (save ? "Settings could not be saved." : "Command validation failed.");
        this.settingsValidation.textContent = `${message} Nothing was saved.`;
        this.settingsValidation.classList.add("ysw-validation-error");
        this.setStatus(`${save ? "Settings save" : "Settings validation"} failed: ${message}`, true);
        return false;
      } catch (error) {
        const message = error?.message || String(error);
        this.settingsValidation.textContent = `${message} Nothing was saved.`;
        this.settingsValidation.classList.add("ysw-validation-error");
        this.setStatus(`${save ? "Settings save" : "Settings validation"} failed: ${message}`, true);
        return false;
      } finally {
        this.setSettingsBusy(false);
      }
    }

    async resetSettings() {
      await this.validateOrSaveSettings(true, { reset: "1" });
    }

    async toggleSettingsPanel() {
      if (!this.settingsPanel.hidden) {
        this.hideSettingsPanel();
        return;
      }

      this.settingsPanel.hidden = false;
      this.markSettingsUnvalidated();
      this.setStatus("Loading settings...", true);
      try {
        const [helperSettings, videoExclusionSettings] = await Promise.all([
          this.fetchSettingsPayload(),
          readVideoExclusionSettings()
        ]);
        this.populateSettings(helperSettings);
        this.populateVideoExclusionSettings(videoExclusionSettings);
        this.setStatus("Settings loaded.", true);
      } catch (error) {
        this.setStatus(`Settings failed: ${error?.message || String(error)}`, true);
      }
    }

    hideSettingsPanel() {
      this.settingsPanel.hidden = true;
    }

    formatLabel(format) {
      return format === "og" ? "OG" : format === "aac" ? "M4A" : String(format || "").toUpperCase();
    }

    updateMarchUi() {
      this.marchButton.textContent = this.marchActive ? "STOP" : this.marchAwaitingFormat ? "PICK" : "MARCH";
      this.marchButton.classList.toggle("ysw-march-active", this.marchActive);
      this.marchButton.classList.toggle("ysw-march-armed", this.marchAwaitingFormat);
      this.marchSkipButton.hidden = !this.marchActive;
      this.marchSkipButton.disabled = !this.marchActive || this.marchSkipRequested;
      const formatButtons = {
        og: this.downloadOriginalButton,
        wav: this.downloadButton,
        mp3: this.downloadMp3Button,
        aac: this.downloadAacButton,
        mp4: this.downloadMp4Button,
        game: this.downloadGameButton
      };
      for (const [format, button] of Object.entries(formatButtons)) {
        button?.classList.toggle("ysw-march-default", this.marchActive && format === this.marchDefaultFormat);
      }
    }

    async enterMarchFastMode() {
      if (this.marchFastMode) return;
      this.marchFastMode = true;
      this.root.classList.add("ysw-march-mode");
      this.prefetchRequestId += 1;
      this.prefetchInProgress = false;
      this.highResWaveformInProgress = false;
      this.streamingWaveformActive = false;
      this.stopLiveAudioProcessing();
      this.updateLoadingIndicator();
      try {
        await sendRuntimeMessage({ type: "ysw:cancel-waveform-work" });
      } catch (_) {
        // The download can still start if there was no active waveform request.
      }
    }

    leaveMarchFastMode() {
      if (!this.marchFastMode) return;
      this.marchFastMode = false;
      this.root.classList.remove("ysw-march-mode");
      if (this.destroyed || this.collapsed || document.hidden) return;
      this.setupAudio();
      const videoUrl = this.pendingPrefetchUrl || this.currentVideoUrl || getVideoWatchUrl();
      if (!this.prefetchedPeaks && (isResolvedWatchUrl(videoUrl) || isDirectMediaUrl(videoUrl))) {
        void this.loadPrefetchedWaveform(videoUrl);
      } else if (this.prefetchedPeaks && !this.highResWaveformReady) {
        void this.requestHighResolutionWaveformIfNeeded();
      }
    }

    persistMarchState(previousUrl = "") {
      if (!this.marchActive) return;
      try {
        sessionStorage.setItem(MARCH_SESSION_KEY, JSON.stringify({
          active: true,
          origin: location.origin,
          format: this.marchDefaultFormat,
          directory: this.marchDirectory,
          previousUrl,
          pendingOverrides: this.marchPendingOverrides
        }));
      } catch (_) {
        // Session persistence is a convenience for Samplette's full-page navigation.
      }
    }

    async restoreMarchState() {
      if (!isMarchSupportedPage() || this.marchActive || this.marchAwaitingFormat || this.destroyed) return;
      let saved = null;
      try {
        saved = JSON.parse(sessionStorage.getItem(MARCH_SESSION_KEY) || "null");
      } catch (_) {
        saved = null;
      }
      if (!saved?.active || saved.origin !== location.origin || !/^(og|wav|mp3|aac|mp4|game)$/.test(saved.format || "")) return;
      this.marchDefaultFormat = saved.format;
      this.marchDirectory = String(saved.directory || "");
      this.marchPendingOverrides = Array.isArray(saved.pendingOverrides)
        ? saved.pendingOverrides.filter((format) => /^(og|wav|mp3|aac|mp4|game)$/.test(format))
        : [];
      this.marchActive = true;
      const token = ++this.marchRunToken;
      this.updateMarchUi();
      this.setStatus(`MARCH resumed: ${this.formatLabel(saved.format)} files will be saved in ${this.marchDirectory}.`, true);
      await this.enterMarchFastMode();
      void this.runMarch(token, String(saved.previousUrl || ""));
    }

    toggleMarch() {
      if (!isMarchSupportedPage()) {
        this.setStatus("MARCH is available on YouTube playlists, CrateDigrs, SampleRoulette, and Samplette.", true);
        return;
      }
      if (this.marchActive || this.marchAwaitingFormat) {
        this.stopMarch(this.downloadInProgress ? "MARCH will stop after the current download." : "MARCH stopped.");
        return;
      }
      this.marchAwaitingFormat = true;
      this.updateMarchUi();
      this.setStatus("MARCH armed. Choose the format to repeat.", true);
    }

    async skipMarchItem() {
      if (!this.marchActive || this.marchSkipRequested) return;
      this.marchSkipRequested = true;
      this.marchCurrentOverrides = [];
      this.marchPendingOverrides = [];
      this.updateMarchUi();
      this.setStatus(this.downloadInProgress
        ? "Skipping current item: cancelling its download and cleaning up files..."
        : "Skipping current item...", true);
      await this.cancelAndCleanSkippedMarchItem();
    }

    async cancelAndCleanSkippedMarchItem() {
      try {
        await sendRuntimeMessage({
          type: "ysw:skip-march-download",
          paths: [...this.marchCurrentSavedPaths]
        });
      } catch (_) {
        // The loop still advances if no native download had started yet.
      }
    }

    async handleFormatClick(format) {
      if (this.marchAwaitingFormat) {
        await this.startMarch(format);
        return;
      }
      if (this.marchActive) {
        const queue = this.marchAcceptingOverrides ? this.marchCurrentOverrides : this.marchPendingOverrides;
        if (!queue.includes(format)) queue.push(format);
        this.persistMarchState();
        this.setStatus(`${this.formatLabel(format)} queued once for the current MARCH record; ${this.formatLabel(this.marchDefaultFormat)} remains the default.`, true);
        return;
      }
      if (format === "wav") {
        await this.downloadBestWav();
      } else {
        await this.downloadYoutubeFormat(format);
      }
    }

    async startMarch(format) {
      this.marchAwaitingFormat = false;
      this.marchDefaultFormat = format;
      this.updateMarchUi();
      this.setStatus(`Choose the folder for ${this.formatLabel(format)} MARCH downloads...`, true);
      const directory = await this.chooseMarchDirectory();
      if (!directory || this.destroyed) {
        this.marchDefaultFormat = "";
        this.updateMarchUi();
        return;
      }
      this.marchDirectory = directory;
      this.marchActive = true;
      this.marchCurrentOverrides = [];
      this.marchCurrentSavedPaths = [];
      this.marchPendingOverrides = [];
      this.marchSkipRequested = false;
      const token = ++this.marchRunToken;
      this.updateMarchUi();
      this.persistMarchState();
      this.setStatus(`MARCH started in fast-download mode: ${this.formatLabel(format)} files will be saved in ${directory}.`, true);
      await this.enterMarchFastMode();
      void this.runMarch(token);
    }

    stopMarch(message = "MARCH stopped.") {
      this.marchActive = false;
      this.marchAwaitingFormat = false;
      this.marchAcceptingOverrides = false;
      this.marchRunToken += 1;
      this.marchPendingOverrides = [];
      this.marchSkipRequested = false;
      try { sessionStorage.removeItem(MARCH_SESSION_KEY); } catch (_) { /* Storage can be disabled. */ }
      this.updateMarchUi();
      this.setStatus(message, true);
      if (!this.downloadInProgress) this.leaveMarchFastMode();
    }

    async chooseMarchDirectory() {
      if (!await this.ensureHelperSession()) {
        this.setStatus("MARCH could not open the folder picker because the helper is unavailable.", true);
        return "";
      }
      let response = null;
      let lastRequestUrl = "";
      const failures = [];
      for (const endpoint of CHOOSE_DOWNLOAD_DIR_ENDPOINTS) {
        const requestUrl = this.addClientId(endpoint);
        lastRequestUrl = requestUrl.toString();
        response = await fetchHelperJson(lastRequestUrl, DIRECTORY_PICKER_TIMEOUT_MS);
        if (response?.ok) break;
        if (response?.body?.cancelled) break;
        failures.push(this.formatHelperFailure("MARCH folder picker", response, lastRequestUrl));
      }
      if (response?.body?.cancelled) {
        this.setStatus("MARCH cancelled before starting.", true);
        return "";
      }
      if (!response?.ok) {
        this.setStatus(failures.join(" / ") || this.formatHelperFailure("MARCH folder picker", response, lastRequestUrl), true);
        return "";
      }
      return String(response.body.downloadDir || "");
    }

    currentMarchTrack() {
      const videoUrl = getVideoWatchUrl();
      if (!isResolvedWatchUrl(videoUrl)) return null;
      if (!isYoutubePlaylistPage()) return { url: videoUrl, key: videoUrl };
      const pageUrl = new URL(location.href);
      const playlistId = pageUrl.searchParams.get("list") || "";
      const videoId = new URL(videoUrl).searchParams.get("v") || "";
      const selectedIndex = [...document.querySelectorAll("ytd-playlist-panel-video-renderer")]
        .findIndex((item) => item.hasAttribute("selected") || item.getAttribute("aria-current") === "true");
      const playlistIndex = pageUrl.searchParams.get("index") || (selectedIndex >= 0 ? String(selectedIndex + 1) : "1");
      return { url: videoUrl, key: `${playlistId}:${playlistIndex}:${videoId}` };
    }

    async waitForMarchTrack(previousKey, token) {
      for (let attempt = 0; attempt < 160; attempt += 1) {
        if (!this.marchActive || token !== this.marchRunToken || this.destroyed) return "";
        const track = this.currentMarchTrack();
        if (track && (!previousKey || track.key !== previousKey)) return track;
        await wait(250);
      }
      return null;
    }

    advanceMarchTrack() {
      let button = null;
      if (isYoutubePlaylistPage()) {
        const items = [...document.querySelectorAll("ytd-playlist-panel-video-renderer")];
        const selectedIndex = items.findIndex((item) => item.hasAttribute("selected") || item.getAttribute("aria-current") === "true");
        if (selectedIndex >= 0 && selectedIndex >= items.length - 1) return "finished";
        const nextPlaylistLink = selectedIndex >= 0 ? items[selectedIndex + 1]?.querySelector("a#wc-endpoint") : null;
        if (nextPlaylistLink) {
          nextPlaylistLink.click();
          return "advanced";
        }

        const player = document.querySelector("#movie_player");
        try {
          const playlist = player?.getPlaylist?.() || [];
          const index = Number(player?.getPlaylistIndex?.());
          if (playlist.length && Number.isFinite(index) && index >= playlist.length - 1) return "finished";
        } catch (_) {
          // The player API is optional; the visible Next control is the fallback.
        }
        button = document.querySelector('.ytp-next-button[aria-disabled="false"], .ytp-next-button:not([aria-disabled="true"])');
      } else if (isCrateDigrsPage()) {
        button = [...document.querySelectorAll("button")].find((candidate) => /shuffle\s*\/\s*next record/i.test(candidate.textContent || ""));
      } else if (isSampleRoulettePage()) {
        button = [...document.querySelectorAll("button")].find((candidate) => /next sample/i.test(candidate.textContent || ""));
      } else if (isSamplettePage()) {
        button = document.querySelector("#samplette-btn");
      }
      if (!button || button.disabled || button.getAttribute?.("aria-disabled") === "true") return "missing";
      button.click();
      return "advanced";
    }

    advanceMarchAfterItem(track, skipped = false) {
      this.marchAcceptingOverrides = false;
      this.marchSkipRequested = false;
      this.marchCurrentOverrides = [];
      this.marchCurrentSavedPaths = [];
      this.updateMarchUi();
      this.setStatus(skipped
        ? "MARCH item skipped and cleaned up. Loading the next item..."
        : "MARCH download complete. Loading the next item...", true);
      this.persistMarchState(track.key);
      const advanceResult = this.advanceMarchTrack();
      if (advanceResult === "finished") {
        this.stopMarch("MARCH complete: the end of the YouTube playlist was reached.");
        return false;
      }
      if (advanceResult !== "advanced") {
        this.stopMarch("MARCH stopped: Galaktika could not find the control for the next item.");
        return false;
      }
      return true;
    }

    async runMarch(token, previousKey = "") {
      try {
        while (this.marchActive && token === this.marchRunToken && !this.destroyed) {
          const track = await this.waitForMarchTrack(previousKey, token);
          if (!track) {
            if (this.marchActive && token === this.marchRunToken) this.stopMarch("MARCH stopped: the next playable item did not appear.");
            return;
          }
          const videoUrl = track.url;

          if (this.marchSkipRequested) {
            await this.cancelAndCleanSkippedMarchItem();
            previousKey = track.key;
            if (!this.advanceMarchAfterItem(track, true)) return;
            continue;
          }

          this.marchCurrentUrl = videoUrl;
          this.marchCurrentSavedPaths = [];
          this.marchCurrentOverrides = this.marchPendingOverrides.splice(0);
          this.marchAcceptingOverrides = true;
          const baseFormat = this.marchDefaultFormat;
          const baseSucceeded = await this.downloadYoutubeFormat(baseFormat, {
            skipPicker: true,
            videoUrl,
            march: true
          });
          if (this.marchSkipRequested) {
            await this.cancelAndCleanSkippedMarchItem();
            previousKey = track.key;
            if (!this.advanceMarchAfterItem(track, true)) return;
            continue;
          }
          if (!baseSucceeded) {
            if (this.marchActive && token === this.marchRunToken) this.stopMarch(`MARCH stopped because the ${this.formatLabel(baseFormat)} download failed.`);
            return;
          }
          if (!this.marchActive || token !== this.marchRunToken) {
            this.setStatus("MARCH stopped after the current download completed.", true);
            this.leaveMarchFastMode();
            return;
          }

          while (this.marchActive && token === this.marchRunToken && this.marchCurrentOverrides.length) {
            const overrideFormat = this.marchCurrentOverrides.shift();
            const overrideSucceeded = await this.downloadYoutubeFormat(overrideFormat, {
              skipPicker: true,
              videoUrl,
              march: true
            });
            if (this.marchSkipRequested) break;
            if (!overrideSucceeded) {
              this.stopMarch(`MARCH stopped because the one-time ${this.formatLabel(overrideFormat)} download failed.`);
              return;
            }
          }

          if (this.marchSkipRequested) {
            await this.cancelAndCleanSkippedMarchItem();
            previousKey = track.key;
            if (!this.advanceMarchAfterItem(track, true)) return;
            continue;
          }

          if (!this.marchActive || token !== this.marchRunToken) return;
          previousKey = track.key;
          if (!this.advanceMarchAfterItem(track, false)) return;
        }
      } catch (error) {
        if (this.marchActive && token === this.marchRunToken) {
          this.stopMarch(`MARCH stopped: ${error?.message || String(error)}`);
        }
      } finally {
        this.marchAcceptingOverrides = false;
        if (!this.marchActive && !this.downloadInProgress) this.leaveMarchFastMode();
      }
    }

    setDownloadButtonsBusy(busy) {
      for (const button of this.downloadButtons) {
        if (button) button.disabled = this.marchActive ? false : busy;
      }
    }

    markerTimesForDownload() {
      return this.markers
        .map((marker) => Number(marker.time))
        .filter((time) => Number.isFinite(time) && time >= 0)
        .sort((a, b) => a - b);
    }

    applyDownloadProgress(progress, label) {
      if (!this.downloadInProgress || !progress) return;
      const percent = clamp(Number(progress.percent) || 0, 0, 100);
      this.downloadProgress = percent;
      this.updateLoadingIndicator();
      const phase = progress.phase === "convert" ? "Converting" : "Downloading";
      this.setStatus(`${phase} ${label}... ${Math.round(percent)}%`, true);
    }

    async downloadBestWav() {
      this.setDownloadButtonsBusy(true);
      if (isRadioooooPage()) {
        const selectedPath = await this.chooseDownloadFile(getRadioooooDownloadFilename(), mediaExtensionFromUrl(getLatestRadioooooMediaUrl()));
        if (!selectedPath) {
          this.setDownloadButtonsBusy(false);
          return;
        }
        this.downloadInProgress = true;
        this.updateLoadingIndicator();
        try {
          await this.downloadDirectMedia(selectedPath);
        } catch (error) {
          this.setStatus(`Direct download failed: ${error?.message || String(error)}`, true);
        } finally {
          this.downloadInProgress = false;
          this.updateLoadingIndicator();
          this.setDownloadButtonsBusy(false);
        }
        return;
      }
      await this.downloadYoutubeFormat("wav");
    }

    async downloadYoutubeFormat(format, options = {}) {
      const skipPicker = options.skipPicker === true;
      const requestedVideoUrl = String(options.videoUrl || "");
      if (isRadioooooPage()) {
        this.setStatus(`${format.toUpperCase()} downloads are only available for YouTube right now.`, true);
        return false;
      }

      let videoUrl = requestedVideoUrl;
      let extension = format === "game" ? ".mp4" : format === "aac" ? ".m4a" : `.${format}`;
      let defaultName = format === "game"
        ? `${abbreviateVideoTitle(sanitizeDownloadName(document.title || "YouTube media"))}${extension}`
        : format === "aac"
          ? `${abbreviateVideoTitle(sanitizeDownloadName(document.title || "YouTube media"))}${extension}`
        : `${sanitizeDownloadName(document.title || "YouTube media")}${extension}`;
      if ((format === "game" || format === "aac") && !skipPicker) {
        if (!await this.ensureHelperSession()) {
          this.setStatus(`${this.formatLabel(format)} download blocked: Galaktika is not visible or the helper is unavailable.`, true);
          return false;
        }
        videoUrl = await waitForVideoWatchUrl();
        this.setStatus("Reading the source video title for the abbreviated filename...", true);
        let titleResponse = null;
        const titleFailures = [];
        for (const endpoint of ORIGINAL_INFO_ENDPOINTS) {
          const requestUrl = this.addClientId(endpoint);
          requestUrl.searchParams.set("url", videoUrl);
          titleResponse = await fetchHelperJson(requestUrl.toString(), SETTINGS_VALIDATION_TIMEOUT_MS);
          if (titleResponse?.ok) break;
          titleFailures.push(this.formatHelperFailure("Video title check", titleResponse, requestUrl.toString()));
        }
        if (!titleResponse?.ok) {
          this.setStatus(titleFailures.join(" / ") || "Could not read the source video title.", true);
          return false;
        }
        defaultName = `${abbreviateVideoTitle(titleResponse.body?.title || "YouTube video")}${extension}`;
      }
      if (format === "og" && !skipPicker) {
        if (!await this.ensureHelperSession()) {
          this.setStatus("OG download blocked: Galaktika is not visible or the helper is unavailable.", true);
          return false;
        }
        videoUrl = await waitForVideoWatchUrl();
        this.setStatus("Detecting the original YouTube audio format...", true);
        let infoResponse = null;
        const infoFailures = [];
        for (const endpoint of ORIGINAL_INFO_ENDPOINTS) {
          const requestUrl = this.addClientId(endpoint);
          requestUrl.searchParams.set("url", videoUrl);
          infoResponse = await fetchHelperJson(requestUrl.toString(), SETTINGS_VALIDATION_TIMEOUT_MS);
          if (infoResponse?.ok) break;
          infoFailures.push(this.formatHelperFailure("Original format check", infoResponse, requestUrl.toString()));
        }
        if (!infoResponse?.ok) {
          this.setStatus(infoFailures.join(" / ") || "Could not detect the original YouTube audio format.", true);
          return false;
        }
        const info = infoResponse.body || {};
        extension = /^\.[a-z0-9]{1,10}$/i.test(info.extension || "") ? info.extension.toLowerCase() : ".webm";
        defaultName = info.suggestedFilename || `${sanitizeDownloadName(info.title || document.title || "YouTube original audio")}${extension}`;
        this.setStatus(`Original source: ${info.audioCodec || "audio"} in ${extension.slice(1).toUpperCase()}.`, true);
      }

      let selectedPath = "";
      if (!skipPicker) {
        selectedPath = await this.chooseDownloadFile(defaultName, extension);
        if (!selectedPath) {
          this.setDownloadButtonsBusy(false);
          return false;
        }
      }

      this.setDownloadButtonsBusy(true);
      if (!videoUrl) videoUrl = await waitForVideoWatchUrl();
      const endpoints = format === "mp3"
        ? MP3_DOWNLOAD_ENDPOINTS
        : format === "og"
          ? ORIGINAL_DOWNLOAD_ENDPOINTS
        : format === "mp4"
          ? MP4_DOWNLOAD_ENDPOINTS
          : format === "game"
            ? GAME_DOWNLOAD_ENDPOINTS
            : format === "aac"
              ? AAC_DOWNLOAD_ENDPOINTS
          : WAV_DOWNLOAD_ENDPOINTS;
      const label = format === "og" ? "OG" : format.toUpperCase();
      const requestUrls = endpoints.map((endpoint) => {
        const requestUrl = this.addClientId(endpoint);
        requestUrl.searchParams.set("url", videoUrl);
        if (options.march) requestUrl.searchParams.set("march", "true");
        if (selectedPath) requestUrl.searchParams.set("outputPath", selectedPath);
        const markerTimes = format === "wav" ? this.markerTimesForDownload() : [];
        if (markerTimes.length) {
          requestUrl.searchParams.set("markers", JSON.stringify(markerTimes));
        }
        return requestUrl.toString();
      });

      const destination = selectedPath || this.marchDirectory || "the configured download folder";
      this.setStatus(`Downloading ${label} to ${destination}...`, true);
      this.downloadInProgress = true;
      this.downloadProgress = null;
      this.updateLoadingIndicator();

      try {
        let response = null;
        let lastRequestUrl = "";
        const failures = [];
        for (const requestUrl of requestUrls) {
          lastRequestUrl = requestUrl;
          response = await fetchHelperJson(
            requestUrl,
            PREFETCH_TIMEOUT_MS,
            (progress) => this.applyDownloadProgress(progress, label)
          );
          if (response?.ok) break;
          failures.push(this.formatHelperFailure(`${label} download`, response, requestUrl));
        }

        const data = response?.body;
        if (!response?.ok) {
          if (options.march && this.marchSkipRequested) return false;
          this.setStatus(failures.join(" / ") || this.formatHelperFailure(`${label} download`, response, lastRequestUrl), true);
          return false;
        }

        this.setStatus(`${label} saved: ${data.filename || data.path || "download complete"}`, true);
        if (options.march && data.path && !this.marchCurrentSavedPaths.includes(data.path)) {
          this.marchCurrentSavedPaths.push(data.path);
        }
        return true;
      } catch (error) {
        this.setStatus(`${label} download failed: ${error?.message || String(error)}`, true);
        return false;
      } finally {
        this.downloadInProgress = false;
        this.downloadProgress = null;
        this.updateLoadingIndicator();
        this.setDownloadButtonsBusy(false);
      }
    }

    async downloadDirectMedia(selectedPath) {
      const mediaUrl = this.currentVideoUrl || getLatestRadioooooMediaUrl();
      if (!isDirectMediaUrl(mediaUrl)) {
        this.setStatus("Direct download failed: no Radiooooo media URL detected yet.", true);
        return;
      }

      const requestUrls = DIRECT_DOWNLOAD_ENDPOINTS.map((endpoint) => {
        const requestUrl = this.addClientId(endpoint);
        requestUrl.searchParams.set("url", mediaUrl);
        requestUrl.searchParams.set("title", getRadioooooMetadataParam());
        requestUrl.searchParams.set("outputPath", selectedPath);
        return requestUrl.toString();
      });

      this.setStatus(`Downloading Radiooooo source file to ${selectedPath}...`, true);
      let response = null;
      let lastRequestUrl = "";
      const failures = [];
      for (const requestUrl of requestUrls) {
        lastRequestUrl = requestUrl;
        response = await fetchHelperJson(requestUrl, PREFETCH_TIMEOUT_MS);
        if (response?.ok) break;
        failures.push(this.formatHelperFailure("Direct download", response, requestUrl));
      }

      if (!response?.ok) {
        this.setStatus(failures.join(" / ") || this.formatHelperFailure("Direct download", response, lastRequestUrl), true);
        return;
      }

      const data = response.body || {};
      this.setStatus(`Radiooooo file saved: ${data.filename || data.path || "download complete"}`, true);
    }

    async chooseDownloadFile(defaultName, extension) {
      try {
        if (!await this.ensureHelperSession()) {
          this.setStatus("Save dialog blocked: Galaktika is not visible or the helper is unavailable.", true);
          return "";
        }
        let response = null;
        let lastRequestUrl = "";
        const failures = [];
        for (const endpoint of CHOOSE_DOWNLOAD_FILE_ENDPOINTS) {
          const requestUrl = this.addClientId(endpoint);
          requestUrl.searchParams.set("name", defaultName || "Galaktika download");
          requestUrl.searchParams.set("extension", extension || ".wav");
          lastRequestUrl = requestUrl.toString();
          response = await fetchHelperJson(lastRequestUrl, DIRECTORY_PICKER_TIMEOUT_MS);
          if (response?.ok) break;
          failures.push(this.formatHelperFailure("Save dialog", response, lastRequestUrl));
        }

        if (response?.body?.cancelled) {
          this.setStatus("Download cancelled.", true);
          return "";
        }

        if (!response?.ok) {
          this.setStatus(failures.join(" / ") || this.formatHelperFailure("Save dialog", response, lastRequestUrl), true);
          return "";
        }

        return response.body.outputPath || "";
      } catch (error) {
        this.setStatus(`Save dialog failed: ${error?.message || String(error)}`, true);
        return "";
      }
    }
  }

  async function init() {
    clearTimeout(initTimer);
    initTimer = 0;

    if (!extensionEnabled || !await readEnabledSetting()) {
      app?.destroy();
      app = null;
      removeLongVideoNotice();
      return;
    }

    if (!isSupportedPage()) {
      app?.destroy();
      app = null;
      removeLongVideoNotice();
      return;
    }
    if (isExternalPlayerPage() && !document.body) {
      initTimer = window.setTimeout(init, INIT_RETRY_MS);
      return;
    }

    const found = await waitForVideo();
    if (!found) {
      initTimer = window.setTimeout(init, INIT_RETRY_MS);
      return;
    }
    if (!isRadioooooPage()) {
      const exclusion = await readVideoExclusionSettings();
      if (exclusion.enabled) {
        const duration = await resolveVideoDuration(found.video);
        if (duration > exclusion.seconds) {
          const videoKey = currentVideoKey();
          longVideoExcludedKey = videoKey;
          if (longVideoOverrideKey === videoKey) {
            excludedPageUrl = "";
          } else {
            app?.destroy();
            app = null;
            excludedPageUrl = location.href;
            showLongVideoNotice(videoKey, duration, exclusion.limit);
            return;
          }
        } else {
          longVideoExcludedKey = "";
          removeLongVideoNotice();
        }
      } else {
        longVideoExcludedKey = "";
        removeLongVideoNotice();
      }
    } else {
      longVideoExcludedKey = "";
      removeLongVideoNotice();
    }
    excludedPageUrl = "";
    if (!isEmbedPage() && !isExternalPlayerPage() && !getNativeTitleAnchor() && !getNativeInsertionAnchor()) {
      initTimer = window.setTimeout(init, INIT_RETRY_MS);
      return;
    }
    if (app && app.video === found.video && app.root.isConnected) {
      app.repairVisibility();
      app.resize();
      const detectedUrl = getVideoWatchUrl();
      if ((isResolvedWatchUrl(detectedUrl) || isDirectMediaUrl(detectedUrl)) && detectedUrl !== app.currentVideoUrl) {
        app.resetWaveformForNewVideo(detectedUrl);
        app.setupAudio();
        if (!app.collapsed && !document.hidden) {
          app.loadPrefetchedWaveform(detectedUrl);
        }
      }
      return;
    }
    app?.destroy();
    removeLongVideoNotice();
    app = new WaveformApp(found.host, found.video);
    app.mount();
    if (!app.collapsed && !document.hidden) {
      app.loadPrefetchedWaveform();
    }
  }

  function scheduleInit(delay = 250) {
    if (initTimer) return;
    initTimer = window.setTimeout(init, delay);
  }

  const navigationObserver = new MutationObserver(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      excludedPageUrl = "";
      removeLongVideoNotice();
      scheduleInit(600);
      return;
    }
    if (isSupportedPage() && (!app || !app.root.isConnected)) {
      scheduleInit(500);
    }
  });

  navigationObserver.observe(document.documentElement, { childList: true, subtree: true });
  window.setInterval(() => {
    if (!extensionEnabled || !isSupportedPage()) return;
    if (!app || !app.root.isConnected) {
      if (excludedPageUrl === location.href) return;
      scheduleInit(0);
      return;
    }
    app.repairVisibility();
  }, 1500);

  browser.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local") return;
    if (changes[ENABLED_KEY]) {
      extensionEnabled = changes[ENABLED_KEY].newValue !== false;
      if (!extensionEnabled) {
        clearTimeout(initTimer);
        initTimer = 0;
        app?.destroy();
        app = null;
        removeLongVideoNotice();
        return;
      }
    }
    if (changes[ENABLED_KEY] || changes[EXCLUDE_LONG_VIDEOS_KEY] || changes[LONG_VIDEO_LIMIT_KEY]) {
      excludedPageUrl = "";
      app?.destroy();
      app = null;
      scheduleInit(0);
    }
  });

  readEnabledSetting().then((enabled) => {
    if (enabled) scheduleInit(0);
  });
})();
