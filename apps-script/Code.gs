// Stores Management backend.
// Deploy: Extensions > Apps Script > paste this in, then
// Deploy > New deployment > type "Web app" > Execute as "Me" > Who has access "Anyone".
// Copy the resulting /exec URL into API_URL at the top of app.js.

var NOTIFY_EMAIL = "sam.pascoe@upuk-unipres.com";
var PRODUCTS_SHEET = "Products";
var REQUESTS_SHEET = "Requests";
var STOCK_LOG_SHEET = "StockTaken";
var REORDER_STATUS_SHEET = "ReorderStatus";
var PROJECT_ORDERS_SHEET = "ProjectOrders";
var TAKE_EMAIL_PROPERTY = "takeEmailEnabled";
var SETTINGS_PASSCODE = "1234"; // change this to whatever you like

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

  if (action === "take") {
    return handleTakeStock(body);
  }
  if (action === "updateSettings") {
    return handleUpdateSettings(body);
  }
  if (action === "resolveReorder") {
    return handleResolveReorder(body);
  }
  if (body.projectOrder) {
    return handleProjectOrder(body);
  }
  return handleReorder(body);
}

function handleUpdateSettings(body) {
  if ((body.passcode || "") !== SETTINGS_PASSCODE) {
    return jsonResponse({ ok: false, error: "Invalid passcode" });
  }
  setTakeEmailEnabled(!!body.takeEmailEnabled);
  return jsonResponse({ ok: true, takeEmailEnabled: isTakeEmailEnabled() });
}

function isTakeEmailEnabled() {
  // Defaults to ON (unset) so every removal is emailed while adoption is
  // still being checked; this is a shared setting for everyone, not a
  // per-device preference, since it controls whether *you* get emailed.
  var stored = PropertiesService.getScriptProperties().getProperty(TAKE_EMAIL_PROPERTY);
  return stored === null ? true : stored === "true";
}

function setTakeEmailEnabled(enabled) {
  PropertiesService.getScriptProperties().setProperty(TAKE_EMAIL_PROPERTY, String(enabled));
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
  var timestamp = new Date();
  try {
    appendRequests(requester, items, timestamp);
    upsertReorderStatus(requester, items, timestamp);
  } finally {
    lock.releaseLock();
  }

  sendNotificationEmail(requester, items);

  return jsonResponse({ ok: true, timestamp: timestamp.toISOString() });
}

function handleProjectOrder(body) {
  var requester = (body.requester || "").toString().trim();
  var projectName = (body.projectOrder && body.projectOrder.name || "").toString().trim();
  var items = Array.isArray(body.items) ? body.items : [];

  if (!requester || !projectName || items.length === 0) {
    return jsonResponse({ ok: false, error: "requester, project name, and items are required" });
  }

  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(PROJECT_ORDERS_SHEET);
  if (!sheet) {
    return jsonResponse({ ok: false, error: "ProjectOrders tab doesn't exist -- add it before using Project Orders" });
  }

  // Project orders are deliberately kept out of the stores reorder-status
  // tracking (no upsertReorderStatus call here) -- ordering for a specific
  // project isn't "reordering stores stock" and shouldn't flag/hide it.
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    appendProjectOrder(requester, projectName, items);
  } finally {
    lock.releaseLock();
  }

  sendProjectOrderEmail(requester, projectName, items);

  return jsonResponse({ ok: true });
}

function handleResolveReorder(body) {
  var sku = (body.sku || "").toString().trim();
  if (!sku) {
    return jsonResponse({ ok: false, error: "sku is required" });
  }

  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(REORDER_STATUS_SHEET);
  if (!sheet) {
    return jsonResponse({ ok: false, error: "ReorderStatus tab doesn't exist" });
  }

  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var rowIndex = findReorderStatusRow(sheet, sku);
    if (rowIndex >= 0) {
      var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0]
        .map(function (h) { return h.toString().trim().toLowerCase(); });
      var resolvedCol = headers.indexOf("resolved");
      if (resolvedCol >= 0) {
        sheet.getRange(rowIndex + 1, resolvedCol + 1).setValue(true);
      }
    }
  } finally {
    lock.releaseLock();
  }

  return jsonResponse({ ok: true });
}

function handleTakeStock(body) {
  var requester = (body.requester || "").toString().trim();
  var sku = (body.sku || "").toString().trim();
  var qty = Number(body.qty);
  var description = (body.description || sku).toString().trim();

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

  appendStockLog(requester, sku, description, qty, newStock);
  if (isTakeEmailEnabled()) {
    sendTakeNotificationEmail(requester, description, qty, newStock);
  }

  return jsonResponse({ ok: true, sku: sku, currentStock: newStock });
}

function readProducts() {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(PRODUCTS_SHEET);
  var values = sheet.getDataRange().getValues();
  var headers = values[0].map(function (h) { return h.toString().trim().toLowerCase(); });
  var reorderStatusMap = getReorderStatusMap();

  var col = {
    sku: headers.indexOf("sku"),
    description: headers.indexOf("description"),
    category: headers.indexOf("category"),
    subcategory: headers.indexOf("subcategory"),
    oem: headers.indexOf("oem"),
    partNumber: headers.indexOf("part number"),
    supplier: headers.indexOf("supplier"),
    supplierLink: headers.indexOf("supplier link"),
    datasheetLink: headers.indexOf("datasheet link"),
    location: headers.indexOf("location"),
    currentStock: headers.indexOf("current stock"),
    minLevel: headers.indexOf("min level"),
    maxLevel: headers.indexOf("max level"),
    unit: headers.indexOf("unit"),
    imageFilename: headers.indexOf("image filename"),
  };

  var products = [];
  for (var i = 1; i < values.length; i++) {
    var row = values[i];
    if (!row[col.sku]) continue;
    var sku = row[col.sku].toString();
    products.push({
      sku: sku,
      description: col.description >= 0 ? row[col.description].toString() : "",
      category: col.category >= 0 ? row[col.category].toString() : "",
      subcategory: col.subcategory >= 0 ? row[col.subcategory].toString() : "",
      oem: col.oem >= 0 ? row[col.oem].toString() : "",
      partNumber: col.partNumber >= 0 ? row[col.partNumber].toString() : "",
      supplier: col.supplier >= 0 ? row[col.supplier].toString() : "",
      supplierLink: col.supplierLink >= 0 ? row[col.supplierLink].toString() : "",
      datasheetLink: col.datasheetLink >= 0 ? row[col.datasheetLink].toString() : "",
      location: col.location >= 0 ? row[col.location].toString() : "",
      currentStock: col.currentStock >= 0 ? row[col.currentStock] : "",
      minLevel: col.minLevel >= 0 ? row[col.minLevel] : "",
      maxLevel: col.maxLevel >= 0 ? row[col.maxLevel] : "",
      unit: col.unit >= 0 ? row[col.unit].toString() : "",
      imageFilename: col.imageFilename >= 0 ? row[col.imageFilename].toString() : "",
      lastReorder: reorderStatusMap[sku] || null,
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
    description: headers.indexOf("description"),
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
      description: col.description >= 0 ? row[col.description].toString() : "",
      qty: col.qty >= 0 ? row[col.qty] : "",
      newStock: col.newStock >= 0 ? row[col.newStock] : "",
    });
  }

  rows.reverse(); // most recent first
  return rows.slice(0, LIMIT);
}

function appendRequests(requester, items, timestamp) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(REQUESTS_SHEET);
  var rows = items.map(function (item) {
    return [timestamp, requester, item.sku, item.qty, item.description || ""];
  });
  sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, 5).setValues(rows);
}

function getReorderStatusMap() {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(REORDER_STATUS_SHEET);
  if (!sheet) return {};

  var values = sheet.getDataRange().getValues();
  if (values.length < 2) return {};
  var headers = values[0].map(function (h) { return h.toString().trim().toLowerCase(); });
  var col = {
    sku: headers.indexOf("sku"),
    requester: headers.indexOf("requester"),
    timestamp: headers.indexOf("timestamp"),
    resolved: headers.indexOf("resolved"),
  };
  if (col.sku < 0) return {};

  var map = {};
  for (var i = 1; i < values.length; i++) {
    var row = values[i];
    if (!row[col.sku]) continue;
    var ts = col.timestamp >= 0 ? row[col.timestamp] : "";
    map[row[col.sku].toString()] = {
      requester: col.requester >= 0 ? row[col.requester].toString() : "",
      timestamp: ts instanceof Date ? ts.toISOString() : ts.toString(),
      resolved: col.resolved >= 0 ? !!row[col.resolved] : false,
    };
  }
  return map;
}

function findReorderStatusRow(sheet, sku) {
  var values = sheet.getDataRange().getValues();
  var headers = values[0].map(function (h) { return h.toString().trim().toLowerCase(); });
  var skuCol = headers.indexOf("sku");
  if (skuCol < 0) return -1;

  for (var i = 1; i < values.length; i++) {
    if (values[i][skuCol].toString() === sku) return i;
  }
  return -1;
}

function upsertReorderStatus(requester, items, timestamp) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(REORDER_STATUS_SHEET);
  if (!sheet) return; // optional tab -- skip tracking if it hasn't been created

  var headers = sheet.getRange(1, 1, 1, Math.max(sheet.getLastColumn(), 1)).getValues()[0]
    .map(function (h) { return h.toString().trim().toLowerCase(); });
  var skuCol = headers.indexOf("sku");
  var requesterCol = headers.indexOf("requester");
  var timestampCol = headers.indexOf("timestamp");
  var resolvedCol = headers.indexOf("resolved");
  if (skuCol < 0) return;

  items.forEach(function (item) {
    var rowIndex = findReorderStatusRow(sheet, item.sku);
    if (rowIndex >= 0) {
      if (requesterCol >= 0) sheet.getRange(rowIndex + 1, requesterCol + 1).setValue(requester);
      if (timestampCol >= 0) sheet.getRange(rowIndex + 1, timestampCol + 1).setValue(timestamp);
      if (resolvedCol >= 0) sheet.getRange(rowIndex + 1, resolvedCol + 1).setValue(false);
    } else {
      var row = [];
      row[skuCol] = item.sku;
      if (requesterCol >= 0) row[requesterCol] = requester;
      if (timestampCol >= 0) row[timestampCol] = timestamp;
      if (resolvedCol >= 0) row[resolvedCol] = false;
      sheet.getRange(sheet.getLastRow() + 1, 1, 1, row.length).setValues([row]);
    }
  });
}

function appendProjectOrder(requester, projectName, items) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(PROJECT_ORDERS_SHEET);
  var timestamp = new Date();
  var rows = items.map(function (item) {
    return [timestamp, requester, projectName, item.sku, item.description || "", item.qty];
  });
  sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, 6).setValues(rows);
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

function appendStockLog(requester, sku, description, qty, newStock) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(STOCK_LOG_SHEET);
  if (!sheet) return; // optional tab -- skip logging if it hasn't been created
  sheet.appendRow([new Date(), requester, sku, qty, newStock, description]);
}

function sendNotificationEmail(requester, items) {
  var lines = items.map(function (item) {
    return "  - " + item.description + "  x" + item.qty;
  });

  var subject = "Stock reorder request from " + requester;
  var body =
    requester + " submitted a reorder request:\n\n" +
    lines.join("\n") +
    "\n\nSubmitted: " + new Date().toLocaleString();

  MailApp.sendEmail(NOTIFY_EMAIL, subject, body);
}

function sendProjectOrderEmail(requester, projectName, items) {
  var lines = items.map(function (item) {
    return "  - " + item.description + "  x" + item.qty;
  });

  var subject = "Project order (" + projectName + ") from " + requester;
  var body =
    requester + " submitted a PROJECT ORDER for \"" + projectName + "\" -- not a stores restock:\n\n" +
    lines.join("\n") +
    "\n\nSubmitted: " + new Date().toLocaleString();

  MailApp.sendEmail(NOTIFY_EMAIL, subject, body);
}

function sendTakeNotificationEmail(requester, description, qty, newStock) {
  var subject = requester + " took stock: " + description;
  var body =
    requester + " took " + qty + " of " + description + ".\n\n" +
    "New stock level: " + newStock +
    "\n\nTaken: " + new Date().toLocaleString();

  MailApp.sendEmail(NOTIFY_EMAIL, subject, body);
}

function jsonResponse(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
