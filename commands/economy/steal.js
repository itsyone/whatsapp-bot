const https = require('https');
const { getBalance, addBalanceAtomic, transferBalanceAtomic, getEconomySnapshot } = require('../../lib/economy');
const { getRegisteredProfile, addInventoryItem } = require('../../lib/registrationStore');
const { getCooldown, setCooldown, formatCooldown } = require('../../lib/gathering');

const SUCCESS_THUMB_URL = 'https://files.catbox.moe/a5nlzl.png';
const FAIL_THUMB_URL = 'https://files.catbox.moe/9suzrf.png';
const PISTOL_PRICE = 1000;
const MIN_COOLDOWN_MS = 60 * 60 * 1000;
const MAX_COOLDOWN_MS = 2 * 60 * 60 * 1000;
const MIN_TARGET_WALLET = 200;
const SUCCESS_RATE = 0.48;
const CAUGHT_RATE = 0.30;

const SUCCESS_TEXTS = [
    '🦹‍♂️ You stole *{amount} coins* from @user 💸\n> clean hit, no traces left',
    '💰 Steal successful: *{amount} coins* taken\n> target never noticed',
    '🕶️ You got *{amount} coins* from @user\n> smooth and silent'
];

const FAIL_TEXTS = [
    '🚔 Steal failed, lost *{amount} coins*\n> you got caught instantly',
    '💥 You were caught stealing\n> everything went wrong',
    '❌ Failed attempt, no reward\n> security was too strong'
];

const EMPTY_TEXTS = [
    '🪙 No coins found\n> empty target',
    '😐 Nothing to steal from @user\n> waste of time'
];

const COUNTER_TEXTS = [
    '☠️ @user stole *{amount} coins* from you\n> you got outplayed',
    '💀 Counter attack! Lost *{amount} coins*\n> turned into a victim'
];

let successThumbCache = null;
let failThumbCache = null;

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

async function getThumb(kind = 'success') {
    if (kind === 'success') {
        if (!successThumbCache) successThumbCache = await fetchBuffer(SUCCESS_THUMB_URL).catch(() => null);
        return successThumbCache;
    }
    if (!failThumbCache) failThumbCache = await fetchBuffer(FAIL_THUMB_URL).catch(() => null);
    return failThumbCache;
}

function mentionTag(jid) {
    const id = String(jid || '').split('@')[0].split(':')[0];
    return `@${id}`;
}

function getTargetJid(message, rawText = '') {
    const mentioned = message?.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
    if (mentioned[0]) return mentioned[0];

    const quotedParticipant = message?.message?.extendedTextMessage?.contextInfo?.participant;
    if (quotedParticipant) return quotedParticipant;

    const parts = String(rawText || '').trim().split(/\s+/).slice(1);
    for (const part of parts) {
        const digits = part.replace(/\D/g, '');
        if (digits.length >= 7) {
            return `${digits}@s.whatsapp.net`;
        }
    }

    return '';
}

function choose(list) {
    return list[Math.floor(Math.random() * list.length)] || list[0] || '';
}

function formatMoney(amount) {
    return Number(Math.max(0, Math.floor(Number(amount || 0)))).toLocaleString();
}

function randomCooldownMs() {
    return Math.floor(MIN_COOLDOWN_MS + (Math.random() * (MAX_COOLDOWN_MS - MIN_COOLDOWN_MS)));
}

function randomBetween(min, max) {
    return min + (Math.random() * (max - min));
}

function buildPayload(text, thumb, kind = 'success') {
    const title = kind === 'success' ? 'STEAL' : kind === 'empty' ? 'NO LOOT' : 'ARRESTED';
    const body = kind === 'success' ? 'smooth and silent' : kind === 'empty' ? 'target was dry' : 'caught on the move';
    return {
        text,
        contextInfo: {
            externalAdReply: {
                title,
                body,
                mediaType: 1,
                mediaUrl: '',
                renderLargerThumbnail: false,
                showAdAttribution: false,
                sourceUrl: '',
                ...(thumb ? { thumbnail: thumb } : { thumbnailUrl: kind === 'success' ? SUCCESS_THUMB_URL : FAIL_THUMB_URL })
            }
        }
    };
}

function withTargetText(template, amount, targetId) {
    return template
        .replace('{amount}', formatMoney(amount))
        .replace(/@user/g, mentionTag(targetId));
}

async function ensurePistol(senderId) {
    const profile = getRegisteredProfile(senderId);
    const current = Math.max(0, Number(profile?.inventory?.pistol || 0));
    if (current > 0) return { ok: true, bought: false };

    const wallet = getBalance(senderId);
    if (wallet < PISTOL_PRICE) {
        return { ok: false, reason: 'need_pistol_money', wallet };
    }

    await addBalanceAtomic(senderId, -PISTOL_PRICE, {
        force: true,
        awardXp: false,
        source: 'steal_pistol_purchase',
        category: 'economy',
        actorJid: senderId
    });
    addInventoryItem(senderId, 'pistol', 1);
    return { ok: true, bought: true };
}

async function stealCommand(sock, chatId, message, senderId, rawText = '') {
    try {
        const senderProfile = getRegisteredProfile(senderId);
        if (!senderProfile) {
            await sock.sendMessage(chatId, { text: 'Register first with `.register`.' }, { quoted: message });
            return;
        }

        const cooldownExpiry = Number(getCooldown(senderId, 'steal') || 0);
        const cooldownRemaining = Math.max(0, cooldownExpiry - Date.now());
        if (cooldownRemaining > 0) {
            await sock.sendMessage(chatId, {
                text: `🕒 Steal cooldown active\n> try again in ${formatCooldown(cooldownRemaining)}`
            }, { quoted: message });
            return;
        }

        const targetId = getTargetJid(message, rawText);
        if (!targetId) {
            await sock.sendMessage(chatId, {
                text: 'Use `.steal @user` or reply with `.steal`.'
            }, { quoted: message });
            return;
        }
        if (targetId === senderId) {
            await sock.sendMessage(chatId, { text: 'You cannot steal from yourself.' }, { quoted: message });
            return;
        }

        const targetProfile = getRegisteredProfile(targetId);
        if (!targetProfile) {
            await sock.sendMessage(chatId, { text: 'That user is not registered yet.' }, { quoted: message });
            return;
        }

        const pistol = await ensurePistol(senderId);
        if (!pistol.ok) {
            await sock.sendMessage(chatId, {
                text: `🔫 You need ¥${formatMoney(PISTOL_PRICE)} to get a pistol.\n> Wallet: ¥${formatMoney(pistol.wallet)}`
            }, { quoted: message });
            return;
        }

        const cooldownMs = randomCooldownMs();
        setCooldown(senderId, 'steal', Date.now() + cooldownMs);

        const targetSnapshot = getEconomySnapshot(targetId);
        const targetWallet = Math.max(0, Number(targetSnapshot?.wallet || 0));
        const setupLine = pistol.bought ? `\n\n> pistol acquired for ¥${formatMoney(PISTOL_PRICE)}` : '';

        if (targetWallet < MIN_TARGET_WALLET) {
            const thumb = await getThumb('fail');
            const text = withTargetText(choose(EMPTY_TEXTS), 0, targetId) + setupLine;
            await sock.sendMessage(chatId, {
                ...buildPayload(text, thumb, 'empty'),
                mentions: [targetId]
            }, { quoted: message });
            return;
        }

        const roll = Math.random();

        if (roll < SUCCESS_RATE) {
            const stealAmount = Math.min(
                targetWallet,
                Math.max(120, Math.floor(targetWallet * randomBetween(0.08, 0.18)))
            );
            const transfer = await transferBalanceAtomic(targetId, senderId, stealAmount, {
                force: true,
                awardXp: false,
                source: 'steal_success',
                category: 'crime',
                actorJid: senderId,
                meta: { targetJid: targetId }
            });
            if (!transfer.ok || !transfer.amount) {
                const thumb = await getThumb('fail');
                const text = withTargetText(choose(EMPTY_TEXTS), 0, targetId) + setupLine;
                await sock.sendMessage(chatId, {
                    ...buildPayload(text, thumb, 'empty'),
                    mentions: [targetId]
                }, { quoted: message });
                return;
            }

            const thumb = await getThumb('success');
            const text = withTargetText(choose(SUCCESS_TEXTS), transfer.amount, targetId) + setupLine;
            await sock.sendMessage(chatId, {
                ...buildPayload(text, thumb, 'success'),
                mentions: [targetId]
            }, { quoted: message });
            return;
        }

        if (roll < SUCCESS_RATE + CAUGHT_RATE) {
            const senderWallet = Math.max(0, Number(getEconomySnapshot(senderId)?.wallet || 0));
            const counterAmount = Math.min(
                senderWallet,
                Math.max(150, Math.floor(senderWallet * randomBetween(0.06, 0.14)))
            );

            if (counterAmount > 0) {
                const transfer = await transferBalanceAtomic(senderId, targetId, counterAmount, {
                    force: true,
                    awardXp: false,
                    source: 'steal_counter',
                    category: 'crime',
                    actorJid: targetId,
                    meta: { sourceJid: senderId }
                });
                const thumb = await getThumb('fail');
                const text = withTargetText(choose(COUNTER_TEXTS), transfer.amount || counterAmount, targetId) + setupLine;
                await sock.sendMessage(chatId, {
                    ...buildPayload(text, thumb, 'fail'),
                    mentions: [targetId]
                }, { quoted: message });
                return;
            }
        }

        const thumb = await getThumb('fail');
        const text = withTargetText(choose(FAIL_TEXTS), 0, targetId) + setupLine;
        await sock.sendMessage(chatId, {
            ...buildPayload(text, thumb, 'fail'),
            mentions: [targetId]
        }, { quoted: message });
    } catch (error) {
        console.error('[steal] error:', error.message);
        await sock.sendMessage(chatId, { text: 'Steal failed.' }, { quoted: message });
    }
}

module.exports = {
    name: 'steal',
    alias: ['rob'],
    async execute(ctx) {
        return stealCommand(ctx.sock || null, ctx.chatId || null, ctx.message || null, ctx.senderId || null, ctx.rawText || null);
    }
};
