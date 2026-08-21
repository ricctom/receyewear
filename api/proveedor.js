// /api/proveedor — cuentas corrientes de los proveedores.
// Cada uno lleva su cuenta en su moneda: Martín en dólares, los locales en pesos.
// El admin ve y carga todos. Un proveedor, si entró por su link de invitación,
// ve solo la suya y en modo lectura.
//   GET                        -> lista de proveedores + la cuenta del elegido
//   GET ?proveedor=ID          -> la cuenta de ese
//   GET ?pedido=N              -> borrador de entrega a partir de un pedido
//   POST { entrega|pago|ajuste|consignacion|precio|proveedor|nuevo|invitacion }
const crypto = require('crypto');
const { sql, ensureTables, splitNombre, norm, usdRate } = require('./_db');
const { getSession, ADMIN_EMAIL } = require('./_auth');

async function proveedores() {
  const rows = await sql`SELECT id, nombre, email, moneda, invite_token, claimed_at
    FROM suppliers ORDER BY id`;
  if (rows.length) return rows;
  await sql`INSERT INTO suppliers (nombre, moneda) VALUES ('Martín', 'USD')`;
  return sql`SELECT id, nombre, email, moneda, invite_token, claimed_at FROM suppliers ORDER BY id`;
}

// Link de invitación: el primero que entra con Google por ese link queda
// registrado como ese proveedor y el token se quema. Tomás no puede canjearlo.
async function canjearInvitacion(lista, token, sesion) {
  if (!token) return null;
  const mail = String(sesion.email || '').toLowerCase();
  if (!mail || mail === ADMIN_EMAIL) return null;
  for (const p of lista) {
    if (!p.invite_token || p.email) continue;
    const a = Buffer.from(String(token));
    const b = Buffer.from(p.invite_token);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) continue;
    await sql`UPDATE suppliers SET email = ${mail}, invite_token = NULL, claimed_at = now()
      WHERE id = ${p.id}`;
    p.email = mail; p.invite_token = null;
    return p;
  }
  return null;
}

function limpiarItems(items) {
  return (items || []).map((it) => ({
    articulo: String(it.articulo || '').trim(),
    cantidad: parseInt(it.cantidad, 10) || 0,
    precio: Math.round((Number(it.precio != null ? it.precio : it.precio_usd) || 0) * 100) / 100,
  })).filter((it) => it.articulo && it.cantidad);
}

const totalItems = (items) =>
  Math.round(items.reduce((a, it) => a + it.cantidad * it.precio, 0) * 100) / 100;

// Saldo de cada proveedor, para el resumen de arriba.
async function saldos() {
  const rows = await sql`SELECT supplier_id, COALESCE(sum(monto), 0) AS saldo
    FROM supplier_moves GROUP BY supplier_id`;
  const m = new Map(rows.map((r) => [r.supplier_id, Math.round(Number(r.saldo) * 100) / 100]));
  return m;
}

module.exports = async (req, res) => {
  const s = getSession(req);
  if (!s) return res.status(401).json({ error: 'Necesitás iniciar sesión' });
  try {
    await ensureTables();
    const url = new URL(req.url, 'http://x');
    let lista = await proveedores();

    const invitacion = url.searchParams.get('invitacion') || '';
    let reciénEntró = false;
    if (invitacion && await canjearInvitacion(lista, invitacion, s)) {
      reciénEntró = true;
      lista = await proveedores();
    }

    const mail = String(s.email || '').toLowerCase();
    const mio = lista.find((p) => p.email && p.email.toLowerCase() === mail);
    if (!s.admin && !mio) {
      return res.status(403).json({
        error: invitacion
          ? 'Ese link ya no sirve: o lo usó alguien antes, o Tomás lo dio de baja.'
          : 'Esta cuenta no tiene acceso.' });
    }
    const soloLectura = !s.admin;

    // Cuál se está mirando: el proveedor ve el suyo y nada más.
    const pedido = parseInt(url.searchParams.get('proveedor') || '', 10);
    const prov = soloLectura ? mio : (lista.find((p) => p.id === pedido) || lista[0]);
    const moneda = prov.moneda || 'USD';

    if (req.method === 'GET') {
      // Borrador de entrega a partir de un pedido de la web.
      const pedidoId = parseInt(url.searchParams.get('pedido') || '', 10);
      if (pedidoId) {
        if (soloLectura) return res.status(403).json({ error: 'Solo el administrador' });
        const [ped] = await sql`SELECT id, items FROM orders WHERE id = ${pedidoId}`;
        if (!ped) return res.status(404).json({ error: 'No existe el pedido' });
        const mapRows = await sql`SELECT patron, articulo, factor, supplier_id FROM cost_map`;
        const precios = await sql`SELECT supplier_id, articulo, precio FROM supplier_prices WHERE activo`;
        const mapa = new Map(mapRows.map((r) => [r.patron, r]));
        const pmap = new Map(precios.map((r) => [r.supplier_id + '|' + String(r.articulo).toUpperCase(), Number(r.precio)]));
        const acum = new Map();
        const sinMapear = new Set();
        (ped.items || []).forEach((it) => {
          const { linea } = splitNombre(it.name);
          const m = mapa.get(norm(linea));
          const qty = Math.max(1, parseInt(it.qty, 10) || 1);
          if (!m || m.supplier_id !== prov.id) { if (!m) sinMapear.add(linea); return; }
          acum.set(m.articulo, (acum.get(m.articulo) || 0) + qty * (m.factor || 1));
        });
        const items = [...acum.entries()].map(([articulo, cantidad]) => ({
          articulo, cantidad, precio: pmap.get(prov.id + '|' + articulo.toUpperCase()) || 0,
        }));
        return res.status(200).json({ pedido: ped.id, items, sin_mapear: [...sinMapear] });
      }

      const [movs, consign, precios, usd, saldoDe] = await Promise.all([
        sql`SELECT id, fecha, tipo, monto, detalle, items, order_id FROM supplier_moves
            WHERE supplier_id = ${prov.id} ORDER BY fecha, id`,
        sql`SELECT id, fecha, articulo, cantidad, precio, nota FROM supplier_consign
            WHERE supplier_id = ${prov.id} ORDER BY fecha, id`,
        sql`SELECT id, articulo, precio, activo FROM supplier_prices
            WHERE supplier_id = ${prov.id} ORDER BY articulo`,
        usdRate(),
        saldos(),
      ]);

      let saldo = 0;
      const movimientos = movs.map((m) => {
        saldo = Math.round((saldo + Number(m.monto)) * 100) / 100;
        return { ...m, monto: Number(m.monto), saldo };
      }).reverse();

      const porArticulo = new Map();
      consign.forEach((c) => {
        const a = porArticulo.get(c.articulo) || { articulo: c.articulo, cantidad: 0, total: 0 };
        a.cantidad += c.cantidad;
        a.total = Math.round((a.total + c.cantidad * Number(c.precio)) * 100) / 100;
        porArticulo.set(c.articulo, a);
      });
      const stockConsign = [...porArticulo.values()].filter((a) => a.cantidad || a.total);
      const consignTotal = Math.round(stockConsign.reduce((a, x) => a + x.total, 0) * 100) / 100;

      return res.status(200).json({
        proveedor: { id: prov.id, nombre: prov.nombre, email: prov.email, moneda,
                     invitacion: s.admin ? prov.invite_token : undefined },
        // El resumen de arriba: todos los proveedores con su saldo.
        proveedores: s.admin
          ? lista.map((p) => ({ id: p.id, nombre: p.nombre, moneda: p.moneda || 'USD',
                                saldo: saldoDe.get(p.id) || 0, tiene_acceso: !!p.email }))
          : [{ id: prov.id, nombre: prov.nombre, moneda, saldo: saldoDe.get(prov.id) || 0 }],
        soloLectura, reciénEntró,
        deuda: saldo,
        consign_total: consignTotal,
        movimientos,
        consignacion: consign.slice().reverse(),
        stock_consignacion: stockConsign,
        precios,
        usd,
      });
    }

    if (req.method === 'POST') {
      if (soloLectura) return res.status(403).json({ error: 'Solo el administrador puede cargar movimientos' });
      const b = req.body || {};
      const fecha = /^\d{4}-\d{2}-\d{2}$/.test(String(b.fecha || '')) ? b.fecha : null;
      // Sobre qué proveedor se está trabajando.
      const destino = lista.find((p) => p.id === (parseInt(b.supplier_id, 10) || prov.id)) || prov;

      /* ----- Alta de un proveedor ----- */
      if (b.nuevo) {
        const nombre = String(b.nuevo.nombre || '').trim().slice(0, 80);
        if (!nombre) return res.status(400).json({ error: 'Poné el nombre' });
        if (lista.some((p) => p.nombre.toLowerCase() === nombre.toLowerCase())) {
          return res.status(400).json({ error: 'Ya tenés un proveedor con ese nombre' });
        }
        const mon = b.nuevo.moneda === 'USD' ? 'USD' : 'ARS';
        const [row] = await sql`INSERT INTO suppliers (nombre, moneda) VALUES (${nombre}, ${mon}) RETURNING id`;
        return res.status(200).json({ ok: true, id: row.id });
      }

      /* ----- Link de invitación ----- */
      if (b.invitacion) {
        if (b.invitacion === 'generar') {
          if (destino.email) return res.status(400).json({ error: 'Ya hay alguien registrado. Sacale el acceso primero.' });
          const token = crypto.randomBytes(18).toString('base64url');
          await sql`UPDATE suppliers SET invite_token = ${token} WHERE id = ${destino.id}`;
          return res.status(200).json({ ok: true, token });
        }
        if (b.invitacion === 'revocar') {
          await sql`UPDATE suppliers SET invite_token = NULL WHERE id = ${destino.id}`;
          return res.status(200).json({ ok: true });
        }
        return res.status(400).json({ error: 'Datos inválidos' });
      }

      /* ----- Nombre, moneda y acceso ----- */
      if (b.proveedor) {
        const nombre = String(b.proveedor.nombre || destino.nombre).trim().slice(0, 80) || destino.nombre;
        const email = b.proveedor.email ? String(b.proveedor.email).toLowerCase().trim().slice(0, 120) : null;
        if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: 'Ese mail no parece válido' });
        const mon = b.proveedor.moneda === 'USD' ? 'USD' : b.proveedor.moneda === 'ARS' ? 'ARS' : destino.moneda;
        await sql`UPDATE suppliers SET nombre = ${nombre}, email = ${email}, moneda = ${mon},
            claimed_at = CASE WHEN ${email}::text IS NULL THEN NULL ELSE claimed_at END
          WHERE id = ${destino.id}`;
        return res.status(200).json({ ok: true });
      }

      /* ----- Lista de precios ----- */
      if (b.precio) {
        const articulo = String(b.precio.articulo || '').trim().slice(0, 80);
        if (!articulo) return res.status(400).json({ error: 'Falta el artículo' });
        if (b.precio.borrar) {
          await sql`DELETE FROM supplier_prices WHERE supplier_id = ${destino.id} AND upper(articulo) = upper(${articulo})`;
          return res.status(200).json({ ok: true });
        }
        const precio = Math.round((Number(b.precio.precio) || 0) * 100) / 100;
        if (!(precio > 0)) return res.status(400).json({ error: 'El precio tiene que ser mayor a cero' });
        await sql`INSERT INTO supplier_prices (supplier_id, articulo, precio_usd, precio, activo)
          VALUES (${destino.id}, ${articulo}, ${precio}, ${precio}, true)
          ON CONFLICT (supplier_id, upper(articulo))
          DO UPDATE SET precio = ${precio}, precio_usd = ${precio}, activo = true`;
        return res.status(200).json({ ok: true });
      }

      /* ----- Entrega (sube la deuda) ----- */
      if (b.entrega) {
        const items = limpiarItems(b.entrega.items);
        if (!items.length) return res.status(400).json({ error: 'Cargá al menos un artículo con cantidad' });
        const monto = totalItems(items);
        if (!(monto > 0)) return res.status(400).json({ error: 'El total de la entrega da cero' });
        const [mov] = await sql`INSERT INTO supplier_moves (supplier_id, fecha, tipo, monto_usd, monto, detalle, items)
          VALUES (${destino.id}, COALESCE(${fecha}::date, CURRENT_DATE), 'PEDIDO', ${monto}, ${monto},
                  ${b.entrega.detalle ? String(b.entrega.detalle).slice(0, 200) : null},
                  ${JSON.stringify(items)}::jsonb)
          RETURNING id`;
        return res.status(200).json({ ok: true, id: mov.id, monto });
      }

      /* ----- Pago (baja la deuda) ----- */
      if (b.pago) {
        const monto = Math.round((Number(b.pago.monto) || 0) * 100) / 100;
        if (!(monto > 0)) return res.status(400).json({ error: 'El monto tiene que ser mayor a cero' });
        await sql`INSERT INTO supplier_moves (supplier_id, fecha, tipo, monto_usd, monto, detalle)
          VALUES (${destino.id}, COALESCE(${fecha}::date, CURRENT_DATE), 'PAGO', ${-monto}, ${-monto},
                  ${b.pago.detalle ? String(b.pago.detalle).slice(0, 200) : null})`;
        return res.status(200).json({ ok: true });
      }

      /* ----- Ajuste ----- */
      if (b.ajuste) {
        const monto = Math.round((Number(b.ajuste.monto) || 0) * 100) / 100;
        if (!monto) return res.status(400).json({ error: 'El ajuste no puede ser cero' });
        await sql`INSERT INTO supplier_moves (supplier_id, fecha, tipo, monto_usd, monto, detalle)
          VALUES (${destino.id}, COALESCE(${fecha}::date, CURRENT_DATE), 'AJUSTE', ${monto}, ${monto},
                  ${b.ajuste.detalle ? String(b.ajuste.detalle).slice(0, 200) : 'Ajuste manual'})`;
        return res.status(200).json({ ok: true });
      }

      /* ----- Consignación ----- */
      if (b.consignacion) {
        const items = limpiarItems(b.consignacion.items);
        if (!items.length) return res.status(400).json({ error: 'Cargá al menos un artículo con cantidad' });
        const signo = b.consignacion.tipo === 'deja' ? 1 : -1;
        for (const it of items) {
          await sql`INSERT INTO supplier_consign (supplier_id, fecha, articulo, cantidad, precio_usd, precio, nota)
            VALUES (${destino.id}, COALESCE(${fecha}::date, CURRENT_DATE), ${it.articulo},
                    ${signo * Math.abs(it.cantidad)}, ${it.precio}, ${it.precio},
                    ${b.consignacion.nota ? String(b.consignacion.nota).slice(0, 200) : null})`;
        }
        if (b.consignacion.tipo === 'pago') {
          const monto = totalItems(items.map((i) => ({ ...i, cantidad: Math.abs(i.cantidad) })));
          await sql`INSERT INTO supplier_moves (supplier_id, fecha, tipo, monto_usd, monto, detalle, items)
            VALUES (${destino.id}, COALESCE(${fecha}::date, CURRENT_DATE), 'PEDIDO', ${monto}, ${monto},
                    'Consignación que me quedo', ${JSON.stringify(items)}::jsonb)`;
        }
        return res.status(200).json({ ok: true });
      }

      if (b.borrarMov) {
        await sql`DELETE FROM supplier_moves WHERE id = ${parseInt(b.borrarMov, 10)}`;
        return res.status(200).json({ ok: true });
      }
      if (b.borrarConsign) {
        await sql`DELETE FROM supplier_consign WHERE id = ${parseInt(b.borrarConsign, 10)}`;
        return res.status(200).json({ ok: true });
      }

      return res.status(400).json({ error: 'Datos inválidos' });
    }

    res.status(405).json({ error: 'method' });
  } catch (e) {
    res.status(500).json({ error: 'server', detail: String((e && e.message) || e) });
  }
};
