import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { fromMinor, x } from '../lib/money';
import type { Bet, LiveRound } from './live';

interface TopItem { player: string; roundNumber: number; betMinor: string; cashoutX100: number; payoutMinor: string; crashX100: string | null; settledAt: string }

/** All bets of the round on screen, my own bets, and the biggest wins. */
export function Sidebar({ round, roundEnded, myVersion }: { round: LiveRound | null; roundEnded: boolean; myVersion: number }) {
  const [tab, setTab] = useState<'all' | 'mine' | 'top'>('all');
  const [mine, setMine] = useState<Bet[]>([]);
  const [top, setTop] = useState<TopItem[]>([]);
  const [by, setBy] = useState<'win' | 'multiplier'>('win');
  const [period, setPeriod] = useState<'day' | 'month' | 'year'>('day');

  useEffect(() => {
    if (tab === 'mine') void api<{ items: Bet[] }>('/game/bets?limit=30').then((r) => setMine(r.items)).catch(() => undefined);
  }, [tab, myVersion]);
  useEffect(() => {
    if (tab === 'top') void api<{ items: TopItem[] }>(`/game/top?by=${by}&period=${period}`).then((r) => setTop(r.items)).catch(() => undefined);
  }, [tab, by, period, myVersion]);

  return (
    <aside className="card side">
      <div className="seg" role="tablist">
        {(['all', 'mine', 'top'] as const).map((t) => (
          <button key={t} type="button" role="tab" aria-selected={tab === t} className={tab === t ? 'on' : ''} onClick={() => setTab(t)}>
            {t === 'all' ? 'All bets' : t === 'mine' ? 'My bets' : 'Top'}
          </button>
        ))}
      </div>

      {tab === 'all' && (
        <>
          <div className="side-head">
            <span>{round ? `Round ${round.number}` : '–'}</span>
            <span className="hint">{round ? <><b>{round.playerCount}</b> bets · <b>{fromMinor(round.totalBetMinor)}</b></> : null}</span>
          </div>
          <div className="table-wrap">
            <table className="tight">
              <thead><tr><th>Player</th><th className="num">Bet</th><th className="num">×</th><th className="num">Win</th></tr></thead>
              <tbody>
                {(!round || round.players.length === 0) && <tr><td colSpan={4} className="muted">No bets yet in this round.</td></tr>}
                {round?.players.map((p, i) => (
                  <tr key={i} className={p.status === 'CASHED_OUT' ? 'won' : ''}>
                    <td>{p.player}</td>
                    <td className="num">{fromMinor(p.betMinor)}</td>
                    <td className="num">{p.status === 'CASHED_OUT' ? <span className="hi">{x(p.cashoutX100!)}</span> : p.status === 'BUSTED' || roundEnded ? <span className="lo">–</span> : ''}</td>
                    <td className="num hi">{p.payoutMinor ? fromMinor(p.payoutMinor) : ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {tab === 'mine' && (
        <div className="table-wrap">
          <table className="tight">
            <thead><tr><th>Round</th><th className="num">Bet</th><th className="num">×</th><th className="num">Win</th></tr></thead>
            <tbody>
              {mine.length === 0 && <tr><td colSpan={4} className="muted">Your bets appear here.</td></tr>}
              {mine.map((b) => (
                <tr key={b.id} className={b.status === 'CASHED_OUT' ? 'won' : ''}>
                  <td>#{b.roundNumber}{b.slot === 2 ? ' · 2' : ''}</td>
                  <td className="num">{fromMinor(b.betMinor)}</td>
                  <td className="num">{b.status === 'CASHED_OUT' ? <span className="hi">{x(b.cashoutX100!)}</span> : b.crashX100 ? <span className="lo">{x(b.crashX100)}</span> : '…'}</td>
                  <td className="num hi">{b.payoutMinor ? fromMinor(b.payoutMinor) : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {tab === 'top' && (
        <>
          <div className="row" style={{ gap: 6 }}>
            <div className="seg small">
              <button type="button" className={by === 'win' ? 'on' : ''} onClick={() => setBy('win')}>Biggest wins</button>
              <button type="button" className={by === 'multiplier' ? 'on' : ''} onClick={() => setBy('multiplier')}>Multipliers</button>
            </div>
            <div className="seg small">
              {(['day', 'month', 'year'] as const).map((p) => (
                <button key={p} type="button" className={period === p ? 'on' : ''} onClick={() => setPeriod(p)}>{p === 'day' ? 'Day' : p === 'month' ? 'Month' : 'Year'}</button>
              ))}
            </div>
          </div>
          <div className="table-wrap">
            <table className="tight">
              <thead><tr><th>Player</th><th className="num">Bet</th><th className="num">×</th><th className="num">Win</th></tr></thead>
              <tbody>
                {top.length === 0 && <tr><td colSpan={4} className="muted">No wins yet in this period.</td></tr>}
                {top.map((t, i) => (
                  <tr key={i}>
                    <td title={`Round ${t.roundNumber}`}>{t.player}</td>
                    <td className="num">{fromMinor(t.betMinor)}</td>
                    <td className="num hi">{x(t.cashoutX100)}</td>
                    <td className="num hi">{fromMinor(t.payoutMinor)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </aside>
  );
}
