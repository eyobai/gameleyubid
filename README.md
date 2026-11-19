# Updraft

A multiplayer cash-out game for a LeyuBid subdomain (for example `game.leyubid.com`). Everyone bets on the same
balloon; it rises while a multiplier climbs, and players cash out before it pops to win bet × multiplier.

Updraft is a separate product. It has its own accounts, wallet, Chapa deposits and database, and shares no code or
data with LeyuBid.

> **Before real money:** a game of chance played for money needs a license from Ethiopia's National Lottery
> Administration. The game is off by default (`GAME_ENABLED=false`). Use Chapa test mode until the license is in place.

```
server/   NestJS API + PostgreSQL (Prisma): accounts, ledger, game, deposits, admin
web/      React site: play, wallet, fairness check, admin pages
```

## Run locally

Needs Node.js 22 and Docker.

```bash
docker compose up -d                      # PostgreSQL on port 5433
cd server
cp .env.example .env                      # then set GAME_ENABLED=true for local play
npm install
npx prisma generate
npm run db:deploy
npm run start:dev                         # API on http://localhost:3100
```

```bash
cd web
npm install
npm run dev                               # site on http://localhost:5180 (proxies /api to :3100)
```

Create a staff account, then give a test player money without Chapa:

```bash
cd server
SEED_PHONE=0911000000 SEED_PASSWORD='a-long-password' SEED_ROLE=ADMIN npm run seed
DEV_PHONE=0912345678 DEV_AMOUNT_MINOR=100000 npm run dev:credit   # refuses to run in production
```

Sign in as staff, open **Admin**, and **Add to reserve** before anyone plays. With an empty reserve the largest
allowed bet is 0.

## Tests

```bash
cd server
npm test              # game math, fairness distribution, reserve limits, Chapa rules
npm run test:e2e      # against PostgreSQL; set TEST_DATABASE_URL (database name must contain "test")
cd ../web && npm test # browser fairness check matches the server formula
```

The integration tests cover:
- a full shared round from betting to pop, with two players seeing each other
- bets after lift-off refused
- cash-outs, auto cash-outs and pops
- one bet per player per round, and retried requests
- 30 players betting 1,000 at the same moment, cashed out together at the shared round limit
- four engines ticking at once opening exactly one round
- withdrawals that would touch promised money
- seeds hashing back to the published commitment
- refresh-token reuse
- reconciliation after the money tests

## How a round works

Everyone plays the same rounds and sees the same balloon:

1. **Betting (7 s by default, `GAME_BETTING_MS`).** Players place one bet each with `POST /api/v1/game/bets`, with
   `betMinor` (and optional `autoCashoutX100`) and an `Idempotency-Key`. The bet is taken from the wallet at once.
2. **Lift-off.** Betting closes on the **database clock**. The multiplier is `floor(100 · e^(0.12 · seconds))` from
   lift-off: 2× after about 5.8 s, 10× after about 19 s.
3. **Cash out.** `POST /game/bets/:id/cash-out` pays bet × the multiplier at the moment the server handles the
   request, if the balloon hasn't popped. Cash-out opens at 1.01×.
4. **Pop.** Bets still flying are lost. The round's seed is revealed and the next round opens.

**What players can do in a round:**
- **Two bets at once.** Each player has two bet panels (`slot` 1 and 2), for example one safe bet with auto cash-out at
  1.5× and one left to ride.
- **Cancel** a bet before lift-off (`POST /game/bets/:id/cancel`). It's returned in full and the slot is free again.
- **Bet on the next round** while one is flying. The site places the bet as soon as betting opens.
- **Auto bet** repeats the same bet every round, with optional auto cash-out. It stops as soon as a bet can't be
  placed, for example when the balance runs out. Auto bet runs in the player's browser, so nothing is placed while
  they're away.
- **Quick amounts**, + / − steps, and sound effects that can be switched on and off.
- **All bets / My bets / Top:** the current round's bets, the player's own history, and the biggest wins or
  multipliers of the day, month or year (`GET /game/top`).
- **Chat** (`/chat`) for players who have played at least one round:
  - links, usernames and phone numbers are refused, which stops scam "signals"
  - one message every 3 seconds
  - admins can hide messages and mute players, and every action is recorded in the audit log

The **round engine** runs every 100 ms (`GAME_TICK_MS`):
- it pays auto cash-outs and limit cash-outs at their exact multiplier, so a player who closes the page is still paid
- it ends rounds and opens the next one
- several servers can run it at once: a database lock picks one to move rounds forward, and each bet is settled
  under its own row lock

**What players see:** `GET /game/live`, which the site checks about 3 times a second, returns:
- the current round
- every bet in it, with phone numbers masked like `+2519******67`
- who has cashed out at what
- the last 24 pop points
- the player's own bet

The pop point of a round is never sent before it ends.

Every money movement is a balanced journal in a double-entry ledger in integer minor units. The database rejects
unbalanced journals, edits to ledger lines, a negative wallet and a negative reserve.

## Bankruptcy protection

The **reserve** is the house bankroll that pays winners. Staff fund it and take profit out from the admin page.

| Rule | Default | Setting |
| --- | --- | --- |
| The most one bet can cost the house (payout − bet), as a share of the reserve | 1% | `GAME_FLIGHT_RISK_BPS=100` |
| The most one whole round can cost the house, as a share of the reserve | 10% | `GAME_TOTAL_RISK_BPS=1000` |
| Highest multiplier anyone is paid at | 1000× | `GAME_MAX_MULTIPLIER_X100=100000` |
| House edge | 3% | `GAME_EDGE_BPS=300` |

How the limits are applied:
- **What the limits are a share of:** the reserve minus the bets still in the air, which may soon be paid back out.
- **Personal limit:** each bet gets its own cap, the multiplier where its winnings reach 1%. Bets larger than 1% are
  refused (`BET_ABOVE_LIMIT`, with the current maximum).
- **Shared round limit:** when a round's possible winnings would pass 10%, the round gets a limit and **everyone
  still flying is cashed out together** there. Players see it on screen. For example, with a 100,000 reserve and 30
  players betting 1,000, everyone is cashed out at 1.33× at the latest. A bet is refused only when even 1.01×
  wouldn't fit (`ROUND_FULL`).
- **Coverage:** a bet is refused if the reserve couldn't cover every open bet's largest payout after taking it. A
  withdrawal can never take money promised to open bets.

## Provably fair

```
seed[L] = random;  seed[i − 1] = SHA-256(seed[i]);  commitment = seed[0]   (published before round 1)
round i uses seed[i] and reveals it when it ends

h     = first 13 hex digits of HMAC-SHA256(key = seed, message = salt)
E     = 2^52
crash = floor((10000 − edgeBps) · E / (100 · (E − h))), at least 100   (×100: 250 = 2.50×)
```

- **Checking a round:** hash its seed with SHA-256. The result must be the seed of the round before it (the
  commitment, for the first round).
- **Why seeds can't be changed:** SHA-256 can't be reversed, so every seed was fixed when the commitment was published.
- **In the browser:** the Fairness page shows the commitments and lets anyone check any round.
- **Odds:** a target *m* is reached with probability (1 − edge) / *m*, so every strategy returns 97% over time.
- **Chains:** each holds 100,000 rounds (`GAME_CHAIN_LENGTH`). When one runs out, a new chain with a new commitment
  starts.
- **Strongest guarantee:** publish the commitment somewhere public first (for example a social media post). Then set
  `GAME_CHAIN_SALT` to a value nobody could know in advance, such as a later lottery draw.

The formula is in `server/src/game/fairness.ts`.

## Deposits (Chapa)

Set `PAYMENT_PROVIDER=chapa` and `CHAPA_SECRET_KEY` (a `CHASECK_TEST-…` key for test mode). Checking works the same
way as in LeyuBid:
- **Verification:** a deposit is credited only after the server asks Chapa and the amount, currency, reference and
  mode all match.
- **Triggers:** the check runs on Chapa's callback, when the player returns from checkout, and in a background check
  every 60 s.
- **Webhooks:** accepted only with `CHAPA_WEBHOOK_SECRET` set and a valid signature.

## Deploying on a subdomain

The Docker image serves both the API (`/api/v1/...`) and the site from one address:

```bash
docker build -t updraft .
docker run -p 3100:3100 --env-file server/.env -e DATABASE_URL=postgresql://... updraft
```

The container applies pending migrations at start.

1. Create a PostgreSQL database that is separate from LeyuBid's.
2. Set the production variables in `server/.env`:
   - `NODE_ENV=production`
   - `PUBLIC_URL=https://game.leyubid.com`
   - `CORS_ORIGINS=https://game.leyubid.com`
   - `TRUST_PROXY=true` (behind a proxy)
   - a random `JWT_ACCESS_SECRET` (`openssl rand -base64 48`)
3. Point a DNS record for `game.leyubid.com` at the server or load balancer and terminate HTTPS there.
4. In the Chapa dashboard, set the webhook URL to `https://game.leyubid.com/api/v1/payments/chapa/webhook`.
5. Seed an ADMIN and a FINANCE account, fund the reserve, then set `GAME_ENABLED=true`.

## Not built yet

- **Withdrawals to players.** Players can deposit and win but can't cash out to telebirr or a bank yet. This must
  exist before real money; it needs Chapa transfers and a staff approval step.
- **Responsible-gambling tools:** deposit and loss limits, self-exclusion, cool-off periods, age and identity checks.
  These are likely license conditions.
- **Amharic translation** of the site.
- **Live updates over WebSocket.** The site checks the server about 3 times a second, which is fine for hundreds of
  players. Thousands at once would call for a WebSocket push instead.
