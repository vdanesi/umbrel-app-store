# Devolutions Server 2026.3 — bozza di integrazione Umbrel

**Non installare ancora.** Questo ramo è una proposta tecnica, NON un pacchetto pronto
per utenti finali. Il manifesto Umbrel utilizza l'ID corretto `casa-devolutions-server`,
perché `umbrel-app-store.yml` identifica lo store con `id: casa`.

## Verificato
- Host Debian 13 x86_64; Docker 29.9.2, Compose v5.6.1
- RAM available: 6.5 GiB nel controllo eseguito dall'utente
- Immagine `devolutions/devolutions-server:release-2026.3` scaricata su amd64
- Porta applicativa interna 5000/tcp, HTTPS come default nell'immagine analizzata
- PostgreSQL 14+ supportato da DVLS 2026.3 in Docker (conferma Devolutions)

## Problemi bloccanti
1. **PostgreSQL**: su 2026.3.11.0 l'inizializzazione dello schema
   richiede temporaneamente `SUPERUSER` sull'utente DVLS. Revocare immediatamente
   usando `ALTER ROLE dvls_user NOSUPERUSER;`. Un'installazione one-click non
   deve lasciare l'utente applicativo con privilegi permanenti.
2. **Segreti**: niente password nel repository pubblico. Occorre un meccanismo
   Umbrel per creare/mantenere in modo sicuro credenziali PostgreSQL e di bootstrap.
3. **Cifratura**: montare App_Data persistente e conservare `encryption.config`
   in backup sicuro separato. Senza questa chiave il database cifrato non
   sarebbe recuperabile.
4. **Backup**: nel container DVLS mancano `pg_dump` e `pg_restore`.
   Pianificare dump dal container Postgres e test di restore, prima di usare dati reali.
5. **HTTPS**: definire certificato valido oppure proxy TLS, origine, hostname e
   accesso LAN; non esporre un gestore di credenziali senza protezioni.
6. **Upgrade**: evitare tag mobili e definire migrazione e rollback verificati.
7. **Test**: validazione manifesto Umbrel, inizializzazione, login, riavvio,
   revoca privilegi, backup/ripristino e accesso via Remote Desktop Manager.

## Fonti
- https://hub.docker.com/r/devolutions/devolutions-server
- https://forum.devolutions.net/topics/56997/dvls-20263-docker-image-databasetypepostgresql-found-in-the-binary-but
- https://github.com/getumbrel/umbrel-community-app-store

## Stato
Fase preparatoria: il `docker-compose.yml` è deliberatamente un **placeholder
non operativo** e non deve essere pubblicato sul ramo `main`.
