/**
 * Error mapping of the Eros driver. Condenses the `PodCommsError` cases of OmnipodKit
 * (MIT License, (c) LoopKit Authors) onto the DASH driver's `OmnipodError` kinds, so the dosing
 * safety logic (certain failure vs. unknown outcome) is the same for both drivers.
 *
 *  - `unacknowledged`: the whole message was on the air, the answer is missing or unusable:
 *    the pod may have executed it;
 *  - `unsent`: the pod cannot have executed the command (the message never left completely).
 */
import { ErosTransportError } from '../eros';
import { RileyLinkError } from '../../rileylink';
import { OmnipodError } from '../dash/errors';

export { OmnipodError, errorMessage, isOmnipodError, type OmnipodErrorKind } from '../dash/errors';

/** Maps anything the radio layer throws while a message is exchanged to an `OmnipodError`. */
export function fromRadioError(e: unknown): OmnipodError {
  if (e instanceof OmnipodError) return e;
  if (e instanceof ErosTransportError) {
    switch (e.kind) {
      case 'invalidMessage':
        return new OmnipodError('invalid', e.message);
      case 'unacknowledgedMessage':
        return new OmnipodError('unacknowledged', `Command sent, but not acknowledged (${e.rootKind}): ${e.message}`);
      default:
        // the message did not leave completely, so the pod cannot have run it
        return new OmnipodError('unsent', `Command was not sent (${e.kind}): ${e.message}`);
    }
  }
  if (e instanceof RileyLinkError) return new OmnipodError('notConnected', `RileyLink: ${e.message}`);
  return new OmnipodError('unacknowledged', `Unexpected error during the exchange: ${e instanceof Error ? e.message : String(e)}`);
}
