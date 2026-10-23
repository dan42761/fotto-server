# Guida Rapida: Deploy Backend Fotto-Music + Rintocchi Anti-Sleep

## Contenuto dello ZIP
1. `server.js`: Server Node.js/Express che espone `/?q=...`, `/audio?videoId=...`, `/stream-local/...` (con supporto `HTTP 206 Partial Content / Range` per il background su Android) e `/ping` per i rintocchi anti-sleep.
2. `package.json`: Dipendenze pronte per host Node.js (FalixNodes, Render, Koyeb, Hop, ecc.).
3. `Dockerfile`: Per i servizi che usano container Docker (es. Koyeb, Render, HuggingFace Spaces o il tuo server locale con Docker/Podman).
4. `cloudflare-worker-keepalive.js`: Codice da mettere sul tuo Cloudflare Worker (`fotto-music.atuttifotto.workers.dev`) che inoltra le richieste al server e gli manda un rintocco automatico ogni 5 minuti tramite i **Cron Triggers** di Cloudflare.

---

## Come caricarlo

### Caso A: Su FalixNodes (o pannelli Pterodactyl simili)
1. Crea un server scegliendo come software **Node.js** (Generic Node.js).
2. Vai nel **File Manager** e carica `server.js` e `package.json`.
3. Nelle impostazioni di avvio (**Startup**), imposta il file principale su `server.js`.
4. Avvia il server: installerà in automatico `express` e `cors` e si metterà in ascolto sulla porta assegnata.
5. *(Nota su FalixNodes)*: Falix assegna una porta `IP:PORTA` in HTTP. Poiché la tua app Android usa HTTPS, ti basta inserire l'indirizzo `http://IP:PORTA` dentro `BACKEND_ORIGIN` nel file `cloudflare-worker-keepalive.js` su Cloudflare: il tuo Worker farà da ponte HTTPS gratuito!

### Caso B: Su Render.com o Koyeb (Piano Free con HTTPS incluso)
1. Carica questi file in un repository GitHub privato o pubblico.
2. Su Render/Koyeb crea un **Web Service** gratuito collegato al repository.
3. Imposta `npm install` come Build Command e `npm start` come Start Command.

---

## Come attivare i Rintocchi per non farlo MAI andare offline

I server gratuiti vanno in sospensione se non ricevono traffico HTTP ESTERNO per 15 minuti. Nel pacchetto hai **due livelli di protezione**:

1. **Rintocco Interno (`setInterval` in `server.js`):** Ogni 4 minuti il server chiama se stesso su `/ping`.
2. **Rintocco Esterno Gratuito (Consigliato al 100%):**
   - **Tramite Cloudflare Cron Trigger:** Dopo aver incollato `cloudflare-worker-keepalive.js` nel tuo Worker su Cloudflare, vai nella scheda **Settings -> Triggers -> Cron Triggers** del Worker e aggiungi `*/5 * * * *` (esegue un ping ogni 5 minuti dai server di Cloudflare).
   - **Tramite Cron-job.org o UptimeRobot (Gratuiti):** Crea un monitor HTTP(S) gratuito che chiama `https://TUO-SERVER/ping` ogni 5 minuti.
