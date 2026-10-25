export const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));
