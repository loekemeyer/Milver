-- ============================================================
-- MILVER — esquema completo (demo). Todo con prefijo milver_.
-- Este archivo recrea desde cero las tablas, datos y RPCs en
-- cualquier proyecto Supabase (hoy corre en el proyecto LK;
-- para transferir a Milver: correr este archivo en su proyecto
-- y migrar los datos de milver_orders / milver_order_items).
-- ============================================================

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
insert into public.milver_comisionistas (nombre, pin)
select 'Comisionista ' || n, repeat(n::text, 4)
from generate_series(1, 5) n;

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
