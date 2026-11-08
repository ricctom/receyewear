// POST /api/auth  { credential }  -> verifica Google, crea/actualiza usuario, devuelve sesión.
//
// También lo llama Google directamente cuando el login se hace desde el
// celular (modo "redirect", ver index.html): llega como formulario con
// credential + g_csrf_token, y en vez de JSON se devuelve una página mínima
// que deja el resultado en sessionStorage y vuelve a la tienda.
const { sql, ensureTables } = require('./_db');
const { newSession, verifyGoogle, ADMIN_EMAIL } = require('./_auth');
const { otorgar, PROMO, promoActiva } = require('./_promo');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method' });
  const b = req.body || {};
  const desdeGoogle = !!b.g_csrf_token;
  const responder = (code, data) => desdeGoogle ? volverATienda(res, data) : res.status(code).json(data);
  try {
    // Google manda el mismo token en una cookie y en el formulario: si no
    // coinciden, el pedido no vino de Google.
    if (desdeGoogle && cookie(req, 'g_csrf_token') !== String(b.g_csrf_token)) {
      return responder(400, { error: 'Probá de nuevo' });
    }
    const credential = b.credential;
    const g = await verifyGoogle(credential, process.env.GOOGLE_CLIENT_ID);
    if (!g) return responder(401, { error: 'Token de Google inválido' });

    await ensureTables();
    // Si Tomás le cargó una venta antes de que tuviera cuenta, el usuario se
    // creó con su mail: al entrar con Google por primera vez queda enganchado.
    await sql`UPDATE users SET google_sub = ${g.sub}
      WHERE lower(email) = ${g.email} AND google_sub LIKE 'pendiente:%'
        AND NOT EXISTS (SELECT 1 FROM users x WHERE x.google_sub = ${g.sub})`;
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

    responder(200, {
      token,
      user: { id: uid, email: g.email, name: g.name, picture: g.picture, admin },
      cuentaNueva,
      voucher,
      promo: promoActiva() ? { monto: PROMO.monto, minimo: PROMO.minimo, vence: PROMO.venceUso } : null,
    });
  } catch (e) {
    responder(500, { error: 'server', detail: String(e && e.message || e) });
  }
};

function cookie(req, nombre) {
  const m = String(req.headers.cookie || '').match(new RegExp('(?:^|;\\s*)' + nombre + '=([^;]*)'));
  return m ? decodeURIComponent(m[1]) : null;
}

// Página puente: guarda el resultado y vuelve a la tienda, que termina el
// login al arrancar. El JSON va escapado para que no pueda cerrar el <script>.
function volverATienda(res, data) {
  const json = JSON.stringify(JSON.stringify(data)).replace(/</g, '\\u003c');
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).send('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width">'
    + '<p style="font-family:sans-serif;text-align:center;margin-top:40vh">Volviendo a la tienda…</p>'
    + '<script>try{sessionStorage.setItem("rec4_login",' + json + ')}catch(e){}location.replace("/")</script>');
}
