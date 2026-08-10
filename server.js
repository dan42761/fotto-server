const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const qs = require('qs');
const cors = require('cors');

const app = express();
app.use(cors());

let cachedCookies = null;

// Creiamo un'impronta digitale che mimi esattamente Google Chrome su Windows
const browserHeaders = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
    'Accept-Language': 'it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7',
    'Accept-Encoding': 'gzip, deflate, br',
    'Cache-Control': 'max-age=0',
    'Connection': 'keep-alive',
    'Upgrade-Insecure-Requests': '1',
    'Sec-Ch-Ua': '"Not A(Brand";v="99", "Google Chrome";v="121", "Chromium";v="121"',
    'Sec-Ch-Ua-Mobile': '?0',
    'Sec-Ch-Ua-Platform': '"Windows"',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'same-origin',
    'Sec-Fetch-User': '?1'
};

async function eseguiLogin() {
    const loginUrl = 'https://ilcorsaroblu.org/index.php?page=login'; 
    const formData = qs.stringify({ uid: 'danyluii', pwd: 'dany42761' });

    // Creiamo gli header specifici per il POST unendoli a quelli del browser
    const postHeaders = { 
        ...browserHeaders, 
        'Content-Type': 'application/x-www-form-urlencoded',
        'Origin': 'https://ilcorsaroblu.org',
        'Referer': 'https://ilcorsaroblu.org/index.php?page=login'
    };

    const response = await axios.post(loginUrl, formData, {
        headers: postHeaders,
        maxRedirects: 0,
        validateStatus: (status) => status >= 200 && status < 400
    });

    const setCookieHeaders = response.headers['set-cookie'];
    if (!setCookieHeaders) throw new Error("Errore login: nessun cookie restituito dal server.");

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
            headers: { ...browserHeaders, 'Cookie': cachedCookies }
        });

        if (response.data.includes('name="pwd"')) {
            await eseguiLogin();
            response = await axios.get(trackerUrl, { headers: { ...browserHeaders, 'Cookie': cachedCookies } });
        }

        const $ = cheerio.load(response.data);
        const risultati = [];

        $('table tr').each((index, element) => {
            const tds = $(element).find('td');
            if (tds.length >= 8) {
                const linkDettaglio = $(tds[1]).find('a').first();
                let titolo = linkDettaglio.text().trim();
                let detailsUrl = linkDettaglio.attr('href');

                if (titolo && detailsUrl) {
                    if (!detailsUrl.startsWith('http')) {
                        detailsUrl = `https://ilcorsaroblu.org/${detailsUrl.replace(/^\//, '')}`;
                    }

                    const seeds = $(tds[5]).text().trim() || '?'; 
                    const size = $(tds[9]).text().trim() || 'N/D';
                    risultati.push({ titolo, detailsUrl, size, seeds });
                }
            }
        });

        res.json({ success: true, count: risultati.length, data: risultati });

    } catch (error) {
        // Se c'è ancora un errore 403, lo stampiamo per capire in quale punto fallisce
        console.error("Errore Ricerca:", error.response ? error.response.status : error.message);
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
            headers: { ...browserHeaders, 'Cookie': cachedCookies }
        });

        const $ = cheerio.load(response.data);
        const magnet = $('a[href^="magnet:"]').attr('href');

        if (magnet) {
            res.json({ success: true, magnet });
        } else {
            res.json({ success: false, error: "Link magnetico non trovato" });
        }
    } catch (error) {
        console.error("Errore Magnet:", error.response ? error.response.status : error.message);
        res.status(500).json({ success: false, error: "Errore recupero magnet" });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server proxy in esecuzione sulla porta ${PORT}`));
