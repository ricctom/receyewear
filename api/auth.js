// POST /api/auth  { credential }  -> verifica Google, crea/actualiza usuario, devuelve sesión.
const { sql, ensureTables } = require('./_db');
const { newSession, verifyGoogle, ADMIN_EMAIL } = require('./_auth');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method' });
  try {
    const credential = req.body && req.body.credential;
    const g = await verifyGoogle(credential, process.env.GOOGLE_CLIENT_ID);
    if (!g) return res.status(401).json({ error: 'Token de Google inválido' });

    await ensureTables();
    const rows = await sql`
      INSERT INTO users (google_sub, email, name, picture)
      VALUES (${g.sub}, ${g.email}, ${g.name}, ${g.picture})
      ON CONFLICT (google_sub) DO UPDATE
        SET email = EXCLUDED.email, name = EXCLUDED.name, picture = EXCLUDED.picture
      RETURNING id`;
    const uid = rows[0].id;
    const admin = g.email === ADMIN_EMAIL;
    const token = newSession({ uid, email: g.email, name: g.name, admin });
    res.status(200).json({ token, user: { id: uid, email: g.email, name: g.name, picture: g.picture, admin } });
  } catch (e) {
    res.status(500).json({ error: 'server', detail: String(e && e.message || e) });
  }
};
