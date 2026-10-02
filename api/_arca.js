// ARCA (ex AFIP): la factura electrónica de REC, a nombre del CUIT de Tomás.
//
// Es el mismo motor que ya factura en optica-app (src/lib/arca.ts) y en el
// sistema integral de Hidra, pasado a CommonJS. Tomás es monotributista:
// emite Factura C (11) y, para anular, Nota de crédito C (13).
//
// Usa el MISMO certificado que optica-app (alias "visionline", a nombre de
// Tomás). Lo único a cuidar: ARCA entrega un solo pase (ticket) de 12 horas
// por certificado y, mientras está vigente, no da otro. Por eso REC no se
// guarda el suyo aparte: lee y escribe el pase en la base de optica-app
// (ARCA_TICKET_DB_URL), así los dos programas usan el mismo.
//
// Variables de entorno (Vercel):
//   ARCA_CERT, ARCA_KEY    el certificado y la clave de optica-app (los mismos valores)
//   ARCA_TICKET_DB_URL     la DATABASE_URL de optica-app, para compartir el pase
//   ARCA_CUIT              el CUIT de Tomás
//   ARCA_PUNTO_VENTA       el punto de venta "Web Services" dado de alta en ARCA
//   ARCA_ENTORNO           "homologacion" para probar sin emitir de verdad
//
// ⚠ solicitarCAE() emite una factura REAL.
const https = require('https');
const forge = require('node-forge');
const { neon } = require('@neondatabase/serverless');
const { sql, setSetting } = require('./_db');

const HOMOLOGACION = process.env.ARCA_ENTORNO === 'homologacion';
const WSAA_URL = HOMOLOGACION
  ? 'https://wsaahomo.afip.gov.ar/ws/services/LoginCms'
  : 'https://wsaa.afip.gov.ar/ws/services/LoginCms';
const WSFE_URL = HOMOLOGACION
  ? 'https://wswhomo.afip.gov.ar/wsfev1/service.asmx'
  : 'https://servicios1.afip.gov.ar/wsfev1/service.asmx';
const FEV1_NS = 'http://ar.gov.afip.dif.FEV1/';
const SERVICIO = 'wsfe';
// Consulta de padrón: con un CUIT devuelve nombre y condición frente al IVA.
// Es otro servicio de ARCA, con su propio pase (no choca con el de wsfe).
const PADRON = 'ws_sr_constancia_inscripcion';
const PADRON_URL = HOMOLOGACION
  ? 'https://awshomo.afip.gov.ar/sr-padron/webservices/personaServiceA5'
  : 'https://aws.afip.gov.ar/sr-padron/webservices/personaServiceA5';
const TICKET_KEY = 'arca_ticket_' + (HOMOLOGACION ? 'homo' : 'prod');

const TIPOS = { 11: 'Factura C', 13: 'Nota de crédito C' };
const DOC = { CUIT: 80, DNI: 96, SIN_IDENTIFICAR: 99 };
// Condición frente al IVA del receptor (RG 5616).
const IVA_RECEPTOR = { 1: 'Responsable inscripto', 4: 'Exento', 5: 'Consumidor final', 6: 'Monotributo' };

const soloDigitos = (s) => String(s || '').replace(/\D/g, '');
const cuit = () => soloDigitos(process.env.ARCA_CUIT);
const puntoVenta = () => parseInt(process.env.ARCA_PUNTO_VENTA, 10) || 0;

class ArcaError extends Error {}

// En Vercel el certificado viaja en base64, en una línea.
function pem(valor) {
  const s = String(valor || '').trim();
  if (!s) return null;
  return s.startsWith('-----BEGIN') ? s.replace(/\\n/g, '\n') : Buffer.from(s, 'base64').toString('utf8');
}

// Qué falta para poder facturar. Vacío = listo.
function faltaConfigurar() {
  const f = [];
  if (!pem(process.env.ARCA_CERT)) f.push('ARCA_CERT');
  if (!pem(process.env.ARCA_KEY)) f.push('ARCA_KEY');
  if (cuit().length !== 11) f.push('ARCA_CUIT');
  if (!puntoVenta()) f.push('ARCA_PUNTO_VENTA');
  return f;
}

/* ---------- transporte ---------- */

// ARCA negocia con una clave Diffie-Hellman de 1024 bits que OpenSSL moderno
// rechaza (DH_KEY_TOO_SMALL). Se baja el nivel solo para estas conexiones.
const agente = new https.Agent({ ciphers: 'DEFAULT@SECLEVEL=1' });

function post(url, cuerpo, soapAction, timeoutMs = 25000) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, {
      method: 'POST',
      agent: agente,
      headers: {
        'Content-Type': 'text/xml; charset=utf-8',
        SOAPAction: soapAction,
        'Content-Length': Buffer.byteLength(cuerpo),
      },
    }, (res) => {
      const partes = [];
      res.on('data', (c) => partes.push(c));
      res.on('end', () => resolve(Buffer.concat(partes).toString('utf8')));
    });
    req.setTimeout(timeoutMs, () => req.destroy(new ArcaError('ARCA no respondió en ' + timeoutMs / 1000 + ' segundos')));
    req.on('error', reject);
    req.end(cuerpo);
  });
}

/* ---------- XML ---------- */

const desescapar = (s) => String(s || '')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
  .replace(/&apos;/g, "'").replace(/&#39;/g, "'").replace(/&amp;/g, '&');

function texto(xml, etiqueta) {
  const m = String(xml).match(new RegExp('<' + etiqueta + '>([\\s\\S]*?)</' + etiqueta + '>'));
  return m ? m[1].trim() : null;
}
function bloques(xml, etiqueta) {
  const re = new RegExp('<' + etiqueta + '>[\\s\\S]*?<Code>([\\s\\S]*?)</Code>[\\s\\S]*?<Msg>([\\s\\S]*?)</Msg>[\\s\\S]*?</' + etiqueta + '>', 'g');
  return [...String(xml).matchAll(re)].map((m) => ({ codigo: m[1].trim(), mensaje: desescapar(m[2].trim()) }));
}
const errores = (xml) => bloques(xml, 'Err');
const observaciones = (xml) => bloques(xml, 'Obs');
const enTexto = (lista) => lista.map((e) => e.codigo + ': ' + e.mensaje).join(' · ');

// Fecha y hora con el huso de Argentina, como la pide el WSAA.
const isoArgentina = (d) => new Date(d.getTime() - 3 * 3600000).toISOString().replace(/\.\d{3}Z$/, '-03:00');
// AAAAMMDD del día en Argentina, como lo pide el WSFE.
const diaArca = (d = new Date()) => new Date(d.getTime() - 3 * 3600000).toISOString().slice(0, 10).replace(/-/g, '');
// "20261002" -> "2026-10-02"
const fechaDeArca = (s) => {
  const m = String(s || '').match(/^(\d{4})(\d{2})(\d{2})$/);
  return m ? m[1] + '-' + m[2] + '-' + m[3] : null;
};

/* ---------- WSAA: el ticket ---------- */

function armarTRA(servicio) {
  const ahora = new Date();
  return '<?xml version="1.0" encoding="UTF-8"?>' +
    '<loginTicketRequest version="1.0"><header>' +
    '<uniqueId>' + Math.floor(ahora.getTime() / 1000) + '</uniqueId>' +
    '<generationTime>' + isoArgentina(new Date(ahora.getTime() - 10 * 60000)) + '</generationTime>' +
    '<expirationTime>' + isoArgentina(new Date(ahora.getTime() + 12 * 3600000)) + '</expirationTime>' +
    '</header><service>' + servicio + '</service></loginTicketRequest>';
}

// Firma CMS (PKCS#7) del pedido, con SHA-256: la que ARCA acepta.
function firmarCMS(tra) {
  const cert = pem(process.env.ARCA_CERT), clave = pem(process.env.ARCA_KEY);
  if (!cert || !clave) throw new ArcaError('Falta cargar el certificado de ARCA en Vercel (ARCA_CERT y ARCA_KEY).');
  const certificado = forge.pki.certificateFromPem(cert);
  const p7 = forge.pkcs7.createSignedData();
  p7.content = forge.util.createBuffer(tra, 'utf8');
  p7.addCertificate(certificado);
  p7.addSigner({
    key: forge.pki.privateKeyFromPem(clave),
    certificate: certificado,
    digestAlgorithm: forge.pki.oids.sha256,
    authenticatedAttributes: [
      { type: forge.pki.oids.contentType, value: forge.pki.oids.data },
      { type: forge.pki.oids.messageDigest },
      { type: forge.pki.oids.signingTime, value: new Date() },
    ],
  });
  p7.sign();
  return forge.util.encode64(forge.asn1.toDer(p7.toAsn1()).getBytes());
}

async function pedirTicket(servicio) {
  const sobre = '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" ' +
    'xmlns:wsaa="https://wsaa.afip.gov.ar/ws/services/LoginCms">' +
    '<soapenv:Header/><soapenv:Body><wsaa:loginCms>' +
    '<wsaa:in0>' + firmarCMS(armarTRA(servicio)) + '</wsaa:in0>' +
    '</wsaa:loginCms></soapenv:Body></soapenv:Envelope>';
  const resp = await post(WSAA_URL, sobre, '');
  const ret = texto(resp, 'loginCmsReturn');
  if (!ret) {
    const falla = desescapar(texto(resp, 'faultstring') || resp.slice(0, 300));
    if (/no autorizado|not authorized|notAuthorized|computador.*no.*relaci/i.test(falla) && servicio === PADRON) {
      throw new ArcaError('SIN_PADRON');
    }
    if (/ya posee un TA v[aá]lido/i.test(falla)) {
      throw new ArcaError('ARCA dice que el certificado ya tiene un pase vigente pedido por el sistema de ópticas, ' +
        'y REC no lo pudo leer. Revisá ARCA_TICKET_DB_URL en Vercel.');
    }
    throw new ArcaError('ARCA no dio el ticket de acceso: ' + falla);
  }
  const ta = desescapar(ret);
  return { token: texto(ta, 'token') || '', sign: texto(ta, 'sign') || '', expira: texto(ta, 'expirationTime') };
}

const vigente = (t) => t && t.token && t.sign && new Date(t.expira).getTime() - 5 * 60000 > Date.now();

// El pase dura 12 horas. Si está ARCA_TICKET_DB_URL, se comparte con optica-app
// en su tabla "ArcaTicket"; si no, REC lo guarda en su settings.
const compartida = process.env.ARCA_TICKET_DB_URL && !HOMOLOGACION ? neon(process.env.ARCA_TICKET_DB_URL) : null;

// Clave en settings: la de wsfe queda como estaba; los otros servicios, con su nombre.
const claveTicket = (servicio) => servicio === SERVICIO ? TICKET_KEY : TICKET_KEY + '_' + servicio;

async function leerTicket(servicio) {
  if (compartida) {
    const [r] = await compartida`SELECT token, sign, expira FROM "ArcaTicket" WHERE servicio = ${servicio}`;
    return r || null;
  }
  const [row] = await sql`SELECT value FROM settings WHERE key = ${claveTicket(servicio)}`;
  try { return row && JSON.parse(row.value); } catch { return null; }
}
async function guardarTicket(servicio, t) {
  if (compartida) {
    await compartida`INSERT INTO "ArcaTicket" (servicio, token, sign, expira, updated_at)
      VALUES (${servicio}, ${t.token}, ${t.sign}, ${new Date(t.expira)}, now())
      ON CONFLICT (servicio) DO UPDATE SET token = EXCLUDED.token, sign = EXCLUDED.sign,
        expira = EXCLUDED.expira, updated_at = now()`;
  } else await setSetting(claveTicket(servicio), JSON.stringify(t));
}
async function borrarTicket(servicio) {
  if (compartida) await compartida`DELETE FROM "ArcaTicket" WHERE servicio = ${servicio}`;
  else await sql`DELETE FROM settings WHERE key = ${claveTicket(servicio)}`;
}

async function ticket(servicio = SERVICIO) {
  const t = await leerTicket(servicio);
  if (vigente(t)) return t;
  const nuevo = await pedirTicket(servicio);
  await guardarTicket(servicio, nuevo);
  return nuevo;
}

/* ---------- WSFEv1 ---------- */

// Errores que significan "el ticket no sirve": se pide otro.
const TICKET_INVALIDO = new Set(['600', '601', '602']);

async function wsfe(metodo, interno, conAuth = true, reintento = true) {
  let auth = '';
  if (conAuth) {
    const t = await ticket();
    auth = '<ar:Auth><ar:Token>' + t.token + '</ar:Token><ar:Sign>' + t.sign + '</ar:Sign><ar:Cuit>' + cuit() + '</ar:Cuit></ar:Auth>';
  }
  const sobre = '<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" xmlns:ar="' + FEV1_NS + '"><soap:Body>' +
    '<ar:' + metodo + '>' + auth + interno + '</ar:' + metodo + '>' +
    '</soap:Body></soap:Envelope>';
  const resp = await post(WSFE_URL, sobre, FEV1_NS + metodo);
  if (conAuth && reintento && errores(resp).some((e) => TICKET_INVALIDO.has(e.codigo))) {
    await borrarTicket(SERVICIO);
    return wsfe(metodo, interno, conAuth, false);
  }
  return resp;
}

async function servidorVivo() {
  return texto(await wsfe('FEDummy', '', false), 'AppServer') === 'OK';
}

// Último número emitido de ese tipo en nuestro punto de venta. Solo lectura.
async function ultimoAutorizado(cbteTipo) {
  const r = await wsfe('FECompUltimoAutorizado',
    '<ar:PtoVta>' + puntoVenta() + '</ar:PtoVta><ar:CbteTipo>' + cbteTipo + '</ar:CbteTipo>');
  const err = errores(r);
  if (err.length) throw new ArcaError(enTexto(err));
  return Number(texto(r, 'CbteNro'));
}

// Un comprobante ya emitido, como lo tiene ARCA. null si no existe. Sirve para
// saber qué pasó si se cortó la conexión en medio de una emisión.
async function consultarComprobante(cbteTipo, numero) {
  const r = await wsfe('FECompConsultar',
    '<ar:FeCompConsReq><ar:CbteTipo>' + cbteTipo + '</ar:CbteTipo><ar:CbteNro>' + numero +
    '</ar:CbteNro><ar:PtoVta>' + puntoVenta() + '</ar:PtoVta></ar:FeCompConsReq>');
  const err = errores(r);
  if (err.some((e) => e.codigo === '602')) return null;
  if (err.length) throw new ArcaError('ARCA no pudo consultar el comprobante: ' + enTexto(err));
  return {
    cae: texto(r, 'CodAutorizacion'),
    caeVence: fechaDeArca(texto(r, 'FchVto')),
    total: Number(texto(r, 'ImpTotal')),
    resultado: texto(r, 'Resultado'),
  };
}

const importe = (n) => Number(n).toFixed(2);

// El detalle para ARCA. El orden de los campos lo impone el WSDL. Factura C:
// no discrimina IVA, el neto es el total y no lleva bloque <Iva>.
// d = { cbteTipo, numero, fecha, docTipo, docNro, condIva, total, asociado? }
// asociado = { tipo, numero, fecha } (la factura que anula una nota de crédito)
function armarPedidoCAE(d) {
  const asoc = d.asociado
    ? '<ar:CbtesAsoc><ar:CbteAsoc><ar:Tipo>' + d.asociado.tipo + '</ar:Tipo><ar:PtoVta>' + puntoVenta() +
      '</ar:PtoVta><ar:Nro>' + d.asociado.numero + '</ar:Nro><ar:Cuit>' + cuit() + '</ar:Cuit>' +
      '<ar:CbteFch>' + String(d.asociado.fecha).replace(/-/g, '').slice(0, 8) + '</ar:CbteFch></ar:CbteAsoc></ar:CbtesAsoc>'
    : '';
  return '<ar:FeCAEReq><ar:FeCabReq>' +
    '<ar:CantReg>1</ar:CantReg><ar:PtoVta>' + puntoVenta() + '</ar:PtoVta><ar:CbteTipo>' + d.cbteTipo + '</ar:CbteTipo>' +
    '</ar:FeCabReq><ar:FeDetReq><ar:FECAEDetRequest>' +
    '<ar:Concepto>1</ar:Concepto>' +
    '<ar:DocTipo>' + d.docTipo + '</ar:DocTipo><ar:DocNro>' + (d.docTipo === DOC.SIN_IDENTIFICAR ? 0 : soloDigitos(d.docNro)) + '</ar:DocNro>' +
    '<ar:CbteDesde>' + d.numero + '</ar:CbteDesde><ar:CbteHasta>' + d.numero + '</ar:CbteHasta>' +
    '<ar:CbteFch>' + diaArca(d.fecha) + '</ar:CbteFch>' +
    '<ar:ImpTotal>' + importe(d.total) + '</ar:ImpTotal><ar:ImpTotConc>0.00</ar:ImpTotConc>' +
    '<ar:ImpNeto>' + importe(d.total) + '</ar:ImpNeto><ar:ImpOpEx>0.00</ar:ImpOpEx>' +
    '<ar:ImpTrib>0.00</ar:ImpTrib><ar:ImpIVA>0.00</ar:ImpIVA>' +
    '<ar:MonId>PES</ar:MonId><ar:MonCotiz>1</ar:MonCotiz>' +
    '<ar:CondicionIVAReceptorId>' + d.condIva + '</ar:CondicionIVAReceptorId>' +
    asoc +
    '</ar:FECAEDetRequest></ar:FeDetReq></ar:FeCAEReq>';
}

// ⚠ EMITE UN COMPROBANTE REAL. Devuelve lo que contestó ARCA, sin interpretarlo.
async function solicitarCAE(d) {
  const r = await wsfe('FECAESolicitar', armarPedidoCAE(d));
  return {
    aprobada: texto(r, 'Resultado') === 'A',
    cae: texto(r, 'CAE'),
    caeVence: fechaDeArca(texto(r, 'CAEFchVto')),
    errores: errores(r),
    observaciones: observaciones(r),
  };
}

/* ---------- Padrón: quién es un CUIT ---------- */

// Nombre, domicilio y condición frente al IVA de un CUIT, según ARCA.
// cond_iva: 6 monotributo, 1 responsable inscripto, 4 exento, 5 consumidor final.
// Si el certificado no tiene habilitado el servicio, tira ArcaError('SIN_PADRON').
async function consultarPadron(cuitCliente) {
  const n = soloDigitos(cuitCliente);
  if (n.length !== 11) throw new ArcaError('El CUIT tiene que tener 11 números');
  const pedir = async (reintento) => {
    const t = await ticket(PADRON);
    const sobre = '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:a5="http://a5.soap.ws.server.puc.sr/">' +
      '<soapenv:Header/><soapenv:Body><a5:getPersona_v2>' +
      '<token>' + t.token + '</token><sign>' + t.sign + '</sign>' +
      '<cuitRepresentada>' + cuit() + '</cuitRepresentada><idPersona>' + n + '</idPersona>' +
      '</a5:getPersona_v2></soapenv:Body></soapenv:Envelope>';
    const r = await post(PADRON_URL, sobre, '', 15000);
    const falla = texto(r, 'faultstring');
    if (falla && reintento && /token|sign|expir/i.test(falla)) { await borrarTicket(PADRON); return pedir(false); }
    if (falla) {
      if (/no existe|inexistente/i.test(falla)) throw new ArcaError('Ese CUIT no existe en ARCA');
      throw new ArcaError('ARCA: ' + desescapar(falla));
    }
    return r;
  };
  const r = await pedir(true);
  const generales = texto(r, 'datosGenerales') || '';
  const nombre = texto(generales, 'razonSocial') ||
    [texto(generales, 'apellido'), texto(generales, 'nombre')].filter(Boolean).join(' ');
  const dom = texto(generales, 'domicilioFiscal') || '';
  const domicilio = [texto(dom, 'direccion'), texto(dom, 'localidad'), texto(dom, 'descripcionProvincia')].filter(Boolean).join(', ');
  const impuestos = [...String(texto(r, 'datosRegimenGeneral') || '').matchAll(/<idImpuesto>(\d+)<\/idImpuesto>/g)].map((m) => m[1]);
  let condIva = 5;
  if (texto(r, 'datosMonotributo')) condIva = 6;
  else if (impuestos.includes('30')) condIva = 1;
  else if (impuestos.includes('32')) condIva = 4;
  // Inicio de actividades: el período (AAAAMM) más viejo de sus impuestos
  // (monotributo o IVA). ARCA no da el día, solo mes y año.
  const periodos = [...String(r).matchAll(/<periodo>(\d{6})<\/periodo>/g)].map((m) => m[1]).sort();
  const inicio = periodos.length ? periodos[0].slice(4) + '/' + periodos[0].slice(0, 4) : '';
  const categoria = texto(texto(r, 'datosMonotributo') || '', 'descripcionCategoria');
  const errorConstancia = texto(r, 'errorConstancia');
  return { cuit: n, nombre: desescapar(nombre), domicilio: desescapar(domicilio), cond_iva: condIva,
           inicio, categoria: categoria ? desescapar(categoria) : null,
           aviso: errorConstancia ? desescapar(texto(errorConstancia, 'error') || '') : null };
}

// Qué documento mandar según lo que cargó el cliente en "DNI/CUIT".
function documentoDe(dniCuit) {
  const n = soloDigitos(dniCuit);
  if (n.length === 11) return { docTipo: DOC.CUIT, docNro: n };
  if (n.length >= 7 && n.length <= 8) return { docTipo: DOC.DNI, docNro: n };
  return { docTipo: DOC.SIN_IDENTIFICAR, docNro: '0' };
}

// La URL del QR obligatorio (RG 4892).
function urlQR(f) {
  const datos = {
    ver: 1, fecha: f.fecha instanceof Date ? f.fecha.toISOString().slice(0, 10) : String(f.fecha).slice(0, 10), cuit: Number(cuit()),
    ptoVta: f.pto_vta, tipoCmp: f.tipo, nroCmp: f.numero, importe: Number(f.total),
    moneda: 'PES', ctz: 1, tipoDocRec: f.doc_tipo, nroDocRec: Number(soloDigitos(f.doc_nro) || 0),
    tipoCodAut: 'E', codAut: Number(f.cae),
  };
  return 'https://www.afip.gob.ar/fe/qr/?p=' + Buffer.from(JSON.stringify(datos)).toString('base64');
}

module.exports = {
  HOMOLOGACION, TIPOS, DOC, IVA_RECEPTOR, ArcaError,
  cuit, puntoVenta, faltaConfigurar, servidorVivo, ultimoAutorizado,
  consultarComprobante, solicitarCAE, documentoDe, urlQR, enTexto, consultarPadron,
};
