// Verificación del token de Google + sesión propia firmada (HMAC), sin dependencias.
const crypto = require('crypto');

const SECRET = process.env.JWT_SECRET || 'dev-insecure-secret-cambiar-en-produccion';
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || 'ricciarditomas@gmail.com').toLowerCase();
const SESSION_MS = 1000 * 60 * 60 * 24 * 30; // 30 días

function sign(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  return body + '.' + sig;
}

function verify(token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return null;
  const [body, sig] = token.split('.');
  const expect = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  try {
    const a = Buffer.from(sig);
    const b = Buffer.from(expect);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    const p = JSON.parse(Buffer.from(body, 'base64url').toString());
    if (!p.exp || Date.now() > p.exp) return null;
    return p;
  } catch { return null; }
}

function newSession({ uid, email, name, admin }) {
  return sign({ uid, email, name, admin: !!admin, exp: Date.now() + SESSION_MS });
}

// Lee "Authorization: Bearer <token>" y devuelve el payload de sesión (o null).
function getSession(req) {
  const h = req.headers['authorization'] || req.headers['Authorization'] || '';
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m ? verify(m[1]) : null;
}

// Verifica el ID token de Google contra el endpoint oficial (sin librerías).
async function verifyGoogle(credential, clientId) {
  if (!credential) return null;
  const r = await fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(credential));
  if (!r.ok) return null;
  const d = await r.json();
  if (clientId && d.aud !== clientId) return null;
  if (!d.sub || !d.email) return null;
  if (d.email_verified === 'false' || d.email_verified === false) return null;
  return { sub: d.sub, email: String(d.email).toLowerCase(), name: d.name || '', picture: d.picture || '' };
}

module.exports = { newSession, getSession, verifyGoogle, ADMIN_EMAIL };
