// Generates test/fixtures/version-compare.json: expected version_compare() results from the local PHP CLI.
// Run with `pnpm -F @auto-wp/inventory gen:version-fixtures`. Output is deterministic for a given PHP build.
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, '..', 'test', 'fixtures', 'version-compare.json');

const pairs = [
  ['1.0', '1.0.0'],
  ['1.0.0', '1.0'],
  ['1.0', '1.0'],
  ['1.10', '1.9'],
  ['1.9', '1.10'],
  ['6.7', '6.6.2'],
  ['6.6.2', '6.7'],
  ['6.7.1', '6.7'],
  ['6.7', '6.7.1'],
  ['2.0', '1.9.9'],
  ['5.3.0-dev', '5.3.0'],
  ['5.3.0', '5.3.0-dev'],
  ['5.3.0-alpha', '5.3.0-beta'],
  ['5.3.0-beta', '5.3.0-RC1'],
  ['5.3.0RC1', '5.3.0rc1'],
  ['5.3.0rc1', '5.3.0'],
  ['5.3.0-rc2', '5.3.0-rc10'],
  ['8.0.0beta2', '8.0.0b3'],
  ['1.0a1', '1.0b1'],
  ['1.0b1', '1.0'],
  ['1.0pl1', '1.0'],
  ['1.0', '1.0pl1'],
  ['1.0p1', '1.0pl2'],
  ['1.0-p1', '1.0.1'],
  ['1.0.1', '1.0-p1'],
  ['1.0#', '1.0'],
  ['1.0', '1.0#'],
  ['1.0-1', '1.0.1'],
  ['1.0_1', '1.0-1'],
  ['1.0+build.5', '1.0'],
  ['1.0.0+build', '1.0.0.1'],
  ['a', '1'],
  ['1', 'a'],
  ['', '1.0'],
  ['1.0', ''],
  ['', ''],
  ['dev', 'alpha'],
  ['alpha', 'beta'],
  ['rc', 'pl'],
  ['pl', 'p'],
  ['1.0.a', '1.0'],
  ['1.0', '1.0.a'],
  ['1.0.b', '1.0.a'],
  ['1.0.z', '1.0.1'],
  ['3.2.1', '3.2.1.0.0'],
  ['3.2.1.0.0', '3.2.1'],
  ['10.4.3', '10.4.10'],
  ['0.9.9', '1.0'],
  ['1.2.3-4', '1.2.3.4'],
  ['7.4.33', '8.0.0'],
  ['8.4.21', '8.4.21'],
  ['2.0.0-RC.1', '2.0.0-RC.2'],
  ['2.0.0RC1', '2.0.0.RC.1'],
  ['2.5.1-beta-3', '2.5.1beta3'],
  ['v2', '2'],
  ['1.0.0.0', '1.0.0.0.0'],
  ['4.9.8', '4.9.8-pl1'],
  ['#1.0', '1.0'],
  ['1.0', '#1.0'],
  ['1.0.10-dev', '1.0.9'],
  ['0.0.1', '0.0.0.1'],
  ['11.0', '11.0-RC'],
  ['99999999999999999999', '99999999999999999998'],
  ['99999999999999999999', '1.0'],
];

const php = execFileSync('php', ['-r', 'echo PHP_VERSION;'], { encoding: 'utf8' }).trim();
const phpScript = `
$pairs = json_decode(stream_get_contents(STDIN), true);
$rows = [];
foreach ($pairs as [$a, $b]) {
  $rows[] = ['a' => $a, 'b' => $b, 'expected' => version_compare($a, $b)];
}
echo json_encode($rows, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
`;
const rows = JSON.parse(
  execFileSync('php', ['-r', phpScript], { input: JSON.stringify(pairs), encoding: 'utf8' }),
);

writeFileSync(
  out,
  `${JSON.stringify({ phpVersion: php, generatedBy: 'scripts/gen-version-fixtures.mjs', pairs: rows }, null, 2)}\n`,
);
console.log(`wrote ${rows.length} pairs (PHP ${php}) to ${out}`);
