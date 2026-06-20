import { getQuote } from './predict.js';

const POLY_API = 'https://gamma-api.polymarket.com/events';

async function fetchPolymarket(windowMins) {
  const now     = Date.now();
  const winMs   = windowMins * 60 * 1000;
  const winSec  = Math.floor(now / winMs) * windowMins * 60;
  const label   = windowMins === 60 ? '1h' : `${windowMins}m`;
  const slug    = `btc-updown-${label}-${winSec}`;
  try {
    const r = await fetch(`${POLY_API}?slug=${slug}`);
    if (!r.ok) return null;
    const events = await r.json();
    if (!events?.length) return null;
    const mkt = events[0].markets?.[0];
    if (!mkt?.outcomePrices) return null;
    const prices = JSON.parse(mkt.outcomePrices);
    return {
      upProb:    parseFloat(prices[0]),
      downProb:  parseFloat(prices[1]),
      slug, liquidity: mkt.liquidityNum || 0, volume: mkt.volumeNum || 0,
      windowStart: winSec * 1000, windowEnd: (winSec + windowMins * 60) * 1000,
      ageMs: now - winSec * 1000,
    };
  } catch { return null; }
}

// Fetch the current 15M BTC market from Polymarket
export async function getPolymarketBtc15m() { return fetchPolymarket(15); }

// Fetch the current 1H BTC market from Polymarket
// Slug format: bitcoin-up-or-down-{month}-{day}-{year}-{hour}{ampm}-et
export async function getPolymarketBtc1h() {
  try {
    const MONTHS = ['january','february','march','april','may','june','july','august','september','october','november','december'];
    // ET = UTC-4 (EDT, summer)
    const etOffsetMs = -4 * 60 * 60 * 1000;
    const nowEt = new Date(Date.now() + etOffsetMs);
    const month = MONTHS[nowEt.getUTCMonth()];
    const day   = nowEt.getUTCDate();
    const year  = nowEt.getUTCFullYear();
    const h24   = nowEt.getUTCHours();
    const ampm  = h24 < 12 ? 'am' : 'pm';
    const h12   = h24 % 12 === 0 ? 12 : h24 % 12;
    const slug  = `bitcoin-up-or-down-${month}-${day}-${year}-${h12}${ampm}-et`;
    const r = await fetch(`${POLY_API}?slug=${slug}`);
    if (!r.ok) return null;
    const events = await r.json();
    if (!events?.length) return null;
    const mkt = events[0].markets?.[0];
    if (!mkt?.outcomePrices) return null;
    const prices = JSON.parse(mkt.outcomePrices);
    const winStartMs = Date.now() - (nowEt.getUTCMinutes() * 60 + nowEt.getUTCSeconds()) * 1000;
    return {
      upProb: parseFloat(prices[0]), downProb: parseFloat(prices[1]), slug,
      liquidity: mkt.liquidityNum || 0, volume: mkt.volumeNum || 0,
      windowStart: winStartMs, windowEnd: winStartMs + 60 * 60 * 1000,
      ageMs: (nowEt.getUTCMinutes() * 60 + nowEt.getUTCSeconds()) * 1000,
    };
  } catch { return null; }
}

async function getDeepbookProb(direction, durationMins = 15) {
  try {
    const quote = await getQuote(durationMins, 10, direction);
    const lvl   = quote.levels[1] || quote.levels[0];
    if (!lvl) return null;
    return lvl.premium / lvl.face;
  } catch { return null; }
}

// Returns the strongest signal across checked timeframes, or null.
// windowMins: 15 | 60 | 'both' (default 15)
export async function checkArbSignal(windowMins = 15) {
  const toCheck = windowMins === 'both' ? [15, 60] : [windowMins];
  const signals = [];

  for (const mins of toCheck) {
    const poly = mins === 60 ? await getPolymarketBtc1h() : await getPolymarketBtc15m();
    if (!poly) continue;
    const freshWindow = mins === 60 ? 5 * 60 * 1000 : 3 * 60 * 1000;
    if (poly.ageMs > freshWindow) continue;
    if (poly.liquidity < 1000) continue;

    const [deepUp, deepDown] = await Promise.all([
      getDeepbookProb('up', mins),
      getDeepbookProb('down', mins),
    ]);
    if (!deepUp || !deepDown) continue;

    const upDiff   = poly.upProb   - deepUp;
    const downDiff = poly.downProb - deepDown;
    const THRESHOLD = 0.12;

    let signal = null;
    if (Math.abs(upDiff) >= THRESHOLD) {
      const edge = upDiff > 0
        ? `Polymarket prices UP at ${(poly.upProb*100).toFixed(0)}% — DeepBook only at ${(deepUp*100).toFixed(0)}%. DeepBook UP is cheap.`
        : `Polymarket prices UP at ${(poly.upProb*100).toFixed(0)}% — DeepBook at ${(deepUp*100).toFixed(0)}%. DeepBook DOWN is cheap.`;
      signal = { direction: upDiff > 0 ? 'up' : 'down', polyProb: poly.upProb, deepProb: deepUp, diff: Math.abs(upDiff), edge, poly, durationMins: mins };
    } else if (Math.abs(downDiff) >= THRESHOLD) {
      const edge = downDiff > 0
        ? `Polymarket prices DOWN at ${(poly.downProb*100).toFixed(0)}% — DeepBook only at ${(deepDown*100).toFixed(0)}%. DeepBook DOWN is cheap.`
        : `Polymarket prices DOWN at ${(poly.downProb*100).toFixed(0)}% — DeepBook at ${(deepDown*100).toFixed(0)}%. DeepBook UP is cheap.`;
      signal = { direction: downDiff > 0 ? 'down' : 'up', polyProb: poly.downProb, deepProb: deepDown, diff: Math.abs(downDiff), edge, poly, durationMins: mins };
    }
    if (signal) signals.push(signal);
  }

  // Return the signal with the highest gap
  if (!signals.length) return null;
  return signals.sort((a, b) => b.diff - a.diff)[0];
}

// Format a signal for Telegram
export function formatSignal(signal) {
  const dirEmoji = signal.direction === 'up' ? '📈' : '📉';
  const diffPct  = (signal.diff * 100).toFixed(0);
  const expiry   = new Date(signal.poly.windowEnd).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', timeZone: 'UTC', hour12: false });
  return (
    `⚡ *Arb Signal — BTC ${signal.direction.toUpperCase()}*\n\n` +
    `${signal.edge}\n\n` +
    `Divergence: *${diffPct}pp*\n` +
    `Window expires: *${expiry} UTC*\n` +
    `Polymarket liquidity: *$${signal.poly.liquidity.toLocaleString('en-US', { maximumFractionDigits: 0 })}*\n\n` +
    `${dirEmoji} DeepBook 15-min ${signal.direction.toUpperCase()} is the play.`
  );
}
