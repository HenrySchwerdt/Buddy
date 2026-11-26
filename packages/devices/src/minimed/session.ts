/**
 * Command session with a MiniMed pump: TypeScript port of `PumpOpsSession.swift`,
 * `MinimedPumpMessageSender.swift` and `PumpOps.swift` from MinimedKit (migrated from
 * ps2/rileylink_ios, MIT License, (c) LoopKit Authors), on top of Buddy's `RileyLinkDevice`.
 *
 * The pump sleeps to save battery: every operation first wakes it (`wakeup`). A command is a
 * two step exchange: a one byte "short" message that the pump acknowledges, then the message
 * with the arguments, acknowledged again (`runCommandWithArguments`). The second ack is the
 * pump's confirmation that it took the command; any failure after the short message leaves the
 * outcome unknown unless the pump answered with an error code (see `wasNotExecuted`).
 *
 * Not ported: MySentry / watchdog pairing, remote control IDs, glucose history, button presses,
 * changing pump limits and writing basal schedules (the driver never changes pump settings).
 * Differences to the Swift original are marked DEVIATION.
 *
 * Logging: only message type names. Serial numbers, addresses and raw frames are never logged.
 */
import { silentLogger, type Bytes, type Clock, type Logger } from '@buddy/core';
import type { RFPacket } from '../rileylink';
import { RileyLinkError } from '../rileylink';
import type { SendAndListenOptions } from '../rileylink';
import { MinimedError, errorMessage, isMinimedError, pumpRejected } from './errors';
import {
  changeTempBasalBody,
  changeTimeBody,
  getHistoryPageBody,
  powerOnBody,
  shortBody,
  suspendResumeBody,
  bolusBody,
  unitsRemaining,
  type BodyOfKind,
  type MessageBody,
  type PumpClock,
  type SuspendResumeState,
} from './messages/bodies';
import { MessageType } from './messages/message-type';
import { carelinkMessage, decodePumpMessage, describeMessage, encodePumpMessage, type PumpMessage } from './messages/pump-message';
import { HISTORY_PAGE_LENGTH, parseHistoryPage, timestampedEvents, type TimestampedHistoryEvent } from './history/events';
import { hasMySentry, insulinBitPackingScale, SCAN_FREQUENCIES_MHZ, type PumpModel, type PumpRegion, isPumpModel } from './models';
import { BasalSchedule, decodeBasalSchedule } from './basal-schedule';
import { decodeMinimedPacket, encodeMinimedPacket } from './radio/packet';

/** What the session needs from a RileyLink (`RileyLinkDevice` satisfies it). */
export interface MinimedRadio {
  sendAndListen(data: Bytes, options: SendAndListenOptions): Promise<RFPacket>;
  send(data: Bytes, options?: { readonly channel?: number; readonly timeoutMs?: number }): Promise<void>;
  setBaseFrequency(megahertz: number): Promise<void>;
}

export interface SessionOptions {
  readonly radio: MinimedRadio;
  /** the 3 address bytes of the pump */
  readonly address: Bytes;
  readonly clock: Clock;
  readonly log?: Logger;
  /** the model, once known */
  readonly model?: PumpModel | null;
  /** Pause after every answered message (MinimedKit: 200 ms); tests use 0. */
  readonly responseDelayMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
}

/** How long the pump gets to answer one radio attempt (`standardPumpResponseWindow`). */
export const PUMP_RESPONSE_WINDOW_MS = 200;
const MIN_TIME_BETWEEN_WAKE_ATTEMPTS_MS = 60_000;
const DEFAULT_AWAKE_MS = 60_000;

interface Exchange {
  readonly repeatCount: number;
  readonly timeoutMs: number;
  readonly retryCount: number;
}
const standard = (retryCount: number): Exchange => ({ repeatCount: 0, timeoutMs: PUMP_RESPONSE_WINDOW_MS, retryCount });

export interface PumpReading {
  readonly bolusing: boolean;
  readonly suspended: boolean;
}

export interface TempBasalReading {
  readonly rateType: 'absolute' | 'percent';
  readonly rate: number;
  readonly timeRemainingMin: number;
}

export interface BatteryReading {
  readonly status: 'low' | 'normal' | 'unknown';
  readonly volts: number;
}

export interface TempBasalAttempt {
  /** the pump acknowledged the arguments */
  readonly acked: boolean;
  /** the pump certainly did not run it (it said no, or never got the arguments) */
  readonly rejection: MinimedError | null;
  /** no usable answer: the pump may or may not have run it */
  readonly uncertain: MinimedError | null;
  /** the temp basal the pump reports afterwards; null when it could not be read */
  readonly readback: TempBasalReading | null;
}

export interface FrequencyTrial {
  readonly frequencyMhz: number;
  readonly tries: number;
  readonly successes: number;
  readonly avgRssi: number;
}

const defaultSleep = (ms: number): Promise<void> => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());

export class MinimedSession {
  private readonly radio: MinimedRadio;
  private readonly address: Bytes;
  private readonly clock: Clock;
  private readonly log: Logger;
  private readonly responseDelayMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private model: PumpModel | null;
  private awakeUntil = 0;
  private lastWakeAttempt: number | null = null;

  constructor(o: SessionOptions) {
    this.radio = o.radio;
    this.address = o.address;
    this.clock = o.clock;
    this.log = o.log ?? silentLogger;
    this.model = o.model ?? null;
    this.responseDelayMs = o.responseDelayMs ?? 200;
    this.sleep = o.sleep ?? defaultSleep;
  }

  get knownModel(): PumpModel | null {
    return this.model;
  }

  // ── messages ──────────────────────────────────────────────────────────────────

  private message(type: number, body?: MessageBody): PumpMessage {
    return carelinkMessage(this.address, type, body);
  }

  /** Sends `message` and returns the decoded answer (`MinimedPumpMessageSender.sendAndListen`). */
  private async sendAndListen(message: PumpMessage, x: Exchange): Promise<PumpMessage> {
    let packet: RFPacket;
    try {
      packet = await this.radio.sendAndListen(encodeMinimedPacket(encodePumpMessage(message)), { repeatCount: x.repeatCount, timeoutMs: x.timeoutMs, retryCount: x.retryCount });
    } catch (e) {
      if (e instanceof RileyLinkError) {
        if (e.kind === 'responseTimeout') {
          this.awakeUntil = 0; // a silent pump may have gone back to sleep: wake it again next time
          throw new MinimedError('noResponse', 'Pump did not respond');
        }
        throw new MinimedError('device', `RileyLink: ${e.message}`);
      }
      throw new MinimedError('device', `RileyLink: ${errorMessage(e)}`);
    }
    const decoded = decodeMinimedPacket(packet.data);
    if (!decoded) throw new MinimedError('couldNotDecode', `Invalid response during ${describeMessage(message)}`);
    const response = decodePumpMessage(decoded);
    if (!response) throw new MinimedError('unknownResponse', `Unknown response during ${describeMessage(message)}`);
    if (response.address.length !== message.address.length || response.address.some((b, i) => b !== message.address[i])) {
      throw new MinimedError('crosstalk', 'Comms with another pump detected');
    }
    return response;
  }

  /** Answer of type `responseType` with a body of `kind`; a pump error code becomes a `pumpError`. */
  private async getResponse<K extends MessageBody['kind']>(message: PumpMessage, responseType: number, kind: K, x: Exchange): Promise<BodyOfKind<K>> {
    const response = await this.sendAndListen(message, x);
    if (response.messageType !== responseType || response.body.kind !== kind) {
      if (response.body.kind === 'error') throw pumpRejected(response.body.code);
      throw new MinimedError('unexpectedResponse', `Unexpected response ${describeMessage(response)} to ${describeMessage(message)}`);
    }
    await this.sleep(this.responseDelayMs);
    return response.body as BodyOfKind<K>;
  }

  private ack(message: PumpMessage, x: Exchange = standard(3)): Promise<BodyOfKind<'ack'>> {
    return this.getResponse(message, MessageType.pumpAck, 'ack', x);
  }

  /** Sends without waiting for an answer (`send`): the final ack of a multi-frame read. */
  private async sendOnly(message: PumpMessage): Promise<void> {
    try {
      await this.radio.send(encodeMinimedPacket(encodePumpMessage(message)), { channel: 0, timeoutMs: 0 });
    } catch (e) {
      throw new MinimedError('device', `RileyLink: ${errorMessage(e)}`);
    }
  }

  // ── wakeup ────────────────────────────────────────────────────────────────────

  private get isAwake(): boolean {
    return this.awakeUntil > this.clock.now();
  }

  private async sendWakeUpBurst(): Promise<void> {
    const now = this.clock.now();
    if (this.lastWakeAttempt !== null && now - this.lastWakeAttempt < MIN_TIME_BETWEEN_WAKE_ATTEMPTS_MS) return;
    this.lastWakeAttempt = now;
    const power = this.message(MessageType.powerOn);
    // pumps without MySentry first get a very short burst (the answer is not awaited)
    if (this.model === null || !hasMySentry(this.model)) {
      try {
        await this.ack(power, { repeatCount: 255, timeoutMs: 1, retryCount: 0 });
      } catch {
        // expected: the burst is only meant to wake the pump
      }
    }
    await this.ack(power, { repeatCount: 255, timeoutMs: 12_000, retryCount: 0 });
  }

  private async isPumpResponding(): Promise<boolean> {
    try {
      await this.getResponse(this.message(MessageType.getPumpModel), MessageType.getPumpModel, 'pumpModel', standard(1));
      return true;
    } catch {
      return false;
    }
  }

  /** Makes sure the pump listens for the next `durationMs` (`wakeup`). */
  async wakeup(durationMs = DEFAULT_AWAKE_MS): Promise<void> {
    if (this.isAwake) return;
    if (await this.isPumpResponding()) {
      this.awakeUntil = this.clock.now() + DEFAULT_AWAKE_MS;
      return;
    }
    await this.sendWakeUpBurst();
    await this.ack(this.message(MessageType.powerOn, powerOnBody(durationMs)), standard(3));
    this.log.info('MiniMed: pump woken');
    this.awakeUntil = this.clock.now() + durationMs;
  }

  // ── reads ─────────────────────────────────────────────────────────────────────

  async getPumpModel(useCache = true): Promise<PumpModel> {
    if (useCache && this.model) return this.model;
    await this.wakeup();
    const body = await this.getResponse(this.message(MessageType.getPumpModel), MessageType.getPumpModel, 'pumpModel', standard(3));
    if (!isPumpModel(body.model)) throw new MinimedError('unknownPumpModel', `Unknown pump model: ${body.model}`);
    this.model = body.model;
    return body.model;
  }

  async getFirmwareVersion(): Promise<string> {
    await this.wakeup();
    return (await this.getResponse(this.message(MessageType.readFirmwareVersion), MessageType.readFirmwareVersion, 'firmware', standard(3))).version;
  }

  async getBattery(): Promise<BatteryReading> {
    await this.wakeup();
    const b = await this.getResponse(this.message(MessageType.getBattery), MessageType.getBattery, 'battery', standard(3));
    return { status: b.status === 'low' ? 'low' : b.status === 'normal' ? 'normal' : 'unknown', volts: b.volts };
  }

  async getPumpStatus(): Promise<PumpReading> {
    await this.wakeup();
    const b = await this.getResponse(this.message(MessageType.readPumpStatus), MessageType.readPumpStatus, 'pumpStatus', standard(3));
    return { bolusing: b.bolusing, suspended: b.suspended };
  }

  async getSettings(): Promise<BodyOfKind<'settings'>> {
    await this.wakeup();
    return this.getResponse(this.message(MessageType.readSettings), MessageType.readSettings, 'settings', standard(3));
  }

  /** The pump's clock, as wall-clock fields. */
  async getTime(): Promise<PumpClock> {
    await this.wakeup();
    return (await this.getResponse(this.message(MessageType.readTime), MessageType.readTime, 'time', standard(3))).clock;
  }

  async getRemainingInsulin(): Promise<{ units: number; clock: PumpClock }> {
    const model = await this.getPumpModel();
    const clock = await this.getTime();
    const body = await this.getResponse(this.message(MessageType.readRemainingInsulin), MessageType.readRemainingInsulin, 'remainingInsulin', standard(3));
    return { units: unitsRemaining(body.raw, insulinBitPackingScale(model)), clock };
  }

  async getTempBasal(): Promise<TempBasalReading> {
    await this.wakeup();
    const b = await this.getResponse(this.message(MessageType.readTempBasal), MessageType.readTempBasal, 'tempBasal', standard(3));
    return { rateType: b.rateType, rate: b.rate, timeRemainingMin: b.timeRemainingMin };
  }

  /** The basal profile stored in the pump (standard, A or B); null when it is empty. */
  async getBasalSchedule(profile: 'standard' | 'profileA' | 'profileB' = 'standard'): Promise<BasalSchedule | null> {
    await this.wakeup();
    const type = profile === 'standard' ? MessageType.readProfileStd512 : profile === 'profileA' ? MessageType.readProfileA512 : MessageType.readProfileB512;
    let message = this.message(type);
    const data: number[] = [];
    for (let frames = 0; frames < 8; frames++) {
      const body = await this.getResponse(message, type, 'dataFrame', standard(3));
      data.push(...body.contents);
      if (body.isLastFrame) return decodeBasalSchedule(Uint8Array.from(data));
      message = this.message(MessageType.pumpAck);
    }
    throw new MinimedError('rfComms', 'Basal profile has too many frames');
  }

  // ── commands ──────────────────────────────────────────────────────────────────

  /**
   * `runCommandWithArguments`: wake the pump, open the command with a short message, then send
   * the arguments. Failures carry the phase they happened in (`MinimedError.phase`).
   */
  private async runCommandWithArguments<K extends MessageBody['kind']>(message: PumpMessage, responseType: number, kind: K, retryCount = 3): Promise<BodyOfKind<K>> {
    try {
      await this.wakeup();
    } catch (e) {
      throw e instanceof MinimedError ? e.withPhase('wake') : e;
    }
    try {
      await this.ack(carelinkMessage(message.address, message.messageType, shortBody()), standard(3));
    } catch (e) {
      throw e instanceof MinimedError ? e.withPhase('command') : e;
    }
    try {
      return await this.getResponse(message, responseType, kind, standard(retryCount));
    } catch (e) {
      throw e instanceof MinimedError ? e.withPhase('arguments') : e;
    }
  }

  async setSuspendResume(state: SuspendResumeState): Promise<void> {
    await this.runCommandWithArguments(this.message(MessageType.suspendResume, suspendResumeBody(state)), MessageType.pumpAck, 'ack');
  }

  /**
   * Starts a normal bolus (`setNormalBolus`). Refuses while the pump bolusses or is suspended.
   * Resolves when the pump acknowledged the arguments.
   * @throws MinimedError; use `wasNotExecuted` to tell a certain failure from an unknown outcome.
   */
  async setNormalBolus(units: number): Promise<void> {
    let model: PumpModel;
    let status: PumpReading;
    try {
      model = await this.getPumpModel();
      status = await this.getPumpStatus();
    } catch (e) {
      // nothing was sent yet: whatever failed, no bolus was started
      throw e instanceof MinimedError ? e.withPhase('wake') : e;
    }
    if (status.bolusing) throw new MinimedError('bolusInProgress', 'A bolus is already in progress', { phase: 'wake' });
    if (status.suspended) throw new MinimedError('pumpSuspended', 'Pump is suspended', { phase: 'wake' });
    await this.runCommandWithArguments(this.message(MessageType.bolus, bolusBody(units, insulinBitPackingScale(model))), MessageType.pumpAck, 'ack');
  }

  /**
   * Programs a temp basal (`setTempBasal`; rate 0 for 0 minutes cancels). After the arguments the
   * pump is asked what it is running, because an unanswered command may still have been taken.
   */
  async setTempBasal(unitsPerHour: number, durationMin: number): Promise<TempBasalAttempt> {
    const message = this.message(MessageType.changeTempBasal, changeTempBasalBody(unitsPerHour, durationMin * 60_000));
    const none = (rejection: MinimedError | null, uncertain: MinimedError | null): TempBasalAttempt => ({ acked: false, rejection, uncertain, readback: null });
    try {
      await this.wakeup();
      await this.ack(carelinkMessage(message.address, message.messageType, shortBody()), standard(3));
    } catch (e) {
      // the pump never got the arguments: certain failure
      return none(e instanceof MinimedError ? e.withPhase('command') : new MinimedError('rfComms', errorMessage(e)), null);
    }
    let acked = false;
    let uncertain: MinimedError | null = null;
    try {
      await this.ack(message, standard(1));
      acked = true;
    } catch (e) {
      if (isMinimedError(e, 'pumpError')) return none(e.withPhase('arguments'), null);
      uncertain = e instanceof MinimedError ? e.withPhase('arguments') : new MinimedError('rfComms', errorMessage(e), { phase: 'arguments' });
    }
    let readback: TempBasalReading | null = null;
    try {
      readback = await this.getTempBasal();
    } catch {
      // unreadable: the driver decides with what it has
    }
    return { acked, rejection: null, uncertain, readback };
  }

  /** Sets the pump's clock (`setTime`); `clock` is the wall-clock time the pump should show. */
  async setTime(clock: PumpClock): Promise<void> {
    const body = changeTimeBody(clock);
    if (!body) throw new MinimedError('invalid', 'Not a valid pump time');
    try {
      await this.wakeup();
      await this.ack(this.message(MessageType.changeTime), standard(3));
    } catch (e) {
      throw e instanceof MinimedError ? e.withPhase('command') : e;
    }
    try {
      await this.ack(this.message(MessageType.changeTime, body), standard(3));
    } catch (e) {
      throw e instanceof MinimedError ? e.withPhase('arguments') : e;
    }
  }

  // ── history ───────────────────────────────────────────────────────────────────

  /** One 1024 byte history page (0 = newest); `pumpError` with code 0x0d when the page does not exist. */
  async getHistoryPage(pageNum: number): Promise<Bytes> {
    const frames: number[] = [];
    const request = this.message(MessageType.getHistoryPage, getHistoryPageBody(pageNum));
    let current = await this.runCommandWithArguments(request, MessageType.getHistoryPage, 'historyPage');
    let expected = 1;
    while (expected === current.frameNumber) {
      frames.push(...current.frame);
      expected += 1;
      const ack = this.message(MessageType.pumpAck);
      if (!current.lastFrame) {
        current = await this.getResponse(ack, MessageType.getHistoryPage, 'historyPage', standard(3));
      } else {
        await this.sendOnly(ack);
        break;
      }
    }
    if (frames.length !== HISTORY_PAGE_LENGTH) throw new MinimedError('rfComms', `Short history page: ${frames.length} bytes. Expected ${HISTORY_PAGE_LENGTH}`);
    return Uint8Array.from(frames);
  }

  /**
   * The history events newer than `since` (ms), oldest first (`getHistoryEvents`). Pages are read
   * newest first until one reaches back to `since`; at most 16 pages exist.
   */
  async getHistoryEvents(since: number, utcOffsetSeconds: number): Promise<{ events: TimestampedHistoryEvent[]; model: PumpModel }> {
    await this.wakeup();
    const model = await this.getPumpModel();
    let events: TimestampedHistoryEvent[] = [];
    for (let pageNum = 0; pageNum < 16; pageNum++) {
      let pageData: Bytes;
      try {
        pageData = await this.getHistoryPage(pageNum);
      } catch (e) {
        if (isMinimedError(e, 'pumpError') && e.pumpErrorCode === 0x0d) return { events, model };
        throw e;
      }
      const page = parseHistoryPage(pageData, model);
      const r = timestampedEvents(page, { after: since, utcOffsetSeconds, model, now: this.clock.now() });
      events = [...r.events, ...events];
      if (!r.hasMoreEvents) break;
    }
    return { events, model };
  }

  // ── radio tuning ──────────────────────────────────────────────────────────────

  /**
   * Scans the region's channels with a model request and picks the one with the best signal
   * (`tuneRadio`). Throws when no channel answered; the radio is then left on `fallbackMhz`.
   */
  async tuneRadio(region: PumpRegion, fallbackMhz: number, attempts = 3): Promise<{ trials: FrequencyTrial[]; bestFrequencyMhz: number }> {
    const frequencies = SCAN_FREQUENCIES_MHZ[region];
    const middle = frequencies[Math.floor(frequencies.length / 2)]!;
    try {
      await this.radio.setBaseFrequency(middle);
      await this.wakeup();
    } catch {
      // the scan below tells whether the pump is reachable at all
    }
    const trials: FrequencyTrial[] = [];
    for (const frequencyMhz of frequencies) {
      await this.radio.setBaseFrequency(frequencyMhz);
      let successes = 0;
      let rssiSum = 0;
      for (let i = 0; i < attempts; i++) {
        try {
          const packet = await this.radio.sendAndListen(encodeMinimedPacket(encodePumpMessage(this.message(MessageType.getPumpModel))), { repeatCount: 0, timeoutMs: 130, retryCount: 3 });
          const decoded = decodeMinimedPacket(packet.data);
          const response = decoded ? decodePumpMessage(decoded) : null;
          if (response?.messageType === MessageType.getPumpModel) {
            successes += 1;
            rssiSum += packet.rssi;
          }
        } catch {
          // a miss on this channel
        }
      }
      trials.push({ frequencyMhz, tries: attempts, successes, avgRssi: (rssiSum + -99 * (attempts - successes)) / attempts });
    }
    const best = [...trials].sort((a, b) => b.avgRssi - a.avgRssi)[0]!;
    if (best.successes === 0) {
      await this.radio.setBaseFrequency(fallbackMhz);
      throw new MinimedError('rfComms', 'No pump responses during scan');
    }
    await this.radio.setBaseFrequency(best.frequencyMhz);
    return { trials, bestFrequencyMhz: best.frequencyMhz };
  }
}
