const { createSession, deleteSession, getSession } = require('../../lib/gameSessions');
const { progressMission } = require('../../lib/economy');

const WORDS = [
    'JAVASCRIPT', 'NODEJS', 'WHATSAPP', 'HITSUBOT', 'KESSORU', 'RYOYAMADA', 
    'BOCCHITHEK', 'NIJIKA', 'RYOTRIO', 'KITAIKU', 'GUITAR', 'DRUMS', 'BASS',
    'ZEALOT', 'PHANTOM', 'CYBERPUNK', 'METAVERSE', 'BLOCKCHAIN', 'SOLANA',
    'MONGODB', 'EXPRESS', 'REACTJS', 'NEXTJS', 'TYPESCRIPT', 'PYTHON'
];

const STAGES = [
  `
  +---+
  |   |
      |
      |
      |
      |
=========`,
  `
  +---+
  |   |
  O   |
      |
      |
      |
=========`,
  `
  +---+
  |   |
  O   |
  |   |
      |
      |
=========`,
  `
  +---+
  |   |
  O   |
 /|   |
      |
      |
=========`,
  `
  +---+
  |   |
  O   |
 /|\\  |
      |
      |
=========`,
  `
  +---+
  |   |
  O   |
 /|\\  |
 /    |
      |
=========`,
  `
  +---+
  |   |
  O   |
 /|\\  |
 / \\  |
      |
=========`,
];

function buildGameText(session) {
    const { word, maskedWord, guessedLetters, wrongGuesses, joinedParticipants } = session.data;
    const stage = STAGES[wrongGuesses] || STAGES[STAGES.length - 1];
    const maxWrong = STAGES.length - 1;
    const remaining = maxWrong - wrongGuesses;
    
    return `🪓 HANGMAN

${stage}

🔤 Word: ${maskedWord.join(' ')}
❌ Misses: ${wrongGuesses}/${maxWrong} (${remaining} left)
📝 Guessed: ${guessedLetters.join(', ') || 'None'}

👥 Players: ${joinedParticipants.map(p => `@${p.split('@')[0]}`).join(', ')}

> 💡 Reply with a letter to guess!`;
}

async function startHangmanGame(sock, chatId, senderId) {
    const word = WORDS[Math.floor(Math.random() * WORDS.length)];
    const session = {
        type: 'hangman',
        joinedParticipants: [senderId],
        data: {
            word,
            maskedWord: Array(word.length).fill('_'),
            guessedLetters: [],
            wrongGuesses: 0,
            starter: senderId,
            status: 'WAITING'
        },
        async onMessage(sock, message, senderId, text) {
            const session = getSession(chatId);
            if (!session || session.data.status !== 'PLAYING') return false;

            // Only joined participants can guess
            const isJoined = session.joinedParticipants.some(p => p.split('@')[0] === senderId.split('@')[0]);
            if (!isJoined) return false;

            const guess = String(text || '').trim().toUpperCase();
            if (guess.length !== 1 || !/[A-Z]/.test(guess)) return false;

            const game = session.data;
            if (game.guessedLetters.includes(guess)) {
                await sock.sendMessage(chatId, { text: `⚠️ Letter "${guess}" was already guessed!` }, { quoted: message });
                return true;
            }

            game.guessedLetters.push(guess);

            if (game.word.includes(guess)) {
                for (let i = 0; i < game.word.length; i++) {
                    if (game.word[i] === guess) game.maskedWord[i] = guess;
                }

                if (!game.maskedWord.includes('_')) {
                    await sock.sendMessage(chatId, { 
                        text: `🎉 VICTORY!

🏆 Winner: @${senderId.split('@')[0]}
🔤 The word was: *${game.word}*

Great job solving the puzzle!`,
                        mentions: [senderId]
                    }, { quoted: message });
                    progressMission(senderId, 'challenge').catch(() => null);
                    deleteSession(chatId);
                } else {
                    await sock.sendMessage(chatId, { 
                        text: buildGameText(session),
                        mentions: session.joinedParticipants
                    }, { quoted: message });
                }
            } else {
                game.wrongGuesses++;
                if (game.wrongGuesses >= STAGES.length - 1) {
                    await sock.sendMessage(chatId, { 
                        text: `💀 GAME OVER

🔤 The word was: *${game.word}*

Better luck next time!`,
                    }, { quoted: message });
                    deleteSession(chatId);
                } else {
                    await sock.sendMessage(chatId, { 
                        text: buildGameText(session),
                        mentions: session.joinedParticipants
                    }, { quoted: message });
                }
            }
            return true;
        }
    };

    createSession(chatId, session);
    
    await sock.sendMessage(chatId, { 
        text: `🎮 HANGMAN LOBBY

👤 Host: @${senderId.split('@')[0]}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📋 COMMANDS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
• *.hangman join*  - Join the game
• *.hangman start* - Begin (Host only)

Waiting for players to join...`,
        mentions: [senderId]
    });
}

module.exports = {
    name: 'hangman',
    async execute(ctx) {
        const { sock, chatId, senderId, args } = ctx;
        const sub = (args[0] || '').toLowerCase();

        if (sub === 'join') {
            const session = getSession(chatId);
            if (!session || session.type !== 'hangman') return sock.sendMessage(chatId, { text: '❌ No hangman lobby found.' });
            if (session.data.status !== 'WAITING') return sock.sendMessage(chatId, { text: '❌ Game already in progress.' });
            
            if (!session.joinedParticipants.includes(senderId)) {
                session.joinedParticipants.push(senderId);
                return sock.sendMessage(chatId, { text: `✅ @${senderId.split('@')[0]} joined the game! (${session.joinedParticipants.length} players)`, mentions: [senderId] });
            }
            return sock.sendMessage(chatId, { text: '⚠️ You already joined!' });
        }

        if (sub === 'start') {
            const session = getSession(chatId);
            if (!session || session.type !== 'hangman') return sock.sendMessage(chatId, { text: '❌ No lobby found.' });
            if (session.data.starter !== senderId) return sock.sendMessage(chatId, { text: '❌ Only the starter can begin the game.' });
            
            session.data.status = 'PLAYING';
            return sock.sendMessage(chatId, { 
                text: buildGameText(session), 
                mentions: session.joinedParticipants 
            });
        }

        const existing = getSession(chatId);
        if (existing) return sock.sendMessage(chatId, { text: '❌ A game is already active in this chat.' });

        return startHangmanGame(sock, chatId, senderId);
    }
};
