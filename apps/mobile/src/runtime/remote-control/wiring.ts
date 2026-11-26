import * as Notifications from 'expo-notifications';
import * as SecureStore from 'expo-secure-store';
import Constants from 'expo-constants';
import { Platform } from 'react-native';
import { newId, type ActiveOverride, type ActiveTempTarget } from '@buddy/core';
import { fpuCarbEquivalents } from '../../features/treatment/fpu';
import { useTreatmentSettings } from '../../features/treatment/settings-store';
import { handleEncryptedCommand, MAX_REMEMBERED_COMMANDS, type HandlerContext, type HandlerOutcome } from './handler';
import { REMOTE_MEAL_NOTE, type RemoteDeps } from './commands';
import { COMMAND_TYPES, type CommandPayload } from './payload';
import { deleteRecordEverywhere } from '../record-deletion';
import { deliverBolus, now, runLoop, store } from '../runtime';
import { uploadNightscoutNote } from '../services';
import { useSettings } from '../settings-store';

export const REMOTE_SECRET_KEY = 'buddy.remote.secret';

export async function loadRemoteSecret(): Promise<string> {
  return (await SecureStore.getItemAsync(REMOTE_SECRET_KEY)) ?? '';
}
export async function saveRemoteSecret(secret: string): Promise<void> {
  if (secret) await SecureStore.setItemAsync(REMOTE_SECRET_KEY, secret);
  else await SecureStore.deleteItemAsync(REMOTE_SECRET_KEY);
}

/** Trio `generateNewSharedSecret`: 32 random hex characters. */
export function generateSharedSecret(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function realDeps(): RemoteDeps {
  const settings = () => useSettings.getState();
  return {
    now,
    limits: () => settings().limits,
    mealLimits: () => {
      const t = useTreatmentSettings.getState();
      return { maxCarbs: t.maxCarbs, maxFat: t.maxFat, maxProtein: t.maxProtein };
    },
    profile: () => settings().profile,
    snapshot: () => store.snapshot(),
    overridePresets: () => settings().overridePresets,
    tempTarget: () => settings().tempTarget,
    override: () => settings().override,
    deliverBolus,
    addMeal: ({ carbs, fat, protein, date, note }) => {
      const id = newId('carbs');
      if (carbs > 0) store.addCarbs({ id, date, grams: carbs, ...(note ? { note } : {}) });
      const t = useTreatmentSettings.getState();
      if (t.useFPUconversion) {
        for (const e of fpuCarbEquivalents(fat, protein, date, t)) store.addCarbs({ id: newId('fpu'), date: e.date, grams: e.grams });
      }
      void runLoop();
      return id;
    },
    deleteMeal: async (id, date) => {
      await deleteRecordEverywhere('carbs', id, date);
    },
    startTempTarget: (t: ActiveTempTarget) => {
      settings().update({ tempTarget: t });
      void runLoop();
    },
    cancelTempTarget: () => {
      settings().update({ tempTarget: null });
      void runLoop();
    },
    startOverride: (o: ActiveOverride) => {
      settings().update({ override: o });
      void runLoop();
    },
    cancelOverride: () => {
      settings().update({ override: null });
      void runLoop();
    },
    recalculate: async () => {
      await runLoop();
    },
  };
}

/** Audit note, log line and a local notification. Contains the command description but never the secret. */
async function report(note: string, result: { ok: boolean; message: string }): Promise<void> {
  if (result.ok) console.log(`[buddy] ${note}`);
  else console.warn(`[buddy] ${note}`);
  await uploadNightscoutNote(now, note).catch(() => {});
  await Notifications.scheduleNotificationAsync({
    identifier: `buddy-remote-${now()}`,
    content: { title: result.ok ? 'Remote command' : 'Remote command rejected', body: result.message, sound: false, data: { kind: 'remoteCommand' } },
    trigger: null,
  }).catch(() => {});
}

let handling: Promise<unknown> = Promise.resolve();

/**
 * Receives the `encrypted_data` string of a push message. Commands run one after the other. Never throws.
 */
export function handleRemoteNotification(encryptedData: string): Promise<HandlerOutcome | null> {
  const next = handling.then(async () => {
    const s = useSettings.getState();
    const ctx: HandlerContext = {
      enabled: s.remoteControlEnabled,
      secret: await loadRemoteSecret(),
      deps: realDeps(),
      executedIds: s.remoteCommandIds,
      rememberCommand: (id) => {
        const cur = useSettings.getState().remoteCommandIds;
        useSettings.getState().update({ remoteCommandIds: [...cur, id].slice(-MAX_REMEMBERED_COMMANDS) });
      },
      report: (note, result) => report(note, result),
    };
    return handleEncryptedCommand(encryptedData, ctx);
  });
  handling = next.catch(() => null);
  return next.catch((e) => {
    console.warn(`[buddy] Remote command failed: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  });
}

/** Finds the encrypted message in a push `data` object (Trio sends `{ "encrypted_data": "..." }`). */
export function extractEncryptedData(data: unknown): string | null {
  if (typeof data !== 'object' || data === null) return null;
  const d = data as Record<string, unknown>;
  if (typeof d.encrypted_data === 'string') return d.encrypted_data;
  // FCM data messages and some APNs bridges nest the custom payload as a JSON string.
  for (const key of ['body', 'dataString', 'data']) {
    const v = d[key];
    if (typeof v === 'string') {
      try {
        const inner = extractEncryptedData(JSON.parse(v));
        if (inner) return inner;
      } catch {
        // not JSON
      }
    } else if (typeof v === 'object' && v !== null) {
      const inner = extractEncryptedData(v);
      if (inner) return inner;
    }
  }
  return null;
}

/** Hand the `data` of any push to this; returns whether it carried a remote command. For background tasks too. */
export async function handleRemotePushData(data: unknown): Promise<boolean> {
  const encrypted = extractEncryptedData(data);
  if (!encrypted) return false;
  await handleRemoteNotification(encrypted);
  return true;
}

/** Listens for push messages while the app runs. Returns the unsubscribe function. */
export function startRemoteControlReceiver(): () => void {
  const received = Notifications.addNotificationReceivedListener((n) => void handleRemotePushData(n.request.content.data));
  const response = Notifications.addNotificationResponseReceivedListener((r) => void handleRemotePushData(r.notification.request.content.data));
  return () => {
    received.remove();
    response.remove();
  };
}

export interface RemoteProfileFields {
  readonly bundleIdentifier: string;
  readonly deviceToken: string;
  readonly isAPNSProduction: boolean;
  readonly teamID: string;
  readonly remoteCommands: readonly string[];
}

/** The fields Trio adds to the Nightscout profile so a follower app knows where to send commands (iOS only). */
export async function remoteProfileFields(): Promise<RemoteProfileFields | null> {
  if (Platform.OS !== 'ios' || !useSettings.getState().remoteControlEnabled) return null;
  try {
    const token = await Notifications.getDevicePushTokenAsync();
    if (typeof token.data !== 'string' || !token.data) return null;
    return {
      bundleIdentifier: Constants.expoConfig?.ios?.bundleIdentifier ?? '',
      deviceToken: token.data,
      isAPNSProduction: !(typeof __DEV__ !== 'undefined' && __DEV__),
      teamID: Constants.expoConfig?.ios?.appleTeamId ?? '',
      remoteCommands: COMMAND_TYPES,
    };
  } catch {
    return null;
  }
}

export type { CommandPayload, HandlerOutcome };
export { REMOTE_MEAL_NOTE };
