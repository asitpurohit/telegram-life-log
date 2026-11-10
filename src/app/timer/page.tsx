"use client";

import { useEffect, useRef, useState, Suspense, useCallback } from "react";
import { useSearchParams } from "next/navigation";

declare global {
  interface Window {
    Telegram?: {
      WebApp?: {
        ready: () => void;
        expand: () => void;
        close: () => void;
        openLink?: (url: string, options?: { try_instant_view?: boolean }) => void;
        initData?: string;
        platform?: string;
        isExpanded: boolean;
        HapticFeedback?: {
          impactOccurred: (style: "light" | "medium" | "heavy" | "rigid" | "soft") => void;
          notificationOccurred: (type: "error" | "success" | "warning") => void;
        };
        initDataUnsafe?: {
          user?: {
            id: number;
            first_name?: string;
            username?: string;
          };
        };
        themeParams?: Record<string, string>;
      };
    };
  }
}

interface ActiveData {
  taskName: string;
  projectName: string | null;
  projectProgress: string | null;
  todoTitle: string | null;
  startedAt: string;
  isPomodoro: boolean;
  autoAdvance?: boolean;
  beepEnabled?: boolean;
  workMins: number;
  breakMins: number;
  round: number;
  phase: "work" | "break" | "awaiting_break" | "awaiting_round";
  phaseStartedAt: string;
  isPaused: boolean;
  pausedSeconds: number;
  pausedAt: number | null;
}

function formatClockTime(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);

  if (h > 0) {
    return `${h.toString().padStart(2, "0")}:${m.toString().padStart(2, "0")}:${s
      .toString()
      .padStart(2, "0")}`;
  }
  return `${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
}

function playAudioAlert(type: "milestone" | "celebration" | "alarm") {
  try {
    const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();
    const now = ctx.currentTime;

    if (type === "milestone") {
      // Gentle soft crystalline chime for 5-minute milestones
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.setValueAtTime(659.25, now); // E5
      gain.gain.setValueAtTime(0.18, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.45);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now);
      osc.stop(now + 0.45);
    } else if (type === "celebration") {
      // Warm uplifting 2-tone chime for focus completion
      const osc1 = ctx.createOscillator();
      const gain1 = ctx.createGain();
      osc1.type = "sine";
      osc1.frequency.setValueAtTime(587.33, now); // D5
      gain1.gain.setValueAtTime(0.2, now);
      gain1.gain.exponentialRampToValueAtTime(0.001, now + 0.4);
      osc1.connect(gain1);
      gain1.connect(ctx.destination);
      osc1.start(now);
      osc1.stop(now + 0.4);

      const osc2 = ctx.createOscillator();
      const gain2 = ctx.createGain();
      osc2.type = "sine";
      osc2.frequency.setValueAtTime(880, now + 0.16); // A5
      gain2.gain.setValueAtTime(0.25, now + 0.16);
      gain2.gain.exponentialRampToValueAtTime(0.001, now + 0.65);
      osc2.connect(gain2);
      gain2.connect(ctx.destination);
      osc2.start(now + 0.16);
      osc2.stop(now + 0.65);
    } else {
      // Triple alert tone for break completion
      [0, 0.14, 0.28].forEach((offset, idx) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = "triangle";
        osc.frequency.setValueAtTime(idx === 2 ? 880 : 740, now + offset);
        gain.gain.setValueAtTime(0.22, now + offset);
        gain.gain.exponentialRampToValueAtTime(0.001, now + offset + 0.12);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(now + offset);
        osc.stop(now + offset + 0.12);
      });
    }
  } catch {}
}

function triggerHaptic(style: "light" | "medium" | "heavy" = "medium") {
  try {
    window.Telegram?.WebApp?.HapticFeedback?.impactOccurred(style);
  } catch {}
}

function getTaskVisualIcon(taskName: string): string {
  const trimmed = taskName.trim();
  if (/^(\p{Extended_Pictographic}|\p{Emoji_Presentation})/u.test(trimmed)) {
    return "";
  }
  const lower = trimmed.toLowerCase();
  if (/physics|quantum|science|atom|gravity/i.test(lower)) return "⚛️";
  if (/math|calc|algebra|geometry/i.test(lower)) return "📐";
  if (/code|programming|dev|bug|react|next|app|python|js|ts|web/i.test(lower)) return "💻";
  if (/study|read|book|exam|prep/i.test(lower)) return "📚";
  if (/write|ppt|slide|present|design|figma|art/i.test(lower)) return "🎨";
  if (/gym|workout|exercise|run|fitness/i.test(lower)) return "🏋️";
  if (/sleep|nap|rest/i.test(lower)) return "😴";
  if (/break|coffee|tea/i.test(lower)) return "☕";
  return "⏱️";
}

function truncateNotificationName(name: string, maxLen = 16): string {
  const chars = Array.from(name.trim());
  if (chars.length <= maxLen) return name.trim();
  return chars.slice(0, maxLen - 1).join("").trim() + "…";
}

function TimerView() {
  const searchParams = useSearchParams();
  const [chatId, setChatId] = useState<string | null>(null);
  const [active, setActive] = useState<ActiveData | null>(null);
  const [loading, setLoading] = useState(true);
  const [isOperating, setIsOperating] = useState(false);
  const [stoppedSuccess, setStoppedSuccess] = useState(false);
  const [lockScreenActive, setLockScreenActive] = useState<boolean>(false);
  const [isInsideTelegram, setIsInsideTelegram] = useState(false);
  const [flashInfo, setFlashInfo] = useState<{
    type: "milestone" | "celebration" | "alarm";
    text: string;
  } | null>(null);

  const progressRef = useRef<HTMLProgressElement | null>(null);
  const svgCircleRef = useRef<SVGCircleElement | null>(null);
  const digitsRef = useRef<HTMLDivElement | null>(null);
  const sublabelRef = useRef<HTMLDivElement | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const autoTriggeredRef = useRef<boolean>(false);
  const lastMilestoneRef = useRef<number>(0);
  const lastPositionSyncRef = useRef<number>(0);
  const currentArtworkRef = useRef<string>("");
  const activeRef = useRef<ActiveData | null>(null);
  activeRef.current = active;

  const myInstanceId = useRef(
    typeof window !== "undefined" ? Math.random().toString(36).slice(2) : ""
  ).current;
  const channelRef = useRef<BroadcastChannel | null>(null);

  // 0ms instant display from localStorage cache if available
  useEffect(() => {
    try {
      const cached = localStorage.getItem("tg_timer_active_cache");
      if (cached) {
        const parsed = JSON.parse(cached);
        if (parsed && parsed.taskName) {
          setActive(parsed);
          setLoading(false);
        }
      }
    } catch {}
  }, []);

  // Single-instance coordination via BroadcastChannel
  useEffect(() => {
    if (typeof window === "undefined" || !("BroadcastChannel" in window)) return;

    const channel = new BroadcastChannel("tg_live_timer_lock");
    channelRef.current = channel;

    // Announce to any existing instances that this new instance is claiming lead
    channel.postMessage({ type: "CLAIM_LEAD", instanceId: myInstanceId });

    channel.onmessage = (event) => {
      const msg = event.data;
      if (!msg) return;

      if (msg.type === "CLAIM_LEAD" && msg.instanceId !== myInstanceId) {
        // Another instance took leadership; surrender audio and media session
        if (audioRef.current) {
          audioRef.current.pause();
        }
        if (typeof navigator !== "undefined" && "mediaSession" in navigator) {
          try {
            navigator.mediaSession.playbackState = "none";
          } catch {}
        }
        setLockScreenActive(false);
      } else if (msg.type === "SESSION_STOPPED") {
        try {
          localStorage.removeItem("tg_timer_active_cache");
        } catch {}
        setActive(null);
        setStoppedSuccess(true);
      } else if (msg.type === "SYNC_ACTIVE" && msg.active) {
        setActive(msg.active);
        try {
          localStorage.setItem("tg_timer_active_cache", JSON.stringify(msg.active));
        } catch {}
      }
    };

    return () => {
      channel.close();
    };
  }, [myInstanceId]);

  const triggerFlash = useCallback(
    (type: "milestone" | "celebration" | "alarm", text: string) => {
      setFlashInfo({ type, text });
      playAudioAlert(type);
      triggerHaptic(type === "milestone" ? "medium" : "heavy");
      setTimeout(() => {
        setFlashInfo(null);
      }, 2600);
    },
    []
  );

  // Reset auto-trigger lock when phase changes
  useEffect(() => {
    autoTriggeredRef.current = false;
  }, [active?.phase, active?.round]);

  // Clean up any Telegram hash in standalone browser
  useEffect(() => {
    if (typeof window !== "undefined" && window.location.hash.includes("tgWebAppData")) {
      try {
        const cleanPath = window.location.pathname + window.location.search;
        window.history.replaceState(null, "", cleanPath);
      } catch {}
    }
  }, []);

  // Initialize Telegram Web App SDK & detect container
  useEffect(() => {
    try {
      const tg = window.Telegram?.WebApp;
      if (tg) {
        tg.ready();
        const isTg = Boolean(
          tg.platform &&
          tg.platform !== "unknown"
        );
        setIsInsideTelegram(isTg);
      }
    } catch {}

    const queryChatId = searchParams.get("chatId");
    const tgUserId = window.Telegram?.WebApp?.initDataUnsafe?.user?.id;
    const resolvedChatId = queryChatId || (tgUserId ? String(tgUserId) : null);
    setChatId(resolvedChatId);
  }, [searchParams]);

  // Fetch active timer state from server
  const fetchActiveTimer = useCallback(async (id: string) => {
    try {
      const res = await fetch(`/api/timer/active?chatId=${encodeURIComponent(id)}`, {
        cache: "no-store",
      });
      const data = await res.json();
      if (data.ok && data.active) {
        setStoppedSuccess(false);
        setActive(data.active);
        try {
          localStorage.setItem("tg_timer_active_cache", JSON.stringify(data.active));
        } catch {}
      } else {
        setActive(null);
        try {
          localStorage.removeItem("tg_timer_active_cache");
        } catch {}
      }
    } catch (err) {
      console.error("Failed to fetch active timer:", err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!chatId) return;
    fetchActiveTimer(chatId);

    // Fast-sync every 3s so actions taken in Telegram chat reflect near-instantly in Mini App
    const timer = setInterval(() => {
      fetchActiveTimer(chatId);
    }, 3000);

    // Instant-sync the exact millisecond user returns to the tab/app
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        fetchActiveTimer(chatId);
      }
    };
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [chatId, fetchActiveTimer]);

  // Sync background audio and lock screen player with chat pause/resume actions
  useEffect(() => {
    if (!active || !lockScreenActive) return;
    if (active.isPaused) {
      audioRef.current?.pause();
      if (typeof navigator !== "undefined" && "mediaSession" in navigator) {
        navigator.mediaSession.playbackState = "paused";
      }
    } else {
      audioRef.current?.play().catch(() => {});
      if (typeof navigator !== "undefined" && "mediaSession" in navigator) {
        navigator.mediaSession.playbackState = "playing";
      }
    }
  }, [active?.isPaused, lockScreenActive]);

  // Update Android Lock Screen Media Session Controls & PositionState
  const updateMediaSessionState = useCallback((current: ActiveData, forceSyncPosition = false) => {
    if (typeof navigator === "undefined" || !("mediaSession" in navigator)) return;

    const now = Date.now();
    const endMs = current.isPaused && current.pausedAt ? current.pausedAt : now;
    const startMs = new Date(current.startedAt).getTime();
    const elapsedSec = Math.max(
      0,
      Math.floor((endMs - startMs) / 1000) - (current.pausedSeconds || 0)
    );
    const phaseStartMs = new Date(current.phaseStartedAt || current.startedAt).getTime();

    let durationSec = 3600;
    let positionSec = elapsedSec;
    let displayText = "00:00";
    let isBreakPhase = false;

    if (current.isPomodoro) {
      if (current.phase === "break") {
        isBreakPhase = true;
        durationSec = current.breakMins * 60;
        const breakSec = Math.max(0, Math.floor((endMs - phaseStartMs) / 1000));
        const remainingSec = Math.max(0, durationSec - breakSec);
        positionSec = Math.min(durationSec, breakSec);
        displayText = formatClockTime(remainingSec);
      } else if (current.phase === "awaiting_break") {
        isBreakPhase = false;
        durationSec = 10;
        if (current.autoAdvance) {
          const waitSec = Math.max(0, Math.floor((endMs - phaseStartMs) / 1000));
          const countdown = Math.max(0, 10 - waitSec);
          positionSec = waitSec;
          displayText = `00:${countdown.toString().padStart(2, "0")}`;
        } else {
          positionSec = 10;
          displayText = "00:00";
        }
      } else if (current.phase === "awaiting_round") {
        isBreakPhase = true;
        durationSec = 10;
        if (current.autoAdvance) {
          const waitSec = Math.max(0, Math.floor((endMs - phaseStartMs) / 1000));
          const countdown = Math.max(0, 10 - waitSec);
          positionSec = waitSec;
          displayText = `00:${countdown.toString().padStart(2, "0")}`;
        } else {
          positionSec = 10;
          displayText = "00:00";
        }
      } else {
        isBreakPhase = false;
        durationSec = current.workMins * 60;
        const workSec = Math.max(0, Math.floor((endMs - phaseStartMs) / 1000));
        const remainingSec = Math.max(0, durationSec - workSec);
        positionSec = Math.min(durationSec, workSec);
        displayText = formatClockTime(remainingSec);
      }
    } else {
      durationSec = Math.max(3600, elapsedSec + 1800);
      positionSec = elapsedSec;
      displayText = formatClockTime(elapsedSec);
    }

    // Exact lock-screen format requested: "Timer name(w/b) : Timer time"
    // Short string (max 26 chars) so Android notification never overflows or scrolls (stays stationary)
    const rawName = current.taskName?.trim() || "Timer";
    const safeName = truncateNotificationName(rawName, 16);
    const tag = current.isPomodoro ? (isBreakPhase ? "(b)" : "(w)") : "";
    const prefix = current.isPaused ? "⏸️ " : "";
    const titleStr = current.isPomodoro
      ? `${prefix}${safeName}${tag} : ${displayText}`
      : `${prefix}${safeName} : ${displayText}`;

    // Select dynamic artwork icon: Break (coffee) vs Work (tomato/focus) vs Stopwatch
    const iconType = current.isPomodoro
      ? isBreakPhase
        ? "break"
        : "work"
      : "default";

    const origin = typeof window !== "undefined" ? window.location.origin : "";
    const icon192 =
      iconType === "break"
        ? `${origin}/icon-break-192.png`
        : iconType === "work"
        ? `${origin}/icon-work-192.png`
        : `${origin}/icon-192.png`;
    const icon512 =
      iconType === "break"
        ? `${origin}/icon-break-512.png`
        : iconType === "work"
        ? `${origin}/icon-work-512.png`
        : `${origin}/icon-512.png`;

    // Update browser tab document title
    if (typeof document !== "undefined" && document.title !== titleStr) {
      document.title = titleStr;
    }

    const needsNewMetadata =
      !navigator.mediaSession.metadata ||
      currentArtworkRef.current !== iconType;

    // Use zero-width space "\u200B" for artist so Chrome Android never falls back to showing origin domain
    const emptyPlaceholder = "\u200B";

    if (needsNewMetadata || !navigator.mediaSession.metadata) {
      currentArtworkRef.current = iconType;
      navigator.mediaSession.metadata = new MediaMetadata({
        title: titleStr,
        artist: emptyPlaceholder,
        album: "",
        artwork: [
          { src: icon192, sizes: "192x192", type: "image/png" },
          { src: icon512, sizes: "512x512", type: "image/png" },
        ],
      });
    } else {
      const meta = navigator.mediaSession.metadata;
      if (meta.title !== titleStr) {
        meta.title = titleStr;
      }
      if (meta.artist !== emptyPlaceholder) {
        meta.artist = emptyPlaceholder;
      }
      if (meta.album !== "") {
        meta.album = "";
      }
    }

    const desiredState = current.isPaused ? "paused" : "playing";
    if (navigator.mediaSession.playbackState !== desiredState) {
      try {
        navigator.mediaSession.playbackState = desiredState;
      } catch {}
    }

    // Android Lock Screen Native Progress Sync (syncs on change or every 5s)
    const shouldSyncPos =
      forceSyncPosition ||
      now - lastPositionSyncRef.current > 5000 ||
      current.isPaused;

    if (shouldSyncPos && "setPositionState" in navigator.mediaSession) {
      lastPositionSyncRef.current = now;
      try {
        navigator.mediaSession.setPositionState({
          duration: Math.max(1, durationSec),
          playbackRate: current.isPaused ? 0 : 1.0,
          position: Math.min(durationSec, Math.max(0, positionSec)),
        });
      } catch {}
    }
  }, []);

  // 60 FPS animation loop for smooth countdown and ring updates
  useEffect(() => {
    if (!active) return;

    let animFrame: number;
    let lastSecond = -1;

    const tick = () => {
      const current = activeRef.current;
      if (!current) return;

      const now = Date.now();
      const endMs = current.isPaused && current.pausedAt ? current.pausedAt : now;
      const startMs = new Date(current.startedAt).getTime();
      const elapsedSec = Math.max(
        0,
        Math.floor((endMs - startMs) / 1000) - (current.pausedSeconds || 0)
      );
      const phaseStartMs = new Date(current.phaseStartedAt || current.startedAt).getTime();

      let displayText = "00:00";
      let sublabel = "ELAPSED";
      let percent = 0;
      let currentSec = 0;

      if (current.isPomodoro) {
        if (current.phase === "break") {
          const targetSec = current.breakMins * 60;
          const breakSec = Math.max(0, Math.floor((endMs - phaseStartMs) / 1000));
          const remainingSec = Math.max(0, targetSec - breakSec);
          currentSec = remainingSec;
          percent = Math.min(100, Math.round((breakSec / targetSec) * 100));
          displayText = formatClockTime(remainingSec);
          sublabel = "BREAK REMAINING";
        } else if (current.phase === "awaiting_break") {
          if (current.autoAdvance) {
            const waitSec = Math.max(0, Math.floor((endMs - phaseStartMs) / 1000));
            const countdown = Math.max(0, 10 - waitSec);
            displayText = `00:${countdown.toString().padStart(2, "0")}`;
            percent = Math.min(100, Math.round(((10 - countdown) / 10) * 100));
            sublabel = `⚡ BREAK IN ${countdown}s (AUTO)`;
            if (countdown === 0 && !autoTriggeredRef.current) {
              autoTriggeredRef.current = true;
              void executeAction("pomodoro_start_break");
            }
          } else {
            displayText = "00:00";
            percent = 100;
            sublabel = "FOCUS COMPLETE";
          }
        } else if (current.phase === "awaiting_round") {
          if (current.autoAdvance) {
            const waitSec = Math.max(0, Math.floor((endMs - phaseStartMs) / 1000));
            const countdown = Math.max(0, 10 - waitSec);
            displayText = `00:${countdown.toString().padStart(2, "0")}`;
            percent = Math.min(100, Math.round(((10 - countdown) / 10) * 100));
            sublabel = `⚡ ROUND ${current.round} IN ${countdown}s`;
            if (countdown === 0 && !autoTriggeredRef.current) {
              autoTriggeredRef.current = true;
              void executeAction("pomodoro_next_round");
            }
          } else {
            displayText = "00:00";
            percent = 100;
            sublabel = "BREAK COMPLETE";
          }
        } else {
          // Work phase
          const targetSec = current.workMins * 60;
          const workSec = Math.max(0, Math.floor((endMs - phaseStartMs) / 1000));
          const remainingSec = Math.max(0, targetSec - workSec);
          currentSec = remainingSec;
          percent = Math.min(100, Math.round((workSec / targetSec) * 100));
          displayText = formatClockTime(remainingSec);
          sublabel = `ROUND ${current.round} FOCUS`;
        }
      } else {
        // Standard Stopwatch
        currentSec = elapsedSec;
        // Ring progresses smoothly every 60 seconds
        percent = Math.round(((elapsedSec % 60) / 60) * 100);
        displayText = formatClockTime(elapsedSec);
        sublabel = current.isPaused ? "PAUSED" : "RUNNING";
      }

      // Update DOM nodes directly for zero React re-render overhead at 60 FPS
      if (digitsRef.current && digitsRef.current.textContent !== displayText) {
        digitsRef.current.textContent = displayText;
      }
      if (sublabelRef.current && sublabelRef.current.textContent !== sublabel) {
        sublabelRef.current.textContent = sublabel;
      }
      if (svgCircleRef.current) {
        // Circumference for r=116 is 2 * PI * 116 = 728.85
        const offset = 728.85 * (1 - percent / 100);
        svgCircleRef.current.style.strokeDashoffset = String(offset);
      }
      if (progressRef.current) {
        progressRef.current.value = percent;
        progressRef.current.style.setProperty("--value", String(percent));
      }

      // Update Android Lock Screen Media Session Controls
      if (lockScreenActive && current) {
        updateMediaSessionState(current);
      }

      // Check 5-minute milestone flash alert
      const milestoneSec = current.isPomodoro
        ? Math.max(0, Math.floor((endMs - phaseStartMs) / 1000))
        : elapsedSec;
      const fiveMinChunk = Math.floor(milestoneSec / 300);
      if (fiveMinChunk > 0 && fiveMinChunk > lastMilestoneRef.current && !current.isPaused) {
        lastMilestoneRef.current = fiveMinChunk;
        if (current.beepEnabled !== false) {
          triggerFlash("milestone", `✨ ${fiveMinChunk * 5} Minutes Logged!`);
        }
      }

      // Check Pomodoro countdown completion (Work -> Break or Break -> Work)
      if (
        current.isPomodoro &&
        !current.isPaused &&
        currentSec === 0 &&
        lastSecond > 0
      ) {
        if (current.phase === "work") {
          triggerFlash("celebration", "🎉 Focus Complete! Break Time ☕");
        } else if (current.phase === "break") {
          triggerFlash("alarm", `🚨 Break Over! Ready for Round ${current.round + 1}`);
        }
      }
      lastSecond = currentSec;

      animFrame = requestAnimationFrame(tick);
    };

    animFrame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(animFrame);
  }, [active, lockScreenActive, triggerFlash, updateMediaSessionState]);

  // Action dispatcher
  const executeAction = useCallback(async (action: string) => {
    if (!chatId || isOperating) return;
    setIsOperating(true);
    triggerHaptic("medium");

    try {
      const res = await fetch("/api/timer/action", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chatId, action }),
      });
      const data = await res.json();

      if (data.ok) {
        if (action === "stop") {
          setStoppedSuccess(true);
          triggerHaptic("heavy");
          try {
            localStorage.removeItem("tg_timer_active_cache");
          } catch {}
          channelRef.current?.postMessage({
            type: "SESSION_STOPPED",
            instanceId: myInstanceId,
          });
          if (audioRef.current) {
            audioRef.current.pause();
          }
          if (typeof navigator !== "undefined" && "mediaSession" in navigator) {
            navigator.mediaSession.playbackState = "none";
          }
          setTimeout(() => {
            try {
              window.Telegram?.WebApp?.close();
            } catch {}
          }, 1200);
        } else {
          await fetchActiveTimer(chatId);
          if (action === "pause") {
            audioRef.current?.pause();
            if (typeof navigator !== "undefined" && "mediaSession" in navigator) {
              navigator.mediaSession.playbackState = "paused";
            }
          } else if (action === "resume") {
            audioRef.current?.play().catch(() => {});
            if (typeof navigator !== "undefined" && "mediaSession" in navigator) {
              navigator.mediaSession.playbackState = "playing";
            }
          }
          if (activeRef.current) {
            updateMediaSessionState(activeRef.current, true);
            channelRef.current?.postMessage({
              type: "SYNC_ACTIVE",
              active: activeRef.current,
              instanceId: myInstanceId,
            });
          }
        }
      }
    } catch (err) {
      console.error("Action error:", err);
    } finally {
      setIsOperating(false);
    }
  }, [chatId, isOperating, fetchActiveTimer, updateMediaSessionState]);

  // Lock Screen Media Session initialization
  const initMediaSession = useCallback(async () => {
    if (typeof window === "undefined" || !("mediaSession" in navigator)) return;

    let audio = audioRef.current;
    if (!audio) {
      audio = new Audio("/silent.mp3");
      audio.loop = true;
      audioRef.current = audio;
    }

    try {
      audio.src = "/silent.mp3";
      audio.loop = true;
      await audio.play();
      setLockScreenActive(true);
      navigator.mediaSession.playbackState = "playing";
      if (activeRef.current) {
        updateMediaSessionState(activeRef.current, true);
      }
    } catch (err) {
      console.warn("Audio play rejected:", err);
    }

    // Zero lock-screen buttons: keep lock screen as a pure visual display
    try {
      navigator.mediaSession.setActionHandler("play", null);
      navigator.mediaSession.setActionHandler("pause", null);
      navigator.mediaSession.setActionHandler("stop", null);
      navigator.mediaSession.setActionHandler("nexttrack", null);
      navigator.mediaSession.setActionHandler("previoustrack", null);
      navigator.mediaSession.setActionHandler("seekto", null);
      navigator.mediaSession.setActionHandler("seekforward", null);
      navigator.mediaSession.setActionHandler("seekbackward", null);
    } catch {}
  }, [executeAction, updateMediaSessionState]);

  useEffect(() => {
    const handleGesture = () => {
      void initMediaSession();
    };
    window.addEventListener("touchstart", handleGesture, { once: true });
    window.addEventListener("click", handleGesture, { once: true });

    void initMediaSession();

    return () => {
      window.removeEventListener("touchstart", handleGesture);
      window.removeEventListener("click", handleGesture);
      if (audioRef.current) {
        audioRef.current.pause();
      }
    };
  }, [initMediaSession]);

  // Background lock-screen sync timer (keeps firing when phone screen is locked)
  useEffect(() => {
    if (!active || !lockScreenActive) return;

    const interval = setInterval(() => {
      if (activeRef.current) {
        updateMediaSessionState(activeRef.current, true);
      }
    }, 1000);

    return () => clearInterval(interval);
  }, [active, lockScreenActive, updateMediaSessionState]);

  const handleClose = () => {
    try {
      window.Telegram?.WebApp?.close();
    } catch {}
  };

  const handleOpenInBrowser = useCallback(() => {
    triggerHaptic("light");
    const targetUrl = chatId
      ? `${window.location.origin}/timer?chatId=${encodeURIComponent(chatId)}`
      : `${window.location.origin}/timer`;
    if (window.Telegram?.WebApp?.openLink) {
      window.Telegram.WebApp.openLink(targetUrl, { try_instant_view: false });
    } else {
      window.open(targetUrl, "_blank");
    }
  }, [chatId]);

  if (loading) {
    return (
      <div className="empty-state-dark">
        <div className="ambient-blob ambient-blob-1" />
        <div className="ambient-blob ambient-blob-2" />
        <div className="pulse-dot-green" style={{ width: 18, height: 18 }} />
        <p style={{ color: "#94a3b8", fontSize: "0.95rem", fontWeight: 500 }}>
          Connecting live timer...
        </p>
      </div>
    );
  }

  if (stoppedSuccess) {
    return (
      <div className="empty-state-dark">
        <div className="ambient-blob ambient-blob-1" />
        <div className="ambient-blob ambient-blob-2" />
        <div style={{ fontSize: "3.5rem" }}>🎉</div>
        <h2 style={{ fontSize: "1.4rem", fontWeight: 800, color: "#ffffff" }}>Session Completed!</h2>
        <p style={{ color: "#94a3b8", fontSize: "0.9rem" }}>
          Saved to your log. Returning to chat...
        </p>
      </div>
    );
  }

  if (!active) {
    return (
      <div className="empty-state-dark">
        <div className="ambient-blob ambient-blob-1" />
        <div className="ambient-blob ambient-blob-2" />
        <div className="ambient-blob ambient-blob-3" />
        <div style={{ fontSize: "3rem" }}>⏱️</div>
        <h2 style={{ fontSize: "1.4rem", fontWeight: 800, color: "#ffffff" }}>No Active Timer</h2>
        <p style={{ color: "#94a3b8", fontSize: "0.92rem", maxWidth: 280, lineHeight: 1.5 }}>
          No stopwatch is currently running. Start a timer in Telegram chat.
        </p>
        <div
          style={{
            marginTop: "1.2rem",
            display: "inline-flex",
            alignItems: "center",
            gap: "0.5rem",
            fontSize: "0.85rem",
            fontWeight: 500,
            color: "#94a3b8",
            background: "rgba(15, 23, 42, 0.8)",
            border: "1px solid rgba(255, 255, 255, 0.08)",
            boxShadow: "0 4px 16px rgba(0, 0, 0, 0.3)",
            padding: "0.5rem 1rem",
            borderRadius: "20px",
          }}
        >
          <span className="pulse-dot-green" style={{ width: 8, height: 8 }} />
          <span>Waiting for next timer from Telegram chat...</span>
        </div>
      </div>
    );
  }

  const isPomodoro = active.isPomodoro;
  const phase = active.phase;
  const isPaused = active.isPaused;

  const accentColor =
    isPaused
      ? "#64748b"
      : isPomodoro
      ? phase === "break"
        ? "#fbbf24"
        : "#38bdf8"
      : /sleep/i.test(active.taskName)
      ? "#818cf8"
      : "#38bdf8";

  const taskIcon = getTaskVisualIcon(active.taskName);

  return (
    <div className="timer-container" style={{ "--accent-color": accentColor } as React.CSSProperties}>
      {/* Ambient Dark Mode Luminous Glow Blobs */}
      <div className="ambient-blob ambient-blob-1" />
      <div className="ambient-blob ambient-blob-2" />
      <div className="ambient-blob ambient-blob-3" />

      <audio
        ref={audioRef}
        src="/silent.mp3"
        loop
        playsInline
        preload="auto"
        style={{ display: "none" }}
      />
      {flashInfo && (
        <>
          <div className={`ambient-flash-overlay flash-${flashInfo.type}`} />
          <div className={`flash-banner flash-banner-${flashInfo.type}`}>
            {flashInfo.text}
          </div>
        </>
      )}

      {/* Header */}
      <header className="timer-header">
        <div className="phase-pill-dark">
          {!isPaused && <span className="pulse-dot-green" />}
          <span>
            {isPaused
              ? "⏸ PAUSED"
              : isPomodoro
              ? phase === "break"
                ? `☕ BREAK (Round ${active.round})`
                : phase === "awaiting_break"
                ? "🎉 FOCUS COMPLETE"
                : phase === "awaiting_round"
                ? "🚨 BREAK FINISHED"
                : `🍅 FOCUS (Round ${active.round})`
              : "⏱️ ACTIVE STOPWATCH"}
          </span>
          <span style={{ color: "#94a3b8", fontSize: "0.85rem", marginLeft: "2px" }}>⌵</span>
        </div>

        <h1 className="task-title-dark">
          {taskIcon && <span>{taskIcon}</span>}
          <span>{active.taskName}</span>
        </h1>

        {active.projectName && (
          <div className="sub-meta-pill">
            <span>📦 {active.projectName}</span>
            {active.projectProgress && <span>• ⏱️ {active.projectProgress}</span>}
          </div>
        )}

        {active.todoTitle && (
          <div className="todo-meta-pill">
            <span>🎯 {active.todoTitle}</span>
          </div>
        )}
      </header>

      {/* Modern Circular Progress Ring Component in Dark Mode */}
      <main className="ring-wrapper-dark">
        <svg width="280" height="280" viewBox="0 0 280 280" className="progress-ring-svg">
          {/* Background Track */}
          <circle
            cx="140"
            cy="140"
            r="116"
            fill="none"
            stroke="#1e293b"
            strokeWidth="15"
          />
          {/* Animated Progress Fill Arc with Glow */}
          <circle
            ref={svgCircleRef}
            cx="140"
            cy="140"
            r="116"
            fill="none"
            stroke={accentColor}
            strokeWidth="15"
            strokeLinecap="round"
            strokeDasharray="728.85"
            strokeDashoffset="728.85"
            style={{
              transform: "rotate(-90deg)",
              transformOrigin: "140px 140px",
              transition: "stroke-dashoffset 0.15s ease",
            }}
          />
        </svg>

        <div className="ring-content-dark">
          <div className="timer-hourglass" style={{ color: accentColor }}>
            {/sleep/i.test(active.taskName) ? "😴" : phase === "break" ? "☕" : "⌛"}
          </div>
          <div ref={digitsRef} className="timer-digits-dark">
            00:00
          </div>
          <div ref={sublabelRef} className="timer-badge-pill">
            {isPaused
              ? "PAUSED"
              : isPomodoro
              ? phase === "break"
                ? `ROUND ${active.round} BREAK`
                : `ROUND ${active.round} FOCUS`
              : "RUNNING"}
          </div>
        </div>
      </main>

      {/* Details Card in Dark Mode */}
      <section className="details-card-dark">
        <div className="card-side">
          <div className="card-icon-circle blue-circle">
            <span>▶</span>
          </div>
          <div className="card-text-col">
            <span className="card-sublabel">STARTED AT</span>
            <span className="card-value">
              {new Date(active.startedAt).toLocaleTimeString([], {
                hour: "2-digit",
                minute: "2-digit",
              })}
            </span>
          </div>
        </div>

        <div className="card-divider" />

        <div
          className="card-side"
          style={{ cursor: "pointer" }}
          onClick={() => void initMediaSession()}
          title="Tap to activate lock screen audio"
        >
          <div className="card-icon-circle purple-circle">
            <span>🔒</span>
          </div>
          <div className="card-text-col">
            <span className="card-sublabel">LOCK SCREEN</span>
            <span
              className="card-value"
              style={{ color: "#38bdf8", fontSize: "0.92rem", fontWeight: 600 }}
            >
              {lockScreenActive ? "🟢 Active on Lock Screen" : "Tap to activate"}
            </span>
          </div>
        </div>
      </section>
    </div>
  );
}

export default function TimerPage() {
  return (
    <Suspense
      fallback={
        <div className="empty-state-dark">
          <div className="ambient-blob ambient-blob-1" />
          <div className="ambient-blob ambient-blob-2" />
          <div className="pulse-dot-green" style={{ width: 16, height: 16 }} />
          <p style={{ color: "#94a3b8", fontSize: "0.95rem" }}>
            Loading stopwatch...
          </p>
        </div>
      }
    >
      <TimerView />
    </Suspense>
  );
}
