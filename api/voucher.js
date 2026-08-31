// GET /api/voucher -> el cupón que el usuario logueado puede usar ahora.
// Lo usa el carrito para mostrar el descuento antes de confirmar el pedido.
// Si el usuario todavía no lo tiene y la campaña sigue viva, se lo entrega acá
// también (por si inició sesión antes de que arrancara la promo).
const { ensureTables } = require('./_db');
const { getSession } = require('./_auth');
const { otorgar, vigente, descuentoDe, PROMO, promoActiva } = require('./_promo');

module.exports = async (req, res) => {
  const s = getSession(req);
  if (!s) return res.status(401).json({ error: 'Necesitás iniciar sesión' });
  try {
    await ensureTables();
    let v = await vigente(s.uid);
    if (!v && promoActiva()) v = await otorgar(s.uid);

    const subtotal = Math.max(0, parseInt(req.query && req.query.subtotal, 10) || 0);
    res.status(200).json({
      voucher: v,
      descuento: descuentoDe(subtotal, v),
      promo: promoActiva() ? { monto: PROMO.monto, minimo: PROMO.minimo, vence: PROMO.vence } : null,
    });
  } catch (e) {
    res.status(500).json({ error: 'server', detail: String((e && e.message) || e) });
  }
};
