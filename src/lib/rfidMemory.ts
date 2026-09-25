export type MemoryProfile = {
  readCommand: string;
  writeTemplate: string;
  readPrefix: string;
  valueBytes: number;
  writeAck: string;
  timeoutMs: number;
};

export type MemoryState = {
  phase: 'idle' | 'reading' | 'writing' | 'verifying' | 'read' | 'verified' | 'error';
  message: string;
  value?: Uint8Array;
};

export type MemoryCallbacks = {
  send: (bytes: Uint8Array) => Promise<void>;
  onState: (state: MemoryState) => void;
};

const MAX_COMMAND_BYTES = 4096;
const MAX_SIGNATURE_BYTES = 256;
const VALUE_MARKER = '{value}';

function checkWidth(valueBytes: number): void {
  if (!Number.isInteger(valueBytes) || valueBytes < 1 || valueBytes > 256) {
    throw new Error('Set the value width to a whole number from 1 to 256 bytes.');
  }
}

function parseHex(value: string, label: string, maximum: number, allowEmpty = false): Uint8Array {
  if (typeof value !== 'string') throw new Error(`Enter ${label} as complete hexadecimal bytes.`);
  const compact = value.replace(/\s/g, '');
  if (allowEmpty && !compact) return new Uint8Array();
  if (!compact || !/^[\da-f]+$/i.test(compact) || compact.length % 2 !== 0) {
    throw new Error(
      `Enter ${label} as complete hexadecimal bytes, for example AA 01. Do not include 0x or separators other than spaces.`,
    );
  }
  if (compact.length > maximum * 2)
    throw new Error(`Keep ${label} to ${maximum.toLocaleString('en-US')} bytes or fewer.`);
  return Uint8Array.from(compact.match(/.{2}/g)!, (pair) => parseInt(pair, 16));
}

function readConfiguration(profile: MemoryProfile) {
  checkWidth(profile.valueBytes);
  if (
    !Number.isInteger(profile.timeoutMs) ||
    profile.timeoutMs < 500 ||
    profile.timeoutMs > 10000
  ) {
    throw new Error('Set the response timeout to a whole number from 500 to 10,000 milliseconds.');
  }
  return {
    command: parseHex(profile.readCommand, 'the documented read command', MAX_COMMAND_BYTES),
    prefix: parseHex(
      profile.readPrefix,
      'the documented read response prefix',
      MAX_SIGNATURE_BYTES,
    ),
    width: profile.valueBytes,
    timeoutMs: profile.timeoutMs,
  };
}

export function encodeMemoryValue(
  value: string,
  format: 'text' | 'hex',
  valueBytes: number,
): Uint8Array {
  checkWidth(valueBytes);
  const bytes =
    format === 'text' ? new TextEncoder().encode(value) : parseHex(value, 'the value', 256);
  if (bytes.length !== valueBytes) {
    throw new Error(
      `The value must be exactly ${valueBytes} bytes; the entered ${format === 'text' ? 'UTF-8 text' : 'hex value'} contains ${bytes.length}. Values are never padded or truncated.`,
    );
  }
  return bytes;
}

/** Read-only profiles do not need a write command or acknowledgment. */
export function buildReadCommand(profile: MemoryProfile): Uint8Array {
  return readConfiguration(profile).command;
}

export function buildWriteCommand(profile: MemoryProfile, valueBytes: Uint8Array): Uint8Array {
  readConfiguration(profile);
  parseHex(profile.writeAck, 'the documented write acknowledgment', MAX_SIGNATURE_BYTES);
  if (!(valueBytes instanceof Uint8Array) || valueBytes.byteLength !== profile.valueBytes) {
    throw new Error(`The write value must contain exactly ${profile.valueBytes} bytes.`);
  }
  if (
    typeof profile.writeTemplate !== 'string' ||
    profile.writeTemplate.split(VALUE_MARKER).length !== 2
  ) {
    throw new Error(
      'Enter a documented write template containing exactly one {value} placeholder.',
    );
  }
  const [before, after] = profile.writeTemplate.split(VALUE_MARKER);
  const prefix = parseHex(before, 'the write template before {value}', MAX_COMMAND_BYTES, true);
  const suffix = parseHex(after, 'the write template after {value}', MAX_COMMAND_BYTES, true);
  if (prefix.length + valueBytes.length + suffix.length > MAX_COMMAND_BYTES) {
    throw new Error('Keep the complete write command to 4,096 bytes or fewer.');
  }
  const command = new Uint8Array(prefix.length + valueBytes.length + suffix.length);
  command.set(prefix);
  command.set(valueBytes, prefix.length);
  command.set(suffix, prefix.length + valueBytes.length);
  return command;
}

type ResponseMatcher = {
  armed: boolean;
  complete: boolean;
  push: (bytes: Uint8Array) => void;
  response: Promise<Uint8Array>;
};

/** A prefix matcher stores at most the configured signature and 256 payload bytes. */
function responseMatcher(prefix: Uint8Array, valueSize: number): ResponseMatcher {
  const failure = new Uint16Array(prefix.length);
  for (let index = 1, matched = 0; index < prefix.length; index++) {
    while (matched && prefix[index] !== prefix[matched]) matched = failure[matched - 1];
    if (prefix[index] === prefix[matched]) matched++;
    failure[index] = matched;
  }
  const value = new Uint8Array(valueSize);
  let prefixMatched = 0;
  let valueOffset = 0;
  let readingValue = false;
  let resolve!: (value: Uint8Array) => void;
  const response = new Promise<Uint8Array>((complete) => {
    resolve = complete;
  });
  const matcher: ResponseMatcher = {
    armed: false,
    complete: false,
    response,
    push(bytes) {
      if (!matcher.armed || matcher.complete) return;
      for (const byte of bytes) {
        if (readingValue) {
          value[valueOffset++] = byte;
          if (valueOffset !== valueSize) continue;
        } else {
          while (prefixMatched && byte !== prefix[prefixMatched])
            prefixMatched = failure[prefixMatched - 1];
          if (byte === prefix[prefixMatched]) prefixMatched++;
          if (prefixMatched !== prefix.length) continue;
          readingValue = true;
          if (valueSize) continue;
        }
        matcher.complete = true;
        matcher.armed = false;
        resolve(value.slice());
        // Never carry bytes after this response into the next command's matcher.
        return;
      }
    },
  };
  return matcher;
}

type Operation = {
  kind: 'read' | 'write';
  abort: AbortController;
  matcher: ResponseMatcher | null;
  expireIfOverdue?: () => boolean;
};

/**
 * Configurable fixed-prefix/fixed-width exchanges only. This is not a tag protocol decoder.
 * No defaults, retries, checksum guesses, background polling, or implicit writes are supplied.
 */
export function createMemorySession(callbacks: MemoryCallbacks) {
  let current: Operation | null = null;
  let lastState: MemoryState = {
    phase: 'idle',
    message: 'Configure your reader’s documented commands to begin.',
  };
  const active = (operation: Operation) => current === operation && !operation.abort.signal.aborted;

  function emit(state: MemoryState) {
    lastState = { ...state, ...(state.value ? { value: state.value.slice() } : {}) };
    callbacks.onState({
      ...lastState,
      ...(lastState.value ? { value: lastState.value.slice() } : {}),
    });
  }

  function finish(operation: Operation, state: MemoryState) {
    if (!active(operation)) return;
    current = null;
    operation.matcher = null;
    operation.expireIfOverdue = undefined;
    operation.abort.abort();
    emit(state);
  }

  function available(): boolean {
    if (!current) return true;
    emit({
      ...lastState,
      message: 'A tag operation is already in progress. Wait for it to finish or cancel it first.',
    });
    return false;
  }

  async function exchange(
    operation: Operation,
    command: Uint8Array,
    prefix: Uint8Array,
    width: number,
    timeoutMs: number,
    phase: 'reading' | 'writing' | 'verifying',
    message: string,
  ): Promise<Uint8Array> {
    if (!active(operation)) throw new DOMException('Tag operation cancelled.', 'AbortError');
    const deadline = performance.now() + timeoutMs;
    const matcher = responseMatcher(prefix, width);
    operation.matcher = matcher;
    let interrupt!: (error: Error) => void;
    const interrupted = new Promise<never>((_resolve, reject) => {
      interrupt = reject;
    });
    // A callback may synchronously cancel while the next phase is being announced.
    void interrupted.catch(() => {});
    const cancel = () => interrupt(new DOMException('Tag operation cancelled.', 'AbortError'));
    const timeoutError = new Error(
      `Timed out after ${timeoutMs.toLocaleString('en-US')} ms waiting for ${phase === 'writing' ? 'the configured write acknowledgment' : 'the configured read response'} and command delivery.`,
    );
    const expire = () => {
      matcher.armed = false;
      interrupt(timeoutError);
    };
    // Hidden pages may deliver timers late. The timer wakes an idle exchange, while
    // this monotonic deadline also rejects overdue input and send continuations.
    const expireIfOverdue = () => {
      if (performance.now() < deadline) return false;
      expire();
      return true;
    };
    operation.expireIfOverdue = expireIfOverdue;
    const timeout = setTimeout(expire, timeoutMs);
    operation.abort.signal.addEventListener('abort', cancel, { once: true });
    try {
      emit({ phase, message });
      if (!active(operation)) throw new DOMException('Tag operation cancelled.', 'AbortError');
      if (expireIfOverdue()) throw timeoutError;
      // No await separates arming and sending. Even a response emitted synchronously
      // inside send() belongs to this command, while older response leftovers cannot.
      matcher.armed = true;
      let sending: Promise<void>;
      try {
        sending = Promise.resolve(callbacks.send(command.slice()));
      } catch {
        throw new Error('The configured command could not be sent. Check the reader connection.');
      }
      const delivery = sending.then(
        () => {
          if (active(operation) && expireIfOverdue()) throw timeoutError;
        },
        () => {
          throw new Error('The configured command could not be sent. Check the reader connection.');
        },
      );
      const [, response] = await Promise.race([
        Promise.all([delivery, matcher.response]),
        interrupted,
      ]);
      if (!active(operation)) throw new DOMException('Tag operation cancelled.', 'AbortError');
      if (expireIfOverdue()) throw timeoutError;
      return response;
    } finally {
      clearTimeout(timeout);
      operation.abort.signal.removeEventListener('abort', cancel);
      matcher.armed = false;
      if (operation.matcher === matcher) operation.matcher = null;
      if (operation.expireIfOverdue === expireIfOverdue) operation.expireIfOverdue = undefined;
    }
  }

  async function read(profile: MemoryProfile): Promise<void> {
    if (!available()) return;
    let configuration: ReturnType<typeof readConfiguration>;
    try {
      configuration = readConfiguration({ ...profile });
    } catch (error) {
      emit({
        phase: 'error',
        message:
          error instanceof Error ? error.message : 'Configure a valid read command and response.',
      });
      return;
    }
    const operation: Operation = { kind: 'read', abort: new AbortController(), matcher: null };
    current = operation;
    try {
      const value = await exchange(
        operation,
        configuration.command,
        configuration.prefix,
        configuration.width,
        configuration.timeoutMs,
        'reading',
        'Sending the configured read command; waiting for a response.',
      );
      finish(operation, {
        phase: 'read',
        message: `Read ${configuration.width} bytes from the configured response.`,
        value,
      });
    } catch (error) {
      finish(operation, {
        phase: 'error',
        message: `Read failed. ${error instanceof Error ? error.message : 'Check the connection and command profile.'}`,
      });
    }
  }

  async function writeAndVerify(profile: MemoryProfile, valueBytes: Uint8Array): Promise<void> {
    if (!available()) return;
    let configuration: ReturnType<typeof readConfiguration>;
    let writeCommand: Uint8Array;
    let acknowledgment: Uint8Array;
    try {
      const snapshot = { ...profile };
      configuration = readConfiguration(snapshot);
      writeCommand = buildWriteCommand(snapshot, valueBytes);
      acknowledgment = parseHex(
        snapshot.writeAck,
        'the documented write acknowledgment',
        MAX_SIGNATURE_BYTES,
      );
    } catch (error) {
      emit({
        phase: 'error',
        message:
          error instanceof Error
            ? error.message
            : 'Configure valid read and write commands before writing.',
      });
      return;
    }
    const expected = valueBytes.slice();
    const operation: Operation = { kind: 'write', abort: new AbortController(), matcher: null };
    current = operation;
    try {
      await exchange(
        operation,
        writeCommand,
        acknowledgment,
        0,
        configuration.timeoutMs,
        'writing',
        'Sending the configured write command; waiting for its acknowledgment.',
      );
      const value = await exchange(
        operation,
        configuration.command,
        configuration.prefix,
        configuration.width,
        configuration.timeoutMs,
        'verifying',
        'Acknowledgment received. Sending a fresh read command to compare the value.',
      );
      const matches =
        value.length === expected.length && value.every((byte, index) => byte === expected[index]);
      finish(
        operation,
        matches
          ? {
              phase: 'verified',
              message: `Readback matches the ${expected.length} configured bytes.`,
              value,
            }
          : {
              phase: 'error',
              message:
                'Write result is unverified. The returned value does not match the requested bytes.',
              value,
            },
      );
    } catch (error) {
      finish(operation, {
        phase: 'error',
        message: `Write result is unverified. ${error instanceof Error ? error.message : 'Check the connection and command profile.'}`,
      });
    }
  }

  function receive(bytes: Uint8Array): void {
    if (!(bytes instanceof Uint8Array) || !bytes.byteLength || !current || !active(current)) return;
    if (current.expireIfOverdue?.()) return;
    current.matcher?.push(bytes);
  }

  function cancel(reason = 'Tag operation cancelled.'): void {
    const operation = current;
    if (!operation) return;
    current = null;
    if (operation.matcher) operation.matcher.armed = false;
    operation.matcher = null;
    operation.expireIfOverdue = undefined;
    operation.abort.abort();
    emit({
      phase: 'error',
      message: `${operation.kind === 'write' ? 'Write result is unverified. ' : ''}${reason}`,
    });
  }

  return {
    read,
    writeAndVerify,
    receive,
    cancel,
    get busy() {
      return current !== null;
    },
  };
}
