function normalizeJid(jid) {
  if (!jid || typeof jid !== "string") return "";
  const trimmed = jid.trim().toLowerCase();
  if (!trimmed.includes("@")) return trimmed;

  const parts = trimmed.split("@");
  const user = (parts[0] || "").split(":")[0];
  const server = parts.slice(1).join("@");
  return `${user}@${server}`;
}

function isGroupJid(jid) {
  return /@g\.us$/.test(jid || "");
}

function isStatusBroadcast(jid) {
  return jid === "status@broadcast";
}

module.exports = {
  normalizeJid,
  isGroupJid,
  isStatusBroadcast
};
