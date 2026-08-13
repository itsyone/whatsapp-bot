const https = require('https');
const {
    loadDb,
    saveDb,
    getCrew,
    setNamingPrompt,
    getNamingPrompt,
    clearNamingPrompt,
    createCrew,
    isCrewMember,
    canManageCrew,
    canLeadCrew,
    updateCrew,
    setRecruitInvite,
    getRecruitInvite,
    acceptRecruitInvite,
    declineRecruitInvite,
    addBooty
} = require('../../lib/crewStore');
const { getBalance, addBalance } = require('../../lib/economy');

const START_THUMB_URL = 'https://files.catbox.moe/batkd1.jpg';
const SAIL_IMAGE_URL = 'https://files.catbox.moe/k91ttq.jpg';
const REPUTATIONS = ['Unknown', 'Risky', 'Feared', 'Notorious', 'Legendary'];
const HOURLY_SHIP_INCOME = 50;
const RAID_ACTIVE_MS = 10 * 60 * 1000;
const COOLDOWNS = {
    spyglass: 5 * 1000,
    crewlist: 10 * 1000,
    manifest: 15 * 1000,
    plunder: 10 * 60 * 1000,
    duel: 5 * 60 * 1000,
    raid: 60 * 60 * 1000,
    maroon: 30 * 60 * 1000,
    pardoner: 15 * 60 * 1000,
    captain: 7 * 24 * 60 * 60 * 1000,
    setsail: 30 * 60 * 1000,
    lockship: 5 * 60 * 1000
};

const thumbCache = new Map();

function fetchBuffer(url) {
    return new Promise((resolve, reject) => {
        https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
            if (res.statusCode === 301 || res.statusCode === 302) {
                return fetchBuffer(res.headers.location).then(resolve).catch(reject);
            }
            const chunks = [];
            res.on('data', (chunk) => chunks.push(chunk));
            res.on('end', () => resolve(Buffer.concat(chunks)));
            res.on('error', reject);
        }).on('error', reject);
    });
}

async function getThumb(url) {
    if (!thumbCache.has(url)) {
        thumbCache.set(url, await fetchBuffer(url).catch(() => null));
    }
    return thumbCache.get(url) || null;
}

function mentionTag(jid) {
    const id = String(jid || '').split('@')[0].split(':')[0];
    return `@${id}`;
}

function sameUserId(a, b) {
    const left = String(a || '').split('@')[0].split(':')[0];
    const right = String(b || '').split('@')[0].split(':')[0];
    return Boolean(left && right && left === right);
}

function isMemberOfCrew(crew, jid) {
    return Array.isArray(crew?.members) && crew.members.some((memberJid) => sameUserId(memberJid, jid));
}

function resolveCrewMemberJid(crew, jid) {
    if (!crew || !jid) return '';
    if (sameUserId(crew.captain, jid)) return crew.captain;
    if (sameUserId(crew.firstMate, jid)) return crew.firstMate;
    return (Array.isArray(crew.members) ? crew.members : []).find((memberJid) => sameUserId(memberJid, jid)) || '';
}

function explainCrewTargetIssue(crew, targetId) {
    if (!targetId) {
        return 'Tag a crew member using `.firstmate @user`.';
    }
    if (sameUserId(targetId, crew?.captain)) {
        return 'You cannot target the captain for this action.';
    }
    return 'That user is not in your crew yet.\n> Use `.recruit @user` and have them send `accept`.';
}

function collectContextInfos(node, bucket = []) {
    if (!node || typeof node !== 'object') return bucket;
    if (node.contextInfo && typeof node.contextInfo === 'object') bucket.push(node.contextInfo);

    for (const value of Object.values(node)) {
        if (value && typeof value === 'object') {
            collectContextInfos(value, bucket);
        }
    }

    return bucket;
}

function extractMentionTokens(rawText = '') {
    return [...new Set(
        (String(rawText || '').match(/@(\d{5,20})/g) || [])
            .map((token) => token.replace('@', '').trim())
            .filter(Boolean)
    )];
}

function getMentionedTarget(message, mentionedJids = [], rawText = '') {
    const directMentions = Array.isArray(mentionedJids) ? mentionedJids.filter(Boolean) : [];
    if (directMentions[0]) return directMentions[0];

    const contextInfos = collectContextInfos(message?.message || {});

    for (const contextInfo of contextInfos) {
        const mentions = Array.isArray(contextInfo?.mentionedJid) ? contextInfo.mentionedJid.filter(Boolean) : [];
        if (mentions[0]) return mentions[0];
    }

    for (const contextInfo of contextInfos) {
        if (contextInfo?.quotedMessage && contextInfo?.participant) {
            return contextInfo.participant;
        }
    }

    const mentionToken = extractMentionTokens(rawText)[0];
    if (mentionToken) return `${mentionToken}@s.whatsapp.net`;

    return '';
}

function collectMentionedJids(message, rawText = '') {
    const results = new Set();

    for (const contextInfo of collectContextInfos(message?.message || {})) {
        for (const jid of Array.isArray(contextInfo?.mentionedJid) ? contextInfo.mentionedJid : []) {
            if (jid) results.add(jid);
        }
        if (contextInfo?.quotedMessage && contextInfo?.participant) {
            results.add(contextInfo.participant);
        }
    }

    for (const token of extractMentionTokens(rawText)) {
        results.add(`${token}@s.whatsapp.net`);
    }

    return [...results];
}

function cleanCrewName(input) {
    const text = String(input || '').replace(/\s+/g, ' ').trim();
    if (!text || text.length < 2 || text.length > 40) return null;
    return text;
}

function buildCard(text, thumbUrl, jpegThumbnail, mentions = [], title = 'PIRATE CREW', body = 'set sail') {
    return {
        text,
        mentions,
        contextInfo: {
            externalAdReply: {
                title,
                body,
                mediaType: 1,
                renderLargerThumbnail: false,
                showAdAttribution: false,
                sourceUrl: '',
                ...(jpegThumbnail ? { thumbnail: jpegThumbnail } : { thumbnailUrl: thumbUrl })
            }
        }
    };
}

function ensureGroup(chatId) {
    return String(chatId || '').endsWith('@g.us');
}

function isMarooned(crew, jid) {
    return Array.isArray(crew?.marooned) && crew.marooned.some((maroonedJid) => sameUserId(maroonedJid, jid));
}

function canManageCrewFromCrew(crew, jid) {
    return sameUserId(crew?.captain, jid) || sameUserId(crew?.firstMate, jid);
}

function isCrewLockedFor(crew, jid) {
    if (!crew) return false;
    if (crew.anchored) return true;
    if (crew.locked && !canManageCrewFromCrew(crew, jid)) return true;
    return isMarooned(crew, jid);
}

function roleLabel(crew, jid) {
    if (!crew) return 'Outsider';
    if (sameUserId(crew.captain, jid)) return 'Captain';
    if (sameUserId(crew.firstMate, jid)) return 'First Mate';
    if (isMemberOfCrew(crew, jid)) return 'Crew';
    return 'Outsider';
}

function randomReputation(current) {
    const currentIndex = Math.max(0, REPUTATIONS.indexOf(String(current || 'Unknown')));
    const delta = Math.random() < 0.5 ? 0 : 1;
    return REPUTATIONS[Math.min(REPUTATIONS.length - 1, currentIndex + delta)];
}

function formatRemaining(ms) {
    const totalSeconds = Math.max(1, Math.ceil(Number(ms || 0) / 1000));
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    const parts = [];
    if (hours > 0) parts.push(`${hours}h`);
    if (minutes > 0) parts.push(`${minutes}m`);
    if (seconds > 0 || !parts.length) parts.push(`${seconds}s`);
    return parts.join(' ');
}

function buildCooldownText(remainingMs, style = 'default') {
    const remaining = formatRemaining(remainingMs);
    if (style === 'recover') {
        return ['🗡 You need to recover...', '', `> Ready in ${remaining}`].join('\n');
    }
    return ['⏳ Cooldown active', '', `> Try again in ${remaining}`].join('\n');
}

function cleanupCrewState(crew) {
    if (!crew) return crew;
    const now = Date.now();
    const maroonedUntil = crew.maroonedUntil && typeof crew.maroonedUntil === 'object' ? crew.maroonedUntil : {};
    crew.marooned = (Array.isArray(crew.marooned) ? crew.marooned : []).filter((jid) => Number(maroonedUntil[jid] || 0) > now);
    for (const jid of Object.keys(maroonedUntil)) {
        if (Number(maroonedUntil[jid] || 0) <= now) {
            delete maroonedUntil[jid];
        }
    }
    crew.maroonedUntil = maroonedUntil;
    return crew;
}

function getCooldownRemaining(crew, key) {
    const readyAt = Number(crew?.cooldowns?.[key] || 0);
    return Math.max(0, readyAt - Date.now());
}

function setCrewCooldown(chatId, key, durationMs, senderId = '') {
    return updateCrew(chatId, (draft) => {
        draft.cooldowns = draft.cooldowns && typeof draft.cooldowns === 'object' ? draft.cooldowns : {};
        draft.cooldowns[key] = Date.now() + durationMs;
        return draft;
    }, senderId);
}

function collectHourlyIncome(chatId, senderId = '') {
    const crew = cleanupCrewState(getCrew(chatId, senderId));
    if (!crew || !crew.sailed) return { crew, added: 0, hours: 0 };

    const lastCollectedAt = Number(crew?.income?.lastCollectedAt || crew.createdAt || Date.now());
    const now = Date.now();
    const elapsed = now - lastCollectedAt;
    const hours = Math.floor(elapsed / (60 * 60 * 1000));
    if (hours <= 0) return { crew, added: 0, hours: 0 };

    const result = updateCrew(chatId, (draft) => {
        cleanupCrewState(draft);
        draft.income = draft.income && typeof draft.income === 'object' ? draft.income : {};
        draft.income.lastCollectedAt = lastCollectedAt + (hours * 60 * 60 * 1000);
        draft.booty = Math.max(0, Number(draft.booty || 0) + (hours * HOURLY_SHIP_INCOME));
        return draft;
    }, senderId);

    return { crew: result.crew, added: hours * HOURLY_SHIP_INCOME, hours };
}

function getRaidState() {
    const db = loadDb();
    const raid = db.meta?.raid || { activeUntil: 0, cooldownUntil: 0, members: {} };
    if (Date.now() >= Number(raid.activeUntil || 0) && raid.activeUntil) {
        raid.activeUntil = 0;
        raid.members = {};
        db.meta.raid = raid;
        saveDb(db);
    }
    return db.meta.raid;
}

function startRaidState(hostChatId) {
    const db = loadDb();
    const now = Date.now();
    const raid = db.meta?.raid || { activeUntil: 0, cooldownUntil: 0, members: {} };
    raid.activeUntil = now + RAID_ACTIVE_MS;
    raid.cooldownUntil = now + COOLDOWNS.raid;
    raid.members = {};
    raid.hostChatId = hostChatId;
    db.meta.raid = raid;
    saveDb(db);
    return raid;
}

function joinRaidState(chatId, senderId) {
    const db = loadDb();
    const raid = db.meta?.raid || { activeUntil: 0, cooldownUntil: 0, members: {} };
    if (Date.now() >= Number(raid.activeUntil || 0)) {
        raid.activeUntil = 0;
        raid.members = {};
        db.meta.raid = raid;
        saveDb(db);
        return { ok: false, reason: 'inactive' };
    }
    if (!raid.members || typeof raid.members !== 'object') raid.members = {};
    if (raid.members[senderId]) return { ok: false, reason: 'already_joined', raid };
    raid.members[senderId] = { chatId, joinedAt: Date.now() };
    db.meta.raid = raid;
    saveDb(db);
    return { ok: true, raid };
}

async function crewStartCommand(sock, chatId, message, senderId) {
    if (!ensureGroup(chatId)) {
        await sock.sendMessage(chatId, { text: 'Use `.crewstart` inside a group.' }, { quoted: message });
        return true;
    }

    const crew = cleanupCrewState(getCrew(chatId, senderId));
    if (crew) {
        await sock.sendMessage(chatId, { text: `You already have a crew.\n> Name: _${crew.name}_` }, { quoted: message });
        return true;
    }

    setNamingPrompt(chatId, senderId);
    const thumb = await getThumb(START_THUMB_URL);
    await sock.sendMessage(chatId, buildCard([
        '*🏴‍☠️ PIRATE CREW 🏴‍☠️*',
        '',
        'Before you set sail...',
        '',
        '> 📝 Name your crew',
        '',
        'Type your crew name ⚓'
    ].join('\n'), START_THUMB_URL, thumb), { quoted: message });
    return true;
}

async function handleCrewReply(sock, chatId, message, senderId, rawText) {
    const input = String(rawText || '').trim();
    if (!input || input.startsWith('.')) return false;

    const naming = getNamingPrompt(chatId);
    if (naming && naming.senderId === senderId) {
        const crewName = cleanCrewName(input);
        if (!crewName) {
            await sock.sendMessage(chatId, { text: 'Type a valid crew name ⚓' }, { quoted: message });
            return true;
        }

        const result = createCrew(chatId, senderId, crewName);
        if (!result.ok) {
            clearNamingPrompt(chatId);
            await sock.sendMessage(chatId, { text: 'Could not form the crew right now.' }, { quoted: message });
            return true;
        }

        const crew = result.crew;
        await sock.sendMessage(chatId, {
            text: [
                '🏴‍☠️ *Crew Formed!*',
                '',
                `> ⚓ Name: _${crew.name}_`,
                `> 👑 Captain: ${mentionTag(senderId)}`,
                `> 🏴 Title: *${crew.title}*`,
                `> 🌊 Reputation: ${crew.reputation}`,
                '✨ Crew Trait:',
                '',
                '🍀 Lucky Crew',
                '',
                '🎁 Starter Bonus!',
                '',
                '+150 gold 💰',
                '🎯 First Objective:',
                '',
                '▸ Recruit 2 members',
                '▸ Set sail'
            ].join('\n'),
            mentions: [senderId]
        }, { quoted: message });
        return true;
    }

    const invite = getRecruitInvite(chatId, senderId);
    if (!invite) return false;

    const normalized = input.toLowerCase();
    if (normalized === 'accept') {
        const result = acceptRecruitInvite(chatId, senderId);
        if (!result.ok) {
            await sock.sendMessage(chatId, { text: 'That invite expired.' }, { quoted: message });
            return true;
        }

        await sock.sendMessage(chatId, {
            text: [
                '⚓ Welcome aboard!',
                '',
                `${mentionTag(senderId)} joined the crew 🏴‍☠️`
            ].join('\n'),
            mentions: [senderId]
        }, { quoted: message });
        return true;
    }

    if (normalized === 'decline') {
        declineRecruitInvite(chatId, senderId);
        await sock.sendMessage(chatId, {
            text: `${mentionTag(senderId)} declined the crew invite.`,
            mentions: [senderId]
        }, { quoted: message });
        return true;
    }

    return false;
}

async function recruitCommand(sock, chatId, message, senderId, rawText, mentionedJids) {
    if (!ensureGroup(chatId)) {
        await sock.sendMessage(chatId, { text: 'Use `.recruit @user` inside a group.' }, { quoted: message });
        return true;
    }

    const crew = collectHourlyIncome(chatId, senderId).crew;
    if (!crew) {
        await sock.sendMessage(chatId, { text: 'Start a crew first with `.crewstart`.' }, { quoted: message });
        return true;
    }
    if (!canManageCrew(chatId, senderId)) {
        await sock.sendMessage(chatId, { text: 'Only the captain or first mate can recruit.' }, { quoted: message });
        return true;
    }
    if (isCrewLockedFor(crew, senderId)) {
        await sock.sendMessage(chatId, { text: 'Crew actions are paused right now.' }, { quoted: message });
        return true;
    }

    const targetId = getMentionedTarget(message, mentionedJids, rawText);
    if (!targetId) {
        await sock.sendMessage(chatId, { text: 'Tag a user.\n> `.recruit @user`' }, { quoted: message });
        return true;
    }
    if (isCrewMember(chatId, targetId)) {
        await sock.sendMessage(chatId, { text: 'That user is already in the crew.' }, { quoted: message });
        return true;
    }

    if (!setRecruitInvite(chatId, targetId, senderId)) {
        await sock.sendMessage(chatId, { text: 'Could not create an invite for that crew.' }, { quoted: message });
        return true;
    }
    await sock.sendMessage(chatId, {
        text: [
            '🏴‍☠️ *RECRUITMENT*',
            '',
            `${mentionTag(targetId)} has been invited...`,
            '',
            '> Type: accept / decline'
        ].join('\n'),
        mentions: [targetId]
    }, { quoted: message });
    return true;
}

async function setSailCommand(sock, chatId, message, senderId) {
    if (!ensureGroup(chatId)) {
        await sock.sendMessage(chatId, { text: 'Use `.set sail` inside a group.' }, { quoted: message });
        return true;
    }

    const crew = collectHourlyIncome(chatId, senderId).crew;
    if (!crew) {
        await sock.sendMessage(chatId, { text: 'Start a crew first with `.crewstart`.' }, { quoted: message });
        return true;
    }
    if (!canLeadCrew(chatId, senderId)) {
        await sock.sendMessage(chatId, { text: 'Only the captain can set sail.' }, { quoted: message });
        return true;
    }
    const cooldownRemaining = getCooldownRemaining(crew, `setsail:${senderId}`);
    if (cooldownRemaining > 0) {
        await sock.sendMessage(chatId, { text: buildCooldownText(cooldownRemaining) }, { quoted: message });
        return true;
    }
    if (crew.sailed) {
        await sock.sendMessage(chatId, { text: 'Your crew has already set sail.' }, { quoted: message });
        return true;
    }

    const result = updateCrew(chatId, (draft) => {
        draft.sailed = true;
        draft.rank = 'Deckhand';
        return draft;
    }, senderId);

    await sock.sendMessage(chatId, {
        image: { url: SAIL_IMAGE_URL },
        caption: [
            '🌊 *SET SAIL*',
            '',
            'The journey begins...',
            '',
            '> ⚓ The crew has left the harbor',
            '> 🗺 Adventure awaits beyond the horizon'
        ].join('\n')
    }, { quoted: message });
    setCrewCooldown(chatId, `setsail:${senderId}`, COOLDOWNS.setsail, senderId);
    return true;
}

async function bootyCommand(sock, chatId, message, senderId) {
    const income = collectHourlyIncome(chatId, senderId);
    const crew = income.crew;
    if (!crew) {
        await sock.sendMessage(chatId, { text: 'You do not have a pirate crew yet.\n> Use `.crewstart` first.' }, { quoted: message });
        return true;
    }

    await sock.sendMessage(chatId, {
        text: [
            `💰 Booty: ${crew.booty.toLocaleString()} gold`,
            '',
            '> Earn by:',
            '▸ Plundering',
            '▸ Daily claim',
            '▸ Events',
            ...(income.added > 0 ? ['', `> Ship income: +${income.added} gold`] : [])
        ].join('\n')
    }, { quoted: message });
    return true;
}

async function crewListCommand(sock, chatId, message, senderId, title = '📜 *CREW LIST*', includeBooty = false) {
    const income = collectHourlyIncome(chatId, senderId);
    const crew = income.crew;
    if (!crew) {
        await sock.sendMessage(chatId, { text: 'You do not have a pirate crew yet.\n> Use `.crewstart` first.' }, { quoted: message });
        return true;
    }
    const commandKey = includeBooty ? 'manifest' : 'crewlist';
    const cooldownRemaining = getCooldownRemaining(crew, `${commandKey}:${message.key.participant || message.key.remoteJid}`);
    if (cooldownRemaining > 0) {
        await sock.sendMessage(chatId, { text: buildCooldownText(cooldownRemaining) }, { quoted: message });
        return true;
    }

    const memberLines = crew.members.map((jid) => `▸ ${mentionTag(jid)}`);
    const lines = [
        title,
        '',
        `👑 Captain: ${mentionTag(crew.captain)}`,
        `🗡 First Mate: ${crew.firstMate ? mentionTag(crew.firstMate) : 'None'}`,
        '',
        '👥 Crew:',
        ...(memberLines.length ? memberLines : ['▸ None'])
    ];

    if (includeBooty) {
        lines.push('', `💰 Total Booty: ${crew.booty.toLocaleString()}`);
    }

    await sock.sendMessage(chatId, {
        text: lines.join('\n'),
        mentions: crew.members
    }, { quoted: message });
    setCrewCooldown(chatId, `${commandKey}:${message.key.participant || message.key.remoteJid}`, includeBooty ? COOLDOWNS.manifest : COOLDOWNS.crewlist, senderId);
    return true;
}

async function spyglassCommand(sock, chatId, message, senderId, rawText, mentionedJids) {
    const targetId = getMentionedTarget(message, mentionedJids, rawText);
    if (!targetId) {
        await sock.sendMessage(chatId, { text: 'Tag a user.\n> `.spyglass @user`' }, { quoted: message });
        return true;
    }

    const crew = collectHourlyIncome(chatId, senderId).crew;
    const cooldownRemaining = getCooldownRemaining(crew, `spyglass:${senderId}`);
    if (cooldownRemaining > 0) {
        await sock.sendMessage(chatId, { text: buildCooldownText(cooldownRemaining) }, { quoted: message });
        return true;
    }
    const gold = getBalance(targetId);
    const role = roleLabel(crew, targetId);
    const reputation = isMemberOfCrew(crew, targetId) ? crew.reputation : 'Unknown';

    await sock.sendMessage(chatId, {
        text: [
            `🔍 ${mentionTag(targetId)}`,
            '',
            `💰 Gold: ${gold.toLocaleString()}`,
            `⚓ Rank: ${role}`,
            `☠️ Reputation: ${reputation}`
        ].join('\n'),
        mentions: [targetId]
    }, { quoted: message });
    setCrewCooldown(chatId, `spyglass:${senderId}`, COOLDOWNS.spyglass, senderId);
    return true;
}

async function plunderCommand(sock, chatId, message, senderId) {
    const crew = collectHourlyIncome(chatId, senderId).crew;
    if (!crew) {
        await sock.sendMessage(chatId, { text: 'You do not have a pirate crew yet.\n> Use `.crewstart` first.' }, { quoted: message });
        return true;
    }
    if (!crew.sailed) {
        await sock.sendMessage(chatId, { text: 'Set sail first with `.set sail`.' }, { quoted: message });
        return true;
    }
    if (!isCrewMember(chatId, senderId)) {
        await sock.sendMessage(chatId, { text: 'Only crew members can plunder.' }, { quoted: message });
        return true;
    }
    if (isCrewLockedFor(crew, senderId)) {
        await sock.sendMessage(chatId, { text: 'Crew actions are paused right now.' }, { quoted: message });
        return true;
    }
    const cooldownRemaining = getCooldownRemaining(crew, `plunder:${senderId}`);
    if (cooldownRemaining > 0) {
        await sock.sendMessage(chatId, { text: buildCooldownText(cooldownRemaining, 'recover') }, { quoted: message });
        return true;
    }

    if (Math.random() < 0.65) {
        const reward = 80 + Math.floor(Math.random() * 81);
        const bootyResult = addBooty(chatId, reward, senderId);
        const repResult = updateCrew(chatId, (draft) => {
            draft.reputation = randomReputation(draft.reputation);
            return draft;
        }, senderId);
        await sock.sendMessage(chatId, {
            text: [
                '⚔️ Plunder Success!',
                '',
                `+${reward} gold 💰`,
                `> Crew booty: ${bootyResult.crew.booty.toLocaleString()}`,
                `> Reputation: ${repResult.crew.reputation}`
            ].join('\n')
        }, { quoted: message });
        setCrewCooldown(chatId, `plunder:${senderId}`, COOLDOWNS.plunder, senderId);
        return true;
    }

    const loss = 30 + Math.floor(Math.random() * 31);
    const bootyResult = addBooty(chatId, -loss, senderId);
    await sock.sendMessage(chatId, {
        text: [
            '💀 Plunder Failed!',
            '',
            `-${loss} gold`,
            `> Crew booty: ${bootyResult.crew.booty.toLocaleString()}`
        ].join('\n')
    }, { quoted: message });
    setCrewCooldown(chatId, `plunder:${senderId}`, COOLDOWNS.plunder, senderId);
    return true;
}

async function duelCommand(sock, chatId, message, senderId, rawText, mentionedJids) {
    const crew = collectHourlyIncome(chatId, senderId).crew;
    const cooldownRemaining = getCooldownRemaining(crew, `duel:${senderId}`);
    if (cooldownRemaining > 0) {
        await sock.sendMessage(chatId, { text: buildCooldownText(cooldownRemaining, 'recover') }, { quoted: message });
        return true;
    }
    const targetId = getMentionedTarget(message, mentionedJids, rawText);
    if (!targetId) {
        await sock.sendMessage(chatId, { text: 'Tag a user and amount.\n> `.duel @user 200`' }, { quoted: message });
        return true;
    }

    const amountMatch = String(rawText || '').trim().match(/(\d+)\s*$/);
    const amount = amountMatch ? Math.floor(Number(amountMatch[1])) : 0;
    if (!amount || amount < 1) {
        await sock.sendMessage(chatId, { text: 'Enter a valid duel amount.' }, { quoted: message });
        return true;
    }

    const myGold = getBalance(senderId);
    const theirGold = getBalance(targetId);
    if (myGold < amount) {
        await sock.sendMessage(chatId, { text: `You need ${amount.toLocaleString()} gold.` }, { quoted: message });
        return true;
    }
    if (theirGold < amount) {
        await sock.sendMessage(chatId, {
            text: `${mentionTag(targetId)} does not have enough gold.`,
            mentions: [targetId]
        }, { quoted: message });
        return true;
    }

    const winner = Math.random() < 0.5 ? senderId : targetId;
    const loser = winner === senderId ? targetId : senderId;
    addBalance(winner, amount);
    addBalance(loser, -amount);

    await sock.sendMessage(chatId, {
        text: [
            '⚔️ Duel!',
            '',
            `${mentionTag(senderId)} vs ${mentionTag(targetId)}`,
            '',
            `Winner: ${mentionTag(winner)}`,
            `+${amount} gold 💰`,
            '',
            `-${amount} gold`
        ].join('\n'),
        mentions: [senderId, targetId, winner]
    }, { quoted: message });
    setCrewCooldown(chatId, `duel:${senderId}`, COOLDOWNS.duel, senderId);
    return true;
}

async function bountyCommand(sock, chatId, message, senderId, rawText, mentionedJids) {
    const crew = collectHourlyIncome(chatId, senderId).crew;
    if (!crew) {
        await sock.sendMessage(chatId, { text: 'You do not have a pirate crew yet.\n> Use `.crewstart` first.' }, { quoted: message });
        return true;
    }
    if (!canManageCrew(chatId, senderId)) {
        await sock.sendMessage(chatId, { text: 'Only the captain or first mate can place a bounty.' }, { quoted: message });
        return true;
    }

    const targetId = getMentionedTarget(message, mentionedJids, rawText);
    if (!targetId) {
        await sock.sendMessage(chatId, { text: 'Tag a user.\n> `.bounty @user 300`' }, { quoted: message });
        return true;
    }

    const amountMatch = String(rawText || '').trim().match(/(\d+)\s*$/);
    const amount = amountMatch ? Math.floor(Number(amountMatch[1])) : 300;
    if (crew.booty < amount) {
        await sock.sendMessage(chatId, { text: 'Not enough crew booty for that bounty.' }, { quoted: message });
        return true;
    }

    const result = updateCrew(chatId, (draft) => {
        draft.booty = Math.max(0, draft.booty - amount);
        draft.bounties = Array.isArray(draft.bounties) ? draft.bounties : [];
        draft.bounties.push({ targetId, amount, createdAt: Date.now(), by: senderId });
        return draft;
    }, senderId);

    await sock.sendMessage(chatId, {
        text: [
            '🎯 Bounty placed!',
            '',
            `${mentionTag(targetId)} — ${amount.toLocaleString()} gold`,
            `> Crew booty: ${result.crew.booty.toLocaleString()}`
        ].join('\n'),
        mentions: [targetId]
    }, { quoted: message });
    return true;
}

async function anchorCommand(sock, chatId, message, senderId) {
    const crew = collectHourlyIncome(chatId, senderId).crew;
    if (!crew) {
        await sock.sendMessage(chatId, { text: 'You do not have a pirate crew yet.\n> Use `.crewstart` first.' }, { quoted: message });
        return true;
    }
    if (!canLeadCrew(chatId, senderId)) {
        await sock.sendMessage(chatId, { text: 'Only the captain can drop anchor.' }, { quoted: message });
        return true;
    }

    const result = updateCrew(chatId, (draft) => {
        draft.anchored = !draft.anchored;
        return draft;
    }, senderId);

    await sock.sendMessage(chatId, {
        text: result.crew.anchored
            ? '⚓ Anchor dropped\n\n> Crew actions paused'
            : '⚓ Anchor lifted\n\n> Crew actions resumed'
    }, { quoted: message });
    return true;
}

async function shipLockCommand(sock, chatId, message, senderId, locked) {
    const crew = collectHourlyIncome(chatId, senderId).crew;
    if (!crew) {
        await sock.sendMessage(chatId, { text: 'You do not have a pirate crew yet.\n> Use `.crewstart` first.' }, { quoted: message });
        return true;
    }
    if (!canLeadCrew(chatId, senderId)) {
        await sock.sendMessage(chatId, { text: 'Captain only.' }, { quoted: message });
        return true;
    }
    const cooldownRemaining = getCooldownRemaining(crew, `lockship:${senderId}`);
    if (cooldownRemaining > 0) {
        await sock.sendMessage(chatId, { text: buildCooldownText(cooldownRemaining) }, { quoted: message });
        return true;
    }

    updateCrew(chatId, (draft) => {
        draft.locked = Boolean(locked);
        return draft;
    }, senderId);

    await sock.sendMessage(chatId, {
        text: locked
            ? '🔒 Ship locked\n\n> Captain only'
            : '🔓 Ship opened\n\n> Crew may act'
    }, { quoted: message });
    setCrewCooldown(chatId, `lockship:${senderId}`, COOLDOWNS.lockship, senderId);
    return true;
}

async function firstMateCommand(sock, chatId, message, senderId, rawText, mentionedJids) {
    const crew = collectHourlyIncome(chatId, senderId).crew;
    if (!crew) {
        await sock.sendMessage(chatId, { text: 'You do not have a pirate crew yet.\n> Use `.crewstart` first.' }, { quoted: message });
        return true;
    }
    if (!canLeadCrew(chatId, senderId)) {
        await sock.sendMessage(chatId, { text: 'Only the captain can assign first mate.' }, { quoted: message });
        return true;
    }

    const targetId = getMentionedTarget(message, mentionedJids, rawText);
    const crewMemberId = resolveCrewMemberJid(crew, targetId);
    if (!crewMemberId || sameUserId(crewMemberId, crew.captain)) {
        await sock.sendMessage(chatId, { text: explainCrewTargetIssue(crew, targetId) }, { quoted: message });
        return true;
    }

    updateCrew(chatId, (draft) => {
        draft.firstMate = crewMemberId;
        return draft;
    }, senderId);

    await sock.sendMessage(chatId, {
        text: ['🗡 First Mate assigned', '', mentionTag(crewMemberId)].join('\n'),
        mentions: [crewMemberId]
    }, { quoted: message });
    return true;
}

async function captainCommand(sock, chatId, message, senderId, rawText, mentionedJids) {
    const crew = collectHourlyIncome(chatId, senderId).crew;
    if (!crew) {
        await sock.sendMessage(chatId, { text: 'You do not have a pirate crew yet.\n> Use `.crewstart` first.' }, { quoted: message });
        return true;
    }
    if (!canLeadCrew(chatId, senderId)) {
        await sock.sendMessage(chatId, { text: 'Only the captain can transfer the ship.' }, { quoted: message });
        return true;
    }
    const cooldownRemaining = getCooldownRemaining(crew, 'captain:global');
    if (cooldownRemaining > 0) {
        await sock.sendMessage(chatId, { text: buildCooldownText(cooldownRemaining) }, { quoted: message });
        return true;
    }

    const targetId = getMentionedTarget(message, mentionedJids, rawText);
    const crewMemberId = resolveCrewMemberJid(crew, targetId);
    if (!crewMemberId || sameUserId(crewMemberId, crew.captain)) {
        await sock.sendMessage(chatId, { text: explainCrewTargetIssue(crew, targetId) }, { quoted: message });
        return true;
    }

    updateCrew(chatId, (draft) => {
        const oldCaptain = draft.captain;
        draft.captain = crewMemberId;
        if (sameUserId(draft.firstMate, crewMemberId)) {
            draft.firstMate = oldCaptain;
        }
        return draft;
    }, senderId);

    await sock.sendMessage(chatId, {
        text: ['👑 New Captain!', '', `${mentionTag(crewMemberId)} now leads the crew`].join('\n'),
        mentions: [crewMemberId]
    }, { quoted: message });
    setCrewCooldown(chatId, 'captain:global', COOLDOWNS.captain, senderId);
    return true;
}

async function maroonCommand(sock, chatId, message, senderId, rawText, mentionedJids) {
    const crew = collectHourlyIncome(chatId, senderId).crew;
    if (!crew) {
        await sock.sendMessage(chatId, { text: 'You do not have a pirate crew yet.\n> Use `.crewstart` first.' }, { quoted: message });
        return true;
    }
    if (!canManageCrew(chatId, senderId)) {
        await sock.sendMessage(chatId, { text: 'Only the captain or first mate can maroon a member.' }, { quoted: message });
        return true;
    }
    const cooldownRemaining = getCooldownRemaining(crew, `maroon:${senderId}`);
    if (cooldownRemaining > 0) {
        await sock.sendMessage(chatId, { text: buildCooldownText(cooldownRemaining) }, { quoted: message });
        return true;
    }

    const targetId = getMentionedTarget(message, mentionedJids, rawText);
    const crewMemberId = resolveCrewMemberJid(crew, targetId);
    if (!crewMemberId || sameUserId(crewMemberId, crew.captain)) {
        await sock.sendMessage(chatId, { text: explainCrewTargetIssue(crew, targetId) }, { quoted: message });
        return true;
    }

    updateCrew(chatId, (draft) => {
        cleanupCrewState(draft);
        draft.marooned = Array.isArray(draft.marooned) ? draft.marooned : [];
        if (!draft.marooned.some((jid) => sameUserId(jid, crewMemberId))) draft.marooned.push(crewMemberId);
        draft.maroonedUntil = draft.maroonedUntil && typeof draft.maroonedUntil === 'object' ? draft.maroonedUntil : {};
        draft.maroonedUntil[crewMemberId] = Date.now() + COOLDOWNS.maroon;
        return draft;
    }, senderId);

    await sock.sendMessage(chatId, {
        text: ['🏝 Marooned!', '', `${mentionTag(crewMemberId)} cannot act`].join('\n'),
        mentions: [crewMemberId]
    }, { quoted: message });
    setCrewCooldown(chatId, `maroon:${senderId}`, COOLDOWNS.maroon, senderId);
    return true;
}

async function pardonerCommand(sock, chatId, message, senderId, rawText, mentionedJids) {
    const crew = collectHourlyIncome(chatId, senderId).crew;
    if (!crew) {
        await sock.sendMessage(chatId, { text: 'You do not have a pirate crew yet.\n> Use `.crewstart` first.' }, { quoted: message });
        return true;
    }
    if (!canManageCrew(chatId, senderId)) {
        await sock.sendMessage(chatId, { text: 'Only the captain or first mate can pardon.' }, { quoted: message });
        return true;
    }
    const cooldownRemaining = getCooldownRemaining(crew, `pardoner:${senderId}`);
    if (cooldownRemaining > 0) {
        await sock.sendMessage(chatId, { text: buildCooldownText(cooldownRemaining) }, { quoted: message });
        return true;
    }

    const targetId = getMentionedTarget(message, mentionedJids, rawText);
    const crewMemberId = resolveCrewMemberJid(crew, targetId) || targetId;
    if (!crewMemberId) {
        await sock.sendMessage(chatId, { text: 'Tag a member.\n> `.pardoner @user`' }, { quoted: message });
        return true;
    }

    updateCrew(chatId, (draft) => {
        draft.marooned = Array.isArray(draft.marooned) ? draft.marooned.filter((jid) => !sameUserId(jid, crewMemberId)) : [];
        if (draft.maroonedUntil && typeof draft.maroonedUntil === 'object') {
            for (const key of Object.keys(draft.maroonedUntil)) {
                if (sameUserId(key, crewMemberId)) delete draft.maroonedUntil[key];
            }
        }
        return draft;
    }, senderId);

    await sock.sendMessage(chatId, {
        text: ['⚖️ Pardoned!', '', mentionTag(crewMemberId)].join('\n'),
        mentions: [crewMemberId]
    }, { quoted: message });
    setCrewCooldown(chatId, `pardoner:${senderId}`, COOLDOWNS.pardoner, senderId);
    return true;
}

async function raidCommand(sock, chatId, message, senderId) {
    const crew = collectHourlyIncome(chatId, senderId).crew;
    if (!crew) {
        await sock.sendMessage(chatId, { text: 'You do not have a pirate crew yet.\n> Use `.crewstart` first.' }, { quoted: message });
        return true;
    }
    if (!isCrewMember(chatId, senderId)) {
        await sock.sendMessage(chatId, { text: 'Only crew members can start a raid.' }, { quoted: message });
        return true;
    }

    const raid = getRaidState();
    if (Number(raid.activeUntil || 0) > Date.now()) {
        await sock.sendMessage(chatId, { text: '⚔️ A raid is already live.\n\n> Use `.joinraid`' }, { quoted: message });
        return true;
    }
    if (Number(raid.cooldownUntil || 0) > Date.now()) {
        await sock.sendMessage(chatId, { text: buildCooldownText(Number(raid.cooldownUntil) - Date.now()) }, { quoted: message });
        return true;
    }

    startRaidState(chatId);
    await sock.sendMessage(chatId, {
        text: [
            '⚔️ *RAID OPEN*',
            '',
            '> The crew spotted a rich target.',
            '> Type `.joinraid` before the raid closes.'
        ].join('\n')
    }, { quoted: message });
    return true;
}

async function joinRaidCommand(sock, chatId, message, senderId) {
    const crew = collectHourlyIncome(chatId, senderId).crew;
    if (!crew) {
        await sock.sendMessage(chatId, { text: 'No pirate crew found here.' }, { quoted: message });
        return true;
    }
    if (!isCrewMember(chatId, senderId)) {
        await sock.sendMessage(chatId, { text: 'Only crew members can join a raid.' }, { quoted: message });
        return true;
    }
    if (isCrewLockedFor(crew, senderId)) {
        await sock.sendMessage(chatId, { text: 'Crew actions are paused right now.' }, { quoted: message });
        return true;
    }

    const result = joinRaidState(chatId, senderId);
    if (!result.ok) {
        await sock.sendMessage(chatId, {
            text: result.reason === 'already_joined'
                ? '⚔️ You are already in this raid.'
                : '⚔️ No active raid right now.'
        }, { quoted: message });
        return true;
    }

    const success = Math.random() < 0.75;
    if (success) {
        const personalReward = 150;
        const crewReward = 100;
        addBalance(senderId, personalReward);
        const bootyResult = addBooty(chatId, crewReward, senderId);
        await sock.sendMessage(chatId, {
            text: [
                '💰 Raid success!',
                '',
                `+${personalReward} gold each`,
                `> Crew booty: ${bootyResult.crew.booty.toLocaleString()}`
            ].join('\n')
        }, { quoted: message });
        return true;
    }

    await sock.sendMessage(chatId, {
        text: [
            '💥 Raid failed!',
            '',
            '> The target slipped away this time.'
        ].join('\n')
    }, { quoted: message });
    return true;
}

async function lockshipCommand(sock, chatId, message, senderId) {
    return shipLockCommand(sock, chatId, message, senderId, true);
}

async function openshipCommand(sock, chatId, message, senderId) {
    return shipLockCommand(sock, chatId, message, senderId, false);
}

async function manifestCommand(sock, chatId, message, senderId) {
    return crewListCommand(sock, chatId, message, senderId, '📜 *SHIP MANIFEST*', true);
}

async function crewCommand(sock, chatId, message, senderId, rawText) {
    const text = String(rawText || '').trim();
    const normalized = text.toLowerCase();
    const mentionedJids = collectMentionedJids(message, text);

    if (normalized === '.crewstart') return crewStartCommand(sock, chatId, message, senderId);
    if (normalized.startsWith('.recruit')) return recruitCommand(sock, chatId, message, senderId, text, mentionedJids);
    if (/^\.set\s+sail$/.test(normalized)) return setSailCommand(sock, chatId, message, senderId);
    if (normalized === '.crewlist') return crewListCommand(sock, chatId, message, senderId);
    if (normalized === '.manifest') return crewListCommand(sock, chatId, message, senderId, '📜 *SHIP MANIFEST*', true);
    if (normalized === '.booty') return bootyCommand(sock, chatId, message, senderId);
    if (normalized.startsWith('.spyglass')) return spyglassCommand(sock, chatId, message, senderId, text, mentionedJids);
    if (normalized.startsWith('.plunder')) return plunderCommand(sock, chatId, message, senderId);
    if (normalized.startsWith('.duel')) return duelCommand(sock, chatId, message, senderId, text, mentionedJids);
    if (normalized.startsWith('.bounty')) return bountyCommand(sock, chatId, message, senderId, text, mentionedJids);
    if (normalized === '.raid') return raidCommand(sock, chatId, message, senderId);
    if (normalized === '.joinraid') return joinRaidCommand(sock, chatId, message, senderId);
    if (normalized === '.anchor') return anchorCommand(sock, chatId, message, senderId);
    if (normalized === '.lockship') return shipLockCommand(sock, chatId, message, senderId, true);
    if (normalized === '.openship') return shipLockCommand(sock, chatId, message, senderId, false);
    if (normalized.startsWith('.firstmate')) return firstMateCommand(sock, chatId, message, senderId, text, mentionedJids);
    if (normalized.startsWith('.captain')) return captainCommand(sock, chatId, message, senderId, text, mentionedJids);
    if (normalized.startsWith('.maroon')) return maroonCommand(sock, chatId, message, senderId, text, mentionedJids);
    if (normalized.startsWith('.pardoner')) return pardonerCommand(sock, chatId, message, senderId, text, mentionedJids);
    return false;
}

module.exports = {
    crewCommand,
    handleCrewReply,
    crewStartCommand,
    crewListCommand,
    manifestCommand,
    bootyCommand,
    spyglassCommand,
    plunderCommand,
    firstMateCommand,
    captainCommand,
    maroonCommand,
    pardonerCommand,
    lockshipCommand,
    openshipCommand,
    recruitCommand,
    setSailCommand,
    duelCommand,
    bountyCommand,
    anchorCommand,
    raidCommand,
    joinRaidCommand
};
