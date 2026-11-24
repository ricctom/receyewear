// Precios de la web según el dólar (ver api/_dolar.js).
// Los precios escritos en index.html son los "de base". /api/config?js=1 deja
// en window.REC_DOLAR el factor (dólar publicado / dólar base) y acá se
// multiplican, redondeados a números redondos:
//   - hasta $50.000, de a $500   (15.600 × 1,06 = 16.536 → 16.500)
//   - más de $50.000, de a $1.000
// Con factor 1 los precios quedan exactamente como están escritos.
// El precio tachado se rehace para que el "% OFF" siga diciendo lo mismo.
(function () {
  function redondo(n) {
    var paso = n > 50000 ? 1000 : 500;
    return Math.max(paso, Math.round(n / paso) * paso);
  }
  function precioConDolar(base, factor) {
    var f = Number(factor);
    if (!(f > 0) || Math.abs(f - 1) < 1e-6) return Number(base);
    return redondo(Number(base) * f);
  }
  // Cambia los precios de la lista en el lugar (guarda los de base la primera vez).
  function aplicarDolar(lista, factor) {
    (lista || []).forEach(function (p) {
      if (!p._base) p._base = { price: Number(p.price), oldPrice: p.oldPrice };
      p.price = precioConDolar(p._base.price, factor);
      var old = p._base.oldPrice;
      if (old && p.price !== p._base.price) {
        p.oldPrice = p.discount > 0 && p.discount < 100
          ? Math.round(p.price / (1 - p.discount / 100))
          : Math.round(Number(old) * Number(factor));
      } else p.oldPrice = old;
    });
    return lista;
  }
  window.precioConDolar = precioConDolar;
  window.aplicarDolar = aplicarDolar;
})();
