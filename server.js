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

// ENDPOINT 1: Ricerca e recupero lista risultati (Titoli e URL dei Dettagli)
app.get('/cercaTorrentIta', async (req, res) => {
    const searchQuery = req.query.q;
    if (!searchQuery) return res.status(400).json({ success: false, error: "Manca la query" });

    try {
        if (!cachedCookies) await eseguiLogin();

        const trackerUrl = `https://ilcorsaroblu.org/index.php?page=torrents&search=${encodeURIComponent(searchQuery)}`;
        let response = await axios.get(trackerUrl, {
            headers: { 'Cookie': cachedCookies, 'User-Agent': 'Mozilla/5.0' }
        });

        if (response.data.includes('name="pwd"')) {
            await eseguiLogin();
            response = await axios.get(trackerUrl, { headers: { 'Cookie': cachedCookies, 'User-Agent': 'Mozilla/5.0' } });
        }

        const $ = cheerio.load(response.data);
        const risultati = [];

        // Analizziamo la tabella mostrata nella tua prima immagine
        $('table tr').each((index, element) => {
            if (index === 0) return; // Salta l'intestazione della tabella

            // La colonna 'Nome' è la seconda (indice 1). Cerchiamo il link <a> al suo interno.
            const nameLink = $(element).find('td').eq(1).find('a').first();
            const titolo = nameLink.text().trim();
            let detailsUrl = nameLink.attr('href');

            if (titolo && detailsUrl) {
                // Assicuriamoci che l'URL sia assoluto
                if (!detailsUrl.startsWith('http')) {
                    detailsUrl = `https://ilcorsaroblu.org/${detailsUrl.replace(/^\//, '')}`;
                }
                
                // In base alla tua immagine, cerchiamo di estrarre i dati dalle altre colonne
                const seeds = $(element).find('td').eq(6).text().trim() || '?'; // Colonna R (Seeds)
                const size = $(element).find('td').eq(9).text().trim() || 'N/D'; // Colonna Dimensione

                risultati.push({ titolo, detailsUrl, size, seeds });
            }
        });

        res.json({ success: true, count: risultati.length, data: risultati });

    } catch (error) {
        console.error("Errore Ricerca:", error.message);
        res.status(500).json({ success: false, error: "Errore proxy ricerca" });
    }
});

// ENDPOINT 2: Scraping della pagina di dettaglio (mostrata nella seconda immagine)
app.get('/getMagnet', async (req, res) => {
    const detailsUrl = req.query.url;
    if (!detailsUrl) return res.status(400).json({ success: false, error: "Manca l'URL" });

    try {
        if (!cachedCookies) await eseguiLogin();
        
        const response = await axios.get(detailsUrl, {
            headers: { 'Cookie': cachedCookies, 'User-Agent': 'Mozilla/5.0' }
        });

        const $ = cheerio.load(response.data);
        // Cerca il link che inizia con magnet: (il bottone con la calamita)
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
