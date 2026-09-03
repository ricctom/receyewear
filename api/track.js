// POST /api/track  { tipo, sid, ref, meta }
// Registra un paso del embudo. Es público a propósito (tiene que funcionar
// antes de que la persona inicie sesión), así que sólo acepta una lista fija
// de eventos y guarda una única fila por visitante y paso.
const { sql, ensureTables } = require('./_db');
const { getSession } = require('./_auth');

// Los pasos del embudo, en orden. Lo que no está acá se descarta.
const TIPOS = [
  'visita',            // abrió el sitio
  'promo_vista',       // le apareció el cartel del cupón
  'promo_cerrada',     // lo cerró sin iniciar sesión
  'login_ok',          // inició sesión con Google
  'cupon_dado',        // se le cargó el cupón
  'carrito_add',       // puso el primer producto en el carrito
  'checkout_abierto',  // llegó a los datos de envío
  'pedido_ok',         // confirmó el pedido
];

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method' });
  try {
    const b = req.body || {};
    const tipo = String(b.tipo || '');
    if (!TIPOS.includes(tipo)) return res.status(400).json({ error: 'tipo' });

    // El sid lo genera el navegador y vive en su localStorage: no identifica a
    // nadie, sólo sirve para no contar diez veces a la misma persona.
    const sid = String(b.sid || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40);
    if (sid.length < 8) return res.status(400).json({ error: 'sid' });

    // De dónde vino (el ?d= del link de la difusión, o el dominio que lo mandó).
    const ref = b.ref == null ? null : String(b.ref).slice(0, 120);
    // Se copian a lo sumo 6 claves y valores cortos. (Cortar el JSON por la
    // mitad lo dejaría inválido, así que se recorta clave por clave.)
    let meta = null;
    if (b.meta && typeof b.meta === 'object' && !Array.isArray(b.meta)) {
      meta = {};
      for (const k of Object.keys(b.meta).slice(0, 6)) {
        const v = b.meta[k];
        if (v == null) continue;
        meta[String(k).slice(0, 30)] =
          typeof v === 'number' || typeof v === 'boolean' ? v : String(v).slice(0, 120);
      }
      if (!Object.keys(meta).length) meta = null;
    }

    const s = getSession(req);   // si ya inició sesión, queda enganchado
    await ensureTables();
    await sql`
      INSERT INTO events (tipo, sid, user_id, ref, meta)
      VALUES (${tipo}, ${sid}, ${s ? s.uid : null}, ${ref},
              ${meta ? JSON.stringify(meta) : null}::jsonb)
      ON CONFLICT (sid, tipo) DO NOTHING`;
    res.status(200).json({ ok: true });
  } catch (e) {
    // Si falla el registro NO se le rompe la página a nadie.
    res.status(200).json({ ok: false });
  }
};
