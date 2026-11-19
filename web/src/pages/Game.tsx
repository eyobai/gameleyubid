import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { fromMinor, x } from '../lib/money';
import { BetPanel } from '../game/BetPanel';
import { Chat } from '../game/Chat';
import { useLive } from '../game/live';
import { multiplierAt } from '../game/math';
import { Sidebar } from '../game/Sidebar';
import { setSound, soundOn, sounds } from '../game/sound';
import { startSky } from '../game/sky';
import type { SkyState } from '../game/sky';
import { useWallet } from '../wallet';

/** How long the pop of the last round stays on screen while betting for the next one is open. */
const SHOW_POP_MS = 2500;

export function Game() {
  const wallet = useWallet();
  const [myVersion, setMyVersion] = useState(0);
  const [sound, setSoundState] = useState(soundOn());
  const lastFlying = useRef<number | null>(null);

  const onNewRound = useCallback(() => {
    void wallet.refresh();
    setMyVersion((v) => v + 1);
  }, [wallet]);
  const { live, liveRef, info, serverNow, refresh } = useLive(onNewRound);
  const [, setTick] = useState(0);

  const canvas = useRef<HTMLCanvasElement>(null);
  const bigText = useRef<HTMLDivElement>(null);
  const sky = useRef<SkyState>({ phase: 'idle', multiplierX100: 100, cashedAtX100: null, capX100: null });
  const lastPhase = useRef<string>('');

  useEffect(() => {
    if (!canvas.current) return;
    const stopSky = startSky(canvas.current, () => sky.current);
    let raf = 0;
    const frame = () => {
      const l = liveRef.current;
      const s = sky.current;
      const el = bigText.current;
      if (l?.round && el) {
        const r = l.round;
        const prev = l.history[0];
        const now = serverNow();
        const popping = r.status === 'BETTING' && !!prev?.endedAt && now - Date.parse(prev.endedAt) < SHOW_POP_MS;
        let phase: string;
        if (r.status === 'FLYING') {
          phase = 'flying';
          const m = multiplierAt(now - Date.parse(r.startsAt));
          const open = l.mine.filter((b) => b.status === 'OPEN');
          const cashed = l.mine.filter((b) => b.status === 'CASHED_OUT');
          s.phase = open.length === 0 && cashed.length > 0 ? 'cashed' : 'flying';
          s.multiplierX100 = m;
          s.cashedAtX100 = cashed.length ? Math.max(...cashed.map((b) => b.cashoutX100 ?? 0)) : null;
          s.capX100 = open.length ? Math.min(...open.map((b) => b.capX100)) : r.capX100;
          el.textContent = x(m);
          el.className = 'mult';
          lastFlying.current = r.number;
        } else if (popping || r.status === 'ENDED') {
          phase = 'popped';
          s.phase = 'popped';
          s.multiplierX100 = Number(popping ? prev.crashX100 : (r.crashX100 ?? 100));
          el.textContent = x(s.multiplierX100);
          el.className = 'mult bust';
        } else {
          phase = 'betting';
          s.phase = 'idle';
          s.multiplierX100 = 100;
          s.cashedAtX100 = null;
          s.capX100 = null;
          const left = Math.max(0, Date.parse(r.startsAt) - now);
          el.textContent = `${(left / 1000).toFixed(1)}s`;
          el.className = 'mult wait';
        }
        if (phase !== lastPhase.current) {
          if (phase === 'flying' && lastPhase.current) sounds.liftOff();
          if (phase === 'popped' && lastPhase.current === 'flying') sounds.pop();
          lastPhase.current = phase;
        }
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    const t = setInterval(() => setTick((n) => n + 1), 200);
    return () => {
      stopSky();
      cancelAnimationFrame(raf);
      clearInterval(t);
    };
  }, [liveRef, serverNow]);

  const changed = useCallback(() => {
    void refresh().catch(() => undefined);
    void wallet.refresh();
    setMyVersion((v) => v + 1);
  }, [refresh, wallet]);

  const round = live?.round ?? null;
  const prev = live?.history[0];
  const popping = round?.status === 'BETTING' && !!prev?.endedAt && serverNow() - Date.parse(prev.endedAt) < SHOW_POP_MS;

  let sub: React.ReactNode = 'Connecting…';
  if (round) {
    if (popping) sub = `Round ${prev!.number} popped`;
    else if (round.status === 'BETTING') sub = `Round ${round.number} · place your bets`;
    else if (round.status === 'FLYING' && round.capX100) sub = <>Everyone still flying is cashed out at <b>{x(round.capX100)}</b></>;
    else if (round.status === 'FLYING') sub = `Round ${round.number} · ${round.playerCount} ${round.playerCount === 1 ? 'bet' : 'bets'}`;
  }

  return (
    <>
      {info && !info.enabled && <div className="banner">The game is closed right now. You can still deposit and check your history.</div>}
      <section className="arena">
        <Sidebar round={round} roundEnded={round?.status === 'ENDED' || !!popping} myVersion={myVersion} />

        <div className="center">
          <div className="strip" aria-label="Last rounds">
            {(live?.history ?? []).map((h) => (
              <span key={h.number} className={Number(h.crashX100) >= 1000 ? 'big' : Number(h.crashX100) >= 200 ? 'hi' : 'lo'} title={`Round ${h.number}`}>
                {x(h.crashX100)}
              </span>
            ))}
          </div>
          <div className="stage">
            <canvas ref={canvas} />
            <div className="readout">
              <div ref={bigText} className="mult">–</div>
              <div className="sub">{sub}</div>
            </div>
            <button
              type="button"
              className="sound"
              aria-pressed={sound}
              onClick={() => {
                setSound(!sound);
                setSoundState(!sound);
              }}
            >
              {sound ? 'Sound on' : 'Sound off'}
            </button>
          </div>
          <div className="panels">
            <BetPanel slot={1} live={live} info={info} balanceMinor={wallet.balanceMinor} serverNow={serverNow} onChange={changed} />
            <BetPanel slot={2} live={live} info={info} balanceMinor={wallet.balanceMinor} serverNow={serverNow} onChange={changed} />
          </div>
          {wallet.balanceMinor === 0n && (
            <p className="hint" style={{ margin: 0 }}>Your wallet is empty. <Link to="/wallet">Add money</Link> to play.</p>
          )}
          <p className="hint" style={{ margin: 0 }}>
            Bet while the countdown runs, then cash out before the balloon pops. Max bet right now <b>{info ? fromMinor(info.maxBetMinor) : '–'}</b>.
            Every pop point is fixed in advance and can be checked on the <Link to="/fairness">fairness</Link> page. The house keeps a{' '}
            {info ? info.edgeBps / 100 : 3}% edge. Play with money you can afford to lose. 18+ only.
          </p>
        </div>

        <Chat />
      </section>
    </>
  );
}
