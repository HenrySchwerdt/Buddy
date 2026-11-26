import { newId, validateTempTarget, type ActiveOverride, type ActiveTempTarget, type CarbEntry, type DataSnapshot, type Millis, type OverridePreset, type SafetyLimits, type TherapyProfile } from '@buddy/core';
import { checkBolusSafety } from '../bolus-safety';
import { describeCommand, type CommandPayload } from './payload';

/**
 * Executes an authenticated remote command (port of Trio's TrioRemoteControl+* handlers). Everything the phone has to do
 * is injected (`RemoteDeps`), so every rule is testable. A command that fails validation is never executed: it produces a
 * rejection that is logged (without secrets) and audited.
 */

export const REMOTE_MEAL_NOTE = '📡';
/** Trio `mealMutationMaxFuture`. */
export const MEAL_MUTATION_MAX_FUTURE_MS = 12 * 3_600_000;
const DAY_MS = 24 * 3_600_000;

export interface RemoteLimits {
  readonly maxCarbs: number;
  readonly maxFat: number;
  readonly maxProtein: number;
}

export interface RemoteDeps {
  now(): Millis;
  limits(): SafetyLimits;
  mealLimits(): RemoteLimits;
  profile(): TherapyProfile;
  snapshot(): DataSnapshot;
  overridePresets(): readonly OverridePreset[];
  tempTarget(): ActiveTempTarget | null;
  override(): ActiveOverride | null;
  /** Delivers a manual bolus on the pump; returns the units actually delivered. */
  deliverBolus(units: number): Promise<number>;
  /** Stores a meal (carbs plus the carb equivalents of fat and protein) and returns the id of the carb entry. */
  addMeal(meal: { readonly carbs: number; readonly fat: number; readonly protein: number; readonly date: Millis; readonly note: string }): string;
  /** Deletes a meal locally and in Nightscout / Health / Tidepool. */
  deleteMeal(id: string, date: Millis): Promise<void>;
  startTempTarget(t: ActiveTempTarget): void;
  cancelTempTarget(): void;
  startOverride(o: ActiveOverride): void;
  cancelOverride(): void;
  /** Re-runs the loop so IOB/COB reflect the change (failures only delay it). */
  recalculate(): Promise<void>;
}

export type AckResult = 'deleted' | 'updated' | 'not_found' | 'rejected';

export interface CommandResult {
  readonly ok: boolean;
  /** Short text for the user (local notification) and the audit note. */
  readonly message: string;
  readonly ack?: { readonly commandId?: string; readonly mealId?: string; readonly result: AckResult };
}

const done = (message: string, ack?: CommandResult['ack']): CommandResult => ({ ok: true, message, ...(ack ? { ack } : {}) });
const reject = (message: string, ack?: CommandResult['ack']): CommandResult => ({ ok: false, message, ...(ack ? { ack } : {}) });
const rejectedAck = (p: CommandPayload): CommandResult['ack'] => ({ ...(p.commandId ? { commandId: p.commandId } : {}), ...(p.mealId ? { mealId: p.mealId } : {}), result: 'rejected' });

const g = (n: number) => `${n}g`;

/** Trio `validateMealAge`. */
export function validateMealAge(date: Millis, now: Millis, label = 'meal'): string | null {
  if (date < now - DAY_MS) return `Command rejected: the ${label} is older than 24 hours.`;
  if (now - date < -MEAL_MUTATION_MAX_FUTURE_MS) return `Command rejected: the ${label} is more than 12 hours in the future.`;
  return null;
}

/** Trio `validateEditMealInput`. */
export function validateEditMealInput(carbs: number, fat: number, protein: number, max: RemoteLimits): string | null {
  if (carbs < 0 || fat < 0 || protein < 0) return 'Command rejected: meal amounts cannot be negative.';
  if (carbs === 0 && fat === 0 && protein === 0) return 'Command rejected: all meal amounts are zero. Use delete_meal to remove the meal.';
  if (carbs > max.maxCarbs) return `Command rejected: carbs amount (${g(carbs)}) exceeds the maximum allowed (${g(max.maxCarbs)}).`;
  if (fat > max.maxFat) return `Command rejected: fat amount (${g(fat)}) exceeds the maximum allowed (${g(max.maxFat)}).`;
  if (protein > max.maxProtein) return `Command rejected: protein amount (${g(protein)}) exceeds the maximum allowed (${g(max.maxProtein)}).`;
  return null;
}

async function bolus(p: CommandPayload, d: RemoteDeps): Promise<CommandResult> {
  const amount = p.bolusAmount;
  if (amount === undefined || !Number.isFinite(amount)) return reject('Command rejected: bolus amount is missing or invalid.');
  const now = d.now();
  const verdict = checkBolusSafety({ units: amount, limits: d.limits(), profile: d.profile(), doses: d.snapshot().doses, now, source: 'remote', lookbackStart: p.timestamp * 1000 });
  if (!verdict.ok) return reject(verdict.message);
  try {
    await d.deliverBolus(amount);
  } catch (e) {
    return reject(e instanceof Error ? e.message : 'Bolus failed');
  }
  return done('Bolus started');
}

async function meal(p: CommandPayload, d: RemoteDeps): Promise<CommandResult> {
  if (p.carbs === undefined && p.fat === undefined && p.protein === undefined) return reject('Command rejected: meal data is incomplete or invalid.');
  const carbs = p.carbs ?? 0;
  const fat = p.fat ?? 0;
  const protein = p.protein ?? 0;
  if (carbs < 0 || fat < 0 || protein < 0) return reject('Command rejected: meal amounts cannot be negative.');
  const max = d.mealLimits();
  if (p.carbs !== undefined && carbs > max.maxCarbs) return reject(`Command rejected: carbs amount (${g(carbs)}) exceeds the maximum allowed (${g(max.maxCarbs)}).`);
  if (p.fat !== undefined && fat > max.maxFat) return reject(`Command rejected: fat amount (${g(fat)}) exceeds the maximum allowed (${g(max.maxFat)}).`);
  if (p.protein !== undefined && protein > max.maxProtein) return reject(`Command rejected: protein amount (${g(protein)}) exceeds the maximum allowed (${g(max.maxProtein)}).`);

  const now = d.now();
  // Only entries already in the past can indicate a replay; equivalents and scheduled meals are dated ahead.
  const sentAt = p.timestamp * 1000;
  if (d.snapshot().carbs.some((c) => c.date > sentAt && c.date <= now)) return reject('Command rejected: newer carb entries have been logged since the command was sent.');

  const date = p.scheduledTime !== undefined ? p.scheduledTime * 1000 : now;
  d.addMeal({ carbs, fat, protein, date, note: REMOTE_MEAL_NOTE });
  if (p.bolusAmount !== undefined) return bolus(p, d);
  return done('Meal logged');
}

function findMeal(p: CommandPayload, d: RemoteDeps): { readonly carb: CarbEntry } | { readonly error: CommandResult } {
  const carb = d.snapshot().carbs.find((c) => c.id === p.mealId);
  if (!carb) {
    return { error: reject('Command rejected: the meal was not found. It may already have been deleted or changed on the phone.', { ...(p.commandId ? { commandId: p.commandId } : {}), ...(p.mealId ? { mealId: p.mealId } : {}), result: 'not_found' }) };
  }
  if (carb.id.startsWith('fpu-')) return { error: reject('Command rejected: meal_id refers to a carb equivalent, not the meal itself.', rejectedAck(p)) };
  return { carb };
}

async function deleteMeal(p: CommandPayload, d: RemoteDeps): Promise<CommandResult> {
  if ([p.carbs, p.fat, p.protein, p.scheduledTime, p.bolusAmount, p.target, p.duration, p.overrideName].some((v) => v !== undefined)) {
    return reject('Command rejected: delete_meal cannot carry meal, bolus or override values.', rejectedAck(p));
  }
  if (!p.mealId) return reject('Command rejected: meal_id is missing or not a valid UUID.', rejectedAck(p));
  const found = findMeal(p, d);
  if ('error' in found) return found.error;
  const age = validateMealAge(found.carb.date, d.now());
  if (age) return reject(age, rejectedAck(p));
  await d.deleteMeal(found.carb.id, found.carb.date);
  await d.recalculate().catch(() => {});
  return done('Meal deleted', { ...(p.commandId ? { commandId: p.commandId } : {}), mealId: found.carb.id, result: 'deleted' });
}

async function editMeal(p: CommandPayload, d: RemoteDeps): Promise<CommandResult> {
  if ([p.bolusAmount, p.target, p.duration, p.overrideName].some((v) => v !== undefined)) return reject('Command rejected: edit_meal cannot carry bolus or override values.', rejectedAck(p));
  if (!p.mealId) return reject('Command rejected: meal_id is missing or not a valid UUID.', rejectedAck(p));
  if (p.carbs === undefined || p.fat === undefined || p.protein === undefined || p.scheduledTime === undefined) {
    return reject('Command rejected: edit_meal requires carbs, fat, protein and scheduled_time.', rejectedAck(p));
  }
  const input = validateEditMealInput(p.carbs, p.fat, p.protein, d.mealLimits());
  if (input) return reject(input, rejectedAck(p));
  const now = d.now();
  const newDate = p.scheduledTime * 1000;
  const newAge = validateMealAge(newDate, now, 'new meal time');
  if (newAge) return reject(newAge, rejectedAck(p));
  const found = findMeal(p, d);
  if ('error' in found) return found.error;
  const oldAge = validateMealAge(found.carb.date, now);
  if (oldAge) return reject(oldAge, rejectedAck(p));

  await d.deleteMeal(found.carb.id, found.carb.date);
  const newId_ = d.addMeal({ carbs: p.carbs, fat: p.fat, protein: p.protein, date: newDate, note: found.carb.note && found.carb.note.length > 0 ? found.carb.note : REMOTE_MEAL_NOTE });
  await d.recalculate().catch(() => {});
  return done('Meal updated', { ...(p.commandId ? { commandId: p.commandId } : {}), mealId: newId_, result: 'updated' });
}

function tempTarget(p: CommandPayload, d: RemoteDeps): CommandResult {
  if (p.target === undefined || p.duration === undefined) return reject('Command rejected: temp target data is incomplete or invalid.');
  const draft = { id: newId('target'), name: 'Custom', target: p.target, durationMin: p.duration };
  const errors = validateTempTarget(draft);
  if (errors.length > 0) return reject(`Command rejected: ${errors.join('; ')}`);
  d.startTempTarget({ ...draft, startedAt: d.now() });
  return done('Temp target set');
}

function startOverride(p: CommandPayload, d: RemoteDeps): CommandResult {
  if (!p.overrideName) return reject('Command rejected: override name is missing.');
  const preset = d.overridePresets().find((o) => o.name === p.overrideName);
  if (!preset) return reject('Command rejected: no override preset with this name.');
  d.startOverride({ ...preset, startedAt: d.now(), presetId: preset.id });
  return done('Override started');
}

/** Dispatches an authenticated command. Never throws. */
export async function executeCommand(p: CommandPayload, d: RemoteDeps): Promise<CommandResult> {
  try {
    switch (p.commandType) {
      case 'bolus':
        return await bolus(p, d);
      case 'temp_target':
        return tempTarget(p, d);
      case 'cancel_temp_target':
        d.cancelTempTarget();
        return done('Temp target canceled');
      case 'meal':
        return await meal(p, d);
      case 'start_override':
        return startOverride(p, d);
      case 'cancel_override':
        d.cancelOverride();
        return done('Override canceled');
      case 'delete_meal':
        return await deleteMeal(p, d);
      case 'edit_meal':
        return await editMeal(p, d);
      case 'unknown':
        return reject('Command rejected: unsupported command type.', rejectedAck(p));
    }
  } catch (e) {
    return reject(`Command failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export const describeForAudit = (p: CommandPayload, message: string, ok: boolean): string => (ok ? `Remote command processed successfully. ${describeCommand(p)}` : `${message} Details: ${describeCommand(p)}`);
