process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
const PORT = process.env.PORT || 3000;

// ⚙️ الإعدادات الأساسية
const FIREBASE_URL = "https://gamerdz1517-db-default-rtdb.europe-west1.firebasedatabase.app";
const CLOUDFLARE_WORKER_URL = "https://xt2.gamerdz1517.com"; // العامل الكادح للبث

app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// ==============================================================
// دوال مساعدة
// ==============================================================
function getSpoofedIP(mac) {
    if (!mac) return '197.22.14.11';
    let hash = 0; const str = String(mac).toLowerCase();
    for (let i = 0; i < str.length; i++) { hash = ((hash << 5) - hash) + str.charCodeAt(i); hash |= 0; }
    hash = Math.abs(hash);
    return `197.${(hash % 200) + 10}.${((hash >> 8) % 200) + 10}.${((hash >> 16) % 200) + 10}`;
}

async function callStalkerDirect(serverUrl, macAddress, stalkerType, stalkerAction, token = null) {
    const spoofedIP = getSpoofedIP(macAddress);
    const headers = {
        "User-Agent": "Mozilla/5.0 (QtEmbedded; U; Linux; C) AppleWebKit/533.3 (KHTML, like Gecko) MAG200 stbapp ver: 2 rev: 250 Safari/533.3",
        "Referer": `${serverUrl}/c/`,
        "Cookie": `mac=${macAddress}; stb_lang=en; timezone=Africa/Algiers;`,
        "X-Forwarded-For": spoofedIP, "X-Real-IP": spoofedIP, "Client-IP": spoofedIP
    };
    let targetUrl;
    if (stalkerAction === "handshake") {
        targetUrl = `${serverUrl}/portal.php?action=handshake&type=stb&token=&JsHttpRequest=1-xml`;
    } else {
        targetUrl = `${serverUrl}/server/load.php?type=${stalkerType}&action=${stalkerAction}&JsHttpRequest=1-xml`;
        if (token) headers["Authorization"] = `Bearer ${token}`;
    }
    try {
        const res = await fetch(targetUrl, { headers, timeout: 20000 });
        return await res.json();
    } catch { return null; }
}

// 🚀 الدالة المفقودة لجلب القنوات والأفلام (تمت إعادتها)
async function fetchContentStrict(server, mac, type, allowedIds, categoryId, token, extraParam = "") {
    const genreParam = type === "itv" ? "genre" : "category";
    const targetCat  = (categoryId && !["0","*","null","undefined"].includes(categoryId)) ? categoryId : "";
    const extraQuery = extraParam ? `&${extraParam}` : "";

    let catsToFetch = [];
    if (targetCat) {
        catsToFetch = [targetCat];
    } else if (allowedIds.includes('ALL')) {
        const catRes = await callStalkerDirect(server, mac, type, type === "itv" ? "get_genres" : "get_categories", token);
        const list   = catRes?.js ? (Array.isArray(catRes.js) ? catRes.js : Object.values(catRes.js)) : [];
        catsToFetch  = list.map(c => String(c.id));
        if (!catsToFetch.length) catsToFetch = [""];
    } else {
        catsToFetch = allowedIds;
    }

    const uniqueMap = new Map();
    const batchSize = 3;

    for (const catId of catsToFetch) {
        const catQuery = catId ? `&${genreParam}=${catId}` : "";
        let page = 1, keepGoing = true;
        while (keepGoing && page <= 60) {
            const promises = Array.from({length: batchSize}, (_, i) =>
                callStalkerDirect(server, mac, type, `get_ordered_list${catQuery}${extraQuery}&limit=1500&p=${page+i}`, token)
            );
            const results = await Promise.all(promises);
            let found = false;
            for (const res of results) {
                let pageData = res?.js?.data || res?.js;
                if (!pageData) continue;
                if (!Array.isArray(pageData)) pageData = typeof pageData === 'object' ? Object.values(pageData) : [];
                for (const item of pageData) {
                    const itemCat = String(item.tv_genre_id || item.category_id || catId || targetCat || "0");
                    if (allowedIds.includes('ALL') || allowedIds.includes(itemCat) || extraParam) {
                        const id = item.id || item.cmd || Math.random();
                        if (!uniqueMap.has(id)) { item.injected_cat_id = itemCat; uniqueMap.set(id, item); }
                    }
                    found = true;
                }
            }
            if (!found) { keepGoing = false; break; }
            page += batchSize;
        }
    }
    return Array.from(uniqueMap.values());
}

// ==============================================================
// 1️⃣ الفحص وجلب التصنيفات (للمنصة)
// ==============================================================
app.get('/api/scan', async (req, res) => {
    let { server, mac } = req.query;
    try {
        server = server.trim().replace(/\/c\/?$/i, '').replace(/\/+$/, '');
        let hsRaw = await callStalkerDirect(server, mac, "stb", "handshake", null);
        let tk = hsRaw?.js?.token;
        if(!tk) return res.json({success: false, error: "الماك محظور أو السيرفر لا يستجيب"});

        let liveRes = await callStalkerDirect(server, mac, "itv", "get_genres", tk);
        let vodRes = await callStalkerDirect(server, mac, "vod", "get_categories", tk);
        let seriesRes = await callStalkerDirect(server, mac, "series", "get_categories", tk).catch(()=>({js:[]}));

        let formatCats = (arr) => {
            let list = Array.isArray(arr) ? arr : Object.values(arr||{});
            return list.map(c => ({id: String(c.id), title: String(c.title || c.name)}));
        };
        res.json({ success: true, categories: { live: formatCats(liveRes?.js), vod: formatCats(vodRes?.js), series: formatCats(seriesRes?.js) } });
    } catch(e) { res.json({success: false, error: e.message}); }
});

// 🚀 المسار المفقود لجلب محتوى التصنيفات داخل المشغل (تمت إعادته)
app.post('/api/get_items', async (req, res) => {
    const { server, mac, type, selectedCats } = req.body;
    try {
        const hs = await callStalkerDirect(server, mac, "stb", "handshake", null);
        const tk = hs?.js?.token;
        if (!tk) return res.json({ success:false, error:"MAC Blocked" });

        const items = await fetchContentStrict(server, mac, type, selectedCats, null, tk);
        const formatted = items.map(item => ({
            id:   item.id || item.cmd,
            name: item.name || item.cmd,
            logo: item.logo || item.screenshot_uri || ""
        }));
        res.json({ success:true, data:formatted });
    } catch(e) { res.json({ success:false, error:e.message }); }
});

// ==============================================================
// 2️⃣ إنشاء حساب وحفظه في Firebase
// ==============================================================
app.post('/create_account', async (req, res) => {
    try {
        const { mac, server, selections } = req.body;
        if (!mac || !server) return res.json({ success: false });

        const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
        let shortPass = '';
        for (let i = 0; i < 8; i++) shortPass += chars.charAt(Math.floor(Math.random() * chars.length));

        const dbData = { mac: mac.trim(), server: server.trim(), selections };
        
        await fetch(`${FIREBASE_URL}/accounts/${shortPass}.json`, {
            method: 'PUT',
            body: JSON.stringify(dbData)
        });

        res.json({ success: true, password: shortPass });
    } catch (e) { res.json({ success: false, error: e.message }); }
});

// ==============================================================
// 3️⃣ استخراج رابط البث وتحويله للـ Cloudflare Worker 🚀
// ==============================================================
app.get('/proxy_stream', async (req, res) => {
    let { server, mac, stream_id, type } = req.query;

    if (server) {
        server = server.trim().replace(/\/c\/?$/i, '').replace(/\/+$/, '');
        if (!server.startsWith('http')) server = 'http://' + server;
    }
    if (!server || !mac || !stream_id) return res.status(400).send("Missing params");

    console.log(`[PROXY] server=${server} stream_id=${stream_id} type=${type}`);

    try {
        // جلب التوكن
        const tkRes = await callStalkerDirect(server, mac, "stb", "handshake", null);
        const tk = tkRes?.js?.token;
        if (!tk) {
            // تلبية طلب المساعد الذكي: فرض Content-Type لمنع ORB Error
            res.setHeader('Content-Type', 'video/mp2t');
            return res.status(403).end();
        }

        // تجهيز رابط البث
        let streamUrl = "";
        if (type === 'vod' || type === 'movie') {
            streamUrl = `${server}/play/movie.php?mac=${mac}&stream=${stream_id}.mkv&type=movie`;
        } else {
            const cmd = encodeURIComponent(`ffmpeg localhost/ch/${stream_id}`);
            const linkRes = await callStalkerDirect(server, mac, "itv", `create_link&cmd=${cmd}`, tk);
            const pt = linkRes?.js?.play_token || linkRes?.js?.token_random || "";

            if (linkRes?.js?.cmd) {
                const rawCmd = linkRes.js.cmd;
                if (rawCmd.startsWith('http')) streamUrl = rawCmd;
                else streamUrl = rawCmd.startsWith('ffmpeg ') ? rawCmd.split(' ').pop() : rawCmd;
            }
            if (!streamUrl) streamUrl = `${server}/play/live.php?mac=${mac}&stream=${stream_id}&extension=ts`;
            if (pt && !streamUrl.includes('play_token=')) streamUrl += (streamUrl.includes('?') ? '&' : '?') + `play_token=${pt}`;
        }

        // 🚀 هيدرز التخفي القصوى (تطابق VLC تماماً بدون X-Forwarded-For)
        const reqHeaders = {
            "User-Agent": "Mozilla/5.0 (QtEmbedded; U; Linux; C) AppleWebKit/533.3 (KHTML, like Gecko) MAG200 stbapp ver: 2 rev: 250 Safari/533.3",
            "Accept": "*/*",
            "Connection": "keep-alive",
            "Referer": `${server}/c/`,
            "Cookie": `mac=${mac}; stb_lang=en; timezone=Africa/Algiers;`,
            "Authorization": `Bearer ${tk}`
        };
        if (req.headers.range) reqHeaders["Range"] = req.headers.range;

        const controller = new AbortController();
        req.on('close', () => controller.abort());

        const fetchRes = await fetch(streamUrl, { 
            headers: reqHeaders, 
            redirect: 'follow', 
            timeout: 15000, 
            signal: controller.signal 
        });

        // إعداد استجابة آمنة للمتصفح لتخطي CORS و ORB
        res.status(fetchRes.status);
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
        res.setHeader('Access-Control-Expose-Headers', 'Content-Range, Accept-Ranges, Content-Length, Content-Type');
        
        ['content-length','content-range','accept-ranges'].forEach(h => {
            if (fetchRes.headers.has(h)) res.setHeader(h, fetchRes.headers.get(h));
        });

        // 🚀 الفرض الإجباري لصيغة الفيديو (حل تحذير المساعد الذكي)
        res.setHeader('Content-Type', (type==='vod'||type==='movie') ? 'video/mp4' : 'video/mp2t');

        // إذا استمر الحظر، ننهي الطلب بسلام دون إرسال صفحة HTML مفخخة للمتصفح
        if (!fetchRes.ok && fetchRes.status !== 206) {
            console.log(`[PROXY] Blocked by server: ${fetchRes.status}`);
            return res.end(); 
        }

        // تمرير البث
        streamToResponse(fetchRes.body, res, req);

    } catch (e) {
        res.setHeader('Content-Type', 'video/mp2t');
        res.status(500).end();
    }
});
// ==============================================================
// 4️⃣ محاكاة واجهة Xtream Codes API (لتعمل على التطبيقات)
// ==============================================================
app.get('/player_api.php', async (req, res) => {
    res.json({ user_info: { auth: 1, status: "Active" } });
});

// توجيه روابط البث القادمة من تطبيقات الاكستريم إلى مسار /proxy_stream ليحولها للوركر
app.get(['/live/:user/:pass/:stream', '/movie/:user/:pass/:stream', '/series/:user/:pass/:stream'], async (req, res) => {
    const reqPass = req.params.pass;
    const streamId = req.params.stream.split('.')[0];
    const typeStr = req.path.includes('/movie/') ? 'vod' : 'itv';

    try {
        const fbRes = await fetch(`${FIREBASE_URL}/accounts/${reqPass}.json`);
        const account = await fbRes.json();
        
        if (account && account.server && account.mac) {
            // توجيه الطلب داخلياً للبروكسي الخاص بنا والذي سيحوله بدوره لـ Cloudflare
            res.redirect(302, `/proxy_stream?server=${encodeURIComponent(account.server)}&mac=${encodeURIComponent(account.mac)}&stream_id=${streamId}&type=${typeStr}`);
        } else {
            res.status(401).send("Unauthorized");
        }
    } catch(e) { res.status(500).send("Error"); }
});

app.get('/', (req, res) => res.send('✅ GAMERDZ1517 BACKEND IS RUNNING!'));

app.listen(PORT, '0.0.0.0', () => console.log(`Server running on port ${PORT}`));
