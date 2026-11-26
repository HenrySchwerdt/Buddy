import { readErosPodStatus, type OmnipodErosDriver } from '../src/omnipod/eros-driver';
export const podStatusFlow = (d: OmnipodErosDriver) => readErosPodStatus(d);
