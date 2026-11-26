/**
 * Shared Omnipod message layer (transport independent): message blocks, message framing with
 * CRC16, pod enums and insulin tables. TypeScript port of OmnipodKit's `OmnipodCommon`
 * (MIT License, (c) LoopKit Authors), written so an Eros driver can reuse it.
 */
export * from './bytes';
export * from './crc16';
export * from './pod-constants';
export * from './fault-codes';
export * from './insulin-table';
export * from './basal-schedule';
export * from './blocks';
export * from './message';
export * from './pod-state';
