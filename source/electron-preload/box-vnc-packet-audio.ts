import type { AudioPlaybackTarget } from "./box-vnc-audio.js";

// A fixed presentation window tolerates ordinary network jitter without letting
// adaptive buffering put sound further and further behind desktop video.
export const AUDIO_LEAD_SECONDS = 0.12;
export const AUDIO_MAX_QUEUE_SECONDS = 0.15;

export function createPacketAudio(pc: RTCPeerConnection, output: (target: AudioPlaybackTarget | null) => void) {
  if (typeof AudioDecoder === "undefined") return null;
  let context: AudioContext | null = null, gain: GainNode | null = null;
  let decoder: AudioDecoder | null = null, closed = false, active = false;
  let volume = 1, muted = true, next = 0, lastReceived = 0, lastSequence: number | null = null;
  let lastStamp: number | null = null, timestamp = 0, played = 0, resets = 0, dropped = 0;
  let maxArrivalGapMs = 0, lastDecoded = 0, maxDecodeGapMs = 0, stale = 0;
  let decodeAgeMs = 0;
  let arrivalOffset = Infinity, playbackOffset: number | null = null;
  const nodes = new Set<AudioBufferSourceNode>();
  const pending: number[] = [];
  const apply = () => { if (gain && context) gain.gain.setValueAtTime(muted ? 0 : volume, context.currentTime); };
  const target: AudioPlaybackTarget = {
    get volume() { return volume; }, set volume(value) { volume = value; apply(); },
    get muted() { return muted; }, set muted(value) { muted = value; apply(); },
    async play() { if (context) await context.resume(); },
  };
  const clear = () => {
    for (const node of nodes) { try { node.stop(); node.disconnect(); } catch {} }
    nodes.clear(); next = 0; playbackOffset = null;
  };
  const channel = pc.createDataChannel("mengel-audio-v1", { ordered: false, maxRetransmits: 0 });
  channel.binaryType = "arraybuffer";
  const close = () => {
    if (closed) return;
    closed = true; clearInterval(watchdog); clear(); pending.length = 0; channel.close();
    if (active) { active = false; output(null); }
    if (decoder?.state !== "closed") decoder?.close();
    void context?.close().catch(() => {});
  };
  // Remain on packet playback during a short network stall. Switching back to
  // the RTP receiver would suddenly play its older, independently buffered sound.
  const watchdog = setInterval(() => { if (active && performance.now() - lastReceived > 250) clear(); }, 100);
  channel.onclose = close;
  channel.onerror = close;
  try {
    decoder = new AudioDecoder({
      error: close,
      output(frame) {
        try {
          // Chromium's Opus decoder can synthesize contiguous output timestamps
          // across dropped input packets. Retain the capture time ourselves.
          const sampleTime = pending.shift();
          if (sampleTime === undefined) return;
          if (closed || !context || !gain || context.state !== "running") return;
          // Protocol v1 carries exactly one 10 ms stereo Opus frame per message.
          if (frame.numberOfFrames !== 480 || frame.numberOfChannels !== 2 || frame.sampleRate !== 48000) { close(); return; }
          const now = performance.now();
          if (lastDecoded) maxDecodeGapMs = Math.max(maxDecodeGapMs, now - lastDecoded);
          lastDecoded = now;
          // Apply the deadline after decoding too: a busy renderer must not
          // drain its decoder backlog into a fresh queue of obsolete sound.
          const age = (now - arrivalOffset - sampleTime / 1000) / 1000;
          decodeAgeMs = Math.round(age * 1000);
          if (age > AUDIO_LEAD_SECONDS - 0.005) { dropped++; stale++; return; }
          const desiredOffset = context.currentTime + AUDIO_LEAD_SECONDS - age - sampleTime / 1000000;
          if (playbackOffset === null || Math.abs(playbackOffset - desiredOffset) > 0.015) {
            clear(); playbackOffset = desiredOffset; resets++;
          }
          const time = playbackOffset + sampleTime / 1000000;
          const duration = frame.numberOfFrames / frame.sampleRate;
          if (time < context.currentTime || time + duration > context.currentTime + AUDIO_MAX_QUEUE_SECONDS) {
            dropped++; stale++; return;
          }
          const buffer = context.createBuffer(2, frame.numberOfFrames, frame.sampleRate);
          for (let i = 0; i < 2; i++) frame.copyTo(buffer.getChannelData(i), { planeIndex: i, format: "f32-planar" });
          const node = context.createBufferSource(); node.buffer = buffer; node.connect(gain);
          nodes.add(node); node.onended = () => { nodes.delete(node); node.disconnect(); };
          node.start(time); next = time + duration; played++;
          if (!active) { active = true; output(target); }
        } finally { frame.close(); }
      },
    });
    decoder.configure({ codec: "opus", sampleRate: 48000, numberOfChannels: 2 });
  } catch { close(); return null; }
  channel.onmessage = event => {
    if (closed || !(event.data instanceof ArrayBuffer) || event.data.byteLength < 7 || event.data.byteLength > 1506) return;
    const bytes = new Uint8Array(event.data), view = new DataView(event.data);
    const sequence = view.getUint16(4), stamp = view.getUint32(0);
    const step = lastSequence === null ? 1 : (sequence - lastSequence + 65536) % 65536;
    if (step === 0 || step > 32767) { dropped++; return; }
    const delta = lastStamp === null ? 0 : (stamp - lastStamp + 4294967296) % 4294967296;
    const now = performance.now(), elapsed = lastReceived ? now - lastReceived : 0;
    maxArrivalGapMs = Math.max(maxArrivalGapMs, elapsed);
    if (delta > 48000 * 5) { clear(); timestamp = 0; arrivalOffset = Infinity; }
    else timestamp += delta;
    lastStamp = stamp; lastSequence = sequence; lastReceived = now;
    // Estimate clock offset from the quickest packets. Allow slow clock drift
    // (up to 1 ms/s), without treating a stalled connection as a new low latency.
    arrivalOffset = Math.min(arrivalOffset + Math.min(elapsed, 1000) * 0.001, now - timestamp / 48);
    if (now - timestamp / 48 - arrivalOffset > AUDIO_LEAD_SECONDS * 1000 - 5) { dropped++; stale++; return; }
    try {
      if (!context) {
        context = new AudioContext({ sampleRate: 48000, latencyHint: "interactive" });
        gain = context.createGain(); gain.connect(context.destination); apply();
      }
      if (context.state !== "running") void context.resume().catch(() => {});
      if (pending.length >= 8 || decoder!.decodeQueueSize > 8) { dropped++; return; }
      const sampleTime = Math.round(timestamp * 1000000 / 48000);
      pending.push(sampleTime);
      decoder!.decode(new EncodedAudioChunk({ type: "key", timestamp: sampleTime, data: bytes.subarray(6) }));
    } catch { close(); }
  };
  return {
    close, get active() { return active; }, target,
    stats: () => ({ mode: active ? "packet" : "rtp", played, resets, dropped, stale, decodeAgeMs, maxArrivalGapMs: Math.round(maxArrivalGapMs), maxDecodeGapMs: Math.round(maxDecodeGapMs), queueMs: context ? Math.max(0, Math.round((next - context.currentTime) * 1000)) : 0, outputMs: context ? Math.round((context.outputLatency ?? 0) * 1000) : null }),
  };
}
