const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const cors = require('cors');

const app = express();
app.use(cors());

// ⚠️ INCOLLA QUI IL TUO COOKIE COMPLETO PRESO DA CHROME
const MIO_COOKIE = "uid=51848; pass=a2a90a313abb7199768a4750be1fa5f2; ilCorSaRoBlu=6e5cc1274b9bd197beaba89a2ba72bd4; cf_clearance=OvF35no_pleQa.mChz0Zngs1qhN3fQ5g2.k.Z01XPHA-1786383525-1.2.1.1-.YhA6qZsIVSgG_u5Vu8RPBf1YCLUsDwWveN8o3ZP8SyRVDPu7TWJeIY.K9U2.nEAG06R5iWD2HRF4IRuwAI0RigbeaQMJUob5UmbDImqsa1jblj6Hb00k7q9eOHxrw7rxMnU4L04LntiTwsE7V_QfGxK7bK3bewccQKeyS7a_hZZAfMZgy46yYbRSNDflj8YssWxeOdW1HJFuM6RddyDPrAhOab0a02K3n1gs3uwa_RweCxEfzuW7lC.nNlYjuKGIN1d0GCl4qAALyGSGXLbj8C21l_LJzbxfetZbYd97q.QqqcJQzDlzZvA4hwJEeZnUlucFYi4LQKf40GGBAIsVGWhKJ8bP2cswdwDTE4.Tfg";

// ⚠️ INCOLLA QUI IL TUO USER-AGENT ESATTO PRESO DA CHROME
const MIO_USER_AGENT = "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Edg/151.0.0.0 Mobile Safari/537.36";

const headersSicuri = {
    'Cookie': MIO_COOKIE,
    'User-Agent': MIO_USER_AGENT,
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7',
    'Upgrade-Insecure-Requests': '1',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'same-origin',
    'Sec-Fetch-User': '?1'
};

// ENDPOINT 1: Ricerca 
app.get('/cercaTorrentIta', async (req, res) => {
    const searchQuery = req.query.q;
    if (!searchQuery) return res.status(400).json({ success: false, error: "Manca la query" });

    try {
        const trackerUrl = `https://ilcorsaroblu.org/index.php?page=torrents&search=${encodeURIComponent(searchQuery)}&active=0`;
        
        const response = await axios.get(trackerUrl, { headers: headersSicuri });

        // Se la pagina contiene il form della password, significa che il cookie è scaduto
        if (response.data.includes('name="pwd"')) {
            console.error("ATTENZIONE: Sessione scaduta o Cookie non validi.");
            return res.status(401).json({ success: false, error: "Sessione scaduta. Aggiorna i cookie nel server.js" });
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
        console.error("Errore Ricerca:", error.response ? error.response.status : error.message);
        res.status(500).json({ success: false, error: "Errore proxy ricerca. Probabile blocco Cloudflare." });
    }
});

// ENDPOINT 2: Scraping del Magnet
app.get('/getMagnet', async (req, res) => {
    const detailsUrl = req.query.url;
    if (!detailsUrl) return res.status(400).json({ success: false, error: "Manca l'URL" });

    try {
        const response = await axios.get(detailsUrl, { headers: headersSicuri });
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
app.listen(PORT, () => console.log(`Server in esecuzione sulla porta ${PORT}`));
