import { useEffect, useRef, useState } from 'react';
import { ApiError, api, newKey } from '../lib/api';
import { fromMinor, toMinor, x } from '../lib/money';
import { multiplierAt } from './math';
import type { Bet, Info, Live } from './live';
import { sounds } from './sound';

interface Props {
  slot: 1 | 2;
  live: Live | null;
  info: Info | null;
  balanceMinor: bigint | null;
  serverNow: () => number;
  onChange: () => void;
}

const QUICK = ['10', '50', '100', '500'];

/** One of the two bet panels: bet now, bet on the next round, cancel, cash out, and the Auto tab. */
export function BetPanel({ slot, live, info, balanceMinor, serverNow, onChange }: Props) {
  const [tab, setTab] = useState<'bet' | 'auto'>('bet');
  const [amount, setAmount] = useState(slot === 1 ? '10' : '20');
  const [autoCash, setAutoCash] = useState(false);
  const [autoCashAt, setAutoCashAt] = useState('2.00');
  const [autoBet, setAutoBet] = useState(false);
  /** Waiting to bet as soon as the next round opens. */
  const [queued, setQueued] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const placedFor = useRef<number | null>(null);
  /** This panel's last settled bet, kept on screen after its round is over. */
  const [last, setLast] = useState<Bet | null>(null);

  const round = live?.round ?? null;
  const mine: Bet | undefined = live?.mine.find((b) => b.slot === slot);
  const now = serverNow();
  const betting = round?.status === 'BETTING' && Date.parse(round.startsAt) > now;
  const flying = round?.status === 'FLYING';
  const amountMinor = toMinor(amount);
  const autoX100 = autoCash ? toMinor(autoCashAt) : null;
  const maxBet = info ? BigInt(info.maxBetMinor) : 0n;

  const place = async () => {
    if (!round) return;
    setError('');
    if (!amountMinor || amountMinor <= 0n) return setError('Enter an amount');
    if (autoCash && (!autoX100 || autoX100 < 101n)) return setError('Auto cash-out must be at least 1.01');
    placedFor.current = round.number;
    setBusy(true);
    try {
      await api('/game/bets', {
        method: 'POST',
        idempotencyKey: newKey(),
        body: { betMinor: amountMinor.toString(), slot, ...(autoX100 ? { autoCashoutX100: Number(autoX100) } : {}) },
      });
      sounds.bet();
      setQueued(false);
      onChange();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not place the bet');
      // Stop repeating a bet that cannot be placed (no money, above the limit, game closed).
      setAutoBet(false);
      setQueued(false);
    } finally {
      setBusy(false);
    }
  };

  const cancel = async () => {
    if (!mine) return setQueued(false);
    setBusy(true);
    try {
      await api(`/game/bets/${mine.id}/cancel`, { method: 'POST' });
      onChange();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not cancel');
    } finally {
      setBusy(false);
    }
  };

  const cashOut = async () => {
    if (!mine) return;
    setBusy(true);
    try {
      const b = await api<Bet>(`/game/bets/${mine.id}/cash-out`, { method: 'POST' });
      if (b.status === 'CASHED_OUT') sounds.cashOut();
      onChange();
    } catch (e) {
      if (!(e instanceof ApiError && e.code === 'BET_SETTLED')) setError(e instanceof ApiError ? e.message : 'Could not cash out');
    } finally {
      setBusy(false);
    }
  };

  // A queued or automatic bet goes in once per round, as soon as betting opens.
  useEffect(() => {
    if (!round || !betting || mine || busy || placedFor.current === round.number) return;
    if (queued || autoBet) void place();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [round?.number, betting, mine, queued, autoBet, busy]);

  useEffect(() => {
    if (mine && mine.status !== 'OPEN') setLast(mine);
    if (mine?.status === 'OPEN') setLast(null);
  }, [mine?.id, mine?.status]); // eslint-disable-line react-hooks/exhaustive-deps

  // Celebrate an automatic cash-out of this panel's bet.
  const lastStatus = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (mine?.status === 'CASHED_OUT' && lastStatus.current === 'OPEN' && mine.cashoutReason !== 'PLAYER') sounds.cashOut();
    lastStatus.current = mine?.status;
  }, [mine?.status, mine?.cashoutReason]);

  const step = (delta: bigint) => {
    const next = (amountMinor ?? 0n) + delta;
    setAmount(fromMinor(next < 100n ? 100n : next).replace(/,/g, ''));
  };

  const m = flying && round ? multiplierAt(now - Date.parse(round.startsAt)) : 100;
  let button;
  if (flying && mine?.status === 'OPEN') {
    const pays = (BigInt(mine.betMinor) * BigInt(Math.max(100, Math.min(m, mine.capX100)))) / 100n;
    button = (
      <button className="go cash big" type="button" onClick={cashOut} disabled={busy}>
        <span>Cash out</span>
        <b>{fromMinor(pays)} {info?.currency}</b>
      </button>
    );
  } else if (betting && mine?.status === 'OPEN') {
    button = (
      <button className="go stop big" type="button" onClick={cancel} disabled={busy}>
        <span>Cancel</span>
        <small>Waiting for lift-off</small>
      </button>
    );
  } else if (queued && !betting) {
    button = (
      <button className="go stop big" type="button" onClick={() => setQueued(false)}>
        <span>Cancel</span>
        <small>Waiting for the next round</small>
      </button>
    );
  } else {
    button = (
      <button
        className="go big"
        type="button"
        disabled={busy || !info?.enabled || !round}
        onClick={() => (betting ? place() : setQueued(true))}
      >
        <span>Bet</span>
        <b>{amountMinor ? fromMinor(amountMinor) : '–'} {info?.currency}</b>
        {!betting && <small>for the next round</small>}
      </button>
    );
  }

  const locked = mine?.status === 'OPEN' || queued;
  const shown = mine && mine.status !== 'OPEN' ? mine : !mine ? last : null;
  const result =
    shown && shown.status === 'CASHED_OUT' ? (
      <span className="ok">Won +{fromMinor(shown.profitMinor ?? '0')} at {x(shown.cashoutX100!)}</span>
    ) : shown && shown.status === 'BUSTED' ? (
      <span className="error">Lost {fromMinor(shown.betMinor)}</span>
    ) : null;

  return (
    <div className={`bp card ${mine?.status === 'OPEN' ? 'in' : ''}`}>
      <div className="seg" role="tablist" aria-label={`Bet ${slot}`}>
        <button type="button" role="tab" aria-selected={tab === 'bet'} className={tab === 'bet' ? 'on' : ''} onClick={() => setTab('bet')}>Bet</button>
        <button type="button" role="tab" aria-selected={tab === 'auto'} className={tab === 'auto' ? 'on' : ''} onClick={() => setTab('auto')}>Auto</button>
      </div>
      <div className="bp-body">
        <div className="bp-amount">
          <div className="stepper">
            <button type="button" className="chip" onClick={() => step(-100n)} disabled={locked} aria-label="Less">−</button>
            <input id={`amount-${slot}`} aria-label={`Bet ${slot} amount`} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} disabled={locked} />
            <button type="button" className="chip" onClick={() => step(100n)} disabled={locked} aria-label="More">+</button>
          </div>
          <div className="quick">
            {QUICK.map((q) => (
              <button key={q} type="button" className="chip" onClick={() => setAmount(q)} disabled={locked}>{q}</button>
            ))}
          </div>
        </div>
        {button}
      </div>
      {tab === 'auto' && (
        <div className="bp-auto">
          <label className="switch">
            <input type="checkbox" checked={autoBet} onChange={(e) => setAutoBet(e.target.checked)} />
            <span>Auto bet every round</span>
          </label>
          <label className="switch">
            <input type="checkbox" checked={autoCash} onChange={(e) => setAutoCash(e.target.checked)} />
            <span>Auto cash-out at</span>
            <input className="mini" aria-label="Auto cash-out multiplier" inputMode="decimal" value={autoCashAt} onChange={(e) => setAutoCashAt(e.target.value)} disabled={!autoCash} />
            <span>×</span>
          </label>
          {info && autoX100 && autoX100 >= 101n && (
            <p className="hint">Reaches {x(autoX100)} about {(((10000 - info.edgeBps) / 100 / Number(autoX100)) * 100).toFixed(1)}% of the time.</p>
          )}
          {mine?.status === 'OPEN' && <p className="hint">Changes apply from your next bet.</p>}
        </div>
      )}
      <p className="bp-note">
        {error ? <span className="error">{error}</span> : result ?? (
          amountMinor && amountMinor > maxBet ? <span className="hint">Largest bet right now: {fromMinor(maxBet)}</span>
          : balanceMinor !== null && amountMinor && amountMinor > balanceMinor ? <span className="hint">Not enough balance</span>
          : <span className="hint">{autoBet ? 'Auto bet is on' : ' '}</span>
        )}
      </p>
    </div>
  );
}
