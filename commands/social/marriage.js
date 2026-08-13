const https = require('https');
const { getBalance, addBalance } = require('../../lib/economy');
const { getRegisteredProfile, resolveRegisteredJid } = require('../../lib/registrationStore');
const {
    createMarriage,
    createProposal,
    getAllMarriages,
    getMarriageByUser,
    getProposalByUser,
    removeMarriage,
    removeProposalById,
    removeProposalByUser,
    canTriggerBonus,
    markBonusTriggered,
    normalizeJid
} = require('../../lib/marriageStore');

const MARRY_THUMB_URL = 'https://files.catbox.moe/88mbmj.png';
const DIVORCE_THUMB_URL = 'https://files.catbox.moe/o4iv9o.png';
const DIVORCE_COST = 2000;
const PROPOSAL_TIMEOUT_MS = 10 * 60 * 1000;

let marryThumbCache = null;
let divorceThumbCache = null;

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

async function getThumb(kind) {
    if (kind === 'marry') {
        if (!marryThumbCache) marryThumbCache = await fetchBuffer(MARRY_THUMB_URL).catch(() => null);
        return marryThumbCache;
    }
    if (!divorceThumbCache) divorceThumbCache = await fetchBuffer(DIVORCE_THUMB_URL).catch(() => null);
    return divorceThumbCache;
}

function mentionTag(jid) {
    const id = String(jid || '').split('@')[0].split(':')[0];
    return `@${id}`;
}

function formatCoupleDuration(ms) {
    const totalHours = Math.max(0, Math.floor(Number(ms || 0) / (60 * 60 * 1000)));
    const days = Math.floor(totalHours / 24);
    const hours = totalHours % 24;
    if (days > 0) return `${days}d`;
    return `${Math.max(1, hours)}h`;
}

function getRankPrefix(index) {
    if (index === 0) return '🥇';
    if (index === 1) return '🥈';
    if (index === 2) return '🥉';
    return `${index + 1}.`;
}

function getTargetJid(message, senderId) {
    const contextInfo = message?.message?.extendedTextMessage?.contextInfo
        || message?.message?.imageMessage?.contextInfo
        || message?.message?.videoMessage?.contextInfo
        || {};
    const mentioned = Array.isArray(contextInfo.mentionedJid) ? contextInfo.mentionedJid : [];
    const rawTarget = mentioned[0] || contextInfo.participant || '';
    if (!rawTarget) return '';
    return resolveRegisteredJid(rawTarget) || rawTarget;
}

function payload(text, thumb, thumbUrl, title, body) {
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
                ...(thumb ? { thumbnail: thumb } : { thumbnailUrl: thumbUrl })
            }
        }
    };
}

function isProposalExpired(proposal) {
    return Date.now() - Number(proposal?.createdAt || 0) > PROPOSAL_TIMEOUT_MS;
}

async function marryCommand(sock, chatId, message, senderId, isGroup) {
    if (!isGroup) {
        await sock.sendMessage(chatId, { text: 'This command can only be used in groups.' }, { quoted: message });
        return;
    }

    const targetId = getTargetJid(message, senderId);
    if (!targetId) {
        await sock.sendMessage(chatId, { text: 'Mention or reply to someone with `.marry @user`.' }, { quoted: message });
        return;
    }
    if (targetId === senderId) {
        await sock.sendMessage(chatId, { text: 'You cannot marry yourself.' }, { quoted: message });
        return;
    }
    if (!getRegisteredProfile(senderId) || !getRegisteredProfile(targetId)) {
        await sock.sendMessage(chatId, { text: 'Both users need to be registered first.' }, { quoted: message });
        return;
    }
    if (await getMarriageByUser(senderId)) {
        await sock.sendMessage(chatId, { text: 'You are already married.' }, { quoted: message });
        return;
    }
    if (await getMarriageByUser(targetId)) {
        await sock.sendMessage(chatId, { text: 'That user is already married.' }, { quoted: message });
        return;
    }

    const senderProposal = await getProposalByUser(senderId);
    if (senderProposal) {
        if (isProposalExpired(senderProposal)) await removeProposalById(senderProposal.id);
        else {
            await sock.sendMessage(chatId, { text: 'You already have a pending marriage proposal.' }, { quoted: message });
            return;
        }
    }
    const targetProposal = await getProposalByUser(targetId);
    if (targetProposal) {
        if (isProposalExpired(targetProposal)) await removeProposalById(targetProposal.id);
        else {
            await sock.sendMessage(chatId, { text: 'That user already has a pending marriage proposal.' }, { quoted: message });
            return;
        }
    }

    await createProposal(senderId, targetId, { chatId });
    const thumb = await getThumb('marry');
    await sock.sendMessage(chatId, {
        ...payload(
            `💍 Marriage Proposal\n\n${mentionTag(senderId)} wants to marry ${mentionTag(targetId)}\n\n> ${mentionTag(targetId)} reply with .accept or .reject\n> Proposal expires in 10 minutes`,
            thumb,
            MARRY_THUMB_URL,
            'MARRIAGE PROPOSAL',
            'Waiting for accept or reject'
        ),
        mentions: [senderId, targetId]
    }, { quoted: message });
}

async function acceptMarriageCommand(sock, chatId, message, senderId, isGroup) {
    if (!isGroup) {
        await sock.sendMessage(chatId, { text: 'This command can only be used in groups.' }, { quoted: message });
        return;
    }

    const proposal = await getProposalByUser(senderId);
    if (!proposal || proposal.to !== normalizeJid(senderId)) {
        await sock.sendMessage(chatId, { text: 'You have no marriage proposal to accept.' }, { quoted: message });
        return;
    }
    if (isProposalExpired(proposal)) {
        await removeProposalById(proposal.id);
        await sock.sendMessage(chatId, { text: 'That marriage proposal has expired.' }, { quoted: message });
        return;
    }
    if (await getMarriageByUser(proposal.from) || await getMarriageByUser(proposal.to)) {
        await removeProposalById(proposal.id);
        await sock.sendMessage(chatId, { text: 'Marriage failed because one user is already married now.' }, { quoted: message });
        return;
    }

    await removeProposalById(proposal.id);
    await createMarriage(proposal.from, proposal.to, { chatId: proposal.chatId || chatId });

    const thumb = await getThumb('marry');
    await sock.sendMessage(chatId, {
        ...payload(
            `💍 ✧ Married ✧\n\n${mentionTag(proposal.from)} ❤️ ${mentionTag(proposal.to)}\n\n> Forever starts now ♡`,
            thumb,
            MARRY_THUMB_URL,
            'MARRIAGE',
            'Forever starts now'
        ),
        mentions: [proposal.from, proposal.to]
    }, { quoted: message });
}

async function rejectMarriageCommand(sock, chatId, message, senderId, isGroup) {
    if (!isGroup) {
        await sock.sendMessage(chatId, { text: 'This command can only be used in groups.' }, { quoted: message });
        return;
    }

    const proposal = await getProposalByUser(senderId);
    if (!proposal || (proposal.from !== normalizeJid(senderId) && proposal.to !== normalizeJid(senderId))) {
        await sock.sendMessage(chatId, { text: 'You have no marriage proposal to reject.' }, { quoted: message });
        return;
    }
    await removeProposalById(proposal.id);
    await sock.sendMessage(chatId, {
        text: `💔 Proposal Rejected\n\n${mentionTag(senderId)} rejected ${mentionTag(proposal.from)}'s proposal.`,
        mentions: [senderId, proposal.from]
    }, { quoted: message });
}

async function divorceCommand(sock, chatId, message, senderId, isGroup) {
    if (!isGroup) {
        await sock.sendMessage(chatId, { text: 'This command can only be used in groups.' }, { quoted: message });
        return;
    }

    const marriage = await getMarriageByUser(senderId);
    if (!marriage) {
        await sock.sendMessage(chatId, { text: 'You are not married.' }, { quoted: message });
        return;
    }

    const balance = getBalance(senderId);
    if (balance < DIVORCE_COST) {
        await sock.sendMessage(chatId, {
            text: `💔 Divorce failed\n\n> You need ${DIVORCE_COST.toLocaleString()} ¥ 💴`
        }, { quoted: message });
        return;
    }

    const [firstUser, secondUser] = marriage.users;
    addBalance(senderId, -DIVORCE_COST, { awardXp: false });
    await removeMarriage(senderId);
    await removeProposalByUser(firstUser);
    await removeProposalByUser(secondUser);

    const thumb = await getThumb('divorce');
    await sock.sendMessage(chatId, {
        ...payload(
            `💔 ✧ Divorced ✧\n\n${mentionTag(firstUser)} × ${mentionTag(secondUser)}\n\n-${DIVORCE_COST.toLocaleString()} ¥ 💴\n\n> Some endings come at a cost`,
            thumb,
            DIVORCE_THUMB_URL,
            'DIVORCE',
            'The bond has been broken'
        ),
        mentions: [firstUser, secondUser]
    }, { quoted: message });
}

async function maybeTriggerBondBonus(sock, chatId, message, senderId, isGroup) {
    if (!isGroup || !senderId || message?.key?.fromMe) return;

    const marriage = await getMarriageByUser(senderId);
    if (!marriage || !canTriggerBonus(marriage)) return;

    if (Math.random() > 0.12) return;

    const amount = 50 + Math.floor(Math.random() * 951);
    addBalance(senderId, amount, { awardXp: false });
    await markBonusTriggered(marriage.id, Date.now());

    await sock.sendMessage(chatId, {
        text: `❤️ Bond Bonus!\n\n+${amount.toLocaleString()} ¥ 💴`
    }, { quoted: message });
}

async function couplesCommand(sock, chatId, message) {
    const rawMarriages = await getAllMarriages();
    const marriages = rawMarriages.slice(0, 10);
    if (!marriages.length) {
        await sock.sendMessage(chatId, { text: 'No couples yet.' }, { quoted: message });
        return;
    }

    const now = Date.now();
    const mentions = [];
    const lines = ['💑 ✧ Couples ✧', ''];

    marriages.forEach((pair, index) => {
        const [firstUser, secondUser] = pair.users;
        mentions.push(firstUser, secondUser);
        lines.push(`> ${getRankPrefix(index)} ${mentionTag(firstUser)} ⟡ ${mentionTag(secondUser)} ・ *${formatCoupleDuration(now - Number(pair.marriedAt || now))}*`);
    });

    await sock.sendMessage(chatId, {
        text: lines.join('\n'),
        mentions
    }, { quoted: message });
}

module.exports = {
    couplesCommand,
    marryCommand,
    acceptMarriageCommand,
    rejectMarriageCommand,
    divorceCommand,
    maybeTriggerBondBonus
};
