# Scontrinaio per Umbrel

Questa cartella è un **app store personale per umbrelOS** con tre app: Scontrinaio, Camper Planner e Rapportini (vedi le sezioni in fondo).
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
.github/workflows/camper-planner.yml ← GitHub costruisce l'immagine di Camper Planner
casa-camper-planner/              ← stessa struttura: umbrel-app.yml, docker-compose.yml, app/, data/
.github/workflows/rapportini.yml   ← GitHub costruisce l'immagine di Rapportini
casa-rapportini/                  ← stessa struttura: umbrel-app.yml, docker-compose.yml, app/, data/
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

---

# Camper Planner

Pianificatore di itinerari in camper: tappe sulla mappa con percorso e tempi di guida, aree camper e campeggi da OpenStreetMap, diario, spese e budget, esportazione GPX e stampa. I viaggi sono salvati sull'Umbrel in `data/`.

- Si installa da **Casa App Store → Camper Planner** e si apre dall'icona, oppure su **http://umbrel.local:3847**.
- **Account** (dalla versione 2.0.0), con le stesse regole di Scontrinaio e Rapportini:
  - al primo avvio la pagina chiede di creare il primo account, che diventa l'**amministratore** e riceve i viaggi, la raccolta e le impostazioni già salvati;
  - ogni utente vede **solo i propri** viaggi, raccolta e mezzo, e le proprie chiavi API;
  - l'amministratore, dal pulsante con il suo nome in alto a destra → **Amministrazione**: apre o chiude le registrazioni, fa **Reset password** (crea una password temporanea da comunicare: al primo accesso l'utente ne sceglie una nuova), nomina altri amministratori, elimina un account con tutti i suoi dati;
  - "Resta connesso" dura 30 giorni, altrimenti l'accesso finisce alla chiusura del browser (al massimo 12 ore); dopo 5 password sbagliate quel nome si blocca per 15 minuti;
  - Umbrel non chiede più anche la propria password (`PROXY_AUTH_ADD: "false"` nel `docker-compose.yml`); per la doppia protezione cancella quella riga e aggiorna.
- Serve internet per mappe, percorsi e ricerca dei luoghi (servizi pubblici di OpenStreetMap).
- **Fonti delle aree sosta** (scheda Aree sosta → Fonti):
  - **OpenStreetMap**, sempre attiva.
  - **Overture Maps**: dati aperti di Meta, Microsoft e Foursquare. Serve una chiave gratuita di [Open Places API](https://openplacesapi.com) (10.000 ricerche al mese), da incollare nella scheda **Mezzo**.
  - **La mia raccolta**: file GPX, KML o CSV importati (POI per navigatori, mappe esportate da Google My Maps, CSV con colonne `lat` e `lon`) e aree salvate con ☆. Resta sull'Umbrel in `data/collection.json` e si esporta in GPX.
  - **Fonti esterne** (in fondo alla scheda Aree sosta): dati aperti di regioni ed enti turistici da importare nella raccolta con un clic, e aggiornare con ↻. Li scarica direttamente l'Umbrel. Puoi anche incollare l'indirizzo di qualsiasi file GeoJSON, CSV, KML o GPX pubblico. Sotto "Altre fonti da scaricare a mano" trovi Archies Campings, DATAtourisme, Areas AC e Google My Maps.
  - **CampingCard ACSI**: sui campeggi trovati c'è il pulsante **A** per segnarli come ACSI con la tariffa a notte, e il collegamento "Cerca su CampingCard ACSI" per controllarli sul sito. Il filtro "Solo campeggi che ho segnato ACSI" mostra solo quelli. Nelle tappe la tariffa si modifica, e il diario stima il costo delle notti ACSI. I dati di ACSI non vengono scaricati, perché le sue condizioni vietano di copiarli su altri computer: i segni li metti tu e restano nella raccolta.
  - **Velocità**: OpenStreetMap viene interrogato a zone di circa 25 km, che restano in cache sull'Umbrel per 14 giorni (cartella `data/cache`, condivisa tra gli utenti; si può cancellare senza perdere dati). Le risposte di Overture restano in cache 7 giorni. I risultati compaiono man mano che arrivano.
  - Le aree trovate in più fonti a meno di 60 m (o 300 m con nome simile) diventano un solo risultato.
  - Park4Night e Campercontact non sono collegati: non hanno un'API pubblica e le loro condizioni vietano di riutilizzarne i dati.
- Facoltativo: con una chiave gratuita di [OpenRouteService](https://openrouteservice.org/dev/#/signup), da incollare nella scheda **Mezzo**, il percorso tiene conto di altezza, larghezza, lunghezza e massa del camper. Senza chiave usa OSRM (profilo auto) con tempi aumentati del 15%.

### Solo la prima volta: rendi pubblica l'immagine
Come per Scontrinaio: dopo la prima costruzione riuscita in **Actions** (“Immagine Docker Camper Planner”), apri **Packages → camper-planner → Package settings → Change visibility → Public**.

### Aggiornare Camper Planner
Stessa procedura di Scontrinaio, con lo stesso numero di versione in:
- `casa-camper-planner/umbrel-app.yml` → `version`
- `casa-camper-planner/docker-compose.yml` → `image: ghcr.io/vdanesi/camper-planner:<versione>`
- `casa-camper-planner/app/package.json` → `version` (è la versione mostrata da `/api/health`)


---

# Rapportini

Registro delle attività lavorative in ambito ferroviario che compila il **Rapporto giornaliero dell'agente (Mod. 0444)**. Un rapporto per ogni giorno, salvato sull'Umbrel in `data/rapporti/`.

- Si installa da **Casa App Store → Rapportini** e si apre dall'icona, oppure su **http://umbrel.local:3444**.
- **Account personali** (dalla versione 2.0): chi apre l'app vede la pagina di **accesso** con le schede *Accedi* e *Registrati*. Ogni account vede solo i propri rapporti, pratiche e impostazioni. Umbrel non chiede anche la sua password (`PROXY_AUTH_ADD: "false"` nel `docker-compose.yml`).
  - **Primo avvio:** il primo account creato è l'**amministratore** e riceve i rapporti e le pratiche già salvati. Crealo subito dopo l'aggiornamento.
  - **Registrazione:** aperta a tutti finché l'amministratore non la chiude da **Impostazioni → Amministrazione**. Link diretto: `http://umbrel.local:3444/accesso?modo=registrati`.
  - **Password dimenticata:** l'amministratore preme **Reset password** accanto all'utente, ottiene una password temporanea da comunicargli e l'utente al primo accesso deve sceglierne una nuova. Il reset sblocca anche i tentativi sbagliati.
  - L'amministratore può anche **nominare altri amministratori** ed **eliminare account** (con tutti i loro dati). Deve restare sempre almeno un amministratore.
  - Password di almeno 8 caratteri, salvate cifrate (scrypt). Dopo 5 tentativi sbagliati l'accesso per quel nome si blocca per 15 minuti. "Resta connesso" dura 30 giorni, altrimenti la sessione finisce chiudendo il browser (al massimo 12 ore).
  - I PDF vuoti dei moduli aziendali e i km già calcolati sono **in comune**: li carica l'amministratore.
- Internet serve solo per calcolare i km del rimborso.
- **Prima volta:** apri **Impostazioni** e inserisci agente, qualifica, CID, residenza di servizio, servizio abituale, unità e **inizio e fine turno**: è straordinario il lavoro fatto prima dell'inizio o dopo la fine (turno fino alle 16:48, lavoro fino alle 17:48 = 1:00). Il turno si può cambiare in ogni rapporto. Compileranno da soli ogni nuovo rapporto.
- **Ogni giorno:** "+ Rapporto di oggi", poi i lavori con *dalle/alle*: ore, totale e straordinario si calcolano da soli. Si salva da solo a ogni modifica. "Copia dal giorno prima" riprende lavori e testata dell'ultimo rapporto.
- **Stampa del Mod. 0444:** l'amministratore carica una volta il PDF vuoto del Mod. 0444 in **Impostazioni → Moduli aziendali**. Nel rapporto del giorno **PDF Mod. 0444** apre il modulo ufficiale compilato (solo la pagina del rapporto), **Scarica PDF** lo salva, **Copertina** crea la copertina del blocchetto con i tuoi dati.
- **Stampa su prestampato:** stampa solo i dati da sovrapporre al blocchetto cartaceo (A4 orizzontale, scala 100%, margini nessuno), con la calibrazione descritta sotto.
- **Calibrare il prestampato:** Impostazioni → "Stampa foglio di prova", sovrapponi il foglio al modulo in controluce e correggi Spostamento X/Y e Scala finché le crocette rosse cadono sugli angoli delle tabelle.
- Il modulo ha 9 righe di lavori e 9 di anormalità, e 8 numeri per colonna nei moduli emessi: l'app non ne accetta di più. I testi lunghi vengono rimpiccioliti per entrare nella casella.
- **Congedi e trasferte (scheda Moduli):** la prima volta carica i PDF vuoti dei moduli 0319, 0692 e 0693 in **Impostazioni → Moduli aziendali** (restano sull'Umbrel, non vanno su GitHub) e completa struttura, data di assunzione, luogo, recapito, auto ed €/km.
  - *Domanda di congedo (0319):* ogni campo del modulo ha la sua casella, raggruppate come sul foglio (domanda, firma, parere del capo, decisione del responsabile, esito, ricevuta). Le giornate lavorative (lun–ven, senza festivi) si contano da sole; i campi dell'esito sono proposti dai tuoi dati e si possono riscrivere (↺ torna al valore proposto). Le parti del capo e del responsabile restano vuote finché non le compili.
  - *Trasferta / intervento in reperibilità (0692 + 0693):* numero, destinazione e motivazione per la lettera di incarico; giornate con o senza timbratura (↺ prende orari e straordinario dal rapportino di quel giorno); viaggi con auto propria: con "Ho usato l'auto propria" (attivo di default) l'app crea una riga per ogni giornata con itinerario andata e ritorno dal luogo delle Impostazioni e **calcola i km stradali** del percorso (OpenStreetMap: serve internet sull'Umbrel; i percorsi già calcolati restano salvati in `data/distanze.json`). Importo = km × €/km. I km si possono sempre correggere a mano.
  - "Apri PDF" lo apre per stamparlo, "Scarica" lo salva. Con "PDF con i campi ancora compilabili" (attivo di default) il PDF si può ancora modificare con un lettore PDF; togliendolo il testo diventa fisso nella pagina. "Duplica" crea la pratica successiva con il numero aumentato di uno.
- **Riepilogo del mese** nella pagina principale, **esportazione CSV** (una riga per lavoro, si apre con Excel) e **backup** in Impostazioni (ognuno scarica il backup dei propri dati).

### Solo la prima volta: rendi pubblica l'immagine
Dopo la prima costruzione riuscita in **Actions** ("Immagine Docker Rapportini"), apri **Packages → rapportini → Package settings → Change visibility → Public**. L'immagine contiene solo il codice, nessun tuo rapporto.

### Aggiornare Rapportini
Stessa procedura di Scontrinaio, con lo stesso numero di versione in:
- `casa-rapportini/umbrel-app.yml` → `version`
- `casa-rapportini/docker-compose.yml` → `image: ghcr.io/vdanesi/rapportini:<versione>`
- `casa-rapportini/app/package.json` → `version` (è la versione mostrata da `/api/health`)
