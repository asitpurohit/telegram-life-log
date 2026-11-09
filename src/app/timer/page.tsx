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

function playAudioChime() {
  try {
    const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();
    const now = ctx.currentTime;

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
  } catch {}
}

function triggerHaptic(style: "light" | "medium" | "heavy" = "medium") {
  try {
    window.Telegram?.WebApp?.HapticFeedback?.impactOccurred(style);
  } catch {}
}

function TimerView() {
  const searchParams = useSearchParams();
  const [chatId, setChatId] = useState<string | null>(null);
  const [active, setActive] = useState<ActiveData | null>(null);
  const [loading, setLoading] = useState(true);
  const [isOperating, setIsOperating] = useState(false);
  const [stoppedSuccess, setStoppedSuccess] = useState(false);
  const [lockScreenActive, setLockScreenActive] = useState<boolean>(false);

  const progressRef = useRef<HTMLProgressElement | null>(null);
  const digitsRef = useRef<HTMLDivElement | null>(null);
  const sublabelRef = useRef<HTMLDivElement | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const autoTriggeredRef = useRef<boolean>(false);
  const activeRef = useRef<ActiveData | null>(null);
  activeRef.current = active;

  // Reset auto-trigger lock when phase changes
  useEffect(() => {
    autoTriggeredRef.current = false;
  }, [active?.phase, active?.round]);

  // Initialize Telegram Web App SDK & detect chatId
  useEffect(() => {
    try {
      const tg = window.Telegram?.WebApp;
      if (tg) {
        tg.ready();
        tg.expand();
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
        setActive(data.active);
      } else {
        setActive(null);
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

    // Sync in background every 8s
    const timer = setInterval(() => {
      fetchActiveTimer(chatId);
    }, 8000);

    // Fast-sync whenever user returns to the tab/app
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

      let displayText = "00:00";
      let sublabel = "ELAPSED";
      let percent = 0;
      let currentSec = 0;

      if (current.isPomodoro) {
        const phaseStartMs = new Date(current.phaseStartedAt || current.startedAt).getTime();
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
        const startMs = new Date(current.startedAt).getTime();
        const elapsedSec = Math.max(
          0,
          Math.floor((endMs - startMs) / 1000) - (current.pausedSeconds || 0)
        );
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
      if (progressRef.current) {
        progressRef.current.value = percent;
        progressRef.current.style.setProperty("--value", String(percent));
      }

      // Update Android Lock Screen Media Session Controls
      if (typeof navigator !== "undefined" && "mediaSession" in navigator && lockScreenActive) {
        const titleStr = `${displayText} — ${current.taskName}`;
        const artistStr = current.isPaused
          ? "⏸ Paused • Telegram Life Log"
          : current.isPomodoro
          ? `${sublabel} • Telegram Life Log`
          : "⏱️ Running • Telegram Life Log";

        if (navigator.mediaSession.metadata?.title !== titleStr) {
          navigator.mediaSession.metadata = new MediaMetadata({
            title: titleStr,
            artist: artistStr,
            album: current.projectName ? `📦 ${current.projectName}` : "Telegram Life Log",
          });
          try {
            navigator.mediaSession.playbackState = current.isPaused ? "paused" : "playing";
          } catch {}
        }
      }

      // Play soft sound chime when a Pomodoro countdown hits exactly 0
      if (
        current.isPomodoro &&
        !current.isPaused &&
        currentSec === 0 &&
        lastSecond > 0 &&
        (current.phase === "work" || current.phase === "break")
      ) {
        playAudioChime();
        triggerHaptic("heavy");
      }
      lastSecond = currentSec;

      animFrame = requestAnimationFrame(tick);
    };

    animFrame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(animFrame);
  }, [active, lockScreenActive]);

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
        }
      }
    } catch (err) {
      console.error("Action error:", err);
    } finally {
      setIsOperating(false);
    }
  }, [chatId, isOperating, fetchActiveTimer]);

  // Lock Screen Media Session initialization
  const initMediaSession = useCallback(() => {
    if (typeof window === "undefined" || !("mediaSession" in navigator)) return;

    if (!audioRef.current) {
      const audio = new Audio("/silent.wav");
      audio.loop = true;
      audioRef.current = audio;
    }

    const audio = audioRef.current;
    audio.play().then(() => {
      setLockScreenActive(true);
      navigator.mediaSession.playbackState = "playing";
    }).catch(() => {
      // Browser autoplay policy might require user click/touch
    });

    try {
      navigator.mediaSession.setActionHandler("play", () => {
        executeAction("resume");
        audio.play().catch(() => {});
      });

      navigator.mediaSession.setActionHandler("pause", () => {
        executeAction("pause");
        audio.pause();
      });

      navigator.mediaSession.setActionHandler("stop", () => {
        executeAction("stop");
      });

      navigator.mediaSession.setActionHandler("nexttrack", () => {
        const cur = activeRef.current;
        if (cur?.isPomodoro) {
          if (cur.phase === "break" || cur.phase === "awaiting_break") {
            executeAction("pomodoro_skip_break");
          } else if (cur.phase === "awaiting_round") {
            executeAction("pomodoro_next_round");
          }
        }
      });
    } catch {}
  }, [executeAction]);

  useEffect(() => {
    const handleGesture = () => {
      initMediaSession();
    };
    window.addEventListener("touchstart", handleGesture, { once: true });
    window.addEventListener("click", handleGesture, { once: true });

    initMediaSession();

    return () => {
      window.removeEventListener("touchstart", handleGesture);
      window.removeEventListener("click", handleGesture);
      if (audioRef.current) {
        audioRef.current.pause();
      }
    };
  }, [initMediaSession]);

  const handleClose = () => {
    try {
      window.Telegram?.WebApp?.close();
    } catch {}
  };

  if (loading) {
    return (
      <div className="empty-state">
        <div className="pulse-dot" style={{ width: 16, height: 16 }} />
        <p style={{ color: "var(--hint-color)", fontSize: "0.95rem" }}>
          Connecting live timer...
        </p>
      </div>
    );
  }

  if (stoppedSuccess) {
    return (
      <div className="empty-state">
        <div style={{ fontSize: "3.5rem" }}>🎉</div>
        <h2 style={{ fontSize: "1.4rem", fontWeight: 700 }}>Session Completed!</h2>
        <p style={{ color: "var(--hint-color)", fontSize: "0.9rem" }}>
          Saved to your log. Returning to chat...
        </p>
      </div>
    );
  }

  if (!active) {
    return (
      <div className="empty-state">
        <div style={{ fontSize: "3rem" }}>⏱️</div>
        <h2 style={{ fontSize: "1.3rem", fontWeight: 700 }}>No Active Timer</h2>
        <p style={{ color: "var(--hint-color)", fontSize: "0.9rem", maxWidth: 280 }}>
          No stopwatch is currently running. Start a timer in your Telegram chat to watch it tick live.
        </p>
        <button
          className="btn btn-secondary"
          style={{ maxWidth: 200, marginTop: "1rem" }}
          onClick={handleClose}
        >
          Close
        </button>
      </div>
    );
  }

  const isPomodoro = active.isPomodoro;
  const phase = active.phase;
  const isPaused = active.isPaused;

  const accentColor =
    isPaused
      ? "#94a3b8"
      : isPomodoro
      ? phase === "break"
        ? "#f59e0b"
        : "#10b981"
      : /sleep/i.test(active.taskName)
      ? "#818cf8"
      : "#10b981";

  return (
    <div className="timer-container" style={{ "--accent-color": accentColor } as React.CSSProperties}>
      {/* Header */}
      <header className="timer-header">
        <div className="phase-pill">
          {!isPaused && <span className="pulse-dot" />}
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
        </div>
        <h1 className="task-title">{active.taskName}</h1>
        {active.projectName && (
          <div className="sub-meta">
            <span>📦 {active.projectName}</span>
            {active.projectProgress && <span>• {active.projectProgress}</span>}
          </div>
        )}
        {active.todoTitle && (
          <div className="sub-meta">
            <span>🎯 {active.todoTitle}</span>
          </div>
        )}
      </header>

      {/* Modern Circular Progress Ring Component */}
      <main className="ring-wrapper">
        <progress
          ref={progressRef}
          className="progress-ring"
          value={0}
          max={100}
          aria-label="Timer Progress"
        />
        <div className="ring-content">
          <div ref={digitsRef} className="timer-digits">
            00:00
          </div>
          <div ref={sublabelRef} className="timer-sublabel">
            {isPaused ? "PAUSED" : "RUNNING"}
          </div>
        </div>
      </main>

      {/* Details Card */}
      <section className="details-card">
        <div className="details-col">
          <span className="details-label">Started At</span>
          <span className="details-val">
            {new Date(active.startedAt).toLocaleTimeString([], {
              hour: "2-digit",
              minute: "2-digit",
            })}
          </span>
        </div>
        <div className="details-col" style={{ textAlign: "right" }}>
          <span className="details-label">Lock Screen Controls</span>
          <span
            className="details-val"
            style={{
              fontSize: "0.85rem",
              color: lockScreenActive ? "var(--accent-color)" : "var(--hint-color)",
            }}
          >
            {lockScreenActive ? "🟢 Active on Lock Screen" : "📱 Tap screen to link"}
          </span>
        </div>
      </section>

      {/* Action Buttons */}
      <footer className="actions-row">
        {isPomodoro && phase === "awaiting_break" ? (
          <>
            <button
              className="btn btn-primary"
              disabled={isOperating}
              onClick={() => executeAction("pomodoro_start_break")}
            >
              ☕ {active.autoAdvance ? "Start Break Now" : `Start ${active.breakMins}m Break`}
            </button>
            <button
              className="btn btn-secondary"
              disabled={isOperating}
              onClick={() => executeAction("pomodoro_skip_break")}
            >
              ▶️ Skip Break
            </button>
          </>
        ) : isPomodoro && phase === "awaiting_round" ? (
          <>
            <button
              className="btn btn-primary"
              disabled={isOperating}
              onClick={() => executeAction("pomodoro_next_round")}
            >
              ▶️ {active.autoAdvance ? `Start Round ${active.round} Now` : `Start Round ${active.round}`}
            </button>
            <button
              className="btn btn-danger"
              disabled={isOperating}
              onClick={() => executeAction("stop")}
            >
              ⏹ Stop & Log
            </button>
          </>
        ) : (
          <>
            {isPaused ? (
              <button
                className="btn btn-primary"
                disabled={isOperating}
                onClick={() => executeAction("resume")}
              >
                ▶️ Resume
              </button>
            ) : (
              <button
                className="btn btn-secondary"
                disabled={isOperating}
                onClick={() => executeAction("pause")}
              >
                ⏸ Pause
              </button>
            )}

            <button
              className="btn btn-danger"
              disabled={isOperating}
              onClick={() => executeAction("stop")}
            >
              ⏹ Stop & Log
            </button>
          </>
        )}
      </footer>
    </div>
  );
}

export default function TimerPage() {
  return (
    <Suspense
      fallback={
        <div className="empty-state">
          <div className="pulse-dot" style={{ width: 16, height: 16 }} />
          <p style={{ color: "var(--hint-color)", fontSize: "0.95rem" }}>
            Loading stopwatch...
          </p>
        </div>
      }
    >
      <TimerView />
    </Suspense>
  );
}
