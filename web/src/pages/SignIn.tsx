import { useState } from 'react';
import { useAuth } from '../auth';
import { ApiError } from '../lib/api';

export function SignIn() {
  const { signIn } = useAuth();
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
  const [adult, setAdult] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    if (mode === 'register' && !adult) return setError('Confirm that you are 18 or older');
    setBusy(true);
    try {
      await signIn(mode, phone, password);
    } catch (err) {
      setError(err instanceof ApiError ? (err.code === 'VALIDATION_FAILED' ? 'Use at least 8 characters with a letter and a digit' : err.message) : 'Could not sign in');
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="auth card panel" onSubmit={submit} noValidate>
      <div>
        <h1>Updraft</h1>
        <p className="muted" style={{ margin: '4px 0 0' }}>Bet, watch the balloon climb, cash out before it pops.</p>
      </div>
      <div className="tabs">
        <button type="button" className={`btn ${mode === 'login' ? 'on' : ''}`} onClick={() => setMode('login')}>Sign in</button>
        <button type="button" className={`btn ${mode === 'register' ? 'on' : ''}`} onClick={() => setMode('register')}>Create account</button>
      </div>
      <div className="field">
        <label htmlFor="phone">Phone number</label>
        <input id="phone" type="tel" autoComplete="tel" placeholder="0911 234 567" value={phone} onChange={(e) => setPhone(e.target.value)} />
      </div>
      <div className="field">
        <label htmlFor="password">Password</label>
        <input
          id="password"
          type="password"
          autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        {mode === 'register' && <div className="hint">At least 8 characters, with a letter and a digit.</div>}
      </div>
      {mode === 'register' && (
        <label style={{ display: 'flex', gap: 8, alignItems: 'center', textTransform: 'none', letterSpacing: 0, fontSize: 14 }}>
          <input id="adult" type="checkbox" checked={adult} onChange={(e) => setAdult(e.target.checked)} style={{ width: 'auto' }} />
          I am 18 or older
        </label>
      )}
      <button className="go" type="submit" disabled={busy}>{mode === 'login' ? 'Sign in' : 'Create account'}</button>
      <p className="error" role="status">{error}</p>
    </form>
  );
}
