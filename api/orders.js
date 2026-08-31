// /api/orders
//   POST  { items:[{sku,name,color,qty,price}], ship:{...}, faltante }
//         -> guarda los datos de envío en el usuario y crea el pedido
//   GET   -> lista los pedidos del usuario, con lo que lleva cobrado
const { sql, ensureTables, usdRate } = require('./_db');
const { getSession } = require('./_auth');
const { notifyOrder } = require('./_notify');
const { validar } = require('./me');
const { vigente, descuentoDe, tomar, asociar, devolver } = require('./_promo');

module.exports = async (req, res) => {
  const s = getSession(req);
  if (!s) return res.status(401).json({ error: 'Necesitás iniciar sesión' });
  try {
    await ensureTables();

    if (req.method === 'POST') {
      const body = req.body || {};
      const items = Array.isArray(body.items) ? body.items : null;
      if (!items || !items.length) return res.status(400).json({ error: 'Carrito vacío' });

      // Datos de envío: si vienen en el pedido se validan y se guardan en el
      // usuario; si no vienen, se usan los que ya tenía guardados.
      let ship = null;
      if (body.ship) {
        const { errores, datos } = validar(body.ship);
        if (errores.length) return res.status(400).json({ error: errores[0], errores });
        await sql`UPDATE users SET
            dni_cuit = ${datos.dni_cuit}, razon_social = ${datos.razon_social},
            telefono = ${datos.telefono}, direccion = ${JSON.stringify(datos.direccion)}::jsonb,
            faltante = ${datos.faltante},
            faltante_detalle = ${datos.faltante_detalle ? JSON.stringify(datos.faltante_detalle) : null}::jsonb
          WHERE id = ${s.uid}`;
        ship = datos;
      } else {
        const rows = await sql`SELECT dni_cuit, razon_social, telefono, direccion, faltante, faltante_detalle
          FROM users WHERE id = ${s.uid}`;
        const u = rows[0] || {};
        if (!u.razon_social || !u.direccion) {
          return res.status(400).json({ error: 'Faltan los datos de envío', needShip: true });
        }
        ship = u;
      }

      const faltante = ['cambiar', 'consultar', 'baja'].includes(body.faltante)
        ? body.faltante : (ship.faltante || 'consultar');

      // Total recalculado en el server (no se confía en el precio del cliente).
      const clean = items.map((it) => ({
        sku: String(it.sku || ''),
        name: String(it.name || ''),
        color: it.color ? String(it.color) : null,
        qty: Math.max(1, parseInt(it.qty, 10) || 1),
        price: Number(it.price) || 0,
      }));
      const subtotal = clean.reduce((acc, it) => acc + it.price * it.qty, 0);

      // Cupón de campaña. El descuento se decide acá, con el precio de la base:
      // lo que mande el navegador no se usa para nada.
      const v = await vigente(s.uid);
      const descuento = descuentoDe(subtotal, v);
      // Se marca gastado ANTES de crear el pedido para que dos pedidos a la vez
      // no puedan usar el mismo cupón. Si el pedido después falla, se devuelve.
      let usado = null;
      if (descuento > 0 && (await tomar(v.id))) usado = v.id;
      const totalFinal = subtotal - (usado ? descuento : 0);

      // Se guarda el dólar del día para que el margen histórico no se mueva.
      let rate = null;
      try { rate = (await usdRate()).valor || null; } catch { rate = null; }

      let order;
      try {
        const rows = await sql`
          INSERT INTO orders (user_id, items, total, descuento, voucher_id, ship, faltante, usd_rate)
          VALUES (${s.uid}, ${JSON.stringify(clean)}::jsonb, ${totalFinal},
                  ${usado ? descuento : 0}, ${usado},
                  ${JSON.stringify({ ...ship, faltante })}::jsonb, ${faltante}, ${rate})
          RETURNING id, total, descuento, status, created_at`;
        order = rows[0];
      } catch (e) {
        if (usado) await devolver(usado).catch(() => {});
        throw e;
      }
      if (usado) await asociar(usado, order.id).catch(() => {});

      await notifyOrder(order, { name: s.name, email: s.email }, clean, { ...ship, faltante });
      return res.status(200).json({ order: { ...order, subtotal } });
    }

    if (req.method === 'GET') {
      const rows = await sql`
        SELECT o.id, o.items, o.total, COALESCE(o.descuento, 0) AS descuento, o.status, o.created_at, o.faltante,
               COALESCE((SELECT sum(monto)::int FROM order_payments p WHERE p.order_id = o.id), 0) AS cobrado
        FROM orders o WHERE o.user_id = ${s.uid} ORDER BY o.id DESC LIMIT 100`;
      return res.status(200).json({ orders: rows });
    }

    res.status(405).json({ error: 'method' });
  } catch (e) {
    res.status(500).json({ error: 'server', detail: String((e && e.message) || e) });
  }
};
