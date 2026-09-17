const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
const PORT = process.env.PORT || 3000;

// ⚠️ رابط قاعدة بيانات Firebase الخاص بك
const FIREBASE_URL = "https://gamerdz1517-db-default-rtdb.europe-west1.firebasedatabase.app"; 

// ⚠️ رابط Cloudflare Worker الخاص بك (احتياطي فقط)
const CLOUDFLARE_WORKER_URL = "https://xt.gamerdz1517.com";

// 🛡️ حماية السيرفر من الانهيار
process.on('uncaughtException', function (err) { console.error('Caught exception: ', err); });
process.on('unhandledRejection', (reason, p) => { console.error('Unhandled Rejection: ', reason); });

app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ limit: '5mb', extended: true }));

// 🛡️ نظام الكاش الذكي لتقليل الطلبات وحماية السيرفر (تمت إضافته لكودك الأصلي)
const listsCache = new Map();
app.use((req, res, next) => {
    if (req.path.includes('player_api') || req.path.includes('get_items') || req.path.includes('scan') || req.path.includes('get.php')) {
        res.setHeader('Cache-Control', 'public, max-age=14400');
    }
    next();
});

const localCache = new Map();

async function getAuthDataFromFirebase(password) {
    if (!password) return null;
    if (localCache.has(password)) return localCache.get(password);
    try {
        let res = await fetch(`${FIREBASE_URL}/accounts/${password}.json`);
        if (!res.ok) return null;
        let data = await res.json();
        if (data && data.server && data.mac) {
            let authResult = { srv: data.server, mac: data.mac, selections: data.selections };
            localCache.set(password, authResult); 
            return authResult;
        }
        return null;
    } catch(e) { return null; }
}

function encodeSafeBase64(str) {
    try { return Buffer.from(unescape(encodeURIComponent(str))).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); } 
    catch(e) { return Buffer.from(str).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
}

function decodeSafeBase64(str) {
    try {
        let b64 = str.replace(/-/g, '+').replace(/_/g, '/');
        while (b64.length % 4) { b64 += '='; }
        return decodeURIComponent(escape(Buffer.from(b64, 'base64').toString('utf-8')));
    } catch(e) { return str; }
}

function isAdultContent(name) {
    if (!name) return false;
    return /porn|xxx|adult|18\+|erotic|sex|adults/i.test(name.toLowerCase());
}

function getRealLogo(serverUrl, logoPath, type) {
    if (!logoPath) return "";
    let url = String(logoPath).trim();
    if (url.startsWith('http')) return url;
    let srv = serverUrl.replace(/\/+$/, '');
    if (url.startsWith('/')) return srv + url;
    if (url.includes('/')) return srv + '/' + url;
    if (type === 'vod' || type === 'series') return srv + '/stalker_portal/misc/video_cover/' + url;
    return srv + '/stalker_portal/misc/logos/320/' + url;
}

function safeFallback(action) {
    let timeNow = new Date().toISOString().replace('T', ' ').substring(0, 19);
    if (action === "") {
        return {
            user_info: { username: "GAMERDZ", password: "", message: "Unauthorized", auth: 0, status: "Inactive", exp_date: "0", is_trial: "0", active_cons: "0", max_connections: "1000", created_at: "0", allowed_output_formats: ["m3u8", "ts", "rtmp", "mkv", "mp4"] },
            server_info: { url: "", port: "80", https_port: "443", server_protocol: "http", timezone: "Africa/Algiers", version: "2.9.0" }
        };
    } else if (action === "get_series_info") {
        return { seasons: [], episodes: {}, info: { name: "Not Found", cover: "", plot: "", cast: "", director: "", genre: "", releaseDate: "", rating: "5", rating_5based: 5.0, backdrop_path: [] } };
    } else if (action === "get_short_epg" || action === "get_simple_data_table") {
        return { epg_listings: [] };
    } else return [];
}

async function callStalkerDirect(serverUrl, macAddress, stalkerType, stalkerAction, token = null) {
    let targetUrl = "";
    let headers = {
        "User-Agent": "Mozilla/5.0 (QtEmbedded; U; Linux; C) AppleWebKit/533.3 (KHTML, like Gecko) MAG200 stbapp ver: 2 rev: 250 Safari/533.3",
        "Referer": `${serverUrl}/c/`,
        "Cookie": `mac=${macAddress}; stb_lang=en; timezone=Africa/Algiers;`,
        "Accept": "application/json, text/javascript, */*; q=0.01",
        "X-Requested-With": "XMLHttpRequest"
    };

    if (stalkerAction === "handshake") {
        targetUrl = `${serverUrl}/portal.php?action=handshake&type=stb&token=&JsHttpRequest=1-xml`;
        headers["Authorization"] = `MAC ${macAddress}`;
    } else {
        targetUrl = `${serverUrl}/server/load.php?type=${stalkerType}&action=${stalkerAction}&JsHttpRequest=1-xml`;
        if (token && token !== "null") {
            targetUrl += `&token=${token}`;
            headers["Authorization"] = `Bearer ${token}`;
        }
    }

    try {
        const res = await fetch(targetUrl, { headers: headers, timeout: 35000 });
        if (!res.ok) return null;
        return await res.json();
    } catch(e) { return null; }
}

async function fetchContentStrict(server, mac, type, allowedIds, categoryId, token, extraParam = "") {
    let genreParam = type === "itv" ? "genre" : "category";
    let targetCat = (categoryId && categoryId !== "0" && categoryId !== "*" && categoryId !== "null" && categoryId !== "undefined") ? categoryId : "";
    let extraQuery = extraParam ? `&${extraParam}` : "";

    let catsToFetch = [];
    if (targetCat !== "") {
        catsToFetch = [targetCat];
    } else {
        if (allowedIds.includes('ALL')) {
            let catRes = await callStalkerDirect(server, mac, type, type === "itv" ? "get_genres" : "get_categories", token);
            let list = catRes?.js ? (Array.isArray(catRes.js) ? catRes.js : Object.values(catRes.js)) : [];
            catsToFetch = list.map(c => String(c.id));
            if (catsToFetch.length === 0) catsToFetch = [""]; 
        } else {
            catsToFetch = allowedIds; 
        }
    }

    let uniqueMap = new Map();
    let batchSize = 3; 

    for (let catId of catsToFetch) {
        let catQuery = catId !== "" ? `&${genreParam}=${catId}` : "";
        let currentPage = 1;
        let keepGoing = true;

        while (keepGoing && currentPage <= 60) { 
            let promises = [];
            for (let i = 0; i < batchSize; i++) {
                let page = currentPage + i;
                promises.push(callStalkerDirect(server, mac, type, `get_ordered_list${catQuery}${extraQuery}&limit=1500&p=${page}`, token));
            }
            
            let chunkResults = await Promise.all(promises);
            let foundDataInChunk = false;

            for (let res of chunkResults) {
                let pageData = res?.js?.data || res?.js;
                if (!pageData) continue;
                if (!Array.isArray(pageData)) {
                    if (typeof pageData === 'object' && Object.keys(pageData).length > 0) pageData = Object.values(pageData);
                    else pageData = [];
                }
                
                if (pageData.length > 0) {
                    for (let x = 0; x < pageData.length; x++) {
                        let item = pageData[x];
                        let itemCatId = String(item.tv_genre_id || item.category_id || catId || targetCat || "0");

                        if (allowedIds.includes('ALL') || allowedIds.includes(itemCatId) || extraParam !== "") {
                            let id = item.id || item.cmd;
                            if (!id) id = Math.random();
                            if (!uniqueMap.has(id)) {
                                item.injected_cat_id = itemCatId; 
                                uniqueMap.set(id, item);
                            }
                        }
                    }
                    foundDataInChunk = true;
                }
            }
            chunkResults = null; 
            if (!foundDataInChunk) { keepGoing = false; break; }
            currentPage += batchSize;
        }
    }
    return Array.from(uniqueMap.values());
}

app.post('/create_account', async (req, res) => {
    try {
        const { mac, server, selections } = req.body;
        if (!mac || !server) return res.json({success: false, error: "Missing Data"});

        const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
        let shortPass = '';
        for (let i = 0; i < 8; i++) shortPass += chars.charAt(Math.floor(Math.random() * chars.length));

        const dbData = { mac: mac.trim(), server: server.trim(), selections };
        
        let fbRes = await fetch(`${FIREBASE_URL}/accounts/${shortPass}.json`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(dbData)
        });

        if(fbRes.ok) {
            localCache.set(shortPass, { srv: dbData.server, mac: dbData.mac, selections: dbData.selections });
            return res.json({success: true, password: shortPass});
        }
        else return res.json({success: false, error: "Database Error"});
    } catch(e) { res.json({success: false, error: e.message}); }
});

app.get('/api/scan', async (req, res) => {
    let server = req.query.server;
    let mac = req.query.mac;
    try {
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

app.post('/api/get_items', async (req, res) => {
    const { server, mac, type, selectedCats } = req.body;
    try {
        let hsRaw = await callStalkerDirect(server, mac, "stb", "handshake", null);
        let tk = hsRaw?.js?.token;
        if(!tk) return res.json({success: false, error: "MAC Blocked"});

        let items = await fetchContentStrict(server, mac, type, selectedCats, null, tk);
        let formatted = items.map(item => ({
            id: item.id || item.cmd,
            name: item.name || item.cmd,
            logo: item.logo || item.screenshot_uri || ""
        }));
        
        res.json({ success: true, data: formatted });
    } catch(e) { res.json({success: false, error: e.message}); }
});

// 🚀 مسار المعاينة الذكي الذي يحاكي مسارات التحويل بالضبط (Bypass CORS) - الكود الأصلي الذي يعمل
app.get('/proxy_stream', async (req, res) => {
    let { server, mac, stream_id, type, use_worker } = req.query;
    try {
        let tkRes = await callStalkerDirect(server, mac, "stb", "handshake", null);
        let tk = tkRes?.js?.token;
        if(!tk) return res.status(403).send("Blocked");

        let streamUrl = "";
        
        if (type === 'vod' || type === 'movie') {
            streamUrl = `${server}/play/movie.php?mac=${mac}&stream=${stream_id}.mkv&type=movie`;
        } else {
            streamUrl = `${server}/play/live.php?mac=${mac}&stream=${stream_id}&extension=ts`;
            let linkRes = await callStalkerDirect(server, mac, "itv", `create_link&cmd=${encodeURIComponent('ffmpeg localhost/ch/'+stream_id)}`, tk);
            if (linkRes?.js?.cmd && !linkRes.js.cmd.includes('.m3u8')) {
                streamUrl = linkRes.js.cmd.startsWith('ffmpeg ') ? linkRes.js.cmd.split(' ').pop() : linkRes.js.cmd;
            }
        }

        if(!streamUrl) return res.status(404).send("Stream not found");

        // 🌟 الميزة الاختيارية للـ Worker (مغلقة افتراضياً ليعمل المشغل القديم)
        if (use_worker === '1') {
            let workerProxyUrl = `${CLOUDFLARE_WORKER_URL}/?url=${encodeURIComponent(streamUrl)}`;
            return res.redirect(workerProxyUrl);
        }

        // الكود الأصلي الذي يعمل لديك باستخدام Pipe
        const reqHeaders = { 
            "User-Agent": "VLC/3.0.9 LibVLC/3.0.9", 
            "Accept": "*/*",
            "Connection": "keep-alive"
        };
        
        if (req.headers.range) reqHeaders["Range"] = req.headers.range;

        const fetchRes = await fetch(streamUrl, {
            headers: reqHeaders,
            redirect: 'follow',
            timeout: 0 
        });

        if (!fetchRes.ok && fetchRes.status !== 206) return res.status(fetchRes.status).send("Stream Error");

        res.status(fetchRes.status); 
        
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Range, Accept-Ranges');
        res.setHeader('Access-Control-Expose-Headers', 'Content-Range, Accept-Ranges, Content-Length, Content-Type');
        
        const headersToForward = ['content-type', 'content-length', 'content-range', 'accept-ranges'];
        headersToForward.forEach(h => {
            if (fetchRes.headers.has(h)) res.setHeader(h, fetchRes.headers.get(h));
        });

        if (!res.getHeader('Content-Type')) {
            res.setHeader('Content-Type', (type === 'vod' || type === 'movie') ? 'video/mp4' : 'video/mp2t');
        }

        fetchRes.body.pipe(res);

        fetchRes.body.on('error', (err) => { res.end(); });
        req.on('close', () => { 
            if (fetchRes.body && typeof fetchRes.body.destroy === 'function') fetchRes.body.destroy(); 
        });

    } catch(e) { res.status(500).send("Proxy Error"); }
});

app.get('/get.php', async (req, res) => {
    let username = (req.query.username || "").trim();
    let password = (req.query.password || "").trim();

    let authData = await getAuthDataFromFirebase(password);
    if (!authData || authData.mac.toLowerCase() !== username.toLowerCase()) return res.status(403).send("Unauthorized");

    let portalServer = authData.srv;
    let stalkerMac = authData.mac; 
    let sel = authData.selections || { l: [], v: [], s: [] };
    let fullUrl = `http://${req.headers['x-forwarded-host'] || req.get('host')}`;

    try {
        let handshakeRes = await callStalkerDirect(portalServer, stalkerMac, "stb", "handshake");
        let stalkerToken = handshakeRes?.js?.token;
        if (!stalkerToken) return res.status(403).send("MAC Blocked");

        res.setHeader('Content-Type', 'application/vnd.apple.mpegurl; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="GAMERDZ1517_${username}.m3u"`);
        res.write("#EXTM3U\n"); 
        
        if (sel.l && sel.l.length > 0) {
            let catRes = await callStalkerDirect(portalServer, stalkerMac, "itv", "get_genres", stalkerToken);
            let catList = catRes?.js ? (Array.isArray(catRes.js) ? catRes.js : Object.values(catRes.js)) : [];
            let catMap = {}; catList.forEach(c => catMap[String(c.id)] = c.title || c.name);

            let channels = await fetchContentStrict(portalServer, stalkerMac, "itv", sel.l, null, stalkerToken);
            for(let ch of channels) {
                let cId = String(ch.injected_cat_id || "0");
                let cName = catMap[cId] || "Live";
                let logo = getRealLogo(portalServer, ch.logo, 'itv');
                let name = ch.name || "Unknown";
                res.write(`#EXTINF:-1 tvg-id="" tvg-name="${name}" tvg-logo="${logo}" group-title="${cName} by ᴳᴬᴹᴱᴿᴰᶻ¹⁵¹⁷",${name}\n`);
                res.write(`${fullUrl}/live/${username}/${password}/${ch.id}.ts\n`);
            }
        }

        if (sel.v && sel.v.length > 0) {
            let catRes = await callStalkerDirect(portalServer, stalkerMac, "vod", "get_categories", stalkerToken);
            let catList = catRes?.js ? (Array.isArray(catRes.js) ? catRes.js : Object.values(catRes.js)) : [];
            let catMap = {}; catList.forEach(c => catMap[String(c.id)] = c.title || c.name);

            let vods = await fetchContentStrict(portalServer, stalkerMac, "vod", sel.v, null, stalkerToken);
            for(let v of vods) {
                if(isAdultContent(v.name)) continue;
                let cId = String(v.injected_cat_id || "0");
                let cName = catMap[cId] || "Movies";
                let logo = getRealLogo(portalServer, v.screenshot_uri || v.logo, 'vod');
                let name = v.name || v.cmd;
                res.write(`#EXTINF:-1 tvg-id="" tvg-name="${name}" tvg-logo="${logo}" group-title="${cName} by ᴳᴬᴹᴱᴿᴰᶻ¹⁵¹⁷",${name}\n`);
                res.write(`${fullUrl}/movie/${username}/${password}/${v.id}.mkv\n`);
            }
        }
        res.end();
    } catch(e) { return res.status(500).send("Error generating M3U"); }
});

// 🚀 مسارات Xtream (مع تفعيل الكاش الداخلي 🛡️)
app.all(['/player_api.php', '/panel_api.php', '/xmltv.php'], async (req, res) => {
    let username = (req.query.username || req.body.username || "").trim();
    let password = (req.query.password || req.body.password || "").trim();
    let apiAction = req.query.action || req.body.action || "";
    let categoryId = req.query.category_id || req.body.category_id;
    let seriesId = req.query.series_id || req.body.series_id;

    if (req.path.endsWith("xmltv.php")) return res.type('text/xml').send('<?xml version="1.0" encoding="UTF-8"?><tv></tv>');

    // 🛡️ فحص الكاش الداخلي
    let cacheKey = `xtream_${username}_${apiAction}_${categoryId || 'all'}_${seriesId || 'all'}`;
    if (listsCache.has(cacheKey)) {
        let cached = listsCache.get(cacheKey);
        if (Date.now() - cached.time < 14400000) { 
            return res.json(cached.data);
        }
    }

    let authData = await getAuthDataFromFirebase(password);

    if (!authData || authData.mac.toLowerCase() !== username.toLowerCase()) {
        if (apiAction === "") return res.json({ user_info: { auth: 0, status: "Inactive" } });
        return res.json(safeFallback(apiAction));
    }

    let portalServer = authData.srv;
    let stalkerMac = authData.mac; 
    let sel = authData.selections || { l: [], v: [], s: [] };

    let host = req.headers['x-forwarded-host'] || req.get('host');
    let fullUrl = `http://${host}`;

    try {
        if (apiAction === "") {
            let timeNow = new Date().toISOString().replace('T', ' ').substring(0, 19);
            return res.json({
                user_info: { username: username, password: password, message: "Logged In Successfully", auth: 1, status: "Active", exp_date: "1999999999", is_trial: "0", active_cons: "0", max_connections: "1000", created_at: "1600000000", allowed_output_formats: ["m3u8", "ts", "rtmp", "mkv", "mp4"] },
                server_info: { url: fullUrl, port: "80", https_port: "443", server_protocol: "http", timezone: "Africa/Algiers", timestamp_now: Math.floor(Date.now() / 1000), time_now: timeNow, version: "2.9.0" }
            });
        } 
        
        let handshakeRes = await callStalkerDirect(portalServer, stalkerMac, "stb", "handshake");
        let stalkerToken = handshakeRes?.js?.token;
        if (!stalkerToken) return res.json(safeFallback(apiAction)); 

        let responseData = [];

        if (apiAction === "get_live_categories") {
            let r = await callStalkerDirect(portalServer, stalkerMac, "itv", "get_genres", stalkerToken);
            let list = r?.js ? (Array.isArray(r.js) ? r.js : Object.values(r.js)) : [];
            if (!sel.l.includes('ALL')) list = list.filter(c => sel.l.includes(String(c.id)));
            responseData = list.map(c => ({ category_id: String(c.id), category_name: String(c.title || c.name), parent_id: 0 }));
        } 
        else if (apiAction === "get_vod_categories") {
            let r = await callStalkerDirect(portalServer, stalkerMac, "vod", "get_categories", stalkerToken);
            let list = r?.js ? (Array.isArray(r.js) ? r.js : Object.values(r.js)) : [];
            if (!sel.v.includes('ALL')) list = list.filter(c => sel.v.includes(String(c.id)));
            responseData = list.map(c => ({ category_id: String(c.id), category_name: String(c.title || c.name), parent_id: 0 }));
        } 
        else if (apiAction === "get_series_categories") {
            let r = await callStalkerDirect(portalServer, stalkerMac, "series", "get_categories", stalkerToken).catch(() => ({js:[]}));
            let list = r?.js ? (Array.isArray(r.js) ? r.js : Object.values(r.js)) : [];
            if (!sel.s.includes('ALL')) list = list.filter(c => sel.s.includes(String(c.id)));
            responseData = list.map(c => ({ category_id: String(c.id), category_name: String(c.title || c.name), parent_id: 0 }));
        } 
        else if (apiAction === "get_live_streams") {
            let reqCat = (categoryId && categoryId !== "null" && categoryId !== "*" && categoryId !== "0") ? String(categoryId) : null;
            if (reqCat && !sel.l.includes('ALL') && !sel.l.includes(reqCat)) return res.json([]);
            let channels = await fetchContentStrict(portalServer, stalkerMac, "itv", sel.l, categoryId, stalkerToken);
            
            responseData = channels.map(ch => ({
                num: parseInt(ch.number || ch.id) || 0, name: String(ch.name || "Unknown"), stream_type: "live", stream_id: parseInt(ch.id) || 0, 
                stream_icon: getRealLogo(portalServer, ch.logo, 'itv'), 
                epg_channel_id: null, added: "1600000000", category_id: String(ch.injected_cat_id || "0"), custom_sid: "", tv_archive: parseInt(ch.tv_archive) || 0, direct_source: "", tv_archive_duration: parseInt(ch.tv_archive_duration) || 0
            }));
        } 
        else if (apiAction === "get_vod_streams") {
            let reqCat = (categoryId && categoryId !== "null" && categoryId !== "*" && categoryId !== "0") ? String(categoryId) : null;
            if (reqCat && !sel.v.includes('ALL') && !sel.v.includes(reqCat)) return res.json([]);
            let vods = await fetchContentStrict(portalServer, stalkerMac, "vod", sel.v, categoryId, stalkerToken);
            
            responseData = vods.filter(v => !isAdultContent(v.name)).map(v => ({
                num: parseInt(v.id) || 0, name: String(v.name || v.cmd), stream_type: "movie", stream_id: parseInt(v.id) || 0, 
                stream_icon: getRealLogo(portalServer, v.screenshot_uri || v.logo, 'vod'),
                added: "1600000000", category_id: String(v.injected_cat_id || "0"), container_extension: "mkv", rating: String(v.rating || "5"), rating_5based: 5.0, custom_sid: "", direct_source: ""
            }));
        } 
        else if (apiAction === "get_series") {
            let reqCat = (categoryId && categoryId !== "null" && categoryId !== "*" && categoryId !== "0") ? String(categoryId) : null;
            if (reqCat && !sel.s.includes('ALL') && !sel.s.includes(reqCat)) return res.json([]);
            let series = await fetchContentStrict(portalServer, stalkerMac, "series", sel.s, categoryId, stalkerToken);
            
            responseData = series.filter(s => !isAdultContent(s.name)).map(s => ({
                num: parseInt(s.id) || 0, name: String(s.name), series_id: parseInt(s.id) || 0, 
                cover: getRealLogo(portalServer, s.screenshot_uri || s.logo, 'series'),
                category_id: String(s.injected_cat_id || "0"), plot: "", cast: "", director: "", genre: "", releaseDate: "", last_modified: "1600000000", rating: "5", rating_5based: 5.0, backdrop_path: [], youtube_trailer: "", episode_run_time: "0"
            }));
        }
        else if (apiAction === "get_series_info" && seriesId) {
            try {
                let data = await fetchContentStrict(portalServer, stalkerMac, "series", ['ALL'], null, stalkerToken, `&movie_id=${seriesId}&season_id=0&episode_id=0`);
                let seasonsInfo = []; let epsObj = {}; let seasonIndex = 1;
                
                if (data.length > 0) {
                    for (let season of data) {
                        let seasonCmd = season.cmd;
                        if (!seasonCmd) continue;
                        let episodesArr = season.series; 
                        if (!Array.isArray(episodesArr) || episodesArr.length === 0) continue;
                        
                        let sNum = String(season.season || seasonIndex);
                        if (!epsObj[sNum]) epsObj[sNum] = [];
                        
                        for (let ep of episodesArr) {
                            let episodeNum = String(ep);
                            let streamIdRaw = encodeSafeBase64(`${seasonCmd}::::${episodeNum}`);
                            
                            epsObj[sNum].push({ 
                                id: streamIdRaw, episode_num: parseInt(episodeNum) || 0, title: `Episode ${episodeNum}`, container_extension: "mkv", 
                                info: { movie_image: getRealLogo(portalServer, season.screenshot_uri || season.cover, 'series'), plot: "", releasedate: "", rating: "5", rating_5based: 5.0, duration_secs: 0, duration: "" }, 
                                custom_sid: "", added: "1600000000", season: parseInt(sNum), direct_source: "" 
                            });
                        }
                        seasonsInfo.push({ air_date: "", episode_count: episodesArr.length, id: parseInt(sNum), name: `Season ${sNum}`, overview: "", season_number: parseInt(sNum), cover: "", cover_big: "" });
                        seasonIndex++;
                    }
                }
                if (seasonsInfo.length === 0) { seasonsInfo.push({ air_date: "", episode_count: 0, id: 1, name: "Season 1", overview: "", season_number: 1, cover: "", cover_big: "" }); epsObj["1"] = []; }
                responseData = { seasons: seasonsInfo, episodes: epsObj, info: { name: "GAMERDZ Series", cover: "", plot: "", cast: "", director: "", genre: "", releaseDate: "", rating: "5", rating_5based: 5.0, backdrop_path: [] } };
            } catch(e) { responseData = safeFallback("get_series_info"); }
        }
        else if (apiAction === "get_short_epg" || apiAction === "get_simple_data_table") {
            responseData = { epg_listings: [] };
        }

        // 🛡️ حفظ النتيجة في الكاش
        if (apiAction !== "") {
            listsCache.set(cacheKey, { data: responseData, time: Date.now() });
        }

        return res.json(responseData);
    } catch (e) { return res.json(safeFallback(apiAction)); }
});

// 🚀 مسار سحب الفيديو لتطبيقات Xtream و المضاف له ترويسات CORS الكاملة - الكود الأصلي الذي يعمل
app.get(['/live/:user/:pass/:stream', '/movie/:user/:pass/:stream', '/series/:user/:pass/:stream', '/:user/:pass/:stream'], async (req, res) => {
    const type = req.path.split('/')[1] || "live";
    const username = decodeURIComponent(req.params.user).trim();
    const reqPass = decodeURIComponent(req.params.pass).trim();
    let streamId = req.params.stream; if (streamId.includes('.')) streamId = streamId.split('.')[0];
    let use_worker = req.query.use_worker;

    let authData = await getAuthDataFromFirebase(reqPass);
    if (!authData || authData.mac.toLowerCase() !== username.toLowerCase()) return res.status(403).send("Unauthorized");

    let server = authData.srv;
    let stalkerMac = authData.mac; 

    try {
        let finalStreamUrl = "";

        if (type === "movie") {
            finalStreamUrl = `${server}/play/movie.php?mac=${stalkerMac}&stream=${streamId}.mkv&type=${type}`;
        } 
        else if (type === "series") {
            let actualId = streamId;
            let playToken = "";
            try {
                let decodedId = decodeSafeBase64(streamId);
                if (decodedId.includes("::::")) actualId = decodedId.split("::::")[0];
            } catch(e) {}

            if (actualId.includes("-")) {
                let idx = actualId.indexOf("-");
                playToken = actualId.substring(idx + 1);
                actualId = actualId.substring(0, idx);
            }

            finalStreamUrl = `${server}/play/movie.php?mac=${stalkerMac}&stream=${actualId}.mkv&type=series`;
            if (playToken) finalStreamUrl += `&play_token=${playToken}`;
        } 
        else {
            finalStreamUrl = `${server}/play/live.php?mac=${stalkerMac}&stream=${streamId}&extension=ts`;
            const handshakeRes = await callStalkerDirect(server, stalkerMac, "stb", "handshake");
            const stalkerToken = handshakeRes?.js?.token;
            if (!stalkerToken) return res.status(403).send("MAC Blocked");

            let cmd = encodeURIComponent(`ffmpeg localhost/ch/${streamId}`);
            let linkRes = await callStalkerDirect(server, stalkerMac, "itv", `create_link&cmd=${cmd}`, stalkerToken);
            if (linkRes?.js?.cmd && !linkRes.js.cmd.includes('.m3u8')) {
                finalStreamUrl = linkRes.js.cmd.startsWith('ffmpeg ') ? linkRes.js.cmd.split(' ').pop() : linkRes.js.cmd;
            }
        }

        if (!finalStreamUrl) return res.status(404).send("Stream Not Found");

        // 🌟 الميزة الاختيارية للـ Worker
        if (use_worker === '1') {
            let workerProxyUrl = `${CLOUDFLARE_WORKER_URL}/?url=${encodeURIComponent(finalStreamUrl)}`;
            return res.redirect(workerProxyUrl);
        }

        // الكود الأصلي الذي يعمل لديك باستخدام Pipe
        const reqHeaders = { 
            "User-Agent": "VLC/3.0.9 LibVLC/3.0.9", 
            "Accept": "*/*",
            "Connection": "keep-alive"
        };
        
        if (req.headers.range) reqHeaders["Range"] = req.headers.range;

        const fetchRes = await fetch(finalStreamUrl, {
            headers: reqHeaders,
            redirect: 'follow',
            timeout: 0
        });

        if (!fetchRes.ok && fetchRes.status !== 206) return res.status(fetchRes.status).send("Stream Error");

        res.status(fetchRes.status);
        
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Range, Accept-Ranges');
        res.setHeader('Access-Control-Expose-Headers', 'Content-Range, Accept-Ranges, Content-Length, Content-Type');
        
        const headersToForward = ['content-type', 'content-length', 'content-range', 'accept-ranges'];
        headersToForward.forEach(h => {
            if (fetchRes.headers.has(h)) res.setHeader(h, fetchRes.headers.get(h));
        });

        if (!res.getHeader('Content-Type')) {
            res.setHeader('Content-Type', (type === "live" ? 'video/mp2t' : 'video/mp4'));
        }
        
        fetchRes.body.pipe(res);

        fetchRes.body.on('error', (err) => res.end());
        req.on('close', () => {
            if (fetchRes.body && typeof fetchRes.body.destroy === 'function') fetchRes.body.destroy();
        });

    } catch(e) { 
        return res.status(500).send("Bridge Error"); 
    }
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
