export class TransportSecurityError extends Error {
  override name = 'TransportSecurityError';
}

export function isLoopbackHost(hostname: string): boolean {
  const h = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (h === 'localhost' || h.endsWith('.localhost') || h === '::1') return true;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  return !!m && Number(m[1]) === 127 && m.slice(1).every((p) => Number(p) <= 255);
}

/** https only; plain http solely for loopback hosts and only when explicitly enabled. */
export function assertSecureEndpoint(endpoint: string, insecureHttpLoopback: boolean): URL {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new TransportSecurityError('invalid agent endpoint URL');
  }
  if (url.protocol === 'https:') return url;
  if (url.protocol === 'http:') {
    if (insecureHttpLoopback && isLoopbackHost(url.hostname)) return url;
    throw new TransportSecurityError(
      'refusing plain http for agent endpoint (https required; http allowed only for loopback with insecureHttpLoopback)',
    );
  }
  throw new TransportSecurityError(`unsupported agent endpoint protocol ${url.protocol}`);
}
