/**
 * Command model of Trio's remote control (`CommandPayload`, `TrioRemoteControl.CommandType`).
 * Field names are the wire names the sender (Loop Follow) uses.
 */

export const COMMAND_TYPES = ['bolus', 'temp_target', 'cancel_temp_target', 'meal', 'start_override', 'cancel_override', 'delete_meal', 'edit_meal'] as const;
export type KnownCommandType = (typeof COMMAND_TYPES)[number];
/** Types from newer senders decode to `unknown` and are rejected. */
export type CommandType = KnownCommandType | 'unknown';

export interface CommandPayload {
  readonly user: string;
  readonly commandType: CommandType;
  /** Seconds since 1970 when the sender created the command. */
  readonly timestamp: number;
  /** Units. */
  readonly bolusAmount?: number;
  /** mg/dL */
  readonly target?: number;
  /** minutes */
  readonly duration?: number;
  readonly carbs?: number;
  readonly protein?: number;
  readonly fat?: number;
  readonly overrideName?: string;
  /** Seconds since 1970. */
  readonly scheduledTime?: number;
  readonly commandId?: string;
  readonly mealId?: string;
}

export class PayloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PayloadError';
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Optional number field: absent/null is undefined, anything else must be a finite number (numeric strings are accepted like Decimal decoding). */
function optNumber(o: Record<string, unknown>, key: string): number | undefined {
  const v = o[key];
  if (v === undefined || v === null) return undefined;
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isFinite(n)) throw new PayloadError(`Field "${key}" is not a number`);
  return n;
}

function optInt(o: Record<string, unknown>, key: string): number | undefined {
  const n = optNumber(o, key);
  if (n !== undefined && !Number.isInteger(n)) throw new PayloadError(`Field "${key}" is not an integer`);
  return n;
}

function optString(o: Record<string, unknown>, key: string): string | undefined {
  const v = o[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string') throw new PayloadError(`Field "${key}" is not a string`);
  return v;
}

/** Decodes the decrypted JSON like Swift's `JSONDecoder` does for `CommandPayload` (the return-notification block is deliberately dropped). */
export function parseCommandPayload(json: unknown): CommandPayload {
  if (!isRecord(json)) throw new PayloadError('Command is not an object');
  const user = optString(json, 'user');
  const type = optString(json, 'command_type');
  const timestamp = optNumber(json, 'timestamp');
  if (user === undefined || type === undefined || timestamp === undefined) throw new PayloadError('Command is missing user, command_type or timestamp');
  const commandType: CommandType = (COMMAND_TYPES as readonly string[]).includes(type) ? (type as KnownCommandType) : 'unknown';
  const out: { -readonly [K in keyof CommandPayload]: CommandPayload[K] } = { user, commandType, timestamp };
  const set = <K extends keyof CommandPayload>(k: K, v: CommandPayload[K] | undefined) => {
    if (v !== undefined) out[k] = v;
  };
  set('bolusAmount', optNumber(json, 'bolus_amount'));
  set('target', optInt(json, 'target'));
  set('duration', optInt(json, 'duration'));
  set('carbs', optInt(json, 'carbs'));
  set('protein', optInt(json, 'protein'));
  set('fat', optInt(json, 'fat'));
  set('overrideName', optString(json, 'overrideName'));
  set('scheduledTime', optNumber(json, 'scheduled_time'));
  set('commandId', optString(json, 'command_id'));
  set('mealId', optString(json, 'meal_id'));
  return out;
}

export const COMMAND_LABEL: Record<CommandType, string> = {
  bolus: 'Bolus',
  temp_target: 'Temporary Target',
  cancel_temp_target: 'Cancel Temporary Target',
  meal: 'Meal',
  start_override: 'Start Override',
  cancel_override: 'Cancel Override',
  delete_meal: 'Delete Meal',
  edit_meal: 'Edit Meal',
  unknown: 'Unknown',
};

/** Trio `humanReadableDescription`. Contains no secret: only what the command asks for. */
export function describeCommand(p: CommandPayload): string {
  let d = `User: ${p.user}. Command Type: ${COMMAND_LABEL[p.commandType]}. `;
  if (p.overrideName) d += `Override Name: ${p.overrideName}. `;
  const macros = `${p.carbs !== undefined ? `${p.carbs}g carbs` : 'unknown carbs'}, ${p.fat !== undefined ? `${p.fat}g fat` : 'unknown fat'}, ${p.protein !== undefined ? `${p.protein}g protein` : 'unknown protein'}`;
  switch (p.commandType) {
    case 'bolus':
      d += p.bolusAmount !== undefined ? `Bolus Amount: ${p.bolusAmount} units.` : 'Bolus Amount: unknown.';
      break;
    case 'temp_target':
      d += `Temp Target: ${p.target !== undefined ? `${p.target} mg/dL` : 'unknown target'}, Duration: ${p.duration !== undefined ? `${p.duration} minutes` : 'unknown duration'}.`;
      break;
    case 'cancel_temp_target':
      d += 'Cancel Temp Target command.';
      break;
    case 'meal':
      d += `Meal with ${macros}.`;
      break;
    case 'delete_meal':
      d += `Delete meal ${p.mealId ?? 'unknown'}.`;
      break;
    case 'edit_meal':
      d += `Edit meal ${p.mealId ?? 'unknown'} to ${macros}.`;
      break;
    case 'start_override':
      d += p.overrideName ? `Start Override: ${p.overrideName}.` : 'Start Override: unknown override name.';
      break;
    case 'cancel_override':
      d += 'Cancel Override command.';
      break;
    case 'unknown':
      d += 'Unknown command.';
      break;
  }
  if (p.scheduledTime !== undefined) d += ` Scheduled for: ${new Date(p.scheduledTime * 1000).toISOString()}.`;
  return d;
}
