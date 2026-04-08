const fs = require("fs");
const path = require("path");

// Kode premium valid diambil dari environment, misalnya PREMIUM_CODES=K0DE1,K0DE2
const PREMIUM_CODES = (process.env.PREMIUM_CODES || "").split(",").filter(Boolean);

// File untuk simpan server premium dan kode yang sudah dipakai
// Disimpan di root project, bukan di dalam folder src.
const PREMIUM_FILE = path.join(__dirname, "..", "premium.json");

function loadPremiumData() {
  try {
    if (!fs.existsSync(PREMIUM_FILE)) {
      return { guilds: {}, usedCodes: [] };
    }
    const raw = fs.readFileSync(PREMIUM_FILE, "utf8");
    const data = JSON.parse(raw);
    if (!data.guilds) data.guilds = {};
    if (!data.usedCodes) data.usedCodes = [];
    return data;
  } catch (e) {
    console.error("Gagal load premium.json:", e);
    return { guilds: {}, usedCodes: [] };
  }
}

function savePremiumData(data) {
  try {
    fs.writeFileSync(PREMIUM_FILE, JSON.stringify(data, null, 2));
  } catch (e) {
    console.error("Gagal save premium.json:", e);
  }
}

const premiumData = loadPremiumData();

function isGuildPremium(guildId) {
  return Boolean(premiumData.guilds[guildId]);
}

function redeemCodeForGuild(code, guild, userId) {
  const normalized = code.trim();
  if (!normalized) return { ok: false, reason: "Kode tidak boleh kosong." };

  // cek apakah kode ada di daftar kode valid
  if (!PREMIUM_CODES.includes(normalized)) {
    return { ok: false, reason: "Kode tidak valid." };
  }

  // cek apakah sudah pernah dipakai
  if (premiumData.usedCodes.includes(normalized)) {
    return { ok: false, reason: "Kode ini sudah pernah dipakai." };
  }

  premiumData.usedCodes.push(normalized);
  premiumData.guilds[guild.id] = {
    activatedAt: new Date().toISOString(),
    byUserId: userId,
    code: normalized,
  };
  savePremiumData(premiumData);
  return { ok: true };
}

module.exports = {
  premiumData,
  isGuildPremium,
  redeemCodeForGuild,
};
