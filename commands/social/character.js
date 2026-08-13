const axios = require('axios');

const TRAITS = {
    mind: {
        label: '🧠 Mind',
        options: ['Analytical', 'Creative', 'Logical', 'Intuitive', 'Strategic', 'Imaginative', 'Philosophical', 'Curious']
    },
    heart: {
        label: '❤️ Heart',
        options: ['Empathetic', 'Caring', 'Loyal', 'Generous', 'Sincere', 'Compassionate', 'Warm', 'Forgiving']
    },
    energy: {
        label: '⚡ Energy',
        options: ['Ambitious', 'Determined', 'Persistent', 'Passionate', 'Driven', 'Fearless', 'Bold', 'Unstoppable']
    },
    vibe: {
        label: '✨ Vibe',
        options: ['Charismatic', 'Humorous', 'Confident', 'Mysterious', 'Chill', 'Witty', 'Charming', 'Magnetic']
    },
    soul: {
        label: '🌙 Soul',
        options: ['Wise', 'Patient', 'Honest', 'Grounded', 'Optimistic', 'Peaceful', 'Reliable', 'Authentic']
    }
};

const RARE_TITLES = [
    '👑 The Untouchable', '🌟 Born Legend', '💎 Diamond Soul',
    '🔥 Chaos Incarnate', '🌙 Moonwalker', '⚡ Thunder Spirit'
];

const TITLES = [
    '🎯 The Strategist', '🌊 Calm Storm', '🦁 Silent Lion',
    '🎭 The Performer', '🌸 Gentle Giant', '🗡️ The Guardian',
    '🚀 The Dreamer', '🧩 The Problem Solver', '🌺 Free Spirit',
    '🔮 The Visionary', '⚔️ Lone Wolf', '🌈 The Peacemaker'
];

function pick(arr) {
    return arr[Math.floor(Math.random() * arr.length)];
}

function randInt(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

function makeBar(percent) {
    const filled = Math.round(percent / 10);
    return '█'.repeat(filled) + '░'.repeat(10 - filled) + ` ${percent}%`;
}

function buildAnalysis(userName) {
    const isRare = Math.random() < 0.08; // 8% chance rare title
    const title = isRare ? pick(RARE_TITLES) : pick(TITLES);

    const categories = Object.entries(TRAITS).map(([, cat]) => {
        const trait = pick(cat.options);
        const pct = randInt(55, 100);
        return `${cat.label} — *${trait}*\n${makeBar(pct)}`;
    });

    const overall = randInt(70, 99);
    const luck = randInt(1, 100);
    const chaosLevel = randInt(0, 100);

    const overallBar = makeBar(overall);

    const luckyEmoji = luck > 80 ? '🍀' : luck > 50 ? '🌟' : '😬';
    const chaosEmoji = chaosLevel > 80 ? '💥' : chaosLevel > 50 ? '🔥' : '😇';

    return (
        `╔══════════════════╗\n` +
        `     🔮 *CHARACTER ANALYSIS* 🔮\n` +
        `╚══════════════════╝\n\n` +
        `👤 *@${userName}*\n` +
        `🏷️ Title: *${title}*\n\n` +
        `━━━━━ *TRAIT BREAKDOWN* ━━━━━\n\n` +
        categories.join('\n\n') + '\n\n' +
        `━━━━━ *OVERALL POWER* ━━━━━\n\n` +
        `⭐ ${overallBar}\n\n` +
        `${luckyEmoji} Lucky Score: *${luck}/100*\n` +
        `${chaosEmoji} Chaos Level: *${chaosLevel}/100*\n\n` +
        `╔══════════════════╗\n` +
        `  📊 *just for fun, don't take it seriously* 😄\n` +
        `╚══════════════════╝`
    );
}

async function characterCommand(sock, chatId, message) {
    let userToAnalyze;

    if (message.message?.extendedTextMessage?.contextInfo?.mentionedJid?.length > 0) {
        userToAnalyze = message.message.extendedTextMessage.contextInfo.mentionedJid[0];
    } else if (message.message?.extendedTextMessage?.contextInfo?.participant) {
        userToAnalyze = message.message.extendedTextMessage.contextInfo.participant;
    }

    if (!userToAnalyze) {
        await sock.sendMessage(chatId, {
            text: '❌ Mention someone or reply to their message!\n\nUsage: `.character @user`',
        }, { quoted: message });
        return;
    }

    try {
        const userName = userToAnalyze.split('@')[0];
        const analysis = buildAnalysis(userName);

        let profilePic;
        try {
            profilePic = await sock.profilePictureUrl(userToAnalyze, 'image');
        } catch {
            profilePic = null;
        }

        if (profilePic) {
            await sock.sendMessage(chatId, {
                image: { url: profilePic },
                caption: analysis,
                mentions: [userToAnalyze],
            }, { quoted: message });
        } else {
            await sock.sendMessage(chatId, {
                text: analysis,
                mentions: [userToAnalyze],
            }, { quoted: message });
        }

    } catch (error) {
        console.error('characterCommand error:', error);
        await sock.sendMessage(chatId, {
            text: '❌ Failed to analyze. Try again!',
        }, { quoted: message });
    }
}





module.exports = {
  name: 'character',
  async execute(ctx) {
    return characterCommand(ctx.sock || null, ctx.chatId || null, ctx.message || null);
  }
};
