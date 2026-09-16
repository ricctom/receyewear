// PDF del pedido para el cliente: el mismo detalle que "PDF cliente" del panel
// (admin.html), pero armado en el servidor para mandarlo adjunto en el mail.
// Devuelve un Buffer. Si algo falla, quien lo llama sigue sin el adjunto.
const PDFDocument = require('pdfkit');

// Las fuentes estándar del PDF no tienen todos los signos: se usan los que sí.
const plata = (n) => '$' + String(Math.round(Number(n) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, '.');

// "Metal Receta Diseño (MS18)" -> { linea:'Metal Receta Diseño', modelo:'MS18' }
function splitNombre(name) {
  const s = String(name || '').trim();
  const m = s.match(/^(.*?)\s*\(([^)]+)\)\s*$/);
  if (m) return { linea: m[1].trim() || 'Sin línea', modelo: m[2].trim() };
  return { linea: s || 'Sin línea', modelo: '' };
}

// Agrupa los items por línea, igual que porLinea() del panel.
function porLinea(items) {
  const m = new Map();
  (items || []).forEach((it) => {
    const { linea, modelo } = splitNombre(it.name);
    if (!m.has(linea)) m.set(linea, { linea, total: 0, modelos: [] });
    const g = m.get(linea);
    const qty = Math.max(1, parseInt(it.qty, 10) || 1);
    const price = Number(it.price) || 0;
    g.total += qty * price;
    g.modelos.push({ modelo: it.sku || modelo || '-', color: it.color || '-', qty, price });
  });
  return [...m.values()].sort((a, b) => b.total - a.total);
}

function pedidoPdf(order, user, items, ship) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'A4', margin: 40, info: { Title: 'Pedido #' + order.id } });
      const partes = [];
      doc.on('data', (c) => partes.push(c));
      doc.on('end', () => resolve(Buffer.concat(partes)));
      doc.on('error', reject);

      const X = 40, W = doc.page.width - 80;
      const fondo = doc.page.height - 50;
      // Columnas de la tabla: Modelo · Color · Cant. · Precio u. · Subtotal
      const col = { modelo: X, color: X + 150, cant: X + 300, precio: X + 355, sub: X + 435 };
      const anchoNum = { cant: 45, precio: 75, sub: W - 435 };

      const sh = ship || {};
      const dir = sh.direccion || {};
      const fecha = new Date(order.created_at || Date.now())
        .toLocaleDateString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' });

      /* ----- encabezado ----- */
      doc.font('Helvetica-Bold').fontSize(18).fillColor('#111').text('PEDIDO #' + order.id, X, 40);
      doc.font('Helvetica').fontSize(10).fillColor('#555').text('REC Eyewear · ' + fecha);
      doc.moveTo(X, doc.y + 6).lineTo(X + W, doc.y + 6).lineWidth(1.5).strokeColor('#111').stroke();
      doc.y += 16;

      /* ----- cliente ----- */
      const lineasCli = [
        [sh.razon_social || user.name || '-', sh.dni_cuit ? 'DNI/CUIT ' + sh.dni_cuit : ''].filter(Boolean).join(' · '),
        [dir.texto, dir.piso].filter(Boolean).join(' · '),
        [sh.telefono, user.email].filter(Boolean).join(' · '),
      ].filter(Boolean);
      const altoCli = 14 + lineasCli.length * 14;
      const yCli = doc.y;
      doc.roundedRect(X, yCli, W, altoCli, 5).fillAndStroke('#f5f5f5', '#e2e2e2');
      doc.fillColor('#111').fontSize(10);
      lineasCli.forEach((l, i) => {
        doc.font(i === 0 ? 'Helvetica-Bold' : 'Helvetica').text(l, X + 10, yCli + 8 + i * 14, { width: W - 20 });
      });
      doc.y = yCli + altoCli + 14;

      const saltoSiHace = (alto) => { if (doc.y + alto > fondo) { doc.addPage(); doc.y = 40; } };
      const cabeceraTabla = () => {
        const y = doc.y;
        doc.font('Helvetica').fontSize(8).fillColor('#666');
        doc.text('MODELO', col.modelo, y);
        doc.text('COLOR', col.color, y);
        doc.text('CANT.', col.cant, y, { width: anchoNum.cant, align: 'right' });
        doc.text('PRECIO U.', col.precio, y, { width: anchoNum.precio, align: 'right' });
        doc.text('SUBTOTAL', col.sub, y, { width: anchoNum.sub, align: 'right' });
        doc.moveTo(X, y + 12).lineTo(X + W, y + 12).lineWidth(0.5).strokeColor('#bbb').stroke();
        doc.y = y + 17;
      };

      /* ----- una tabla por línea ----- */
      porLinea(items).forEach((g) => {
        saltoSiHace(60);
        const y = doc.y;
        doc.font('Helvetica-Bold').fontSize(11).fillColor('#111').text(g.linea, X, y, { width: W - 120 });
        doc.text(plata(g.total), X + W - 120, y, { width: 120, align: 'right' });
        doc.moveTo(X, doc.y + 2).lineTo(X + W, doc.y + 2).lineWidth(0.5).strokeColor('#ccc').stroke();
        doc.y += 7;
        cabeceraTabla();
        g.modelos.forEach((m) => {
          if (doc.y + 16 > fondo) { doc.addPage(); doc.y = 40; cabeceraTabla(); }
          const yf = doc.y;
          doc.font('Helvetica').fontSize(9.5).fillColor('#111');
          doc.text(m.modelo, col.modelo, yf, { width: 145, lineBreak: false, ellipsis: true });
          doc.text(m.color, col.color, yf, { width: 145, lineBreak: false, ellipsis: true });
          doc.text(String(m.qty), col.cant, yf, { width: anchoNum.cant, align: 'right' });
          doc.text(plata(m.price), col.precio, yf, { width: anchoNum.precio, align: 'right' });
          doc.text(plata(m.price * m.qty), col.sub, yf, { width: anchoNum.sub, align: 'right' });
          doc.moveTo(X, yf + 13).lineTo(X + W, yf + 13).lineWidth(0.3).strokeColor('#eee').stroke();
          doc.y = yf + 17;
        });
        doc.y += 8;
      });

      /* ----- totales ----- */
      const descuento = Number(order.descuento) || 0;
      const total = Number(order.total) || 0;
      saltoSiHace(90);
      doc.moveTo(X, doc.y).lineTo(X + W, doc.y).lineWidth(1.5).strokeColor('#111').stroke();
      doc.y += 10;
      const filaTotal = (txt, monto, fuerte) => {
        const y = doc.y;
        doc.font(fuerte ? 'Helvetica-Bold' : 'Helvetica').fontSize(fuerte ? 14 : 11).fillColor('#111');
        doc.text(txt, X, y);
        doc.text(monto, X + W - 160, y, { width: 160, align: 'right' });
        doc.y = y + (fuerte ? 20 : 16);
      };
      if (descuento > 0) {
        filaTotal('Subtotal', plata(total + descuento));
        filaTotal('Cupón de descuento', '-' + plata(descuento));
        doc.y += 2;
      }
      filaTotal('Total', plata(total), true);

      doc.moveDown(2);
      doc.font('Helvetica').fontSize(8.5).fillColor('#888')
        .text('Precios en pesos. Este comprobante no es factura.', X, doc.y, { width: W, align: 'center' });

      doc.end();
    } catch (e) { reject(e); }
  });
}

module.exports = { pedidoPdf };
