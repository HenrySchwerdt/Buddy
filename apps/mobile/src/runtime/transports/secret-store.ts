import * as SecureStore from 'expo-secure-store';
import type { SecretStore } from '@buddy/core';

/** SecureStore only accepts [A-Za-z0-9._-] keys. */
const safe = (k: string) => `buddy.device.${k.replace(/[^A-Za-z0-9._-]/g, '_')}`;

/** Keychain / Keystore-backed SecretStore for pairing keys and device identity. */
export const keychainSecretStore: SecretStore = {
  get: (k) => SecureStore.getItemAsync(safe(k)),
  async set(k, v) {
    if (v === null) await SecureStore.deleteItemAsync(safe(k));
    else await SecureStore.setItemAsync(safe(k), v, { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY });
  },
};
