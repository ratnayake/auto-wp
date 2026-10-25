#!/bin/sh
# The MariaDB 11 client requires TLS by default; the e2e MariaDB 10.11 server has none, and WP-CLI runs the
# client with --no-defaults (so a my.cnf cannot turn it off). Insert --skip-ssl, keeping a leading
# --no-defaults / --defaults-* option first as the client requires.
real="/usr/bin/$(basename "$0")"
case "$1" in
  --no-defaults | --defaults-file=* | --defaults-extra-file=* | --defaults-group-suffix=* | --print-defaults)
    first=$1
    shift
    exec "$real" "$first" --skip-ssl "$@"
    ;;
esac
exec "$real" --skip-ssl "$@"
