/**
 * GATT layout of the Syai Ultra sensor. TypeScript port of SyaiGATT.swift from SyaiKit
 * (MIT, © 2026 Nightscout Foundation).
 *
 * SyaiKit looks characteristics up by UUID alone; Buddy's `BleConnection` also needs the service,
 * so `CHARACTERISTIC_SERVICES` records the service(s) each one is expected under. Only the
 * ctl/auth/deviceInfo placements are documented in SyaiKit; the others are listed with the
 * remaining services as fallbacks and must be confirmed on hardware (see `gatt.ts`).
 */
export const SYAI_ID = 'syai-ultra';

const base = (short: string): string => `0000${short}-0000-1000-8000-00805f9b34fb`;

export const SERVICE = {
  deviceInfo: base('180a'),
  auth: 'e06e1d43-1319-4ebf-94b0-5b0e5313b1f4',
  /** Also the advertised scan-filter service: an awake sensor advertises it plus its MAC. */
  cgm: base('181f'),
  /** Vendor control service (`ctlDevice`, `ctlGluDataIdx`). */
  ctl: '84c5b711-655a-460d-89ca-337dbc981857',
} as const;

export const CHAR = {
  softVersion: base('2a28'),
  /** Routine `0x77XX` status frames on every connect; nothing here may latch a blocking fault. */
  errorInfo: 'cb627922-4e79-42e3-b107-a10e816f6caa',
  /** Read for the auth `index`. */
  currentTime: base('2a2b'),
  /** App to device, 68 B: idx(2 LE) | index(2 LE) | pubX(32) | pubY(32). */
  authHost: '1756ef6e-884b-4eb0-b646-f04ab18408f9',
  /** Device to app, 68 B: idx(1) | time(3) | pubX(32) | pubY(32). */
  authDev: '86805092-92b5-4d8c-9d73-0785ff6f9147',
  /** Device signature on read, app signature on write (32 B each). */
  authFlag: '785022c6-08c0-48af-ad17-684bb889aa83',
  newGlucose: base('2aa7'),
  glucoseRecord: '69e4f45f-a180-422c-83c0-324146402112',
  requestByCount: 'ccecb015-6750-41fd-ba78-3fb77d350574',
  /** Lifecycle state: 0 initialize, 1 self-test, 2 inactive, 3 activated/healthy, >= 4 latched fault. */
  cmd: 'd78d0706-c775-448d-8a78-01215e7c2e11',
  /** Device control, write only. Only the BLE-interval profile is ever written here. */
  ctlDevice: '6aa799b6-b374-4148-8f36-6d440c0ec203',
  ctlGluDataIdx: 'c8693b6f-f850-44cb-b9b4-ac87ed962bac',
  activeDuration: 'b8fd9848-0ccd-423f-bd34-2419aa7ea004',
} as const;

/** Services to try for each characteristic, most likely first. */
export const CHARACTERISTIC_SERVICES: Readonly<Record<string, readonly string[]>> = {
  [CHAR.softVersion]: [SERVICE.deviceInfo, SERVICE.cgm, SERVICE.auth, SERVICE.ctl],
  [CHAR.activeDuration]: [SERVICE.deviceInfo, SERVICE.cgm, SERVICE.auth, SERVICE.ctl],
  [CHAR.authHost]: [SERVICE.auth, SERVICE.cgm, SERVICE.deviceInfo, SERVICE.ctl],
  [CHAR.authDev]: [SERVICE.auth, SERVICE.cgm, SERVICE.deviceInfo, SERVICE.ctl],
  [CHAR.authFlag]: [SERVICE.auth, SERVICE.cgm, SERVICE.deviceInfo, SERVICE.ctl],
  [CHAR.ctlDevice]: [SERVICE.ctl, SERVICE.cgm, SERVICE.auth, SERVICE.deviceInfo],
  [CHAR.ctlGluDataIdx]: [SERVICE.ctl, SERVICE.cgm, SERVICE.auth, SERVICE.deviceInfo],
  [CHAR.newGlucose]: [SERVICE.cgm, SERVICE.auth, SERVICE.deviceInfo, SERVICE.ctl],
  [CHAR.glucoseRecord]: [SERVICE.cgm, SERVICE.auth, SERVICE.deviceInfo, SERVICE.ctl],
  [CHAR.requestByCount]: [SERVICE.cgm, SERVICE.auth, SERVICE.deviceInfo, SERVICE.ctl],
  [CHAR.errorInfo]: [SERVICE.cgm, SERVICE.auth, SERVICE.deviceInfo, SERVICE.ctl],
  [CHAR.cmd]: [SERVICE.cgm, SERVICE.auth, SERVICE.deviceInfo, SERVICE.ctl],
  [CHAR.currentTime]: [SERVICE.cgm, SERVICE.auth, SERVICE.deviceInfo, SERVICE.ctl],
};

/** cmd characteristic: 0 initialize, 1 self-test, 2 unactivated, 3 healthy, 4+ dead. */
export const HEALTHY_CMD_STATE = 3;

/** `writeBleIntervalSetting` fast profile written once after auth: `08 19 1a 04 06`. */
export const BLE_INTERVAL_FRAME: Uint8Array = new Uint8Array([0x08, 25, 26, 4, 6]);

/** mg/dL per mmol/L (blood-glucose molar mass), matching Nightscout and xDrip. */
export const MMOL_TO_MGDL = 18.01559;
