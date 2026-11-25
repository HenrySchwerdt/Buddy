import { createRegistry } from '@buddy/core';
import { orefSmb, orefTempBasal } from './oref/plugins';
import { predictive } from './predictive';
import { pid } from './pid';
export { orefSmb, orefTempBasal, predictive, pid };
export { totalDailyDose } from './oref/adapter';
export { predictGlucose } from './shared/predict';
/** All algorithms bundled with Buddy. Add yours here (see docs/ADDING_AN_ALGORITHM.md). */
export const BUILT_IN_ALGORITHMS = [orefSmb, orefTempBasal, predictive, pid];
export const createAlgorithmRegistry = () => createRegistry(BUILT_IN_ALGORITHMS);
export * from './testkit';
