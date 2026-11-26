/**
 * Eros pairing: `AssignAddress` and `SetupPod` over the pairing address. Port of
 * `erosSendPairMessage`, `assignAddress`, `setupPod` and `erosAssignAddressAndSetupPod` of
 * `Eros/ErosPodComms.swift` (OmnipodKit, MIT License, (c) LoopKit Authors).
 *
 * DEVIATION: the pod's RSSI/gain check of OmnipodKit is not done; the shared message layer does
 * not decode those two fields of the version response.
 * BENCH USE ONLY: the pod is filled with water and never attached to a body.
 */
import type { Millis } from '@buddy/core';
import {
  POD,
  PodProgress,
  SetupProgress,
  decodeMessage,
  encodeMessage,
  faultFromDetailed,
  formatFault,
  makeMessage,
  messageFault,
  setupIsPaired,
  type Message,
  type VersionResponseBlock,
} from '../common';
import { randomBytes } from '../common/bytes';
import { ErosTransportError, generatePodAddress, PAIRING_ADDRESS, type ErosMessageTransport } from '../eros';
import type { RileyLinkDevice } from '../../rileylink';
import { errorMessage, fromRadioError, OmnipodError } from './errors';
import { OmnipodErosReconciler } from './reconcile';

/** Errors after which OmniKit retries a pairing message once with the already advanced packet number. */
const PAIR_RETRY_ROOTS = ['podAckedInsteadOfReturningResponse', 'noResponseRL'] as const;

/** Problems of the delivery parameters a pod reports (`erosSendPairMessage`). */
export function incompatibilities(v: VersionResponseBlock): string[] {
  const s = v.setup;
  if (!s) return [];
  const problems: string[] = [];
  if (s.pulseSize !== POD.pulseSize) problems.push(`Pod reported a pulse size of ${s.pulseSize} U instead of ${POD.pulseSize} U`);
  if (s.secondsPerBolusPulse !== POD.secondsPerBolusPulse) problems.push(`Pod reported ${s.secondsPerBolusPulse} s per bolus pulse instead of ${POD.secondsPerBolusPulse} s`);
  if (s.secondsPerPrimePulse !== POD.secondsPerPrimePulse) problems.push(`Pod reported ${s.secondsPerPrimePulse} s per prime pulse instead of ${POD.secondsPerPrimePulse} s`);
  if (s.primeUnits !== POD.primeUnits) problems.push(`Pod reported a prime bolus of ${s.primeUnits} U instead of ${POD.primeUnits} U`);
  if (s.cannulaInsertionUnits !== POD.cannulaInsertionUnits) problems.push(`Pod reported a cannula insertion bolus of ${s.cannulaInsertionUnits} U instead of ${POD.cannulaInsertionUnits} U`);
  if (s.serviceDuration < POD.serviceDuration) problems.push(`Pod reported a service duration of ${s.serviceDuration / 3600} h, shorter than ${POD.serviceDuration / 3600} h`);
  return problems;
}

export class OmnipodErosPairing extends OmnipodErosReconciler {
  /** Date components of `at` in the local time zone (`SetupPodCommand.dateComponents`). */
  protected localDate(at: Millis) {
    const d = new Date(at + this.opts.utcOffsetSeconds(at) * 1000);
    return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(), hour: d.getUTCHours(), minute: d.getUTCMinutes() };
  }

  private random32(): number {
    return this.opts.random32 ? this.opts.random32() >>> 0 : new DataView(randomBytes(4).buffer).getUint32(0);
  }

  /**
   * Assigns an address and sets the pod up (the steps that are still missing), then opens the
   * normal command session on the paired pod.
   */
  protected async assignAddressAndSetup(): Promise<void> {
    const device = await this.openRadio();
    try {
      if (this.record.podId === 0) await this.assignAddress(device);
      if (!setupIsPaired(this.record.setupProgress)) await this.setupPod(device);
    } finally {
      await this.persist(); // keeps the packet counter even when pairing failed
    }
    if (!this.hasPairedPod) throw new OmnipodError('protocol', 'The pod did not report that pairing completed');
    this.comms = this.makeComms(device);
  }

  private async assignAddress(device: RileyLinkDevice): Promise<void> {
    const address = generatePodAddress(() => this.random32());
    const transport = this.makeTransport(device, PAIRING_ADDRESS, address);
    const message = makeMessage(PAIRING_ADDRESS, [{ type: 'assignAddress', address }], transport.messageNumber);
    const v = await this.sendPairMessage(transport, address, message, false);
    if (!v) throw new OmnipodError('protocol', 'The pod only acknowledged the address assignment');
    this.update({ podId: address, lot: v.lot, tid: v.tid, firmwareVersion: v.firmwareVersion, iFirmwareVersion: v.iFirmwareVersion, podModel: v.podModel, setupProgress: SetupProgress.none, lastSync: this.now() });
    await this.persist();
  }

  private async setupPod(device: RileyLinkDevice): Promise<void> {
    const r = this.record;
    const now = this.now();
    const transport = this.makeTransport(device, PAIRING_ADDRESS, r.podId);
    const message = makeMessage(PAIRING_ADDRESS, [{ type: 'setupPod', address: r.podId, lot: r.lot, tid: r.tid, date: this.localDate(now), packetTimeoutLimit: 4 }], transport.messageNumber);
    const v = await this.sendPairMessage(transport, r.podId, message, true);
    if (v && !v.setup) throw new OmnipodError('protocol', 'SetupPod: unexpected version response');
    // OmnipodKit: a pod that only acknowledged SetupPod is treated as paired
    if (!v || v.podProgress === PodProgress.pairingCompleted) {
      this.update({
        setupProgress: SetupProgress.podPaired,
        activatedAt: now,
        ...(v ? { firmwareVersion: v.firmwareVersion, iFirmwareVersion: v.iFirmwareVersion } : {}),
        utcOffsetSeconds: this.opts.utcOffsetSeconds(now),
        lastSync: now,
      });
    }
    await this.persist();
  }

  /**
   * Sends one pairing message and validates the version response. Returns null when the pod only
   * acknowledged it and `ackedIsOk` (SetupPod). Retries once after a missing response.
   */
  private async sendPairMessage(transport: ErosMessageTransport, address: number, message: Message, ackedIsOk: boolean): Promise<VersionResponseBlock | null> {
    let retried = false;
    for (;;) {
      try {
        const bytes = await transport.sendMessage(encodeMessage(message));
        return this.checkVersion(decodeMessage(bytes), address);
      } catch (e) {
        if (e instanceof ErosTransportError) {
          const root = e.rootKind;
          if (ackedIsOk && root === 'podAckedInsteadOfReturningResponse' && retried) return null;
          if (!retried && (PAIR_RETRY_ROOTS as readonly string[]).includes(root)) {
            retried = true; // the transport's packet number is already advanced for the retry
            continue;
          }
          throw fromRadioError(e);
        }
        throw e instanceof OmnipodError ? e : new OmnipodError('protocol', `Unreadable answer from the pod: ${errorMessage(e)}`);
      }
    }
  }

  private async checkVersion(response: Message, address: number): Promise<VersionResponseBlock> {
    const fault = messageFault(response);
    if (fault) {
      if (this.record.podId !== 0 && !this.record.fault) this.update({ fault: faultFromDetailed(fault) });
      throw new OmnipodError('podFault', `Pod fault: ${formatFault(fault.faultEventCode)}`, faultFromDetailed(fault));
    }
    const v = response.blocks[0];
    if (v?.type !== 'versionResponse') throw new OmnipodError('protocol', `Unexpected response from pod: ${v?.type ?? 'empty message'}`);
    if (v.address !== address) throw new OmnipodError('protocol', `The pod answered with address ${v.address.toString(16)}, expected ${address.toString(16)}`);
    const r = this.record;
    if (r.podId !== 0 && (r.lot !== v.lot || r.tid !== v.tid)) {
      throw new OmnipodError('protocol', 'A different pod answered (lot and tid differ). Another pod is pairing nearby; move away or discard this pod.');
    }
    if (v.podProgress === PodProgress.activationTimeExceeded) {
      this.update({ setupProgress: SetupProgress.activationTimeout });
      await this.persist();
      throw new OmnipodError('incompatible', 'Activation time exceeded');
    }
    const problems = incompatibilities(v);
    if (problems.length) {
      this.update({ setupProgress: SetupProgress.podIncompatible });
      await this.persist();
      throw new OmnipodError('incompatible', problems.join('. '));
    }
    return v;
  }
}
