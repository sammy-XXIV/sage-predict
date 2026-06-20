import { Transaction, Inputs } from '@mysten/sui/transactions';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import {
  FULLNODE, PREDICT_SERVER, PREDICT_PACKAGE, PREDICT_OBJECT,
  DUSDC_TYPE, CLOCK, PRICE_SCALE, DUSDC_SCALE
} from './config.js';

async function rpc(method, params = [], timeoutMs = 30000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const r = await fetch(FULLNODE, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: controller.signal,
    });
    const d = await r.json();
    if (d.error) throw new Error(`RPC ${method}: ${d.error.message}`);
    return d.result;
  } catch (e) {
    if (e.name === 'AbortError') throw new Error(`RPC ${method} timed out after ${timeoutMs / 1000}s`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

const indexer = async (path) => {
  const res = await fetch(`${PREDICT_SERVER}${path}`);
  if (!res.ok) throw new Error(`Indexer ${path} → ${res.status}`);
  return res.json();
};

async function fetchObjectRef(objectId, mutable = true) {
  const r = await rpc('sui_getObject', [objectId, { showOwner: true }]);
  if (!r.data) throw new Error(`Object not found: ${objectId}`);
  const { objectId: id, version, digest, owner } = r.data;
  if (owner?.Shared) {
    return Inputs.SharedObjectRef({ objectId: id, initialSharedVersion: owner.Shared.initial_shared_version, mutable });
  }
  return Inputs.ObjectRef({ objectId: id, version, digest });
}

async function getCoins(owner, coinType) {
  const r = await rpc('suix_getCoins', [owner, coinType, null, 50]);
  return r.data || [];
}

// Any valid address works for devInspect (no balance/ownership check).
const DEV_SENDER = '0x0000000000000000000000000000000000000000000000000000000000000001';

const u64le = (bytes) => { let n = 0n; for (let i = bytes.length - 1; i >= 0; i--) n = n * 256n + BigInt(bytes[i]); return n; };

// Ask-price bounds (per-unit, 1e9 fixed point) that the contract enforces on mint.
async function askBounds(oracleId) {
  const predictRef = await fetchObjectRef(PREDICT_OBJECT);
  const tx = new Transaction();
  tx.moveCall({ target: `${PREDICT_PACKAGE}::predict::ask_bounds`,
    arguments: [tx.object(predictRef), tx.pure.id(oracleId)] });
  const kind = Buffer.from(await tx.build({ onlyTransactionKind: true })).toString('base64');
  const res = await rpc('sui_devInspectTransactionBlock', [DEV_SENDER, kind, null, null]);
  const ret = res.results?.[0]?.returnValues;
  return { minAsk: u64le(ret[0][0]), maxAsk: u64le(ret[1][0]) };
}

// Ask the contract for the real (cost, payout) of a strike. Returns null if unmintable.
async function contractTradeAmounts(oracleId, expiryMs, strike, direction, faceBig) {
  const [predictRef, oracleRef, clockRef] = await Promise.all([
    fetchObjectRef(PREDICT_OBJECT),
    fetchObjectRef(oracleId),
    fetchObjectRef(CLOCK, false),
  ]);
  const strikeBig = BigInt(Math.round(strike * Number(PRICE_SCALE)));
  const keyFn = direction === 'up' ? 'up' : 'down';
  const tx = new Transaction();
  const key = tx.moveCall({ target: `${PREDICT_PACKAGE}::market_key::${keyFn}`,
    arguments: [tx.pure.id(oracleId), tx.pure.u64(BigInt(expiryMs)), tx.pure.u64(strikeBig)] });
  tx.moveCall({ target: `${PREDICT_PACKAGE}::predict::get_trade_amounts`,
    arguments: [tx.object(predictRef), tx.object(oracleRef), key, tx.pure.u64(faceBig), tx.object(clockRef)] });
  const kind = Buffer.from(await tx.build({ onlyTransactionKind: true })).toString('base64');
  const res = await rpc('sui_devInspectTransactionBlock', [DEV_SENDER, kind, null, null]);
  if (res.effects?.status?.status !== 'success') return null; // pricing engine rejected this strike
  const ret = res.results?.[res.results.length - 1]?.returnValues;
  if (!ret) return null;
  const costRaw   = u64le(ret[0][0]); // dUSDC raw (1e6)
  const payoutRaw = u64le(ret[1][0]);
  return { costRaw, payoutRaw };
}

function normalCDF(x) {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x) / Math.sqrt(2);
  const p = 0.3275911;
  const t = 1 / (1 + p * ax);
  const y = 1 - (((((1.061405429*t - 1.453152027)*t) + 1.421413741)*t - 0.284496736)*t + 0.254829592)*t*Math.exp(-ax*ax);
  return 0.5 * (1 + sign * y);
}

function sviTotalVariance(k, svi) {
  const a   = svi.a     / 1e8;
  const b   = svi.b     / 1e8;
  const rho = (svi.rho_negative ? -1 : 1) * svi.rho / 1e9;
  const m   = (svi.m_negative   ? -1 : 1) * svi.m   / 1e9;
  const sig = svi.sigma / 1e8;
  return a + b * (rho * (k - m) + Math.sqrt((k - m) ** 2 + sig ** 2));
}

function binaryPrice(spot, strike, svi, direction) {
  const k  = Math.log(strike / spot);
  const w  = Math.max(sviTotalVariance(k, svi), 1e-10);
  const d2 = (-k - 0.5 * w) / Math.sqrt(w);
  const p  = direction === 'down' ? normalCDF(-d2) : normalCDF(d2);
  return Math.min(Math.max(p, 0.001), 0.999);
}

function findStrike(spot, targetUnit, svi, minStrike, tickSize, direction) {
  let lo = minStrike, hi = spot * 0.9999;
  for (let i = 0; i < 50; i++) {
    const mid = (lo + hi) / 2;
    const price = binaryPrice(spot, mid, svi, direction);
    if (direction === 'down') {
      if (price > targetUnit) hi = mid; else lo = mid;
    } else {
      if (price < targetUnit) hi = mid; else lo = mid;
    }
  }
  const raw = (lo + hi) / 2;
  const n = Math.max(0, Math.round((raw - minStrike) / tickSize));
  return minStrike + n * tickSize;
}

export async function getBtcPrice() {
  const oracles = await indexer(`/predicts/${PREDICT_OBJECT}/oracles`);
  const now = Date.now();
  const live = oracles.filter(o => o.status === 'active' && Number(o.expiry) > now && !o.settlement_price);
  if (!live.length) return null;
  const state = await indexer(`/oracles/${live[0].oracle_id}/state`);
  return Number(state.latest_price?.spot) / Number(PRICE_SCALE);
}

// amount = stake (what the user risks). face (payout) is derived per-strike from the unit price.
export async function getQuote(durationMinutes, stakeAmount, direction = 'down') {
  const oracles = await indexer(`/predicts/${PREDICT_OBJECT}/oracles`);
  const now = Date.now();
  const targetExpiry = now + durationMinutes * 60 * 1000;
  const live = oracles
    .filter(o => o.status === 'active' && Number(o.expiry) > now + 60_000 && !o.settlement_price)
    .sort((a, b) => Math.abs(Number(a.expiry) - targetExpiry) - Math.abs(Number(b.expiry) - targetExpiry));
  if (!live.length) throw new Error('No live oracles');

  const oracle = live[0];
  const state  = await indexer(`/oracles/${oracle.oracle_id}/state`);
  const spot      = Number(state.latest_price?.spot) / Number(PRICE_SCALE);
  const svi       = state.latest_svi;
  const minStrike = Number(oracle.min_strike) / Number(PRICE_SCALE);
  const tickSize  = Number(oracle.tick_size)  / Number(PRICE_SCALE);
  if (!svi) throw new Error('No SVI data');

  const oracleId  = oracle.oracle_id;
  const expiryMs  = Number(oracle.expiry);
  const { minAsk, maxAsk } = await askBounds(oracleId);

  // Price strikes using a $100 reference face to get unit prices cheaply.
  // Then compute face = stakeAmount / unitPrice so the user's cost = stakeAmount exactly.
  const refFaceBig = BigInt(Math.round(100 * Number(DUSDC_SCALE)));

  const offsets = [0.0005, 0.001, 0.002, 0.0035, 0.005, 0.0075, 0.011, 0.016];
  const snap = (px) => {
    const n = Math.round((px - minStrike) / tickSize);
    return +(minStrike + n * tickSize).toFixed(2);
  };
  const candidates = [...new Set(offsets.map(o =>
    snap(direction === 'down' ? spot * (1 - o) : spot * (1 + o))
  ))].filter(s => s > 0);

  const priced = (await Promise.all(candidates.map(async (strike) => {
    const amounts = await contractTradeAmounts(oracleId, expiryMs, strike, direction, refFaceBig);
    if (!amounts || amounts.costRaw === 0n) return null;
    const askUnit = Number(amounts.costRaw) * Number(PRICE_SCALE) / Number(refFaceBig);
    const lo = Math.max(Number(minAsk), 0.05 * Number(PRICE_SCALE));
    const hi = Math.min(Number(maxAsk), 0.80 * Number(PRICE_SCALE));
    if (askUnit < lo || askUnit > hi) return null;
    // unitPrice is the fraction of face the user pays (e.g. 0.04 = 4%)
    const unitPrice = askUnit / Number(PRICE_SCALE);
    // face = how much the user wins when they stake `stakeAmount`
    const face = stakeAmount / unitPrice;
    return {
      strike,
      drop:      +Math.abs(((spot - strike) / spot) * 100).toFixed(2),
      premium:   +stakeAmount.toFixed(4),
      face:      +face.toFixed(4),
      unitPrice: +unitPrice.toFixed(6),
      odds:      Math.max(1, Math.round(1 / unitPrice)),
    };
  }))).filter(Boolean).sort((a, b) => b.unitPrice - a.unitPrice); // safest (highest price) first

  if (!priced.length) throw new Error('No mintable strikes right now — try a different duration.');

  // Pick 3 spread across the odds range: safest → balanced → moon shot
  const pick = priced.length <= 3
    ? priced
    : [priced[0], priced[Math.floor(priced.length / 2)], priced[priced.length - 1]];
  const labels = ['Safe Hedge', 'Balanced', 'Moon Shot'];
  const levels = pick.map((l, i) => ({ label: labels[i] || `Tier ${i + 1}`, ...l }));

  return {
    spot:      +spot.toFixed(2),
    oracleId,
    expiryMs,
    direction,
    levels,
  };
}

export async function getBalance(address) {
  const coins = await getCoins(address, DUSDC_TYPE);
  const total = coins.reduce((s, c) => s + BigInt(c.balance), 0n);
  return Number(total) / 1e6;
}

export async function getSuiBalance(address) {
  const coins = await getCoins(address, '0x2::sui::SUI');
  const total = coins.reduce((s, c) => s + BigInt(c.balance), 0n);
  return Number(total) / 1e9;
}

export async function withdrawFunds(keypair, fromAddress, toAddress, amountDusdc) {
  const amountBig = BigInt(Math.round(amountDusdc * 1e6));
  const [coins, gasCoins, gasPrice] = await Promise.all([
    getCoins(fromAddress, DUSDC_TYPE),
    getCoins(fromAddress, '0x2::sui::SUI'),
    rpc('suix_getReferenceGasPrice').then(BigInt),
  ]);
  if (!gasCoins.length) throw new Error('No SUI for gas fees. Get some from the faucet first.');
  const totalDusdc = coins.reduce((s, c) => s + BigInt(c.balance), 0n);
  if (totalDusdc < amountBig) throw new Error(`Insufficient balance. You have $${Number(totalDusdc) / 1e6} dUSDC.`);

  const tx = new Transaction();
  tx.setGasBudget(10_000_000n);
  tx.setGasPrice(gasPrice);
  tx.setGasPayment(gasCoins.map(c => ({ objectId: c.coinObjectId, version: c.version, digest: c.digest })));

  const [primaryCoin, ...restCoins] = coins;
  const primary = tx.object(primaryCoin.coinObjectId);
  if (restCoins.length) tx.mergeCoins(primary, restCoins.map(c => tx.object(c.coinObjectId)));

  const [sendCoin] = tx.splitCoins(primary, [tx.pure.u64(amountBig)]);
  tx.transferObjects([sendCoin], tx.pure.address(toAddress));

  const bytes  = await tx.build({ client: { getReferenceGasPrice: async () => gasPrice } });
  const sig    = (await keypair.signTransaction(bytes)).signature;
  const result = await rpc('sui_executeTransactionBlock', [
    Buffer.from(bytes).toString('base64'), [sig],
    { showEffects: true }, 'WaitForLocalExecution',
  ]);
  if (result.effects?.status?.status !== 'success') throw new Error(result.effects?.status?.error || 'Transaction failed');
  return { digest: result.digest };
}

// Create a PredictManager in its own transaction and return its objectId.
// Creating + using the manager inside one PTB triggers a TypeMismatch, so this
// runs standalone and the position tx then uses the proven existing-manager path.
async function createManager(keypair, address) {
  const [gasCoins, gasPrice] = await Promise.all([
    getCoins(address, '0x2::sui::SUI'),
    rpc('suix_getReferenceGasPrice').then(BigInt),
  ]);
  if (!gasCoins.length) throw new Error('No SUI for gas');

  const tx = new Transaction();
  tx.setSender(address);
  tx.setGasPrice(gasPrice);
  tx.setGasBudget(20_000_000n);
  tx.setGasPayment(gasCoins.map(c => ({ objectId: c.coinObjectId, version: c.version, digest: c.digest })));

  // create_manager handles ownership internally (no transferable return value)
  tx.moveCall({ target: `${PREDICT_PACKAGE}::predict::create_manager`, arguments: [] });

  const bytes = await tx.build();
  const { signature } = await keypair.signTransaction(bytes);
  const result = await rpc('sui_executeTransactionBlock', [
    Buffer.from(bytes).toString('base64'),
    [signature],
    { showEffects: true, showObjectChanges: true },
    'WaitForEffectsCert',
  ]);
  if (result.effects?.status?.status !== 'success') {
    throw new Error(`Manager creation failed: ${JSON.stringify(result.effects?.status)}`);
  }
  const created = result.objectChanges?.find(c =>
    c.type === 'created' && c.objectType?.includes('PredictManager')
  );
  if (!created) throw new Error('Manager created but object not found');
  return created.objectId;
}

export async function openPosition(keypair, address, managerId, oracleId, expiryMs, strike, direction, face, premium) {
  const strikeBig  = BigInt(Math.round(strike  * Number(PRICE_SCALE)));
  const expiryBig  = BigInt(expiryMs);
  const faceBig    = BigInt(Math.round(face    * Number(DUSDC_SCALE)));

  // Re-price against the contract right now — the quote may be seconds old and the
  // ask can drift out of bounds (high gamma near expiry). Use the fresh cost so the
  // deposit covers it and we fail cleanly instead of aborting on-chain.
  const { minAsk, maxAsk } = await askBounds(oracleId);
  const fresh = await contractTradeAmounts(oracleId, expiryMs, strike, direction, faceBig);
  if (!fresh || fresh.costRaw === 0n) {
    throw new Error('Price moved — please request a fresh quote.');
  }
  const freshAsk = Number(fresh.costRaw) * Number(PRICE_SCALE) / Number(faceBig);
  if (freshAsk < Number(minAsk) || freshAsk > Number(maxAsk)) {
    throw new Error('Price moved — please request a fresh quote.');
  }
  const premiumBig = fresh.costRaw + 1000n; // fresh contract cost + tiny buffer

  // No manager yet, or stored manager no longer exists on-chain (e.g. testnet reset)
  if (managerId) {
    const check = await rpc('sui_getObject', [managerId, {}]);
    if (!check.data) managerId = null;
  }
  if (!managerId) {
    managerId = await createManager(keypair, address);
  }

  const [dusdcCoins, gasCoins, gasPrice] = await Promise.all([
    getCoins(address, DUSDC_TYPE),
    getCoins(address, '0x2::sui::SUI'),
    rpc('suix_getReferenceGasPrice').then(BigInt),
  ]);

  if (!dusdcCoins.length) throw new Error('No dUSDC in wallet');
  if (!gasCoins.length)   throw new Error('No SUI for gas');

  const objRef = c => Inputs.ObjectRef({ objectId: c.coinObjectId, version: c.version, digest: c.digest });

  const tx = new Transaction();
  tx.setSender(address);
  tx.setGasPrice(gasPrice);
  tx.setGasBudget(20_000_000n);
  tx.setGasPayment(gasCoins.map(c => ({ objectId: c.coinObjectId, version: c.version, digest: c.digest })));

  const mgrRef = await fetchObjectRef(managerId);
  const mgr = tx.object(mgrRef);

  const primary = tx.object(objRef(dusdcCoins[0]));
  if (dusdcCoins.length > 1) {
    tx.mergeCoins(primary, dusdcCoins.slice(1).map(c => tx.object(objRef(c))));
  }
  const [depositCoin] = tx.splitCoins(primary, [tx.pure.u64(premiumBig)]);

  tx.moveCall({
    target: `${PREDICT_PACKAGE}::predict_manager::deposit`,
    typeArguments: [DUSDC_TYPE],
    arguments: [mgr, depositCoin],
  });

  const keyFn = direction === 'up' ? 'up' : 'down';
  const key = tx.moveCall({
    target: `${PREDICT_PACKAGE}::market_key::${keyFn}`,
    arguments: [tx.pure.id(oracleId), tx.pure.u64(expiryBig), tx.pure.u64(strikeBig)],
  });

  const [predictRef, oracleRef, clockRef] = await Promise.all([
    fetchObjectRef(PREDICT_OBJECT),
    fetchObjectRef(oracleId),
    fetchObjectRef(CLOCK, false),
  ]);

  tx.moveCall({
    target: `${PREDICT_PACKAGE}::predict::mint`,
    typeArguments: [DUSDC_TYPE],
    arguments: [tx.object(predictRef), mgr, tx.object(oracleRef), key, tx.pure.u64(faceBig), tx.object(clockRef)],
  });

  const bytes = await tx.build();
  const { signature } = await keypair.signTransaction(bytes);

  const result = await rpc('sui_executeTransactionBlock', [
    Buffer.from(bytes).toString('base64'),
    [signature],
    { showEffects: true, showObjectChanges: true },
    'WaitForEffectsCert',
  ]);

  if (result.effects?.status?.status !== 'success') {
    throw new Error(`Transaction failed: ${JSON.stringify(result.effects?.status)}`);
  }

  return { digest: result.digest, managerId };
}

async function buildRedeemKind(predictRef, managerRef, oracleRef, clockRef, oracleId, expiryBig, strikeBig, direction, quantityBig) {
  const tx = new Transaction();
  const keyFn = direction === 'up' ? 'up' : 'down';
  const key = tx.moveCall({
    target: `${PREDICT_PACKAGE}::market_key::${keyFn}`,
    arguments: [tx.pure.id(oracleId), tx.pure.u64(expiryBig), tx.pure.u64(strikeBig)],
  });
  tx.moveCall({
    target: `${PREDICT_PACKAGE}::predict::redeem_permissionless`,
    typeArguments: [DUSDC_TYPE],
    arguments: [tx.object(predictRef), tx.object(managerRef), tx.object(oracleRef), key, tx.pure.u64(quantityBig), tx.object(clockRef)],
  });
  return Buffer.from(await tx.build({ onlyTransactionKind: true })).toString('base64');
}

export async function redeemPosition(keypair, address, managerId, oracleId, expiry, strike, direction, quantity) {
  const strikeBig = BigInt(Math.round(strike * Number(PRICE_SCALE)));
  const expiryBig = BigInt(expiry);

  const [predictRef, managerRef, oracleRef, clockRef, gasCoins, gasPrice] = await Promise.all([
    fetchObjectRef(PREDICT_OBJECT),
    fetchObjectRef(managerId),
    fetchObjectRef(oracleId),
    fetchObjectRef(CLOCK, false),
    getCoins(address, '0x2::sui::SUI'),
    rpc('suix_getReferenceGasPrice').then(BigInt),
  ]);

  // Find the exact redeemable amount via devInspect.
  // Stored face may be rounded up by .toFixed(4), making quantityBig 1-2000 units
  // larger than what was minted — causing decrease_position abort 1.
  const baseQty = BigInt(Math.round(quantity * Number(DUSDC_SCALE)));
  let quantityBig = baseQty;
  let inspectOk = false;

  for (let delta = 0n; delta <= 2000n; delta++) {
    const tryQty = baseQty - delta;
    if (tryQty <= 0n) break;
    try {
      const kind  = await buildRedeemKind(predictRef, managerRef, oracleRef, clockRef, oracleId, expiryBig, strikeBig, direction, tryQty);
      const probe = await rpc('sui_devInspectTransactionBlock', [DEV_SENDER, kind, null, null]);
      if (probe.effects?.status?.status === 'success') {
        quantityBig = tryQty;
        inspectOk   = true;
        break;
      }
      // Only retry for decrease_position overflow; any other error is fatal
      const err = probe.effects?.status?.error || '';
      if (!err.includes('decrease_position') && !err.includes('MoveAbort')) break;
    } catch { break; }
  }

  if (!inspectOk) {
    throw new Error('Oracle not yet finalized on-chain. Try again in a minute.');
  }

  if (!gasCoins.length) throw new Error('No SUI for gas');

  const tx = new Transaction();
  tx.setSender(address);
  tx.setGasPrice(gasPrice);
  tx.setGasBudget(10_000_000n);
  tx.setGasPayment(gasCoins.map(c => ({ objectId: c.coinObjectId, version: c.version, digest: c.digest })));

  const keyFn = direction === 'up' ? 'up' : 'down';
  const key = tx.moveCall({
    target: `${PREDICT_PACKAGE}::market_key::${keyFn}`,
    arguments: [tx.pure.id(oracleId), tx.pure.u64(expiryBig), tx.pure.u64(strikeBig)],
  });
  tx.moveCall({
    target: `${PREDICT_PACKAGE}::predict::redeem_permissionless`,
    typeArguments: [DUSDC_TYPE],
    arguments: [tx.object(predictRef), tx.object(managerRef), tx.object(oracleRef), key, tx.pure.u64(quantityBig), tx.object(clockRef)],
  });

  const bytes = await tx.build();
  const { signature } = await keypair.signTransaction(bytes);

  const result = await rpc('sui_executeTransactionBlock', [
    Buffer.from(bytes).toString('base64'),
    [signature],
    { showEffects: true },
    'WaitForLocalExecution',
  ]);

  if (result.effects?.status?.status !== 'success') {
    throw new Error(`Redeem failed: ${JSON.stringify(result.effects?.status)}`);
  }

  return { digest: result.digest, quantityBig };
}

export async function getOracleState(oracleId) {
  return indexer(`/oracles/${oracleId}/state`);
}

export async function getOraclesList() {
  return indexer(`/predicts/${PREDICT_OBJECT}/oracles`);
}

export async function fundNewUser(address) {
  const appKeypair = Ed25519Keypair.fromSecretKey(process.env.SECRET_KEY);
  const appAddress = appKeypair.toSuiAddress();
  const SEND = 5n * 1_000_000n; // send 5 dUSDC to new users

  const [coins, gasCoins, gasPrice] = await Promise.all([
    getCoins(appAddress, DUSDC_TYPE),
    getCoins(appAddress, '0x2::sui::SUI'),
    rpc('suix_getReferenceGasPrice').then(BigInt),
  ]);

  if (!coins.length || !gasCoins.length) throw new Error('App wallet low on funds');

  const objRef = c => Inputs.ObjectRef({ objectId: c.coinObjectId, version: c.version, digest: c.digest });

  const tx = new Transaction();
  tx.setSender(appAddress);
  tx.setGasPrice(gasPrice);
  tx.setGasBudget(10_000_000n);
  tx.setGasPayment(gasCoins.map(c => ({ objectId: c.coinObjectId, version: c.version, digest: c.digest })));

  const primary = tx.object(objRef(coins[0]));
  if (coins.length > 1) tx.mergeCoins(primary, coins.slice(1).map(c => tx.object(objRef(c))));
  const [coin] = tx.splitCoins(primary, [tx.pure.u64(SEND)]);
  tx.transferObjects([coin], tx.pure.address(address));

  const bytes = await tx.build();
  const { signature } = await appKeypair.signTransaction(bytes);

  const result = await rpc('sui_executeTransactionBlock', [
    Buffer.from(bytes).toString('base64'),
    [signature],
    { showEffects: true },
    'WaitForEffectsCert',
  ]);

  if (result.effects?.status?.status !== 'success') throw new Error('Funding failed');
  return true;
}
