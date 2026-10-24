<?php
// E2E: dump database `src` with the agent (native, sliced across fresh connections like separate web
// requests; and via mysqldump when available), import into fresh databases and compare checksums and
// row counts. Usage: php db-roundtrip.php <workdir> <dbhost>
declare(strict_types=1);

require dirname(__DIR__, 2) . '/vendor/autoload.php';

use AutoWp\Agent\Actions\DumpJob;
use AutoWp\Agent\Actions\ImportJob;
use AutoWp\Agent\Config;
use AutoWp\Agent\Context;
use AutoWp\Agent\Db\Connector;
use AutoWp\Agent\Jobs\JobRunner;

[$_, $work, $host] = $argv;

function site(string $work, string $name, string $db, string $host, string $mode, bool $bin): Context
{
    $wp = "$work/$name";
    @mkdir($wp, 0755, true);
    file_put_contents("$wp/wp-config.php", "<?php\n// test\ndefine( 'DB_NAME', '$db' );\ndefine('DB_USER', 'wp');\n"
        . "define('DB_PASSWORD', \"pa'ss\\\\word\");\ndefine('DB_HOST', '$host');\n\$table_prefix = 'wp_';\n");
    $cfg = Config::fromArray(['siteId' => 's', 'wpRoot' => $wp, 'dataDir' => "$work/data-$name", 'sliceSeconds' => 2, 'useBinaries' => $bin]);
    return new Context($cfg, $mode, 'time', "$wp/auto-wp-agent/agent.php");
}

/** Runs a job slice by slice, each slice with a new Context (new DB connection) and zero budget. */
function sliced(callable $mkCtx, string $cls, array $params): array
{
    $ctx = $mkCtx();
    $h = new $cls();
    $state = $h->init($params, $ctx);
    for ($i = 1; ; $i++) {
        $state = JobRunner::unwrap(json_decode(json_encode(JobRunner::wrap($state)), true));
        $ctx = $mkCtx();
        $h = new $cls();
        $r = $h->step($state, $ctx, microtime(true));
        if ($r !== null) {
            return [$r, $i];
        }
    }
}

function fingerprint(Context $ctx): array
{
    $db = $ctx->db();
    $out = [];
    foreach (AutoWp\Agent\Actions\DbInfo::baseTables($db) as $t) {
        $cs = $db->fetchAll('CHECKSUM TABLE `' . $t . '`');
        $out[$t] = ['rows' => AutoWp\Agent\Actions\DbInfo::count($db, $t), 'checksum' => $cs[0]['Checksum']];
    }
    $out['__views'] = array_map(fn ($r) => reset($r), $db->fetchAll("SHOW FULL TABLES WHERE Table_type = 'VIEW'"));
    $out['__triggers'] = array_column($db->fetchAll('SHOW TRIGGERS'), 'Trigger');
    return $out;
}

function check(bool $c, string $msg): void
{
    if (!$c) {
        fwrite(STDERR, "FAIL: $msg\n");
        exit(1);
    }
    echo "ok: $msg\n";
}

$src = site($work, 'src', 'src', $host, Context::MODE_WEB, false);
$expect = fingerprint($src);
echo 'driver: ' . $src->db()->driver() . "\n";

// 1. Native dump, sliced like web requests.
[$dump, $slices] = sliced(fn () => site($work, 'src', 'src', $host, Context::MODE_WEB, false), DumpJob::class, ['dest' => 'auto-wp-backup/db.sql.gz', 'excludeTables' => []]);
check($dump['method'] === 'native', 'native method');
check($slices > 3, "native dump took $slices slices");
$file = "$work/src/auto-wp-backup/db.sql.gz";
check(hash_file('sha256', $file) === $dump['sha256'], 'sha256 matches');
$sql = (string) file_get_contents('compress.zlib://' . $file);
check(preg_match('/-- Dump completed \d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ\n$/', $sql) === 1, 'dump ends with "-- Dump completed <ISO8601>"');
$counts = array_column($dump['tables'], 'rows', 'name');
foreach ($expect as $t => $fp) {
    if ($t[0] !== '_') {
        check(($counts[$t] ?? -1) === $fp['rows'], "row count $t = {$fp['rows']}");
    }
}

// 2. Import into a fresh DB, sliced.
$dst = site($work, 'dst', 'dst', $host, Context::MODE_WEB, false);
copy($file, "$work/dst/db.sql.gz");
[$imp, $islices] = sliced(fn () => site($work, 'dst', 'dst', $host, Context::MODE_WEB, false), ImportJob::class, ['source' => 'db.sql.gz']);
check($islices > 3, "import took $islices slices, {$imp['statements']} statements");
$got = fingerprint($dst);
if ($got != $expect) {
    echo json_encode(['expected' => $expect, 'got' => $got], JSON_PRETTY_PRINT), "\n";
}
check($got == $expect, 'native dump -> import: identical checksums, counts, views, triggers');

// 3. mysqldump path (CLI mode), when the binary exists; imported with the agent in one go (CLI).
$cli = site($work, 'src', 'src', $host, Context::MODE_CLI, true);
if ($cli->mayUseBinaries() && $cli->binaries->find('mysqldump') !== null) {
    $r = (new JobRunner($cli, ['db.dump' => new DumpJob()]))->start('db.dump', ['dest' => 'auto-wp-backup/md.sql.gz', 'excludeTables' => ['nopk']]);
    check($r['result']['method'] === 'mysqldump', 'mysqldump method');
    check(!in_array('nopk', array_column($r['result']['tables'], 'name'), true), 'excludeTables honoured');
    check(glob("$work/data-src/tmp/my-*") === [], 'defaults-extra-file removed');
    $sql2 = (string) file_get_contents("compress.zlib://$work/src/auto-wp-backup/md.sql.gz");
    check(substr(rtrim($sql2), -40) !== '' && preg_match('/-- Dump completed \S+Z\n$/', $sql2) === 1, 'mysqldump output ends with marker');
    check(strpos($sql2, "pa'ss") === false, 'no password in output');
    $dst2 = site($work, 'dst2', 'dst2', $host, Context::MODE_CLI, true);
    copy("$work/src/auto-wp-backup/md.sql.gz", "$work/dst2/md.sql.gz");
    $i2 = (new JobRunner($dst2, ['db.import' => new ImportJob()]))->start('db.import', ['source' => 'md.sql.gz']);
    $fp2 = fingerprint($dst2);
    $exp2 = $expect;
    unset($exp2['nopk']);
    $exp2['__triggers'] = [];
    check($fp2 == $exp2, 'mysqldump -> import: identical checksums and counts (' . $i2['result']['statements'] . ' statements)');
} else {
    echo "skip: mysqldump not available in this image\n";
}
echo "ALL OK\n";
