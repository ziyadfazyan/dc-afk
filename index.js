require("dotenv").config();

const { Client, GatewayIntentBits, PermissionFlagsBits } = require("discord.js");
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

const TOKEN = process.env.DISCORD_TOKEN;
// Kode premium yang valid, atur sendiri di sini (contoh)
// Misalnya setelah orang bayar, kamu kasih salah satu kode ini ke dia.
const PREMIUM_CODES = (process.env.PREMIUM_CODES || "").split(",").filter(Boolean);

// File untuk simpan server premium dan kode yang sudah dipakai
const PREMIUM_FILE = path.join(__dirname, "premium.json");

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

if (!TOKEN) {
  console.error("Missing DISCORD_TOKEN in environment.");
  process.exit(1);
}

// Simple readable stream that outputs silence continuously
class SilenceStream extends Readable {
  _read() {
    // 20ms of silence (48kHz, stereo, 16-bit PCM -> 48000 * 2 * 2 * 0.02 = 3840 bytes)
    const buffer = Buffer.alloc(3840);
    this.push(buffer);
  }
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
});
// Map guildId -> { connection, player, channelId }
const voiceStates = new Map();

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

    console.log(
      `Joined voice channel ${channel.name} in guild ${guild.name} and started AFK.`,
    );
    return state;
  } catch (error) {
    console.error("Error connecting to voice channel:", error);
    return null;
  }
}

client.once("ready", async () => {
  console.log(`Logged in as ${client.user.tag}`);
  client.user.setPresence({
    status: "idle",
    activities: [{ name: "AFK 24/7", type: 0 }],
  });

  const commands = [
    {
      name: "afk-join",
      description: "Make the bot join your current voice channel and AFK",
    },
    {
      name: "afk-leave",
      description: "Disconnect the bot from the voice channel",
    },
    {
      name: "premium-redeem",
      description: "Redeem kode premium untuk server ini",
      defaultMemberPermissions: PermissionFlagsBits.Administrator,
      options: [
        {
          name: "kode",
          description: "Kode premium yang kamu dapat setelah bayar",
          type: 3, // STRING
          required: true,
        },
      ],
    },
    {
      name: "premium-status",
      description: "Cek status premium server ini",
    },
  ];

  try {
    await client.application.commands.set(commands);
    console.log("Slash commands registered globally.");
  } catch (error) {
    console.error("Failed to register slash commands:", error);
  }

  // Periodically ensure we are still connected for each guild
  setInterval(() => {
    for (const [guildId, state] of voiceStates.entries()) {
      if (
        !state.connection ||
        state.connection.state.status === "disconnected" ||
        state.connection.state.status === "destroyed"
      ) {
        const guild = client.guilds.cache.get(guildId);
        if (!guild || !state.channelId) continue;
        const channel = guild.channels.cache.get(state.channelId);
        if (!channel) continue;
        console.log(
          `Voice connection lost in guild ${guild.name}, reconnecting...`,
        );
        connectToVoice(guild, channel);
      }
    }
  }, 60_000);
});

client.on("interactionCreate", async (interaction) => {
  try {
    if (!interaction.isChatInputCommand()) return;

    if (interaction.commandName === "afk-join") {
      const guild = interaction.guild;
      if (!guild) {
        await interaction.reply({
          content: "Command ini cuma bisa dipakai di server, bukan DM.",
          ephemeral: true,
        });
        return;
      }

      if (!isGuildPremium(guild.id)) {
        await interaction.reply({
          content:
            "Server ini belum premium. Silakan bayar ke owner dulu lalu redeem kode pakai /premium-redeem.",
          ephemeral: true,
        });
        return;
      }

      const existingState = voiceStates.get(guild.id);
      if (
        existingState &&
        existingState.connection &&
        existingState.connection.state.status !== "destroyed"
      ) {
        const currentChannel = guild.channels.cache.get(existingState.channelId);
        await interaction.reply({
          content:
            currentChannel
              ? `Aku sudah AFK di **${currentChannel.name}**. Kalau mau pindah, pakai /afk-leave dulu baru /afk-join lagi di channel baru.`
              : "Aku sudah AFK di salah satu voice channel. Kalau mau pindah, pakai /afk-leave dulu baru /afk-join lagi di channel baru.",
          ephemeral: true,
        });
        return;
      }

      // Ambil data member terbaru supaya state voice-nya akurat
      const member = await guild.members
        .fetch(interaction.user.id)
        .catch(() => null);

      const voiceChannel = member && member.voice && member.voice.channel;

      if (!voiceChannel) {
        await interaction.reply({
          content:
            "Kamu harus sudah join ke salah satu voice channel dulu biar aku bisa ikut.",
          ephemeral: true,
        });
        return;
      }

      connectToVoice(guild, voiceChannel);
      await interaction.reply({
        content: `Aku join ke **${voiceChannel.name}** dan AFK di sini.`,
        ephemeral: true,
      });
    } else if (interaction.commandName === "afk-leave") {
      const state = voiceStates.get(interaction.guild.id);
      if (!state || !state.connection) {
        await interaction.reply({
          content: "Aku lagi tidak di voice channel mana pun di server ini.",
          ephemeral: true,
        });
        return;
      }

      try {
        state.connection.destroy();
      } catch (e) {
        console.error("Error destroying voice connection:", e);
      }

      voiceStates.delete(interaction.guild.id);
      await interaction.reply({
        content: "Sudah keluar dari voice channel.",
        ephemeral: true,
      });
    } else if (interaction.commandName === "premium-redeem") {
      const guild = interaction.guild;
      if (!guild) {
        await interaction.reply({
          content: "Command ini cuma bisa dipakai di server, bukan DM.",
          ephemeral: true,
        });
        return;
      }

      if (!interaction.memberPermissions.has(PermissionFlagsBits.Administrator)) {
        await interaction.reply({
          content: "Hanya admin server yang bisa redeem kode.",
          ephemeral: true,
        });
        return;
      }

      const code = interaction.options.getString("kode", true);

      if (isGuildPremium(guild.id)) {
        await interaction.reply({
          content: "Server ini sudah premium sebelumnya.",
          ephemeral: true,
        });
        return;
      }

      const result = redeemCodeForGuild(code, guild, interaction.user.id);
      if (!result.ok) {
        await interaction.reply({
          content: `Gagal redeem: ${result.reason}`,
          ephemeral: true,
        });
        return;
      }

      await interaction.reply({
        content:
          "Berhasil redeem! Server ini sekarang sudah premium dan bisa pakai /afk-join 24/7.",
        ephemeral: true,
      });
    } else if (interaction.commandName === "premium-status") {
      const guild = interaction.guild;
      if (!guild) {
        await interaction.reply({
          content: "Command ini cuma bisa dipakai di server, bukan DM.",
          ephemeral: true,
        });
        return;
      }

      if (isGuildPremium(guild.id)) {
        const info = premiumData.guilds[guild.id];
        await interaction.reply({
          content: `Server ini **SUDAH PREMIUM** sejak ${info.activatedAt}.`,
          ephemeral: true,
        });
      } else {
        await interaction.reply({
          content:
            "Server ini **BELUM PREMIUM**. Silakan hubungi owner untuk beli dan redeem kode lewat /premium-redeem.",
          ephemeral: true,
        });
      }
    }
  } catch (error) {
    console.error("interactionCreate error:", error);
    if (interaction.isRepliable()) {
      try {
        await interaction.reply({
          content: "Terjadi error saat memproses command.",
          ephemeral: true,
        });
      } catch (_) {}
    }
  }
});

client.on("error", (error) => {
  console.error("Client error:", error);
});

client.login(TOKEN).catch((error) => {
  console.error("Failed to login:", error);
});
