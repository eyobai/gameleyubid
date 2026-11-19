import { createContext, useContext, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { api, getSession, onSession, setSession } from './lib/api';
import type { Session } from './lib/api';

interface AuthState {
  session: Session | null;
  signIn: (mode: 'login' | 'register', phoneNumber: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
}

const Ctx = createContext<AuthState>(null as unknown as AuthState);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, set] = useState(getSession());
  useEffect(() => {
    const off = onSession(set);
    return () => {
      off();
    };
  }, []);
  const signIn = async (mode: 'login' | 'register', phoneNumber: string, password: string) => {
    setSession(await api<Session>(`/auth/${mode}`, { method: 'POST', body: { phoneNumber, password } }));
  };
  const signOut = async () => {
    const s = getSession();
    setSession(null);
    if (s) await api('/auth/logout', { method: 'POST', body: { refreshToken: s.refreshToken } }).catch(() => undefined);
  };
  return <Ctx.Provider value={{ session, signIn, signOut }}>{children}</Ctx.Provider>;
}

export const useAuth = () => useContext(Ctx);
