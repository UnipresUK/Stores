// Set this to your deployed Apps Script Web App URL (ends in /exec).
// Left blank, the page falls back to products.sample.json and simulates
// submission locally, useful for testing before the backend exists.
const API_URL = "https://script.google.com/macros/s/AKfycbwM7b0nUJIwizdppHMk7FAH56EVZ9tPDP7A5jg3B9GcCOu1GnDsVwL2MXWDaCJqxltXQQ/exec";

const PENDING_STORAGE_KEY = "pendingOrders";
const HIDE_IMAGES_KEY = "hideImages";

const state = {
  products: [],
  pending: new Map(), // sku -> reorder qty
  takeQty: new Map(), // sku -> qty about to be taken (local only, defaults to 1)
  activeCategory: null, // set by tapping a category chip; null means "All"
  activeSubcategory: null, // set via the subcategory dropdown; null means "All"
};

const els = {
  requester: document.getElementById("requester"),
  gateHint: document.getElementById("gateHint"),
  gateContinueBtn: document.getElementById("gateContinueBtn"),
  searchControls: document.getElementById("searchControls"),
  mainContent: document.getElementById("mainContent"),
  search: document.getElementById("search"),
  categoryChips: document.getElementById("categoryChips"),
  subcategorySelect: document.getElementById("subcategorySelect"),
  lowStockOnly: document.getElementById("lowStockOnly"),
  hideImages: document.getElementById("hideImages"),
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
  settingsBtn: document.getElementById("settingsBtn"),
  settingsOverlay: document.getElementById("settingsOverlay"),
  settingsCloseBtn: document.getElementById("settingsCloseBtn"),
  settingsLocked: document.getElementById("settingsLocked"),
  settingsUnlocked: document.getElementById("settingsUnlocked"),
  settingsPasscodeInput: document.getElementById("settingsPasscodeInput"),
  settingsUnlockBtn: document.getElementById("settingsUnlockBtn"),
  takeEmailToggle: document.getElementById("takeEmailToggle"),
  removalsBtn: document.getElementById("removalsBtn"),
  removalsOverlay: document.getElementById("removalsOverlay"),
  removalsCloseBtn: document.getElementById("removalsCloseBtn"),
  removalsList: document.getElementById("removalsList"),
  toast: document.getElementById("toast"),
};

let gatePassed = false;

init();

function init() {
  const savedName = localStorage.getItem("requesterName");
  if (savedName) {
    els.requester.value = savedName;
    passGate();
  } else {
    els.gateContinueBtn.classList.remove("hidden");
    els.requester.focus();
  }

  els.requester.addEventListener("change", () => {
    localStorage.setItem("requesterName", els.requester.value.trim());
  });
  els.requester.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !gatePassed) confirmGateName();
  });
  els.gateContinueBtn.addEventListener("click", confirmGateName);

  initSettings();
  initRemovals();

  restorePending();
  updateCartBar();

  els.search.addEventListener("input", () => renderGrid());
  els.lowStockOnly.addEventListener("change", () => renderGrid());
  els.subcategorySelect.addEventListener("change", () => selectSubcategory(els.subcategorySelect.value));

  els.hideImages.checked = localStorage.getItem(HIDE_IMAGES_KEY) === "true";
  els.grid.classList.toggle("hide-images", els.hideImages.checked);
  els.hideImages.addEventListener("change", () => {
    localStorage.setItem(HIDE_IMAGES_KEY, els.hideImages.checked);
    els.grid.classList.toggle("hide-images", els.hideImages.checked);
  });
  els.cartSubmitBtn.addEventListener("click", openConfirm);
  els.confirmCancelBtn.addEventListener("click", closeConfirm);
  els.confirmSubmitBtn.addEventListener("click", submitOrder);
  document.querySelectorAll('input[name="orderMode"]').forEach((radio) => {
    radio.addEventListener("change", renderConfirmList);
  });

  // Warn before leaving so nobody loses flagged reorders by accidentally
  // closing the tab or navigating away without hitting Submit Order.
  window.addEventListener("beforeunload", (e) => {
    if (state.pending.size > 0) {
      e.preventDefault();
      e.returnValue = "";
    }
  });

  loadProducts();
}

function confirmGateName() {
  const name = els.requester.value.trim();
  if (!name) {
    showToast("Please enter your name first.");
    els.requester.focus();
    return;
  }
  localStorage.setItem("requesterName", name);
  passGate();
}

function passGate() {
  gatePassed = true;
  els.gateHint.classList.add("hidden");
  els.gateContinueBtn.classList.add("hidden");
  els.searchControls.classList.remove("hidden");
  els.mainContent.classList.remove("hidden");
}

function initSettings() {
  els.settingsBtn.addEventListener("click", () => {
    els.settingsOverlay.classList.remove("hidden");
  });
  els.settingsCloseBtn.addEventListener("click", () => {
    els.settingsOverlay.classList.add("hidden");
  });

  els.settingsUnlockBtn.addEventListener("click", unlockSettings);
  els.settingsPasscodeInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") unlockSettings();
  });
  els.takeEmailToggle.addEventListener("change", updateTakeEmailSetting);
}

function initRemovals() {
  els.removalsBtn.addEventListener("click", () => {
    els.removalsOverlay.classList.remove("hidden");
    loadTransactions();
  });
  els.removalsCloseBtn.addEventListener("click", () => {
    els.removalsOverlay.classList.add("hidden");
  });
}

let settingsPasscode = null;

async function unlockSettings() {
  const passcode = els.settingsPasscodeInput.value.trim();
  if (!passcode) {
    showToast("Enter the passcode first.");
    return;
  }
  if (!API_URL) {
    showToast("Not available in demo mode (no API_URL set).");
    return;
  }

  els.settingsUnlockBtn.disabled = true;
  try {
    const res = await fetch(`${API_URL}?action=settings&passcode=${encodeURIComponent(passcode)}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (!data.ok) {
      showToast("Incorrect passcode.");
      return;
    }

    settingsPasscode = passcode;
    els.takeEmailToggle.checked = data.takeEmailEnabled;
    els.settingsLocked.classList.add("hidden");
    els.settingsUnlocked.classList.remove("hidden");
    els.settingsPasscodeInput.value = "";
  } catch (err) {
    console.error(err);
    showToast("Failed to check passcode. Please try again.");
  } finally {
    els.settingsUnlockBtn.disabled = false;
  }
}

async function updateTakeEmailSetting() {
  const checked = els.takeEmailToggle.checked;
  try {
    const res = await fetch(`${API_URL}?action=updateSettings`, {
      method: "POST",
      body: JSON.stringify({ passcode: settingsPasscode, takeEmailEnabled: checked }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || "Unknown error");
    showToast(checked ? "Take Stock emails turned on." : "Take Stock emails turned off.");
  } catch (err) {
    console.error(err);
    els.takeEmailToggle.checked = !checked; // revert on failure
    showToast("Failed to update setting. Please try again.");
  }
}

async function loadTransactions() {
  els.removalsList.textContent = "Loading…";
  try {
    if (!API_URL) {
      els.removalsList.textContent = "Not available in demo mode (no API_URL set).";
      return;
    }
    const res = await fetch(`${API_URL}?action=transactions`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    renderTransactions(await res.json());
  } catch (err) {
    console.error(err);
    els.removalsList.textContent = "Failed to load recent removals.";
  }
}

function renderTransactions(transactions) {
  if (!transactions || transactions.length === 0) {
    els.removalsList.textContent = "No removals recorded yet.";
    return;
  }
  els.removalsList.innerHTML = transactions.map((t) => `
    <div class="removal-row">
      <span class="removal-when">${escapeHtml(formatTimestamp(t.timestamp))}</span>
      <span class="removal-who">${escapeHtml(t.requester)}</span>
      <span class="removal-what">${escapeHtml(describeSku(t))} &minus;${escapeHtml(String(t.qty))}</span>
      <span class="removal-stock">now ${escapeHtml(String(t.newStock))}</span>
    </div>
  `).join("");
}

function describeSku(item) {
  if (item.description) return item.description;
  const product = state.products.find((p) => p.sku === item.sku);
  return product ? product.description : item.sku;
}

function formatTimestamp(iso) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return String(iso);
  return d.toLocaleString([], { dateStyle: "short", timeStyle: "short" });
}

function restorePending() {
  try {
    const raw = localStorage.getItem(PENDING_STORAGE_KEY);
    if (!raw) return;
    const entries = JSON.parse(raw);
    if (Array.isArray(entries)) {
      state.pending = new Map(entries);
    }
  } catch (err) {
    console.error("Failed to restore pending orders", err);
  }
}

function savePending() {
  localStorage.setItem(PENDING_STORAGE_KEY, JSON.stringify(Array.from(state.pending.entries())));
}

async function loadProducts() {
  els.status.textContent = "Loading products…";
  try {
    const url = API_URL ? `${API_URL}?action=products` : "products.sample.json";
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    state.products = await res.json();
    els.status.textContent = `${state.products.length} products`;
    renderCategoryChips();
    renderGrid();
  } catch (err) {
    els.status.textContent = "Failed to load products. Check your connection and try again.";
    console.error(err);
  }
}

function matchesSearch(product, term) {
  if (!term) return true;
  const haystack = `${product.sku} ${product.description} ${product.location} ${product.category || ""} ${product.subcategory || ""} ${product.oem || ""} ${product.partNumber || ""} ${product.supplier || ""}`.toLowerCase();
  return haystack.includes(term);
}

function isLowStock(product) {
  const min = Number(product.minLevel);
  const current = Number(product.currentStock);
  if (product.minLevel === "" || product.minLevel == null || Number.isNaN(min)) return false;
  if (Number.isNaN(current)) return false;
  return current <= min;
}

function renderCategoryChips() {
  const categories = Array.from(
    new Set(state.products.map((p) => (p.category || "").trim()).filter(Boolean))
  ).sort((a, b) => a.localeCompare(b));

  // Dropping a category that no longer exists (e.g. renamed in the Sheet)
  // so the filter doesn't get stuck on a chip that's no longer shown.
  if (state.activeCategory && !categories.includes(state.activeCategory)) {
    state.activeCategory = null;
  }

  els.categoryChips.innerHTML = "";

  if (categories.length === 0) {
    renderSubcategoryOptions();
    return;
  }

  const allChip = document.createElement("button");
  allChip.type = "button";
  allChip.className = "chip" + (state.activeCategory === null ? " active" : "");
  allChip.textContent = "All";
  allChip.addEventListener("click", () => selectCategory(null));
  els.categoryChips.appendChild(allChip);

  for (const category of categories) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "chip" + (state.activeCategory === category ? " active" : "");
    chip.textContent = category;
    chip.addEventListener("click", () => selectCategory(category));
    els.categoryChips.appendChild(chip);
  }

  renderSubcategoryOptions();
}

function selectCategory(category) {
  state.activeCategory = category;
  state.activeSubcategory = null;
  renderCategoryChips();
  renderGrid();
}

function renderSubcategoryOptions() {
  if (!state.activeCategory) {
    state.activeSubcategory = null;
    els.subcategorySelect.classList.add("hidden");
    els.subcategorySelect.innerHTML = "";
    return;
  }

  const subcategories = Array.from(
    new Set(
      state.products
        .filter((p) => p.category === state.activeCategory)
        .map((p) => (p.subcategory || "").trim())
        .filter(Boolean)
    )
  ).sort((a, b) => a.localeCompare(b));

  if (subcategories.length === 0) {
    state.activeSubcategory = null;
    els.subcategorySelect.classList.add("hidden");
    els.subcategorySelect.innerHTML = "";
    return;
  }

  // Dropping a subcategory that's no longer valid for the current category
  // (e.g. category was switched, or the Sheet data changed).
  if (state.activeSubcategory && !subcategories.includes(state.activeSubcategory)) {
    state.activeSubcategory = null;
  }

  els.subcategorySelect.innerHTML = "";
  const allOption = document.createElement("option");
  allOption.value = "";
  allOption.textContent = `All ${state.activeCategory}`;
  els.subcategorySelect.appendChild(allOption);

  for (const sub of subcategories) {
    const opt = document.createElement("option");
    opt.value = sub;
    opt.textContent = sub;
    els.subcategorySelect.appendChild(opt);
  }

  els.subcategorySelect.value = state.activeSubcategory || "";
  els.subcategorySelect.classList.remove("hidden");
}

function selectSubcategory(subcategory) {
  state.activeSubcategory = subcategory || null;
  renderGrid();
}

function renderGrid() {
  const term = els.search.value.trim().toLowerCase();
  const lowStockOnly = els.lowStockOnly.checked;
  const filtered = state.products
    .filter((p) => matchesSearch(p, term))
    .filter((p) => !lowStockOnly || isLowStock(p))
    .filter((p) => !state.activeCategory || p.category === state.activeCategory)
    .filter((p) => !state.activeSubcategory || p.subcategory === state.activeSubcategory);

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
  img.src = resolveImageSrc(product.imageFilename);
  img.alt = product.description || product.sku;
  img.loading = "lazy";
  img.onerror = () => { img.onerror = null; img.src = "images/placeholder.svg"; };
  card.appendChild(img);

  const unitSuffix = product.unit ? ` ${product.unit}` : "";
  const partNo = product.partNumber || product.oem;
  const oemLine = partNo ? `<div class="meta-line">Part No: ${escapeHtml(partNo)}</div>` : "";
  const supplierLine = product.supplier || product.supplierLink
    ? `<div class="meta-line">Supplier: ${
        product.supplierLink
          ? `<a href="${escapeAttr(normalizeUrl(product.supplierLink))}" target="_blank" rel="noopener">${escapeHtml(product.supplier || "Link")}</a>`
          : escapeHtml(product.supplier)
      }</div>`
    : "";
  const datasheetLine = product.datasheetLink
    ? `<div class="meta-line"><a href="${escapeAttr(normalizeUrl(product.datasheetLink))}" target="_blank" rel="noopener">View datasheet</a></div>`
    : "";

  const info = document.createElement("div");
  info.className = "product-info";
  info.innerHTML = `
    <span class="location-badge">${escapeHtml(product.location)}</span>
    ${product.category ? `<span class="category-badge">${escapeHtml(product.category)}</span>` : ""}
    ${isLowStock(product) ? '<span class="low-stock-badge">Low stock</span>' : ""}
    <div class="desc">${escapeHtml(product.description)}</div>
    <div class="sku">${escapeHtml(product.sku)}</div>
    ${oemLine}
    ${supplierLine}
    ${datasheetLine}
    <div class="stock-line">In stock: ${escapeHtml(String(product.currentStock))}${escapeHtml(unitSuffix)}</div>
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

  const stepperLabel = document.createElement("div");
  stepperLabel.className = "stepper-label";
  stepperLabel.textContent = "Reorder qty";
  card.appendChild(stepperLabel);
  card.appendChild(stepper);

  card.appendChild(renderTakeStockRow(product));

  return card;
}

function renderTakeStockRow(product) {
  const takeQty = state.takeQty.get(product.sku) || 1;

  const wrapper = document.createElement("div");
  wrapper.className = "take-stock-row";

  const label = document.createElement("div");
  label.className = "stepper-label";
  label.textContent = "Take stock";
  wrapper.appendChild(label);

  const controlsRow = document.createElement("div");
  controlsRow.className = "take-controls-row";

  const stepper = document.createElement("div");
  stepper.className = "stepper";

  const minusBtn = document.createElement("button");
  minusBtn.type = "button";
  minusBtn.textContent = "−";
  minusBtn.addEventListener("click", () => changeTakeQty(product.sku, -1));

  const qtyEl = document.createElement("span");
  qtyEl.className = "qty";
  qtyEl.textContent = takeQty;

  const plusBtn = document.createElement("button");
  plusBtn.type = "button";
  plusBtn.textContent = "+";
  plusBtn.addEventListener("click", () => changeTakeQty(product.sku, 1));

  const takeBtn = document.createElement("button");
  takeBtn.type = "button";
  takeBtn.className = "take-btn";
  takeBtn.textContent = "Take";
  takeBtn.addEventListener("click", () => takeStock(product.sku, takeBtn));

  stepper.append(minusBtn, qtyEl, plusBtn);
  controlsRow.append(stepper, takeBtn);
  wrapper.appendChild(controlsRow);
  return wrapper;
}

function changeQty(sku, delta) {
  const current = state.pending.get(sku) || 0;
  const next = Math.max(0, current + delta);
  if (next === 0) {
    state.pending.delete(sku);
  } else {
    state.pending.set(sku, next);
  }
  savePending();
  renderGrid();
  updateCartBar();
}

function changeTakeQty(sku, delta) {
  const current = state.takeQty.get(sku) || 1;
  const next = Math.max(1, current + delta);
  state.takeQty.set(sku, next);
  renderGrid();
}

async function takeStock(sku, buttonEl) {
  const requester = els.requester.value.trim();
  if (!requester) {
    showToast("Please enter your name first.");
    els.requester.focus();
    return;
  }

  const qty = state.takeQty.get(sku) || 1;
  const product = state.products.find((p) => p.sku === sku);
  const description = product ? product.description : sku;
  buttonEl.disabled = true;

  try {
    if (API_URL) {
      const res = await fetch(`${API_URL}?action=take`, {
        method: "POST",
        body: JSON.stringify({ requester, sku, qty, description }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || "Unknown error");

      if (product) product.currentStock = data.currentStock;
    } else {
      console.log("Simulated take (no API_URL set):", { requester, sku, qty, description });
      await new Promise((r) => setTimeout(r, 300));
      if (product) {
        product.currentStock = Math.max(0, Number(product.currentStock) - qty);
      }
    }

    state.takeQty.delete(sku);
    renderGrid();
    showToast(`Took ${qty} of ${description}.`);
    if (!els.removalsOverlay.classList.contains("hidden")) loadTransactions();
  } catch (err) {
    console.error(err);
    showToast("Failed to record stock taken. Please try again.");
    buttonEl.disabled = false;
  }
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

function getOrderMode() {
  const checked = document.querySelector('input[name="orderMode"]:checked');
  return checked ? checked.value : "selected";
}

function computeOrderQty(product, selectedQty, mode) {
  if (mode !== "max") return selectedQty;
  const max = Number(product && product.maxLevel);
  if (!product || product.maxLevel === "" || product.maxLevel == null || Number.isNaN(max)) {
    return selectedQty; // no Max Level set for this product -- fall back to what was selected
  }
  const current = Number(product.currentStock) || 0;
  return Math.max(0, max - current);
}

function openConfirm() {
  const name = els.requester.value.trim();
  if (!name) {
    showToast("Please enter your name first.");
    els.requester.focus();
    return;
  }

  els.confirmRequester.textContent = name;
  document.querySelector('input[name="orderMode"][value="selected"]').checked = true;
  renderConfirmList();
  els.confirmOverlay.classList.remove("hidden");
}

function renderConfirmList() {
  const mode = getOrderMode();
  els.confirmList.innerHTML = "";
  for (const [sku, selectedQty] of state.pending.entries()) {
    const product = state.products.find((p) => p.sku === sku);
    const qty = computeOrderQty(product, selectedQty, mode);
    const li = document.createElement("li");
    li.innerHTML = `<span>${escapeHtml(product ? product.description : sku)}</span><strong>${qty}</strong>`;
    els.confirmList.appendChild(li);
  }
}

function closeConfirm() {
  els.confirmOverlay.classList.add("hidden");
}

async function submitOrder() {
  const requester = els.requester.value.trim();
  const mode = getOrderMode();
  const items = Array.from(state.pending.entries()).map(([sku, selectedQty]) => {
    const product = state.products.find((p) => p.sku === sku);
    return {
      sku,
      qty: computeOrderQty(product, selectedQty, mode),
      description: product ? product.description : sku,
    };
  });
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
    savePending();
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

function resolveImageSrc(imageFilename) {
  if (!imageFilename) return "images/placeholder.svg";
  // A full URL (e.g. pasted from a supplier's site) is used directly;
  // anything else is treated as a filename uploaded to the images/ folder.
  return /^https?:\/\//i.test(imageFilename) ? imageFilename : `images/${imageFilename}`;
}

function normalizeUrl(url) {
  // Sheet data often gets pasted without a protocol (e.g. "www.example.com/x.pdf"),
  // which the browser would otherwise treat as a broken relative link.
  return /^https?:\/\//i.test(url) ? url : `https://${url}`;
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str ?? "";
  return div.innerHTML;
}

function escapeAttr(str) {
  return escapeHtml(str).replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
