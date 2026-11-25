import * as SecureStore from 'expo-secure-store';
import { NIGHTSCOUT_TOKEN_KEY } from '@/runtime/services';
import { useSettings } from '@/runtime/settings-store';
import { importTherapy, normalizeNightscoutUrl, pumpModel } from './logic';
import { useOnboardingDraft } from './store';

const query = (token: string) => (token ? `?${new URLSearchParams({ token }).toString()}` : '');

/** Reads the URL/token stored by an earlier install (Trio pre-fills from the keychain). */
export async function prefillNightscout(): Promise<void> {
  const url = useSettings.getState().nightscoutUrl;
  const token = (await SecureStore.getItemAsync(NIGHTSCOUT_TOKEN_KEY).catch(() => null)) ?? '';
  const ns = useOnboardingDraft.getState().nightscout;
  useOnboardingDraft.getState().setNightscout({ url: ns.url || url, token: ns.token || token });
}

/**
 * `connectToNightscout()`: requires https, verifies the token against `/api/v1/verifyauth`,
 * then stores URL (settings) and token (SecureStore).
 */
export async function connectToNightscout(): Promise<void> {
  const { nightscout, setNightscout } = useOnboardingDraft.getState();
  const url = normalizeNightscoutUrl(nightscout.url);
  if (!url) {
    setNightscout({ responseMessage: 'Invalid URL', url: nightscout.url.trim().replace(/\/$/, '') });
    return;
  }
  setNightscout({ url, connecting: true, responseMessage: '' });
  try {
    const res = await fetch(`${url}/api/v1/verifyauth${query(nightscout.token)}`, { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = (await res.json()) as { message?: { message?: string; canRead?: boolean } };
    const verdict = body.message?.message;
    if (verdict && verdict !== 'OK') throw new Error(verdict === 'UNAUTHORIZED' ? 'Unauthorized' : verdict);
    await SecureStore.setItemAsync(NIGHTSCOUT_TOKEN_KEY, nightscout.token);
    useSettings.getState().update({ nightscoutUrl: url });
    setNightscout({ connected: true });
  } catch (e) {
    setNightscout({ responseMessage: `Error: ${e instanceof Error ? e.message : String(e)}` });
  } finally {
    setTimeout(() => useOnboardingDraft.getState().setNightscout({ connecting: false }), 1000);
  }
}

/** `importSettingsFromNightscout()`: fetches the profile and fills the therapy schedules. Throws with Trio's messages. */
export async function importFromNightscout(): Promise<void> {
  const draft = useOnboardingDraft.getState();
  const { url, token, connected } = draft.nightscout;
  if (!connected) return;
  draft.setNightscout({ importStatus: 'running' });
  try {
    const res = await fetch(`${url}/api/v1/profile.json${query(token)}`, { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`Nightscout HTTP ${res.status}`);
    const imported = importTherapy(await res.json(), pumpModel(draft.pumpModelId));
    draft.set({ units: imported.units, targets: imported.targets, basal: imported.basal, carbRatios: imported.carbRatios, isf: imported.isf });
    await new Promise((r) => setTimeout(r, 1500));
    draft.setNightscout({ importStatus: 'finished' });
  } catch (e) {
    draft.setNightscout({ importStatus: 'failed' });
    throw e;
  }
}
