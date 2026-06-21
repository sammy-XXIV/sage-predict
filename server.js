import 'dotenv/config';
import crypto from 'crypto';
import express from 'express';
import { runAgent, getTradeContext } from './agent.js';
import { getAllActivePositions, getAllUsersPositions, clearAllPositions, updatePosition, getAllAlerts, removeAlert, getAllAutoPredict, getAllUsers, resetBudgets, savePosition, saveUser, getUser, getPositions, getPendingTrade, setPendingTrade, clearPendingTrade, getBudget, recordSpend, updateStreak, setWizardState, getWizardState, clearWizardState, migrateHistory, initDb, getArbAlerts, setArbAlerts, getPendingLadder, clearPendingLadder, getFollowers, setOnboardingState, getOnboardingState, clearOnboardingState, getAllWalletWatchers, updateWalletWatcherCursor } from './db.js';
import { checkArbSignal, formatSignal, getPolymarketBtc15m } from './arb.js';
import { getKeypair, getAddress, getManagerId, setManagerId } from './wallet.js';
import { getOracleState, redeemPosition, getBtcPrice, getQuote, openPosition, getBalance, getSuiBalance, withdrawFunds } from './predict.js';
import { TELEGRAM_API, PRICE_SCALE } from './config.js';
const EXPLORER = 'https://suiscan.xyz/testnet/tx';
import { generateCard } from './card.js';

const app  = express();
app.use(express.json());

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const tg = (method, body) =>
  fetch(`${TELEGRAM_API}/bot${BOT_TOKEN}/${method}`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
  }).then(r => r.json());

let botUsername = '';

function appUrl() {
  const domain = process.env.RAILWAY_PUBLIC_DOMAIN;
  return domain ? `https://${domain}/app` : null;
}

function validateTelegramInitData(initData) {
  if (!initData || !BOT_TOKEN) return null;
  try {
    const params = new URLSearchParams(initData);
    const hash = params.get('hash');
    if (!hash) return null;
    params.delete('hash');
    const sorted = [...params.entries()].sort(([a], [b]) => a.localeCompare(b));
    const checkString = sorted.map(([k, v]) => `${k}=${v}`).join('\n');
    const secretKey = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
    const expected  = crypto.createHmac('sha256', secretKey).update(checkString).digest('hex');
    if (expected !== hash) return null;
    const userStr = params.get('user');
    return userStr ? JSON.parse(userStr) : null;
  } catch { return null; }
}

async function sendMessage(chatId, text, extra = {}) {
  return tg('sendMessage', { chat_id: chatId, text, parse_mode: 'Markdown', ...extra });
}

function chartButton() {
  const url = appUrl();
  if (!url) return null;
  return { inline_keyboard: [[{ text: '📊 View Chart', web_app: { url } }]] };
}

async function sendPositionOpened(chatId, text) {
  const kb = chartButton();
  return tg('sendMessage', {
    chat_id: chatId, text, parse_mode: 'Markdown',
    ...(kb ? { reply_markup: kb } : {}),
  });
}


const pendingWithdraws = new Map(); // telegramId → { toAddress, amount }

async function sendOnboardingChoice(chatId, firstName) {
  return tg('sendMessage', {
    chat_id:    chatId,
    text:       `👋 Welcome${firstName ? ', ' + firstName : ''}!\n\nI'm *SAGE* — your AI agent for BTC prediction markets on DeepBook.\n\nWould you like to create a fresh wallet or import an existing one?`,
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: [[
      { text: '✨ Create New Wallet', callback_data: 'onboard_create' },
      { text: '📥 Import Wallet',     callback_data: 'onboard_import' },
    ]] },
  });
}

async function sendWithdrawPreview(chatId, telegramId, toAddress, amount) {
  pendingWithdraws.set(String(telegramId), { toAddress, amount });
  return tg('sendMessage', {
    chat_id:    chatId,
    text:
      `💸 *Withdraw Preview*\n\n` +
      `Amount: *$${amount.toFixed(4)} dUSDC*\n` +
      `To: \`${toAddress}\`\n\n` +
      `Confirm this withdrawal?`,
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: [[
      { text: '✅ Confirm Withdraw', callback_data: 'confirm_withdraw' },
      { text: '❌ Cancel',           callback_data: 'cancel_withdraw'  },
    ]] },
  });
}

async function sendLadderPreview(chatId, text) {
  return tg('sendMessage', {
    chat_id:    chatId,
    text,
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: [[
      { text: '✅ Open Ladder', callback_data: 'confirm_ladder' },
      { text: '❌ Cancel',      callback_data: 'cancel_ladder'  },
    ]] },
  });
}

async function sendTradePreview(chatId, text) {
  return tg('sendMessage', {
    chat_id:      chatId,
    text,
    parse_mode:   'Markdown',
    reply_markup: {
      inline_keyboard: [[
        { text: '✅ Confirm', callback_data: 'confirm_trade' },
        { text: '❌ Cancel',  callback_data: 'cancel_trade'  },
      ]],
    },
  });
}

function durationKeyboard() {
  return { inline_keyboard: [[
    { text: '⚡ 15 min', callback_data: 'wiz_dur_15' },
    { text: '🕐 30 min', callback_data: 'wiz_dur_30' },
    { text: '🕑 60 min', callback_data: 'wiz_dur_60' },
  ]] };
}
async function directionKeyboard(duration) {
  let upPct = null, downPct = null;
  try {
    const quote = await getQuote(duration, 10, 'up');
    const lvl   = quote.levels?.[1] || quote.levels?.[0];
    if (lvl) {
      const prob = lvl.premium / lvl.face;
      upPct   = Math.round(prob * 100);
      downPct = 100 - upPct;
    }
  } catch {}
  const upLabel   = upPct   != null ? `📈 UP ${upPct}%`   : '📈 UP';
  const downLabel = downPct != null ? `📉 DOWN ${downPct}%` : '📉 DOWN';
  return { inline_keyboard: [[
    { text: upLabel,   callback_data: 'wiz_dir_up'   },
    { text: downLabel, callback_data: 'wiz_dir_down' },
  ]] };
}
function amountKeyboard() {
  return { inline_keyboard: [[
    { text: '$2',   callback_data: 'wiz_amt_2'   },
    { text: '$5',   callback_data: 'wiz_amt_5'   },
    { text: '$10',  callback_data: 'wiz_amt_10'  },
    { text: '$50',  callback_data: 'wiz_amt_50'  },
  ]] };
}

async function executeClaim(telegramId, chatId, posId = null) {
  const positions = getPositions(telegramId);
  const claimable = positions.filter(p => p.status === 'won' && p.won);
  const targets = posId ? claimable.filter(p => p.id === posId) : claimable;

  if (!targets.length) {
    await sendMessage(chatId, '✅ Nothing to claim right now — positions settle automatically. Check `/positions` for open bets.');
    return;
  }

  for (const pos of targets) {
    const keypair   = getKeypair(telegramId);
    const address   = getAddress(telegramId);
    const managerId = pos.managerId || getManagerId(telegramId);


    if (!keypair || !address) {
      await sendMessage(chatId, '❌ Wallet not found. Try /wallet to check.');
      continue;
    }

    await sendMessage(chatId, `⏳ Claiming $${pos.quantity.toFixed(2)} dUSDC…`);

    try {
      const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('RPC timed out after 60s — the tx may still land. Try claiming again in a minute.')), 60_000));
      const result  = await Promise.race([
        redeemPosition(keypair, address, managerId, pos.oracleId, pos.expiryMs, pos.strike, pos.direction, pos.quantity),
        timeout,
      ]);
      const claimedAmount = result.quantityBig ? Number(result.quantityBig) / 1e6 : pos.quantity;
      console.log(`[claim] success digest=${result.digest} amount=${claimedAmount}`);
      updatePosition(telegramId, pos.id, { status: 'claimed', claimDigest: result.digest, claimedAmount });
      await sendMessage(chatId, `💰 *$${claimedAmount.toFixed(2)} dUSDC claimed!*\n[View on-chain](https://suiscan.xyz/testnet/tx/${result.digest})`);
    } catch (e) {
      const msg = e?.message || String(e) || 'Unknown error';
      console.error(`[claim] failed posId=${pos.id}:`, msg);
      if (msg.includes('Oracle not yet finalized') || msg.includes('not yet finalized')) {
        await sendMessage(chatId, `⏳ Oracle is still finalizing on-chain. Try claiming again in a minute.`);
      } else {
        await sendMessage(chatId, `❌ Claim failed: ${msg}`);
      }
    }
  }
}

async function sendCard(chatId, type, data) {
  try {
    const buffer = await generateCard(type, data);
    const form = new FormData();
    form.append('chat_id', String(chatId));
    form.append('photo', new Blob([buffer], { type: 'image/png' }), 'card.png');
    if (data.caption) form.append('caption', data.caption);
    if (data.caption) form.append('parse_mode', 'Markdown');
    if (data.extra?.reply_markup) form.append('reply_markup', JSON.stringify(data.extra.reply_markup));
    return fetch(`${TELEGRAM_API}/bot${BOT_TOKEN}/sendPhoto`, { method: 'POST', body: form });
  } catch (e) {
    console.error('Card send error:', e.message);
    return sendMessage(chatId, data.caption || '');
  }
}

let dbReady = false;

// ── Telegram webhook ──────────────────────────────────────────────
app.post('/webhook', async (req, res) => {
  res.sendStatus(200);
  if (!dbReady) return;

  const update = req.body;
  let _emergencyChatId = null;

  try {

  // ── Inline keyboard callback ──────────────────────────────────────
  if (update.callback_query) {
    const cq          = update.callback_query;
    const cqChatId    = cq.message.chat.id;
    const cqMsgId     = cq.message.message_id;
    const telegramId  = String(cq.from.id);
    _emergencyChatId  = cqChatId;

    await tg('answerCallbackQuery', { callback_query_id: cq.id });

    // ── Claim button on win card ──────────────────────────────────
    if (cq.data.startsWith('claim_pos_')) {
      const posId = parseInt(cq.data.replace('claim_pos_', ''), 10);
      await executeClaim(telegramId, cqChatId, posId);
      return;
    }

    if (cq.data === 'confirm_trade') {
      const trade = getPendingTrade(telegramId);
      if (!trade) {
        await tg('editMessageText', { chat_id: cqChatId, message_id: cqMsgId, text: '⏰ Quote expired. Ask for a new one.' });
        return;
      }
      clearPendingTrade(telegramId);
      await tg('editMessageReplyMarkup', { chat_id: cqChatId, message_id: cqMsgId, reply_markup: { inline_keyboard: [] } });
      await tg('sendChatAction', { chat_id: cqChatId, action: 'typing' });

      try {
        const keypair   = getKeypair(telegramId);
        const address   = getAddress(telegramId);
        const managerId = getManagerId(telegramId);
        if (!keypair || !address) throw new Error('Wallet not found');

        const budget = getBudget(telegramId);
        if (budget) {
          const today = new Date().toDateString();
          const spent = budget.resetDate === today ? budget.spentToday : 0;
          if (spent + trade.premium > budget.dailyLimit) {
            await sendMessage(cqChatId, `❌ Daily budget exceeded. You've spent $${spent.toFixed(2)} of your $${budget.dailyLimit} limit.`);
            return;
          }
        }

        const result = await openPosition(keypair, address, managerId, trade.oracleId, trade.expiryMs, trade.strike, trade.direction, trade.face, trade.premium);
        if (result.managerId && result.managerId !== managerId) setManagerId(telegramId, result.managerId);

        savePosition(telegramId, {
          oracleId:  trade.oracleId, expiryMs: trade.expiryMs,
          strike:    trade.strike,   direction: trade.direction,
          quantity:  trade.face,     premium:   trade.premium,
          managerId: result.managerId || managerId,
          digest:    result.digest,  chatId:    cqChatId, status: 'open',
        });
        if (budget) recordSpend(telegramId, trade.premium);
        triggerCopyTrades(telegramId, { oracleId: trade.oracleId, expiryMs: trade.expiryMs, strike: trade.strike, direction: trade.direction, face: trade.face, premium: trade.premium }).catch(() => {});

        const expireAt = new Date(trade.expiryMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', timeZone: 'UTC', hour12: false });
        const strikeFmt = `$${trade.strike.toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
        await sendPositionOpened(cqChatId,
          `✅ *Position open!*\n\nBTC ${trade.direction.toUpperCase()} ${strikeFmt} · expires ${expireAt} UTC\n💵 $${trade.premium.toFixed(2)} at risk · 💰 $${trade.face.toFixed(2)} to win\n\n[View on-chain](${EXPLORER}/${result.digest})`
        );
      } catch (e) {
        console.error('Confirm trade error:', e);
        const userAddress = getAddress(telegramId);
        if (e.message?.includes('Balance of gas') || e.message?.includes('gas')) {
          await sendMessage(cqChatId, `⛽ *No SUI for gas fees.*\n\nYour wallet needs a tiny amount of SUI to pay transaction fees. Get some free testnet SUI at faucet.sui.io (testnet)\n\nYour wallet: \`${userAddress}\``, { parse_mode: 'Markdown' });
        } else if (e.message?.includes('Price moved') || e.message?.includes('quote') || e.message?.includes('Object not found') || e.message?.includes('expir')) {
          clearPendingTrade(telegramId);
          clearWizardState(telegramId);
          await tg('sendMessage', {
            chat_id: cqChatId,
            text: '🔄 Quote expired — pick your direction again:',
            parse_mode: 'Markdown',
            reply_markup: await directionKeyboard(15),
          });
        } else if (e.message?.includes('balancemanager') || e.message?.includes('withdrawwithproof') || e.message?.includes('MoveAbort')) {
          await sendMessage(cqChatId, `💸 *Not enough dUSDC.*\n\nYour balance is too low for this trade. Check your balance and top up if needed.`, { parse_mode: 'Markdown' });
        } else {
          await sendMessage(cqChatId, `❌ Failed to open position: ${e.message}`);
        }
      }
      return;
    }

    if (cq.data === 'cancel_trade') {
      clearPendingTrade(telegramId);
      await tg('editMessageText', {
        chat_id: cqChatId, message_id: cqMsgId,
        text: '🚫 Trade cancelled.', parse_mode: 'Markdown',
      });
      return;
    }

    // ── Ladder: confirm ──────────────────────────────────────────────
    if (cq.data === 'confirm_ladder') {
      const ladder = getPendingLadder(telegramId);
      if (!ladder) {
        await tg('editMessageText', { chat_id: cqChatId, message_id: cqMsgId, text: '⏱ Ladder expired. Try again.' });
        return;
      }
      clearPendingLadder(telegramId);
      await tg('editMessageText', { chat_id: cqChatId, message_id: cqMsgId, text: '⏳ Opening ladder positions…' });
      const keypair   = getKeypair(telegramId);
      const address   = getAddress(telegramId);
      let   managerId = getManagerId(telegramId);
      const results   = [];
      for (const rung of ladder.rungs) {
        try {
          const result = await openPosition(keypair, address, managerId, rung.oracleId, rung.expiryMs, rung.strike, rung.direction, rung.face, rung.premium);
          if (result.managerId && result.managerId !== managerId) { managerId = result.managerId; setManagerId(telegramId, managerId); }
          savePosition(telegramId, { oracleId: rung.oracleId, expiryMs: rung.expiryMs, strike: rung.strike, direction: rung.direction, quantity: rung.face, premium: rung.premium, managerId, digest: result.digest, chatId: cqChatId, status: 'open' });
          results.push({ label: rung.label, strike: rung.strike, face: rung.face, premium: rung.premium, digest: result.digest, ok: true });
        } catch (e) {
          results.push({ label: rung.label, strike: rung.strike, ok: false, error: e.message });
        }
      }
      const opened = results.filter(r => r.ok);
      const failed = results.filter(r => !r.ok);
      const lines  = results.map(r =>
        r.ok
          ? `✅ *${r.label}* — $${r.strike.toLocaleString('en-US', { maximumFractionDigits: 0 })} · $${r.premium.toFixed(2)} → $${r.face.toFixed(2)} · [tx](${EXPLORER}/${r.digest})`
          : `❌ *${r.label}* — failed: ${r.error}`
      );
      const summary = `🎯 *Ladder open!* ${opened.length}/${results.length} positions placed\n\n` + lines.join('\n');
      await sendMessage(cqChatId, summary);
      return;
    }

    if (cq.data === 'cancel_ladder') {
      clearPendingLadder(telegramId);
      await tg('editMessageText', {
        chat_id: cqChatId, message_id: cqMsgId,
        text: '🚫 Ladder cancelled.', parse_mode: 'Markdown',
      });
      return;
    }

    // ── Onboarding: create wallet ────────────────────────────────────
    if (cq.data === 'onboard_create') {
      clearOnboardingState(telegramId);
      await tg('editMessageReplyMarkup', { chat_id: cqChatId, message_id: cqMsgId, reply_markup: { inline_keyboard: [] } });
      // Let runAgent create the wallet on the next call
      const { runAgent } = await import('./agent.js');
      const { text: reply, isNew, newAddress } = await runAgent(telegramId, 'start', cqChatId);
      if (isNew && newAddress) {
        await tg('sendMessage', {
          chat_id:    cqChatId,
          text:       `✅ *Wallet created!*\n\n🔐 Your address:\n\`${newAddress}\`\n\n💧 Need testnet SUI for gas? [n1stake Faucet](https://faucet.n1stake.com/)`,
          parse_mode: 'Markdown',
          disable_web_page_preview: true,
        });
      }
      if (reply) await sendMessage(cqChatId, reply);
      return;
    }

    // ── Onboarding: import wallet ────────────────────────────────────
    if (cq.data === 'onboard_import') {
      setOnboardingState(telegramId, 'awaiting_key');
      await tg('editMessageReplyMarkup', { chat_id: cqChatId, message_id: cqMsgId, reply_markup: { inline_keyboard: [] } });
      await tg('sendMessage', {
        chat_id:    cqChatId,
        text:       `🔑 *Import your wallet*\n\nSend me your Sui private key.\n\nAccepted formats:\n• Bech32: \`suiprivkey1...\`\n• Hex: \`0x...\`\n\n⚠️ *Only send this in a private chat. I will delete your message immediately after importing.*`,
        parse_mode: 'Markdown',
      });
      return;
    }

    // ── Withdraw: confirm ────────────────────────────────────────────
    if (cq.data === 'confirm_withdraw') {
      const pw = pendingWithdraws.get(String(telegramId));
      if (!pw) { await tg('editMessageText', { chat_id: cqChatId, message_id: cqMsgId, text: '⏱ Withdraw expired. Try again.' }); return; }
      pendingWithdraws.delete(String(telegramId));
      await tg('editMessageText', { chat_id: cqChatId, message_id: cqMsgId, text: '⏳ Sending…' });
      try {
        const keypair = getKeypair(telegramId);
        const address = getAddress(telegramId);
        if (!keypair || !address) throw new Error('Wallet not found');
        const result = await withdrawFunds(keypair, address, pw.toAddress, pw.amount);
        await sendMessage(cqChatId,
          `✅ *Withdrawal sent!*\n\n$${pw.amount.toFixed(4)} dUSDC → \`${pw.toAddress.slice(0, 16)}…\`\n\n[View on explorer](https://suiscan.xyz/testnet/tx/${result.digest})`
        );
      } catch (e) {
        await sendMessage(cqChatId, `❌ Withdrawal failed: ${e.message}`);
      }
      return;
    }

    // ── Withdraw: cancel ─────────────────────────────────────────────
    if (cq.data === 'cancel_withdraw') {
      pendingWithdraws.delete(String(telegramId));
      await tg('editMessageText', { chat_id: cqChatId, message_id: cqMsgId, text: '🚫 Withdrawal cancelled.' });
      return;
    }

    // ── Wizard: duration pick ────────────────────────────────────────
    if (cq.data.startsWith('wiz_dur_')) {
      const duration = parseInt(cq.data.replace('wiz_dur_', ''), 10);
      setWizardState(telegramId, { step: 'direction', duration });
      await tg('editMessageText', {
        chat_id: cqChatId, message_id: cqMsgId,
        text: `⏱ *${duration} min* selected\n\nWhich direction?`,
        parse_mode: 'Markdown', reply_markup: await directionKeyboard(duration),
      });
      return;
    }

    // ── Wizard: direction pick ───────────────────────────────────────
    if (cq.data.startsWith('wiz_dir_')) {
      const direction = cq.data.replace('wiz_dir_', '');
      const wiz = getWizardState(telegramId);
      if (!wiz) { await sendMessage(cqChatId, 'Wizard expired. Try again.'); return; }
      setWizardState(telegramId, { ...wiz, step: 'amount', direction });
      const emoji = direction === 'up' ? '📈' : '📉';
      await tg('editMessageText', {
        chat_id: cqChatId, message_id: cqMsgId,
        text: `${emoji} *${direction.toUpperCase()}* selected\n\nHow much do you want to risk?`,
        parse_mode: 'Markdown', reply_markup: amountKeyboard(),
      });
      return;
    }

    // ── Wizard: amount pick → fetch quote → show preview ────────────
    if (cq.data.startsWith('wiz_amt_')) {
      const stake = parseInt(cq.data.replace('wiz_amt_', ''), 10);
      const wiz   = getWizardState(telegramId);
      if (!wiz) { await sendMessage(cqChatId, 'Wizard expired. Try again.'); return; }
      clearWizardState(telegramId);

      await tg('editMessageText', { chat_id: cqChatId, message_id: cqMsgId, text: '⏳ Fetching live quote…' });

      try {
        const quote    = await getQuote(wiz.duration, stake, wiz.direction);
        const lvl      = quote.levels[1] || quote.levels[0];
        const { oracleId, expiryMs } = quote;
        const { strike, premium, face: payout } = lvl; // premium=stake, payout=what user wins

        const currentPrice = await getBtcPrice().catch(() => null);
        const strikeFmt    = `$${strike.toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
        const priceFmt     = currentPrice ? `$${currentPrice.toLocaleString('en-US', { maximumFractionDigits: 0 })}` : '—';
        const multiplier   = (payout / premium).toFixed(1);
        const expireAt     = new Date(expiryMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', timeZone: 'UTC', hour12: false });
        const dirWord      = wiz.direction === 'down' ? 'DROP BELOW' : 'RISE ABOVE';
        const moveWord     = wiz.direction === 'down' ? 'fall' : 'rise';
        const delta        = currentPrice ? Math.abs(currentPrice - strike) : null;
        const deltaTxt     = delta ? ` — needs to ${moveWord} $${delta.toLocaleString('en-US', { maximumFractionDigits: 0 })}` : '';

        // premium/face from DeepBook always = P(UP) regardless of direction quoted
        const pUp            = premium / payout;
        const marketFavors   = pUp >= 0.5 ? 'up' : 'down';
        const contrarian     = marketFavors !== wiz.direction;
        const consensusPct   = Math.round((pUp >= 0.5 ? pUp : 1 - pUp) * 100);
        const contrarianWarn = contrarian
          ? `\n⚠️ *Against the market* — DeepBook is pricing ${consensusPct}% ${marketFavors.toUpperCase()}. You are taking the other side.\n`
          : '';
        const tradeCtx    = await getTradeContext(wiz.duration).catch(() => null);
        const sageCtxLine = tradeCtx ? `\n🔮 *SAGE* — ${tradeCtx}\n` : '';

        const previewText =
          `🎯 *Trade Preview · BTC/USD ${wiz.direction.toUpperCase()} · ${wiz.duration} min*\n\n` +
          `Current price: *${priceFmt}*\n` +
          `Strike: *${strikeFmt}*${deltaTxt}\n` +
          `Expires: *${expireAt} UTC*\n\n` +
          `💵 You put in: *$${premium.toFixed(2)}*\n` +
          `💰 You win: *$${payout.toFixed(2)}* (${multiplier}x)\n\n` +
          `━━━━━━━━━━━━━━━━\n` +
          contrarianWarn +
          sageCtxLine +
          `⚠️ *Risk*\n` +
          `• Binary outcome — win *$${payout.toFixed(2)}* or lose *$${premium.toFixed(2)}*\n` +
          `• BTC must *${dirWord} ${strikeFmt}* by ${expireAt} UTC\n` +
          `• If it hasn't moved enough at expiry, you lose 100%\n` +
          `• No early exit · No partial payouts · Oracle-settled\n` +
          `━━━━━━━━━━━━━━━━`;

        setPendingTrade(telegramId, { oracleId, expiryMs, strike, direction: wiz.direction, face: payout, premium });
        await tg('editMessageText', {
          chat_id: cqChatId, message_id: cqMsgId,
          text: previewText, parse_mode: 'Markdown',
          reply_markup: { inline_keyboard: [[
            { text: '✅ Confirm', callback_data: 'confirm_trade' },
            { text: '❌ Cancel',  callback_data: 'cancel_trade'  },
          ]] },
        });
      } catch (e) {
        console.error('Wizard quote error:', e);
        await tg('editMessageText', { chat_id: cqChatId, message_id: cqMsgId, text: `❌ Failed to get quote: ${e.message}` });
      }
      return;
    }

    return;
  }

  // ── Regular message ───────────────────────────────────────────────
  const message = update.message || update.edited_message;
  if (!message?.text && !message?.voice) return;

  // ── Voice → text via Gemini ──────────────────────────────────────
  let replyWithVoice = false;
  if (message.voice) {
    const chatId     = message.chat.id;
    const telegramId = String(message.from.id);
    try {
      await tg('sendChatAction', { chat_id: chatId, action: 'typing' });
      const fileInfo = await tg('getFile', { file_id: message.voice.file_id });
      console.log('getFile response:', JSON.stringify(fileInfo).slice(0, 300));
      const filePath = fileInfo.result?.file_path || fileInfo.file_path;
      if (!filePath) throw new Error('No file_path from Telegram');
      const fileUrl  = `https://api.telegram.org/file/bot${BOT_TOKEN}/${filePath}`;
      const audioRes = await fetch(fileUrl);
      const audioBuf = Buffer.from(await audioRes.arrayBuffer());
      console.log('Voice file size:', audioBuf.length, 'path:', filePath);
      const formData = new FormData();
      formData.append('file', new Blob([audioBuf], { type: 'audio/ogg; codecs=opus' }), 'voice.opus');
      formData.append('model', 'whisper-large-v3');
      formData.append('prompt', 'This is a command for a BTC trading bot. Common terms: dUSDC, BTC, up, down, ladder, balance, positions, withdraw, strike, risk.');
      const whisperRes  = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
        method:  'POST',
        headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}` },
        body:    formData,
      });
      const whisperJson = await whisperRes.json();
      console.log('Whisper transcribe:', JSON.stringify(whisperJson).slice(0, 300));
      const transcript  = whisperJson.text?.trim();
      if (!transcript) { await tg('sendMessage', { chat_id: chatId, text: "Sorry, I couldn't make that out. Try again?" }); return; }
      message.text  = transcript;
      replyWithVoice = true;
    } catch (e) {
      console.error('Voice transcription error:', e.message);
      await tg('sendMessage', { chat_id: message.chat.id, text: "Voice transcription failed. Try typing instead." });
      return;
    }
  }
  _emergencyChatId = message.chat.id;

  const chatId     = message.chat.id;
  const telegramId = String(message.from.id);
  const isGroup    = message.chat.type === 'group' || message.chat.type === 'supergroup';

  // In groups, only respond when @mentioned
  let rawText = message.text.trim();
  if (isGroup) {
    const mentionTag = botUsername ? `@${botUsername}` : null;
    const mentioned  = mentionTag && rawText.toLowerCase().includes(mentionTag.toLowerCase());
    if (!mentioned) return;
    rawText = rawText.replace(new RegExp('@' + botUsername, 'gi'), '').trim();
    if (!rawText) return;
  }
  const text = rawText;

  if (message.from.first_name) {
    // Preserve the user's DM chatId — don't overwrite it with a group chat id
    const existing = getUser(telegramId);
    const dmChatId = existing?.dmChatId || (!isGroup ? chatId : null);
    saveUser(telegramId, {
      firstName: message.from.first_name,
      chatId: isGroup ? (existing?.chatId || chatId) : chatId,
      ...(dmChatId ? { dmChatId } : {}),
    });
  }

  // ── Onboarding: new user with no wallet → show choice ────────────
  if (!isGroup && !getAddress(telegramId) && getOnboardingState(telegramId) !== 'awaiting_key') {
    setOnboardingState(telegramId, 'choosing');
    await sendOnboardingChoice(chatId, message.from.first_name);
    return;
  }

  // ── Import wallet: intercept private key input ────────────────────
  if (!isGroup && getOnboardingState(telegramId) === 'awaiting_key') {
    const key = text.trim();
    // Delete the message immediately for security
    await tg('deleteMessage', { chat_id: chatId, message_id: message.message_id }).catch(() => {});
    try {
      const { Ed25519Keypair } = await import('@mysten/sui/keypairs/ed25519');
      let keypair;
      if (key.startsWith('suiprivkey')) {
        keypair = Ed25519Keypair.fromSecretKey(key);
      } else {
        const hex = key.startsWith('0x') ? key.slice(2) : key;
        keypair = Ed25519Keypair.fromSecretKey(Buffer.from(hex, 'hex'));
      }
      const address   = keypair.toSuiAddress();
      const secretKey = keypair.getSecretKey();
      saveUser(telegramId, { secretKey, address, managerId: null });
      clearOnboardingState(telegramId);
      await tg('sendMessage', {
        chat_id:    chatId,
        text:
          `✅ *Wallet imported!*\n\n🔐 Address:\n\`${address}\`\n\n` +
          `⚠️ Your message with the key has been deleted.\n\n` +
          `You're all set — what would you like to do?`,
        parse_mode: 'Markdown',
      });
    } catch (e) {
      await sendMessage(chatId, `❌ Invalid private key: ${e.message}\n\nPlease try again or tap /start to choose again.`);
    }
    return;
  }

  // ── Intercept typed confirm/cancel for pending trades ────────────
  const pendingCheck = getPendingTrade(telegramId);
  if (pendingCheck) {
    const t = text.toLowerCase().trim();
    if (t === 'confirm' || t === 'yes' || t === 'ok' || t === 'y') {
      clearPendingTrade(telegramId);
      tg('sendChatAction', { chat_id: chatId, action: 'typing' });
      try {
        const keypair   = getKeypair(telegramId);
        const address   = getAddress(telegramId);
        const managerId = getManagerId(telegramId);
        if (!keypair || !address) throw new Error('Wallet not found');
        const result = await openPosition(keypair, address, managerId, pendingCheck.oracleId, pendingCheck.expiryMs, pendingCheck.strike, pendingCheck.direction, pendingCheck.face, pendingCheck.premium);
        if (result.managerId && result.managerId !== managerId) setManagerId(telegramId, result.managerId);
        savePosition(telegramId, { oracleId: pendingCheck.oracleId, expiryMs: pendingCheck.expiryMs, strike: pendingCheck.strike, direction: pendingCheck.direction, quantity: pendingCheck.face, premium: pendingCheck.premium, managerId: result.managerId || managerId, digest: result.digest, chatId, status: 'open' });
        triggerCopyTrades(telegramId, { oracleId: pendingCheck.oracleId, expiryMs: pendingCheck.expiryMs, strike: pendingCheck.strike, direction: pendingCheck.direction, face: pendingCheck.face, premium: pendingCheck.premium }).catch(() => {});
        const expireAt = new Date(pendingCheck.expiryMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', timeZone: 'UTC', hour12: false });
        const strikeFmt = `$${pendingCheck.strike.toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
        await sendPositionOpened(chatId, `✅ *Position open!*\n\nBTC ${pendingCheck.direction.toUpperCase()} ${strikeFmt} · expires ${expireAt} UTC\n💵 $${pendingCheck.premium.toFixed(2)} at risk · 💰 $${pendingCheck.face.toFixed(2)} to win\n\n[View on-chain](${EXPLORER}/${result.digest})`);
      } catch (e) {
        await sendMessage(chatId, `❌ Failed to open position: ${e.message}`);
      }
      return;
    }
    if (t === 'cancel' || t === 'no' || t === 'nope' || t === 'n') {
      clearPendingTrade(telegramId);
      await sendMessage(chatId, 'Trade cancelled.');
      return;
    }
  }

  // ── Wizard: intercept typed custom amount ────────────────────────
  const wiz = getWizardState(telegramId);
  if (wiz?.step === 'amount') {
    const face = parseFloat(text.replace(/[^0-9.]/g, ''));
    if (face >= 1) {
      clearWizardState(telegramId);
      try {
        const quote = await getQuote(wiz.duration, face, wiz.direction);
        const lvl = quote.levels[1] || quote.levels[0];
        const { oracleId, expiryMs } = quote;
        const { strike, premium, face: payout } = lvl;
        const multiplier = (payout / premium).toFixed(1);
        const previewText = [
          `*${wiz.direction.toUpperCase()} BTC — ${wiz.duration}min*`,
          ``,
          `💵 You put in: $${premium.toFixed(2)}`,
          `💰 You win: $${payout.toFixed(2)} (${multiplier}x)`,
          `📊 Strike: $${strike.toLocaleString()}`,
          `⏱ Expires: ${new Date(expiryMs).toLocaleTimeString()}`,
          ``,
          `⚠️ Risk: lose $${premium.toFixed(2)} if wrong`,
        ].join('\n');
        setPendingTrade(telegramId, { direction: wiz.direction, duration: wiz.duration, oracleId, expiryMs, strike, premium, face: payout });
        await sendTradePreview(chatId, previewText);
      } catch (e) {
        await sendMessage(chatId, `Couldn't get a quote: ${e.message}`);
      }
      return;
    }
    await tg('sendMessage', { chat_id: chatId, text: 'Pick an amount:', reply_markup: amountKeyboard() });
    return;
  }

  const cmdBase = text.split(' ')[0].toLowerCase();
  const cmdArg  = text.split(' ').slice(1).join(' ').toLowerCase().trim();

  // ── /start deep links (e.g. /start trade_up, /start trade_down) ──
  if (cmdBase === '/start') {
    if (cmdArg.startsWith('trade_')) {
      const dir = cmdArg.replace('trade_', '');
      if (dir === 'up' || dir === 'down') {
        setWizardState(telegramId, { step: 'amount', direction: dir, duration: 30 });
        const emoji = dir === 'up' ? '📈' : '📉';
        await tg('sendMessage', {
          chat_id: chatId,
          text: `${emoji} *${dir.toUpperCase()}* locked in — how much do you want to risk?`,
          parse_mode: 'Markdown',
          reply_markup: amountKeyboard(),
        });
        return;
      }
    }
  }

  // ── /reset — clear stale wizard / trade state ──────────────────
  if (cmdBase === '/reset') {
    clearWizardState(telegramId);
    clearPendingTrade(telegramId);
    clearHistory(telegramId);
    await sendMessage(chatId, '🔄 State cleared. Send me a message to start fresh.');
    return;
  }

  // ── /wallet — show wallet address ───────────────────────────────
  if (cmdBase === '/wallet') {
    const addr = getAddress(telegramId);
    if (addr) {
      await tg('sendMessage', {
        chat_id:    chatId,
        text:       `🔐 *Your SAGE Wallet*\n\n\`${addr}\`\n\nNeed testnet SUI for gas? 👉 [n1stake Faucet](https://faucet.n1stake.com/)`,
        parse_mode: 'Markdown',
        disable_web_page_preview: true,
      });
    } else {
      await sendMessage(chatId, 'No wallet found. Send me any message to create one.');
    }
    return;
  }

  // ── /help ────────────────────────────────────────────────────────
  if (cmdBase === '/help') {
    await sendMessage(chatId,
      `*SAGE* trades BTC prediction markets on-chain for you.\n\n` +
      `Just talk naturally — no commands needed:\n\n` +
      `💬 _"bet $2 BTC goes up in 15 mins"_\n` +
      `💬 _"what's my balance?"_\n` +
      `💬 _"show my positions"_\n` +
      `💬 _"open the chart"_\n` +
      `💬 _"show leaderboard"_\n` +
      `💬 _"what's my P&L?"_\n\n` +
      `SAGE handles everything else automatically.`
    );
    return;
  }

  // ── Route everything (including old slash commands) to the AI ─────
  const agentMessage = text;

  // In groups, block private key export entirely
  if (isGroup && /private\s*key|secret\s*key|export.*key/i.test(text)) {
    await sendMessage(chatId, `🔒 Private key export is only available in a private chat with me.`);
    return;
  }

  tg('sendChatAction', { chat_id: chatId, action: 'typing' });

  try {
    const { text: reply, card, pendingTrade, pendingLadder, pendingWithdraw, startWizard } = await runAgent(telegramId, agentMessage, chatId);

    const deliverReply = async (txt) => {
      if (!txt) return;
      if (replyWithVoice) {
        try {
          const plain = txt.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/[*_`~]/g, '').replace(/\n+/g, ' ').trim();
          const ttsRes = await fetch('https://api.groq.com/openai/v1/audio/speech', {
            method:  'POST',
            headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: 'playai-tts', voice: 'Celeste-PlayAI', input: plain.slice(0, 4096), response_format: 'wav' }),
          });
          if (ttsRes.ok) {
            const audioBuf = Buffer.from(await ttsRes.arrayBuffer());
            const form = new FormData();
            form.append('chat_id', String(chatId));
            form.append('voice', new Blob([audioBuf], { type: 'audio/wav' }), 'reply.wav');
            await fetch(`${TELEGRAM_API}/sendVoice`, { method: 'POST', body: form });
            return;
          }
        } catch (e) { console.error('TTS error:', e.message); }
      }
      const kb = chartButton();
      const mentionsChart = /mini.?app|open.*app|tap.*app|chart|tradingview/i.test(txt);
      await sendMessage(chatId, txt, (kb && mentionsChart) ? { reply_markup: kb } : {});
    };

    if (pendingWithdraw) {
      await sendWithdrawPreview(chatId, telegramId, pendingWithdraw.toAddress, pendingWithdraw.amount);
      await deliverReply(reply);
    } else if (startWizard) {
      const wizText = `📊 *Quick trade explainer*\n\nYou pick UP or DOWN for BTC over a window of time. If you're right — you win the payout. If you're wrong — you lose your stake. No partial wins, no early exit.\n\nFirst, pick your timeframe:`;
      await tg('sendMessage', {
        chat_id: chatId,
        text: wizText,
        parse_mode: 'Markdown',
        reply_markup: durationKeyboard(),
      });
    } else if (pendingLadder) {
      await sendLadderPreview(chatId, pendingLadder.previewText);
      await deliverReply(reply);
    } else if (pendingTrade) {
      setPendingTrade(telegramId, pendingTrade.tradeParams);
      await sendTradePreview(chatId, pendingTrade.previewText);
      await deliverReply(reply);
    } else {
      if (card) await sendCard(chatId, card.type, card);
      await deliverReply(reply);
    }
  } catch (e) {
    console.error('Agent error:', e);
    await sendMessage(chatId, 'Something went wrong on my end. Try again in a moment.');
  }

  } catch (e) {
    console.error('Unhandled webhook error:', e);
    if (_emergencyChatId) await sendMessage(_emergencyChatId, 'Something went wrong. Try again.').catch(() => {});
  }
});

app.get('/health', (_, res) => res.json({ ok: true }));

// ── SVI data API ──────────────────────────────────────────────────
app.get('/api/svi', async (_, res) => {
  try {
    const { PREDICT_OBJECT, PREDICT_SERVER, PRICE_SCALE } = await import('./config.js');
    const oracles = await fetch(`${PREDICT_SERVER}/predicts/${PREDICT_OBJECT}/oracles`).then(r => r.json());
    const now = Date.now();
    const live = oracles
      .filter(o => o.status === 'active' && Number(o.expiry) > now && !o.settlement_price)
      .sort((a, b) => Number(a.expiry) - Number(b.expiry))
      .slice(0, 6);
    const results = await Promise.all(live.map(async o => {
      try {
        const state = await fetch(`${PREDICT_SERVER}/oracles/${o.oracle_id}/state`).then(r => r.json());
        if (!state?.latest_svi || !state?.latest_price) return null;
        return {
          oracleId: o.oracle_id,
          expiry:   Number(o.expiry),
          spot:     Number(state.latest_price.spot) / Number(PRICE_SCALE),
          svi: {
            a:            state.latest_svi.a,
            b:            state.latest_svi.b,
            rho:          state.latest_svi.rho,
            rho_negative: state.latest_svi.rho_negative,
            m:            state.latest_svi.m,
            m_negative:   state.latest_svi.m_negative,
            sigma:        state.latest_svi.sigma,
          },
        };
      } catch { return null; }
    }));
    res.json(results.filter(Boolean));
  } catch (e) { res.json({ error: e.message }); }
});

// ── Live odds API (ATM probability from DeepBook SVI oracle) ──────
app.get('/api/odds', async (_, res) => {
  try {
    const { PREDICT_OBJECT, PREDICT_SERVER } = await import('./config.js');
    const oracles = await fetch(`${PREDICT_SERVER}/predicts/${PREDICT_OBJECT}/oracles`).then(r => r.json());
    const now = Date.now();
    const live = oracles
      .filter(o => o.status === 'active' && Number(o.expiry) > now && !o.settlement_price)
      .sort((a, b) => Number(a.expiry) - Number(b.expiry))
      .slice(0, 3);

    const TF_MINS = [15, 30, 60];
    const results = await Promise.all(live.map(async (o, i) => {
      try {
        const tf      = ['15m', '30m', '60m'][i] || '60m';
        const mins    = TF_MINS[i] || 60;
        const quote   = await getQuote(mins, 10, 'up');
        const lvl     = quote.levels?.[1] || quote.levels?.[0];
        if (!lvl) return null;
        const upProb  = lvl.premium / lvl.face;
        return {
          tf,
          db: { pUp: Math.round(upProb * 100), pDown: Math.round((1 - upProb) * 100) },
          expiryMs: Number(o.expiry),
        };
      } catch { return null; }
    }));
    res.json(results.filter(Boolean));
  } catch (e) { res.json({ error: e.message }); }
});

// ── PLP risk panel API ─────────────────────────────────────────────
app.get('/api/risk', async (_, res) => {
  try {
    const { getOraclesList, getOracleState } = await import('./predict.js');
    const now = Date.now();
    const oracleList = await getOraclesList().catch(() => []);
    const liveOracles    = oracleList.filter(o => o.status === 'active' && Number(o.expiry) > now && !o.settlement_price);
    const settledOracles = oracleList.filter(o => !!o.settlement_price);
    let spot = null, priceAgeMs = null;
    if (liveOracles.length) {
      const state = await getOracleState(liveOracles[0].oracle_id).catch(() => null);
      if (state?.latest_price) {
        spot = Number(state.latest_price.spot) / 1e9;
        let ts = Number(state.latest_price.timestamp_ms || state.latest_price.timestamp || 0);
        // if timestamp looks like epoch seconds (< year 3000 in ms = 32503680000000), convert
        if (ts > 0 && ts < 1e12) ts = ts * 1000;
        priceAgeMs = ts > 0 ? now - ts : null;
      }
    }
    const allPositions = getAllUsersPositions();
    const allFlat      = Object.values(allPositions).flat();
    const openPos      = allFlat.filter(p => p.status === 'open');
    const allSettled   = allFlat.filter(p => ['won', 'lost', 'claimed'].includes(p.status));
    const allWins      = allSettled.filter(p => p.won || p.status === 'claimed');
    const recentSettlements = allFlat
      .filter(p => ['won', 'lost', 'claimed'].includes(p.status) && p.expiryMs)
      .sort((a, b) => b.expiryMs - a.expiryMs)
      .slice(0, 20)
      .map(p => ({
        direction: p.direction, strike: p.strike,
        outcome:   (p.won || p.status === 'claimed') ? 'won' : 'lost',
        payout:    (p.won || p.status === 'claimed') ? p.quantity : 0,
        premium: p.premium, expiryMs: p.expiryMs,
      }));
    res.json({
      oracle: {
        live: liveOracles.length, settled: settledOracles.length, spot,
        priceAgeSeconds: priceAgeMs ? +(priceAgeMs / 1000).toFixed(0) : null,
        healthy: liveOracles.length > 0 && (!priceAgeMs || priceAgeMs < 60_000),
      },
      openInterest: {
        positions:   openPos.length,
        totalFace:   +openPos.reduce((s, p) => s + (p.quantity || 0), 0).toFixed(2),
        totalStaked: +openPos.reduce((s, p) => s + (p.premium  || 0), 0).toFixed(2),
      },
      platform: {
        totalSettled: allSettled.length,
        winRate:      allSettled.length ? Math.round(allWins.length / allSettled.length * 100) : 0,
        totalVolume:  +allSettled.reduce((s, p) => s + (p.premium || 0), 0).toFixed(2),
      },
      recentSettlements,
    });
  } catch (e) { res.json({ error: e.message }); }
});

// ── Rolling BTC price history (filled by monitor interval) ───────
const priceHistory = []; // { t: timestamp_ms, p: price }
const MAX_HISTORY = 120;
let cachedStrikes = { up: null, down: null };

function recordPrice(price) {
  priceHistory.push({ t: Date.now(), p: price });
  if (priceHistory.length > MAX_HISTORY) priceHistory.shift();
}

app.get('/api/price-history', (_, res) => {
  res.json(priceHistory);
});

app.get('/api/klines', async (req, res) => {
  const interval = req.query.interval || '15m';
  const limit    = Math.min(parseInt(req.query.limit) || 100, 200);
  try {
    const now   = Date.now();
    const r     = await fetch(`https://api.mexc.com/api/v3/klines?symbol=BTCUSDT&interval=${interval}&limit=${limit}&endTime=${now}`);
    const data  = await r.json();
    res.json(data);
  } catch (e) { res.status(502).json({ error: e.message }); }
});


// ── Mini app: live quote strikes (served from cache, refreshed in bg)
app.get('/api/quote-strikes', (_, res) => res.json(cachedStrikes));

async function refreshStrikes() {
  try {
    const [up, down] = await Promise.all([
      getQuote(30, 5, 'up').catch(() => null),
      getQuote(30, 5, 'down').catch(() => null),
    ]);
    if (up)   cachedStrikes.up   = up.levels[1]?.strike   ?? up.levels[0]?.strike;
    if (down) cachedStrikes.down = down.levels[1]?.strike ?? down.levels[0]?.strike;
  } catch {}
}

// ── Mini app: chart positions API ────────────────────────────────
app.get('/api/chart-positions', (req, res) => {
  try {
    const user = validateTelegramInitData(req.query.initData || '');
    if (!user) return res.json([]);
    const positions = getPositions(String(user.id))
      .filter(p => p.status === 'open')
      .map(p => ({ strike: p.strike, direction: p.direction }));
    res.json(positions);
  } catch { res.json([]); }
});

// ── Mini app: BTC chart ───────────────────────────────────────────
app.get('/app', (_, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  const username = botUsername || 'sagebot';
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1,user-scalable=no">
<title>SAGE · BTC</title>
<script src="https://cdn.jsdelivr.net/npm/lightweight-charts@4.2.0/dist/lightweight-charts.standalone.production.js" async></script>
<style>
*{margin:0;padding:0;box-sizing:border-box}
html,body{height:100%;background:#0b0e11;overflow:hidden}
body{display:flex;flex-direction:column;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#fff}
#header{padding:8px 14px 6px;flex-shrink:0}
#price{font-size:22px;font-weight:700;letter-spacing:-0.5px}
#meta{display:flex;align-items:center;gap:8px;margin-top:2px}
#change{font-size:11px;font-weight:600;padding:2px 6px;border-radius:3px}
#change.up{background:rgba(14,203,129,.15);color:#0ecb81}
#change.down{background:rgba(246,70,93,.15);color:#f6465d}
#sub{font-size:10px;color:#5e6673}
#chart{flex:1;min-height:0}
a[href*="tradingview"]{display:none!important}
#tabs{display:flex;border-top:1px solid #1e2329;flex-shrink:0;position:relative;z-index:100}
.tab{flex:1;padding:9px 0;background:none;border:none;border-top:2px solid transparent;color:#5e6673;font-size:11px;font-weight:600;letter-spacing:.5px;cursor:pointer;text-transform:uppercase}
.tab.active{color:#2962ff;border-top-color:#2962ff}
#pane-vol{flex:1;min-height:0;display:none;flex-direction:column;overflow:hidden}
#vol-header{padding:8px 14px 4px;flex-shrink:0}
#vol-title{font-size:13px;font-weight:700;color:#e2e8f0}
#vol-sub{font-size:10px;color:#5e6673;margin-top:2px}
#vol-wrap{flex:1;min-height:0;padding:0 8px 8px;position:relative}
#odds-strip::-webkit-scrollbar{display:none}
.odds-pill{flex-shrink:0;background:#161a20;border-radius:6px;padding:4px 8px;font-size:10px;white-space:nowrap}
.odds-pill .exp{color:#5e6673;font-size:9px;margin-bottom:2px}
.odds-pill .up-pct{color:#0ecb81;font-weight:700}
.odds-pill .dn-pct{color:#f6465d;font-weight:700}
#smile-canvas{display:block;width:100%;height:100%}
#vol-legend{position:absolute;top:8px;right:14px;display:flex;flex-direction:column;gap:4px}
.leg{display:flex;align-items:center;gap:5px;font-size:9px;color:#5e6673}
.leg-dot{width:8px;height:8px;border-radius:50%;flex-shrink:0}
</style>
</head>
<body>
<div id="header">
  <div id="price">—</div>
  <div id="meta"><span id="change" class="up">+0.00%</span><span id="sub">BTC/USD · 15m</span></div>
  <div id="odds-strip" style="display:flex;gap:6px;margin-top:6px;overflow-x:auto;padding-bottom:2px"></div>
</div>
<div id="chart"></div>
<div id="pane-vol">
  <div id="vol-header">
    <div id="vol-title">Volatility Smile</div>
    <div id="vol-sub">Implied vol by strike — DeepBook SVI oracle</div>
  </div>
  <div id="vol-wrap"><canvas id="smile-canvas"></canvas><div id="vol-legend"></div></div>
  <div id="vol-sage" style="margin:10px 10px 0;background:#161a20;border-radius:8px;padding:10px 12px;border-left:3px solid #f7931a">
    <div style="color:#f7931a;font-size:10px;letter-spacing:.08em;margin-bottom:5px">SAGE SAYS</div>
    <div id="vol-sage-text" style="color:#eaecef;font-size:11px;line-height:1.5">Loading interpretation…</div>
  </div>
</div>
<div id="risk-panel" style="display:none;padding:12px 10px;overflow-y:auto">
  <div id="risk-oracle" style="margin-bottom:12px"></div>
  <div id="risk-oi" style="margin-bottom:12px"></div>
  <div id="risk-platform" style="margin-bottom:12px"></div>
  <div id="risk-history" style="margin-bottom:12px"></div>
  <div id="risk-sage" style="background:#161a20;border-radius:8px;padding:10px 12px;border-left:3px solid #f7931a">
    <div style="color:#f7931a;font-size:10px;letter-spacing:.08em;margin-bottom:5px">SAGE SAYS</div>
    <div id="risk-sage-text" style="color:#eaecef;font-size:11px;line-height:1.5">Loading interpretation…</div>
  </div>
</div>
<div id="tabs">
  <button class="tab active" onclick="switchTab('price')">Price</button>
  <button class="tab" onclick="switchTab('vol')">Vol Smile</button>
  <button class="tab" onclick="switchTab('risk')">Risk</button>
</div>
<script>
const tg=window.Telegram?.WebApp;
if(tg){tg.expand();tg.ready();try{tg.setBackgroundColor('#0b0e11');tg.setHeaderColor('#0b0e11')}catch(e){}}
window.onerror=function(msg,src,line){
  const d=document.createElement('div');
  d.style='position:fixed;top:0;left:0;right:0;background:#f6465d;color:#fff;font-size:11px;padding:6px 10px;z-index:9999;word-break:break-all';
  d.textContent='JS ERROR: '+msg+' (line '+line+')';
  document.body.appendChild(d);
  return false;
};

let chart,series,firstOpen=null,priceLines=[],chartData=[],activeTf='15m',activeWs=null;

function initChart(){
  const el=document.getElementById('chart');
  chart=LightweightCharts.createChart(el,{
    autoSize:true,
    layout:{background:{color:'#0b0e11'},textColor:'#5e6673',fontSize:11},
    grid:{vertLines:{color:'#1a1d23'},horzLines:{color:'#1a1d23'}},
    crosshair:{mode:LightweightCharts.CrosshairMode.Normal},
    rightPriceScale:{borderColor:'#1e2329',scaleMargins:{top:0.15,bottom:0.15}},
    timeScale:{borderColor:'#1e2329',timeVisible:true,secondsVisible:false,rightOffset:5,barSpacing:6},
  });
  series=chart.addAreaSeries({
    lineColor:'#2962ff',
    topColor:'rgba(41,98,255,0.25)',
    bottomColor:'rgba(41,98,255,0.0)',
    lineWidth:2,
    lineType:LightweightCharts.LineType.Curved,
    crosshairMarkerVisible:true,
    crosshairMarkerRadius:4,
    priceLineVisible:true,
    lastValueVisible:true,
  });
}

function updateHeader(price){
  document.getElementById('price').textContent='$'+price.toLocaleString('en-US',{maximumFractionDigits:0});
  if(firstOpen!==null){
    const pct=(price-firstOpen)/firstOpen*100;
    const el=document.getElementById('change');
    el.textContent=(pct>=0?'+':'')+pct.toFixed(2)+'%';
    el.className=pct>=0?'up':'down';
  }
}

const TF_MAP={'15m':{rest:'15m',ws:'Min15',mins:15},'30m':{rest:'30m',ws:'Min30',mins:30},'60m':{rest:'60m',ws:'Min60',mins:60}};

async function loadData(tf){
  tf=tf||activeTf;
  const {rest,mins}=TF_MAP[tf]||TF_MAP['15m'];
  const now=Date.now();const start=now-100*mins*60*1000;
  document.getElementById('sub').textContent='BTC/USD · '+tf;
  try{
    const r=await fetch('/api/klines?interval='+rest+'&limit=100');
    const data=await r.json();
    if(!Array.isArray(data)||!data.length)throw new Error('empty');
    const pts=data.map(d=>({time:Math.floor(d[0]/1000),value:parseFloat(d[4])}));
    chartData=pts;
    series.setData(pts);
    chart.timeScale().fitContent();chart.timeScale().scrollToRealTime();
    firstOpen=parseFloat(data[0][1]);
    updateHeader(parseFloat(data[data.length-1][4]));
    return true;
  }catch(e){console.warn('klines failed, using oracle data');}
  try{
    const r=await fetch('/api/price-history');
    const hist=await r.json();
    if(!hist.length)return false;
    const pts=hist.map(h=>({time:Math.floor(h.t/1000),value:h.p}));
    chartData=pts;series.setData(pts);
    chart.timeScale().fitContent();chart.timeScale().scrollToRealTime();
    firstOpen=pts[0].value;updateHeader(pts[pts.length-1].value);
    return true;
  }catch(e){return false;}
}

function connectWS(tf){
  tf=tf||activeTf;
  if(activeWs){try{activeWs.close();}catch{}}
  const{ws:wsSuffix}=TF_MAP[tf]||TF_MAP['15m'];
  try{
    const ws=new WebSocket('wss://wbs.mexc.com/ws');
    activeWs=ws;
    ws.onopen=()=>ws.send(JSON.stringify({method:'SUBSCRIPTION',params:['spot@public.kline.v3.api@BTCUSDT@'+wsSuffix]}));
    ws.onmessage=(e)=>{
      try{
        const msg=JSON.parse(e.data);
        const k=msg.d?.k;
        if(k){
          const price=parseFloat(k.c);
          const pt={time:Math.floor(k.t/1000),value:price};
          series.update(pt);
          if(chartData.length&&chartData[chartData.length-1].time===pt.time)chartData[chartData.length-1]=pt;
          else chartData.push(pt);
          updateHeader(price);
        }
      }catch{}
    };
    ws.onclose=()=>{if(activeWs===ws)setTimeout(()=>connectWS(activeTf),3000);};
  }catch(e){setTimeout(()=>connectWS(activeTf),5000);}
}

async function switchTf(tf){
  activeTf=tf;
  document.querySelectorAll('.odds-pill').forEach(p=>{
    p.style.border=p.dataset.tf===tf?'1px solid #f7931a':'1px solid transparent';
  });
  await loadData(tf);
  connectWS(tf);
}

async function loadPositions(){
  try{
    for(const l of priceLines)series.removePriceLine(l);
    priceLines=[];
    const r=await fetch('/api/chart-positions?'+(tg?.initData?new URLSearchParams({initData:tg.initData}):''));
    const positions=await r.json();
    for(const p of positions){
      const l=series.createPriceLine({
        price:p.strike,
        color:p.direction==='up'?'#0ecb81':'#f6465d',
        lineWidth:2,
        lineStyle:LightweightCharts.LineStyle.Dashed,
        axisLabelVisible:true,
        title:(p.direction==='up'?'↑ ':'↓ ')+'$'+p.strike.toLocaleString('en-US',{maximumFractionDigits:0}),
      });
      priceLines.push(l);
    }
  }catch(e){}
}


let oddsExpiries=[];
function fmtCountdown(ms){
  const s=Math.max(0,Math.floor(ms/1000));
  const m=Math.floor(s/60),sec=s%60;
  return m>0?m+'m '+String(sec).padStart(2,'0')+'s':sec+'s';
}
function tickCountdowns(){
  const now=Date.now();
  oddsExpiries.forEach(({tf,expiryMs})=>{
    const el=document.getElementById('cd-'+tf);
    if(el)el.textContent=fmtCountdown(expiryMs-now);
  });
}
setInterval(tickCountdowns,1000);

async function loadOdds(){
  try{
    const r=await fetch('/api/odds');
    const data=await r.json();
    const strip=document.getElementById('odds-strip');
    if(!strip||!data.length)return;
    oddsExpiries=data.map(d=>({tf:d.tf,expiryMs:d.expiryMs}));
    strip.innerHTML=data.map(d=>{
      const dbCol=d.db.pUp>d.db.pDown?'#0ecb81':'#f6465d';
      const active=d.tf===activeTf;
      return '<div class="odds-pill" data-tf="'+d.tf+'" onclick="switchTf(this.dataset.tf)" style="cursor:pointer;border:1px solid '+(active?'#f7931a':'transparent')+';transition:border .2s"><div class="exp">'+d.tf+' · <span id="cd-'+d.tf+'" style="color:#f7931a">–</span></div><span style="color:'+dbCol+';font-weight:700">'+d.db.pUp+'%↑</span> <span style="color:#5e6673;font-size:9px">·</span> <span style="color:'+dbCol+';font-weight:700">'+d.db.pDown+'%↓</span></div>';
    }).join('');
    tickCountdowns();
  }catch(e){}
}

function tryInitChart(){
  if(typeof LightweightCharts==='undefined'){setTimeout(tryInitChart,300);return;}
  try{initChart();}catch(e){console.warn('Chart init failed:',e);return;}
  loadData(activeTf).then(ok=>{if(ok){connectWS(activeTf);loadPositions();}});
}
setTimeout(tryInitChart,150);
loadOdds();
setInterval(loadOdds,30000);
setInterval(()=>{try{loadPositions();}catch(e){}},15000);

// ── Tab switching ─────────────────────────────────────────────────
function switchTab(tab){
  const tabs=document.querySelectorAll('.tab');
  tabs.forEach((t,i)=>t.classList.toggle('active',(tab==='price'&&i===0)||(tab==='vol'&&i===1)||(tab==='risk'&&i===2)));
  const chartEl=document.getElementById('chart');
  const volEl=document.getElementById('pane-vol');
  const riskEl=document.getElementById('risk-panel');
  chartEl.style.display  = tab==='price' ? '' : 'none';
  volEl.style.display    = tab==='vol'   ? 'flex' : 'none';
  riskEl.style.display   = tab==='risk'  ? 'block' : 'none';
  if(tab==='vol')  loadSmile();
  if(tab==='risk') loadRisk();
}

async function loadRisk(){
  const [oEl,oiEl,platEl,histEl]=['risk-oracle','risk-oi','risk-platform','risk-history'].map(id=>document.getElementById(id));
  const card=(title,rows)=>'<div style="background:#161a20;border-radius:8px;padding:10px 12px;margin-bottom:8px"><div style="color:#848e9c;font-size:10px;letter-spacing:.08em;margin-bottom:6px">'+title+'</div>'+rows.map(function(r){var k=r[0],v=r[1],c=r[2]||'#eaecef';return '<div style="display:flex;justify-content:space-between;padding:2px 0"><span style="color:#848e9c;font-size:11px">'+k+'</span><span style="color:'+c+';font-size:11px;font-weight:600">'+v+'</span></div>';}).join('')+'</div>';
  try{
    const r=await fetch('/api/risk');
    const d=await r.json();
    if(d.error){oEl.innerHTML='<div style="color:#f6465d;font-size:11px">'+d.error+'</div>';return;}
    const {oracle,openInterest,platform,recentSettlements}=d;
    oEl.innerHTML=card('ORACLE HEALTH',[
      ['Status', oracle.healthy?'✅ Healthy':'⚠️ Degraded', oracle.healthy?'#0ecb81':'#f6465d'],
      ['Live oracles', oracle.live, '#eaecef'],
      ['BTC spot', oracle.spot?'$'+oracle.spot.toLocaleString('en-US',{maximumFractionDigits:0}):'–'],
      ['Price age', oracle.priceAgeSeconds!=null?(oracle.priceAgeSeconds<5?'<5s ago':oracle.priceAgeSeconds<60?oracle.priceAgeSeconds+'s ago':Math.round(oracle.priceAgeSeconds/60)+'m ago'):'–', oracle.priceAgeSeconds>30?'#f7931a':'#0ecb81'],
    ]);
    oiEl.innerHTML=card('OPEN INTEREST',[
      ['Open positions', openInterest.positions],
      ['Total face at risk', '$'+openInterest.totalFace.toLocaleString('en-US',{maximumFractionDigits:2})],
      ['Total staked', '$'+openInterest.totalStaked.toLocaleString('en-US',{maximumFractionDigits:2})],
    ]);
    platEl.innerHTML=card('PLATFORM STATS',[
      ['All-time volume', '$'+platform.totalVolume.toLocaleString('en-US',{maximumFractionDigits:2})],
      ['Settled trades', platform.totalSettled],
      ['Win rate', platform.winRate+'%', platform.winRate>=50?'#0ecb81':'#f6465d'],
    ]);
    if(recentSettlements&&recentSettlements.length){
      const rows=recentSettlements.slice(0,10).map(s=>{
        const t=new Date(s.expiryMs).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit',hour12:false,timeZone:'UTC'});
        const dir=s.direction==='up'?'📈':'📉';
        const out=s.outcome==='won'?'<span style="color:#0ecb81">WIN</span>':'<span style="color:#f6465d">LOSS</span>';
        const strike='$'+Number(s.strike).toLocaleString('en-US',{maximumFractionDigits:0});
        return '<div style="display:flex;justify-content:space-between;align-items:center;padding:4px 0;border-bottom:1px solid #1e2329;font-size:11px"><span style="color:#848e9c">'+t+'</span><span>'+dir+' '+strike+'</span>'+out+'</div>';
      }).join('');
      histEl.innerHTML='<div style="background:#161a20;border-radius:8px;padding:10px 12px"><div style="color:#848e9c;font-size:10px;letter-spacing:.08em;margin-bottom:6px">RECENT SETTLEMENTS</div>'+rows+'</div>';
    } else {
      histEl.innerHTML='<div style="color:#848e9c;font-size:11px;text-align:center;margin-top:8px">No settlements yet</div>';
    }
    // SAGE natural language commentary
    const sageEl = document.getElementById('risk-sage-text');
    const lines = [];
    if (oracle.live >= 15) lines.push('Oracle network is healthy — ' + oracle.live + ' live feeds pricing the market in real time.');
    else if (oracle.live > 0) lines.push('Oracle coverage is thin right now with only ' + oracle.live + ' live feeds — prices may be less precise.');
    else lines.push('No live oracles detected — trading may be unavailable right now.');
    if (openInterest.positions === 0) lines.push('No open positions on the platform yet — you would be the first in, meaning no crowded trades.');
    else lines.push('$' + openInterest.totalFace.toLocaleString('en-US', {maximumFractionDigits:0}) + ' face value at risk across ' + openInterest.positions + ' open position' + (openInterest.positions !== 1 ? 's' : '') + '.');
    if (platform.totalSettled === 0) lines.push('No settled trades yet — win rate will update once positions expire.');
    else if (platform.winRate >= 55) lines.push('Platform win rate is ' + platform.winRate + '% — traders are reading the market well.');
    else if (platform.winRate >= 45) lines.push('Win rate sitting at ' + platform.winRate + '% — close to even money, market is competitive.');
    else lines.push('Win rate at ' + platform.winRate + '% — market has been tough lately. Pick your strikes carefully.');
    sageEl.innerHTML = lines.join(' ');
  }catch(e){oEl.innerHTML='<div style="color:#f6465d;font-size:11px">'+e.message+'</div>';}
}

// ── SVI smile chart ───────────────────────────────────────────────
const COLORS=['#2962ff','#f6465d','#0ecb81','#f7931a','#a855f7','#06b6d4'];

function sviIV(strike,spot,svi,expiryMs){
  const T=(expiryMs-Date.now())/(365.25*24*3600*1000);
  if(T<=0.00001)return null;
  const k=Math.log(strike/spot);
  const a=svi.a/1e8, b=svi.b/1e8;
  const rho=(svi.rho_negative?-1:1)*svi.rho/1e9;
  const m=(svi.m_negative?-1:1)*svi.m/1e9;
  const sig=svi.sigma/1e8;
  const w=a+b*(rho*(k-m)+Math.sqrt((k-m)**2+sig**2));
  if(w<=0)return null;
  return Math.sqrt(w/T)*100;
}

function drawSmile(data){
  const canvas=document.getElementById('smile-canvas');
  const wrap=document.getElementById('vol-wrap');
  const W=wrap.clientWidth, H=wrap.clientHeight;
  canvas.width=W*devicePixelRatio; canvas.height=H*devicePixelRatio;
  canvas.style.width=W+'px'; canvas.style.height=H+'px';
  const ctx=canvas.getContext('2d');
  ctx.scale(devicePixelRatio,devicePixelRatio);

  const PAD={t:16,r:16,b:36,l:44};
  const cw=W-PAD.l-PAD.r, ch=H-PAD.t-PAD.b;

  ctx.fillStyle='#0b0e11';
  ctx.fillRect(0,0,W,H);

  if(!data.length){
    ctx.fillStyle='#5e6673';ctx.font='12px sans-serif';ctx.textAlign='center';
    ctx.fillText('No oracle data',W/2,H/2);return;
  }

  const spot=data[0].spot;
  const strikeMin=spot*0.94, strikeMax=spot*1.06;
  const POINTS=60;

  // Collect all IV values to find Y range
  let ivMin=Infinity, ivMax=-Infinity;
  const series=data.map((d,di)=>{
    const pts=[];
    for(let i=0;i<=POINTS;i++){
      const s=strikeMin+(strikeMax-strikeMin)*i/POINTS;
      const iv=sviIV(s,d.spot,d.svi,d.expiry);
      if(iv!==null&&iv>0&&iv<2000){pts.push({s,iv});ivMin=Math.min(ivMin,iv);ivMax=Math.max(ivMax,iv);}
    }
    return pts;
  });
  if(ivMin===Infinity){ctx.fillStyle='#5e6673';ctx.font='12px sans-serif';ctx.textAlign='center';ctx.fillText('Calculating...',W/2,H/2);return;}

  const ivPad=(ivMax-ivMin)*0.1||5;
  ivMin-=ivPad; ivMax+=ivPad;

  const toX=s=>PAD.l+(s-strikeMin)/(strikeMax-strikeMin)*cw;
  const toY=iv=>PAD.t+(1-(iv-ivMin)/(ivMax-ivMin))*ch;

  // Grid
  ctx.strokeStyle='#1a1d23'; ctx.lineWidth=1;
  for(let i=0;i<=4;i++){
    const y=PAD.t+ch*i/4;
    ctx.beginPath();ctx.moveTo(PAD.l,y);ctx.lineTo(PAD.l+cw,y);ctx.stroke();
    const iv=ivMax-(ivMax-ivMin)*i/4;
    ctx.fillStyle='#5e6673';ctx.font='9px sans-serif';ctx.textAlign='right';
    ctx.fillText(iv.toFixed(0)+'%',PAD.l-4,y+3);
  }

  // Spot line
  const sx=toX(spot);
  ctx.strokeStyle='#3a4a6b';ctx.lineWidth=1;ctx.setLineDash([3,3]);
  ctx.beginPath();ctx.moveTo(sx,PAD.t);ctx.lineTo(sx,PAD.t+ch);ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle='#5e6673';ctx.font='9px sans-serif';ctx.textAlign='center';
  ctx.fillText('$'+Math.round(spot/1000)+'k',sx,PAD.t+ch+14);

  // Strike labels (3 points)
  [strikeMin,spot,strikeMax].forEach(s=>{
    ctx.fillStyle='#3a4a6b';ctx.font='9px sans-serif';ctx.textAlign='center';
    ctx.fillText('$'+s.toLocaleString('en-US',{maximumFractionDigits:0}),toX(s),PAD.t+ch+26);
  });

  // Draw IV curves
  series.forEach((pts,di)=>{
    if(!pts.length)return;
    ctx.strokeStyle=COLORS[di%COLORS.length];ctx.lineWidth=2;
    ctx.beginPath();
    pts.forEach((p,i)=>{i===0?ctx.moveTo(toX(p.s),toY(p.iv)):ctx.lineTo(toX(p.s),toY(p.iv))});
    ctx.stroke();
  });

  // Spot IV dot for nearest expiry
  const nearestIV=sviIV(spot,data[0].spot,data[0].svi,data[0].expiry);
  if(nearestIV){
    ctx.fillStyle=COLORS[0];
    ctx.beginPath();ctx.arc(toX(spot),toY(nearestIV),4,0,Math.PI*2);ctx.fill();
  }

  // Legend
  const legend=document.getElementById('vol-legend');
  legend.innerHTML=data.map((d,i)=>{
    const minsLeft=Math.round((d.expiry-Date.now())/60000);
    return '<div class="leg"><div class="leg-dot" style="background:'+COLORS[i%COLORS.length]+'"></div>'+minsLeft+'m</div>';
  }).join('');
}

function describeSmile(data){
  const el=document.getElementById('vol-sage-text');
  if(!data.length){el.innerHTML='No oracle data available right now.';return;}
  const spot=data[0].spot;
  const nearestIV=sviIV(spot,spot,data[0].svi,data[0].expiry);
  const nearestExpMins=Math.round((data[0].expiry-Date.now())/60000);
  const lines=[];
  if(nearestIV) lines.push('At-the-money vol for the nearest expiry ('+nearestExpMins+'m) is '+nearestIV.toFixed(1)+'% annualised — this is how much the market is pricing in uncertainty right now.');
  lines.push('The curve rises steeply away from spot — meaning the further your strike is from the current price, the more expensive the option per dollar of payout. Strikes close to spot offer the best cost efficiency.');
  if(data.length>1){
    const longerIV=sviIV(spot,spot,data[data.length-1].svi,data[data.length-1].expiry);
    if(longerIV&&nearestIV){
      if(longerIV>nearestIV) lines.push('Longer expiries carry higher vol ('+longerIV.toFixed(1)+'% for the '+Math.round((data[data.length-1].expiry-Date.now())/60000)+'m) — more time means more uncertainty priced in.');
      else lines.push('Vol is flatter across expiries — the market is not pricing in significantly more uncertainty for longer windows right now.');
    }
  }
  el.innerHTML=lines.join(' ');
}

async function loadSmile(){
  try{
    const r=await fetch('/api/svi');
    const data=await r.json();
    if(data.error||!data.length){drawSmile([]);describeSmile([]);return;}
    drawSmile(data);
    describeSmile(data);
  }catch(e){drawSmile([]);document.getElementById('vol-sage-text').innerHTML='Could not load oracle data.';}
}
</script>
</body>
</html>`;
  res.setHeader('Content-Type', 'text/html');
  res.send(html);
});

// ── Re-check 'won' positions against real oracle state on startup ─
async function revalidateWonPositions() {
  const allByUser = getAllUsersPositions();
  const all = [];
  for (const [telegramId, positions] of Object.entries(allByUser)) {
    for (const pos of positions) {
      if (pos.status === 'won' || (pos.status === 'claimed' && pos.won === true && !pos.claimDigest)) {
        all.push({ telegramId, ...pos });
      }
    }
  }
  if (!all.length) return;
  console.log(`[revalidate] checking ${all.length} position(s)…`);
  for (const pos of all) {
    try {
      const state = await getOracleState(pos.oracleId);
      const rawSettlement = state.oracle?.settlement_price || state.settlement_price;
      if (!rawSettlement || rawSettlement === '0') continue;
      const settlementPrice = Number(rawSettlement) / Number(PRICE_SCALE);
      if (settlementPrice < 1000) continue;
      const dir = (pos.direction || '').toLowerCase();
      const won = dir === 'down' ? settlementPrice < pos.strike : settlementPrice > pos.strike;
      if (!won) {
        console.log(`[revalidate] pos ${pos.id} corrected to lost (settled $${settlementPrice.toFixed(0)}, strike $${pos.strike}, dir ${dir})`);
        updatePosition(pos.telegramId, pos.id, { status: 'lost', won: false, settlementPrice });
        const chatId = pos.chatId || pos.telegramId;
        const strikeFmt = `$${pos.strike.toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
        const priceFmt  = `$${settlementPrice.toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
        await sendCard(chatId, 'loss', {
          payout: pos.quantity, cost: pos.premium,
          label: `BTC/USD ${dir === 'down' ? 'did not drop below' : 'did not rise above'} ${strikeFmt}`,
          caption: `📊 Correction: BTC settled at ${priceFmt}, not below ${strikeFmt}. This position lost. Sorry for the confusion.`,
        });
      }
    } catch (e) {
      console.error(`[revalidate] error for pos ${pos.id}:`, e.message);
    }
  }
}

// ── Position monitor ──────────────────────────────────────────────
async function monitorPositions() {
  const positions = getAllActivePositions();
  const now = Date.now();

  for (const pos of positions) {
    if (pos.expiryMs > now) continue;
    try {
      const state = await getOracleState(pos.oracleId);
      // settlement_price lives under state.oracle, not top-level (top-level is always "")
      const rawSettlement = state.oracle?.settlement_price || state.settlement_price;
      // Reject missing, "0", or implausibly small prices (oracle not yet finalized)
      if (!rawSettlement || rawSettlement === '0') continue;
      const settlementPrice = Number(rawSettlement) / Number(PRICE_SCALE);
      if (settlementPrice < 1000) continue; // BTC will never be < $1000; guards against partial data

      const dir = (pos.direction || '').toLowerCase();
      const won = dir === 'down' ? settlementPrice < pos.strike : settlementPrice > pos.strike;

      updatePosition(pos.telegramId, pos.id, { status: won ? 'won' : 'lost', settlementPrice, won });

      const priceFmt  = `$${settlementPrice.toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
      const strikeFmt = `$${pos.strike.toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
      const chatId    = pos.chatId || pos.telegramId;

      const label = `BTC/USD ${dir === 'down' ? 'dropped below' : 'rose above'} ${strikeFmt} in ${pos.duration || 15} min`;

      if (won) {
        const streak = updateStreak(pos.telegramId);
        const MILESTONES = [3, 5, 7, 10, 14, 21, 30];
        const milestone  = MILESTONES.includes(streak.count) ? streak.count : null;
        const streakLine = milestone
          ? `\n🔥 *${milestone}-day winning streak!* You're on fire.`
          : streak.count >= 2
          ? `\n🔥 ${streak.count}-day streak`
          : '';
        const shareText = encodeURIComponent(
          `I just won $${pos.quantity.toFixed(2)} on SAGE — BTC prediction markets on Sui.\n` +
          `$${pos.premium.toFixed(2)} in → $${pos.quantity.toFixed(2)} out (${(pos.quantity / pos.premium).toFixed(1)}x)\n\n` +
          `Trade on @sagepredict_bot`
        );
        const shareUrl  = `https://t.me/share/url?url=https%3A%2F%2Ft.me%2Fsagepredict_bot&text=${shareText}`;
        const shareBtn  = { text: '📢 Share win', url: shareUrl };
        try {
          const keypair   = getKeypair(pos.telegramId);
          const address   = getAddress(pos.telegramId);
          const managerId = pos.managerId || getManagerId(pos.telegramId);
          const timeout   = new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 55_000));
          const result    = await Promise.race([redeemPosition(keypair, address, managerId, pos.oracleId, pos.expiryMs, pos.strike, pos.direction, pos.quantity), timeout]);
          const claimedAmount = result.quantityBig ? Number(result.quantityBig) / 1e6 : pos.quantity;
          updatePosition(pos.telegramId, pos.id, { status: 'claimed', claimDigest: result.digest, claimedAmount });
          await sendCard(chatId, 'win', {
            payout: claimedAmount, cost: pos.premium, label,
            caption: `🎯 *+$${claimedAmount.toFixed(2)} dUSDC* claimed!${streakLine}\n[View on-chain](https://suiscan.xyz/testnet/tx/${result.digest})`,
            extra: { reply_markup: { inline_keyboard: [[shareBtn]] } },
          });
        } catch {
          await sendCard(chatId, 'win', {
            payout: pos.quantity, cost: pos.premium, label,
            caption: `🎯 *You won $${pos.quantity.toFixed(2)} dUSDC!*${streakLine} Tap below to claim.`,
            extra: { reply_markup: { inline_keyboard: [[{ text: '💰 Claim winnings', callback_data: `claim_pos_${pos.id}` }], [shareBtn]] } },
          });
        }
      } else {
        await sendCard(chatId, 'loss', {
          payout: pos.quantity, cost: pos.premium, label,
          caption: `BTC settled at ${priceFmt}. Cost: $${pos.premium.toFixed(2)}. Next call?`,
        });
      }
    } catch (e) {
      console.error('Monitor error:', e.message);
    }
  }
}

// ── Price alerts ──────────────────────────────────────────────────
async function checkAlerts() {
  const alerts = getAllAlerts();
  if (!alerts.length) return;
  const price = await getBtcPrice().catch(() => null);
  if (!price) return;

  for (const alert of alerts) {
    const triggered = alert.direction === 'above' ? price >= alert.price : price <= alert.price;
    if (!triggered) continue;

    const chatId = alert.chatId || alert.telegramId;
    await sendMessage(chatId,
      `🔔 *Price Alert*\n\nBTC just hit $${price.toLocaleString('en-US', { maximumFractionDigits: 0 })} — your ${alert.direction} $${alert.price.toLocaleString()} alert triggered.\n\nWant to open a position?`
    );
    removeAlert(alert.telegramId, alert.id);
  }
}

// ── Auto-predict ──────────────────────────────────────────────────
async function runAutoPredict() {
  const configs = getAllAutoPredict();
  for (const cfg of configs) {
    if (!cfg.active) continue;
    // Only run if last position has expired (or never run)
    const now = Date.now();
    if (cfg.lastRun && now - cfg.lastRun < cfg.duration * 60 * 1000) continue;

    try {
      const keypair   = getKeypair(cfg.telegramId);
      const address   = getAddress(cfg.telegramId);
      const managerId = getManagerId(cfg.telegramId);
      if (!keypair || !address) continue;

      const quote = await getQuote(cfg.duration, cfg.amount, cfg.direction);
      const lvl   = quote.levels[0]; // always use Safe Hedge tier for auto

      const result = await openPosition(keypair, address, managerId, quote.oracleId, quote.expiryMs, lvl.strike, cfg.direction, cfg.amount, lvl.premium);

      const { savePosition, setAutoPredict } = await import('./db.js');
      savePosition(cfg.telegramId, {
        oracleId: quote.oracleId, expiryMs: quote.expiryMs,
        strike: lvl.strike, direction: cfg.direction,
        quantity: cfg.amount, premium: lvl.premium,
        managerId: result.managerId || managerId,
        digest: result.digest, chatId: cfg.chatId, status: 'open',
      });
      setAutoPredict(cfg.telegramId, { ...cfg, lastRun: now, managerId: result.managerId || managerId });

      const expireAt = new Date(quote.expiryMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      await sendMessage(cfg.chatId || cfg.telegramId,
        `🤖 *Auto-predict fired*\n\n${cfg.direction.toUpperCase()} $${lvl.strike.toLocaleString('en-US', { maximumFractionDigits: 0 })} · costs $${lvl.premium.toFixed(2)} · expires ${expireAt}\n\n[View on-chain](https://suiscan.xyz/testnet/tx/${result.digest})`
      );
    } catch (e) {
      console.error('Auto-predict error:', cfg.telegramId, e.message);
    }
  }
}

// ── Arb auto-trade ────────────────────────────────────────────────
async function runArbAuto() {
  const { getAllArbAuto, setArbAuto, savePosition, getBudget, recordSpend } = await import('./db.js');
  const { checkArbSignal } = await import('./arb.js');

  const configs = getAllArbAuto().filter(c => c.active);
  if (!configs.length) return;

  // Group configs by duration so we only fetch each signal once
  const durations = [...new Set(configs.map(c => c.duration || 15))];
  const signalMap = {};
  for (const dur of durations) {
    signalMap[dur] = await checkArbSignal(dur);
  }

  const todayUTC = new Date().toISOString().slice(0, 10);

  for (const cfg of configs) {
    const signal = signalMap[cfg.duration || 15];
    if (!signal) continue;

    // Reset daily counter if new day
    if (cfg.lastTradeDate !== todayUTC) {
      cfg.tradesToday  = 0;
      cfg.lastTradeDate = todayUTC;
    }

    // Daily cap check
    if (cfg.maxTradesPerDay && cfg.tradesToday >= cfg.maxTradesPerDay) continue;

    try {
      const keypair   = getKeypair(cfg.telegramId);
      const address   = getAddress(cfg.telegramId);
      const managerId = getManagerId(cfg.telegramId);
      if (!keypair || !address) continue;

      const budget = getBudget(cfg.telegramId);
      if (budget && budget.spent + cfg.amount > budget.limit) {
        await sendMessage(cfg.chatId, `⚡ Arb signal fired but you've hit your daily budget ($${budget.limit}). Increase it to auto-trade.`);
        continue;
      }

      const quote = await getQuote(signal.durationMins, cfg.amount, signal.direction);
      const lvl   = quote.levels?.[1] || quote.levels?.[0];
      if (!lvl) continue;

      const result = await openPosition(keypair, address, managerId, quote.oracleId, quote.expiryMs, lvl.strike, signal.direction, cfg.amount, lvl.premium);
      savePosition(cfg.telegramId, {
        oracleId: quote.oracleId, expiryMs: quote.expiryMs,
        strike: lvl.strike, direction: signal.direction,
        quantity: cfg.amount, premium: lvl.premium,
        managerId: result.managerId || managerId,
        digest: result.digest, chatId: cfg.chatId, status: 'open',
      });
      if (budget) recordSpend(cfg.telegramId, cfg.amount);

      cfg.tradesToday = (cfg.tradesToday || 0) + 1;
      cfg.lastTradeDate = todayUTC;
      setArbAuto(cfg.telegramId, cfg);

      const diffPct   = Math.round(signal.diff * 100);
      const capNote   = cfg.maxTradesPerDay ? ` (${cfg.tradesToday}/${cfg.maxTradesPerDay} today)` : '';
      await sendMessage(cfg.chatId,
        `⚡ *Arb auto-trade fired*${capNote}\n\n` +
        `PM vs DB gap: *${diffPct}pp* — ${signal.direction.toUpperCase()} edge · ${signal.durationMins}m window\n` +
        `${signal.direction === 'up' ? '📈' : '📉'} ${signal.direction.toUpperCase()} $${lvl.strike.toLocaleString('en-US', { maximumFractionDigits: 0 })} · $${lvl.premium.toFixed(2)} in → $${cfg.amount.toFixed(2)} if wins\n\n` +
        `[View on-chain](https://suiscan.xyz/testnet/tx/${result.digest})`
      );
    } catch (e) {
      console.error('Arb auto-trade error:', cfg.telegramId, e.message);
    }
  }
}

// ── Morning brief (9am UTC) ───────────────────────────────────────
let lastBriefDate = null;
async function morningBrief() {
  const now = new Date();
  if (now.getUTCHours() !== 9 || now.getUTCMinutes() > 2) return;
  const today = now.toISOString().slice(0, 10);
  if (lastBriefDate === today) return;
  lastBriefDate = today;

  const price = await getBtcPrice().catch(() => null);
  if (!price) return;

  const users = getAllUsers();
  for (const user of users) {
    if (!user.chatId) continue;
    await sendMessage(user.chatId,
      `☀️ *Morning Brief*\n\nBTC is at $${price.toLocaleString('en-US', { maximumFractionDigits: 0 })}\n\nWhat's your call today — UP or DOWN?`
    ).catch(() => {});
  }
}

// ── Copy-trade fanout ─────────────────────────────────────────────
async function triggerCopyTrades(leaderId, pos) {
  const followers = getFollowers(leaderId);
  console.log(`[copy] leader=${leaderId} followers=${followers.length}`, followers.map(f => f.followerId));
  if (!followers.length) return;
  for (const f of followers) {
    try {
      const keypair   = getKeypair(f.followerId);
      const address   = getAddress(f.followerId);
      const managerId = getManagerId(f.followerId);
      console.log(`[copy] follower=${f.followerId} hasKeypair=${!!keypair} hasAddress=${!!address} amount=${f.amount}`);
      if (!keypair || !address) continue;
      // Snap remaining time to nearest valid DeepBook window (15/30/60)
      const remainingMins = (pos.expiryMs - Date.now()) / 60000;
      const duration = remainingMins >= 45 ? 60 : remainingMins >= 22 ? 30 : 15;
      const quote = await getQuote(duration, f.amount, pos.direction).catch(() => null);
      if (!quote) continue;
      // Pick the level closest to the leader's strike
      const lvl = quote.levels.reduce((best, l) =>
        Math.abs(l.strike - pos.strike) < Math.abs(best.strike - pos.strike) ? l : best
      , quote.levels[0]);
      const result = await openPosition(keypair, address, managerId, quote.oracleId, quote.expiryMs, lvl.strike, pos.direction, lvl.face, lvl.premium);
      savePosition(f.followerId, { oracleId: quote.oracleId, expiryMs: quote.expiryMs, strike: lvl.strike, direction: pos.direction, quantity: lvl.face, premium: lvl.premium, managerId: result.managerId || managerId, digest: result.digest, chatId: f.chatId || f.followerId, status: 'open' });
      const leaderName = getUser(leaderId)?.firstName || 'your leader';
      const strikeFmt  = `$${lvl.strike.toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
      await sendMessage(f.chatId || f.followerId,
        `📋 *Copy trade placed!*\n\nMirroring ${leaderName} — BTC ${pos.direction.toUpperCase()} ${strikeFmt}\n💵 $${lvl.premium.toFixed(2)} → $${lvl.face.toFixed(2)}\n[View on-chain](${EXPLORER}/${result.digest})`
      ).catch(() => {});
    } catch (e) {
      console.error(`[copy] failed for follower ${f.followerId}:`, e.message);
      await sendMessage(f.chatId || f.followerId,
        `⚠️ *Copy trade failed*\n\nCouldn't mirror the trade: ${e.message}`
      ).catch(() => {});
    }
  }
}

// ── Arb signal broadcaster ────────────────────────────────────────
let lastArbSlug = null;
async function broadcastArbSignal() {
  try {
    const signal = await checkArbSignal();
    if (!signal) return;
    if (signal.poly.slug === lastArbSlug) return; // already sent for this window
    lastArbSlug = signal.poly.slug;
    const msg = formatSignal(signal);
    const users = getAllUsers();
    for (const user of users) {
      if (!getArbAlerts(user.telegramId)) continue;
      const chatId = user.chatId || user.telegramId;
      await sendMessage(chatId, msg).catch(() => {});
    }
  } catch (e) {
    console.error('Arb signal error:', e.message);
  }
}

// ── Wallet watcher: mirror external DeepBook positions ───────────
const PKG = '0xf5ea2b3749c65d6e56507cc35388719aadb28f9cab873696a2f8687f5c785138';
const POSITION_MINTED_TYPE = `${PKG}::predict::PositionMinted`;
const PRICE_SCALE_N = 1_000_000_000;

async function checkWalletWatchers() {
  const watchers = getAllWalletWatchers();
  console.log(`[watcher] ${watchers.length} watcher(s)`);
  for (const watcher of watchers) {
    const { followerId, watchedAddress, amount, chatId: wChatId, lastEventCursor } = watcher;
    try {
      // Query PositionMinted events sent by the watched address
      const result = await tgRpc('suix_queryEvents', [
        { Sender: watchedAddress },
        lastEventCursor || null, 10, false,
      ]);

      const events  = result?.data || [];
      console.log(`[watcher] ${watchedAddress.slice(0,10)} events=${events.length} cursor=${JSON.stringify(lastEventCursor)}`);
      if (events.length) console.log(`[watcher] sample event:`, JSON.stringify(events[0]).slice(0, 400));
      const newOnes = events.filter(e => e.type === POSITION_MINTED_TYPE);
      console.log(`[watcher] matching events=${newOnes.length}`);

      for (const evt of newOnes) {
        const j         = evt.parsedJson;
        const oracleId  = j.oracle_id;
        const expiryMs  = Number(j.expiry);
        const strike    = Number(j.strike) / PRICE_SCALE_N;
        const direction = j.is_up ? 'up' : 'down';
        const managerId = getManagerId(followerId);
        const keypair   = getKeypair(followerId);
        const addr      = getAddress(followerId);

        if (!keypair || !addr) continue;
        if (expiryMs <= Date.now()) continue; // already expired

        try {
          // Get fresh quote at same strike to confirm it's still tradeable
          const { getQuote } = await import('./predict.js');
          const durationMs  = expiryMs - Date.now();
          const durationMin = Math.round(durationMs / 60000);
          const quote       = await getQuote(durationMin, amount, direction);
          // Find the level closest to the watched wallet's strike
          const level = quote.levels.reduce((best, l) =>
            Math.abs(l.strike - strike) < Math.abs(best.strike - strike) ? l : best
          );

          const openRes = await openPosition(keypair, addr, managerId, oracleId, expiryMs, level.strike, direction, level.face, level.premium);
          if (openRes.managerId && openRes.managerId !== managerId) setManagerId(followerId, openRes.managerId);
          savePosition(followerId, { oracleId, expiryMs, strike: level.strike, direction, quantity: level.face, premium: level.premium, managerId: openRes.managerId || managerId, digest: openRes.digest, chatId: wChatId, status: 'open' });

          const shortAddr = watchedAddress.slice(0, 10) + '…';
          await sendMessage(wChatId,
            `📋 *Copy trade fired!*\n\n` +
            `Mirroring \`${shortAddr}\`\n` +
            `BTC ${direction.toUpperCase()} $${level.strike.toLocaleString()} · expires ${new Date(expiryMs).toLocaleTimeString([], { hour:'2-digit', minute:'2-digit', timeZone:'UTC', hour12:false })} UTC\n` +
            `💵 $${level.premium.toFixed(2)} at risk · 💰 $${level.face.toFixed(2)} to win\n\n` +
            `[View on-chain](${EXPLORER}/${openRes.digest})`
          ).catch(() => {});
        } catch (e) {
          await sendMessage(wChatId, `⚠️ Copy trade failed for \`${watchedAddress.slice(0,10)}…\`: ${e.message}`).catch(() => {});
        }
      }

      // Advance cursor to latest event
      if (result?.nextCursor) updateWalletWatcherCursor(followerId, result.nextCursor);
      else if (events.length) updateWalletWatcherCursor(followerId, events[events.length - 1].id);
    } catch (e) {
      console.error('Wallet watcher error:', e.message);
    }
  }
}

// Thin wrapper so we can reuse the rpc pattern
async function tgRpc(method, params) {
  const r = await fetch('https://fullnode.testnet.sui.io', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  return (await r.json()).result;
}

// ── Deposit detector ─────────────────────────────────────────────
async function checkDeposits() {
  const users = getAllUsers();
  for (const user of users) {
    if (!user.address) continue;
    try {
      const [dusdc, sui] = await Promise.all([
        getBalance(user.address),
        getSuiBalance(user.address),
      ]);

      const prevDusdc = user.lastBalance    ?? null;
      const prevSui   = user.lastSuiBalance ?? null;
      const lines     = [];

      if (prevDusdc !== null && dusdc > prevDusdc + 0.001)
        lines.push(`+$${(dusdc - prevDusdc).toFixed(4)} dUSDC  (balance: $${dusdc.toFixed(4)})`);
      if (prevSui !== null && sui > prevSui + 0.0001)
        lines.push(`+${(sui - prevSui).toFixed(4)} SUI  (balance: ${sui.toFixed(4)} SUI)`);

      if (lines.length) {
        const chatId = user.dmChatId || user.chatId || user.telegramId;
        await sendMessage(chatId,
          `💰 *Deposit detected!*\n\n${lines.join('\n')}\n\nYou're ready to trade!`
        ).catch(() => {});
      }

      const updates = {};
      if (dusdc !== prevDusdc) updates.lastBalance    = dusdc;
      if (sui   !== prevSui)   updates.lastSuiBalance = sui;
      if (Object.keys(updates).length) saveUser(user.telegramId, updates);
    } catch {}
  }
}

// ── Background job intervals ──────────────────────────────────────
setInterval(async () => {
  await monitorPositions();
  await checkAlerts();
  await runAutoPredict();
  await runArbAuto();
  await checkDeposits();
  await checkWalletWatchers();
}, 2 * 60 * 1000);

// 1-min price feed + strike cache refresh
setInterval(async () => {
  const p = await getBtcPrice().catch(() => null);
  if (p) recordPrice(p);
  await refreshStrikes();
}, 60 * 1000);

setInterval(() => resetBudgets(), 60 * 60 * 1000); // reset budgets hourly check
setInterval(() => morningBrief(), 60 * 1000);       // check every minute for 9am UTC
setInterval(broadcastArbSignal, 60 * 1000);         // check arb signal every minute

// ── Register webhook ──────────────────────────────────────────────
async function registerWebhook() {
  const url = process.env.RAILWAY_PUBLIC_DOMAIN
    ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}/webhook`
    : process.env.WEBHOOK_URL;
  if (!url) { console.log('No webhook URL — skipping'); return; }
  const result = await tg('setWebhook', { url, drop_pending_updates: true });
  console.log('Webhook registered:', url, result.ok ? '✓' : result.description);
}

async function registerCommands() {
  if (!BOT_TOKEN) { console.log('No bot token — skipping commands'); return; }
  const result = await tg('setMyCommands', {
    commands: [
      { command: 'start',  description: 'Start trading with SAGE'         },
      { command: 'wallet', description: 'Show and pin your wallet address' },
      { command: 'help',   description: 'How to use SAGE'                  },
    ],
  });
  console.log('Commands registered:', result.ok ? '✓' : result.description);
}

const PORT = process.env.PORT || 3001;
app.listen(PORT, async () => {
  console.log(`SAGE → http://localhost:${PORT}`);
  await initDb();
  dbReady = true;
  await registerWebhook();
  await registerCommands();
  const appDomain = process.env.RAILWAY_PUBLIC_DOMAIN;
  if (appDomain) {
    await tg('setChatMenuButton', { menu_button: { type: 'web_app', text: 'Open App', web_app: { url: `https://${appDomain}/app` } } });
    console.log('Menu button set ✓');
  }
  try {
    const me = await tg('getMe', {});
    if (me.result?.username) {
      botUsername = me.result.username;
      console.log(`Bot username: @${botUsername}`);
    }
  } catch {}
  getBtcPrice().then(p => { if (p) recordPrice(p); }).catch(() => {});
  refreshStrikes().catch(() => {});
});
