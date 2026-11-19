import { chatRefusal } from './chat.rules';

describe('chat rules', () => {
  it('allows ordinary messages, multipliers included', () => {
    expect(chatRefusal('nice 12.50x!')).toBeNull();
    expect(chatRefusal('cashed at 2.35 then it went to 100')).toBeNull();
  });
  it('refuses links, usernames and phone numbers', () => {
    expect(chatRefusal('join https://example.com')).toMatch(/Links/);
    expect(chatRefusal('signals at t.me/winbig')).toMatch(/Links/);
    expect(chatRefusal('dm @predictor')).toMatch(/Links/);
    expect(chatRefusal('call 0911 23 45 67')).toMatch(/Phone/);
    expect(chatRefusal('+251-911-234567')).toMatch(/Phone/);
  });
  it('refuses empty and long messages', () => {
    expect(chatRefusal('   ')).not.toBeNull();
    expect(chatRefusal('x'.repeat(161))).not.toBeNull();
  });
});
