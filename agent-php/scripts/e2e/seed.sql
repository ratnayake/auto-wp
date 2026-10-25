SET SESSION max_recursive_iterations = 100000;
CREATE TABLE wp_options (
  option_id bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  option_name varchar(191) NOT NULL DEFAULT '',
  option_value longtext NOT NULL,
  autoload varchar(20) NOT NULL DEFAULT 'yes',
  PRIMARY KEY (option_id), UNIQUE KEY option_name (option_name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_520_ci;

CREATE TABLE bin_data (
  id int NOT NULL AUTO_INCREMENT,
  b varbinary(255) NULL,
  blobcol longblob NULL,
  bits bit(8) NULL,
  t text NULL,
  f double NULL,
  d decimal(20,6) NULL,
  ts timestamp NULL DEFAULT NULL,
  len int AS (LENGTH(t)) VIRTUAL,
  PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE rel (
  object_id bigint unsigned NOT NULL,
  term_id varbinary(16) NOT NULL,
  note varchar(50) NULL,
  PRIMARY KEY (object_id, term_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE nopk (a int NULL, s varchar(100) NULL) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE audit_count (n int NOT NULL) ENGINE=InnoDB;
INSERT INTO audit_count VALUES (0);

INSERT INTO wp_options (option_name, option_value) VALUES
 ('siteurl', 'http://example.test'),
 ('quotes', 'it''s "quoted" \\ back\\slash; semi-colon -- not a comment /* nor this */'),
 ('unicode', 'ünïcødé 🎉 日本語 Ω'),
 ('newlines', 'line1\nline2\r\n\ttab\0nul'),
 ('serialized', 'a:2:{s:3:"foo";s:3:"bar";i:0;b:1;}'),
 ('delimiter', 'DELIMITER ;; looks like a command');

INSERT INTO bin_data (b, blobcol, bits, t, f, d, ts) VALUES
 (0x00FF27225C0A0D1A, 0x89504E470D0A1A0A0000, b'10100101', NULL, 0.1, 12345678901234.123456, '2026-10-24 10:30:12'),
 ('', '', b'0', '', -1.7976931348623157e308, -0.000001, NULL),
 (NULL, NULL, NULL, 'plain', NULL, NULL, '1999-12-31 23:59:59');

-- 2500 more rows to exercise chunking (NativeDumper::CHUNK_ROWS = 1000).
INSERT INTO bin_data (b, blobcol, t, f)
WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < 2500)
SELECT UNHEX(SHA2(n, 256)), RANDOM_BYTES(1 + n % 200), CONCAT('row ', n, ' ''', CHAR(92), 'é'), n / 7 FROM seq;

INSERT INTO rel
WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < 1500)
SELECT n % 37, UNHEX(MD5(n)), IF(n % 5 = 0, NULL, CONCAT('n', n)) FROM seq;

INSERT INTO nopk VALUES (1, 'a'), (1, 'a'), (NULL, NULL), (2, 'dup''s');

CREATE VIEW v_opts AS SELECT option_name, LENGTH(option_value) AS l FROM wp_options;
CREATE TRIGGER trg_nopk AFTER INSERT ON nopk FOR EACH ROW UPDATE audit_count SET n = n + 1;
