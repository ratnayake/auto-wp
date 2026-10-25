export class BackupError extends Error {
  override name = 'BackupError';
}
export class DiskSpaceError extends BackupError {
  override name = 'DiskSpaceError';
}
export class LockError extends BackupError {
  override name = 'LockError';
}
export class ExposureError extends BackupError {
  override name = 'ExposureError';
}
export class HashMismatchError extends BackupError {
  override name = 'HashMismatchError';
}
