FROM alpine:3.20
RUN apk add --no-cache openssh php83 php83-cli coreutils tar gzip \
 && ln -sf /usr/bin/php83 /usr/bin/php \
 && ssh-keygen -A \
 && adduser -D -s /bin/sh tester \
 && echo "tester:$(head -c 32 /dev/urandom | base64)" | chpasswd \
 && mkdir -p /home/tester/.ssh /home/tester/wp /home/tester/outside \
 && chown -R tester:tester /home/tester \
 && chmod 700 /home/tester/.ssh
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
EXPOSE 22
ENTRYPOINT ["/entrypoint.sh"]
