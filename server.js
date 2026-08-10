const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const qs = require('qs');
const cors = require('cors');

const app = express();

// Abilita il CORS per permettere al tuo sito su Firebase di contattare questo server
app.use(cors());

// Variabile globale per salvare la sessione
let cachedCookies = null;

async function eseguiLogin() {
    const loginUrl = 'https://ilcorsaroblu.org/index.php?page=login'; 
    const formData = qs.stringify({
        uid: 'danyluii',
        pwd: 'dany42761'
    });

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

// Endpoint principale
app.get('/cercaTorrentIta', async (req, res) => {
    const searchQuery = req.query.q;
    if (!searchQuery) {
        return res.status(400).json({ success: false, error: "Manca la query" });
    }

    try {
        if (!cachedCookies) await eseguiLogin();

        const trackerUrl = `https://ilcorsaroblu.org/index.php?page=torrents&search=${encodeURIComponent(searchQuery)}`;
        let response = await axios.get(trackerUrl, {
            headers: {
                'Cookie': cachedCookies,
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
            }
        });

        if (response.data.includes('name="pwd"')) {
            await eseguiLogin();
            response = await axios.get(trackerUrl, {
                headers: { 'Cookie': cachedCookies, 'User-Agent': 'Mozilla/5.0' }
            });
        }

        const $ = cheerio.load(response.data);
        const risultati = [];

        $('table tr').each((index, element) => {
            const magnet = $(element).find('a[href^="magnet:"]').attr('href');
            if (magnet) {
                const titolo = $(element).find('td.titolo, td.name, td:nth-child(2)').text().trim() || 'Titolo sconosciuto';
                const size = $(element).find('td.size, td:nth-child(3)').text().trim() || 'N/D';
                const seeds = $(element).find('td.seeds, td:nth-child(4)').text().trim() || '0';
                risultati.push({ titolo, magnet, size, seeds });
            }
        });

        res.json({ success: true, count: risultati.length, data: risultati });

    } catch (error) {
        console.error("Errore:", error.message);
        res.status(500).json({ success: false, error: "Errore proxy" });
    }
});

// Avvia il server sulla porta assegnata dalla piattaforma o sulla 3000 in locale
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server proxy in esecuzione sulla porta ${PORT}`);
});