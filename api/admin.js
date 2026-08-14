// /api/admin  (solo el email admin)
//   GET                      -> todos los pedidos con datos del cliente
//   POST  { id, status }     -> cambia el estado de un pedido
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
      const { id, status } = req.body || {};
      if (!id || !ALLOWED.includes(status)) return res.status(400).json({ error: 'Datos inválidos' });
      await sql`UPDATE orders SET status = ${status} WHERE id = ${id}`;
      return res.status(200).json({ ok: true });
    }

    res.status(405).json({ error: 'method' });
  } catch (e) {
    res.status(500).json({ error: 'server', detail: String(e && e.message || e) });
  }
};
