import { NavLink, Navigate, Route, Routes } from 'react-router-dom';
import { useAuth } from './auth';
import { fromMinor } from './lib/money';
import { Admin } from './pages/Admin';
import { Fairness } from './pages/Fairness';
import { Game } from './pages/Game';
import { SignIn } from './pages/SignIn';
import { Wallet } from './pages/Wallet';
import { useWallet } from './wallet';

export function App() {
  const { session, signOut } = useAuth();
  const wallet = useWallet();
  if (!session) {
    return (
      <main className="wrap">
        <SignIn />
      </main>
    );
  }
  const staff = session.user.role !== 'PLAYER';
  return (
    <main className="wrap">
      <header className="top">
        <NavLink to="/" className="brand">Updraft</NavLink>
        <nav className="nav">
          {!staff && <NavLink to="/" end>Play</NavLink>}
          {!staff && <NavLink to="/wallet">Wallet</NavLink>}
          {!staff && <NavLink to="/fairness">Fairness</NavLink>}
          {staff && <NavLink to="/admin">Admin</NavLink>}
        </nav>
        <span className="spacer" />
        {!staff && (
          <NavLink to="/wallet" className="wallet-pill" style={{ textDecoration: 'none', color: 'inherit' }}>
            <span className="lbl">{wallet.currency}</span>
            <span className="amt num">{wallet.balanceMinor === null ? '–' : fromMinor(wallet.balanceMinor)}</span>
          </NavLink>
        )}
        <button className="btn" type="button" onClick={() => void signOut()}>Sign out</button>
      </header>
      <Routes>
        {staff ? (
          <>
            <Route path="/admin" element={<Admin />} />
            <Route path="*" element={<Navigate to="/admin" replace />} />
          </>
        ) : (
          <>
            <Route path="/" element={<Game />} />
            <Route path="/wallet" element={<Wallet />} />
            <Route path="/fairness" element={<Fairness />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </>
        )}
      </Routes>
    </main>
  );
}
