import Constants from 'expo-constants';
import * as Crypto from 'expo-crypto';
import { makeRedirectUri } from 'expo-auth-session';
import * as WebBrowser from 'expo-web-browser';
import { create } from 'zustand';
import { scheduleValueAt } from '@buddy/core';
import {
  TIDEPOOL_ENVIRONMENTS,
  TidepoolLoginCancelledError,
  createTidepoolApi,
  createTidepoolAuth,
  createTidepoolUploader,
  needsReauthentication,
  type TidepoolAuth,
  type TidepoolSession,
  type TidepoolUploader,
  type TidepoolUploaderState,
} from '@buddy/tidepool';
import type { RecordKind } from './record-deletion';
import { recentPart } from './history-archive';
import { glucoseSource } from './record-ids';
import type { ServiceHost } from './service-host';
import { useSettings } from './settings-store';
import { keychainSecretStore } from './transports/secret-store';

/**
 * Tidepool (Trio TidepoolService): OIDC PKCE sign-in in the system browser, session in the keychain,
 * and an upload after every loop. `@buddy/tidepool` does the protocol; this wires it to the app.
 */

const CLIENT_NAME = 'org.nightscout.Buddy';
const REDIRECT_PATH = 'tidepool-auth';

export const tidepoolRedirectUri = (): string => makeRedirectUri({ scheme: 'buddy', path: REDIRECT_PATH });

const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

const log = {
  info: () => {},
  warn: (m: string) => console.warn(`[tidepool] ${m}`),
  error: (m: string) => console.warn(`[tidepool] ${m}`),
};

export interface TidepoolStatus {
  readonly signedIn: boolean;
  readonly username: string;
  readonly lastOk: number | null;
  readonly lastError: string | null;
  /** The refresh token was refused: sign in again. */
  readonly reauthRequired: boolean;
}

export const useTidepoolStatus = create<TidepoolStatus>(() => ({ signedIn: false, username: '', lastOk: null, lastError: null, reauthRequired: false }));

const applySession = (s: TidepoolSession | null) =>
  useTidepoolStatus.setState({ signedIn: s !== null, username: s?.username ?? '', ...(s ? { reauthRequired: false } : {}) });

let auth: TidepoolAuth | null = null;
let authClientId = '';

/** The auth client for the configured OAuth client id, or null while none is set. */
export function getTidepoolAuth(): TidepoolAuth | null {
  const clientId = useSettings.getState().tidepoolClientId.trim();
  if (!clientId) return null;
  if (!auth || authClientId !== clientId) {
    authClientId = clientId;
    auth = createTidepoolAuth({
      clientId,
      redirectUri: tidepoolRedirectUri(),
      secrets: keychainSecretStore,
      fetch: globalThis.fetch.bind(globalThis),
      environment: TIDEPOOL_ENVIRONMENTS[useSettings.getState().tidepoolEnvironment],
      log,
      random: (n) => Crypto.getRandomBytes(n),
      openAuthSession: async (url, redirectUri) => {
        const result = await WebBrowser.openAuthSessionAsync(url, redirectUri);
        if (result.type !== 'success') throw new TidepoolLoginCancelledError();
        return result.url;
      },
    });
    auth.subscribe(applySession);
  }
  return auth;
}

/** Loads the stored session into the status store (call when the screen opens or the app starts). */
export async function refreshTidepoolStatus(): Promise<void> {
  const a = getTidepoolAuth();
  applySession(a ? await a.getSession().catch(() => null) : null);
}

export async function tidepoolLogin(): Promise<void> {
  const a = getTidepoolAuth();
  if (!a) throw new Error('Enter the Tidepool OAuth client id first.');
  await a.login({ environment: TIDEPOOL_ENVIRONMENTS[useSettings.getState().tidepoolEnvironment] });
}

export async function tidepoolLogout(): Promise<void> {
  const a = getTidepoolAuth();
  useSettings.getState().update({ tidepoolUpload: false, tidepoolState: {} });
  if (a) await a.logout();
  uploader = null;
  applySession(null);
}

let uploader: TidepoolUploader | null = null;
let hostRef: ServiceHost | null = null;

/** The runtime host, so deletions can build the uploader before the first upload of a session. */
export const setTidepoolHost = (host: ServiceHost): void => {
  hostRef = host;
};
let uploaderKey = '';

function getUploader(host: ServiceHost): TidepoolUploader | null {
  const a = getTidepoolAuth();
  if (!a) return null;
  const s = useSettings.getState();
  const key = `${s.tidepoolClientId}|${s.tidepoolEnvironment}`;
  if (!uploader || key !== uploaderKey) {
    uploaderKey = key;
    const api = createTidepoolApi({ auth: a, fetch: globalThis.fetch.bind(globalThis), log });
    uploader = createTidepoolUploader({
      api,
      auth: a,
      clock: { now: () => host.now() },
      log,
      clientName: CLIENT_NAME,
      clientVersion: Constants.expoConfig?.version ?? '0.0.0',
      scheduledBasalAt: (date) => {
        const p = useSettings.getState().profile;
        return scheduleValueAt(p.basal, date, p.utcOffsetMinutes);
      },
      initialState: s.tidepoolState as Partial<TidepoolUploaderState>,
    });
  }
  return uploader;
}

/** Uploads what is new. Never throws. */
export async function uploadToTidepool(host: ServiceHost): Promise<void> {
  const s = useSettings.getState();
  if (!s.tidepoolUpload || host.isDemo()) return;
  const u = getUploader(host);
  if (!u) return;
  try {
    // The store keeps months of history; only the recent part is (re)sent.
    const snap = recentPart(host.store.snapshot(), host.now());
    const result = await u.upload({
      glucose: snap.glucose,
      doses: snap.doses,
      carbs: snap.carbs,
      settings: { date: host.now(), profile: s.profile, limits: s.limits, glucoseUnit: s.units },
    });
    if (result.skipped) {
      if (result.reason === 'signed-out') useTidepoolStatus.setState({ signedIn: false });
      return;
    }
    const failed = Object.entries(result.collections).filter(([, r]) => !r.ok);
    useTidepoolStatus.setState(
      failed.length
        ? { lastError: failed.map(([k, r]) => `${k}: ${'error' in r ? r.error : ''}`).join(', '), reauthRequired: result.reauthRequired }
        : { lastOk: host.now(), lastError: null, reauthRequired: false },
    );
    useSettings.getState().update({ tidepoolState: u.getState() as unknown as Record<string, unknown> });
  } catch (e) {
    useTidepoolStatus.setState({ lastError: errorText(e), reauthRequired: needsReauthentication(e) });
  }
}

/** Removes a record from Tidepool (Trio `deleteCarbs` / `deleteInsulin` / `deleteGlucose`). No-op while upload is off or signed out. */
export async function deleteFromTidepool(kind: RecordKind, id: string, date: number): Promise<{ ok: boolean; error?: string }> {
  const s = useSettings.getState();
  if (!s.tidepoolUpload || !hostRef) return { ok: true };
  const uploader = getUploader(hostRef);
  if (!uploader) return { ok: true };
  const request =
    kind === 'carbs'
      ? { carbs: [{ id }] }
      : kind === 'glucose'
        ? { glucose: [{ date, value: 0, source: glucoseSource(id, date) }] }
        : { doses: [{ kind: 'bolus' as const, id, date, units: 0 }] };
  const r = await uploader.delete(request);
  return r.ok ? { ok: true } : { ok: false, error: r.error };
}
