const { isJidGroup } = require('./baileys');
const { getAntilink, incrementWarningCount, resetWarningCount, isSudo } = require('../lib/index');
const isAdmin = require('../lib/isAdmin');
const config = require('../config');
const https = require('https');

const WARN_COUNT = config.WARN_COUNT || 3;
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
    if (!thumbCache) thumbCache = await fetchBuffer(THUMB_URL).catch(() => null);
    return thumbCache;
}

function containsURL(str) {
    if (!str || typeof str !== 'string') return false;
    const text = str.trim();
    const schemeRegex = /\bhttps?:\/\/[^\s]+/i;
    const wwwRegex = /\bwww\.[^\s]+\.[a-z]{2,}(?:\/[^\s]*)?/i;
    const waInviteRegex = /\bchat\.whatsapp\.com\/[A-Za-z0-9-_]{5,}/i;
    return schemeRegex.test(text) || wwwRegex.test(text) || waInviteRegex.test(text);
}

function getWarnDots(current, total) {
    return Array.from({ length: total }, (_, i) => i < current ? '●' : '○').join(' ');
}

function buildCard(lines, thumb) {
    return {
        text:
            `┌─〔 *🎀 ᴡɪsᴛᴏʀɪᴀ sᴇᴄᴜʀɪᴛʏ* 〕─┐\n` +
            `│\n` +
            lines.map(l => `│  ${l}`).join('\n') +
            `\n│\n└─────────────────┘`,
        contextInfo: {
            externalAdReply: {
                title: 'ᴡɪsᴛᴏʀɪᴀ sᴇᴄᴜʀɪᴛʏ',
                body: 'ʟɪɴᴋ ᴅᴇᴛᴇᴄᴛᴇᴅ',
                sourceUrl: '',
                mediaType: 1,
                renderLargerThumbnail: false,
                showAdAttribution: 0,
                thumbnail: thumb
            }
        }
    };
}

async function Antilink(msg, sock, adminStatus = {}) {
    const jid = msg.key.remoteJid;
    if (!isJidGroup(jid)) return;

    const SenderMessage = msg.message?.conversation ||
                          msg.message?.extendedTextMessage?.text || '';
    if (!SenderMessage || typeof SenderMessage !== 'string') return;

    const sender = msg.key.participant;
    if (!sender) return;

    const isSenderAdmin = adminStatus.isSenderAdmin;
    if (isSenderAdmin) return;

    const senderIsSudo = await isSudo(sender);
    if (senderIsSudo) return;

    if (!containsURL(SenderMessage.trim())) return;

    const antilinkConfig = await getAntilink(jid, 'on');
    if (!antilinkConfig) return;

    const action = antilinkConfig.action;
    const userNumber = sender.split('@')[0];
    const thumb = await getThumb();

    try {
        const deleteKey = {
            remoteJid: jid,
            fromMe: false,
            id: msg?.key?.id,
            participant: msg?.key?.participant || sender
        };
        if (deleteKey.id) {
            await sock.sendMessage(jid, { delete: deleteKey });
        }

        switch (action) {
            case 'delete': {
                await sock.sendMessage(jid, {
                    ...buildCard([
                        `👤 ᴜsᴇʀ    : @${userNumber}`,
                        `*⚠️ ᴀᴄᴛɪᴏɴ*  : ʟɪɴᴋ ʀᴇᴍᴏᴠᴇᴅ`,
                        ``,
                        `*📡 sᴛᴀᴛᴜs*  : ᴍᴏɴɪᴛᴏʀɪɴɢ`,
                        `*🎵 ɴᴏᴛᴇ*    : ɴᴏ ʟɪɴᴋs ᴀʟʟᴏᴡᴇᴅ`
                    ], thumb),
                    mentions: [sender]
                });
                break;
            }

            case 'kick': {
                await sock.groupParticipantsUpdate(jid, [sender], 'remove');
                await sock.sendMessage(jid, {
                    ...buildCard([
                        `👤 ᴜsᴇʀ    : @${userNumber}`,
                        `*💢 ᴀᴄᴛɪᴏɴ*  : ᴋɪᴄᴋᴇᴅ`,
                        ``,
                        `*📡 sᴛᴀᴛᴜs*  : ᴇᴊᴇᴄᴛᴇᴅ`,
                        `*🎵 ɴᴏᴛᴇ*    : sᴀʏᴏɴᴀʀᴀ~`
                    ], thumb),
                    mentions: [sender]
                });
                break;
            }

            case 'warn': {
                const warningCount = await incrementWarningCount(jid, sender);
                const dots = getWarnDots(warningCount, WARN_COUNT);
                const warnsLeft = WARN_COUNT - warningCount;

                if (warningCount >= WARN_COUNT) {
                    await sock.groupParticipantsUpdate(jid, [sender], 'remove');
                    await resetWarningCount(jid, sender);
                    await sock.sendMessage(jid, {
                        ...buildCard([
                            `👤 ᴜsᴇʀ    : @${userNumber}`,
                            `*💢 ᴀᴄᴛɪᴏɴ*  : ʀᴇᴍᴏᴠᴇᴅ`,
                            ``,
                            `*🚫 ᴡᴀʀɴ*    : ${dots}`,
                            ``,
                            `*📡 sᴛᴀᴛᴜs*  : ᴇᴊᴇᴄᴛᴇᴅ`,
                            `*🎵 ɴᴏᴛᴇ*    : sᴀʏᴏɴᴀʀᴀ~`
                        ], thumb),
                        mentions: [sender]
                    });
                } else {
                    await sock.sendMessage(jid, {
                        ...buildCard([
                            `👤 ᴜsᴇʀ    : @${userNumber}`,
                            `*⚠️ ᴀᴄᴛɪᴏɴ*  : ʟɪɴᴋ ʀᴇᴍᴏᴠᴇᴅ`,
                            ``,
                            `*🚫 ᴡᴀʀɴ*    : ${dots}`,
                            ``,
                            `*📡 sᴛᴀᴛᴜs*  : ᴍᴏɴɪᴛᴏʀɪɴɢ`,
                            `*⏭️ ɴᴇxᴛ*    : ${warnsLeft === 1 ? '*ʀᴇᴍᴏᴠᴀʟ*' : `${warnsLeft} ᴡᴀʀɴs ʟᴇꜰᴛ`}`
                        ], thumb),
                        mentions: [sender]
                    });
                }
                break;
            }

            default: {
                await sock.sendMessage(jid, {
                    ...buildCard([
                        `👤 ᴜsᴇʀ    : @${userNumber}`,
                        `*⚠️ ᴀᴄᴛɪᴏɴ*  : ʟɪɴᴋ ʀᴇᴍᴏᴠᴇᴅ`,
                        ``,
                        `*📡 sᴛᴀᴛᴜs*  : ᴍᴏɴɪᴛᴏʀɪɴɢ`,
                        `*🎵 ɴᴏᴛᴇ*    : ɴᴏ ʟɪɴᴋs ᴀʟʟᴏᴡᴇᴅ`
                    ], thumb),
                    mentions: [sender]
                });
            }
        }
    } catch (error) {
        console.error('Error in Antilink:', error);
    }
}

module.exports = { Antilink };
