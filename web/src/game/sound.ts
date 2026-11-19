/** Small sounds made in the browser with Web Audio, so no audio files are needed. Off until the player turns them on. */
let ctx: AudioContext | null = null;
let enabled = (() => {
  try {
    return localStorage.getItem('updraft.sound') === 'on';
  } catch {
    return false;
  }
})();

export const soundOn = () => enabled;

export function setSound(on: boolean) {
  enabled = on;
  try {
    localStorage.setItem('updraft.sound', on ? 'on' : 'off');
  } catch {
    // Private mode: the choice lasts for this tab.
  }
  if (on) ctx ??= new AudioContext();
}

function tone(freq: number, to: number, ms: number, type: OscillatorType, gain = 0.12) {
  if (!enabled) return;
  ctx ??= new AudioContext();
  const t = ctx.currentTime;
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, t);
  o.frequency.exponentialRampToValueAtTime(to, t + ms / 1000);
  g.gain.setValueAtTime(gain, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + ms / 1000);
  o.connect(g).connect(ctx.destination);
  o.start(t);
  o.stop(t + ms / 1000);
}

export const sounds = {
  liftOff: () => tone(180, 520, 700, 'sine', 0.08),
  cashOut: () => {
    tone(880, 1320, 120, 'triangle');
    setTimeout(() => tone(1320, 1760, 160, 'triangle'), 110);
  },
  pop: () => {
    if (!enabled) return;
    ctx ??= new AudioContext();
    const len = Math.floor(ctx.sampleRate * 0.25);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3);
    const src = ctx.createBufferSource();
    const g = ctx.createGain();
    g.gain.value = 0.25;
    src.buffer = buf;
    src.connect(g).connect(ctx.destination);
    src.start();
  },
  bet: () => tone(520, 640, 90, 'square', 0.05),
};
