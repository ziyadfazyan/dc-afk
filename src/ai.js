const fetch = require("node-fetch");

const aiCommandDefinition = {
  name: "chat-ai",
  description: "Tanya AI",
  options: [
    {
      name: "prompt",
      description: "Pertanyaan atau perintah untuk AI",
      type: 3, // STRING
      required: true,
    },
  ],
};

async function handleAiCommand(interaction, { apiKey, ownerId }) {
  if (!apiKey) {
    await interaction.reply({
      content:
        "OPENROUTER_API_KEY belum diset di environment. Hubungi owner bot.",
      ephemeral: true,
    });
    return;
  }

  if (!ownerId) {
    await interaction.reply({
      content:
        "AI_OWNER_ID belum diset di environment, jadi fitur AI dimatikan.",
      ephemeral: true,
    });
    return;
  }

  if (interaction.user.id !== ownerId) {
    await interaction.reply({
      content: "Fitur AI ini hanya bisa dipakai oleh owner bot.",
      ephemeral: true,
    });
    return;
  }

  const prompt = interaction.options.getString("prompt", true);

  await interaction.deferReply(); // publik, bisa dilihat semua orang

  try {
    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
        "X-Title": "Discord AFK Bot",
      },
      body: JSON.stringify({
        model: "openrouter/free",
        messages: [
          {
            role: "system",
            content:
              "Kamu adalah asisten AI untuk server Discord. Jawab singkat dan jelas dalam bahasa yang sama dengan user.",
          },
          { role: "user", content: prompt },
        ],
      }),
    });

    if (!response.ok) {
      console.error("OpenRouter API error status:", response.status);
      await interaction.editReply(
        "Gagal menghubungi AI (OpenRouter). Coba lagi nanti.",
      );
      return;
    }

    const data = await response.json();
    const aiMessageRaw =
      data.choices?.[0]?.message?.content || "AI tidak mengembalikan jawaban.";

    // Bersihkan newline berlebih supaya jawaban tidak terlihat "banyak enter" di Discord
    const aiMessageClean = aiMessageRaw.replace(/\s+/g, " ").trim();

    const maxLen = 2000;
    const fullMessage = `**Prompt:** ${prompt}\n**Jawaban:** ${aiMessageClean}`;

    await interaction.editReply(fullMessage.slice(0, maxLen));
  } catch (err) {
    console.error("Error panggil OpenRouter:", err);
    await interaction.editReply(
      "Terjadi error saat menghubungi AI. Coba lagi nanti.",
    );
  }
}

module.exports = {
  aiCommandDefinition,
  handleAiCommand,
};
