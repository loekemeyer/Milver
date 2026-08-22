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
let WEB_ORDER_DISCOUNT = 0.02;

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
  if ((id === "carrito" || id === "historial") && !session) return;
  document.querySelectorAll(".section").forEach((s) => s.classList.remove("active"));
  const el = $(id);
  if (el) el.classList.add("active");
  document.body.classList.toggle("section-carrito", id === "carrito");
  if (id === "carrito") renderCart();
  updateCartBar();
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

async function doLogin() {
  const nombre = ($("loginNombre")?.value || "").trim();
  const pin = ($("loginPin")?.value || "").trim();
  const errBox = $("loginError");
  if (!nombre || !pin) {
    if (errBox) {
      errBox.textContent = "Completá nombre y PIN.";
      errBox.style.display = "";
    }
    return;
  }
  const btn = $("loginBtn");
  if (btn) btn.disabled = true;
  const { data, error } = await supabaseClient.rpc("milver_login", {
    p_nombre: nombre,
    p_pin: pin,
  });
  if (btn) btn.disabled = false;
  if (error || !data?.ok) {
    if (errBox) {
      errBox.textContent = data?.error || "Error de conexión. Probá de nuevo.";
      errBox.style.display = "";
    }
    return;
  }
  session = { id: data.id, nombre: data.nombre, pin };
  try {
    localStorage.setItem("milver_session", JSON.stringify(session));
  } catch (e) {}
  syncLoginUI();
  loadClientes();
  renderProducts();
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
  for (const id of ["clienteSelect", "clienteSelectTop"]) {
    const sel = $(id);
    if (sel) sel.innerHTML = opts;
  }
}

// Elegir cliente carga su surtido (qué le compra a Milver) y marca el catálogo.
async function setCliente(cod) {
  clienteSel = clientes.find((c) => c.cod === cod) || null;
  for (const id of ["clienteSelect", "clienteSelectTop"]) {
    const sel = $(id);
    if (sel && sel.value !== (cod || "")) sel.value = cod || "";
  }
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
  const qty = qtyOf(v.cod);
  const compra = surtidoSet.has(String(v.cod));
  return `
    <div class="mv-var-row${compra ? " mv-var-surtido" : ""}" id="var-${v.cod}">
      <span class="mv-var-cod">${v.cod}</span>
      <span class="mv-var-name">${compra ? '<span class="mv-star" title="Este cliente compra esta variante">★</span> ' : ""}${v.variante || v.descripcion}</span>
      <span class="mv-var-qty">
        <button type="button" class="mv-step" onclick="changeQty('${v.cod}', -1)" aria-label="Restar 1 unidad">−</button>
        <input class="mv-qty-input" id="qty-${v.cod}" type="number" min="0" value="${qty}"
               onchange="setQty('${v.cod}', this.value)" aria-label="Unidades" />
        <button type="button" class="mv-step" onclick="changeQty('${v.cod}', 1)" aria-label="Sumar 1 unidad">+</button>
      </span>
    </div>
  `;
}

function buildCard(a) {
  const compra = articleEnSurtido(a);
  const chips =
    (compra ? '<span class="mv-tag mv-tag-surtido" title="Este cliente le compra este artículo a Milver">★ Te compra</span>' : "") +
    (a.compraLk ? '<span class="mv-tag mv-tag-lk" title="Artículo que Milver le compra a Loekemeyer">LOEKE</span>' : "") +
    (a.variantes ? `<span class="mv-tag">${a.variantes.length} variantes</span>` : "");
  const head = (codLabel) => `
    <div class="mv-card-head">
      <div class="mv-card-title">
        <div class="card-desc">${a.descripcion}</div>
        <div class="mv-card-meta card-cod">${codLabel}${chips}</div>
      </div>
      <div class="mv-card-price card-prices">
        <strong>$${formatMoney(a.list_price)}</strong>
        <span class="mv-card-price-sub">x unidad + IVA</span>
      </div>
    </div>
  `;
  if (a.variantes) {
    return `
      <div class="product-card mv-card mv-card-madre${compra ? " mv-card-surtido" : ""}">
        ${head(`<span>${a.variantes[0].cod}–${a.variantes[a.variantes.length - 1].cod}</span>`)}
        <div class="mv-var-list">
          ${a.variantes.map(variantRowHtml).join("")}
        </div>
      </div>
    `;
  }
  const p = a.item;
  const qty = qtyOf(p.cod);
  return `
    <div class="product-card mv-card mv-card-simple${compra ? " mv-card-surtido" : ""}">
      ${head(`<span>${p.cod}</span>`)}
      <div class="mv-simple-qty mv-var-qty">
        <button type="button" class="mv-step" onclick="changeQty('${p.cod}', -1)" aria-label="Restar 1 unidad">−</button>
        <input class="mv-qty-input" id="qty-${p.cod}" type="number" min="0" value="${qty}"
               onchange="setQty('${p.cod}', this.value)" aria-label="Unidades" />
        <button type="button" class="mv-step" onclick="changeQty('${p.cod}', 1)" aria-label="Sumar 1 unidad">+</button>
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
  const input = $("qty-" + cod);
  if (input) input.value = qty;
  updateCartCount();
  if ($("carrito")?.classList.contains("active")) renderCart();
}

function changeQty(cod, delta) {
  if (!session) return;
  setQty(cod, qtyOf(cod) + delta);
}

function updateCartCount() {
  const el = $("cartCount");
  if (el) el.textContent = cart.reduce((s, i) => s + i.qty, 0);
  updateCartBar();
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
          <div class="mv-var-qty">
            <button type="button" class="mv-step" onclick="changeQty('${i.cod}', -1)" aria-label="Restar">−</button>
            <input class="mv-qty-input" id="qty-${i.cod}" type="number" min="0" value="${i.qty}"
                   onchange="setQty('${i.cod}', this.value)" aria-label="Unidades" />
            <button type="button" class="mv-step" onclick="changeQty('${i.cod}', 1)" aria-label="Sumar">+</button>
          </div>
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
      <div class="mv-tot-row"><span>Dto. pedido web (${Math.round(WEB_ORDER_DISCOUNT * 100)}%)</span><span>incluido</span></div>
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
  const { data, error } = await supabaseClient.rpc("milver_submit_order", {
    p_comisionista_id: session.id,
    p_pin: session.pin,
    p_cliente_cod: clienteSel.cod,
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
  lastConfirmedOrder = data;
  cart = [];
  updateCartCount();
  const det = $("confirmDetalle");
  if (det) {
    det.innerHTML = `
      <p>Pedido <strong>#${data.numero}</strong> para <strong>${data.cliente}</strong></p>
      <p class="mv-confirm-total">Total: <strong>$${formatMoney(data.total)} + IVA</strong></p>
    `;
  }
  showSection("pedidoConfirmado");
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
  const pedidos = data.pedidos || [];
  if (!pedidos.length) {
    box.innerHTML = `<div class="mv-cart-empty">Todavía no cargaste pedidos.</div>`;
    return;
  }
  box.innerHTML = pedidos
    .map((o) => {
      const fecha = new Date(o.fecha).toLocaleString("es-AR", {
        dateStyle: "short",
        timeStyle: "short",
      });
      return `
        <details class="mv-hist-card">
          <summary>
            <span class="mv-hist-num">#${o.numero}</span>
            <span class="mv-hist-cliente">${o.cliente}</span>
            <span class="mv-hist-fecha">${fecha}</span>
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
        </details>
      `;
    })
    .join("");
}

/***********************
 * INIT
 ***********************/
document.addEventListener("DOMContentLoaded", () => {
  const ver = $("mvVersion");
  if (ver && typeof MILVER_VERSION !== "undefined") ver.textContent = "v" + MILVER_VERSION;
  restoreSession();
  loadCatalog();
  if (session) loadClientes();
  setupInfiniteScroll();

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
window.logout = logout;
window.setCategory = setCategory;
window.clearSearch = clearSearch;
window.repetirUltimoPedido = repetirUltimoPedido;
window.setSortMode = setSortMode;
window.changeQty = changeQty;
window.setQty = setQty;
window.setCliente = setCliente;
window.toggleSoloSurtido = toggleSoloSurtido;
window.submitOrder = submitOrder;
window.nuevoPedido = nuevoPedido;
