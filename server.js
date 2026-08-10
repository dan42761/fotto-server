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

        // ⚠️ NUOVO ALGORITMO DI SCRAPING DINAMICO
        // Scansioniamo ogni singola riga presente in tutte le tabelle
        $('tr').each((index, element) => {
            const tds = $(element).find('td');
            
            // Guardando la tua immagine, i veri file hanno 11 colonne. 
            // Ignoriamo i separatori delle date e le barre di ricerca che hanno poche colonne.
            if (tds.length >= 8) {
                
                // La colonna 1 (la seconda da sinistra) è "Nome". Cerchiamo il link al suo interno.
                const linkDettaglio = $(tds[1]).find('a').first();
                let titolo = linkDettaglio.text().trim();
                let detailsUrl = linkDettaglio.attr('href');

                if (titolo && detailsUrl) {
                    // Rendiamo l'URL della pagina dettagli un link assoluto
                    if (!detailsUrl.startsWith('http')) {
                        detailsUrl = `https://ilcorsaroblu.org/${detailsUrl.replace(/^\//, '')}`;
                    }

                    // Preleviamo Seeds (Colonna 5 'D') e Size (Colonna 9 'Dimensione')
                    const seeds = $(tds[5]).text().trim() || '?'; 
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
