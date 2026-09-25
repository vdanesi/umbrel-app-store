# Scontrinaio per Umbrel

Questa cartella è un **app store personale per umbrelOS** con una sola app, Scontrinaio.
Una volta aggiunto a Umbrel, Scontrinaio si installa e si apre come le altre app.
Spese e foto sono salvate sull'Umbrel e le vedi da tutti i tuoi dispositivi.

```
umbrel-app-store.yml              ← nome dello store ("Casa")
.github/workflows/immagine.yml    ← GitHub costruisce l'immagine Docker dell'app
casa-scontrinaio/
  umbrel-app.yml                  ← scheda dell'app (nome, icona, porta 3958, versione)
  docker-compose.yml              ← quale immagine Umbrel avvia (ghcr.io/vdanesi/scontrinaio:<versione>)
  app/Dockerfile                  ← come è fatta l'immagine (Node.js 20, senza dipendenze)
  app/server.js                   ← il server: account, spese, foto
  app/public/                     ← l'app (pagine, icone, lettura scontrini)
  data/                           ← dati sull'Umbrel (resta vuota nel repository)
```

**Perché serve l'immagine Docker.** Quando aggiorna un'app, Umbrel copia solo `docker-compose.yml`, `umbrel-app.yml` e pochi altri file di configurazione, mai il codice. Il codice viaggia quindi dentro un'immagine Docker che GitHub costruisce da solo, per Umbrel Home (x86) e Raspberry Pi (ARM), a ogni modifica.

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
- **Durata dell'accesso:** senza **"Resta connesso"** l'accesso finisce quando chiudi il browser, e comunque dopo 12 ore. Con "Resta connesso" dura 30 giorni su quel dispositivo. Il pulsante **Esci** chiude subito la sessione.
  Sui telefoni il browser spesso non si "chiude" davvero: lì vale il limite delle 12 ore.
- **Versione in uso:** è scritta in fondo alla pagina di accesso e nel menu **Backup → Account**.
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

**Accesso da fuori casa:** usa Tailscale oppure un tunnel Cloudflare (vedi sotto). Non aprire la porta 3958 sul router.

## 3. Sul telefono

- Collegati alla rete di casa e apri `http://umbrel.local:3958`. Se il telefono non riconosce `umbrel.local`, usa l'indirizzo IP dell'Umbrel, ad esempio `http://192.168.1.50:3958`.
- Aggiungi la pagina alla schermata Home: su iPhone **Condividi → Aggiungi alla schermata Home**, su Android **⋮ → Aggiungi a schermata Home**.
- **Fuori casa:** installa l'app **Tailscale** su Umbrel e sul telefono, poi apri `http://umbrel:3958` (o l'indirizzo Tailscale dell'Umbrel).

### Fotocamera
Umbrel serve le app in `http://` (senza https). Per questo il browser non permette la fotocamera dentro la pagina.
Il pulsante con la fotocamera apre quindi la **fotocamera del telefono**: scatti, confermi e la foto torna nell'app, che legge lo scontrino come prima.
Per le stesse ragioni l'app non funziona offline: serve il collegamento all'Umbrel.

## Accesso da internet con Cloudflare Tunnel

Scontrinaio funziona dietro un tunnel Cloudflare, per esempio `https://spese.tuodominio.it`, e in https va meglio che in casa:
- la **fotocamera si apre dentro l'app**, con la cornice per inquadrare lo scontrino;
- l'app si può **installare** sul telefono e il cookie di accesso viaggia solo cifrato (flag `Secure`);
- la protezione dai tentativi usa l'indirizzo reale del visitatore, che Cloudflare invia nell'intestazione `CF-Connecting-IP`.

**Come configurarlo**
1. Su Umbrel installa l'app **Cloudflare Tunnel** (oppure usa `cloudflared` dal pannello Zero Trust).
2. Aggiungi un *Public hostname*, per esempio `spese.tuodominio.it`. Come servizio scegli **HTTP**, con indirizzo `umbrel.local:3958` (o l'IP dell'Umbrel seguito da `:3958`).
3. Nel pannello Cloudflare del dominio, in **Speed → Optimization**, **disattiva Rocket Loader**: modifica gli script della pagina e può bloccare l'app.

**Importante, prima di aprirla su internet**
- Le registrazioni sono aperte di default. Su internet, chiunque trovi l'indirizzo potrebbe creare un account: vedrebbe solo le proprie spese, ma occuperebbe spazio sul tuo Umbrel. Dopo aver creato gli account che ti servono, **chiudi le registrazioni** da **Backup → Amministrazione**.
- Protezione consigliata in più: **Cloudflare Access** (Zero Trust → Access → Applications → *Self-hosted*), con una regola che ammette solo le vostre email. Cloudflare chiede un codice via email prima ancora di mostrare la pagina di accesso di Scontrinaio. È gratuito fino a 50 utenti.
- Non creare regole di cache "Cache Everything" su questo indirizzo. Senza regole particolari, Cloudflare non conserva le pagine né le spese: l'app le marca come non memorizzabili.

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

## Aggiornare l'app (nuova versione)

1. Modifica i file su GitHub.
2. Aumenta la versione **in due punti, con lo stesso numero**:
   - `casa-scontrinaio/umbrel-app.yml` → `version: "1.3.2"`
   - `casa-scontrinaio/docker-compose.yml` → `image: ghcr.io/vdanesi/scontrinaio:1.3.2`
3. Premi **Commit changes**. GitHub avvia da solo la costruzione dell'immagine: la vedi nella scheda **Actions** del repository e dura 2–4 minuti.
4. **Aspetta il segno verde** in Actions. Solo dopo, su Umbrel, premi **Update** su Scontrinaio. Se aggiorni prima che l'immagine sia pronta, Umbrel non riesce a scaricarla: in quel caso aspetta e riprova.
5. Fai un backup prima di ogni aggiornamento.

Per controllare quale versione gira: apri `/api/salute` nell'indirizzo dell'app, ad esempio `https://scontrinaio.dvsolutions.net/api/salute`.

### Solo la prima volta: rendi pubblica l'immagine
GitHub crea l'immagine come **privata**, e Umbrel non riuscirebbe a scaricarla.
Dopo la prima costruzione riuscita:
1. apri il tuo profilo GitHub → **Packages** → **scontrinaio**;
2. vai in **Package settings** → **Danger Zone** → **Change visibility** e scegli **Public**.

L'immagine contiene solo il codice dell'app, nessun tuo dato.
