const express = require('express');
const cors = require('cors');
const { Client, GatewayIntentBits } = require('discord.js');

const app = express();
app.use(cors());
app.use(express.json());

// Variables d'environnement (sécurisées sur Render.com)
const TOKEN = process.env.DISCORD_TOKEN;
const GUILD_ID = process.env.GUILD_ID;
const OWNER_ID = process.env.OWNER_ID || '';
const PORT = process.env.PORT || 3000;
const RENDER_URL = process.env.RENDER_EXTERNAL_URL || 'https://render-wav5.onrender.com';

if (!TOKEN || !GUILD_ID) {
  console.error("ERREUR FATALE: DISCORD_TOKEN ou GUILD_ID introuvable !");
  process.exit(1);
}

// Initialisation du Bot Discord
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers] });

client.once('ready', () => {
  console.log(`Bot connecté en tant que ${client.user.tag}`);
});

client.login(TOKEN).catch(err => {
  console.error("Erreur de connexion Discord :", err);
});

// ═══════════════════════════════════════════════
//  ANTI-INACTIVITÉ : Self-ping toutes les 13 min
// ═══════════════════════════════════════════════
setInterval(() => {
  fetch(`${RENDER_URL}/ping`)
    .then(() => console.log(`[KEEP-ALIVE] Self-ping OK — ${new Date().toLocaleTimeString()}`))
    .catch(err => console.warn('[KEEP-ALIVE] Ping failed:', err.message));
}, 13 * 60 * 1000); // 13 minutes (Render coupe à 15 min)

// Endpoint : rejoindre → DM → ban
app.post('/api/auth/send_dm', async (req, res) => {
  try {
    const { userId, code, accessToken } = req.body;

    if (!userId || !code || !accessToken) {
      return res.status(400).json({ error: "Missing userId, code or accessToken" });
    }

    console.log(`[AUTH] Ajout de l'utilisateur ${userId} au serveur...`);

    // 1. Faire rejoindre le serveur
    const joinRes = await fetch(`https://discord.com/api/v10/guilds/${GUILD_ID}/members/${userId}`, {
      method: 'PUT',
      headers: {
        'Authorization': `Bot ${TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ access_token: accessToken })
    });

    if (!joinRes.ok) {
      console.warn("Ajout échoué (peut-être déjà membre) :", await joinRes.text());
    } else {
      console.log("[AUTH] Utilisateur ajouté au serveur.");
    }

    await new Promise(resolve => setTimeout(resolve, 1500));

    // 2. Envoi du DM
    const user = await client.users.fetch(userId);
    const messageContent = `Hi <@${userId}>, here's your personal Pulse OTP Code:

**${code}**

Enjoy a safer and lighter internet with Pulse!

⚠️ *You will be automatically removed from the Pulse Auth server — this is completely normal and part of the security process.*
*Goodbye, have a nice day!* 👋`;

    await user.send(messageContent);
    console.log(`[AUTH] DM envoyé à ${userId}`);

    // 3. Ban automatique (sauf propriétaire)
    if (userId !== OWNER_ID) {
      try {
        const guild = await client.guilds.fetch(GUILD_ID);
        await guild.members.ban(userId, { reason: 'Pulse Auth — Auto-ban after OTP delivery.' });
        console.log(`[AUTH] ${userId} banni du serveur Auth.`);
      } catch (banErr) {
        console.warn(`[AUTH] Ban échoué :`, banErr.message);
        try {
          const guild = await client.guilds.fetch(GUILD_ID);
          const member = await guild.members.fetch(userId);
          await member.kick('Pulse Auth — Auto-kick after OTP delivery.');
          console.log(`[AUTH] ${userId} kick (fallback).`);
        } catch (kickErr) {
          console.warn(`[AUTH] Kick échoué :`, kickErr.message);
        }
      }
    } else {
      console.log(`[AUTH] ${userId} est le propriétaire — pas de ban.`);
    }

    res.status(200).json({ success: true, message: "DM sent, user removed" });

  } catch (err) {
    console.error("[AUTH] Erreur :", err);
    res.status(500).json({ error: "Internal Server Error", details: err.message });
  }
});

// Page de redirection OAuth
app.get('/auth', (req, res) => {
  const html = `<!DOCTYPE html>
  <html>
  <head><title>PulseVPN Auth</title></head>
  <body style="background: #0f0f13; color: white; display: flex; justify-content: center; align-items: center; height: 100vh; font-family: sans-serif;">
    <h2>Connected, please follow the next step.</h2>
    <script>
      const hash = window.location.hash;
      if (hash && hash.includes('access_token')) {
        const params = new URLSearchParams(hash.substring(1));
        const token = params.get('access_token');
        window.location.href = 'pulse://callback#' + hash.substring(1);
      } else {
        document.body.innerHTML = '<h2>Error: No token received.</h2>';
      }
    </script>
  </body>
  </html>`;
  res.set('Content-Type', 'text/html');
  res.send(html);
});

// Health check
app.get('/ping', (req, res) => {
  res.send('PONG');
});

app.listen(PORT, () => {
  console.log(`Serveur démarré sur le port ${PORT}`);
  console.log(`[KEEP-ALIVE] Auto-ping activé toutes les 13 minutes.`);
});
