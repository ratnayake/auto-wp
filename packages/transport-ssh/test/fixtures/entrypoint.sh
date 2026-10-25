#!/bin/sh
echo "$AUTHORIZED_KEY" > /home/tester/.ssh/authorized_keys
chown tester:tester /home/tester/.ssh/authorized_keys
chmod 600 /home/tester/.ssh/authorized_keys
exec /usr/sbin/sshd -D -e
