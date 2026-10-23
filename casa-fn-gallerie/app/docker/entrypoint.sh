#!/bin/sh
# FN Avanzamento Gallerie: la cartella dati (volume) deve essere scrivibile da Apache/PHP
set -e
mkdir -p /var/www/html/data
chown -R www-data:www-data /var/www/html/data
exec "$@"
