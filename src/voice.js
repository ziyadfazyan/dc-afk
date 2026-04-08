const {
  joinVoiceChannel,
  createAudioPlayer,
  NoSubscriberBehavior,
  createAudioResource,
  AudioPlayerStatus,
} = require("@discordjs/voice");
const { Readable } = require("stream");
const fs = require("fs");
const path = require("path");

// File untuk simpan state AFK (guild -> voice channel) agar bisa auto join lagi setelah restart
// Disimpan di root project, bukan di dalam folder src.
const VOICE_STATE_FILE = path.join(__dirname, "..", "voice_state.json");

function loadVoiceState() {
  try {
    if (!fs.existsSync(VOICE_STATE_FILE)) {
      return {};
    }
    const raw = fs.readFileSync(VOICE_STATE_FILE, "utf8");
    const data = JSON.parse(raw);
    if (!data || typeof data !== "object") return {};
    return data;
  } catch (e) {
    console.error("Gagal load voice_state.json:", e);
    return {};
  }
}

function saveVoiceState(data) {
  try {
    fs.writeFileSync(VOICE_STATE_FILE, JSON.stringify(data, null, 2));
  } catch (e) {
    console.error("Gagal save voice_state.json:", e);
  }
}

// guildId -> { channelId, leaveCode?, leaveCodeOwnerId? }
const persistentVoiceState = loadVoiceState();

// Map guildId -> { connection, player, channelId }
const voiceStates = new Map();

// Simple readable stream that outputs silence continuously
class SilenceStream extends Readable {
  _read() {
    // 20ms of silence (48kHz, stereo, 16-bit PCM -> 48000 * 2 * 2 * 0.02 = 3840 bytes)
    const buffer = Buffer.alloc(3840);
    this.push(buffer);
  }
}

function connectToVoice(guild, channel) {
  try {
    const existing = voiceStates.get(guild.id);
    if (
      existing &&
      existing.connection &&
      existing.connection.state.status !== "destroyed"
    ) {
      return existing;
    }

    const connection = joinVoiceChannel({
      channelId: channel.id,
      guildId: guild.id,
      adapterCreator: guild.voiceAdapterCreator,
      selfDeaf: true,
    });

    const player = createAudioPlayer({
      behaviors: {
        noSubscriber: NoSubscriberBehavior.Play,
      },
    });

    const silenceResource = createAudioResource(new SilenceStream());
    player.play(silenceResource);

    connection.subscribe(player);

    player.on(AudioPlayerStatus.Idle, () => {
      const newResource = createAudioResource(new SilenceStream());
      player.play(newResource);
    });

    connection.on("error", (error) => {
      console.error("Voice connection error:", error);
    });

    const state = { connection, player, channelId: channel.id };
    voiceStates.set(guild.id, state);

    // Simpan ke file supaya setelah restart bisa auto join lagi.
    // Pertahankan leaveCode kalau sudah ada.
    const prev = persistentVoiceState[guild.id] || {};
    persistentVoiceState[guild.id] = {
      ...prev,
      channelId: channel.id,
    };
    saveVoiceState(persistentVoiceState);

    console.log(
      `Joined voice channel ${channel.name} in guild ${guild.name} and started AFK.`,
    );
    return state;
  } catch (error) {
    console.error("Error connecting to voice channel:", error);
    return null;
  }
}

function autoReconnect(client) {
  for (const [guildId, info] of Object.entries(persistentVoiceState)) {
    try {
      const guild = client.guilds.cache.get(guildId);
      if (!guild) {
        continue;
      }

      const channelId = info && info.channelId;
      if (!channelId) continue;

      const channel = guild.channels.cache.get(channelId);
      if (!channel) {
        continue;
      }

      // Pastikan itu voice channel (bukan text)
      if (!channel.isVoiceBased || !channel.isVoiceBased()) {
        continue;
      }

      console.log(
        `Auto-join AFK voice channel ${channel.name} di guild ${guild.name} dari persistent state.`,
      );
      connectToVoice(guild, channel);
    } catch (e) {
      console.error(
        "Gagal auto-join voice setelah restart untuk guild",
        guildId,
        e,
      );
    }
  }
}

function clearPersistentVoiceForGuild(guildId) {
  if (persistentVoiceState[guildId]) {
    delete persistentVoiceState[guildId];
    saveVoiceState(persistentVoiceState);
  }
}

function setLeaveCode(guildId, code, ownerId) {
  const current = persistentVoiceState[guildId] || {};
  if (code && code.trim()) {
    current.leaveCode = code.trim();
    if (ownerId && String(ownerId).trim()) {
      current.leaveCodeOwnerId = String(ownerId).trim();
    }
  } else {
    delete current.leaveCode;
    delete current.leaveCodeOwnerId;
  }
  persistentVoiceState[guildId] = current;
  saveVoiceState(persistentVoiceState);
}

function getLeaveCode(guildId) {
  const current = persistentVoiceState[guildId];
  return current && current.leaveCode;
}

function getLeaveCodeOwner(guildId) {
  const current = persistentVoiceState[guildId];
  return current && current.leaveCodeOwnerId;
}

module.exports = {
  voiceStates,
  connectToVoice,
  autoReconnect,
  clearPersistentVoiceForGuild,
  setLeaveCode,
  getLeaveCode,
  getLeaveCodeOwner,
};
