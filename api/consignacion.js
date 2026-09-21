// /api/consignacion — la cuenta de consignación, aparte de la cuenta corriente.
// Todo va por línea (el artículo del proveedor), sin modelos ni colores.
// El proveedor ve lo que dejó y lo que se le pagó (en proveedor.html); las
// ventas son solo de Tomás.
//   GET  ?proveedor=ID  -> stock en mano, entradas, ventas, pagos y lo que se debe
//   POST { agrega:{ fecha, nota, items:[{ articulo, cantidad, precio }] } }  -> entra mercadería
//   POST { venta:{ fecha, email, cliente, nota, items:[{ articulo, cantidad, precio }] } }
//          -> baja el stock y queda debiéndose; con mail, le crea el pedido al cliente
//          + descuento: $            -> se resta del total
//          + cobros:[{ monto, medio }] -> lo que ya pagó, uno por medio (quedan como cobros del pedido)
//          + mandarMail:true         -> le llega el detalle por línea (items[].nombre)
//          + forzar:true             -> la guarda aunque venda más de lo que hay en mano
//   POST { paga:{ fecha, monto, nota } }  -> le pago esa plata a cuenta: no se
//          dice de qué ventas es, se va descontando de la más vieja a la más
//          nueva y lo que sobre queda a favor para las que vengan
//   POST { borrarVenta: id } / { borrarEntrada: id } / { borrarPago: id }
// Giras (de todos los proveedores juntos):
//   POST { gira:{ id?, nombre, desde, hasta, nota } }  -> crea o cambia; engancha las ventas sueltas de esas fechas
//   POST { giraVentas:{ id, ventas:[id] } }            -> qué ventas son de esa gira
//   POST { gasto:{ gira_id, fecha, concepto, monto, medio } } / { borrarGasto: id } / { borrarGira: id }
const { sql, ensureTables, norm, usdRate } = require('./_db');
const { getSession } = require('./_auth');
const { notifyVentaCliente } = require('./_notify');

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const MAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const diaValido = (x) => (/^\d{4}-\d{2}-\d{2}$/.test(String(x || '')) ? x : null);
const soloDia = (f) => (f instanceof Date ? f.toISOString().slice(0, 10) : String(f || ''));

// La cuenta de consignación es una sola cuenta corriente: las ventas suman lo
// que se le debe y los pagos restan, sin atarse unos a otros. Para saber qué
// está pagado y qué no, lo que se le fue pagando se aplica a las ventas de la
// más vieja a la más nueva. Así un pago puede no cerrar justo (deja una venta
// a medias) o pasarse (queda plata a favor para las que vengan).
function repartir(ventas, pagos) {
  const EPS = 0.005;
  const orden = (a, b) => (soloDia(a.fecha) < soloDia(b.fecha) ? -1
    : soloDia(a.fecha) > soloDia(b.fecha) ? 1 : a.id - b.id);
  const cola = [...pagos].sort(orden).map((p) => ({ id: p.id, fecha: p.fecha, resta: r2(p.monto), cubre: 0 }));
  const estado = new Map();
  let i = 0;
  for (const v of [...ventas].sort(orden)) {
    const costo = r2(v.costo);
    let pagado = 0;
    let ultimo = null;
    while (pagado < costo - EPS && i < cola.length) {
      const p = cola[i];
      if (p.resta <= EPS) { i += 1; continue; }
      const usa = Math.min(p.resta, r2(costo - pagado));
      p.resta = r2(p.resta - usa);
      pagado = r2(pagado + usa);
      ultimo = p;
    }
    const saldada = pagado >= costo - EPS;
    if (saldada && ultimo) ultimo.cubre += 1;
    estado.set(v.id, {
      pagado,
      resta: saldada ? 0 : r2(costo - pagado),
      pagada_at: saldada && ultimo ? ultimo.fecha : null,
      pago_id: saldada && ultimo ? ultimo.id : null,
    });
  }
  return { estado, aFavor: r2(cola.reduce((a, p) => a + Math.max(0, p.resta), 0)), pagos: cola };
}

module.exports = async (req, res) => {
  const s = getSession(req);
  if (!s || !s.admin) return res.status(403).json({ error: 'Solo el administrador' });
  try {
    await ensureTables();
    const url = new URL(req.url, 'http://x');
    const b = req.body || {};

    const provs = await sql`SELECT id, nombre, moneda FROM suppliers ORDER BY id`;
    if (!provs.length) return res.status(200).json({ proveedores: [], proveedor: null });
    // Sobre qué proveedor: el pedido, o si no el que más mercadería dejó en consignación.
    const pid = parseInt(req.method === 'GET' ? url.searchParams.get('proveedor') : b.supplier_id, 10);
    let prov = provs.find((p) => p.id === pid);
    if (!prov) {
      const [c] = await sql`SELECT supplier_id FROM supplier_consign
        GROUP BY supplier_id HAVING sum(cantidad) > 0 ORDER BY sum(cantidad) DESC LIMIT 1`;
      prov = (c && provs.find((p) => p.id === c.supplier_id)) || provs[0];
    }
    prov = { ...prov, moneda: prov.moneda || 'USD' };

    if (req.method === 'GET') {
      const [consign, precios, ventas, entradas, pagos, clientes, usd, mapa, giras, ventasGira] = await Promise.all([
        sql`SELECT articulo, cantidad, sale_id FROM supplier_consign WHERE supplier_id = ${prov.id}`,
        sql`SELECT articulo, precio FROM supplier_prices WHERE supplier_id = ${prov.id} AND activo ORDER BY articulo`,
        sql`SELECT v.id, v.fecha, v.email, v.cliente, v.items, v.total_venta, v.costo, v.order_id,
                   v.nota, v.gira_id, u.name, u.razon_social,
                   COALESCE((SELECT sum(p.monto)::int FROM order_payments p WHERE p.order_id = v.order_id), 0) AS cobrado
              FROM consign_sales v LEFT JOIN users u ON u.id = v.user_id
             WHERE v.supplier_id = ${prov.id}
             ORDER BY v.fecha DESC, v.id DESC`,
        // Lo que entró y salió que no es una venta: lo que dejó, devoluciones, etc.
        sql`SELECT id, fecha, articulo, cantidad, precio, nota, created_at FROM supplier_consign
             WHERE supplier_id = ${prov.id} AND sale_id IS NULL
             ORDER BY fecha DESC, id DESC LIMIT 100`,
        sql`SELECT id, fecha, monto, nota FROM consign_payments
             WHERE supplier_id = ${prov.id} ORDER BY fecha DESC, id DESC`,
        sql`SELECT email, COALESCE(razon_social, name) AS nombre FROM users ORDER BY created_at DESC LIMIT 1000`,
        usdRate(),
        // Qué línea de la web es cada artículo: con esto la página saca el
        // precio de venta de la tienda, en vez de pedirlo a mano.
        sql`SELECT patron, articulo, factor FROM cost_map
             WHERE (supplier_id = ${prov.id} OR supplier_id IS NULL) AND NOT COALESCE(ignorar, false)`,
        sql`SELECT g.id, g.nombre, g.desde, g.hasta, g.nota,
                   COALESCE((SELECT json_agg(json_build_object('id', x.id, 'fecha', x.fecha, 'concepto', x.concepto,
                                                               'monto', x.monto, 'medio', x.medio) ORDER BY x.fecha, x.id)
                             FROM gira_gastos x WHERE x.gira_id = g.id), '[]'::json) AS gastos
              FROM giras g ORDER BY g.desde DESC, g.id DESC`,
        // Las ventas que pueden entrar en una gira, de cualquier proveedor: las
        // que ya son de una y las sueltas desde la primera gira. Con lo que pagó
        // el cliente y con qué (del pedido, o de la venta misma si no tiene).
        sql`SELECT v.id, v.supplier_id, v.fecha, v.email, v.cliente, v.items, v.total_venta, v.costo,
                   v.order_id, v.gira_id, s.nombre AS proveedor, COALESCE(s.moneda, 'USD') AS moneda,
                   u.name, u.razon_social,
                   COALESCE(o.descuento, 0) AS descuento,
                   CASE WHEN v.order_id IS NULL THEN COALESCE(v.cobros, '[]'::jsonb)
                        ELSE COALESCE((SELECT jsonb_agg(jsonb_build_object('monto', p.monto, 'medio', p.medio) ORDER BY p.id)
                                       FROM order_payments p WHERE p.order_id = v.order_id), '[]'::jsonb) END AS cobros
              FROM consign_sales v
              JOIN suppliers s ON s.id = v.supplier_id
              LEFT JOIN users u ON u.id = v.user_id
              LEFT JOIN orders o ON o.id = v.order_id
             WHERE v.gira_id IS NOT NULL OR v.fecha >= (SELECT min(desde) FROM giras)
             ORDER BY v.fecha, v.id`,
      ]);

      const precioDe = (art) => {
        const p = precios.find((x) => x.articulo.toUpperCase() === String(art).toUpperCase());
        return p ? Number(p.precio) : 0;
      };
      // En mano = todo lo que dejó menos lo devuelto y lo vendido. Va también
      // el desglose, para que un número raro (un negativo) se vea de dónde sale.
      const m = new Map();
      consign.forEach((c) => {
        const k = c.articulo.toUpperCase();
        const a = m.get(k) || { articulo: c.articulo, en_mano: 0, dejo: 0, devolvio: 0, vendio: 0 };
        a.en_mano += c.cantidad;
        if (c.sale_id) a.vendio -= c.cantidad;
        else if (c.cantidad > 0) a.dejo += c.cantidad;
        else a.devolvio -= c.cantidad;
        m.set(k, a);
      });
      const stock = [...m.values()]
        .filter((a) => a.en_mano)
        .map((a) => ({ ...a, precio: precioDe(a.articulo) }))
        .sort((x, y) => x.articulo.localeCompare(y.articulo));

      const unidades = (v) => (v.items || []).reduce((a, it) => a + (Number(it.cantidad) || 0), 0);
      const crudas = ventas.map((v) => ({ ...v, costo: Number(v.costo) }));
      const crudosPagos = pagos.map((p) => ({ ...p, monto: Number(p.monto) }));
      // Qué venta está tachada y cuál no sale de acá: de lo que se le pagó en
      // total, aplicado de la más vieja a la más nueva.
      const rep = repartir(crudas, crudosPagos);
      const lista = crudas.map((v) => ({ ...v, ...rep.estado.get(v.id) }));
      const listaPagos = crudosPagos.map((p) => {
        const x = rep.pagos.find((q) => q.id === p.id) || { cubre: 0, resta: 0 };
        return { ...p, cubre: x.cubre, a_cuenta: r2(Math.max(0, x.resta)) };
      });
      const debiendo = lista.filter((v) => v.resta > 0);
      const resumen = {
        vendido_u: lista.reduce((a, v) => a + unidades(v), 0),
        por_cobrar: lista.filter((v) => v.order_id)
          .reduce((a, v) => a + Math.max(0, v.total_venta - v.cobrado), 0),
        debo: r2(debiendo.reduce((a, v) => a + v.resta, 0)),
        u_debo: debiendo.reduce((a, v) => a + unidades(v), 0),
        ventas_impagas: debiendo.length,
        pagado: r2(crudosPagos.reduce((a, p) => a + p.monto, 0)),
        // Lo que se le pagó de más: se descuenta solo de las próximas ventas.
        a_favor: rep.aFavor,
        costo_total: r2(crudas.reduce((a, v) => a + v.costo, 0)),
      };

      return res.status(200).json({
        proveedores: provs, proveedor: prov, stock, precios, ventas: lista,
        entradas: entradas.map((e) => ({ ...e, precio: Number(e.precio) })),
        pagos: listaPagos, clientes, resumen, usd, mapa,
        giras, ventasGira: ventasGira.map((v) => ({ ...v, costo: Number(v.costo) })),
      });
    }

    if (req.method !== 'POST') return res.status(405).json({ error: 'method' });

    const precios = await sql`SELECT articulo, precio FROM supplier_prices WHERE supplier_id = ${prov.id}`;
    const costoDe = (art) => {
      const p = precios.find((x) => x.articulo.toUpperCase() === String(art).toUpperCase());
      return p ? Number(p.precio) : 0;
    };

    /* ----- Me dejó mercadería ----- */
    if (b.agrega) {
      const dia = diaValido(b.agrega.fecha);
      const nota = b.agrega.nota ? String(b.agrega.nota).trim().slice(0, 200) || null : null;
      const items = (Array.isArray(b.agrega.items) ? b.agrega.items : []).map((it) => {
        const articulo = String(it.articulo || '').trim().slice(0, 80);
        const precio = r2(it.precio);
        return { articulo, cantidad: parseInt(it.cantidad, 10) || 0, precio: precio > 0 ? precio : costoDe(articulo) };
      }).filter((it) => it.articulo && it.cantidad > 0);
      if (!items.length) return res.status(400).json({ error: 'Cargá al menos una línea con cantidad' });

      for (const it of items) {
        await sql`INSERT INTO supplier_consign (supplier_id, fecha, articulo, cantidad, precio_usd, precio, nota)
          VALUES (${prov.id}, COALESCE(${dia}::date, CURRENT_DATE), ${it.articulo}, ${it.cantidad},
                  ${it.precio}, ${it.precio}, ${nota})`;
        // Una línea nueva entra también a la lista de precios, para que la
        // venta sepa cuánto se le debe. Si ya tenía precio, no se toca.
        if (it.precio > 0) {
          await sql`INSERT INTO supplier_prices (supplier_id, articulo, precio_usd, precio, activo)
            VALUES (${prov.id}, ${it.articulo}, ${it.precio}, ${it.precio}, true)
            ON CONFLICT (supplier_id, upper(articulo)) DO NOTHING`;
        }
      }
      return res.status(200).json({ ok: true });
    }

    /* ----- Registrar una venta ----- */
    if (b.venta) {
      const v = b.venta;
      const email = String(v.email || '').trim().toLowerCase().slice(0, 120);
      // El mail es opcional: sin mail (una venta vieja, un cliente que no se
      // sabe) se registra igual, pero no se le crea el pedido a nadie.
      if (email && !MAIL.test(email)) return res.status(400).json({ error: 'Ese mail no parece válido' });
      const cliente = String(v.cliente || '').trim().slice(0, 120) || null;
      const nota = v.nota ? String(v.nota).trim().slice(0, 200) || null : null;
      const dia = diaValido(v.fecha);

      const items = (Array.isArray(v.items) ? v.items : []).map((it) => {
        const articulo = String(it.articulo || '').trim().slice(0, 80);
        return {
          articulo,
          nombre: String(it.nombre || '').trim().slice(0, 80) || articulo,   // cómo lo ve el cliente
          cantidad: parseInt(it.cantidad, 10) || 0,
          precio: Math.max(0, Math.round(Number(it.precio) || 0)),   // venta, en pesos
          costo: costoDe(articulo),                                  // lo que se le debe al proveedor
        };
      }).filter((it) => it.articulo && it.cantidad > 0);
      if (!items.length) return res.status(400).json({ error: 'Cargá al menos una línea con cantidad' });
      const subtotal = items.reduce((a, it) => a + it.precio * it.cantidad, 0);
      // Descuento en pesos sobre el total (la página lo pasa ya calculado si fue un %).
      const descuento = Math.min(subtotal, Math.max(0, Math.round(Number(v.descuento) || 0)));
      const totalVenta = subtotal - descuento;
      const costo = r2(items.reduce((a, it) => a + it.costo * it.cantidad, 0));

      // No se vende lo que no está en mano sin avisar: así fue como el Clipon
      // Runflex quedó en negativo (se vendía una línea que nunca se cargó como
      // entrada). Si de verdad se quiere guardar igual, la página manda forzar.
      if (!v.forzar) {
        const enMano = await sql`SELECT upper(articulo) AS k, sum(cantidad)::int AS n FROM supplier_consign
          WHERE supplier_id = ${prov.id} GROUP BY upper(articulo)`;
        const pide = new Map();
        items.forEach((it) => pide.set(it.articulo.toUpperCase(),
          { articulo: it.articulo, cantidad: (pide.get(it.articulo.toUpperCase()) || { cantidad: 0 }).cantidad + it.cantidad }));
        const faltan = [...pide.entries()].map(([k, p]) => {
          const hay = (enMano.find((x) => x.k === k) || { n: 0 }).n;
          return { articulo: p.articulo, en_mano: hay, pide: p.cantidad };
        }).filter((f) => f.pide > f.en_mano);
        if (faltan.length) {
          return res.status(409).json({
            error: 'No te alcanza el stock de ' + faltan.map((f) => `${f.articulo} (tenés ${f.en_mano}, vendés ${f.pide})`).join(', '),
            faltan,
          });
        }
      }

      // Lo que ya pagó (todo o una parte, con uno o más medios). Lo que pase
      // del total se recorta.
      const cobrosIn = Array.isArray(v.cobros) ? v.cobros : v.cobro ? [v.cobro] : [];
      const pagos = [];
      let cobrado = 0;
      for (const c of cobrosIn) {
        const monto = Math.min(totalVenta - cobrado, Math.max(0, Math.round(Number(c && c.monto) || 0)));
        if (monto <= 0) continue;
        pagos.push({ monto, medio: c.medio ? String(c.medio).slice(0, 40) : null });
        cobrado += monto;
      }

      // El cliente: si todavía no tiene cuenta se le crea una con ese mail, que
      // se engancha sola la primera vez que entre con Google (api/auth.js).
      let u = null;
      if (email) {
        [u] = await sql`SELECT id, dni_cuit, razon_social, telefono, direccion, faltante, faltante_detalle
          FROM users WHERE lower(email) = ${email} ORDER BY id LIMIT 1`;
        if (!u) {
          [u] = await sql`INSERT INTO users (google_sub, email, name, razon_social)
            VALUES (${'pendiente:' + email}, ${email}, ${cliente}, ${cliente})
            RETURNING id, dni_cuit, razon_social, telefono, direccion, faltante, faltante_detalle`;
        } else if (cliente && !u.razon_social) {
          await sql`UPDATE users SET razon_social = ${cliente} WHERE id = ${u.id}`;
          u.razon_social = cliente;
        }
      }
      const quien = cliente || (u && u.razon_social) || email || 'sin cliente';

      // La deuda queda en la venta misma (cuenta de consignación): no toca la
      // cuenta corriente del proveedor. Entra sola a la gira de esas fechas.
      // Sin pedido (no hay mail), lo que pagó queda en la venta.
      const [venta] = await sql`
        INSERT INTO consign_sales (supplier_id, fecha, user_id, email, cliente, items, total_venta, costo, nota, cobros, gira_id)
        VALUES (${prov.id}, COALESCE(${dia}::date, CURRENT_DATE), ${u ? u.id : null}, ${email || null}, ${cliente},
                ${JSON.stringify(items)}::jsonb, ${totalVenta}, ${costo}, ${nota},
                ${u || !pagos.length ? null : JSON.stringify(pagos)}::jsonb,
                (SELECT g.id FROM giras g
                  WHERE g.desde <= COALESCE(${dia}::date, CURRENT_DATE)
                    AND (g.hasta IS NULL OR g.hasta >= COALESCE(${dia}::date, CURRENT_DATE))
                  ORDER BY g.desde DESC, g.id DESC LIMIT 1))
        RETURNING id, fecha, gira_id`;

      // Baja el stock. El proveedor no ve estas líneas (van con sale_id).
      for (const it of items) {
        await sql`INSERT INTO supplier_consign (supplier_id, fecha, articulo, cantidad, precio_usd, precio, nota, privado, sale_id)
          VALUES (${prov.id}, ${venta.fecha}, ${it.articulo}, ${-it.cantidad}, ${it.costo}, ${it.costo},
                  ${'Vendido a ' + quien}, true, ${venta.id})`;
      }

      // Para que el panel de Pedidos calcule la ganancia, cada línea tiene que
      // estar mapeada a su artículo. Si ya había un mapeo con ese nombre, se respeta.
      for (const it of items) {
        await sql`INSERT INTO cost_map (patron, articulo, factor, supplier_id)
          VALUES (${norm(it.articulo)}, ${it.articulo}, 1, ${prov.id})
          ON CONFLICT (patron) DO NOTHING`;
      }

      if (!u) return res.status(200).json({ ok: true, id: venta.id, order_id: null, cobrado, gira_id: venta.gira_id });

      // El pedido del cliente: lo ve en "Mis pedidos" y en Pedidos queda para
      // cobrar. Ya está entregado, así que no pasa por "Pasar a Martín".
      let rate = null;
      try { rate = (await usdRate()).valor || null; } catch { rate = null; }
      const ship = {
        dni_cuit: u.dni_cuit, razon_social: u.razon_social, telefono: u.telefono,
        direccion: u.direccion, faltante: u.faltante || 'consultar', faltante_detalle: u.faltante_detalle,
      };
      const [o] = await sql`
        INSERT INTO orders (user_id, items, total, descuento, ship, faltante, usd_rate, nota,
                            etapa, status, created_at)
        VALUES (${u.id},
                ${JSON.stringify(items.map((it) => ({ sku: '', name: it.articulo, color: null, qty: it.cantidad, price: it.precio })))}::jsonb,
                ${totalVenta}, ${descuento}, ${JSON.stringify(ship)}::jsonb, ${ship.faltante}, ${rate},
                ${'Venta de consignación' + (nota ? ': ' + nota : '')},
                'despachado', 'enviado',
                COALESCE((${dia}::date + interval '15 hours')::timestamptz, now()))
        RETURNING id`;
      await sql`UPDATE consign_sales SET order_id = ${o.id} WHERE id = ${venta.id}`;

      // Con pedido, cada pago queda como un cobro del pedido.
      for (const p of pagos) {
        await sql`INSERT INTO order_payments (order_id, fecha, monto, medio, nota)
          VALUES (${o.id}, COALESCE(${dia}::date, CURRENT_DATE), ${p.monto}, ${p.medio}, 'Venta de consignación')`;
      }

      let mail = false;
      if (v.mandarMail) {
        mail = await notifyVentaCliente({
          email, cliente, orderId: o.id, total: totalVenta, subtotal, descuento, cobrado, pagos,
          items: items.map((it) => ({ nombre: it.nombre, cantidad: it.cantidad, precio: it.precio })),
        });
      }

      return res.status(200).json({ ok: true, id: venta.id, order_id: o.id, cobrado, mail, gira_id: venta.gira_id });
    }

    /* ----- Le pagué plata de la consignación ----- */
    // Va a la cuenta de consignación: el proveedor lo ve como pago de
    // consignación, sin saber de qué ventas. La cuenta corriente no se toca.
    // No hace falta que cierre justo con unas ventas: se anota cuánto fue y la
    // cuenta se ordena sola (ver repartir).
    if (b.paga) {
      const dia = diaValido(b.paga.fecha);
      const nota = b.paga.nota ? String(b.paga.nota).trim().slice(0, 200) || null : null;
      let monto = r2(b.paga.monto);
      // Una pantalla vieja (o una pestaña que quedó abierta) manda las ventas
      // marcadas: se toma lo que suman y se registra igual, como pago a cuenta.
      if (!(monto > 0) && Array.isArray(b.paga.ventas) && b.paga.ventas.length) {
        const ids = b.paga.ventas.map((x) => parseInt(x, 10)).filter(Boolean);
        const elegidas = await sql`SELECT costo FROM consign_sales
          WHERE supplier_id = ${prov.id} AND id = ANY(${ids}::int[])`;
        monto = r2(elegidas.reduce((a, v) => a + Number(v.costo), 0));
      }
      if (!(monto > 0)) return res.status(400).json({ error: 'Poné cuánto le pagaste' });

      const [pago] = await sql`
        INSERT INTO consign_payments (supplier_id, fecha, monto, nota)
        VALUES (${prov.id}, COALESCE(${dia}::date, CURRENT_DATE), ${monto}, ${nota})
        RETURNING id`;

      // Cómo quedó la cuenta con este pago, para avisarlo en la pantalla.
      const [lasVentas, losPagos] = await Promise.all([
        sql`SELECT id, fecha, costo FROM consign_sales WHERE supplier_id = ${prov.id}`,
        sql`SELECT id, fecha, monto FROM consign_payments WHERE supplier_id = ${prov.id}`,
      ]);
      const rep = repartir(
        lasVentas.map((v) => ({ ...v, costo: Number(v.costo) })),
        losPagos.map((p) => ({ ...p, monto: Number(p.monto) })),
      );
      const cubre = (rep.pagos.find((p) => p.id === pago.id) || { cubre: 0 }).cubre;
      const debo = r2([...rep.estado.values()].reduce((a, e) => a + e.resta, 0));
      return res.status(200).json({ ok: true, id: pago.id, monto, cubre, debo, a_favor: rep.aFavor });
    }

    /* ----- Borrar un pago: la cuenta se rearma sola ----- */
    if (b.borrarPago) {
      const id = parseInt(b.borrarPago, 10);
      const [row] = await sql`DELETE FROM consign_payments WHERE id = ${id} AND supplier_id = ${prov.id} RETURNING id`;
      if (!row) return res.status(404).json({ error: 'No existe ese pago' });
      // No hay nada que deshacer en las ventas: se tachan según lo que se le
      // pagó en total, así que sin este pago las últimas vuelven a deberse.
      return res.status(200).json({ ok: true });
    }

    /* ----- Borrar una venta: se deshace todo lo que generó ----- */
    if (b.borrarVenta) {
      const id = parseInt(b.borrarVenta, 10);
      const [v] = await sql`SELECT id, order_id FROM consign_sales WHERE id = ${id} AND supplier_id = ${prov.id}`;
      if (!v) return res.status(404).json({ error: 'No existe esa venta' });
      // Aunque ya estuviera tachada se puede borrar: los pagos son a cuenta,
      // así que lo que cubría esta venta pasa a la siguiente sin pagar.
      await sql`DELETE FROM supplier_consign WHERE sale_id = ${id}`;
      if (v.order_id) {
        await sql`DELETE FROM order_payments WHERE order_id = ${v.order_id}`;
        await sql`DELETE FROM orders WHERE id = ${v.order_id}`;
      }
      await sql`DELETE FROM consign_sales WHERE id = ${id}`;
      return res.status(200).json({ ok: true });
    }

    /* ----- Borrar una entrada de mercadería ----- */
    if (b.borrarEntrada) {
      const [row] = await sql`DELETE FROM supplier_consign
        WHERE id = ${parseInt(b.borrarEntrada, 10)} AND supplier_id = ${prov.id} AND sale_id IS NULL
        RETURNING id`;
      if (!row) return res.status(404).json({ error: 'No existe esa entrada' });
      return res.status(200).json({ ok: true });
    }

    /* ----- Giras ----- */
    // Crear o cambiar una gira. Las ventas sueltas (sin gira) de esas fechas
    // entran solas; las que ya eran de otra gira no se tocan.
    if (b.gira) {
      const g = b.gira;
      const nombre = String(g.nombre || '').trim().slice(0, 80);
      const desde = diaValido(g.desde);
      const hasta = diaValido(g.hasta);
      const nota = g.nota ? String(g.nota).trim().slice(0, 200) || null : null;
      if (!nombre) return res.status(400).json({ error: 'Ponele un nombre a la gira' });
      if (!desde) return res.status(400).json({ error: 'Falta desde cuándo' });
      if (hasta && hasta < desde) return res.status(400).json({ error: 'La gira termina antes de empezar' });
      let id = parseInt(g.id, 10) || null;
      if (id) {
        const [row] = await sql`UPDATE giras SET nombre = ${nombre}, desde = ${desde}, hasta = ${hasta}, nota = ${nota}
          WHERE id = ${id} RETURNING id`;
        if (!row) return res.status(404).json({ error: 'No existe esa gira' });
      } else {
        [{ id }] = await sql`INSERT INTO giras (nombre, desde, hasta, nota)
          VALUES (${nombre}, ${desde}, ${hasta}, ${nota}) RETURNING id`;
      }
      const sumadas = await sql`UPDATE consign_sales SET gira_id = ${id}
        WHERE gira_id IS NULL AND fecha >= ${desde}::date AND (${hasta}::date IS NULL OR fecha <= ${hasta}::date)
        RETURNING id`;
      return res.status(200).json({ ok: true, id, sumadas: sumadas.length });
    }

    // Qué ventas son de la gira: las marcadas entran, las que estaban y no, salen.
    if (b.giraVentas) {
      const id = parseInt(b.giraVentas.id, 10);
      const ids = (Array.isArray(b.giraVentas.ventas) ? b.giraVentas.ventas : []).map((x) => parseInt(x, 10)).filter(Boolean);
      const [g] = await sql`SELECT id FROM giras WHERE id = ${id}`;
      if (!g) return res.status(404).json({ error: 'No existe esa gira' });
      await sql`UPDATE consign_sales SET gira_id = NULL WHERE gira_id = ${id} AND NOT (id = ANY(${ids}::int[]))`;
      if (ids.length) await sql`UPDATE consign_sales SET gira_id = ${id} WHERE id = ANY(${ids}::int[])`;
      return res.status(200).json({ ok: true });
    }

    if (b.borrarGira) {
      const id = parseInt(b.borrarGira, 10);
      await sql`UPDATE consign_sales SET gira_id = NULL WHERE gira_id = ${id}`;
      const [row] = await sql`DELETE FROM giras WHERE id = ${id} RETURNING id`;
      if (!row) return res.status(404).json({ error: 'No existe esa gira' });
      return res.status(200).json({ ok: true });
    }

    // Un gasto del viaje (nafta, hotel, comida…), en pesos.
    if (b.gasto) {
      const x = b.gasto;
      const giraId = parseInt(x.gira_id, 10);
      const concepto = String(x.concepto || '').trim().slice(0, 80);
      const monto = Math.round(Number(x.monto) || 0);
      const medio = x.medio ? String(x.medio).slice(0, 40) : null;
      if (!concepto) return res.status(400).json({ error: '¿En qué fue el gasto?' });
      if (monto <= 0) return res.status(400).json({ error: 'Poné el monto' });
      const [g] = await sql`SELECT id FROM giras WHERE id = ${giraId}`;
      if (!g) return res.status(404).json({ error: 'No existe esa gira' });
      await sql`INSERT INTO gira_gastos (gira_id, fecha, concepto, monto, medio)
        VALUES (${giraId}, COALESCE(${diaValido(x.fecha)}::date, CURRENT_DATE), ${concepto}, ${monto}, ${medio})`;
      return res.status(200).json({ ok: true });
    }

    if (b.borrarGasto) {
      const [row] = await sql`DELETE FROM gira_gastos WHERE id = ${parseInt(b.borrarGasto, 10)} RETURNING id`;
      if (!row) return res.status(404).json({ error: 'No existe ese gasto' });
      return res.status(200).json({ ok: true });
    }

    return res.status(400).json({ error: 'Datos inválidos' });
  } catch (e) {
    res.status(500).json({ error: 'server', detail: String((e && e.message) || e) });
  }
};
