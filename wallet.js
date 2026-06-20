import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { getUser, saveUser } from './db.js';

export function getOrCreateWallet(telegramId) {
  const user = getUser(telegramId);
  if (user?.secretKey) {
    const keypair = Ed25519Keypair.fromSecretKey(user.secretKey);
    return { keypair, address: keypair.toSuiAddress(), isNew: false };
  }
  const keypair = new Ed25519Keypair();
  const secretKey = keypair.getSecretKey();
  const address = keypair.toSuiAddress();
  saveUser(telegramId, { secretKey, address, managerId: null });
  return { keypair, address, isNew: true };
}

export function getKeypair(telegramId) {
  const user = getUser(telegramId);
  if (!user?.secretKey) return null;
  return Ed25519Keypair.fromSecretKey(user.secretKey);
}

export function getAddress(telegramId) {
  return getUser(telegramId)?.address || null;
}

export function getManagerId(telegramId) {
  return getUser(telegramId)?.managerId || null;
}

export function setManagerId(telegramId, managerId) {
  saveUser(telegramId, { managerId });
}
