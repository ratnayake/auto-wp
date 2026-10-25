export class HostKeyMismatchError extends Error {
  override name = 'HostKeyMismatchError';
  constructor(
    readonly host: string,
    readonly expected: string,
    readonly actual: string,
  ) {
    super(
      `Host key mismatch for ${host}: expected ${expected} but the server presented ${actual}. Refusing to connect.`,
    );
  }
}

export class ExecTimeoutError extends Error {
  override name = 'ExecTimeoutError';
  constructor(readonly timeoutMs: number) {
    super(`remote command timed out after ${timeoutMs} ms and its channel was closed`);
  }
}

export class SshConnectError extends Error {
  override name = 'SshConnectError';
}
