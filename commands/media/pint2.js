const { PinterestHarvester } = require("../../lib/scrapers");

async function handlePintCommand(sock, message) {
  const chatId = message.key.remoteJid;
  const text = message.message?.conversation || message.message?.extendedTextMessage?.text || "";
  const keyword = text.replace(/^\.pint2\b/i, '').trim();
  console.log("🔧 Command received with keyword:", keyword);

  if (!keyword) return;

  try {
    // Add processing reaction
    await sock.sendMessage(chatId, {
        react: { text: "⏳", key: message.key }
    });

    const results = await PinterestHarvester.search(keyword, 10);
    if (results.length === 0) {
        await sock.sendMessage(chatId, { text: `No Pinterest results found for: ${keyword}` }, { quoted: message });
        // Remove processing reaction
        await sock.sendMessage(chatId, {
            react: { text: "", key: message.key }
        });
        return;
    }

    // Send all images in parallel for extreme speed
    await Promise.all(results.map(async (pin, i) => {
      try {
        await sock.sendMessage(chatId, {
          image: { url: pin.image },
          caption: i === 0 ? `*Query:* ${keyword}\n*Title:* ${pin.title}` : ''
        }, { quoted: message });
      } catch (error) {
        console.error(`❌ Failed to send image ${i+1}:`, error.message);
      }
    }));

    // Remove processing reaction
    await sock.sendMessage(chatId, {
        react: { text: "", key: message.key }
    });

  } catch (error) {
    console.error("❌ Error in handlePintCommand:", error.message);
    await sock.sendMessage(chatId, { text: "Failed to harvest Pinterest images." }, { quoted: message });
  }
}


module.exports = {
    name: 'pint2',
    execute: handlePintCommand
};
