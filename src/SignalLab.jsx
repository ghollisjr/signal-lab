import { useState, useEffect, useRef, useCallback, useMemo } from "react";

// Hook for non-passive wheel events (prevents page scroll)
function useNonPassiveWheel(handler) {
  const ref = useRef(null);
  const handlerRef = useRef(handler);
  handlerRef.current = handler;
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const fn = (e) => handlerRef.current(e);
    el.addEventListener("wheel", fn, { passive: false });
    return () => el.removeEventListener("wheel", fn);
  }, []);
  return ref;
}

// ─── Signal Generators ───────────────────────────────────────────────────────
const generators = {
  sine: (t, freq) => Math.sin(2 * Math.PI * freq * t),
  square: (t, freq) => Math.sign(Math.sin(2 * Math.PI * freq * t)),
  triangle: (t, freq) => {
    const p = 1 / freq;
    const v = ((t % p) + p) % p;
    return 4 * Math.abs(v / p - 0.5) - 1;
  },
  sawtooth: (t, freq) => {
    const p = 1 / freq;
    const v = ((t % p) + p) % p;
    return 2 * (v / p) - 1;
  },
  noise: () => Math.random() * 2 - 1,
  pcm: (t, freq, pcmData) => {
    if (!pcmData || pcmData.length === 0) return 0;
    const idx = ((t * 44100) % pcmData.length + pcmData.length) % pcmData.length;
    const i = Math.floor(idx);
    const frac = idx - i;
    const a = pcmData[i] || 0;
    const b = pcmData[(i + 1) % pcmData.length] || 0;
    return a + frac * (b - a);
  },
};

// ─── Effect Processors ───────────────────────────────────────────────────────

function processCompressor(sample, params, state) {
  const { threshold, ratio, attack, release, makeupGain } = params;
  const threshLin = Math.pow(10, threshold / 20);
  const absSample = Math.abs(sample);
  const targetGain = absSample > threshLin
    ? threshLin * Math.pow(absSample / threshLin, 1 / ratio) / (absSample || 1e-10)
    : 1;
  const coeff = targetGain < state.envelope ? attack : release;
  state.envelope = state.envelope + coeff * (targetGain - state.envelope);
  const gain = Math.pow(10, makeupGain / 20);
  return sample * state.envelope * gain;
}

function processGain(sample, params) {
  return sample * Math.pow(10, params.gainDb / 20);
}

function processDelay(sample, params, state, sampleRate) {
  const delaySamples = Math.floor(params.time * sampleRate);
  if (!state.buffer) {
    state.buffer = new Float32Array(Math.max(sampleRate * 2, delaySamples + 1));
    state.writeIdx = 0;
  }
  if (delaySamples >= state.buffer.length) {
    const newBuf = new Float32Array(delaySamples + 1);
    newBuf.set(state.buffer);
    state.buffer = newBuf;
  }
  const readIdx = (state.writeIdx - delaySamples + state.buffer.length) % state.buffer.length;
  const delayed = state.buffer[readIdx];
  const output = sample + delayed * params.feedback;
  state.buffer[state.writeIdx] = output;
  state.writeIdx = (state.writeIdx + 1) % state.buffer.length;
  return sample * (1 - params.mix) + delayed * params.mix;
}

function processChorus(sample, params, state, sampleRate) {
  if (!state.buffer) {
    state.buffer = new Float32Array(sampleRate);
    state.writeIdx = 0;
    state.lfoPhase = 0;
  }
  state.buffer[state.writeIdx] = sample;
  state.lfoPhase += params.rate / sampleRate;
  if (state.lfoPhase > 1) state.lfoPhase -= 1;
  const lfo = Math.sin(2 * Math.PI * state.lfoPhase);
  const delayMs = params.delay + lfo * params.depth;
  const delaySamples = (delayMs / 1000) * sampleRate;
  const readIdx = (state.writeIdx - delaySamples + state.buffer.length) % state.buffer.length;
  const i = Math.floor(readIdx);
  const frac = readIdx - i;
  const a = state.buffer[(i + state.buffer.length) % state.buffer.length];
  const b = state.buffer[(i + 1) % state.buffer.length];
  const delayed = a + frac * (b - a);
  state.writeIdx = (state.writeIdx + 1) % state.buffer.length;
  return sample * (1 - params.mix) + delayed * params.mix;
}

function processFlanger(sample, params, state, sampleRate) {
  if (!state.buffer) {
    state.buffer = new Float32Array(sampleRate);
    state.writeIdx = 0;
    state.lfoPhase = 0;
  }
  state.buffer[state.writeIdx] = sample + (state.lastOut || 0) * params.feedback;
  state.lfoPhase += params.rate / sampleRate;
  if (state.lfoPhase > 1) state.lfoPhase -= 1;
  const lfo = Math.sin(2 * Math.PI * state.lfoPhase);
  const delayMs = 1 + lfo * params.depth;
  const delaySamples = (delayMs / 1000) * sampleRate;
  const readIdx = (state.writeIdx - delaySamples + state.buffer.length) % state.buffer.length;
  const i = Math.floor(readIdx);
  const frac = readIdx - i;
  const a = state.buffer[(i + state.buffer.length) % state.buffer.length];
  const b = state.buffer[(i + 1) % state.buffer.length];
  const delayed = a + frac * (b - a);
  state.lastOut = delayed;
  state.writeIdx = (state.writeIdx + 1) % state.buffer.length;
  return sample * (1 - params.mix) + delayed * params.mix;
}

function processPhaser(sample, params, state, sampleRate) {
  if (!state.allpassStates) {
    state.allpassStates = Array.from({ length: 4 }, () => ({ x1: 0, y1: 0 }));
    state.lfoPhase = 0;
  }
  state.lfoPhase += params.rate / sampleRate;
  if (state.lfoPhase > 1) state.lfoPhase -= 1;
  const lfo = Math.sin(2 * Math.PI * state.lfoPhase);
  const minFreq = 200, maxFreq = 4000;
  const freq = minFreq + (maxFreq - minFreq) * (0.5 + 0.5 * lfo * params.depth);
  const w = 2 * Math.PI * freq / sampleRate;
  const c = (Math.tan(w / 2) - 1) / (Math.tan(w / 2) + 1);
  let out = sample;
  for (let i = 0; i < state.allpassStates.length; i++) {
    const s = state.allpassStates[i];
    const newY = c * out + s.x1 - c * s.y1;
    s.x1 = out;
    s.y1 = newY;
    out = newY;
  }
  return sample + out * params.mix * params.feedback;
}

function processDistortion(sample, params) {
  const driven = sample * params.drive;
  let out;
  if (params.type === "soft") {
    out = Math.tanh(driven);
  } else if (params.type === "hard") {
    out = Math.max(-1, Math.min(1, driven));
  } else {
    out = Math.sign(driven) * (1 - Math.pow(1 - Math.min(Math.abs(driven), 1), 3));
  }
  return out * params.mix + sample * (1 - params.mix);
}

function processParametricEQ(sample, params, state, sampleRate) {
  if (!state.bands) {
    state.bands = params.bands.map(() => ({ x1: 0, x2: 0, y1: 0, y2: 0 }));
  }
  let out = sample;
  params.bands.forEach((band, i) => {
    if (Math.abs(band.gain) < 0.1) return;
    const A = Math.pow(10, band.gain / 40);
    const w0 = 2 * Math.PI * band.freq / sampleRate;
    const alpha = Math.sin(w0) / (2 * band.q);
    const b0 = 1 + alpha * A;
    const b1 = -2 * Math.cos(w0);
    const b2 = 1 - alpha * A;
    const a0 = 1 + alpha / A;
    const a1 = -2 * Math.cos(w0);
    const a2 = 1 - alpha / A;
    const s = state.bands[i];
    const y = (b0 / a0) * out + (b1 / a0) * s.x1 + (b2 / a0) * s.x2 - (a1 / a0) * s.y1 - (a2 / a0) * s.y2;
    s.x2 = s.x1; s.x1 = out;
    s.y2 = s.y1; s.y1 = y;
    out = y;
  });
  return out;
}

function processGraphicEQ(sample, params, state, sampleRate) {
  const bands = [60, 170, 310, 600, 1000, 3000, 6000, 12000, 14000, 16000];
  if (!state.bands) {
    state.bands = bands.map(() => ({ x1: 0, x2: 0, y1: 0, y2: 0 }));
  }
  let out = sample;
  bands.forEach((freq, i) => {
    const gainDb = params.gains[i] || 0;
    if (Math.abs(gainDb) < 0.1) return;
    const A = Math.pow(10, gainDb / 40);
    const w0 = 2 * Math.PI * freq / sampleRate;
    const q = 1.4;
    const alpha = Math.sin(w0) / (2 * q);
    const b0 = 1 + alpha * A;
    const b1 = -2 * Math.cos(w0);
    const b2 = 1 - alpha * A;
    const a0 = 1 + alpha / A;
    const a1 = -2 * Math.cos(w0);
    const a2 = 1 - alpha / A;
    const s = state.bands[i];
    const y = (b0 / a0) * out + (b1 / a0) * s.x1 + (b2 / a0) * s.x2 - (a1 / a0) * s.y1 - (a2 / a0) * s.y2;
    s.x2 = s.x1; s.x1 = out;
    s.y2 = s.y1; s.y1 = y;
    out = y;
  });
  return out;
}

function processLowpass(sample, params, state, sampleRate) {
  if (!state.x1) { state.x1 = 0; state.x2 = 0; state.y1 = 0; state.y2 = 0; }
  const w0 = 2 * Math.PI * params.cutoff / sampleRate;
  const alpha = Math.sin(w0) / (2 * params.q);
  const cosw = Math.cos(w0);
  const b0 = (1 - cosw) / 2;
  const b1 = 1 - cosw;
  const b2 = (1 - cosw) / 2;
  const a0 = 1 + alpha;
  const a1 = -2 * cosw;
  const a2 = 1 - alpha;
  const y = (b0/a0)*sample + (b1/a0)*state.x1 + (b2/a0)*state.x2 - (a1/a0)*state.y1 - (a2/a0)*state.y2;
  state.x2 = state.x1; state.x1 = sample;
  state.y2 = state.y1; state.y1 = y;
  return y;
}

function processHighpass(sample, params, state, sampleRate) {
  if (!state.x1) { state.x1 = 0; state.x2 = 0; state.y1 = 0; state.y2 = 0; }
  const w0 = 2 * Math.PI * params.cutoff / sampleRate;
  const alpha = Math.sin(w0) / (2 * params.q);
  const cosw = Math.cos(w0);
  const b0 = (1 + cosw) / 2;
  const b1 = -(1 + cosw);
  const b2 = (1 + cosw) / 2;
  const a0 = 1 + alpha;
  const a1 = -2 * cosw;
  const a2 = 1 - alpha;
  const y = (b0/a0)*sample + (b1/a0)*state.x1 + (b2/a0)*state.x2 - (a1/a0)*state.y1 - (a2/a0)*state.y2;
  state.x2 = state.x1; state.x1 = sample;
  state.y2 = state.y1; state.y1 = y;
  return y;
}

function processReverb(sample, params, state, sampleRate) {
  if (!state.combs) {
    const combDelays = [1557, 1617, 1491, 1422, 1277, 1356, 1188, 1116].map(d => Math.floor(d * sampleRate / 44100));
    const apDelays = [225, 556, 441, 341].map(d => Math.floor(d * sampleRate / 44100));
    state.combs = combDelays.map(len => ({ buffer: new Float32Array(len), idx: 0, filter: 0 }));
    state.allpasses = apDelays.map(len => ({ buffer: new Float32Array(len), idx: 0 }));
  }
  const decay = params.decay;
  const damping = params.damping;
  let out = 0;
  for (const comb of state.combs) {
    const delayed = comb.buffer[comb.idx];
    comb.filter = delayed * (1 - damping) + comb.filter * damping;
    comb.buffer[comb.idx] = sample + comb.filter * decay;
    comb.idx = (comb.idx + 1) % comb.buffer.length;
    out += delayed;
  }
  out /= state.combs.length;
  for (const ap of state.allpasses) {
    const delayed = ap.buffer[ap.idx];
    const input = out + delayed * 0.5;
    ap.buffer[ap.idx] = input;
    out = delayed - out * 0.5;
    ap.idx = (ap.idx + 1) % ap.buffer.length;
  }
  return sample * (1 - params.mix) + out * params.mix;
}

function processTremolo(sample, params, state, sampleRate) {
  if (state.phase === undefined) state.phase = 0;
  state.phase += params.rate / sampleRate;
  if (state.phase > 1) state.phase -= 1;
  const lfo = 0.5 + 0.5 * Math.sin(2 * Math.PI * state.phase);
  const mod = 1 - params.depth * (1 - lfo);
  return sample * mod;
}

function processBitcrusher(sample, params) {
  const steps = Math.pow(2, params.bits);
  return Math.round(sample * steps) / steps;
}

// ─── Effect Definitions ──────────────────────────────────────────────────────

const EFFECT_DEFS = {
  gain: {
    label: "Gain", icon: "◊",
    defaults: { gainDb: 0 },
    controls: [{ key: "gainDb", label: "Gain (dB)", min: -24, max: 24, step: 0.5 }],
    process: processGain,
  },
  compressor: {
    label: "Compressor", icon: "⊳",
    defaults: { threshold: -20, ratio: 4, attack: 0.01, release: 0.1, makeupGain: 0 },
    controls: [
      { key: "threshold", label: "Threshold (dB)", min: -60, max: 0, step: 1 },
      { key: "ratio", label: "Ratio", min: 1, max: 20, step: 0.5 },
      { key: "attack", label: "Attack", min: 0.001, max: 0.2, step: 0.001 },
      { key: "release", label: "Release", min: 0.01, max: 1, step: 0.01 },
      { key: "makeupGain", label: "Makeup (dB)", min: 0, max: 30, step: 0.5 },
    ],
    initState: () => ({ envelope: 1 }),
    process: processCompressor,
  },
  delay: {
    label: "Delay", icon: "⧖",
    defaults: { time: 0.25, feedback: 0.4, mix: 0.5 },
    controls: [
      { key: "time", label: "Time (s)", min: 0.01, max: 1, step: 0.01 },
      { key: "feedback", label: "Feedback", min: 0, max: 0.95, step: 0.01 },
      { key: "mix", label: "Mix", min: 0, max: 1, step: 0.01 },
    ],
    initState: () => ({}),
    process: processDelay,
  },
  chorus: {
    label: "Chorus", icon: "≈",
    defaults: { rate: 1.5, depth: 3, delay: 7, mix: 0.5 },
    controls: [
      { key: "rate", label: "Rate (Hz)", min: 0.1, max: 5, step: 0.1 },
      { key: "depth", label: "Depth (ms)", min: 0, max: 10, step: 0.1 },
      { key: "delay", label: "Delay (ms)", min: 1, max: 30, step: 0.5 },
      { key: "mix", label: "Mix", min: 0, max: 1, step: 0.01 },
    ],
    initState: () => ({}),
    process: processChorus,
  },
  flanger: {
    label: "Flanger", icon: "∿",
    defaults: { rate: 0.5, depth: 3, feedback: 0.7, mix: 0.5 },
    controls: [
      { key: "rate", label: "Rate (Hz)", min: 0.05, max: 5, step: 0.05 },
      { key: "depth", label: "Depth (ms)", min: 0, max: 10, step: 0.1 },
      { key: "feedback", label: "Feedback", min: 0, max: 0.95, step: 0.01 },
      { key: "mix", label: "Mix", min: 0, max: 1, step: 0.01 },
    ],
    initState: () => ({}),
    process: processFlanger,
  },
  phaser: {
    label: "Phaser", icon: "φ",
    defaults: { rate: 0.5, depth: 0.7, feedback: 0.7, mix: 0.5 },
    controls: [
      { key: "rate", label: "Rate (Hz)", min: 0.05, max: 5, step: 0.05 },
      { key: "depth", label: "Depth", min: 0, max: 1, step: 0.01 },
      { key: "feedback", label: "Feedback", min: 0, max: 0.99, step: 0.01 },
      { key: "mix", label: "Mix", min: 0, max: 1, step: 0.01 },
    ],
    initState: () => ({}),
    process: processPhaser,
  },
  distortion: {
    label: "Distortion", icon: "⚡",
    defaults: { drive: 4, mix: 0.8, type: "soft" },
    controls: [
      { key: "drive", label: "Drive", min: 1, max: 50, step: 0.5 },
      { key: "mix", label: "Mix", min: 0, max: 1, step: 0.01 },
    ],
    process: processDistortion,
  },
  parametricEQ: {
    label: "Parametric EQ", icon: "⌇",
    defaults: {
      bands: [
        { freq: 100, gain: 0, q: 1 },
        { freq: 500, gain: 0, q: 1 },
        { freq: 2000, gain: 0, q: 1 },
        { freq: 8000, gain: 0, q: 1 },
      ],
    },
    process: processParametricEQ,
    initState: () => ({}),
    custom: true,
  },
  graphicEQ: {
    label: "Graphic EQ", icon: "▥",
    defaults: { gains: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
    process: processGraphicEQ,
    initState: () => ({}),
    custom: true,
  },
  lowpass: {
    label: "Low Pass", icon: "⌁",
    defaults: { cutoff: 2000, q: 0.707 },
    controls: [
      { key: "cutoff", label: "Cutoff (Hz)", min: 20, max: 20000, step: 10 },
      { key: "q", label: "Q", min: 0.1, max: 20, step: 0.1 },
    ],
    initState: () => ({}),
    process: processLowpass,
  },
  highpass: {
    label: "High Pass", icon: "⌁",
    defaults: { cutoff: 200, q: 0.707 },
    controls: [
      { key: "cutoff", label: "Cutoff (Hz)", min: 20, max: 20000, step: 10 },
      { key: "q", label: "Q", min: 0.1, max: 20, step: 0.1 },
    ],
    initState: () => ({}),
    process: processHighpass,
  },
  reverb: {
    label: "Reverb", icon: "⊙",
    defaults: { decay: 0.8, damping: 0.3, mix: 0.3 },
    controls: [
      { key: "decay", label: "Decay", min: 0, max: 0.99, step: 0.01 },
      { key: "damping", label: "Damping", min: 0, max: 1, step: 0.01 },
      { key: "mix", label: "Mix", min: 0, max: 1, step: 0.01 },
    ],
    initState: () => ({}),
    process: processReverb,
  },
  tremolo: {
    label: "Tremolo", icon: "∼",
    defaults: { rate: 5, depth: 0.5 },
    controls: [
      { key: "rate", label: "Rate (Hz)", min: 0.1, max: 20, step: 0.1 },
      { key: "depth", label: "Depth", min: 0, max: 1, step: 0.01 },
    ],
    initState: () => ({}),
    process: processTremolo,
  },
  bitcrusher: {
    label: "Bitcrusher", icon: "▦",
    defaults: { bits: 8 },
    controls: [
      { key: "bits", label: "Bits", min: 1, max: 16, step: 1 },
    ],
    process: processBitcrusher,
  },
};

// ─── Editable Value (click to type a number) ────────────────────────────────
function EditableValue({ value, min, max, step, onChange, style = {} }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const inputRef = useRef(null);

  const displayVal = step >= 1 ? value.toFixed(0) : step >= 0.1 ? value.toFixed(1) : step >= 0.01 ? value.toFixed(2) : value.toFixed(3);

  const commit = () => {
    const parsed = parseFloat(draft);
    if (!isNaN(parsed)) {
      const clamped = Math.max(min, Math.min(max, parsed));
      const snapped = Math.round(clamped / step) * step;
      onChange(snapped);
    }
    setEditing(false);
  };

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editing]);

  if (editing) {
    return (
      <input
        ref={inputRef}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
          if (e.key === "Escape") setEditing(false);
        }}
        style={{
          background: "#1a1a2e",
          border: "1px solid #50c8a0",
          borderRadius: 3,
          color: "#e0e0f0",
          fontFamily: "'JetBrains Mono', 'Space Mono', monospace",
          fontSize: 10,
          padding: "1px 3px",
          width: 52,
          textAlign: "center",
          outline: "none",
          ...style,
        }}
      />
    );
  }

  return (
    <span
      onClick={() => { setDraft(displayVal); setEditing(true); }}
      style={{
        fontSize: 10,
        color: "#c0c0e0",
        fontFamily: "'JetBrains Mono', 'Space Mono', monospace",
        cursor: "text",
        borderBottom: "1px dashed #3a3a5c",
        ...style,
      }}
      title="Click to edit"
    >
      {displayVal}
    </span>
  );
}

// ─── Knob Component ──────────────────────────────────────────────────────────
function Knob({ value, min, max, step, label, onChange, size = 48 }) {
  const knobRef = useRef(null);
  const dragRef = useRef(null);

  const pct = (value - min) / (max - min);
  const angle = -135 + pct * 270;

  const handleWheelNative = useCallback((e) => {
    e.preventDefault();
    const direction = e.deltaY < 0 ? 1 : -1;
    const range = max - min;
    const delta = direction * Math.max(step, range * 0.02);
    let newVal = value + delta;
    newVal = Math.round(newVal / step) * step;
    newVal = Math.max(min, Math.min(max, newVal));
    onChange(newVal);
  }, [value, min, max, step, onChange]);

  useEffect(() => {
    const el = knobRef.current;
    if (!el) return;
    el.addEventListener("wheel", handleWheelNative, { passive: false });
    return () => el.removeEventListener("wheel", handleWheelNative);
  }, [handleWheelNative]);

  const handlePointerDown = (e) => {
    e.preventDefault();
    dragRef.current = { startY: e.clientY, startVal: value };
    const onMove = (ev) => {
      const dy = dragRef.current.startY - ev.clientY;
      const range = max - min;
      const delta = (dy / 150) * range;
      let newVal = dragRef.current.startVal + delta;
      newVal = Math.round(newVal / step) * step;
      newVal = Math.max(min, Math.min(max, newVal));
      onChange(newVal);
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  const displayVal = step >= 1 ? value.toFixed(0) : step >= 0.1 ? value.toFixed(1) : value.toFixed(3);

  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 2, userSelect: "none" }}>
      <div
        ref={knobRef}
        onPointerDown={handlePointerDown}
        style={{
          width: size, height: size, borderRadius: "50%",
          background: "conic-gradient(from 225deg, #1a1a2e 0deg, #1a1a2e 315deg)",
          border: "2px solid #3a3a5c",
          position: "relative", cursor: "ns-resize",
          boxShadow: "0 2px 8px rgba(0,0,0,0.4), inset 0 1px 2px rgba(255,255,255,0.05)",
        }}
      >
        <div style={{
          position: "absolute", top: "50%", left: "50%",
          width: 2, height: size / 2 - 4,
          background: `hsl(${160 + pct * 60}, 80%, 60%)`,
          transformOrigin: "bottom center",
          transform: `translate(-50%, -100%) rotate(${angle}deg)`,
          borderRadius: 1,
          boxShadow: `0 0 6px hsla(${160 + pct * 60}, 80%, 60%, 0.5)`,
        }} />
        {/* Arc track */}
        <svg style={{ position: "absolute", top: 0, left: 0 }} width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
          <circle
            cx={size/2} cy={size/2} r={size/2 - 1}
            fill="none" stroke={`hsla(${160 + pct * 60}, 60%, 50%, 0.15)`}
            strokeWidth={2}
            strokeDasharray={`${pct * 236} 1000`}
            strokeDashoffset={-59}
            strokeLinecap="round"
          />
        </svg>
      </div>
      <span style={{ fontSize: 9, color: "#8888aa", textAlign: "center", lineHeight: 1.1, maxWidth: size + 10 }}>{label}</span>
      <EditableValue value={value} min={min} max={max} step={step} onChange={onChange} style={{ marginTop: -2 }} />
    </div>
  );
}

// ─── Graphic EQ Panel ────────────────────────────────────────────────────────
function GraphicEQPanel({ params, onChange }) {
  const freqs = ["60", "170", "310", "600", "1k", "3k", "6k", "12k", "14k", "16k"];
  return (
    <div style={{ display: "flex", gap: 4, alignItems: "flex-end", padding: "8px 4px" }}>
      {freqs.map((f, i) => (
        <div key={i} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 2 }}>
          <input
            type="range" min={-12} max={12} step={0.5}
            value={params.gains[i]}
            onChange={(e) => {
              const g = [...params.gains];
              g[i] = parseFloat(e.target.value);
              onChange({ ...params, gains: g });
            }}
            style={{
              writingMode: "vertical-lr", direction: "rtl",
              height: 80, width: 18, accentColor: "#50c8a0",
              cursor: "pointer",
            }}
          />
          <span style={{ fontSize: 8, color: "#8888aa" }}>{f}</span>
          <EditableValue
            value={params.gains[i]} min={-12} max={12} step={0.5}
            onChange={(v) => {
              const g = [...params.gains];
              g[i] = v;
              onChange({ ...params, gains: g });
            }}
            style={{ fontSize: 8 }}
          />
        </div>
      ))}
    </div>
  );
}

// ─── Parametric EQ Panel ─────────────────────────────────────────────────────
function ParametricEQPanel({ params, onChange }) {
  const colors = ["#ff6b8a", "#ffaa5c", "#50c8a0", "#6b9fff"];
  return (
    <div style={{ display: "flex", gap: 12, flexWrap: "wrap", padding: 4 }}>
      {params.bands.map((band, i) => (
        <div key={i} style={{
          display: "flex", flexDirection: "column", gap: 4,
          padding: "6px 8px", borderRadius: 6,
          background: `${colors[i]}11`, border: `1px solid ${colors[i]}33`,
        }}>
          <span style={{ fontSize: 9, color: colors[i], fontWeight: 600 }}>Band {i + 1}</span>
          <Knob value={band.freq} min={20} max={16000} step={10} label="Freq" size={36}
            onChange={(v) => {
              const b = [...params.bands]; b[i] = { ...b[i], freq: v };
              onChange({ ...params, bands: b });
            }}
          />
          <Knob value={band.gain} min={-18} max={18} step={0.5} label="Gain" size={36}
            onChange={(v) => {
              const b = [...params.bands]; b[i] = { ...b[i], gain: v };
              onChange({ ...params, bands: b });
            }}
          />
          <Knob value={band.q} min={0.1} max={20} step={0.1} label="Q" size={36}
            onChange={(v) => {
              const b = [...params.bands]; b[i] = { ...b[i], q: v };
              onChange({ ...params, bands: b });
            }}
          />
        </div>
      ))}
    </div>
  );
}

// ─── Effect Card ─────────────────────────────────────────────────────────────
function EffectCard({ effect, onUpdate, onRemove, onToggle, onMoveUp, onMoveDown, isFirst, isLast }) {
  const def = EFFECT_DEFS[effect.type];
  const [collapsed, setCollapsed] = useState(false);

  return (
    <div style={{
      background: effect.enabled ? "#1a1a2e" : "#14141f",
      border: `1px solid ${effect.enabled ? "#3a3a5c" : "#2a2a3c"}`,
      borderRadius: 8, padding: "8px 10px", opacity: effect.enabled ? 1 : 0.5,
      transition: "all 0.2s",
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: collapsed ? 0 : 8 }}>
        <span style={{ fontSize: 16, width: 22, textAlign: "center" }}>{def.icon}</span>
        <span style={{
          fontSize: 12, fontWeight: 700, color: "#e0e0f0",
          fontFamily: "'Space Mono', monospace", flex: 1,
          letterSpacing: "0.04em",
        }}>{def.label}</span>
        <button onClick={() => onMoveUp()} disabled={isFirst} style={smallBtnStyle}>▲</button>
        <button onClick={() => onMoveDown()} disabled={isLast} style={smallBtnStyle}>▼</button>
        <button onClick={() => setCollapsed(!collapsed)} style={smallBtnStyle}>{collapsed ? "+" : "−"}</button>
        <button onClick={onToggle} style={{
          ...smallBtnStyle,
          background: effect.enabled ? "#50c8a044" : "#44444466",
          color: effect.enabled ? "#50c8a0" : "#888",
        }}>{effect.enabled ? "ON" : "OFF"}</button>
        <button onClick={onRemove} style={{ ...smallBtnStyle, color: "#ff6b8a" }}>✕</button>
      </div>
      {!collapsed && (
        effect.type === "graphicEQ" ? (
          <GraphicEQPanel params={effect.params} onChange={(p) => onUpdate({ ...effect, params: p })} />
        ) : effect.type === "parametricEQ" ? (
          <ParametricEQPanel params={effect.params} onChange={(p) => onUpdate({ ...effect, params: p })} />
        ) : effect.type === "distortion" ? (
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "flex-end" }}>
            {def.controls.map(c => (
              <Knob key={c.key} value={effect.params[c.key]} min={c.min} max={c.max}
                step={c.step} label={c.label}
                onChange={(v) => onUpdate({ ...effect, params: { ...effect.params, [c.key]: v } })}
              />
            ))}
            <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
              <span style={{ fontSize: 9, color: "#8888aa" }}>Type</span>
              <select value={effect.params.type}
                onChange={(e) => onUpdate({ ...effect, params: { ...effect.params, type: e.target.value } })}
                style={selectStyle}
              >
                <option value="soft">Soft</option>
                <option value="hard">Hard</option>
                <option value="tube">Tube</option>
              </select>
            </div>
          </div>
        ) : (
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {def.controls?.map(c => (
              <Knob key={c.key} value={effect.params[c.key]} min={c.min} max={c.max}
                step={c.step} label={c.label}
                onChange={(v) => onUpdate({ ...effect, params: { ...effect.params, [c.key]: v } })}
              />
            ))}
          </div>
        )
      )}
    </div>
  );
}

const smallBtnStyle = {
  background: "#2a2a44", border: "1px solid #3a3a5c", color: "#b0b0d0",
  borderRadius: 4, padding: "2px 6px", fontSize: 10, cursor: "pointer",
  fontFamily: "monospace",
};

const selectStyle = {
  background: "#1a1a2e", border: "1px solid #3a3a5c", color: "#c0c0e0",
  borderRadius: 4, padding: "4px 6px", fontSize: 11, cursor: "pointer",
  fontFamily: "'Space Mono', monospace",
};

// ─── Waveform Canvas ─────────────────────────────────────────────────────────
function WaveformCanvas({ dryBuffer, wetBufferL, wetBufferR, bufferLen, isStereo, viewWindow }) {
  const canvasRef = useRef(null);
  const animRef = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    const dpr = window.devicePixelRatio || 1;

    const draw = () => {
      const rect = canvas.getBoundingClientRect();
      canvas.width = rect.width * dpr;
      canvas.height = rect.height * dpr;
      ctx.scale(dpr, dpr);
      const w = rect.width;
      const h = rect.height;

      ctx.fillStyle = "#0d0d18";
      ctx.fillRect(0, 0, w, h);

      // Grid
      ctx.strokeStyle = "#1a1a30";
      ctx.lineWidth = 0.5;
      for (let i = 0; i <= 10; i++) {
        const x = (i / 10) * w;
        ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
      }
      const channels = isStereo ? 2 : 1;
      const channelH = h / channels;

      for (let ch = 0; ch < channels; ch++) {
        const yOff = ch * channelH;
        const midY = yOff + channelH / 2;

        // Horizontal grid
        for (let g = -1; g <= 1; g += 0.5) {
          const gy = midY - g * (channelH / 2 - 10);
          ctx.strokeStyle = g === 0 ? "#2a2a4a" : "#1a1a30";
          ctx.lineWidth = g === 0 ? 1 : 0.5;
          ctx.beginPath(); ctx.moveTo(0, gy); ctx.lineTo(w, gy); ctx.stroke();
        }

        if (isStereo && ch === 0) {
          ctx.strokeStyle = "#2a2a44";
          ctx.lineWidth = 1;
          ctx.beginPath(); ctx.moveTo(0, channelH); ctx.lineTo(w, channelH); ctx.stroke();
        }

        // Channel label
        if (isStereo) {
          ctx.fillStyle = "#4a4a6a";
          ctx.font = "10px 'Space Mono', monospace";
          ctx.fillText(ch === 0 ? "L" : "R", 6, yOff + 14);
        }

        const wetBuf = ch === 0 ? wetBufferL : wetBufferR;
        const scale = channelH / 2 - 10;

        // Dry signal (dimmed)
        ctx.beginPath();
        ctx.strokeStyle = "#3a5a70";
        ctx.lineWidth = 1;
        ctx.globalAlpha = 0.3;
        for (let px = 0; px < w; px++) {
          const sampleIdx = Math.floor((px / w) * viewWindow);
          const idx = (bufferLen - viewWindow + sampleIdx + dryBuffer.length) % dryBuffer.length;
          const v = dryBuffer[idx] || 0;
          const y = midY - v * scale;
          px === 0 ? ctx.moveTo(px, y) : ctx.lineTo(px, y);
        }
        ctx.stroke();
        ctx.globalAlpha = 1;

        // Wet signal (bright)
        ctx.beginPath();
        const gradient = ctx.createLinearGradient(0, yOff, 0, yOff + channelH);
        gradient.addColorStop(0, "#50c8a0");
        gradient.addColorStop(0.5, "#40e8b0");
        gradient.addColorStop(1, "#50c8a0");
        ctx.strokeStyle = gradient;
        ctx.lineWidth = 1.5;
        for (let px = 0; px < w; px++) {
          const sampleIdx = Math.floor((px / w) * viewWindow);
          const idx = (bufferLen - viewWindow + sampleIdx + wetBuf.length) % wetBuf.length;
          const v = wetBuf[idx] || 0;
          const y = midY - v * scale;
          px === 0 ? ctx.moveTo(px, y) : ctx.lineTo(px, y);
        }
        ctx.stroke();

        // Glow effect
        ctx.strokeStyle = "#40e8b033";
        ctx.lineWidth = 4;
        ctx.beginPath();
        for (let px = 0; px < w; px++) {
          const sampleIdx = Math.floor((px / w) * viewWindow);
          const idx = (bufferLen - viewWindow + sampleIdx + wetBuf.length) % wetBuf.length;
          const v = wetBuf[idx] || 0;
          const y = midY - v * scale;
          px === 0 ? ctx.moveTo(px, y) : ctx.lineTo(px, y);
        }
        ctx.stroke();
      }

      // Now line
      ctx.strokeStyle = "#ff6b8a44";
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(w, 0); ctx.lineTo(w, h);
      ctx.stroke();
      ctx.setLineDash([]);

      // Time axis
      ctx.fillStyle = "#6a6a8a";
      ctx.font = "9px 'Space Mono', monospace";
      const totalSec = viewWindow / 44100;
      for (let i = 0; i <= 4; i++) {
        const x = (i / 4) * w;
        const sec = -totalSec + (i / 4) * totalSec;
        let label;
        if (Math.abs(totalSec) >= 1) label = sec.toFixed(2) + "s";
        else if (Math.abs(totalSec) >= 0.001) label = (sec * 1000).toFixed(1) + "ms";
        else label = (sec * 1000000).toFixed(0) + "µs";
        ctx.fillText(label, x + 3, h - 4);
      }

      animRef.current = requestAnimationFrame(draw);
    };

    draw();
    return () => cancelAnimationFrame(animRef.current);
  }, [dryBuffer, wetBufferL, wetBufferR, bufferLen, isStereo, viewWindow]);

  return <canvas ref={canvasRef} style={{ width: "100%", height: "100%", borderRadius: 6, display: "block" }} />;
}

// ─── Static Waveform Canvas ──────────────────────────────────────────────────
function StaticCanvas({ dryBuffer, wetBufferL, wetBufferR, numSamples, isStereo }) {
  const canvasRef = useRef(null);
  const animRef = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    const dpr = window.devicePixelRatio || 1;

    const draw = () => {
      const rect = canvas.getBoundingClientRect();
      canvas.width = rect.width * dpr;
      canvas.height = rect.height * dpr;
      ctx.scale(dpr, dpr);
      const w = rect.width;
      const h = rect.height;

      ctx.fillStyle = "#0d0d18";
      ctx.fillRect(0, 0, w, h);

      // Grid
      ctx.strokeStyle = "#1a1a30";
      ctx.lineWidth = 0.5;
      for (let i = 0; i <= 10; i++) {
        const x = (i / 10) * w;
        ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
      }
      const channels = isStereo ? 2 : 1;
      const channelH = h / channels;

      for (let ch = 0; ch < channels; ch++) {
        const yOff = ch * channelH;
        const midY = yOff + channelH / 2;

        for (let g = -1; g <= 1; g += 0.5) {
          const gy = midY - g * (channelH / 2 - 10);
          ctx.strokeStyle = g === 0 ? "#2a2a4a" : "#1a1a30";
          ctx.lineWidth = g === 0 ? 1 : 0.5;
          ctx.beginPath(); ctx.moveTo(0, gy); ctx.lineTo(w, gy); ctx.stroke();
        }

        if (isStereo && ch === 0) {
          ctx.strokeStyle = "#2a2a44";
          ctx.lineWidth = 1;
          ctx.beginPath(); ctx.moveTo(0, channelH); ctx.lineTo(w, channelH); ctx.stroke();
        }

        if (isStereo) {
          ctx.fillStyle = "#4a4a6a";
          ctx.font = "10px 'Space Mono', monospace";
          ctx.fillText(ch === 0 ? "L" : "R", 6, yOff + 14);
        }

        const wetBuf = ch === 0 ? wetBufferL : wetBufferR;
        const scale = channelH / 2 - 10;
        const len = numSamples;

        // Dry signal
        ctx.beginPath();
        ctx.strokeStyle = "#3a5a70";
        ctx.lineWidth = 1;
        ctx.globalAlpha = 0.3;
        for (let px = 0; px < w; px++) {
          const idx = Math.floor((px / w) * len);
          const v = dryBuffer[idx] || 0;
          const y = midY - v * scale;
          px === 0 ? ctx.moveTo(px, y) : ctx.lineTo(px, y);
        }
        ctx.stroke();
        ctx.globalAlpha = 1;

        // Wet signal
        ctx.beginPath();
        const gradient = ctx.createLinearGradient(0, yOff, 0, yOff + channelH);
        gradient.addColorStop(0, "#50c8a0");
        gradient.addColorStop(0.5, "#40e8b0");
        gradient.addColorStop(1, "#50c8a0");
        ctx.strokeStyle = gradient;
        ctx.lineWidth = 1.5;
        for (let px = 0; px < w; px++) {
          const idx = Math.floor((px / w) * len);
          const v = wetBuf[idx] || 0;
          const y = midY - v * scale;
          px === 0 ? ctx.moveTo(px, y) : ctx.lineTo(px, y);
        }
        ctx.stroke();

        // Glow
        ctx.strokeStyle = "#40e8b033";
        ctx.lineWidth = 4;
        ctx.beginPath();
        for (let px = 0; px < w; px++) {
          const idx = Math.floor((px / w) * len);
          const v = wetBuf[idx] || 0;
          const y = midY - v * scale;
          px === 0 ? ctx.moveTo(px, y) : ctx.lineTo(px, y);
        }
        ctx.stroke();
      }

      // Time axis
      ctx.fillStyle = "#6a6a8a";
      ctx.font = "9px 'Space Mono', monospace";
      const totalSec = numSamples / 44100;
      for (let i = 0; i <= 4; i++) {
        const x = (i / 4) * w;
        const sec = (i / 4) * totalSec;
        let label;
        if (totalSec >= 1) label = sec.toFixed(2) + "s";
        else if (totalSec >= 0.001) label = (sec * 1000).toFixed(1) + "ms";
        else label = (sec * 1000000).toFixed(0) + "µs";
        ctx.fillText(label, x + 3, h - 4);
      }
    };

    draw();
    // No animation loop needed — just one draw
  }, [dryBuffer, wetBufferL, wetBufferR, numSamples, isStereo]);

  return <canvas ref={canvasRef} style={{ width: "100%", height: "100%", borderRadius: 6, display: "block" }} />;
}

// ─── Scroll-safe slider/select wrappers ──────────────────────────────────────
function VolumeSlider({ volume, setVolume }) {
  const ref = useNonPassiveWheel((e) => {
    e.preventDefault();
    const dir = e.deltaY < 0 ? 1 : -1;
    setVolume(v => Math.max(0, Math.min(1, v + dir * 0.03)));
  });
  return (
    <input ref={ref} type="range" min={0} max={1} step={0.01} value={volume}
      onChange={(e) => setVolume(parseFloat(e.target.value))}
      style={{ width: 70, accentColor: "#ffaa5c", cursor: "pointer" }}
    />
  );
}

function ViewWindowSlider({ viewWindow, setViewWindow, SAMPLE_RATE }) {
  const minLog = Math.log10(10);
  const maxLog = Math.log10(SAMPLE_RATE * 4);
  const ref = useNonPassiveWheel((e) => {
    e.preventDefault();
    const dir = e.deltaY < 0 ? 1 : -1;
    const currentLog = Math.log10(viewWindow);
    const step = (maxLog - minLog) * 0.03;
    const newLog = Math.max(minLog, Math.min(maxLog, currentLog + dir * step));
    setViewWindow(Math.round(Math.pow(10, newLog)));
  });
  const currentLog = Math.log10(viewWindow);
  const sliderVal = ((currentLog - minLog) / (maxLog - minLog)) * 1000;
  return (
    <input ref={ref} type="range" min={0} max={1000} value={sliderVal} step={1}
      onChange={(e) => {
        const pct = parseInt(e.target.value) / 1000;
        const logVal = minLog + pct * (maxLog - minLog);
        setViewWindow(Math.round(Math.pow(10, logVal)));
      }}
      style={{ flex: 1, accentColor: "#50c8a0", cursor: "pointer" }}
    />
  );
}

function SpeedSelect({ speed, setSpeed }) {
  const opts = [0.000001, 0.00001, 0.0001, 0.001, 0.01, 0.1, 0.25, 0.5, 1, 2];
  const ref = useNonPassiveWheel((e) => {
    e.preventDefault();
    const idx = opts.indexOf(speed);
    if (idx === -1) return;
    const dir = e.deltaY < 0 ? 1 : -1;
    const newIdx = Math.max(0, Math.min(opts.length - 1, idx + dir));
    setSpeed(opts[newIdx]);
  });
  return (
    <select ref={ref} value={speed} onChange={e => setSpeed(parseFloat(e.target.value))} style={selectStyle}>
      <option value={0.000001}>10⁻⁶×</option>
      <option value={0.00001}>10⁻⁵×</option>
      <option value={0.0001}>10⁻⁴×</option>
      <option value={0.001}>10⁻³×</option>
      <option value={0.01}>10⁻²×</option>
      <option value={0.1}>10⁻¹×</option>
      <option value={0.25}>0.25×</option>
      <option value={0.5}>0.5×</option>
      <option value={1}>1×</option>
      <option value={2}>2×</option>
    </select>
  );
}

function ViewWindowValue({ viewWindow, setViewWindow, SAMPLE_RATE }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const inputRef = useRef(null);

  const sec = viewWindow / SAMPLE_RATE;
  const display = sec >= 1 ? sec.toFixed(2) + "s"
    : sec >= 0.001 ? (sec * 1000).toFixed(1) + "ms"
    : (sec * 1000000).toFixed(0) + "µs";

  const commit = () => {
    const text = draft.trim().toLowerCase();
    let seconds;
    if (text.endsWith("ms")) seconds = parseFloat(text) / 1000;
    else if (text.endsWith("µs") || text.endsWith("us")) seconds = parseFloat(text) / 1000000;
    else if (text.endsWith("s")) seconds = parseFloat(text);
    else seconds = parseFloat(text) / 1000; // default to ms
    if (!isNaN(seconds) && seconds > 0) {
      const samples = Math.max(10, Math.min(SAMPLE_RATE * 4, Math.round(seconds * SAMPLE_RATE)));
      setViewWindow(samples);
    }
    setEditing(false);
  };

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editing]);

  if (editing) {
    return (
      <input ref={inputRef} value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => { if (e.key === "Enter") commit(); if (e.key === "Escape") setEditing(false); }}
        placeholder="e.g. 20ms"
        style={{
          background: "#1a1a2e", border: "1px solid #50c8a0", borderRadius: 3,
          color: "#e0e0f0", fontFamily: "'Space Mono', monospace", fontSize: 10,
          padding: "1px 3px", width: 65, textAlign: "right", outline: "none",
        }}
      />
    );
  }

  return (
    <span onClick={() => { setDraft(display); setEditing(true); }}
      style={{
        fontSize: 10, color: "#8888aa", fontFamily: "monospace", minWidth: 70,
        textAlign: "right", cursor: "text", borderBottom: "1px dashed #3a3a5c",
      }}
      title="Click to edit (e.g. 20ms, 1s, 500µs)"
    >{display}</span>
  );
}

// ─── Main App ────────────────────────────────────────────────────────────────
export default function SignalLab() {
  const [signalType, setSignalType] = useState("sine");
  const [frequency, setFrequency] = useState(220);
  const [amplitude, setAmplitude] = useState(0.8);
  const [isStereo, setIsStereo] = useState(false);
  const [stereoWidth, setStereoWidth] = useState(0.5);
  const [effects, setEffects] = useState([]);
  const [running, setRunning] = useState(true);
  const [viewWindow, setViewWindow] = useState(882);
  const [showAddMenu, setShowAddMenu] = useState(false);
  const [speed, setSpeed] = useState(0.01);
  const [audioPlaying, setAudioPlaying] = useState(false);
  const [volume, setVolume] = useState(0.5);
  const [viewMode, setViewMode] = useState("live"); // "live" or "static"

  const SAMPLE_RATE = 44100;
  const BUFFER_SIZE = SAMPLE_RATE * 4;

  const dryBufferRef = useRef(new Float32Array(BUFFER_SIZE));
  const wetBufferLRef = useRef(new Float32Array(BUFFER_SIZE));
  const wetBufferRRef = useRef(new Float32Array(BUFFER_SIZE));
  const writeIdxRef = useRef(0);
  const timeRef = useRef(0);
  const effectStatesRef = useRef(new Map());
  const pcmDataRef = useRef(null);

  // Audio playback refs - separate DSP state for real-time audio
  const audioCtxRef = useRef(null);
  const audioNodeRef = useRef(null);
  const audioTimeRef = useRef(0);
  const audioEffectStatesRef = useRef(new Map());
  const audioGainRef = useRef(null);
  // Refs to share current config with audio callback
  const signalTypeRef = useRef(signalType);
  const frequencyRef = useRef(frequency);
  const amplitudeRef = useRef(amplitude);
  const effectsRef = useRef(effects);
  const isStereoRef = useRef(isStereo);
  const stereoWidthRef = useRef(stereoWidth);

  // Keep refs in sync with state
  useEffect(() => { signalTypeRef.current = signalType; }, [signalType]);
  useEffect(() => { frequencyRef.current = frequency; }, [frequency]);
  useEffect(() => { amplitudeRef.current = amplitude; }, [amplitude]);
  useEffect(() => { effectsRef.current = effects; }, [effects]);
  useEffect(() => { isStereoRef.current = isStereo; }, [isStereo]);
  useEffect(() => { stereoWidthRef.current = stereoWidth; }, [stereoWidth]);
  useEffect(() => {
    if (audioGainRef.current) audioGainRef.current.gain.value = volume;
  }, [volume]);

  // Force rerender for canvas
  const [tick, setTick] = useState(0);

  const getEffectState = useCallback((effectId, type) => {
    if (!effectStatesRef.current.has(effectId)) {
      const def = EFFECT_DEFS[type];
      effectStatesRef.current.set(effectId, {
        L: def.initState ? def.initState() : {},
        R: def.initState ? def.initState() : {},
      });
    }
    return effectStatesRef.current.get(effectId);
  }, []);

  // Clean up stale effect states
  useEffect(() => {
    const activeIds = new Set(effects.map(e => e.id));
    for (const key of effectStatesRef.current.keys()) {
      if (!activeIds.has(key)) effectStatesRef.current.delete(key);
    }
  }, [effects]);

  // ─── Audio Playback (real-time, independent of visualization speed) ────────
  const getAudioEffectState = useCallback((effectId, type) => {
    if (!audioEffectStatesRef.current.has(effectId)) {
      const def = EFFECT_DEFS[type];
      audioEffectStatesRef.current.set(effectId, {
        L: def.initState ? def.initState() : {},
        R: def.initState ? def.initState() : {},
      });
    }
    return audioEffectStatesRef.current.get(effectId);
  }, []);

  const toggleAudio = useCallback(() => {
    if (audioPlaying) {
      // Stop
      if (audioNodeRef.current) {
        audioNodeRef.current.disconnect();
        audioNodeRef.current = null;
      }
      if (audioGainRef.current) {
        audioGainRef.current.disconnect();
        audioGainRef.current = null;
      }
      if (audioCtxRef.current) {
        audioCtxRef.current.close();
        audioCtxRef.current = null;
      }
      audioEffectStatesRef.current.clear();
      audioTimeRef.current = 0;
      setAudioPlaying(false);
    } else {
      // Start
      const ctx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 44100 });
      audioCtxRef.current = ctx;
      const bufSize = 2048;
      const node = ctx.createScriptProcessor(bufSize, 0, 2);
      audioNodeRef.current = node;
      audioTimeRef.current = timeRef.current;

      node.onaudioprocess = (e) => {
        const outL = e.outputBuffer.getChannelData(0);
        const outR = e.outputBuffer.getChannelData(1);
        const sr = ctx.sampleRate;
        const sig = signalTypeRef.current;
        const freq = frequencyRef.current;
        const amp = amplitudeRef.current;
        const fx = effectsRef.current;
        const stereo = isStereoRef.current;
        const width = stereoWidthRef.current;

        for (let i = 0; i < bufSize; i++) {
          const t = audioTimeRef.current;
          const dry = generators[sig] ? generators[sig](t, freq, pcmDataRef.current) * amp : 0;

          let sL = dry;
          let sR = dry;
          if (stereo) {
            const phase = width * 0.01;
            sR = generators[sig] ? generators[sig](t + phase, freq, pcmDataRef.current) * amp : 0;
          }

          for (const effect of fx) {
            if (!effect.enabled) continue;
            const def = EFFECT_DEFS[effect.type];
            if (!def) continue;
            const states = getAudioEffectState(effect.id, effect.type);
            sL = def.process(sL, effect.params, states.L, sr);
            if (stereo) {
              sR = def.process(sR, effect.params, states.R, sr);
            }
          }

          outL[i] = Math.max(-1, Math.min(1, sL));
          outR[i] = Math.max(-1, Math.min(1, stereo ? sR : sL));
          audioTimeRef.current += 1 / sr;
        }
      };

      const gainNode = ctx.createGain();
      gainNode.gain.value = volume;
      audioGainRef.current = gainNode;
      node.connect(gainNode);
      gainNode.connect(ctx.destination);
      setAudioPlaying(true);
    }
  }, [audioPlaying, getAudioEffectState]);

  // Cleanup audio on unmount
  useEffect(() => {
    return () => {
      if (audioNodeRef.current) audioNodeRef.current.disconnect();
      if (audioCtxRef.current) audioCtxRef.current.close();
    };
  }, []);

  // ─── Static mode: recompute entire window on any param change ──────────────
  const staticDryRef = useRef(new Float32Array(0));
  const staticWetLRef = useRef(new Float32Array(0));
  const staticWetRRef = useRef(new Float32Array(0));
  const [staticTick, setStaticTick] = useState(0);

  useEffect(() => {
    if (viewMode !== "static") return;
    const numSamples = Math.max(1, viewWindow);
    const dry = new Float32Array(numSamples);
    const wetL = new Float32Array(numSamples);
    const wetR = new Float32Array(numSamples);

    // Fresh effect states for clean computation from t=0
    const localStates = new Map();
    const getLocalState = (id, type) => {
      if (!localStates.has(id)) {
        const def = EFFECT_DEFS[type];
        localStates.set(id, {
          L: def.initState ? def.initState() : {},
          R: def.initState ? def.initState() : {},
        });
      }
      return localStates.get(id);
    };

    for (let s = 0; s < numSamples; s++) {
      const t = s / SAMPLE_RATE;
      const drySample = generators[signalType]
        ? generators[signalType](t, frequency, pcmDataRef.current) * amplitude
        : 0;
      dry[s] = drySample;

      let sL = drySample;
      let sR = drySample;
      if (isStereo) {
        const phase = stereoWidth * 0.01;
        sR = generators[signalType]
          ? generators[signalType](t + phase, frequency, pcmDataRef.current) * amplitude
          : 0;
      }

      for (const effect of effects) {
        if (!effect.enabled) continue;
        const def = EFFECT_DEFS[effect.type];
        if (!def) continue;
        const states = getLocalState(effect.id, effect.type);
        sL = def.process(sL, effect.params, states.L, SAMPLE_RATE);
        if (isStereo) {
          sR = def.process(sR, effect.params, states.R, SAMPLE_RATE);
        }
      }

      wetL[s] = Math.max(-1, Math.min(1, sL));
      wetR[s] = Math.max(-1, Math.min(1, isStereo ? sR : sL));
    }

    staticDryRef.current = dry;
    staticWetLRef.current = wetL;
    staticWetRRef.current = wetR;
    setStaticTick(t => t + 1);
  }, [viewMode, viewWindow, signalType, frequency, amplitude, effects, isStereo, stereoWidth]);

  // Processing loop
  useEffect(() => {
    if (!running) return;
    let frameId;
    let lastTime = performance.now();

    const process = (now) => {
      const elapsed = Math.min((now - lastTime) / 1000, 0.05) * speed;
      lastTime = now;
      const samplesToGen = Math.floor(elapsed * SAMPLE_RATE);

      for (let s = 0; s < samplesToGen; s++) {
        const t = timeRef.current;
        const drySample = generators[signalType]
          ? generators[signalType](t, frequency, pcmDataRef.current) * amplitude
          : 0;

        dryBufferRef.current[writeIdxRef.current] = drySample;

        // Generate stereo input
        let sampleL = drySample;
        let sampleR = drySample;
        if (isStereo) {
          const phase = stereoWidth * 0.01;
          sampleR = generators[signalType]
            ? generators[signalType](t + phase, frequency, pcmDataRef.current) * amplitude
            : 0;
        }

        // Process effects chain
        for (const effect of effects) {
          if (!effect.enabled) continue;
          const def = EFFECT_DEFS[effect.type];
          if (!def) continue;
          const states = getEffectState(effect.id, effect.type);
          sampleL = def.process(sampleL, effect.params, states.L, SAMPLE_RATE);
          if (isStereo) {
            sampleR = def.process(sampleR, effect.params, states.R, SAMPLE_RATE);
          }
        }

        // Clamp
        sampleL = Math.max(-1, Math.min(1, sampleL));
        sampleR = Math.max(-1, Math.min(1, sampleR));

        wetBufferLRef.current[writeIdxRef.current] = sampleL;
        wetBufferRRef.current[writeIdxRef.current] = isStereo ? sampleR : sampleL;
        writeIdxRef.current = (writeIdxRef.current + 1) % BUFFER_SIZE;
        timeRef.current += 1 / SAMPLE_RATE;
      }

      setTick(t => t + 1);
      frameId = requestAnimationFrame(process);
    };

    frameId = requestAnimationFrame(process);
    return () => cancelAnimationFrame(frameId);
  }, [running, signalType, frequency, amplitude, effects, isStereo, stereoWidth, speed, getEffectState]);

  const addEffect = (type) => {
    const def = EFFECT_DEFS[type];
    setEffects(prev => [...prev, {
      id: `${type}_${Date.now()}`,
      type,
      enabled: true,
      params: JSON.parse(JSON.stringify(def.defaults)),
    }]);
    setShowAddMenu(false);
  };

  const updateEffect = (idx, updated) => {
    setEffects(prev => prev.map((e, i) => i === idx ? updated : e));
  };

  const removeEffect = (idx) => {
    setEffects(prev => prev.filter((_, i) => i !== idx));
  };

  const moveEffect = (idx, dir) => {
    setEffects(prev => {
      const arr = [...prev];
      const newIdx = idx + dir;
      if (newIdx < 0 || newIdx >= arr.length) return arr;
      [arr[idx], arr[newIdx]] = [arr[newIdx], arr[idx]];
      return arr;
    });
  };

  const toggleEffect = (idx) => {
    setEffects(prev => prev.map((e, i) => i === idx ? { ...e, enabled: !e.enabled } : e));
  };

  const handlePCMUpload = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      ctx.decodeAudioData(ev.target.result, (buffer) => {
        pcmDataRef.current = buffer.getChannelData(0);
        setSignalType("pcm");
        ctx.close();
      });
    };
    reader.readAsArrayBuffer(file);
  };

  const effectCategories = {
    "Dynamics": ["gain", "compressor"],
    "EQ / Filter": ["parametricEQ", "graphicEQ", "lowpass", "highpass"],
    "Time": ["delay", "reverb"],
    "Modulation": ["chorus", "flanger", "phaser", "tremolo"],
    "Distortion": ["distortion", "bitcrusher"],
  };

  const appRef = useRef(null);
  useEffect(() => {
    const el = appRef.current;
    if (!el) return;
    const handler = (e) => {
      let target = e.target;
      while (target && target !== el) {
        const style = window.getComputedStyle(target);
        if ((style.overflowY === "auto" || style.overflowY === "scroll") && target.scrollHeight > target.clientHeight) {
          const atTop = target.scrollTop === 0 && e.deltaY < 0;
          const atBottom = target.scrollTop + target.clientHeight >= target.scrollHeight - 1 && e.deltaY > 0;
          if (!atTop && !atBottom) return;
        }
        target = target.parentElement;
      }
      e.preventDefault();
    };
    el.addEventListener("wheel", handler, { passive: false });
    return () => el.removeEventListener("wheel", handler);
  }, []);

  return (
    <div ref={appRef} style={{
      fontFamily: "'Space Mono', 'Courier New', monospace",
      background: "#0d0d18",
      color: "#d0d0e8",
      minHeight: "100vh",
      display: "flex",
      flexDirection: "column",
    }}>
      <link href="https://fonts.googleapis.com/css2?family=Space+Mono:wght@400;700&family=Syne:wght@700;800&display=swap" rel="stylesheet" />

      {/* Header */}
      <div style={{
        padding: "10px 16px",
        borderBottom: "1px solid #1a1a30",
        display: "flex", alignItems: "center", justifyContent: "space-between",
        background: "#0f0f1c",
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{
            fontFamily: "Syne, sans-serif", fontSize: 18, fontWeight: 800,
            background: "linear-gradient(135deg, #50c8a0, #40a8e8)",
            WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent",
            letterSpacing: "0.05em",
          }}>SIGNAL LAB</span>
          <span style={{ fontSize: 9, color: "#4a4a6a", letterSpacing: "0.1em" }}>AUDIO SIGNAL PROCESSOR</span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <button onClick={() => setViewMode(viewMode === "live" ? "static" : "live")} style={{
            ...smallBtnStyle,
            background: viewMode === "static" ? "#c084fc22" : "#2a2a44",
            color: viewMode === "static" ? "#c084fc" : "#b0b0d0",
            border: `1px solid ${viewMode === "static" ? "#c084fc44" : "#3a3a5c"}`,
            padding: "4px 12px",
            fontSize: 10,
            letterSpacing: "0.05em",
          }}>
            {viewMode === "static" ? "◆ STATIC" : "◇ LIVE"}
          </button>
          <div style={{ width: 1, height: 20, background: "#2a2a44" }} />
          <button onClick={toggleAudio} style={{
            ...smallBtnStyle,
            background: audioPlaying ? "#ffaa5c22" : "#2a2a44",
            color: audioPlaying ? "#ffaa5c" : "#b0b0d0",
            border: `1px solid ${audioPlaying ? "#ffaa5c44" : "#3a3a5c"}`,
            padding: "4px 12px",
            fontSize: 11,
          }}>
            {audioPlaying ? "🔊 STOP" : "🔈 LISTEN"}
          </button>
          <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
            <span style={{ fontSize: 10, color: "#6a6a8a" }}>🔉</span>
            <VolumeSlider volume={volume} setVolume={setVolume} />
            <EditableValue
              value={Math.round(volume * 100)} min={0} max={100} step={1}
              onChange={(v) => setVolume(v / 100)}
              style={{ fontSize: 9, color: "#8888aa", minWidth: 28 }}
            />
            <span style={{ fontSize: 9, color: "#6a6a8a" }}>%</span>
          </div>
          <div style={{
            display: "flex", alignItems: "center", gap: 8,
            visibility: viewMode === "live" ? "visible" : "hidden",
            pointerEvents: viewMode === "live" ? "auto" : "none",
          }}>
            <div style={{ width: 1, height: 20, background: "#2a2a44" }} />
            <button onClick={() => setRunning(!running)} style={{
              ...smallBtnStyle,
              background: running ? "#50c8a022" : "#ff6b8a22",
              color: running ? "#50c8a0" : "#ff6b8a",
              border: `1px solid ${running ? "#50c8a044" : "#ff6b8a44"}`,
              padding: "4px 12px",
            }}>
              {running ? "⏸ PAUSE" : "▶ PLAY"}
            </button>
            <SpeedSelect speed={speed} setSpeed={setSpeed} />
          </div>
        </div>
      </div>

      <div style={{ display: "flex", flex: 1, overflow: "hidden" }}>
        {/* Left Panel - Signal + Effects */}
        <div style={{
          width: 320, minWidth: 320,
          borderRight: "1px solid #1a1a30",
          overflowY: "auto",
          background: "#0f0f1c",
          display: "flex", flexDirection: "column",
        }}>
          {/* Signal Section */}
          <div style={{ padding: "10px 12px", borderBottom: "1px solid #1a1a30" }}>
            <div style={{ fontSize: 9, color: "#6a6a8a", letterSpacing: "0.15em", marginBottom: 8, fontWeight: 700 }}>
              INPUT SIGNAL
            </div>
            <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginBottom: 10 }}>
              {["sine", "square", "triangle", "sawtooth", "noise"].map(type => (
                <button key={type} onClick={() => setSignalType(type)} style={{
                  ...smallBtnStyle,
                  background: signalType === type ? "#50c8a022" : "#1a1a2e",
                  color: signalType === type ? "#50c8a0" : "#8888aa",
                  border: `1px solid ${signalType === type ? "#50c8a044" : "#3a3a5c"}`,
                  padding: "3px 8px",
                  textTransform: "uppercase",
                  fontSize: 9,
                  letterSpacing: "0.05em",
                }}>
                  {type}
                </button>
              ))}
              <label style={{
                ...smallBtnStyle,
                background: signalType === "pcm" ? "#50c8a022" : "#1a1a2e",
                color: signalType === "pcm" ? "#50c8a0" : "#8888aa",
                border: `1px solid ${signalType === "pcm" ? "#50c8a044" : "#3a3a5c"}`,
                padding: "3px 8px",
                textTransform: "uppercase",
                fontSize: 9,
                cursor: "pointer",
              }}>
                PCM
                <input type="file" accept="audio/*" onChange={handlePCMUpload} style={{ display: "none" }} />
              </label>
            </div>

            <div style={{ display: "flex", gap: 12 }}>
              <Knob value={frequency} min={20} max={2000} step={1} label="Freq (Hz)" onChange={setFrequency} />
              <Knob value={amplitude} min={0} max={1} step={0.01} label="Amplitude" onChange={setAmplitude} />
              <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 4 }}>
                <button onClick={() => setIsStereo(!isStereo)} style={{
                  ...smallBtnStyle,
                  background: isStereo ? "#6b9fff22" : "#1a1a2e",
                  color: isStereo ? "#6b9fff" : "#8888aa",
                  border: `1px solid ${isStereo ? "#6b9fff44" : "#3a3a5c"}`,
                  padding: "4px 10px", fontSize: 10,
                }}>
                  {isStereo ? "STEREO" : "MONO"}
                </button>
                {isStereo && (
                  <Knob value={stereoWidth} min={0} max={1} step={0.01} label="Width" size={36} onChange={setStereoWidth} />
                )}
              </div>
            </div>
          </div>

          {/* View control */}
          <div style={{ padding: "8px 12px", borderBottom: "1px solid #1a1a30" }}>
            <div style={{ fontSize: 9, color: "#6a6a8a", letterSpacing: "0.15em", marginBottom: 6, fontWeight: 700 }}>
              VIEW WINDOW
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <ViewWindowSlider viewWindow={viewWindow} setViewWindow={setViewWindow} SAMPLE_RATE={SAMPLE_RATE} />
              <ViewWindowValue viewWindow={viewWindow} setViewWindow={setViewWindow} SAMPLE_RATE={SAMPLE_RATE} />
            </div>
          </div>

          {/* Effects Chain */}
          <div style={{ flex: 1, overflowY: "auto", padding: "8px 10px" }}>
            <div style={{
              display: "flex", alignItems: "center", justifyContent: "space-between",
              marginBottom: 8,
            }}>
              <span style={{ fontSize: 9, color: "#6a6a8a", letterSpacing: "0.15em", fontWeight: 700 }}>
                EFFECTS CHAIN ({effects.length})
              </span>
              <button onClick={() => setShowAddMenu(!showAddMenu)} style={{
                ...smallBtnStyle,
                background: "#50c8a022",
                color: "#50c8a0",
                border: "1px solid #50c8a044",
                padding: "3px 10px", fontSize: 10,
              }}>
                + ADD
              </button>
            </div>

            {showAddMenu && (
              <div style={{
                background: "#16162a",
                border: "1px solid #3a3a5c",
                borderRadius: 8,
                padding: 10,
                marginBottom: 10,
              }}>
                {Object.entries(effectCategories).map(([cat, types]) => (
                  <div key={cat} style={{ marginBottom: 8 }}>
                    <div style={{ fontSize: 8, color: "#6a6a8a", letterSpacing: "0.15em", marginBottom: 4, fontWeight: 700 }}>
                      {cat.toUpperCase()}
                    </div>
                    <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                      {types.map(type => (
                        <button key={type} onClick={() => addEffect(type)} style={{
                          ...smallBtnStyle,
                          padding: "3px 8px", fontSize: 9,
                        }}>
                          {EFFECT_DEFS[type].icon} {EFFECT_DEFS[type].label}
                        </button>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}

            {effects.length === 0 && (
              <div style={{
                textAlign: "center", padding: "30px 16px",
                color: "#4a4a6a", fontSize: 11,
              }}>
                No effects added yet.
                <br />Click "+ ADD" to start building your chain.
              </div>
            )}

            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {effects.map((effect, idx) => (
                <EffectCard
                  key={effect.id}
                  effect={effect}
                  onUpdate={(e) => updateEffect(idx, e)}
                  onRemove={() => removeEffect(idx)}
                  onToggle={() => toggleEffect(idx)}
                  onMoveUp={() => moveEffect(idx, -1)}
                  onMoveDown={() => moveEffect(idx, 1)}
                  isFirst={idx === 0}
                  isLast={idx === effects.length - 1}
                />
              ))}
            </div>
          </div>
        </div>

        {/* Right Panel - Visualization */}
        <div style={{ flex: 1, display: "flex", flexDirection: "column", position: "relative" }}>
          {/* Legend */}
          <div style={{
            position: "absolute", top: 10, left: 14, zIndex: 10,
            display: "flex", gap: 14, alignItems: "center",
          }}>
            <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
              <div style={{ width: 16, height: 2, background: "#3a5a70", opacity: 0.6 }} />
              <span style={{ fontSize: 9, color: "#5a7a90" }}>DRY</span>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
              <div style={{ width: 16, height: 2, background: "#50c8a0" }} />
              <span style={{ fontSize: 9, color: "#50c8a0" }}>WET</span>
            </div>
          </div>
          <div style={{ flex: 1, padding: 6 }}>
            {viewMode === "live" ? (
              <WaveformCanvas
                dryBuffer={dryBufferRef.current}
                wetBufferL={wetBufferLRef.current}
                wetBufferR={wetBufferRRef.current}
                bufferLen={writeIdxRef.current}
                isStereo={isStereo}
                viewWindow={viewWindow}
              />
            ) : (
              <StaticCanvas
                dryBuffer={staticDryRef.current}
                wetBufferL={staticWetLRef.current}
                wetBufferR={staticWetRRef.current}
                numSamples={viewWindow}
                isStereo={isStereo}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
