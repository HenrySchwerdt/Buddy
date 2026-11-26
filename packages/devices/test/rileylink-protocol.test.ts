/**
 * RileyLink port tests: byte vectors from RileyLinkKit's RFPacketTests / ResponseBufferTests /
 * RadioFirmwareVersionTests plus command layouts and the device against the protocol simulator.
 */
import { describe, expect, it } from 'vitest';
import { fromHex, hex, type Logger } from '@buddy/core';
import { createFakeBle } from '../src/testkit';
import {
  CC111XRegister,
  decodeRfPacket,
  encodeRfPacket,
  isRileyLinkError,
  parseBleFirmware,
  parseRadioFirmware,
  radioCapabilities,
  responseFraming,
  RileyLinkDevice,
  RileyLinkSimulator,
  scanRileyLinks,
  SoftwareEncodingType,
} from '../src/rileylink';
import { getPacketCommand, readRegisterCommand, sendAndListenCommand, setModeRegistersCommand, updateRegisterCommand } from '../src/rileylink/commands';
import { legacyResponses, packetResponse } from '../src/rileylink/responses';

const LONG_RF =
  '4926a965a5d1a8dab0e5635635555555555555555555555555555555555555555555555555555555555555555555555555555555555555555555555555555555555555555555555555555555555555555555555555555555555555555555555555555555555555555555559a35';

describe('RFPacket', () => {
  it('decodes the RileyLinkKit vector (rssi -37)', () => {
    const p = decodeRfPacket(fromHex(LONG_RF))!;
    expect(p.rssi).toBe(-37);
    expect(hex(p.data)).toBe(LONG_RF.slice(4));
  });
  it('maps rssi bytes >= 128 with truncating division', () => {
    expect(decodeRfPacket(Uint8Array.of(0xc9, 0, 1))!.rssi).toBe(-27 - 73); // (201-256)/2 = -27.5 truncates toward zero
    expect(decodeRfPacket(Uint8Array.of(0xc8, 0, 1))!.rssi).toBe(-28 - 73);
  });
  it('rejects fewer than two bytes and round-trips', () => {
    expect(decodeRfPacket(Uint8Array.of(1))).toBeNull();
    const p = { rssi: -60, packetCounter: 7, data: Uint8Array.of(1, 2, 3) };
    expect(decodeRfPacket(encodeRfPacket(p))).toEqual(p);
  });
});

describe('firmware versions', () => {
  it('parses subg_rfspy 0.8 as [0, 8]', () => {
    expect(parseRadioFirmware('subg_rfspy 0.8')!.components).toEqual([0, 8]);
    expect(parseRadioFirmware('nonsense')).toBeNull();
    expect(parseBleFirmware('ble_rfspy 2.0')!.components).toEqual([2, 0]);
  });
  it('derives capabilities and framing', () => {
    const old = radioCapabilities(parseRadioFirmware('subg_rfspy 0.8')!);
    expect(old.supportsPreambleExtension).toBe(false);
    expect(old.needsExtraByteForUpdateRegister).toBe(true);
    const v22 = radioCapabilities(parseRadioFirmware('subg_rfspy 2.2')!);
    expect(v22.supportsStatistics).toBe(true);
    expect(v22.needsExtraByteForReadRegister).toBe(true);
    expect(radioCapabilities(parseRadioFirmware('subg_rfspy 2.3')!).needsExtraByteForReadRegister).toBe(false);
    expect(responseFraming(parseBleFirmware('ble_rfspy 2.0'))).toBe('single');
    expect(responseFraming(parseBleFirmware('ble_rfspy 0.9'))).toBe('buffered');
    expect(responseFraming(null)).toBe('buffered');
  });
});

describe('legacy response buffer', () => {
  it('a lone "bb00" yields one response (commandInterrupted)', () => {
    expect(legacyResponses(packetResponse, fromHex('bb00'))).toHaveLength(1);
  });
  it('yields nothing before an end marker arrives', () => {
    expect(legacyResponses(packetResponse, fromHex('bb'))).toHaveLength(0);
  });
});

describe('command layouts', () => {
  const v2 = radioCapabilities(parseRadioFirmware('subg_rfspy 2.2')!);
  const v0 = radioCapabilities(parseRadioFirmware('subg_rfspy 0.8')!);
  const params = { outgoing: Uint8Array.of(0xaa, 0xbb), sendChannel: 0, repeatCount: 1, delayBetweenPacketsMs: 0x0102, listenChannel: 0, timeoutMs: 333, retryCount: 9, preambleExtensionMs: 127 };

  it('SendAndListen v2: 16-bit delay, preamble extension', () => {
    expect(hex(sendAndListenCommand(params, v2).data)).toBe('05' + '00' + '01' + '0102' + '00' + '0000014d' + '09' + '007f' + 'aabb');
  });
  it('SendAndListen v0: 8-bit clamped delay, no preamble', () => {
    expect(hex(sendAndListenCommand(params, v0).data)).toBe('05' + '00' + '01' + 'ff' + '00' + '0000014d' + '09' + 'aabb');
  });
  it('UpdateRegister / ReadRegister extra bytes follow the firmware', () => {
    expect(hex(updateRegisterCommand(CC111XRegister.freq0, 0x5f, v2).data)).toBe('060b5f');
    expect(hex(updateRegisterCommand(CC111XRegister.freq0, 0x5f, v0).data)).toBe('060b5f00');
    expect(hex(readRegisterCommand(CC111XRegister.freq0, v2).data)).toBe('090b0b');
    expect(hex(readRegisterCommand(CC111XRegister.freq0, radioCapabilities(parseRadioFirmware('subg_rfspy 2.3')!)).data)).toBe('090b');
  });
  it('GetPacket and SetModeRegisters', () => {
    expect(hex(getPacketCommand(0, 1000).data)).toBe('03' + '00' + '000003e8');
    expect(hex(setModeRegistersCommand(1, [{ address: CC111XRegister.freq0, value: 1 }, { address: CC111XRegister.test0, value: 9 }]).data)).toBe('0a01' + '0b01' + '2509');
  });
});

async function connect(sim = new RileyLinkSimulator(), o: { bleLatencyMs?: number; log?: Logger } = {}) {
  const ble = createFakeBle();
  ble.add(sim);
  const dev = await RileyLinkDevice.connect(ble.transport, sim.id, { bleLatencyMs: 50, versionTimeoutMs: 200, ...o });
  return { ble, sim, dev };
}

describe('RileyLinkDevice over the simulator', () => {
  it('scans by service UUID', async () => {
    const ble = createFakeBle();
    ble.add(new RileyLinkSimulator());
    const found = await scanRileyLinks(ble.transport, { timeoutMs: 20 });
    expect(found.map((f) => f.name)).toEqual(['RileyLink']);
  });

  it('reads firmware versions on connect (single framing)', async () => {
    const { dev } = await connect();
    expect(dev.bleFirmware.versionString).toBe('ble_rfspy 2.0');
    expect(dev.radioFirmware.versionString).toBe('subg_rfspy 2.2');
    expect(dev.firmwareDescription).toBe('subg_rfspy 2.2 / ble_rfspy 2.0');
  });

  it('works with legacy buffered firmware', async () => {
    const { dev, sim } = await connect(new RileyLinkSimulator({ bleFirmware: 'ble_rfspy 0.9', radioFirmware: 'subg_rfspy 0.8' }));
    expect(dev.radioFirmware.components).toEqual([0, 8]);
    await dev.updateRegister(CC111XRegister.freq0, 0x5f);
    expect(sim.registers.get(CC111XRegister.freq0)).toBe(0x5f);
    await expect(dev.setSoftwareEncoding(SoftwareEncodingType.manchester)).rejects.toMatchObject({ kind: 'unsupportedCommand' });
    sim.setRadioResponder((tx) => (tx ? Uint8Array.of(1, 2, 3) : null));
    const p = await dev.sendAndListen(Uint8Array.of(9), { repeatCount: 0, timeoutMs: 50, retryCount: 0 });
    expect(hex(p.data)).toBe('010203');
  });

  it('sets the base frequency to FREQ2..0 = 12145f for 433.91 MHz and reads it back', async () => {
    const { dev, sim } = await connect();
    await dev.setBaseFrequency(433.91);
    expect([sim.registers.get(0x09), sim.registers.get(0x0a), sim.registers.get(0x0b)]).toEqual([0x12, 0x14, 0x5f]);
    expect(await dev.readBaseFrequency()).toBeCloseTo(433.91, 3);
  });

  it('sendAndListen returns the heard packet and reports retries as one rxTimeout', async () => {
    const { dev, sim } = await connect();
    let calls = 0;
    sim.setRadioResponder((tx) => (++calls < 3 ? null : tx));
    const p = await dev.sendAndListen(Uint8Array.of(1, 2), { repeatCount: 0, timeoutMs: 50, retryCount: 4, preambleExtensionMs: 127 });
    expect(hex(p.data)).toBe('0102');
    expect(p.rssi).toBe(-60);
    expect(sim.transmitted).toHaveLength(3);

    sim.setRadioResponder(() => null);
    await expect(dev.sendAndListen(Uint8Array.of(1), { repeatCount: 0, timeoutMs: 50, retryCount: 1 })).rejects.toSatisfy((e) => isRileyLinkError(e, 'responseTimeout'));
  });

  it('never logs raw radio frames (they carry pod nonces), only lengths and codes', async () => {
    const lines: string[] = [];
    const log: Logger = { info: (m) => lines.push(m), warn: (m) => lines.push(m), error: (m) => lines.push(m) };
    const { dev, sim } = await connect(new RileyLinkSimulator(), { log });
    sim.setRadioResponder((tx) => tx);
    const secret = Uint8Array.of(0xde, 0xad, 0xbe, 0xef, 0xca, 0xfe, 0x01, 0x02);
    await dev.sendAndListen(secret, { repeatCount: 0, timeoutMs: 50, retryCount: 0 });
    expect(lines.some((l) => /^RL (send|recv)/.test(l))).toBe(true);
    expect(lines.filter((l) => /deadbeef|cafe0102/i.test(l))).toEqual([]);
    expect(lines.filter((l) => /[0-9a-f]{12,}/i.test(l))).toEqual([]);
  });

  it('ignores a commandInterrupted preceding the real response', async () => {
    const { dev, sim } = await connect();
    sim.interruptNextCommand();
    await dev.updateRegister(CC111XRegister.pktctrl1, 0x20);
    expect(sim.registers.get(CC111XRegister.pktctrl1)).toBe(0x20);
  });

  it('maps invalidParam to errorResponse', async () => {
    const { dev } = await connect();
    await expect(dev.updateRegister(0x7f as never, 1)).rejects.toMatchObject({ kind: 'errorResponse' });
  });

  it('reports commandsBlocked when the write succeeds but nothing answers', async () => {
    const { dev, sim } = await connect(undefined, { bleLatencyMs: 30 });
    sim.swallowCommands(true);
    await expect(dev.updateRegister(CC111XRegister.pktctrl1, 1)).rejects.toMatchObject({ kind: 'commandsBlocked' });
  });

  it('reports bleError when the write fails and keeps serving later commands', async () => {
    const { dev, ble } = await connect();
    ble.failNextWrite();
    await expect(dev.updateRegister(CC111XRegister.pktctrl1, 1)).rejects.toMatchObject({ kind: 'bleError' });
    await dev.updateRegister(CC111XRegister.pktctrl1, 2);
  });

  it('serialises concurrent commands in order', async () => {
    const { dev, sim } = await connect();
    await Promise.all([1, 2, 3, 4].map((v) => dev.updateRegister(CC111XRegister.pktctrl0, v)));
    expect(sim.commands.filter((c) => c.code === 6).map((c) => c.payload[1])).toEqual([1, 2, 3, 4]);
  });

  it('rejects oversize commands and fails fast after disconnect', async () => {
    const { dev } = await connect();
    await expect(dev.sendAndListen(new Uint8Array(250), { repeatCount: 0, timeoutMs: 50, retryCount: 0 })).rejects.toMatchObject({ kind: 'writeSizeLimitExceeded' });
    await dev.disconnect();
    await expect(dev.updateRegister(CC111XRegister.pktctrl0, 1)).rejects.toMatchObject({ kind: 'disconnected' });
  });

  it('aborts the in-flight command when the link drops', async () => {
    const { dev, sim, ble } = await connect(undefined, { bleLatencyMs: 500 });
    sim.swallowCommands(true);
    ble.dropAfterWrites(1);
    await expect(dev.updateRegister(CC111XRegister.pktctrl0, 1)).rejects.toMatchObject({ kind: 'disconnected' });
    expect(dev.isConnected).toBe(false);
  });

  it('battery, statistics, LEDs, name, resetRadioConfig', async () => {
    const { dev, sim } = await connect();
    expect(await dev.readBatteryLevel()).toBe(87);
    expect((await dev.getStatistics()).uptimeMs).toBe(123_456);
    await dev.setRadioLeds(true);
    expect([...sim.radioLeds.values()]).toEqual([2, 2]);
    await dev.setCustomName('Buddy');
    expect(sim.customName).toBe('Buddy');
    await dev.setPreamble(0x6665);
    await dev.resetRadioConfig();
    expect(sim.preamble).toBe(0);
  });
});
