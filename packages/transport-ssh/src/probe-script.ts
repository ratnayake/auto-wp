/**
 * One POSIX sh script, run as `sh -c SCRIPT sh <php> <toolDir> <wpRoot>`. Prints `key=value` lines.
 */
export const PROBE_SCRIPT = `
php_bin=$(command -v "$1" 2>/dev/null)
echo "php_bin=$php_bin"
if [ -n "$php_bin" ]; then
  echo "php_version=$("$php_bin" -r 'echo PHP_VERSION;' 2>/dev/null)"
  echo "sodium=$("$php_bin" -r 'echo extension_loaded("sodium") ? 1 : 0;' 2>/dev/null)"
fi
wp=$(command -v wp 2>/dev/null)
if [ -n "$wp" ]; then
  echo "wp_path=$wp"
  echo "wp_version=$("$wp" --version 2>/dev/null | head -n 1)"
elif [ -f "$2/wp-cli.phar" ] && [ -n "$php_bin" ]; then
  v=$("$php_bin" "$2/wp-cli.phar" --version 2>/dev/null | head -n 1)
  if [ -n "$v" ]; then
    echo "wp_path=$2/wp-cli.phar"
    echo "wp_version=$v"
  fi
fi
for b in tar gzip mysqldump mysql find sha256sum; do
  p=$(command -v "$b" 2>/dev/null)
  [ -n "$p" ] && echo "bin_$b=$p"
done
echo "disk_free=$(df -Pk "$3" 2>/dev/null | awk 'NR==2 {print $4 * 1024}')"
d=$(dirname "$3")
[ -d "$d" ] && [ -w "$d" ] && echo "outside_parent=$d"
echo "docroot=$(cd "$3" 2>/dev/null && pwd -P)"
exit 0
`;

export interface ProbeScriptOutput {
  phpBin?: string;
  phpVersion?: string;
  sodium: boolean;
  wpPath?: string;
  wpVersion?: string;
  binaries: Record<string, string>;
  diskFreeBytes?: number;
  /** Writable parent of wpRoot; a dedicated subdirectory of it is used, never the parent itself. */
  outsideParent?: string;
  docroot?: string;
}

export function parseProbeOutput(out: string): ProbeScriptOutput {
  const kv = new Map<string, string>();
  for (const line of out.split('\n')) {
    const i = line.indexOf('=');
    if (i > 0) kv.set(line.slice(0, i), line.slice(i + 1).trim());
  }
  const get = (k: string) => kv.get(k) || undefined;
  const binaries: Record<string, string> = {};
  for (const [k, v] of kv) if (k.startsWith('bin_') && v) binaries[k.slice(4)] = v;
  const disk = Number(get('disk_free'));
  const wpVersion = get('wp_version')?.replace(/^WP-CLI\s+/i, '');
  return {
    phpBin: get('php_bin'),
    phpVersion: get('php_version'),
    sodium: get('sodium') === '1',
    wpPath: get('wp_path'),
    wpVersion,
    binaries,
    diskFreeBytes: Number.isFinite(disk) && disk >= 0 && get('disk_free') ? Math.floor(disk) : undefined,
    outsideParent: get('outside_parent'),
    docroot: get('docroot'),
  };
}
