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
| `milver_orders` / `milver_order_items` | pedidos |
| `milver_settings` | `web_order_discount` (0.02) |
| RPC `milver_login` | login nombre + PIN |
| RPC `milver_catalogo` | catálogo entero en un jsonb (evita tope 1000 filas) |
| RPC `milver_clientes_list` | cartera del comisionista (exige PIN) |
| RPC `milver_surtido` | surtido de un cliente de la cartera |
| RPC `milver_submit_order` | alta de pedido; precios recalculados server-side |
| RPC `milver_historial` | últimos 50 pedidos del comisionista |

Las tablas tienen RLS sin policies (sin acceso directo por REST); todo pasa
por las RPC. `sql/milver.sql` recrea el esquema completo desde cero.

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

## Lógica de precios (igual que LK)

`list_price` es **por unidad**; la cantidad se carga en **cajas** (`uxb`
unidades por caja). Neto por unidad:

```
neto = list_price × (1 − dto_vol del cliente) × (1 − web_order_discount)
```

El servidor recalcula todo en `milver_submit_order` — el navegador solo manda
`[{cod, cajas}]`.

## Correr local

Abrir `index.html` en un navegador o servir la carpeta con cualquier server
estático (`python -m http.server`). No hay build.
