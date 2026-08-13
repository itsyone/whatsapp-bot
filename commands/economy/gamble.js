const fs = require('fs');
const path = require('path');
const { hasPermission } = require('../../lib/permissionHandler');
const { isGamblingEnabled, setGamblingEnabled, GAMBLING_GROUP_LINK } = require('../../lib/gamblingAccess');
const { buildOfficialLinkPreview } = require('../../lib/linkPreviewHelper');

const IMAGE_PATH = path.join(__dirname, '../lib/gamble.png');

const GAMBLE_TEXT = `🎰 *GAMBLING*
━━━━━━━━━━━━━━

🎲 chance
┣ ✦ .coinflip / .cf <heads/tails> [amount]
┣ ✦ .dice [amount]
┣ ✦ .market up/down [amount]

🎡 casino
┣ ✦ .roulette [amount]
┣ ✦ .slots [amount]
┣ ✦ .jackpot [amount]
┣ ✦ .wheel [amount]

⚔️ versus
┣ ✦ .bet [@user] [amount]

🎟️ misc
┣ ✦ .raffle

━━━━━━━━━━━━━━`;

async function sendGambleMenu(sock, chatId, message, statusLine = '') {
    const caption = statusLine ? `${statusLine}\n\n${GAMBLE_TEXT}` : GAMBLE_TEXT;
    try {
        if (fs.existsSync(IMAGE_PATH)) {
            const image = fs.readFileSync(IMAGE_PATH);
            await sock.sendMessage(
                chatId,
                {
                    image,
                    caption
                },
                { quoted: message }
            );
            return;
        }

        await sock.sendMessage(chatId, { text: caption }, { quoted: message });
    } catch (error) {
        console.error('[gamble] error:', error?.message || error);
        await sock.sendMessage(chatId, { text: caption }, { quoted: message });
    }
}

async function sendDisabledGambleMenu(sock, chatId, message) {
    const text = [
        'Join the gambling group here:',
        GAMBLING_GROUP_LINK
    ].join('\n');

    try {
        const linkPreview = await buildOfficialLinkPreview(sock, GAMBLING_GROUP_LINK, {
            title: 'Wistoria Bets',
            description: 'WhatsApp Group Invite'
        });
        await sock.sendMessage(chatId, { text, linkPreview }, { quoted: message }); // FIXED: disabled gamble menu now shows join link preview
        return;
    } catch (error) {
        console.error('[gamble] disabled preview error:', error?.message || error);
    }

    await sock.sendMessage(chatId, { text }, { quoted: message }); // FIXED: disabled gamble menu plain-link fallback
}

async function gambleCommand(sock, chatId, message, senderId, args = []) {
    const sub = String(args[0] || '').trim().toLowerCase();
    const isGroup = String(chatId || '').endsWith('@g.us');

    if (sub === 'on' || sub === 'off') {
        if (!isGroup) {
            await sock.sendMessage(chatId, { text: 'Use `.gamble on` or `.gamble off` inside a group.' }, { quoted: message });
            return;
        }

        const allowed = await hasPermission(senderId, 'sudo');
        if (!allowed) {
            await sock.sendMessage(chatId, { text: "You don't have permission to use this command." }, { quoted: message }); // FIXED: sudo-only gambling toggle
            return;
        }

        const enable = sub === 'on';
        await setGamblingEnabled(chatId, enable);
        await sock.sendMessage(
            chatId,
            {
                text: enable
                    ? `✅ Gambling enabled in this group.\n\nInvite: ${GAMBLING_GROUP_LINK}` // FIXED: sudo-only group gambling enable
                    : '✅ Gambling disabled in this group.' // FIXED: sudo-only group gambling disable
            },
            { quoted: message }
        );
        return;
    }

    const enabled = isGroup ? await isGamblingEnabled(chatId) : false;
    if (!enabled) {
        await sendDisabledGambleMenu(sock, chatId, message);
        return;
    }

    await sendGambleMenu(sock, chatId, message); // FIXED: enabled gamble menu without status line
}

module.exports = {
  name: 'gamble',
  async execute(ctx) {
    return gambleCommand(ctx.sock || null, ctx.chatId || null, ctx.message || null, ctx.senderId || null, ctx.args || []);
  }
};
