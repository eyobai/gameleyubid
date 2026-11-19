/** The dusk sky and the balloon, drawn on a canvas. Purely visual: it shows what the server's numbers say. */

export interface SkyState {
  phase: 'idle' | 'flying' | 'popped' | 'cashed';
  multiplierX100: number;
  /** Where the player cashed out, drawn as a line while the balloon keeps rising. */
  cashedAtX100: number | null;
  /** Multiplier at which this bet is cashed out automatically (the reserve limit). */
  capX100: number | null;
}

export function startSky(canvas: HTMLCanvasElement, read: () => SkyState): () => void {
  const ctx = canvas.getContext('2d')!;
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  let W = 0;
  let H = 0;
  let frame = 0;
  let lastPhase: SkyState['phase'] = 'idle';
  let parts: { x: number; y: number; vx: number; vy: number; life: number; c: string }[] = [];
  let pos = { x: 0, y: 0 };
  const stars = Array.from({ length: 70 }, () => ({ x: Math.random(), y: Math.random(), r: Math.random() * 1.3 + 0.3 }));
  const clouds = Array.from({ length: 6 }, (_, i) => ({ x: Math.random(), y: i / 6, s: 0.6 + Math.random() * 0.8 }));

  const resize = () => {
    const dpr = Math.min(2, devicePixelRatio || 1);
    W = canvas.clientWidth;
    H = canvas.clientHeight;
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  };
  const ro = new ResizeObserver(resize);
  ro.observe(canvas);
  resize();

  const yFor = (x100: number) => H * 0.86 - H * 0.5 * (1 - 1 / Math.sqrt(x100 / 100));

  const cloud = (x: number, y: number, s: number) => {
    ctx.fillStyle = 'rgba(200,190,255,0.10)';
    for (const [dx, dy, r] of [[0, 0, 26], [22, -8, 20], [44, 0, 24], [20, 6, 22]]) {
      ctx.beginPath();
      ctx.arc(x + dx * s, y + dy * s, r * s, 0, 7);
      ctx.fill();
    }
  };

  const balloon = (x: number, y: number, sway: number) => {
    const r = Math.max(18, Math.min(W, H) * 0.07);
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(sway);
    ctx.strokeStyle = 'rgba(255,230,200,0.7)';
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(-r * 0.45, r * 0.95);
    ctx.lineTo(-r * 0.22, r * 1.55);
    ctx.moveTo(r * 0.45, r * 0.95);
    ctx.lineTo(r * 0.22, r * 1.55);
    ctx.stroke();
    ctx.fillStyle = '#8a5a36';
    ctx.fillRect(-r * 0.25, r * 1.55, r * 0.5, r * 0.36);
    const g = ctx.createRadialGradient(-r * 0.35, -r * 0.4, r * 0.1, 0, 0, r * 1.2);
    g.addColorStop(0, '#ffc39a');
    g.addColorStop(0.55, '#ff8a4c');
    g.addColorStop(1, '#c8431f');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(0, r);
    ctx.bezierCurveTo(-r * 1.25, r * 0.2, -r * 1.05, -r * 1.1, 0, -r * 1.1);
    ctx.bezierCurveTo(r * 1.05, -r * 1.1, r * 1.25, r * 0.2, 0, r);
    ctx.fill();
    ctx.strokeStyle = 'rgba(120,30,10,0.35)';
    ctx.lineWidth = 1;
    for (const k of [-0.5, 0, 0.5]) {
      ctx.beginPath();
      ctx.moveTo(0, -r * 1.1);
      ctx.quadraticCurveTo(r * k * 1.3, 0, 0, r);
      ctx.stroke();
    }
    ctx.restore();
  };

  const draw = (now: number) => {
    const s = read();
    if (s.phase === 'popped' && lastPhase !== 'popped') {
      for (let i = 0; i < 40; i++) {
        const a = Math.random() * Math.PI * 2;
        const v = 1.5 + Math.random() * 4;
        parts.push({ x: pos.x, y: pos.y, vx: Math.cos(a) * v, vy: Math.sin(a) * v - 1, life: 1, c: Math.random() < 0.5 ? '#ff8a4c' : '#ffd29a' });
      }
    }
    lastPhase = s.phase;
    const m = s.phase === 'idle' ? 100 : s.multiplierX100;
    const climb = Math.log(m / 100);

    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, '#0d1230');
    g.addColorStop(0.6, '#232a5e');
    g.addColorStop(1, `hsl(${280 - Math.min(60, climb * 25)}, 38%, ${Math.max(16, 28 - climb * 4)}%)`);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
    for (const st of stars) {
      ctx.fillStyle = `rgba(255,255,255,${0.25 + Math.min(0.5, climb * 0.2)})`;
      ctx.beginPath();
      ctx.arc(st.x * W, ((st.y + climb * 0.04) % 1) * H, st.r, 0, 7);
      ctx.fill();
    }
    for (const c of clouds) cloud(c.x * W * 0.85, ((c.y + climb * 0.35) % 1.2) * H - 30, c.s);

    const ground = H * 0.92 + climb * H * 0.25;
    if (ground < H + 40) {
      ctx.fillStyle = '#1a1438';
      ctx.beginPath();
      ctx.moveTo(0, H);
      ctx.lineTo(0, ground);
      for (let px = 0; px <= W; px += 20) ctx.lineTo(px, ground - Math.sin(px / 70) * 10 - Math.sin(px / 23) * 4);
      ctx.lineTo(W, H);
      ctx.fill();
    }

    ctx.fillStyle = 'rgba(163,169,214,0.6)';
    ctx.font = "11px 'JetBrains Mono', monospace";
    for (const v of [150, 200, 300, 500, 1000, 2000]) {
      const y = yFor(v);
      ctx.fillRect(10, y, 8, 1);
      ctx.fillText(`${v / 100}×`, 22, y + 4);
    }
    const line = (x100: number, color: string, label: string) => {
      const y = yFor(x100);
      ctx.strokeStyle = color;
      ctx.setLineDash([4, 6]);
      ctx.beginPath();
      ctx.moveTo(30, y);
      ctx.lineTo(W - 10, y);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = color;
      ctx.fillText(label, Math.max(60, W - 170), y - 6);
    };
    if (s.capX100 && s.phase === 'flying' && s.capX100 < 3000) line(s.capX100, 'rgba(255,209,102,0.6)', `paid out at ${(s.capX100 / 100).toFixed(2)}×`);
    if (s.cashedAtX100 && s.phase === 'cashed') line(s.cashedAtX100, 'rgba(95,224,168,0.8)', `you left at ${(s.cashedAtX100 / 100).toFixed(2)}×`);

    pos = { x: W * 0.5, y: yFor(m) };
    if (s.phase !== 'popped') balloon(pos.x, pos.y + (reduce ? 0 : Math.sin(now / 600) * 3), reduce ? 0 : Math.sin(now / 900) * 0.04);

    parts = parts.filter((p) => p.life > 0);
    for (const p of parts) {
      p.x += p.vx;
      p.y += p.vy;
      p.vy += 0.12;
      p.life -= 0.02;
      ctx.globalAlpha = Math.max(0, p.life);
      ctx.fillStyle = p.c;
      ctx.fillRect(p.x, p.y, 4, 4);
    }
    ctx.globalAlpha = 1;
    frame = requestAnimationFrame(draw);
  };
  frame = requestAnimationFrame(draw);
  return () => {
    cancelAnimationFrame(frame);
    ro.disconnect();
  };
}
