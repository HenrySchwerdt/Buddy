import * as SecureStore from 'expo-secure-store';
import type { SettingsSection, SettingsValues } from '@buddy/core';

const key = (pluginId: string, field: string) => `buddy.secret.${pluginId}.${field}`;

export const secretFields = (sections: readonly SettingsSection[]) =>
  sections.flatMap((s) => s.fields).filter((f) => f.kind === 'text' && f.secret).map((f) => f.key);

/** Loads secret fields for a plugin from the keychain / keystore. */
export async function loadSecrets(pluginId: string, sections: readonly SettingsSection[]): Promise<SettingsValues> {
  const entries = await Promise.all(secretFields(sections).map(async (f) => [f, (await SecureStore.getItemAsync(key(pluginId, f))) ?? ''] as const));
  return Object.fromEntries(entries);
}

export async function saveSecret(pluginId: string, field: string, value: string): Promise<void> {
  if (value) await SecureStore.setItemAsync(key(pluginId, field), value);
  else await SecureStore.deleteItemAsync(key(pluginId, field));
}
