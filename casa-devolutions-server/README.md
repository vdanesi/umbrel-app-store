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

## Accesso concordato (7 novembre 2026)
- Nome pubblico Cloudflare Tunnel: `devolutions.dvso.net` (route creata dall'utente, non ancora collaudata).
- Porta interna HTTPS DVLS: `5000/tcp` (confermata dall'immagine).
- Porta host proposta: `5000`, soggetta a nuova verifica conflitti prima del deploy.
- LAN: HTTPS su IP/hostname Umbrel, con certificato valido per il nome utilizzato.
- Cloudflare: usare un hostname di origine raggiungibile dal container cloudflared; `localhost` non identifica Umbrel dall'interno del container.
- Non impostare `No TLS Verify` in modo permanente. Definire certificato origine e trust, e verificare l'interoperabilità Cloudflare Access / Remote Desktop Manager.
- Non attivare pubblicamente il tunnel prima del bootstrap amministratore, del controllo accessi e del test backup.

## Origine Cloudflare confermata dall'utente
- URL configurato nel tunnel: `https://192.168.3.110:5000`.
- IP host Umbrel: `192.168.3.110`.
- Verificare la raggiungibilità dal container cloudflared e il certificato TLS (IP SAN oppure originServerName/CA adeguati).
- Non considerare attivo il servizio prima del deploy e della verifica della protezione Cloudflare Access.

## Cloudflare Access (screenshot utente, 7 novembre 2026)
- Applicazione self-hosted `devolutions`, destinazione `devolutions.dvso.net`.
- Policy visibile `Allow emails: 14/09/2026`; **presenza confermata, contenuto e precedenza non verificati**.
- Prima del deploy verificare la policy Include/Exclude/Require e testare con sessione privata, utente autorizzato e non autorizzato.
- Non assumere che una policy Access per browser sia compatibile con i client Remote Desktop Manager; verificare il flusso API prima di utilizzarlo in produzione.
