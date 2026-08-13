const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const axios = require('axios');
const settings = require('../../settings');
const { getCurrentProfile } = require('../../lib/botContext');

const HELP_IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp']);
const helpImageCache = new Map();
// Clear cache on load to ensure persona changes take effect
helpImageCache.clear();

const MENU_TEMPLATE = `
╭━✦ __BOT_TITLE__ ✦━╮
┃ 𖤓 Prefix → .
┃ 𖤓 Bot Name → __BOT_NAME__
┃ 𖤓 Crafted with 💻 by Team
┃ 𖤓 Keep Exploring & Enjoy!
╰━━━━━━━━━━━╯

✮《 🔷 GENSHIN 》
┣ ✧ .gi help
┣ ✧ .gi chars
┣ ✧ .gi char
┣ ✧ .gi build
┣ ✧ .gi weapon
┣ ✧ .gi artifact
┣ ✧ .gi tier
┣ ✧ .gi team
┣ ✧ .gi ascension
┣ ✧ .gi talents
┣ ✧ .gi const
┣ ✧ .gi element
┣ ✧ .gi region
┣ ✧ .gi materials
╰━━━━━━━━━━

✮《 🎮 ECONOMY 》
┣ ✧ .profile
┣ ✧ .p
┣ ✧ .balance
┣ ✧ .daily
┣ ✧ .work
┣ ✧ .beg
┣ ✧ .donate
┣ ✧ .deposit
┣ ✧ .withdraw
┣ ✧ .bank
┣ ✧ .switch
┣ ✧ .network
┣ ✧ .top
┣ ✧ .edit
┣ ✧ .bio
┣ ✧ .setage
┣ ✧ .inventory
┣ ✧ .use
┣ ✧ .sell
┣ ✧ .mine
┣ ✧ .hunt
┣ ✧ .gamble
┣ ✧ .roast
╰━━━━━━━━━━

✮《 🎰 GAMBLE 》
┣ ✧ .slots
┣ ✧ .dice
┣ ✧ .coinflip
┣ ✧ .roulette
┣ ✧ .bet
┣ ✧ .jackpot
┣ ✧ .wheel
┣ ✧ .horse
┣ ✧ .highlow
┣ ✧ .raffle
┣ ✧ .dicepoker
╰━━━━━━━━━━

✮《 👤 INTERACTION 》
┣ ✧ .hug
┣ ✧ .kiss
┣ ✧ .slap
┣ ✧ .pat
┣ ✧ .wave
┣ ✧ .dance
┣ ✧ .fuck
┣ ✧ .laugh
┣ ✧ .bonk
┣ ✧ .kill
┣ ✧ .bite
┣ ✧ .poke
┣ ✧ .flirt
┣ ✧ .insult
┣ ✧ .horny
┣ ✧ .wife
╰━━━━━━━━━━

✮《 👤 FUN 》
┣ ✧ .marry
┣ ✧ .divorce
┣ ✧ .joke
┣ ✧ .truth
┣ ✧ .dare
┣ ✧ .ship
┣ ✧ .skill
┣ ✧ .fact
┣ ✧ .trivia
┣ ✧ .guess
┣ ✧ .hangman
┣ ✧ .meme
╰━━━━━━━━━━

✮《 📲 DOWNLOADERS 》
┣ ✧ .yt
┣ ✧ .ig
┣ ✧ .ttk
┣ ✧ .play
┣ ✧ .spotify
╰━━━━━━━━━━

✮《 🌺 ANIME SFW 》
┣ ✧ .waifu
┣ ✧ .neko
┣ ✧ .maid
┣ ✧ .raiden-shogun
┣ ✧ .selfies
┣ ✧ .uniform
┣ ✧ .kamisato-ayaka
┣ ✧ .anime
┣ ✧ .manga
╰━━━━━━━━━━

✮《 🍓 ANIME NSFW 》
┣ ✧ .nsfw
┣ ✧ .hentai
┣ ✧ .ero
┣ ✧ .nhentai
╰━━━━━━━━━━

✮《 🀄 GAMES 》
┣ ✧ .duel
┣ ✧ .elementwar
┣ ✧ .puzzlebox
┣ ✧ .mysticroll
┣ ✧ .arena
┣ ✧ .bombpass
┣ ✧ .shadowfight
┣ ✧ .wordquest
┣ ✧ .tictactoe
╰━━━━━━━━━━

✮《 🏰 GROUP COMMANDS 》
┣ ✧ .kick
┣ ✧ .ban
┣ ✧ .unban
┣ ✧ .mute
┣ ✧ .promote
┣ ✧ .demote
┣ ✧ .delete
┣ ✧ .purge
┣ ✧ .tagall
┣ ✧ .hidetag
┣ ✧ .welcome
┣ ✧ .goodbye
┣ ✧ .antilink
┣ ✧ .antidemote
┣ ✧ .antipromote
┣ ✧ .antism
┣ ✧ .antiporn
┣ ✧ .antibot
┣ ✧ .groupstats
┣ ✧ .open
┣ ✧ .close
╰━━━━━━━━━━

✮《 🏴‍☠️ PIRATE CREW 》
┣ ✧ .captain
┣ ✧ .firstmate
┣ ✧ .maroon
┣ ✧ .lockship
┣ ✧ .openship
┣ ✧ .spyglass
┣ ✧ .plunder
┣ ✧ .pardoner
┣ ✧ .crewlist
┣ ✧ .booty
┣ ✧ .crewstart
┣ ✧ .missions
╰━━━━━━━━━━

✮《 🔍 SEARCH & UTILS 》
┣ ✧ .pint
┣ ✧ .sauce
┣ ✧ .wallpaper
┣ ✧ .lyrics
┣ ✧ .sticker
┣ ✧ .toimg
┣ ✧ .tovid
┣ ✧ .imagine
┣ ✧ .remini
┣ ✧ .removebg
┣ ✧ .tts
╰━━━━━━━━━━

✮《 🔧 TOOLS & UTILITIES 》
┣ ✧ .afk
┣ ✧ .translate
┣ ✧ .transcribe
┣ ✧ .subtitles
┣ ✧ .sos
┣ ✧ .ping
┣ ✧ .alive
┣ ✧ .runtime
┣ ✧ .owner
┣ ✧ .team
┣ ✧ .help
┣ ✧ .chatbot on/off
┣ ✧ .weather
┣ ✧ .news
┣ ✧ .uptime
╰━━━━━━━━━━

questions? type .support
`.trim();

function getProfile() {
    return getCurrentProfile() || null;
}

function getBotLabel(profile) {
    return String(profile?.botName || settings.botName || 'Bot').trim() || 'Bot';
}

function getHelpImageCandidates(profile) {
    const assetDir = path.join(process.cwd(), profile?.assetDir || 'assets');
    const botLabel = getBotLabel(profile);
    const lowerBot = botLabel.toLowerCase();
    const botId = String(profile?.botId || '').toLowerCase();

    // Prioritize Haimiya assets for the second bot profile.
    if (lowerBot.includes('haimiya') || lowerBot.includes('hamiya') || botId === 'reze') {
        const haimiyaSpecific = [
            path.join(process.cwd(), 'assets', 'hamiya.png'),
            path.join(process.cwd(), 'assets', 'Haumiya', 'Haimiya Mio.jpg'),
            path.join(process.cwd(), 'assets', 'Haumiya', 'Haimiya Mio (1).jpg'),
            path.join(process.cwd(), 'assets', 'Haumiya', 'Haimiya.jpg'),
            path.join(process.cwd(), 'assets', 'Haumiya', 'Haimiya (1).jpg'),
            path.join(process.cwd(), 'assets', 'Haumiya', 'Pfp.jpg')
        ];
        return [...haimiyaSpecific];
    }

    const explicit = [
        path.join(assetDir, `${botLabel}.jpg`),
        path.join(assetDir, `${botLabel}.png`),
        path.join(assetDir, `${botLabel}.webp`)
    ];

    let matched = [];
    try {
        matched = fs.readdirSync(assetDir)
            .filter((name) => HELP_IMAGE_EXTENSIONS.has(path.extname(name).toLowerCase()))
            .filter((name) => {
                const lower = name.toLowerCase();
                return lower.includes(botId) || lower.includes(lowerBot) || lower.includes('bot');
            })
            .map((name) => path.join(assetDir, name));
    } catch {}

    const fallback = [
        path.join(process.cwd(), 'assets', 'bot_image.jpg'),
        path.join(process.cwd(), 'assets', 'download.jpg')
    ];

    return [...new Set([...explicit, ...matched, ...fallback])];
}

async function getHelpImage(profile) {
    const cacheKey = String(profile?.botId || getBotLabel(profile)).toLowerCase();
    if (helpImageCache.has(cacheKey)) return helpImageCache.get(cacheKey);

    const remoteUrl = String(profile?.helpImageUrl || '').trim();
    if (remoteUrl) {
        try {
            const response = await axios.get(remoteUrl, { responseType: 'arraybuffer', timeout: 20000 });
            const output = await sharp(Buffer.from(response.data || []), { animated: false })
                .resize(1280, 1280, { fit: 'inside', withoutEnlargement: true })
                .jpeg({ quality: 92 })
                .toBuffer();
            helpImageCache.set(cacheKey, output);
            return output;
        } catch {}
    }

    for (const filePath of getHelpImageCandidates(profile)) {
        try {
            if (!fs.existsSync(filePath)) continue;
            const buffer = fs.readFileSync(filePath);
            const output = await sharp(buffer, { animated: false })
                .resize(1280, 1280, { fit: 'inside', withoutEnlargement: true })
                .jpeg({ quality: 92 })
                .toBuffer();
            helpImageCache.set(cacheKey, output);
            return output;
        } catch {}
    }

    return null;
}

function buildHelpMessage(profile) {
    const botLabel = getBotLabel(profile);
    return MENU_TEMPLATE
        .replace(/__BOT_TITLE__/g, botLabel.toUpperCase())
        .replace(/__BOT_NAME__/g, botLabel);
}

async function helpCommand(sock, chatId, message, profile) {
    const helpMessage = buildHelpMessage(profile);

    try {
        const helpImage = await getHelpImage(profile);
        if (helpImage) {
            await sock.sendMessage(chatId, {
                image: helpImage,
                caption: helpMessage
            }, { quoted: message });
            return;
        }

        await sock.sendMessage(chatId, { text: helpMessage }, { quoted: message });
    } catch (error) {
        console.error('Error in help command:', error?.message || error);
        await sock.sendMessage(chatId, { text: helpMessage }, { quoted: message });
    }
}

module.exports = {
    name: 'help',
    async execute(ctx) {
        return helpCommand(ctx.sock || null, ctx.chatId || null, ctx.message || null, ctx.profile || null);
    }
};
