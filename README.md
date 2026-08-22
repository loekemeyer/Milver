# Milver — Portal de carga de pedidos

Página de venta para que los **comisionistas de Milver** carguen pedidos.
Copia la estructura del portal mayorista de Loekemeyer (`pagina-LK-copia`):
sitio estático sin build step, JS global que habla directo con Supabase,
mismas convenciones (`showSection`, carrito en cajas, precio lista por unidad).

## Catálogo demo

- **5.000 ítems** con códigos `1` a `5000`, inventados en forma determinística.
- **250 artículos madre con 4 variantes de color cada uno** = 1.000 ítems
  variante (cods `1`–`1000`, en grupos de 4 consecutivos; `madre_cod`
  `M001`–`M250`).
- **4.000 artículos simples** (cods `1001`–`5000`).
- Sin fotos: las cards muestran cod, descripción, UxB y precio de lista; los
  artículos madre listan sus variantes en filas con cantidad propia.

## Artículos que Milver le compra a Loekemeyer

Milver S.R.L es el **cliente 2288** del padrón LK. Sus 76 artículos comprados
(reales: abrelatas, peladores, sacacorchos…) están en el catálogo con cod
`L`+<cod LK> (ej. `L506`), categoría **Loekemeyer**, chip azul "LOEKE", y
salen **primero** en el listado, ordenados por volumen comprado. La carga fue
una lectura puntual de `sales_lines`/`orders` de LK — ninguna pantalla toca
tablas LK en vivo.

El buscador matchea **código exacto** cuando se tipea un código (`506`
encuentra `L506` y el `506` demo; `12` no trae `512`) y por **descripción**
en cualquier otro caso.

## Pantalla de Inicio (dashboard del comisionista)

Al loguearse, el comisionista cae en **Inicio** con:
- Dos accesos grandes: **Cargar nuevo pedido** y **Ver pedidos anteriores**.
- Tarjetas de **esta semana**, **este mes**, clientes activos e histórico.
- Mini-gráfico de barras de ventas de los últimos 8 días.
- Top 5 clientes del mes.

El **Historial** suma filtro por cliente (buscador + desplegable). Datos
desde la RPC `milver_stats` (todo acotado a los pedidos del comisionista).

## Comisionistas y carteras

La página NO es para el cliente final: la usa el **comisionista**, que carga
pedidos para SUS clientes (misma idea que los vendedores del portal LK).
Hay 5 comisionistas genéricos (los nombres reales todavía no están) y
**500 clientes demo, 100 por comisionista** en bloques:
Comisionista 1 → C001–C100, Comisionista 2 → C101–C200, etc.
Cada RPC valida que el cliente sea de la cartera del comisionista logueado.

`milver_cliente_surtido` guarda **qué ítems le compra cada cliente** (~40 por
cliente, demo). Al elegir cliente, el catálogo marca esos artículos con borde
verde + badge "★ Te compra" (y la variante exacta con ★), los ordena primero,
y el botón "Solo lo que compra" filtra el catálogo a su surtido.

Cada pedido se puede **descargar en PDF** (jsPDF) desde la confirmación y
desde el historial: encabezado Milver, número, cliente, comisionista,
tabla de ítems y total.

## Backend (Supabase)

Vive **en el proyecto Supabase de LK** (`kwkclwhmoygunqmlegrg`), pero TODO lo
de Milver lleva prefijo **`milver_`** y es **100% independiente**: no toca ni
lee ninguna tabla, vista, RPC o página del sitio LK — solo comparte el
proyecto para no pagar otro. Para identificarlo/transferirlo:

| Objeto | Rol |
|---|---|
| `milver_products` | catálogo (5.000 filas) |
| `milver_comisionistas` | usuarios con PIN |
| `milver_clientes` | 500 clientes demo, 100 por comisionista (`comisionista_id`) |
| `milver_cliente_surtido` | ítems que cada cliente le compra (~40 c/u) |
| `milver_orders` / `milver_order_items` | pedidos (con `estado` y `costo_unit`) |
| `milver_order_eventos` | eventos de armado por operario |
| `milver_settings` | `web_order_discount` = 0 (Milver no aplica el descuento web de LK) |
| RPC `milver_login` | login nombre + PIN |
| RPC `milver_catalogo` | catálogo entero en un jsonb (evita tope 1000 filas) |
| RPC `milver_clientes_list` | cartera del comisionista (exige PIN) |
| RPC `milver_surtido` | surtido de un cliente de la cartera |
| RPC `milver_submit_order` | alta de pedido; precios recalculados server-side |
| RPC `milver_historial` | últimos 50 pedidos del comisionista |
| `milver_ventas` | histórico de compras importado; de acá se deriva el surtido real |
| `milver_login_intentos` | intentos de login (rate limit: 8 fallos / 10 min) |
| RPCs `milver_admin_*` | panel admin: pedidos, stats, ganancias, importadores, ABM, carteras |
| RPCs `milver_dep_*` | depósito: login, cola de pedidos, eventos de armado |

Las tablas tienen RLS sin policies (sin acceso directo por REST); todo pasa
por las RPC. Los **PINs se guardan hasheados con bcrypt** (pgcrypto) y el
login tiene **rate limit** (8 fallos en 10 minutos bloquea).
`sql/milver.sql` recrea el esquema completo desde cero.

## Costos y ganancias (acceso maestro)

`milver_products.cost` = costo por unidad (demo: **mitad del precio de
venta**; el importador de catálogo acepta una columna `costo` real, y si
falta asume el 50%). Cada línea de pedido snapshotea `costo_unit`, así el
histórico no se mueve si cambia el costo después.

El **panel admin** (PIN maestro) tiene la pestaña **Ganancias**: venta,
costo, ganancia y margen **por día** y **por pedido**, con tarjetas de
"hoy" y del período elegido.

## Depósito (`milver-deposito.html`)

Botonera para los operarios que arman pedidos, calcada del patrón de
Producción Virgilio. PIN de depósito propio (demo **2468**) + nombre del
operario. Cola de pedidos entrantes en orden de llegada; al abrir uno, la
botonera de 3 pasos con guarda de estado:

| Botón | Acción | Pasa a |
|---|---|---|
| EA (azul) | Empezar armado | en_armado |
| TA (verde) | Armado listo | armado |
El armado es **picking ítem por ítem**: al abrir un pedido, el operario ve
la lista de artículos y marca cada uno como **juntado** (cantidad, que
puede ser parcial) o **faltante / sin stock**, con un teclado propio.
Una barra de progreso muestra cuántos ítems lleva. Estados del pedido:
`nuevo → en_picking → pickeado → despachado`. El botón **Pickeado listo**
solo se habilita cuando todos los ítems tienen decisión; después
**Despachar** lo saca. Cada línea guarda cantidad juntada, faltante,
operario y hora (`pick_unidades`, `pick_falta`, `pick_por`, `pick_at`);
cada transición queda en `milver_order_eventos`. Los pedidos del portal
caen solos en la cola como `nuevo` y se van programando al llegar.

## Panel de administración (`milver-admin.html`)

PIN demo: **9999**. Pestañas:

| Pestaña | Qué hace |
|---|---|
| Resumen | contadores + clientes por comisionista |
| Pedidos | lista con detalle, filtro por fecha, **descarga Excel** (hojas Pedidos + Detalle) |
| Catálogo | **importador Excel** (upsert por cod; opción de desactivar faltantes; planilla modelo) |
| Clientes | ABM, buscador, importador Excel, **asignación masiva de carteras** |
| Comisionistas | alta, renombrar, cambiar PIN, activar/desactivar |
| Ventas | **importador Excel de ventas**; reconstruye el surtido real de cada cliente del archivo |
| Ganancias | venta/costo/ganancia por día y por pedido, con **descarga Excel** |
| Análisis | **ranking de productos más pedidos** y **comparativo por comisionista** (pedidos, clientes, venta, ganancia, margen, ticket promedio) en un rango, cada uno con descarga Excel |

La pestaña **Catálogo** además permite **editar precio y costo** de un
producto: buscador por código/descripción y edición inline (el margen se
recalcula al guardar). RPCs: `milver_admin_ranking_productos`,
`milver_admin_comparativo`, `milver_admin_set_precio`,
`milver_admin_productos`.

El importador detecta columnas por NOMBRE de encabezado (flexible: `cod`/`codigo`,
`precio`/`list_price`, etc.), nunca por posición — lección aprendida del
importador de listas de súper de LK.

**Para transferir a Milver**: crear su proyecto Supabase, correr
`sql/milver.sql`, y en `script.js` cambiar `SUPABASE_URL` + `SUPABASE_ANON_KEY`.

## Usuarios demo

| Comisionista | PIN | Cartera |
|---|---|---|
| Comisionista 1 | 1111 | C001–C100 |
| Comisionista 2 | 2222 | C101–C200 |
| Comisionista 3 | 3333 | C201–C300 |
| Comisionista 4 | 4444 | C301–C400 |
| Comisionista 5 | 5555 | C401–C500 |

## Lógica de precios

**Milver vende POR UNIDAD** (a diferencia de LK, que vende por caja): el
comisionista carga unidades y `list_price` es el precio por unidad. Neto:

```
neto = list_price × (1 − dto_vol del cliente)
```

El servidor recalcula todo en `milver_submit_order` — el navegador solo manda
`[{cod, unidades}]`.

## Correr local

Abrir `index.html` en un navegador o servir la carpeta con cualquier server
estático (`python -m http.server`). No hay build.
