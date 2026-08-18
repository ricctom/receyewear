// /api/admin  (solo el email admin)
//   GET                      -> todos los pedidos con datos del cliente
//   POST  { id, status }     -> cambia el estado de un pedido
//   POST  { id, items }      -> reemplaza los items del pedido y recalcula el total
const { sql, ensureTables } = require('./_db');
const { getSession } = require('./_auth');

const ALLOWED = ['nuevo', 'preparando', 'enviado', 'entregado', 'cancelado'];

module.exports = async (req, res) => {
  const s = getSession(req);
  if (!s || !s.admin) return res.status(403).json({ error: 'Solo el administrador' });
  try {
    await ensureTables();

    if (req.method === 'GET') {
      const rows = await sql`
        SELECT o.id, o.items, o.total, o.status, o.created_at, u.email, u.name
        FROM orders o JOIN users u ON u.id = o.user_id
        ORDER BY o.id DESC LIMIT 500`;
      return res.status(200).json({ orders: rows });
    }

    if (req.method === 'POST') {
      const { id, status, items } = req.body || {};
      if (!id) return res.status(400).json({ error: 'Datos inválidos' });

      // Edición de los items del pedido (el total se recalcula acá, no se confía en el front).
      if (Array.isArray(items)) {
        if (!items.length) return res.status(400).json({ error: 'El pedido no puede quedar vacío' });
        const clean = items.map((it) => ({
          sku: String(it.sku || ''),
          name: String(it.name || ''),
          color: it.color ? String(it.color) : null,
          qty: Math.max(1, parseInt(it.qty, 10) || 1),
          price: Number(it.price) || 0,
        }));
        if (clean.some((it) => !it.name)) return res.status(400).json({ error: 'Hay un item sin nombre' });
        const total = clean.reduce((acc, it) => acc + it.price * it.qty, 0);
        await sql`UPDATE orders SET items = ${JSON.stringify(clean)}::jsonb, total = ${total} WHERE id = ${id}`;
        return res.status(200).json({ ok: true, total });
      }

      if (!ALLOWED.includes(status)) return res.status(400).json({ error: 'Datos inválidos' });
      await sql`UPDATE orders SET status = ${status} WHERE id = ${id}`;
      return res.status(200).json({ ok: true });
    }

    res.status(405).json({ error: 'method' });
  } catch (e) {
    res.status(500).json({ error: 'server', detail: String(e && e.message || e) });
  }
};
