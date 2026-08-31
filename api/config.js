// Expone al front lo que no es secreto: el Client ID de Google y, si hay una
// campaña de cupones corriendo, sus condiciones (para poder mostrar el cartel).
const { PROMO, promoActiva } = require('./_promo');

module.exports = (req, res) => {
  res.setHeader('Cache-Control', 'public, max-age=60');
  res.status(200).json({
    googleClientId: process.env.GOOGLE_CLIENT_ID || '',
    promo: promoActiva()
      ? { monto: PROMO.monto, minimo: PROMO.minimo, vence: PROMO.vence }
      : null,
  });
};
