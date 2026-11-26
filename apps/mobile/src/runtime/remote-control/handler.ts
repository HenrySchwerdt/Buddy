import { base64ToBytes, bytesToBase64, decryptCommand, DecryptionError } from './secure-message';
import { describeForAudit, executeCommand, type CommandResult, type RemoteDeps } from './commands';
import { describeCommand, type CommandPayload } from './payload';

/** Trio `TrioRemoteControl.handleRemoteNotification`: authenticate (secret, time window, replay), then execute. */

/** Trio `timeWindow`: a command older or further in the future than this is rejected. */
export const TIME_WINDOW_SECONDS = 600;
/** How many executed command ids are remembered to reject replays inside the time window. */
export const MAX_REMEMBERED_COMMANDS = 50;

export interface HandlerContext {
  readonly enabled: boolean;
  /** Shared secret from the keychain (empty = none). */
  readonly secret: string;
  readonly deps: RemoteDeps;
  /** Ids of commands that already ran. */
  readonly executedIds: readonly string[];
  /** Persists an executed command id. */
  rememberCommand(id: string): void;
  /** Rejection and success log + Nightscout note + local notification. Receives no secret. */
  report(note: string, result: { readonly ok: boolean; readonly message: string }, payload?: CommandPayload): Promise<void>;
}

export type HandlerOutcome = { readonly handled: false; readonly reason: 'disabled' | 'no-secret' | 'decryption' | 'too-old' | 'future' | 'replay' } | { readonly handled: true; readonly result: CommandResult };

/**
 * Replay key of a message: the sender's command id, or (when the sender sent none) the AES-GCM nonce of the message.
 * A captured ciphertext always carries the same nonce, so a command without an id cannot be replayed inside the time window.
 */
function replayKey(encrypted: string, payload: CommandPayload): string {
  if (payload.commandId) return payload.commandId;
  return `nonce:${bytesToBase64(base64ToBytes(encrypted).slice(0, 12))}`;
}

export async function handleEncryptedCommand(encrypted: string, ctx: HandlerContext): Promise<HandlerOutcome> {
  const reportOnly = async (reason: Extract<HandlerOutcome, { handled: false }>['reason'], message: string, payload?: CommandPayload): Promise<HandlerOutcome> => {
    await ctx.report(payload ? `${message} Details: ${describeCommand(payload)}` : message, { ok: false, message }, payload);
    return { handled: false, reason };
  };

  if (!ctx.enabled) {
    console.warn('[buddy] Remote command received, but remote control is disabled in settings. Ignoring the command.');
    return { handled: false, reason: 'disabled' };
  }
  if (!ctx.secret) return reportOnly('no-secret', 'Command rejected: shared secret is missing in settings. Cannot authenticate the command.');

  let payload: CommandPayload;
  try {
    payload = decryptCommand(encrypted, ctx.secret);
  } catch (e) {
    const detail = e instanceof DecryptionError ? e.message : 'Unreadable message';
    return reportOnly('decryption', `Command rejected: ${detail}.`);
  }

  const age = ctx.deps.now() / 1000 - payload.timestamp;
  if (age > TIME_WINDOW_SECONDS) return reportOnly('too-old', `Command rejected: the message is too old (sent ${Math.round(age)} seconds ago).`, payload);
  if (age < -TIME_WINDOW_SECONDS) return reportOnly('future', 'Command rejected: the message has an invalid future timestamp.', payload);
  const key = replayKey(encrypted, payload);
  if (ctx.executedIds.includes(key)) return reportOnly('replay', 'Command rejected: this command was already executed.', payload);

  // Remember before executing: a command that throws half way must not run again.
  ctx.rememberCommand(key);
  const result = await executeCommand(payload, ctx.deps);
  await ctx.report(describeForAudit(payload, result.message, result.ok), result, payload);
  return { handled: true, result };
}
