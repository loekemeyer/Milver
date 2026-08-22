-- ============================================================
-- MILVER — esquema completo (demo). Todo con prefijo milver_.
-- Este archivo recrea desde cero las tablas, datos y RPCs en
-- cualquier proyecto Supabase (hoy corre en el proyecto LK;
-- para transferir a Milver: correr este archivo en su proyecto
-- y migrar los datos de milver_orders / milver_order_items).
-- ============================================================

create extension if not exists pgcrypto with schema extensions;

create table public.milver_products (
  cod         text primary key,
  descripcion text not null,
  categoria   text not null,
  madre_cod   text,            -- 'M001'..'M250' si es variante, null si es simple
  madre_desc  text,            -- descripción del artículo madre (sin la variante)
  variante    text,            -- color de la variante, null si es simple
  uxb         integer not null,
  list_price  numeric not null,  -- precio de lista POR UNIDAD (misma convención que LK)
  activo      boolean not null default true
);
create index milver_products_madre_idx on public.milver_products (madre_cod);

create table public.milver_comisionistas (
  id      serial primary key,
  nombre  text not null unique,
  pin     text not null,
  activo  boolean not null default true
);

create table public.milver_clientes (
  cod             text primary key,
  razon_social    text not null,
  dto_vol         numeric not null default 0,
  localidad       text,
  comisionista_id integer references public.milver_comisionistas(id)
);

create table public.milver_settings (
  clave text primary key,
  valor text not null
);

create table public.milver_orders (
  id              bigint generated always as identity primary key,
  comisionista_id integer not null references public.milver_comisionistas(id),
  comisionista    text not null,
  cliente_cod     text not null references public.milver_clientes(cod),
  cliente_nombre  text not null,
  metodo_pago     text,
  observaciones   text,
  subtotal_lista  numeric not null default 0,
  descuento_total numeric not null default 0,
  total           numeric not null default 0,
  created_at      timestamptz not null default now()
);

-- Surtido: qué ítems le compra cada cliente a Milver (para marcarlos en pantalla)
create table public.milver_cliente_surtido (
  cliente_cod text not null references public.milver_clientes(cod) on delete cascade,
  item_cod    text not null references public.milver_products(cod),
  primary key (cliente_cod, item_cod)
);

create table public.milver_order_items (
  id           bigint generated always as identity primary key,
  order_id     bigint not null references public.milver_orders(id) on delete cascade,
  item_cod     text not null,
  descripcion  text not null,
  variante     text,
  cajas        integer not null,
  uxb          integer not null,
  unidades     integer not null,
  precio_lista numeric not null,   -- por unidad
  precio_neto  numeric not null,   -- por unidad, con descuentos
  subtotal     numeric not null    -- precio_neto * unidades
);

-- RLS: sin policies = sin acceso directo por REST; todo pasa por RPC
alter table public.milver_products       enable row level security;
alter table public.milver_comisionistas  enable row level security;
alter table public.milver_clientes       enable row level security;
alter table public.milver_settings       enable row level security;
alter table public.milver_orders         enable row level security;
alter table public.milver_order_items    enable row level security;
alter table public.milver_cliente_surtido enable row level security;

-- ---------- DATOS ----------
insert into public.milver_settings values ('web_order_discount', '0.02');

-- Nombres reales de comisionistas todavía no están: genéricos 1..5, PIN nnnn
-- (hasheado con bcrypt; el PIN en claro es solo el valor inicial de demo)
insert into public.milver_comisionistas (nombre, pin)
select 'Comisionista ' || n, extensions.crypt(repeat(n::text, 4), extensions.gen_salt('bf'))
from generate_series(1, 5) n;

-- PIN del panel de administración (demo: 9999)
insert into public.milver_settings values ('admin_pin_hash', extensions.crypt('9999', extensions.gen_salt('bf')));

-- 500 clientes: C001..C500, en bloques de 100 por comisionista
-- (Comisionista 1 → C001-C100, 2 → C101-C200, etc.)
insert into public.milver_clientes (cod, razon_social, dto_vol, localidad, comisionista_id)
select 'C' || lpad(n::text, 3, '0'),
       (array['Bazar','Regalería','Ferretería','Supermercado','Distribuidora','Almacén','Tienda','Comercial','Mayorista','Casa'])[1 + ((n - 1) % 10)]
         || ' ' ||
       (array['García','López','Martínez','Fernández','Rodríguez','Sosa','Romero','Díaz','Torres','Acosta','Benítez','Medina','Herrera','Aguirre','Molina','Castro','Ríos','Vega','Silva','Ortiz','Núñez','Vargas','Cabrera','Ponce','Luna'])[1 + (((n - 1) / 10) % 25)]
         || (array['',' Hnos.'])[1 + ((n - 1) / 250)],
       (array[0, 0.05, 0.10, 0.15])[1 + ((n - 1) % 4)],
       (array['CABA','Rosario','Córdoba','Mendoza','La Plata','Mar del Plata','Tucumán','Salta','Neuquén','Bahía Blanca','Santa Fe','Paraná','Posadas','San Juan','Resistencia'])[1 + ((n * 3) % 15)],
       1 + ((n - 1) / 100)
from generate_series(1, 500) n;

-- Surtido determinístico: ~40 ítems por cliente
insert into public.milver_cliente_surtido (cliente_cod, item_cod)
select distinct 'C' || lpad(n::text, 3, '0'),
       (1 + ((n * 7919 + i * 104729) % 5000))::text
from generate_series(1, 500) n, generate_series(1, 40) i;

-- Generación determinística de los 5.000 artículos.
-- 250 artículos madre con 4 variantes c/u (cods 1-1000) + 4.000 simples (1001-5000).
-- Combos nombre: 48 tipos × 10 materiales × 15 tamaños = 7.200; se recorren
-- con paso 2647 (coprimo con 7200) para que los consecutivos no se parezcan.
with tipos as (
  select ord, tipo, categoria from (values
    (1,'Tabla de Picar','Cocina'),(2,'Espátula','Cocina'),(3,'Cucharón','Cocina'),
    (4,'Colador','Cocina'),(5,'Sartén','Cocina'),(6,'Cacerola','Cocina'),
    (7,'Fuente','Cocina'),(8,'Bowl','Cocina'),(9,'Rallador','Cocina'),
    (10,'Pelapapas','Cocina'),(11,'Cuchillo Cocina','Cocina'),(12,'Molde Repostería','Cocina'),
    (13,'Escurridor','Cocina'),(14,'Jarra Medidora','Cocina'),(15,'Batidor','Cocina'),
    (16,'Plato','Bazar'),(17,'Vaso','Bazar'),(18,'Taza','Bazar'),
    (19,'Jarra','Bazar'),(20,'Bandeja','Bazar'),(21,'Panera','Bazar'),
    (22,'Frutera','Bazar'),(23,'Azucarera','Bazar'),(24,'Salero','Bazar'),
    (25,'Especiero','Bazar'),(26,'Mate','Bazar'),(27,'Termo','Bazar'),
    (28,'Botella','Bazar'),(29,'Frasco','Bazar'),(30,'Tupper','Bazar'),
    (31,'Balde','Limpieza'),(32,'Palangana','Limpieza'),(33,'Cesto Residuos','Limpieza'),
    (34,'Secador Piso','Limpieza'),(35,'Cepillo','Limpieza'),(36,'Esponjero','Limpieza'),
    (37,'Dispenser Jabón','Limpieza'),(38,'Trapo Rejilla','Limpieza'),
    (39,'Organizador','Organización'),(40,'Canasto','Organización'),(41,'Caja Apilable','Organización'),
    (42,'Perchero','Organización'),(43,'Gancho Multiuso','Organización'),(44,'Zapatero','Organización'),
    (45,'Repasador','Textil'),(46,'Delantal','Textil'),(47,'Mantel','Textil'),(48,'Individual','Textil')
  ) t(ord, tipo, categoria)
),
materiales as (
  select ord, mat from unnest(array['Plástico','Madera','Bambú','Acero Inox','Silicona','Vidrio','Aluminio','Melamina','Polipropileno','Acrílico']) with ordinality x(mat, ord)
),
tamanios as (
  select ord, tam from unnest(array['Chico','Mediano','Grande','XL','Nº1','Nº2','Nº3','Nº4','Nº5','Premium','Reforzado','Clásico','Profesional','Gastronómico','Línea Hogar']) with ordinality x(tam, ord)
),
base as (
  select m as k, 'M' || lpad(m::text, 3, '0') as madre_cod, m as seed, true as es_madre
  from generate_series(1, 250) m
  union all
  select 250 + (cod - 1000) as k, cod::text as madre_cod, cod as seed, false as es_madre
  from generate_series(1001, 5000) cod
),
armado as (
  select b.*,
         ((b.k * 2647) % 7200) as combo,
         t.tipo, t.categoria, mt.mat, tm.tam,
         round((500 + ((b.seed * 7919) % 14501)) / 10.0) * 10 as precio,
         (array[6, 12, 24, 48])[1 + ((b.seed * 31) % 4)] as uxb
  from base b
  join tipos      t  on t.ord  = 1 + (((b.k * 2647) % 7200) % 48)
  join materiales mt on mt.ord = 1 + ((((b.k * 2647) % 7200) / 48) % 10)
  join tamanios   tm on tm.ord = 1 + (((b.k * 2647) % 7200) / 480)
)
insert into public.milver_products (cod, descripcion, categoria, madre_cod, madre_desc, variante, uxb, list_price)
select ((m.seed - 1) * 4 + v.i)::text,
       m.tipo || ' ' || m.mat || ' ' || m.tam || ' - ' || v.color,
       m.categoria,
       m.madre_cod,
       m.tipo || ' ' || m.mat || ' ' || m.tam,
       v.color,
       m.uxb,
       m.precio
from armado m
cross join lateral (
  select i, (array['Rojo','Azul','Verde','Negro','Blanco','Amarillo','Gris','Natural'])[(m.seed % 5) + i] as color
  from generate_series(1, 4) i
) v
where m.es_madre
union all
select m.madre_cod,
       m.tipo || ' ' || m.mat || ' ' || m.tam,
       m.categoria,
       null, null, null,
       m.uxb,
       m.precio
from armado m
where not m.es_madre;

-- ---------- RPCs ----------
create or replace function public.milver_login(p_nombre text, p_pin text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare c record;
begin
  select id, nombre into c
  from milver_comisionistas
  where lower(nombre) = lower(trim(p_nombre)) and pin = trim(p_pin) and activo;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'Nombre o PIN incorrecto');
  end if;
  return jsonb_build_object('ok', true, 'id', c.id, 'nombre', c.nombre);
end $$;

-- Catálogo completo en un solo jsonb (evita el tope de 1000 filas de PostgREST).
create or replace function public.milver_catalogo()
returns jsonb language sql security definer set search_path = public stable as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'cod', cod, 'descripcion', descripcion, 'categoria', categoria,
           'madre_cod', madre_cod, 'madre_desc', madre_desc, 'variante', variante,
           'uxb', uxb, 'list_price', list_price
         ) order by cod::int), '[]'::jsonb)
  from milver_products where activo;
$$;

-- Cartera del comisionista (exige PIN: los 500 clientes no son públicos)
create or replace function public.milver_clientes_list(p_comisionista_id integer, p_pin text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_ok boolean;
begin
  select true into v_ok from milver_comisionistas
   where id = p_comisionista_id and pin = trim(p_pin) and activo;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'Sesión inválida');
  end if;
  return jsonb_build_object('ok', true, 'clientes', coalesce((
    select jsonb_agg(jsonb_build_object(
             'cod', cod, 'razon_social', razon_social, 'dto_vol', dto_vol, 'localidad', localidad
           ) order by cod)
    from milver_clientes where comisionista_id = p_comisionista_id
  ), '[]'::jsonb));
end $$;

-- Surtido del cliente: cods de los ítems que le compra a Milver.
-- Solo para clientes de la cartera del comisionista logueado.
create or replace function public.milver_surtido(p_comisionista_id integer, p_pin text, p_cliente_cod text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_ok boolean;
begin
  select true into v_ok from milver_comisionistas c
   join milver_clientes cl on cl.comisionista_id = c.id and cl.cod = p_cliente_cod
   where c.id = p_comisionista_id and c.pin = trim(p_pin) and c.activo;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'Sesión inválida o cliente ajeno');
  end if;
  return jsonb_build_object('ok', true, 'cods', coalesce((
    select jsonb_agg(item_cod order by item_cod::int)
    from milver_cliente_surtido where cliente_cod = p_cliente_cod
  ), '[]'::jsonb));
end $$;

-- Alta de pedido. Precios se recalculan SERVER-SIDE desde milver_products:
-- neto = list_price * (1 - dto_vol del cliente) * (1 - web_order_discount).
create or replace function public.milver_submit_order(
  p_comisionista_id integer, p_pin text, p_cliente_cod text,
  p_metodo_pago text, p_observaciones text, p_items jsonb
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_com record; v_cli record; v_web numeric; v_order_id bigint;
  v_sub_lista numeric := 0; v_total numeric := 0;
  it record;
begin
  select id, nombre into v_com from milver_comisionistas
   where id = p_comisionista_id and pin = trim(p_pin) and activo;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'Sesión inválida');
  end if;

  select cod, razon_social, dto_vol into v_cli from milver_clientes
   where cod = p_cliente_cod and comisionista_id = v_com.id;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'Cliente inexistente o de otro comisionista');
  end if;

  if p_items is null or jsonb_array_length(p_items) = 0 then
    return jsonb_build_object('ok', false, 'error', 'Pedido vacío');
  end if;

  select coalesce(valor::numeric, 0.02) into v_web
  from milver_settings where clave = 'web_order_discount';
  v_web := coalesce(v_web, 0.02);

  insert into milver_orders (comisionista_id, comisionista, cliente_cod, cliente_nombre, metodo_pago, observaciones)
  values (v_com.id, v_com.nombre, v_cli.cod, v_cli.razon_social, p_metodo_pago, p_observaciones)
  returning id into v_order_id;

  for it in
    select p.cod, p.descripcion, p.variante, p.uxb, p.list_price,
           greatest(1, least(9999, (x->>'cajas')::int)) as cajas
    from jsonb_array_elements(p_items) x
    join milver_products p on p.cod = (x->>'cod') and p.activo
    where coalesce((x->>'cajas')::int, 0) > 0
  loop
    declare
      v_uni integer := it.uxb * it.cajas;
      v_neto numeric := round(it.list_price * (1 - v_cli.dto_vol) * (1 - v_web), 2);
    begin
      insert into milver_order_items
        (order_id, item_cod, descripcion, variante, cajas, uxb, unidades, precio_lista, precio_neto, subtotal)
      values
        (v_order_id, it.cod, it.descripcion, it.variante, it.cajas, it.uxb, v_uni, it.list_price, v_neto, round(v_neto * v_uni, 2));
      v_sub_lista := v_sub_lista + it.list_price * v_uni;
      v_total := v_total + round(v_neto * v_uni, 2);
    end;
  end loop;

  if v_total = 0 then
    delete from milver_orders where id = v_order_id;
    return jsonb_build_object('ok', false, 'error', 'Ningún ítem válido');
  end if;

  update milver_orders
     set subtotal_lista = round(v_sub_lista, 2),
         descuento_total = round(v_sub_lista - v_total, 2),
         total = v_total
   where id = v_order_id;

  return jsonb_build_object('ok', true, 'numero', v_order_id, 'total', v_total,
                            'cliente', v_cli.razon_social);
end $$;

-- Historial del comisionista (últimos 50 pedidos, con ítems).
create or replace function public.milver_historial(p_comisionista_id integer, p_pin text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_ok boolean;
begin
  select true into v_ok from milver_comisionistas
   where id = p_comisionista_id and pin = trim(p_pin) and activo;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'Sesión inválida');
  end if;

  return jsonb_build_object('ok', true, 'pedidos', coalesce((
    select jsonb_agg(jsonb_build_object(
      'numero', o.id, 'fecha', o.created_at, 'cliente', o.cliente_nombre,
      'metodo_pago', o.metodo_pago, 'total', o.total, 'observaciones', o.observaciones,
      'items', (select jsonb_agg(jsonb_build_object(
                  'cod', i.item_cod, 'descripcion', i.descripcion, 'variante', i.variante,
                  'cajas', i.cajas, 'uxb', i.uxb, 'unidades', i.unidades,
                  'precio_neto', i.precio_neto, 'subtotal', i.subtotal) order by i.id)
                from milver_order_items i where i.order_id = o.id)
    ) order by o.created_at desc)
    from (select * from milver_orders where comisionista_id = p_comisionista_id
          order by created_at desc limit 50) o
  ), '[]'::jsonb));
end $$;

-- ============================================================
-- v3 — seguridad + ventas + administración
-- Las definiciones de acá abajo REEMPLAZAN (create or replace) a las
-- versiones anteriores de milver_login / milver_clientes_list /
-- milver_surtido / milver_submit_order / milver_historial.
-- ============================================================

create table public.milver_ventas (
  id          bigint generated always as identity primary key,
  cliente_cod text not null references public.milver_clientes(cod) on delete cascade,
  item_cod    text not null,
  fecha       date,
  cajas       numeric not null default 0,
  importado_at timestamptz not null default now()
);
create index milver_ventas_cliente_idx on public.milver_ventas (cliente_cod);
alter table public.milver_ventas enable row level security;

create table public.milver_login_intentos (
  id      bigint generated always as identity primary key,
  usuario text not null,
  ok      boolean not null,
  at      timestamptz not null default now()
);
create index milver_login_intentos_idx on public.milver_login_intentos (usuario, at);
alter table public.milver_login_intentos enable row level security;

-- ---------- helpers internos (revocados de anon/authenticated) ----------
create or replace function public.milver_com_nombre(p_id integer, p_pin text)
returns text language sql security definer set search_path = public, extensions stable as $$
  select nombre from milver_comisionistas
   where id = p_id and activo and pin = crypt(trim(p_pin), pin);
$$;
revoke execute on function public.milver_com_nombre(integer, text) from public, anon, authenticated;

create or replace function public.milver_admin_ok(p_pin text)
returns boolean language plpgsql security definer set search_path = public, extensions as $$
declare v_hash text; v_fails int; v_ok boolean;
begin
  select count(*) into v_fails from milver_login_intentos
   where usuario = '__admin__' and not ok and at > now() - interval '10 minutes';
  if v_fails >= 8 then return false; end if;
  select valor into v_hash from milver_settings where clave = 'admin_pin_hash';
  v_ok := v_hash is not null and v_hash = crypt(trim(p_pin), v_hash);
  insert into milver_login_intentos (usuario, ok) values ('__admin__', v_ok);
  return v_ok;
end $$;
revoke execute on function public.milver_admin_ok(text) from public, anon, authenticated;

-- ---------- login con rate limit (8 fallos / 10 min) ----------
-- OJO: el found del SELECT se captura ANTES del insert del intento,
-- porque el insert lo pisa (1 fila insertada => found = true).
create or replace function public.milver_login(p_nombre text, p_pin text)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare c record; v_usuario text; v_fails int; v_ok boolean;
begin
  v_usuario := lower(trim(p_nombre));
  select count(*) into v_fails from milver_login_intentos
   where usuario = v_usuario and not ok and at > now() - interval '10 minutes';
  if v_fails >= 8 then
    return jsonb_build_object('ok', false, 'error', 'Demasiados intentos. Esperá 10 minutos.');
  end if;

  select id, nombre into c from milver_comisionistas
   where lower(nombre) = v_usuario and activo and pin = crypt(trim(p_pin), pin);
  v_ok := found;
  insert into milver_login_intentos (usuario, ok) values (v_usuario, v_ok);
  if not v_ok then
    return jsonb_build_object('ok', false, 'error', 'Nombre o PIN incorrecto');
  end if;
  return jsonb_build_object('ok', true, 'id', c.id, 'nombre', c.nombre);
end $$;

-- ---------- RPCs de comisionista (v3: validación por helper) ----------
create or replace function public.milver_clientes_list(p_comisionista_id integer, p_pin text)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  if milver_com_nombre(p_comisionista_id, p_pin) is null then
    return jsonb_build_object('ok', false, 'error', 'Sesión inválida');
  end if;
  return jsonb_build_object('ok', true, 'clientes', coalesce((
    select jsonb_agg(jsonb_build_object(
             'cod', cod, 'razon_social', razon_social, 'dto_vol', dto_vol, 'localidad', localidad
           ) order by cod)
    from milver_clientes where comisionista_id = p_comisionista_id
  ), '[]'::jsonb));
end $$;

create or replace function public.milver_surtido(p_comisionista_id integer, p_pin text, p_cliente_cod text)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  if milver_com_nombre(p_comisionista_id, p_pin) is null or not exists (
    select 1 from milver_clientes where cod = p_cliente_cod and comisionista_id = p_comisionista_id
  ) then
    return jsonb_build_object('ok', false, 'error', 'Sesión inválida o cliente ajeno');
  end if;
  return jsonb_build_object('ok', true, 'cods', coalesce((
    select jsonb_agg(item_cod order by item_cod::int)
    from milver_cliente_surtido where cliente_cod = p_cliente_cod
  ), '[]'::jsonb));
end $$;

create or replace function public.milver_submit_order(
  p_comisionista_id integer, p_pin text, p_cliente_cod text,
  p_metodo_pago text, p_observaciones text, p_items jsonb
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_nombre text; v_cli record; v_web numeric; v_order_id bigint;
  v_sub_lista numeric := 0; v_total numeric := 0;
  it record;
begin
  v_nombre := milver_com_nombre(p_comisionista_id, p_pin);
  if v_nombre is null then
    return jsonb_build_object('ok', false, 'error', 'Sesión inválida');
  end if;

  select cod, razon_social, dto_vol into v_cli from milver_clientes
   where cod = p_cliente_cod and comisionista_id = p_comisionista_id;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'Cliente inexistente o de otro comisionista');
  end if;

  if p_items is null or jsonb_array_length(p_items) = 0 then
    return jsonb_build_object('ok', false, 'error', 'Pedido vacío');
  end if;

  select coalesce(valor::numeric, 0.02) into v_web
  from milver_settings where clave = 'web_order_discount';
  v_web := coalesce(v_web, 0.02);

  insert into milver_orders (comisionista_id, comisionista, cliente_cod, cliente_nombre, metodo_pago, observaciones)
  values (p_comisionista_id, v_nombre, v_cli.cod, v_cli.razon_social, p_metodo_pago, p_observaciones)
  returning id into v_order_id;

  for it in
    select p.cod, p.descripcion, p.variante, p.uxb, p.list_price,
           greatest(1, least(9999, (x->>'cajas')::int)) as cajas
    from jsonb_array_elements(p_items) x
    join milver_products p on p.cod = (x->>'cod') and p.activo
    where coalesce((x->>'cajas')::int, 0) > 0
  loop
    declare
      v_uni integer := it.uxb * it.cajas;
      v_neto numeric := round(it.list_price * (1 - v_cli.dto_vol) * (1 - v_web), 2);
    begin
      insert into milver_order_items
        (order_id, item_cod, descripcion, variante, cajas, uxb, unidades, precio_lista, precio_neto, subtotal)
      values
        (v_order_id, it.cod, it.descripcion, it.variante, it.cajas, it.uxb, v_uni, it.list_price, v_neto, round(v_neto * v_uni, 2));
      v_sub_lista := v_sub_lista + it.list_price * v_uni;
      v_total := v_total + round(v_neto * v_uni, 2);
    end;
  end loop;

  if v_total = 0 then
    delete from milver_orders where id = v_order_id;
    return jsonb_build_object('ok', false, 'error', 'Ningún ítem válido');
  end if;

  update milver_orders
     set subtotal_lista = round(v_sub_lista, 2),
         descuento_total = round(v_sub_lista - v_total, 2),
         total = v_total
   where id = v_order_id;

  return jsonb_build_object('ok', true, 'numero', v_order_id, 'total', v_total,
                            'cliente', v_cli.razon_social);
end $$;

create or replace function public.milver_historial(p_comisionista_id integer, p_pin text)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  if milver_com_nombre(p_comisionista_id, p_pin) is null then
    return jsonb_build_object('ok', false, 'error', 'Sesión inválida');
  end if;
  return jsonb_build_object('ok', true, 'pedidos', coalesce((
    select jsonb_agg(jsonb_build_object(
      'numero', o.id, 'fecha', o.created_at, 'cliente', o.cliente_nombre,
      'metodo_pago', o.metodo_pago, 'total', o.total, 'observaciones', o.observaciones,
      'items', (select jsonb_agg(jsonb_build_object(
                  'cod', i.item_cod, 'descripcion', i.descripcion, 'variante', i.variante,
                  'cajas', i.cajas, 'uxb', i.uxb, 'unidades', i.unidades,
                  'precio_neto', i.precio_neto, 'subtotal', i.subtotal) order by i.id)
                from milver_order_items i where i.order_id = o.id)
    ) order by o.created_at desc)
    from (select * from milver_orders where comisionista_id = p_comisionista_id
          order by created_at desc limit 50) o
  ), '[]'::jsonb));
end $$;

-- ---------- RPCs de ADMIN (todas validan milver_admin_ok) ----------
create or replace function public.milver_admin_login(p_pin text)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  if not milver_admin_ok(p_pin) then
    return jsonb_build_object('ok', false, 'error', 'PIN incorrecto o demasiados intentos');
  end if;
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.milver_admin_pedidos(p_pin text, p_desde date default null, p_limit integer default 500)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  if not milver_admin_ok(p_pin) then
    return jsonb_build_object('ok', false, 'error', 'Sesión inválida');
  end if;
  return jsonb_build_object('ok', true, 'pedidos', coalesce((
    select jsonb_agg(jsonb_build_object(
      'numero', o.id, 'fecha', o.created_at, 'comisionista', o.comisionista,
      'cliente_cod', o.cliente_cod, 'cliente', o.cliente_nombre,
      'metodo_pago', o.metodo_pago, 'observaciones', o.observaciones,
      'subtotal_lista', o.subtotal_lista, 'descuento_total', o.descuento_total, 'total', o.total,
      'items', (select jsonb_agg(jsonb_build_object(
                  'cod', i.item_cod, 'descripcion', i.descripcion, 'variante', i.variante,
                  'cajas', i.cajas, 'uxb', i.uxb, 'unidades', i.unidades,
                  'precio_lista', i.precio_lista, 'precio_neto', i.precio_neto, 'subtotal', i.subtotal) order by i.id)
                from milver_order_items i where i.order_id = o.id)
    ) order by o.created_at desc)
    from (select * from milver_orders
           where p_desde is null or created_at >= p_desde
           order by created_at desc limit least(coalesce(p_limit, 500), 2000)) o
  ), '[]'::jsonb));
end $$;

create or replace function public.milver_admin_stats(p_pin text)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  if not milver_admin_ok(p_pin) then
    return jsonb_build_object('ok', false, 'error', 'Sesión inválida');
  end if;
  return jsonb_build_object('ok', true,
    'productos', (select count(*) from milver_products where activo),
    'productos_inactivos', (select count(*) from milver_products where not activo),
    'clientes', (select count(*) from milver_clientes),
    'comisionistas', (select count(*) from milver_comisionistas where activo),
    'pedidos', (select count(*) from milver_orders),
    'total_pedidos', (select coalesce(sum(total), 0) from milver_orders),
    'ventas_filas', (select count(*) from milver_ventas),
    'surtido_filas', (select count(*) from milver_cliente_surtido),
    'comisionistas_lista', (select jsonb_agg(jsonb_build_object(
        'id', c.id, 'nombre', c.nombre, 'activo', c.activo,
        'clientes', (select count(*) from milver_clientes cl where cl.comisionista_id = c.id)
      ) order by c.id) from milver_comisionistas c));
end $$;

create or replace function public.milver_admin_import_products(p_pin text, p_rows jsonb, p_desactivar_faltantes boolean default false)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_ins int := 0; v_upd int := 0; v_des int := 0;
begin
  if not milver_admin_ok(p_pin) then
    return jsonb_build_object('ok', false, 'error', 'Sesión inválida');
  end if;
  if p_rows is null or jsonb_array_length(p_rows) = 0 then
    return jsonb_build_object('ok', false, 'error', 'Archivo vacío');
  end if;

  with filas as (
    select trim(x->>'cod') as cod,
           nullif(trim(x->>'descripcion'), '') as descripcion,
           coalesce(nullif(trim(x->>'categoria'), ''), 'Sin categoría') as categoria,
           nullif(trim(x->>'madre_cod'), '') as madre_cod,
           nullif(trim(x->>'madre_desc'), '') as madre_desc,
           nullif(trim(x->>'variante'), '') as variante,
           greatest(1, coalesce((x->>'uxb')::int, 1)) as uxb,
           greatest(0, coalesce((x->>'list_price')::numeric, 0)) as list_price
    from jsonb_array_elements(p_rows) x
    where nullif(trim(x->>'cod'), '') is not null
      and nullif(trim(x->>'descripcion'), '') is not null
  ),
  up as (
    insert into milver_products (cod, descripcion, categoria, madre_cod, madre_desc, variante, uxb, list_price, activo)
    select distinct on (cod) cod, descripcion, categoria, madre_cod, madre_desc, variante, uxb, list_price, true
    from filas
    on conflict (cod) do update
      set descripcion = excluded.descripcion, categoria = excluded.categoria,
          madre_cod = excluded.madre_cod, madre_desc = excluded.madre_desc,
          variante = excluded.variante, uxb = excluded.uxb,
          list_price = excluded.list_price, activo = true
    returning (xmax = 0) as insertado
  )
  select count(*) filter (where insertado), count(*) filter (where not insertado)
    into v_ins, v_upd from up;

  if p_desactivar_faltantes then
    update milver_products p set activo = false
     where p.activo
       and not exists (
         select 1 from jsonb_array_elements(p_rows) x
          where trim(x->>'cod') = p.cod
       );
    get diagnostics v_des = row_count;
  end if;

  return jsonb_build_object('ok', true, 'insertados', v_ins, 'actualizados', v_upd, 'desactivados', v_des);
end $$;

create or replace function public.milver_admin_import_clientes(p_pin text, p_rows jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_ins int := 0; v_upd int := 0;
begin
  if not milver_admin_ok(p_pin) then
    return jsonb_build_object('ok', false, 'error', 'Sesión inválida');
  end if;
  if p_rows is null or jsonb_array_length(p_rows) = 0 then
    return jsonb_build_object('ok', false, 'error', 'Archivo vacío');
  end if;
  with filas as (
    select trim(x->>'cod') as cod,
           nullif(trim(x->>'razon_social'), '') as razon_social,
           least(0.9, greatest(0, coalesce((x->>'dto_vol')::numeric, 0))) as dto_vol,
           nullif(trim(x->>'localidad'), '') as localidad,
           (x->>'comisionista_id')::int as comisionista_id
    from jsonb_array_elements(p_rows) x
    where nullif(trim(x->>'cod'), '') is not null
      and nullif(trim(x->>'razon_social'), '') is not null
  ),
  up as (
    insert into milver_clientes (cod, razon_social, dto_vol, localidad, comisionista_id)
    select distinct on (cod) cod, razon_social, dto_vol, localidad,
           case when comisionista_id in (select id from milver_comisionistas) then comisionista_id end
    from filas
    on conflict (cod) do update
      set razon_social = excluded.razon_social, dto_vol = excluded.dto_vol,
          localidad = excluded.localidad,
          comisionista_id = coalesce(excluded.comisionista_id, milver_clientes.comisionista_id)
    returning (xmax = 0) as insertado
  )
  select count(*) filter (where insertado), count(*) filter (where not insertado)
    into v_ins, v_upd from up;
  return jsonb_build_object('ok', true, 'insertados', v_ins, 'actualizados', v_upd);
end $$;

create or replace function public.milver_admin_import_ventas(p_pin text, p_rows jsonb, p_reemplazar boolean default true)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_ins int := 0; v_surt int := 0; v_sin_cliente int := 0;
begin
  if not milver_admin_ok(p_pin) then
    return jsonb_build_object('ok', false, 'error', 'Sesión inválida');
  end if;
  if p_rows is null or jsonb_array_length(p_rows) = 0 then
    return jsonb_build_object('ok', false, 'error', 'Archivo vacío');
  end if;

  create temp table _mv_filas on commit drop as
    select trim(x->>'cliente_cod') as cliente_cod,
           trim(x->>'item_cod') as item_cod,
           (nullif(trim(x->>'fecha'), ''))::date as fecha,
           greatest(0, coalesce((x->>'cajas')::numeric, 0)) as cajas
    from jsonb_array_elements(p_rows) x
    where nullif(trim(x->>'cliente_cod'), '') is not null
      and nullif(trim(x->>'item_cod'), '') is not null;

  select count(*) into v_sin_cliente from _mv_filas f
   where not exists (select 1 from milver_clientes c where c.cod = f.cliente_cod);
  delete from _mv_filas f
   where not exists (select 1 from milver_clientes c where c.cod = f.cliente_cod);

  if p_reemplazar then
    delete from milver_ventas v
     where v.cliente_cod in (select distinct cliente_cod from _mv_filas);
  end if;

  insert into milver_ventas (cliente_cod, item_cod, fecha, cajas)
  select cliente_cod, item_cod, fecha, cajas from _mv_filas;
  get diagnostics v_ins = row_count;

  -- Surtido real: lo que el cliente compró según sus ventas
  delete from milver_cliente_surtido s
   where s.cliente_cod in (select distinct cliente_cod from _mv_filas);
  insert into milver_cliente_surtido (cliente_cod, item_cod)
  select distinct v.cliente_cod, v.item_cod
  from milver_ventas v
  join milver_products p on p.cod = v.item_cod
  where v.cliente_cod in (select distinct cliente_cod from _mv_filas);
  get diagnostics v_surt = row_count;

  return jsonb_build_object('ok', true, 'ventas_insertadas', v_ins,
                            'surtido_filas', v_surt, 'filas_sin_cliente', v_sin_cliente);
end $$;

create or replace function public.milver_admin_upsert_comisionista(
  p_pin text, p_id integer, p_nombre text, p_pin_nuevo text default null, p_activo boolean default true)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare v_id integer;
begin
  if not milver_admin_ok(p_pin) then
    return jsonb_build_object('ok', false, 'error', 'Sesión inválida');
  end if;
  if nullif(trim(p_nombre), '') is null then
    return jsonb_build_object('ok', false, 'error', 'Falta el nombre');
  end if;
  if p_id is null then
    if length(coalesce(trim(p_pin_nuevo), '')) < 4 then
      return jsonb_build_object('ok', false, 'error', 'PIN de al menos 4 caracteres');
    end if;
    insert into milver_comisionistas (nombre, pin, activo)
    values (trim(p_nombre), crypt(trim(p_pin_nuevo), gen_salt('bf')), coalesce(p_activo, true))
    returning id into v_id;
  else
    update milver_comisionistas
       set nombre = trim(p_nombre),
           activo = coalesce(p_activo, activo),
           pin = case when length(coalesce(trim(p_pin_nuevo), '')) >= 4
                      then crypt(trim(p_pin_nuevo), gen_salt('bf')) else pin end
     where id = p_id
     returning id into v_id;
    if v_id is null then
      return jsonb_build_object('ok', false, 'error', 'Comisionista inexistente');
    end if;
  end if;
  return jsonb_build_object('ok', true, 'id', v_id);
exception when unique_violation then
  return jsonb_build_object('ok', false, 'error', 'Ya existe un comisionista con ese nombre');
end $$;

create or replace function public.milver_admin_upsert_cliente(
  p_pin text, p_cod text, p_razon_social text, p_dto_vol numeric default 0,
  p_localidad text default null, p_comisionista_id integer default null)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  if not milver_admin_ok(p_pin) then
    return jsonb_build_object('ok', false, 'error', 'Sesión inválida');
  end if;
  if nullif(trim(p_cod), '') is null or nullif(trim(p_razon_social), '') is null then
    return jsonb_build_object('ok', false, 'error', 'Faltan código o razón social');
  end if;
  insert into milver_clientes (cod, razon_social, dto_vol, localidad, comisionista_id)
  values (trim(p_cod), trim(p_razon_social), least(0.9, greatest(0, coalesce(p_dto_vol, 0))),
          nullif(trim(p_localidad), ''), p_comisionista_id)
  on conflict (cod) do update
    set razon_social = excluded.razon_social, dto_vol = excluded.dto_vol,
        localidad = excluded.localidad, comisionista_id = excluded.comisionista_id;
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.milver_admin_delete_cliente(p_pin text, p_cod text)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  if not milver_admin_ok(p_pin) then
    return jsonb_build_object('ok', false, 'error', 'Sesión inválida');
  end if;
  delete from milver_clientes where cod = trim(p_cod);
  if not found then
    return jsonb_build_object('ok', false, 'error', 'Cliente inexistente');
  end if;
  return jsonb_build_object('ok', true);
exception when foreign_key_violation then
  return jsonb_build_object('ok', false, 'error', 'El cliente tiene pedidos; no se puede borrar');
end $$;

create or replace function public.milver_admin_set_cartera(p_pin text, p_cliente_cods text[], p_comisionista_id integer)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_n int;
begin
  if not milver_admin_ok(p_pin) then
    return jsonb_build_object('ok', false, 'error', 'Sesión inválida');
  end if;
  if p_comisionista_id is not null and not exists (
    select 1 from milver_comisionistas where id = p_comisionista_id
  ) then
    return jsonb_build_object('ok', false, 'error', 'Comisionista inexistente');
  end if;
  update milver_clientes set comisionista_id = p_comisionista_id
   where cod = any(p_cliente_cods);
  get diagnostics v_n = row_count;
  return jsonb_build_object('ok', true, 'actualizados', v_n);
end $$;

create or replace function public.milver_admin_clientes(p_pin text)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  if not milver_admin_ok(p_pin) then
    return jsonb_build_object('ok', false, 'error', 'Sesión inválida');
  end if;
  return jsonb_build_object('ok', true, 'clientes', coalesce((
    select jsonb_agg(jsonb_build_object(
             'cod', c.cod, 'razon_social', c.razon_social, 'dto_vol', c.dto_vol,
             'localidad', c.localidad, 'comisionista_id', c.comisionista_id,
             'ventas', (select count(*) from milver_ventas v where v.cliente_cod = c.cod),
             'surtido', (select count(*) from milver_cliente_surtido s where s.cliente_cod = c.cod)
           ) order by c.cod)
    from milver_clientes c
  ), '[]'::jsonb));
end $$;

-- ============================================================
-- v4 — artículos que Milver le compra a Loekemeyer
-- Milver S.R.L es el cliente 2288 del padrón LK. Sus compras reales
-- entran al catálogo con cod 'L'+<cod LK>, compra_lk=true y orden_lk
-- por volumen comprado, y el catálogo los devuelve PRIMERO.
-- NOTA: el INSERT de estos artículos lee las tablas de LK (sales_lines,
-- orders, products) y por eso NO es portable a otro proyecto: al migrar
-- a un Supabase propio de Milver, exportar las filas compra_lk=true de
-- milver_products como datos (o re-importarlas por Excel).
-- ============================================================

alter table public.milver_products
  add column compra_lk boolean not null default false,
  add column orden_lk integer;

create or replace function public.milver_catalogo()
returns jsonb language sql security definer set search_path = public stable as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'cod', cod, 'descripcion', descripcion, 'categoria', categoria,
           'madre_cod', madre_cod, 'madre_desc', madre_desc, 'variante', variante,
           'uxb', uxb, 'list_price', list_price,
           'compra_lk', compra_lk, 'orden_lk', orden_lk
         ) order by compra_lk desc, orden_lk nulls last,
                    (case when cod ~ '^[0-9]+$' then cod::int else 2147483647 end), cod),
         '[]'::jsonb)
  from milver_products where activo;
$$;

-- ============================================================
-- v5 — venta POR UNIDAD (Milver vende por unidad, no por caja)
-- El comisionista carga UNIDADES; list_price ya era por unidad.
-- milver_order_items.cajas queda legada en 0; manda `unidades`.
-- ============================================================

alter table public.milver_ventas rename column cajas to cantidad;

create or replace function public.milver_submit_order(
  p_comisionista_id integer, p_pin text, p_cliente_cod text,
  p_metodo_pago text, p_observaciones text, p_items jsonb
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_nombre text; v_cli record; v_web numeric; v_order_id bigint;
  v_sub_lista numeric := 0; v_total numeric := 0;
  it record;
begin
  v_nombre := milver_com_nombre(p_comisionista_id, p_pin);
  if v_nombre is null then
    return jsonb_build_object('ok', false, 'error', 'Sesión inválida');
  end if;

  select cod, razon_social, dto_vol into v_cli from milver_clientes
   where cod = p_cliente_cod and comisionista_id = p_comisionista_id;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'Cliente inexistente o de otro comisionista');
  end if;

  if p_items is null or jsonb_array_length(p_items) = 0 then
    return jsonb_build_object('ok', false, 'error', 'Pedido vacío');
  end if;

  select coalesce(valor::numeric, 0.02) into v_web
  from milver_settings where clave = 'web_order_discount';
  v_web := coalesce(v_web, 0.02);

  insert into milver_orders (comisionista_id, comisionista, cliente_cod, cliente_nombre, metodo_pago, observaciones)
  values (p_comisionista_id, v_nombre, v_cli.cod, v_cli.razon_social, p_metodo_pago, p_observaciones)
  returning id into v_order_id;

  for it in
    select p.cod, p.descripcion, p.variante, p.uxb, p.list_price,
           greatest(1, least(999999, (x->>'unidades')::int)) as unidades
    from jsonb_array_elements(p_items) x
    join milver_products p on p.cod = (x->>'cod') and p.activo
    where coalesce((x->>'unidades')::int, 0) > 0
  loop
    declare
      v_neto numeric := round(it.list_price * (1 - v_cli.dto_vol) * (1 - v_web), 2);
    begin
      insert into milver_order_items
        (order_id, item_cod, descripcion, variante, cajas, uxb, unidades, precio_lista, precio_neto, subtotal)
      values
        (v_order_id, it.cod, it.descripcion, it.variante, 0, it.uxb, it.unidades, it.list_price, v_neto, round(v_neto * it.unidades, 2));
      v_sub_lista := v_sub_lista + it.list_price * it.unidades;
      v_total := v_total + round(v_neto * it.unidades, 2);
    end;
  end loop;

  if v_total = 0 then
    delete from milver_orders where id = v_order_id;
    return jsonb_build_object('ok', false, 'error', 'Ningún ítem válido');
  end if;

  update milver_orders
     set subtotal_lista = round(v_sub_lista, 2),
         descuento_total = round(v_sub_lista - v_total, 2),
         total = v_total
   where id = v_order_id;

  return jsonb_build_object('ok', true, 'numero', v_order_id, 'total', v_total,
                            'cliente', v_cli.razon_social);
end $$;

create or replace function public.milver_admin_import_ventas(p_pin text, p_rows jsonb, p_reemplazar boolean default true)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_ins int := 0; v_surt int := 0; v_sin_cliente int := 0;
begin
  if not milver_admin_ok(p_pin) then
    return jsonb_build_object('ok', false, 'error', 'Sesión inválida');
  end if;
  if p_rows is null or jsonb_array_length(p_rows) = 0 then
    return jsonb_build_object('ok', false, 'error', 'Archivo vacío');
  end if;

  create temp table _mv_filas on commit drop as
    select trim(x->>'cliente_cod') as cliente_cod,
           trim(x->>'item_cod') as item_cod,
           (nullif(trim(x->>'fecha'), ''))::date as fecha,
           greatest(0, coalesce((coalesce(x->>'cantidad', x->>'cajas'))::numeric, 0)) as cantidad
    from jsonb_array_elements(p_rows) x
    where nullif(trim(x->>'cliente_cod'), '') is not null
      and nullif(trim(x->>'item_cod'), '') is not null;

  select count(*) into v_sin_cliente from _mv_filas f
   where not exists (select 1 from milver_clientes c where c.cod = f.cliente_cod);
  delete from _mv_filas f
   where not exists (select 1 from milver_clientes c where c.cod = f.cliente_cod);

  if p_reemplazar then
    delete from milver_ventas v
     where v.cliente_cod in (select distinct cliente_cod from _mv_filas);
  end if;

  insert into milver_ventas (cliente_cod, item_cod, fecha, cantidad)
  select cliente_cod, item_cod, fecha, cantidad from _mv_filas;
  get diagnostics v_ins = row_count;

  delete from milver_cliente_surtido s
   where s.cliente_cod in (select distinct cliente_cod from _mv_filas);
  insert into milver_cliente_surtido (cliente_cod, item_cod)
  select distinct v.cliente_cod, v.item_cod
  from milver_ventas v
  join milver_products p on p.cod = v.item_cod
  where v.cliente_cod in (select distinct cliente_cod from _mv_filas);
  get diagnostics v_surt = row_count;

  return jsonb_build_object('ok', true, 'ventas_insertadas', v_ins,
                            'surtido_filas', v_surt, 'filas_sin_cliente', v_sin_cliente);
end $$;

-- ============================================================
-- v6 — costos + ganancias (acceso maestro) + botonera de depósito
-- ============================================================

alter table public.milver_products add column cost numeric not null default 0;
update public.milver_products set cost = round(list_price * 0.5, 2) where cost = 0;

alter table public.milver_order_items add column costo_unit numeric not null default 0;

alter table public.milver_orders
  add column estado text not null default 'nuevo',   -- nuevo → en_armado → armado → despachado
  add column estado_at timestamptz,
  add column armado_por text;

create table public.milver_order_eventos (
  id       bigint generated always as identity primary key,
  order_id bigint not null references public.milver_orders(id) on delete cascade,
  evento   text not null,          -- EA / TA / DES
  operario text not null,
  at       timestamptz not null default now()
);
alter table public.milver_order_eventos enable row level security;

insert into public.milver_settings values ('deposito_pin_hash', extensions.crypt('2468', extensions.gen_salt('bf')));

-- Las definiciones de milver_submit_order, milver_admin_import_products,
-- milver_admin_ganancias, milver_dep_ok, milver_dep_login,
-- milver_dep_pedidos y milver_dep_evento están desplegadas en la base.
-- Para regenerar el archivo entero: volcar con pg_get_functiondef todas
-- las funciones milver_* (la base es la fuente de verdad, igual que en LK).

-- v7 — estadísticas del comisionista para la pantalla de Inicio
-- (semana / mes / histórico / top clientes / serie de 8 días).
-- Definición desplegada en la base; regenerar con pg_get_functiondef milver_stats.

-- v8 — Milver NO aplica el descuento por pedido web de LK: se puso
-- milver_settings.web_order_discount = '0'. El neto queda
-- list_price × (1 - dto_vol del cliente).
update public.milver_settings set valor = '0' where clave = 'web_order_discount';

-- ============================================================
-- v9 — picking ítem por ítem (operarios de depósito)
-- milver_order_items: pick_unidades / pick_falta / pick_por / pick_at.
-- Estados del pedido: nuevo → en_picking → pickeado → despachado.
-- RPCs: milver_dep_detalle, milver_dep_pick, milver_dep_pick_undo,
-- milver_dep_finalizar (TA exige todo pickeado; DES despacha).
-- milver_dep_pedidos ahora trae progreso (items_pick/items_total/faltantes).
-- Definiciones desplegadas en la base; regenerar con pg_get_functiondef.
-- ============================================================

-- v10 — editar / anular pedido del comisionista (solo estado 'nuevo')
-- milver_edit_order(p_comisionista_id, p_pin, p_numero, metodo, obs, items)
--   reemplaza ítems y recalcula; rechaza si el pedido ya está en depósito.
-- milver_cancel_order(p_comisionista_id, p_pin, p_numero) borra el pedido.
-- Definiciones desplegadas en la base; regenerar con pg_get_functiondef.
