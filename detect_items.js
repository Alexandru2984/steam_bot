
(async () => {
  if (location.hostname !== "steamcommunity.com") {
    console.error("Rulează scriptul pe steamcommunity.com");
    return;
  }

  if (window.dotaScan?.running) {
    console.warn("Scanarea rulează deja!");
    return;
  }

  const steamId =
    typeof g_steamID !== "undefined"
      ? String(g_steamID)
      : location.pathname.match(/\/profiles\/(\d{17})/)?.[1];

  if (!steamId || !/^\d{17}$/.test(steamId)) {
    console.error("Nu am identificat SteamID64.");
    return;
  }

  const KEY = `dota-market-scanner-v2-${steamId}`;
  const DELAY = 7000;

  const sleep = ms =>
    new Promise(resolve => setTimeout(resolve, ms));

  function parsePrice(value) {
    if (!value) return null;

    const s = String(value).replace(/[^\d,.]/g, "");
    if (!s) return null;

    const index = Math.max(
      s.lastIndexOf(","),
      s.lastIndexOf(".")
    );

    let normalized;

    if (index >= 0 && /^\d{1,2}$/.test(s.slice(index + 1))) {
      normalized =
        s.slice(0, index).replace(/[.,]/g, "") +
        "." +
        s.slice(index + 1);
    } else {
      normalized = s.replace(/[.,]/g, "");
    }

    const number = Number(normalized);
    return Number.isFinite(number) ? number : null;
  }

  // Estimare comisioane Steam + Dota 2.
  function estimateNet(buyerEUR) {
    if (buyerEUR === null) return null;

    const total = Math.round(buyerEUR * 100);
    let low = 0;
    let high = total;

    while (low < high) {
      const mid = Math.ceil((low + high) / 2);

      const steamFee = Math.max(1, Math.floor(mid * 0.05));
      const dotaFee = Math.max(1, Math.floor(mid * 0.10));

      if (mid + steamFee + dotaFee <= total) {
        low = mid;
      } else {
        high = mid - 1;
      }
    }

    return low / 100;
  }

  async function loadInventory() {
    if (Array.isArray(window.dotaInventory)) {
      console.log("Folosim inventarul deja încărcat.");
      return window.dotaInventory;
    }

    console.log("Încărcăm inventarul Dota 2...");

    const items = [];
    let cursor = null;

    do {
      const url = new URL(
        `/inventory/${steamId}/570/2`,
        location.origin
      );

      url.searchParams.set("l", "english");
      url.searchParams.set("count", "2000");

      if (cursor) {
        url.searchParams.set("start_assetid", cursor);
      }

      const response = await fetch(url, {
        credentials: "same-origin"
      });

      if (!response.ok) {
        throw new Error(`Inventory HTTP ${response.status}`);
      }

      const data = await response.json();

      if (!data.success) {
        throw new Error("Nu am putut citi inventarul.");
      }

      const descriptions = new Map(
        (data.descriptions || []).map(d => [
          `${d.classid}_${d.instanceid}`, d
        ])
      );

      for (const asset of data.assets || []) {
        const desc = descriptions.get(
          `${asset.classid}_${asset.instanceid}`
        );

        items.push({
          name: desc?.name || "Unknown",
          marketHashName: desc?.market_hash_name || "",
          type: desc?.type || "",
          quantity: Number(asset.amount || 1),
          marketable: Number(desc?.marketable) === 1
        });
      }

      if (!data.more_items) break;

      if (!data.last_assetid ||
          data.last_assetid === cursor) {
        throw new Error("Cursor inventar invalid.");
      }

      cursor = data.last_assetid;
      await sleep(4000);

    } while (true);

    return items;
  }

  const scanner = {
    running: true,
    stopped: false,
    stop() {
      this.stopped = true;
      console.warn("Oprirea a fost solicitată.");
    }
  };

  window.dotaScan = scanner;

  try {
    const inventory = await loadInventory();
    const groups = new Map();

    for (const item of inventory) {
      if (!item.marketable || !item.marketHashName) continue;

      const hash = item.marketHashName;

      if (!groups.has(hash)) {
        groups.set(hash, {
          name: hash,
          type: item.type,
          quantity: 0
        });
      }

      groups.get(hash).quantity += item.quantity;
    }

    const items = [...groups.values()];

    function priority(item) {
      const value = `${item.name} ${item.type}`;

      if (/arcana/i.test(value)) return 100;
      if (/immortal/i.test(value)) return 95;
      if (/unusual/i.test(value)) return 90;
      if (/frostivus|dead reckoning/i.test(value)) return 85;
      if (/legendary/i.test(value)) return 80;
      if (/mythical/i.test(value)) return 70;
      if (/treasure|chest/i.test(value)) return 65;
      if (/rare/i.test(value)) return 50;
      return 10;
    }

    items.sort((a, b) =>
      priority(b) - priority(a) ||
      a.name.localeCompare(b.name)
    );

    let saved;

    try {
      saved = JSON.parse(localStorage.getItem(KEY) || "{}");
    } catch {
      saved = {};
    }

    const prices = saved.prices || {};
    const save = () => localStorage.setItem(
      KEY,
      JSON.stringify({ prices, updatedAt: Date.now() })
    );

    function buildRows() {
      return items.map(item => {
        const record = prices[item.name];
        const price = record?.priceEUR ?? null;
        const net = estimateNet(price);

        return {
          name: item.name,
          type: item.type,
          quantity: item.quantity,
          lowestEUR: price,
          median: record?.median || "",
          volume: record?.volume || "",
          grossEUR: price === null
            ? null
            : Number((price * item.quantity).toFixed(2)),
          estimatedNetEUR: net === null
            ? null
            : Number((net * item.quantity).toFixed(2)),
          status: record?.status || "not_checked",
          marketURL:
            "https://steamcommunity.com/market/listings/570/" +
            encodeURIComponent(item.name)
        };
      }).sort((a, b) =>
        (b.estimatedNetEUR ?? -1) -
        (a.estimatedNetEUR ?? -1)
      );
    }

    function exportCSV() {
      const rows = buildRows();

      const headers = [
        "name", "type", "quantity", "lowestEUR",
        "median", "volume", "grossEUR",
        "estimatedNetEUR", "status", "marketURL"
      ];

      const escapeCSV = value => {
        let s = String(value ?? "");
        if (/^[=+@-]/.test(s)) s = "'" + s;
        return `"${s.replace(/"/g, '""')}"`;
      };

      const content = "\uFEFF" + [
        headers.join(","),
        ...rows.map(row =>
          headers.map(h => escapeCSV(row[h])).join(",")
        )
      ].join("\r\n");

      const blob = new Blob([content], {
        type: "text/csv;charset=utf-8"
      });

      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");

      a.href = url;
      a.download = "dota2-market-valuation.csv";
      document.body.appendChild(a);
      a.click();
      a.remove();

      setTimeout(() => URL.revokeObjectURL(url), 60000);
      console.log("CSV exportat:", rows.length, "tipuri");
    }

    scanner.exportCSV = exportCSV;
    scanner.results = buildRows;

    console.log("===== DOTA MARKET SCANNER 2.0 =====");
    console.log("Tipuri de evaluat:", items.length);
    console.log(
      "Deja evaluate:",
      items.filter(i => prices[i.name]).length
    );
    console.log("Progresul se salvează automat.");

    let stoppedByError = false;

    for (let index = 0; index < items.length; index++) {
      const item = items[index];
      if (scanner.stopped) break;
      if (prices[item.name]) continue;

      const url = new URL(
        "/market/priceoverview/",
        location.origin
      );

      url.search = new URLSearchParams({
        appid: "570",
        currency: "3",
        country: "RO",
        market_hash_name: item.name
      });

      try {
        let data = null;

        for (let attempt = 0; attempt < 3; attempt++) {
          const response = await fetch(url, {
            credentials: "same-origin",
            signal: AbortSignal.timeout(20000)
          });

          if (response.status === 429 ||
              response.status >= 500) {
            if (attempt === 2) {
              throw new Error(
                `HTTP ${response.status}: limită persistentă`
              );
            }

            const pause = 90000 * (attempt + 1);

            console.warn(
              `HTTP ${response.status}. Pauză ${pause / 1000}s...`
            );

            await sleep(pause);
            if (scanner.stopped) break;
            continue;
          }

          if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
          }

          data = await response.json();
          break;
        }

        if (scanner.stopped) break;

        if (data?.success) {
          prices[item.name] = {
            status: "priced",
            priceEUR: parsePrice(data.lowest_price),
            lowest: data.lowest_price || "",
            median: data.median_price || "",
            volume: data.volume || "",
            checkedAt: Date.now()
          };
        } else {
          prices[item.name] = {
            status: "no_data",
            priceEUR: null,
            checkedAt: Date.now()
          };
        }

        save();

        const done = items.filter(i => prices[i.name]).length;

        if (done % 10 === 0 || done === items.length) {
          const valued = buildRows().filter(
            r => r.estimatedNetEUR !== null
          );

          const net = valued.reduce(
            (sum, r) => sum + r.estimatedNetEUR, 0
          );

          console.log(
            `[${done}/${items.length}]`,
            `${(done / items.length * 100).toFixed(1)}%`,
            `Net estimat evaluat: ${net.toFixed(2)} EUR`
          );
        }

        if (index < items.length - 1) {
          await sleep(DELAY);
        }

      } catch (error) {
        console.error(
          "Scanarea s-a oprit la:",
          item.name,
          error.message
        );
        stoppedByError = true;
        break;
      }
    }

    const rows = buildRows();
    const priced = rows.filter(
      r => r.estimatedNetEUR !== null
    );

    const totalGross = priced.reduce(
      (sum, r) => sum + r.grossEUR, 0
    );

    const totalNet = priced.reduce(
      (sum, r) => sum + r.estimatedNetEUR, 0
    );

    const completed = items.filter(i => prices[i.name]).length;

    console.log("===== REZULTATE =====");
    console.log("Tipuri procesate:", completed, "/", items.length);
    console.log("Tipuri cu preț:", priced.length);
    console.log("Valoare brută:", totalGross.toFixed(2), "EUR");
    console.log("Net estimat:", totalNet.toFixed(2), "EUR");

    console.table(rows.slice(0, 30));

    exportCSV();

    if (stoppedByError || scanner.stopped) {
      console.warn(
        "Scanare parțială. Progresul este salvat. " +
        "Reexecutarea scriptului continuă de unde a rămas."
      );
    } else {
      console.log("Scanare finalizată!");
    }

  } catch (error) {
    console.error("Eroare:", error);
  } finally {
    scanner.running = false;
  }
})();
