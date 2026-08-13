function createInitialThread() {
  return {
    history: [],
    updatedAt: Date.now(),
    profile: {
      ageClaim: null,
      goons: 0,
      anime: 0,
      lies: 0
    },
    state: {
      mood: "neutral",
      attachmentLevel: 25,
      patience: 80,
      lastStyle: "casual",
      relationshipType: "neutral",
      runningJokes: [],
      confidenceLevel: 55,
      convo: {
        topic: "",
        stage: "idle",
        lastQuestion: "",
        lastAnimeName: "",
        lastReplies: []
      }
    }
  };
}

function updateThreadState(thread, input, intent) {
  if (!thread || !thread.state) return;
  const text = String(input || "").toLowerCase();
  const s = thread.state;

  s.lastStyle = intent;

  if (intent === "flirty") {
    s.mood = "teasing";
    s.attachmentLevel = clamp(s.attachmentLevel + 3, 0, 100);
  } else if (intent === "roast") {
    s.mood = "dry";
    s.confidenceLevel = clamp(s.confidenceLevel + 2, 0, 100);
  } else if (intent === "question") {
    s.mood = "focused";
  } else if (intent === "dry") {
    s.mood = "bored";
  } else {
    s.mood = "neutral";
  }

  if (text.length > 180) s.patience = clamp(s.patience - 5, 0, 100);
  else s.patience = clamp(s.patience + 1, 0, 100);

  if (/\bbro|sis|baby|jaan|bestie\b/.test(text)) {
    s.relationshipType = "familiar";
  }
}

function registerRunningJoke(thread, joke) {
  if (!thread || !thread.state || !joke) return;
  const safe = String(joke).trim().toLowerCase().slice(0, 60);
  if (!safe) return;
  const list = thread.state.runningJokes || [];
  if (!list.includes(safe)) list.push(safe);
  thread.state.runningJokes = list.slice(-12);
}

function clamp(num, min, max) {
  return Math.max(min, Math.min(max, Number(num) || 0));
}

module.exports = {
  createInitialThread,
  updateThreadState,
  registerRunningJoke
};
