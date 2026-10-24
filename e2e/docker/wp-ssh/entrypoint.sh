#!/bin/bash
set -e
ssh-keygen -A
if [ -f /authorized_keys_src ]; then
  install -o cpuser -g cpuser -m 600 /authorized_keys_src /home/cpuser/.ssh/authorized_keys
fi
chmod 700 /home/cpuser/.ssh && chown cpuser:cpuser /home/cpuser/.ssh
mkdir -p /run/sshd
/usr/sbin/sshd
exec docker-entrypoint.sh "$@"
