// Stores Management backend.
// Deploy: Extensions > Apps Script > paste this in, then
// Deploy > New deployment > type "Web app" > Execute as "Me" > Who has access "Anyone".
// Copy the resulting /exec URL into API_URL at the top of app.js.

var NOTIFY_EMAIL = "sam.pascoe@upuk-unipres.com";
var PRODUCTS_SHEET = "Products";
var REQUESTS_SHEET = "Requests";
var STOCK_LOG_SHEET = "StockTaken";

function doGet(e) {
  var action = (e.parameter && e.parameter.action) || "products";
  if (action === "transactions") {
    return jsonResponse(readRecentTransactions());
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

  if (action === "take") {
    return handleTakeStock(body);
  }
  return handleReorder(body);
}

function handleReorder(body) {
  var requester = (body.requester || "").toString().trim();
  var items = Array.isArray(body.items) ? body.items : [];

  if (!requester || items.length === 0) {
    return jsonResponse({ ok: false, error: "requester and items are required" });
  }

  // Multiple people can submit from different devices at the same moment.
  // Without a lock, two concurrent appends could both compute the same
  // "next row" and one submission would silently overwrite the other.
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

function handleTakeStock(body) {
  var requester = (body.requester || "").toString().trim();
  var sku = (body.sku || "").toString().trim();
  var qty = Number(body.qty);

  if (!requester || !sku || !qty || qty <= 0) {
    return jsonResponse({ ok: false, error: "requester, sku, and a positive qty are required" });
  }

  // Deducting stock happens far more often than reordering and doesn't
  // need an email each time, but it still needs the same lock protection:
  // two people taking the same part at once must not overwrite each other.
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

  appendStockLog(requester, sku, qty, newStock);
  sendTakeNotificationEmail(requester, sku, qty, newStock);

  return jsonResponse({ ok: true, sku: sku, currentStock: newStock });
}

function readProducts() {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(PRODUCTS_SHEET);
  var values = sheet.getDataRange().getValues();
  var headers = values[0].map(function (h) { return h.toString().trim().toLowerCase(); });

  var col = {
    sku: headers.indexOf("sku"),
    description: headers.indexOf("description"),
    category: headers.indexOf("category"),
    oem: headers.indexOf("oem"),
    supplier: headers.indexOf("supplier"),
    supplierLink: headers.indexOf("supplier link"),
    datasheetLink: headers.indexOf("datasheet link"),
    location: headers.indexOf("location"),
    currentStock: headers.indexOf("current stock"),
    minLevel: headers.indexOf("min level"),
    unit: headers.indexOf("unit"),
    imageFilename: headers.indexOf("image filename"),
  };

  var products = [];
  for (var i = 1; i < values.length; i++) {
    var row = values[i];
    if (!row[col.sku]) continue;
    products.push({
      sku: row[col.sku].toString(),
      description: col.description >= 0 ? row[col.description].toString() : "",
      category: col.category >= 0 ? row[col.category].toString() : "",
      oem: col.oem >= 0 ? row[col.oem].toString() : "",
      supplier: col.supplier >= 0 ? row[col.supplier].toString() : "",
      supplierLink: col.supplierLink >= 0 ? row[col.supplierLink].toString() : "",
      datasheetLink: col.datasheetLink >= 0 ? row[col.datasheetLink].toString() : "",
      location: col.location >= 0 ? row[col.location].toString() : "",
      currentStock: col.currentStock >= 0 ? row[col.currentStock] : "",
      minLevel: col.minLevel >= 0 ? row[col.minLevel] : "",
      unit: col.unit >= 0 ? row[col.unit].toString() : "",
      imageFilename: col.imageFilename >= 0 ? row[col.imageFilename].toString() : "",
    });
  }
  return products;
}

function readRecentTransactions() {
  var LIMIT = 50;
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(STOCK_LOG_SHEET);
  if (!sheet) return [];

  var values = sheet.getDataRange().getValues();
  var headers = values[0].map(function (h) { return h.toString().trim().toLowerCase(); });
  var col = {
    timestamp: headers.indexOf("timestamp"),
    requester: headers.indexOf("requester"),
    sku: headers.indexOf("sku"),
    qty: headers.indexOf("qty taken"),
    newStock: headers.indexOf("new stock"),
  };

  var rows = [];
  for (var i = 1; i < values.length; i++) {
    var row = values[i];
    if (!row[col.sku]) continue;
    var ts = col.timestamp >= 0 ? row[col.timestamp] : "";
    rows.push({
      timestamp: ts instanceof Date ? ts.toISOString() : ts.toString(),
      requester: col.requester >= 0 ? row[col.requester].toString() : "",
      sku: row[col.sku].toString(),
      qty: col.qty >= 0 ? row[col.qty] : "",
      newStock: col.newStock >= 0 ? row[col.newStock] : "",
    });
  }

  rows.reverse(); // most recent first
  return rows.slice(0, LIMIT);
}

function appendRequests(requester, items) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(REQUESTS_SHEET);
  var timestamp = new Date();
  var rows = items.map(function (item) {
    return [timestamp, requester, item.sku, item.qty];
  });
  sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, 4).setValues(rows);
}

function deductStock(sku, qty) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(PRODUCTS_SHEET);
  var values = sheet.getDataRange().getValues();
  var headers = values[0].map(function (h) { return h.toString().trim().toLowerCase(); });
  var skuCol = headers.indexOf("sku");
  var stockCol = headers.indexOf("current stock");

  if (skuCol < 0 || stockCol < 0) {
    throw new Error("Products sheet is missing an SKU or Current Stock column");
  }

  for (var i = 1; i < values.length; i++) {
    if (values[i][skuCol].toString() === sku) {
      var current = Number(values[i][stockCol]) || 0;
      var updated = Math.max(0, current - qty);
      sheet.getRange(i + 1, stockCol + 1).setValue(updated);
      return updated;
    }
  }

  throw new Error("SKU not found: " + sku);
}

function appendStockLog(requester, sku, qty, newStock) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(STOCK_LOG_SHEET);
  if (!sheet) return; // optional tab -- skip logging if it hasn't been created
  sheet.appendRow([new Date(), requester, sku, qty, newStock]);
}

function sendNotificationEmail(requester, items) {
  var lines = items.map(function (item) {
    return "  - " + item.sku + "  x" + item.qty;
  });

  var subject = "Stock reorder request from " + requester;
  var body =
    requester + " submitted a reorder request:\n\n" +
    lines.join("\n") +
    "\n\nSubmitted: " + new Date().toLocaleString();

  MailApp.sendEmail(NOTIFY_EMAIL, subject, body);
}

function sendTakeNotificationEmail(requester, sku, qty, newStock) {
  var subject = requester + " took stock: " + sku;
  var body =
    requester + " took " + qty + " of " + sku + ".\n\n" +
    "New stock level: " + newStock +
    "\n\nTaken: " + new Date().toLocaleString();

  MailApp.sendEmail(NOTIFY_EMAIL, subject, body);
}

function jsonResponse(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
