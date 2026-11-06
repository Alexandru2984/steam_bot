# Dota 2 Market Scanner

A lightweight JavaScript tool for inspecting a Dota 2 inventory and estimating its value on the **Steam Community Market**. Run it directly in your browser's developer console—no dependencies, browser extensions, or API keys required.

> **Read-only:** This script does not list, sell, trade, or transfer items.

## Features

- Fetches the full Dota 2 inventory through Steam's inventory endpoint, including pagination.
- Identifies marketable items and groups identical items by `market_hash_name`, preserving quantities.
- Retrieves the lowest listed price, median price, and reported sales volume when available.
- Checks higher-priority item categories first (including Arcana, Immortal, Legendary, Mythical, and selected treasure chests).
- Spaces out price requests and retries some temporary HTTP errors with backoff.
- Saves scanned prices in `localStorage` so interrupted scans can resume without repeating successful requests.
- Estimates seller proceeds after Steam and Dota 2 marketplace fees.
- Exports a CSV report sorted by estimated net value.

## Requirements

- A modern browser with developer tools.
- A signed-in Steam Community session with access to your Dota 2 inventory.

## Usage

1. Open your [Dota 2 inventory](https://steamcommunity.com/my/inventory/#570) on `steamcommunity.com`.
2. Open **Developer Tools → Console** (`F12`).
3. Paste and run the contents of `dota-market-scanner.js`.
4. Watch the progress updates in the console. Large inventories may take a while to scan.
5. Once the scan finishes, the browser downloads `dota2-market-valuation.csv` automatically.

To request a stop after the current operation:

```js
window.dotaScan.stop();
```

Re-run the script to resume from the cached results after an interruption or page reload. While the original page session remains open, you can export the report again with:

```js
window.dotaScan.exportCSV();
```

## Configuration

The current script uses the following settings:

| Setting | Value | Purpose |
| --- | --- | --- |
| App ID | `570` | Dota 2 |
| Inventory context | `2` | Steam inventory |
| Currency | `3` (EUR) | Market price requests |
| Country | `RO` | Market price requests |
| Delay between price requests | `7000 ms` | Reduces request frequency |
| Retries on HTTP 429 / 5xx | Up to 3 attempts | Uses increasing delays |
| Progress persistence | `localStorage` | Continues an interrupted scan |

Steam may impose additional rate limits, and the scanner may need to be restarted later if those limits persist.

## CSV output

| Column | Description |
| --- | --- |
| `name` | Steam Market item name |
| `type` | Steam-reported item type/rarity |
| `quantity` | Number of marketable copies |
| `lowestEUR` | Lowest listed buyer price in EUR |
| `median` | Steam-reported median price, when provided |
| `volume` | Steam-reported sales volume, when provided |
| `grossEUR` | `lowestEUR × quantity` |
| `estimatedNetEUR` | Estimated seller proceeds for the quantity |
| `status` | `priced`, `no_data`, or `not_checked` |
| `marketURL` | Item listing page on Steam Market |

## How valuation works

The script requests price data from Steam Community Market and estimates the amount a seller might receive after the Steam fee (5%) and Dota 2 fee (10%), accounting approximately for minimum fees and rounding. These estimates are **not** guaranteed sale prices or exact proceeds. Check the final seller amount in Steam's listing interface before selling.

## Limitations

- Lowest listed prices can change and do not guarantee an immediate buyer.
- Cached prices **do not refresh automatically** when the scan is resumed; clear the scanner's relevant `localStorage` entry if you intentionally want a completely fresh valuation.
- The default price parser assumes EUR-style market formatting and the configuration is set to Romania.
- `marketable` and `tradable` are different Steam inventory properties.
- Rate limits, temporary network failures, and changes to Steam endpoints can interrupt the scan.
- This tool reads inventory and pricing data only; **it does not automate market listings**.
- Never paste your Steam password, Steam Guard codes, or session tokens into untrusted scripts.

## Example console output

```text
DOTA MARKET SCANNER 2.0
Types to evaluate: 395
[50/395] 12.7% — Estimated net: 20.38 EUR
[395/395] 100.0% — Estimated net: 25.92 EUR
CSV exported: 395 item types
```

The values above are illustrative results from a previous scan, not an expected value for other inventories.

## Disclaimer

Unofficial community utility. Not affiliated with, endorsed by, or maintained by Valve or Steam.