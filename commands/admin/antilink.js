const { setAntilink, getAntilink, removeAntilink } = require('../../lib/index');
const https = require('https');

const THUMB_URL = 'https://i.ibb.co/xqNw3R4X/59b205d1-7430-4f5d-8168-2f510aa694fd-removalai-preview.png';
let thumbCache = null;

function fetchBuffer(url) {
    return new Promise((resolve, reject) => {
        https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
            if (res.statusCode === 301 || res.statusCode === 302) {
                return fetchBuffer(res.headers.location).then(resolve).catch(reject);
            }
            const chunks = [];
            res.on('data', chunk => chunks.push(chunk));
            res.on('end', () => resolve(Buffer.concat(chunks)));
            res.on('error', reject);
        }).on('error', reject);
    });
}

async function getThumb() {
    if (!thumbCache) thumbCache = await fetchBuffer(THUMB_URL);
    return thumbCache;
}

function buildWarnText(userNumber, actionText, currentWarns, maxWarns = 5) {
    const dots = Array.from({ length: maxWarns }, (_, i) => (i < currentWarns ? '●' : '○')).join('');
    const remaining = Math.max(0, maxWarns - currentWarns);
    return [
        '*╭⚠ WISTORIA SECURITY╮*',
        `│ @${userNumber}`,
        `│ × ${actionText}`,
        `│ warn: ${dots}`,
        `│ ${remaining}/${maxWarns} left`,
        '╰──────────────'
    ].join('\n');
}

const warnMap = new Map();

const linkPatterns = /https?:\/\/\S+|www\.\S+|(?:[a-z0-9-]+\.)+[a-z]{2,}(?:\/\S*)?/i;

function getWarnDots(count) {
    return ['●', '●', '●'].map((_, i) => i < count ? '●' : '○').join(' ');
}

async function handleAntilinkCommand(sock, chatId, userMessage, senderId, isSenderAdmin, message) {
    try {
        if (!isSenderAdmin) {
            await sock.sendMessage(chatId, {
                text:
                    `┌─〔 *🎀 ᴡɪsᴛᴏʀɪᴀ sᴇᴄᴜʀɪᴛʏ* 〕─┐\n` +
                    `│\n` +
                    `│  🚫 *ᴀᴄᴄᴇss ᴅᴇɴɪᴇᴅ*\n` +
                    `│  ᴀᴅᴍɪɴs ᴏɴʟʏ\n` +
                    `│\n` +
                    `└─────────────────┘`
            }, { quoted: message });
            return;
        }

        const prefix = '.';
        const args = userMessage.slice(9).toLowerCase().trim().split(' ');
        const action = args[0];

        if (!action) {
            await sock.sendMessage(chatId, {
                text:
                    `┌─〔 *🎀 ᴡɪsᴛᴏʀɪᴀ sᴇᴄᴜʀɪᴛʏ* 〕─┐\n` +
                    `│\n` +
                    `│  📋 *ᴀɴᴛɪʟɪɴᴋ ᴄᴏᴍᴍᴀɴᴅs*\n` +
                    `│\n` +
                    `│  ✦ ${prefix}antilink on\n` +
                    `│  ✦ ${prefix}antilink off\n` +
                    `│  ✦ ${prefix}antilink set delete\n` +
                    `│  ✦ ${prefix}antilink set kick\n` +
                    `│  ✦ ${prefix}antilink set warn\n` +
                    `│  ✦ ${prefix}antilink get\n` +
                    `│\n` +
                    `└─────────────────┘`
            }, { quoted: message });
            return;
        }

        switch (action) {
            case 'on': {
                const existing = await getAntilink(chatId, 'on');
                if (existing?.enabled) {
                    await sock.sendMessage(chatId, {
                        text:
                            `┌─〔 *🎀 ᴡɪsᴛᴏʀɪᴀ sᴇᴄᴜʀɪᴛʏ* 〕─┐\n` +
                            `│\n` +
                            `│  ⚡ ᴀɴᴛɪʟɪɴᴋ ɪs ᴀʟʀᴇᴀᴅʏ *ᴏɴ*\n` +
                            `│\n` +
                            `└─────────────────┘`
                    }, { quoted: message });
                    return;
                }
                const result = await setAntilink(chatId, 'on', 'delete');
                await sock.sendMessage(chatId, {
                    text:
                        `┌─〔 *🎀 ᴡɪsᴛᴏʀɪᴀ sᴇᴄᴜʀɪᴛʏ* 〕─┐\n` +
                        `│\n` +
                        `│  ✅ *ᴀɴᴛɪʟɪɴᴋ ᴇɴᴀʙʟᴇᴅ*\n` +
                        `│  📡 sᴛᴀᴛᴜs : ᴍᴏɴɪᴛᴏʀɪɴɢ\n` +
                        `│\n` +
                        `└─────────────────┘`
                }, { quoted: message });
                break;
            }

            case 'off': {
                await removeAntilink(chatId, 'on');
                await sock.sendMessage(chatId, {
                    text:
                        `┌─〔 *🎀 ᴡɪsᴛᴏʀɪᴀ sᴇᴄᴜʀɪᴛʏ* 〕─┐\n` +
                        `│\n` +
                        `│  🔕 *ᴀɴᴛɪʟɪɴᴋ ᴅɪsᴀʙʟᴇᴅ*\n` +
                        `│  📡 sᴛᴀᴛᴜs : ɪɴᴀᴄᴛɪᴠᴇ\n` +
                        `│\n` +
                        `└─────────────────┘`
                }, { quoted: message });
                break;
            }

            case 'set': {
                if (args.length < 2) {
                    await sock.sendMessage(chatId, {
                        text: `⚠️ ᴜsᴀɢᴇ: *${prefix}antilink set delete | kick | warn*`
                    }, { quoted: message });
                    return;
                }
                const setAction = args[1];
                if (!['delete', 'kick', 'warn'].includes(setAction)) {
                    await sock.sendMessage(chatId, {
                        text: `❌ ɪɴᴠᴀʟɪᴅ. ᴄʜᴏᴏsᴇ *delete*, *kick*, ᴏʀ *warn*`
                    }, { quoted: message });
                    return;
                }
                const setResult = await setAntilink(chatId, 'on', setAction);
                await sock.sendMessage(chatId, {
                    text:
                        `┌─〔 *🎀 ᴡɪsᴛᴏʀɪᴀ sᴇᴄᴜʀɪᴛʏ* 〕─┐\n` +
                        `│\n` +
                        `│  ⚙️ *ᴀᴄᴛɪᴏɴ ᴜᴘᴅᴀᴛᴇᴅ*\n` +
                        `│  ✦ sᴇᴛ ᴛᴏ : *${setAction}*\n` +
                        `│\n` +
                        `└─────────────────┘`
                }, { quoted: message });
                break;
            }

            case 'get': {
                const status = await getAntilink(chatId, 'on');
                await sock.sendMessage(chatId, {
                    text:
                        `┌─〔 *🎀 ᴡɪsᴛᴏʀɪᴀ sᴇᴄᴜʀɪᴛʏ* 〕─┐\n` +
                        `│\n` +
                        `│  📋 *ᴀɴᴛɪʟɪɴᴋ sᴛᴀᴛᴜs*\n` +
                        `│\n` +
                        `│  📡 sᴛᴀᴛᴜs  : *${status?.enabled ? 'ᴏɴ' : 'ᴏꜰꜰ'}*\n` +
                        `│  ⚙️ ᴀᴄᴛɪᴏɴ  : *${status?.action || 'ɴᴏᴛ sᴇᴛ'}*\n` +
                        `│\n` +
                        `└─────────────────┘`
                }, { quoted: message });
                break;
            }

            default:
                await sock.sendMessage(chatId, {
                    text: `⚠️ ᴜɴᴋɴᴏᴡɴ ᴀᴄᴛɪᴏɴ. ᴜsᴇ *${prefix}antilink* ꜰᴏʀ ʜᴇʟᴘ.`
                }, { quoted: message });
        }
    } catch (error) {
        console.error('Error in antilink command:', error);
        await sock.sendMessage(chatId, { text: '❌ ᴇʀʀᴏʀ ᴘʀᴏᴄᴇssɪɴɢ ᴄᴏᴍᴍᴀɴᴅ' });
    }
}

async function handleLinkDetection(sock, chatId, message, userMessage, senderId) {
    try {
        const antilinkSetting = await getAntilink(chatId, 'on');
        if (!antilinkSetting?.enabled) return;

        if (!linkPatterns.test(userMessage)) return;

        // delete the link message first
        try {
            await sock.sendMessage(chatId, {
                delete: {
                    remoteJid: chatId,
                    fromMe: false,
                    id: message.key.id,
                    participant: message.key.participant || senderId
                }
            });
        } catch (e) {
            console.error('[antilink] delete failed:', e.message);
        }

        if (!warnMap.has(chatId)) warnMap.set(chatId, new Map());
        const groupWarns = warnMap.get(chatId);
        const currentWarns = (groupWarns.get(senderId) || 0) + 1;
        groupWarns.set(senderId, currentWarns);

        const userNumber = senderId.split('@')[0];
        const thumb = await getThumb().catch(() => null);
        const dots = getWarnDots(currentWarns);

        if (currentWarns >= 5) {
            groupWarns.delete(senderId);

            try {
                await sock.groupParticipantsUpdate(chatId, [senderId], 'remove');
            } catch (e) {
                console.error('[antilink] kick failed:', e.message);
            }

            await sock.sendMessage(chatId, {
                text:
                    `┌─〔 *🎀 ᴡɪsᴛᴏʀɪᴀ sᴇᴄᴜʀɪᴛʏ* 〕─┐\n` +
                    `│\n` +
                    `│  👤 ᴜsᴇʀ    : @${userNumber}\n` +
                    `│  *💢 ᴀᴄᴛɪᴏɴ*  : ʀᴇᴍᴏᴠᴇᴅ\n` +
                    `│\n` +
                    `│  *🚫 ᴡᴀʀɴ*    : ● ● ●\n` +
                    `│\n` +
                    `│  *📡 sᴛᴀᴛᴜs*  : ᴇᴊᴇᴄᴛᴇᴅ\n` +
                    `│  *🎵 ɴᴏᴛᴇ*    : sᴀʏᴏɴᴀʀᴀ~\n` +
                    `│\n` +
                    `└─────────────────┘`,
                mentions: [senderId],
                contextInfo: {
                    externalAdReply: {
                        title: 'ᴡɪsᴛᴏʀɪᴀ sᴇᴄᴜʀɪᴛʏ',
                        body: 'ᴜsᴇʀ ʀᴇᴍᴏᴠᴇᴅ',
                        sourceUrl: '',
                        mediaType: 1,
                        renderLargerThumbnail: false,
                        showAdAttribution: 0,
                        thumbnail: thumb
                    }
                }
            });

        } else {
            const warnsLeft = 3 - currentWarns;

            await sock.sendMessage(chatId, {
                text: buildWarnText(userNumber, 'link removed', currentWarns, 5),
                mentions: [senderId],
                contextInfo: {
                    externalAdReply: {
                        title: 'ᴡɪsᴛᴏʀɪᴀ sᴇᴄᴜʀɪᴛʏ',
                        body: `ᴡᴀʀɴɪɴɢ ${currentWarns}/5 — ${Math.max(0, 5 - currentWarns)} ʟᴇꜰᴛ`,
                        sourceUrl: '',
                        mediaType: 1,
                        renderLargerThumbnail: false,
                        showAdAttribution: 0,
                        thumbnail: thumb
                    }
                }
            });
        }

    } catch (error) {
        console.error('[antilink] error:', error);
    }
}

module.exports = {
    handleAntilinkCommand,
    handleLinkDetection,
};
