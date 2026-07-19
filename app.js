// Set this to your deployed Apps Script Web App URL (ends in /exec).
// Left blank, the page falls back to products.sample.json and simulates
// submission locally, useful for testing before the backend exists.
const API_URL = "";

const state = {
  products: [],
  pending: new Map(), // sku -> qty
};

const els = {
  requester: document.getElementById("requester"),
  search: document.getElementById("search"),
  status: document.getElementById("status"),
  grid: document.getElementById("productGrid"),
  cartBar: document.getElementById("cartBar"),
  cartCount: document.getElementById("cartCount"),
  cartSubmitBtn: document.getElementById("cartSubmitBtn"),
  confirmOverlay: document.getElementById("confirmOverlay"),
  confirmRequester: document.getElementById("confirmRequester"),
  confirmList: document.getElementById("confirmList"),
  confirmCancelBtn: document.getElementById("confirmCancelBtn"),
  confirmSubmitBtn: document.getElementById("confirmSubmitBtn"),
  toast: document.getElementById("toast"),
};

init();

function init() {
  const savedName = localStorage.getItem("requesterName");
  if (savedName) els.requester.value = savedName;
  els.requester.addEventListener("change", () => {
    localStorage.setItem("requesterName", els.requester.value.trim());
  });

  els.search.addEventListener("input", () => renderGrid());
  els.cartSubmitBtn.addEventListener("click", openConfirm);
  els.confirmCancelBtn.addEventListener("click", closeConfirm);
  els.confirmSubmitBtn.addEventListener("click", submitOrder);

  loadProducts();
}

async function loadProducts() {
  els.status.textContent = "Loading products…";
  try {
    const url = API_URL ? `${API_URL}?action=products` : "products.sample.json";
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    state.products = await res.json();
    els.status.textContent = `${state.products.length} products`;
    renderGrid();
  } catch (err) {
    els.status.textContent = "Failed to load products. Check your connection and try again.";
    console.error(err);
  }
}

function matchesSearch(product, term) {
  if (!term) return true;
  const haystack = `${product.sku} ${product.description} ${product.location}`.toLowerCase();
  return haystack.includes(term);
}

function renderGrid() {
  const term = els.search.value.trim().toLowerCase();
  const filtered = state.products.filter((p) => matchesSearch(p, term));

  els.grid.innerHTML = "";
  for (const product of filtered) {
    els.grid.appendChild(renderCard(product));
  }

  if (filtered.length === 0) {
    els.status.textContent = "No products match your search.";
  } else {
    els.status.textContent = `${filtered.length} of ${state.products.length} products`;
  }
}

function renderCard(product) {
  const qty = state.pending.get(product.sku) || 0;

  const card = document.createElement("div");
  card.className = "product-card" + (qty > 0 ? " flagged" : "");

  const img = document.createElement("img");
  img.src = product.imageFilename ? `images/${product.imageFilename}` : "images/placeholder.svg";
  img.alt = product.description || product.sku;
  img.loading = "lazy";
  img.onerror = () => { img.onerror = null; img.src = "images/placeholder.svg"; };
  card.appendChild(img);

  const info = document.createElement("div");
  info.className = "product-info";
  info.innerHTML = `
    <span class="location-badge">${escapeHtml(product.location)}</span>
    <div class="sku">${escapeHtml(product.sku)}</div>
    <div class="desc">${escapeHtml(product.description)}</div>
    <div class="stock-line">In stock: ${escapeHtml(String(product.currentStock))}</div>
  `;
  card.appendChild(info);

  const stepper = document.createElement("div");
  stepper.className = "stepper";

  const minusBtn = document.createElement("button");
  minusBtn.type = "button";
  minusBtn.textContent = "−";
  minusBtn.addEventListener("click", () => changeQty(product.sku, -1));

  const qtyEl = document.createElement("span");
  qtyEl.className = "qty";
  qtyEl.textContent = qty;

  const plusBtn = document.createElement("button");
  plusBtn.type = "button";
  plusBtn.textContent = "+";
  plusBtn.addEventListener("click", () => changeQty(product.sku, 1));

  stepper.append(minusBtn, qtyEl, plusBtn);
  card.appendChild(stepper);

  return card;
}

function changeQty(sku, delta) {
  const current = state.pending.get(sku) || 0;
  const next = Math.max(0, current + delta);
  if (next === 0) {
    state.pending.delete(sku);
  } else {
    state.pending.set(sku, next);
  }
  renderGrid();
  updateCartBar();
}

function updateCartBar() {
  const count = state.pending.size;
  if (count === 0) {
    els.cartBar.classList.add("hidden");
    return;
  }
  els.cartBar.classList.remove("hidden");
  els.cartCount.textContent = `${count} product${count === 1 ? "" : "s"} flagged for reorder`;
}

function openConfirm() {
  const name = els.requester.value.trim();
  if (!name) {
    showToast("Please enter your name first.");
    els.requester.focus();
    return;
  }

  els.confirmRequester.textContent = name;
  els.confirmList.innerHTML = "";
  for (const [sku, qty] of state.pending.entries()) {
    const product = state.products.find((p) => p.sku === sku);
    const li = document.createElement("li");
    li.innerHTML = `<span>${escapeHtml(sku)} — ${escapeHtml(product ? product.description : "")}</span><strong>${qty}</strong>`;
    els.confirmList.appendChild(li);
  }
  els.confirmOverlay.classList.remove("hidden");
}

function closeConfirm() {
  els.confirmOverlay.classList.add("hidden");
}

async function submitOrder() {
  const requester = els.requester.value.trim();
  const items = Array.from(state.pending.entries()).map(([sku, qty]) => ({ sku, qty }));
  const payload = { requester, items };

  els.confirmSubmitBtn.disabled = true;
  els.confirmSubmitBtn.textContent = "Sending…";

  try {
    if (API_URL) {
      const res = await fetch(API_URL, {
        method: "POST",
        // Deliberately text/plain (not application/json) so this stays a
        // "simple request" and Apps Script never sees a CORS preflight.
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } else {
      console.log("Simulated submit (no API_URL set):", payload);
      await new Promise((r) => setTimeout(r, 400));
    }

    state.pending.clear();
    closeConfirm();
    updateCartBar();
    renderGrid();
    showToast("Order submitted.");
  } catch (err) {
    console.error(err);
    showToast("Failed to submit order. Please try again.");
  } finally {
    els.confirmSubmitBtn.disabled = false;
    els.confirmSubmitBtn.textContent = "Confirm & Send";
  }
}

let toastTimer = null;
function showToast(message) {
  els.toast.textContent = message;
  els.toast.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => els.toast.classList.add("hidden"), 2500);
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str ?? "";
  return div.innerHTML;
}
