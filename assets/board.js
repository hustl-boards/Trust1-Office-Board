/* Trust 1 Services office TV board. board-version: 20261030a
   One interval drives the clock, the town rotation, and weather refresh.
   Weather retries on failure and keeps the last good reading.
   The page reloads about every six hours, and only while online. */
(function () {
  if (window.__trust1BoardStarted) return;
  window.__trust1BoardStarted = true;

  var VERSION = "20261030a";
  var TICK_MS = 500;
  var RELOAD_MS = 6 * 60 * 60 * 1000;
  var WEATHER_MS = 12 * 60 * 1000;
  var WEATHER_TIMEOUT_MS = 8000;
  var TOWN_MS = 22000;
  var WATCHDOG_MS = 8000;
  var SVG_NS = "http://www.w3.org/2000/svg";
  var WEATHER_KEY = "trust1-board-weather";
  var RELOAD_KEY = "trust1-board-reloads";

  var TOWNS = [
    { id: "quincy", name: "Quincy", lat: 42.2529, lon: -71.0023 },
    { id: "hanover", name: "Hanover", lat: 42.1132, lon: -70.8120 }
  ];

  var DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  var WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  var MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  var DIRS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
  var KINDS = ["clear", "clear-night", "partly", "partly-night", "cloudy", "fog", "rain", "snow", "storm"];

  var freeze = query("freeze") === "1";
  var demoMode = query("demo");
  var featured = query("town") === "hanover" ? 1 : 0;
  var booted = Date.now();
  var timer = null;
  var watchdog = null;
  var listening = false;
  var failures = 0;
  var gaveUp = false;
  var reloading = false;
  var lastClockKey = "";
  var reduceMotion = false;
  var viewScale = 1;

  var stage = null;
  var timeNode = null;
  var dateNode = null;
  var tempNode = null;
  var degNode = null;
  var condNode = null;
  var feelsNode = null;
  var windNode = null;
  var humNode = null;
  var hiloNode = null;
  var heroIcon = null;
  var hourlyLabel = null;
  var hourNodes = [];
  var dayNodes = [];
  var townNodes = [];
  var miniNodes = {};

  var state = null;
  var weatherBusy = false;
  var weatherStarted = 0;
  var nextWeatherAt = 0;
  var weatherAbort = null;
  var weatherToken = 0;
  var weatherFinished = false;
  var weatherRetry = 0;
  var nextTownAt = 0;

  var precipCanvas = null;
  var precipCtx = null;
  var drops = [];
  var rafId = 0;
  var animHold = false;
  var wakeLock = null;
  var lastWakeRequest = 0;
  var logoBackup = null;

  try {
    reduceMotion = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch (err) {
    reduceMotion = false;
  }

  function query(name) {
    var parts = location.search.length > 1 ? location.search.substring(1).split("&") : [];
    var n;
    for (n = 0; n < parts.length; n++) {
      var pair = parts[n].split("=");
      var key = decodeURIComponent(pair[0] || "");
      if (key === name) return decodeURIComponent((pair[1] || "").replace(/\+/g, " "));
    }
    return "";
  }

  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text) node.textContent = text;
    return node;
  }

  function setText(node, text) {
    if (node && node.textContent !== text) node.textContent = text;
  }

  function pad2(n) {
    return n < 10 ? "0" + n : "" + n;
  }

  function isNum(v) {
    return typeof v === "number" && isFinite(v);
  }

  function nthSunday(year, month, n) {
    var first = new Date(Date.UTC(year, month, 1));
    var day = first.getUTCDay();
    return 1 + ((7 - day) % 7) + (n - 1) * 7;
  }

  function isEasternDST(utcMs) {
    var y = new Date(utcMs).getUTCFullYear();
    var start = Date.UTC(y, 2, nthSunday(y, 2, 2), 7, 0, 0);
    var end = Date.UTC(y, 10, nthSunday(y, 10, 1), 6, 0, 0);
    return utcMs >= start && utcMs < end;
  }

  function easternParts(now) {
    var utc = now.getTime();
    var dst = isEasternDST(utc);
    var shifted = new Date(utc + (dst ? -4 : -5) * 3600000);
    return {
      year: shifted.getUTCFullYear(),
      month: shifted.getUTCMonth(),
      date: shifted.getUTCDate(),
      day: shifted.getUTCDay(),
      hour: shifted.getUTCHours(),
      minute: shifted.getUTCMinutes()
    };
  }

  function dateIso(p) {
    return p.year + "-" + pad2(p.month + 1) + "-" + pad2(p.date);
  }

  function hourKey(p) {
    return dateIso(p) + "T" + pad2(p.hour);
  }

  function formatHour(hour) {
    var h = hour % 12;
    if (h === 0) h = 12;
    return h + " " + (hour >= 12 ? "PM" : "AM");
  }

  function addDays(iso, days) {
    var parts = iso.split("-");
    var t = Date.UTC(+parts[0], +parts[1] - 1, +parts[2] + days);
    var d = new Date(t);
    return d.getUTCFullYear() + "-" + pad2(d.getUTCMonth() + 1) + "-" + pad2(d.getUTCDate());
  }

  function weekdayFromIso(iso) {
    var parts = String(iso || "").split("-");
    if (parts.length !== 3) return "";
    var t = Date.UTC(+parts[0], +parts[1] - 1, +parts[2]);
    if (!isFinite(t)) return "";
    return WEEKDAYS[new Date(t).getUTCDay()];
  }

  function family(code) {
    if (code === 0) return "clear";
    if (code === 1 || code === 2) return "partly";
    if (code === 3) return "cloudy";
    if (code === 45 || code === 48) return "fog";
    if (code >= 95) return "storm";
    if ((code >= 71 && code <= 77) || code === 85 || code === 86) return "snow";
    if ((code >= 51 && code <= 67) || (code >= 80 && code <= 82)) return "rain";
    return "cloudy";
  }

  function iconKind(code, isDay) {
    var fam = family(code);
    if (!isDay && (fam === "clear" || fam === "partly")) return fam + "-night";
    return fam;
  }

  function skyName(code, isDay) {
    return family(code) + (isDay ? "-day" : "-night");
  }

  function phraseFor(code, isDay) {
    if (code === 0) return isDay ? "Clear" : "Clear night";
    if (code === 1) return "Mainly clear";
    if (code === 2) return "Partly cloudy";
    if (code === 3) return "Overcast";
    if (code === 45 || code === 48) return "Fog";
    if (code === 51) return "Light drizzle";
    if (code === 53) return "Drizzle";
    if (code === 55) return "Heavy drizzle";
    if (code === 56 || code === 57) return "Freezing drizzle";
    if (code === 61 || code === 80) return "Light rain";
    if (code === 63 || code === 81) return "Rain";
    if (code === 65 || code === 82) return "Heavy rain";
    if (code === 66 || code === 67) return "Freezing rain";
    if (code === 71 || code === 85) return "Light snow";
    if (code === 73 || code === 77) return "Snow";
    if (code === 75 || code === 86) return "Heavy snow";
    if (code >= 95) return "Thunderstorm";
    return "Cloudy";
  }

  function cardinal(deg) {
    if (!isNum(deg)) return "";
    var i = Math.round(deg / 45) % 8;
    if (i < 0) i += 8;
    return DIRS[i];
  }

  function svgRoot(cls) {
    var svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("viewBox", "0 0 64 64");
    svg.setAttribute("class", cls);
    svg.setAttribute("aria-hidden", "true");
    return svg;
  }

  function stroke(svg, d) {
    var p = document.createElementNS(SVG_NS, "path");
    p.setAttribute("d", d);
    p.setAttribute("fill", "none");
    p.setAttribute("stroke", "currentColor");
    p.setAttribute("stroke-width", "2.6");
    p.setAttribute("stroke-linecap", "round");
    p.setAttribute("stroke-linejoin", "round");
    svg.appendChild(p);
  }

  function fillPath(svg, d, evenodd) {
    var p = document.createElementNS(SVG_NS, "path");
    p.setAttribute("d", d);
    p.setAttribute("fill", "currentColor");
    p.setAttribute("stroke", "none");
    if (evenodd) p.setAttribute("fill-rule", "evenodd");
    svg.appendChild(p);
  }

  function circle(svg, cx, cy, r, filled) {
    var c = document.createElementNS(SVG_NS, "circle");
    c.setAttribute("cx", cx);
    c.setAttribute("cy", cy);
    c.setAttribute("r", r);
    if (filled) {
      c.setAttribute("fill", "currentColor");
      c.setAttribute("stroke", "none");
    } else {
      c.setAttribute("fill", "none");
      c.setAttribute("stroke", "currentColor");
      c.setAttribute("stroke-width", "2.6");
    }
    svg.appendChild(c);
  }

  var CLOUD = "M12 40h32a10 10 0 0 0 1.2-19.7A14 14 0 0 0 18 24 9 9 0 0 0 12 40z";

  function drawIcon(kind) {
    var svg = svgRoot("k-" + kind);
    if (kind === "clear") {
      circle(svg, 32, 32, 8, true);
      stroke(svg, "M32 7v7M32 50v7M7 32h7M50 32h7M14 14l5 5M45 45l5 5M50 14l-5 5M19 45l-5 5");
    } else if (kind === "clear-night") {
      fillPath(svg, "M14 32a14 14 0 1 0 28 0 14 14 0 1 0-28 0zm20-11a11 11 0 1 1 0 22 11 11 0 1 1 0-22z", true);
      fillPath(svg, "M48 14l1.4 3.2 3.4.4-2.6 2.3.7 3.4L48 21.6 45.1 23.3l.7-3.4-2.6-2.3 3.4-.4z");
    } else if (kind === "partly") {
      circle(svg, 46, 16, 5, true);
      stroke(svg, "M46 5v3.5M46 23.5V27M35 16h3.5M53.5 16H57M38.2 8.2l2.4 2.4M51.4 21.4l2.4 2.4M53.8 8.2l-2.4 2.4M40.6 21.4l-2.4 2.4");
      fillPath(svg, "M8 46h30a9 9 0 0 0 1-17.6A13 13 0 0 0 14 32a8 8 0 0 0-6 14z");
    } else if (kind === "partly-night") {
      fillPath(svg, "M40 8a8 8 0 1 0 16 0 8 8 0 1 0-16 0zm10-6a6 6 0 1 1 0 12 6 6 0 1 1 0-12z", true);
      fillPath(svg, "M8 46h30a9 9 0 0 0 1-17.6A13 13 0 0 0 14 32a8 8 0 0 0-6 14z");
    } else if (kind === "cloudy") {
      fillPath(svg, "M8 42h36a12 12 0 0 0 1.4-23.8A17 17 0 0 0 16 24 11 11 0 0 0 8 42z");
    } else if (kind === "fog") {
      fillPath(svg, "M8 36h36a12 12 0 0 0 1.4-23.8A17 17 0 0 0 16 18 11 11 0 0 0 8 36z");
      stroke(svg, "M10 48h44M14 56h36");
    } else if (kind === "rain") {
      fillPath(svg, CLOUD);
      stroke(svg, "M22 48v8M32 50v9M42 48v8");
    } else if (kind === "snow") {
      fillPath(svg, CLOUD);
      circle(svg, 22, 52, 2.3, true);
      circle(svg, 32, 58, 2.3, true);
      circle(svg, 42, 52, 2.3, true);
    } else if (kind === "storm") {
      fillPath(svg, "M8 36h32a10 10 0 0 0 1-19.6A15 15 0 0 0 14 20 9 9 0 0 0 8 36z");
      fillPath(svg, "M36 30h-7l3-12H24l10 16h-6l8 14 2-12h8z");
    }
    return svg;
  }

  function makeIcons() {
    var wrap = el("div", "ico");
    var i;
    for (i = 0; i < KINDS.length; i++) wrap.appendChild(drawIcon(KINDS[i]));
    return wrap;
  }

  function buildStrips() {
    var hourly = document.getElementById("hourly");
    var daily = document.getElementById("daily");
    var i;
    var cell;
    var icon;
    hourNodes = [];
    dayNodes = [];
    for (i = 0; i < 12; i++) {
      cell = el("div", i === 0 ? "hour is-now" : "hour");
      cell.appendChild(el("div", "hour-label", "–"));
      icon = makeIcons();
      cell.appendChild(icon);
      cell.appendChild(el("div", "hour-temp", "–"));
      hourly.appendChild(cell);
      hourNodes.push(cell);
    }
    for (i = 0; i < 5; i++) {
      cell = el("div", "day");
      cell.appendChild(el("div", "day-label", "–"));
      icon = makeIcons();
      cell.appendChild(icon);
      cell.appendChild(el("div", "day-hi", "–"));
      cell.appendChild(el("div", "day-lo", "–"));
      daily.appendChild(cell);
      dayNodes.push(cell);
    }
    heroIcon = document.getElementById("wx-ico");
    if (heroIcon) {
      var icons = makeIcons();
      while (icons.firstChild) heroIcon.appendChild(icons.firstChild);
    }
  }

  function dotField(node, count, size, span, twin) {
    if (!node) return;
    var parts = [];
    var i;
    var x;
    var y;
    var a;
    var bit;
    for (i = 0; i < count; i++) {
      x = Math.round(Math.random() * 1920);
      y = Math.round(Math.random() * span);
      a = (0.4 + Math.random() * 0.6).toFixed(2);
      bit = x + "px " + y + "px 0 " + size + "px rgba(255,255,255," + a + ")";
      parts.push(bit);
      if (twin) parts.push(x + "px " + (y - span) + "px 0 " + size + "px rgba(255,255,255," + a + ")");
    }
    node.style.boxShadow = parts.join(",");
  }

  function buildFields() {
    dotField(document.getElementById("stars-a"), 46, 0, 780, false);
    dotField(document.getElementById("stars-b"), 22, 1, 640, false);
    dotField(document.getElementById("snow-a"), 34, 1, 1080, true);
    dotField(document.getElementById("snow-b"), 24, 2, 1080, true);
    dotField(document.getElementById("snow-c"), 20, 0, 1080, true);
  }

  function initDrops() {
    var i;
    drops = [];
    for (i = 0; i < 80; i++) {
      drops.push({
        x: Math.random() * 1920,
        y: Math.random() * 1080,
        len: 16 + Math.random() * 22,
        vy: 14 + Math.random() * 12,
        vx: -2.4 - Math.random() * 1.6,
        bright: Math.random() > 0.72
      });
    }
  }

  function resizeCanvas() {
    if (!precipCanvas) return;
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    var w = Math.round(1920 * viewScale * dpr);
    var h = Math.round(1080 * viewScale * dpr);
    if (w < 640) w = 640;
    if (h < 360) h = 360;
    if (w > 3840) w = 3840;
    if (h > 2160) h = 2160;
    if (precipCanvas.width === w && precipCanvas.height === h && precipCtx) return;
    precipCanvas.width = w;
    precipCanvas.height = h;
    precipCtx = precipCanvas.getContext("2d");
  }

  function prepCanvas() {
    if (!precipCtx || !precipCanvas) return false;
    precipCtx.setTransform(precipCanvas.width / 1920, 0, 0, precipCanvas.height / 1080, 0, 0);
    precipCtx.clearRect(0, 0, 1920, 1080);
    return true;
  }

  function drawRain() {
    if (!prepCanvas()) return;
    var skyNow = stage ? (stage.getAttribute("data-sky") || "") : "";
    var fast = skyNow.indexOf("storm") === 0;
    var speed = fast ? 1.55 : 1;
    var i;
    var d;
    var ctx = precipCtx;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.strokeStyle = "rgba(214,228,240,0.45)";
    ctx.lineWidth = 1.4;
    for (i = 0; i < drops.length; i++) {
      d = drops[i];
      if (d.bright) continue;
      d.y += d.vy * speed;
      d.x += d.vx * speed;
      if (d.y > 1120) {
        d.y = -30;
        d.x = Math.random() * 1920;
      }
      if (d.x < -40) d.x = 1960;
      ctx.moveTo(d.x, d.y);
      ctx.lineTo(d.x + d.vx * 2.2, d.y + d.len);
    }
    ctx.stroke();
    ctx.beginPath();
    ctx.strokeStyle = "rgba(236,244,250,0.8)";
    ctx.lineWidth = 1.8;
    for (i = 0; i < drops.length; i++) {
      d = drops[i];
      if (!d.bright) continue;
      d.y += d.vy * speed;
      d.x += d.vx * speed;
      if (d.y > 1120) {
        d.y = -30;
        d.x = Math.random() * 1920;
      }
      if (d.x < -40) d.x = 1960;
      ctx.moveTo(d.x, d.y);
      ctx.lineTo(d.x + d.vx * 2.4, d.y + d.len + 8);
    }
    ctx.stroke();
  }

  function skyNeedsRain() {
    if (!stage) return false;
    var sky = stage.getAttribute("data-sky") || "";
    return sky.indexOf("rain") === 0 || sky.indexOf("storm") === 0;
  }

  function frame() {
    if (animHold || !skyNeedsRain() || reduceMotion) {
      rafId = 0;
      return;
    }
    rafId = requestAnimationFrame(frame);
    drawRain();
  }

  function syncAnim() {
    var need = skyNeedsRain() && !reduceMotion && !animHold;
    if (need && !rafId) rafId = requestAnimationFrame(frame);
    if (!need && precipCtx) prepCanvas();
  }

  function armLogo() {
    var img = document.getElementById("logo");
    var brand = document.querySelector(".brand");
    if (!img) return;
    logoBackup = new Image();
    logoBackup.src = "assets/trust1-logo.png?v=20261030a";
    img.addEventListener("error", function onErr() {
      img.removeEventListener("error", onErr);
      if (img.getAttribute("data-fallback") === "1") {
        img.style.display = "none";
        if (brand) brand.classList.add("logo-failed");
        return;
      }
      img.setAttribute("data-fallback", "1");
      img.addEventListener("error", onErr);
      img.src = "assets/trust1-logo.png?v=20261030a";
    });
    if (img.complete && img.naturalWidth === 0) {
      try { img.dispatchEvent(new Event("error")); } catch (err) {}
    }
  }

  function updateClock() {
    var p = easternParts(new Date());
    var key = p.year + "-" + p.month + "-" + p.date + "-" + p.hour + "-" + p.minute;
    if (key === lastClockKey) return;
    var h = p.hour % 12;
    if (h === 0) h = 12;
    var timeText = h + ":" + pad2(p.minute) + " " + (p.hour >= 12 ? "PM" : "AM");
    var dateText = DAYS[p.day] + ", " + MONTHS[p.month] + " " + p.date;
    lastClockKey = key;
    setText(timeNode, timeText);
    setText(dateNode, dateText);
  }

  function fit() {
    if (!stage) return;
    var s = Math.min(window.innerWidth / 1920, window.innerHeight / 1080);
    if (!isFinite(s) || s <= 0) s = 1;
    viewScale = s;
    stage.style.transform = "scale(" + s + ")";
    resizeCanvas();
  }

  function isOnline() {
    return typeof navigator === "undefined" || navigator.onLine !== false;
  }

  function stopAnim() {
    animHold = true;
    if (rafId) {
      cancelAnimationFrame(rafId);
      rafId = 0;
    }
  }

  function cleanup() {
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
    clearWatchdog();
    stopAnim();
    if (weatherAbort) {
      try { weatherAbort.abort(); } catch (err) {}
      weatherAbort = null;
    }
    weatherToken += 1;
    weatherFinished = true;
    weatherBusy = false;
    if (wakeLock) {
      try { wakeLock.release(); } catch (err2) {}
      wakeLock = null;
    }
    if (listening) {
      window.removeEventListener("resize", fit);
      window.removeEventListener("error", onWindowError);
      window.removeEventListener("unhandledrejection", noteFailure);
      document.removeEventListener("visibilitychange", onVisibility);
      listening = false;
    }
  }

  function safeReload() {
    if (reloading) return;
    if (!isOnline()) return;
    reloading = true;
    cleanup();
    location.reload();
  }

  function clearWatchdog() {
    if (watchdog !== null) {
      clearTimeout(watchdog);
      watchdog = null;
    }
  }

  function armWatchdog() {
    clearWatchdog();
    if (freeze || gaveUp || reloading || animHold) return;
    if (document.visibilityState === "hidden") return;
    watchdog = setTimeout(function () {
      watchdog = null;
      if (gaveUp || reloading || freeze || document.visibilityState === "hidden") return;
      noteFailure();
    }, WATCHDOG_MS);
  }

  function onWindowError(event) {
    var target = event && event.target;
    if (target && target !== window && target.nodeType === 1) return;
    noteFailure();
  }

  function stormList() {
    try {
      var now = Date.now();
      var raw = sessionStorage.getItem(RELOAD_KEY) || "[]";
      var list = JSON.parse(raw);
      if (!list || !list.length) return [];
      var kept = [];
      var n;
      for (n = 0; n < list.length; n++) {
        if (now - list[n] < 120000) kept.push(list[n]);
      }
      return kept;
    } catch (err) {
      return [];
    }
  }

  function tooManyReloads() {
    return stormList().length >= 3;
  }

  function markReload() {
    try {
      var list = stormList();
      list.push(Date.now());
      sessionStorage.setItem(RELOAD_KEY, JSON.stringify(list));
    } catch (err) {}
  }

  function noteFailure() {
    failures += 1;
    if (failures < 3) {
      armWatchdog();
      return;
    }
    if (tooManyReloads()) {
      gaveUp = true;
      clearWatchdog();
      return;
    }
    markReload();
    safeReload();
  }

  function onVisibility() {
    if (document.visibilityState === "hidden") {
      animHold = true;
      if (rafId) {
        cancelAnimationFrame(rafId);
        rafId = 0;
      }
      clearWatchdog();
      return;
    }
    animHold = false;
    syncAnim();
    armWatchdog();
    requestWake();
  }

  function requestWake() {
    var now = Date.now();
    if (reloading || document.visibilityState === "hidden") return;
    if (!navigator.wakeLock || !navigator.wakeLock.request) return;
    if (now - lastWakeRequest < 15000) return;
    lastWakeRequest = now;
    navigator.wakeLock.request("screen").then(function (lock) {
      if (reloading) {
        try { lock.release(); } catch (err) {}
        return;
      }
      wakeLock = lock;
      lock.addEventListener("release", function () {
        if (wakeLock === lock) wakeLock = null;
        if (!reloading && document.visibilityState === "visible") requestWake();
      });
    }).catch(function () {});
  }

  function weatherUrl(town) {
    return "https://api.open-meteo.com/v1/forecast?latitude=" + town.lat +
      "&longitude=" + town.lon +
      "&current=temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m,wind_direction_10m,is_day" +
      "&hourly=temperature_2m,weather_code,is_day" +
      "&daily=weather_code,temperature_2m_max,temperature_2m_min" +
      "&temperature_unit=fahrenheit&wind_speed_unit=mph&timezone=America%2FNew_York&forecast_days=5&forecast_hours=36";
  }

  function validSlot(item, withLo) {
    if (!item || typeof item.label !== "string" || !item.label) return false;
    if (typeof item.kind !== "string" || !item.kind) return false;
    if (withLo) return isNum(item.hi) && isNum(item.lo);
    return isNum(item.temp);
  }

  function validTown(t) {
    if (!t) return false;
    if (!isNum(t.temp) || !isNum(t.feels) || !isNum(t.wind) || !isNum(t.humidity)) return false;
    if (!isNum(t.hi) || !isNum(t.lo) || !isNum(t.code)) return false;
    if (t.isDay !== 0 && t.isDay !== 1) return false;
    if (typeof t.phrase !== "string" || !t.phrase) return false;
    if (typeof t.kind !== "string" || !t.kind) return false;
    if (typeof t.sky !== "string" || !t.sky) return false;
    if (typeof t.dir !== "string") return false;
    if (!t.hours || t.hours.length !== 12 || !t.days || t.days.length !== 5) return false;
    var i;
    for (i = 0; i < 12; i++) if (!validSlot(t.hours[i], false)) return false;
    for (i = 0; i < 5; i++) if (!validSlot(t.days[i], true)) return false;
    return true;
  }

  function validState(data) {
    if (!data || data.v !== 1) return false;
    var ok = false;
    if (data.quincy) {
      if (!validTown(data.quincy)) return false;
      ok = true;
    }
    if (data.hanover) {
      if (!validTown(data.hanover)) return false;
      ok = true;
    }
    return ok;
  }

  function packTown(json) {
    var cur = json && json.current;
    var hourly = json && json.hourly;
    var daily = json && json.daily;
    if (!cur || !hourly || !daily) return null;
    if (!hourly.time || !hourly.temperature_2m || !hourly.weather_code) return null;
    if (!daily.time || !daily.temperature_2m_max || !daily.temperature_2m_min || !daily.weather_code) return null;
    var temp = Math.round(Number(cur.temperature_2m));
    var feels = Math.round(Number(cur.apparent_temperature));
    var wind = Math.round(Number(cur.wind_speed_10m));
    var humidity = Math.round(Number(cur.relative_humidity_2m));
    var code = Number(cur.weather_code);
    var isDay = Number(cur.is_day) === 1 ? 1 : 0;
    if (!isNum(temp) || !isNum(feels) || !isNum(wind) || !isNum(humidity) || !isNum(code)) return null;
    var nowParts = easternParts(new Date());
    var key = hourKey(nowParts);
    var today = dateIso(nowParts);
    var idx = -1;
    var n;
    for (n = 0; n < hourly.time.length; n++) {
      if (String(hourly.time[n]).substring(0, 13) === key) {
        idx = n;
        break;
      }
    }
    if (idx < 0) idx = 0;
    if (idx + 12 > hourly.time.length) return null;
    var hours = [];
    for (n = 0; n < 12; n++) {
      var at = idx + n;
      var stamp = String(hourly.time[at]);
      var hTemp = Math.round(Number(hourly.temperature_2m[at]));
      var hCode = Number(hourly.weather_code[at]);
      var hDay = 1;
      if (n === 0) hDay = isDay;
      else if (hourly.is_day && hourly.is_day.length > at) hDay = Number(hourly.is_day[at]) === 1 ? 1 : 0;
      else {
        var hh = parseInt(stamp.substring(11, 13), 10);
        hDay = hh >= 6 && hh < 19 ? 1 : 0;
      }
      if (!isNum(hTemp) || !isNum(hCode)) return null;
      hours.push({
        label: n === 0 ? "Now" : formatHour(parseInt(stamp.substring(11, 13), 10)),
        temp: hTemp,
        kind: iconKind(hCode, hDay)
      });
    }
    if (daily.time.length < 5) return null;
    var days = [];
    var hi0 = null;
    var lo0 = null;
    for (n = 0; n < 5; n++) {
      var iso = String(daily.time[n]);
      var hi = Math.round(Number(daily.temperature_2m_max[n]));
      var lo = Math.round(Number(daily.temperature_2m_min[n]));
      var dCode = Number(daily.weather_code[n]);
      if (!iso || !isNum(hi) || !isNum(lo) || !isNum(dCode)) return null;
      if (n === 0) {
        hi0 = hi;
        lo0 = lo;
      }
      days.push({
        label: iso === today ? "Today" : weekdayFromIso(iso),
        hi: hi,
        lo: lo,
        kind: iconKind(dCode, 1)
      });
    }
    if (!days[0].label) return null;
    return {
      temp: temp,
      feels: feels,
      wind: wind,
      humidity: humidity,
      code: code,
      isDay: isDay,
      hi: hi0,
      lo: lo0,
      dir: cardinal(Number(cur.wind_direction_10m)),
      phrase: phraseFor(code, isDay),
      kind: iconKind(code, isDay),
      sky: skyName(code, isDay),
      hours: hours,
      days: days
    };
  }

  function readCache() {
    try {
      var data = JSON.parse(localStorage.getItem(WEATHER_KEY) || "null");
      if (!validState(data)) {
        try { localStorage.removeItem(WEATHER_KEY); } catch (err) {}
        return null;
      }
      return data;
    } catch (err2) {
      return null;
    }
  }

  function saveState(data) {
    try {
      localStorage.setItem(WEATHER_KEY, JSON.stringify(data));
    } catch (err) {}
  }

  function setKind(node, kind) {
    if (!node) return;
    if (node.getAttribute("data-kind") !== kind) node.setAttribute("data-kind", kind);
  }

  function markTown(index) {
    if (townNodes[0]) townNodes[0].classList.toggle("is-on", index === 0);
    if (townNodes[1]) townNodes[1].classList.toggle("is-on", index === 1);
  }

  function paint() {
    var q = state && validTown(state.quincy) ? state.quincy : null;
    var h = state && validTown(state.hanover) ? state.hanover : null;
    if (featured === 1 && !h && q) featured = 0;
    if (featured === 0 && !q && h) featured = 1;
    var town = featured === 1 ? h : q;
    markTown(featured);
    setText(miniNodes.quincy, q ? q.temp + "\u00b0" : "");
    setText(miniNodes.hanover, h ? h.temp + "\u00b0" : "");
    if (!town) return;
    setText(tempNode, String(town.temp));
    if (degNode) degNode.hidden = false;
    setText(condNode, town.phrase);
    setKind(heroIcon, town.kind);
    setText(feelsNode, town.feels + "\u00b0");
    setText(windNode, town.wind + " mph" + (town.dir ? " " + town.dir : ""));
    setText(humNode, town.humidity + "%");
    setText(hiloNode, town.hi + "\u00b0 / " + town.lo + "\u00b0");
    setText(hourlyLabel, "Next 12 hours  \u00b7  " + (featured === 1 ? "Hanover" : "Quincy"));
    if (stage && stage.getAttribute("data-sky") !== town.sky) stage.setAttribute("data-sky", town.sky);
    var i;
    for (i = 0; i < 12; i++) {
      var hour = town.hours[i];
      var cell = hourNodes[i];
      if (!cell || !hour) continue;
      setText(cell.getElementsByClassName("hour-label")[0], hour.label);
      setText(cell.getElementsByClassName("hour-temp")[0], hour.temp + "\u00b0");
      setKind(cell.getElementsByClassName("ico")[0], hour.kind);
    }
    for (i = 0; i < 5; i++) {
      var day = town.days[i];
      var dayCell = dayNodes[i];
      if (!dayCell || !day) continue;
      setText(dayCell.getElementsByClassName("day-label")[0], day.label);
      setText(dayCell.getElementsByClassName("day-hi")[0], day.hi + "\u00b0");
      setText(dayCell.getElementsByClassName("day-lo")[0], day.lo + "\u00b0");
      setKind(dayCell.getElementsByClassName("ico")[0], day.kind);
    }
    syncAnim();
  }

  function pulse() {
    if (!stage || reduceMotion) return;
    stage.classList.remove("is-swap");
    void stage.offsetWidth;
    stage.classList.add("is-swap");
  }

  function showTown(index) {
    if (index === featured) return;
    var next = state && (index === 1 ? state.hanover : state.quincy);
    if (!validTown(next)) return;
    featured = index;
    paint();
    pulse();
  }

  function rotateTown() {
    if (freeze || !state) return;
    showTown(featured === 0 ? 1 : 0);
  }

  function scheduleWeather(ok, partial) {
    var now = Date.now();
    if (ok) {
      weatherRetry = 0;
      nextWeatherAt = now + WEATHER_MS;
      return;
    }
    weatherRetry += 1;
    if (partial && weatherRetry >= 3) {
      nextWeatherAt = now + WEATHER_MS;
      weatherRetry = 0;
      return;
    }
    var shift = weatherRetry - 1;
    if (shift > 3) shift = 3;
    if (shift < 0) shift = 0;
    nextWeatherAt = now + (20000 * Math.pow(2, shift));
  }

  function finishWeather(token, ok, partial) {
    if (token !== weatherToken || weatherFinished) return;
    weatherFinished = true;
    weatherBusy = false;
    weatherAbort = null;
    scheduleWeather(ok, partial);
  }

  function refreshWeather() {
    if (weatherBusy || reloading || demoMode) return;
    var now = Date.now();
    if (typeof fetch !== "function" || typeof AbortController !== "function") {
      nextWeatherAt = now + WEATHER_MS;
      return;
    }
    weatherBusy = true;
    weatherFinished = false;
    weatherStarted = now;
    weatherToken += 1;
    var token = weatherToken;
    var controller = new AbortController();
    weatherAbort = controller;
    var incoming = { quincy: null, hanover: null };
    var got = 0;
    var failed = 0;
    function settle() {
      if (token !== weatherToken || weatherFinished) return;
      if (got + failed < 2) return;
      var merged = {
        v: 1,
        quincy: incoming.quincy || (state && state.quincy) || null,
        hanover: incoming.hanover || (state && state.hanover) || null
      };
      if (got > 0 && validState(merged)) {
        state = merged;
        saveState(state);
        try { paint(); } catch (err) {}
        finishWeather(token, failed === 0, failed > 0);
        return;
      }
      finishWeather(token, false, false);
    }
    var n;
    for (n = 0; n < TOWNS.length; n++) {
      (function (town) {
        fetch(weatherUrl(town), { signal: controller.signal, cache: "no-store" })
          .then(function (res) {
            if (!res || !res.ok) throw new Error("wx");
            return res.json();
          })
          .then(function (json) {
            if (token !== weatherToken) return;
            var packed = packTown(json);
            if (!validTown(packed)) throw new Error("wx");
            incoming[town.id] = packed;
            got += 1;
            settle();
          })
          .catch(function () {
            if (token !== weatherToken) return;
            failed += 1;
            settle();
          });
      })(TOWNS[n]);
    }
  }

  function demoSpec(mode) {
    var table = {
      "clear-day": { code: 0, isDay: 1, temp: 72, feels: 70, wind: 8, dir: "SW", humidity: 46, hi: 76, lo: 54 },
      "clear-night": { code: 0, isDay: 0, temp: 48, feels: 44, wind: 6, dir: "W", humidity: 62, hi: 61, lo: 44 },
      "partly-day": { code: 2, isDay: 1, temp: 66, feels: 64, wind: 11, dir: "NW", humidity: 52, hi: 70, lo: 49 },
      "cloudy-day": { code: 3, isDay: 1, temp: 58, feels: 55, wind: 9, dir: "E", humidity: 70, hi: 61, lo: 47 },
      "fog-day": { code: 45, isDay: 1, temp: 52, feels: 50, wind: 3, dir: "SE", humidity: 94, hi: 56, lo: 46 },
      "rain-day": { code: 63, isDay: 1, temp: 55, feels: 51, wind: 13, dir: "NE", humidity: 88, hi: 58, lo: 47 },
      "rain-night": { code: 63, isDay: 0, temp: 51, feels: 46, wind: 15, dir: "NE", humidity: 91, hi: 57, lo: 46 },
      "snow-day": { code: 73, isDay: 1, temp: 30, feels: 22, wind: 12, dir: "N", humidity: 78, hi: 34, lo: 24 },
      "snow-night": { code: 71, isDay: 0, temp: 27, feels: 18, wind: 10, dir: "NW", humidity: 80, hi: 33, lo: 22 },
      "storm-day": { code: 95, isDay: 1, temp: 68, feels: 66, wind: 22, dir: "S", humidity: 84, hi: 74, lo: 60 },
      "storm-night": { code: 95, isDay: 0, temp: 64, feels: 62, wind: 24, dir: "SW", humidity: 86, hi: 71, lo: 58 }
    };
    return table[mode] || null;
  }

  function buildDemo(spec, shift) {
    var p = easternParts(new Date());
    var today = dateIso(p);
    var hours = [];
    var days = [];
    var i;
    for (i = 0; i < 12; i++) {
      var hour = (p.hour + i) % 24;
      var isDay = spec.isDay;
      hours.push({
        label: i === 0 ? "Now" : formatHour(hour),
        temp: spec.temp + shift - i,
        kind: iconKind(spec.code, isDay)
      });
    }
    var dayCodes = [spec.code, spec.code, spec.code === 0 ? 2 : spec.code, 3, spec.code];
    for (i = 0; i < 5; i++) {
      var iso = addDays(today, i);
      days.push({
        label: i === 0 ? "Today" : weekdayFromIso(iso),
        hi: spec.hi + shift - i,
        lo: spec.lo + shift - i,
        kind: iconKind(dayCodes[i], 1)
      });
    }
    return {
      temp: spec.temp + shift,
      feels: spec.feels + shift,
      wind: spec.wind,
      humidity: spec.humidity,
      code: spec.code,
      isDay: spec.isDay,
      hi: spec.hi + shift,
      lo: spec.lo + shift,
      dir: spec.dir,
      phrase: phraseFor(spec.code, spec.isDay),
      kind: iconKind(spec.code, spec.isDay),
      sky: skyName(spec.code, spec.isDay),
      hours: hours,
      days: days
    };
  }

  function loadDemo() {
    var spec = demoSpec(demoMode);
    if (!spec) {
      demoMode = "";
      return false;
    }
    state = { v: 1, quincy: buildDemo(spec, 0), hanover: buildDemo(spec, -3) };
    paint();
    return true;
  }

  function tick() {
    if (gaveUp) {
      try { updateClock(); } catch (err) {}
      return;
    }
    try {
      var now = Date.now();
      updateClock();
      if (!freeze && state && now >= nextTownAt) {
        nextTownAt = now + TOWN_MS;
        rotateTown();
      }
      if (weatherBusy && weatherAbort && now - weatherStarted >= WEATHER_TIMEOUT_MS) {
        try { weatherAbort.abort(); } catch (abortErr) {}
      }
      if (weatherBusy && now - weatherStarted >= WEATHER_TIMEOUT_MS + 2000) {
        finishWeather(weatherToken, false, false);
      }
      if (!demoMode && !weatherBusy && now >= nextWeatherAt) refreshWeather();
      if (!freeze && now - booted >= RELOAD_MS && isOnline()) {
        safeReload();
        return;
      }
      armWatchdog();
    } catch (err) {
      noteFailure();
    }
  }

  function boot() {
    stage = document.getElementById("stage");
    timeNode = document.getElementById("clock-time");
    dateNode = document.getElementById("clock-date");
    tempNode = document.getElementById("wx-temp");
    degNode = document.getElementById("wx-deg");
    condNode = document.getElementById("wx-cond");
    feelsNode = document.getElementById("wx-feels");
    windNode = document.getElementById("wx-wind");
    humNode = document.getElementById("wx-hum");
    hiloNode = document.getElementById("wx-hilo");
    hourlyLabel = document.getElementById("hourly-label");
    townNodes = [
      document.getElementById("town-quincy"),
      document.getElementById("town-hanover")
    ];
    miniNodes = {
      quincy: document.getElementById("mini-quincy"),
      hanover: document.getElementById("mini-hanover")
    };
    precipCanvas = document.getElementById("precip");
    buildStrips();
    buildFields();
    initDrops();
    armLogo();
    fit();
    updateClock();
    nextTownAt = Date.now() + TOWN_MS;
    if (!loadDemo()) {
      try { state = readCache(); } catch (err) { state = null; }
      try { paint(); } catch (err2) {}
      try { refreshWeather(); } catch (err3) {}
    }
    if (timer === null) timer = setInterval(tick, TICK_MS);
    if (!listening) {
      window.addEventListener("resize", fit);
      window.addEventListener("error", onWindowError);
      window.addEventListener("unhandledrejection", noteFailure);
      document.addEventListener("visibilitychange", onVisibility);
      listening = true;
    }
    requestWake();
    armWatchdog();
    syncAnim();
    window.__trust1Board = {
      version: VERSION,
      reloadMs: RELOAD_MS,
      weatherMs: WEATHER_MS,
      get sky() { return stage ? stage.getAttribute("data-sky") : ""; },
      get town() { return featured === 1 ? "hanover" : "quincy"; },
      get errors() { return failures; },
      get nodes() { return document.getElementsByTagName("*").length; },
      get state() { return state; }
    };
  }

  try {
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
    else boot();
  } catch (err) {
    noteFailure();
  }
})();
