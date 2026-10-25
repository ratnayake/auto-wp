export const BACKUP_ID_RE = /^\d{8}T\d{6}Z-[0-9a-f]{6}$/;

export const BACKUP_EXCLUDES: readonly string[] = [
  'auto-wp-backup',
  'auto-wp-agent/.data',
  'wp-content/cache',
  'wp-content/updraft',
  'wp-content/ai1wm-backups',
  'wp-content/backups-dup-lite',
  'wp-content/uploads/backup*',
  '*.log',
];

export const DB_FILE = 'db.sql.gz';
export const FILES_FILE = 'files.tar.gz';
export const MANIFEST_FILE = 'manifest.json';
export const SIG_FILE = 'manifest.json.sig';
export const CANARY_FILE = 'canary.txt';

export const FETCH_TIMEOUT_MS = 15_000;
/** Remote lock lifetime: must outlast the slowest steps (each exec is capped at 3h; dump + tar + margin). */
export const EXEC_TIMEOUT_MS = 3 * 3600_000;
export const LOCK_TTL_SEC = 8 * 3600;

/** Needed free space as a multiple of the estimated backup size. */
export const DISK_SAFETY_FACTOR = 1.2;
/** Rough uncompressed bytes per DB row, used only for the free-space estimate. */
export const EST_BYTES_PER_ROW = 256;

export const HTACCESS = `# auto-wp: backups must never be served over HTTP
Options -Indexes
<IfModule mod_authz_core.c>
  Require all denied
</IfModule>
<IfModule !mod_authz_core.c>
  <IfModule mod_access_compat.c>
    Order deny,allow
    Deny from all
  </IfModule>
</IfModule>
`;

export const INDEX_PHP = `<?php
http_response_code(403);
header('Content-Type: text/plain');
exit('Forbidden');
`;

export const WEB_CONFIG = `<?xml version="1.0" encoding="UTF-8"?>
<configuration>
  <system.webServer>
    <security>
      <authorization>
        <remove users="*" roles="" verbs="" />
        <add accessType="Deny" users="*" />
      </authorization>
    </security>
    <directoryBrowse enabled="false" />
  </system.webServer>
</configuration>
`;

/**
 * Fixed scripts: all variable parts are positional parameters, never interpolated. The terminator is
 * appended inside the pipe so that it ends up in the gzip stream; a failing dump exits non-zero.
 * $1 = wp binary, $2 = wp root, $3 = dest, $4 = ISO timestamp.
 */
export const WPCLI_DUMP_SCRIPT =
  'set -o pipefail; { "$1" db export - --path="$2" --single-transaction --skip-plugins --skip-themes || exit 1; ' +
  'printf \'%s\\n\' "-- Dump completed $4"; } | gzip -c > "$3"';

/** $1 = mysqldump, $2 = defaults-extra-file, $3 = db name, $4 = dest, $5 = ISO timestamp. */
export const MYSQLDUMP_SCRIPT =
  'set -o pipefail; { "$1" --defaults-extra-file="$2" --single-transaction --quick --routines --triggers "$3" || exit 1; ' +
  'printf \'%s\\n\' "-- Dump completed $5"; } | gzip -c > "$4"';
