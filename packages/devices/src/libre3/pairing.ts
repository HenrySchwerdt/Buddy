/**
 * Libre 3 NFC pairing: read patch info, send activation (`0xA0`, fresh sensor) or switch-receiver
 * (`0xA8`, already active sensor) and persist the BLE address, PIN and receiver id.
 *
 * TypeScript port of the NFC part of LibreLoop `LibreLoopPairingService.pair` and of RoundWhiteDiscKit
 * `Pairing/CoreNFCActivationReader.swift` (MIT, (c) the LibreLoop / RoundWhiteDiscKit authors). The BLE
 * authorization handshake follows when the CGM source starts (`libre3DirectCgm`), like a reconnect
 * without a cached key.
 *
 * Order matters (LibreLoop): the app credential is checked BEFORE the NFC command, because
 * activation starts the sensor's wear clock; and the NFC response is persisted IMMEDIATELY because
 * every switch-receiver burns the previous BLE PIN.
 */
import { type DeviceContext, type NfcIso15693Tag } from '@buddy/core';
import { loadAppIdentities } from './identity';
import {
  NFC_ACTIVATE, NFC_READ_PATCH_INFO, NFC_SWITCH_RECEIVER, Libre3NfcError, activationParameters, parseActivationResponse, parsePatchInfo, receiverIdFromAccount, receiverIdToHex,
  type Libre3NfcCommand, type Libre3PatchInfo, type ReceiverIdDerivation,
} from './nfc';
import { secureRandom, type RandomSource } from './random';
import { loadOrCreateReceiverId, loadSensorState, saveSensorState, type Libre3SensorState } from './storage';

export const LIBRE3_PAIRING_ALERT = 'Hold the top of your phone very close to the sensor';

export type Libre3PairingErrorCode =
  | 'nfcNotSupported'
  | 'noAppCredential'
  | 'activationNotAllowed'
  | 'unexpectedSensorState'
  | 'nfcFailed';

const PAIRING_ERROR_TEXT: Record<Libre3PairingErrorCode, string> = {
  nfcNotSupported: 'Phone NFC not supported',
  noAppCredential: 'No Libre 3 app credential is installed (see installAppIdentities)',
  activationNotAllowed: 'This sensor is not activated yet. Activating it starts its wear clock; confirm and pair again with allowActivation',
  unexpectedSensorState: 'The sensor is not in the state this pairing mode expects',
  nfcFailed: 'NFC communication with the sensor failed',
};

export class Libre3PairingError extends Error {
  constructor(readonly code: Libre3PairingErrorCode, readonly patchInfo?: Libre3PatchInfo, detail?: string) {
    super(detail ? `${PAIRING_ERROR_TEXT[code]}: ${detail}` : PAIRING_ERROR_TEXT[code]);
    this.name = 'Libre3PairingError';
  }
}

export interface PairLibre3Options {
  /**
   * Permit activating a factory-fresh sensor (irreversible: starts the 60 minute warmup and the wear
   * clock). Default false: a fresh sensor is reported as `activationNotAllowed` with its patch info
   * so the app can ask the user first.
   */
  readonly allowActivation?: boolean;
  /** Only ever send switch-receiver (recovery / re-pair of an active sensor). */
  readonly switchReceiverOnly?: boolean;
  /** Explicit receiver id (e.g. recovered from an earlier install). Wins over `account`. */
  readonly receiverId?: number;
  /** Derive the receiver id from the LibreView account of the Abbott app that activated the sensor. */
  readonly account?: { readonly id: string; readonly derivation: ReceiverIdDerivation };
  readonly random?: RandomSource;
}

export interface Libre3PairingInfo {
  readonly serialNumber: string;
  readonly bleAddress: string;
  readonly receiverIdHex: string;
  readonly command: Libre3NfcCommand;
  /** True when this scan activated a factory-fresh sensor (warmup just started). */
  readonly activated: boolean;
  readonly patchInfo: Libre3PatchInfo;
}

async function resolveReceiverId(ctx: Required<Pick<DeviceContext, 'secrets'>>, options: PairLibre3Options, random: RandomSource): Promise<number> {
  if (options.receiverId !== undefined) return options.receiverId >>> 0;
  if (options.account) return receiverIdFromAccount(options.account.id, options.account.derivation);
  return loadOrCreateReceiverId(ctx.secrets, random);
}

async function runNfc(tag: NfcIso15693Tag, options: PairLibre3Options, receiverId: number, nowSeconds: number) {
  const patchInfo = parsePatchInfo(await tag.customCommand(NFC_READ_PATCH_INFO, new Uint8Array(0)));
  const command = patchInfo.recommendedCommand;
  if (command === NFC_ACTIVATE && options.switchReceiverOnly) throw new Libre3PairingError('unexpectedSensorState', patchInfo, 'sensor is not active');
  if (command === NFC_ACTIVATE && !options.allowActivation) throw new Libre3PairingError('activationNotAllowed', patchInfo);
  // the sensor expects a time just in the past
  const response = await tag.customCommand(command, activationParameters(Math.max(0, nowSeconds - 1), receiverId));
  return { patchInfo, command, activation: parseActivationResponse(response) };
}

/**
 * Pairs (or re-pairs) a Libre 3 sensor over NFC and stores its BLE address, PIN, receiver id and
 * lifecycle durations in `ctx.secrets` for the `libre-3-direct` CGM source. A re-scan invalidates the
 * cached BLE key, so the next start runs the full authorization again.
 */
export async function pairLibre3Sensor(ctx: Pick<DeviceContext, 'nfc' | 'secrets' | 'log' | 'clock'>, options: PairLibre3Options = {}): Promise<Libre3PairingInfo> {
  const { nfc, secrets } = ctx;
  if (!nfc) throw new Error('Libre 3 pairing needs NFC (ctx.nfc is missing)');
  if (!secrets) throw new Error('Libre 3 pairing needs a secret store (ctx.secrets is missing)');
  if (!(await nfc.isSupported())) throw new Libre3PairingError('nfcNotSupported');
  if ((await loadAppIdentities(secrets)).length === 0) throw new Libre3PairingError('noAppCredential');

  const random = options.random ?? secureRandom;
  const receiverId = await resolveReceiverId({ secrets }, options, random);
  const now = ctx.clock?.now() ?? Date.now();

  let result: Awaited<ReturnType<typeof runNfc>>;
  try {
    result = await nfc.withIso15693Tag(LIBRE3_PAIRING_ALERT, (tag) => runNfc(tag, options, receiverId, Math.floor(now / 1000)));
  } catch (e) {
    if (e instanceof Libre3PairingError) throw e;
    if (e instanceof Libre3NfcError) throw new Libre3PairingError('nfcFailed', undefined, e.message);
    throw new Libre3PairingError('nfcFailed', undefined, (e as Error).message);
  }
  const { patchInfo, command, activation } = result;

  const previous = await loadSensorState(secrets);
  const sameSensor = previous?.serialNumber === patchInfo.serialNumber;
  const state: Libre3SensorState = {
    serialNumber: patchInfo.serialNumber,
    bleAddress: activation.bleAddress,
    blePin: activation.blePin,
    receiverId,
    kAuth: null,
    appIdentity: null,
    peripheralId: sameSensor ? previous.peripheralId : null,
    wearDurationMinutes: patchInfo.wearDurationMinutes,
    warmupMinutes: patchInfo.warmupMinutes,
    generation: patchInfo.generation,
    firmwareVersion: patchInfo.firmwareVersion,
    pairedAt: now,
    lastLifeCount: sameSensor ? previous.lastLifeCount : null,
    needsReplacement: false,
    endedNormally: false,
  };
  await saveSensorState(secrets, state);
  ctx.log?.info(`Libre 3 sensor ${patchInfo.serialNumber} ${command === NFC_ACTIVATE ? 'activated' : 'switched to this receiver'} (BLE PIN stored)`);
  return {
    serialNumber: state.serialNumber,
    bleAddress: state.bleAddress,
    receiverIdHex: receiverIdToHex(receiverId),
    command: command === NFC_ACTIVATE ? NFC_ACTIVATE : NFC_SWITCH_RECEIVER,
    activated: command === NFC_ACTIVATE,
    patchInfo,
  };
}

