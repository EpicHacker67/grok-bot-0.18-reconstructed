import { VNC_VIEWER_VISIBLE_CHANNEL } from "../shared/vnc-viewer-visibility.js";

export type AudioPlaybackTarget = Pick<HTMLMediaElement, "muted" | "volume" | "play">;

export interface RemoteAudioEdge {
  startAudio(): Promise<{ supported: boolean; started?: boolean }>;
  readAudio(): Promise<{ bytes: Uint8Array; error: string | null }>;
  stopAudio(): Promise<unknown>;
}

export function installRemoteAudio(edge: RemoteAudioEdge, renderer: { on(channel: string, listener: (event: unknown, value: unknown) => void): void }): { prepareMediaElement(media: AudioPlaybackTarget): void; setMediaElement(media: AudioPlaybackTarget | null): void } | undefined {
  if (!location.pathname.endsWith("/vnc.html") || new URLSearchParams(location.search).get("sandInteractive") !== "1") return;
  let visible = false;
  let media: AudioPlaybackTarget | null = null;
  let enabled = true;
  try { enabled = localStorage.getItem("mengel-remote-sound") !== "muted"; } catch {}
  let volume = 1;
  try {
    const saved = Number(localStorage.getItem("mengel-remote-volume") ?? "1");
    if (Number.isFinite(saved) && saved > 0 && saved <= 1) volume = saved;
  } catch {}
  let context: AudioContext | null = null;
  let gain: GainNode | null = null;
  let nextTime = 0;
  let generation = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let starting = false;
  let running = false;
  let failed = false;
  const active = new Set<AudioBufferSourceNode>();
  const controls = document.createElement("div");
  controls.id = "mengel-remote-audio";
  controls.setAttribute("role", "group");
  controls.setAttribute("aria-label", "Remote computer volume");
  const style = document.createElement("style");
  // Match the app's Sand dark palette; this isolated webview does not inherit its theme tokens.
  style.textContent = `
    #mengel-remote-audio { position:fixed;right:16px;bottom:16px;z-index:2147483647;
      --sand-bg-elevated:#181818;--sand-text-primary:#fcfcfc;--sand-text-secondary:#fcfcfc99;
      --sand-border-weak:#fcfcfc1a;--sand-border-focus:#fcfcfc66;--sand-fill-ghost-hover:#7777772c;
      --sand-fill-control-track:#fcfcfc1a;--sand-fill-primary:#fafafa;
      display:flex;align-items:center;gap:8px;padding:4px 12px 4px 4px;
      border:1px solid var(--sand-border-weak);border-radius:12px;
      background:var(--sand-bg-elevated);color:var(--sand-text-secondary);color-scheme:dark;
      opacity:1;transition:opacity 180ms ease; }
    #mengel-remote-audio[hidden] { display:none; }
    #mengel-remote-audio[data-idle="true"] { opacity:0;pointer-events:none; }
    @media (prefers-reduced-motion:reduce) { #mengel-remote-audio { transition:none; } }
    #mengel-remote-sound { display:grid;place-items:center;box-sizing:border-box;min-width:0;width:28px;height:28px;flex:0 0 28px;
      margin:0;padding:4px;border:0;border-radius:8px;background:transparent;color:inherit;cursor:pointer;
      transition:background-color 120ms,color 120ms; }
    #mengel-remote-sound:hover { background:var(--sand-fill-ghost-hover);color:var(--sand-text-primary); }
    #mengel-remote-sound:focus-visible,#mengel-remote-volume:focus-visible { outline:2px solid var(--sand-border-focus);outline-offset:2px; }
    #mengel-remote-sound[data-connecting="true"] { opacity:.5; }
    #mengel-remote-volume { appearance:none;-webkit-appearance:none;width:88px;height:28px;
      box-sizing:border-box;padding:0;min-width:0;margin:0;border:0;cursor:pointer;background:transparent;
      clip-path:none;overflow:visible; }
    #mengel-remote-volume::-webkit-slider-runnable-track { height:4px;margin:0;border-radius:2px;
      background:linear-gradient(to right,var(--sand-fill-primary) 0%,var(--sand-fill-primary) var(--volume),var(--sand-fill-control-track) var(--volume),var(--sand-fill-control-track) 100%); }
    #mengel-remote-volume::-webkit-slider-thumb { appearance:none;-webkit-appearance:none;
      width:10px;height:10px;margin-top:-3px;border:0;border-radius:50%;background:var(--sand-fill-primary);box-shadow:none;clip-path:none; }
  `;
  const button = document.createElement("button");
  button.type = "button";
  button.id = "mengel-remote-sound";
  const slider = document.createElement("input");
  slider.id = "mengel-remote-volume";
  slider.type = "range"; slider.min = "0"; slider.max = "100"; slider.step = "1";
  slider.setAttribute("aria-label", "Remote computer volume");
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  let adjusting = false;
  const clearIdle = () => { if (idleTimer != null) clearTimeout(idleTimer); idleTimer = null; };
  const reveal = () => {
    clearIdle();
    if (!visible) return;
    controls.setAttribute("data-idle", "false");
    if (!adjusting) idleTimer = setTimeout(() => {
      idleTimer = null;
      controls.setAttribute("data-idle", "true");
    }, 3000);
  };
  // Only activity at the volume control resets its timer, never browser activity.
  for (const event of ["pointerenter", "pointermove", "keydown", "wheel"]) {
    controls.addEventListener(event, reveal, { passive: true });
  }
  // The faded control passes clicks through. Moving into its bounds reveals it.
  document.addEventListener("pointermove", event => {
    if (!visible || controls.hidden) return;
    const bounds = controls.getBoundingClientRect();
    if (event.clientX >= bounds.left && event.clientX <= bounds.right &&
        event.clientY >= bounds.top && event.clientY <= bounds.bottom) reveal();
  }, { passive: true, capture: true });
  controls.addEventListener("pointerdown", () => { adjusting = true; reveal(); });
  const finishAdjusting = () => { if (adjusting) { adjusting = false; reveal(); } };
  document.addEventListener("pointerup", finishAdjusting, { passive: true });
  document.addEventListener("pointercancel", finishAdjusting, { passive: true });
  controls.addEventListener("focusin", reveal);
  controls.addEventListener("focusout", reveal);
  controls.addEventListener("input", reveal);
  const speaker = '<path d="M10 4 5 8H2v4h3l5 4V4Z"/>';
  const label = () => {
    const level = enabled ? Math.round(volume * 100) : 0;
    const action = !enabled ? "Unmute" : failed ? "Reconnect audio" : starting ? "Mute" : (media != null || context?.state === "running") && running ? "Mute" : "Enable audio";
    button.innerHTML = `<svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${speaker}${!enabled ? '<path d="m14 7 5 6m0-6-5 6"/>' : level <= 50 ? '<path d="M13 7a4 4 0 0 1 0 6"/>' : '<path d="M13 7a4 4 0 0 1 0 6m2-9a8 8 0 0 1 0 12"/>'}</svg>`;
    button.title = starting ? "Connecting audio…" : `${action} remote computer`;
    button.setAttribute("aria-label", `${action} remote computer`);
    button.setAttribute("aria-pressed", String(!enabled));
    button.setAttribute("data-connecting", String(starting));
    slider.value = String(level);
    slider.title = `Volume: ${level}%`;
    slider.setAttribute("aria-valuetext", `${level}%`);
    slider.style.setProperty("--volume", `${level}%`);
  };
  const applyVolume = () => {
    if (media) { media.muted = !enabled; media.volume = volume; }
    if (context && gain) {
      gain.gain.cancelScheduledValues(context.currentTime);
      gain.gain.setTargetAtTime(enabled ? volume : 0, context.currentTime, 0.015);
    }
  };
  const save = () => {
    try {
      localStorage.setItem("mengel-remote-sound", enabled ? "on" : "muted");
      localStorage.setItem("mengel-remote-volume", String(volume));
    } catch {}
  };
  const stop = () => {
    generation++; starting = false; running = false;
    if (timer != null) clearTimeout(timer);
    timer = null;
    for (const node of active) { try { node.stop(); } catch {} }
    active.clear(); nextTime = 0;
    void edge.stopAudio().catch(() => {});
    void context?.suspend().catch(() => {});
    label();
  };
  const start = async () => {
    if (!visible || !enabled || starting || running) return;
    if (media) { applyVolume(); running = true; failed = false; void media.play().catch(() => { running = false; label(); }); label(); return; }
    starting = true; failed = false; label();
    const current = ++generation;
    try {
      context ??= new AudioContext({ sampleRate: 48000, latencyHint: "interactive" });
      if (gain == null) { gain = context.createGain(); gain.connect(context.destination); }
      applyVolume();
      context.onstatechange = label;
      void context.resume().catch(() => {});
      const result = await edge.startAudio();
      if (generation !== current) return;
      if (!result.supported) { controls.hidden = true; starting = false; return; }
      if (!result.started) throw new Error("Sound connection interrupted");
      starting = false; running = true; label();
      const poll = async () => {
        if (generation !== current) return;
        try {
          const { bytes, error } = await edge.readAudio();
          if (generation !== current) return;
          if (error) throw new Error(error);
          if (bytes.byteLength > 0 && context?.state === "running") {
            const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
            const frames = Math.floor(bytes.byteLength / 8);
            const buffer = context.createBuffer(2, frames, 48000);
            for (let channel = 0; channel < 2; channel++) {
              const data = buffer.getChannelData(channel);
              for (let i = 0; i < frames; i++) data[i] = view.getFloat32(i * 8 + channel * 4, true);
            }
            // Drop delayed audio rather than accumulating lag after a stall.
            if (nextTime < context.currentTime || nextTime > context.currentTime + 0.3) {
              for (const node of active) { try { node.stop(); } catch {} }
              active.clear(); nextTime = context.currentTime + 0.04;
            }
            const node = context.createBufferSource(); node.buffer = buffer;
            node.connect(gain!); active.add(node);
            node.onended = () => { active.delete(node); node.disconnect(); };
            node.start(nextTime); nextTime += buffer.duration;
          }
          timer = setTimeout(poll, 40);
        } catch {
          if (generation !== current) return;
          stop(); failed = true; label();
        }
      };
      void poll();
    } catch {
      if (generation !== current) return;
      stop(); failed = true; label();
    }
  };
  button.addEventListener("click", () => {
    if (enabled && (starting || running && (media != null || context?.state === "running"))) { enabled = false; applyVolume(); stop(); }
    else { enabled = true; applyVolume(); void context?.resume().catch(() => {}); void start(); }
    save(); label();
  });
  slider.addEventListener("input", () => {
    const value = Number(slider.value) / 100;
    if (!Number.isFinite(value)) return;
    enabled = value > 0;
    // Keep the last audible level so clicking unmute restores it.
    if (enabled) volume = Math.min(1, value);
    applyVolume();
    if (enabled) { void context?.resume().catch(() => {}); void start(); } else stop();
    save(); label();
  });
  // A click anywhere in the computer is also a valid browser audio gesture.
  document.addEventListener("pointerdown", event => { if (controls.contains(event.target as Node)) return; if (enabled && visible) { void context?.resume().catch(() => {}); void start(); } }, { passive: true });
  renderer.on(VNC_VIEWER_VISIBLE_CHANNEL, (_event, value) => {
    visible = value === true;
    if (visible) { reveal(); void start(); }
    else { clearIdle(); adjusting = false; stop(); }
  });
  window.addEventListener("pagehide", () => { clearIdle(); stop(); void context?.close(); }, { once: true });
  label();
  controls.append(button, slider);
  const mount = () => document.body.append(style, controls);
  if (document.body) mount(); else document.addEventListener("DOMContentLoaded", mount, { once: true });
  return {
    prepareMediaElement(value) { value.muted = !enabled; value.volume = volume; },
    setMediaElement(value) { stop(); media = value; applyVolume(); if (visible) void start(); label(); },
  };
}
