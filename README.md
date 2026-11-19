# Updraft

A cash-out game for a LeyuBid subdomain (for example `game.leyubid.com`). A player bets, a balloon rises while a
multiplier climbs, and the player cashes out before it pops to win bet × multiplier.

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
- cash-outs, pops and auto cash-outs
- limit cash-outs settled by the background job
- the player and the job racing to settle the same flight (it pays once)
- retried requests
- 30 players betting at the same moment against the reserve limit
- withdrawals that would touch promised money
- seed reveal and re-verification
- refresh-token reuse
- reconciliation after every money test

## How a flight works

1. **Bet.** `POST /api/v1/game/flights` with `betMinor` (and optional `autoCashoutX100`) and an `Idempotency-Key`.
   In one database transaction the server:
   - checks the reserve limits
   - takes the bet from the wallet
   - computes the pop point from the player's seeds
   - fixes the flight's cap and the moment it settles
2. **Fly.** The multiplier is `floor(100 · e^(0.12 · seconds))` on the **database clock**: 2× after about 5.8 s, 10× after about 19 s.
   The pop point stays secret until the flight is over.
3. **Cash out.** `POST /flights/:id/cash-out` pays bet × the multiplier at the moment the server handles the request,
   if the balloon has not popped. Cash-out opens at 1.01×.
4. **Automatic settlement.** A background job (every 500 ms) settles flights without waiting for the player:
   - auto cash-outs
   - flights that reach their cap (the reserve limit)
   - pops

   A player who closes the page is still paid.

Every money movement is a balanced journal in a double-entry ledger in integer minor units. The database rejects
unbalanced journals, edits to ledger lines, a negative wallet and a negative reserve.

## Bankruptcy protection

The **reserve** is the house bankroll that pays winners. Staff fund it and take profit out from the admin page.

| Rule | Default | Setting |
| --- | --- | --- |
| The most one bet can cost the house (payout − bet), as a share of the free reserve | 1% | `GAME_FLIGHT_RISK_BPS=100` |
| The most all open flights together can cost the house, as a share of the reserve | 10% | `GAME_TOTAL_RISK_BPS=1000` |
| Highest multiplier anyone is paid at | 1000× | `GAME_MAX_MULTIPLIER_X100=100000` |
| House edge | 3% | `GAME_EDGE_BPS=300` |

How the limits are applied:
- **Free reserve:** the reserve minus everything open flights could still win.
- **Bet limit:** a bet larger than the current limit is refused (`BET_ABOVE_LIMIT`, with the current maximum).
- **Cap:** every accepted bet gets a cap, the multiplier where its winnings reach the limit. The flight is paid out
  there automatically, so no payout can exceed what was set aside for it.
- **Serialization:** new bets and reserve withdrawals take the same lock, so two bets can't both use the same free
  money. A withdrawal can never take money promised to open flights.

Taken together, the reserve always covers every open flight at its maximum, and one round can cost it at most 1%.

## Provably fair

```
h     = first 13 hex digits of HMAC-SHA256(key = serverSeed, message = clientSeed + ":" + nonce)
E     = 2^52
crash = floor((10000 − edgeBps) · E / (100 · (E − h))), at least 100   (×100: 250 = 2.50×)
```

- **Before betting:** players see the SHA-256 hash of their server seed. The nonce goes up by one with each flight.
- **After changing seeds:** **Change seeds** reveals the old server seed, and the Fairness page recomputes any flight
  in the browser.
- **Odds:** a target *m* is reached with probability (1 − edge) / *m*, so every strategy returns 97% over time.

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
- **Shared rounds**, where all players watch the same balloon. Each player currently flies their own.
