import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';

export const sha256 = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex');

function octal(n: number, len: number): string {
  return `${n.toString(8).padStart(len - 1, '0')}\0`;
}

/** Minimal ustar writer for fixtures. `dir` entries end in `/`. */
export function buildTar(
  entries: { name: string; data?: string; type?: string }[],
  endMarker = true,
): Buffer {
  const parts: Buffer[] = [];
  for (const e of entries) {
    const data = Buffer.from(e.data ?? '');
    const type = e.type ?? (e.name.endsWith('/') ? '5' : '0');
    const h = Buffer.alloc(512);
    h.write(e.name, 0, 100, 'utf8');
    h.write(octal(0o644, 8), 100);
    h.write(octal(0, 8), 108);
    h.write(octal(0, 8), 116);
    h.write(octal(type === '0' ? data.length : 0, 12), 124);
    h.write(octal(0, 12), 136);
    h.write('        ', 148);
    h.write(type, 156);
    h.write('ustar\0', 257);
    h.write('00', 263);
    let sum = 0;
    for (const b of h) sum += b;
    h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
    parts.push(h, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  if (endMarker) parts.push(Buffer.alloc(1024));
  return Buffer.concat(parts);
}

export interface DumpTable {
  name: string;
  rows: number;
}

const esc = (s: string): string => s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");

/** mysqldump-shaped SQL: header, CREATE TABLE, multi-row INSERTs with nasty strings, terminator. */
export function buildDump(
  tables: DumpTable[],
  o: { terminator?: boolean; rowsPerInsert?: number } = {},
): string {
  const per = o.rowsPerInsert ?? 3;
  let sql = '-- MySQL dump 10.13\n/*!40101 SET @OLD_SQL_MODE=@@SQL_MODE */;\n\n';
  for (const t of tables) {
    sql += `DROP TABLE IF EXISTS \`${t.name}\`;\nCREATE TABLE \`${t.name}\` (\n  \`id\` bigint NOT NULL,\n  \`v\` longtext COMMENT 'a; b (c)',\n  PRIMARY KEY (\`id\`)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;\n\n`;
    sql += `LOCK TABLES \`${t.name}\` WRITE;\n/*!40000 ALTER TABLE \`${t.name}\` DISABLE KEYS */;\n`;
    for (let i = 0; i < t.rows; i += per) {
      const tuples: string[] = [];
      for (let j = i; j < Math.min(t.rows, i + per); j++) {
        const v =
          j % 4 === 0 ? `it's ),( ${j}; -- not a comment` : j % 4 === 1 ? "back\\\\slash\\'" : 'plain';
        tuples.push(`(${j},'${j % 4 === 0 ? esc(v) : v}')`);
      }
      sql += `INSERT INTO \`${t.name}\` VALUES ${tuples.join(',')};\n`;
    }
    sql += `/*!40000 ALTER TABLE \`${t.name}\` ENABLE KEYS */;\nUNLOCK TABLES;\n\n`;
  }
  sql += '/*!40101 SET SQL_MODE=@OLD_SQL_MODE */;\n\n';
  if (o.terminator !== false) sql += '-- Dump completed on 2026-10-24 10:30:12\n';
  return sql;
}

export const gz = (s: string | Buffer): Buffer => gzipSync(s);
