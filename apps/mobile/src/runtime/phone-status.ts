import * as Battery from 'expo-battery';
import Constants from 'expo-constants';
import type { DeviceStatusOptions } from '@buddy/nightscout';

/** Phone battery and app version for Nightscout's devicestatus (Trio `Uploader.battery` / `isCharging`). */
export async function readPhoneStatus(): Promise<DeviceStatusOptions> {
  const version = Constants.expoConfig?.version;
  const out: { version?: string; uploaderBattery?: number; isCharging?: boolean } = version ? { version } : {};
  try {
    const level = await Battery.getBatteryLevelAsync();
    if (level >= 0) out.uploaderBattery = Math.round(level * 100);
    const state = await Battery.getBatteryStateAsync();
    if (state !== Battery.BatteryState.UNKNOWN) out.isCharging = state === Battery.BatteryState.CHARGING || state === Battery.BatteryState.FULL;
  } catch {
    // Battery information is optional.
  }
  return out;
}
