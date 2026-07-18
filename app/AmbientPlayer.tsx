"use client";

import { useEffect, useRef, useState } from "react";

const STORAGE_KEY = "wuguobin-background-music";

type PlaybackState = "loading" | "playing" | "paused" | "blocked" | "error";

const statusLabels: Record<PlaybackState, string> = {
  loading: "正在准备音乐",
  playing: "正在播放 · 18% 音量",
  paused: "音乐已暂停",
  blocked: "点击开启背景音乐",
  error: "音乐暂时无法播放",
};

export default function AmbientPlayer({ src }: { src: string }) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [playbackState, setPlaybackState] =
    useState<PlaybackState>("loading");

  useEffect(() => {
    const audio = audioRef.current;

    if (!audio) {
      return;
    }

    audio.volume = 0.18;

    if (window.localStorage.getItem(STORAGE_KEY) === "paused") {
      audio.pause();
      const pausedFrame = window.requestAnimationFrame(() => {
        setPlaybackState("paused");
      });

      return () => window.cancelAnimationFrame(pausedFrame);
    }

    const playPromise = audio.play();

    if (playPromise) {
      playPromise.catch(() => setPlaybackState("blocked"));
    }
  }, []);

  const togglePlayback = async () => {
    const audio = audioRef.current;

    if (!audio || playbackState === "error") {
      return;
    }

    if (audio.paused) {
      try {
        await audio.play();
        window.localStorage.setItem(STORAGE_KEY, "playing");
      } catch {
        setPlaybackState("blocked");
      }
      return;
    }

    audio.pause();
    window.localStorage.setItem(STORAGE_KEY, "paused");
  };

  return (
    <aside
      className={`ambient-player is-${playbackState}`}
      aria-label="背景音乐播放器"
    >
      <audio
        ref={audioRef}
        src={src}
        autoPlay
        loop
        preload="auto"
        onPlay={() => setPlaybackState("playing")}
        onPause={() => setPlaybackState("paused")}
        onError={() => setPlaybackState("error")}
      />

      <button
        className="ambient-player-toggle"
        type="button"
        aria-label={playbackState === "playing" ? "暂停背景音乐" : "播放背景音乐"}
        aria-pressed={playbackState === "playing"}
        onClick={togglePlayback}
      >
        <span className="ambient-equalizer" aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
      </button>

      <div className="ambient-player-copy">
        <span>READING SOUNDTRACK</span>
        <strong>Placid Ambient</strong>
        <small aria-live="polite">{statusLabels[playbackState]}</small>
        <a
          href="https://commons.wikimedia.org/wiki/File:Placid_Ambient_by_MusicLFiles.ogg"
          target="_blank"
          rel="noreferrer"
        >
          MusicLFiles · CC BY 4.0 ↗
        </a>
      </div>
    </aside>
  );
}
