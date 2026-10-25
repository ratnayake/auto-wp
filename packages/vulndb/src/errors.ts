export class QuotaExceededError extends Error {
  override readonly name = 'QuotaExceededError';
  constructor(message = 'WPScan daily API quota exhausted') {
    super(message);
  }
}

export class ProviderNotConfiguredError extends Error {
  override readonly name = 'ProviderNotConfiguredError';
}
