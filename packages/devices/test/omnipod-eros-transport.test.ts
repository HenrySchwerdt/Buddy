/** ErosMessageTransport: fragmentation, ACK/CON handshake, retry/timeout behaviour, full stack over the RileyLink simulator. */
import { describe, expect, it } from 'vitest';
import { hex, type Bytes } from '@buddy/core';
import { createFakeBle } from '../src/testkit';
import { RileyLinkDevice, RileyLinkError, RileyLinkSimulator, decodeRfPacket, encodeRfPacket, type PacketRadio } from '../src/rileylink';
import {
  configureErosRadio,
  decodePacket,
  encodeMessageFrame,
  ErosMessageTransport,
  ErosPodSimulator,
  ErosTransportError,
  PacketType,
  PAIRING_ADDRESS,
} from '../src/omnipod/eros';

const ADDR = 0x1f01482a;
const body = (n: number, seed = 1) => Uint8Array.from({ length: n }, (_, i) => (i * 13 + seed) & 0xff);
const msg = (address: number, seq: number, n: number, seed = 1) => encodeMessageFrame({ address, sequenceNum: seq, body: body(n, seed) });

/** PacketRadio over a pod simulator with a manual clock that advances per radio call. */
function rig(pod: ErosPodSimulator, o: { stepMs?: number } = {}) {
  const clock = { t: 0, now: () => clock.t };
  const sent: Bytes[] = [];
  const radio: PacketRadio = {
    async sendAndListen(data, opts) {
      sent.push(data);
      clock.t += o.stepMs ?? 5;
      for (let i = 0; i <= opts.retryCount; i++) {
        const heard = pod.respond(data);
        if (heard) return { data: heard, packetCounter: 0, rssi: -60 };
        clock.t += opts.timeoutMs;
      }
      throw new RileyLinkError('responseTimeout', 'Pump did not respond in time');
    },
  };
  return { clock, sent, radio };
}
const types = (sent: Bytes[]) => sent.map((s) => decodePacket(s).packetType);

describe('ErosMessageTransport', () => {
  it('single packet exchange: PDM out, POD response back, counters advance', async () => {
    const response = msg(ADDR, 5, 10, 9);
    const pod = new ErosPodSimulator({ address: ADDR, onMessage: () => response });
    const { radio, sent, clock } = rig(pod);
    const t = new ErosMessageTransport({ radio, address: ADDR, clock, state: { packetNumber: 7, messageNumber: 4 } });
    const request = msg(ADDR, 4, 3);
    expect(await t.sendMessage(request)).toEqual(response);
    expect(pod.received).toEqual([request]);
    expect(types(sent)).toEqual([PacketType.pdm, PacketType.ack]); // data packet, then the final ACK
    expect(decodePacket(sent[0]!).sequenceNum).toBe(7);
    // exchange: +1 before, +1 after response, +1 after ackUntilQuiet; message: seq+1, then +1
    expect(t.state).toEqual({ packetNumber: 10, messageNumber: 6 });
  });

  it('fragments a long request into PDM + CON packets and reassembles a long response with CON ACKs', async () => {
    const request = msg(ADDR, 2, 70); // 78 bytes -> 3 packets
    const response = msg(ADDR, 3, 60, 4); // 68 bytes -> POD + 2 CON
    const pod = new ErosPodSimulator({ address: ADDR, onMessage: () => response });
    const { radio, sent, clock } = rig(pod);
    const t = new ErosMessageTransport({ radio, address: ADDR, clock, state: { packetNumber: 0, messageNumber: 2 } });
    expect(await t.sendMessage(request)).toEqual(response);
    expect(pod.received).toEqual([request]);
    expect(types(sent).slice(0, 5)).toEqual([PacketType.pdm, PacketType.con, PacketType.con, PacketType.ack, PacketType.ack]);
    const seqs = sent.slice(0, 5).map((s) => decodePacket(s).sequenceNum);
    expect(seqs).toEqual([0, 2, 4, 6, 8]); // each exchange consumes two packet numbers
  });

  it('pairing: transport address 0xffffffff with ackAddress carried in ACK bodies', async () => {
    const NEW = 0x1f0b3554;
    const response = msg(PAIRING_ADDRESS, 1, 20);
    const pod = new ErosPodSimulator({ address: PAIRING_ADDRESS, onMessage: () => response });
    const { radio, sent, clock } = rig(pod);
    const t = new ErosMessageTransport({ radio, clock, ackAddress: NEW });
    await t.sendMessage(msg(PAIRING_ADDRESS, 0, 6));
    const ack = decodePacket(sent[sent.length - 1]!);
    expect(ack.packetType).toBe(PacketType.ack);
    expect(ack.address).toBe(PAIRING_ADDRESS);
    expect(hex(ack.data)).toBe('1f0b3554');
  });

  it('retries a lost packet and a lost reply without double-processing', async () => {
    const response = msg(ADDR, 1, 8);
    const pod = new ErosPodSimulator({ address: ADDR, onMessage: () => response });
    pod.dropNext = 1;
    pod.dropNextReplies = 1;
    const { radio, clock } = rig(pod);
    const t = new ErosMessageTransport({ radio, address: ADDR, clock });
    expect(await t.sendMessage(msg(ADDR, 0, 4))).toEqual(response);
    expect(pod.received).toHaveLength(1);
    expect(pod.heard).toBeGreaterThan(2);
  });

  it('skips a corrupted reply and recovers on the retry', async () => {
    const response = msg(ADDR, 1, 8);
    const pod = new ErosPodSimulator({ address: ADDR, onMessage: () => response });
    pod.corruptNextReply = true;
    const { radio, clock } = rig(pod);
    const t = new ErosMessageTransport({ radio, address: ADDR, clock });
    expect(await t.sendMessage(msg(ADDR, 0, 4))).toEqual(response);
  });

  it('gives up with noResponseRL after the exchange timeout when the pod is silent (nothing sent fully? yes -> unacknowledged)', async () => {
    const pod = new ErosPodSimulator({ address: ADDR, onMessage: () => null });
    pod.dropNext = 1_000_000;
    const { radio, clock } = rig(pod);
    const t = new ErosMessageTransport({ radio, address: ADDR, clock, timing: { exchangeTimeoutMs: 2000, radioRetryCount: 1 } });
    const err = await t.sendMessage(msg(ADDR, 0, 4)).catch((e) => e);
    expect(err).toBeInstanceOf(ErosTransportError);
    expect(err.kind).toBe('unacknowledgedMessage');
    expect(err.rootKind).toBe('noResponseRL');
    expect(err.sequenceNumber).toBe(0);
    expect(clock.t).toBeGreaterThanOrEqual(2000);
  });

  it('noResponseRL (not unacknowledged) while a multi-packet request is still being sent', async () => {
    const pod = new ErosPodSimulator({ address: ADDR, onMessage: () => null });
    pod.dropNext = 1_000_000;
    const { radio, clock } = rig(pod);
    const t = new ErosMessageTransport({ radio, address: ADDR, clock, timing: { exchangeTimeoutMs: 500, radioRetryCount: 0 } });
    await expect(t.sendMessage(msg(ADDR, 0, 70))).rejects.toMatchObject({ kind: 'noResponseRL' });
  });

  it('pod ACK instead of response is reported as unacknowledged with root podAckedInsteadOfReturningResponse', async () => {
    const pod = new ErosPodSimulator({ address: ADDR, onMessage: () => null });
    const { radio, clock } = rig(pod);
    const t = new ErosMessageTransport({ radio, address: ADDR, clock });
    const err = await t.sendMessage(msg(ADDR, 0, 4)).catch((e) => e);
    expect(err.rootKind).toBe('podAckedInsteadOfReturningResponse');
  });

  it('rejects wrong response address / sequence, but still counts the message as unacknowledged', async () => {
    const cases: [Bytes, string][] = [
      [msg(0x1f000001, 1, 6), 'invalidAddress'],
      [msg(ADDR, 9, 6), 'invalidSequence'],
    ];
    for (const [response, kind] of cases) {
      const pod = new ErosPodSimulator({ address: ADDR, onMessage: () => response });
      const { radio, clock } = rig(pod);
      const t = new ErosMessageTransport({ radio, address: ADDR, clock });
      const err = await t.sendMessage(msg(ADDR, 0, 4)).catch((e) => e);
      expect(err.rootKind).toBe(kind);
    }
  });

  it('rejects malformed messages before touching the radio or the counters', async () => {
    const pod = new ErosPodSimulator({ address: ADDR, onMessage: () => null });
    const { radio, sent, clock } = rig(pod);
    const t = new ErosMessageTransport({ radio, address: ADDR, clock });
    const bad = msg(ADDR, 0, 4).slice();
    bad[bad.length - 1] = bad[bad.length - 1]! ^ 1;
    await expect(t.sendMessage(bad)).rejects.toMatchObject({ kind: 'invalidMessage' });
    expect(sent).toHaveLength(0);
    expect(t.state).toEqual({ packetNumber: 0, messageNumber: 0 });
  });

  it('propagates non-timeout radio errors immediately and serialises concurrent calls', async () => {
    const order: number[] = [];
    const radio: PacketRadio = {
      async sendAndListen() {
        throw new RileyLinkError('disconnected', 'gone');
      },
    };
    const t = new ErosMessageTransport({ radio, address: ADDR });
    const err = await t.sendMessage(msg(ADDR, 0, 4)).catch((e) => e);
    expect(err.kind).toBe('unacknowledgedMessage');
    expect((err.cause as RileyLinkError).kind).toBe('disconnected');

    const response = msg(ADDR, 1, 8);
    const pod = new ErosPodSimulator({ address: ADDR, onMessage: (m) => (order.push(m[6]!), response) });
    const r = rig(pod);
    const t2 = new ErosMessageTransport({ radio: r.radio, address: ADDR, clock: r.clock });
    const a = msg(ADDR, 0, 4, 1);
    const b = msg(ADDR, 2, 4, 2);
    await Promise.all([t2.sendMessage(a), t2.sendMessage(b).catch(() => undefined)]);
    expect(order[0]).toBe(a[6]);
  });

  it('notifies state changes', async () => {
    const pod = new ErosPodSimulator({ address: ADDR, onMessage: () => msg(ADDR, 1, 4) });
    const { radio, clock } = rig(pod);
    const states: unknown[] = [];
    const t = new ErosMessageTransport({ radio, address: ADDR, clock, onStateChange: (s) => states.push(s) });
    await t.sendMessage(msg(ADDR, 0, 4));
    expect(states.length).toBeGreaterThan(3);
    expect(states[states.length - 1]).toEqual(t.state);
  });
});

describe('full stack: ErosMessageTransport -> RileyLinkDevice -> BLE -> RileyLinkSimulator -> pod', () => {
  it('configures the radio and exchanges a fragmented message through packet loss', async () => {
    const response = msg(ADDR, 1, 50, 3);
    const pod = new ErosPodSimulator({ address: ADDR, onMessage: () => response });
    let n = 0;
    const sim = new RileyLinkSimulator({ onRadio: (tx) => (tx && ++n % 4 === 0 ? null : pod.respond(tx)) });
    const ble = createFakeBle();
    ble.add(sim);
    const dev = await RileyLinkDevice.connect(ble.transport, sim.id, { bleLatencyMs: 200, versionTimeoutMs: 200 });
    await configureErosRadio(dev);
    expect(sim.softwareEncoding).toBe(1);
    expect(sim.preamble).toBe(0x6665);
    expect([sim.registers.get(0x09), sim.registers.get(0x0a), sim.registers.get(0x0b)]).toEqual([0x12, 0x14, 0x5f]);
    expect(sim.registers.get(0x1b - 0x1b + 0x2e)).toBe(0x84);
    expect(sim.registers.get(0x00)).toBe(0xa5);
    expect(sim.registers.get(0x01)).toBe(0x5a);

    const t = new ErosMessageTransport({ radio: dev, address: ADDR, timing: { quietWindowMs: 30, packetResponseTimeoutMs: 20, radioRetryCount: 9 } });
    const request = msg(ADDR, 0, 45);
    expect(await t.sendMessage(request)).toEqual(response);
    expect(pod.received).toEqual([request]);
    // radio retries (retryCount 9 inside the firmware) hid the losses from the transport
    expect(sim.transmitted.length).toBeGreaterThan(pod.heard);
    // preamble extension travelled in the SendAndListen command (127 ms = 0x007f)
    const first = sim.commands.find((c) => c.code === 5)!;
    expect(hex(first.payload.slice(10, 12))).toBe('007f');
    expect(decodeRfPacket(encodeRfPacket({ rssi: -60, packetCounter: 1, data: Uint8Array.of(1) }))!.rssi).toBe(-60);
  });
});
