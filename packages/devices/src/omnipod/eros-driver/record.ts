/**
 * The persisted Eros pod record. It extends the DASH record (`PodState.swift` of OmnipodKit,
 * MIT License, (c) LoopKit Authors: setup progress, last status, fault, dose ledger) by the
 * Eros specific radio state: the 5-bit packet counter and the rolling nonce state. The DASH
 * fields `ltk`, `bleId`, `controllerId` stay empty; `podId` holds the pod's radio address and
 * `transport.messageNumber` the 4-bit message number.
 */
import type { SecretStore } from '@buddy/core';
import type { NonceState } from '../eros';
import { initialRecord, parseRecord, type DashPodRecord } from '../dash/record';
import { parseNonceState } from './nonce-store';

export interface ErosPodRecord extends DashPodRecord {
  /** 5-bit radio packet counter; kept across pairing attempts */
  readonly packetNumber: number;
  /** null until the first nonce resync */
  readonly nonce: NonceState | null;
}

export const EROS_RECORD_KEY = 'omnipod-eros/pod';

export const initialErosRecord = (): ErosPodRecord => ({ ...initialRecord(), packetNumber: 0, nonce: null });

export function parseErosRecord(json: string): ErosPodRecord {
  const base = parseRecord(json);
  const raw = JSON.parse(json) as { packetNumber?: unknown; nonce?: unknown };
  const packetNumber = typeof raw.packetNumber === 'number' && Number.isFinite(raw.packetNumber) ? raw.packetNumber & 0b11111 : 0;
  return { ...base, packetNumber, nonce: parseNonceState(raw.nonce) };
}

export async function loadErosRecord(secrets: SecretStore): Promise<ErosPodRecord> {
  const raw = await secrets.get(EROS_RECORD_KEY);
  return raw === null ? initialErosRecord() : parseErosRecord(raw);
}

export const saveErosRecord = (secrets: SecretStore, r: ErosPodRecord): Promise<void> => secrets.set(EROS_RECORD_KEY, JSON.stringify(r));
export const clearErosRecord = (secrets: SecretStore): Promise<void> => secrets.set(EROS_RECORD_KEY, null);
