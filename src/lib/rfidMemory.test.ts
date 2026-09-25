import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildReadCommand,
  buildWriteCommand,
  createMemorySession,
  encodeMemoryValue,
} from './rfidMemory';
import type { MemoryProfile, MemoryState } from './rfidMemory';

const profile: MemoryProfile = {
  readCommand: 'AA 01',
  writeTemplate: 'AA 02 {value}',
  readPrefix: 'BB 01',
  valueBytes: 4,
  writeAck: 'BB 02',
  timeoutMs: 500,
};
const desired = new Uint8Array([0x54, 0x41, 0x47, 0x31]);
const response = (value = desired) => Uint8Array.from([0xbb, 0x01, ...value]);
const ack = () => new Uint8Array([0xbb, 0x02]);
const cleanups: Array<() => void> = [];

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function setup() {
  const states: MemoryState[] = [];
  const send = vi.fn(async (_bytes: Uint8Array) => {});
  const onState = vi.fn((state: MemoryState) => {
    states.push(state);
  });
  const session = createMemorySession({ send, onState });
  cleanups.push(() => session.cancel('Test cleanup.'));
  return { session, states, send, onState, last: () => states[states.length - 1] };
}

async function settle() {
  for (let index = 0; index < 12; index++) await Promise.resolve();
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup());
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('documented command and value validation', () => {
  it('encodes exact UTF-8 and hex values, including whitespace and zero bytes', () => {
    expect(encodeMemoryValue(' TAG ', 'text', 5)).toEqual(new TextEncoder().encode(' TAG '));
    expect(encodeMemoryValue('é', 'text', 2)).toEqual(new Uint8Array([0xc3, 0xa9]));
    expect(encodeMemoryValue('00 ff 20 0a', 'hex', 4)).toEqual(new Uint8Array([0, 255, 32, 10]));
  });

  it.each([
    ['A', 'text', 4],
    ['é', 'text', 1],
    ['', 'text', 2],
    ['0001', 'hex', 4],
  ] as const)(
    'rejects wrong byte widths instead of padding or truncating %s',
    (value, format, width) => {
      expect(() => encodeMemoryValue(value, format, width)).toThrow('exactly');
    },
  );

  it.each(['0', '0x01', '01-02', 'ZZ', ''])('rejects ambiguous or malformed hex %s', (value) => {
    expect(() => encodeMemoryValue(value, 'hex', 1)).toThrow('hexadecimal');
  });

  it.each([0, 257, 1.5, Number.NaN])('bounds the fixed value size: %s', (width) => {
    expect(() => encodeMemoryValue('A', 'text', width)).toThrow('1 to 256');
  });

  it('allows reading before write configuration exists', () => {
    expect(buildReadCommand({ ...profile, writeTemplate: '', writeAck: '' })).toEqual(
      new Uint8Array([0xaa, 0x01]),
    );
  });

  it('substitutes one byte-aligned value placeholder and preserves prefix/suffix', () => {
    expect(
      buildWriteCommand(
        { ...profile, writeTemplate: 'A0{value}0F FF' },
        new Uint8Array([0, 1, 2, 255]),
      ),
    ).toEqual(new Uint8Array([0xa0, 0, 1, 2, 255, 0x0f, 0xff]));
  });

  it.each(['', 'AA 02', '{value}{value}', 'AA {VALUE}', 'A{value}B', 'GG{value}'])(
    'rejects invalid write templates %s',
    (writeTemplate) => {
      expect(() => buildWriteCommand({ ...profile, writeTemplate }, desired)).toThrow();
    },
  );

  it('requires a read prefix, acknowledgment, bounded commands and timeout', () => {
    expect(() => buildReadCommand({ ...profile, readPrefix: '' })).toThrow('response prefix');
    expect(() => buildReadCommand({ ...profile, readCommand: '' })).toThrow('read command');
    expect(() => buildWriteCommand({ ...profile, writeAck: '' }, desired)).toThrow(
      'acknowledgment',
    );
    expect(() => buildReadCommand({ ...profile, readPrefix: 'AA'.repeat(257) })).toThrow('256');
    expect(() => buildReadCommand({ ...profile, readCommand: 'AA'.repeat(4097) })).toThrow('4,096');
    expect(() =>
      buildWriteCommand({ ...profile, writeTemplate: `${'AA'.repeat(4093)}{value}` }, desired),
    ).toThrow('4,096');
    expect(() => buildReadCommand({ ...profile, timeoutMs: 499 })).toThrow('500 to 10,000');
    expect(() => buildReadCommand({ ...profile, timeoutMs: 10001 })).toThrow('500 to 10,000');
  });

  it('sends nothing when read or write configuration is invalid', async () => {
    const test = setup();
    await test.session.read({ ...profile, readPrefix: '' });
    expect(test.last().phase).toBe('error');
    await test.session.writeAndVerify({ ...profile, writeAck: '' }, desired);
    await test.session.writeAndVerify(profile, new Uint8Array([1]));
    expect(test.send).not.toHaveBeenCalled();
    expect(test.session.busy).toBe(false);
  });
});

describe('fixed response reads', () => {
  it('ignores input until an explicit action sends a command', async () => {
    const test = setup();
    test.session.receive(response());
    expect(test.states).toEqual([]);
    expect(test.send).not.toHaveBeenCalled();
    const reading = test.session.read(profile);
    await settle();
    expect(test.last().phase).toBe('reading');
    await vi.advanceTimersByTimeAsync(500);
    await reading;
    expect(test.last().phase).toBe('error');
    expect(test.last().message).toContain('Timed out');
  });

  it('assembles split prefixes and payloads while preserving exact bytes', async () => {
    const test = setup();
    const reading = test.session.read({ ...profile, writeAck: '', writeTemplate: '' });
    test.session.receive(new Uint8Array([0x90, 0xbb]));
    test.session.receive(new Uint8Array([0x01, 0x20, 0x00]));
    test.session.receive(new Uint8Array([0xff, 0x20]));
    await reading;
    expect(test.last()).toMatchObject({
      phase: 'read',
      value: new Uint8Array([0x20, 0, 255, 0x20]),
    });
    expect(test.session.busy).toBe(false);
    expect(test.send).toHaveBeenCalledExactlyOnceWith(new Uint8Array([0xaa, 1]));
  });

  it('finds overlapping signatures in a long noisy stream without retaining noise', async () => {
    const test = setup();
    const reading = test.session.read({ ...profile, readPrefix: 'AA AA BB' });
    test.session.receive(new Uint8Array(100_000).fill(0xaa));
    test.session.receive(new Uint8Array([0xaa, 0xbb, ...desired]));
    await reading;
    expect(test.last()).toMatchObject({ phase: 'read', value: desired });
  });

  it('accepts an early synchronous response but waits for send confirmation', async () => {
    const test = setup();
    const delivery = deferred<void>();
    test.send.mockImplementation(() => {
      test.session.receive(response());
      return delivery.promise;
    });
    const reading = test.session.read(profile);
    await settle();
    expect(test.last().phase).toBe('reading');
    expect(test.session.busy).toBe(true);
    delivery.resolve();
    await reading;
    expect(test.last().phase).toBe('read');
  });

  it('does not claim a successful read if send rejects after an early response', async () => {
    const test = setup();
    const delivery = deferred<void>();
    test.send.mockImplementation(() => {
      test.session.receive(response());
      return delivery.promise;
    });
    const reading = test.session.read(profile);
    delivery.reject(new Error('Reader unplugged'));
    await reading;
    expect(test.last().phase).toBe('error');
    expect(test.last().message).toContain('could not be sent');
    expect(test.states.some((state) => state.phase === 'read')).toBe(false);
  });

  it('bounds a pending send even after a complete response already arrived', async () => {
    const test = setup();
    const delivery = deferred<void>();
    test.send.mockImplementation(() => {
      test.session.receive(response());
      return delivery.promise;
    });
    const reading = test.session.read(profile);
    await vi.advanceTimersByTimeAsync(500);
    await reading;
    expect(test.last().phase).toBe('error');
    expect(test.last().message).toContain('Timed out');
    expect(test.session.busy).toBe(false);
    const count = test.states.length;
    delivery.resolve();
    await settle();
    expect(test.states).toHaveLength(count);
  });

  it('clears its deadline after a successful response and publishes detached values', async () => {
    const test = setup();
    const reading = test.session.read(profile);
    const incoming = response();
    test.session.receive(incoming);
    incoming.fill(0);
    await reading;
    const count = test.states.length;
    expect(test.last().value).toEqual(desired);
    await vi.advanceTimersByTimeAsync(2000);
    expect(test.states).toHaveLength(count);
  });
});

describe('write acknowledgment and fresh readback', () => {
  it('requires ACK and a fresh matching readback before reporting verified', async () => {
    const test = setup();
    const writing = test.session.writeAndVerify(profile, desired);
    expect(test.send).toHaveBeenCalledExactlyOnceWith(new Uint8Array([0xaa, 2, ...desired]));
    test.session.receive(new Uint8Array([0xbb]));
    await settle();
    expect(test.send).toHaveBeenCalledTimes(1);
    test.session.receive(new Uint8Array([2]));
    await settle();
    expect(test.last().phase).toBe('verifying');
    expect(test.send).toHaveBeenNthCalledWith(2, new Uint8Array([0xaa, 1]));
    expect(test.states.some((state) => state.phase === 'verified')).toBe(false);
    test.session.receive(response());
    await writing;
    expect(test.last()).toMatchObject({ phase: 'verified', value: desired });
    expect(test.last().message).toBe('Readback matches the 4 configured bytes.');
  });

  it('discards read-like bytes trailing the ACK instead of reusing them as readback', async () => {
    const test = setup();
    const writing = test.session.writeAndVerify(profile, desired);
    test.session.receive(Uint8Array.from([...ack(), ...response()]));
    await settle();
    expect(test.last().phase).toBe('verifying');
    expect(test.send).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(500);
    await writing;
    expect(test.last().phase).toBe('error');
    expect(test.last().message).toContain('unverified');
    expect(test.last().value).toBeUndefined();
    expect(test.states.some((state) => state.phase === 'verified')).toBe(false);
  });

  it('ignores a readback injected during the phase callback before the read command starts', async () => {
    const test = setup();
    test.onState.mockImplementation((state) => {
      test.states.push(state);
      if (state.phase === 'verifying') test.session.receive(response());
    });
    const writing = test.session.writeAndVerify(profile, desired);
    test.session.receive(ack());
    await settle();
    expect(test.last().phase).toBe('verifying');
    test.session.receive(response());
    await writing;
    expect(test.last().phase).toBe('verified');
  });

  it('compares exact bytes and reports mismatched returned data as unverified', async () => {
    const test = setup();
    const writing = test.session.writeAndVerify(profile, desired);
    test.session.receive(ack());
    await settle();
    const different = new Uint8Array([0x54, 0x41, 0x47, 0x32]);
    test.session.receive(response(different));
    await writing;
    expect(test.last()).toMatchObject({ phase: 'error', value: different });
    expect(test.last().message).toContain('does not match');
    expect(test.last().message).toContain('unverified');
    expect(test.send).toHaveBeenCalledTimes(2);
  });

  it('does not retry or start readback when an acknowledgment is absent or wrong', async () => {
    const test = setup();
    const writing = test.session.writeAndVerify(profile, desired);
    test.session.receive(new Uint8Array([0xbb, 0x03, ...desired]));
    await vi.advanceTimersByTimeAsync(500);
    await writing;
    expect(test.last().phase).toBe('error');
    expect(test.last().message).toContain('unverified');
    expect(test.send).toHaveBeenCalledTimes(1);
  });

  it('handles immediate write ACK and read response emitted inside their send calls', async () => {
    const test = setup();
    test.send.mockImplementation(async (command) => {
      test.session.receive(command[1] === 2 ? ack() : response());
    });
    const value = desired.slice();
    const writing = test.session.writeAndVerify(profile, value);
    value.fill(0);
    await writing;
    expect(test.last()).toMatchObject({ phase: 'verified', value: desired });
    expect(test.send).toHaveBeenCalledTimes(2);
  });

  it('does not read back when delivery of the write rejects despite an early ACK', async () => {
    const test = setup();
    const delivery = deferred<void>();
    test.send.mockImplementation(() => {
      test.session.receive(ack());
      return delivery.promise;
    });
    const writing = test.session.writeAndVerify(profile, desired);
    delivery.reject(new Error('Delivery unknown'));
    await writing;
    expect(test.last().phase).toBe('error');
    expect(test.last().message).toContain('unverified');
    expect(test.send).toHaveBeenCalledTimes(1);
  });
});

describe('deadlines when timeout callbacks are delayed', () => {
  // Advance monotonic time without running timers, as can happen while a page is
  // throttled or its event loop is busy. No test relies on real-time sleeping.
  it.each([500, 750])('rejects a read response delivered at %s ms', async (elapsed) => {
    const clock = vi.spyOn(performance, 'now').mockReturnValue(0);
    const test = setup();
    const reading = test.session.read(profile);
    await settle();
    clock.mockReturnValue(elapsed);
    test.session.receive(response());
    await reading;
    expect(test.last()).toMatchObject({ phase: 'error' });
    expect(test.last().message).toContain('Timed out after 500 ms');
    expect(test.last().value).toBeUndefined();
    expect(test.session.busy).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects a value whose prefix arrived in time but whose last bytes arrived late', async () => {
    const clock = vi.spyOn(performance, 'now').mockReturnValue(0);
    const test = setup();
    const reading = test.session.read(profile);
    clock.mockReturnValue(400);
    test.session.receive(response().subarray(0, 4));
    clock.mockReturnValue(600);
    test.session.receive(response().subarray(4));
    await reading;
    expect(test.last().phase).toBe('error');
    expect(test.last().message).toContain('Timed out');
    expect(test.states.some((state) => state.phase === 'read')).toBe(false);
  });

  it('never starts a verification read after a late write acknowledgment', async () => {
    const clock = vi.spyOn(performance, 'now').mockReturnValue(0);
    const test = setup();
    const writing = test.session.writeAndVerify(profile, desired);
    await settle();
    clock.mockReturnValue(600);
    test.session.receive(ack());
    await writing;
    expect(test.last().phase).toBe('error');
    expect(test.last().message).toContain('unverified');
    expect(test.last().message).toContain('Timed out');
    expect(test.send).toHaveBeenCalledTimes(1);
    expect(test.states.some((state) => state.phase === 'verifying')).toBe(false);
  });

  it('rejects late write delivery despite an acknowledgment received before the deadline', async () => {
    const clock = vi.spyOn(performance, 'now').mockReturnValue(0);
    const test = setup();
    const delivery = deferred<void>();
    test.send.mockReturnValueOnce(delivery.promise);
    const writing = test.session.writeAndVerify(profile, desired);
    clock.mockReturnValue(200);
    test.session.receive(ack());
    clock.mockReturnValue(600);
    delivery.resolve();
    await writing;
    expect(test.last().phase).toBe('error');
    expect(test.last().message).toContain('Timed out');
    expect(test.send).toHaveBeenCalledTimes(1);
    expect(test.states.some((state) => state.phase === 'verifying')).toBe(false);
  });

  it('checks expiry after response completion before starting verification', async () => {
    const clock = vi.spyOn(performance, 'now').mockReturnValue(0);
    const test = setup();
    const writing = test.session.writeAndVerify(profile, desired);
    await settle();
    clock.mockReturnValue(400);
    test.session.receive(ack());
    // The ACK has matched, but its promise continuation has not run yet.
    clock.mockReturnValue(600);
    await writing;
    expect(test.last().phase).toBe('error');
    expect(test.last().message).toContain('Timed out');
    expect(test.send).toHaveBeenCalledTimes(1);
  });

  it.each([
    [899, 'verified'],
    [900, 'error'],
  ] as const)(
    'gives fresh readback its own deadline and checks it at %s ms',
    async (elapsed, phase) => {
      const clock = vi.spyOn(performance, 'now').mockReturnValue(0);
      const test = setup();
      const writing = test.session.writeAndVerify(profile, desired);
      clock.mockReturnValue(400);
      test.session.receive(ack());
      await settle();
      expect(test.last().phase).toBe('verifying');
      clock.mockReturnValue(elapsed);
      test.session.receive(response());
      await writing;
      expect(test.last().phase).toBe(phase);
      expect(test.send).toHaveBeenCalledTimes(2);
      if (phase === 'error') {
        expect(test.last().message).toContain('Timed out');
        expect(test.last().value).toBeUndefined();
      } else expect(test.last().value).toEqual(desired);
    },
  );

  it('does not send a command when a phase callback consumes the whole deadline', async () => {
    const clock = vi.spyOn(performance, 'now').mockReturnValue(0);
    const test = setup();
    test.onState.mockImplementation((state) => {
      test.states.push(state);
      if (state.phase === 'reading') clock.mockReturnValue(600);
    });
    await test.session.read(profile);
    expect(test.last().phase).toBe('error');
    expect(test.last().message).toContain('Timed out');
    expect(test.send).not.toHaveBeenCalled();
  });

  it('preserves explicit cancellation when an overdue delivery completes later', async () => {
    const clock = vi.spyOn(performance, 'now').mockReturnValue(0);
    const test = setup();
    const delivery = deferred<void>();
    test.send.mockReturnValueOnce(delivery.promise);
    const writing = test.session.writeAndVerify(profile, desired);
    clock.mockReturnValue(600);
    test.session.cancel('Reader disconnected.');
    delivery.resolve();
    test.session.receive(ack());
    await writing;
    expect(test.last().message).toBe('Write result is unverified. Reader disconnected.');
    expect(test.send).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('cancellation and overlapping requests', () => {
  it('prevents concurrent actions while leaving the active read usable', async () => {
    const test = setup();
    const first = test.session.read(profile);
    await test.session.writeAndVerify(profile, desired);
    await test.session.read(profile);
    expect(test.send).toHaveBeenCalledTimes(1);
    expect(test.session.busy).toBe(true);
    test.session.receive(response());
    await first;
    expect(test.last().phase).toBe('read');
  });

  it('cancels a pending write promptly and suppresses late ACK/send continuations', async () => {
    const test = setup();
    const delivery = deferred<void>();
    test.send.mockImplementationOnce(() => delivery.promise);
    const writing = test.session.writeAndVerify(profile, desired);
    test.session.receive(ack());
    test.session.cancel('Reader disconnected.');
    await writing;
    expect(test.session.busy).toBe(false);
    expect(test.last().message).toBe('Write result is unverified. Reader disconnected.');
    const count = test.states.length;
    delivery.resolve();
    test.session.receive(ack());
    test.session.receive(response());
    await vi.advanceTimersByTimeAsync(1000);
    expect(test.states).toHaveLength(count);
    expect(test.send).toHaveBeenCalledTimes(1);
  });

  it('cancels between ACK and read initiation without sending the follow-up command', async () => {
    const test = setup();
    test.onState.mockImplementation((state) => {
      test.states.push(state);
      if (state.phase === 'verifying') test.session.cancel('Testing stopped.');
    });
    const writing = test.session.writeAndVerify(profile, desired);
    test.session.receive(ack());
    await writing;
    expect(test.send).toHaveBeenCalledTimes(1);
    expect(test.last().message).toContain('unverified');
    expect(test.session.busy).toBe(false);
  });

  it('can cancel from the initial phase callback before any command is sent', async () => {
    const test = setup();
    test.onState.mockImplementation((state) => {
      test.states.push(state);
      if (state.phase === 'reading') test.session.cancel('Read cancelled.');
    });
    await test.session.read(profile);
    expect(test.send).not.toHaveBeenCalled();
    expect(test.last()).toEqual({ phase: 'error', message: 'Read cancelled.' });
  });

  it('does not allow an old rejected send to corrupt a new explicit operation', async () => {
    const test = setup();
    const delivery = deferred<void>();
    test.send.mockImplementationOnce(() => delivery.promise);
    const first = test.session.read(profile);
    test.session.cancel('Old connection ended.');
    await first;
    const second = test.session.read(profile);
    delivery.reject(new Error('Late old transport error'));
    await settle();
    expect(test.last().phase).toBe('reading');
    test.session.receive(response());
    await second;
    expect(test.last().phase).toBe('read');
    expect(test.send).toHaveBeenCalledTimes(2);
  });
});
