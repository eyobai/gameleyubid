import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { api } from './lib/api';
import { useAuth } from './auth';

interface WalletState {
  balanceMinor: bigint | null;
  currency: string;
  refresh: () => Promise<void>;
}

const Ctx = createContext<WalletState>({ balanceMinor: null, currency: 'ETB', refresh: async () => undefined });

export function WalletProvider({ children }: { children: ReactNode }) {
  const { session } = useAuth();
  const [balanceMinor, setBalance] = useState<bigint | null>(null);
  const [currency, setCurrency] = useState('ETB');
  const refresh = useCallback(async () => {
    if (!session || session.user.role !== 'PLAYER') return setBalance(null);
    const w = await api<{ balanceMinor: string; currency: string }>('/wallet').catch(() => null);
    if (w) {
      setBalance(BigInt(w.balanceMinor));
      setCurrency(w.currency);
    }
  }, [session]);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  const value = useMemo(() => ({ balanceMinor, currency, refresh }), [balanceMinor, currency, refresh]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export const useWallet = () => useContext(Ctx);
