const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/;

/** POSIX single-quote escaping: safe for any string without NUL bytes. */
export function shellQuote(s: string): string {
  if (s.includes('\0')) throw new Error('argument contains a NUL byte');
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export interface BuildCommandOptions {
  cwd?: string;
  env?: Record<string, string>;
}

/** Builds `[cd 'dir' && ][A='x' ]exec 'argv0' 'argv1'...`. Every element is quoted; callers never pass shell text. */
export function buildCommand(argv: readonly string[], o: BuildCommandOptions = {}): string {
  if (argv.length === 0) throw new Error('exec: argv must not be empty');
  const parts: string[] = [];
  if (o.cwd !== undefined) parts.push(`cd ${shellQuote(o.cwd)} &&`);
  for (const [name, value] of Object.entries(o.env ?? {})) {
    if (!ENV_NAME.test(name)) throw new Error(`exec: invalid environment variable name: ${name}`);
    parts.push(`${name}=${shellQuote(value)}`);
  }
  parts.push('exec', ...argv.map(shellQuote));
  return parts.join(' ');
}
