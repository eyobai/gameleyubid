import { useEffect, useState } from 'react';
import { ApiError, api } from '../lib/api';
import { x } from '../lib/money';
import { crashPointX100, sha256Hex } from '../game/math';

interface Seeds { serverSeedHash: string; clientSeed: string; nextNonce: number }
interface Rotated { previous: { serverSeed: string; serverSeedHash: string; clientSeed: string; flights: number }; current: Seeds }

export function Fairness() {
  const [seeds, setSeeds] = useState<Seeds | null>(null);
  const [clientSeed, setClientSeed] = useState('');
  const [revealed, setRevealed] = useState<Rotated['previous'] | null>(null);
  const [error, setError] = useState('');
  const [check, setCheck] = useState({ serverSeed: '', clientSeed: '', nonce: '0', edge: '300' });
  const [checked, setChecked] = useState<{ crash: string; hash: string } | null>(null);

  useEffect(() => {
    void api<Seeds>('/game/seeds').then(setSeeds).catch(() => undefined);
  }, []);

  const rotate = async () => {
    setError('');
    try {
      const r = await api<Rotated>('/game/seeds/rotate', { method: 'POST', body: clientSeed ? { clientSeed } : {} });
      setRevealed(r.previous);
      setSeeds(r.current);
      setCheck({ serverSeed: r.previous.serverSeed, clientSeed: r.previous.clientSeed, nonce: '0', edge: '300' });
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not change seeds');
    }
  };

  const verify = async (e: React.FormEvent) => {
    e.preventDefault();
    const crash = await crashPointX100(check.serverSeed.trim(), check.clientSeed.trim(), Number(check.nonce), Number(check.edge));
    setChecked({ crash: x(crash), hash: await sha256Hex(check.serverSeed.trim()) });
  };

  return (
    <>
      <section className="card">
        <h1>Provably fair</h1>
        <p className="muted" style={{ maxWidth: '68ch' }}>
          Every pop point comes from three things fixed before you bet: a secret server seed, your client seed, and a counter (the nonce)
          that goes up by one each flight. You see the server seed's SHA-256 hash in advance. When you change seeds, the old server seed is
          revealed, so you can recompute every flight and confirm that nothing was changed after you bet.
        </p>
        <pre className="card" style={{ background: 'var(--ink)', overflowX: 'auto', margin: 0 }}><code>{`h     = first 13 hex digits of HMAC-SHA256(key = serverSeed, message = clientSeed + ":" + nonce)
E     = 2^52
crash = floor( (10000 - edgeBps) × E / (100 × (E − h)) ) / 100, at least 1.00×`}</code></pre>
      </section>

      <section className="grid-2">
        <div className="card panel">
          <h2 style={{ margin: 0 }}>Your current seeds</h2>
          {seeds && (
            <>
              <div className="field"><span className="lbl">Server seed hash</span><code>{seeds.serverSeedHash}</code></div>
              <div className="field"><span className="lbl">Client seed</span><code>{seeds.clientSeed}</code></div>
              <div className="field"><span className="lbl">Next nonce</span><code>{seeds.nextNonce}</code></div>
            </>
          )}
          <div className="field">
            <label htmlFor="cs">New client seed (optional)</label>
            <div className="row">
              <input id="cs" className="text" placeholder="anything you like" value={clientSeed} onChange={(e) => setClientSeed(e.target.value)} />
              <button className="btn" type="button" onClick={rotate}>Change seeds</button>
            </div>
            <div className="hint">Reveals the current server seed and starts a new pair. Not possible while a balloon is flying.</div>
          </div>
          <p className="error">{error}</p>
          {revealed && (
            <div className="banner">
              Revealed server seed for {revealed.flights} flight{revealed.flights === 1 ? '' : 's'}: <code>{revealed.serverSeed}</code>
            </div>
          )}
        </div>

        <form className="card panel" onSubmit={verify}>
          <h2 style={{ margin: 0 }}>Check a flight</h2>
          <div className="field"><label htmlFor="v-ss">Server seed</label><input id="v-ss" className="text" value={check.serverSeed} onChange={(e) => setCheck({ ...check, serverSeed: e.target.value })} /></div>
          <div className="field"><label htmlFor="v-cs">Client seed</label><input id="v-cs" className="text" value={check.clientSeed} onChange={(e) => setCheck({ ...check, clientSeed: e.target.value })} /></div>
          <div className="row">
            <div className="field" style={{ flex: 1 }}><label htmlFor="v-n">Nonce</label><input id="v-n" inputMode="numeric" value={check.nonce} onChange={(e) => setCheck({ ...check, nonce: e.target.value })} /></div>
            <div className="field" style={{ flex: 1 }}><label htmlFor="v-e">Edge (bps)</label><input id="v-e" inputMode="numeric" value={check.edge} onChange={(e) => setCheck({ ...check, edge: e.target.value })} /></div>
          </div>
          <button className="btn primary" type="submit">Calculate in my browser</button>
          {checked && (
            <div className="field">
              <span>Pop point: <b className="num">{checked.crash}</b></span>
              <span className="hint">Seed hash: <code>{checked.hash}</code></span>
            </div>
          )}
        </form>
      </section>
    </>
  );
}
