const axios = require('axios');
const { progressMission } = require('../../lib/economy');

let triviaGames = {};

function decodeHtml(value = '') {
    return String(value || '')
        .replace(/&quot;/g, '"')
        .replace(/&#039;/g, "'")
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>');
}

async function startTrivia(sock, chatId, message = null) {
    if (triviaGames[chatId]) {
        sock.sendMessage(chatId, { text: '❌ A trivia game is already in progress!' }, message ? { quoted: message } : {});
        return;
    }

    try {
        const response = await axios.get('https://opentdb.com/api.php?amount=1&type=multiple');
        const questionData = response.data.results[0];
        const options = [...questionData.incorrect_answers, questionData.correct_answer]
            .map(decodeHtml)
            .sort(() => Math.random() - 0.5);

        triviaGames[chatId] = {
            question: decodeHtml(questionData.question),
            correctAnswer: decodeHtml(questionData.correct_answer),
            options,
        };

        const optionsText = options.map((opt, i) => `${i + 1} *${opt}*`).join('\n');

        sock.sendMessage(chatId, {
            text: `🧠 TRIVIA

❓ *${triviaGames[chatId].question}*

${optionsText}

> 💡 Reply: 1-4`
        }, message ? { quoted: message } : {});
    } catch (error) {
        sock.sendMessage(chatId, { text: '❌ Error fetching trivia question. Try again later.' }, message ? { quoted: message } : {});
    }
}

function answerTrivia(sock, chatId, answer, senderId) {
    if (!triviaGames[chatId]) {
        sock.sendMessage(chatId, { text: '❌ No trivia game is in progress.' });
        return;
    }

    const game = triviaGames[chatId];
    const raw = String(answer || '').trim();
    const numeric = raw.match(/^[\s.]*([1-4])[\s.)-]*$/);
    const selectedNumber = numeric ? Number(numeric[1]) - 1 : -1;
    const selectedAnswer = selectedNumber >= 0 ? game.options[selectedNumber] : raw;

    if (String(selectedAnswer || '').toLowerCase() === game.correctAnswer.toLowerCase()) {
        if (senderId) {
            progressMission(senderId, 'challenge');
        }
        sock.sendMessage(chatId, { 
            text: `✅ *CORRECT!*

🎉 You got it right!
🔤 Answer: ${game.correctAnswer}`
        });
    } else {
        sock.sendMessage(chatId, { 
            text: `❌ *WRONG!*

💔 Better luck next time!
🔤 Correct answer: ${game.correctAnswer}`
        });
    }

    delete triviaGames[chatId];
}

function hasActiveTrivia(chatId) {
    return Boolean(triviaGames[chatId]);
}

module.exports = {
    name: 'trivia',
    aliases: ['quiz'],
    startTrivia,
    answerTrivia,
    hasActiveTrivia,
    async execute(ctx) {
        return startTrivia(ctx.sock, ctx.chatId, ctx.message);
    }
};
