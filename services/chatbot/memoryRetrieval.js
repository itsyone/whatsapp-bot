function pickRelevantMemory(userMemory, input, intent) {
  const text = String(input || "").toLowerCase();
  const facts = Array.isArray(userMemory && userMemory.facts) ? userMemory.facts : [];
  const jokes = Array.isArray(userMemory && userMemory.jokes) ? userMemory.jokes : [];
  const now = Date.now();

  const scoredFacts = facts
    .map((fact) => {
      const f = normalizeFact(fact);
      if (!f.text) return null;
      let score = Number(f.weight || 0.5) * 100;

      if (wordOverlap(text, f.text) > 0) score += 35;
      if (intent === "callback" && (f.type === "running_joke" || f.type === "identity")) score += 25;
      if (intent === "question" && (f.type === "identity" || f.type === "conversation_preference")) score += 18;
      if (intent === "roast" && f.type === "running_joke") score += 28;
      score += recencyBoost(now - Number(f.ts || now));

      return { ...f, score };
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score)
    .slice(0, 4);

  const scoredJokes = jokes
    .map((j) => {
      const textJoke = String(j && j.text ? j.text : "").trim().toLowerCase();
      if (!textJoke) return null;
      let score = Number(j.strength || 0.6) * 100;
      if (wordOverlap(text, textJoke) > 0) score += 26;
      if (intent === "roast" || intent === "callback") score += 12;
      score += recencyBoost(now - Number(j.ts || now));
      return { text: textJoke, score };
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score)
    .slice(0, 2);

  return {
    facts: scoredFacts,
    jokes: scoredJokes
  };
}

function wordOverlap(a, b) {
  const wa = tokenize(a);
  const wb = tokenize(b);
  let hits = 0;
  for (const token of wa) {
    if (wb.has(token)) hits += 1;
  }
  return hits;
}

function tokenize(text) {
  const set = new Set();
  for (const token of String(text || "").toLowerCase().split(/[^a-z0-9]+/)) {
    if (!token || token.length < 3) continue;
    set.add(token);
  }
  return set;
}

function recencyBoost(msOld) {
  if (msOld < 15 * 60 * 1000) return 14;
  if (msOld < 60 * 60 * 1000) return 9;
  if (msOld < 24 * 60 * 60 * 1000) return 5;
  if (msOld < 7 * 24 * 60 * 60 * 1000) return 2;
  return 0;
}

function normalizeFact(fact) {
  if (!fact) return { text: "", type: "identity", weight: 0.5, ts: Date.now() };
  if (typeof fact === "string") {
    return { text: fact.toLowerCase(), type: "identity", weight: 0.6, ts: Date.now() };
  }
  return {
    text: String(fact.text || "").toLowerCase(),
    type: String(fact.type || "identity").toLowerCase(),
    weight: Number(fact.weight || 0.6),
    ts: Number(fact.ts || Date.now())
  };
}

module.exports = {
  pickRelevantMemory
};
