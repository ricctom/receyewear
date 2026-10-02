# Facturación en ARCA (Factura C)

El panel de pedidos factura con el CUIT de Tomás (monotributo, Factura C).

## Cómo se usa

- **Cada cobro dice cómo entró.** Al cargarlo se elige el medio y si va **en blanco**:
  - Transferencia, Mercado Pago, Cheque y Echeq quedan en blanco de entrada.
  - Efectivo y Dólares quedan en negro.
  - La etiqueta del cobro se puede tocar para cambiarlo.
- **Dólares.** Se cargan los US$ y la cotización. Al pedido se le descuenta el equivalente en pesos y queda guardado que fueron dólares.
- **Facturar.** En un pedido con cobros en blanco sin facturar aparece el botón *Facturar $X*.
  - Se eligen los cobros, el nombre, el CUIT o DNI y la condición de IVA del cliente, y sale **una** Factura C por la suma.
  - Cada cobro queda atado a esa factura, así no se factura dos veces.
- **Anular.** Emite una Nota de crédito C por el total, y los cobros quedan otra vez sin facturar.
- **Facturación** (botón de arriba) muestra, por mes, cuánto entró en blanco, cuánto se facturó, cuánto falta facturar, cuánto entró en negro y cuánto en dólares. También muestra lo facturado en los últimos 12 meses, que es lo que mira ARCA para la categoría del monotributo, y ahí se cargan los datos que salen impresos en la factura.

## Puesta en marcha (una sola vez)

Se usa **el mismo certificado** del sistema de ópticas (alias `visionline`, a tu nombre).
ARCA da un pase de 12 horas por certificado, así que REC comparte ese pase con
el sistema de ópticas leyéndolo de su base: no se piden dos.

1. En ARCA, en **ABM Puntos de Venta**, crear (si no lo tenés) un punto de venta
   **"Factura Electrónica - Monotributo - Web Services"** para tu CUIT. El que usás
   para facturar a mano en la web no sirve para esto.
2. En ARCA, **Administrador de Relaciones**: verificar que el computador fiscal
   `visionline` tenga el servicio **Facturación Electrónica** para tu propio CUIT
   (si el sistema de ópticas ya factura para las ópticas, ya lo tiene).
3. En Vercel, en el proyecto de REC (Settings → Environment Variables), cargar:
   - `ARCA_CERT` y `ARCA_KEY`: los mismos valores que tiene el proyecto de ópticas.
   - `ARCA_TICKET_DB_URL`: la `DATABASE_URL` del proyecto de ópticas.
   - `ARCA_CUIT`: tu CUIT.
   - `ARCA_PUNTO_VENTA`: el número del punto de venta del paso 1.
4. Volver a publicar y, en el panel, **Facturación → Probar conexión con ARCA**.
