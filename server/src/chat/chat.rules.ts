/** Why a chat message is refused, or null when it may be posted. Kept pure so the rules are easy to test. */
export function chatRefusal(text: string): string | null {
  const t = text.trim();
  if (t.length < 1 || t.length > 160) return 'Messages are 1 to 160 characters';
  // Links and phone numbers are how scams and paid "signals" spread in game chats.
  if (/(https?:\/\/|www\.|\b[a-z0-9-]+\.(com|net|org|et|io|me|bet|xyz|link|ly)\b|t\.me|@\w{3,})/i.test(t)) {
    return 'Links and usernames are not allowed in chat';
  }
  if ((t.replace(/[\s\-().+]/g, '').match(/\d/g) ?? []).length >= 7 && /\d[\d\s\-().]{6,}\d/.test(t)) {
    return 'Phone numbers are not allowed in chat';
  }
  return null;
}
