const express = require('express');
const cors = require('cors');
const { Client, GatewayIntentBits } = require('discord.js');

const app = express();
app.use(cors());
app.use(express.json());

// Stockage temporaire des tokens en mémoire (SessionID => Token)
const authSessions = new Map();

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
}, 13 * 60 * 1000);

// ═══════════════════════════════════════════════
//  POLLING AUTHENTIFICATION
// ═══════════════════════════════════════════════

// 1. L'app Tauri interroge ce point d'accès en boucle
app.get('/api/auth/status', (req, res) => {
  const { sessionId } = req.query;
  if (!sessionId) return res.status(400).json({ error: "Missing sessionId" });

  if (authSessions.has(sessionId)) {
    const token = authSessions.get(sessionId);
    authSessions.delete(sessionId); // Le token est lu, on le supprime par sécurité
    return res.json({ token });
  }

  res.status(404).json({ error: "Pending" });
});

// 2. La page HTML envoie le token récupéré via hash à cet endpoint
app.post('/api/auth/save_token', (req, res) => {
  const { sessionId, token } = req.body;
  if (!sessionId || !token) return res.status(400).json({ error: "Missing data" });

  authSessions.set(sessionId, token);
  
  // Nettoyage automatique après 5 minutes si non réclamé
  setTimeout(() => {
    authSessions.delete(sessionId);
  }, 5 * 60 * 1000);

  res.json({ success: true });
});

// 3. Page de redirection Discord OAuth
app.get('/auth', (req, res) => {
  const html = `<!DOCTYPE html>
  <html>
  <head><title>PulseVPN Auth</title></head>
  <body style="background: #0f0f13; color: white; display: flex; flex-direction: column; justify-content: center; align-items: center; height: 100vh; font-family: sans-serif; text-align: center;">
    
    <div id="status">
      <h2>Authenticating...</h2>
      <p style="color: #ffffff80;">Please wait while we connect your account.</p>
    </div>

    <script>
      const hash = window.location.hash;
      if (hash && hash.includes('access_token') && hash.includes('state=')) {
        const params = new URLSearchParams(hash.substring(1));
        const token = params.get('access_token');
        const sessionId = params.get('state');

        if (token && sessionId) {
          fetch('/api/auth/save_token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sessionId, token })
          }).then(res => {
            if(res.ok) {
              document.getElementById('status').innerHTML = '<h2>✅ Success!</h2><p style="color: #14b8a6;">You can safely close this window and return to PulseVPN.</p>';
              // Tente de fermer l'onglet automatiquement
              setTimeout(() => { window.close(); }, 3000);
            }
          });
        }
      } else {
        document.getElementById('status').innerHTML = '<h2>❌ Error</h2><p style="color: #ef4444;">No token or session ID received.</p>';
      }
    </script>
  </body>
  </html>`;
  res.set('Content-Type', 'text/html');
  res.send(html);
});

// ═══════════════════════════════════════════════
//  ENVOI DU DM & AUTO-BAN
// ═══════════════════════════════════════════════
app.post('/api/auth/send_dm', async (req, res) => {
  try {
    const { userId, code, accessToken } = req.body;

    if (!userId || !code || !accessToken) {
      return res.status(400).json({ error: "Missing userId, code or accessToken" });
    }

    console.log(`[AUTH] Ajout de l'utilisateur ${userId} au serveur...`);

    const joinRes = await fetch(`https://discord.com/api/v10/guilds/${GUILD_ID}/members/${userId}`, {
      method: 'PUT',
      headers: {
        'Authorization': `Bot ${TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ access_token: accessToken })
    });

    if (!joinRes.ok) console.warn("Ajout échoué :", await joinRes.text());
    else console.log("[AUTH] Utilisateur ajouté au serveur.");

    await new Promise(resolve => setTimeout(resolve, 1500));

    const user = await client.users.fetch(userId);
    const messageContent = `Hi <@${userId}>, here's your personal Pulse OTP Code:

**${code}**

Enjoy a safer and lighter internet with Pulse!

⚠️ *You will be automatically removed from the Pulse Auth server — this is completely normal and part of the security process.*
*Goodbye, have a nice day!* 👋`;

    await user.send(messageContent);
    console.log(`[AUTH] DM envoyé à ${userId}`);

    if (userId !== OWNER_ID) {
      try {
        const guild = await client.guilds.fetch(GUILD_ID);
        await guild.members.ban(userId, { reason: 'Pulse Auth — Auto-ban after OTP delivery.' });
        console.log(`[AUTH] ${userId} banni.`);
      } catch (banErr) {
        try {
          const guild = await client.guilds.fetch(GUILD_ID);
          const member = await guild.members.fetch(userId);
          await member.kick('Pulse Auth — Auto-kick after OTP delivery.');
        } catch (kickErr) {}
      }
    }

    res.status(200).json({ success: true, message: "DM sent, user removed" });

  } catch (err) {
    console.error("[AUTH] Erreur :", err);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

// Health check
app.get('/ping', (req, res) => {
  res.send('PONG');
});

app.listen(PORT, () => {
  console.log(`Serveur démarré sur le port ${PORT}`);
});
