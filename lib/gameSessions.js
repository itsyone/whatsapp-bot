const activeSessions = new Map();

/**
 * Game Session Structure:
 * {
 *   chatId: string,
 *   type: 'hangman' | 'tictactoe',
 *   joinedParticipants: string[], // Jids
 *   data: any, // Game specific state
 *   onMessage: (sock, message, senderId, text) => Promise<boolean>
 * }
 */

function createSession(chatId, session) {
    activeSessions.set(chatId, {
        ...session,
        chatId,
        createdAt: Date.now()
    });
}

function getSession(chatId) {
    return activeSessions.get(chatId);
}

function deleteSession(chatId) {
    activeSessions.delete(chatId);
}

function isParticipant(chatId, senderId) {
    const session = getSession(chatId);
    if (!session) return false;
    // Normalize senderId for comparison
    const normId = senderId.split('@')[0].split(':')[0];
    return session.joinedParticipants.some(p => p.split('@')[0].split(':')[0] === normId);
}

module.exports = {
    createSession,
    getSession,
    deleteSession,
    isParticipant,
    activeSessions
};
