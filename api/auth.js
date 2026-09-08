// POST /api/auth  { credential }  -> verifica Google, crea/actualiza usuario, devuelve sesión.
const { sql, ensureTables } = require('./_db');
const { newSession, verifyGoogle, ADMIN_EMAIL } = require('./_auth');
const { otorgar, PROMO, promoActiva } = require('./_promo');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method' });
  try {
    const credential = req.body && req.body.credential;
    const g = await verifyGoogle(credential, process.env.GOOGLE_CLIENT_ID);
    if (!g) return res.status(401).json({ error: 'Token de Google inválido' });

    await ensureTables();
    // xmax = 0 significa que la fila se INSERTó recién: sirve para saber si la
    // cuenta es nueva o si ya existía (lo usa el reporte de la campaña).
    const rows = await sql`
      INSERT INTO users (google_sub, email, name, picture)
      VALUES (${g.sub}, ${g.email}, ${g.name}, ${g.picture})
      ON CONFLICT (google_sub) DO UPDATE
        SET email = EXCLUDED.email, name = EXCLUDED.name, picture = EXCLUDED.picture
      RETURNING id, (xmax = 0) AS nueva`;
    const uid = rows[0].id;
    const cuentaNueva = rows[0].nueva === true;
    const admin = g.email === ADMIN_EMAIL;
    const token = newSession({ uid, email: g.email, name: g.name, admin });

    // El cupón se entrega acá: le toca a cualquiera que inicie sesión mientras
    // dure la campaña, tenga la cuenta recién hecha o de antes. Si algo falla
    // con el cupón NO se rompe el login.
    let voucher = null;
    try { voucher = await otorgar(uid); } catch (e) { voucher = null; }

    res.status(200).json({
      token,
      user: { id: uid, email: g.email, name: g.name, picture: g.picture, admin },
      cuentaNueva,
      voucher,
      promo: promoActiva() ? { monto: PROMO.monto, minimo: PROMO.minimo, vence: PROMO.venceUso } : null,
    });
  } catch (e) {
    res.status(500).json({ error: 'server', detail: String(e && e.message || e) });
  }
};
