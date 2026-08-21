// Datos iniciales que se cargan UNA sola vez (si la tabla está vacía).
// Vienen de la planilla "Cta. Cte Martin" (Google Sheets), migrada el 20/8/2026.

// Lista de precios del proveedor, en dólares.
const PRECIOS = [
  ['ACETATO DISEÑO', 12.00],
  ['TR90 DAMA - CABALLERO', 4.00],
  ['LAVANETT', 8.50],
  ['METAL FINO', 8.00],
  ['CLIPON', 12.00],
  ['RUBBER NYLON', 5.00],
  ['RUNFLEX', 6.50],
  ['POLARIZADOS', 6.50],
  ['NYLON SOL', 11.00],
  ['CLIPPER', 9.00],
  ['VINCHAS', 12.00],
  ['DEPORTIVO 5 PLACAS', 14.00],
  ['ECONOMICOS PASTA', 2.05],
  ['ECONOMICOS METAL', 2.05],
  ['CLIPON RUNFLEX', 15.00],
];

// Cuenta corriente: cada PEDIDO lleva el detalle de la planilla cuando lo tenía.
// monto_usd positivo = me entregó mercadería (sube la deuda).
// monto_usd negativo = le pagué (baja la deuda).
const MOVIMIENTOS = [
  { fecha: '2026-04-20', tipo: 'PEDIDO', monto: 352.00, items: [
    ['METAL FINO', 38, 8.00], ['TR90 DAMA - CABALLERO', 12, 4.00] ] },
  { fecha: '2026-05-04', tipo: 'PEDIDO', monto: 220.00, items: [
    ['TR90 DAMA - CABALLERO', 30, 4.00], ['RUBBER NYLON', 20, 5.00] ] },
  { fecha: '2026-05-04', tipo: 'PAGO', monto: -300.00, items: [] },
  { fecha: '2026-05-15', tipo: 'PAGO', monto: -200.00, items: [] },
  { fecha: '2026-05-15', tipo: 'PEDIDO', monto: 360.00, items: [
    ['ACETATO DISEÑO', 30, 12.00] ] },
  { fecha: '2026-05-20', tipo: 'PEDIDO', monto: 898.00, items: [
    ['METAL FINO', 46, 8.00], ['CLIPON', 10, 12.00], ['ECONOMICOS METAL', 200, 2.05] ] },
  { fecha: '2026-06-01', tipo: 'PAGO', monto: -700.00, items: [] },
  { fecha: '2026-06-09', tipo: 'PAGO', monto: -600.00, items: [] },
  { fecha: '2026-06-09', tipo: 'PEDIDO', monto: 288.00, items: [
    ['ACETATO DISEÑO', 6, 12.00], ['CLIPON', 6, 12.00], ['METAL FINO', 18, 8.00] ] },
  { fecha: '2026-06-16', tipo: 'PEDIDO', monto: 1025.00, items: [], detalle: 'Sin detalle en la planilla' },
  { fecha: '2026-06-29', tipo: 'PEDIDO', monto: 293.50, items: [
    ['ACETATO DISEÑO', 6, 12.00], ['LAVANETT', 11, 8.50], ['RUNFLEX', 10, 6.50],
    ['RUBBER NYLON', 3, 5.00], ['TR90 DAMA - CABALLERO', 12, 4.00] ] },
  { fecha: '2026-06-29', tipo: 'PAGO', monto: -1344.45, items: [] },
  { fecha: '2026-07-06', tipo: 'PEDIDO', monto: 200.00, items: [
    ['TR90 DAMA - CABALLERO', 8, 4.00], ['CLIPON', 14, 12.00] ] },
  { fecha: '2026-07-20', tipo: 'PAGO', monto: -300.00, items: [] },
  { fecha: '2026-07-20', tipo: 'PEDIDO', monto: 581.50, items: [
    ['CLIPON', 8, 12.00], ['METAL FINO', 24, 8.00], ['TR90 DAMA - CABALLERO', 16, 4.00],
    ['RUBBER NYLON', 10, 5.00], ['RUNFLEX', 11, 6.50], ['ACETATO DISEÑO', 9, 12.00] ] },
  { fecha: '2026-07-31', tipo: 'PAGO', monto: -700.00, items: [] },
  { fecha: '2026-07-31', tipo: 'PEDIDO', monto: 1084.00, items: [
    ['METAL FINO', 51, 8.00], ['TR90 DAMA - CABALLERO', 13, 4.00],
    ['CLIPON', 12, 12.00], ['CLIPON RUNFLEX', 32, 15.00] ] },
  { fecha: '2026-08-05', tipo: 'PEDIDO', monto: 228.50, items: [
    ['METAL FINO', 8, 8.00], ['LAVANETT', 1, 8.50], ['ACETATO DISEÑO', 4, 12.00],
    ['CLIPON RUNFLEX', 1, 15.00], ['POLARIZADOS', 8, 6.50], ['CLIPON', 3, 12.00],
    ['RUBBER NYLON', 1, 5.00] ] },
  { fecha: '2026-08-05', tipo: 'PAGO', monto: -900.00, items: [] },
];

// Consignación: cantidad positiva = me la dejó, negativa = se la devolví o se la pagué.
const CONSIGNACION = [
  ['2026-04-20', 'CLIPON', 30, 12.00, ''],
  ['2026-04-20', 'METAL FINO', 30, 8.00, ''],
  ['2026-04-20', 'TR90 DAMA - CABALLERO', 15, 4.00, 'TR DAMA'],
  ['2026-04-20', 'LAVANETT', 15, 8.50, ''],
  ['2026-04-20', 'RUNFLEX', 15, 6.50, ''],
  ['2026-04-20', 'RUBBER NYLON', 15, 5.00, ''],
  ['2026-04-20', 'ACETATO DISEÑO', 15, 12.00, ''],
  ['2026-05-04', 'DEPORTIVO 5 PLACAS', 10, 14.00, ''],
  ['2026-05-15', 'DEPORTIVO 5 PLACAS', 10, 10.00, 'Muestras'],
  ['2026-07-06', 'TR90 DAMA - CABALLERO', 30, 4.00, ''],
  ['2026-07-06', 'POLARIZADOS', 20, 6.50, 'Sol polarizado'],
  ['2026-07-31', 'DEPORTIVO 5 PLACAS', -2, 14.00, 'Pagados'],
  ['2026-07-31', 'DEPORTIVO 5 PLACAS', -8, 14.00, 'Devueltos'],
  ['2026-07-31', 'DEPORTIVO 5 PLACAS', -10, 14.00, 'Muestras devueltas'],
];

// Mapa: línea de la web -> artículo del proveedor. El "factor" son las unidades
// que trae ese ítem (los packs de económicos vienen de a 50, 100 o 500).
const COSTOS = [
  ['metal receta diseno', 'METAL FINO', 1],
  ['una placa', 'CLIPON', 1],
  ['clipon tr90', 'CLIPON', 1],
  ['acetato laminado', 'ACETATO DISEÑO', 1],
  ['polarizados', 'POLARIZADOS', 1],
  ['clipper polarizados', 'CLIPPER', 1],
  ['tr90 caballero', 'TR90 DAMA - CABALLERO', 1],
  ['runflex kids', 'RUNFLEX', 1],
  ['rubbers kids', 'RUBBER NYLON', 1],
  ['lavanett', 'LAVANETT', 1],
  ['clipon runflex', 'CLIPON RUNFLEX', 1],
  ['lentes de sol halo con 5 placas intercambiables', 'DEPORTIVO 5 PLACAS', 1],
  ['pack x500 plasticos surtidos', 'ECONOMICOS PASTA', 500],
  ['pack x500 metalicos surtidos', 'ECONOMICOS METAL', 500],
  ['pack x100 plasticos surtidos', 'ECONOMICOS PASTA', 100],
  ['pack x100 metalicos surtidos', 'ECONOMICOS METAL', 100],
  ['pack x50 plasticos surtidos', 'ECONOMICOS PASTA', 50],
  ['pack x50 metalicos surtidos', 'ECONOMICOS METAL', 50],
];

module.exports = { PRECIOS, MOVIMIENTOS, CONSIGNACION, COSTOS };
