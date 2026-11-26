import type { BleManagerOptions } from 'react-native-ble-plx';

/**
 * CoreBluetooth state restoration (iOS). With the "bluetooth-central" background mode (react-native-ble-plx
 * plugin, `isBackgroundEnabled`) and a restore identifier, iOS relaunches the app in the background when a
 * connected pump/CGM peripheral has data or reconnects, even after iOS terminated the app for memory. That is
 * how a Bluetooth CGM keeps the loop running on iOS; it does not apply to peripherals that were never connected
 * or to an app the user force-quit from the app switcher (iOS does not relaunch force-quit apps).
 * Android ignores both options.
 */
export const BLE_RESTORE_IDENTIFIER = 'dev.buddy.app.ble-central';

export const BLE_MANAGER_OPTIONS: BleManagerOptions = {
  restoreStateIdentifier: BLE_RESTORE_IDENTIFIER,
  restoreStateFunction: (restored) => {
    // The transport reconnects on demand by device id; restoring only has to keep CoreBluetooth's connections alive.
    console.log(`[buddy] BLE state restored: ${restored?.connectedPeripherals.length ?? 0} connected peripheral(s)`);
  },
};
