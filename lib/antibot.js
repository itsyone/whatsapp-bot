const fs = require('fs');
const path = require('path');

const DATA_PATH = path.join(process.cwd(), 'data', 'antibot.json');
const burstTracker = new Map();
const duplicateTracker = new Map();
const timingTracker = new Map();
const entropyHistory = new Map();
const clientRuntime = new Map();

const LEVELS = [
    { min: 85, level: 'CONFIRMED' },
    { min: 70, level: 'WARN' },
    { min: 50, level: 'SUSPECT' },
    { min: 25, level: 'MONITOR' },
    { min: 0, level: 'CLEAN' }
];

const WEIGHTS = {
    massForward: 25,
    emptyDeviceList: 15,
    fakeAdReply: 20,
    userAgentMatch: 30,
    massMention: 15,
    interactivePayload: 10,
    browserConnectNotice: 25,
    sequentialDigits: 10,
    shortNumber: 8,
    lidSuffix: 5,
    burstSpam: 20,
    tooRegular: 18,
    lowEntropy: 22,
    repetitiveVocab: 18,
    templatedText: 12,
    repeatedLength: 10,
    duplicateSpam: 18
};

const USER_AGENT_SIGNATURES = [
    { type: 'Baileys', re: /baileys/i, confidence: 0.85 },
    { type: 'whatsapp-web.js', re: /whatsapp-web/i, confidence: 0.8 },
    { type: 'WPPConnect', re: /wppconnect/i, confidence: 0.78 },
    { type: 'Go client', re: /\bgo[-\s]?whatsapp\b/i, confidence: 0.75 }
];

function ensureStore() {
    const dir = path.dirname(DATA_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    if (!fs.existsSync(DATA_PATH)) {
        fs.writeFileSync(DATA_PATH, JSON.stringify(defaultStore(), null, 2), 'utf8');
    }
}

function defaultStore() {
    return {
        groups: {},
        warnings: {},
        clients: {},
        whitelist: [],
        blacklist: [],
        stats: {
            totalScanned: 0,
            detected: 0
        }
    };
}

function loadStore() {
    ensureStore();
    try {
        const parsed = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));
        return {
            ...defaultStore(),
            ...(parsed || {}),
            groups: parsed?.groups && typeof parsed.groups === 'object' ? parsed.groups : {},
            warnings: parsed?.warnings && typeof parsed.warnings === 'object' ? parsed.warnings : {},
            clients: parsed?.clients && typeof parsed.clients === 'object' ? parsed.clients : {},
            whitelist: Array.isArray(parsed?.whitelist) ? parsed.whitelist : [],
            blacklist: Array.isArray(parsed?.blacklist) ? parsed.blacklist : [],
            stats: {
                ...defaultStore().stats,
                ...(parsed?.stats || {})
            }
        };
    } catch {
        return defaultStore();
    }
}

function saveStore(store) {
    ensureStore();
    fs.writeFileSync(DATA_PATH, JSON.stringify(store, null, 2), 'utf8');
}

function normalizeJid(value) {
    return String(value || '').trim();
}

function shortUserId(value) {
    return normalizeJid(value).split('@')[0].split(':')[0];
}

function sameUser(a, b) {
    const left = shortUserId(a);
    const right = shortUserId(b);
    return Boolean(left && right && left === right);
}

function normalizeConfig(config = {}) {
    const mode = String(config.mode || config.action || '').toLowerCase();
    return {
        enabled: Boolean(config.enabled),
        mode: ['warn', 'delete', 'remove'].includes(mode) ? mode : 'warn',
        sensitivity: ['low', 'medium', 'high'].includes(String(config.sensitivity || '').toLowerCase())
            ? String(config.sensitivity).toLowerCase()
            : 'medium',
        maxWarnings: Math.max(1, Number(config.maxWarnings || config.warnLimit || 3)),
        burstMax: Math.max(3, Number(config.burstMax || 6)),
        burstWindowMs: Math.max(1000, Number(config.burstWindowMs || 8000)),
        duplicateMax: Math.max(2, Number(config.duplicateMax || 4)),
        duplicateWindowMs: Math.max(5000, Number(config.duplicateWindowMs || 30000))
    };
}

function getAntiBotConfig(chatId) {
    const store = loadStore();
    return normalizeConfig(store.groups?.[chatId] || {});
}

function setAntiBotConfig(chatId, patch = {}) {
    const store = loadStore();
    if (!store.groups) store.groups = {};
    store.groups[chatId] = normalizeConfig({
        ...(store.groups[chatId] || {}),
        ...patch
    });
    saveStore(store);
    return store.groups[chatId];
}

function addWarning(chatId, userId) {
    const store = loadStore();
    if (!store.warnings[chatId]) store.warnings[chatId] = {};
    store.warnings[chatId][userId] = Number(store.warnings[chatId][userId] || 0) + 1;
    saveStore(store);
    return store.warnings[chatId][userId];
}

function clearWarnings(chatId, userId = '') {
    const store = loadStore();
    if (!store.warnings?.[chatId]) return;
    if (userId) delete store.warnings[chatId][userId];
    else delete store.warnings[chatId];
    saveStore(store);
}

function setWhitelist(jid, enabled = true) {
    const store = loadStore();
    const target = normalizeJid(jid);
    store.whitelist = store.whitelist.filter((entry) => !sameUser(entry, target));
    if (enabled && target) store.whitelist.push(target);
    saveStore(store);
    return store.whitelist;
}

function setBlacklist(jid, enabled = true) {
    const store = loadStore();
    const target = normalizeJid(jid);
    store.blacklist = store.blacklist.filter((entry) => !sameUser(entry, target));
    if (enabled && target) store.blacklist.push(target);
    saveStore(store);
    return store.blacklist;
}

function isWhitelisted(jid) {
    return loadStore().whitelist.some((entry) => sameUser(entry, jid));
}

function isBlacklisted(jid) {
    return loadStore().blacklist.some((entry) => sameUser(entry, jid));
}

function incStat(field) {
    const store = loadStore();
    store.stats[field] = Number(store.stats[field] || 0) + 1;
    saveStore(store);
}

function getLevel(score) {
    for (const entry of LEVELS) {
        if (score >= entry.min) return entry.level;
    }
    return 'CLEAN';
}

function getSensitivityMultiplier(level) {
    return { low: 0.6, medium: 1.0, high: 1.4 }[level] || 1.0;
}

function hydrateClient(jid) {
    const key = normalizeJid(jid);
    if (clientRuntime.has(key)) return clientRuntime.get(key);

    const persisted = loadStore().clients?.[key] || {};
    const client = {
        jid: key,
        score: Math.max(0, Number(persisted.score || 0)),
        level: String(persisted.level || 'CLEAN'),
        clientType: String(persisted.clientType || ''),
        confidence: Math.max(0, Number(persisted.confidence || 0)),
        warns: Math.max(0, Number(persisted.warns || 0)),
        evidence: Array.isArray(persisted.evidence) ? persisted.evidence : [],
        timeline: Array.isArray(persisted.timeline) ? persisted.timeline : [],
        firstSeen: persisted.firstSeen || new Date().toISOString(),
        lastSeen: persisted.lastSeen || new Date().toISOString()
    };
    clientRuntime.set(key, client);
    return client;
}

function persistClient(client) {
    const store = loadStore();
    store.clients[client.jid] = {
        jid: client.jid,
        score: client.score,
        level: client.level,
        clientType: client.clientType,
        confidence: client.confidence,
        warns: client.warns,
        evidence: client.evidence.slice(-20),
        timeline: client.timeline.slice(-50),
        firstSeen: client.firstSeen,
        lastSeen: client.lastSeen
    };
    saveStore(store);
}

function recordTimeline(client, event, meta = null) {
    client.timeline.push({ ts: Date.now(), event, meta });
    if (client.timeline.length > 50) client.timeline = client.timeline.slice(-50);
}

function addEvidence(client, evidence = []) {
    if (!Array.isArray(evidence) || !evidence.length) return;
    client.evidence.push(...evidence);
    if (client.evidence.length > 20) client.evidence = client.evidence.slice(-20);
}

function containsBrowserConnectNotice(text = '') {
    const value = String(text || '').toLowerCase();
    if (!value) return false;
    const hasConnect = /\b(connect|connected|using|browser|device|linked)\b/.test(value);
    const hasPlatform = /\b(linux|windows|ubuntu|chrome|firefox|edge|safari|desktop|web)\b/.test(value);
    return hasConnect && hasPlatform;
}

function isLikelyExternalBotPayload(message = {}) {
    const keyId = String(message?.key?.id || '');
    const payload = message?.message || {};
    return keyId.startsWith('BAE5') ||
        keyId.startsWith('BAE6') ||
        Boolean(payload?.buttonsMessage) ||
        Boolean(payload?.listMessage) ||
        Boolean(payload?.interactiveMessage) ||
        Boolean(payload?.templateMessage) ||
        Boolean(payload?.viewOnceMessage?.message?.interactiveMessage);
}

function trackBurst(chatId, senderId, config) {
    const key = `${chatId}:${senderId}`;
    const now = Date.now();
    const arr = (burstTracker.get(key) || []).filter((ts) => now - ts < config.burstWindowMs);
    arr.push(now);
    burstTracker.set(key, arr);
    return arr.length;
}

function trackDuplicate(chatId, senderId, rawText, config) {
    const normalized = String(rawText || '').trim().toLowerCase().replace(/\s+/g, ' ');
    if (normalized.length < 3) return 0;
    const key = `${chatId}:${senderId}:${normalized}`;
    const now = Date.now();
    const arr = (duplicateTracker.get(key) || []).filter((ts) => now - ts < config.duplicateWindowMs);
    arr.push(now);
    duplicateTracker.set(key, arr);
    return arr.length;
}

function recordTiming(senderId) {
    const now = Date.now();
    const rec = timingTracker.get(senderId) || { lastMsg: 0, gaps: [], firstSeen: now, msgCount: 0 };
    if (rec.lastMsg) {
        rec.gaps.push(now - rec.lastMsg);
        if (rec.gaps.length > 30) rec.gaps = rec.gaps.slice(-30);
    }
    rec.lastMsg = now;
    rec.msgCount += 1;
    timingTracker.set(senderId, rec);
    return rec;
}

function analyzeTiming(senderId) {
    const rec = timingTracker.get(senderId);
    const signals = [];
    let weight = 0;
    if (!rec) return { signals, weight };

    const gaps = rec.gaps || [];
    if (gaps.length >= 5) {
        const avg = gaps.reduce((sum, value) => sum + value, 0) / gaps.length;
        const variance = gaps.reduce((sum, value) => sum + Math.pow(value - avg, 2), 0) / gaps.length;
        const cv = avg > 0 ? Math.sqrt(variance) / avg : 0;
        if (cv < 0.15 && avg < 3000) {
            signals.push({ layer: 7, signal: `message_gap_too_regular_${cv.toFixed(2)}`, weight: WEIGHTS.tooRegular });
            weight += WEIGHTS.tooRegular;
        }
    }

    return { signals, weight };
}

function shannonEntropy(str) {
    if (!str) return 0;
    const freq = {};
    for (const char of str) freq[char] = (freq[char] || 0) + 1;
    let entropy = 0;
    const len = str.length;
    for (const count of Object.values(freq)) {
        const p = count / len;
        entropy -= p * Math.log2(p);
    }
    return entropy;
}

function isTemplateMessage(text = '') {
    return [
        /^(halo|hello|hi)\s+kak\s+\*/i,
        /^\[[^\]]+\]/,
        /^[*!~`_]{1,3}[^]+[*!~`_]{1,3}$/m,
        /^[\u2705\u274C\u26A0\u{1F7E2}\u{1F534}]/u
    ].some((re) => re.test(text));
}

function recordEntropy(senderId, text) {
    if (!text || text.length < 2) return [];
    const hist = entropyHistory.get(senderId) || [];
    hist.push(text.slice(0, 200));
    if (hist.length > 20) hist.splice(0, hist.length - 20);
    entropyHistory.set(senderId, hist);
    return hist;
}

function analyzeEntropy(senderId, currentText) {
    const signals = [];
    let weight = 0;
    const hist = entropyHistory.get(senderId) || [];
    const entropy = shannonEntropy(currentText || '');
    if (entropy < 2.0 && String(currentText || '').length > 10) {
        signals.push({ layer: 8, signal: `low_entropy_${entropy.toFixed(2)}`, weight: WEIGHTS.lowEntropy });
        weight += WEIGHTS.lowEntropy;
    }

    if (hist.length >= 5) {
        const words = hist.join(' ').toLowerCase().split(/\s+/).filter((word) => word.length > 2);
        const diversity = words.length ? new Set(words).size / words.length : 1;
        if (diversity < 0.2) {
            signals.push({ layer: 8, signal: `low_vocab_diversity_${diversity.toFixed(2)}`, weight: WEIGHTS.repetitiveVocab });
            weight += WEIGHTS.repetitiveVocab;
        }

        const lengths = hist.map((entry) => entry.length);
        const avg = lengths.reduce((sum, value) => sum + value, 0) / lengths.length;
        const variance = lengths.reduce((sum, value) => sum + Math.pow(value - avg, 2), 0) / lengths.length;
        const cv = avg > 0 ? Math.sqrt(variance) / avg : 0;
        if (cv < 0.1 && avg > 5) {
            signals.push({ layer: 8, signal: `fixed_message_length_${cv.toFixed(2)}`, weight: WEIGHTS.repeatedLength });
            weight += WEIGHTS.repeatedLength;
        }
    }

    if (isTemplateMessage(currentText || '')) {
        signals.push({ layer: 8, signal: 'template_message_structure', weight: WEIGHTS.templatedText });
        weight += WEIGHTS.templatedText;
    }

    return { signals, weight };
}

function analyzeMessageSignals(message, rawText = '') {
    const signals = [];
    let weight = 0;
    let clientType = '';
    let confidence = 0;
    const payload = message?.message || {};
    const extText = payload?.extendedTextMessage;
    const context = extText?.contextInfo || {};

    if (context.isForwarded && Number(context.forwardingScore || 0) >= 999) {
        signals.push({ layer: 6, signal: 'mass_forward_score_999', weight: WEIGHTS.massForward });
        weight += WEIGHTS.massForward;
    }

    const devMeta = context.deviceListMetadata;
    if (devMeta !== undefined) {
        const hasRealMeta = devMeta && (devMeta.senderKeyHash || devMeta.recipientKeyHash);
        if (!hasRealMeta && Object.keys(devMeta || {}).length === 0) {
            signals.push({ layer: 6, signal: 'empty_device_list_metadata', weight: WEIGHTS.emptyDeviceList });
            weight += WEIGHTS.emptyDeviceList;
        }
    }

    const extAd = context.externalAdReply;
    if (extAd && Number(extAd.forwardingScore || 0) > 999) {
        signals.push({ layer: 6, signal: 'fake_ad_reply_fwd_999', weight: WEIGHTS.fakeAdReply });
        weight += WEIGHTS.fakeAdReply;
    }

    const text = String(rawText || payload?.conversation || extText?.text || '').toLowerCase();
    for (const signature of USER_AGENT_SIGNATURES) {
        if (signature.re.test(text)) {
            signals.push({ layer: 6, signal: `user_agent_${signature.type}`, weight: WEIGHTS.userAgentMatch });
            weight += WEIGHTS.userAgentMatch;
            if (signature.confidence > confidence) {
                clientType = signature.type;
                confidence = signature.confidence;
            }
        }
    }

    const mentions = context.mentionedJid || [];
    if (mentions.length > 20) {
        signals.push({ layer: 6, signal: `mass_mention_${mentions.length}`, weight: WEIGHTS.massMention });
        weight += WEIGHTS.massMention;
    }

    if (isLikelyExternalBotPayload(message)) {
        signals.push({ layer: 6, signal: 'interactive_or_external_bot_payload', weight: WEIGHTS.interactivePayload });
        weight += WEIGHTS.interactivePayload;
    }

    if (containsBrowserConnectNotice(rawText)) {
        signals.push({ layer: 6, signal: 'browser_device_connect_notice', weight: WEIGHTS.browserConnectNotice });
        weight += WEIGHTS.browserConnectNotice;
    }

    return { signals, weight, clientType, confidence };
}

function analyzeJidSignals(jid) {
    const signals = [];
    let weight = 0;
    const digits = shortUserId(jid).replace(/\D/g, '');
    if (/(\d)\1{4,}/.test(digits)) {
        signals.push({ layer: 6, signal: 'sequential_digit_pattern', weight: WEIGHTS.sequentialDigits });
        weight += WEIGHTS.sequentialDigits;
    }
    if (digits && digits.length < 10) {
        signals.push({ layer: 6, signal: 'short_jid_number', weight: WEIGHTS.shortNumber });
        weight += WEIGHTS.shortNumber;
    }
    if (String(jid || '').endsWith('@lid')) {
        signals.push({ layer: 6, signal: 'lid_suffix', weight: WEIGHTS.lidSuffix });
        weight += WEIGHTS.lidSuffix;
    }
    return { signals, weight };
}

function analyzeBotMessage({ chatId, senderId, message, rawText }) {
    const config = getAntiBotConfig(chatId);
    if (!config.enabled) return { flagged: false, config, score: 0, level: 'CLEAN', reasons: [] };
    if (isWhitelisted(senderId)) return { flagged: false, config, score: 0, level: 'CLEAN', reasons: [] };
    if (isBlacklisted(senderId)) {
        return {
            flagged: true,
            config,
            score: 100,
            level: 'CONFIRMED',
            reasons: ['blacklisted user'],
            signals: [{ layer: 0, signal: 'blacklisted_user', weight: 100 }],
            clientType: 'Blacklist'
        };
    }

    incStat('totalScanned');
    const client = hydrateClient(senderId);
    client.lastSeen = new Date().toISOString();
    recordTimeline(client, 'message', { chatId });
    recordTiming(senderId);
    recordEntropy(senderId, rawText);

    const sensitivity = getSensitivityMultiplier(config.sensitivity);
    const layer6 = analyzeMessageSignals(message, rawText);
    const layer6j = analyzeJidSignals(senderId);
    const layer7 = analyzeTiming(senderId);
    const layer8 = analyzeEntropy(senderId, rawText);
    const burstCount = trackBurst(chatId, senderId, config);
    const duplicateCount = trackDuplicate(chatId, senderId, rawText, config);

    const runtimeSignals = [];
    let runtimeWeight = 0;
    if (burstCount >= config.burstMax) {
        runtimeSignals.push({ layer: 7, signal: `burst_spam_${burstCount}`, weight: WEIGHTS.burstSpam });
        runtimeWeight += WEIGHTS.burstSpam;
    }
    if (duplicateCount >= config.duplicateMax) {
        runtimeSignals.push({ layer: 8, signal: `duplicate_spam_${duplicateCount}`, weight: WEIGHTS.duplicateSpam });
        runtimeWeight += WEIGHTS.duplicateSpam;
    }

    const allSignals = [
        ...layer6.signals,
        ...layer6j.signals,
        ...layer7.signals,
        ...layer8.signals,
        ...runtimeSignals
    ];

    const rawScore = layer6.weight + layer6j.weight + layer7.weight + layer8.weight + runtimeWeight;
    const score = Math.min(100, Math.round(rawScore * sensitivity));
    const newScore = Math.min(100, Math.round((client.score || 0) * 0.7 + score * 0.3));
    const level = getLevel(newScore);
    const previousLevel = client.level || 'CLEAN';

    client.score = newScore;
    client.level = level;
    client.clientType = layer6.clientType || client.clientType || '';
    client.confidence = Math.max(Number(client.confidence || 0), Number(layer6.confidence || 0));
    addEvidence(client, allSignals);
    persistClient(client);

    if (level !== previousLevel && ['SUSPECT', 'WARN', 'CONFIRMED'].includes(level)) {
        incStat('detected');
    }

    return {
        flagged: ['SUSPECT', 'WARN', 'CONFIRMED'].includes(level),
        config,
        score: newScore,
        level,
        reasons: allSignals.map((entry) => entry.signal),
        signals: allSignals,
        clientType: client.clientType || 'Unknown',
        confidence: client.confidence || 0
    };
}

async function enforceAntiBot(sock, chatId, message, senderId, result) {
    const config = result?.config || getAntiBotConfig(chatId);
    if (!result?.flagged) return false;

    const warnings = addWarning(chatId, senderId);
    const client = hydrateClient(senderId);
    client.warns = warnings;
    persistClient(client);

    const warningLine = `Warning ${warnings}/${config.maxWarnings}`;
    const scoreLine = `Score ${Number(result.score || 0)}/100 | Level ${result.level}`;
    const reasonLine = result.reasons.slice(0, 4).join(', ') || 'multi-layer bot signals';

    if (config.mode === 'delete') {
        try {
            await sock.sendMessage(chatId, { delete: message.key });
        } catch {}
    }

    if (config.mode === 'remove' && (result.level === 'CONFIRMED' || warnings >= config.maxWarnings)) {
        try {
            await sock.groupParticipantsUpdate(chatId, [senderId], 'remove');
            clearWarnings(chatId, senderId);
            await sock.sendMessage(chatId, {
                text: `@${shortUserId(senderId)} removed by antibot.\n${scoreLine}\nReason: ${reasonLine}`,
                mentions: [senderId]
            }, { quoted: message });
            return true;
        } catch {
            await sock.sendMessage(chatId, {
                text: `Antibot confirmed a bot-like sender but could not remove them.\n${warningLine}\n${scoreLine}\nReason: ${reasonLine}`
            }, { quoted: message });
            return true;
        }
    }

    await sock.sendMessage(chatId, {
        text: `@${shortUserId(senderId)} antibot detected suspicious bot-like activity.\n${warningLine}\n${scoreLine}\nReason: ${reasonLine}`,
        mentions: [senderId]
    }, { quoted: message });
    return true;
}

module.exports = {
    getAntiBotConfig,
    setAntiBotConfig,
    clearWarnings,
    analyzeBotMessage,
    enforceAntiBot,
    sameUser,
    isWhitelisted,
    isBlacklisted,
    setWhitelist,
    setBlacklist
};
