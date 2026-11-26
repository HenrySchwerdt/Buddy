/**
 * Commands whose outcome is unknown. Port of the idea of `PendingCommand.swift` and
 * `PodCommsSession.recoverUnacknowledgedCommand` from OmnipodKit (MIT License, (c) LoopKit
 * Authors): the pod stores the message number of the last programming command it accepted
 * (`lastProgrammingMessageSeqNum` of every status); comparing it with the message number the
 * command was sent with tells whether the pod received it.
 *
 * Because message numbers are 4 bits (a number repeats after 8 exchanges), a match is ambiguous
 * when the pod's previous programming command had the same number; then only the delivery
 * status can confirm it, otherwise the outcome stays `unknown` and further dosing is refused.
 */
import type { Millis } from '@buddy/core';
import { deliveryIsBolusing, deliveryIsSuspended, deliveryIsTempBasalRunning } from '../common';
import type { StatusResponseBlock } from '../common';

export type PendingCommand =
  | { readonly kind: 'bolus'; readonly messageNumber: number; readonly sentAt: Millis; readonly priorProgSeq: number | null; readonly units: number; readonly automatic: boolean; readonly id: string }
  | { readonly kind: 'tempBasal'; readonly messageNumber: number; readonly sentAt: Millis; readonly priorProgSeq: number | null; readonly rate: number; readonly durationMin: number }
  | { readonly kind: 'cancel'; readonly messageNumber: number; readonly sentAt: Millis; readonly priorProgSeq: number | null; readonly deliveryType: number }
  | { readonly kind: 'basalProgram'; readonly messageNumber: number; readonly sentAt: Millis; readonly priorProgSeq: number | null };

export type PendingOutcome = 'received' | 'notReceived' | 'unknown';

export function resolvePending(p: PendingCommand, status: StatusResponseBlock): PendingOutcome {
  if (status.lastProgrammingMessageSeqNum !== p.messageNumber) return 'notReceived';
  if (p.priorProgSeq !== p.messageNumber) return 'received';
  // ambiguous: the previous programming command of the pod had the same message number
  switch (p.kind) {
    case 'bolus':
      return deliveryIsBolusing(status.deliveryStatus) ? 'received' : 'unknown';
    case 'tempBasal':
      return deliveryIsTempBasalRunning(status.deliveryStatus) ? 'received' : 'unknown';
    case 'cancel':
      // a cancel leaves no trace that differs from "nothing was running"
      return 'unknown';
    case 'basalProgram':
      return deliveryIsSuspended(status.deliveryStatus) ? 'unknown' : 'received';
  }
}

export const describePending = (p: PendingCommand): string => {
  switch (p.kind) {
    case 'bolus':
      return `${p.units.toFixed(2)} U bolus`;
    case 'tempBasal':
      return `${p.rate} U/h temp basal`;
    case 'cancel':
      return 'cancel delivery';
    case 'basalProgram':
      return 'basal program';
  }
};
