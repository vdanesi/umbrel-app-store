# FN Avanzamento Gallerie - immagine per Umbrel e CasaOS (PHP 8.3 + Apache)
# Contiene solo il programma: i dati del progetto (pacchetto dati, stato, utenti, documenti)
# stanno nel volume /var/www/html/data sul server.
FROM php:8.3-apache

COPY docker/apache-fn.conf /etc/apache2/conf-enabled/zz-fn.conf
COPY docker/php-fn.ini /usr/local/etc/php/conf.d/zz-fn.ini
COPY docker/entrypoint.sh /usr/local/bin/fn-entrypoint
COPY www/ /var/www/html/

RUN chmod 0755 /usr/local/bin/fn-entrypoint \
 && rm -f /var/www/html/data/.gitkeep \
 && mkdir -p /var/www/html/data \
 && chown -R root:root /var/www/html \
 && chown -R www-data:www-data /var/www/html/data

ENV FN_FORCE_HTTPS=0 \
    TZ=Europe/Rome

VOLUME ["/var/www/html/data"]
EXPOSE 80
ENTRYPOINT ["fn-entrypoint"]
CMD ["apache2-foreground"]
