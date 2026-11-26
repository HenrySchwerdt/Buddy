/**
 * Protocol models of the Insight bridge (port of InsightKit/Protocol/BridgeModels.swift and
 * BridgeProtocol.swift): operations, errors and lenient parsers for everything the bridge sends.
 *
 * Parsing never trusts the shape of a message: every reader returns `null` / a flag for what it
 * could not read, and callers treat "unreadable" as "unknown", never as "nothing".
 */
import { MAX_CLOCK_SKEW_MS } from './constants';

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export const isObject = (v: unknown): v is JsonObject => typeof v === 'object' && v !== null && !Array.isArray(v);
export const asNumber = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
/** Whole numbers only. */
export const asInt = (v: unknown): number | null => (typeof v === 'number' && Number.isSafeInteger(v) ? v : null);
export const asString = (v: unknown): string | null => (typeof v === 'string' ? v : null);
export const asBool = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null);
export const asArray = (v: unknown): JsonValue[] | null => (Array.isArray(v) ? v : null);
/** ISO-8601 (with or without fractional seconds) to epoch milliseconds. */
export function asDate(v: unknown): number | null {
  if (typeof v !== 'string') return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}
/** Epoch milliseconds to the bridge's ISO-8601 UTC format without fractions (`2026-11-18T10:00:00Z`). */
export const formatBridgeDate = (ms: number): string => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

// ── operations ───────────────────────────────────────────────────────────────

export type BridgeOp =
  | 'hello'
  | 'getStatus'
  | 'deliverBolus'
  | 'cancelBolus'
  | 'setTBR'
  | 'cancelTBR'
  | 'setOperatingMode'
  | 'setBasalProfile'
  | 'setDateTime'
  | 'readHistory'
  | 'confirmAlert'
  | 'snoozeAlert'
  | 'getRequestOutcome'
  | 'pumpPairingStatus'
  | 'ping';

const DOSING_OPS: ReadonlySet<BridgeOp> = new Set(['cancelBolus', 'cancelTBR', 'deliverBolus', 'setBasalProfile', 'setOperatingMode', 'setTBR']);

/** Ops that change what the pump delivers (or may). A timeout on those is "uncertain". */
export const isDosingOp = (op: BridgeOp): boolean => DOSING_OPS.has(op);

// ── errors ───────────────────────────────────────────────────────────────────

export type BridgeErrorCode =
  | 'notPaired'
  | 'pumpUnreachable'
  | 'pumpSuspended'
  | 'pumpBusy'
  | 'invalidArgs'
  | 'limitExceeded'
  | 'verifyFailed'
  | 'alertActive'
  | 'busy'
  | 'tooLarge'
  | 'unsupportedProtocol'
  | 'internal'
  | 'unknown';

const ERROR_CODES: ReadonlySet<string> = new Set([
  'notPaired',
  'pumpUnreachable',
  'pumpSuspended',
  'pumpBusy',
  'invalidArgs',
  'limitExceeded',
  'verifyFailed',
  'alertActive',
  'busy',
  'tooLarge',
  'unsupportedProtocol',
  'internal',
]);

export interface RemoteError {
  readonly code: BridgeErrorCode;
  readonly message: string;
  readonly uncertain: boolean;
}

export function parseRemoteError(v: unknown): RemoteError | null {
  if (!isObject(v)) return null;
  const raw = asString(v.code);
  return {
    code: raw !== null && ERROR_CODES.has(raw) ? (raw as BridgeErrorCode) : 'unknown',
    message: asString(v.message) ?? '',
    uncertain: asBool(v.uncertain) ?? false,
  };
}

export type BridgeErrorKind =
  /** The link/session could not be brought up before the command was sent. Nothing was sent. */
  | 'notConnected'
  /** The link dropped after the command may have been sent. */
  | 'linkLost'
  /** No response in time after the command was sent. */
  | 'timeout'
  | 'remote'
  | 'sessionRejected'
  | 'pairingRejected'
  | 'unsupportedProtocol'
  | 'protocolViolation'
  | 'decoding'
  | 'encoding'
  | 'missingCredentials'
  | 'macMismatch'
  | 'bluetoothUnavailable';

const REMOTE_TEXT: Readonly<Record<BridgeErrorCode, string>> = {
  notPaired: 'The InsightBridge app has no Insight pump paired. Pair the pump in the bridge app first.',
  pumpUnreachable: 'The bridge cannot reach the pump.',
  pumpSuspended: 'The pump is suspended.',
  pumpBusy: 'The pump is busy.',
  alertActive: 'The pump shows an alert that must be confirmed first.',
  busy: 'The bridge is in use by another phone.',
  limitExceeded: 'The requested value exceeds a pump limit.',
  verifyFailed: 'The pump did not confirm the change.',
  invalidArgs: '',
  tooLarge: '',
  unsupportedProtocol: '',
  internal: '',
  unknown: '',
};

/**
 * Everything that can go wrong talking to the bridge. `isUncertainOutcome` is the only property
 * dosing code may use to decide whether a command might have been executed.
 */
export class BridgeError extends Error {
  constructor(
    readonly kind: BridgeErrorKind,
    readonly remote: RemoteError | null = null,
    readonly detail = '',
  ) {
    super(describeError(kind, remote, detail));
    this.name = 'BridgeError';
  }

  /** Whether the command might have been executed by the pump although we got no (valid) success. */
  get isUncertainOutcome(): boolean {
    if (this.kind === 'linkLost' || this.kind === 'timeout') return true;
    return this.kind === 'remote' && this.remote?.uncertain === true;
  }

  get isTimeoutLike(): boolean {
    return this.kind === 'linkLost' || this.kind === 'timeout';
  }

  get remoteCode(): BridgeErrorCode | null {
    return this.remote?.code ?? null;
  }

  static remote(code: BridgeErrorCode, message = '', uncertain = false): BridgeError {
    return new BridgeError('remote', { code, message, uncertain });
  }
}

function describeError(kind: BridgeErrorKind, remote: RemoteError | null, detail: string): string {
  switch (kind) {
    case 'notConnected':
      return 'Not connected to the InsightBridge app.';
    case 'linkLost':
      return 'The connection to the InsightBridge app was lost.';
    case 'timeout':
      return 'The InsightBridge app did not answer in time.';
    case 'remote': {
      if (!remote) return 'The bridge reported an error.';
      return REMOTE_TEXT[remote.code] || remote.message || 'The bridge reported an error.';
    }
    case 'sessionRejected':
      return 'The InsightBridge app does not know this phone. Pair the bridge again.';
    case 'pairingRejected':
      switch (detail) {
        case 'notInPairingMode':
          return 'The bridge is not in pairing mode. Tap "Pair with iPhone" in the InsightBridge app and try again.';
        case 'commitMismatch':
          return 'The bridge rejected the pairing data. Something may be interfering; try again close to the bridge.';
        default:
          return 'Pairing was cancelled.';
      }
    case 'unsupportedProtocol':
      return 'The InsightBridge app uses an incompatible protocol version. Update both apps.';
    case 'protocolViolation':
      return `Invalid data from the InsightBridge app (${detail}).`;
    case 'decoding':
      return `Could not read the answer of the InsightBridge app (${detail}).`;
    case 'encoding':
      return `Could not build the request (${detail}).`;
    case 'missingCredentials':
      return 'This phone is not paired with an InsightBridge app.';
    case 'macMismatch':
      return 'The bridge could not be verified. Pair the bridge again.';
    case 'bluetoothUnavailable':
      return detail || 'Bluetooth is not available.';
  }
}

// ── hello / simple results ───────────────────────────────────────────────────

export interface HelloResult {
  readonly protocolVersion: number | null;
  readonly bridgeVersion: string | null;
  readonly pumpPaired: boolean;
}

export function parseHello(v: unknown): HelloResult | null {
  if (!isObject(v)) return null;
  return { protocolVersion: asInt(v.protocol), bridgeVersion: asString(v.bridgeVersion), pumpPaired: asBool(v.pumpPaired) ?? false };
}

export interface DeliverBolusResult {
  readonly bolusId: number;
  readonly amount: number;
}
export function parseDeliverBolus(v: unknown): DeliverBolusResult | null {
  if (!isObject(v)) return null;
  const bolusId = asInt(v.bolusId);
  const amount = asNumber(v.amount);
  return bolusId === null || amount === null ? null : { bolusId, amount };
}

export interface CancelBolusResult {
  readonly delivered: number | null;
}
export function parseCancelBolus(v: unknown): CancelBolusResult | null {
  if (!isObject(v)) return null;
  return { delivered: asNumber(v.delivered) };
}

export interface SetTbrResult {
  readonly percent: number;
  readonly duration: number;
}
export function parseSetTbr(v: unknown): SetTbrResult | null {
  if (!isObject(v)) return null;
  const percent = asInt(v.percent);
  const duration = asInt(v.duration);
  return percent === null || duration === null ? null : { percent, duration };
}

export interface OperatingModeResult {
  readonly mode: string;
}
export function parseOperatingModeResult(v: unknown): OperatingModeResult | null {
  if (!isObject(v)) return null;
  const mode = asString(v.mode);
  return mode === null ? null : { mode };
}

export interface PumpPairingStatus {
  readonly paired: boolean;
  readonly serial: string | null;
  readonly bridgeBluetoothOn: boolean | null;
}
export function parsePumpPairingStatus(v: unknown): PumpPairingStatus | null {
  if (!isObject(v)) return null;
  const paired = asBool(v.paired);
  return paired === null ? null : { paired, serial: asString(v.serial), bridgeBluetoothOn: asBool(v.bridgeBluetoothOn) };
}

// ── request outcome (v2) ─────────────────────────────────────────────────────

export type RequestOutcomeState = 'unknown' | 'inProgress' | 'succeeded' | 'failed' | 'uncertain';

export interface RequestOutcome {
  readonly state: RequestOutcomeState;
  readonly result: JsonValue | null;
  readonly error: RemoteError | null;
  readonly completedAt: number | null;
}

const OUTCOME_STATES: ReadonlySet<string> = new Set(['unknown', 'inProgress', 'succeeded', 'failed', 'uncertain']);

/** An unreadable state is "unknown": the evidence path decides, never a guess. */
export function parseRequestOutcome(v: unknown): RequestOutcome {
  if (!isObject(v)) return { state: 'unknown', result: null, error: null, completedAt: null };
  const raw = asString(v.state);
  return {
    state: raw !== null && OUTCOME_STATES.has(raw) ? (raw as RequestOutcomeState) : 'unknown',
    result: v.result === undefined ? null : (v.result as JsonValue),
    error: parseRemoteError(v.error),
    completedAt: asDate(v.completedAt),
  };
}

// ── status ───────────────────────────────────────────────────────────────────

export type PumpLinkState = 'connected' | 'connecting' | 'disconnected' | 'notPaired' | 'unknown';
export type PumpOperatingMode = 'started' | 'stopped' | 'paused' | 'unknown';

export const isDelivering = (mode: PumpOperatingMode): boolean => mode === 'started';

const LINK_STATES: ReadonlySet<string> = new Set(['connected', 'connecting', 'disconnected', 'notPaired']);
const MODES: ReadonlySet<string> = new Set(['started', 'stopped', 'paused']);

export interface BridgeTbr {
  readonly percent: number;
  readonly duration: number;
  readonly remaining: number | null;
  readonly start: number | null;
}
export interface ActiveBolus {
  readonly bolusId: number;
  readonly type: string | null;
  readonly amount: number;
  readonly remaining: number;
}
export interface PumpLimits {
  readonly maxBolus: number | null;
  readonly maxBasal: number | null;
  readonly bolusStep: number | null;
  readonly basalStep: number | null;
  readonly minBasal: number | null;
}
export interface PumpTime {
  readonly utc: number | null;
  readonly pumpLocal: string | null;
  readonly driftSeconds: number | null;
}

export type AlertCategory = 'reminder' | 'maintenance' | 'warning' | 'error' | 'unknown';
export interface BridgeAlert {
  readonly alertId: number;
  readonly alertType: string;
  readonly category: AlertCategory;
  readonly status: string | null;
  readonly tbrPercent: number | null;
  readonly remainingInsulin: number | null;
}
const CATEGORIES: ReadonlySet<string> = new Set(['reminder', 'maintenance', 'warning', 'error']);

export function parseAlert(v: unknown): BridgeAlert | null {
  if (!isObject(v)) return null;
  const alertId = asInt(v.alertId);
  const alertType = asString(v.alertType);
  if (alertId === null || alertType === null) return null;
  const cat = asString(v.category);
  return {
    alertId,
    alertType,
    category: cat !== null && CATEGORIES.has(cat) ? (cat as AlertCategory) : 'unknown',
    status: asString(v.status),
    tbrPercent: asInt(v.tbrPercent),
    remainingInsulin: asNumber(v.remainingInsulin),
  };
}
export const isSnoozed = (a: BridgeAlert): boolean => a.status === 'snoozed';

export interface BridgeStatus {
  /** When the bridge last read the pump (epoch ms); `null` if unknown. */
  readonly timestamp: number | null;
  readonly pumpLink: PumpLinkState;
  readonly serial: string | null;
  readonly firmware: string | null;
  readonly operatingMode: PumpOperatingMode;
  readonly batteryPercent: number | null;
  readonly reservoirUnits: number | null;
  readonly cartridgeType: string | null;
  readonly activeProfile: number | null;
  /** Scheduled basal rate at the pump's current time, excluding any TBR. */
  readonly basalRate: number | null;
  readonly tbr: BridgeTbr | null;
  readonly boluses: readonly ActiveBolus[];
  readonly pumpTime: PumpTime | null;
  readonly limits: PumpLimits | null;
  readonly activeAlert: BridgeAlert | null;
  readonly lastHistorySequence: number | null;
  /** The `tbr` field was present but could not be parsed: unknown, which is not the same as "no TBR". */
  readonly tbrIsUnreadable: boolean;
  /** The `boluses` field was present but could not be parsed: unknown, which is not the same as "no bolus". */
  readonly bolusesAreUnreadable: boolean;
}

function parseTbr(v: unknown): BridgeTbr | null {
  if (!isObject(v)) return null;
  const percent = asInt(v.percent);
  const duration = asInt(v.duration);
  if (percent === null || duration === null) return null;
  return { percent, duration, remaining: asInt(v.remaining), start: asDate(v.start) };
}

function parseActiveBolus(v: unknown): ActiveBolus | null {
  if (!isObject(v)) return null;
  const bolusId = asInt(v.bolusId);
  const amount = asNumber(v.amount);
  const remaining = asNumber(v.remaining);
  if (bolusId === null || amount === null || remaining === null) return null;
  return { bolusId, type: asString(v.type), amount, remaining };
}

export function parseStatus(v: unknown): BridgeStatus | null {
  if (!isObject(v)) return null;
  const link = asString(v.pumpLink);
  const mode = asString(v.operatingMode);

  let tbr: BridgeTbr | null = null;
  let tbrIsUnreadable = false;
  if (v.tbr !== undefined && v.tbr !== null) {
    tbr = parseTbr(v.tbr);
    tbrIsUnreadable = tbr === null;
  }

  let boluses: ActiveBolus[] = [];
  let bolusesAreUnreadable = false;
  if (v.boluses !== undefined && v.boluses !== null) {
    const list = asArray(v.boluses);
    const parsed = list?.map(parseActiveBolus) ?? null;
    if (parsed && parsed.every((b): b is ActiveBolus => b !== null)) boluses = parsed;
    else bolusesAreUnreadable = true;
  }

  const battery = isObject(v.battery) ? v.battery : null;
  const reservoir = isObject(v.reservoir) ? v.reservoir : null;
  const basal = isObject(v.basal) ? v.basal : null;
  const pt = isObject(v.pumpTime) ? v.pumpTime : null;
  const lim = isObject(v.limits) ? v.limits : null;

  return {
    timestamp: asDate(v.timestamp),
    pumpLink: link !== null && LINK_STATES.has(link) ? (link as PumpLinkState) : 'unknown',
    serial: asString(v.serial),
    firmware: asString(v.firmware),
    operatingMode: mode !== null && MODES.has(mode) ? (mode as PumpOperatingMode) : 'unknown',
    batteryPercent: battery ? asNumber(battery.percent) : null,
    reservoirUnits: reservoir ? asNumber(reservoir.units) : null,
    cartridgeType: reservoir ? asString(reservoir.cartridgeType) : null,
    activeProfile: basal ? asInt(basal.activeProfile) : null,
    basalRate: basal ? asNumber(basal.rate) : null,
    tbr,
    boluses,
    pumpTime: pt ? { utc: asDate(pt.utc), pumpLocal: asString(pt.pumpLocal), driftSeconds: asNumber(pt.driftSeconds) } : null,
    limits: lim
      ? { maxBolus: asNumber(lim.maxBolus), maxBasal: asNumber(lim.maxBasal), bolusStep: asNumber(lim.bolusStep), basalStep: asNumber(lim.basalStep), minBasal: asNumber(lim.minBasal) }
      : null,
    activeAlert: parseAlert(v.activeAlert),
    lastHistorySequence: asInt(v.lastHistorySequence),
    tbrIsUnreadable,
    bolusesAreUnreadable,
  };
}

/**
 * A status stamped in the future (broken clock on the bridge) must neither win the "newest status"
 * race nor look fresh: its timestamp is dropped (treated as unknown).
 */
export function sanitizeStatus(status: BridgeStatus, now: number): BridgeStatus {
  return status.timestamp !== null && status.timestamp > now + MAX_CLOCK_SKEW_MS ? { ...status, timestamp: null } : status;
}

/** Pump local offset from UTC derived from `pumpTime` (rounded to 15 minutes), `null` if not parsable. */
export function pumpUtcOffsetSeconds(pumpTime: PumpTime | null): number | null {
  if (!pumpTime || pumpTime.utc === null || !pumpTime.pumpLocal) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/.exec(pumpTime.pumpLocal);
  if (!m) return null;
  const naive = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]));
  const steps = Math.round((naive - pumpTime.utc) / 1000 / 900);
  return Number.isFinite(steps) && Math.abs(steps) <= 14 * 4 ? steps * 900 : null;
}

// ── history ──────────────────────────────────────────────────────────────────

export type HistoryEventKind =
  | 'bolusProgrammed'
  | 'bolusDelivered'
  | 'tbrStart'
  | 'tbrEnd'
  | 'basalRateChanged'
  | 'operatingModeChanged'
  | 'cartridgeInserted'
  | 'cartridgeRemoved'
  | 'tubeFilled'
  | 'cannulaFilled'
  | 'totalDailyDose'
  | 'alert'
  | 'dateTimeChanged'
  | 'other';

const KINDS: ReadonlySet<string> = new Set([
  'bolusProgrammed',
  'bolusDelivered',
  'tbrStart',
  'tbrEnd',
  'basalRateChanged',
  'operatingModeChanged',
  'cartridgeInserted',
  'cartridgeRemoved',
  'tubeFilled',
  'cannulaFilled',
  'totalDailyDose',
  'alert',
  'dateTimeChanged',
]);

export interface HistoryEvent {
  readonly seq: number;
  readonly time: number;
  readonly typeName: string;
  readonly kind: HistoryEventKind;
  readonly data: JsonObject;
}

/** What could still be read of a history event that could not be decoded as a whole. */
export interface UnreadableHistoryEvent {
  readonly seq: number | null;
  readonly typeName: string | null;
  readonly time: number | null;
  /** For bolus events: the programmed amount if it was readable. */
  readonly programmed: number | null;
}

export const isBolusEvent = (e: UnreadableHistoryEvent): boolean => e.typeName === 'bolusDelivered' || e.typeName === 'bolusProgrammed';

export interface HistoryPage {
  readonly events: readonly HistoryEvent[];
  readonly unreadable: readonly UnreadableHistoryEvent[];
  readonly lastSequence: number;
  readonly more: boolean;
}

function parseEvent(v: unknown): HistoryEvent | null {
  if (!isObject(v)) return null;
  const seq = asInt(v.seq);
  const time = asDate(v.time);
  const typeName = asString(v.type);
  if (seq === null || time === null || typeName === null) return null;
  return { seq, time, typeName, kind: KINDS.has(typeName) ? (typeName as HistoryEventKind) : 'other', data: isObject(v.data) ? v.data : {} };
}

/** A malformed event never fails the page, but it is remembered so the caller does not move past it. */
export function parseHistoryPage(v: unknown): HistoryPage | null {
  if (!isObject(v)) return null;
  const list = asArray(v.events);
  const lastSequence = asInt(v.lastSequence);
  if (list === null || lastSequence === null) return null;
  const events: HistoryEvent[] = [];
  const unreadable: UnreadableHistoryEvent[] = [];
  for (const raw of list) {
    const ev = parseEvent(raw);
    if (ev) {
      events.push(ev);
      continue;
    }
    const o = isObject(raw) ? raw : {};
    const data = isObject(o.data) ? o.data : {};
    unreadable.push({ seq: asInt(o.seq), typeName: asString(o.type), time: asDate(o.time), programmed: asNumber(data.programmed) ?? asNumber(data.amount) });
  }
  return { events, unreadable, lastSequence, more: asBool(v.more) ?? false };
}

export const eventNumber = (e: HistoryEvent, key: string): number | null => asNumber(e.data[key]);
export const eventInt = (e: HistoryEvent, key: string): number | null => asInt(e.data[key]);
export const eventString = (e: HistoryEvent, key: string): string | null => asString(e.data[key]);
export const eventDate = (e: HistoryEvent, key: string): number | null => asDate(e.data[key]);

// ── unsolicited events ───────────────────────────────────────────────────────

export type BridgeEvent =
  | { readonly kind: 'status'; readonly status: BridgeStatus }
  | { readonly kind: 'alert'; readonly alert: BridgeAlert }
  | { readonly kind: 'bolusProgress'; readonly bolusId: number; readonly delivered: number; readonly remaining: number }
  | { readonly kind: 'pumpLink'; readonly state: PumpLinkState }
  | { readonly kind: 'unknown'; readonly name: string };

/** `null` if the event is known but undecodable (it is then ignored). */
export function parseBridgeEvent(name: string, data: unknown): BridgeEvent | null {
  switch (name) {
    case 'status': {
      const status = parseStatus(data);
      return status ? { kind: 'status', status } : null;
    }
    case 'alert': {
      const alert = parseAlert(data);
      return alert ? { kind: 'alert', alert } : null;
    }
    case 'bolusProgress': {
      if (!isObject(data)) return null;
      const bolusId = asInt(data.bolusId);
      const delivered = asNumber(data.delivered);
      const remaining = asNumber(data.remaining);
      return bolusId === null || delivered === null || remaining === null ? null : { kind: 'bolusProgress', bolusId, delivered, remaining };
    }
    case 'pumpLink': {
      const raw = isObject(data) ? asString(data.state) : null;
      return { kind: 'pumpLink', state: raw !== null && LINK_STATES.has(raw) ? (raw as PumpLinkState) : 'unknown' };
    }
    default:
      return { kind: 'unknown', name };
  }
}
