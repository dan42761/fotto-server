const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const qs = require('qs');
const cors = require('cors');

const app = express();
app.use(cors());

let cachedCookies = null;

async function eseguiLogin() {
    const loginUrl = 'https://ilcorsaroblu.org/index.php?page=login'; 
    const formData = qs.stringify({ uid: 'danyluii', pwd: 'dany42761' });

    const response = await axios.post(loginUrl, formData, {
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        },
        maxRedirects: 0,
        validateStatus: (status) => status >= 200 && status < 400
    });

    const setCookieHeaders = response.headers['set-cookie'];
    if (!setCookieHeaders) throw new Error("Errore login: nessun cookie restituito.");

    cachedCookies = setCookieHeaders.map(cookieString => cookieString.split(';')[0]).join('; ');
    console.log("Login effettuato, cookie aggiornati.");
    return cachedCookies;
}

// ENDPOINT 1: Ricerca 
app.get('/cercaTorrentIta', async (req, res) => {
    const searchQuery = req.query.q;
    if (!searchQuery) return res.status(400).json({ success: false, error: "Manca la query" });

    try {
        if (!cachedCookies) await eseguiLogin();

        const trackerUrl = `https://ilcorsaroblu.org/index.php?page=torrents&search=${encodeURIComponent(searchQuery)}&active=0`;
        let response = await axios.get(trackerUrl, {
            headers: { 'Cookie': cachedCookies, 'User-Agent': 'Mozilla/5.0' }
        });

        // Se la sessione in memoria è scaduta, rifacciamo il login
        if (response.data.includes('name="pwd"')) {
            await eseguiLogin();
            response = await axios.get(trackerUrl, { headers: { 'Cookie': cachedCookies, 'User-Agent': 'Mozilla/5.0' } });
        }

        const $ = cheerio.load(response.data);
        const risultati = [];

        // PASSO 1: Inserisci la classe della tabella.
        // Se ispezionando hai visto <table class="lista">, scrivi $('table.lista tr').
        // Se la tabella non ha una classe ma ha un ID (<table id="torrents">), scrivi $('table#torrents tr').
        // Se non ha nulla, lascia semplicemente $('table tr').
        $('table tr').each((index, element) => {
            const tds = $(element).find('td');
            
            // PASSO 2: Quante colonne ha la riga vera e propria del film?
            // Qui diciamo: "Ignora le righe che hanno meno di 8 colonne" (così saltiamo intestazioni e separatori).
            if (tds.length >= 8) {
                
                // PASSO 3: Mappa le colonne giuste!
                // IMPORTANTE: In programmazione (negli Array), la prima colonna è 0, la seconda è 1, la terza è 2, ecc.
                
                // -> Trova il TITOLO (Nella foto era la 2° colonna, quindi indice [1])
                const linkDettaglio = $(tds[1]).find('a').first();
                let titolo = linkDettaglio.text().trim();
                let detailsUrl = linkDettaglio.attr('href');

                if (titolo && detailsUrl) {
                    if (!detailsUrl.startsWith('http')) {
                        detailsUrl = `https://ilcorsaroblu.org/${detailsUrl.replace(/^\//, '')}`;
                    }

                    // -> Trova i SEEDS (Nella foto "D" era la 6° colonna, quindi indice [5])
                    const seeds = $(tds[5]).text().trim() || '?'; 
                    
                    // -> Trova la DIMENSIONE (Nella foto "Dimensione" era la 10° colonna, quindi indice [9])
                    const size = $(tds[9]).text().trim() || 'N/D';

                    risultati.push({ titolo, detailsUrl, size, seeds });
                }
            }
        });

        res.json({ success: true, count: risultati.length, data: risultati });

    } catch (error) {
        console.error("Errore Ricerca:", error.message);
        res.status(500).json({ success: false, error: "Errore proxy ricerca" });
    }
});

// ENDPOINT 2: Scraping della pagina del magnet link
app.get('/getMagnet', async (req, res) => {
    const detailsUrl = req.query.url;
    if (!detailsUrl) return res.status(400).json({ success: false, error: "Manca l'URL" });

    try {
        if (!cachedCookies) await eseguiLogin();
        
        const response = await axios.get(detailsUrl, {
            headers: { 'Cookie': cachedCookies, 'User-Agent': 'Mozilla/5.0' }
        });

        const $ = cheerio.load(response.data);
        
        // Estrae direttamente l'URL dalla grossa calamita
        const magnet = $('a[href^="magnet:"]').attr('href');

        if (magnet) {
            res.json({ success: true, magnet });
        } else {
            res.json({ success: false, error: "Link magnetico non trovato" });
        }
    } catch (error) {
        console.error("Errore Magnet:", error.message);
        res.status(500).json({ success: false, error: "Errore recupero magnet" });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server proxy in esecuzione sulla porta ${PORT}`));
