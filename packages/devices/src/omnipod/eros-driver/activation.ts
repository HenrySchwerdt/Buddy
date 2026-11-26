/**
 * Pod lifecycle flow of the Omnipod Eros driver as plain functions for the app's setup UI (same
 * shape as the DASH helpers). Port of the onboarding of OmnipodKit's `OmniPumpManager`
 * (`pairAndPrime`, `insertCannula`, `checkCannulaInsertionFinished`, `deactivatePod`).
 *
 * BENCH USE ONLY: the pod is filled with water and never attached to a body.
 *
 * Typical flow:
 *   1. user fills the pod with water (bench only) -> `pairAndPrimeErosPod`
 *   2. poll `refreshErosPod` until `readErosPodStatus().podProgress` shows priming finished (5)
 *   3. `insertErosCannula(driver, basalSchedule)` -> poll `refreshErosPod` until `phase === 'running'`
 *   4. at the end of life: `deactivateErosPod` (or `discardErosPod` if the pod is unreachable)
 */
import type { PumpDriver, Schedule } from '@buddy/core';
import { OmnipodErosDriver } from './driver';
import type { FlowResult, OmnipodPodStatus } from '../dash/driver-setup';

export const isOmnipodErosDriver = (d: PumpDriver): d is OmnipodErosDriver => d instanceof OmnipodErosDriver;

/** Status from the last sync, no radio traffic. */
export const readErosPodStatus = (d: OmnipodErosDriver): Promise<OmnipodPodStatus> => d.podStatus();
/** Connects the RileyLink if needed and syncs the pod status. */
export const refreshErosPod = (d: OmnipodErosDriver): Promise<FlowResult> => d.refreshPod();
export const pairAndPrimeErosPod = (d: OmnipodErosDriver): Promise<FlowResult> => d.pairAndPrime();
export const insertErosCannula = (d: OmnipodErosDriver, basalSchedule: Schedule): Promise<FlowResult> => d.insertCannula(basalSchedule);
export const deactivateErosPod = (d: OmnipodErosDriver): Promise<FlowResult> => d.deactivate();
export const discardErosPod = (d: OmnipodErosDriver): Promise<FlowResult> => d.discard();
