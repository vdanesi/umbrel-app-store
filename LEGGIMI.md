# Scontrinaio per Umbrel

Questa cartella è un **app store personale per umbrelOS** con una sola app, Scontrinaio.
Una volta aggiunto a Umbrel, Scontrinaio si installa e si apre come le altre app.
Spese e foto sono salvate sull'Umbrel e le vedi da tutti i tuoi dispositivi.

```
umbrel-app-store.yml          ← nome dello store ("Casa")
casa-scontrinaio/
  umbrel-app.yml              ← scheda dell'app (nome, icona, porta 3958)
  docker-compose.yml          ← come Umbrel avvia l'app (immagine ufficiale node:20-alpine)
  app/server.js               ← piccolo server senza dipendenze
  app/public/                 ← l'app (pagina, icone, lettura scontrini)
  data/                       ← qui vengono salvati spese.json e le foto (resta vuota nel repository)
```

Non c'è niente da compilare. Umbrel scarica l'immagine standard di Node.js, che funziona sia su Umbrel Home (x86) sia su Raspberry Pi (ARM), e avvia `server.js` dalla cartella dell'app.

## 1. Metti la cartella su GitHub

1. Crea un account su https://github.com (se non ce l'hai).
2. Crea un nuovo repository **pubblico** chiamato `umbrel-app-store`.
   Umbrel deve poterlo scaricare senza credenziali. Nel repository c'è solo il codice dell'app, nessun tuo dato.
3. Carica tutto il contenuto di questa cartella: **Add file → Upload files**, trascinando `umbrel-app-store.yml`, `LEGGIMI.md` e la cartella `casa-scontrinaio`.
   Controlla che la cartella `casa-scontrinaio/data` contenga il file `.gitkeep`. Se il caricamento dal browser lo salta, crea il file a mano con **Add file → Create new file** e scrivi `casa-scontrinaio/data/.gitkeep`.
4. `casa-scontrinaio/umbrel-app.yml` è già impostato per l'account GitHub `vdanesi` (icona e link). Se usi un altro account, sostituisci `vdanesi` con il tuo nome utente.

## 2. Aggiungi lo store a Umbrel

1. Apri Umbrel nel browser (di solito http://umbrel.local).
2. Vai su **App Store**, poi sul menu **⋯** in alto a destra, poi **Community App Stores**.
3. Incolla l'indirizzo del repository, `https://github.com/vdanesi/umbrel-app-store`, e premi **Add**.
4. Apri **Casa App Store** e installa **Scontrinaio**.

L'app si apre dall'icona su Umbrel, oppure direttamente su **http://umbrel.local:3958**.

## Account e login

Scontrinaio ha account suoi, separati da quello di Umbrel. Ogni persona vede **solo le proprie spese e foto**.

Chi non ha fatto l'accesso vede solo la **pagina di accesso** (`http://umbrel.local:3958/accesso`), con le schede **Accedi** e **Registrati**. L'app vera si apre solo dopo l'accesso.

- **Primo avvio:** la pagina chiede di creare il primo account, che diventa l'**amministratore**. Crealo subito dopo l'installazione.
- **Registrazione:** chiunque apra Scontrinaio può crearsi un account dalla scheda **Registrati**, e ogni account vede solo le proprie spese.
  L'amministratore può chiudere le registrazioni da **Backup → Amministrazione → Consenti nuove registrazioni**. A registrazioni chiuse, la scheda Registrati spiega di chiedere all'amministratore.
  Link diretto alla registrazione: `http://umbrel.local:3958/accesso?modo=registrati`.
- **Password:** almeno 8 caratteri. Si cambia da **Backup → Account → Cambia password**. Dopo il cambio, gli altri dispositivi devono accedere di nuovo.
- **Accesso ricordato** per 30 giorni su ogni dispositivo. Il pulsante **Esci** chiude la sessione.
- **Protezione dai tentativi:** dopo 5 password sbagliate l'accesso per quel nome si blocca per 15 minuti.
- **Eliminare un account:** l'amministratore può eliminare un account da **Amministrazione**. Vengono cancellate anche le sue spese.
- **Aggiornamento dalla versione 1.0.0:** le spese già salvate passano al primo account creato.

Come sono protetti i dati:
- le password sono salvate cifrate con scrypt, mai in chiaro;
- il cookie di accesso non è leggibile dagli script della pagina;
- le modifiche sono accettate solo se partono dall'app stessa.

Dato che Scontrinaio ha il suo login, Umbrel non chiede anche la propria password: nel `docker-compose.yml` c'è `PROXY_AUTH_ADD: "false"`.
Se vuoi la doppia protezione (password di Umbrel più account di Scontrinaio), cancella quella riga e aggiorna l'app.

**Password dimenticata:** non c'è il recupero via email.
- Se si tratta di un altro utente, l'amministratore può eliminarne l'account e farlo registrare di nuovo. Così però si perdono le sue spese, quindi prima fategli esportare un backup, se riesce ancora ad accedere.
- Se l'amministratore ha perso la password, scrivimi e ti preparo una procedura di ripristino.

**Accesso solo in http:** su Umbrel l'app gira in `http://`, senza https. In casa va bene. Da fuori usa Tailscale, che cifra il collegamento: non esporre la porta 3958 su internet.

## 3. Sul telefono

- Collegati alla rete di casa e apri `http://umbrel.local:3958`. Se il telefono non riconosce `umbrel.local`, usa l'indirizzo IP dell'Umbrel, ad esempio `http://192.168.1.50:3958`.
- Aggiungi la pagina alla schermata Home: su iPhone **Condividi → Aggiungi alla schermata Home**, su Android **⋮ → Aggiungi a schermata Home**.
- **Fuori casa:** installa l'app **Tailscale** su Umbrel e sul telefono, poi apri `http://umbrel:3958` (o l'indirizzo Tailscale dell'Umbrel).

### Fotocamera
Umbrel serve le app in `http://` (senza https). Per questo il browser non permette la fotocamera dentro la pagina.
Il pulsante con la fotocamera apre quindi la **fotocamera del telefono**: scatti, confermi e la foto torna nell'app, che legge lo scontrino come prima.
Per le stesse ragioni l'app non funziona offline: serve il collegamento all'Umbrel.

## 4. Portare le spese dalla versione su Claude o dalla PWA

1. Nella versione su Claude premi **Backup**, oppure nella PWA **Backup → Esporta backup completo**.
2. In Scontrinaio su Umbrel: **Backup → Ripristina da backup** e scegli il file `.json`.

## 5. Backup

I dati sono in `~/umbrel/app-data/casa-scontrinaio/data/` sull'Umbrel:
- `utenti.json` contiene gli account, con le password cifrate;
- `utenti/<id>/spese.json` contiene le spese di ogni account;
- `utenti/<id>/files/` contiene le foto degli scontrini.

Il backup dall'app contiene le spese dell'account con cui hai fatto l'accesso.

Esporta comunque un **backup completo** dall'app ogni tanto (**Backup → Esporta backup completo**, da ogni account) e tienilo fuori dall'Umbrel.
**Disinstallare l'app da Umbrel cancella i suoi dati.** Prima di disinstallarla, fai un backup.

## Aggiornare l'app

1. Modifica i file su GitHub.
2. Aumenta `version` in `umbrel-app.yml` (ad esempio da `"1.0.0"` a `"1.0.1"`).
3. Umbrel proporrà l'aggiornamento nell'App Store.

Fai un backup prima di ogni aggiornamento.
