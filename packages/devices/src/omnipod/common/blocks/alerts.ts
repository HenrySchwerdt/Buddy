/**
 * Pod alert presets. Port of the `PodAlert.configuration` cases that the pod lifecycle needs
 * (`OmnipodCommon/AlertSlot.swift` from OmnipodKit, MIT License, (c) LoopKit Authors).
 * Suspend reminder alerts and the auto-off alert are not ported.
 */
import { AlertSlot, BeepRepeat, BeepType, HOUR, MINUTE } from '../pod-constants';
import type { AlertConfiguration } from './types';

/** Reminder beeps every 5 minutes if setup is not finished within an hour (after priming). */
export const finishSetupReminderAlert = (): AlertConfiguration => ({
  slot: AlertSlot.expired,
  active: true,
  duration: 1 * HOUR - 5 * MINUTE,
  trigger: { kind: 'timeUntilAlert', seconds: 5 * MINUTE },
  beepRepeat: BeepRepeat.every5Minutes,
  beepType: BeepType.bipBeepBipBeepBipBeepBipBeep,
  silent: false,
  autoOffModifier: false,
});

export const shutdownImminentAlert = (offset: number, absAlertTime: number, silent: boolean): AlertConfiguration => {
  const active = absAlertTime !== 0;
  return {
    slot: AlertSlot.shutdownImminent,
    active,
    duration: 0,
    trigger: { kind: 'timeUntilAlert', seconds: active ? absAlertTime - offset : 0 },
    beepRepeat: BeepRepeat.every15Minutes,
    beepType: BeepType.bipBeepBipBeepBipBeepBipBeep,
    silent,
    autoOffModifier: false,
  };
};

export const expirationReminderAlert = (offset: number, absAlertTime: number, silent: boolean, duration = 0): AlertConfiguration => {
  const active = absAlertTime !== 0;
  return {
    slot: AlertSlot.expirationReminder,
    active,
    duration,
    trigger: { kind: 'timeUntilAlert', seconds: active ? absAlertTime - offset : 0 },
    beepRepeat: BeepRepeat.every1MinuteFor3MinutesAndRepeatEvery15Minutes,
    beepType: BeepType.bipBeepBipBeepBipBeepBipBeep,
    silent,
    autoOffModifier: false,
  };
};

/** The "pod expired" advisory (slot 7), lasting `duration` seconds once `absAlertTime` is reached. */
export const expiredAlert = (offset: number, absAlertTime: number, duration: number, silent: boolean): AlertConfiguration => {
  const active = absAlertTime !== 0;
  return {
    slot: AlertSlot.expired,
    active,
    duration,
    trigger: { kind: 'timeUntilAlert', seconds: active ? absAlertTime - offset : 0 },
    beepRepeat: BeepRepeat.every60Minutes,
    beepType: BeepType.bipBeepBipBeepBipBeepBipBeep,
    silent,
    autoOffModifier: false,
  };
};

export const lowReservoirAlert = (units: number, silent: boolean): AlertConfiguration => ({
  slot: AlertSlot.lowReservoir,
  active: units !== 0,
  duration: 0,
  trigger: { kind: 'unitsRemaining', units },
  beepRepeat: BeepRepeat.every1MinuteFor3MinutesAndRepeatEvery60Minutes,
  beepType: BeepType.bipBeepBipBeepBipBeepBipBeep,
  silent,
  autoOffModifier: false,
});
