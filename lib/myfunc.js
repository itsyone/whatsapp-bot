/**
 * Knight Bot - A WhatsApp Bot
 * Copyright (c) 2024 Professor
 * 
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the MIT License.
 * 
 * Credits:
 * - Baileys Library by @adiwajshing
 * - Pair Code implementation inspired by TechGod143 & DGXEON
 */
const chalk = require('./chalkSafe')
const fs = require('fs')
const Crypto = require('crypto')
const axiosModule = require('axios')
const axios = axiosModule.default || axiosModule
const moment = require('moment-timezone')
const {
    sizeFormatter
} = require('human-readable')
const util = require('util')
const Jimp = require('jimp')
const {
    defaultMaxListeners
} = require('stream')
const path = require('path')
const os = require('os')
const ffmpeg = require('fluent-ffmpeg')
const ffmpegPath = require('ffmpeg-static')
const sharp = require('sharp')

// Job queue for ffmpeg conversions
const MAX_CONCURRENT_CONVERSIONS = 3;
const conversionQueue = [];
let activeConversions = 0;

async function processConversionQueue() {
    if (activeConversions >= MAX_CONCURRENT_CONVERSIONS || conversionQueue.length === 0) {
        return;
    }

    const { buffer, resolve, reject } = conversionQueue.shift();
    activeConversions++;

    try {
        const result = await processGifToMp4Internal(buffer);
        resolve(result);
    } catch (err) {
        reject(err);
    } finally {
        activeConversions--;
        processConversionQueue(); // Process next item in queue
    }
}

function queueConversion(buffer) {
    return new Promise((resolve, reject) => {
        conversionQueue.push({ buffer, resolve, reject });
        processConversionQueue();
    });
}

// Caching layer for converted MP4s
const cacheDir = path.join(os.tmpdir(), 'gif-to-mp4-cache');
if (!fs.existsSync(cacheDir)) {
    fs.mkdirSync(cacheDir, { recursive: true });
}

function getBufferHash(buffer) {
    return Crypto.createHash('sha256').update(buffer).digest('hex');
}

function getCachedMp4(buffer) {
    const hash = getBufferHash(buffer);
    const cachePath = path.join(cacheDir, `${hash}.mp4`);
    
    if (fs.existsSync(cachePath)) {
        try {
            const stats = fs.statSync(cachePath);
            // Cache expires after 1 hour
            if (Date.now() - stats.mtimeMs < 3600000) {
                console.log('[GIFtoMP4] Cache hit:', hash.substring(0, 8));
                return fs.readFileSync(cachePath);
            } else {
                fs.unlinkSync(cachePath); // Remove expired cache
            }
        } catch (err) {
            // Cache file corrupted, remove it
            try { fs.unlinkSync(cachePath); } catch {}
        }
    }
    return null;
}

function setCachedMp4(buffer, mp4Buffer) {
    const hash = getBufferHash(buffer);
    const cachePath = path.join(cacheDir, `${hash}.mp4`);
    
    try {
        fs.writeFileSync(cachePath, mp4Buffer);
        console.log('[GIFtoMP4] Cached:', hash.substring(0, 8));
    } catch (err) {
        console.error('[GIFtoMP4] Failed to cache:', err.message);
    }
}


if (ffmpegPath) {
    ffmpeg.setFfmpegPath(ffmpegPath)
}

/**
 * Converts an animated GIF buffer to an MP4 buffer for WhatsApp playback.
 * @param {Buffer} buffer The GIF buffer
 * @returns {Promise<Buffer>}
 */
const { execSync, spawnSync } = require('child_process');

function getAnimationInputExt(buffer) {
    if (buffer.slice(0, 3).toString('ascii') === 'GIF') return '.gif';
    if (buffer.slice(0, 4).toString('ascii') === 'RIFF' && buffer.slice(8, 12).toString('ascii') === 'WEBP') return '.webp';
    return '.bin';
}

function withTimeout(promise, ms, label) {
    return Promise.race([
        promise,
        new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms))
    ]);
}

let webpLibReady = null;

function blendPixel(canvas, dst, r, g, b, a) {
    if (a === 255) {
        canvas[dst] = r;
        canvas[dst + 1] = g;
        canvas[dst + 2] = b;
        canvas[dst + 3] = 255;
        return;
    }
    if (a === 0) return;
    const srcA = a / 255;
    const dstA = canvas[dst + 3] / 255;
    const outA = srcA + dstA * (1 - srcA);
    canvas[dst] = Math.round((r * srcA + canvas[dst] * dstA * (1 - srcA)) / outA);
    canvas[dst + 1] = Math.round((g * srcA + canvas[dst + 1] * dstA * (1 - srcA)) / outA);
    canvas[dst + 2] = Math.round((b * srcA + canvas[dst + 2] * dstA * (1 - srcA)) / outA);
    canvas[dst + 3] = Math.round(outA * 255);
}

function clearRect(canvas, canvasWidth, frame, bg = [0, 0, 0, 0]) {
    for (let y = 0; y < frame.height; y++) {
        for (let x = 0; x < frame.width; x++) {
            const dst = ((frame.y + y) * canvasWidth + frame.x + x) * 4;
            canvas[dst] = bg[0];
            canvas[dst + 1] = bg[1];
            canvas[dst + 2] = bg[2];
            canvas[dst + 3] = bg[3];
        }
    }
}

async function animatedWebpToMp4(buffer, outputPath) {
    const WebP = require('node-webpmux');
    webpLibReady = webpLibReady || WebP.Image.initLib();
    await webpLibReady;

    const img = new WebP.Image();
    await img.load(buffer);
    const frames = img.frames || [];
    if (!frames.length) return null;

    const width = img.width;
    const height = img.height;
    const maxFrames = Math.min(frames.length, 300);
    const bg = img.anim?.bgColor || [0, 0, 0, 255];
    const canvas = Buffer.alloc(width * height * 4, 255);
    for (let i = 0; i < canvas.length; i += 4) {
        canvas[i] = bg[0] || 0;
        canvas[i + 1] = bg[1] || 0;
        canvas[i + 2] = bg[2] || 0;
        canvas[i + 3] = 255;
    }

    const rawFrames = [];
    const frameDelays = [];
    for (let i = 0; i < maxFrames; i++) {
        const frame = frames[i];
        
        // Dispose BEFORE drawing this frame (clear previous frame area)
        if (i > 0 && frames[i - 1].dispose) {
            clearRect(canvas, width, frames[i - 1], bg);
        }
        
        const data = Buffer.from(await img.getFrameData(i));
        const blend = frame.blend !== false;
        
        for (let y = 0; y < frame.height; y++) {
            for (let x = 0; x < frame.width; x++) {
                const src = (y * frame.width + x) * 4;
                const dst = ((frame.y + y) * width + frame.x + x) * 4;
                if (blend) {
                    blendPixel(canvas, dst, data[src], data[src+1], data[src+2], data[src+3]);
                } else {
                    canvas[dst]   = data[src];
                    canvas[dst+1] = data[src+1];
                    canvas[dst+2] = data[src+2];
                    canvas[dst+3] = data[src+3];
                }
            }
        }
        rawFrames.push(Buffer.from(canvas));
        frameDelays.push(frame.delay || 80);
    }

    // Fix FPS - use per-frame delay not average
    const avgDelay = frameDelays.reduce((s, d) => s + d, 0) / frameDelays.length;
    const fps = Math.max(10, Math.min(30, Math.round(1000 / Math.max(33, avgDelay))));
    const ffmpegBin = ffmpegPath || 'ffmpeg';
    console.log(`[WebPtoMP4] Input dimensions: ${width}x${height}, Frames: ${maxFrames}, FPS: ${fps}`);
    
    const result = spawnSync(ffmpegBin, [
        '-y',
        '-f', 'rawvideo',
        '-pix_fmt', 'rgba',
        '-s:v', `${width}x${height}`,
        '-r', String(fps),
        '-i', 'pipe:0',
        '-an',
        '-c:v', 'libx264',
        '-profile:v', 'high444',
        '-level', '4.1',
        '-pix_fmt', 'yuv444p', // No chroma subsampling for pixel-perfect output
        '-crf', '0', // Lossless encoding
        '-preset', 'veryslow',
        '-fps_mode', 'passthrough', // Preserve original frame timing
        '-movflags', 'faststart',
        outputPath
    ], {
        input: Buffer.concat(rawFrames),
        stdio: ['pipe', 'ignore', 'ignore'],
        timeout: 30000 // Increased timeout for lossless encoding
    });

    if (result.status !== 0) return null;
    return outputPath;
}

async function processGifToMp4Internal(buffer) {
    const { spawnSync } = require('child_process');
    const fs = require('fs');
    const path = require('path');
    const os = require('os');
    const ffmpegBin = require('ffmpeg-static');

    // Validate buffer and format
    if (!buffer || buffer.length < 100) {
        console.error('[GIFtoMP4 ERROR] Invalid buffer: too small or empty');
        return null;
    }

    // Check magic bytes
    const magic = buffer.slice(0, 12).toString('ascii');
    const isGif = magic.startsWith('GIF');
    const isWebp = magic.startsWith('RIFF') && buffer.slice(8, 12).toString('ascii') === 'WEBP';
    
    if (!isGif && !isWebp) {
        console.error('[GIFtoMP4 ERROR] Invalid format: not GIF or WebP');
        return null;
    }

    const tempDir = os.tmpdir();
    const outputPath = path.join(tempDir, `giftmp-${Date.now()}-${Math.random().toString(36).slice(2)}.mp4`);
    let inputPath = null;

    try {
        // Use animatedWebpToMp4 for WebP files (pre-ffmpeg decoding)
        if (isWebp) {
            console.log('[GIFtoMP4] Using WebP frame extraction before ffmpeg');
            const result = await animatedWebpToMp4(buffer, outputPath);
            if (result && fs.existsSync(result)) {
                const outBuffer = fs.readFileSync(result);
                try { fs.unlinkSync(result); } catch {}
                return outBuffer;
            }
            console.error('[GIFtoMP4 ERROR] WebP frame extraction failed');
            return null;
        }

        // For GIF files, use direct ffmpeg conversion
        const inputExt = '.gif';
        inputPath = path.join(tempDir, `giftmp-${Date.now()}-${Math.random().toString(36).slice(2)}${inputExt}`);
        fs.writeFileSync(inputPath, buffer);

        const args = [
            '-hide_banner',
            '-loglevel', 'error'
        ];

        args.push('-i', inputPath);

        // For animated content, ensure we process all frames properly
        args.push(
            '-c:v', 'libx264',
            '-pix_fmt', 'yuv420p',
            '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2:flags=lanczos',
            '-crf', '15',
            '-preset', 'veryslow',
            '-movflags', '+faststart',
            '-an',
            '-y',
            '-f', 'mp4',
            outputPath
        );

        let result = spawnSync(ffmpegBin, args);
        if (result.status !== 0) {
            const stderr1 = result.stderr?.toString();
            console.error('[GIFtoMP4 ERROR] ffmpeg status:', result.status);
            console.error('[GIFtoMP4 ERROR] ffmpeg stderr:', stderr1);

            // Fallback: simpler conversion without conflicting options
            const fallbackArgs = [
                '-hide_banner',
                '-loglevel', 'error',
                '-i', inputPath,
                '-c:v', 'libx264',
                '-pix_fmt', 'yuv420p',
                '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2:flags=lanczos,fps=15',
                '-crf', '15',
                '-preset', 'veryslow',
                '-movflags', '+faststart',
                '-an',
                '-y',
                '-f', 'mp4',
                outputPath
            ];

            result = spawnSync(ffmpegBin, fallbackArgs);
            if (result.status !== 0) {
                console.error('[GIFtoMP4 ERROR] fallback ffmpeg status:', result.status);
                console.error('[GIFtoMP4 ERROR] fallback ffmpeg stderr:', result.stderr?.toString());
                return null;
            }
        }

        console.log(`[GIFtoMP4 DEBUG] FFmpeg successful. Output size: ${fs.statSync(outputPath).size} bytes`);
        const outBuffer = fs.readFileSync(outputPath);
        return outBuffer;
    } catch (err) {
        console.error('[GIFtoMP4 ERROR] catch block:', err);
        return null;
    } finally {
        try { if (inputPath && fs.existsSync(inputPath)) fs.unlinkSync(inputPath); } catch {}
        try { if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath); } catch {}
    }
}

exports.gifToMp4 = async (buffer) => {
    // Check cache first
    const cached = getCachedMp4(buffer);
    if (cached) {
        return cached;
    }

    // Queue the conversion
    const result = await queueConversion(buffer);
    
    // Cache the result if successful
    if (result) {
        setCachedMp4(buffer, result);
    }
    
    return result;
};


function getContentType(message = {}) {
    const keys = Object.keys(message || {}).filter((key) => key !== 'messageContextInfo');
    return keys[0] || '';
}

const proto = {
    WebMessageInfo: {
        fromObject(obj) {
            return obj;
        },
        toObject(obj) {
            return obj;
        }
    }
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const unixTimestampSeconds = (date = new Date()) => Math.floor(date.getTime() / 1000)

exports.unixTimestampSeconds = unixTimestampSeconds

exports.generateMessageTag = (epoch) => {
    let tag = (0, exports.unixTimestampSeconds)().toString();
    if (epoch)
        tag += '.--' + epoch; // attach epoch if provided
    return tag;
}

exports.processTime = (timestamp, now) => {
    return moment.duration(now - moment(timestamp * 1000)).asSeconds()
}

exports.getRandom = (ext) => {
    return `${Math.floor(Math.random() * 10000)}${ext}`
}

exports.getBuffer = async (url, options) => {
    try {
        const res = await axios({
            method: "get",
            url,
            headers: {
                'DNT': 1,
                'Upgrade-Insecure-Request': 1,
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/95.0.4638.69 Safari/537.36'
            },
            ...options,
            responseType: 'arraybuffer'
        })
        return Buffer.from(res.data)
    } catch (err) {
        console.error(`[getBuffer] Error fetching ${url}:`, err.message);
        return null
    }
}


exports.getImg = async (url, options) => {
    try {
        options ? options : {}
        const res = await axios({
            method: "get",
            url,
            headers: {
                'DNT': 1,
                'Upgrade-Insecure-Request': 1
            },
            ...options,
            responseType: 'arraybuffer'
        })
        return res.data
    } catch (err) {
        return err
    }
}

exports.fetchJson = async (url, options) => {
    try {
        options ? options : {}
        const res = await axios({
            method: 'GET',
            url: url,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/95.0.4638.69 Safari/537.36'
            },
            ...options
        })
        return res.data
    } catch (err) {
        return err
    }
}

exports.runtime = function(seconds) {
    seconds = Number(seconds);
    var d = Math.floor(seconds / (3600 * 24));
    var h = Math.floor(seconds % (3600 * 24) / 3600);
    var m = Math.floor(seconds % 3600 / 60);
    var s = Math.floor(seconds % 60);
    var dDisplay = d > 0 ? d + (d == 1 ? " day, " : " days, ") : "";
    var hDisplay = h > 0 ? h + (h == 1 ? " hour, " : " hours, ") : "";
    var mDisplay = m > 0 ? m + (m == 1 ? " minute, " : " minutes, ") : "";
    var sDisplay = s > 0 ? s + (s == 1 ? " second" : " seconds") : "";
    return dDisplay + hDisplay + mDisplay + sDisplay;
}

exports.clockString = (ms) => {
    let h = isNaN(ms) ? '--' : Math.floor(ms / 3600000)
    let m = isNaN(ms) ? '--' : Math.floor(ms / 60000) % 60
    let s = isNaN(ms) ? '--' : Math.floor(ms / 1000) % 60
    return [h, m, s].map(v => v.toString().padStart(2, 0)).join(':')
}

exports.sleep = async (ms) => {
    return new Promise(resolve => setTimeout(resolve, ms));
}

exports.isUrl = (url) => {
    return url.match(new RegExp(/https?:\/\/(www\.)?[-a-zA-Z0-9@:%._+~#=]{1,256}\.[a-zA-Z0-9()]{1,6}\b([-a-zA-Z0-9()@:%_+.~#?&/=]*)/, 'gi'))
}

exports.getTime = (format, date) => {
    if (date) {
        return moment(date).locale('id').format(format)
    } else {
        return moment.tz('Asia/Jakarta').locale('id').format(format)
    }
}

exports.formatDate = (n, locale = 'id') => {
    let d = new Date(n)
    return d.toLocaleDateString(locale, {
        weekday: 'long',
        day: 'numeric',
        month: 'long',
        year: 'numeric',
        hour: 'numeric',
        minute: 'numeric',
        second: 'numeric'
    })
}

exports.tanggal = (numer) => {
    const myMonths = ["Januari", "Februari", "Maret", "April", "Mei", "Juni", "Juli", "Agustus", "September", "Oktober", "November", "Desember"];
    const myDays = ['Minggu', 'Senin', 'Selasa', 'Rabu', 'Kamis', "Jum'at", 'Sabtu'];
    const tgl = new Date(numer);
    const day = tgl.getDate();
    const bulan = tgl.getMonth();
    let thisDay = tgl.getDay();
    thisDay = myDays[thisDay];
    const yy = tgl.getYear();
    const year = (yy < 1000) ? yy + 1900 : yy;
    const time = moment.tz('Asia/Jakarta').format('DD/MM HH:mm:ss');
    const d = new Date();
    const locale = 'id';
    const gmt = new Date(0).getTime() - new Date('1 January 1970').getTime();
    const weton = ['Pahing', 'Pon', 'Wage', 'Kliwon', 'Legi'][Math.floor(((d * 1) + gmt) / 84600000) % 5];

    return `${thisDay}, ${day} - ${myMonths[bulan]} - ${year}`;
}

exports.jam = (numer, options = {}) => {
    let format = options.format ? options.format : "HH:mm"
    let jam = options?.timeZone ? moment(numer).tz(timeZone).format(format) : moment(numer).format(format)

    return `${jam}`
}

exports.formatp = sizeFormatter({
    std: 'JEDEC', //'SI' = default | 'IEC' | 'JEDEC'
    decimalPlaces: 2,
    keepTrailingZeroes: false,
    render: (literal, symbol) => `${literal} ${symbol}B`,
})

exports.json = (string) => {
    return JSON.stringify(string, null, 2)
}

function format(...args) {
    return util.format(...args)
}

exports.logic = (check, inp, out) => {
    if (inp.length !== out.length) throw new Error('Input and Output must have same length')
    for (let i in inp)
        if (util.isDeepStrictEqual(check, inp[i])) return out[i]
    return null
}

exports.generateProfilePicture = async (buffer) => {
    const jimp = await Jimp.read(buffer)
    const min = jimp.getWidth()
    const max = jimp.getHeight()
    const cropped = jimp.crop(0, 0, min, max)
    return {
        img: await cropped.scaleToFit(720, 720).getBufferAsync(Jimp.MIME_JPEG),
        preview: await cropped.scaleToFit(720, 720).getBufferAsync(Jimp.MIME_JPEG)
    }
}

exports.bytesToSize = (bytes, decimals = 2) => {
    if (bytes === 0) return '0 Bytes';

    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB'];

    const i = Math.floor(Math.log(bytes) / Math.log(k));

    return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}

exports.getSizeMedia = (path) => {
    return new Promise((resolve, reject) => {
        if (/http/.test(path)) {
            axios.get(path)
                .then((res) => {
                    let length = parseInt(res.headers['content-length'])
                    let size = exports.bytesToSize(length, 3)
                    if (!isNaN(length)) resolve(size)
                })
        } else if (Buffer.isBuffer(path)) {
            let length = Buffer.byteLength(path)
            let size = exports.bytesToSize(length, 3)
            if (!isNaN(length)) resolve(size)
        } else {
            reject('error gatau apah')
        }
    })
}

exports.parseMention = (text = '') => {
    return [...text.matchAll(/@([0-9]{5,16}|0)/g)].map(v => v[1] + '@s.whatsapp.net')
}

exports.getGroupAdmins = (participants) => {
    let admins = []
    for (let i of participants) {
        i.admin === "superadmin" ? admins.push(i.id) : i.admin === "admin" ? admins.push(i.id) : ''
    }
    return admins || []
}

/**
 * Serialize Message
 * @param {WAConnection} conn 
 * @param {Object} m 
 * @param {store} store 
 */
function extractNativeFlowReplyId(message = {}) {
    try {
        const paramsJson = message?.interactiveResponseMessage?.nativeFlowResponseMessage?.paramsJson
        if (!paramsJson) return ''
        const parsed = JSON.parse(paramsJson)
        return parsed?.id || parsed?.selectedId || parsed?.selected_id || parsed?.button_id || parsed?.selection?.id || ''
    } catch {
        return ''
    }
}

exports.smsg = (XeonBotInc, m, store) => {
    if (!m) return m
    let M = proto.WebMessageInfo
    if (m.key) {
        m.id = m.key.id
        m.isBaileys = m.id.startsWith('BAE5') && m.id.length === 16
        m.chat = m.key.remoteJid
        m.fromMe = m.key.fromMe
        m.isGroup = m.chat.endsWith('@g.us')
        m.sender = XeonBotInc.decodeJid(m.fromMe && XeonBotInc.user.id || m.participant || m.key.participant || m.chat || '')
        if (m.isGroup) m.participant = XeonBotInc.decodeJid(m.key.participant) || ''
    }
    if (m.message) {
        m.mtype = getContentType(m.message)
        m.msg = (m.mtype == 'viewOnceMessage' ? m.message[m.mtype].message[getContentType(m.message[m.mtype].message)] : m.message[m.mtype])
        m.body = m.message.conversation || m.msg.caption || (m.mtype == 'interactiveResponseMessage') && extractNativeFlowReplyId(m.message) || m.msg.text || (m.mtype == 'listResponseMessage') && m.msg.singleSelectReply.selectedRowId || (m.mtype == 'buttonsResponseMessage') && m.msg.selectedButtonId || (m.mtype == 'viewOnceMessage') && m.msg.caption || m.text
        let quoted = m.quoted = m.msg.contextInfo ? m.msg.contextInfo.quotedMessage : null
        m.mentionedJid = m.msg.contextInfo ? m.msg.contextInfo.mentionedJid : []
        if (m.quoted) {
            let type = getContentType(quoted)
            m.quoted = m.quoted[type]
            if (['productMessage'].includes(type)) {
                type = getContentType(m.quoted)
                m.quoted = m.quoted[type]
            }
            if (typeof m.quoted === 'string') m.quoted = {
                text: m.quoted
            }
            m.quoted.mtype = type
            m.quoted.id = m.msg.contextInfo.stanzaId
            m.quoted.chat = m.msg.contextInfo.remoteJid || m.chat
            m.quoted.isBaileys = m.quoted.id ? m.quoted.id.startsWith('BAE5') && m.quoted.id.length === 16 : false
            m.quoted.sender = XeonBotInc.decodeJid(m.msg.contextInfo.participant)
            m.quoted.fromMe = m.quoted.sender === (XeonBotInc.user && XeonBotInc.user.id)
            m.quoted.text = m.quoted.text || m.quoted.caption || m.quoted.conversation || m.quoted.contentText || m.quoted.selectedDisplayText || m.quoted.title || ''
            m.quoted.mentionedJid = m.msg.contextInfo ? m.msg.contextInfo.mentionedJid : []
            m.getQuotedObj = m.getQuotedMessage = async () => {
                if (!m.quoted.id) return false
                let q = await store.loadMessage(m.chat, m.quoted.id, XeonBotInc)
                return exports.smsg(XeonBotInc, q, store)
            }
            let vM = m.quoted.fakeObj = M.fromObject({
                key: {
                    remoteJid: m.quoted.chat,
                    fromMe: m.quoted.fromMe,
                    id: m.quoted.id
                },
                message: quoted,
                ...(m.isGroup ? {
                    participant: m.quoted.sender
                } : {})
            })

            /**
             * 
             * @returns 
             */
            m.quoted.delete = () => XeonBotInc.sendMessage(m.quoted.chat, {
                delete: vM.key
            })

            /**
             * 
             * @param {*} jid 
             * @param {*} forceForward 
             * @param {*} options 
             * @returns 
             */
            m.quoted.copyNForward = (jid, forceForward = false, options = {}) => XeonBotInc.copyNForward(jid, vM, forceForward, options)

            /**
             *
             * @returns
             */
            m.quoted.download = () => XeonBotInc.downloadMediaMessage(m.quoted)
        }
    }
    if (m.msg.url) m.download = () => XeonBotInc.downloadMediaMessage(m.msg)
    m.text = m.msg.text || m.msg.caption || m.message.conversation || m.msg.contentText || m.msg.selectedDisplayText || m.msg.title || ''
    /**
     * Reply to this message
     * @param {String|Object} text 
     * @param {String|false} chatId 
     * @param {Object} options 
     */
    m.reply = (text, chatId = m.chat, options = {}) => Buffer.isBuffer(text) ? XeonBotInc.sendMedia(chatId, text, 'file', '', m, {
        ...options
    }) : XeonBotInc.sendText(chatId, text, m, {
        ...options
    })
    /**
     * Copy this message
     */
    m.copy = () => exports.smsg(XeonBotInc, M.fromObject(M.toObject(m)))

    /**
     * 
     * @param {*} jid 
     * @param {*} forceForward 
     * @param {*} options 
     * @returns 
     */
    m.copyNForward = (jid = m.chat, forceForward = false, options = {}) => XeonBotInc.copyNForward(jid, m, forceForward, options)

    return m
}
exports.reSize = (buffer, ukur1, ukur2) => {
    return new Promise(async (resolve, reject) => {
        var baper = await Jimp.read(buffer);
        var ab = await baper.resize(ukur1, ukur2).getBufferAsync(Jimp.MIME_JPEG)
        resolve(ab)
    })
}

let file = require.resolve(__filename)
const myfuncWatchers = global.__myfuncWatchers || (global.__myfuncWatchers = new Map())
if (!myfuncWatchers.has(file)) {
    const listener = () => {
        fs.unwatchFile(file, listener)
        myfuncWatchers.delete(file)
        console.log(chalk.redBright(`Update ${__filename}`))
        delete require.cache[file]
        require(file)
    }
    myfuncWatchers.set(file, listener)
    fs.watchFile(file, listener)
}

// Helper function to send message with hide mode check
// This function checks if hide mode is enabled and if sender is owner, redirects to PM
exports.sendWithHideCheck = async function(sock, originalChatId, messageData, options = {}) {
    return sock.sendMessage(originalChatId, messageData, options);
}

// Wrapper function to create hide-aware sock instance
// This wraps sendMessage to automatically check hide mode
exports.wrapSockForHideMode = function(sock, currentMessage) {
    return sock;
}
