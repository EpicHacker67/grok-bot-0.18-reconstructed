import { VNC_VIEWER_VISIBLE_CHANNEL } from "../shared/vnc-viewer-visibility.js";
export interface RemoteVideoEdge {
  startVideo(offer: { type: string; sdp: string }): Promise<{ supported: boolean; type?: "answer"; sdp?: string }>;
  stopVideo(): Promise<unknown>;
}

// VNC retains keyboard, mouse, clipboard, and the fallback image. The video is
// aligned to its canvas and never intercepts input or the volume controls.
export function installRemoteVideo(edge: RemoteVideoEdge, renderer: { on(channel: string, fn: (event: unknown, value: unknown) => void): void }, audio: { prepareMediaElement(media: HTMLVideoElement): void; setMediaElement(media: HTMLVideoElement | null): void } | undefined): void {
  if (!location.pathname.endsWith("/vnc.html") || new URLSearchParams(location.search).get("sandInteractive") !== "1") return;
  let visible = false, generation = 0, peer: RTCPeerConnection | null = null, element: HTMLVideoElement | null = null;
  let watchdog: ReturnType<typeof setInterval> | null = null, retry: ReturnType<typeof setTimeout> | null = null;
  let observer: ResizeObserver | null = null;
  const status = (value: string) => { document.documentElement.dataset.mengelStream = value; };
  const stop = () => {
    generation++; if (watchdog) clearInterval(watchdog); watchdog = null;
    if (retry) clearTimeout(retry); retry = null;
    observer?.disconnect(); observer = null;
    peer?.close(); peer = null;
    if (element) { audio?.setMediaElement(null); element.pause(); element.srcObject = null; element.remove(); element = null; }
    void edge.stopVideo().catch(() => {}); status("vnc");
  };
  const start = async () => {
    if (!visible || peer) return;
    const current = ++generation;
    const pc = new RTCPeerConnection({ iceServers: [] }); peer = pc;
    const video = document.createElement("video"); element = video;
    video.id = "mengel-desktop-video"; video.autoplay = true; video.playsInline = true; video.muted = true;
    audio?.prepareMediaElement(video);
    video.setAttribute("aria-hidden", "true");
    Object.assign(video.style, { position: "fixed", pointerEvents: "none", zIndex: "2147483646", objectFit: "fill", opacity: "0.001", background: "#111" });
    document.body.append(video);
    const align = () => {
      const canvas = document.querySelector<HTMLCanvasElement>("#noVNC_container canvas");
      if (!canvas) return;
      const r = canvas.getBoundingClientRect();
      Object.assign(video.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
    };
    observer = new ResizeObserver(align); observer.observe(document.body);
    const stream = new MediaStream();
    pc.addTransceiver("video", { direction: "recvonly" }); pc.addTransceiver("audio", { direction: "recvonly" });
    pc.ontrack = event => {
      if ("jitterBufferTarget" in event.receiver) event.receiver.jitterBufferTarget = 0;
      stream.addTrack(event.track); video.srcObject = stream; void video.play().catch(() => {});
    };
    let ready = false, lastFrames = 0, lastTime = performance.now(), lastProgress = performance.now();
    const fail = () => {
      if (current !== generation) return;
      stop();
      if (visible) retry = setTimeout(() => { retry = null; void start(); }, 10000);
    };
    pc.onconnectionstatechange = () => { if (["failed", "closed"].includes(pc.connectionState)) fail(); };
    video.addEventListener("playing", () => {
      if (current !== generation) return;
      align(); video.style.opacity = "1"; ready = true; lastProgress = performance.now();
      audio?.setMediaElement(video); status("webrtc");
    }, { once: true });
    watchdog = setInterval(async () => {
      if (current !== generation) return;
      align();
      try {
        const stats = await pc.getStats();
        stats.forEach(report => {
          if (report.type === "inbound-rtp" && report.kind === "audio") {
            document.documentElement.dataset.mengelAudioStats = JSON.stringify({ energy: report.totalAudioEnergy, samples: report.totalSamplesReceived, concealed: report.concealedSamples, packetsLost: report.packetsLost });
          }
          if (report.type !== "inbound-rtp" || report.kind !== "video") return;
          const now = performance.now(), frames = Number(report.framesDecoded ?? 0);
          if (frames > lastFrames) lastProgress = now;
          document.documentElement.dataset.mengelStreamStats = JSON.stringify({
            fps: Math.round((frames - lastFrames) * 1000 / Math.max(1, now - lastTime)),
            frames, dropped: report.framesDropped, width: report.frameWidth, height: report.frameHeight,
            decoder: report.decoderImplementation, powerEfficient: report.powerEfficientDecoder,
            decodeMs: frames ? Math.round(1000 * report.totalDecodeTime / frames * 10) / 10 : 0,
            jitterMs: Math.round((report.jitter ?? 0) * 1000), packetsLost: report.packetsLost,
          });
          lastFrames = frames; lastTime = now;
        });
        if (performance.now() - lastProgress > (ready ? 5000 : 20000)) fail();
      } catch { fail(); }
    }, 2000);
    try {
      status("connecting");
      await pc.setLocalDescription(await pc.createOffer());
      await new Promise<void>((resolve, reject) => {
        if (pc.iceGatheringState === "complete") { resolve(); return; }
        const timer = setTimeout(() => reject(new Error("ICE gathering timed out")), 5000);
        pc.addEventListener("icegatheringstatechange", () => { if (pc.iceGatheringState === "complete") { clearTimeout(timer); resolve(); } });
      });
      if (current !== generation) return;
      const answer = await edge.startVideo({ type: "offer", sdp: pc.localDescription!.sdp });
      if (current !== generation) return;
      if (!answer.supported) { stop(); return; }
      if (typeof answer.sdp !== "string") throw new Error("Missing video answer");
      await pc.setRemoteDescription({ type: "answer", sdp: answer.sdp });
    } catch (error) { console.warn("[mengel:video]", error instanceof Error ? error.message : "Connection failed"); fail(); }
  };
  renderer.on(VNC_VIEWER_VISIBLE_CHANNEL, (_event, value) => {
    visible = value === true;
    if (visible) { if (document.body) void start(); else document.addEventListener("DOMContentLoaded", () => { if (visible) void start(); }, { once: true }); }
    else stop();
  });
  window.addEventListener("pagehide", () => { visible = false; stop(); }, { once: true });
}
