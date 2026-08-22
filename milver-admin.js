"use strict";

/***********************
 * MILVER ADMIN
 * Panel de administración: pedidos + export Excel, importadores de
 * catálogo/clientes/ventas, ABM comisionistas y carteras.
 * Todas las RPC son milver_admin_* y validan el PIN en el servidor.
 ***********************/
const SUPABASE_URL = "https://kwkclwhmoygunqmlegrg.supabase.co";
const SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imt3a2Nsd2htb3lndW5xbWxlZ3JnIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njk1MjA2NzUsImV4cCI6MjA4NTA5NjY3NX0.soqPY5hfA3RkAJ9jmIms8UtEGUc4WpZztpEbmDijOgU";

const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

let adminPin = null;
let pedidos = [];
let clientes = [];
let comisionistas = [];
let clientesSel = new Set(); // cods tildados para asignación de cartera

const $ = (id) => document.getElementById(id);

function formatMoney(n) {
  return Math.round(Number(n || 0)).toLocaleString("es-AR");
}

async function rpc(fn, args) {
  const { data, error } = await supabaseClient.rpc(fn, args);
  if (error) return { ok: false, error: error.message || "Error de conexión" };
  return data || { ok: false, error: "Sin respuesta" };
}

/***********************
 * LOGIN
 ***********************/
function restoreSession() {
  try {
    adminPin = sessionStorage.getItem("milver_admin_pin") || null;
  } catch (e) {
    adminPin = null;
  }
  syncLoginUI();
  if (adminPin) initData();
}

function syncLoginUI() {
  const overlay = $("loginOverlay");
  if (overlay) overlay.style.display = adminPin ? "none" : "";
}

async function doLogin() {
  const pin = ($("loginPin")?.value || "").trim();
  const errBox = $("loginError");
  if (!pin) return;
  const btn = $("loginBtn");
  if (btn) btn.disabled = true;
  const r = await rpc("milver_admin_login", { p_pin: pin });
  if (btn) btn.disabled = false;
  if (!r.ok) {
    if (errBox) {
      errBox.textContent = r.error || "PIN incorrecto";
      errBox.style.display = "";
    }
    return;
  }
  adminPin = pin;
  try {
    sessionStorage.setItem("milver_admin_pin", pin);
  } catch (e) {}
  syncLoginUI();
  initData();
}

function logout() {
  adminPin = null;
  try {
    sessionStorage.removeItem("milver_admin_pin");
  } catch (e) {}
  syncLoginUI();
}

/***********************
 * TABS
 ***********************/
function showTab(id) {
  document.querySelectorAll(".mva-section").forEach((s) => s.classList.remove("active"));
  document.querySelectorAll(".mva-tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === id));
  const el = $("tab-" + id);
  if (el) el.classList.add("active");
  if (id === "resumen") loadStats();
  if (id === "pedidos") loadPedidos();
  if (id === "clientes") loadClientes();
  if (id === "comisionistas") loadStats(true);
  if (id === "ganancias") loadGanancias();
}

function initData() {
  loadStats();
  loadPedidos();
  loadClientes();
}

/***********************
 * RESUMEN
 ***********************/
async function loadStats(soloComs) {
  const r = await rpc("milver_admin_stats", { p_pin: adminPin });
  if (!r.ok) return;
  comisionistas = r.comisionistas_lista || [];
  fillComSelects();
  renderComisionistas();
  if (soloComs) return;
  const cards = $("statsCards");
  if (cards) {
    cards.innerHTML = [
      ["Pedidos", r.pedidos, "$" + formatMoney(r.total_pedidos)],
      ["Productos activos", r.productos, r.productos_inactivos + " inactivos"],
      ["Clientes", r.clientes, ""],
      ["Comisionistas", r.comisionistas, ""],
      ["Ventas importadas", r.ventas_filas, r.surtido_filas + " filas de surtido"],
    ]
      .map(
        ([t, v, s]) => `
        <div class="mva-card">
          <div class="mva-card-num">${Number(v || 0).toLocaleString("es-AR")}</div>
          <div class="mva-card-tit">${t}</div>
          ${s ? `<div class="mva-card-sub">${s}</div>` : ""}
        </div>`,
      )
      .join("");
  }
  const box = $("statsComs");
  if (box) {
    box.innerHTML =
      "<h3>Carteras</h3>" +
      `<table class="mva-table"><thead><tr><th>ID</th><th>Comisionista</th><th>Clientes</th><th>Estado</th></tr></thead><tbody>` +
      comisionistas
        .map(
          (c) =>
            `<tr><td>${c.id}</td><td>${c.nombre}</td><td>${c.clientes}</td><td>${c.activo ? "Activo" : "Inactivo"}</td></tr>`,
        )
        .join("") +
      "</tbody></table>";
  }
}

/***********************
 * PEDIDOS
 ***********************/
async function loadPedidos() {
  const box = $("pedidosLista");
  if (!box || !adminPin) return;
  box.innerHTML = "Cargando…";
  const desde = $("pedidosDesde")?.value || null;
  const r = await rpc("milver_admin_pedidos", { p_pin: adminPin, p_desde: desde, p_limit: 500 });
  if (!r.ok) {
    box.innerHTML = `<div class="mva-error">${r.error}</div>`;
    return;
  }
  pedidos = r.pedidos || [];
  if (!pedidos.length) {
    box.innerHTML = "Sin pedidos todavía.";
    return;
  }
  box.innerHTML = pedidos
    .map((o) => {
      const fecha = new Date(o.fecha).toLocaleString("es-AR", { dateStyle: "short", timeStyle: "short" });
      return `
      <details class="mv-hist-card">
        <summary>
          <span class="mv-hist-num">#${o.numero}</span>
          <span>${o.comisionista}</span>
          <span class="mv-hist-cliente">${o.cliente} (${o.cliente_cod})</span>
          <span class="mv-hist-fecha">${fecha}</span>
          <span>${o.metodo_pago || ""}</span>
          <span class="mv-hist-total">$${formatMoney(o.total)}</span>
        </summary>
        <div class="mv-hist-items">
          ${(o.items || [])
            .map(
              (i) => `
            <div class="mv-hist-item">
              <span class="mv-cart-cod">${i.cod}</span>
              <span>${i.descripcion}</span>
              <span>${formatMoney(i.unidades)} u.</span>
              <span>$${formatMoney(i.subtotal)}</span>
            </div>`,
            )
            .join("")}
          ${o.observaciones ? `<div class="mv-hist-obs">Obs: ${o.observaciones}</div>` : ""}
        </div>
      </details>`;
    })
    .join("");
}

function descargarPedidosExcel() {
  if (!pedidos.length) {
    alert("No hay pedidos para exportar.");
    return;
  }
  const cab = pedidos.map((o) => ({
    Numero: o.numero,
    Fecha: new Date(o.fecha).toLocaleString("es-AR"),
    Comisionista: o.comisionista,
    ClienteCod: o.cliente_cod,
    Cliente: o.cliente,
    MedioPago: o.metodo_pago || "",
    SubtotalLista: Number(o.subtotal_lista || 0),
    Descuento: Number(o.descuento_total || 0),
    Total: Number(o.total || 0),
    Observaciones: o.observaciones || "",
  }));
  const det = pedidos.flatMap((o) =>
    (o.items || []).map((i) => ({
      Numero: o.numero,
      ClienteCod: o.cliente_cod,
      Cliente: o.cliente,
      Cod: i.cod,
      Descripcion: i.descripcion,
      Variante: i.variante || "",
      Unidades: i.unidades,
      PrecioLista: Number(i.precio_lista || 0),
      PrecioNeto: Number(i.precio_neto || 0),
      Subtotal: Number(i.subtotal || 0),
    })),
  );
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(cab), "Pedidos");
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(det), "Detalle");
  const hoy = new Date().toISOString().slice(0, 10);
  XLSX.writeFile(wb, `milver-pedidos-${hoy}.xlsx`);
}

/***********************
 * HELPERS EXCEL
 ***********************/
function leerExcel(inputId) {
  return new Promise((resolve, reject) => {
    const input = $(inputId);
    const file = input?.files?.[0];
    if (!file) {
      reject(new Error("Elegí un archivo primero."));
      return;
    }
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const wb = XLSX.read(new Uint8Array(e.target.result), { type: "array" });
        const ws = wb.Sheets[wb.SheetNames[0]];
        resolve(XLSX.utils.sheet_to_json(ws, { defval: "" }));
      } catch (err) {
        reject(err);
      }
    };
    reader.onerror = () => reject(new Error("No se pudo leer el archivo."));
    reader.readAsArrayBuffer(file);
  });
}

// Busca la columna por nombre flexible (sin acentos, minúsculas).
function colVal(row, nombres) {
  const norm = (s) =>
    String(s)
      .toLowerCase()
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9]/g, "");
  const claves = Object.keys(row);
  for (const n of nombres) {
    const k = claves.find((c) => norm(c) === norm(n));
    if (k !== undefined && row[k] !== "") return row[k];
  }
  return "";
}

function mostrarResultado(id, r, extra) {
  const box = $(id);
  if (!box) return;
  box.innerHTML = r.ok
    ? `<div class="mva-ok">✓ ${extra}</div>`
    : `<div class="mva-error">✗ ${r.error}</div>`;
}

/***********************
 * IMPORTADOR CATÁLOGO
 ***********************/
async function importarCatalogo() {
  const box = $("catalogoResultado");
  try {
    box.innerHTML = "Leyendo archivo…";
    const filas = await leerExcel("fileCatalogo");
    const rows = filas
      .map((f) => ({
        cod: String(colVal(f, ["cod", "codigo", "código", "art", "articulo"])).trim(),
        descripcion: String(colVal(f, ["descripcion", "descripción", "detalle", "nombre"])).trim(),
        categoria: String(colVal(f, ["categoria", "categoría", "rubro"])).trim(),
        madre_cod: String(colVal(f, ["madre_cod", "madre", "cod_madre"])).trim(),
        madre_desc: String(colVal(f, ["madre_desc", "desc_madre"])).trim(),
        variante: String(colVal(f, ["variante", "color", "variedad"])).trim(),
        uxb: Number(colVal(f, ["uxb", "unidades_por_caja", "u_x_b", "bulto"])) || 1,
        list_price: Number(colVal(f, ["precio", "list_price", "precio_lista", "lista"])) || 0,
        cost: Number(colVal(f, ["costo", "cost", "precio_costo"])) || 0,
      }))
      .filter((r) => r.cod && r.descripcion);
    if (!rows.length) {
      box.innerHTML = `<div class="mva-error">✗ No se encontraron filas con cod y descripción.</div>`;
      return;
    }
    box.innerHTML = `Importando ${rows.length.toLocaleString("es-AR")} filas…`;
    const r = await rpc("milver_admin_import_products", {
      p_pin: adminPin,
      p_rows: rows,
      p_desactivar_faltantes: !!$("chkDesactivar")?.checked,
    });
    mostrarResultado(
      "catalogoResultado",
      r,
      `${r.insertados} nuevos, ${r.actualizados} actualizados, ${r.desactivados} desactivados.`,
    );
    loadStats();
  } catch (e) {
    box.innerHTML = `<div class="mva-error">✗ ${e.message}</div>`;
  }
}

function descargarModeloCatalogo() {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.json_to_sheet([
      { cod: "1", descripcion: "Tabla de Picar Bambú Grande - Rojo", categoria: "Cocina", madre_cod: "M001", madre_desc: "Tabla de Picar Bambú Grande", variante: "Rojo", uxb: 12, precio: 5000 },
      { cod: "1001", descripcion: "Colador Acero Nº2", categoria: "Cocina", madre_cod: "", madre_desc: "", variante: "", uxb: 24, precio: 3200 },
    ]),
    "Catalogo",
  );
  XLSX.writeFile(wb, "milver-modelo-catalogo.xlsx");
}

/***********************
 * CLIENTES
 ***********************/
async function loadClientes() {
  if (!adminPin) return;
  const r = await rpc("milver_admin_clientes", { p_pin: adminPin });
  if (!r.ok) return;
  clientes = r.clientes || [];
  clientesSel = new Set();
  renderClientes();
}

function comNombre(id) {
  const c = comisionistas.find((x) => x.id === id);
  return c ? c.nombre : "—";
}

function fillComSelects() {
  const opts =
    '<option value="">— Sin asignar —</option>' +
    comisionistas.map((c) => `<option value="${c.id}">${c.nombre}</option>`).join("");
  for (const id of ["cliCom", "carteraCom"]) {
    const sel = $(id);
    if (sel) sel.innerHTML = opts;
  }
}

function renderClientes() {
  const box = $("clientesLista");
  if (!box) return;
  const q = ($("clientesBuscar")?.value || "").toLowerCase().trim();
  const list = q
    ? clientes.filter(
        (c) =>
          c.cod.toLowerCase().includes(q) ||
          c.razon_social.toLowerCase().includes(q) ||
          (c.localidad || "").toLowerCase().includes(q) ||
          comNombre(c.comisionista_id).toLowerCase().includes(q),
      )
    : clientes;
  const info = $("carteraInfo");
  if (info) info.textContent = clientesSel.size ? `${clientesSel.size} seleccionados` : "";
  box.innerHTML =
    `<div class="mva-help">${list.length.toLocaleString("es-AR")} clientes${q ? " (filtrados)" : ""}</div>` +
    `<table class="mva-table"><thead><tr>
       <th></th><th>Cod</th><th>Razón social</th><th>Dto</th><th>Localidad</th>
       <th>Comisionista</th><th>Ventas</th><th>Surtido</th><th></th>
     </tr></thead><tbody>` +
    list
      .slice(0, 600)
      .map(
        (c) => `
      <tr>
        <td><input type="checkbox" ${clientesSel.has(c.cod) ? "checked" : ""} onchange="toggleSelCliente('${c.cod}', this.checked)"></td>
        <td>${c.cod}</td>
        <td>${c.razon_social}</td>
        <td>${Math.round(Number(c.dto_vol || 0) * 100)}%</td>
        <td>${c.localidad || ""}</td>
        <td>${comNombre(c.comisionista_id)}</td>
        <td>${c.ventas}</td>
        <td>${c.surtido}</td>
        <td>
          <button type="button" class="mva-mini-btn" onclick="editarCliente('${c.cod}')">✎</button>
          <button type="button" class="mva-mini-btn mva-mini-del" onclick="borrarCliente('${c.cod}')">🗑</button>
        </td>
      </tr>`,
      )
      .join("") +
    "</tbody></table>" +
    (list.length > 600 ? `<div class="mva-help">Mostrando 600 de ${list.length}; afiná la búsqueda.</div>` : "");
}

function toggleSelCliente(cod, on) {
  if (on) clientesSel.add(cod);
  else clientesSel.delete(cod);
  const info = $("carteraInfo");
  if (info) info.textContent = clientesSel.size ? `${clientesSel.size} seleccionados` : "";
}

function editarCliente(cod) {
  const c = clientes.find((x) => x.cod === cod);
  if (!c) return;
  $("cliCod").value = c.cod;
  $("cliNombre").value = c.razon_social;
  $("cliDto").value = c.dto_vol;
  $("cliLoc").value = c.localidad || "";
  $("cliCom").value = c.comisionista_id || "";
  window.scrollTo({ top: 0, behavior: "smooth" });
}

async function guardarCliente() {
  const r = await rpc("milver_admin_upsert_cliente", {
    p_pin: adminPin,
    p_cod: ($("cliCod")?.value || "").trim(),
    p_razon_social: ($("cliNombre")?.value || "").trim(),
    p_dto_vol: Number($("cliDto")?.value) || 0,
    p_localidad: ($("cliLoc")?.value || "").trim() || null,
    p_comisionista_id: Number($("cliCom")?.value) || null,
  });
  mostrarResultado("clientesResultado", r, "Cliente guardado.");
  if (r.ok) {
    for (const id of ["cliCod", "cliNombre", "cliDto", "cliLoc"]) $(id).value = "";
    loadClientes();
    loadStats(true);
  }
}

async function borrarCliente(cod) {
  if (!confirm(`¿Borrar el cliente ${cod}? Se borran también su surtido y sus ventas importadas.`)) return;
  const r = await rpc("milver_admin_delete_cliente", { p_pin: adminPin, p_cod: cod });
  mostrarResultado("clientesResultado", r, `Cliente ${cod} borrado.`);
  if (r.ok) loadClientes();
}

async function asignarCartera() {
  if (!clientesSel.size) {
    alert("Tildá al menos un cliente en la tabla.");
    return;
  }
  const comId = Number($("carteraCom")?.value) || null;
  const r = await rpc("milver_admin_set_cartera", {
    p_pin: adminPin,
    p_cliente_cods: [...clientesSel],
    p_comisionista_id: comId,
  });
  mostrarResultado("clientesResultado", r, `${r.actualizados} clientes asignados.`);
  if (r.ok) {
    loadClientes();
    loadStats(true);
  }
}

async function importarClientes() {
  const box = $("clientesResultado");
  try {
    box.innerHTML = "Leyendo archivo…";
    const filas = await leerExcel("fileClientes");
    const rows = filas
      .map((f) => ({
        cod: String(colVal(f, ["cod", "codigo", "código"])).trim(),
        razon_social: String(colVal(f, ["razon_social", "razon social", "razón social", "nombre", "cliente"])).trim(),
        dto_vol: Number(colVal(f, ["dto_vol", "dto", "descuento"])) || 0,
        localidad: String(colVal(f, ["localidad", "ciudad"])).trim(),
        comisionista_id: Number(colVal(f, ["comisionista_id", "comisionista"])) || null,
      }))
      .filter((r) => r.cod && r.razon_social);
    if (!rows.length) {
      box.innerHTML = `<div class="mva-error">✗ No se encontraron filas con cod y razón social.</div>`;
      return;
    }
    const r = await rpc("milver_admin_import_clientes", { p_pin: adminPin, p_rows: rows });
    mostrarResultado("clientesResultado", r, `${r.insertados} nuevos, ${r.actualizados} actualizados.`);
    if (r.ok) {
      loadClientes();
      loadStats(true);
    }
  } catch (e) {
    box.innerHTML = `<div class="mva-error">✗ ${e.message}</div>`;
  }
}

/***********************
 * COMISIONISTAS
 ***********************/
function renderComisionistas() {
  const box = $("comLista");
  if (!box) return;
  box.innerHTML =
    `<table class="mva-table"><thead><tr>
       <th>ID</th><th>Nombre</th><th>Clientes</th><th>Estado</th><th>Nuevo PIN</th><th></th>
     </tr></thead><tbody>` +
    comisionistas
      .map(
        (c) => `
      <tr>
        <td>${c.id}</td>
        <td><input id="comNom-${c.id}" class="mv-input mva-mini" value="${c.nombre}"></td>
        <td>${c.clientes}</td>
        <td>
          <label class="mva-check"><input id="comAct-${c.id}" type="checkbox" ${c.activo ? "checked" : ""}> activo</label>
        </td>
        <td><input id="comPin-${c.id}" class="mv-input mva-mini" placeholder="(sin cambio)"></td>
        <td><button type="button" class="mva-mini-btn" onclick="guardarComisionista(${c.id})">Guardar</button></td>
      </tr>`,
      )
      .join("") +
    "</tbody></table>";
}

async function guardarComisionista(id) {
  const r = await rpc("milver_admin_upsert_comisionista", {
    p_pin: adminPin,
    p_id: id,
    p_nombre: ($(`comNom-${id}`)?.value || "").trim(),
    p_pin_nuevo: ($(`comPin-${id}`)?.value || "").trim() || null,
    p_activo: !!$(`comAct-${id}`)?.checked,
  });
  mostrarResultado("comResultado", r, "Comisionista actualizado.");
  if (r.ok) loadStats(true);
}

async function altaComisionista() {
  const r = await rpc("milver_admin_upsert_comisionista", {
    p_pin: adminPin,
    p_id: null,
    p_nombre: ($("comNombre")?.value || "").trim(),
    p_pin_nuevo: ($("comPin")?.value || "").trim(),
    p_activo: true,
  });
  mostrarResultado("comResultado", r, `Comisionista creado (id ${r.id}).`);
  if (r.ok) {
    $("comNombre").value = "";
    $("comPin").value = "";
    loadStats(true);
  }
}

/***********************
 * GANANCIAS (acceso maestro)
 ***********************/
const ESTADO_LABEL = { nuevo: "Nuevo", en_armado: "En armado", armado: "Armado", despachado: "Despachado" };

async function loadGanancias() {
  if (!adminPin) return;
  const cards = $("ganCards");
  if (cards) cards.innerHTML = "Cargando…";
  const r = await rpc("milver_admin_ganancias", {
    p_pin: adminPin,
    p_desde: $("ganDesde")?.value || null,
    p_hasta: $("ganHasta")?.value || null,
  });
  if (!r.ok) {
    if (cards) cards.innerHTML = `<div class="mva-error">${r.error}</div>`;
    return;
  }
  const dias = r.dias || [];
  const pedidos = r.pedidos || [];
  const hoyStr = new Date().toISOString().slice(0, 10);
  const hoy = dias.find((d) => d.fecha === hoyStr) || { pedidos: 0, venta: 0, costo: 0, ganancia: 0 };
  const tot = dias.reduce((a, d) => ({ venta: a.venta + Number(d.venta), ganancia: a.ganancia + Number(d.ganancia), pedidos: a.pedidos + Number(d.pedidos) }), { venta: 0, ganancia: 0, pedidos: 0 });
  if (cards) {
    cards.innerHTML = [
      ["Pedidos HOY", hoy.pedidos, ""],
      ["Venta HOY", "$" + formatMoney(hoy.venta), ""],
      ["Ganancia HOY", "$" + formatMoney(hoy.ganancia), hoy.venta > 0 ? Math.round((hoy.ganancia / hoy.venta) * 100) + "% margen" : ""],
      ["Ganancia período", "$" + formatMoney(tot.ganancia), tot.pedidos + " pedidos · $" + formatMoney(tot.venta) + " venta"],
    ].map(([t, v, sub]) => `
      <div class="mva-card">
        <div class="mva-card-num">${v}</div>
        <div class="mva-card-tit">${t}</div>
        ${sub ? `<div class="mva-card-sub">${sub}</div>` : ""}
      </div>`).join("");
  }
  const diasBox = $("ganDias");
  if (diasBox) {
    diasBox.innerHTML = dias.length
      ? `<table class="mva-table"><thead><tr><th>Fecha</th><th>Pedidos</th><th>Venta</th><th>Costo</th><th>Ganancia</th><th>Margen</th></tr></thead><tbody>` +
        dias.map((d) => `<tr><td>${d.fecha}</td><td>${d.pedidos}</td><td>$${formatMoney(d.venta)}</td><td>$${formatMoney(d.costo)}</td><td><strong>$${formatMoney(d.ganancia)}</strong></td><td>${d.venta > 0 ? Math.round((d.ganancia / d.venta) * 100) + "%" : "—"}</td></tr>`).join("") +
        "</tbody></table>"
      : "Sin pedidos en el período.";
  }
  const pedBox = $("ganPedidos");
  if (pedBox) {
    pedBox.innerHTML = pedidos.length
      ? `<table class="mva-table"><thead><tr><th>#</th><th>Fecha</th><th>Comisionista</th><th>Cliente</th><th>Estado</th><th>Venta</th><th>Ganancia</th></tr></thead><tbody>` +
        pedidos.map((p) => `<tr><td>${p.numero}</td><td>${new Date(p.fecha).toLocaleString("es-AR", { dateStyle: "short", timeStyle: "short" })}</td><td>${p.comisionista}</td><td>${p.cliente}</td><td>${ESTADO_LABEL[p.estado] || p.estado}</td><td>$${formatMoney(p.venta)}</td><td><strong>$${formatMoney(p.ganancia)}</strong></td></tr>`).join("") +
        "</tbody></table>"
      : "Sin pedidos en el período.";
  }
}

/***********************
 * VENTAS
 ***********************/
async function importarVentas() {
  const box = $("ventasResultado");
  try {
    box.innerHTML = "Leyendo archivo…";
    const filas = await leerExcel("fileVentas");
    const rows = filas
      .map((f) => {
        let fecha = colVal(f, ["fecha", "date"]);
        if (fecha instanceof Date) fecha = fecha.toISOString().slice(0, 10);
        else if (typeof fecha === "number") {
          // fecha serial de Excel
          const d = XLSX.SSF ? XLSX.SSF.parse_date_code(fecha) : null;
          fecha = d ? `${d.y}-${String(d.m).padStart(2, "0")}-${String(d.d).padStart(2, "0")}` : "";
        }
        return {
          cliente_cod: String(colVal(f, ["cliente_cod", "cliente", "cod_cliente"])).trim(),
          item_cod: String(colVal(f, ["item_cod", "cod", "articulo", "artículo"])).trim(),
          fecha: String(fecha || "").slice(0, 10),
          cantidad: Number(colVal(f, ["cantidad", "unidades", "cajas", "bultos"])) || 0,
        };
      })
      .filter((r) => r.cliente_cod && r.item_cod);
    if (!rows.length) {
      box.innerHTML = `<div class="mva-error">✗ No se encontraron filas con cliente_cod e item_cod.</div>`;
      return;
    }
    box.innerHTML = `Importando ${rows.length.toLocaleString("es-AR")} filas…`;
    const r = await rpc("milver_admin_import_ventas", { p_pin: adminPin, p_rows: rows, p_reemplazar: true });
    mostrarResultado(
      "ventasResultado",
      r,
      `${r.ventas_insertadas} ventas cargadas, surtido reconstruido (${r.surtido_filas} filas). ${r.filas_sin_cliente} filas con cliente inexistente descartadas.`,
    );
    loadStats();
  } catch (e) {
    box.innerHTML = `<div class="mva-error">✗ ${e.message}</div>`;
  }
}

function descargarModeloVentas() {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.json_to_sheet([
      { cliente_cod: "C001", item_cod: "1", fecha: "2026-05-10", cantidad: 36 },
      { cliente_cod: "C001", item_cod: "1250", fecha: "2026-06-02", cantidad: 12 },
    ]),
    "Ventas",
  );
  XLSX.writeFile(wb, "milver-modelo-ventas.xlsx");
}

/***********************
 * INIT + EXPORTS
 ***********************/
document.addEventListener("DOMContentLoaded", () => {
  restoreSession();
  const pin = $("loginPin");
  if (pin) {
    pin.addEventListener("keydown", (e) => {
      if (e.key === "Enter") doLogin();
    });
  }
});

window.doLogin = doLogin;
window.logout = logout;
window.showTab = showTab;
window.loadPedidos = loadPedidos;
window.descargarPedidosExcel = descargarPedidosExcel;
window.importarCatalogo = importarCatalogo;
window.descargarModeloCatalogo = descargarModeloCatalogo;
window.renderClientes = renderClientes;
window.toggleSelCliente = toggleSelCliente;
window.editarCliente = editarCliente;
window.guardarCliente = guardarCliente;
window.borrarCliente = borrarCliente;
window.asignarCartera = asignarCartera;
window.importarClientes = importarClientes;
window.guardarComisionista = guardarComisionista;
window.altaComisionista = altaComisionista;
window.importarVentas = importarVentas;
window.loadGanancias = loadGanancias;
window.descargarModeloVentas = descargarModeloVentas;
