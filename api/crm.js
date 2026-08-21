// /api/crm  (solo el email admin) — seguimiento de clientes.
//   GET                        -> todos los clientes + lo que compraron por la web
//   GET ?id=N                  -> un cliente con su historial de contactos
//   POST { cliente:{...} }     -> crea o edita un cliente
//   POST { id, evento:{...} }  -> registra un contacto y actualiza "último contacto"
//   POST { importar:"texto" }  -> importa un listado pegado (CSV o TSV)
//   POST { id, borrar:true }   -> borra el cliente
const { sql, ensureTables } = require('./_db');
const { getSession } = require('./_auth');

const ESTADOS = ['compro', 'caliente', 'tibio', 'esperar', 'frio'];

// Los estados vienen escritos de mil formas; los llevamos a los 5 de arriba.
function normEstado(v) {
  const s = String(v || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
  if (!s) return 'tibio';
  if (ESTADOS.includes(s)) return s;
  if (s.startsWith('compr')) return 'compro';
  if (s.includes('caliente')) return 'caliente';
  if (s.startsWith('tibio')) return 'tibio';
  if (s.includes('esper') || s.includes('pausa')) return 'esperar';
  if (s.startsWith('fri')) return 'frio';
  return 'tibio';
}

// Acepta 27/05/2026, 2026-05-27 y también los números de fecha que escupe Excel.
function parseFecha(v) {
  if (v == null || v === '') return null;
  const s = String(v).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const dmy = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/);
  if (dmy) {
    let [, d, m, y] = dmy;
    if (y.length === 2) y = '20' + y;
    return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  }
  // Serial de Excel: días desde el 30/12/1899.
  if (/^\d{5}$/.test(s)) {
    const base = Date.UTC(1899, 11, 30);
    const dt = new Date(base + Number(s) * 86400000);
    let mes = dt.getUTCMonth() + 1, dia = dt.getUTCDate();
    // Excel en inglés lee 1/6/2026 como 6 de enero. Si los dos números entran
    // en un mes, damos vuelta día y mes (acá las fechas se escriben dd/mm).
    if (dia <= 12) { const t = mes; mes = dia; dia = t; }
    return `${dt.getUTCFullYear()}-${String(mes).padStart(2, '0')}-${String(dia).padStart(2, '0')}`;
  }
  return null;
}

// Montos: entiende "$1.158.500", "1,158,500", "702" y "218.5".
// Con enMiles = true, los números chicos se leen como miles (702 = $702.000),
// que es como estaban escritos en la planilla vieja.
function parseMonto(v, enMiles) {
  if (v == null || v === '') return 0;
  const s = String(v).replace(/[^\d.,-]/g, '').trim();
  if (!s) return 0;
  let n, separado = false;
  if (/^-?\d{1,3}(\.\d{3})+(,\d+)?$/.test(s)) {          // 1.158.500,50 (Argentina)
    n = Number(s.replace(/\./g, '').replace(',', '.')); separado = true;
  } else if (/^-?\d{1,3}(,\d{3})+(\.\d+)?$/.test(s)) {   // 1,158,500.50 (inglés)
    n = Number(s.replace(/,/g, '')); separado = true;
  } else {
    n = Number(s.replace(',', '.'));
  }
  if (!isFinite(n) || n <= 0) return 0;
  if (enMiles && !separado && n < 10000) n = n * 1000;
  return Math.round(n);
}

const COLS = {
  nombre: ['cliente', 'nombre', 'optica', 'razon social'],
  zona: ['zona', 'ruta', 'provincia'],
  estado: ['estado', 'status'],
  ultimo_contacto: ['ultimo contacto real', 'ultimo contacto', 'ultimo'],
  resumen: ['resumen situacion', 'resumen', 'situacion', 'notas', 'comentarios'],
  proxima_accion: ['proxima accion', 'accion', 'siguiente paso'],
  fecha_accion: ['fecha accion', 'fecha de accion', 'cuando'],
  comprado: ['compro', 'comprado', 'total comprado', 'ventas'],
  pendiente: ['pendiente cobro', 'pendiente', 'debe', 'saldo'],
  telefono: ['telefono', 'tel', 'celular', 'whatsapp'],
  email: ['email', 'mail', 'correo'],
};

function limpiarCab(h) {
  return String(h || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
}

// Corta una línea de CSV respetando las comillas.
function partirCSV(linea, sep) {
  const out = []; let cur = ''; let dentro = false;
  for (let i = 0; i < linea.length; i++) {
    const c = linea[i];
    if (c === '"') {
      if (dentro && linea[i + 1] === '"') { cur += '"'; i++; }
      else dentro = !dentro;
    } else if (c === sep && !dentro) { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out.map((x) => x.trim());
}

function parsearListado(texto, enMiles) {
  const lineas = String(texto || '').split(/\r?\n/).filter((l) => l.trim());
  if (lineas.length < 2) return { filas: [], error: 'Pegá el listado con su fila de títulos y al menos un cliente' };
  const sep = (lineas[0].match(/\t/g) || []).length >= (lineas[0].match(/[;,]/g) || []).length
    ? '\t' : (lineas[0].includes(';') ? ';' : ',');
  const cab = partirCSV(lineas[0], sep).map(limpiarCab);

  const idx = {};
  Object.entries(COLS).forEach(([campo, alias]) => {
    const i = cab.findIndex((c) => alias.some((a) => c === a || c.startsWith(a)));
    if (i >= 0) idx[campo] = i;
  });
  if (idx.nombre == null) return { filas: [], error: 'No encontré la columna del nombre del cliente' };

  const filas = [];
  for (let i = 1; i < lineas.length; i++) {
    const p = partirCSV(lineas[i], sep);
    const nombre = (p[idx.nombre] || '').trim();
    if (!nombre) continue;
    filas.push({
      nombre: nombre.slice(0, 120),
      zona: idx.zona != null ? (p[idx.zona] || '').slice(0, 80) : null,
      estado: normEstado(idx.estado != null ? p[idx.estado] : ''),
      ultimo_contacto: idx.ultimo_contacto != null ? parseFecha(p[idx.ultimo_contacto]) : null,
      resumen: idx.resumen != null ? (p[idx.resumen] || '').slice(0, 1000) : null,
      proxima_accion: idx.proxima_accion != null ? (p[idx.proxima_accion] || '').slice(0, 500) : null,
      fecha_accion: idx.fecha_accion != null ? parseFecha(p[idx.fecha_accion]) : null,
      comprado: idx.comprado != null ? parseMonto(p[idx.comprado], enMiles) : 0,
      pendiente: idx.pendiente != null ? parseMonto(p[idx.pendiente], enMiles) : 0,
      telefono: idx.telefono != null ? (p[idx.telefono] || '').slice(0, 40) : null,
      email: idx.email != null ? (p[idx.email] || '').toLowerCase().slice(0, 120) : null,
    });
  }
  return { filas };
}

async function upsert(c) {
  const rows = await sql`
    INSERT INTO crm_clients (nombre, zona, estado, telefono, email, ultimo_contacto,
                             resumen, proxima_accion, fecha_accion, comprado, pendiente)
    VALUES (${c.nombre}, ${c.zona || null}, ${c.estado || 'tibio'}, ${c.telefono || null},
            ${c.email || null}, ${c.ultimo_contacto || null}, ${c.resumen || null},
            ${c.proxima_accion || null}, ${c.fecha_accion || null},
            ${c.comprado || 0}, ${c.pendiente || 0})
    ON CONFLICT (lower(nombre)) DO UPDATE SET
      zona = COALESCE(EXCLUDED.zona, crm_clients.zona),
      estado = EXCLUDED.estado,
      telefono = COALESCE(EXCLUDED.telefono, crm_clients.telefono),
      email = COALESCE(EXCLUDED.email, crm_clients.email),
      ultimo_contacto = COALESCE(EXCLUDED.ultimo_contacto, crm_clients.ultimo_contacto),
      resumen = COALESCE(NULLIF(EXCLUDED.resumen, ''), crm_clients.resumen),
      proxima_accion = COALESCE(NULLIF(EXCLUDED.proxima_accion, ''), crm_clients.proxima_accion),
      fecha_accion = COALESCE(EXCLUDED.fecha_accion, crm_clients.fecha_accion),
      comprado = CASE WHEN EXCLUDED.comprado > 0 THEN EXCLUDED.comprado ELSE crm_clients.comprado END,
      pendiente = EXCLUDED.pendiente,
      updated_at = now()
    RETURNING id`;
  return rows[0].id;
}

module.exports = async (req, res) => {
  const s = getSession(req);
  if (!s || !s.admin) return res.status(403).json({ error: 'Solo el administrador' });
  try {
    await ensureTables();

    if (req.method === 'GET') {
      const url = new URL(req.url, 'http://x');
      const id = parseInt(url.searchParams.get('id') || '', 10);
      if (id) {
        const [cli] = await sql`SELECT * FROM crm_clients WHERE id = ${id}`;
        if (!cli) return res.status(404).json({ error: 'No existe el cliente' });
        const eventos = await sql`SELECT id, fecha, texto FROM crm_events
          WHERE client_id = ${id} ORDER BY fecha DESC, id DESC LIMIT 200`;
        // Su cuenta corriente: los pedidos que hizo por la web y lo que pagó.
        const pedidos = cli.email ? await sql`
          SELECT o.id, o.total, o.etapa, o.created_at,
                 COALESCE((SELECT sum(p.monto)::int FROM order_payments p WHERE p.order_id = o.id), 0) AS cobrado
          FROM orders o JOIN users u ON u.id = o.user_id
          WHERE lower(u.email) = ${String(cli.email).toLowerCase()} AND o.etapa <> 'cancelado'
          ORDER BY o.id DESC` : [];
        const pagos = cli.email ? await sql`
          SELECT p.id, p.fecha, p.monto, p.medio, p.nota, p.order_id
          FROM order_payments p JOIN orders o ON o.id = p.order_id JOIN users u ON u.id = o.user_id
          WHERE lower(u.email) = ${String(cli.email).toLowerCase()}
          ORDER BY p.fecha DESC, p.id DESC LIMIT 100` : [];
        return res.status(200).json({ cliente: cli, eventos, pedidos, pagos });
      }

      const clientes = await sql`SELECT c.*,
          (SELECT count(*)::int FROM crm_events e WHERE e.client_id = c.id) AS contactos
        FROM crm_clients c WHERE NOT archivado ORDER BY lower(c.nombre)`;

      // Lo comprado y lo cobrado de verdad, según los pedidos de la web.
      const web = await sql`
        SELECT lower(u.email) AS email, u.name,
               count(o.id)::int AS pedidos,
               COALESCE(sum(o.total), 0)::bigint AS total,
               COALESCE(sum((SELECT COALESCE(sum(p.monto), 0) FROM order_payments p WHERE p.order_id = o.id)), 0)::bigint AS cobrado,
               max(o.created_at) AS ultimo_pedido
        FROM orders o JOIN users u ON u.id = o.user_id
        WHERE o.status <> 'cancelado'
        GROUP BY 1, 2`;

      return res.status(200).json({ clientes, web });
    }

    if (req.method === 'POST') {
      const b = req.body || {};

      if (b.importar) {
        const { filas, error } = parsearListado(b.importar, !!b.miles);
        if (error) return res.status(400).json({ error });
        if (!filas.length) return res.status(400).json({ error: 'No encontré ningún cliente en lo que pegaste' });
        let nuevos = 0;
        const antes = await sql`SELECT lower(nombre) AS n FROM crm_clients`;
        const existentes = new Set(antes.map((r) => r.n));
        for (const f of filas) {
          if (!existentes.has(f.nombre.toLowerCase())) nuevos++;
          await upsert(f);
        }
        return res.status(200).json({ ok: true, total: filas.length, nuevos, actualizados: filas.length - nuevos });
      }

      if (b.cliente) {
        const c = b.cliente;
        if (!String(c.nombre || '').trim()) return res.status(400).json({ error: 'Falta el nombre' });
        const datos = {
          nombre: String(c.nombre).trim().slice(0, 120),
          zona: c.zona ? String(c.zona).slice(0, 80) : null,
          estado: normEstado(c.estado),
          telefono: c.telefono ? String(c.telefono).slice(0, 40) : null,
          email: c.email ? String(c.email).toLowerCase().slice(0, 120) : null,
          ultimo_contacto: parseFecha(c.ultimo_contacto),
          resumen: c.resumen ? String(c.resumen).slice(0, 1000) : null,
          proxima_accion: c.proxima_accion ? String(c.proxima_accion).slice(0, 500) : null,
          fecha_accion: parseFecha(c.fecha_accion),
          comprado: Math.round(Number(c.comprado) || 0),
          pendiente: Math.round(Number(c.pendiente) || 0),
        };
        if (c.id) {
          await sql`UPDATE crm_clients SET
              nombre = ${datos.nombre}, zona = ${datos.zona}, estado = ${datos.estado},
              telefono = ${datos.telefono}, email = ${datos.email},
              ultimo_contacto = ${datos.ultimo_contacto}, resumen = ${datos.resumen},
              proxima_accion = ${datos.proxima_accion}, fecha_accion = ${datos.fecha_accion},
              comprado = ${datos.comprado}, pendiente = ${datos.pendiente}, updated_at = now()
            WHERE id = ${parseInt(c.id, 10)}`;
          return res.status(200).json({ ok: true, id: parseInt(c.id, 10) });
        }
        return res.status(200).json({ ok: true, id: await upsert(datos) });
      }

      const id = parseInt(b.id, 10);
      if (!id) return res.status(400).json({ error: 'Datos inválidos' });

      if (b.borrar) {
        await sql`DELETE FROM crm_clients WHERE id = ${id}`;
        return res.status(200).json({ ok: true });
      }

      // Un cobro cargado desde la cuenta corriente del cliente: se reparte
      // entre sus pedidos impagos, del más viejo al más nuevo. Sirve para el
      // caso típico de un cheque que paga varios pedidos juntos.
      if (b.cobro) {
        const [cli] = await sql`SELECT email FROM crm_clients WHERE id = ${id}`;
        if (!cli) return res.status(404).json({ error: 'No existe el cliente' });
        if (!cli.email) return res.status(400).json({ error: 'Cargale el mail al cliente para poder verle los pedidos' });
        let resto = Math.round(Number(b.cobro.monto) || 0);
        if (!(resto > 0)) return res.status(400).json({ error: 'Poné cuánto te pagó' });

        const pendientes = await sql`
          SELECT o.id, o.total,
                 COALESCE((SELECT sum(p.monto)::int FROM order_payments p WHERE p.order_id = o.id), 0) AS cobrado
          FROM orders o JOIN users u ON u.id = o.user_id
          WHERE lower(u.email) = ${String(cli.email).toLowerCase()} AND o.etapa <> 'cancelado'
          ORDER BY o.id`;
        const abiertos = pendientes.filter((o) => o.total - o.cobrado > 0);
        if (!abiertos.length) return res.status(400).json({ error: 'Este cliente no tiene pedidos sin cobrar' });

        const fecha = parseFecha(b.cobro.fecha);
        const medio = b.cobro.medio ? String(b.cobro.medio).slice(0, 40) : null;
        const nota = b.cobro.nota ? String(b.cobro.nota).slice(0, 200) : null;
        const aplicado = [];
        for (const o of abiertos) {
          if (resto <= 0) break;
          const falta = o.total - o.cobrado;
          const monto = Math.min(falta, resto);
          await sql`INSERT INTO order_payments (order_id, fecha, monto, medio, nota)
            VALUES (${o.id}, COALESCE(${fecha}::date, CURRENT_DATE), ${monto}, ${medio}, ${nota})`;
          aplicado.push({ pedido: o.id, monto });
          resto -= monto;
        }
        return res.status(200).json({ ok: true, aplicado, sobrante: resto });
      }

      if (b.evento) {
        const texto = String(b.evento.texto || '').trim().slice(0, 1000);
        if (!texto) return res.status(400).json({ error: 'Escribí qué pasó en el contacto' });
        const fecha = parseFecha(b.evento.fecha);
        await sql`INSERT INTO crm_events (client_id, fecha, texto)
          VALUES (${id}, COALESCE(${fecha}::date, CURRENT_DATE), ${texto})`;
        // Registrar un contacto actualiza el "último contacto" y, si vino, la próxima acción.
        await sql`UPDATE crm_clients SET
            ultimo_contacto = GREATEST(COALESCE(${fecha}::date, CURRENT_DATE), COALESCE(ultimo_contacto, '1900-01-01'::date)),
            estado = COALESCE(${b.evento.estado ? normEstado(b.evento.estado) : null}, estado),
            proxima_accion = COALESCE(${b.evento.proxima_accion ? String(b.evento.proxima_accion).slice(0, 500) : null}, proxima_accion),
            fecha_accion = COALESCE(${parseFecha(b.evento.fecha_accion)}::date, fecha_accion),
            updated_at = now()
          WHERE id = ${id}`;
        return res.status(200).json({ ok: true });
      }

      return res.status(400).json({ error: 'Datos inválidos' });
    }

    res.status(405).json({ error: 'method' });
  } catch (e) {
    res.status(500).json({ error: 'server', detail: String((e && e.message) || e) });
  }
};

module.exports.parsearListado = parsearListado;
module.exports.parseFecha = parseFecha;
module.exports.parseMonto = parseMonto;
