import { useEffect, useRef, useState } from 'react';
import { ApiError, api } from '../lib/api';

interface Message { id: string; player: string; staff: boolean; mine: boolean; text: string; createdAt: string }

/** Players' chat. New messages are fetched every two seconds. */
export function Chat() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const list = useRef<HTMLDivElement>(null);
  const lastAt = useRef<string | null>(null);

  const load = async () => {
    const q = lastAt.current ? `?after=${encodeURIComponent(lastAt.current)}` : '';
    const r = await api<{ items: Message[] }>(`/chat${q}`).catch(() => null);
    if (!r || r.items.length === 0) return;
    lastAt.current = r.items[r.items.length - 1].createdAt;
    setMessages((m) => {
      const seen = new Set(m.map((x) => x.id));
      return [...m, ...r.items.filter((x) => !seen.has(x.id))].slice(-100);
    });
  };

  useEffect(() => {
    void load();
    const t = setInterval(load, 2000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    const el = list.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length]);

  const send = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!text.trim()) return;
    setBusy(true);
    setError('');
    try {
      await api('/chat', { method: 'POST', body: { text } });
      setText('');
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not send');
    } finally {
      setBusy(false);
    }
  };

  return (
    <aside className="card chat">
      <div className="side-head"><span>Chat</span><span className="hint">Be kind · no links or numbers</span></div>
      <div className="chat-list" ref={list}>
        {messages.length === 0 && <p className="muted">No messages yet.</p>}
        {messages.map((m) => (
          <div key={m.id} className={`msg ${m.mine ? 'mine' : ''} ${m.staff ? 'staff' : ''}`}>
            <span className="who">{m.mine ? 'You' : m.player}</span>
            <span className="what">{m.text}</span>
          </div>
        ))}
      </div>
      <form className="chat-form" onSubmit={send}>
        <input id="chat-text" className="text" aria-label="Message" maxLength={160} placeholder="Say something" value={text} onChange={(e) => setText(e.target.value)} />
        <button className="btn primary" type="submit" disabled={busy}>Send</button>
      </form>
      {error && <p className="error" style={{ margin: 0 }}>{error}</p>}
    </aside>
  );
}
