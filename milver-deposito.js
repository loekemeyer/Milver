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

const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

let depPin = null;
let operario = null;
let pedidos = [];
let pedidoAbierto = null;

const $ = (id) => document.getElementById(id);

const ESTADO = {
  nuevo: { label: "Nuevo", clase: "dep-badge-nuevo" },
  en_armado: { label: "En armado", clase: "dep-badge-armando" },
  armado: { label: "Armado", clase: "dep-badge-armado" },
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
  const pin = ($("loginPin")?.value || "").trim();
  const err = $("loginError");
  if (!nom || !pin) {
    if (err) { err.textContent = "Completá tu nombre y el PIN."; err.style.display = ""; }
    return;
  }
  const btn = $("loginBtn");
  if (btn) btn.disabled = true;
  const r = await rpc("milver_dep_login", { p_pin: pin });
  if (btn) btn.disabled = false;
  if (!r.ok) {
    if (err) { err.textContent = r.error || "PIN incorrecto"; err.style.display = ""; }
    return;
  }
  depPin = pin;
  operario = nom;
  try {
    sessionStorage.setItem("milver_dep_pin", pin);
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
  return `
    <button type="button" class="dep-cola-card" onclick="abrirPedido(${p.numero})">
      <div class="dep-cola-top">
        <span class="dep-cola-num">#${p.numero}</span>
        <span class="dep-badge ${e.clase}">${e.label}</span>
      </div>
      <div class="dep-cola-cliente">${p.cliente}</div>
      <div class="dep-cola-meta">${p.unidades} u. · ${(p.items || []).length} art. · ${fecha}${
        p.armado_por ? " · 👷 " + p.armado_por : ""
      }</div>
    </button>
  `;
}

/***********************
 * DETALLE + BOTONERA
 ***********************/
function abrirPedido(numero) {
  pedidoAbierto = pedidos.find((p) => p.numero === numero);
  if (!pedidoAbierto) return;
  const p = pedidoAbierto;
  $("pedidoTitulo").textContent = `#${p.numero} · ${p.cliente}`;
  const e = ESTADO[p.estado] || { label: p.estado, clase: "" };
  const est = $("pedidoEstado");
  est.textContent = e.label;
  est.className = "dep-estado dep-badge " + e.clase;

  $("pedidoInfo").innerHTML =
    `<div>Comisionista: <strong>${p.comisionista}</strong></div>` +
    `<div>Total: <strong>${p.unidades} unidades</strong> en ${(p.items || []).length} artículos</div>` +
    (p.armado_por ? `<div>Armado por: <strong>${p.armado_por}</strong></div>` : "") +
    (p.observaciones ? `<div class="dep-obs">Obs: ${p.observaciones}</div>` : "");

  $("pedidoItems").innerHTML = (p.items || [])
    .map(
      (i) => `
      <div class="dep-item">
        <span class="dep-item-cod">${i.cod}</span>
        <span class="dep-item-desc">${i.descripcion}</span>
        <span class="dep-item-qty">${i.unidades} u.</span>
      </div>`,
    )
    .join("");

  actualizarBotonera(p.estado);
  $("marcarResultado").innerHTML = "";
  $("pantallaCola").classList.remove("active");
  $("pantallaPedido").classList.add("active");
  window.scrollTo(0, 0);
}

// Habilita solo el botón que corresponde al estado actual.
function actualizarBotonera(estado) {
  const habilitar = { EA: estado === "nuevo", TA: estado === "en_armado", DES: estado === "armado" };
  for (const code of ["EA", "TA", "DES"]) {
    const b = $("btn" + code);
    if (b) b.classList.toggle("dep-box-off", !habilitar[code]);
  }
}

async function marcar(evento) {
  if (!pedidoAbierto) return;
  const btn = $("btn" + evento);
  if (btn && btn.classList.contains("dep-box-off")) return;
  const res = $("marcarResultado");
  if (res) res.innerHTML = "Guardando…";
  const r = await rpc("milver_dep_evento", {
    p_pin: depPin,
    p_numero: pedidoAbierto.numero,
    p_evento: evento,
    p_operario: operario,
  });
  if (!r.ok) {
    if (res) res.innerHTML = `<div class="mva-error">${r.error}</div>`;
    return;
  }
  pedidoAbierto.estado = r.estado;
  if (evento === "EA") pedidoAbierto.armado_por = operario;
  const e = ESTADO[r.estado] || { label: r.estado, clase: "" };
  const est = $("pedidoEstado");
  est.textContent = e.label;
  est.className = "dep-estado dep-badge " + e.clase;
  actualizarBotonera(r.estado);
  if (res) res.innerHTML = `<div class="mva-ok">✓ ${e.label}</div>`;
  // Al despachar, volver a la cola después de un instante.
  if (r.estado === "despachado") {
    setTimeout(() => { volverACola(); }, 700);
  }
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
window.logout = logout;
window.loadCola = loadCola;
window.abrirPedido = abrirPedido;
window.marcar = marcar;
window.volverACola = volverACola;
