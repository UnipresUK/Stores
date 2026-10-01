// Stores Management backend.
// Deploy: Extensions > Apps Script > paste this in, then
// Deploy > New deployment > type "Web app" > Execute as "Me" > Who has access "Anyone".
// Copy the resulting /exec URL into the API URL field in the app settings.

var SPREADSHEET_ID      = "1hZaNIzuUfAuqBxcr616QffwvsJkxcfOKzTC7vqPv7Fo";
var NOTIFY_EMAIL        = "sam.pascoe@upuk-unipres.com";
var PRODUCTS_SHEET      = "Products";
var REQUESTS_SHEET      = "Requests";
var STOCK_LOG_SHEET     = "StockTaken";
var TAKE_EMAIL_PROPERTY = "takeEmailEnabled";
var SETTINGS_PASSCODE   = "3110";

function doGet(e) {
  var action = (e.parameter && e.parameter.action) || "products";

  if (action === "transactions") {
    return jsonResponse(readRecentTransactions());
  }

  if (action === "settings") {
    if ((e.parameter.passcode || "") !== SETTINGS_PASSCODE) {
      return jsonResponse({ ok: false, error: "Invalid passcode" });
    }
    return jsonResponse({ ok: true, takeEmailEnabled: isTakeEmailEnabled() });
  }

  return jsonResponse(readProducts());
}

function doPost(e) {
  var action = (e.parameter && e.parameter.action) || "reorder";
  var body;
  try {
    body = JSON.parse(e.postData.contents);
  } catch (err) {
    return jsonResponse({ ok: false, error: "Invalid JSON body" });
  }

  // action can also be in the body when sent via fetch with text/plain
  if (body.action) action = body.action;

  if (action === "take")           return handleTakeStock(body);
  if (action === "updateSettings") return handleUpdateSettings(body);
  return handleReorder(body);
}

// ── Settings ──────────────────────────────────────────────────────────────────
function isTakeEmailEnabled() {
  var stored = PropertiesService.getScriptProperties().getProperty(TAKE_EMAIL_PROPERTY);
  return stored === null ? true : stored === "true";
}

function setTakeEmailEnabled(enabled) {
  PropertiesService.getScriptProperties().setProperty(TAKE_EMAIL_PROPERTY, String(enabled));
}

function handleUpdateSettings(body) {
  if ((body.passcode || "") !== SETTINGS_PASSCODE) {
    return jsonResponse({ ok: false, error: "Invalid passcode" });
  }
  setTakeEmailEnabled(!!body.takeEmailEnabled);
  return jsonResponse({ ok: true, takeEmailEnabled: isTakeEmailEnabled() });
}

// ── Reorder request ───────────────────────────────────────────────────────────
function handleReorder(body) {
  var requester = (body.requester || "").toString().trim();
  var items = Array.isArray(body.items) ? body.items : [];

  if (!requester || items.length === 0) {
    return jsonResponse({ ok: false, error: "requester and items are required" });
  }

  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    appendRequests(requester, items);
  } finally {
    lock.releaseLock();
  }

  sendNotificationEmail(requester, items);
  return jsonResponse({ ok: true });
}

// ── Take stock ────────────────────────────────────────────────────────────────
function handleTakeStock(body) {
  var requester   = (body.requester   || "").toString().trim();
  var sku         = (body.sku         || "").toString().trim();
  var qty         = Number(body.qty);
  var description = (body.description || sku).toString().trim();

  if (!requester || !sku || !qty || qty <= 0) {
    return jsonResponse({ ok: false, error: "requester, sku, and a positive qty are required" });
  }

  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  var newStock;
  try {
    newStock = deductStock(sku, qty);
  } catch (err) {
    return jsonResponse({ ok: false, error: err.message });
  } finally {
    lock.releaseLock();
  }

  appendStockLog(requester, sku, description, qty, newStock);

  if (isTakeEmailEnabled()) {
    sendTakeNotificationEmail(requester, description, qty, newStock);
  }

  return jsonResponse({ ok: true, sku: sku, currentStock: newStock });
}

// ── Read products ─────────────────────────────────────────────────────────────
function readProducts() {
  var sheet  = SpreadsheetApp.openById(SPREADSHEET_ID).getSheetByName(PRODUCTS_SHEET);
  var values = sheet.getDataRange().getValues();
  var headers = values[0].map(function(h) { return h.toString().trim().toLowerCase(); });

  var col = {
    description:   headers.indexOf("description"),
    sku:           headers.indexOf("sku"),
    location:      headers.indexOf("location"),
    currentStock:  headers.indexOf("current stock"),
    minLevel:      headers.indexOf("min level"),
    maxLevel:      headers.indexOf("max level"),
    oem:           headers.indexOf("oem"),
    partNumber:    headers.indexOf("part number"),
    supplierLink:  headers.indexOf("supplier link"),
    cost:          headers.indexOf("cost"),
    quotation:     headers.indexOf("quotation"),
    category:      headers.indexOf("category"),
    subcategory:   headers.indexOf("subcategory"),
    imageFilename: headers.indexOf("image filename"),
    datasheetLink: headers.indexOf("supplier datasheet"),
  };

  var products = [];
  for (var i = 1; i < values.length; i++) {
    var row = values[i];
    // Skip rows with no description (column A)
    if (!row[col.description]) continue;

    products.push({
      description:   row[col.description].toString(),
      sku:           col.sku           >= 0 ? row[col.sku].toString()           : "",
      location:      col.location      >= 0 ? row[col.location].toString()      : "",
      currentStock:  col.currentStock  >= 0 ? row[col.currentStock]             : "",
      minLevel:      col.minLevel      >= 0 ? row[col.minLevel]                 : "",
      maxLevel:      col.maxLevel      >= 0 ? row[col.maxLevel]                 : "",
      oem:           col.oem           >= 0 ? row[col.oem].toString()           : "",
      partNumber:    col.partNumber    >= 0 ? row[col.partNumber].toString()    : "",
      supplierLink:  col.supplierLink  >= 0 ? row[col.supplierLink].toString()  : "",
      cost:          col.cost          >= 0 ? row[col.cost]                     : "",
      quotation:     col.quotation     >= 0 ? row[col.quotation]                : "",
      category:      col.category      >= 0 ? row[col.category].toString()      : "",
      subcategory:   col.subcategory   >= 0 ? row[col.subcategory].toString()   : "",
      imageFilename: col.imageFilename >= 0 ? row[col.imageFilename].toString() : "",
      datasheetLink: col.datasheetLink >= 0 ? row[col.datasheetLink].toString() : "",
    });
  }
  return products;
}

// ── Read transactions ─────────────────────────────────────────────────────────
function readRecentTransactions() {
  var LIMIT = 50;
  var sheet = SpreadsheetApp.openById(SPREADSHEET_ID).getSheetByName(STOCK_LOG_SHEET);
  if (!sheet) return [];

  var values  = sheet.getDataRange().getValues();
  var headers = values[0].map(function(h) { return h.toString().trim().toLowerCase(); });
  var col = {
    timestamp:   headers.indexOf("timestamp"),
    requester:   headers.indexOf("requester"),
    sku:         headers.indexOf("sku"),
    description: headers.indexOf("description"),
    qty:         headers.indexOf("qty taken"),
    newStock:    headers.indexOf("new stock"),
  };

  var rows = [];
  for (var i = 1; i < values.length; i++) {
    var row = values[i];
    if (!row[col.sku]) continue;
    var ts = col.timestamp >= 0 ? row[col.timestamp] : "";
    rows.push({
      timestamp:   ts instanceof Date ? ts.toISOString() : ts.toString(),
      requester:   col.requester   >= 0 ? row[col.requester].toString()   : "",
      sku:         row[col.sku].toString(),
      description: col.description >= 0 ? row[col.description].toString() : "",
      qty:         col.qty         >= 0 ? row[col.qty]                    : "",
      newStock:    col.newStock    >= 0 ? row[col.newStock]               : "",
    });
  }

  rows.reverse();
  return rows.slice(0, LIMIT);
}

// ── Sheet helpers ─────────────────────────────────────────────────────────────
function appendRequests(requester, items) {
  var ss    = SpreadsheetApp.openById(SPREADSHEET_ID);
  var sheet = ss.getSheetByName(REQUESTS_SHEET);
  if (!sheet) {
    sheet = ss.insertSheet(REQUESTS_SHEET);
    sheet.appendRow(["Timestamp", "Requester", "SKU", "Qty", "Description"]);
    sheet.getRange(1,1,1,5).setFontWeight("bold");
    sheet.setFrozenRows(1);
  }
  var timestamp = new Date();
  var rows = items.map(function(item) {
    return [timestamp, requester, item.sku, item.qty, item.description || ""];
  });
  sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, 5).setValues(rows);
}

function deductStock(sku, qty) {
  var sheet   = SpreadsheetApp.openById(SPREADSHEET_ID).getSheetByName(PRODUCTS_SHEET);
  var values  = sheet.getDataRange().getValues();
  var headers = values[0].map(function(h) { return h.toString().trim().toLowerCase(); });
  var skuCol  = headers.indexOf("sku");
  var stkCol  = headers.indexOf("current stock");

  if (skuCol < 0 || stkCol < 0) {
    throw new Error("Products sheet is missing a SKU or Current Stock column");
  }

  for (var i = 1; i < values.length; i++) {
    if (values[i][skuCol].toString() === sku) {
      var current = Number(values[i][stkCol]) || 0;
      var updated = Math.max(0, current - qty);
      sheet.getRange(i + 1, stkCol + 1).setValue(updated);
      return updated;
    }
  }

  throw new Error("SKU not found: " + sku);
}

function appendStockLog(requester, sku, description, qty, newStock) {
  var ss    = SpreadsheetApp.openById(SPREADSHEET_ID);
  var sheet = ss.getSheetByName(STOCK_LOG_SHEET);
  if (!sheet) {
    sheet = ss.insertSheet(STOCK_LOG_SHEET);
    sheet.appendRow(["Timestamp", "Requester", "SKU", "Qty Taken", "New Stock", "Description"]);
    sheet.getRange(1,1,1,6).setFontWeight("bold");
    sheet.setFrozenRows(1);
  }
  sheet.appendRow([new Date(), requester, sku, qty, newStock, description]);
}

// ── Emails ────────────────────────────────────────────────────────────────────
function sendNotificationEmail(requester, items) {
  var lines = items.map(function(item) {
    return "  - " + item.description + "  x" + item.qty;
  });
  var subject = "Stock request from " + requester;
  var body =
    requester + " submitted a stock request:\n\n" +
    lines.join("\n") +
    "\n\nSubmitted: " + new Date().toLocaleString();
  MailApp.sendEmail(NOTIFY_EMAIL, subject, body);
}

function sendTakeNotificationEmail(requester, description, qty, newStock) {
  var subject = requester + " took stock: " + description;
  var body =
    requester + " took " + qty + " x " + description + ".\n" +
    "New stock level: " + newStock + "\n\n" +
    "Taken: " + new Date().toLocaleString();
  MailApp.sendEmail(NOTIFY_EMAIL, subject, body);
}

function jsonResponse(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
