FROM wordpress:php8.2-apache
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssh-server mariadb-client less zip unzip \
 && rm -rf /var/lib/apt/lists/*
COPY .cache/wp-cli/wp-cli.phar /usr/local/bin/wp
RUN chmod +x /usr/local/bin/wp \
 && useradd -m -u 1000 -s /bin/bash cpuser \
 && usermod -p '*' cpuser \
 && mkdir -p /run/sshd /home/cpuser/.ssh \
 && chown -R cpuser:cpuser /home/cpuser \
 && chown cpuser:cpuser /var/www/html
COPY docker/wp-ssh/sshd_config /etc/ssh/sshd_config.d/autowp.conf
COPY docker/wp-ssh/mysql-no-ssl.sh /usr/local/lib/autowp-mysql-no-ssl.sh
RUN chmod 755 /usr/local/lib/autowp-mysql-no-ssl.sh \
 && for b in mariadb mysql mariadb-dump mysqldump; do ln -s /usr/local/lib/autowp-mysql-no-ssl.sh "/usr/local/bin/$b"; done
COPY docker/wp-ssh/entrypoint.sh /usr/local/bin/autowp-entrypoint.sh
RUN chmod +x /usr/local/bin/autowp-entrypoint.sh
ENV APACHE_RUN_USER=cpuser APACHE_RUN_GROUP=cpuser
ENTRYPOINT ["autowp-entrypoint.sh"]
CMD ["apache2-foreground"]
