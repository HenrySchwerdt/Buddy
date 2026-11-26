/**
 * Errors of the MiniMed driver: a condensed port of `PumpOpsError`, `PumpCommandError` and
 * `MinimedPumpManagerError` from MinimedKit (migrated from ps2/rileylink_ios, MIT License,
 * (c) LoopKit Authors).
 *
 * The dosing safety logic only needs one question answered: could the pump have executed the
 * command? See {@link wasNotExecuted}.
 */
import { describePumpError } from './messages/bodies';

export type MinimedErrorKind =
  /** nothing was heard in time */
  | 'noResponse'
  /** a packet arrived but its 4b/6b code or CRC is wrong */
  | 'couldNotDecode'
  /** a well-formed packet that is not a message of a known type */
  | 'unknownResponse'
  /** the answer came from another pump */
  | 'crosstalk'
  /** the pump answered with an error code */
  | 'pumpError'
  | 'unexpectedResponse'
  | 'unknownPumpModel'
  | 'bolusInProgress'
  | 'pumpSuspended'
  /** the RileyLink or the BLE link failed */
  | 'device'
  /** a precondition failed before anything was sent (bad settings, no RileyLink, ...) */
  | 'invalid'
  | 'rfComms';

/** Where a command failed: while waking the pump, while opening the command (short message), or while sending the arguments. */
export type CommandPhase = 'wake' | 'command' | 'arguments';

export class MinimedError extends Error {
  constructor(
    readonly kind: MinimedErrorKind,
    message: string,
    readonly options: { readonly pumpErrorCode?: number; readonly phase?: CommandPhase } = {},
  ) {
    super(message);
    this.name = 'MinimedError';
  }
  get pumpErrorCode(): number | undefined {
    return this.options.pumpErrorCode;
  }
  get phase(): CommandPhase | undefined {
    return this.options.phase;
  }
  withPhase(phase: CommandPhase): MinimedError {
    return this.options.phase === phase ? this : new MinimedError(this.kind, this.message, { ...this.options, phase });
  }
}

export const isMinimedError = (e: unknown, kind?: MinimedErrorKind): e is MinimedError => e instanceof MinimedError && (kind === undefined || e.kind === kind);

export const pumpRejected = (code: number): MinimedError => new MinimedError('pumpError', describePumpError(code), { pumpErrorCode: code });

export const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * True when the pump certainly did not execute the command that failed with `e`: it never got
 * the arguments (the failure happened before or while opening the command), it answered with an
 * error code, or a precondition failed before anything was sent. Every other failure of the
 * argument exchange (no answer, garbled answer, lost link) leaves the outcome unknown.
 */
export function wasNotExecuted(e: unknown): boolean {
  if (!(e instanceof MinimedError)) return false;
  switch (e.kind) {
    case 'invalid':
    case 'bolusInProgress':
    case 'pumpSuspended':
    case 'pumpError':
    case 'unknownPumpModel':
      return true;
    default:
      return e.phase === 'wake' || e.phase === 'command';
  }
}
