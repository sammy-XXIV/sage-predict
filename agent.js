import Anthropic from '@anthropic-ai/sdk';
import { getBtcPrice, getQuote, getBalance, openPosition, redeemPosition, getOraclesList, getOracleState } from './predict.js';
import { getOrCreateWallet, getKeypair, getAddress, getManagerId, setManagerId } from './wallet.js';
import {
  getPositions, savePosition, updatePosition, getHistory, saveHistory, clearHistory, getUser, getAllUsers,
  getAllUsersPositions, saveAlert, getAlerts, removeAlert,
  getBudget, setBudget, recordSpend, getStreak, updateStreak,
  setWalletWatcher, getWalletWatcher, clearWalletWatcher,
  getAutoPredict, setAutoPredict, clearAutoPredict,
  clearWizardState, getArbAlerts, setArbAlerts,
  setPendingLadder, setCopyTrading, getCopyTrading, clearCopyTrading,
} from './db.js';
import { getPolymarketBtc15m, checkArbSignal, formatSignal } from './arb.js';

export async function getTradeContext(duration) {
  try {
    const { PREDICT_OBJECT, PREDICT_SERVER } = await import('./config.js');
    const oracles = await fetch(`${PREDICT_SERVER}/predicts/${PREDICT_OBJECT}/oracles`).then(r => r.json());
    const now = Date.now();
    const sorted = oracles
      .filter(o => o.status === 'active' && Number(o.expiry) > now && !o.settlement_price)
      .sort((a, b) => Number(a.expiry) - Number(b.expiry));
    const idx    = [15, 30, 60].indexOf(duration);
    const oracle = idx >= 0 ? sorted[idx] : sorted[0];
    if (!oracle) return null;

    const state = await fetch(`${PREDICT_SERVER}/oracles/${oracle.oracle_id}/state`).then(r => r.json());
    const lines = [];

    // Vol insight from SVI
    if (state?.latest_svi) {
      const svi = state.latest_svi;
      const a = svi.a / 1e8, b = svi.b / 1e8;
      const rho = (svi.rho_negative ? -1 : 1) * svi.rho / 1e9;
      const sig = svi.sigma / 1e8;
      const atmVol = Math.sqrt(Math.max(0, a + b * (Math.sqrt(rho * rho + sig * sig)))) * 100;
      const skew   = rho;
      if (atmVol > 80) lines.push(`Vol is elevated at ${atmVol.toFixed(0)}% annualised — options are expensive right now.`);
      else if (atmVol < 30) lines.push(`Vol is low at ${atmVol.toFixed(0)}% — cheap to buy options, market expects calm.`);
      else lines.push(`ATM vol at ${atmVol.toFixed(0)}% — normal conditions.`);
      if (skew < -0.2) lines.push('Smile skewed DOWN — market pricing more risk to the downside.');
      else if (skew > 0.2) lines.push('Smile skewed UP — market pricing more risk to the upside.');
    }

    // Oracle health
    if (state?.latest_price) {
      const liveCount = sorted.filter(o => !o.settlement_price).length;
      let ts = Number(state.latest_price.timestamp_ms || state.latest_price.timestamp || 0);
      if (ts > 0 && ts < 1e12) ts *= 1000;
      const ageS = ts > 0 ? Math.round((now - ts) / 1000) : null;
      if (liveCount < 3) lines.push(`Only ${liveCount} live oracle${liveCount !== 1 ? 's' : ''} — settlement price may be less precise.`);
      if (ageS !== null && ageS > 30) lines.push(`Oracle price is ${ageS}s old — strike may shift before you confirm.`);
    }

    return lines.length ? lines.join(' ') : null;
  } catch { return null; }
}

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const EXPLORER = 'https://suiscan.xyz/testnet/tx';

const SYSTEM_PROMPT = `You are SAGE, an AI agent for BTC prediction markets on Sui blockchain. You help users predict BTC price movements and earn dUSDC.

You run inside Telegram. Users chat with you naturally. You understand what they want and execute it.

WHAT YOU CAN DO:
- Tell users the current BTC price
- Show prediction quotes (UP or DOWN, timeframes: 15min, 30min, 60min)
- Open positions on their behalf (you manage their custodial wallet)
- Show open positions and PnL summary
- Show dUSDC balance
- Claim winnings from settled positions
- Show trading portfolio with on-chain proof links
- Show leaderboard of top traders
- Generate a shareable win card when user wins
- Set BTC price alerts ("tell me when BTC hits $110k")
- Set a daily spending budget
- Set auto-predict (repeat a trade automatically every expiry)
- Stop auto-predict
- Show daily streak
- Export private key for self-custody
- Show live arb signal: compare Polymarket BTC 15M implied probability vs DeepBook pricing
- Toggle arb alert notifications on/off
- Run a ladder strategy: spread a total budget across Safe/Balanced/Moon Shot strikes in one go (use preview_ladder)
- Copy-trade SAGE users: follow another trader by leaderboard rank/name so their trades auto-mirror for you (use get_leaderboard first, then follow_trader)
- Copy-trade ANY external Sui wallet: paste any wallet address and use watch_wallet — SAGE polls DeepBook on-chain for new positions from that address and mirrors them automatically
- Stop copy-trading SAGE user: stop_copying. Stop watching external wallet: unwatch_wallet
- Show PLP risk panel: oracle health, open interest, vault utilization, settlement history (use get_risk_panel). After showing the data, ALWAYS follow up with a short natural language read — e.g. what the oracle health means, whether open interest looks high or low, what the win rate signals about market conditions
- Show arb signal: after calling get_arb_signal, ALWAYS explain the result in plain English — what the gap means, which direction has edge, whether it's worth acting on and why
- Enable arb auto-trade: use enable_arb_auto — user sets amount, timeframe (15 or 60 min), and optional max trades per day. SAGE auto-places the DeepBook leg whenever a ≥12pp gap fires at window open
- Disable arb auto-trade: use disable_arb_auto

HOW PREDICTIONS WORK:
- Users pick direction (UP or DOWN) and timeframe (15, 30, or 60 minutes)
- It costs a small amount upfront to win a larger payout
- Example: costs $4 → win $100 if BTC drops below $104k in 15 minutes
- Settlement is automatic — you watch positions and claim winnings

PERSONALITY:
- Sharp, confident, a little edgy — like a trading desk analyst who also texts like a human
- Keep messages short and punchy. No walls of text.
- Use numbers. Be specific.
- When a position wins, make it feel electric
- When it loses, keep it real and move on fast

IMPORTANT RULES:
- You have a built-in live BTC chart — NEVER tell users to go to TradingView, Binance, Coinbase, or any external site. If they ask for a chart, tell them to tap the mini-app button to open it.
- Any time the user expresses intent to trade (e.g. "I want to trade", "let's trade", "yes", "let's go", "place a trade", "trade now") AND they have not specified both direction AND duration in the same message: ALWAYS call start_trade_wizard. Do not write any text before or after. Do not assume a previous wizard is still visible. Do not reference old buttons or cards. A new wizard is always sent fresh.
- If user has specified direction AND duration (amount defaults to 100 if not given), call preview_trade directly — it fetches the quote and sends confirm/cancel buttons automatically
- If anything goes wrong mid-trade (quote expired, price moved, confirm failed, object not found, any error), NEVER tell the user to "use the card above" or reference old messages — call start_trade_wizard immediately to issue a fresh one
- NEVER show quote data, strike prices, costs, or payouts in your text — preview_trade handles all of that
- NEVER ask the user to "type yes" or "confirm" in text — the buttons handle confirmation
- After calling preview_trade, say nothing or at most "tap confirm when ready"
- Never use the word "premium" — say "it costs $X" or "you're putting in $X"
- There is NO minimum trade amount — $1 is valid. Never invent minimums or tell users they need to trade more than they asked.
- Never suggest slash commands or give menus — you understand natural language
- Never say things like "just say X or Y to do Z" — just respond naturally
- New users get 5 dUSDC automatically
- Format prices as $104,532 not 104532
- ALWAYS call get_balance when the user asks about their balance — never report a balance from memory or conversation history, it changes on-chain
- Always include Sui explorer link after opening a position: ${EXPLORER}/{digest}
- Budget check: before calling preview_trade, check if user has a daily budget set and if they've exceeded it
- After get_arb_signal: ALWAYS explain the result in 2-3 sentences — what the Polymarket vs DeepBook gap means, which side has the edge, and whether it's actionable right now
- After get_risk_panel: ALWAYS give a 2-3 sentence read on what the numbers mean — is oracle health good? is open interest unusually high? what does the platform win rate tell us?
- After get_positions: NEVER show a table or raw JSON. Format each position as a single punchy line: "📈 UP $63,000 · expires 02:30 UTC · $2 in · $7 to win" or "⏰ expired" if past expiry. List them cleanly, one per line.

LEADERBOARD FORMAT (use this exact style when displaying get_leaderboard results):
🏆 *Top Traders*

🥇 Name — +$X.XX · 5W/6T · 83%
🥈 Name — +$X.XX · 3W/4T · 75%
🥉 Name — +$X.XX · 2W/3T · 66%
4\. Name — -$X.XX · ...
...

Show streak with 🔥 if streak > 0 (e.g. "🔥3"). Bold the row with isMe=true and add "(you)". If me exists (user is outside top 10), append their rank below a separator line. If top10 is empty, say "No settled trades yet — be the first!"`;

const tools = [
  {
    name: 'get_market_info',
    description: 'Get current BTC price',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'start_trade_wizard',
    description: 'Launch a step-by-step trade builder with button pickers for duration, direction, and size. Use when user wants to trade but hasn\'t specified all details.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'preview_trade',
    description: 'Fetch a live quote and show a risk breakdown with Confirm/Cancel buttons. Use this when user has specified direction, duration, and amount. This is the ONLY way to initiate a trade.',
    input_schema: {
      type: 'object',
      properties: {
        direction: { type: 'string', enum: ['up', 'down'] },
        duration:  { type: 'number', enum: [15, 30, 60], description: 'Duration in minutes' },
        amount:    { type: 'number', description: 'Payout face value in dUSDC (default 100, minimum 1)' },
      },
      required: ['direction', 'duration'],
    },
  },
  {
    name: 'get_positions',
    description: "Get user's open positions",
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'get_portfolio',
    description: "Get user's full trade history with on-chain explorer links",
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'get_pnl_summary',
    description: "Get user's win rate, net profit/loss, trade count, and streak",
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'get_balance',
    description: "Get user's dUSDC balance",
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'claim_winnings',
    description: 'Claim winnings from a settled winning position',
    input_schema: {
      type: 'object',
      properties: {
        positionId: { type: 'number' },
      },
      required: ['positionId'],
    },
  },
  {
    name: 'get_leaderboard',
    description: 'Get top traders leaderboard by net profit',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'share_win',
    description: 'Generate a shareable win card for a recent winning position',
    input_schema: {
      type: 'object',
      properties: {
        positionId: { type: 'number' },
      },
      required: ['positionId'],
    },
  },
  {
    name: 'set_price_alert',
    description: "Set a BTC price alert. Triggers when BTC crosses the target price.",
    input_schema: {
      type: 'object',
      properties: {
        price:     { type: 'number', description: 'Target BTC price in USD' },
        direction: { type: 'string', enum: ['above', 'below'], description: 'Trigger when price goes above or below target' },
      },
      required: ['price', 'direction'],
    },
  },
  {
    name: 'get_alerts',
    description: "Get user's active price alerts",
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'remove_alert',
    description: "Remove a price alert",
    input_schema: {
      type: 'object',
      properties: {
        alertId: { type: 'number' },
      },
      required: ['alertId'],
    },
  },
  {
    name: 'set_daily_budget',
    description: "Set a daily spending limit in dUSDC",
    input_schema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Max dUSDC to spend per day' },
      },
      required: ['limit'],
    },
  },
  {
    name: 'set_auto_predict',
    description: "Set up automatic recurring predictions. Bot will open a new position every expiry automatically.",
    input_schema: {
      type: 'object',
      properties: {
        direction: { type: 'string', enum: ['up', 'down'] },
        duration:  { type: 'number', enum: [15, 30, 60] },
        amount:    { type: 'number', description: 'Face value per trade in dUSDC' },
      },
      required: ['direction', 'duration', 'amount'],
    },
  },
  {
    name: 'stop_auto_predict',
    description: "Stop automatic recurring predictions",
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'export_private_key',
    description: "Export user's private key for self-custody. Only call when user explicitly asks.",
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'get_arb_signal',
    description: 'Fetch live Polymarket BTC 15M market and compare implied probability against DeepBook Predict pricing to surface any edge signal.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'enable_arb_auto',
    description: 'Enable arb auto-trade: SAGE will automatically place a DeepBook trade whenever a Polymarket vs DeepBook gap ≥12pp is detected at window open.',
    input_schema: {
      type: 'object',
      properties: {
        amount:          { type: 'number', description: 'dUSDC to stake per arb trade' },
        duration:        { type: 'number', enum: [15, 60], description: 'Which timeframe to watch — 15 or 60 minutes. Defaults to 15.' },
        maxTradesPerDay: { type: 'number', description: 'Max number of arb trades to place per day. Defaults to unlimited.' },
      },
      required: ['amount'],
    },
  },
  {
    name: 'disable_arb_auto',
    description: 'Disable arb auto-trade for this user.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'toggle_arb_alerts',
    description: 'Turn arb signal alerts on or off for this user.',
    input_schema: {
      type: 'object',
      properties: { enabled: { type: 'boolean', description: 'true to enable, false to disable' } },
      required: ['enabled'],
    },
  },
  {
    name: 'get_risk_panel',
    description: 'Show the PLP risk panel: oracle health, open interest, vault utilization, and recent settlement history across all users.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'follow_trader',
    description: "Follow another trader to copy their trades automatically. Look up the trader by name from getAllUsersPositions data or leaderboard. Use get_leaderboard first if user says 'copy rank 1' etc.",
    input_schema: {
      type: 'object',
      properties: {
        followedId: { type: 'string', description: 'Telegram ID of the trader to follow' },
        name:       { type: 'string', description: 'Display name of the trader (for confirmation message)' },
        amount:     { type: 'number', description: 'dUSDC amount to risk per copied trade (default 5)' },
      },
      required: ['followedId', 'name'],
    },
  },
  {
    name: 'stop_copying',
    description: 'Stop copy-trading (unfollow current leader)',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'get_copy_status',
    description: "Show who this user is currently copying and their copy config",
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'watch_wallet',
    description: 'Copy-trade any external Sui wallet address. Every time that address opens a position on DeepBook, SAGE automatically mirrors it for the user at their configured amount.',
    input_schema: {
      type: 'object',
      properties: {
        walletAddress: { type: 'string', description: 'The Sui wallet address to watch (0x...)' },
        amount:        { type: 'number', description: 'dUSDC amount to stake per mirrored trade' },
      },
      required: ['walletAddress', 'amount'],
    },
  },
  {
    name: 'unwatch_wallet',
    description: 'Stop copy-trading a watched external wallet address.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'withdraw_funds',
    description: 'Withdraw dUSDC from the user\'s wallet to another Sui address. Shows a preview with confirm/cancel buttons.',
    input_schema: {
      type: 'object',
      properties: {
        toAddress: { type: 'string', description: 'Destination Sui address (0x...)' },
        amount:    { type: 'number', description: 'Amount of dUSDC to withdraw' },
      },
      required: ['toAddress', 'amount'],
    },
  },
  {
    name: 'preview_ladder',
    description: 'Preview a ladder strategy — splits a total budget evenly across Safe/Balanced/Moon Shot strikes for one expiry. Shows all 3 rungs with a single Confirm button.',
    input_schema: {
      type: 'object',
      properties: {
        direction:   { type: 'string', enum: ['up', 'down'] },
        duration:    { type: 'number', enum: [15, 30, 60] },
        totalBudget: { type: 'number', description: 'Total dUSDC to spread across 3 rungs (min $3)' },
      },
      required: ['direction', 'duration', 'totalBudget'],
    },
  },
];

async function executeTool(name, input, telegramId, chatId) {
  const address = getAddress(telegramId);

  switch (name) {
    case 'get_market_info': {
      const price = await getBtcPrice();
      return { price, formatted: price ? `$${price.toLocaleString('en-US', { maximumFractionDigits: 0 })}` : 'unavailable' };
    }

    case 'get_quote': {
      const { direction, duration, amount = 100 } = input;
      return await getQuote(duration, amount, direction);
    }

    case 'start_trade_wizard': {
      clearWizardState(telegramId);
      return { _startWizard: true };
    }

    case 'preview_trade': {
      const { direction, duration, amount = 100 } = input;

      // Fetch live quote internally
      const quote = await getQuote(duration, amount, direction);
      const lvl   = quote.levels[1] || quote.levels[0];
      const { oracleId, expiryMs } = quote;
      const { strike, premium, face } = lvl; // premium=stake, face=payout

      // Budget check
      const budget = getBudget(telegramId);
      if (budget) {
        const today = new Date().toDateString();
        const spent = budget.resetDate === today ? budget.spentToday : 0;
        if (spent + premium > budget.dailyLimit) {
          return { error: `Daily budget exceeded. You've spent $${spent.toFixed(2)} of your $${budget.dailyLimit} limit today.` };
        }
      }

      const currentPrice = await getBtcPrice().catch(() => null);
      const strikeFmt    = `$${strike.toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
      const priceFmt     = currentPrice ? `$${currentPrice.toLocaleString('en-US', { maximumFractionDigits: 0 })}` : 'unknown';
      const multiplier   = (face / premium).toFixed(1);
      const expireAt     = new Date(expiryMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', timeZone: 'UTC', hour12: false });
      const dirWord      = direction === 'down' ? 'DROP BELOW' : 'RISE ABOVE';
      const moveWord     = direction === 'down' ? 'fall' : 'rise';
      const delta        = currentPrice ? Math.abs(currentPrice - strike) : null;
      const deltaTxt     = delta ? ` — needs to ${moveWord} $${delta.toLocaleString('en-US', { maximumFractionDigits: 0 })} from here` : '';

      // premium/face from DeepBook always = P(UP) regardless of direction quoted
      const pUp          = premium / face;
      const marketFavors = pUp >= 0.5 ? 'up' : 'down';
      const contrarian   = marketFavors !== direction;
      const consensusPct = Math.round((pUp >= 0.5 ? pUp : 1 - pUp) * 100);
      const contrarianWarn = contrarian
        ? `\n⚠️ *Against the market* — DeepBook is pricing ${consensusPct}% ${marketFavors.toUpperCase()}. You are taking the other side.\n`
        : '';

      const tradeCtx = await getTradeContext(duration);
      const sageCtxLine = tradeCtx ? `\n🔮 *SAGE* — ${tradeCtx}\n` : '';

      const previewText =
        `🎯 *Trade Preview · BTC/USD ${direction.toUpperCase()} · ${duration} min*\n\n` +
        `Current price: *${priceFmt}*\n` +
        `Strike: *${strikeFmt}*${deltaTxt}\n` +
        `Expires: *${expireAt} UTC*\n\n` +
        `💵 You put in: *$${premium.toFixed(2)}*\n` +
        `💰 You win: *$${face.toFixed(2)}* (${multiplier}x)\n\n` +
        `━━━━━━━━━━━━━━━━\n` +
        contrarianWarn +
        sageCtxLine +
        `⚠️ *Risk*\n` +
        `• Binary outcome — win *$${face.toFixed(2)}* or lose *$${premium.toFixed(2)}*\n` +
        `• BTC must *${dirWord} ${strikeFmt}* by ${expireAt} UTC\n` +
        `• If it hasn't moved enough at expiry, you lose 100%\n` +
        `• No early exit · No partial payouts · Oracle-settled\n` +
        `━━━━━━━━━━━━━━━━`;

      return {
        _pendingTrade: true,
        tradeParams:  { oracleId, expiryMs, strike, direction, face, premium },
        previewText,
      };
    }

    case 'get_positions': {
      const positions = getPositions(telegramId);
      const now = Date.now();
      return positions
        .filter(p => p.status === 'open')
        .map(p => ({
          id:        p.id,
          direction: p.direction.toUpperCase(),
          strike:    `$${p.strike.toLocaleString('en-US', { maximumFractionDigits: 0 })}`,
          face:      p.quantity,
          cost:      p.premium,
          expiresAt: new Date(p.expiryMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
          expired:   p.expiryMs < now,
        }));
    }

    case 'get_portfolio': {
      const positions = getPositions(telegramId);
      return positions.slice(-20).reverse().map(p => ({
        id:        p.id,
        direction: p.direction.toUpperCase(),
        strike:    `$${p.strike.toLocaleString('en-US', { maximumFractionDigits: 0 })}`,
        cost:      p.premium,
        payout:    p.quantity,
        status:    p.status,
        date:      new Date(p.createdAt).toLocaleDateString(),
        explorer:  p.digest ? `${EXPLORER}/${p.digest}` : null,
      }));
    }

    case 'get_pnl_summary': {
      const positions = getPositions(telegramId);
      const settled   = positions.filter(p => ['won', 'lost', 'claimed'].includes(p.status));
      const wins      = settled.filter(p => p.won);
      const totalIn   = settled.reduce((s, p) => s + p.premium, 0);
      const totalOut  = wins.reduce((s, p) => s + p.quantity, 0);
      const net       = totalOut - totalIn;
      const winRate   = settled.length ? Math.round((wins.length / settled.length) * 100) : 0;
      const streak    = getStreak(telegramId);
      const open      = positions.filter(p => p.status === 'open').length;
      return {
        trades: settled.length, wins: wins.length,
        losses: settled.length - wins.length,
        winRate, totalIn: +totalIn.toFixed(2),
        totalOut: +totalOut.toFixed(2),
        net: +net.toFixed(2), open,
        streak: streak.count,
      };
    }

    case 'get_balance': {
      if (!address) return { balance: 0 };
      const balance = await getBalance(address);
      return { balance };
    }

    case 'claim_winnings': {
      const { positionId } = input;
      const positions = getPositions(telegramId);
      const pos = positions.find(p => p.id === positionId);
      if (!pos) throw new Error('Position not found');
      if (!pos.won) throw new Error('Position did not win');
      if (pos.status === 'claimed') throw new Error('Already claimed');
      const keypair = getKeypair(telegramId);
      const managerId = pos.managerId || getManagerId(telegramId);
      const result  = await redeemPosition(keypair, address, managerId, pos.oracleId, pos.expiryMs, pos.strike, pos.direction, pos.quantity);
      const claimedAmount = result.quantityBig ? Number(result.quantityBig) / 1e6 : pos.quantity;
      updatePosition(telegramId, pos.id, { status: 'claimed', claimDigest: result.digest, claimedAmount });
      return { success: true, digest: result.digest, explorerLink: `${EXPLORER}/${result.digest}`, amount: claimedAmount };
    }

    case 'get_leaderboard': {
      const allPositions = getAllUsersPositions();
      const stats = [];
      for (const [tid, positions] of Object.entries(allPositions)) {
        const settled  = positions.filter(p => ['won', 'lost', 'claimed'].includes(p.status));
        if (!settled.length) continue;
        const wins     = settled.filter(p => p.won || p.status === 'claimed');
        const totalIn  = settled.reduce((s, p) => s + (p.premium || 0), 0);
        const totalOut = wins.reduce((s, p) => s + (p.quantity || 0), 0);
        const net      = totalOut - totalIn;
        const user     = getUser(tid);
        const streak   = getStreak(tid);
        stats.push({
          telegramId: tid,
          name:    user?.firstName || `Trader ${tid.slice(-4)}`,
          trades:  settled.length,
          wins:    wins.length,
          winRate: Math.round((wins.length / settled.length) * 100),
          net:     +net.toFixed(2),
          streak:  streak.count || 0,
          isMe:    tid === String(telegramId),
        });
      }
      const sorted = stats.sort((a, b) => b.net - a.net);
      const top10  = sorted.slice(0, 10).map((s, i) => ({ rank: i + 1, ...s }));
      const myRank = sorted.findIndex(s => s.isMe);
      const me     = myRank >= 10 ? { rank: myRank + 1, ...sorted[myRank] } : null;
      return { top10, me };
    }

    case 'share_win': {
      const { positionId } = input;
      const positions = getPositions(telegramId);
      const wonPositions = positions.filter(p => p.won || p.status === 'claimed');
      const pos = positionId
        ? wonPositions.find(p => p.id === positionId)
        : wonPositions[wonPositions.length - 1];
      if (!pos) return { error: 'No winning position found' };
      const multiple   = (pos.quantity / pos.premium).toFixed(1);
      const shareText  = encodeURIComponent(
        `I just won $${pos.quantity.toFixed(2)} on SAGE — BTC prediction markets on Sui.\n` +
        `$${pos.premium.toFixed(2)} in → $${pos.quantity.toFixed(2)} out (${multiple}x)\n\n` +
        `Trade on @sagepredict_bot`
      );
      const shareUrl   = `https://t.me/share/url?url=https%3A%2F%2Ft.me%2Fsagepredict_bot&text=${shareText}`;
      return {
        _sendCard: true,
        type: 'win',
        payout: pos.quantity,
        cost: pos.premium,
        label: `BTC/USD ${pos.direction === 'down' ? 'dropped below' : 'rose above'} $${pos.strike.toLocaleString('en-US', { maximumFractionDigits: 0 })}`,
        caption: `🎯 $${pos.premium.toFixed(2)} in → $${pos.quantity.toFixed(2)} out (${multiple}x)\n\n[Verified on-chain](${EXPLORER}/${pos.digest})\n\nTrade on SAGE`,
        extra: { reply_markup: { inline_keyboard: [[{ text: '📢 Share win', url: shareUrl }]] } },
      };
    }

    case 'set_price_alert': {
      const { price, direction } = input;
      saveAlert(telegramId, { price, direction, chatId });
      return { success: true, price, direction };
    }

    case 'get_alerts': {
      return getAlerts(telegramId);
    }

    case 'remove_alert': {
      removeAlert(telegramId, input.alertId);
      return { success: true };
    }

    case 'set_daily_budget': {
      setBudget(telegramId, input.limit);
      return { success: true, limit: input.limit };
    }

    case 'set_auto_predict': {
      const { direction, duration, amount } = input;
      setAutoPredict(telegramId, { direction, duration, amount, chatId, active: true, lastRun: null });
      return { success: true, direction, duration, amount };
    }

    case 'stop_auto_predict': {
      clearAutoPredict(telegramId);
      return { success: true };
    }

    case 'enable_arb_auto': {
      const { setArbAuto } = await import('./db.js');
      setArbAuto(telegramId, {
        amount: input.amount,
        duration: input.duration || 15,
        maxTradesPerDay: input.maxTradesPerDay || null,
        chatId, active: true,
        tradesToday: 0, lastTradeDate: null,
      });
      return { success: true, amount: input.amount, duration: input.duration || 15, maxTradesPerDay: input.maxTradesPerDay || null };
    }

    case 'disable_arb_auto': {
      const { clearArbAuto } = await import('./db.js');
      clearArbAuto(telegramId);
      return { success: true };
    }

    case 'export_private_key': {
      const user = getUser(telegramId);
      if (!user?.secretKey) throw new Error('No wallet found');
      return { secretKey: user.secretKey, address: user.address };
    }

    case 'get_arb_signal': {
      const poly = await getPolymarketBtc15m();
      if (!poly) return { error: 'Polymarket data unavailable right now.' };
      const signal = await checkArbSignal();
      return {
        polymarket: {
          upProb:    +(poly.upProb * 100).toFixed(1),
          downProb:  +(poly.downProb * 100).toFixed(1),
          liquidity: +poly.liquidity.toFixed(0),
          ageMinutes: +(poly.ageMs / 60000).toFixed(1),
          windowEnd: new Date(poly.windowEnd).toISOString(),
        },
        signal: signal ? formatSignal(signal) : null,
        hasEdge: !!signal,
      };
    }

    case 'toggle_arb_alerts': {
      const { enabled } = input;
      setArbAlerts(telegramId, enabled);
      return { success: true, enabled };
    }

    case 'follow_trader': {
      let { followedId, name, amount = 5 } = input;
      // If a Sui wallet address was given instead of a Telegram ID, resolve it
      if (String(followedId).startsWith('0x')) {
        const match = getAllUsers().find(u => u.address === followedId);
        if (!match) return { error: `No SAGE user found with wallet address ${followedId}. Make sure they have an account.` };
        followedId = match.telegramId;
        name = name || match.firstName || followedId;
      }
      if (String(followedId) === String(telegramId)) return { error: "You can't follow yourself." };
      setCopyTrading(telegramId, { followedId: String(followedId), name, amount, chatId });
      return { success: true, following: name, amount };
    }

    case 'stop_copying': {
      const current = getCopyTrading(telegramId);
      if (!current) return { error: 'Not currently copying anyone.' };
      clearCopyTrading(telegramId);
      return { success: true, stopped: current.name };
    }

    case 'get_copy_status': {
      const cfg     = getCopyTrading(telegramId);
      const watcher = getWalletWatcher(telegramId);
      return {
        copyingUser:    cfg     ? { following: cfg.name,          amount: cfg.amount,     since: new Date(cfg.since).toISOString() }     : null,
        watchingWallet: watcher ? { address: watcher.watchedAddress, amount: watcher.amount, since: new Date(watcher.since).toISOString() } : null,
      };
    }

    case 'get_risk_panel': {
      const now = Date.now();
      const [oracleList, allPositions] = await Promise.all([
        getOraclesList().catch(() => []),
        Promise.resolve(getAllUsersPositions()),
      ]);

      // Oracle health
      const liveOracles    = oracleList.filter(o => o.status === 'active' && Number(o.expiry) > now && !o.settlement_price);
      const settledOracles = oracleList.filter(o => !!o.settlement_price);
      let   spot = null, priceAgeMs = null;
      if (liveOracles.length) {
        const state = await getOracleState(liveOracles[0].oracle_id).catch(() => null);
        if (state?.latest_price) {
          spot       = Number(state.latest_price.spot) / 1e9;
          priceAgeMs = now - Number(state.latest_price.timestamp_ms || 0);
        }
      }

      // Open interest across all users
      const allFlat = Object.values(allPositions).flat();
      const openPos = allFlat.filter(p => p.status === 'open');
      const totalFace    = openPos.reduce((s, p) => s + (p.quantity || 0), 0);
      const totalPremium = openPos.reduce((s, p) => s + (p.premium  || 0), 0);

      // Settlement history — last 10 across all users
      const settled = allFlat
        .filter(p => ['won', 'lost', 'claimed'].includes(p.status) && p.expiryMs)
        .sort((a, b) => b.expiryMs - a.expiryMs)
        .slice(0, 10)
        .map(p => ({
          direction: p.direction,
          strike:    p.strike,
          outcome:   (p.won || p.status === 'claimed') ? 'won' : 'lost',
          payout:    p.won || p.status === 'claimed' ? p.quantity : 0,
          premium:   p.premium,
          expiryMs:  p.expiryMs,
        }));

      // Overall platform stats
      const allSettled  = allFlat.filter(p => ['won', 'lost', 'claimed'].includes(p.status));
      const allWins     = allSettled.filter(p => p.won || p.status === 'claimed');
      const totalVolume = allSettled.reduce((s, p) => s + (p.premium || 0), 0);

      return {
        oracle: {
          live:           liveOracles.length,
          settled:        settledOracles.length,
          spot,
          priceAgeSeconds: priceAgeMs ? +(priceAgeMs / 1000).toFixed(0) : null,
          healthy:        liveOracles.length > 0 && (priceAgeMs === null || priceAgeMs < 60_000),
        },
        openInterest: {
          positions:  openPos.length,
          totalFace:  +totalFace.toFixed(2),
          totalStaked: +totalPremium.toFixed(2),
        },
        platform: {
          totalSettled:  allSettled.length,
          winRate:       allSettled.length ? Math.round(allWins.length / allSettled.length * 100) : 0,
          totalVolume:   +totalVolume.toFixed(2),
        },
        recentSettlements: settled,
      };
    }

    case 'watch_wallet': {
      const { walletAddress, amount } = input;
      if (!walletAddress?.startsWith('0x')) throw new Error('Invalid wallet address — must start with 0x');
      if (amount <= 0) throw new Error('Amount must be greater than 0');
      // Initialize cursor to latest event so we only mirror future trades, not history
      let initialCursor = null;
      try {
        const r = await fetch('https://fullnode.testnet.sui.io', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'suix_queryEvents', params: [{ Sender: walletAddress }, null, 1, true] }),
        });
        const latest = (await r.json()).result?.data?.[0]?.id;
        if (latest) initialCursor = latest;
      } catch {}
      setWalletWatcher(telegramId, { watchedAddress: walletAddress, amount, chatId, lastEventCursor: initialCursor });
      return { success: true, watching: walletAddress, amount };
    }

    case 'unwatch_wallet': {
      const cfg = getWalletWatcher(telegramId);
      if (!cfg) return { error: 'Not currently watching any wallet.' };
      clearWalletWatcher(telegramId);
      return { success: true, stopped: cfg.watchedAddress };
    }

    case 'withdraw_funds': {
      const { toAddress, amount } = input;
      if (!toAddress?.startsWith('0x')) throw new Error('Invalid destination address — must start with 0x');
      if (amount <= 0) throw new Error('Amount must be greater than 0');
      const bal = await getBalance(address);
      if (amount > bal) throw new Error(`Insufficient balance. You have $${bal.toFixed(4)} dUSDC.`);
      return { _pendingWithdraw: true, toAddress, amount };
    }

    case 'preview_ladder': {
      const { direction, duration, totalBudget } = input;
      if (totalBudget < 3) throw new Error('Minimum ladder budget is $3');

      const perRung = +(totalBudget / 3).toFixed(2);
      const quote   = await getQuote(duration, perRung, direction);
      if (!quote.levels || quote.levels.length < 2) throw new Error('Not enough strikes available right now');

      const { oracleId, expiryMs, spot } = quote;
      const levels  = quote.levels; // Safe Hedge, Balanced, Moon Shot
      const currentPrice = await getBtcPrice().catch(() => null);
      const priceFmt     = currentPrice ? `$${currentPrice.toLocaleString('en-US', { maximumFractionDigits: 0 })}` : `$${spot.toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
      const expireAt     = new Date(expiryMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', timeZone: 'UTC', hour12: false });
      const dirWord      = direction === 'down' ? 'DROP BELOW' : 'RISE ABOVE';
      const RUNG_EMOJI   = ['🛡', '⚖️', '🚀'];

      const totalCost    = levels.reduce((s, l) => s + l.premium, 0);
      const bestCase     = levels.reduce((s, l) => s + l.face, 0);

      const lines = levels.map((l, i) => {
        const strikeFmt = `$${l.strike.toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
        const mult      = (l.face / l.premium).toFixed(1);
        return `${RUNG_EMOJI[i] || '•'} *${l.label}* — Strike ${strikeFmt}\n   $${l.premium.toFixed(2)} → win $${l.face.toFixed(2)} (${mult}x)`;
      });

      const previewText =
        `📊 *Ladder Strategy · BTC/USD ${direction.toUpperCase()} · ${duration} min*\n\n` +
        `Current price: *${priceFmt}*\n` +
        `Expires: *${expireAt} UTC*\n` +
        `BTC must *${dirWord}* each strike to win that rung.\n\n` +
        `━━━━━━━━━━━━━━━━\n` +
        lines.join('\n\n') + '\n' +
        `━━━━━━━━━━━━━━━━\n` +
        `Total at risk: *$${totalCost.toFixed(2)}* | Best case: *$${bestCase.toFixed(2)}*`;

      const rungs = levels.map(l => ({ oracleId, expiryMs, strike: l.strike, direction, face: l.face, premium: l.premium, label: l.label }));
      setPendingLadder(telegramId, { rungs, chatId });

      return { _pendingLadder: true, previewText };
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// Returns { text, card, pendingTrade, pendingLadder, isNew }
export async function runAgent(telegramId, userMessage, chatId) {
  const { isNew, address: newAddress } = getOrCreateWallet(telegramId);

  let history = getHistory(telegramId);

  // Proactively strip corrupted history — orphaned tool_result at start breaks Claude API
  if (history.length > 0) {
    const first = history[0];
    const isOrphaned = first.role === 'user' &&
      Array.isArray(first.content) &&
      first.content.some(b => b.type === 'tool_result');
    if (isOrphaned) {
      clearHistory(telegramId);
      history = [];
    }
  }

  history.push({ role: 'user', content: userMessage });

  let welcomePrefix = '';
  if (isNew) {
    try { const { fundNewUser } = await import('./predict.js'); await fundNewUser(newAddress); } catch {}
    welcomePrefix = `🎉 Welcome! Your wallet is ready.\n\n🔐 *Your wallet address:*\n\`${newAddress}\`\n\n💧 Need testnet SUI for gas? [n1stake Faucet](https://faucet.n1stake.com/)\n\nI've dropped 5 dUSDC in to get you started.\n\n`;
  }

  const address  = getAddress(telegramId);
  const user     = getUser(telegramId);
  const streak   = getStreak(telegramId);
  const positions = getPositions(telegramId);
  const openCount = positions.filter(p => p.status === 'open').length;
  const totalTrades = positions.length;

  const memoryBlock = [
    `\n\nUSER MEMORY:`,
    user?.firstName ? `- Name: ${user.firstName}` : null,
    address         ? `- Wallet: ${address}` : null,
    `- Streak: ${streak.count} day${streak.count !== 1 ? 's' : ''}`,
    `- Open positions: ${openCount}`,
    `- Total trades: ${totalTrades}`,
  ].filter(Boolean).join('\n');

  const systemPrompt = SYSTEM_PROMPT + memoryBlock;

  const messages   = [...history];
  let pendingCard     = null;
  let pendingTrade    = null;
  let pendingLadder   = null;
  let pendingWithdraw = null;
  let startWizard     = false;

  while (true) {
    let response;
    try {
      response = await anthropic.messages.create({
        model:      'claude-sonnet-4-6',
        max_tokens: 1024,
        system:     systemPrompt,
        tools,
        messages,
      });
    } catch (e) {
      if (e.message?.includes('tool_use_id') || e.message?.includes('tool_result')) {
        clearHistory(telegramId);
        return { text: "Something went sideways with my memory — I've reset it. Ask me again!", card: null, pendingTrade: null, startWizard: false };
      }
      throw e;
    }

    messages.push({ role: 'assistant', content: response.content });

    if (response.stop_reason === 'end_turn') {
      const text = response.content.find(b => b.type === 'text')?.text || '';
      saveHistory(telegramId, messages);
      return { text: welcomePrefix + text, card: pendingCard, pendingTrade, pendingLadder, pendingWithdraw, startWizard, isNew, newAddress };
    }

    if (response.stop_reason === 'tool_use') {
      const toolResults = [];
      for (const block of response.content) {
        if (block.type !== 'tool_use') continue;
        let result;
        try {
          result = await executeTool(block.name, block.input, telegramId, chatId);
        } catch (e) {
          result = { error: e.message };
        }
        if (result?._sendCard) {
          pendingCard = result;
          toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: JSON.stringify({ cardSent: true, caption: result.caption }) });
        } else if (result?._pendingWithdraw) {
          pendingWithdraw = result;
          toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: JSON.stringify({ queued: true, message: 'Withdraw preview sent with confirm/cancel buttons' }) });
        } else if (result?._pendingLadder) {
          pendingLadder = result;
          toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: JSON.stringify({ queued: true, message: 'Ladder preview sent with confirm/cancel buttons' }) });
        } else if (result?._pendingTrade) {
          pendingTrade = result;
          toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: JSON.stringify({ queued: true, message: 'Preview sent with confirm/cancel buttons' }) });
        } else if (result?._startWizard) {
          startWizard = true;
          toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: JSON.stringify({ wizardStarted: true }) });
        } else {
          toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: JSON.stringify(result) });
        }
      }
      messages.push({ role: 'user', content: toolResults });
      continue;
    }

    break;
  }

  saveHistory(telegramId, messages);
  return { text: welcomePrefix + 'Something went wrong. Try again.', card: null, pendingTrade: null, pendingLadder: null, pendingWithdraw: null, startWizard: false, isNew, newAddress };
}
