"use strict";

/***********************
 * SUPABASE CONFIG
 * Mismo proyecto que LK; TODO lo de Milver vive en tablas/RPCs con
 * prefijo milver_ para poder transferirlo fácil a su propio proyecto.
 ***********************/
const SUPABASE_URL = "https://kwkclwhmoygunqmlegrg.supabase.co";
const SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imt3a2Nsd2htb3lndW5xbWxlZ3JnIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njk1MjA2NzUsImV4cCI6MjA4NTA5NjY3NX0.soqPY5hfA3RkAJ9jmIms8UtEGUc4WpZztpEbmDijOgU";

const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

/***********************
 * ESTADO GLOBAL
 ***********************/
let WEB_ORDER_DISCOUNT = 0; // Milver NO aplica descuento por pedido web (a diferencia de LK)

let products = [];        // filas crudas de milver_catalogo (una por ítem/variante)
let articles = [];        // agrupado: una entrada por artículo (madre con variantes, o simple)
let clientes = [];
let cart = [];            // { cod, descripcion, variante, list_price, qty } — qty en UNIDADES
let session = null;       // { id, nombre, pin }
let clienteSel = null;    // fila de milver_clientes elegida en el carrito
let searchTerm = "";
let categoryFilter = "";
let sortMode = "cod";
let lastConfirmedOrder = null;
let surtidoSet = new Set(); // cods que el cliente elegido le compra a Milver
let soloSurtido = false;    // filtro "solo lo que compra"
let editandoPedido = null;  // nº de pedido en edición (null = pedido nuevo)

const CATEGORY_ORDER = ["Loekemeyer", "Cocina", "Bazar", "Limpieza", "Organización", "Textil"];
const PAGE_SIZE = 48;     // cards por tanda de render (scroll infinito)
let _renderLimit = PAGE_SIZE;

const $ = (id) => document.getElementById(id);

function formatMoney(n) {
  return Math.round(Number(n || 0)).toLocaleString("es-AR");
}

// Parte numérica del cod ("L506" → 506); sin dígitos → al fondo.
function codNum(cod) {
  const n = parseInt(String(cod).replace(/\D/g, ""), 10);
  return Number.isFinite(n) ? n : 99999999;
}

// ¿El cod matchea la búsqueda por código? Exacto, con o sin el prefijo
// L de los artículos Loekemeyer ("506" encuentra "L506" y viceversa).
function codMatch(cod, q) {
  const c = String(cod).toLowerCase();
  return c === q || c === "l" + q || c.replace(/^l/, "") === q;
}

/***********************
 * SECCIONES (mismo patrón que LK: .section + .active)
 ***********************/
function showSection(id) {
  if ((id === "carrito" || id === "historial" || id === "inicio") && !session) return;
  document.querySelectorAll(".section").forEach((s) => s.classList.remove("active"));
  const el = $(id);
  if (el) el.classList.add("active");
  document.body.classList.toggle("section-carrito", id === "carrito");
  if (id === "carrito") renderCart();
  updateCartBar();
  if (id === "inicio") loadInicio();
  if (id === "historial") loadHistorial();
  try {
    window.scrollTo({ top: 0, behavior: "auto" });
  } catch (e) {
    window.scrollTo(0, 0);
  }
}

/***********************
 * LOGIN
 ***********************/
function restoreSession() {
  try {
    const raw = localStorage.getItem("milver_session");
    if (raw) session = JSON.parse(raw);
  } catch (e) {
    session = null;
  }
  syncLoginUI();
}

function syncLoginUI() {
  const overlay = $("loginOverlay");
  const badge = $("userBadge");
  const logoutBtn = $("logoutBtn");
  if (session) {
    if (overlay) overlay.style.display = "none";
    if (badge) {
      badge.textContent = session.nombre;
      badge.style.display = "";
    }
    if (logoutBtn) logoutBtn.style.display = "";
  } else {
    if (overlay) overlay.style.display = "";
    if (badge) badge.style.display = "none";
    if (logoutBtn) logoutBtn.style.display = "none";
  }
}

let loginRole = "comisionista"; // comisionista | armador | admin
let _loginListas = { comisionista: null, armador: null }; // cache de nombres

// Cambiar el rol seleccionado en el login: muestra/oculta el desplegable de
// nombres y ajusta la etiqueta. Admin solo pide PIN.
function setRole(role) {
  loginRole = role;
  document.querySelectorAll(".mv-role-tab").forEach((t) =>
    t.classList.toggle("active", t.dataset.role === role));
  const field = $("loginNombreField");
  const label = $("loginNombreLabel");
  const errBox = $("loginError");
  if (errBox) errBox.style.display = "none";
  const pinInp = $("loginPin");
  if (pinInp) pinInp.value = "";
  if (role === "admin") {
    if (field) field.style.display = "none";
    return;
  }
  if (field) field.style.display = "";
  if (label) label.textContent = role === "armador" ? "Operario" : "Comisionista";
  poblarLoginNombres(role);
}

// Trae la lista de nombres del rol y llena el <select> (con caché).
async function poblarLoginNombres(role) {
  const sel = $("loginNombre");
  if (!sel) return;
  if (_loginListas[role]) {
    _pintarLoginNombres(sel, _loginListas[role], role);
    return;
  }
  sel.innerHTML = "<option>Cargando…</option>";
  const fn = role === "armador" ? "milver_operarios_pub" : "milver_comisionistas_pub";
  const { data } = await supabaseClient.rpc(fn);
  const lista = Array.isArray(data) ? data : [];
  _loginListas[role] = lista;
  _pintarLoginNombres(sel, lista, role);
}

function _pintarLoginNombres(sel, lista, role) {
  if (!lista.length) {
    sel.innerHTML = `<option value="">Sin ${role === "armador" ? "operarios" : "comisionistas"} cargados</option>`;
    return;
  }
  sel.innerHTML =
    '<option value="">Elegí tu nombre…</option>' +
    lista.map((c) => `<option value="${c.nombre}">${c.nombre}</option>`).join("");
}

async function doLogin() {
  const pin = ($("loginPin")?.value || "").trim();
  const errBox = $("loginError");
  const btn = $("loginBtn");
  const falla = (msg) => {
    if (btn) btn.disabled = false;
    if (errBox) { errBox.textContent = msg; errBox.style.display = ""; }
  };
  if (!pin) return falla("Ingresá el PIN.");

  // --- ADMIN: solo PIN → panel de administración ---
  if (loginRole === "admin") {
    if (btn) btn.disabled = true;
    const r = await supabaseClient.rpc("milver_admin_login", { p_pin: pin });
    if (r.data?.ok) {
      try { sessionStorage.setItem("milver_admin_pin", pin); } catch (e) {}
      location.href = "milver-admin.html";
      return;
    }
    return falla("PIN de admin incorrecto.");
  }

  const nombre = ($("loginNombre")?.value || "").trim();
  if (!nombre) return falla("Elegí tu nombre de la lista.");

  // --- ARMADOR: nombre de operario + PIN de depósito → panel de depósito ---
  if (loginRole === "armador") {
    if (btn) btn.disabled = true;
    const r = await supabaseClient.rpc("milver_dep_login", { p_pin: pin });
    if (r.data?.ok) {
      try {
        sessionStorage.setItem("milver_dep_pin", pin);
        sessionStorage.setItem("milver_dep_operario", nombre);
      } catch (e) {}
      location.href = "milver-deposito.html";
      return;
    }
    return falla("PIN de depósito incorrecto.");
  }

  // --- COMISIONISTA: nombre + PIN → portal ---
  if (btn) btn.disabled = true;
  const { data, error } = await supabaseClient.rpc("milver_login", {
    p_nombre: nombre,
    p_pin: pin,
  });
  if (error || !data?.ok) {
    return falla(data?.error || "PIN incorrecto o error de conexión.");
  }
  session = { id: data.id, nombre: data.nombre, pin };
  try {
    localStorage.setItem("milver_session", JSON.stringify(session));
  } catch (e) {}
  syncLoginUI();
  await loadClientes();
  restaurarBorrador();
  renderProducts();
  showSection("inicio");
}

function logout() {
  session = null;
  cart = [];
  clientes = [];
  clienteSel = null;
  surtidoSet = new Set();
  soloSurtido = false;
  try {
    localStorage.removeItem("milver_session");
  } catch (e) {}
  updateCartCount();
  syncLoginUI();
  showSection("productos");
}

/***********************
 * CARGA DE DATOS
 ***********************/
async function loadCatalog() {
  const info = $("catalogInfo");
  const { data, error } = await supabaseClient.rpc("milver_catalogo");
  if (error || !Array.isArray(data)) {
    if (info) info.textContent = "Error cargando catálogo. Recargá la página.";
    console.error("milver_catalogo:", error);
    return;
  }
  products = data;

  // Agrupar: un "artículo" por madre_cod (variantes) o por cod (simples).
  const byMadre = new Map();
  articles = [];
  for (const p of products) {
    if (p.madre_cod) {
      let a = byMadre.get(p.madre_cod);
      if (!a) {
        a = {
          key: p.madre_cod,
          descripcion: p.madre_desc || p.descripcion,
          categoria: p.categoria,
          uxb: p.uxb,
          list_price: Number(p.list_price || 0),
          minCod: codNum(p.cod),
          compraLk: !!p.compra_lk,
          ordenLk: p.orden_lk,
          variantes: [],
        };
        byMadre.set(p.madre_cod, a);
        articles.push(a);
      }
      a.variantes.push(p);
      a.minCod = Math.min(a.minCod, codNum(p.cod));
    } else {
      articles.push({
        key: p.cod,
        descripcion: p.descripcion,
        categoria: p.categoria,
        uxb: p.uxb,
        list_price: Number(p.list_price || 0),
        minCod: codNum(p.cod),
        compraLk: !!p.compra_lk,
        ordenLk: p.orden_lk,
        variantes: null,
        item: p,
      });
    }
  }
  if (info) {
    const nVar = articles.filter((a) => a.variantes).length;
    info.textContent = `${products.length.toLocaleString("es-AR")} ítems · ${articles.length.toLocaleString("es-AR")} artículos (${nVar} con variantes)`;
  }
  buildCategoriesMenu();
  renderProducts();
}

// Cartera del comisionista logueado (100 clientes propios).
async function loadClientes() {
  if (!session) return;
  const { data, error } = await supabaseClient.rpc("milver_clientes_list", {
    p_comisionista_id: session.id,
    p_pin: session.pin,
  });
  if (error || !data?.ok) {
    console.error("milver_clientes_list:", error || data?.error);
    return;
  }
  clientes = data.clientes || [];
  const opts =
    '<option value="">— Elegí un cliente —</option>' +
    clientes
      .map(
        (c) =>
          `<option value="${c.cod}">${c.razon_social} (${c.cod})${
            Number(c.dto_vol) > 0 ? ` · ${Math.round(c.dto_vol * 100)}% dto` : ""
          }</option>`,
      )
      .join("");
  const sel = $("clienteSelect");
  if (sel) sel.innerHTML = opts;
  renderClientesCombo("");
}

// ---- Combobox de cliente con búsqueda (toolbar de productos) ----
function renderClientesCombo(q) {
  const drop = $("clienteDropdown");
  if (!drop) return;
  const t = (q || "").toLowerCase().trim();
  const list = t
    ? clientes.filter((c) => c.razon_social.toLowerCase().includes(t) || c.cod.toLowerCase().includes(t) || (c.localidad || "").toLowerCase().includes(t))
    : clientes;
  if (!clientes.length) {
    drop.innerHTML = '<div class="mv-combo-empty">Sin clientes en tu cartera.</div>';
    return;
  }
  drop.innerHTML = list.slice(0, 60).map((c) =>
    `<button type="button" class="mv-combo-item" onclick="elegirClienteCombo('${c.cod}')">
       <span class="mv-combo-nom">${c.razon_social}</span>
       <span class="mv-combo-sub">${c.cod}${c.localidad ? " · " + c.localidad : ""}${Number(c.dto_vol) > 0 ? " · " + Math.round(c.dto_vol * 100) + "% dto" : ""}</span>
     </button>`).join("") +
    (list.length > 60 ? `<div class="mv-combo-empty">Afiná la búsqueda (${list.length} coinciden).</div>` : "") +
    (!list.length ? '<div class="mv-combo-empty">Sin coincidencias.</div>' : "");
}
function filtrarClientesCombo(q) { abrirClientesCombo(); renderClientesCombo(q); }
function abrirClientesCombo() { const d = $("clienteDropdown"); if (d) d.style.display = ""; }
function cerrarClientesCombo() { const d = $("clienteDropdown"); if (d) d.style.display = "none"; }
function elegirClienteCombo(cod) { setCliente(cod); cerrarClientesCombo(); }
function limpiarClienteCombo() { setCliente(""); const i = $("clienteBuscar"); if (i) i.value = ""; renderClientesCombo(""); }

// Elegir cliente carga su surtido (qué le compra a Milver) y marca el catálogo.
async function setCliente(cod) {
  clienteSel = clientes.find((c) => c.cod === cod) || null;
  const sel = $("clienteSelect");
  if (sel && sel.value !== (cod || "")) sel.value = cod || "";
  const inp = $("clienteBuscar");
  if (inp) inp.value = clienteSel ? `${clienteSel.razon_social} (${clienteSel.cod})` : "";
  const clr = $("clienteClear");
  if (clr) clr.style.display = clienteSel ? "" : "none";
  surtidoSet = new Set();
  if (!clienteSel) soloSurtido = false;
  syncSurtidoBar();
  renderCart();
  renderProducts();
  if (clienteSel && session) {
    const { data, error } = await supabaseClient.rpc("milver_surtido", {
      p_comisionista_id: session.id,
      p_pin: session.pin,
      p_cliente_cod: clienteSel.cod,
    });
    if (!error && data?.ok && clienteSel && clienteSel.cod === cod) {
      surtidoSet = new Set((data.cods || []).map(String));
      syncSurtidoBar();
      renderProducts();
      if ($("carrito")?.classList.contains("active")) renderCart();
    }
  }
}

function toggleSoloSurtido() {
  soloSurtido = !soloSurtido;
  _renderLimit = PAGE_SIZE;
  syncSurtidoBar();
  renderProducts();
}

function syncSurtidoBar() {
  const btn = $("soloSurtidoBtn");
  if (!btn) return;
  btn.style.display = clienteSel ? "" : "none";
  btn.classList.toggle("mv-toggle-on", soloSurtido);
  btn.textContent = soloSurtido
    ? "★ Viendo solo lo que compra"
    : "☆ Solo lo que compra " + (clienteSel ? clienteSel.razon_social : "");
}

// ¿El artículo (madre o simple) tiene algún ítem en el surtido del cliente?
function articleEnSurtido(a) {
  if (!surtidoSet.size) return false;
  if (a.variantes) return a.variantes.some((v) => surtidoSet.has(String(v.cod)));
  return surtidoSet.has(String(a.key));
}

/***********************
 * CATEGORÍAS / BÚSQUEDA / ORDEN
 ***********************/
function buildCategoriesMenu() {
  const menu = $("categoriesMenu");
  if (!menu) return;
  const existentes = [...new Set(articles.map((a) => a.categoria))];
  const cats = CATEGORY_ORDER.filter((c) => existentes.includes(c)).concat(
    existentes.filter((c) => !CATEGORY_ORDER.includes(c)).sort((a, b) => a.localeCompare(b, "es")),
  );
  menu.innerHTML =
    `<button type="button" class="dropdown-item" onclick="setCategory('')">Todas</button>` +
    cats
      .map(
        (c) =>
          `<button type="button" class="dropdown-item" onclick="setCategory('${c}')">${c}</button>`,
      )
      .join("");
  const chips = $("catChips");
  if (chips) {
    chips.innerHTML = ["", ...cats]
      .map(
        (c) =>
          `<button type="button" class="mv-chip${categoryFilter === c ? " mv-chip-on" : ""}"
                   onclick="setCategory('${c}')">${c || "Todas"}</button>`,
      )
      .join("");
  }
}

function setCategory(cat) {
  categoryFilter = cat || "";
  _renderLimit = PAGE_SIZE;
  const menu = $("categoriesMenu");
  if (menu) menu.classList.remove("open");
  buildCategoriesMenu();
  renderProducts();
  showSection("productos");
}

function clearSearch() {
  searchTerm = "";
  const inp = $("navSearch");
  if (inp) inp.value = "";
  _renderLimit = PAGE_SIZE;
  renderProducts();
}

function setSortMode(mode) {
  sortMode = mode || "cod";
  _renderLimit = PAGE_SIZE;
  renderProducts();
}

function getFilteredArticles() {
  const q = searchTerm.trim().toLowerCase();
  let list = articles;
  if (categoryFilter) list = list.filter((a) => a.categoria === categoryFilter);
  if (q) {
    // Búsqueda por CÓDIGO: query de dígitos (o L+dígitos, o dígitos+letra,
    // ej. "525e") → match exacto de código. Si no, por descripción.
    const esCod = /^l?\d+[a-z]?$/.test(q);
    list = list.filter((a) => {
      if (esCod) {
        if (a.variantes) return a.variantes.some((v) => codMatch(v.cod, q));
        return codMatch(a.key, q);
      }
      if (a.descripcion.toLowerCase().includes(q)) return true;
      if (a.variantes) {
        return a.variantes.some((v) => v.descripcion.toLowerCase().includes(q));
      }
      return false;
    });
  }
  if (soloSurtido && surtidoSet.size) {
    list = list.filter(articleEnSurtido);
  }
  const sorted = [...list];
  if (sortMode === "alfa") {
    sorted.sort((a, b) => a.descripcion.localeCompare(b.descripcion, "es"));
  } else if (sortMode === "precio-asc") {
    sorted.sort((a, b) => a.list_price - b.list_price);
  } else if (sortMode === "precio-desc") {
    sorted.sort((a, b) => b.list_price - a.list_price);
  } else {
    sorted.sort((a, b) => a.minCod - b.minCod);
  }
  // Lo que Milver le compra a Loekemeyer va primero (por volumen comprado)…
  sorted.sort((a, b) => {
    if (a.compraLk !== b.compraLk) return a.compraLk ? -1 : 1;
    if (a.compraLk && b.compraLk) return (a.ordenLk || 9e9) - (b.ordenLk || 9e9);
    return 0;
  });
  // …y con cliente elegido, lo que él compra manda por encima de todo.
  if (surtidoSet.size && !soloSurtido) {
    sorted.sort((a, b) => Number(articleEnSurtido(b)) - Number(articleEnSurtido(a)));
  }
  return sorted;
}

/***********************
 * RENDER PRODUCTOS (sin foto; variantes en filas dentro de la card)
 ***********************/
function qtyOf(cod) {
  const line = cart.find((i) => i.cod === String(cod));
  return line ? line.qty : 0;
}

function variantRowHtml(v) {
  const compra = surtidoSet.has(String(v.cod));
  const qty = qtyOf(v.cod);
  return `
    <div class="mv-var-row mv-tap${compra ? " mv-var-surtido" : ""}${qty > 0 ? " mv-var-conqty" : ""}"
         id="var-${v.cod}" onclick="tapAdd('${v.cod}')" role="button" tabindex="0">
      <span class="mv-var-name">${compra ? '<span class="mv-star">★</span> ' : ""}${v.variante || v.descripcion}</span>
      <span class="mv-var-bigqty" id="bigqty-${v.cod}">${qty > 0 ? qty : ""}</span>
      <button type="button" class="mv-qty-edit" onclick="event.stopPropagation();abrirQtyPicker('${v.cod}')" aria-label="Editar cantidad">✎</button>
    </div>
  `;
}

function buildCard(a) {
  const compra = articleEnSurtido(a);
  const tags =
    (compra ? '<span class="mv-tag mv-tag-surtido">★ Te compra</span>' : "") +
    (a.compraLk ? '<span class="mv-tag mv-tag-lk">LOEKE</span>' : "");
  if (a.variantes) {
    return `
      <div class="product-card mv-card mv-card-madre${compra ? " mv-card-surtido" : ""}">
        <div class="mv-card-head2">
          <div class="mv-card-title2">${a.descripcion}</div>
          <div class="mv-card-price2">$${formatMoney(a.list_price)} <span>x u.</span></div>
        </div>
        <div class="mv-card-meta2">${tags}<span class="mv-tag mv-tag-plain">${a.variantes.length} variantes</span></div>
        <div class="mv-var-list">
          ${a.variantes.map(variantRowHtml).join("")}
        </div>
      </div>
    `;
  }
  const p = a.item;
  const qty = qtyOf(p.cod);
  // Tap en cualquier parte del cuadrado suma +1. La cantidad se muestra grande.
  return `
    <div class="product-card mv-card mv-card-simple mv-tap${qty > 0 ? " mv-card-conqty" : ""}"
         id="card-${p.cod}" onclick="tapAdd('${p.cod}')" role="button" tabindex="0">
      <div class="mv-card-head2">
        <div class="mv-card-title2">${p.descripcion}</div>
        <div class="mv-card-price2">$${formatMoney(p.list_price)} <span>x u.</span></div>
      </div>
      <div class="mv-card-meta2"><span class="mv-tag mv-tag-plain">Cod ${p.cod}</span>${tags}</div>
      <div class="mv-card-qtyrow">
        <span class="mv-bigqty" id="bigqty-${p.cod}">${qty > 0 ? qty : ""}</span>
        <span class="mv-bigqty-lbl">${qty > 0 ? "unidades" : "tocá para sumar"}</span>
        <button type="button" class="mv-qty-edit" onclick="event.stopPropagation();abrirQtyPicker('${p.cod}')" aria-label="Editar cantidad">✎</button>
      </div>
    </div>
  `;
}

function renderProducts() {
  const container = $("productsContainer");
  if (!container) return;
  const list = getFilteredArticles();
  if (!list.length) {
    container.innerHTML = `
      <div style="padding:24px 40px; color:#666; font-size:14px;">
        Sin resultados${searchTerm.trim() ? ` para "${searchTerm.trim()}"` : ""}.
        ${searchTerm.trim() ? '<button type="button" class="mv-clear" onclick="clearSearch()">× limpiar</button>' : ""}
      </div>
    `;
    const info0 = $("catalogInfo");
    if (info0) info0.textContent = "0 resultados";
    return;
  }
  container.innerHTML = list.slice(0, _renderLimit).map(buildCard).join("");
  const sentinel = $("loadMoreSentinel");
  if (sentinel) sentinel.style.display = list.length > _renderLimit ? "" : "none";
  const info = $("catalogInfo");
  if (info && (searchTerm.trim() || categoryFilter)) {
    info.innerHTML = `${list.length.toLocaleString("es-AR")} resultado${list.length === 1 ? "" : "s"}` +
      (searchTerm.trim() ? ` para "${searchTerm.trim()}" <button type="button" class="mv-clear" onclick="clearSearch()">× limpiar</button>` : "");
  } else if (info) {
    const nVar = articles.filter((x) => x.variantes).length;
    info.textContent = `${products.length.toLocaleString("es-AR")} ítems · ${articles.length.toLocaleString("es-AR")} artículos (${nVar} con variantes)`;
  }
}

// Scroll infinito: renderizar 4.250 cards de una cuelga el navegador,
// así que se agregan de a PAGE_SIZE cuando el sentinel entra en pantalla.
function setupInfiniteScroll() {
  const sentinel = $("loadMoreSentinel");
  if (!sentinel || !("IntersectionObserver" in window)) return;
  const obs = new IntersectionObserver((entries) => {
    if (entries.some((e) => e.isIntersecting)) {
      const total = getFilteredArticles().length;
      if (_renderLimit < total) {
        _renderLimit += PAGE_SIZE;
        renderProducts();
      }
    }
  });
  obs.observe(sentinel);
}

/***********************
 * CARRITO
 ***********************/
function findProduct(cod) {
  return products.find((p) => String(p.cod) === String(cod));
}

function setQty(cod, value) {
  const qty = Math.max(0, Math.floor(Number(value) || 0));
  const idx = cart.findIndex((i) => i.cod === String(cod));
  if (qty === 0) {
    if (idx >= 0) cart.splice(idx, 1);
  } else if (idx >= 0) {
    cart[idx].qty = qty;
  } else {
    const p = findProduct(cod);
    if (!p) return;
    cart.push({
      cod: String(p.cod),
      descripcion: p.descripcion,
      variante: p.variante,
      list_price: Number(p.list_price),
      qty: qty,
    });
  }
  const big = $("bigqty-" + cod);
  if (big) big.textContent = qty > 0 ? qty : "";
  const card = $("card-" + cod);
  if (card) {
    card.classList.toggle("mv-card-conqty", qty > 0);
    const lbl = card.querySelector(".mv-bigqty-lbl");
    if (lbl) lbl.textContent = qty > 0 ? "unidades" : "tocá para sumar";
  }
  const varRow = $("var-" + cod);
  if (varRow) varRow.classList.toggle("mv-var-conqty", qty > 0);
  updateCartCount();
  if ($("carrito")?.classList.contains("active")) renderCart();
}

function changeQty(cod, delta) {
  if (!session) return;
  setQty(cod, qtyOf(cod) + delta);
}

// Tap en la card/fila: suma 1 unidad.
function tapAdd(cod) {
  if (!session) return;
  setQty(cod, qtyOf(cod) + 1);
  const big = $("bigqty-" + cod);
  if (big) {
    big.classList.remove("mv-bump");
    void big.offsetWidth;
    big.classList.add("mv-bump");
  }
}

/***********************
 * SELECTOR DE CANTIDAD (modal al tocar el artículo/variante)
 ***********************/
let _qtyPickerCod = null;
let _qtyBuffer = "";

function _qtyRender() {
  const d = $("qtyModalDisplay");
  if (d) d.textContent = _qtyBuffer === "" ? "0" : _qtyBuffer;
}

function abrirQtyPicker(cod) {
  if (!session) return;
  const p = findProduct(cod);
  if (!p) return;
  _qtyPickerCod = String(cod);
  const actual = qtyOf(cod);
  _qtyBuffer = actual > 0 ? String(actual) : "";
  const tit = $("qtyModalTitulo");
  const precio = $("qtyModalPrecio");
  if (tit) tit.textContent = p.descripcion;
  if (precio) {
    const dtoVol = getDtoVol();
    const neto = Number(p.list_price) * (1 - dtoVol) * (1 - WEB_ORDER_DISCOUNT);
    precio.textContent = `Cod ${p.cod} · $${formatMoney(neto)} x unidad + IVA`;
  }
  _qtyRender();
  const modal = $("qtyModal");
  if (modal) modal.style.display = "";
}

function cerrarQtyPicker() {
  const modal = $("qtyModal");
  if (modal) modal.style.display = "none";
  _qtyPickerCod = null;
  _qtyBuffer = "";
}

// Teclado propio: cada dígito se agrega al número (tope 6 cifras).
function qtyTecla(d) {
  if (_qtyBuffer === "0") _qtyBuffer = "";
  if (_qtyBuffer.length >= 6) return;
  _qtyBuffer += d;
  _qtyRender();
}

function qtyBorrar() {
  _qtyBuffer = _qtyBuffer.slice(0, -1);
  _qtyRender();
}

function qtyBorrarTodo() {
  _qtyBuffer = "";
  _qtyRender();
}

function qtySumar(n) {
  _qtyBuffer = String((parseInt(_qtyBuffer, 10) || 0) + n);
  _qtyRender();
}

function qtyConfirmar() {
  if (!_qtyPickerCod) return;
  const qty = Math.max(0, parseInt(_qtyBuffer, 10) || 0);
  setQty(_qtyPickerCod, qty);
  cerrarQtyPicker();
}

function qtyQuitar() {
  if (!_qtyPickerCod) return;
  setQty(_qtyPickerCod, 0);
  cerrarQtyPicker();
}

function updateCartCount() {
  const el = $("cartCount");
  if (el) el.textContent = cart.reduce((s, i) => s + i.qty, 0);
  updateCartBar();
  guardarBorrador();
}

// Borrador persistente: si el comisionista cierra la página, no pierde el
// carrito. Se guarda por comisionista y no se pisa entre sesiones distintas.
function guardarBorrador() {
  if (!session) return;
  try {
    const key = "milver_borrador_" + session.id;
    if (cart.length) {
      localStorage.setItem(key, JSON.stringify({
        cart, clienteCod: clienteSel?.cod || null, editando: editandoPedido, at: Date.now(),
      }));
    } else {
      localStorage.removeItem(key);
    }
  } catch (e) {}
}

function restaurarBorrador() {
  if (!session) return;
  try {
    const raw = localStorage.getItem("milver_borrador_" + session.id);
    if (!raw) return;
    const b = JSON.parse(raw);
    if (!b.cart || !b.cart.length) return;
    cart = b.cart;
    editandoPedido = b.editando || null;
    if (b.clienteCod && clientes.length) setCliente(b.clienteCod);
    updateCartCount();
  } catch (e) {}
}

function limpiarBorrador() {
  if (!session) return;
  try { localStorage.removeItem("milver_borrador_" + session.id); } catch (e) {}
}

// Barra fija de abajo: total del pedido siempre a la vista y a un toque.
function updateCartBar() {
  const bar = $("cartBar");
  if (!bar) return;
  const enCarrito = $("carrito")?.classList.contains("active") || $("pedidoConfirmado")?.classList.contains("active");
  if (!cart.length || enCarrito || !session) {
    bar.style.display = "none";
    document.body.classList.remove("mv-has-cartbar");
    return;
  }
  const t = cartTotals();
  const uni = cart.reduce((s, i) => s + i.qty, 0);
  const info = $("cartBarInfo");
  if (info) {
    info.textContent = `${cart.length} art. · ${formatMoney(uni)} u. · $${formatMoney(t.total)} + IVA`;
  }
  bar.style.display = "";
  document.body.classList.add("mv-has-cartbar");
  bar.classList.remove("mv-pulse");
  void bar.offsetWidth; // reinicia la animación
  bar.classList.add("mv-pulse");
}

function getDtoVol() {
  return Number(clienteSel?.dto_vol || 0);
}

function cartTotals() {
  const dtoVol = getDtoVol();
  let subtotalLista = 0;
  let total = 0;
  for (const i of cart) {
    const neto = i.list_price * (1 - dtoVol) * (1 - WEB_ORDER_DISCOUNT);
    subtotalLista += i.list_price * i.qty;
    total += neto * i.qty;
  }
  return { subtotalLista, total, descuento: subtotalLista - total, dtoVol };
}

function renderCart() {
  const box = $("cartItems");
  const totalsBox = $("cartTotals");
  const submitBtn = $("submitBtn");
  if (!box) return;

  // Banner si estamos editando un pedido existente
  const banner = $("editBanner");
  if (banner) {
    if (editandoPedido) {
      banner.style.display = "";
      banner.innerHTML = `Editando pedido <strong>#${editandoPedido}</strong> · <button type="button" class="mv-clear" onclick="cancelarEdicion()">✕ cancelar edición</button>`;
    } else {
      banner.style.display = "none";
    }
  }
  if (submitBtn) submitBtn.textContent = editandoPedido ? "Guardar cambios" : "Confirmar pedido";

  if (!cart.length) {
    box.innerHTML = `<div class="mv-cart-empty">El pedido está vacío. Agregá artículos desde Productos.` +
      (clienteSel
        ? ` <button type="button" class="mv-clear" onclick="repetirUltimoPedido()">↻ Repetir último pedido de ${clienteSel.razon_social}</button>`
        : "") +
      `</div>`;
    if (totalsBox) totalsBox.innerHTML = "";
    if (submitBtn) submitBtn.disabled = true;
    return;
  }

  const dtoVol = getDtoVol();
  box.innerHTML = cart
    .map((i) => {
      const neto = i.list_price * (1 - dtoVol) * (1 - WEB_ORDER_DISCOUNT);
      return `
        <div class="mv-cart-line">
          <div class="mv-cart-line-info">
            <span class="mv-cart-cod">${i.cod}</span>
            <span class="mv-cart-desc">${i.descripcion}</span>
            <span class="mv-cart-meta">${formatMoney(i.qty)} u. × $${formatMoney(neto)}/u</span>
          </div>
          <button type="button" class="mv-qty-pill mv-qty-pill-on" onclick="abrirQtyPicker('${i.cod}')">${formatMoney(i.qty)} u. ✎</button>
          <div class="mv-cart-line-sub">$${formatMoney(neto * i.qty)}</div>
        </div>
      `;
    })
    .join("");

  const t = cartTotals();
  if (totalsBox) {
    totalsBox.innerHTML = `
      <div class="mv-tot-row"><span>Subtotal lista</span><span>$${formatMoney(t.subtotalLista)}</span></div>
      ${
        t.dtoVol > 0
          ? `<div class="mv-tot-row"><span>Dto. cliente (${Math.round(t.dtoVol * 100)}%)</span><span>incluido</span></div>`
          : ""
      }
      <div class="mv-tot-row mv-tot-desc"><span>Descuentos</span><span>−$${formatMoney(t.descuento)}</span></div>
      <div class="mv-tot-row mv-tot-total"><span>TOTAL</span><span>$${formatMoney(t.total)} + IVA</span></div>
      ${!clienteSel ? `<div class="mv-tot-warn">Elegí un cliente para confirmar el pedido.</div>` : ""}
    `;
  }
  if (submitBtn) submitBtn.disabled = !clienteSel;
}

/***********************
 * ENVÍO DE PEDIDO
 ***********************/
async function submitOrder() {
  if (!session || !clienteSel || !cart.length) return;
  const btn = $("submitBtn");
  if (btn) {
    btn.disabled = true;
    btn.textContent = "Enviando…";
  }
  const esEdicion = !!editandoPedido;
  const { data, error } = esEdicion
    ? await supabaseClient.rpc("milver_edit_order", {
        p_comisionista_id: session.id, p_pin: session.pin, p_numero: editandoPedido,
        p_metodo_pago: $("mvPaymentSelect")?.value || "Contado",
        p_observaciones: ($("obsInput")?.value || "").trim() || null,
        p_items: cart.map((i) => ({ cod: i.cod, unidades: i.qty })),
      })
    : await supabaseClient.rpc("milver_submit_order", {
        p_comisionista_id: session.id, p_pin: session.pin, p_cliente_cod: clienteSel.cod,
        p_metodo_pago: $("mvPaymentSelect")?.value || "Contado",
        p_observaciones: ($("obsInput")?.value || "").trim() || null,
        p_items: cart.map((i) => ({ cod: i.cod, unidades: i.qty })),
      });
  if (btn) {
    btn.disabled = false;
    btn.textContent = "Confirmar pedido";
  }
  if (error || !data?.ok) {
    alert(data?.error || "Error enviando el pedido. Probá de nuevo.");
    return;
  }
  // Snapshot completo para el PDF/impresión (el RPC devuelve solo el resumen)
  const dtoVol = getDtoVol();
  lastConfirmedOrder = {
    numero: data.numero,
    fecha: new Date().toISOString(),
    comisionista: session.nombre,
    cliente: data.cliente,
    cliente_cod: clienteSel.cod,
    metodo_pago: $("mvPaymentSelect")?.value || "Contado",
    observaciones: ($("obsInput")?.value || "").trim() || null,
    total: data.total,
    items: cart.map((i) => {
      const neto = i.list_price * (1 - dtoVol) * (1 - WEB_ORDER_DISCOUNT);
      return { cod: i.cod, descripcion: i.descripcion, variante: i.variante,
               unidades: i.qty, precio_neto: neto, subtotal: neto * i.qty };
    }),
  };
  editandoPedido = null;
  cart = [];
  limpiarBorrador();
  updateCartCount();
  const det = $("confirmDetalle");
  if (det) {
    det.innerHTML = `
      <p>Pedido <strong>#${data.numero}</strong> para <strong>${data.cliente}</strong></p>
      <p class="mv-confirm-total">Total: <strong>$${formatMoney(data.total)} + IVA</strong></p>
      <button type="button" class="mv-btn mva-btn-sec mv-btn-pdf" onclick="descargarPDFPedido(lastConfirmedOrder)">📄 Descargar PDF del pedido</button>
    `;
  }
  showSection("pedidoConfirmado");
}

function cancelarEdicion() {
  editandoPedido = null;
  cart = [];
  limpiarBorrador();
  updateCartCount();
  const obs = $("obsInput");
  if (obs) obs.value = "";
  renderCart();
  showSection("productos");
  renderProducts();
}

function nuevoPedido() {
  const obs = $("obsInput");
  if (obs) obs.value = "";
  showSection("productos");
  renderProducts();
}

// Carga en el carrito las cantidades del último pedido del cliente elegido.
async function repetirUltimoPedido() {
  if (!session || !clienteSel) return;
  const { data, error } = await supabaseClient.rpc("milver_historial", {
    p_comisionista_id: session.id,
    p_pin: session.pin,
  });
  if (error || !data?.ok) {
    alert("No se pudo leer el historial.");
    return;
  }
  const ultimo = (data.pedidos || []).find((p) => p.cliente_cod === clienteSel.cod);
  if (!ultimo || !(ultimo.items || []).length) {
    alert(`${clienteSel.razon_social} todavía no tiene pedidos.`);
    return;
  }
  for (const it of ultimo.items) {
    if (findProduct(it.cod)) setQty(it.cod, it.unidades);
  }
  renderCart();
}

/***********************
 * EDITAR / ANULAR PEDIDO (solo mientras esté "nuevo")
 ***********************/
function editarPedido(numero) {
  const o = _histPedidos.find((p) => p.numero === numero);
  if (!o) return;
  cart = (o.items || []).map((i) => {
    const p = findProduct(i.cod) || {};
    return { cod: String(i.cod), descripcion: i.descripcion, variante: i.variante,
             list_price: Number(p.list_price || 0), qty: Number(i.unidades) };
  });
  editandoPedido = numero;
  setCliente(o.cliente_cod);
  const pay = $("mvPaymentSelect");
  if (pay && o.metodo_pago) pay.value = o.metodo_pago;
  const obs = $("obsInput");
  if (obs) obs.value = o.observaciones || "";
  updateCartCount();
  showSection("carrito");
}

async function anularPedido(numero) {
  if (!confirm(`¿Anular el pedido #${numero}? No se puede deshacer.`)) return;
  const { data, error } = await supabaseClient.rpc("milver_cancel_order", {
    p_comisionista_id: session.id, p_pin: session.pin, p_numero: numero,
  });
  if (error || !data?.ok) {
    alert(data?.error || "No se pudo anular.");
    return;
  }
  if (editandoPedido === numero) { editandoPedido = null; cart = []; limpiarBorrador(); updateCartCount(); }
  loadHistorial();
}

/***********************
 * PDF DEL PEDIDO (jsPDF)
 ***********************/
function descargarPDFPedido(o) {
  if (!o) return;
  if (!window.jspdf || !window.jspdf.jsPDF) {
    alert("No se pudo cargar el generador de PDF. Reintentá en unos segundos.");
    return;
  }
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit: "mm", format: "a4" });
  const W = 210;
  let y = 16;

  // Encabezado
  doc.setFont("helvetica", "bold");
  doc.setFontSize(20);
  doc.setTextColor(18, 60, 99);
  doc.text("MILVER", 14, y);
  doc.setFont("helvetica", "normal");
  doc.setFontSize(9);
  doc.setTextColor(90);
  doc.text("Bazar & Gastronomía", 14, y + 5);

  doc.setFont("helvetica", "bold");
  doc.setFontSize(14);
  doc.setTextColor(30);
  doc.text(`Pedido #${o.numero}`, W - 14, y, { align: "right" });
  doc.setFont("helvetica", "normal");
  doc.setFontSize(9);
  doc.setTextColor(90);
  doc.text(new Date(o.fecha).toLocaleString("es-AR"), W - 14, y + 5, { align: "right" });

  y += 14;
  doc.setDrawColor(200);
  doc.line(14, y, W - 14, y);
  y += 7;

  // Datos
  doc.setFontSize(10);
  doc.setTextColor(30);
  doc.text(`Cliente: ${o.cliente}${o.cliente_cod ? " (" + o.cliente_cod + ")" : ""}`, 14, y);
  y += 5;
  doc.text(`Comisionista: ${o.comisionista || "-"}`, 14, y);
  y += 5;
  doc.text(`Medio de pago: ${o.metodo_pago || "-"}`, 14, y);
  y += 8;

  // Tabla de ítems
  const cols = [
    { t: "Cód", x: 14, w: 22 },
    { t: "Descripción", x: 36, w: 96 },
    { t: "Unid.", x: 138, w: 16, align: "right" },
    { t: "P. unit.", x: 168, w: 18, align: "right" },
    { t: "Subtotal", x: W - 14, w: 24, align: "right" },
  ];
  doc.setFillColor(18, 60, 99);
  doc.rect(14, y - 4, W - 28, 7, "F");
  doc.setTextColor(255);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(9);
  doc.text("Cód", 16, y);
  doc.text("Descripción", 38, y);
  doc.text("Unid.", 154, y, { align: "right" });
  doc.text("P.unit.", 180, y, { align: "right" });
  doc.text("Subtotal", W - 16, y, { align: "right" });
  y += 7;

  doc.setFont("helvetica", "normal");
  doc.setTextColor(30);
  for (const it of o.items || []) {
    if (y > 275) { doc.addPage(); y = 20; }
    const desc = (it.descripcion || "").slice(0, 58);
    doc.text(String(it.cod), 16, y);
    doc.text(desc, 38, y);
    doc.text(formatMoney(it.unidades), 154, y, { align: "right" });
    doc.text("$" + formatMoney(it.precio_neto), 180, y, { align: "right" });
    doc.text("$" + formatMoney(it.subtotal), W - 16, y, { align: "right" });
    y += 6;
    doc.setDrawColor(235);
    doc.line(14, y - 2, W - 14, y - 2);
  }

  y += 4;
  doc.setFont("helvetica", "bold");
  doc.setFontSize(13);
  doc.setTextColor(18, 60, 99);
  doc.text(`TOTAL: $${formatMoney(o.total)} + IVA`, W - 14, y, { align: "right" });

  if (o.observaciones) {
    y += 9;
    doc.setFont("helvetica", "normal");
    doc.setFontSize(9);
    doc.setTextColor(90);
    doc.text("Observaciones: " + o.observaciones, 14, y, { maxWidth: W - 28 });
  }

  doc.save(`milver-pedido-${o.numero}.pdf`);
}

/***********************
 * INICIO (dashboard del comisionista)
 ***********************/
let _histPedidos = [];

async function loadInicio() {
  if (!session) return;
  const hola = $("inicioHola");
  if (hola) hola.textContent = "Hola, " + session.nombre + " 👋";
  const statsBox = $("inicioStats");
  if (statsBox) statsBox.innerHTML = '<div class="mv-stats-cargando">Cargando estadísticas…</div>';
  const { data, error } = await supabaseClient.rpc("milver_stats", {
    p_comisionista_id: session.id,
    p_pin: session.pin,
  });
  if (error || !data?.ok) {
    if (statsBox) statsBox.innerHTML = '<div class="mv-cart-empty">No se pudieron cargar las estadísticas.</div>';
    return;
  }
  // aviso de faltantes marcados por el depósito (últimos 30 días)
  const faltaBox = $("inicioFaltantes");
  if (faltaBox) {
    const falt = data.faltantes || [];
    if (!falt.length) {
      faltaBox.style.display = "none";
      faltaBox.innerHTML = "";
    } else {
      faltaBox.style.display = "";
      faltaBox.innerHTML =
        `<div class="mv-falta-tit">⚠ ${falt.length} pedido${falt.length > 1 ? "s" : ""} con faltantes del depósito</div>` +
        falt
          .slice(0, 5)
          .map(
            (f) =>
              `<button type="button" class="mv-falta-row" onclick="verPedidoFaltante('${f.numero}')">
                 <span class="mv-falta-num">#${f.numero}</span>
                 <span class="mv-falta-cli">${f.cliente}</span>
                 <span class="mv-falta-items">${f.items} ítem${Number(f.items) > 1 ? "s" : ""}</span>
               </button>`,
          )
          .join("") +
        (falt.length > 5 ? `<div class="mv-falta-mas">y ${falt.length - 5} más — vé al Historial</div>` : "");
    }
  }
  const sem = data.semana || {}, mes = data.mes || {}, tot = data.total || {};
  if (statsBox) {
    statsBox.innerHTML = [
      ["Esta semana", `$${formatMoney(sem.total)}`, `${sem.pedidos || 0} pedidos · ${formatMoney(sem.unidades)} u.`],
      ["Este mes", `$${formatMoney(mes.total)}`, `${mes.pedidos || 0} pedidos · ${formatMoney(mes.unidades)} u.`],
      ["Clientes activos", `${data.clientes_activos || 0}`, "últimos 30 días"],
      ["Histórico", `$${formatMoney(tot.total)}`, `${tot.pedidos || 0} pedidos`],
    ].map(([t, v, s]) => `
      <div class="mv-stat">
        <div class="mv-stat-tit">${t}</div>
        <div class="mv-stat-num">${v}</div>
        <div class="mv-stat-sub">${s}</div>
      </div>`).join("");
  }
  // mini-gráfico de barras de los últimos 8 días
  const serie = data.serie || [];
  const serieBox = $("inicioSerie");
  if (serieBox) {
    if (!serie.length || serie.every((d) => !Number(d.total))) {
      serieBox.innerHTML = "";
    } else {
      const max = Math.max(...serie.map((d) => Number(d.total)), 1);
      serieBox.innerHTML =
        '<h3>Ventas últimos 8 días</h3><div class="mv-bars">' +
        serie.map((d) => {
          const h = Math.round((Number(d.total) / max) * 100);
          const dia = new Date(d.fecha).toLocaleDateString("es-AR", { weekday: "short" }).replace(".", "");
          return `<div class="mv-bar-col" title="${dia}: $${formatMoney(d.total)}">
            <div class="mv-bar" style="height:${Math.max(h, 2)}%"></div>
            <div class="mv-bar-lbl">${dia}</div>
          </div>`;
        }).join("") +
        "</div>";
    }
  }
  const topBox = $("inicioTop");
  if (topBox) {
    const top = data.top_clientes || [];
    topBox.innerHTML = top.length
      ? top.map((c, i) => `
        <div class="mv-top-row">
          <span class="mv-top-pos">${i + 1}</span>
          <span class="mv-top-nom">${c.cliente}</span>
          <span class="mv-top-tot">$${formatMoney(c.total)}</span>
        </div>`).join("")
      : '<div class="mv-cart-empty">Todavía no cargaste pedidos este mes.</div>';
  }
}

/***********************
 * HISTORIAL
 ***********************/
async function loadHistorial() {
  const box = $("historialLista");
  if (!box || !session) return;
  box.innerHTML = `<div class="mv-cart-empty">Cargando…</div>`;
  const { data, error } = await supabaseClient.rpc("milver_historial", {
    p_comisionista_id: session.id,
    p_pin: session.pin,
  });
  if (error || !data?.ok) {
    box.innerHTML = `<div class="mv-cart-empty">Error cargando historial.</div>`;
    return;
  }
  _histPedidos = data.pedidos || [];
  // poblar el filtro de clientes con los que tienen pedidos
  const sel = $("histCliente");
  if (sel) {
    const vistos = new Map();
    for (const o of _histPedidos) if (!vistos.has(o.cliente_cod)) vistos.set(o.cliente_cod, o.cliente);
    sel.innerHTML = '<option value="">Todos los clientes</option>' +
      [...vistos].map(([cod, nom]) => `<option value="${cod}">${nom}</option>`).join("");
  }
  renderHistorial();
}

function filtrarHistCliente(cod) {
  const inp = $("histBuscar");
  if (inp) inp.value = "";
  renderHistorial(cod);
}

// Desde el aviso de faltantes del Inicio: ir al historial y abrir ese pedido.
async function verPedidoFaltante(numero) {
  showSection("historial");
  if (!_histPedidos.length) await loadHistorial();
  const sel = $("histCliente");
  if (sel) sel.value = "";
  const inp = $("histBuscar");
  if (inp) inp.value = String(numero);
  renderHistorial("");
  // abrir el <details> del pedido
  setTimeout(() => {
    const cards = document.querySelectorAll("#historialLista .mv-hist-card");
    for (const c of cards) {
      if (c.querySelector(".mv-hist-num")?.textContent === "#" + numero) {
        c.open = true;
        c.scrollIntoView({ behavior: "smooth", block: "center" });
        break;
      }
    }
  }, 60);
}

const MV_ESTADOS = {
  nuevo: "Nuevo",
  en_picking: "En preparación",
  pickeado: "Preparado",
  en_armado: "En preparación",
  armado: "Preparado",
  despachado: "Despachado",
};
function estadoLabel(e) {
  return MV_ESTADOS[e] || "En depósito";
}

function renderHistorial(codForzado) {
  const box = $("historialLista");
  if (!box) return;
  const q = ($("histBuscar")?.value || "").toLowerCase().trim();
  const codSel = codForzado !== undefined ? codForzado : ($("histCliente")?.value || "");
  let pedidos = _histPedidos;
  if (codSel) pedidos = pedidos.filter((o) => o.cliente_cod === codSel);
  if (q) pedidos = pedidos.filter((o) => (o.cliente || "").toLowerCase().includes(q) || String(o.numero).includes(q));
  if (!pedidos.length) {
    box.innerHTML = `<div class="mv-cart-empty">${_histPedidos.length ? "Sin pedidos para ese filtro." : "Todavía no cargaste pedidos."}</div>`;
    return;
  }
  box.innerHTML = pedidos
    .map((o) => {
      const fecha = new Date(o.fecha).toLocaleString("es-AR", {
        dateStyle: "short",
        timeStyle: "short",
      });
      const nFalta = Number(o.faltantes || 0);
      return `
        <details class="mv-hist-card${nFalta ? " mv-hist-card-falta" : ""}">
          <summary>
            <span class="mv-hist-num">#${o.numero}</span>
            <span class="mv-hist-cliente">${o.cliente}</span>
            <span class="mv-hist-fecha">${fecha}</span>
            ${nFalta ? `<span class="mv-hist-badge-falta">⚠ ${nFalta} faltante${nFalta > 1 ? "s" : ""}</span>` : `<span class="mv-hist-estado-mini">${estadoLabel(o.estado)}</span>`}
            <span class="mv-hist-total">$${formatMoney(o.total)}</span>
          </summary>
          <div class="mv-hist-items">
            ${nFalta ? `<div class="mv-hist-alerta">⚠ El depósito marcó ${nFalta} ítem${nFalta > 1 ? "s" : ""} con faltante o entregado incompleto. Revisá el detalle con el cliente.</div>` : ""}
            ${(o.items || [])
              .map((i) => {
                const faltan = Number(i.faltan || 0);
                const marca = i.pick_falta
                  ? `<span class="mv-item-falta">Sin stock</span>`
                  : faltan > 0
                    ? `<span class="mv-item-falta">Faltan ${formatMoney(faltan)} u.</span>`
                    : "";
                return `
              <div class="mv-hist-item${faltan > 0 || i.pick_falta ? " mv-hist-item-falta" : ""}">
                <span class="mv-cart-cod">${i.cod}</span>
                <span>${i.descripcion}${marca ? " " + marca : ""}</span>
                <span>${formatMoney(i.unidades)} u.</span>
                <span>$${formatMoney(i.subtotal)}</span>
              </div>`;
              })
              .join("")}
            ${o.observaciones ? `<div class="mv-hist-obs">Obs: ${o.observaciones}</div>` : ""}
            <div class="mv-hist-acciones">
              <button type="button" class="mv-btn mva-btn-sec mv-btn-pdf" onclick='descargarPDFPedido(${JSON.stringify(o).replace(/'/g, "&#39;")})'>📄 PDF</button>
              ${(o.estado === "nuevo" || !o.estado)
                ? `<button type="button" class="mv-btn mva-btn-sec" onclick="editarPedido(${o.numero})">✎ Editar</button>
                   <button type="button" class="mv-btn mv-btn-anular" onclick="anularPedido(${o.numero})">🗑 Anular</button>`
                : `<span class="mv-hist-estado">${estadoLabel(o.estado)}</span>`}
            </div>
          </div>
        </details>
      `;
    })
    .join("");
}

/***********************
 * INIT
 ***********************/
document.addEventListener("DOMContentLoaded", () => {
  if (typeof MILVER_VERSION !== "undefined") {
    const ver = $("mvVersion");
    if (ver) ver.textContent = "v" + MILVER_VERSION;
    const lver = $("loginVersion");
    if (lver) lver.textContent = "v" + MILVER_VERSION;
  }
  restoreSession();
  loadCatalog();
  if (session) {
    loadClientes().then(restaurarBorrador);
    showSection("inicio");
  } else {
    // login visible: precargar el desplegable de comisionistas
    setRole("comisionista");
  }
  setupInfiniteScroll();

  // Avisar antes de cerrar/recargar si hay un pedido a medio cargar.
  window.addEventListener("beforeunload", (e) => {
    if (cart.length) { e.preventDefault(); e.returnValue = ""; }
  });

  // PWA: registrar el service worker para instalación y caché offline.
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }

  const search = $("navSearch");
  if (search) {
    let t = null;
    search.addEventListener("input", () => {
      clearTimeout(t);
      t = setTimeout(() => {
        searchTerm = search.value || "";
        _renderLimit = PAGE_SIZE;
        renderProducts();
        showSection("productos");
      }, 200);
    });
  }

  document.addEventListener("click", (e) => {
    const combo = $("clienteCombo");
    if (combo && !combo.contains(e.target)) cerrarClientesCombo();
  });

  const catBtn = $("categoriesBtn");
  const catMenu = $("categoriesMenu");
  if (catBtn && catMenu) {
    catBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      catMenu.classList.toggle("open");
    });
    document.addEventListener("click", () => catMenu.classList.remove("open"));
  }

  const pin = $("loginPin");
  if (pin) {
    pin.addEventListener("keydown", (e) => {
      if (e.key === "Enter") doLogin();
    });
  }
});

/***********************
 * EXPORTS para onclick= inline (misma convención que LK)
 ***********************/
window.showSection = showSection;
window.doLogin = doLogin;
window.setRole = setRole;
window.logout = logout;
window.setCategory = setCategory;
window.clearSearch = clearSearch;
window.repetirUltimoPedido = repetirUltimoPedido;
window.editarPedido = editarPedido;
window.anularPedido = anularPedido;
window.cancelarEdicion = cancelarEdicion;
window.loadInicio = loadInicio;
window.renderHistorial = renderHistorial;
window.filtrarHistCliente = filtrarHistCliente;
window.verPedidoFaltante = verPedidoFaltante;
window.setSortMode = setSortMode;
window.changeQty = changeQty;
window.tapAdd = tapAdd;
window.abrirQtyPicker = abrirQtyPicker;
window.cerrarQtyPicker = cerrarQtyPicker;
window.qtySumar = qtySumar;
window.qtyTecla = qtyTecla;
window.qtyBorrar = qtyBorrar;
window.qtyBorrarTodo = qtyBorrarTodo;
window.qtyConfirmar = qtyConfirmar;
window.qtyQuitar = qtyQuitar;
window.setQty = setQty;
window.setCliente = setCliente;
window.filtrarClientesCombo = filtrarClientesCombo;
window.abrirClientesCombo = abrirClientesCombo;
window.elegirClienteCombo = elegirClienteCombo;
window.limpiarClienteCombo = limpiarClienteCombo;
window.toggleSoloSurtido = toggleSoloSurtido;
window.submitOrder = submitOrder;
window.nuevoPedido = nuevoPedido;
window.descargarPDFPedido = descargarPDFPedido;
