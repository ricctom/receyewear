// POST /api/cart  { sid, items:[{sku,name,color,qty,price}] }
// Guarda el carrito tal como está en el navegador. Es público a propósito (se
// arma antes de iniciar sesión), igual que /api/track. Si ya inició sesión,
// queda enganchado a su usuario.
//   - items con algo  -> el carrito queda "abierto" con esos productos
//   - items vacío     -> si estaba abierto pasa a "vaciado" (se conservan los
//                        últimos productos para saber qué tenía)
// Cuando el pedido se confirma, /api/orders lo marca como "pedido".
const { sql, ensureTables } = require('./_db');
const { getSession } = require('./_auth');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method' });
  try {
    const b = req.body || {};
    const sid = String(b.sid || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40);
    if (sid.length < 8) return res.status(400).json({ error: 'sid' });

    const items = (Array.isArray(b.items) ? b.items : []).slice(0, 300).map((it) => ({
      sku: String((it && it.sku) || '').slice(0, 60),
      name: String((it && it.name) || '').slice(0, 200),
      color: it && it.color ? String(it.color).slice(0, 80) : null,
      qty: Math.min(100000, Math.max(1, parseInt(it && it.qty, 10) || 1)),
      price: Math.max(0, Number(it && it.price) || 0),
    })).filter((it) => it.name);
    const total = Math.round(items.reduce((a, it) => a + it.price * it.qty, 0));
    const unidades = items.reduce((a, it) => a + it.qty, 0);

    const s = getSession(req);
    const uid = s ? s.uid : null;
    await ensureTables();

    if (!items.length) {
      await sql`UPDATE carts SET estado = 'vaciado', user_id = COALESCE(${uid}, user_id), updated_at = now()
        WHERE sid = ${sid} AND estado = 'abierto'`;
      return res.status(200).json({ ok: true });
    }

    // Si el carrito anterior de este navegador ya terminó (pedido, vaciado o
    // descartado), el que empieza ahora es uno nuevo: arranca de cero.
    await sql`
      INSERT INTO carts (sid, user_id, items, total, unidades, estado)
      VALUES (${sid}, ${uid}, ${JSON.stringify(items)}::jsonb, ${total}, ${unidades}, 'abierto')
      ON CONFLICT (sid) DO UPDATE SET
        items = EXCLUDED.items, total = EXCLUDED.total, unidades = EXCLUDED.unidades,
        user_id = COALESCE(EXCLUDED.user_id, carts.user_id),
        order_id = CASE WHEN carts.estado = 'abierto' THEN carts.order_id ELSE NULL END,
        created_at = CASE WHEN carts.estado = 'abierto' THEN carts.created_at ELSE now() END,
        estado = 'abierto',
        updated_at = now()`;
    res.status(200).json({ ok: true });
  } catch (e) {
    // Si falla el registro NO se le rompe la página a nadie.
    res.status(200).json({ ok: false });
  }
};
