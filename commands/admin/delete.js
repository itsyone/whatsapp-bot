const isAdmin = require('../../lib/isAdmin');
const store = require('../../lib/lightweight_store');
const { hasAdminBypass } = require('../../lib/adminBypass');

async function deleteCommand(sock, chatId, message, senderId, adminContext = {}) {
    try {
        const bypass = await hasAdminBypass(message, senderId);
        let isSenderAdmin = Boolean(adminContext.isSenderAdmin);
        let isBotAdmin = Boolean(adminContext.isBotAdmin);

        if (!isSenderAdmin || !isBotAdmin) {
            const freshAdminStatus = await isAdmin(sock, chatId, senderId);
            isSenderAdmin = Boolean(freshAdminStatus.isSenderAdmin);
            isBotAdmin = Boolean(freshAdminStatus.isBotAdmin);
        }

        if (!isBotAdmin) {
            await sock.sendMessage(chatId, { text: 'I need to be an admin to delete messages.' }, { quoted: message });
            return;
        }

        if (!isSenderAdmin && !bypass) {
            await sock.sendMessage(chatId, { text: 'Only admins can use the .delete command.' }, { quoted: message });
            return;
        }

        // Determine target user and count
        const text = message.message?.conversation || message.message?.extendedTextMessage?.text || '';
        const parts = text.trim().split(/\s+/);
        let countArg = null;
        
        // Check if a number is provided
        if (parts.length > 1) {
            const maybeNum = parseInt(parts[1], 10);
            if (!isNaN(maybeNum) && maybeNum > 0) {
                countArg = Math.min(maybeNum, 50);
            }
        }
        
        // Check if user is replying to a message
        const ctxInfo = message.message?.extendedTextMessage?.contextInfo || {};
        const repliedParticipant = ctxInfo.participant || null;
        const mentioned = Array.isArray(ctxInfo.mentionedJid) && ctxInfo.mentionedJid.length > 0 ? ctxInfo.mentionedJid[0] : null;
        
        // If no number provided but replying to a message, default to 1
        if (countArg === null && repliedParticipant) {
            countArg = 1;
        }
        // If no number provided and not replying/mentioning, show usage message
        else if (countArg === null && !repliedParticipant && !mentioned) {
            await sock.sendMessage(chatId, { 
                text: '❌ Please specify the number of messages to delete.\n\nUsage:\n• `.del 5` - Delete last 5 messages from group\n• `.del 3 @user` - Delete last 3 messages from @user\n• `.del 2` (reply to message) - Delete last 2 messages from replied user' 
            }, { quoted: message });
            return;
        }
        // If no number provided but mentioning a user, default to 1
        else if (countArg === null && mentioned) {
            countArg = 1;
        }


        // Determine target user: replied > mentioned; if neither, delete last N messages from group
        let targetUser = null;
        let repliedMsgId = null;
        let deleteGroupMessages = false;
        
        if (repliedParticipant && ctxInfo.stanzaId) {
            targetUser = repliedParticipant;
            repliedMsgId = ctxInfo.stanzaId;
        } else if (mentioned) {
            targetUser = mentioned;
        } else {
            deleteGroupMessages = true;
        }

        // Gather last N messages from targetUser in this chat
        const chatMessages = Array.isArray(store.messages[chatId]) ? store.messages[chatId] : [];
        // Newest last; we traverse from end backwards
        const toDelete = [];
        const seenIds = new Set();

        if (deleteGroupMessages) {
            // Delete last N messages from group (any user)
            for (let i = chatMessages.length - 1; i >= 0 && toDelete.length < countArg; i--) {
                const m = chatMessages[i];
                if (!seenIds.has(m.key.id)) {
                    // skip protocol/system messages and the current command message
                    if (!m.message?.protocolMessage && 
                        m.key.id !== message.key.id) {
                        toDelete.push(m);
                        seenIds.add(m.key.id);
                    }
                }
            }
        } else {
            // If replying, always add the replied message key directly (works even if not in store)
            if (repliedMsgId && targetUser) {
                toDelete.push({
                    key: {
                        remoteJid: chatId,
                        fromMe: false,
                        id: repliedMsgId,
                        participant: targetUser
                    }
                });
                seenIds.add(repliedMsgId);
            }
            // Then collect more from store if countArg > 1
            for (let i = chatMessages.length - 1; i >= 0 && toDelete.length < countArg; i--) {
                const m = chatMessages[i];
                const participant = m.key.participant || m.key.remoteJid;
                const targetDigits = String(targetUser || '').split('@')[0].replace(/\D/g, '');
                const partDigits = String(participant || '').split('@')[0].replace(/\D/g, '');
                if (targetDigits && partDigits === targetDigits && !seenIds.has(m.key.id)) {
                    if (!m.message?.protocolMessage) {
                        toDelete.push(m);
                        seenIds.add(m.key.id);
                    }
                }
            }
        }

        if (toDelete.length === 0) {
            return;
        }

        // Delete sequentially with small delay
        for (const m of toDelete) {
            try {
                const msgParticipant = deleteGroupMessages 
                    ? (m.key.participant || m.key.remoteJid) 
                    : (m.key.participant || targetUser);
                await sock.sendMessage(chatId, {
                    delete: {
                        remoteJid: chatId,
                        fromMe: Boolean(m.key.fromMe),
                        id: m.key.id,
                        participant: msgParticipant
                    }
                });
                await new Promise(r => setTimeout(r, 300));
            } catch (e) {
                // continue
            }
        }

    
    } catch (err) {
        await sock.sendMessage(chatId, { text: 'Failed to delete messages.' }, { quoted: message });
    }
}





module.exports = {
  name: 'delete',
  aliases: ['del', 'd'],
  permissionLevel: 'admin', // FIXED: central admin permission
  async execute(ctx) {
    return deleteCommand(
      ctx.sock || null,
      ctx.chatId || null,
      ctx.message || null,
      ctx.senderId || null,
      {
        isSenderAdmin: ctx.isSenderAdmin,
        isBotAdmin: ctx.isBotAdmin
      }
    );
  }
};
