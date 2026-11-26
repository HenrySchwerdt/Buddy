/**
 * Decides what happened to a command whose outcome was unknown (port of `UncertaintyResolver` from
 * InsightKit/PumpManager/InsightPumpManager+Uncertainty.swift). Pure, so it can be tested
 * exhaustively. Only *positive evidence* settles a "not delivered": a status read well after the
 * command was sent, with the pump connected, readable fields and a complete history.
 */
import { MAX_CLOCK_SKEW_MS, NOT_DELIVERED_SETTLE_MS } from './constants';
import { eventInt, eventNumber, isDelivering, type BridgeStatus, type HistoryEvent, type RequestOutcome } from './models';
import type { PendingCommand } from './state';

export type PendingResolution = 'delivered' | 'notDelivered' | 'undecided';

/** What a `getRequestOutcome` answer means for an uncertain command. */
export type OutcomeVerdict = 'delivered' | 'notDelivered' | 'inProgress' | 'evidence';

export function outcomeVerdict(outcome: RequestOutcome): OutcomeVerdict {
  switch (outcome.state) {
    case 'succeeded':
      return 'delivered';
    case 'failed':
      return outcome.error?.uncertain === true ? 'evidence' : 'notDelivered';
    case 'inProgress':
      return 'inProgress';
    case 'uncertain':
    case 'unknown':
      return 'evidence';
  }
}

export function decidePending(command: PendingCommand, status: BridgeStatus, history: readonly HistoryEvent[], historyComplete: boolean, now: number): PendingResolution {
  if (command.unreadable) return 'undecided'; // nothing is known about it: only the user can settle it
  // A read time from the future (broken bridge clock) proves nothing: it is neither fresh nor settled.
  const readAt = status.timestamp !== null && status.timestamp <= now + MAX_CLOCK_SKEW_MS ? status.timestamp : null;
  // positive evidence ("it happened") only needs a read after the command ...
  const statusIsFresh = readAt !== null && readAt > command.sentAt;
  // ... "it did not happen" needs a read that had time to see the effect, from a connected pump
  const settled = readAt !== null && readAt > command.sentAt + NOT_DELIVERED_SETTLE_MS;
  const canProveAbsence = settled && status.pumpLink === 'connected' && historyComplete;

  const sinceBaseline = history.filter((e) => {
    if (command.baselineSequence !== null && e.seq <= command.baselineSequence) return false;
    return e.time >= command.sentAt - 60_000;
  });

  switch (command.kind) {
    case 'bolus': {
      const units = command.units ?? -1;
      const seen = sinceBaseline.some((e) => {
        if (e.kind !== 'bolusDelivered' && e.kind !== 'bolusProgrammed') return false;
        const amount = eventNumber(e, 'programmed') ?? eventNumber(e, 'amount') ?? -1;
        return Math.abs(amount - units) < 0.005;
      });
      if (seen) return 'delivered';
      if (status.bolusesAreUnreadable) return 'undecided';
      if (statusIsFresh && status.boluses.some((b) => Math.abs(b.amount - units) < 0.005)) return 'delivered';
      if (canProveAbsence && status.boluses.length === 0) return 'notDelivered';
      return 'undecided';
    }
    case 'setTBR': {
      const percent = command.percent ?? -1;
      const seen = sinceBaseline.some((e) => e.kind === 'tbrStart' && eventInt(e, 'percent') === percent);
      if (seen) return 'delivered';
      if (status.tbrIsUnreadable) return 'undecided';
      if (statusIsFresh && status.tbr !== null && status.tbr.percent === percent) return 'delivered';
      return canProveAbsence ? 'notDelivered' : 'undecided';
    }
    case 'cancelTBR': {
      if (status.tbrIsUnreadable) return 'undecided';
      if (statusIsFresh && status.tbr === null) return 'delivered';
      return status.tbr !== null && settled && status.pumpLink === 'connected' ? 'notDelivered' : 'undecided';
    }
    case 'suspend': {
      if (!statusIsFresh || status.operatingMode === 'unknown') return 'undecided';
      if (!isDelivering(status.operatingMode)) return 'delivered';
      return settled && status.pumpLink === 'connected' ? 'notDelivered' : 'undecided';
    }
    case 'resume': {
      if (!statusIsFresh || status.operatingMode === 'unknown') return 'undecided';
      if (isDelivering(status.operatingMode)) return 'delivered';
      return settled && status.pumpLink === 'connected' ? 'notDelivered' : 'undecided';
    }
  }
}
