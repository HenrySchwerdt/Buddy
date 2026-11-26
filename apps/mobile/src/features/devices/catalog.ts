/**
 * Port of Trio's `DeviceCatalog` (APS/Devices/DeviceCatalog.swift): every pump and CGM the
 * picker shows, grouped by manufacturer, mapped to Buddy's device plugins.
 *
 * Devices Buddy has no driver for keep their place in Trio's order but are not selectable
 * (`pluginId: null`). Simulators are only offered in development builds.
 */

export type DeviceKind = 'pump' | 'cgm';

export type Manufacturer = 'Abbott' | 'Dexcom' | 'Insulet' | 'Medtronic' | 'Medtrum' | 'Roche' | 'Senseonics' | 'SOOIL' | 'Syai' | 'Other Sources' | 'Simulator';

/** Every artwork key. Each one needs a file in `DEVICE_IMAGES` (device-icon.tsx), checked by the catalog tests. */
export const DEVICE_IMAGE_KEYS = [
  'omnipod',
  'omnipod-dash',
  'minimed',
  'insight',
  'medtrum-nano',
  'dana',
  'rileylink',
  'pump-simulator',
  'libre',
  'libre-3',
  'dexcom-g5',
  'dexcom-g6',
  'dexcom-g7',
  'dexcom-share',
  'accu-chek',
  'eversense',
  'syai',
  'nightscout',
  'xdrip',
  'cgm-simulator',
] as const;

export type DeviceImage = (typeof DEVICE_IMAGE_KEYS)[number];

export interface CatalogEntry {
  /** Stable id of the picker entry (Trio's catalog id). */
  readonly id: string;
  readonly kind: DeviceKind;
  readonly manufacturer: Manufacturer;
  readonly name: string;
  /** Secondary line ("Classic, DASH, 5"). */
  readonly supportedModels: readonly string[];
  readonly image: DeviceImage | null;
  /** Template artwork (outline drawings) is tinted with the accent colour like in Trio. */
  readonly templateImage?: boolean;
  /**
   * Buddy plugin that backs this entry. `null`: Buddy has no driver.
   * Libre 1/2/2+ is backed by two plugins (direct or via a transmitter); the setup step picks one.
   */
  readonly pluginIds: readonly string[];
}

export const NOT_SUPPORTED = 'Not supported in Buddy';

const pump = (e: Omit<CatalogEntry, 'kind'>): CatalogEntry => ({ ...e, kind: 'pump' });
const cgm = (e: Omit<CatalogEntry, 'kind'>): CatalogEntry => ({ ...e, kind: 'cgm' });

/** Order inside a manufacturer section is the order shown (as in Trio). */
export const PUMP_CATALOG: readonly CatalogEntry[] = [
  pump({ id: 'Omni', manufacturer: 'Insulet', name: 'Omnipod DASH', supportedModels: [], image: 'omnipod-dash', pluginIds: ['omnipod-dash'] }),
  pump({ id: 'OmniEros', manufacturer: 'Insulet', name: 'Omnipod Classic', supportedModels: ['Eros, needs a RileyLink'], image: 'omnipod', pluginIds: ['omnipod-eros'] }),
  pump({ id: 'Minimed500', manufacturer: 'Medtronic', name: 'MiniMed', supportedModels: ['x15', 'x22', 'x23', 'x54'], image: 'minimed', templateImage: true, pluginIds: [] }),
  pump({ id: 'Medtrum', manufacturer: 'Medtrum', name: 'Medtrum Nano', supportedModels: ['200U', '300U'], image: 'medtrum-nano', pluginIds: ['medtrum-nano'] }),
  pump({ id: 'Dana', manufacturer: 'SOOIL', name: 'Dana', supportedModels: ['DanaRS', 'Dana-i'], image: 'dana', pluginIds: ['dana-i'] }),
  pump({ id: 'MockPumpManager', manufacturer: 'Simulator', name: 'Pump Simulator', supportedModels: [], image: 'pump-simulator', templateImage: true, pluginIds: ['demo-pump'] }),
];

export const CGM_CATALOG: readonly CatalogEntry[] = [
  cgm({ id: 'LibreTransmitterManagerV3', manufacturer: 'Abbott', name: 'FreeStyle Libre 1 / 2 / 2+', supportedModels: [], image: 'libre', pluginIds: ['libre-2-direct', 'libre-transmitter'] }),
  cgm({ id: 'LibreLoopDirect', manufacturer: 'Abbott', name: 'FreeStyle Libre 3 / 3+ (direct)', supportedModels: ['Bluetooth, needs app credential'], image: 'libre-3', pluginIds: ['libre-3-direct'] }),
  cgm({ id: 'LibreLoopCGMManager', manufacturer: 'Abbott', name: 'FreeStyle Libre 3 / 3+ (cloud)', supportedModels: ['via LibreLinkUp, delayed'], image: 'libre-3', pluginIds: ['libre-link-up'] }),
  cgm({ id: 'DexG5Transmitter', manufacturer: 'Dexcom', name: 'Dexcom G5', supportedModels: [], image: 'dexcom-g5', pluginIds: ['dexcom-g6'] }),
  cgm({ id: 'DexG6Transmitter', manufacturer: 'Dexcom', name: 'Dexcom G6 / ONE', supportedModels: [], image: 'dexcom-g6', pluginIds: ['dexcom-g6'] }),
  cgm({ id: 'G7CGMManager', manufacturer: 'Dexcom', name: 'Dexcom G7 / ONE+ / Stelo', supportedModels: [], image: 'dexcom-g7', pluginIds: ['dexcom-g7'] }),
  cgm({ id: 'AccuChek', manufacturer: 'Roche', name: 'Accu-Chek SmartGuide', supportedModels: [], image: 'accu-chek', pluginIds: [] }),
  cgm({ id: 'EversenseKit', manufacturer: 'Senseonics', name: 'Eversense', supportedModels: ['E3', 'E365'], image: 'eversense', pluginIds: [] }),
  cgm({ id: 'SyaiCGMManager', manufacturer: 'Syai', name: 'Syai Ultra', supportedModels: [], image: 'syai', pluginIds: ['syai-ultra'] }),
  cgm({ id: 'nightscout', manufacturer: 'Other Sources', name: 'Nightscout as CGM', supportedModels: [], image: 'nightscout', templateImage: true, pluginIds: ['nightscout-cgm'] }),
  cgm({ id: 'dexcomShare', manufacturer: 'Other Sources', name: 'Dexcom Share', supportedModels: [], image: 'dexcom-share', templateImage: true, pluginIds: ['dexcom-share'] }),
  cgm({ id: 'xdrip', manufacturer: 'Other Sources', name: 'xDrip4iOS', supportedModels: [], image: 'xdrip', templateImage: true, pluginIds: [] }),
  cgm({ id: 'simulator', manufacturer: 'Simulator', name: 'Glucose Simulator', supportedModels: [], image: 'cgm-simulator', templateImage: true, pluginIds: ['demo-cgm'] }),
];

export const catalogFor = (kind: DeviceKind): readonly CatalogEntry[] => (kind === 'pump' ? PUMP_CATALOG : CGM_CATALOG);

export const isSupported = (e: CatalogEntry): boolean => e.pluginIds.length > 0;

/** Trio's `DeviceManufacturer.sortRank`: real hardware alphabetically, then relays, then simulators. */
const sortRank = (m: Manufacturer): number => (m === 'Other Sources' ? 1 : m === 'Simulator' ? 2 : 0);

export interface CatalogSection {
  readonly manufacturer: Manufacturer;
  readonly entries: readonly CatalogEntry[];
}

/** `DeviceCatalog.sections(for:)`; simulators only when `includeSimulators` (Buddy: `__DEV__`). */
export function catalogSections(entries: readonly CatalogEntry[], includeSimulators: boolean): CatalogSection[] {
  const visible = entries.filter((e) => includeSimulators || e.manufacturer !== 'Simulator');
  const manufacturers = [...new Set(visible.map((e) => e.manufacturer))].sort((a, b) => sortRank(a) - sortRank(b) || a.localeCompare(b));
  return manufacturers.map((manufacturer) => ({ manufacturer, entries: visible.filter((e) => e.manufacturer === manufacturer) }));
}

export const modelsLine = (e: CatalogEntry): string | null => (e.supportedModels.length ? e.supportedModels.join(', ') : null);

/**
 * Catalog entry shown for an active plugin. `preferredEntryId` disambiguates plugins that back
 * several entries (G5 vs G6 both run on the `dexcom-g6` driver).
 */
export function entryForPlugin(kind: DeviceKind, pluginId: string, preferredEntryId?: string | null): CatalogEntry | null {
  const matches = catalogFor(kind).filter((e) => e.pluginIds.includes(pluginId));
  return matches.find((e) => e.id === preferredEntryId) ?? matches[0] ?? null;
}

// ── Setup validation (fail fast before a driver is built) ─────────────────────

const DANA_NAME = /^[a-zA-Z]{3}[0-9]{5}[a-zA-Z]{2}$/;
const MEDTRUM_SERIAL = /^[0-9a-fA-F]{8}$/;
const DEXCOM_TRANSMITTER = /^[0-9A-Za-z]{6}$/;

type Values = Readonly<Record<string, string | number | boolean | undefined>>;
const text = (v: Values, k: string) => String(v[k] ?? '').trim();

/** Driver-specific checks the generic schema cannot express; returns human-readable errors. */
export function setupErrors(pluginId: string, values: Values): string[] {
  switch (pluginId) {
    case 'dana-i':
      return DANA_NAME.test(text(values, 'deviceName')) ? [] : ['Select your pump, or enter its Bluetooth name (3 letters, 5 digits, 2 letters, e.g. ABC12345DE).'];
    case 'medtrum-nano':
      return MEDTRUM_SERIAL.test(text(values, 'serialNumber')) ? [] : ['The serial number has 8 hexadecimal characters (e.g. 1234ABCD).'];
    case 'dexcom-g6':
      return DEXCOM_TRANSMITTER.test(text(values, 'transmitterId')) ? [] : ['The transmitter ID has 6 characters.'];
    case 'nightscout-cgm':
      return /^https:\/\/\S+$/.test(text(values, 'url')) ? [] : ['Enter your Nightscout URL, starting with https://.'];
    case 'dexcom-share':
      return text(values, 'username') && text(values, 'password') ? [] : ['Enter your Dexcom account username and password.'];
    case 'syai-ultra':
      return text(values, 'email') && text(values, 'password') ? [] : ['Enter your Syai account email and password.'];
    case 'libre-link-up':
      return text(values, 'email') && text(values, 'password') ? [] : ['Enter your LibreLinkUp follower email and password.'];
    default:
      return [];
  }
}
