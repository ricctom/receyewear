// /api/consignacion — la mercadería que el proveedor deja en consignación.
// Todo va por línea (el artículo del proveedor), sin modelos ni colores.
//   GET  ?proveedor=ID  -> stock en mano, entradas, ventas y lo que se debe
//   POST { agrega:{ fecha, nota, items:[{ articulo, cantidad, precio }] } }
//          -> entra mercadería (el proveedor lo ve: es lo que él dejó)
//   POST { venta:{ fecha, email, cliente, nota, items:[{ articulo, cantidad, precio }] } }
//          -> baja el stock, suma a la deuda (privado) y, con mail, le crea el pedido al cliente
//   POST { paga:{ fecha, nota, ventas:[id] } }
//          -> le pago esas ventas: pasan a verse en su cuenta junto con el pago
//   POST { rendir: id | 'todas' }  -> que las vea sin pagarlas todavía
//   POST { borrarVenta: id } / { borrarEntrada: id }
const { sql, ensureTables, norm, usdRate } = require('./_db');
const { getSession } = require('./_auth');

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const MAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const diaValido = (x) => (/^\d{4}-\d{2}-\d{2}$/.test(String(x || '')) ? x : null);

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
      const [consign, precios, ventas, entradas, clientes, usd] = await Promise.all([
        sql`SELECT articulo, cantidad, privado FROM supplier_consign WHERE supplier_id = ${prov.id}`,
        sql`SELECT articulo, precio FROM supplier_prices WHERE supplier_id = ${prov.id} AND activo ORDER BY articulo`,
        sql`SELECT v.id, v.fecha, v.email, v.cliente, v.items, v.total_venta, v.costo, v.order_id,
                   v.rendida_at, v.pagada_at, v.nota, u.name, u.razon_social,
                   COALESCE((SELECT sum(p.monto)::int FROM order_payments p WHERE p.order_id = v.order_id), 0) AS cobrado
              FROM consign_sales v LEFT JOIN users u ON u.id = v.user_id
             WHERE v.supplier_id = ${prov.id}
             ORDER BY v.fecha DESC, v.id DESC`,
        // Lo que entró y salió que no es una venta: lo que dejó, devoluciones, etc.
        sql`SELECT id, fecha, articulo, cantidad, precio, nota FROM supplier_consign
             WHERE supplier_id = ${prov.id} AND sale_id IS NULL
             ORDER BY fecha DESC, id DESC LIMIT 100`,
        sql`SELECT email, COALESCE(razon_social, name) AS nombre FROM users ORDER BY created_at DESC LIMIT 1000`,
        usdRate(),
      ]);

      const precioDe = (art) => {
        const p = precios.find((x) => x.articulo.toUpperCase() === String(art).toUpperCase());
        return p ? Number(p.precio) : 0;
      };
      // En mano = todo lo que dejó menos lo devuelto, pagado y vendido.
      const m = new Map();
      consign.forEach((c) => {
        const k = c.articulo.toUpperCase();
        const a = m.get(k) || { articulo: c.articulo, en_mano: 0, sin_rendir: 0 };
        a.en_mano += c.cantidad;
        if (c.privado) a.sin_rendir -= c.cantidad;
        m.set(k, a);
      });
      const stock = [...m.values()]
        .filter((a) => a.en_mano || a.sin_rendir)
        .map((a) => ({ ...a, precio: precioDe(a.articulo) }))
        .sort((x, y) => x.articulo.localeCompare(y.articulo));

      const lista = ventas.map((v) => ({ ...v, costo: Number(v.costo) }));
      const unidades = (v) => (v.items || []).reduce((a, it) => a + (Number(it.cantidad) || 0), 0);
      const impagas = lista.filter((v) => !v.pagada_at);
      const resumen = {
        en_mano: stock.reduce((a, x) => a + x.en_mano, 0),
        vendido_u: lista.reduce((a, v) => a + unidades(v), 0),
        vendido_venta: lista.reduce((a, v) => a + v.total_venta, 0),
        por_cobrar: lista.filter((v) => v.order_id)
          .reduce((a, v) => a + Math.max(0, v.total_venta - v.cobrado), 0),
        debo: r2(impagas.reduce((a, v) => a + v.costo, 0)),
        u_debo: impagas.reduce((a, v) => a + unidades(v), 0),
        ventas_impagas: impagas.length,
        ventas_sin_rendir: lista.filter((v) => !v.rendida_at).length,
      };

      return res.status(200).json({
        proveedores: provs, proveedor: prov, stock, precios, ventas: lista,
        entradas: entradas.map((e) => ({ ...e, precio: Number(e.precio) })),
        clientes, resumen, usd,
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
          cantidad: parseInt(it.cantidad, 10) || 0,
          precio: Math.max(0, Math.round(Number(it.precio) || 0)),   // venta, en pesos
          costo: costoDe(articulo),                                  // lo que se le debe al proveedor
        };
      }).filter((it) => it.articulo && it.cantidad > 0);
      if (!items.length) return res.status(400).json({ error: 'Cargá al menos una línea con cantidad' });
      const totalVenta = items.reduce((a, it) => a + it.precio * it.cantidad, 0);
      const costo = r2(items.reduce((a, it) => a + it.costo * it.cantidad, 0));

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

      const [venta] = await sql`
        INSERT INTO consign_sales (supplier_id, fecha, user_id, email, cliente, items, total_venta, costo, nota)
        VALUES (${prov.id}, COALESCE(${dia}::date, CURRENT_DATE), ${u ? u.id : null}, ${email || null}, ${cliente},
                ${JSON.stringify(items)}::jsonb, ${totalVenta}, ${costo}, ${nota})
        RETURNING id, fecha`;

      // Baja el stock y sube la deuda, las dos cosas en privado.
      for (const it of items) {
        await sql`INSERT INTO supplier_consign (supplier_id, fecha, articulo, cantidad, precio_usd, precio, nota, privado, sale_id)
          VALUES (${prov.id}, ${venta.fecha}, ${it.articulo}, ${-it.cantidad}, ${it.costo}, ${it.costo},
                  ${'Vendido a ' + quien}, true, ${venta.id})`;
      }
      const [mov] = await sql`
        INSERT INTO supplier_moves (supplier_id, fecha, tipo, monto_usd, monto, detalle, items, privado, sale_id)
        VALUES (${prov.id}, ${venta.fecha}, 'PEDIDO', ${costo}, ${costo}, ${'Consignación vendida a ' + quien},
                ${JSON.stringify(items.map((it) => ({ articulo: it.articulo, cantidad: it.cantidad, precio: it.costo })))}::jsonb,
                true, ${venta.id})
        RETURNING id`;

      // Para que el panel de Pedidos calcule la ganancia, cada línea tiene que
      // estar mapeada a su artículo. Si ya había un mapeo con ese nombre, se respeta.
      for (const it of items) {
        await sql`INSERT INTO cost_map (patron, articulo, factor, supplier_id)
          VALUES (${norm(it.articulo)}, ${it.articulo}, 1, ${prov.id})
          ON CONFLICT (patron) DO NOTHING`;
      }

      if (!u) {
        await sql`UPDATE consign_sales SET move_id = ${mov.id} WHERE id = ${venta.id}`;
        return res.status(200).json({ ok: true, id: venta.id, order_id: null });
      }

      // El pedido del cliente: lo ve en "Mis pedidos" y en Pedidos queda para
      // cobrar. Ya está entregado y ya está cargado a la cuenta del proveedor.
      let rate = null;
      try { rate = (await usdRate()).valor || null; } catch { rate = null; }
      const ship = {
        dni_cuit: u.dni_cuit, razon_social: u.razon_social, telefono: u.telefono,
        direccion: u.direccion, faltante: u.faltante || 'consultar', faltante_detalle: u.faltante_detalle,
      };
      const [o] = await sql`
        INSERT INTO orders (user_id, items, total, descuento, ship, faltante, usd_rate, nota,
                            etapa, status, supplier_move_id, created_at)
        VALUES (${u.id},
                ${JSON.stringify(items.map((it) => ({ sku: '', name: it.articulo, color: null, qty: it.cantidad, price: it.precio })))}::jsonb,
                ${totalVenta}, 0, ${JSON.stringify(ship)}::jsonb, ${ship.faltante}, ${rate},
                ${'Venta de consignación' + (nota ? ': ' + nota : '')},
                'despachado', 'enviado', ${mov.id},
                COALESCE((${dia}::date + interval '15 hours')::timestamptz, now()))
        RETURNING id`;
      await sql`UPDATE consign_sales SET order_id = ${o.id}, move_id = ${mov.id} WHERE id = ${venta.id}`;

      return res.status(200).json({ ok: true, id: venta.id, order_id: o.id });
    }

    /* ----- Le pagué ventas de consignación ----- */
    // Las ventas pagadas pasan a verse en su cuenta (la deuda) y al lado entra
    // el pago por el mismo monto: para él el saldo no se mueve, para Tomás baja.
    if (b.paga) {
      const ids = (Array.isArray(b.paga.ventas) ? b.paga.ventas : []).map((x) => parseInt(x, 10)).filter(Boolean);
      if (!ids.length) return res.status(400).json({ error: 'Elegí qué ventas le pagaste' });
      const dia = diaValido(b.paga.fecha);
      const nota = b.paga.nota ? String(b.paga.nota).trim().slice(0, 200) || null : null;

      const elegidas = await sql`SELECT id, costo FROM consign_sales
        WHERE supplier_id = ${prov.id} AND pagada_at IS NULL AND id = ANY(${ids}::int[])`;
      if (!elegidas.length) return res.status(400).json({ error: 'Esas ventas ya estaban pagadas' });
      const monto = r2(elegidas.reduce((a, v) => a + Number(v.costo), 0));
      const lasIds = elegidas.map((v) => v.id);

      await sql`UPDATE supplier_moves SET privado = false WHERE sale_id = ANY(${lasIds}::int[])`;
      await sql`UPDATE supplier_consign SET privado = false WHERE sale_id = ANY(${lasIds}::int[])`;
      let pagoId = null;
      if (monto > 0) {
        const [pago] = await sql`
          INSERT INTO supplier_moves (supplier_id, fecha, tipo, monto_usd, monto, detalle)
          VALUES (${prov.id}, COALESCE(${dia}::date, CURRENT_DATE), 'PAGO', ${-monto}, ${-monto},
                  ${'Pago de consignación vendida' + (nota ? ' · ' + nota : '')})
          RETURNING id`;
        pagoId = pago.id;
      }
      await sql`UPDATE consign_sales SET rendida_at = COALESCE(rendida_at, now()),
          pagada_at = now(), pago_move_id = ${pagoId}
        WHERE id = ANY(${lasIds}::int[])`;
      return res.status(200).json({ ok: true, monto, ventas: lasIds.length });
    }

    /* ----- Que las vea sin pagarlas todavía ----- */
    if (b.rendir) {
      if (b.rendir === 'todas') {
        await sql`UPDATE supplier_moves SET privado = false WHERE supplier_id = ${prov.id}
          AND sale_id IN (SELECT id FROM consign_sales WHERE supplier_id = ${prov.id} AND rendida_at IS NULL)`;
        await sql`UPDATE supplier_consign SET privado = false WHERE supplier_id = ${prov.id}
          AND sale_id IN (SELECT id FROM consign_sales WHERE supplier_id = ${prov.id} AND rendida_at IS NULL)`;
        await sql`UPDATE consign_sales SET rendida_at = now() WHERE supplier_id = ${prov.id} AND rendida_at IS NULL`;
        return res.status(200).json({ ok: true });
      }
      const id = parseInt(b.rendir, 10);
      const [v] = await sql`SELECT id FROM consign_sales WHERE id = ${id} AND supplier_id = ${prov.id}`;
      if (!v) return res.status(404).json({ error: 'No existe esa venta' });
      await sql`UPDATE supplier_moves SET privado = false WHERE sale_id = ${id}`;
      await sql`UPDATE supplier_consign SET privado = false WHERE sale_id = ${id}`;
      await sql`UPDATE consign_sales SET rendida_at = COALESCE(rendida_at, now()) WHERE id = ${id}`;
      return res.status(200).json({ ok: true });
    }

    /* ----- Borrar una venta: se deshace todo lo que generó ----- */
    if (b.borrarVenta) {
      const id = parseInt(b.borrarVenta, 10);
      const [v] = await sql`SELECT id, order_id, pagada_at FROM consign_sales WHERE id = ${id} AND supplier_id = ${prov.id}`;
      if (!v) return res.status(404).json({ error: 'No existe esa venta' });
      if (v.pagada_at) {
        return res.status(400).json({ error: 'Esa venta ya se la pagaste: si hay que corregirla, borrá primero el pago en Proveedores.' });
      }
      await sql`DELETE FROM supplier_consign WHERE sale_id = ${id}`;
      await sql`DELETE FROM supplier_moves WHERE sale_id = ${id}`;
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

    return res.status(400).json({ error: 'Datos inválidos' });
  } catch (e) {
    res.status(500).json({ error: 'server', detail: String((e && e.message) || e) });
  }
};
