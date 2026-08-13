const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { createSpawn, generateClaimId } = require('../../lib/cardClaimStore');

// Data path for Mazoku cards
// Data paths for Mazoku cards
const DATA_PATHS = [
    path.join(process.cwd(), 'data', 'mazoku_cards.json'),
    path.join(process.cwd(), '..', 'data', 'mazoku_cards.json'),
    path.join(__dirname, '..', '..', 'data', 'mazoku_cards.json')
];

let DATA_PATH = DATA_PATHS.find(p => fs.existsSync(p)) || DATA_PATHS[0];
console.log(`[SUMMON] Resolved Mazoku data path: ${DATA_PATH} (Exists: ${fs.existsSync(DATA_PATH)})`);




const rarityEmoji = {
    'C': '⚪',
    'R': '⭐',
    'SR': '🌟',
    'SSR': '💎',
    'UR': '🔥',
    'EX': '👑'
};

const rarityNames = {
    'C': 'Common',
    'R': 'Rare',
    'SR': 'Super Rare',
    'SSR': 'SSR',
    'UR': 'Ultra Rare',

    'EX': 'Exclusive'
};

let cachedCards = null;

function loadCards() {
    if (cachedCards && cachedCards.length > 0) return cachedCards;
    
    if (!fs.existsSync(DATA_PATH)) {
        DATA_PATH = DATA_PATHS.find(p => fs.existsSync(p)) || DATA_PATH;
    }

    try {
        const raw = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));
        const cards = Array.isArray(raw) ? raw : [];
        
        cachedCards = cards.filter(c => c && c.name);
        console.log(`[SUMMON] Successfully loaded ${cachedCards.length} Mazoku cards from ${path.basename(DATA_PATH)}`);
        return cachedCards;
    } catch (err) {
        console.error('Error loading Mazoku cards:', DATA_PATH, err.message);
        return [];
    }
}



function pickRandomCard() {
    const cards = loadCards();
    if (!cards.length) return null;
    return cards[Math.floor(Math.random() * cards.length)];
}

const { hasStaffRole } = require('../../lib/staffRoles');
const isOwnerOrSudo = require('../../lib/isOwner');


async function summonCommand(sock, chatId, message, senderId) {
    try {
        const isSudo = await isOwnerOrSudo(senderId);
        if (!isSudo && !hasStaffRole(senderId, ['mods', 'coOwners', 'staff'])) {
            await sock.sendMessage(chatId, { text: '❌ This command is restricted to Moderators only.' }, { quoted: message });
            return;
        }


        const card = pickRandomCard();

        if (!card) {
            await sock.sendMessage(chatId, { text: 'No card data found for summon.' }, { quoted: message });
            return;
        }

        // Generate a short 4-char uppercase ID for .get
        const claimIdBase = generateClaimId(4).toUpperCase();
        
        // Normalize for strictly Mazoku cards
        const cardName = card.name || 'Unknown';
        const cardValue = card.price || 0;
        const cardImage = card.image || '';
        const cardNo = card.uuid ? card.uuid.split('-')[0].toUpperCase() : claimIdBase;

        // Store normalized values back to card object for createSpawn
        card.cardName = cardName;
        card.value = cardValue;
        card.cardNo = cardNo;
        card.moveType = 'SPE'; 

        // Create the spawn with the custom ID
        const actualClaimId = createSpawn(card, chatId, claimIdBase).toUpperCase();

        const rarity = card.tier || 'C';
        const rarityIcon = rarityEmoji[rarity] || '⚪';
        const rarityName = rarityNames[rarity] || 'Common';

        const caption = `*✨ A wild card appeared!*

*🆔 ID: #${actualClaimId}*
*${rarityIcon} Rarity: ${rarityName}*
*👤 Name: “${cardName}”*
${card.series ? `*📺 Series: ${card.series}*` : ''}

*Type \`.get ${actualClaimId}\` to claim.*`;



        if (card.image) {
            const { getBuffer } = require('../../lib/myfunc');
            const sharp = require('sharp');
            const buffer = await getBuffer(card.image).catch(() => null);
            
            if (buffer && Buffer.isBuffer(buffer) && buffer.length > 1024) {
                try {
                    // IMPORTANT: Sharp needs { animated: true } to see GIF/WebP frames
                    const meta = await sharp(buffer, { animated: true }).metadata().catch(() => ({}));
                    const isMp4 = card.image && String(card.image).toLowerCase().endsWith('.mp4');
                    const isGifMagic = buffer.slice(0, 3).toString('ascii') === 'GIF';
                    const isAnimated = isMp4 || isGifMagic || (meta.pages > 1);
                    const isTooLarge = buffer.length > 40 * 1024 * 1024; // 40MB limit
                    
                    // Detect animation (MP4, GIF, or Animated WebP)
                    if (!isTooLarge && isAnimated) {
                        const { gifToMp4 } = require('../../lib/myfunc');
                        let finalVideoBuffer = buffer;
                        if (!isMp4) {
                            const converted = await gifToMp4(buffer).catch(() => null);
                            if (converted) finalVideoBuffer = converted;
                        }

                        if (finalVideoBuffer) {
                            const thumbnail = await sharp(buffer).resize(200).jpeg().toBuffer().catch(() => null);
                            await sock.sendMessage(chatId, {
                                video: finalVideoBuffer,
                                gifPlayback: true,
                                caption,
                                mimetype: 'video/mp4',
                                jpegThumbnail: thumbnail
                            }, { quoted: message });
                            return;
                        }
                    }



                    // If not animated or too large, send as high-quality PNG
                    const finalBuffer = await sharp(buffer)
                        .png({ compressionLevel: 9 })
                        .toBuffer();

                    await sock.sendMessage(chatId, {
                        image: finalBuffer,
                        caption
                    }, { quoted: message });
                    return;


                } catch (err) {
                    console.warn(`[SUMMON] Image processing failed for ${card.name}:`, err.message);
                    // Fall through to text fallback
                }
            } else {
                console.warn(`[SUMMON] Invalid image for card: ${card.name}. Buffer size: ${buffer?.length}, URL: ${card.image}`);
            }
        }




        await sock.sendMessage(chatId, { text: caption }, { quoted: message });
    } catch (error) {
        console.error('Error in summon command:', error);
        await sock.sendMessage(chatId, { text: 'Summon failed.' }, { quoted: message });
    }
}


module.exports = {
  name: 'summon',
  async execute(ctx) {
    return summonCommand(ctx.sock || null, ctx.chatId || null, ctx.message || null, ctx.senderId || null);
  }

};

