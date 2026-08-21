// /api/me  -> datos de envío del usuario logueado (quedan guardados para la próxima).
//   GET   -> { user: { dni_cuit, razon_social, telefono, direccion, faltante } }
//   POST  -> guarda esos datos
const { sql, ensureTables } = require('./_db');
const { getSession } = require('./_auth');

const FALTANTES = ['cambiar', 'consultar', 'baja'];

// Deja la dirección en un objeto prolijo (venga de Georef o escrita a mano).
function limpiarDireccion(d) {
  if (!d || typeof d !== 'object') return null;
  const txt = (v) => (v == null || v === '' ? null : String(v).slice(0, 200).trim());
  const dir = {
    texto: txt(d.texto),
    calle: txt(d.calle),
    altura: txt(d.altura),
    piso: txt(d.piso),
    localidad: txt(d.localidad),
    provincia: txt(d.provincia),
    cp: txt(d.cp),
    lat: Number(d.lat) || null,
    lon: Number(d.lon) || null,
    validada: !!d.validada,
  };
  return dir.texto ? dir : null;
}

function validar(b) {
  const errores = [];
  const dni = String(b.dni_cuit || '').replace(/[^\d]/g, '');
  if (dni.length < 7 || dni.length > 11) errores.push('El DNI/CUIT tiene que tener entre 7 y 11 números');
  const razon = String(b.razon_social || '').trim();
  if (razon.length < 3) errores.push('Falta el nombre completo o la razón social');
  const tel = String(b.telefono || '').replace(/[^\d+]/g, '');
  if (tel.replace(/\D/g, '').length < 8) errores.push('El teléfono está incompleto');
  const direccion = limpiarDireccion(b.direccion);
  if (!direccion) errores.push('Falta la dirección de entrega');
  const faltante = FALTANTES.includes(b.faltante) ? b.faltante : null;
  return { errores, datos: { dni_cuit: dni, razon_social: razon.slice(0, 120), telefono: tel.slice(0, 30), direccion, faltante } };
}

module.exports = async (req, res) => {
  const s = getSession(req);
  if (!s) return res.status(401).json({ error: 'Necesitás iniciar sesión' });
  try {
    await ensureTables();

    if (req.method === 'GET') {
      const rows = await sql`SELECT dni_cuit, razon_social, telefono, direccion, faltante
        FROM users WHERE id = ${s.uid}`;
      return res.status(200).json({ user: rows[0] || {} });
    }

    if (req.method === 'POST') {
      const { errores, datos } = validar(req.body || {});
      if (errores.length) return res.status(400).json({ error: errores[0], errores });
      await sql`UPDATE users SET
          dni_cuit = ${datos.dni_cuit},
          razon_social = ${datos.razon_social},
          telefono = ${datos.telefono},
          direccion = ${JSON.stringify(datos.direccion)}::jsonb,
          faltante = ${datos.faltante}
        WHERE id = ${s.uid}`;
      return res.status(200).json({ ok: true, user: datos });
    }

    res.status(405).json({ error: 'method' });
  } catch (e) {
    res.status(500).json({ error: 'server', detail: String((e && e.message) || e) });
  }
};

module.exports.validar = validar;
module.exports.FALTANTES = FALTANTES;
