import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { SqlScanner, scanGzipSqlStream, scanSqlStream } from '../src/sql-scanner.js';
import { buildDump, gz } from './helpers.js';

function scan(sql: string, chunk = Number.POSITIVE_INFINITY) {
  const s = new SqlScanner();
  const buf = Buffer.from(sql, 'utf8');
  for (let i = 0; i < buf.length; i += Math.min(chunk, buf.length)) s.write(buf.subarray(i, i + chunk));
  const r = s.finish();
  return { ...r, rows: Object.fromEntries(r.rowsPerTable) };
}

/** Every input is also run split into 1-byte and 3-byte chunks; results must match. */
function all(sql: string) {
  const whole = scan(sql);
  expect(scan(sql, 1)).toEqual(whole);
  expect(scan(sql, 3)).toEqual(whole);
  return whole;
}

describe('SqlScanner', () => {
  it('counts rows in multi-row INSERTs and finds CREATE TABLEs', () => {
    const r = all(
      'CREATE TABLE `a` (id int);\nINSERT INTO `a` VALUES (1),(2),(3);\nINSERT INTO `a` VALUES (4);\n',
    );
    expect(r.createTables).toEqual(['a']);
    expect(r.rows).toEqual({ a: 4 });
  });

  it('handles column lists, IGNORE, REPLACE and schema-qualified names', () => {
    const r = all(
      [
        'INSERT INTO `t1` (`a`,`b`) VALUES (1,2),(3,4);',
        'INSERT IGNORE INTO `t2` VALUES (1);',
        'REPLACE INTO `t3` (`x`) VALUES (1),(2);',
        'INSERT LOW_PRIORITY IGNORE INTO `db`.`t4` VALUE (9);',
        'insert into plain_name values (1),(2);',
      ].join('\n'),
    );
    expect(r.rows).toEqual({ t1: 2, t2: 1, t3: 2, t4: 1, plain_name: 2 });
  });

  it('handles CREATE TABLE variants', () => {
    const r = all(
      'CREATE TABLE IF NOT EXISTS `a` (x int);CREATE TEMPORARY TABLE `b` (x int);create table c(x int);CREATE TABLE `d` LIKE `a`;CREATE TABLE `a` (x int);',
    );
    expect(r.createTables).toEqual(['a', 'b', 'c', 'd']);
  });

  it('is not fooled by ); and ),( inside strings', () => {
    const r = all("INSERT INTO `t` VALUES ('a);INSERT INTO `evil` VALUES (1);','b),(c'),(2,'x');");
    expect(r.rows).toEqual({ t: 2 });
    expect(r.createTables).toEqual([]);
  });

  it('handles backslash escapes and doubled quotes', () => {
    const r = all(
      "INSERT INTO `t` VALUES ('it\\'s'),('say ''hi'');x'),('back\\\\'),(\"dq \\\" ),(\"),(\"a\"\"b),(\");",
    );
    expect(r.rows).toEqual({ t: 5 });
  });

  it('handles doubled backticks in identifiers', () => {
    const r = all('CREATE TABLE `we``ird` (x int);INSERT INTO `we``ird` VALUES (1);');
    expect(r.createTables).toEqual(['we`ird']);
    expect(r.rows).toEqual({ 'we`ird': 1 });
  });

  it('skips all comment styles, including executable comments', () => {
    const r = all(
      [
        '-- INSERT INTO `c1` VALUES (1);',
        '# INSERT INTO `c2` VALUES (1);',
        '/* INSERT INTO `c3` VALUES (1); */',
        '/*!40101 SET NAMES utf8mb4 */;',
        '/*!40000 ALTER TABLE `x` DISABLE KEYS */;',
        '/* multi',
        'line ** / INSERT INTO `c4` VALUES (1); */',
        'INSERT INTO `real` VALUES (1) /* trailing ), ( */, (2); -- done',
      ].join('\n'),
    );
    expect(r.rows).toEqual({ real: 2 });
  });

  it('treats -- without a following space as arithmetic, not a comment', () => {
    const r = all('INSERT INTO `t` VALUES (1--1),(2);');
    expect(r.rows).toEqual({ t: 2 });
  });

  it('handles hex, _binary, X literals and NULL', () => {
    const r = all("INSERT INTO `t` VALUES (0x28292C3B,_binary 'a);(',X'2829',NULL),(NULL,0x),(1.5e-3,-2);");
    expect(r.rows).toEqual({ t: 3 });
  });

  it('does not count ON DUPLICATE KEY UPDATE VALUES(col) as a tuple', () => {
    const r = all('INSERT INTO `t` (a,b) VALUES (1,2),(3,4) ON DUPLICATE KEY UPDATE b=VALUES(b);');
    expect(r.rows).toEqual({ t: 2 });
  });

  it('ignores INSERT ... SELECT and nested parens inside tuples', () => {
    const r = all('INSERT INTO `a` SELECT * FROM `b`; INSERT INTO `t` VALUES (f(1,(2)),3),((4));');
    expect(r.rows).toEqual({ t: 2 });
  });

  it('detects the terminator only as the last significant content', () => {
    expect(all('SELECT 1;\n-- Dump completed on 2026-01-01 00:00:00\n').terminator).toBe(true);
    expect(all('SELECT 1;\n-- Dump completed on 2026-01-01 00:00:00').terminator).toBe(true);
    expect(all('SELECT 1;\n').terminator).toBe(false);
    expect(all('-- Dump completed\nSELECT 1;\n').terminator).toBe(false);
    expect(all("INSERT INTO t VALUES ('-- Dump completed');").terminator).toBe(false);
    expect(all('/* -- Dump completed */').terminator).toBe(false);
  });

  it('flags truncation mid-INSERT, mid-string and mid-comment', () => {
    expect(all('INSERT INTO `t` VALUES (1),(2').truncated).toBe(true);
    expect(all("INSERT INTO `t` VALUES (1,'abc").truncated).toBe(true);
    expect(all('CREATE TABLE `t` (x int').truncated).toBe(true);
    expect(all('SELECT 1; /* open').truncated).toBe(true);
    const done = all('SELECT 1;\n-- Dump completed\n');
    expect(done.truncated).toBe(false);
  });

  it('keeps tokens intact across chunk boundaries inside every position', () => {
    const sql = buildDump([{ name: 'wp_posts', rows: 25 }]);
    const whole = scan(sql);
    for (let size = 1; size < 40; size++) expect(scan(sql, size)).toEqual(whole);
    expect(whole.rows).toEqual({ wp_posts: 25 });
  });

  it('decodes multi-byte table names split across chunks', () => {
    const r = all('CREATE TABLE `tëst_表` (x int);INSERT INTO `tëst_表` VALUES (1);');
    expect(r.createTables).toEqual(['tëst_表']);
    expect(r.rows).toEqual({ tëst_表: 1 });
  });

  it('honours DELIMITER directives so routine bodies are not parsed as statements', () => {
    const r = all(
      [
        'DELIMITER ;;',
        'CREATE PROCEDURE p() BEGIN',
        '  INSERT INTO `inner_t` VALUES (1);',
        '  CREATE TABLE `inner_c` (x int);',
        'END ;;',
        'DELIMITER ;',
        'INSERT INTO `after` VALUES (1),(2);',
      ].join('\n'),
    );
    expect(r.rows).toEqual({ after: 2 });
    expect(r.createTables).toEqual([]);
  });

  it('streams multi-MB input without buffering: 60k rows across 3 tables', async () => {
    const big = buildDump(
      [
        { name: 'wp_posts', rows: 50_000 },
        { name: 'wp_postmeta', rows: 20_000 },
        { name: 'wp_options', rows: 10_000 },
      ],
      { rowsPerInsert: 500 },
    );
    expect(big.length).toBeGreaterThan(1_500_000);
    const gzipped = gz(big);
    const stream = Readable.from(
      (function* () {
        for (let i = 0; i < gzipped.length; i += 4096) yield gzipped.subarray(i, i + 4096);
      })(),
    );
    const heapBefore = process.memoryUsage().heapUsed;
    const r = await scanGzipSqlStream(stream);
    expect(process.memoryUsage().heapUsed - heapBefore).toBeLessThan(big.length * 4);
    expect(Object.fromEntries(r.rowsPerTable)).toEqual({
      wp_posts: 50_000,
      wp_postmeta: 20_000,
      wp_options: 10_000,
    });
    expect(r.createTables).toEqual(['wp_posts', 'wp_postmeta', 'wp_options']);
    expect(r.terminator).toBe(true);
    expect(r.truncated).toBe(false);
  });

  it('scans a plain stream and rejects corrupt gzip', async () => {
    const r = await scanSqlStream(Readable.from([Buffer.from('INSERT INTO t VALUES (1);')]));
    expect(r.rowsPerTable.get('t')).toBe(1);
    const bad = gz(buildDump([{ name: 't', rows: 100 }]));
    bad[Math.floor(bad.length / 2)] = (bad[Math.floor(bad.length / 2)] ?? 0) ^ 0xff;
    await expect(scanGzipSqlStream(Readable.from([bad]))).rejects.toThrow();
    await expect(scanGzipSqlStream(Readable.from([bad.subarray(0, bad.length - 20)]))).rejects.toThrow();
  });
});
