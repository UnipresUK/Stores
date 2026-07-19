// Stores Management backend.
// Deploy: Extensions > Apps Script > paste this in, then
// Deploy > New deployment > type "Web app" > Execute as "Me" > Who has access "Anyone".
// Copy the resulting /exec URL into API_URL at the top of app.js.

var NOTIFY_EMAIL = "sam.pascoe@upuk-unipres.com";
var PRODUCTS_SHEET = "Products";
var REQUESTS_SHEET = "Requests";

function doGet(e) {
  var products = readProducts();
  return jsonResponse(products);
}

function doPost(e) {
  var body;
  try {
    body = JSON.parse(e.postData.contents);
  } catch (err) {
    return jsonResponse({ ok: false, error: "Invalid JSON body" });
  }

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

function readProducts() {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(PRODUCTS_SHEET);
  var values = sheet.getDataRange().getValues();
  var headers = values[0].map(function (h) { return h.toString().trim().toLowerCase(); });

  var col = {
    sku: headers.indexOf("sku"),
    description: headers.indexOf("description"),
    location: headers.indexOf("location"),
    currentStock: headers.indexOf("current stock"),
    imageFilename: headers.indexOf("image filename"),
  };

  var products = [];
  for (var i = 1; i < values.length; i++) {
    var row = values[i];
    if (!row[col.sku]) continue;
    products.push({
      sku: row[col.sku].toString(),
      description: col.description >= 0 ? row[col.description].toString() : "",
      location: col.location >= 0 ? row[col.location].toString() : "",
      currentStock: col.currentStock >= 0 ? row[col.currentStock] : "",
      imageFilename: col.imageFilename >= 0 ? row[col.imageFilename].toString() : "",
    });
  }
  return products;
}

function appendRequests(requester, items) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(REQUESTS_SHEET);
  var timestamp = new Date();
  var rows = items.map(function (item) {
    return [timestamp, requester, item.sku, item.qty];
  });
  sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, 4).setValues(rows);
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

function jsonResponse(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
