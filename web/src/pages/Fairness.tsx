import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { x } from '../lib/money';
import { roundCrashX100, sha256Hex } from '../game/math';

interface Chain { commitment: string; salt: string; length: number; roundsPlayed: number; createdAt: string }
interface PlayedRound { number: number; seed: string; chainIndex: number; chainCommitment: string; salt: string; edgeBps: number; crashX100: string; endedAt: string | null }
type Check = { ok: boolean; text: string };

export function Fairness() {
  const [chains, setChains] = useState<Chain[]>([]);
  const [rounds, setRounds] = useState<PlayedRound[]>([]);
  const [checks, setChecks] = useState<Record<number, Check>>({});
  const [form, setForm] = useState({ seed: '', salt: '', edge: '300' });
  const [result, setResult] = useState<{ crash: string; previous: string } | null>(null);

  useEffect(() => {
    void api<{ items: Chain[] }>('/game/chains').then((r) => setChains(r.items)).catch(() => undefined);
    void api<{ items: PlayedRound[] }>('/game/rounds?limit=30').then((r) => setRounds(r.items)).catch(() => undefined);
  }, []);

  /** Checks a round in the browser: its seed hashes to the round before (or the commitment), and gives its pop point. */
  const check = async (r: PlayedRound) => {
    const before = r.chainIndex === 1 ? r.chainCommitment : rounds.find((o) => o.chainCommitment === r.chainCommitment && o.chainIndex === r.chainIndex - 1)?.seed;
    const hash = await sha256Hex(r.seed);
    const crash = await roundCrashX100(r.seed, r.salt, r.edgeBps);
    const chainOk = before === undefined ? null : hash === before;
    const crashOk = crash.toString() === r.crashX100;
    const ok = crashOk && chainOk !== false;
    const text = `${crashOk ? `Pop point ${x(crash)} matches` : `Pop point ${x(crash)} does NOT match ${x(r.crashX100)}`} · ${
      chainOk === null ? 'previous seed not on this page' : chainOk ? (r.chainIndex === 1 ? 'seed hashes to the commitment' : 'seed hashes to the round before') : 'seed does NOT hash to the round before'
    }`;
    setChecks((c) => ({ ...c, [r.number]: { ok, text } }));
  };

  const verify = async (e: React.FormEvent) => {
    e.preventDefault();
    const crash = await roundCrashX100(form.seed.trim(), form.salt, Number(form.edge));
    setResult({ crash: x(crash), previous: await sha256Hex(form.seed.trim()) });
  };

  return (
    <>
      <section className="card">
        <h1>Provably fair</h1>
        <p className="muted" style={{ maxWidth: '70ch' }}>
          Every round's pop point comes from a seed that was fixed before the round, before anyone bet. The seeds form a chain: each one,
          hashed with SHA-256, gives the seed of the round before it. The last hash, the commitment, was published before the first round.
          Because SHA-256 can't be reversed, nobody (including us) could change a seed after publishing the commitment. Each seed is shown
          once its round ends.
        </p>
        <pre className="card" style={{ background: 'var(--ink)', overflowX: 'auto', margin: 0 }}><code>{`SHA-256(seed of round n) = seed of round n − 1      (round 1: the commitment)
h     = first 13 hex digits of HMAC-SHA256(key = seed, message = salt)
E     = 2^52
crash = floor( (10000 − edgeBps) × E / (100 × (E − h)) ) / 100, at least 1.00×`}</code></pre>
      </section>

      <section className="card">
        <h2>Published commitments</h2>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Commitment</th><th>Salt</th><th className="num">Rounds played</th><th>Published</th></tr></thead>
            <tbody>
              {chains.map((c) => (
                <tr key={c.commitment}>
                  <td><code>{c.commitment}</code></td><td><code>{c.salt}</code></td>
                  <td className="num">{c.roundsPlayed.toLocaleString()} / {c.length.toLocaleString()}</td>
                  <td>{new Date(c.createdAt).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="card">
        <h2>Recent rounds</h2>
        <div className="table-wrap">
          <table>
            <thead><tr><th className="num">Round</th><th className="num">Popped at</th><th>Seed</th><th></th></tr></thead>
            <tbody>
              {rounds.length === 0 && <tr><td colSpan={4} className="muted">No rounds have ended yet.</td></tr>}
              {rounds.map((r) => (
                <tr key={r.number}>
                  <td className="num">{r.number}</td>
                  <td className="num">{x(r.crashX100)}</td>
                  <td><code>{r.seed.slice(0, 20)}…</code></td>
                  <td>
                    {checks[r.number] ? (
                      <span className={checks[r.number].ok ? 'ok' : 'error'} style={{ whiteSpace: 'normal' }}>{checks[r.number].text}</span>
                    ) : (
                      <button className="btn" type="button" onClick={() => check(r)}>Check</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <form className="card panel" onSubmit={verify}>
        <h2 style={{ margin: 0 }}>Check any seed</h2>
        <div className="field"><label htmlFor="v-seed">Seed</label><input id="v-seed" className="text" value={form.seed} onChange={(e) => setForm({ ...form, seed: e.target.value })} /></div>
        <div className="row">
          <div className="field" style={{ flex: 2 }}><label htmlFor="v-salt">Salt</label><input id="v-salt" className="text" value={form.salt} onChange={(e) => setForm({ ...form, salt: e.target.value })} /></div>
          <div className="field" style={{ flex: 1 }}><label htmlFor="v-edge">Edge (bps)</label><input id="v-edge" inputMode="numeric" value={form.edge} onChange={(e) => setForm({ ...form, edge: e.target.value })} /></div>
        </div>
        <button className="btn primary" type="submit">Calculate in my browser</button>
        {result && (
          <div className="field">
            <span>Pop point: <b className="num">{result.crash}</b></span>
            <span className="hint">Seed of the round before (SHA-256 of this seed): <code>{result.previous}</code></span>
          </div>
        )}
      </form>
    </>
  );
}
