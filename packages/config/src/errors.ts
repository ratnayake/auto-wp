export class ConfigError extends Error {
  override readonly name = 'ConfigError';
}

export class SecretStoreError extends Error {
  override readonly name = 'SecretStoreError';
}

interface ZodLikeIssue {
  path: ReadonlyArray<PropertyKey>;
  message: string;
}

/** Renders schema issues as `sites[0].transport.host: <message>` lines. */
export function formatIssues(issues: ReadonlyArray<ZodLikeIssue>): string {
  return issues
    .map((issue) => {
      let where = '';
      for (const seg of issue.path) {
        if (typeof seg === 'number') where += `[${seg}]`;
        else where += where === '' ? String(seg) : `.${String(seg)}`;
      }
      return `  - ${where || '(root)'}: ${issue.message}`;
    })
    .join('\n');
}

export function errorCode(err: unknown): string | undefined {
  return typeof err === 'object' && err !== null && 'code' in err && typeof err.code === 'string'
    ? err.code
    : undefined;
}

/** First line of an error message, so parser snippets (which may echo file content) stay short. */
export function firstLine(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.split('\n')[0] ?? '';
}
