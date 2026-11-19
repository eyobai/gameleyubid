import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ApiError, api, newKey } from '../lib/api';
import { fromMinor, toMinor } from '../lib/money';
import { useWallet } from '../wallet';

interface Options { enabled: boolean; testMode: boolean; currency: string; minAmountMinor: string; maxAmountMinor: string }
interface Deposit { id: string; reference: string; status: string; amountMinor: string; checkoutUrl: string | null; createdAt: string }
interface Entry { sequence: string; type: string; description: string | null; changeMinor: string; balanceAfterMinor: string; createdAt: string }

const LABEL: Record<string, string> = { DEPOSIT: 'Deposit', BET: 'Bet', PAYOUT: 'Win' };
const tone = (s: string) => (s === 'SUCCEEDED' ? 'good' : s === 'PENDING' || s === 'INITIATED' ? 'wait' : 'bad');

export function Wallet() {
  const wallet = useWallet();
  const [params, setParams] = useSearchParams();
  const [options, setOptions] = useState<Options | null>(null);
  const [amount, setAmount] = useState('100');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [deposits, setDeposits] = useState<Deposit[]>([]);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [notice, setNotice] = useState('');

  const load = () => {
    void api<{ items: Deposit[] }>('/wallet/deposits').then((r) => setDeposits(r.items)).catch(() => undefined);
    void api<{ items: Entry[] }>('/wallet/transactions?limit=50').then((r) => setEntries(r.items)).catch(() => undefined);
    void wallet.refresh();
  };

  useEffect(() => {
    void api<Options>('/wallet/deposits/options').then(setOptions).catch(() => undefined);
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Back from Chapa: ask the server (which asks Chapa) until the deposit is settled.
  useEffect(() => {
    const id = params.get('deposit');
    if (!id) return;
    let tries = 0;
    setNotice('Checking your payment…');
    const timer = setInterval(async () => {
      tries++;
      const d = await api<Deposit>(`/wallet/deposits/${id}`).catch(() => null);
      if (d && d.status !== 'PENDING' && d.status !== 'INITIATED') {
        clearInterval(timer);
        setNotice(d.status === 'SUCCEEDED' ? `${fromMinor(d.amountMinor)} added to your wallet.` : 'The payment did not go through.');
        setParams({}, { replace: true });
        load();
      } else if (tries > 20) {
        clearInterval(timer);
        setNotice('Still waiting for Chapa to confirm. Your wallet updates as soon as it does.');
      }
    }, 3000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params]);

  const deposit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    const minor = toMinor(amount);
    if (!minor) return setError('Enter an amount, e.g. 100');
    setBusy(true);
    try {
      const d = await api<Deposit>('/wallet/deposits', { method: 'POST', idempotencyKey: newKey(), body: { amountMinor: minor.toString() } });
      if (d.checkoutUrl) location.assign(d.checkoutUrl);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not start the payment');
      setBusy(false);
    }
  };

  return (
    <>
      <section className="grid-2">
        <div className="card panel">
          <div className="stat">
            <span className="lbl">Balance</span>
            <b style={{ fontSize: 32 }}>{wallet.balanceMinor === null ? '–' : fromMinor(wallet.balanceMinor)} {wallet.currency}</b>
          </div>
          {notice && <div className="banner">{notice}</div>}
        </div>
        <form className="card panel" onSubmit={deposit} noValidate>
          <h2 style={{ margin: 0 }}>Add money</h2>
          {options && !options.enabled ? (
            <p className="muted">Deposits are not open yet.</p>
          ) : (
            <>
              {options?.testMode && <div className="banner">Test mode: payments use Chapa's test accounts and no real money moves.</div>}
              <div className="field">
                <label htmlFor="amount">Amount ({options?.currency ?? 'ETB'})</label>
                <input id="amount" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
                {options && <div className="hint">Between <b>{fromMinor(options.minAmountMinor)}</b> and <b>{fromMinor(options.maxAmountMinor)}</b>. You pay on Chapa's page with telebirr, CBE Birr, M-Pesa or a card.</div>}
              </div>
              <button className="go" type="submit" disabled={busy}>Continue to payment</button>
              <p className="error" role="status">{error}</p>
            </>
          )}
        </form>
      </section>

      <section className="card">
        <h2>History</h2>
        <div className="table-wrap">
          <table>
            <thead><tr><th>When</th><th>What</th><th className="num">Change</th><th className="num">Balance</th></tr></thead>
            <tbody>
              {entries.length === 0 && <tr><td colSpan={4} className="muted">Nothing yet. Deposits, bets and wins appear here.</td></tr>}
              {entries.map((e) => (
                <tr key={e.sequence}>
                  <td>{new Date(e.createdAt).toLocaleString()}</td>
                  <td>{LABEL[e.type] ?? e.type}{e.type === 'PAYOUT' && e.description ? ` · ${e.description.replace('Updraft win at ', '')}` : ''}</td>
                  <td className={`num ${e.changeMinor.startsWith('-') ? 'lo' : 'hi'}`}>{e.changeMinor.startsWith('-') ? '' : '+'}{fromMinor(e.changeMinor)}</td>
                  <td className="num">{fromMinor(e.balanceAfterMinor)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {deposits.length > 0 && (
        <section className="card">
          <h2>Deposits</h2>
          <div className="table-wrap">
            <table>
              <thead><tr><th>When</th><th>Reference</th><th className="num">Amount</th><th>Status</th></tr></thead>
              <tbody>
                {deposits.map((d) => (
                  <tr key={d.id}>
                    <td>{new Date(d.createdAt).toLocaleString()}</td>
                    <td><code>{d.reference}</code></td>
                    <td className="num">{fromMinor(d.amountMinor)}</td>
                    <td><span className={`pill ${tone(d.status)}`}>{d.status.toLowerCase()}</span> {d.checkoutUrl && <a href={d.checkoutUrl}>Pay</a>}</td>
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
