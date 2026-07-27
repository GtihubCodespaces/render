const express = require('express');
const cors = require('cors');
const { Client, GatewayIntentBits } = require('discord.js');

const app = express();
app.use(cors());
app.use(express.json());

// Variables d'environnement (Sécurisé sur Render.com)
const TOKEN = process.env.DISCORD_TOKEN;
const GUILD_ID = process.env.GUILD_ID;
const PORT = process.env.PORT || 3000;

if (!TOKEN || !GUILD_ID) {
  console.error("ERREUR FATALE: DISCORD_TOKEN ou GUILD_ID introuvable dans l'environnement !");
  process.exit(1);
}

// Initialisation du Bot Discord
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once('ready', () => {
  console.log(`Bot connecté avec succès en tant que ${client.user.tag}`);
});

client.login(TOKEN).catch(err => {
  console.error("Erreur de connexion Discord :", err);
});

// Endpoint pour faire rejoindre le serveur et envoyer le DM
app.post('/api/auth/send_dm', async (req, res) => {
  try {
    const { userId, code, accessToken } = req.body;

    if (!userId || !code || !accessToken) {
      return res.status(400).json({ error: "Missing userId, code or accessToken" });
    }

    console.log(`[AUTH] Ajout de l'utilisateur ${userId} au serveur...`);

    // 1. Faire rejoindre l'utilisateur au serveur Discord (via l'API Discord)
    const joinRes = await fetch(`https://discord.com/api/v10/guilds/${GUILD_ID}/members/${userId}`, {
      method: 'PUT',
      headers: {
        'Authorization': `Bot ${TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ access_token: accessToken })
    });

    if (!joinRes.ok) {
      console.warn("L'utilisateur est peut-être déjà sur le serveur ou une erreur s'est produite :", await joinRes.text());
    }

    // Pause de sécurité d'une seconde pour laisser Discord actualiser les droits
    await new Promise(resolve => setTimeout(resolve, 1000));

    // 2. Envoi du Message Privé (DM)
    const user = await client.users.fetch(userId);
    const messageContent = `Hi <@${userId}>, here's your personal Pulse OTP Code:

**${code}**

Enjoy a safer and lighter internet with Pulse!

*Don't forget to quit the Pulse Auth Server!*
*Goodbye, have a nice day.*`;

    await user.send(messageContent);
    console.log(`[AUTH] DM envoyé avec succès à ${userId}`);

    res.status(200).json({ success: true, message: "DM sent" });

  } catch (err) {
    console.error("[AUTH] Erreur interne :", err);
    res.status(500).json({ error: "Internal Server Error", details: err.message });
  }
});

// Health check pour Render.com
app.get('/ping', (req, res) => {
  res.send('PONG');
});

// Lancement du serveur Web
app.listen(PORT, () => {
  console.log(`Serveur Express démarré sur le port ${PORT}`);
});
