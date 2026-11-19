import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ApiError, api, newKey } from '../lib/api';
import { fromMinor, toMinor, x } from '../lib/money';
import { multiplierAt } from '../game/math';
import { startSky } from '../game/sky';
import type { SkyState } from '../game/sky';
import { useWallet } from '../wallet';

export interface Bet {
  id: string;
  roundId: string;
  roundNumber: number;
  status: 'OPEN' | 'CASHED_OUT' | 'BUSTED';
  betMinor: string;
  autoCashoutX100: number | null;
  capX100: number;
  cashoutX100: number | null;
  cashoutReason: 'PLAYER' | 'AUTO' | 'LIMIT' | null;
  payoutMinor: string | null;
  profitMinor: string | null;
  crashX100: string | null;
  createdAt: string;
}

interface LivePlayer {
  player: string;
  betMinor: string;
  status: Bet['status'];
  cashoutX100: number | null;
  payoutMinor: string | null;
}

interface Live {
  round: {
    id: string;
    number: number;
    status: 'BETTING' | 'FLYING' | 'ENDED';
    startsAt: string;
    serverTime: string;
    capX100: number | null;
    crashX100: string | null;
    players: LivePlayer[];
    playerCount: number;
    totalBetMinor: string;
  } | null;
  me: Bet | null;
  history: { number: number; crashX100: string; endedAt: string | null }[];
}

interface Info {
  enabled: boolean;
  currency: string;
  edgeBps: number;
  minBetMinor: string;
  maxBetMinor: string;
  bettingMs: number;
}

const POLL_MS = 300;
/** How long the pop of the last round stays on screen while betting for the next one is open. */
const SHOW_POP_MS = 2500;

export function Game() {
  const wallet = useWallet();
  const [info, setInfo] = useState<Info | null>(null);
  const [live, setLive] = useState<Live | null>(null);
  const [bet, setBet] = useState('50');
  const [auto, setAuto] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [lastResult, setLastResult] = useState<Bet | null>(null);
  const [, setTick] = useState(0);

  const canvas = useRef<HTMLCanvasElement>(null);
  const bigText = useRef<HTMLDivElement>(null);
  const offset = useRef(0);
  const liveRef = useRef<Live | null>(null);
  const sky = useRef<SkyState>({ phase: 'idle', multiplierX100: 100, cashedAtX100: null, capX100: null });
  const lastRound = useRef<number | null>(null);
  /** The last flying round as it stood, so its players stay on screen while its pop is shown. */
  const lastFlying = useRef<NonNullable<Live['round']> | null>(null);

  const serverNow = () => Date.now() + offset.current;

  const loadInfo = useCallback(() => api<Info>('/game/info').then(setInfo).catch(() => undefined), []);

  // Poll the shared round. The server's clock decides everything; this only shows it.
  useEffect(() => {
    let stop = false;
    const poll = async () => {
      const sent = Date.now();
      try {
        const l = await api<Live>('/game/live');
        const got = Date.now();
        if (l.round) offset.current = Date.parse(l.round.serverTime) - (sent + got) / 2;
        liveRef.current = l;
        if (l.round?.status === 'FLYING') lastFlying.current = l.round;
        setLive(l);
        if (l.round && lastRound.current !== null && l.round.number !== lastRound.current) {
          // A new round opened: show how my bet in the last one ended, and refresh the balance and limits.
          const ended = lastRound.current;
          void api<{ items: Bet[] }>('/game/bets?limit=1')
            .then((r) => setLastResult(r.items[0]?.roundNumber === ended ? r.items[0] : null))
            .catch(() => undefined);
          void wallet.refresh();
          void loadInfo();
        }
        if (l.round) lastRound.current = l.round.number;
      } catch {
        // A missed poll is retried on the next one.
      }
      if (!stop) setTimeout(poll, POLL_MS);
    };
    void poll();
    void loadInfo();
    return () => {
      stop = true;
    };
  }, [wallet, loadInfo]);

  // Sky and the big number, every frame.
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
        const sincePop = prev?.endedAt ? serverNow() - Date.parse(prev.endedAt) : Infinity;
        if (r.status === 'FLYING') {
          const m = multiplierAt(serverNow() - Date.parse(r.startsAt));
          const mine = l.me;
          s.phase = mine?.status === 'CASHED_OUT' ? 'cashed' : 'flying';
          s.multiplierX100 = m;
          s.cashedAtX100 = mine?.cashoutX100 ?? null;
          s.capX100 = mine?.status === 'OPEN' ? mine.capX100 : r.capX100;
          el.textContent = x(m);
          el.className = 'mult';
        } else if (r.status === 'BETTING' && prev && sincePop < SHOW_POP_MS) {
          s.phase = 'popped';
          s.multiplierX100 = Number(prev.crashX100);
          el.textContent = x(prev.crashX100);
          el.className = 'mult bust';
        } else if (r.status === 'BETTING') {
          s.phase = 'idle';
          s.multiplierX100 = 100;
          s.cashedAtX100 = null;
          const left = Math.max(0, Date.parse(r.startsAt) - serverNow());
          el.textContent = `${(left / 1000).toFixed(1)}s`;
          el.className = 'mult wait';
        } else {
          s.phase = 'popped';
          el.textContent = x(r.crashX100 ?? 100);
          el.className = 'mult bust';
        }
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    // Re-render a few times a second so buttons and labels follow the clock.
    const t = setInterval(() => setTick((n) => n + 1), 200);
    return () => {
      stopSky();
      cancelAnimationFrame(raf);
      clearInterval(t);
    };
  }, []);

  const round = live?.round ?? null;
  const me = live?.me ?? null;
  const betting = round?.status === 'BETTING' && Date.parse(round.startsAt) > serverNow();
  const flying = round?.status === 'FLYING';
  const myOpen = me?.status === 'OPEN';
  const betMinor = toMinor(bet);
  const autoX100 = auto.trim() ? toMinor(auto) : null;
  const maxBet = info ? BigInt(info.maxBetMinor) : 0n;

  const place = async () => {
    setError('');
    if (betMinor === null || betMinor <= 0n) return setError('Enter a bet, e.g. 50');
    if (auto.trim() && (autoX100 === null || autoX100 < 101n)) return setError('Auto cash-out must be at least 1.01');
    setBusy(true);
    try {
      await api<Bet>('/game/bets', {
        method: 'POST',
        idempotencyKey: newKey(),
        body: { betMinor: betMinor.toString(), ...(autoX100 ? { autoCashoutX100: Number(autoX100) } : {}) },
      });
      setLastResult(null);
      void wallet.refresh();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not place the bet. Try again.');
    } finally {
      setBusy(false);
    }
  };

  const cashOut = async () => {
    if (!me) return;
    setBusy(true);
    try {
      await api<Bet>(`/game/bets/${me.id}/cash-out`, { method: 'POST' });
      void wallet.refresh();
    } catch (e) {
      if (!(e instanceof ApiError && e.code === 'BET_SETTLED')) setError(e instanceof ApiError ? e.message : 'Could not cash out. Try again.');
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== 'Space' || (document.activeElement as HTMLElement)?.tagName === 'INPUT' || busy) return;
      e.preventDefault();
      if (flying && myOpen) void cashOut();
      else if (betting && !me) void place();
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  });

  const capFor = (amount: bigint) => {
    const cap = wallet.balanceMinor !== null && wallet.balanceMinor < maxBet ? wallet.balanceMinor : maxBet;
    return fromMinor(amount < cap ? amount : cap).replace(/,/g, '');
  };

  const liveMult = flying && round ? multiplierAt(serverNow() - Date.parse(round.startsAt)) : 100;

  let button;
  if (flying && myOpen) {
    button = (
      <button className="go cash" type="submit" disabled={busy}>
        Cash out {fromMinor((BigInt(me!.betMinor) * BigInt(Math.max(100, Math.min(liveMult, me!.capX100)))) / 100n)}
      </button>
    );
  } else if (betting && !me) {
    button = <button className="go" type="submit" disabled={busy || !info?.enabled}>Bet {betMinor ? fromMinor(betMinor) : ''}</button>;
  } else if (betting && me) {
    button = <button className="go" type="button" disabled>Bet placed · waiting for lift-off</button>;
  } else {
    button = <button className="go" type="button" disabled>Round in progress · bet on the next one</button>;
  }

  const prevEnded = live?.history[0];
  const popShowing =
    round?.status === 'BETTING' && !!prevEnded?.endedAt && serverNow() - Date.parse(prevEnded.endedAt) < SHOW_POP_MS;
  // While the last pop is on screen, keep its players (with the final results) in the list.
  const listed = popShowing && lastFlying.current?.number === prevEnded?.number ? lastFlying.current : round;

  let sub: React.ReactNode = 'Waiting for the next round…';
  if (round) {
    const prev = live!.history[0];
    const showingPop = round.status === 'BETTING' && prev?.endedAt && serverNow() - Date.parse(prev.endedAt) < SHOW_POP_MS;
    if (me?.status === 'CASHED_OUT') sub = <>You cashed out at <b>{x(me.cashoutX100!)}</b> · won <b>+{fromMinor(me.profitMinor ?? '0')}</b></>;
    else if (showingPop && lastResult) sub = lastResult.status === 'CASHED_OUT' ? <>Popped · you won <b>+{fromMinor(lastResult.profitMinor ?? '0')}</b></> : <>Popped · you lost <b>{fromMinor(lastResult.betMinor)}</b></>;
    else if (showingPop) sub = `Round ${prev.number} popped`;
    else if (round.status === 'BETTING') sub = me ? <>Your bet of <b>{fromMinor(me.betMinor)}</b> is in · lift-off soon</> : `Round ${round.number} · place your bets`;
    else if (myOpen) sub = round.capX100 ? <>Everyone still flying is cashed out at <b>{x(round.capX100)}</b></> : <>Paid out automatically at <b>{x(me!.capX100)}</b> at the latest</>;
    else sub = `Round ${round.number} · ${round.playerCount} ${round.playerCount === 1 ? 'player' : 'players'}`;
  }

  return (
    <>
      {info && !info.enabled && <div className="banner">The game is closed right now. You can still deposit and check your history.</div>}
      <section className="game">
        <div className="stage">
          <canvas ref={canvas} />
          <div className="readout">
            <div ref={bigText} className="mult">–</div>
            <div className="sub">{sub}</div>
          </div>
        </div>

        <form className="card panel" onSubmit={(e) => (e.preventDefault(), flying && myOpen ? cashOut() : betting && !me ? place() : undefined)} noValidate>
          <div className="field">
            <label htmlFor="bet">Bet ({info?.currency ?? 'ETB'})</label>
            <div className="row">
              <input id="bet" inputMode="decimal" value={bet} onChange={(e) => setBet(e.target.value)} disabled={!!me && myOpen} />
              <button className="chip" type="button" onClick={() => setBet(fromMinor((betMinor ?? 0n) / 2n).replace(/,/g, ''))}>½</button>
              <button className="chip" type="button" onClick={() => setBet(capFor((betMinor ?? 0n) * 2n))}>2×</button>
              <button className="chip" type="button" onClick={() => setBet(capFor(maxBet))}>Max</button>
            </div>
            <div className="hint">
              {info && betMinor !== null && betMinor > maxBet ? <>The largest bet right now is <b>{fromMinor(maxBet)}</b>.</> : <>Max bet <b>{fromMinor(maxBet)}</b>.</>}
            </div>
          </div>
          <div className="field">
            <label htmlFor="auto">Auto cash-out at (optional)</label>
            <input id="auto" inputMode="decimal" placeholder="e.g. 2.00" value={auto} onChange={(e) => setAuto(e.target.value)} />
            <div className="hint">
              {info && autoX100 && autoX100 >= 101n ? (
                <>Reaches {x(autoX100)} about <b>{(((10000 - info.edgeBps) / 100 / Number(autoX100)) * 100).toFixed(1)}%</b> of the time · pays <b>{betMinor ? fromMinor((betMinor * autoX100) / 100n) : '–'}</b></>
              ) : (
                'Leave empty to cash out yourself.'
              )}
            </div>
          </div>
          {button}
          <p className="error" role="status">{error}</p>
          {wallet.balanceMinor === 0n && !me && <p className="hint">Your wallet is empty. <Link to="/wallet">Add money</Link> to play.</p>}
        </form>
      </section>

      <section className="grid-2">
        <div className="card">
          <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline' }}>
            <h2>Round {listed?.number ?? '–'}</h2>
            <span className="hint">
              {listed ? <>{listed.playerCount} {listed.playerCount === 1 ? 'player' : 'players'} · <b>{fromMinor(listed.totalBetMinor)}</b> bet</> : null}
            </span>
          </div>
          <div className="table-wrap">
            <table>
              <thead><tr><th>Player</th><th className="num">Bet</th><th className="num">Cashed out</th><th className="num">Won</th></tr></thead>
              <tbody>
                {(!listed || listed.players.length === 0) && <tr><td colSpan={4} className="muted">No bets yet in this round.</td></tr>}
                {listed?.players.map((p, i) => (
                  <tr key={i}>
                    <td>{p.player}</td>
                    <td className="num">{fromMinor(p.betMinor)}</td>
                    <td className={`num ${p.status === 'CASHED_OUT' ? 'hi' : p.status === 'BUSTED' ? 'lo' : ''}`}>
                      {p.status === 'CASHED_OUT' ? x(p.cashoutX100!) : p.status === 'BUSTED' || listed !== round ? 'popped' : listed.status === 'FLYING' ? 'flying' : '–'}
                    </td>
                    <td className="num hi">{p.payoutMinor ? fromMinor(p.payoutMinor) : ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
        <div className="card panel">
          <div>
            <h2>Last rounds</h2>
            <div className="chips">
              {(live?.history ?? []).length === 0 && <span className="muted">No rounds yet.</span>}
              {live?.history.map((h) => (
                <span key={h.number} className={Number(h.crashX100) >= 200 ? 'hi' : Number(h.crashX100) < 120 ? 'lo' : ''} title={`Round ${h.number}`}>
                  {x(h.crashX100)}
                </span>
              ))}
            </div>
          </div>
          <div>
            <h2>How it works</h2>
            <p className="muted" style={{ margin: 0 }}>
              Everyone flies the same balloon. Bet while the countdown runs, then cash out before it pops to win bet × multiplier. Every pop
              point was fixed before the round and can be checked on the <Link to="/fairness">fairness</Link> page. The house keeps a{' '}
              {info ? info.edgeBps / 100 : 3}% edge. Play with money you can afford to lose. You must be 18 or older.
            </p>
          </div>
        </div>
      </section>
    </>
  );
}
