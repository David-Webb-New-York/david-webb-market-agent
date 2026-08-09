(() => {
  "use strict";

  const PAGE_SIZE = 50;

  const state = {
    records: [],
    filtered: [],
    sortKey: "date",
    sortDir: "desc",
    page: 1,
  };

  const els = {
    stats: document.getElementById("stats"),
    lastUpdated: document.getElementById("last-updated"),
    search: document.getElementById("search"),
    filterType: document.getElementById("filter-type"),
    filterStatus: document.getElementById("filter-status"),
    filterSource: document.getElementById("filter-source"),
    filterCategory: document.getElementById("filter-category"),
    filterFlagged: document.getElementById("filter-flagged"),
    clearFilters: document.getElementById("clear-filters"),
    table: document.getElementById("results-table"),
    body: document.getElementById("results-body"),
    emptyState: document.getElementById("empty-state"),
    pagination: document.getElementById("pagination"),
    modal: document.getElementById("detail-modal"),
    modalTitle: document.getElementById("modal-title"),
    modalImage: document.getElementById("modal-image"),
    modalBody: document.getElementById("modal-body"),
  };

  // --- Data loading & normalization ------------------------------------

  async function loadJson(path) {
    try {
      const res = await fetch(path, { cache: "no-store" });
      if (!res.ok) return [];
      return await res.json();
    } catch (_) {
      return [];
    }
  }

  function auctionStatus(r) {
    if (r.sold_price) return "Sold";
    if (r.estimate_low || r.estimate_high) return "Estimate only";
    return "Unknown";
  }

  function dealerStatus(r) {
    return r.status === "active" ? "For sale" : "Delisted";
  }

  function normalize(history, dealers, flagsByUrl) {
    const out = [];
    for (const r of history) {
      out.push({
        type: "auction",
        date: r.sale_date || "",
        piece_name: r.piece_name || "(untitled)",
        category: r.category || "other",
        era_or_year: r.era_or_year || "",
        materials_gemstones: r.materials_gemstones || "",
        source: r.auction_house || "Unknown house",
        sale_name: r.sale_name || "",
        lot_number: r.lot_number || "",
        price_type: r.price_type || "",
        price: numOrNull(r.sold_price),
        estimate_low: numOrNull(r.estimate_low),
        estimate_high: numOrNull(r.estimate_high),
        currency: r.currency_note || "USD",
        status: auctionStatus(r),
        listing_url: r.listing_url || "",
        image_url: "",
        notes: r.notes || "",
        flags: flagsByUrl.get(r.listing_url) || [],
      });
    }
    for (const r of dealers) {
      out.push({
        type: "dealer",
        date: r.first_seen || "",
        piece_name: r.piece_name || "(untitled)",
        category: r.category || "other",
        era_or_year: r.era_or_year || "",
        materials_gemstones: r.materials_gemstones || "",
        source: r.dealer || "Unknown dealer",
        sale_name: "",
        lot_number: r.sku || "",
        price_type: r.price_type || "asking",
        price: numOrNull(r.asking_price),
        estimate_low: null,
        estimate_high: null,
        currency: r.currency_note || "USD",
        status: dealerStatus(r),
        listing_url: r.listing_url || "",
        image_url: r.image_url || "",
        notes: r.notes || "",
        flags: flagsByUrl.get(r.listing_url) || [],
      });
    }
    return out;
  }

  function buildFlagsByUrl(flagRecords) {
    const map = new Map();
    for (const f of flagRecords) {
      if (!f.url) continue;
      if (!map.has(f.url)) map.set(f.url, []);
      map.get(f.url).push(f);
    }
    return map;
  }

  function numOrNull(v) {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : null;
  }

  // --- Formatting --------------------------------------------------------

  function fmtMoney(n, currency) {
    if (n == null) return "—";
    try {
      return new Intl.NumberFormat("en-US", { style: "currency", currency: currency || "USD", maximumFractionDigits: 0 }).format(n);
    } catch (_) {
      return "$" + n.toLocaleString();
    }
  }

  function fmtEstimate(r) {
    if (r.estimate_low == null && r.estimate_high == null) return "—";
    if (r.estimate_low != null && r.estimate_high != null) {
      return `${fmtMoney(r.estimate_low, r.currency)}–${fmtMoney(r.estimate_high, r.currency)}`;
    }
    return fmtMoney(r.estimate_low ?? r.estimate_high, r.currency);
  }

  function badgeClass(status) {
    if (status === "Sold") return "badge-sold";
    if (status === "For sale") return "badge-forsale";
    if (status === "Delisted") return "badge-inactive";
    return "badge-unknown";
  }

  function flagSummary(flags) {
    return flags.map((f) => f.reason).join(" — ");
  }

  function escapeHtml(s) {
    return String(s || "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  // --- Filtering / sorting -------------------------------------------------

  function applyFilters() {
    const q = els.search.value.trim().toLowerCase();
    const type = els.filterType.value;
    const status = els.filterStatus.value;
    const source = els.filterSource.value;
    const category = els.filterCategory.value;
    const flaggedOnly = els.filterFlagged.checked;

    state.filtered = state.records.filter((r) => {
      if (type && r.type !== type) return false;
      if (status && r.status !== status) return false;
      if (source && r.source !== source) return false;
      if (category && r.category !== category) return false;
      if (flaggedOnly && !r.flags.length) return false;
      if (q) {
        const hay = `${r.piece_name} ${r.source} ${r.materials_gemstones} ${r.notes} ${r.lot_number} ${r.sale_name}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });

    sortFiltered();
    state.page = 1;
    renderStats();
    renderTable();
    renderPagination();
  }

  function sortFiltered() {
    const { sortKey, sortDir } = state;
    const dir = sortDir === "asc" ? 1 : -1;
    state.filtered.sort((a, b) => {
      let av, bv;
      if (sortKey === "estimate") {
        av = a.estimate_low ?? a.estimate_high ?? -1;
        bv = b.estimate_low ?? b.estimate_high ?? -1;
      } else if (sortKey === "price") {
        av = a.price ?? -1;
        bv = b.price ?? -1;
      } else {
        av = a[sortKey] ?? "";
        bv = b[sortKey] ?? "";
      }
      if (av < bv) return -1 * dir;
      if (av > bv) return 1 * dir;
      return 0;
    });
  }

  // --- Rendering -----------------------------------------------------------

  function renderStats() {
    const total = state.records.length;
    const auctionCount = state.records.filter((r) => r.type === "auction").length;
    const dealerCount = state.records.filter((r) => r.type === "dealer").length;
    const shown = state.filtered.length;
    const dates = state.records.map((r) => r.date).filter(Boolean).sort();
    const range = dates.length ? `${dates[0]} → ${dates[dates.length - 1]}` : "—";

    els.stats.innerHTML = [
      stat(total.toLocaleString(), "Total records"),
      stat(auctionCount.toLocaleString(), "Auction (historic)"),
      stat(dealerCount.toLocaleString(), "Dealer (current)"),
      stat(shown.toLocaleString(), "Matching filters"),
      stat(range, "Date range"),
    ].join("");
  }

  function stat(value, label) {
    return `<div class="stat"><div class="value">${escapeHtml(value)}</div><div class="label">${escapeHtml(label)}</div></div>`;
  }

  function renderTable() {
    const start = (state.page - 1) * PAGE_SIZE;
    const pageRows = state.filtered.slice(start, start + PAGE_SIZE);
    els.emptyState.hidden = pageRows.length > 0;
    els.table.hidden = pageRows.length === 0;

    els.body.innerHTML = pageRows
      .map((r, i) => {
        const idx = start + i;
        const sub = [r.category, r.materials_gemstones, r.era_or_year].filter(Boolean).join(" · ");
        const link = r.listing_url
          ? `<a class="listing-link" href="${escapeHtml(r.listing_url)}" target="_blank" rel="noopener" onclick="event.stopPropagation()">View ↗</a>`
          : "—";
        const thumb = r.image_url
          ? `<img class="piece-thumb" src="${escapeHtml(r.image_url)}" alt="" loading="lazy" onerror="this.remove()" />`
          : "";
        const flagBadge = r.flags.length
          ? `<span class="flag-badge" title="${escapeHtml(flagSummary(r.flags))}">⚑ Worth a look</span>`
          : "";
        return `<tr data-idx="${idx}">
          <td>${escapeHtml(r.date || "—")}<div class="type-tag">${r.type === "auction" ? "Auction" : "Dealer"}</div></td>
          <td><div class="piece-cell">${thumb}<div><span class="piece-name">${escapeHtml(r.piece_name)}</span>${sub ? `<span class="piece-sub">${escapeHtml(sub)}</span>` : ""}${flagBadge}</div></div></td>
          <td>${escapeHtml(r.source)}${r.sale_name ? `<div class="piece-sub">${escapeHtml(r.sale_name)}</div>` : ""}</td>
          <td class="num">${fmtMoney(r.price, r.currency)}</td>
          <td class="num">${fmtEstimate(r)}</td>
          <td><span class="badge ${badgeClass(r.status)}">${escapeHtml(r.status)}</span></td>
          <td>${link}</td>
        </tr>`;
      })
      .join("");

    for (const tr of els.body.querySelectorAll("tr")) {
      tr.addEventListener("click", () => openDetail(state.filtered[Number(tr.dataset.idx)]));
    }
  }

  function renderPagination() {
    const totalPages = Math.max(1, Math.ceil(state.filtered.length / PAGE_SIZE));
    if (state.page > totalPages) state.page = totalPages;
    els.pagination.innerHTML = `
      <button id="page-prev" ${state.page <= 1 ? "disabled" : ""}>← Prev</button>
      <span>Page ${state.page} of ${totalPages}</span>
      <button id="page-next" ${state.page >= totalPages ? "disabled" : ""}>Next →</button>
    `;
    document.getElementById("page-prev")?.addEventListener("click", () => {
      state.page = Math.max(1, state.page - 1);
      renderTable();
      renderPagination();
      window.scrollTo({ top: 0, behavior: "smooth" });
    });
    document.getElementById("page-next")?.addEventListener("click", () => {
      state.page = Math.min(totalPages, state.page + 1);
      renderTable();
      renderPagination();
      window.scrollTo({ top: 0, behavior: "smooth" });
    });
  }

  function renderSortIndicators() {
    for (const th of els.table.querySelectorAll("th.sortable")) {
      th.classList.toggle("active", th.dataset.sort === state.sortKey);
      th.querySelector(".arrow")?.remove();
      if (th.dataset.sort === state.sortKey) {
        const span = document.createElement("span");
        span.className = "arrow";
        span.textContent = state.sortDir === "asc" ? "▲" : "▼";
        th.appendChild(span);
      }
    }
  }

  function openDetail(r) {
    if (!r) return;
    els.modalTitle.textContent = r.piece_name;
    if (r.image_url) {
      els.modalImage.src = r.image_url;
      els.modalImage.hidden = false;
      els.modalImage.onerror = () => {
        els.modalImage.hidden = true;
      };
    } else {
      els.modalImage.hidden = true;
      els.modalImage.removeAttribute("src");
    }
    const fields = [
      ["Type", r.type === "auction" ? "Auction (historic sale)" : "Dealer (current listing)"],
      ["Listing", r.listing_url
        ? `<a class="listing-link" href="${escapeHtml(r.listing_url)}" target="_blank" rel="noopener">View original listing ↗</a>`
        : "—"],
      ["Date", r.date || "—"],
      ["Source", r.source],
      ["Sale", r.sale_name || "—"],
      ["Lot / SKU", r.lot_number || "—"],
      ["Category", r.category],
      ["Materials", r.materials_gemstones || "—"],
      ["Era / year", r.era_or_year || "—"],
      ["Price type", r.price_type || "—"],
      ["Price", fmtMoney(r.price, r.currency)],
      ["Estimate", fmtEstimate(r)],
      ["Status", r.status],
      ["Notes", r.notes || "—"],
    ];
    if (r.flags.length) {
      fields.splice(2, 0, [
        "Worth a second look",
        `<span class="flag-note">Heuristic signal, not a fraud determination.</span><ul class="flag-list">${r.flags
          .map((f) => `<li>${escapeHtml(f.reason)}</li>`)
          .join("")}</ul>`,
      ]);
    }
    els.modalBody.innerHTML = fields
      .map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd>${k === "Listing" || k === "Worth a second look" ? v : escapeHtml(v)}</dd>`)
      .join("");
    els.modal.hidden = false;
  }

  function closeDetail() {
    els.modal.hidden = true;
  }

  function populateFilterOptions() {
    const sources = [...new Set(state.records.map((r) => r.source))].sort();
    const categories = [...new Set(state.records.map((r) => r.category))].sort();
    const statuses = [...new Set(state.records.map((r) => r.status))].sort();

    for (const s of sources) els.filterSource.appendChild(new Option(s, s));
    for (const c of categories) els.filterCategory.appendChild(new Option(cap(c), c));
    for (const s of statuses) els.filterStatus.appendChild(new Option(s, s));
  }

  function cap(s) {
    return s.charAt(0).toUpperCase() + s.slice(1);
  }

  // --- Wiring ---------------------------------------------------------------

  function debounce(fn, ms) {
    let t;
    return (...args) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...args), ms);
    };
  }

  function wireEvents() {
    els.search.addEventListener("input", debounce(applyFilters, 150));
    els.filterType.addEventListener("change", applyFilters);
    els.filterStatus.addEventListener("change", applyFilters);
    els.filterSource.addEventListener("change", applyFilters);
    els.filterCategory.addEventListener("change", applyFilters);
    els.filterFlagged.addEventListener("change", applyFilters);
    els.clearFilters.addEventListener("click", () => {
      els.search.value = "";
      els.filterType.value = "";
      els.filterStatus.value = "";
      els.filterSource.value = "";
      els.filterCategory.value = "";
      els.filterFlagged.checked = false;
      applyFilters();
    });

    els.table.querySelectorAll("th.sortable").forEach((th) => {
      th.addEventListener("click", () => {
        const key = th.dataset.sort;
        if (state.sortKey === key) {
          state.sortDir = state.sortDir === "asc" ? "desc" : "asc";
        } else {
          state.sortKey = key;
          state.sortDir = key === "date" || key === "price" || key === "estimate" ? "desc" : "asc";
        }
        renderSortIndicators();
        sortFiltered();
        state.page = 1;
        renderTable();
        renderPagination();
      });
    });

    for (const el of els.modal.querySelectorAll("[data-close]")) {
      el.addEventListener("click", closeDetail);
    }
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") closeDetail();
    });
  }

  // --- Boot -----------------------------------------------------------------

  async function loadGeneratedAt() {
    try {
      const res = await fetch("data/generated-at.txt", { cache: "no-store" });
      if (!res.ok) return null;
      return (await res.text()).trim();
    } catch (_) {
      return null;
    }
  }

  async function boot() {
    const [history, dealers, flagRecords, generatedAt] = await Promise.all([
      loadJson("data/auction-history.json"),
      loadJson("data/dealer-listings.json"),
      loadJson("data/flagged-listings.json"),
      loadGeneratedAt(),
    ]);
    state.records = normalize(history, dealers, buildFlagsByUrl(flagRecords));
    populateFilterOptions();
    wireEvents();
    renderSortIndicators();
    applyFilters();

    if (!state.records.length) {
      els.lastUpdated.textContent = "No data found — has the weekly refresh run yet?";
    } else if (generatedAt) {
      els.lastUpdated.textContent = `Last updated ${new Date(generatedAt).toLocaleString()}`;
    } else {
      els.lastUpdated.textContent = `${state.records.length.toLocaleString()} records loaded`;
    }
  }

  boot();
})();
