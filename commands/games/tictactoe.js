const TicTacToe = require('../../lib/tictactoe');
const { createSession, deleteSession, getSession } = require('../../lib/gameSessions');

function buildBoard(game) {
    const arr = game.render().map(v => ({
        'X': '❎',
        'O': '⭕',
        '1': '1️⃣',
        '2': '2️⃣',
        '3': '3️⃣',
        '4': '4️⃣',
        '5': '5️⃣',
        '6': '6️⃣',
        '7': '7️⃣',
        '8': '8️⃣',
        '9': '9️⃣',
    }[v]));

    return `
🎮 *TicTacToe Game*

${arr.slice(0, 3).join('')}
${arr.slice(3, 6).join('')}
${arr.slice(6).join('')}

🎲 Turn: @${game.currentTurn.split('@')[0]} (${game.currentTurn === game.playerX ? '❎' : '⭕'})
`;
}

module.exports = {
    name: 'tictactoe',
    alias: ['ttt', 'tic', 'toe', 'xo', 'xox'],
    async execute(ctx) {
        const { sock, chatId, senderId, args, userMessage } = ctx;
        const sub = (args[0] || '').toLowerCase();

        // Surrender logic
        if (sub === 'surrender') {
            const session = getSession(chatId);
            if (!session || session.type !== 'tictactoe') return;
            if (!session.joinedParticipants.includes(senderId)) return;

            const winner = senderId === session.data.game.playerX ? session.data.game.playerO : session.data.game.playerX;
            await sock.sendMessage(chatId, { 
                text: `🏳️ @${senderId.split('@')[0]} has surrendered! @${winner.split('@')[0]} wins!`,
                mentions: [senderId, winner]
            });
            deleteSession(chatId);
            return;
        }

        // Join logic or Start logic
        let session = getSession(chatId);

        if (session && session.type === 'tictactoe') {
            if (session.data.status === 'WAITING' && session.data.game.playerX !== senderId) {
                session.data.game.playerO = senderId;
                session.joinedParticipants.push(senderId);
                session.data.status = 'PLAYING';
                
                return sock.sendMessage(chatId, {
                    text: buildBoard(session.data.game),
                    mentions: session.joinedParticipants
                });
            }
            return sock.sendMessage(chatId, { text: '❌ Game already in progress or you are waiting for opponent.' });
        }

        // Create new game
        const game = new TicTacToe(senderId, 'o');
        const newSession = {
            type: 'tictactoe',
            joinedParticipants: [senderId],
            data: {
                game,
                status: 'WAITING'
            },
            async onMessage(sock, message, senderId, text) {
                const session = getSession(chatId);
                if (!session || session.data.status !== 'PLAYING') return false;
                if (senderId !== session.data.game.currentTurn) return false;

                const moveStr = String(text || '').trim();
                if (!/^[1-9]$/.test(moveStr)) return false;

                const move = parseInt(moveStr) - 1;
                const ok = session.data.game.turn(senderId === session.data.game.playerO, move);
                
                if (!ok) {
                    await sock.sendMessage(chatId, { text: '❌ Position already taken!' }, { quoted: message });
                    return true;
                }

                const winner = session.data.game.winner;
                const isTie = session.data.game.turns === 9;

                if (winner || isTie) {
                    let resultMsg = winner ? `🎉 @${winner.split('@')[0]} WINS!` : `🤝 DRAW!`;
                    await sock.sendMessage(chatId, { 
                        text: `${buildBoard(session.data.game)}\n\n${resultMsg}`,
                        mentions: session.joinedParticipants 
                    }, { quoted: message });
                    deleteSession(chatId);
                } else {
                    await sock.sendMessage(chatId, { 
                        text: buildBoard(session.data.game),
                        mentions: session.joinedParticipants 
                    }, { quoted: message });
                }
                return true;
            }
        };

        createSession(chatId, newSession);
        await sock.sendMessage(chatId, { 
            text: `⏳ *Waiting for opponent*\nType *.ttt* to join!`,
            mentions: [senderId]
        });
    }
};
