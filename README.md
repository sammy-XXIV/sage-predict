# SAGE — BTC Trading Terminal on Sui

SAGE is a full trading terminal for BTC binary prediction markets, built on [DeepBook Predict](https://deepbook.tech) (Sui testnet) and delivered entirely inside Telegram. It combines a conversational AI agent, a live charting mini-app, real-time market intelligence, and automated execution — everything a trader needs, without leaving the chat.

Users interact in natural language or via the built-in mini-app. SAGE handles wallet creation, on-chain execution, position monitoring, automatic settlement, vol analysis, arb detection, and strategy automation.

Built for the **Sui Overflow 2026 Hackathon** (DeepBook track).

---

## Table of Contents

1. [Architecture Overview](#architecture-overview)
2. [Protocol: DeepBook Predict](#protocol-deepbook-predict)
3. [Pricing Model: SVI](#pricing-model-stochastic-volatility-inspired-svi)
4. [Feature Set](#feature-set)
5. [Tech Stack](#tech-stack)
6. [Repository Structure](#repository-structure)
7. [Deployment](#deployment)
9. [API Endpoints](#api-endpoints)
10. [Database Schema](#database-schema)
11. [Contract Addresses](#contract-addresses)
12. [End-to-End Flow](#end-to-end-flow)
13. [Claim Fix: devInspect Probe](#claim-fix-devinspect-probe)

---

## Architecture Overview

```
Telegram User
     │
     ▼
Telegram Bot API (webhook)
     │
     ▼
Express.js server  ──────────────────────────────────────────┐
     │                                                        │
     ├─ runAgent() ──► Anthropic Claude (claude-sonnet-4-6)  │
     │                   │                                   │
     │                   ├─ tool: get_quote ─────────────► predict.js
     │                   ├─ tool: open_position ──────────► predict.js
     │                   ├─ tool: get_leaderboard ───────► db.js
     │                   ├─ tool: preview_ladder ────────► predict.js
     │                   ├─ tool: follow_trader ─────────► db.js
     │                   ├─ tool: get_arb_signal ────────► arb.js
     │                   ├─ tool: get_risk_panel ────────► predict.js + db.js
     │                   └─ tool: toggle_arb_alerts ─────► db.js
     │
     ├─ monitorPositions() ──► Sui fullnode RPC (every 60s)
     │      │
     │      └─ redeemPosition() ──► Sui testnet (on win)
     │
     ├─ broadcastArbSignal() ──► Polymarket API (every 60s)
     │
     └─ Supabase (persistent KV store)
```

All wallets are **custodial** — SAGE generates an Ed25519 keypair per user and stores the secret key encrypted in Supabase. Users never manage private keys.

---

## Protocol: DeepBook Predict

DeepBook Predict is an on-chain binary options protocol on Sui. A binary option pays out a fixed face value if BTC/USD settles above (UP) or below (DOWN) a chosen strike at expiry. The premium (cost) is a fraction of the face value, determined by the SVI oracle at mint time.

### Key Contract Calls

#### 1. `predict::mint` — Open a position

```
predict::mint<DUSDC>(
  predict_obj: &mut Predict,
  manager:     &mut PredictManager<DUSDC>,
  oracle:      &Oracle,
  key:         MarketKey,          // (oracleId, expiryMs, strike, direction)
  face:        u64,                // payout amount in raw dUSDC (1e6 scale)
  clock:       &Clock,
)
```

The user deposits `premium` dUSDC into their `PredictManager`, then calls `mint` to record the position. The manager deducts the premium and records `face` units against the market key.

#### 2. `predict::redeem_permissionless` — Claim a won position

```
predict::redeem_permissionless<DUSDC>(
  predict_obj: &mut Predict,
  manager:     &mut PredictManager<DUSDC>,
  oracle:      &Oracle,
  key:         MarketKey,
  quantity:    u64,                // face value to redeem
  clock:       &Clock,
)
```

Called after oracle settlement. Internally calls `predict_manager::decrease_position` to burn the recorded position and credit dUSDC back to the manager. Permissionless — any caller can trigger it for any manager.

#### 3. `predict_manager::deposit` — Fund the manager

```
predict_manager::deposit<DUSDC>(
  manager: &mut PredictManager<DUSDC>,
  coin:    Coin<DUSDC>,
)
```

Deposits dUSDC into the user's manager before minting. SAGE bundles deposit + mint in a single PTB (Programmable Transaction Block).

### Transaction Flow (open position)

```
PTB {
  1. predict_manager::deposit(manager, split(wallet, premiumBig))
  2. market_key::down(oracleId, expiryMs, strikeBig)  → key
  3. predict::mint(predict, manager, oracle, key, faceBig, clock)
}
```

### Oracle Settlement

The oracle publishes a `settlement_price` after expiry. SAGE polls the indexer every 60 seconds:

```js
GET https://predict-server.testnet.mystenlabs.com/oracles/{oracleId}/state
→ { latest_price: { spot, timestamp_ms }, settlement_price, latest_svi: { a, b, rho, m, sigma } }
```

When `settlement_price > 0`, SAGE evaluates:
- **DOWN wins** if `settlement_price < strike`
- **UP wins** if `settlement_price > strike`

---

## Pricing Model: Stochastic Volatility Inspired (SVI)

DeepBook Predict prices binary options using the SVI parameterisation of the implied volatility smile.

### Total Variance

```
w(k) = a + b · (ρ(k − m) + √((k − m)² + σ²))
```

Where:
- `k = ln(K / S)` — log-moneyness (K = strike, S = spot)
- `a` — vertical translation of the smile
- `b` — slope/curvature scale
- `ρ` — correlation / skew (signed, stored separately as `rho_negative`)
- `m` — log-moneyness of the smile minimum (signed, stored separately as `m_negative`)
- `σ` — smoothing parameter

All parameters are stored in integer fixed-point on-chain:
- `a`, `b`, `sigma` → divide by `1e8`
- `rho`, `m` → divide by `1e9`, apply sign from `rho_negative` / `m_negative`

### Binary Option Price

For a cash-or-nothing binary option, the risk-neutral probability is the digital delta:

```
d₂ = (−k − ½w) / √w

P(UP)   = N(d₂)
P(DOWN) = N(−d₂)
```

Where `N(·)` is the standard normal CDF (Abramowitz & Stegun approximation, error < 1.5×10⁻⁷).

### Ask Bounds

The contract enforces ask price bounds per oracle via `predict::ask_bounds`. SAGE fetches these via `devInspect` and filters strikes whose unit price falls outside `[minAsk, maxAsk]` before presenting them to users.

### Strike Selection

SAGE generates 8 candidate strikes using percentage offsets from spot:

```js
const offsets = [0.0005, 0.001, 0.002, 0.0035, 0.005, 0.0075, 0.011, 0.016];
// e.g. DOWN strikes: spot × (1 − offset), snapped to tick grid
```

Each candidate is priced via `get_trade_amounts` (devInspect). Valid strikes are sorted by unit price (safest first) and the 3 spread picks become **Safe Hedge / Balanced / Moon Shot**.

---

## Feature Set

### 1. Pure Natural Language Interface
No slash commands. Claude interprets free-form intent and routes to the appropriate tool. Works in DMs and group chats (group mode requires `@sagepredict_bot` mention).

### 2. Custodial Wallet per User
On first interaction, SAGE generates an Ed25519 keypair:
```js
const keypair = new Ed25519Keypair();
saveUser(telegramId, { secretKey: keypair.getSecretKey(), address: keypair.toSuiAddress() });
```
New users automatically receive 5 dUSDC from the app wallet for onboarding.

### 3. Group Chat Support
SAGE filters group messages to only respond when `@sagepredict_bot` is mentioned. DM `chatId` is preserved separately so settlement notifications reach users privately even if they first interacted in a group.

### 4. Leaderboard with Win Streaks
Ranks all users by net P&L (`totalOut − totalIn`). Each user's win streak (consecutive winning days) is computed from the streaks table. Milestone notifications fire at 3, 5, 7, 10, 14, 21, 30-day streaks.

### 5. Share Win to Group
On every win notification, a native Telegram share button is appended:
```
https://t.me/share/url?url=https%3A%2F%2Ft.me%2Fsagepredict_bot&text=...
```
Opens the native Telegram share sheet — no external redirect.

### 6. Arb Signal vs Polymarket
Every 60 seconds, SAGE compares:
- **Polymarket BTC 15M market** implied UP probability (from `outcomePrices[0]` in the CLOB API, slug `btc-updown-15m-{unix_seconds}`)
- **DeepBook implied probability** (`premium / face` from the balanced strike quote)

If divergence ≥ 12 percentage points **and** the window is < 3 minutes old, an arb signal is broadcast to all users who have opted in. Signal is deduplicated by slug to prevent repeats.

### 7. Vol Smile Chart (Mini-App)
A Telegram Web App at `/app` renders:
- **Price tab**: Live BTC/USD chart via MEXC (server-proxied, 15m/30m/60m candles selectable by tapping the odds pill). Odds strip shows DeepBook implied probability per expiry with live countdown. Open position strike lines overlaid.
- **Vol Smile tab**: Canvas 2D chart of implied volatility vs strike for up to 6 expiries, computed client-side from SVI parameters. SAGE SAYS natural language interpretation.
- **Risk tab**: Oracle health, open interest, platform win rate, settlement history. SAGE SAYS read.

### 8. Vault Strategy Runner (Ladder)
Splits a total budget evenly across 3 rungs (Safe Hedge / Balanced / Moon Shot) at a single expiry. Each rung is opened as an independent on-chain transaction. A single confirm button fires all 3 sequentially; partial fills are reported if any rung fails.

### 9. Copy Trading
Users can follow any other trader by leaderboard rank or name. When the followed trader confirms a trade, `triggerCopyTrades()` fans out immediately — fetching a fresh quote at the same direction/expiry, opening the follower's position at their configured per-trade amount, and notifying them via DM.

### 10. PLP Risk Panel
Live dashboard (bot chat + mini-app **Risk** tab) showing:
- **Oracle Health**: live oracle count, BTC spot, price feed age
- **Open Interest**: active positions count, total face at risk, total premium staked
- **Platform Stats**: all-time volume, settled trade count, platform-wide win rate
- **Settlement History**: last 20 settlements across all users

### Auto-Predict
Scheduled trading bot: user configures direction, amount, and interval. SAGE automatically opens a new position each time the current one expires.

### Arb Auto-Trade
When enabled, SAGE monitors Polymarket vs DeepBook pricing at each window open. If divergence ≥ 12pp is detected in the first 3–5 minutes of a window, SAGE automatically places the DeepBook leg. Configurable: timeframe (15m or 60m), amount per trade, max trades per day, respects daily budget.

### Voice Commands
Send a Telegram voice note — SAGE transcribes via Groq Whisper (`whisper-large-v3`, OGG Opus) and responds with a voice note back (Groq PlayAI TTS, `Celeste-PlayAI` voice, WAV format).

### Trade Context (Vol + Risk in Preview)
Every trade preview includes a 🔮 SAGE line with live market context: ATM vol level, smile skew direction, oracle health, and price feed age — pulled from DeepBook SVI state for the selected expiry.

### Contrarian Warning
If the implied probability from `premium/face` shows the user is betting against market consensus (e.g. DOWN when DeepBook prices 75% UP), the trade preview shows a ⚠️ Against the market warning.

### Daily Budget Guard
Optional spending cap. `recordSpend()` tracks premium outflow per user per calendar day. Trades that would exceed the cap are blocked before reaching the chain.

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Runtime | Node.js 22 (ESM) |
| Web framework | Express 4 |
| Telegram API | Raw Bot API (webhook mode) |
| AI agent | Anthropic Claude claude-sonnet-4-6 via `@anthropic-ai/sdk` |
| Blockchain | Sui testnet via `@mysten/sui` 2.17.0 |
| Persistence | Supabase (PostgreSQL KV via REST API) |
| Charts | lightweight-charts 4.2.0 (price), Canvas 2D (vol smile) |
| Deployment | Railway (single service, always-on) |
| Price feed | MEXC REST + WebSocket |
| Volatility data | DeepBook Predict indexer `/oracles/{id}/state` |
| Arb signal | Polymarket Gamma API `gamma-api.polymarket.com/events` |
| Voice STT | Groq Whisper `whisper-large-v3` |
| Voice TTS | Groq PlayAI `Celeste-PlayAI` |

---

## Repository Structure

```
hedg-agent/
├── server.js        # Express server, webhook handler, position monitor, mini-app HTML
├── agent.js         # Claude tool definitions, executeTool(), runAgent()
├── predict.js       # All Sui/DeepBook interactions (quote, open, redeem, inspect)
├── arb.js           # Polymarket fetch, arb signal detection, formatter
├── db.js            # Supabase KV store — all state (users, positions, streaks, …)
├── wallet.js        # Ed25519 keypair management per Telegram user
├── card.js          # Win/loss card image generation (Puppeteer + HTML template)
├── card.html        # Win card HTML template
├── card-loss.html   # Loss card HTML template
├── config.js        # Contract addresses, RPC endpoints, scale constants
└── .env             # Secrets (never committed)
```

---


## Deployment

### Railway (production)

```bash
railway login
railway link <project-id>
railway up --service hedg-agent --detach
```

The service auto-registers the Telegram webhook on boot:
```js
POST https://api.telegram.org/bot{TOKEN}/setWebhook
  { url: "https://{RAILWAY_PUBLIC_DOMAIN}/webhook" }
```

### Local Development

```bash
npm install
node server.js
# then expose with: npx localtunnel --port 8080
# and set webhook manually to the tunnel URL
```

---

## API Endpoints

All endpoints are unauthenticated (for mini-app use). The `/app` endpoint validates Telegram `initData` for the `chart-positions` sub-route.

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/webhook` | Telegram Bot API webhook receiver |
| `GET` | `/health` | Health check → `{ ok: true }` |
| `GET` | `/app` | Telegram Web App (price chart + vol smile + risk panel) |
| `GET` | `/api/price-history` | Last 120 BTC price points `{ t, p }[]` |
| `GET` | `/api/quote-strikes` | Cached balanced strikes for UP/DOWN `{ up, down }` |
| `GET` | `/api/chart-positions` | Open positions for authenticated mini-app user |
| `GET` | `/api/svi` | SVI parameters for up to 6 live expiries |
| `GET` | `/api/risk` | PLP risk panel data (oracle health, OI, settlements) |
| `GET` | `/api/odds` | DeepBook implied probabilities (from `premium/face`) for 15m/30m/60m expiries |
| `GET` | `/api/klines` | Server-proxied MEXC klines (avoids browser CORS) — `?interval=15m&limit=100` |

---

## Database Schema

SAGE uses a single Supabase table (`kv`) as a JSON document store. The entire state is one JSON object under key `"db"`, loaded into memory on boot and persisted on every write.

```typescript
interface DB {
  users: {
    [telegramId: string]: {
      firstName:  string;
      secretKey:  string;        // Ed25519 private key (bech32)
      address:    string;        // Sui address
      managerId:  string | null; // PredictManager object ID
      chatId:     number;        // primary chat for notifications
      dmChatId:   number | null; // DM chat (preserved when in groups)
      arbAlerts:  boolean;
    }
  };

  positions: {
    [telegramId: string]: Array<{
      id:           number;      // Date.now() at save time
      oracleId:     string;
      expiryMs:     number;
      strike:       number;      // USD, 2 decimal places
      direction:    'up' | 'down';
      quantity:     number;      // face value (payout) in dUSDC
      premium:      number;      // cost in dUSDC
      managerId:    string;
      digest:       string;      // Sui tx digest
      chatId:       number | string;
      status:       'open' | 'won' | 'lost' | 'claimed';
      won:          boolean;
      settlementPrice?: number;
      claimDigest?: string;
      claimedAmount?: number;    // actual redeemed (after devInspect probe)
    }>
  };

  streaks: {
    [telegramId: string]: { count: number; lastDate: string }
  };

  pendingTrades: {
    [telegramId: string]: {
      oracleId: string; expiryMs: number; strike: number;
      direction: string; face: number; premium: number;
      queuedAt: number;          // expires after 5 min
    }
  };

  pendingLadders: {
    [telegramId: string]: {
      rungs: Array<{ oracleId, expiryMs, strike, direction, face, premium, label }>;
      chatId: number;
      queuedAt: number;
    }
  };

  copyTrading: {
    [followerId: string]: {
      followedId: string;
      name:       string;
      amount:     number;        // dUSDC per copied trade
      chatId:     number | string;
      since:      number;
    }
  };

  budgets:     { [telegramId: string]: { dailyLimit, spentToday, resetDate } };
  alerts:      { [telegramId: string]: Array<{ id, price, direction }> };
  autoPredict: { [telegramId: string]: { direction, amount, duration, active } };
  arbAuto:     { [telegramId: string]: { amount, duration, maxTradesPerDay, tradesToday, lastTradeDate, active, chatId } };
  history:     { [telegramId: string]: AnthropicMessage[] };  // last 20 turns
  wizardState: { [telegramId: string]: { step, direction?, duration?, updatedAt } };
}
```

---

## Contract Addresses

| Name | Address |
|------|---------|
| Predict package | `0xf5ea2b3749c65d6e56507cc35388719aadb28f9cab873696a2f8687f5c785138` |
| Predict shared object | `0xc8736204d12f0a7277c86388a68bf8a194b0a14c5538ad13f22cbd8e2a38028a` |
| dUSDC coin type | `0xe95040085976bfd54a1a07225cd46c8a2b4e8e2b6732f140a0fc49850ba73e1a::dusdc::DUSDC` |
| Sui Clock | `0x6` |
| Network | Sui testnet (`https://fullnode.testnet.sui.io`) |
| Indexer | `https://predict-server.testnet.mystenlabs.com` |

---

## End-to-End Flow

### User opens a trade

```
1. User: "bet $5 BTC drops in 15 min"
2. runAgent() → Claude calls get_quote(15, 5, 'down')
3. predict.js fetches live oracles → finds nearest expiry
4. For each candidate strike, devInspect get_trade_amounts → unit price
5. Filters by ask bounds, selects 3 levels
6. Claude returns _pendingTrade with preview text
7. server.js sends trade card + [Confirm] [Cancel] buttons
8. User taps Confirm
9. server.js calls openPosition():
   a. askBounds(oracleId)               → devInspect
   b. contractTradeAmounts(...)          → devInspect (re-price)
   c. Build PTB: deposit + market_key + mint
   d. sui_executeTransactionBlock
10. Position saved to Supabase
11. triggerCopyTrades() fans out to followers (async)
```

### Position settles

```
1. monitorPositions() runs every 60s
2. For each open position past expiryMs:
   a. GET /oracles/{oracleId}/state
   b. Parse settlement_price (state.oracle.settlement_price)
   c. Evaluate won = direction === 'down' ? price < strike : price > strike
   d. updatePosition(status: 'won' | 'lost')
3. On win:
   a. redeemPosition() → devInspect probe → real tx
   b. updatePosition(status: 'claimed', claimDigest, claimedAmount)
   c. sendCard(win) with share button + streak line
4. On loss: sendCard(loss)
```

---

## Claim Fix: devInspect Probe

**Problem:** `decrease_position abort 1` on redemption.

**Root cause:** `face` was stored as `+face.toFixed(4)`. When the 5th decimal rounds **up**, the stored value exceeds the on-chain face by 1–2000 raw dUSDC units (1 unit = 1e-6 dUSDC). `decrease_position` aborts because the requested quantity exceeds what's recorded in the manager.

**Fix:** Before submitting the real redemption transaction, SAGE runs a binary search via `sui_devInspectTransactionBlock`, starting from the stored quantity and decrementing by 1 unit per iteration (max 2000 iterations = $0.002 tolerance). The first quantity that passes inspection is used for the real transaction.

```js
for (let delta = 0n; delta <= 2000n; delta++) {
  const tryQty = baseQty - delta;
  const kind   = await buildRedeemKind(..., tryQty);
  const probe  = await rpc('sui_devInspectTransactionBlock', [DEV_SENDER, kind, null, null]);
  if (probe.effects?.status?.status === 'success') {
    quantityBig = tryQty;
    break;
  }
  // only retry for decrease_position overflow — all other errors are fatal
  if (!probe.effects?.status?.error?.includes('decrease_position')) break;
}
```

If no quantity passes (oracle not yet finalized on-chain), SAGE returns `"Oracle not yet finalized on-chain. Try again in a minute."` rather than silently marking the position as claimed.

---

## Live Bot

**[@sagepredict_bot](https://t.me/sagepredict_bot)** on Telegram (Sui testnet)

Example interactions:
- `"Bet $5 BTC drops in the next 15 minutes"`
- `"Run a ladder $15 up 30 minutes"`
- `"Show me the leaderboard"`
- `"Is there an arb signal right now?"`
- `"Copy rank 1 with $3 per trade"`
- `"Show the risk panel"`
- `"Turn on arb alerts"`
- `"Enable arb auto-trade, 1hr timeframe, max 3 trades today, $2 per trade"`
- `"What's the vol smile saying right now?"`
