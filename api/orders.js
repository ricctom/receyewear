// /api/orders
//   POST  { items:[{sku,name,color,qty,price}], total }  -> crea pedido del usuario logueado
//   GET                                                   -> lista los pedidos del usuario
const { sql, ensureTables } = require('./_db');
const { getSession } = require('./_auth');

module.exports = async (req, res) => {
  const s = getSession(req);
  if (!s) return res.status(401).json({ error: 'Necesitás iniciar sesión' });
  try {
    await ensureTables();

    if (req.method === 'POST') {
      const body = req.body || {};
      const items = Array.isArray(body.items) ? body.items : null;
      if (!items || !items.length) return res.status(400).json({ error: 'Carrito vacío' });

      // Total recalculado en el server (no se confía en el precio del cliente).
      const total = items.reduce((acc, it) => {
        const price = Number(it.price) || 0;
        const qty = Math.max(1, parseInt(it.qty, 10) || 1);
        return acc + price * qty;
      }, 0);

      const clean = items.map((it) => ({
        sku: String(it.sku || ''),
        name: String(it.name || ''),
        color: it.color ? String(it.color) : null,
        qty: Math.max(1, parseInt(it.qty, 10) || 1),
        price: Number(it.price) || 0,
      }));

      const rows = await sql`
        INSERT INTO orders (user_id, items, total)
        VALUES (${s.uid}, ${JSON.stringify(clean)}::jsonb, ${total})
        RETURNING id, total, status, created_at`;
      return res.status(200).json({ order: rows[0] });
    }

    if (req.method === 'GET') {
      const rows = await sql`
        SELECT id, items, total, status, created_at
        FROM orders WHERE user_id = ${s.uid} ORDER BY id DESC LIMIT 100`;
      return res.status(200).json({ orders: rows });
    }

    res.status(405).json({ error: 'method' });
  } catch (e) {
    res.status(500).json({ error: 'server', detail: String(e && e.message || e) });
  }
};
