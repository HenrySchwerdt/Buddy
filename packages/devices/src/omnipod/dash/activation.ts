/**
 * Pod lifecycle flow of the Omnipod DASH driver as plain functions for the app's setup UI
 * (like the Medtrum helpers). Port of the onboarding of OmnipodKit's `OmniPumpManager`
 * (`pairAndPrime`, `insertCannula`, `checkCannulaInsertionFinished`, `deactivatePod`).
 *
 * BENCH USE ONLY: the pod is filled with water and never attached to a body.
 *
 * Typical flow:
 *   1. user fills the pod with water (bench only) -> `pairAndPrimePod`
 *   2. poll `refreshPod` until `readPodStatus().podProgress` shows priming finished (5)
 *   3. `insertCannula(driver, basalSchedule)` -> poll `refreshPod` until `phase === 'running'`
 *   4. at the end of life: `deactivatePod` (or `discardPod` if the pod is unreachable)
 */
import type { PumpDriver, Schedule } from '@buddy/core';
import { OmnipodDashDriver } from './driver';
import type { FlowResult, OmnipodPodStatus } from './driver-setup';

export const isOmnipodDashDriver = (d: PumpDriver): d is OmnipodDashDriver => d instanceof OmnipodDashDriver;

/** Status from the last sync, no Bluetooth traffic. */
export const readPodStatus = (d: OmnipodDashDriver): Promise<OmnipodPodStatus> => d.podStatus();
/** Connects if needed and syncs the pod status. */
export const refreshPod = (d: OmnipodDashDriver): Promise<FlowResult> => d.refreshPod();
export const pairAndPrimePod = (d: OmnipodDashDriver): Promise<FlowResult> => d.pairAndPrime();
export const insertCannula = (d: OmnipodDashDriver, basalSchedule: Schedule): Promise<FlowResult> => d.insertCannula(basalSchedule);
export const deactivatePod = (d: OmnipodDashDriver): Promise<FlowResult> => d.deactivate();
export const discardPod = (d: OmnipodDashDriver): Promise<FlowResult> => d.discard();
