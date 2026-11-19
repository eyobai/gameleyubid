import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ApiError, api, newKey } from '../lib/api';
import { fromMinor, toMinor, x } from '../lib/money';
import { multiplierAt } from '../game/math';
import { startSky } from '../game/sky';
import type { SkyState } from '../game/sky';
import { useWallet } from '../wallet';

export interface Flight {
  id: string;
  status: 'OPEN' | 'CASHED_OUT' | 'BUSTED';
  betMinor: string;
  capX100: number;
  maxPayoutMinor: string;
  autoCashoutX100: number | null;
  startedAt: string;
  serverTime: string;
  cashoutX100: number | null;
  cashoutReason: 'PLAYER' | 'AUTO' | 'LIMIT' | null;
  payoutMinor: string | null;
  profitMinor: string | null;
  crashX100: string | null;
  fairness: { serverSeedHash: string; clientSeed: string; nonce: number; edgeBps: number; serverSeed: string | null };
}

interface Info {
  enabled: boolean;
  currency: string;
  edgeBps: number;
  minBetMinor: string;
  maxBetMinor: string;
  maxMultiplierX100: number;
}

const POLL_MS = 400;

export function Game() {
  const wallet = useWallet();
  const [info, setInfo] = useState<Info | null>(null);
  const [bet, setBet] = useState('50');
  const [auto, setAuto] = useState('');
  const [flight, setFlight] = useState<Flight | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [history, setHistory] = useState<Flight[]>([]);
  const [result, setResult] = useState<{ text: string; tone: 'win' | 'bust' } | null>(null);

  const canvas = useRef<HTMLCanvasElement>(null);
  const multText = useRef<HTMLDivElement>(null);
  const sky = useRef<SkyState>({ phase: 'idle', multiplierX100: 100, cashedAtX100: null, capX100: null });
  const clock = useRef({ offset: 0, startedAt: 0, stopAt: Infinity as number });
  const current = useRef<Flight | null>(null);

  const loadInfo = useCallback(() => api<Info>('/game/info').then(setInfo).catch(() => undefined), []);
  const loadHistory = useCallback(
    () => api<{ items: Flight[] }>('/game/flights?limit=18').then((r) => setHistory(r.items)).catch(() => undefined),
    [],
  );

  // Show a settled flight: where it was cashed out, and where the balloon popped.
  const finish = useCallback(
    (f: Flight) => {
      current.current = f;
      setFlight(f);
      const crash = Number(f.crashX100 ?? 100);
      if (f.status === 'CASHED_OUT') {
        sky.current.phase = 'cashed';
        sky.current.cashedAtX100 = f.cashoutX100;
        // Keep flying to the real pop point so the player sees what they left behind.
        clock.current.stopAt = crash;
        const why = f.cashoutReason === 'AUTO' ? 'Auto cash-out' : f.cashoutReason === 'LIMIT' ? 'House limit reached' : 'Cashed out';
        setResult({ text: `${why} at ${x(f.cashoutX100!)} · won +${fromMinor(f.profitMinor ?? '0')}`, tone: 'win' });
      } else {
        sky.current.phase = 'popped';
        sky.current.multiplierX100 = crash;
        clock.current.stopAt = crash;
        setResult({ text: `Popped at ${x(crash)} · lost ${fromMinor(f.betMinor)}`, tone: 'bust' });
      }
      void wallet.refresh();
      void loadHistory();
      void loadInfo();
    },
    [wallet, loadHistory, loadInfo],
  );

  const fly = useCallback((f: Flight) => {
    current.current = f;
    setFlight(f);
    setResult(null);
    clock.current = { offset: Date.parse(f.serverTime) - Date.now(), startedAt: Date.parse(f.startedAt), stopAt: Infinity };
    sky.current = { phase: 'flying', multiplierX100: 100, cashedAtX100: null, capX100: f.capX100 };
  }, []);

  // Sky and the big number, driven by the server's clock.
  useEffect(() => {
    if (!canvas.current) return;
    const stop = startSky(canvas.current, () => sky.current);
    let raf = 0;
    const tick = () => {
      const s = sky.current;
      if (s.phase === 'flying' || s.phase === 'cashed') {
        const m = multiplierAt(Date.now() + clock.current.offset - clock.current.startedAt);
        if (s.phase === 'cashed' && m >= clock.current.stopAt) {
          s.phase = 'popped';
          s.multiplierX100 = clock.current.stopAt;
        } else {
          s.multiplierX100 = Math.min(m, clock.current.stopAt);
        }
      }
      if (multText.current) {
        const shown = s.phase === 'cashed' ? (s.cashedAtX100 ?? 100) : s.multiplierX100;
        multText.current.textContent = x(shown);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      stop();
      cancelAnimationFrame(raf);
    };
  }, []);

  // While flying, ask the server how the flight stands; it settles pops and automatic cash-outs.
  useEffect(() => {
    if (!flight || flight.status !== 'OPEN') return;
    const id = flight.id;
    const timer = setInterval(async () => {
      try {
        const f = await api<Flight>(`/game/flights/${id}`);
        if (f.status !== 'OPEN' && current.current?.id === id && current.current.status === 'OPEN') finish(f);
      } catch {
        // A missed poll is retried on the next tick.
      }
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [flight, finish]);

  // Resume a flight that was in the air when the page was closed.
  useEffect(() => {
    void loadInfo();
    void api<{ items: Flight[] }>('/game/flights?limit=18')
      .then((r) => {
        setHistory(r.items);
        const open = r.items.find((f) => f.status === 'OPEN');
        if (open) fly(open);
      })
      .catch(() => undefined);
  }, [loadInfo, fly]);

  const flying = flight?.status === 'OPEN';
  const betMinor = toMinor(bet);
  const autoX100 = auto.trim() ? toMinor(auto) : null;

  const launch = async () => {
    setError('');
    if (betMinor === null || betMinor <= 0n) return setError('Enter a bet, e.g. 50');
    if (auto.trim() && (autoX100 === null || autoX100 < 101n)) return setError('Auto cash-out must be at least 1.01');
    setBusy(true);
    try {
      const f = await api<Flight>('/game/flights', {
        method: 'POST',
        idempotencyKey: newKey(),
        body: { betMinor: betMinor.toString(), ...(autoX100 ? { autoCashoutX100: Number(autoX100) } : {}) },
      });
      fly(f);
      void wallet.refresh();
      if (f.status !== 'OPEN') finish(f);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not launch. Try again.');
    } finally {
      setBusy(false);
    }
  };

  const cashOut = async () => {
    if (!flight) return;
    setBusy(true);
    try {
      finish(await api<Flight>(`/game/flights/${flight.id}/cash-out`, { method: 'POST' }));
    } catch (e) {
      if (e instanceof ApiError && e.code === 'FLIGHT_SETTLED' && e.details.flight) finish(e.details.flight as Flight);
      else if (e instanceof ApiError && e.code === 'CASHOUT_TOO_EARLY') setError(e.message);
      else setError(e instanceof ApiError ? e.message : 'Could not cash out. Try again.');
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== 'Space' || (document.activeElement as HTMLElement)?.tagName === 'INPUT' || busy) return;
      e.preventDefault();
      if (flying) void cashOut();
      else void launch();
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  });

  const maxBet = info ? BigInt(info.maxBetMinor) : 0n;
  const half = () => setBet(fromMinor((betMinor ?? 0n) / 2n).replace(/,/g, ''));
  const double = () => {
    const d = (betMinor ?? 0n) * 2n;
    const cap = wallet.balanceMinor !== null && wallet.balanceMinor < maxBet ? wallet.balanceMinor : maxBet;
    setBet(fromMinor(d < cap ? d : cap).replace(/,/g, ''));
  };
  const max = () => {
    const cap = wallet.balanceMinor !== null && wallet.balanceMinor < maxBet ? wallet.balanceMinor : maxBet;
    setBet(fromMinor(cap).replace(/,/g, ''));
  };

  const capHint = (() => {
    if (!info || betMinor === null || betMinor <= 0n) return null;
    if (betMinor > maxBet) return <>The largest bet right now is <b>{fromMinor(maxBet)}</b>.</>;
    return <>Max bet <b>{fromMinor(maxBet)}</b>. The reserve limit for this bet is shown when it launches.</>;
  })();

  const oddsHint =
    info && autoX100 && autoX100 >= 101n ? (
      <>
        Reaches {x(autoX100)} about <b>{(((10000 - info.edgeBps) / 100 / Number(autoX100)) * 100).toFixed(1)}%</b> of the time · pays{' '}
        <b>{betMinor ? fromMinor((betMinor * autoX100) / 100n) : '–'}</b>
      </>
    ) : (
      'Leave empty to cash out yourself.'
    );

  const live = flying ? multiplierAt(Date.now() + clock.current.offset - clock.current.startedAt) : 0;

  return (
    <>
      {info && !info.enabled && <div className="banner">The game is closed right now. You can still deposit and check your history.</div>}
      <section className="game">
        <div className="stage">
          <canvas ref={canvas} />
          <div className="readout">
            <div ref={multText} className={`mult ${result?.tone ?? ''}`}>1.00×</div>
            <div className="sub">
              {result ? result.text : flying ? <>Paid out automatically at <b>{x(flight!.capX100)}</b> at the latest</> : 'Place a bet and launch'}
            </div>
          </div>
        </div>

        <form className="card panel" onSubmit={(e) => (e.preventDefault(), flying ? cashOut() : launch())} noValidate>
          <div className="field">
            <label htmlFor="bet">Bet ({info?.currency ?? 'ETB'})</label>
            <div className="row">
              <input id="bet" inputMode="decimal" value={bet} onChange={(e) => setBet(e.target.value)} disabled={flying} />
              <button className="chip" type="button" onClick={half} disabled={flying}>½</button>
              <button className="chip" type="button" onClick={double} disabled={flying}>2×</button>
              <button className="chip" type="button" onClick={max} disabled={flying}>Max</button>
            </div>
            <div className="hint">{capHint}</div>
          </div>
          <div className="field">
            <label htmlFor="auto">Auto cash-out at (optional)</label>
            <input id="auto" inputMode="decimal" placeholder="e.g. 2.00" value={auto} onChange={(e) => setAuto(e.target.value)} disabled={flying} />
            <div className="hint">{oddsHint}</div>
          </div>
          {flying ? (
            <button className="go cash" type="submit" disabled={busy}>
              Cash out {fromMinor((BigInt(flight!.betMinor) * BigInt(Math.max(100, live))) / 100n)}
            </button>
          ) : (
            <button className="go" type="submit" disabled={busy || !info?.enabled}>Launch</button>
          )}
          <p className="error" role="status">{error}</p>
          {wallet.balanceMinor === 0n && !flying && (
            <p className="hint">Your wallet is empty. <Link to="/wallet">Add money</Link> to play.</p>
          )}
        </form>
      </section>

      <section className="grid-2">
        <div className="card">
          <h2>Your recent flights</h2>
          <div className="chips">
            {history.filter((f) => f.status !== 'OPEN').length === 0 && <span className="muted">No flights yet.</span>}
            {history
              .filter((f) => f.status !== 'OPEN')
              .map((f) => (
                <span key={f.id} className={f.status === 'CASHED_OUT' ? 'hi' : 'lo'} title={`Popped at ${x(f.crashX100 ?? 100)}`}>
                  {f.status === 'CASHED_OUT' ? `+${fromMinor(f.profitMinor ?? '0')}` : x(f.crashX100 ?? 100)}
                </span>
              ))}
          </div>
        </div>
        <div className="card">
          <h2>How it works</h2>
          <p className="muted" style={{ marginTop: 0 }}>
            Your bet rides the balloon. The multiplier climbs while it rises and the balloon pops at a random height. Cash out before the
            pop to win bet × multiplier. Every pop point is fixed before you bet and can be checked on the <Link to="/fairness">fairness</Link> page.
          </p>
          <p className="muted" style={{ marginBottom: 0 }}>
            The house keeps a {info ? info.edgeBps / 100 : 3}% edge: over many flights players get back about {info ? 100 - info.edgeBps / 100 : 97}% of what they bet.
            Play with money you can afford to lose. You must be 18 or older.
          </p>
        </div>
      </section>
    </>
  );
}
