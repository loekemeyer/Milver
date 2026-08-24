"use strict";

/***********************
 * MILVER DEPÓSITO
 * Botonera para operarios que arman pedidos (inspirada en la de
 * Producción Virgilio). Cola de pedidos entrantes → EA (empezar
 * armado) → TA (armado listo) → DES (despachado). Cada evento
 * queda registrado con el nombre del operario.
 ***********************/
const SUPABASE_URL = "https://kwkclwhmoygunqmlegrg.supabase.co";
const SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imt3a2Nsd2htb3lndW5xbWxlZ3JnIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njk1MjA2NzUsImV4cCI6MjA4NTA5NjY3NX0.soqPY5hfA3RkAJ9jmIms8UtEGUc4WpZztpEbmDijOgU";

// Si el CDN de Supabase no cargó, no matamos la página: mostramos aviso + Reintentar.
let supabaseClient = null;
try {
  supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
} catch (e) {
  console.error("Supabase no cargó:", e);
}

let depPin = null;
let operario = null;
let pedidos = [];
let pedidoAbierto = null;

const $ = (id) => document.getElementById(id);

const ESTADO = {
  nuevo: { label: "Nuevo", clase: "dep-badge-nuevo" },
  en_picking: { label: "En picking", clase: "dep-badge-armando" },
  pickeado: { label: "Pickeado", clase: "dep-badge-armado" },
  despachado: { label: "Despachado", clase: "dep-badge-desp" },
};

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
    depPin = sessionStorage.getItem("milver_dep_pin") || null;
    operario = sessionStorage.getItem("milver_dep_operario") || null;
  } catch (e) {}
  syncLoginUI();
  if (depPin && operario) {
    setOperarioTag();
    loadCola();
  } else {
    poblarOperarios();
  }
}

// Llenar el desplegable con los operarios activos.
// A prueba de fallos: si algo falla, muestra aviso + botón Reintentar en vez
// de quedar en blanco (así el operario nunca queda atrapado sin poder elegir).
async function poblarOperarios() {
  const sel = $("loginOperario");
  if (!sel) return;
  const err = $("loginError");
  const retry = $("reintentarOperarios");
  const mostrarError = (msg) => {
    sel.innerHTML = '<option value="">No se pudo cargar</option>';
    if (err) { err.textContent = msg; err.style.display = ""; }
    if (retry) retry.style.display = "";
  };

  if (err) err.style.display = "none";
  if (retry) retry.style.display = "none";
  sel.innerHTML = "<option>Cargando…</option>";

  if (!supabaseClient) {
    return mostrarError("No cargó la conexión. Revisá internet y tocá Reintentar.");
  }
  try {
    const { data, error } = await supabaseClient.rpc("milver_operarios_pub");
    if (error) throw error;
    const lista = Array.isArray(data) ? data : [];
    if (!lista.length) {
      sel.innerHTML = '<option value="">Sin operarios cargados</option>';
      return;
    }
    sel.innerHTML =
      '<option value="">Elegí tu nombre…</option>' +
      lista.map((o) => `<option value="${o.nombre}">${o.nombre}</option>`).join("");
  } catch (e) {
    console.error("milver_operarios_pub:", e);
    mostrarError("No se pudo cargar la lista. Tocá Reintentar.");
  }
}

function syncLoginUI() {
  const ov = $("loginOverlay");
  if (ov) ov.style.display = depPin && operario ? "none" : "";
}

function setOperarioTag() {
  const t = $("operarioTag");
  if (t) t.textContent = "👷 " + operario;
}

async function doLogin() {
  const nom = ($("loginOperario")?.value || "").trim();
  const err = $("loginError");
  if (!nom) {
    if (err) { err.textContent = "Elegí tu nombre de la lista."; err.style.display = ""; }
    return;
  }
  const btn = $("loginBtn");
  if (btn) btn.disabled = true;
  // Los operarios entran sin PIN: la credencial es el propio nombre.
  const r = await rpc("milver_dep_login", { p_pin: nom });
  if (btn) btn.disabled = false;
  if (!r.ok) {
    if (err) { err.textContent = r.error || "Operario no válido"; err.style.display = ""; }
    return;
  }
  depPin = nom;
  operario = nom;
  try {
    sessionStorage.setItem("milver_dep_pin", nom);
    sessionStorage.setItem("milver_dep_operario", nom);
  } catch (e) {}
  setOperarioTag();
  syncLoginUI();
  loadCola();
}

function logout() {
  depPin = null;
  operario = null;
  try {
    sessionStorage.removeItem("milver_dep_pin");
    sessionStorage.removeItem("milver_dep_operario");
  } catch (e) {}
  syncLoginUI();
}

/***********************
 * COLA
 ***********************/
async function loadCola() {
  const box = $("colaLista");
  if (!box || !depPin) return;
  box.innerHTML = '<div class="dep-cargando">Cargando…</div>';
  const r = await rpc("milver_dep_pedidos", { p_pin: depPin });
  if (!r.ok) {
    box.innerHTML = `<div class="mva-error">${r.error}</div>`;
    return;
  }
  pedidos = r.pedidos || [];
  const pendientes = pedidos.filter((p) => p.estado !== "despachado");
  if (!pendientes.length) {
    box.innerHTML = '<div class="dep-vacio">✅ No hay pedidos pendientes.</div>';
  } else {
    box.innerHTML = pendientes.map(colaCardHtml).join("");
  }
  const desp = pedidos.filter((p) => p.estado === "despachado");
  if (desp.length) {
    box.innerHTML +=
      `<div class="dep-sep">Despachados hoy (${desp.length})</div>` +
      desp.map(colaCardHtml).join("");
  }
}

function colaCardHtml(p) {
  const e = ESTADO[p.estado] || { label: p.estado, clase: "" };
  const fecha = new Date(p.fecha).toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit" });
  const prog = (p.items_total || 0) > 0 ? ` · ${p.items_pick || 0}/${p.items_total} pickeados` : "";
  const falt = p.faltantes ? ` · ⚠ ${p.faltantes} faltante${p.faltantes > 1 ? "s" : ""}` : "";
  return `
    <button type="button" class="dep-cola-card" onclick="abrirPedido(${p.numero})">
      <div class="dep-cola-top">
        <span class="dep-cola-num">#${p.numero}</span>
        <span class="dep-badge ${e.clase}">${e.label}</span>
      </div>
      <div class="dep-cola-cliente">${p.cliente}</div>
      <div class="dep-cola-meta">${p.unidades} u. · ${p.items_total || 0} art.${prog}${falt} · ${fecha}${
        p.armado_por ? " · 👷 " + p.armado_por : ""
      }</div>
    </button>
  `;
}

/***********************
 * DETALLE + PICKING ítem por ítem
 ***********************/
let pedidoAbiertoNum = null;
let pedidoItems = [];
let pickItem = null;   // ítem que se está pickeando
let _pickBuffer = "";

async function abrirPedido(numero) {
  pedidoAbiertoNum = numero;
  await cargarDetalle();
  $("pantallaCola").classList.remove("active");
  $("pantallaPedido").classList.add("active");
  window.scrollTo(0, 0);
}

async function cargarDetalle() {
  const r = await rpc("milver_dep_detalle", { p_pin: depPin, p_numero: pedidoAbiertoNum });
  if (!r.ok) {
    $("marcarResultado").innerHTML = `<div class="mva-error">${r.error}</div>`;
    return;
  }
  const p = r.pedido;
  pedidoAbierto = p;
  pedidoItems = p.items || [];
  $("pedidoTitulo").textContent = `#${p.numero} · ${p.cliente}`;
  const e = ESTADO[p.estado] || { label: p.estado, clase: "" };
  const est = $("pedidoEstado");
  est.textContent = e.label;
  est.className = "dep-estado dep-badge " + e.clase;

  $("pedidoInfo").innerHTML =
    `<div>Comisionista: <strong>${p.comisionista}</strong></div>` +
    (p.armado_por ? `<div>Pickea: <strong>${p.armado_por}</strong></div>` : "") +
    (p.observaciones ? `<div class="dep-obs">Obs: ${p.observaciones}</div>` : "");

  renderItems();
  actualizarProgreso();
  actualizarBotonera(p.estado);
  $("marcarResultado").innerHTML = "";
}

function renderItems() {
  const box = $("pedidoItems");
  box.innerHTML = pedidoItems.map((i) => {
    let estado, clase, detalle;
    if (i.pick_falta) {
      estado = "⚠ FALTANTE"; clase = "dep-item-falta"; detalle = "sin stock";
    } else if (i.pick_unidades !== null && i.pick_unidades !== undefined) {
      const parcial = Number(i.pick_unidades) !== Number(i.unidades);
      estado = "✓ " + i.pick_unidades + " u."; clase = parcial ? "dep-item-parcial" : "dep-item-ok";
      detalle = parcial ? `pedidas ${i.unidades}` : "";
    } else {
      estado = "Pendiente"; clase = "dep-item-pend"; detalle = "";
    }
    const done = i.pick_falta || (i.pick_unidades !== null && i.pick_unidades !== undefined);
    return `
      <div class="dep-pick-row ${clase}">
        <div class="dep-pick-info" onclick="abrirPick(${i.id})">
          <div class="dep-pick-desc">${i.descripcion}</div>
          <div class="dep-pick-meta">${i.cod} · pedido: <strong>${i.unidades} u.</strong>${detalle ? " · " + detalle : ""}</div>
        </div>
        <div class="dep-pick-estado ${clase}">${estado}</div>
        ${done
          ? `<button type="button" class="dep-pick-undo" onclick="undoPick(${i.id})" aria-label="Deshacer">↺</button>`
          : `<button type="button" class="dep-pick-check" onclick="abrirPick(${i.id})">Juntar</button>`}
      </div>`;
  }).join("");
}

function actualizarProgreso() {
  const total = pedidoItems.length;
  const hechos = pedidoItems.filter((i) => i.pick_falta || (i.pick_unidades !== null && i.pick_unidades !== undefined)).length;
  const pct = total ? Math.round((hechos / total) * 100) : 0;
  const bar = $("progBar");
  if (bar) bar.style.width = pct + "%";
  const txt = $("progTxt");
  if (txt) txt.textContent = `${hechos} / ${total} ítems pickeados`;
}

// Solo se habilita el botón que corresponde al estado.
function actualizarBotonera(estado) {
  const habilitar = { TA: estado === "en_picking" || estado === "nuevo", DES: estado === "pickeado" };
  const bTA = $("btnTA"), bDES = $("btnDES");
  if (bTA) bTA.classList.toggle("dep-box-off", !habilitar.TA);
  if (bDES) bDES.classList.toggle("dep-box-off", !habilitar.DES);
}

/***********************
 * MODAL de picking (teclado propio)
 ***********************/
function abrirPick(itemId) {
  pickItem = pedidoItems.find((i) => i.id === itemId);
  if (!pickItem) return;
  $("pickTitulo").textContent = pickItem.descripcion;
  $("pickPedido").textContent = `${pickItem.cod} · pedido: ${pickItem.unidades} u.`;
  // arranca con lo pedido (lo más común: junta todo)
  _pickBuffer = pickItem.pick_falta ? "" : String(pickItem.pick_unidades ?? pickItem.unidades);
  _pickRender();
  $("pickModal").style.display = "";
}
function cerrarPick() { $("pickModal").style.display = "none"; pickItem = null; _pickBuffer = ""; }
function _pickRender() { const d = $("pickDisplay"); if (d) d.textContent = _pickBuffer === "" ? "0" : _pickBuffer; }
function pickTecla(x) { if (_pickBuffer === "0") _pickBuffer = ""; if (_pickBuffer.length < 6) { _pickBuffer += x; _pickRender(); } }
function pickBorrar() { _pickBuffer = _pickBuffer.slice(0, -1); _pickRender(); }
function pickBorrarTodo() { _pickBuffer = ""; _pickRender(); }

async function pickConfirmar() {
  if (!pickItem) return;
  const u = Math.max(0, parseInt(_pickBuffer, 10) || 0);
  await _enviarPick(pickItem.id, u, false);
}
async function pickFaltante() {
  if (!pickItem) return;
  await _enviarPick(pickItem.id, null, true);
}

async function _enviarPick(itemId, unidades, falta) {
  const r = await rpc("milver_dep_pick", {
    p_pin: depPin, p_item_id: itemId, p_unidades: unidades, p_falta: falta, p_operario: operario,
  });
  if (!r.ok) { alert(r.error); return; }
  // actualizar en memoria y re-render sin recargar todo
  const it = pedidoItems.find((i) => i.id === itemId);
  if (it) { it.pick_unidades = falta ? null : unidades; it.pick_falta = !!falta; it.pick_por = operario; }
  cerrarPick();
  renderItems();
  actualizarProgreso();
  if (r.estado) actualizarBotonera(r.estado);
}

async function undoPick(itemId) {
  const r = await rpc("milver_dep_pick_undo", { p_pin: depPin, p_item_id: itemId });
  if (!r.ok) { alert(r.error); return; }
  const it = pedidoItems.find((i) => i.id === itemId);
  if (it) { it.pick_unidades = null; it.pick_falta = false; }
  renderItems();
  actualizarProgreso();
}

async function finalizar(evento) {
  const btn = $("btn" + evento);
  if (btn && btn.classList.contains("dep-box-off")) return;
  const r = await rpc("milver_dep_finalizar", {
    p_pin: depPin, p_numero: pedidoAbiertoNum, p_evento: evento, p_operario: operario,
  });
  const res = $("marcarResultado");
  if (!r.ok) { if (res) res.innerHTML = `<div class="mva-error">${r.error}</div>`; return; }
  pedidoAbierto.estado = r.estado;
  const e = ESTADO[r.estado] || { label: r.estado, clase: "" };
  const est = $("pedidoEstado");
  est.textContent = e.label;
  est.className = "dep-estado dep-badge " + e.clase;
  actualizarBotonera(r.estado);
  const faltas = r.faltantes ? ` (${r.faltantes} faltante${r.faltantes > 1 ? "s" : ""})` : "";
  if (res) res.innerHTML = `<div class="mva-ok">✓ ${e.label}${faltas}</div>`;
  if (r.estado === "despachado") setTimeout(volverACola, 800);
}

function volverACola() {
  $("pantallaPedido").classList.remove("active");
  $("pantallaCola").classList.add("active");
  loadCola();
}

/***********************
 * INIT + EXPORTS
 ***********************/
document.addEventListener("DOMContentLoaded", () => {
  const ver = $("depVersion");
  if (ver && typeof MILVER_VERSION !== "undefined") ver.textContent = "v" + MILVER_VERSION;
  restoreSession();
  const pin = $("loginPin");
  if (pin) pin.addEventListener("keydown", (e) => { if (e.key === "Enter") doLogin(); });
  // Refresco automático de la cola cada 30 s mientras se mira la lista.
  setInterval(() => {
    if (depPin && operario && $("pantallaCola")?.classList.contains("active")) loadCola();
  }, 30000);
});

window.doLogin = doLogin;
window.poblarOperarios = poblarOperarios;
window.logout = logout;
window.loadCola = loadCola;
window.abrirPedido = abrirPedido;
window.volverACola = volverACola;
window.abrirPick = abrirPick;
window.cerrarPick = cerrarPick;
window.pickTecla = pickTecla;
window.pickBorrar = pickBorrar;
window.pickBorrarTodo = pickBorrarTodo;
window.pickConfirmar = pickConfirmar;
window.pickFaltante = pickFaltante;
window.undoPick = undoPick;
window.finalizar = finalizar;
