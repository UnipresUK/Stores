# Stores Management Dashboard

A QR-code-friendly page for the engineering team to browse stock locations (A1, A2, A3…) and submit reorder requests. Frontend is a static site (this repo, hosted on GitHub Pages); the backend is a Google Sheet + Apps Script.

## 1. Create the Google Sheet

**Use a personal Google account, not a corporate/Workspace one.** Corporate Workspace accounts commonly restrict sharing/publishing outside the organization, which blocks deploying the Apps Script Web App with "Anyone" access (step 2 below). A personal account has no such restriction. Note that email notifications will then show as sent *from* that personal account — the recipient address can still be anything you like (e.g. a work inbox).

Create a new Google Sheet with two tabs:

**`Products`** — one row per SKU. Columns are matched by header name, not position, so you can add them in any order:

| SKU | Description | Category | OEM | Supplier | Supplier Link | Location | Current Stock | Min Level | Unit | Image Filename |
|-----|-------------|----------|-----|----------|----------------|----------|----------------|-----------|------|-----------------|
| SKU-1001 | M8 Hex Bolt 40mm | Fasteners | ISO 4017 | RS Online | https://... | A1 | 4 | 5 | box of 100 | sku-1001.jpg |

- Leave `Image Filename` blank for products without a photo yet — the page falls back to a placeholder icon.
- Leave `Min Level` blank for products you don't want flagged automatically. When `Current Stock` drops to or below `Min Level`, the page shows a red "Low stock" badge on that product and it's included when the "Low stock only" filter is ticked — it's just a visual flag to prompt someone to reorder, nothing gets submitted automatically.
- `Category`, `OEM`, and `Supplier` are all optional and searchable on the page (e.g. searching "Reducer" or a supplier name matches).
- `Supplier Link` (optional) renders as a clickable link on the product card so whoever's ordering can jump straight to the supplier's page.
- `Unit` (optional, e.g. "each", "box of 100") is shown next to the stock count so there's no ambiguity about what a "+1" reorder actually represents.

**`Requests`** — leave empty except for a header row, Apps Script appends to it:

| Timestamp | Requester | SKU | Qty Requested |
|-----------|-----------|-----|-----------------|

## 2. Deploy the Apps Script backend

1. In the Sheet, go to **Extensions > Apps Script**.
2. Delete the default code and paste in the contents of [`apps-script/Code.gs`](apps-script/Code.gs).
3. Update `NOTIFY_EMAIL` at the top if needed (currently `sam.pascoe@upuk-unipres.com`).
4. Click **Deploy > New deployment**.
   - Type: **Web app**
   - Execute as: **Me**
   - Who has access: **Anyone**
5. Authorize the requested permissions, then copy the deployment's web app URL (ends in `/exec`).

## 3. Point the frontend at the backend

Open [`app.js`](app.js) and set:

```js
const API_URL = "https://script.google.com/macros/s/XXXXXXXX/exec";
```

Leaving it blank makes the page load `products.sample.json` instead and simulate submissions — useful for testing the UI before the Sheet exists.

## 4. Enable GitHub Pages

In this repo's GitHub settings: **Settings > Pages > Source: Deploy from branch**, pick `main` and `/ (root)`. The page will be live at `https://<username>.github.io/<repo>/`.

## 5. Generate the QR code

Point any QR code generator at the Pages URL above and print it for the stores area. One shared code is enough for now — per-location codes can be added later without changing the backend.

## Adding product photos

Save images into the `images/` folder using the filename referenced in the `Image Filename` column (e.g. `images/sku-1001.jpg`). Keep them small — around 400×400px and under 150KB — so the page stays fast on phones.

## How the reorder flow works

- Team member picks their name (or types a new one) and browses/searches the product list.
- Tapping **+**/**−** on a product only adjusts a local counter — nothing is sent yet.
- Once anything is flagged, a bar appears at the bottom to **Submit Order**.
- Submitting sends one batched request: it logs a row per item in `Requests` and sends a single summary email, rather than emailing on every button tap.
- Flagged quantities are saved to the device's local storage as you go, so closing the tab or reloading the page won't lose them — and the browser will warn before letting anyone navigate away or close the tab while something is still unsubmitted.
- Each device/browser is independent (name, search, and pending quantities aren't shared between devices), so multiple people can use the page from their own phones at the same time without conflicting. Submissions from different devices at the same moment are queued safely on the backend so none get lost.
