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
4. Apri `casa-scontrinaio/umbrel-app.yml` su GitHub (icona matita) e sostituisci ovunque `TUO-UTENTE-GITHUB` con il tuo nome utente GitHub. Serve per l'icona e i link.

## 2. Aggiungi lo store a Umbrel

1. Apri Umbrel nel browser (di solito http://umbrel.local).
2. Vai su **App Store**, poi sul menu **⋯** in alto a destra, poi **Community App Stores**.
3. Incolla l'indirizzo del repository, ad esempio `https://github.com/tuonome/umbrel-app-store`, e premi **Add**.
4. Apri **Casa App Store** e installa **Scontrinaio**.

L'app si apre dall'icona su Umbrel, oppure direttamente su **http://umbrel.local:3958**.
Prima di mostrare l'app, Umbrel chiede la sua password.

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
- `spese.json` contiene tutte le spese;
- `files/` contiene le foto degli scontrini.

Esporta comunque un **backup completo** dall'app ogni tanto (**Backup → Esporta backup completo**) e tienilo fuori dall'Umbrel.
**Disinstallare l'app da Umbrel cancella i suoi dati.** Prima di disinstallarla, fai un backup.

## Aggiornare l'app

1. Modifica i file su GitHub.
2. Aumenta `version` in `umbrel-app.yml` (ad esempio da `"1.0.0"` a `"1.0.1"`).
3. Umbrel proporrà l'aggiornamento nell'App Store.

Fai un backup prima di ogni aggiornamento.
