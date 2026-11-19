import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';

export interface Bet {
  id: string;
  slot: number;
  roundId: string;
  roundNumber: number;
  status: 'OPEN' | 'CASHED_OUT' | 'BUSTED' | 'CANCELLED';
  betMinor: string;
  autoCashoutX100: number | null;
  capX100: number;
  cashoutX100: number | null;
  cashoutReason: 'PLAYER' | 'AUTO' | 'LIMIT' | null;
  payoutMinor: string | null;
  profitMinor: string | null;
  crashX100: string | null;
  createdAt: string;
}

export interface LivePlayer {
  player: string;
  betMinor: string;
  status: Bet['status'];
  cashoutX100: number | null;
  payoutMinor: string | null;
}

export interface LiveRound {
  id: string;
  number: number;
  status: 'BETTING' | 'FLYING' | 'ENDED';
  startsAt: string;
  serverTime: string;
  capX100: number | null;
  crashX100: string | null;
  players: LivePlayer[];
  playerCount: number;
  totalBetMinor: string;
}

export interface Live {
  round: LiveRound | null;
  mine: Bet[];
  history: { number: number; crashX100: string; endedAt: string | null }[];
}

export interface Info {
  enabled: boolean;
  currency: string;
  edgeBps: number;
  minBetMinor: string;
  maxBetMinor: string;
  bettingMs: number;
}

const POLL_MS = 300;

/**
 * Follows the shared round. The server's clock decides everything: `serverNow` estimates it from each answer.
 * `onNewRound` runs once whenever a new round number appears, with the number of the round that just ended.
 */
export function useLive(onNewRound: (endedNumber: number) => void) {
  const [live, setLive] = useState<Live | null>(null);
  const [info, setInfo] = useState<Info | null>(null);
  const ref = useRef<Live | null>(null);
  const offset = useRef(0);
  const last = useRef<number | null>(null);
  const cb = useRef(onNewRound);
  cb.current = onNewRound;

  const serverNow = useCallback(() => Date.now() + offset.current, []);
  const loadInfo = useCallback(() => api<Info>('/game/info').then(setInfo).catch(() => undefined), []);
  const refresh = useCallback(async () => {
    const sent = Date.now();
    const l = await api<Live>('/game/live');
    const got = Date.now();
    if (l.round) offset.current = Date.parse(l.round.serverTime) - (sent + got) / 2;
    ref.current = l;
    setLive(l);
    if (l.round) {
      if (last.current !== null && l.round.number !== last.current) {
        cb.current(last.current);
        void loadInfo();
      }
      last.current = l.round.number;
    }
  }, [loadInfo]);

  useEffect(() => {
    let stop = false;
    const loop = async () => {
      await refresh().catch(() => undefined);
      if (!stop) setTimeout(loop, POLL_MS);
    };
    void loop();
    void loadInfo();
    return () => {
      stop = true;
    };
  }, [refresh, loadInfo]);

  return { live, liveRef: ref, info, serverNow, refresh };
}
