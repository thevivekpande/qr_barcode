import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRe40Session } from './rfidRe40Session';
import type { Re40State } from './rfidRe40Session';
import { encodeRe40Packet } from './rfidRe40';

const bytes = (hex: string) => Uint8Array.from(hex.match(/../g)!.map((part) => parseInt(part, 16)));
// Independent wire fixtures: manufacturer command plus synthetic, CRC-checked replies.
const identify = bytes('AAAB080200020001C66F');
const firmware = bytes('AAAB08110006000101020300AAA3');
const ack = bytes('AAAB080100030802008C23');
const wrongAck = bytes('AAAB0801000308090050D9');
const rejectedAck = bytes('AAAB08010003080207FCC4');
const sessions: ReturnType<typeof createRe40Session>[] = [];

function deferred() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function setup() {
  const states: Re40State[] = [];
  const send = vi.fn(async (_bytes: Uint8Array) => {});
  const onFault = vi.fn((_message: string) => {});
  const onTag = vi.fn();
  const session = createRe40Session({
    send,
    onFault,
    onTag,
    onState: (value) => states.push(value),
  });
  sessions.push(session);
  return { session, send, onFault, onTag, states };
}

async function settle() {
  for (let count = 0; count < 8; count++) await Promise.resolve();
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  sessions.splice(0).forEach((session) => session.reset());
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const originalOlio = bytes('0000020003020064012A1122334405010203040506070800C9');
const tagReport = bytes('AAAB080800188DE2801160600002051A2B3C4D81000186D08700028800039637');
const stopSummary = bytes('AAAB0A91001000000000000000000000000000000004FD96');
const commandType = (value: Uint8Array) => (value[2] << 8) | value[3];

async function inventorySetup(options: { mismatch?: boolean; earlyTag?: boolean } = {}) {
  const test = setup();
  const parameters = new Map<number, Uint8Array>([[0x0401, originalOlio.slice()]]);
  test.send.mockImplementation(async (request) => {
    const command = commandType(request);
    const parameter = (request[6] << 8) | request[7];
    if (command === 0x0802) {
      if (parameter === 1) test.session.receive(firmware);
      else {
        const value = parameters.get(parameter)!.slice();
        if (options.mismatch && parameter === 0x0201) value[0] ^= 1;
        test.session.receive(
          encodeRe40Packet(0x0811, Uint8Array.of(request[6], request[7], ...value)),
        );
      }
    } else if (command === 0x0801) parameters.set(parameter, request.slice(8, -2));
    if (command === 0x0809) {
      if (options.earlyTag) test.session.receive(tagReport);
      // Real SDK behavior permits tag/stop events without a START acknowledgment.
      return;
    }
    test.session.receive(encodeRe40Packet(0x0801, Uint8Array.of(command >> 8, command & 255, 0)));
  });
  await test.session.identify();
  return test;
}

describe('RE40 finite inventory sessions', () => {
  it('rejects a late tag and sends STOP when a background timer misses the scan deadline', async () => {
    const now = vi.spyOn(performance, 'now').mockReturnValue(0);
    const { session, send, onTag } = await inventorySetup();
    await session.scan();
    now.mockReturnValue(5000);
    session.receive(tagReport);
    await settle();
    expect(onTag).not.toHaveBeenCalled();
    expect(commandType(send.mock.calls.at(-1)![0])).toBe(0x0808);
    expect(session.state.phase).toBe('ready');
  });
  it('mirrors configuration readback before START and accepts an early tag without START ACK', async () => {
    const { session, send, onTag, onFault } = await inventorySetup({ earlyTag: true });
    await session.scan();
    expect(session.state.phase).toBe('inventory');
    const requests = send.mock.calls.map(([request]) => request);
    expect(requests.map(commandType)).toEqual([
      0x0802,
      0x0808,
      0x0802,
      ...Array<number>(11).fill(0x0801),
      0x0802,
      0x0802,
      0x0802,
      0x0809,
    ]);
    expect(
      requests
        .filter((request) => commandType(request) === 0x0801)
        .map((request) => (request[6] << 8) | request[7]),
    ).toEqual([
      0x10eb, 0xd003, 0x10ff, 0x10fd, 0x0200, 0x0300, 0x0201, 0x0401, 0x0004, 0x0004, 0x0005,
    ]);
    expect(onTag).toHaveBeenCalledExactlyOnceWith({
      epc: 'E2801160600002051A2B3C4D',
      antenna: 1,
      rssi: -48,
      channel: 2,
      seenCount: 3,
    });
    expect(onFault).not.toHaveBeenCalled();
  });

  it('sends host STOP at five seconds and clears every inventory timer after acknowledgment', async () => {
    const { session, send } = await inventorySetup();
    await session.scan();
    await vi.advanceTimersByTimeAsync(4999);
    expect(session.state.phase).toBe('inventory');
    await vi.advanceTimersByTimeAsync(1);
    expect(session.state.phase).toBe('ready');
    expect(commandType(send.mock.calls.at(-1)![0])).toBe(0x0808);
    const count = send.mock.calls.length;
    await vi.advanceTimersByTimeAsync(10000);
    expect(send).toHaveBeenCalledTimes(count);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('honors the reader stop summary and ignores tags after inventory has ended', async () => {
    const { session, send, onTag } = await inventorySetup({ earlyTag: true });
    await session.scan();
    const count = send.mock.calls.length;
    session.receive(stopSummary);
    expect(session.state.phase).toBe('ready');
    expect(session.state.message).toContain('duration limit');
    expect(session.state.message).toContain('1 tag report');
    session.receive(tagReport);
    await vi.advanceTimersByTimeAsync(10000);
    expect(onTag).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(count);
  });

  it('refuses RF start if any configured value is not confirmed by readback', async () => {
    const { session, send, onFault } = await inventorySetup({ mismatch: true });
    await session.scan();
    expect(session.state.phase).toBe('error');
    expect(session.state.message).toContain('0x201');
    expect(send.mock.calls.some(([request]) => commandType(request) === 0x0809)).toBe(false);
    expect(onFault).toHaveBeenCalledTimes(1);
  });

  it('surfaces a reader error stop reason and never restarts the scan', async () => {
    const { session, send, onFault } = await inventorySetup();
    await session.scan();
    const reason = new Uint8Array(16);
    reason[15] = 32;
    session.receive(encodeRe40Packet(0x0a91, reason));
    expect(session.state.phase).toBe('error');
    expect(session.state.message).toContain('reader error');
    expect(onFault).toHaveBeenCalledTimes(1);
    const count = send.mock.calls.length;
    await vi.advanceTimersByTimeAsync(10000);
    expect(send).toHaveBeenCalledTimes(count);
  });

  it('does not continue scan preparation after disconnect/reset while a write is pending', async () => {
    const { session, send, onFault } = await inventorySetup();
    const writing = deferred();
    send.mockReturnValueOnce(writing.promise);
    const scanning = session.scan();
    await settle();
    expect(commandType(send.mock.calls.at(-1)![0])).toBe(0x0808);
    session.reset();
    writing.resolve();
    await scanning;
    await settle();
    session.receive(bytes('AAAB0801000308080063E8'));
    await vi.advanceTimersByTimeAsync(10000);
    expect(send).toHaveBeenCalledTimes(2);
    expect(session.state.phase).toBe('idle');
    expect(onFault).not.toHaveBeenCalled();
  });
});

describe('RE40 identification exchanges', () => {
  it('ignores replies before its queued send actually starts', async () => {
    const { session } = setup();
    const result = session.identify();
    session.receive(firmware);
    session.receive(ack);
    await settle();
    expect(session.state.phase).toBe('identifying');
    session.receive(firmware);
    session.receive(ack);
    await result;
    expect(session.state.phase).toBe('ready');
  });
  it('ignores unsolicited packets and sends nothing before an explicit identify action', () => {
    const { session, send, states, onFault } = setup();
    session.receive(firmware);
    session.receive(ack);
    expect(session.state.phase).toBe('idle');
    expect(session.busy).toBe(false);
    expect(send).not.toHaveBeenCalled();
    expect(states).toEqual([]);
    expect(onFault).not.toHaveBeenCalled();
  });

  it.each(['firmware-first', 'ack-first'] as const)(
    'requires both replies across split chunks: %s',
    async (order) => {
      const { session, send, onFault } = setup();
      const result = session.identify();
      await settle();
      expect(send).toHaveBeenCalledExactlyOnceWith(identify);
      const first = order === 'firmware-first' ? firmware : ack;
      const second = order === 'firmware-first' ? ack : firmware;
      session.receive(first.subarray(0, 3));
      session.receive(first.subarray(3));
      expect(session.state.phase).toBe('identifying');
      session.receive(second.subarray(0, second.length - 1));
      expect(session.state.phase).toBe('identifying');
      session.receive(second.subarray(second.length - 1));
      await result;
      expect(session.state).toMatchObject({ phase: 'ready', firmware: { version: '1.2.3.0' } });
      expect(session.busy).toBe(false);
      expect(onFault).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it('accepts synchronous replies but waits for the transport send to finish', async () => {
    const { session, send, onFault } = setup();
    const writing = deferred();
    send.mockImplementation(() => {
      session.receive(firmware);
      session.receive(ack);
      return writing.promise;
    });
    const result = session.identify();
    await settle();
    expect(session.state.phase).toBe('identifying');
    writing.resolve();
    await result;
    expect(session.state.phase).toBe('ready');
    expect(onFault).not.toHaveBeenCalled();
  });

  it('does not accept replies as success when the send ultimately rejects', async () => {
    const { session, send, onFault, states } = setup();
    const writing = deferred();
    send.mockReturnValue(writing.promise);
    const result = session.identify();
    await settle();
    session.receive(firmware);
    session.receive(ack);
    writing.reject(new Error('Synthetic write failure'));
    await result;
    expect(session.state).toMatchObject({ phase: 'error', message: 'Synthetic write failure' });
    expect(states.some((state) => state.phase === 'ready')).toBe(false);
    expect(onFault).toHaveBeenCalledExactlyOnceWith('Synthetic write failure');
  });

  it.each(['firmware-only', 'ack-only', 'wrong-ack', 'bad-checksum'] as const)(
    'times out incomplete or invalid exchanges: %s',
    async (kind) => {
      const { session, onFault } = setup();
      const result = session.identify();
      await settle();
      if (kind === 'firmware-only' || kind === 'wrong-ack') session.receive(firmware);
      if (kind === 'ack-only' || kind === 'bad-checksum') session.receive(ack);
      if (kind === 'wrong-ack') session.receive(wrongAck);
      if (kind === 'bad-checksum') {
        const damaged = firmware.slice();
        damaged[damaged.length - 1] ^= 1;
        session.receive(damaged);
      }
      expect(session.state.phase).toBe('identifying');
      await vi.advanceTimersByTimeAsync(3000);
      await result;
      expect(session.state.phase).toBe('error');
      expect(session.state.firmware).toBeUndefined();
      expect(onFault).toHaveBeenCalledTimes(1);
      expect(session.busy).toBe(false);
    },
  );

  it('retires a rejected exchange and refuses another identify until reset', async () => {
    const { session, send, onFault } = setup();
    const result = session.identify();
    await settle();
    session.receive(firmware);
    session.receive(rejectedAck);
    await result;
    expect(session.state.phase).toBe('error');
    expect(session.state.message).toContain('7');
    expect(onFault).toHaveBeenCalledTimes(1);
    await session.identify();
    expect(send).toHaveBeenCalledTimes(1);
    session.receive(ack);
    expect(session.state.phase).toBe('error');
  });

  it('bounds a send that never settles and ignores its later completion', async () => {
    const { session, send, onFault } = setup();
    const writing = deferred();
    send.mockReturnValue(writing.promise);
    const result = session.identify();
    await settle();
    session.receive(firmware);
    session.receive(ack);
    await vi.advanceTimersByTimeAsync(3000);
    await result;
    writing.resolve();
    await settle();
    expect(session.state.phase).toBe('error');
    expect(onFault).toHaveBeenCalledTimes(1);
  });

  it('rejects a response at the monotonic deadline even before a delayed timeout fires', async () => {
    const now = vi.spyOn(performance, 'now').mockReturnValue(0);
    const { session, onFault } = setup();
    const result = session.identify();
    await settle();
    now.mockReturnValue(3000);
    session.receive(firmware);
    session.receive(ack);
    await result;
    expect(session.state.phase).toBe('error');
    expect(onFault).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cancels a queued send before dispatch and discards incomplete decoder state', async () => {
    const { session, send, onFault } = setup();
    const first = session.identify();
    session.receive(firmware.subarray(0, 5));
    session.reset();
    await first;
    await settle();
    expect(send).not.toHaveBeenCalled();
    const second = session.identify();
    await settle();
    session.receive(firmware.subarray(5));
    session.receive(ack);
    expect(session.state.phase).toBe('identifying');
    session.receive(firmware);
    await second;
    expect(session.state.phase).toBe('ready');
    expect(send).toHaveBeenCalledTimes(1);
    expect(onFault).not.toHaveBeenCalled();
  });

  it('does not let a canceled send complete a newer exchange', async () => {
    const { session, send, onFault } = setup();
    const oldWrite = deferred();
    const newWrite = deferred();
    send.mockReturnValueOnce(oldWrite.promise).mockReturnValueOnce(newWrite.promise);
    const first = session.identify();
    await settle();
    session.reset();
    await first;
    const second = session.identify();
    await settle();
    session.receive(firmware);
    session.receive(ack);
    oldWrite.resolve();
    await settle();
    expect(session.state.phase).toBe('identifying');
    newWrite.resolve();
    await second;
    expect(session.state.phase).toBe('ready');
    expect(onFault).not.toHaveBeenCalled();
  });

  it('coalesces concurrent identify requests and requires fresh replies for the next query', async () => {
    const { session, send } = setup();
    const first = session.identify();
    await session.identify();
    await settle();
    expect(send).toHaveBeenCalledTimes(1);
    session.receive(firmware);
    session.receive(ack);
    await first;
    const second = session.identify();
    await settle();
    session.receive(ack);
    expect(session.state.phase).toBe('identifying');
    session.receive(firmware);
    await second;
    expect(send).toHaveBeenCalledTimes(2);
  });
});
