import * as Notifications from 'expo-notifications';
import { PermissionsAndroid, Platform } from 'react-native';
import { bleTransport } from '@/runtime/transports/ble';
import { now } from '@/runtime/runtime';
import { useSettings } from '@/runtime/settings-store';
import { buildSettings, pumpModel } from './logic';
import { useOnboardingDraft, useOnboardingPrefs } from './store';

const OREF_SMB = 'oref-smb';

/**
 * Notification step: asks when undetermined, reports `denied` so the caller can show Trio's
 * "Notifications … are Disabled" alert.
 */
export async function requestNotifications(): Promise<'granted' | 'denied'> {
  try {
    const current = await Notifications.getPermissionsAsync();
    if (current.granted) return 'granted';
    if (current.status === 'denied' && !current.canAskAgain) return 'denied';
    const asked = await Notifications.requestPermissionsAsync({ ios: { allowAlert: true, allowSound: true, allowBadge: true, allowCriticalAlerts: true } });
    useOnboardingPrefs.getState().update({ notificationsGranted: asked.granted });
    // Trio advances after the system prompt either way.
    return 'granted';
  } catch {
    return 'denied';
  }
}

/** Bluetooth step: triggers the system prompt (CoreBluetooth manager creation / Android runtime permissions). */
export async function requestBluetooth(): Promise<boolean> {
  try {
    if (Platform.OS === 'android' && Number(Platform.Version) >= 31) {
      const r = await PermissionsAndroid.requestMultiple([PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN, PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT]);
      return Object.values(r).every((v) => v === PermissionsAndroid.RESULTS.GRANTED);
    }
    const state = await bleTransport.state();
    return state !== 'unauthorized';
  } catch {
    return false;
  }
}

/** `saveOnboardingData()` + `completeOnboarding()`: writes everything and flips `onboarded`. */
export function finishOnboarding(): void {
  const draft = useOnboardingDraft.getState();
  const settings = useSettings.getState();
  const { profile, limits, orefSettings } = buildSettings(draft, {
    profile: settings.profile,
    limits: settings.limits,
    orefSettings: settings.algorithmSettings[OREF_SMB] ?? {},
  });
  const ns = draft.nightscout;
  const nightscoutConfigured = ns.setup === 'setup' && ns.connected;

  useOnboardingPrefs.getState().update({
    pumpModelId: draft.pumpModelId,
    basalIncrement: pumpModel(draft.pumpModelId).basal.step,
    maxCOB: draft.maxCOB,
    disclaimerAcknowledgedAt: now(),
    ...(nightscoutConfigured ? { nightscoutUploadGlucose: ns.uploadGlucose, nightscoutUploadCGMSensorStates: ns.uploadCGMSensorStates } : {}),
  });
  settings.setAlgorithmSettings(OREF_SMB, orefSettings);
  settings.update({
    onboarded: true,
    units: draft.units,
    profile,
    limits,
    ...(nightscoutConfigured ? { nightscoutUrl: ns.url, nightscoutUpload: ns.uploadEnabled } : {}),
  });
}
