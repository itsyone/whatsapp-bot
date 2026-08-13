function detectIntent(input, thread) {
  const text = String(input || "").trim();
  const low = text.toLowerCase();
  const hasQuestion = text.includes("?");

  if (!text) return "ignore";
  if (/\b(sad|upset|hurt|heartbroken|depressed|crying|cried|i feel like shit|feel like shit|bad day|worst day|they left me|got rejected|got cheated|i got cheated|lonely|broken|im tired|i'm tired|i am tired|not okay|not ok|feel low|feeling low|feel empty|feeling empty)\b/.test(low)) return "comfort";
  if (/^\b(ok|k|hmm|h|yo|sup|hey|hi)\b$/i.test(low)) return "casual";
  if (/\b(who am i|remember|nickname|what do you know)\b/.test(low)) return "callback";
  if (/\b(phone|name|age|where|from|what are you|who are you)\b/.test(low) || hasQuestion) return "question";
  if (/\b(horny|boob|sexy|nude|sex|love you|miss you|cute|pretty|beautiful|kiss|date me|marry me|gf|bf|baby|jaan|sweetheart)\b/.test(low)) return "flirty";
  if (/\b(roast|insult|expose|fake|99|goon|clown)\b/.test(low)) return "roast";
  if (/\b(save|remember this|note this)\b/.test(low)) return "memory_update";

  const state = thread && thread.state ? thread.state : null;
  if (state && state.patience < 25) return "dry";
  return "casual";
}

module.exports = {
  detectIntent
};
