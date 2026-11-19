import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '../auth';
import { ApiError, api, newKey } from '../lib/api';
import { fromMinor, group, toMinor, x } from '../lib/money';
import type { Flight } from './Game';

interface Period { flights: number; players: number; playerWinRate: number | null; bets: string; payouts: string; revenue: string; revenueMinor: string; holdRate: number | null }
interface Summary {
  currency: string;
  settings: { enabled: boolean; edgeBps: number; flightRiskBps: number; totalRiskBps: number; maxMultiplierX100: number };
  reserve: { balance: string; committed: string; free: string; openFlights: number; openRisk: string; maxBetNow: string };
  results: Record<'last24h' | 'last7d' | 'last30d' | 'allTime', Period>;
}
interface AdminFlight extends Flight { phoneNumber: string; bet: string; payout: string | null; crash: string | null }
interface ReserveMove { reference: string; type: string; reason: string | null; change: string; balanceAfter: string; createdAt: string }
interface Recon { ok: boolean; trialBalanceMinor: string; accountMismatches: unknown[]; flightsWithWrongPayout: number }
interface Player { id: string; phoneNumber: string; status: string; balance: string; createdAt: string }

const pct = (v: number | null) => (v === null ? '–' : `${(v * 100).toFixed(2)}%`);
const PERIODS = [['last24h', 'Last 24 hours'], ['last7d', 'Last 7 days'], ['last30d', 'Last 30 days'], ['allTime', 'All time']] as const;

export function Admin() {
  const { session } = useAuth();
  const isAdmin = session?.user.role === 'ADMIN';
  const [summary, setSummary] = useState<Summary | null>(null);
  const [flights, setFlights] = useState<AdminFlight[]>([]);
  const [moves, setMoves] = useState<ReserveMove[]>([]);
  const [recon, setRecon] = useState<Recon | null>(null);
  const [players, setPlayers] = useState<Player[]>([]);
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);

  const load = useCallback(() => {
    void api<Summary>('/admin/summary').then(setSummary).catch(() => undefined);
    void api<{ items: AdminFlight[] }>('/admin/flights?limit=50').then((r) => setFlights(r.items)).catch(() => undefined);
    void api<{ items: ReserveMove[] }>('/admin/reserve/history').then((r) => setMoves(r.items)).catch(() => undefined);
    if (isAdmin) void api<{ items: Player[] }>('/admin/players').then((r) => setPlayers(r.items)).catch(() => undefined);
  }, [isAdmin]);

  useEffect(() => {
    load();
    const t = setInterval(load, 10_000);
    return () => clearInterval(t);
  }, [load]);

  const move = async (kind: 'fund' | 'withdraw') => {
    setMsg(null);
    const minor = toMinor(amount);
    if (!minor) return setMsg({ text: 'Enter an amount', ok: false });
    if (reason.trim().length < 3) return setMsg({ text: 'Write a short reason, e.g. "Opening bankroll"', ok: false });
    try {
      const r = await api<{ reserve: string; journal: string }>(`/admin/reserve/${kind}`, {
        method: 'POST',
        idempotencyKey: newKey(),
        body: { amountMinor: minor.toString(), reason: reason.trim() },
      });
      setMsg({ text: `${kind === 'fund' ? 'Added' : 'Withdrew'} ${fromMinor(minor)}. Reserve is now ${group(r.reserve)} (${r.journal}).`, ok: true });
      setAmount('');
      setReason('');
      load();
    } catch (e) {
      setMsg({ text: e instanceof ApiError ? e.message : 'Failed', ok: false });
    }
  };

  const block = async (p: Player) => {
    const path = p.status === 'BLOCKED' ? 'unblock' : 'block';
    await api(`/admin/players/${p.id}/${path}`, { method: 'POST', body: { reason: `${path} from admin page` } }).catch(() => undefined);
    load();
  };

  if (!summary) return <section className="card">Loading…</section>;
  const s = summary.settings;

  return (
    <>
      {!s.enabled && <div className="banner">The game is switched off (GAME_ENABLED=false). Players cannot launch flights.</div>}
      <section className="card panel">
        <h1>House reserve</h1>
        <div className="stats">
          <div className="stat"><span className="lbl">Reserve</span><b>{group(summary.reserve.balance)}</b></div>
          <div className="stat"><span className="lbl">Promised to open flights</span><b>{group(summary.reserve.committed)}</b></div>
          <div className="stat"><span className="lbl">Free</span><b>{group(summary.reserve.free)}</b></div>
          <div className="stat"><span className="lbl">Open flights</span><b>{summary.reserve.openFlights}</b></div>
          <div className="stat"><span className="lbl">Max bet right now</span><b>{group(summary.reserve.maxBetNow)}</b></div>
        </div>
        <p className="hint" style={{ margin: 0 }}>
          Edge {s.edgeBps / 100}% · one bet can cost at most {s.flightRiskBps / 100}% of the free reserve · all open flights at most{' '}
          {s.totalRiskBps / 100}% of the reserve · highest multiplier {x(s.maxMultiplierX100)}. Withdrawals can never touch money promised to open flights.
        </p>
      </section>

      <section className="grid-2">
        <div className="card panel">
          <h2 style={{ margin: 0 }}>Fund or withdraw</h2>
          <div className="field"><label htmlFor="r-amt">Amount ({summary.currency})</label><input id="r-amt" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} /></div>
          <div className="field"><label htmlFor="r-why">Reason (kept in the audit log)</label><input id="r-why" className="text" value={reason} onChange={(e) => setReason(e.target.value)} /></div>
          <div className="row">
            <button className="btn primary" type="button" onClick={() => move('fund')}>Add to reserve</button>
            <button className="btn" type="button" onClick={() => move('withdraw')}>Withdraw profit</button>
          </div>
          {msg && <p className={msg.ok ? 'ok' : 'error'}>{msg.text}</p>}
        </div>
        <div className="card panel">
          <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
            <h2 style={{ margin: 0 }}>Books</h2>
            <button className="btn" type="button" onClick={() => api<Recon>('/admin/ledger/reconciliation').then(setRecon)}>Check the ledger</button>
          </div>
          {recon ? (
            <p className={recon.ok ? 'ok' : 'error'} style={{ margin: 0 }}>
              {recon.ok ? 'Every balance matches its ledger lines and the books balance.' : `Problem: ${recon.accountMismatches.length} account mismatches, ${recon.flightsWithWrongPayout} flights with a wrong payout, trial balance ${recon.trialBalanceMinor}.`}
            </p>
          ) : (
            <p className="hint" style={{ margin: 0 }}>Recomputes every balance from the ledger and checks that debits equal credits.</p>
          )}
          <div className="table-wrap">
            <table>
              <thead><tr><th>When</th><th>Reason</th><th className="num">Change</th><th className="num">Reserve after</th></tr></thead>
              <tbody>
                {moves.length === 0 && <tr><td colSpan={4} className="muted">No funding yet. Add a bankroll before opening the game.</td></tr>}
                {moves.map((m) => (
                  <tr key={m.reference}><td>{new Date(m.createdAt).toLocaleDateString()}</td><td>{m.reason}</td><td className="num">{group(m.change)}</td><td className="num">{group(m.balanceAfter)}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      <section className="card">
        <h2>Results</h2>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Period</th><th className="num">Flights</th><th className="num">Players</th><th className="num">Bets</th><th className="num">Paid to players</th><th className="num">House revenue</th><th className="num">Kept</th><th className="num">Player win rate</th></tr></thead>
            <tbody>
              {PERIODS.map(([key, label]) => {
                const r = summary.results[key];
                return (
                  <tr key={key}>
                    <td>{label}</td><td className="num">{r.flights}</td><td className="num">{r.players}</td><td className="num">{group(r.bets)}</td><td className="num">{group(r.payouts)}</td>
                    <td className={`num ${r.revenueMinor.startsWith('-') ? 'lo' : 'hi'}`}>{group(r.revenue)}</td><td className="num">{pct(r.holdRate)}</td><td className="num">{pct(r.playerWinRate)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="hint">"Kept" approaches the {s.edgeBps / 100}% edge over many flights; short periods swing either way.</p>
      </section>

      <section className="card">
        <h2>Recent flights</h2>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Started</th><th>Player</th><th className="num">Bet</th><th className="num">Limit</th><th>Result</th><th className="num">Popped at</th><th className="num">Paid</th></tr></thead>
            <tbody>
              {flights.map((f) => (
                <tr key={f.id}>
                  <td>{new Date(f.startedAt).toLocaleTimeString()}</td><td>{f.phoneNumber}</td><td className="num">{group(f.bet)}</td><td className="num">{x(f.capX100)}</td>
                  <td>{f.status === 'OPEN' ? <span className="pill wait">flying</span> : f.status === 'CASHED_OUT' ? <span className="pill good">{f.cashoutReason?.toLowerCase()} {x(f.cashoutX100!)}</span> : <span className="pill bad">popped</span>}</td>
                  <td className="num">{f.crash ? `${f.crash}×` : '–'}</td><td className="num">{group(f.payout)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {isAdmin && (
        <section className="card">
          <h2>Players</h2>
          <div className="table-wrap">
            <table>
              <thead><tr><th>Phone</th><th>Joined</th><th className="num">Balance</th><th>Status</th><th></th></tr></thead>
              <tbody>
                {players.map((p) => (
                  <tr key={p.id}>
                    <td>{p.phoneNumber}</td><td>{new Date(p.createdAt).toLocaleDateString()}</td><td className="num">{group(p.balance)}</td>
                    <td><span className={`pill ${p.status === 'ACTIVE' ? 'good' : 'bad'}`}>{p.status.toLowerCase()}</span></td>
                    <td><button className="btn" type="button" onClick={() => block(p)}>{p.status === 'BLOCKED' ? 'Unblock' : 'Block'}</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </>
  );
}
