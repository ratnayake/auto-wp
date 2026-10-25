import { randomBytes } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { type AppConfig, AppConfigSchema, type Logger } from '@auto-wp/contracts';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import pino from 'pino';
import { BearerAuthenticator, parseTokenEntries, sha256Hex } from './auth.js';
import { startHttpServer } from './http.js';
import { buildServer } from './server.js';
import { createServices } from './wire.js';

const USAGE = `auto-wp-mcp [--stdio | --http] [options]

  --stdio                 Serve MCP over stdin/stdout (default)
  --http                  Serve MCP over Streamable HTTP
  --host <addr>           HTTP bind address (default 127.0.0.1)
  --port <n>              HTTP port (default 8787)
  --allow-remote          Permit a non-loopback bind (only behind a TLS reverse proxy)
  --allowed-host <name>   Extra accepted Host header, e.g. mcp.example.com (repeatable)
  --allowed-origin <url>  Extra accepted Origin (repeatable)
  --trust-proxy <ip>      Proxy peer IP whose X-Forwarded-For is trusted for failed-auth throttling (repeatable)
  --max-body-bytes <n>    HTTP request body limit (default 1048576)
  --rate-limit <n>        HTTP requests per minute per token (default 120)
  --config <file>         JSON AppConfig (default: $AUTOWP_CONFIG, else no sites)
  --log-level <level>     pino level (default info; $AUTOWP_LOG_LEVEL)
  --gen-token <id>        Print a new token and its AUTOWP_MCP_TOKENS entry, then exit

Environment: AUTOWP_MCP_TOKENS="id:<sha256 hex of token>,..."  (HTTP bearer tokens)
Logs go to stderr only.`;

function makeLogger(level: string): Logger {
  return pino(
    { level, redact: ['token', 'authorization', '*.token', '*.authorization'] },
    pino.destination(2),
  );
}

async function loadConfig(path: string | undefined): Promise<AppConfig> {
  if (!path) return AppConfigSchema.parse({ sites: [] });
  return AppConfigSchema.parse(JSON.parse(await readFile(path, 'utf8')));
}

export async function main(argv: string[]): Promise<void> {
  const { values: v } = parseArgs({
    args: argv,
    options: {
      stdio: { type: 'boolean' },
      http: { type: 'boolean' },
      host: { type: 'string', default: '127.0.0.1' },
      port: { type: 'string', default: '8787' },
      'allow-remote': { type: 'boolean' },
      'allowed-host': { type: 'string', multiple: true },
      'allowed-origin': { type: 'string', multiple: true },
      'trust-proxy': { type: 'string', multiple: true },
      'max-body-bytes': { type: 'string' },
      'rate-limit': { type: 'string' },
      config: { type: 'string' },
      'log-level': { type: 'string' },
      'gen-token': { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (v.help) {
    process.stderr.write(`${USAGE}\n`);
    return;
  }
  if (v['gen-token']) {
    const token = `awp_${randomBytes(32).toString('base64url')}`;
    // Deliberate stdout: a one-shot CLI helper, never run while serving.
    process.stdout.write(
      `token (give to the client, shown once): ${token}\nAUTOWP_MCP_TOKENS entry: ${v['gen-token']}:${sha256Hex(token)}\n`,
    );
    return;
  }
  if (v.stdio && v.http) throw new Error('choose either --stdio or --http');

  const logger = makeLogger(v['log-level'] ?? process.env.AUTOWP_LOG_LEVEL ?? 'info');
  const config = await loadConfig(v.config ?? process.env.AUTOWP_CONFIG);
  const services = createServices(config, { logger });
  logger.error(
    'WARNING: FAKE SERVICES IN USE. wire.ts has not been integrated with the real packages: nothing reaches a real site, backups/verification are stubs, and the audit log is in memory only. Do not use in production.',
  );

  if (v.http) {
    const entries = parseTokenEntries(process.env.AUTOWP_MCP_TOKENS ?? '');
    if (entries.length === 0)
      throw new Error('AUTOWP_MCP_TOKENS is empty; refusing to serve HTTP without tokens');
    const num = (name: string, s: string | undefined) => {
      if (s === undefined) return undefined;
      const n = Number(s);
      if (!Number.isInteger(n) || n <= 0) throw new Error(`--${name} must be a positive integer`);
      return n;
    };
    const http = await startHttpServer({
      services,
      authenticator: new BearerAuthenticator(entries),
      host: v.host,
      port: num('port', v.port),
      allowRemote: v['allow-remote'],
      allowedHosts: v['allowed-host'],
      allowedOrigins: v['allowed-origin'],
      trustProxy: v['trust-proxy'],
      maxBodyBytes: num('max-body-bytes', v['max-body-bytes']),
      rateLimitPerMinute: num('rate-limit', v['rate-limit']),
    });
    logger.info({ url: http.url }, 'MCP Streamable HTTP listening');
    const stop = () => {
      const force = setTimeout(() => process.exit(1), 30_000);
      force.unref();
      http
        .close()
        .catch((err) => logger.error({ err: String(err) }, 'shutdown error'))
        .finally(() => process.exit(0));
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    return;
  }

  const server = buildServer({ ...services, defaultActor: 'stdio' });
  await server.connect(new StdioServerTransport());
  logger.info('MCP stdio server ready');
}

// `tsx src/main.ts` runs directly; the bin wrapper imports main() instead.
const entry = process.argv[1];
if (entry && realpathSync(entry) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((err) => {
    process.stderr.write(`auto-wp-mcp: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
