require("dotenv").config();

const { Client, GatewayIntentBits, PermissionFlagsBits } = require("discord.js");
const { premiumData, isGuildPremium, redeemCodeForGuild } = require("./src/premium");
const {
  voiceStates,
  connectToVoice,
  autoReconnect,
  clearPersistentVoiceForGuild,
  setLeaveCode,
  getLeaveCode,
  getLeaveCodeOwner,
} = require("./src/voice");
const { aiCommandDefinition, handleAiCommand } = require("./src/ai");

const TOKEN = process.env.DISCORD_TOKEN;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const AI_OWNER_ID = process.env.AI_OWNER_ID; // Discord user ID yang boleh pakai AI

if (!TOKEN) {
  console.error("Missing DISCORD_TOKEN in environment.");
  process.exit(1);
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
});

client.once("ready", async () => {
  console.log(`Logged in as ${client.user.tag}`);
  client.user.setPresence({
    status: "online",
    activities: [{ name: "AFK 24/7", type: 0 }],
  });

  const commands = [
    {
      name: "afk-join",
      description: "Make the bot join your current voice channel and AFK",
      options: [
        {
          name: "kode",
          description:
            "Kode opsional. Kalau diisi, nanti /afk-leave butuh kode yang sama.",
          type: 3, // STRING
          required: false,
        },
      ],
    },
    {
      name: "afk-leave",
      description: "Disconnect the bot from the voice channel",
      options: [
        {
          name: "kode",
          description:
            "Kalau /afk-join sebelumnya pakai kode, isi kode yang sama di sini.",
          type: 3, // STRING
          required: false,
        },
      ],
    },
    {
      name: "premium-redeem",
      description: "Redeem kode premium untuk server ini",
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
    {
      ...aiCommandDefinition,
      // Semua member di server bisa pakai /ai.
      // Tidak ada default_member_permissions -> default: semua member.
      dm_permission: false,
    },
  ];

  try {
    // Bersihkan dulu semua global commands lama supaya tidak ada definisi sisa.
    await client.application.commands.set([]);
    console.log("Cleared global slash commands.");
  } catch (error) {
    console.error("Failed to clear global slash commands:", error);
  }
  // Daftarkan commands sebagai guild commands di setiap server;
  // ini yang dipakai Discord untuk menu / di guild tersebut.
  for (const guild of client.guilds.cache.values()) {
    try {
      await guild.commands.set(commands);
      console.log(
        `Slash commands registered in guild ${guild.name} (${guild.id}).`,
      );
    } catch (error) {
      console.error(
        `Failed to register slash commands in guild ${guild.id}:`,
        error,
      );
    }
  }
  // Setelah bot nyala (misalnya habis restart PM2/server), coba join lagi
  // ke voice channel yang sebelumnya disimpan di persistentVoiceState.
  autoReconnect(client);

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
          ephemeral: false,
        });
        return;
      }

      if (!isGuildPremium(guild.id)) {
        await interaction.reply({
          content:
            "Server ini belum premium. Silakan bayar ke owner dulu lalu redeem kode pakai /premium-redeem.",
          ephemeral: false,
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
          ephemeral: false,
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
          ephemeral: false,
        });
        return;
      }

      const kodeJoin = interaction.options.getString("kode");
      setLeaveCode(guild.id, kodeJoin || "", interaction.user.id);

      connectToVoice(guild, voiceChannel);
      await interaction.reply({
        content: `Aku join ke **${voiceChannel.name}** dan AFK di sini.`,
        ephemeral: false,
      });
    } else if (interaction.commandName === "afk-leave") {
      const guild = interaction.guild;
      const state = voiceStates.get(guild.id);
      if (!state || !state.connection) {
        await interaction.reply({
          content: "Aku lagi tidak di voice channel mana pun di server ini.",
          ephemeral: false,
        });
        return;
      }

      const requiredCode = getLeaveCode(guild.id);
      const isServerOwner = guild && guild.ownerId === interaction.user.id;
      const isBotOwner = interaction.user.id === AI_OWNER_ID;

      if (requiredCode && !isServerOwner && !isBotOwner) {
        const inputCode = interaction.options.getString("kode");
        const trimmed = inputCode && inputCode.trim();

        if (!trimmed) {
          await interaction.reply({
            content:
              "Channel AFK di server ini dikunci dengan kode. Gunakan /afk-leave dengan parameter `kode` yang benar.",
            ephemeral: true,
          });
          return;
        }

        if (trimmed !== requiredCode) {
          const ownerId = getLeaveCodeOwner(guild.id);
          let infoOwner = "";

          // Tampilkan hanya kalau yang set adalah owner server,
          // dan BUKAN bot owner global.
          if (
            ownerId &&
            guild &&
            guild.ownerId === ownerId &&
            ownerId !== AI_OWNER_ID
          ) {
            const ownerMember = guild.members.cache.get(ownerId);
            const displayName = ownerMember
              ? ownerMember.displayName || ownerMember.user.username
              : null;
            infoOwner = displayName
              ? ` Kode ini diset oleh **${displayName}** (<@${ownerId}>).`
              : ` Kode ini diset oleh <@${ownerId}>.`;
          }

          await interaction.reply({
            content: `Kode yang kamu masukkan salah.${infoOwner}`,
            ephemeral: true,
          });
          return;
        }
      }

      try {
        state.connection.destroy();
      } catch (e) {
        console.error("Error destroying voice connection:", e);
      }

      voiceStates.delete(guild.id);
      // Hapus juga dari persistent state supaya tidak auto-join lagi setelah restart
      clearPersistentVoiceForGuild(guild.id);
      await interaction.reply({
        content: "Sudah keluar dari voice channel.",
        ephemeral: false,
      });
    } else if (interaction.commandName === "premium-redeem") {
      const guild = interaction.guild;
      if (!guild) {
        await interaction.reply({
          content: "Command ini cuma bisa dipakai di server, bukan DM.",
          ephemeral: false,
        });
        return;
      }

      const code = interaction.options.getString("kode", true);

      if (isGuildPremium(guild.id)) {
        await interaction.reply({
          content: "Server ini sudah premium sebelumnya.",
          ephemeral: false,
        });
        return;
      }

      const result = redeemCodeForGuild(code, guild, interaction.user.id);
      if (!result.ok) {
        await interaction.reply({
          content: `Gagal redeem: ${result.reason}`,
          ephemeral: false,
        });
        return;
      }

      await interaction.reply({
        content:
          "Berhasil redeem! Server ini sekarang sudah premium dan bisa pakai /afk-join 24/7.",
        ephemeral: false,
      });
    } else if (interaction.commandName === "premium-status") {
      const guild = interaction.guild;
      if (!guild) {
        await interaction.reply({
          content: "Command ini cuma bisa dipakai di server, bukan DM.",
          ephemeral: false,
        });
        return;
      }

      if (isGuildPremium(guild.id)) {
        const info = premiumData.guilds[guild.id];
        await interaction.reply({
          content: `Server ini **SUDAH PREMIUM** sejak ${info.activatedAt}.`,
          ephemeral: false,
        });
      } else {
        await interaction.reply({
          content:
            "Server ini **BELUM PREMIUM**. Silakan hubungi owner untuk beli dan redeem kode lewat /premium-redeem.",
          ephemeral: false,
        });
      }
    } else if (interaction.commandName === "ai") {
      await handleAiCommand(interaction, {
        apiKey: OPENROUTER_API_KEY,
        ownerId: AI_OWNER_ID,
      });
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
