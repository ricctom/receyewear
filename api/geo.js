// /api/geo -> autocompletado de direcciones contra Georef (API oficial del Estado
// argentino: apis.datos.gob.ar). Es gratis y sin API key. Va por el server para
// evitar problemas de CORS y poder cachear.
//   GET /api/geo?provincias=1              -> lista de provincias
//   GET /api/geo?q=santa fe 1500&provincia=Buenos Aires  -> direcciones sugeridas
const BASE = 'https://apis.datos.gob.ar/georef/api';

async function georef(path) {
  const r = await fetch(BASE + path, { headers: { accept: 'application/json' } });
  if (!r.ok) throw new Error('Georef respondió ' + r.status);
  return r.json();
}

module.exports = async (req, res) => {
  if (req.method !== 'GET') return res.status(405).json({ error: 'method' });
  try {
    const url = new URL(req.url, 'http://x');
    const qs = url.searchParams;

    if (qs.get('provincias')) {
      const d = await georef('/provincias?campos=nombre&max=30&orden=nombre');
      res.setHeader('Cache-Control', 'public, max-age=86400');
      return res.status(200).json({ provincias: (d.provincias || []).map((p) => p.nombre) });
    }

    const q = String(qs.get('q') || '').trim();
    if (q.length < 4) return res.status(200).json({ direcciones: [] });

    let path = '/direcciones?max=8&direccion=' + encodeURIComponent(q);
    const prov = String(qs.get('provincia') || '').trim();
    if (prov) path += '&provincia=' + encodeURIComponent(prov);

    const d = await georef(path);
    const direcciones = (d.direcciones || []).map((x) => ({
      texto: x.nomenclatura || '',
      calle: (x.calle && x.calle.nombre) || null,
      altura: (x.altura && x.altura.valor != null) ? String(x.altura.valor) : null,
      localidad: (x.localidad_censal && x.localidad_censal.nombre) || (x.departamento && x.departamento.nombre) || null,
      provincia: (x.provincia && x.provincia.nombre) || null,
      lat: (x.ubicacion && x.ubicacion.lat) || null,
      lon: (x.ubicacion && x.ubicacion.lon) || null,
    })).filter((x) => x.texto);

    // Georef a veces repite la misma dirección con coordenadas casi iguales.
    const vistas = new Set();
    const unicas = direcciones.filter((x) => {
      const k = x.texto.toLowerCase();
      if (vistas.has(k)) return false;
      vistas.add(k); return true;
    });

    res.setHeader('Cache-Control', 'public, max-age=600');
    res.status(200).json({ direcciones: unicas });
  } catch (e) {
    // Si Georef se cae, el front deja escribir la dirección a mano igual.
    res.status(200).json({ direcciones: [], error: String((e && e.message) || e) });
  }
};
