const { getGambleBalance, settleGamble, shouldBypassGambleLimits } = require('../../lib/gambleManager');
const { generateRaffleCard } = require('../../lib/raffleCanvas');

const DEFAULT_BET = 1;
const MIN_BET = 1;
const MAX_BET = 1000000000;

function parseBet(rawText) {
    const amount = Number(String(rawText || '').trim().split(/\s+/).slice(1)[0]);
    if (!Number.isFinite(amount)) return DEFAULT_BET;
    return Math.max(MIN_BET, Math.min(MAX_BET, Math.floor(amount)));
}

function pickOutputStyle(isWin) {
    if (isWin) {
        return {
            line1: '🎟️ RAFFLE 🎟️',
            line2: '🥁 And the winner is...',
            line3: (userName, ticketNumber) => `👑 ${userName} • #${ticketNumber}`,
            line4: '╰─────────────╯'
        };
    }

    const styles = [
        {
            line1: '🎟️ RAFFLE 🎟️',
            line2: '🔥 Spot secured!',
            line3: (_, ticketNumber) => `Ticket #${ticketNumber}`,
            line4: '╰─────────────╯'
        },
        {
            line1: '🎟️ RAFFLE 🎟️',
            line2: "✨ You're in the game",
            line3: (_, ticketNumber) => `🎯 #${ticketNumber}`,
            line4: '╰─────────────╯'
        },
        {
            line1: '🎟️ RAFFLE 🎟️',
            line2: '⚡ Last few spots!',
            line3: (_, ticketNumber, bet) => `🎫 #${ticketNumber} • $${bet} pot`,
            line4: '╰─────────────╯'
        },
        {
            line1: '🎟️ RAFFLE 🎟️',
            line2: ({ bet }) => `💰 $${bet} on the line`,
            line3: (_, ticketNumber) => `🎫 #${ticketNumber} locked in`,
            line4: '╰─────────────╯'
        }
    ];

    return styles[Math.floor(Math.random() * styles.length)];
}

function buildCaption(style, isWin, bet, payout, balance, ticketNumber, userName) {
    const line2 = typeof style.line2 === 'function' ? style.line2({ bet, payout, balance, ticketNumber, userName }) : style.line2;
    const line3 = style.line3(userName, ticketNumber, bet);
    const resultLine = isWin ? `📈 Won: +${payout.toLocaleString()}` : '📉 Lost';

    return [
        style.line1,
        line2,
        line3,
        style.line4,
        '',
        `💸 Bet: ${bet.toLocaleString()}`,
        resultLine,
        `💰 Balance: ${balance.toLocaleString()}`
    ].join('\n');
}

async function raffleCommand(sock, chatId, message, senderId, rawText) {
    try {
        const bet = parseBet(rawText);
        const balance = getGambleBalance(senderId);

        if (balance < bet) {
            await sock.sendMessage(
                chatId,
                { text: `You need at least ${bet.toLocaleString()} to join the raffle.\nCurrent balance: ${balance.toLocaleString()}` },
                { quoted: message }
            );
            return;
        }

        const pushName = String(message?.pushName || senderId.split('@')[0] || 'Player').trim();
        const isWin = Math.random() < 0.3;
        const payout = isWin ? bet * 2 : 0;
        const outputStyle = pickOutputStyle(isWin);

        const settle = await settleGamble(senderId, bet, payout);
        const finalBalance = Number(settle?.balance ?? getGambleBalance(senderId));

        const card = await generateRaffleCard({
            userName: pushName,
            potAmount: bet
        });

        await sock.sendMessage(
            chatId,
            {
                image: card.buffer,
                caption: buildCaption(outputStyle, isWin, bet, payout, finalBalance, card.ticketNumber, pushName)
            },
            { quoted: message }
        );
    } catch (error) {
        console.error('[raffle] error:', error?.message || error);
        await sock.sendMessage(
            chatId,
            { text: 'Raffle failed. Try again in a moment.' },
            { quoted: message }
        );
    }
}





module.exports = {
  name: 'raffle',
  async execute(ctx) {
    return raffleCommand(ctx.sock || null, ctx.chatId || null, ctx.message || null, ctx.senderId || null, ctx.rawText || null);
  }
};

