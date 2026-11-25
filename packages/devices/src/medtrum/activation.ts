/**
 * Patch lifecycle flow of the TypeScript port of loopandlearn/MedtrumKit (MIT License,
 * (c) the original MedtrumKit authors): `primePatch`, `activatePatch`, `deactivatePatch`,
 * `forceDeactivatePatch`, `syncBasalRateSchedule`, `updatePatchSettings`, `clearAlert` of
 * `MedtrumPumpManager.swift`, as plain functions for the app's setup UI.
 *
 * Bench use only: the patch is filled with water and never worn.
 *
 * Typical flow (mirrors MedtrumKit onboarding):
 *   1. user fills the patch and attaches it to the base -> `refreshMedtrumPatch` until state is `filled`
 *   2. `primeMedtrumPatch` -> poll `refreshMedtrumPatch` until `primed` (or `ejected`)
 *   3. `activateMedtrumPatch(driver, basalSchedule)`
 *   4. at the end of life: `deactivateMedtrumPatch` (or `forceDeactivateMedtrumPatch` if unreachable)
 */
import type { PumpDriver, Schedule } from '@buddy/core';
import { MedtrumNanoDriver, type FlowResult, type MedtrumPatchStatus } from './driver';

export const isMedtrumNanoDriver = (d: PumpDriver): d is MedtrumNanoDriver => d instanceof MedtrumNanoDriver;

export const readMedtrumPatchStatus = (d: MedtrumNanoDriver): Promise<MedtrumPatchStatus> => d.patchStatus();
export const refreshMedtrumPatch = (d: MedtrumNanoDriver): Promise<FlowResult> => d.refreshPatch();
export const primeMedtrumPatch = (d: MedtrumNanoDriver): Promise<FlowResult> => d.prime();
export const activateMedtrumPatch = (d: MedtrumNanoDriver, basalSchedule: Schedule): Promise<FlowResult> => d.activate(basalSchedule);
export const deactivateMedtrumPatch = (d: MedtrumNanoDriver): Promise<FlowResult> => d.deactivate();
export const forceDeactivateMedtrumPatch = (d: MedtrumNanoDriver): Promise<FlowResult> => d.forceDeactivate();
export const setMedtrumBasalSchedule = (d: MedtrumNanoDriver, schedule: Schedule): Promise<FlowResult> => d.setBasalSchedule(schedule);
export const updateMedtrumPatchSettings = (d: MedtrumNanoDriver): Promise<FlowResult> => d.updatePatchSettings();
export const clearMedtrumAlert = (d: MedtrumNanoDriver, type: 'hourlyMax' | 'dailyMax'): Promise<FlowResult> => d.clearAlert(type);
export const syncMedtrumPatchTime = (d: MedtrumNanoDriver): Promise<FlowResult> => d.syncPatchTime();
