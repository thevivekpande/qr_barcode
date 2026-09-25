import {
  buildRe40GetParameter,
  buildRe40IdentifyCommand,
  buildRe40InventoryCommands,
  buildRe40StartCommand,
  buildRe40StopCommand,
  createRe40Decoder,
  decodeRe40Ack,
  decodeRe40Firmware,
  decodeRe40Parameter,
  decodeRe40StopReason,
  decodeRe40Tag,
  RE40,
} from './rfidRe40';
import type { Re40Firmware, Re40Packet } from './rfidRe40';

export type Re40State = {
  phase: 'idle' | 'identifying' | 'ready' | 'starting' | 'inventory' | 'stopping' | 'error';
  message: string;
  firmware?: Re40Firmware;
};

type Callbacks = {
  send: (bytes: Uint8Array) => Promise<void>;
  onState: (state: Re40State) => void;
  onTag?: (tag: NonNullable<ReturnType<typeof decodeRe40Tag>>) => void;
  /** An incomplete exchange must retire the connection: this protocol has no request IDs. */
  onFault: (message: string) => void;
};

type Pending = {
  command: number;
  parameter?: number;
  sent: boolean;
  acknowledged: boolean;
  armed: boolean;
  value?: Uint8Array;
  deadline: number;
  timer: ReturnType<typeof setTimeout>;
  resolve: (value: Uint8Array | null) => void;
};
const RESPONSE_TIMEOUT_MS = 3000;
export const RE40_SCAN_MS = 5000;

/** Explicit identification and finite inventory; no commands on construction/reset. */
export function createRe40Session(callbacks: Callbacks) {
  const decoder = createRe40Decoder();
  let state: Re40State = { phase: 'idle', message: '' };
  let generation = 0;
  let pending: Pending | null = null;
  let scanTimer: ReturnType<typeof setTimeout> | null = null;
  let scanDeadline = 0;
  let tagCount = 0;
  let scanStarted = false;
  let stoppedMessage = '';

  function publish(next: Re40State) {
    state = next;
    callbacks.onState(next);
  }
  function clearPending(result: Uint8Array | null = null) {
    const previous = pending;
    pending = null;
    if (previous) {
      clearTimeout(previous.timer);
      previous.resolve(result);
    }
  }
  function clearScan() {
    if (scanTimer) clearTimeout(scanTimer);
    scanTimer = null;
    scanDeadline = 0;
    scanStarted = false;
  }
  function fail(message: string) {
    generation++;
    clearPending();
    clearScan();
    decoder.reset();
    publish({ phase: 'error', message });
    callbacks.onFault(message);
  }
  function complete() {
    if (!pending?.sent || !pending.acknowledged) return;
    if (pending.parameter !== undefined && !pending.value) return;
    clearPending(pending.value ?? new Uint8Array());
  }
  function accept(packet: Re40Packet) {
    // Only an explicit scan displays tag events; a passive connection isn't an inventory.
    if (scanStarted) {
      const startAck = decodeRe40Ack(packet);
      if (startAck?.command === RE40.command.start && startAck.status !== 0) {
        fail(
          `The RE422 rejected inventory start (status ${startAck.status}). Reconnect before retrying.`,
        );
        return;
      }
      const tag =
        state.phase !== 'stopping' && performance.now() < scanDeadline
          ? decodeRe40Tag(packet)
          : null;
      if (tag) {
        tagCount++;
        callbacks.onTag?.(tag);
      }
      const reason = decodeRe40StopReason(packet);
      if (reason?.error) {
        fail(
          `${reason.message} Check the reader’s region and antenna configuration in its vendor utility.`,
        );
        return;
      }
      if (reason) {
        stoppedMessage = reason.message;
        if (state.phase === 'inventory') finishScan();
      }
    }
    if (!pending?.armed) return;
    if (performance.now() >= pending.deadline) {
      fail(
        'The RE422 response timed out. Check its baud rate and binary protocol mode, then reconnect.',
      );
      return;
    }
    const ack = decodeRe40Ack(packet);
    if (ack?.command === pending.command) {
      if (ack.status !== 0) {
        fail(
          `The RE422 rejected command 0x${pending.command.toString(16)} (status ${ack.status}). Reconnect before retrying.`,
        );
        return;
      }
      pending.acknowledged = true;
    }
    if (pending.parameter !== undefined) {
      const value = decodeRe40Parameter(packet, pending.parameter);
      // Firmware must have the exact documented shape, not just the parameter ID.
      if (value && (pending.parameter !== RE40.parameter.firmware || decodeRe40Firmware(packet)))
        pending.value = value;
    }
    complete();
  }
  function exchange(
    bytes: Uint8Array,
    command: number,
    parameter?: number,
    ackRequired = true,
  ): Promise<Uint8Array | null> {
    const token = generation;
    let request: Pending;
    const completion = new Promise<Uint8Array | null>((resolve) => {
      request = {
        command,
        parameter,
        sent: false,
        acknowledged: !ackRequired,
        armed: false,
        deadline: performance.now() + RESPONSE_TIMEOUT_MS,
        timer: setTimeout(() => {
          if (pending === request)
            fail(
              'No complete RE422 response within 3 seconds. Check its baud rate and binary protocol mode, then reconnect.',
            );
        }, RESPONSE_TIMEOUT_MS),
        resolve,
      };
      pending = request;
    });
    // Timeouts/cancellation remain effective even if a browser write never settles.
    Promise.resolve()
      .then(() => {
        if (token !== generation || pending !== request) return;
        decoder.reset();
        request.armed = true;
        if (command === RE40.command.start) {
          scanStarted = true;
          scanDeadline = performance.now() + RE40_SCAN_MS;
        }
        return callbacks.send(bytes);
      })
      .then(() => {
        if (token !== generation || pending !== request) return;
        if (performance.now() >= request.deadline) {
          fail('The RE422 command send timed out. Reconnect before retrying.');
          return;
        }
        request.sent = true;
        complete();
      })
      .catch((error: unknown) => {
        if (token === generation && pending === request)
          fail(error instanceof Error ? error.message : 'Could not send the RE422 command.');
      });
    return completion;
  }
  function finishScan() {
    clearScan();
    publish({
      phase: 'ready',
      firmware: state.firmware,
      message: `${stoppedMessage || 'Scan complete.'} ${tagCount ? `${tagCount} tag report${tagCount === 1 ? '' : 's'} received.` : 'No tags reported. Check that a compatible UHF tag is on the reader.'}`,
    });
  }
  async function stop() {
    if (state.phase !== 'inventory') return;
    const firmware = state.firmware;
    const token = generation;
    if (scanTimer) clearTimeout(scanTimer);
    scanTimer = null;
    publish({ phase: 'stopping', firmware, message: 'Stopping inventory…' });
    const response = await exchange(buildRe40StopCommand(), RE40.command.stop);
    if (response === null || token !== generation) return;
    finishScan();
  }

  return {
    get busy() {
      return pending !== null || state.phase === 'inventory';
    },
    get state() {
      return state;
    },
    async identify(): Promise<void> {
      if (pending || !['idle', 'ready'].includes(state.phase)) return;
      decoder.reset();
      const token = ++generation;
      publish({ phase: 'identifying', message: 'Reading RE40 firmware information…' });
      const value = await exchange(
        buildRe40IdentifyCommand(),
        RE40.command.get,
        RE40.parameter.firmware,
      );
      if (!value || token !== generation) return;
      const firmware = decodeRe40Firmware({
        type: RE40.response.get,
        payload: Uint8Array.of(0, 1, ...value),
      });
      if (!firmware) {
        fail('Invalid RE40 firmware response. Reconnect before retrying.');
        return;
      }
      publish({
        phase: 'ready',
        firmware,
        message: `RE40 binary reader identified. Firmware ${firmware.version}.`,
      });
    },
    async scan(): Promise<void> {
      if (pending || state.phase !== 'ready' || !state.firmware) return;
      const firmware = state.firmware;
      const token = ++generation;
      tagCount = 0;
      stoppedMessage = '';
      publish({ phase: 'starting', firmware, message: 'Preparing a 5-second inventory scan…' });
      if (
        (await exchange(buildRe40StopCommand(), RE40.command.stop)) === null ||
        token !== generation
      )
        return;
      const olio = await exchange(buildRe40GetParameter(0x0401), RE40.command.get, 0x0401);
      if (!olio || token !== generation) return;
      let commands: Uint8Array[];
      try {
        commands = buildRe40InventoryCommands(olio, RE40_SCAN_MS);
      } catch (error) {
        fail(
          error instanceof Error
            ? error.message
            : 'The RE422 inventory configuration is unsupported.',
        );
        return;
      }
      for (const command of commands) {
        if ((await exchange(command, RE40.command.set)) === null || token !== generation) return;
      }
      // Verify the operation, antenna binding and finite stop configuration before RF starts.
      for (const parameter of [0x0201, 0x0401, 0x0005]) {
        const command = commands.find((bytes) => ((bytes[6] << 8) | bytes[7]) === parameter);
        if (!command) {
          fail('The RE422 scan configuration is incomplete.');
          return;
        }
        const expected = command.slice(8, -2);
        const actual = await exchange(
          buildRe40GetParameter(parameter),
          RE40.command.get,
          parameter,
        );
        if (!actual || token !== generation) return;
        if (actual.length !== expected.length || actual.some((byte, i) => byte !== expected[i])) {
          fail(
            `The RE422 did not confirm inventory setting 0x${parameter.toString(16)}. Scanning was not started.`,
          );
          return;
        }
      }
      // The reader's own 5s timer is the primary bound. The host sends STOP as well.
      // The SDK does not wait for START ACK; firmware may reply only with tag/stop events.
      if (
        (await exchange(buildRe40StartCommand(), RE40.command.start, undefined, false)) === null ||
        token !== generation
      )
        return;
      if (stoppedMessage) {
        finishScan();
        return;
      }
      publish({
        phase: 'inventory',
        firmware,
        message: '5-second scan requested. Waiting for UHF tag reports…',
      });
      scanTimer = setTimeout(
        () => {
          void stop();
        },
        Math.max(0, scanDeadline - performance.now()),
      );
    },
    stop,
    receive(bytes: Uint8Array) {
      if (!pending && state.phase !== 'inventory') return;
      // Background timer throttling must not extend the host's scan window.
      if (state.phase === 'inventory' && performance.now() >= scanDeadline) void stop();
      for (const packet of decoder.push(bytes)) accept(packet);
    },
    reset() {
      generation++;
      clearPending();
      clearScan();
      decoder.reset();
      publish({ phase: 'idle', message: '' });
    },
  };
}
