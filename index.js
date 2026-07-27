const express = require('express');
const cors = require('cors');
const { Client, GatewayIntentBits } = require('discord.js');

const app = express();
app.use(cors());
app.use(express.json());

// Stockage temporaire
const authSessions = new Map();

// Variables d'environnement
const TOKEN = process.env.DISCORD_TOKEN;
const GUILD_ID = process.env.GUILD_ID;
const OWNER_ID = process.env.OWNER_ID || '';
const PORT = process.env.PORT || 3000;
const RENDER_URL = process.env.RENDER_EXTERNAL_URL || 'https://render-wav5.onrender.com';
const GROQ_API_KEY = process.env.GROQ_API_KEY;

if (!TOKEN || !GUILD_ID) {
  console.error("ERREUR FATALE: DISCORD_TOKEN ou GUILD_ID introuvable !");
  process.exit(1);
}

// Bot Discord
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers] });
client.once('ready', () => { console.log(`Bot connecté en tant que ${client.user.tag}`); });
client.login(TOKEN).catch(err => { console.error("Erreur de connexion Discord :", err); });

// ═══════════════════════════════════════════════
//  ANTI-INACTIVITÉ
// ═══════════════════════════════════════════════
setInterval(() => {
  fetch(`${RENDER_URL}/ping`)
    .then(() => console.log(`[KEEP-ALIVE] Self-ping OK — ${new Date().toLocaleTimeString()}`))
    .catch(err => console.warn('[KEEP-ALIVE] Ping failed:', err.message));
}, 13 * 60 * 1000);

// ═══════════════════════════════════════════════
//  SERVEURS VPN — LISTE DYNAMIQUE
// ═══════════════════════════════════════════════
const SERVERS = [
  {
    id: 'paris',
    city: 'Paris',
    country: 'France',
    flagCode: 'fr',
    ip: '72.61.192.44',
    coordinates: [2.2935, 48.8591],
    confUrl: 'https://raw.githubusercontent.com/eqq7/PulseVPN-Configs/main/Paris-EU.conf',
    load: 42
  }
  // Ajoute d'autres serveurs ici plus tard !
];

// Cache IP Lookup (pour ne pas spammer ip-api.com)
const ipLookupCache = new Map();

app.get('/api/servers', (req, res) => {
  // Renvoie la liste sans les IP brutes (sécurité)
  const publicList = SERVERS.map(s => ({
    id: s.id,
    city: s.city,
    country: s.country,
    flagCode: s.flagCode,
    coordinates: s.coordinates,
    load: s.load
  }));
  res.json(publicList);
});

app.get('/api/servers/:id/lookup', async (req, res) => {
  const server = SERVERS.find(s => s.id === req.params.id);
  if (!server) return res.status(404).json({ error: "Server not found" });

  // Vérifie le cache (valide 10 minutes)
  if (ipLookupCache.has(server.id)) {
    const cached = ipLookupCache.get(server.id);
    if (Date.now() - cached.timestamp < 10 * 60 * 1000) {
      return res.json(cached.data);
    }
  }

  try {
    const lookupRes = await fetch(`http://ip-api.com/json/${server.ip}?fields=status,message,country,countryCode,region,regionName,city,zip,lat,lon,timezone,isp,org,as,query`);
    const data = await lookupRes.json();

    if (data.status === 'fail') {
      throw new Error(data.message);
    }

    const result = {
      id: server.id,
      ip: server.ip,
      city: data.city,
      region: data.regionName,
      country: data.country,
      countryCode: data.countryCode,
      flagCode: server.flagCode,
      coordinates: [data.lon, data.lat],
      timezone: data.timezone,
      isp: data.isp,
      org: data.org,
      as: data.as,
      load: server.load,
      confUrl: server.confUrl
    };

    // Mise en cache
    ipLookupCache.set(server.id, { data: result, timestamp: Date.now() });
    res.json(result);

  } catch (err) {
    console.error("[LOOKUP] Erreur:", err);
    res.status(500).json({ error: "IP Lookup failed" });
  }
});

// ═══════════════════════════════════════════════
//  PROXY IA GROQ
// ═══════════════════════════════════════════════
app.post('/api/chat', async (req, res) => {
  try {
    const { messages } = req.body;
    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({ error: "Invalid messages format" });
    }
    if (!GROQ_API_KEY) {
      return res.status(500).json({ error: "Server missing GROQ_API_KEY" });
    }

    const groqResponse = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${GROQ_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        messages: messages,
        temperature: 0.7,
        max_tokens: 1024,
      })
    });

    if (!groqResponse.ok) {
      const errorText = await groqResponse.text();
      throw new Error(`Groq API Error: ${errorText}`);
    }

    const data = await groqResponse.json();
    res.json(data);
  } catch (error) {
    console.error("[GROQ PROXY] Erreur:", error);
    res.status(500).json({ error: error.message });
  }
});

// ═══════════════════════════════════════════════
//  POLLING AUTH
// ═══════════════════════════════════════════════
app.get('/api/auth/status', (req, res) => {
  const { sessionId } = req.query;
  if (!sessionId) return res.status(400).json({ error: "Missing sessionId" });
  if (authSessions.has(sessionId)) {
    const token = authSessions.get(sessionId);
    authSessions.delete(sessionId);
    return res.json({ token });
  }
  res.status(404).json({ error: "Pending" });
});

app.post('/api/auth/save_token', (req, res) => {
  const { sessionId, token } = req.body;
  if (!sessionId || !token) return res.status(400).json({ error: "Missing data" });
  authSessions.set(sessionId, token);
  setTimeout(() => { authSessions.delete(sessionId); }, 5 * 60 * 1000);
  res.json({ success: true });
});

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
//  ENVOI DM & AUTO-BAN
// ═══════════════════════════════════════════════
app.post('/api/auth/send_dm', async (req, res) => {
  try {
    const { userId, code, accessToken } = req.body;
    if (!userId || !code || !accessToken) {
      return res.status(400).json({ error: "Missing userId, code or accessToken" });
    }

    const joinRes = await fetch(`https://discord.com/api/v10/guilds/${GUILD_ID}/members/${userId}`, {
      method: 'PUT',
      headers: { 'Authorization': `Bot ${TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ access_token: accessToken })
    });
    if (!joinRes.ok) console.warn("Ajout échoué :", await joinRes.text());

    await new Promise(resolve => setTimeout(resolve, 1500));

    const user = await client.users.fetch(userId);
    const messageContent = `Hi <@${userId}>, here's your personal Pulse OTP Code:

**${code}**

Enjoy a safer and lighter internet with Pulse!

⚠️ *You will be automatically removed from the Pulse Auth server — this is completely normal and part of the security process.*
*Goodbye, have a nice day!* 👋`;

    await user.send(messageContent);

    if (userId !== OWNER_ID) {
      try {
        const guild = await client.guilds.fetch(GUILD_ID);
        await guild.members.ban(userId, { reason: 'Pulse Auth — Auto-ban after OTP delivery.' });
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
app.get('/ping', (req, res) => { res.send('PONG'); });

app.listen(PORT, () => { console.log(`Serveur démarré sur le port ${PORT}`); });
