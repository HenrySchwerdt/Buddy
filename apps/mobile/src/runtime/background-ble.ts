import type { BleManagerOptions } from 'react-native-ble-plx';

/**
 * CoreBluetooth state restoration (iOS). With the "bluetooth-central" background mode (react-native-ble-plx
 * plugin, `isBackgroundEnabled`) and a restore identifier, iOS keeps the app's scans (with a service filter) and
 * pending connects alive while the app is suspended, wakes it for a discovery, a connect, a notification or a
 * disconnect, and relaunches it in the background when iOS terminated it in the meantime (memory pressure). That is
 * how a Bluetooth CGM, a pump link or a heartbeat transmitter keeps the loop running on iOS. It does not apply to
 * an app the user force-quit from the app switcher (iOS does not relaunch force-quit apps), and a relaunch restores
 * only what CoreBluetooth still holds: the runtime arms the scans and connects again when it starts.
 * Android ignores both options.
 */
export const BLE_RESTORE_IDENTIFIER = 'dev.buddy.app.ble-central';

type RestoreHandler = (connectedPeripherals: number) => void;
let onRestored: RestoreHandler | null = null;

/** The runtime registers what to do after a relaunch (start itself, re-arm the CGM and the heartbeat transmitter). */
export function setBleRestoreHandler(handler: RestoreHandler | null): void {
  onRestored = handler;
}

export const BLE_MANAGER_OPTIONS: BleManagerOptions = {
  restoreStateIdentifier: BLE_RESTORE_IDENTIFIER,
  restoreStateFunction: (restored) => {
    const connected = restored?.connectedPeripherals.length ?? 0;
    console.log(`[buddy] BLE state restored: ${connected} connected peripheral(s)`);
    onRestored?.(connected);
  },
};
