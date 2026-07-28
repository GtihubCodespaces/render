const express = require('express');
const cors = require('cors');
const { createClient } = require('@libsql/client');
const crypto = require('crypto');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

// ═══════════════════════════════════════════════
//  CONFIGURATION & ENV VARS
// ═══════════════════════════════════════════════
const PORT = process.env.PORT || 3000;
const BREVO_API_KEY = process.env.BREVO_API_KEY;
const PAYPAL_CLIENT_ID = process.env.PAYPAL_CLIENT_ID;
const PAYPAL_SECRET = process.env.PAYPAL_SECRET;
const PAYPAL_MODE = process.env.PAYPAL_MODE || 'sandbox';
const GROQ_API_KEY = process.env.GROQ_API_KEY;

const PAYPAL_BASE = PAYPAL_MODE === 'sandbox' 
  ? 'https://api-m.sandbox.paypal.com' 
  : 'https://api-m.paypal.com';

// ═══════════════════════════════════════════════
//  BASE DE DONNÉES TURSO (LIBSQL)
// ═══════════════════════════════════════════════
const db = createClient({
  url: process.env.TURSO_DATABASE_URL || 'file:pulse.db', // Fallback local file:pulse.db si test sans variables env
  authToken: process.env.TURSO_AUTH_TOKEN,
});

async function initDB() {
  try {
    await db.execute(`CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE,
      password_hash TEXT,
      is_pro INTEGER DEFAULT 0,
      verified INTEGER DEFAULT 0,
      otp_code TEXT,
      session_token TEXT
    )`);
    console.log("Connecté à la base Turso (LibSQL).");
  } catch (err) {
    console.error("Erreur de connexion Turso:", err.message);
  }
}
initDB();

// Helper pour hacher les mots de passe (SHA256 basique)
const hashPassword = (pwd) => crypto.createHash('sha256').update(pwd).digest('hex');

// ═══════════════════════════════════════════════
//  API BREVO (SENDINBLUE) - ENVOI OTP
// ═══════════════════════════════════════════════
async function sendOtpEmail(email, code) {
  if (!BREVO_API_KEY) return console.warn("BREVO_API_KEY manquante, email non envoyé.");
  
  const payload = {
    sender: { name: "PulseVPN", email: "noreply@pulsevpn.com" },
    to: [{ email: email }],
    subject: "Your PulseVPN Verification Code",
    htmlContent: `
      <div style="font-family: sans-serif; background: #0f0f13; color: white; padding: 40px; text-align: center; border-radius: 10px;">
        <h1 style="color: #14b8a6;">PulseVPN</h1>
        <p style="color: #aaa;">Here is your secure verification code:</p>
        <div style="font-size: 32px; font-weight: bold; letter-spacing: 5px; background: #222; padding: 20px; border-radius: 8px; margin: 20px auto; width: fit-content; color: #fff;">
          ${code}
        </div>
        <p style="color: #666; font-size: 12px;">If you didn't request this, please ignore this email.</p>
      </div>
    `
  };

  try {
    const res = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: { 'api-key': BREVO_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (!res.ok) console.error("Erreur Brevo:", await res.text());
  } catch (err) {
    console.error("Erreur réseau Brevo:", err);
  }
}

// ═══════════════════════════════════════════════
//  AUTHENTIFICATION
// ═══════════════════════════════════════════════
app.post('/api/auth/register', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: "Email et mot de passe requis" });

  const id = crypto.randomUUID();
  const pwdHash = hashPassword(password);
  const otp = Math.floor(100000 + Math.random() * 900000).toString();

  try {
    const rs = await db.execute({ sql: "SELECT id, verified FROM users WHERE email = ?", args: [email] });
    const row = rs.rows[0];

    if (row && row.verified) {
      return res.status(400).json({ error: "Cet email est déjà utilisé." });
    }
    
    // Insert ou remplace
    await db.execute({
      sql: `INSERT OR REPLACE INTO users (id, email, password_hash, otp_code, verified, is_pro) VALUES (?, ?, ?, ?, 0, 0)`,
      args: [row ? row.id : id, email, pwdHash, otp]
    });

    sendOtpEmail(email, otp);
    res.json({ success: true, message: "Code OTP envoyé par email" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erreur DB" });
  }
});

app.post('/api/auth/verify', async (req, res) => {
  const { email, otp } = req.body;
  try {
    const rs = await db.execute({ sql: "SELECT id, otp_code FROM users WHERE email = ?", args: [email] });
    const user = rs.rows[0];

    if (!user || user.otp_code !== otp) {
      return res.status(400).json({ error: "Code invalide" });
    }
    const token = crypto.randomBytes(32).toString('hex');
    await db.execute({
      sql: "UPDATE users SET verified = 1, otp_code = NULL, session_token = ? WHERE email = ?", 
      args: [token, email]
    });
    res.json({ success: true, token, user: { id: user.id, email } });
  } catch (err) {
    res.status(500).json({ error: "Erreur Serveur" });
  }
});

app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  const pwdHash = hashPassword(password);

  try {
    const rs = await db.execute({ 
      sql: "SELECT id, email, is_pro, verified FROM users WHERE email = ? AND password_hash = ?", 
      args: [email, pwdHash] 
    });
    const user = rs.rows[0];

    if (!user) return res.status(401).json({ error: "Identifiants incorrects" });
    if (!user.verified) return res.status(401).json({ error: "Email non vérifié. Veuillez vous réinscrire." });

    const token = crypto.randomBytes(32).toString('hex');
    await db.execute({
      sql: "UPDATE users SET session_token = ? WHERE id = ?",
      args: [token, user.id]
    });
    res.json({ success: true, token, user: { id: user.id, email: user.email, isPro: !!user.is_pro } });
  } catch (err) {
    res.status(500).json({ error: "Erreur Serveur" });
  }
});

// ═══════════════════════════════════════════════
//  PAYPAL - ABONNEMENTS PRO
// ═══════════════════════════════════════════════
async function getPayPalAccessToken() {
  const auth = Buffer.from(`${PAYPAL_CLIENT_ID}:${PAYPAL_SECRET}`).toString('base64');
  const res = await fetch(`${PAYPAL_BASE}/v1/oauth2/token`, {
    method: 'POST',
    headers: { 'Authorization': `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials'
  });
  const data = await res.json();
  return data.access_token;
}

app.post('/api/billing/create-order', async (req, res) => {
  try {
    const token = await getPayPalAccessToken();
    const orderRes = await fetch(`${PAYPAL_BASE}/v2/checkout/orders`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        intent: 'CAPTURE',
        purchase_units: [{
          amount: { currency_code: 'USD', value: '4.99' },
          description: "PulseVPN Pro - 1 Month"
        }]
      })
    });
    const order = await orderRes.json();
    res.json({ id: order.id });
  } catch (err) {
    res.status(500).json({ error: "Erreur PayPal" });
  }
});

app.post('/api/billing/capture-order', async (req, res) => {
  const { orderID, email } = req.body;
  try {
    const token = await getPayPalAccessToken();
    const captureRes = await fetch(`${PAYPAL_BASE}/v2/checkout/orders/${orderID}/capture`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' }
    });
    const capture = await captureRes.json();
    
    if (capture.status === 'COMPLETED') {
      // Met à jour la DB
      await db.execute({
        sql: "UPDATE users SET is_pro = 1 WHERE email = ?",
        args: [email]
      });
      res.json({ success: true, isPro: true });
    } else {
      res.status(400).json({ error: "Paiement non complété" });
    }
  } catch (err) {
    res.status(500).json({ error: "Erreur PayPal Capture" });
  }
});

// ═══════════════════════════════════════════════
//  SERVEURS & IA (Déjà implémentés)
// ═══════════════════════════════════════════════
const SERVERS = [
  { id: 'paris', city: 'Paris', country: 'France', flagCode: 'fr', ip: '72.61.192.44', coordinates: [2.2935, 48.8591], confUrl: 'https://raw.githubusercontent.com/eqq7/PulseVPN-Configs/main/Paris-EU.conf', load: 42 }
];

const ipLookupCache = new Map();

app.get('/api/servers', (req, res) => {
  res.json(SERVERS.map(s => ({ id: s.id, city: s.city, country: s.country, flagCode: s.flagCode, coordinates: s.coordinates, load: s.load })));
});

app.get('/api/servers/:id/lookup', async (req, res) => {
  const server = SERVERS.find(s => s.id === req.params.id);
  if (!server) return res.status(404).json({ error: "Server not found" });

  if (ipLookupCache.has(server.id) && (Date.now() - ipLookupCache.get(server.id).timestamp < 600000)) {
    return res.json(ipLookupCache.get(server.id).data);
  }

  try {
    const lookupRes = await fetch(`http://ip-api.com/json/${server.ip}?fields=status,message,country,countryCode,region,regionName,city,zip,lat,lon,timezone,isp,org,as,query`);
    const data = await lookupRes.json();
    if (data.status === 'fail') throw new Error(data.message);

    const result = { ...data, id: server.id, ip: server.ip, flagCode: server.flagCode, coordinates: [data.lon, data.lat], load: server.load, confUrl: server.confUrl };
    ipLookupCache.set(server.id, { data: result, timestamp: Date.now() });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: "IP Lookup failed" });
  }
});

app.post('/api/chat', async (req, res) => {
  try {
    const { messages } = req.body;
    const groqResponse = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${GROQ_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'llama-3.3-70b-versatile', messages, temperature: 0.7, max_tokens: 1024 })
    });
    if (!groqResponse.ok) throw new Error(await groqResponse.text());
    res.json(await groqResponse.json());
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Ping
app.get('/ping', (req, res) => { res.send('PONG'); });

app.listen(PORT, () => { console.log(`Serveur démarré sur le port ${PORT}`); });
