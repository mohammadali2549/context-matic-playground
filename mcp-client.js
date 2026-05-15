#!/usr/bin/env node
/**
 * mcp-client.js
 * Hand-rolled MCP client + CORS proxy — zero npm dependencies.
 *
 * Usage:
 *   node mcp-client.js --target http://localhost:3000 [--port 8787]
 *
 * Then open http://localhost:8787 in your browser.
 *
 * The proxy sits at /proxy and forwards every request to --target,
 * injecting the necessary CORS headers so the browser never complains.
 *
 * Supports:
 *   • Streamable HTTP transport  (single POST endpoint)
 *   • Legacy SSE transport       (GET /sse  +  POST /message)
 */

const http  = require("http");
const https = require("https");
const url   = require("url");

// ─── CLI ─────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const get  = (flag) => { const i = args.indexOf(flag); return i !== -1 ? args[i + 1] : null; };
const TARGET_URL = get("--target") || "https://chatbotapi.apimatic.io/mcp/plugins";
const PORT       = parseInt(get("--port") || "8787", 10);

console.log(`\n  MCP Client`);
console.log(`  ──────────────────────────────`);
console.log(`  Proxy target : ${TARGET_URL}`);
console.log(`  Local UI     : http://localhost:${PORT}`);
console.log(`  Open the URL above in your browser.\n`);

// ─── CORS HEADERS ────────────────────────────────────────────────────────────
function setCORS(res, origin) {
  res.setHeader("Access-Control-Allow-Origin",  origin || "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS, DELETE, PUT, PATCH");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, Accept, Mcp-Session-Id, Last-Event-ID");
  res.setHeader("Access-Control-Expose-Headers","Mcp-Session-Id");
}

// ─── PROXY HANDLER ───────────────────────────────────────────────────────────
function proxy(req, res) {
  const origin  = req.headers["origin"] || "*";
  setCORS(res, origin);

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  // Strip the leading /proxy prefix to get the upstream path
  const upstreamPath = req.url.replace(/^\/proxy/, "") || "/";
  const target       = new url.URL(upstreamPath === "/" ? TARGET_URL : TARGET_URL + upstreamPath);

  const lib     = target.protocol === "https:" ? https : http;
  const options = {
    hostname: target.hostname,
    port:     target.port || (target.protocol === "https:" ? 443 : 80),
    path:     target.pathname + target.search,
    method:   req.method,
    headers:  {
      ...req.headers,
      host: target.host,
      // Don't forward the browser's origin — it would confuse some servers
      origin: target.origin,
    },
  };

  // ── SSE passthrough ────────────────────────────────────────────────────────
  if (req.headers["accept"] === "text/event-stream") {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection",    "keep-alive");
    res.writeHead(200);

    const upstream = lib.request(options, (uRes) => {
      // Forward any session id header
      const sid = uRes.headers["mcp-session-id"];
      if (sid) res.setHeader("Mcp-Session-Id", sid);
      uRes.pipe(res);
      uRes.on("error", () => res.end());
    });
    upstream.on("error", (e) => {
      res.write(`data: ${JSON.stringify({ error: e.message })}\n\n`);
      res.end();
    });
    req.pipe(upstream);
    req.on("close", () => upstream.destroy());
    return;
  }

  // ── Regular HTTP passthrough ───────────────────────────────────────────────
  const upstream = lib.request(options, (uRes) => {
    const sid = uRes.headers["mcp-session-id"];
    if (sid) res.setHeader("Mcp-Session-Id", sid);
    res.writeHead(uRes.statusCode, {
      "Content-Type": uRes.headers["content-type"] || "application/json",
    });
    uRes.pipe(res);
    uRes.on("error", () => res.end());
  });
  upstream.on("error", (e) => {
    res.writeHead(502, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Proxy error", detail: e.message }));
  });
  req.pipe(upstream);
}

// ─── HTML UI ─────────────────────────────────────────────────────────────────
const HTML = `<!doctype html><html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>ContextMatic Playground</title>
  <script src="https://cdn.tailwindcss.com/3.4.17"></\script>
  <script src="https://cdn.jsdelivr.net/npm/lucide@0.263.0/dist/umd/lucide.min.js"></\script>
  <link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;700&family=Space+Grotesk:wght@400;500;700&display=swap" rel="stylesheet">
  <script>
    tailwind.config = {
      theme: {
        extend: {
          fontFamily: {
            heading: ['Space Grotesk', 'sans-serif'],
            mono:    ['JetBrains Mono', 'monospace']
          }
        }
      }
    }
  </\script>
  <style>
    body { box-sizing: border-box; }
    .tool-column:hover  { border-color: #6366f1 !important; }
    .lang-card  { transition: border-color 0.2s, transform 0.15s; }
    .lang-card:hover  { border-color: #6366f1 !important; transform: translateY(-2px); }
    .api-card:hover   { border-color: #6366f1 !important; }
    .result-box { scrollbar-width: thin; scrollbar-color: #4b5563 #1f2937; }
    @keyframes pulse-dot { 0%,100% { opacity:1; } 50% { opacity:0.3; } }
    .loading-dot { animation: pulse-dot 1s infinite; }
    @keyframes spin { to { transform: rotate(360deg); } }
    .spinner { animation: spin 1s linear infinite; }
  </style>
</head>
<body class="min-h-screen bg-[#0d1117] text-gray-200 font-heading overflow-auto">
 <div class="w-full min-h-screen flex flex-col p-6 gap-6">

  <!-- Header -->
  <header class="flex flex-col items-center gap-3">
   <h1 id="page-title" class="text-3xl font-bold text-white tracking-tight">ContextMatic Playground</h1>
   <p class="text-gray-500 text-sm">Explore SDK-native API context with live MCP tool calls</p>
   <!-- Step indicator -->
   <div class="flex items-center gap-0 mt-1">
    <div id="si-1" class="flex flex-col items-center gap-1.5">
     <div id="sd-1" class="w-8 h-8 rounded-full border-2 flex items-center justify-center text-xs font-bold transition-all duration-300 border-indigo-500 bg-indigo-500 text-white">1</div>
     <span class="text-xs text-white">API</span>
    </div>
    <div id="sc-1" class="w-16 h-px mb-5 bg-gray-700 transition-all duration-300"></div>
    <div id="si-2" class="flex flex-col items-center gap-1.5">
     <div id="sd-2" class="w-8 h-8 rounded-full border-2 flex items-center justify-center text-xs font-bold transition-all duration-300 border-gray-700 bg-transparent text-gray-600">2</div>
     <span class="text-xs text-gray-600">Language</span>
    </div>
    <div id="sc-2" class="w-16 h-px mb-5 bg-gray-700 transition-all duration-300"></div>
    <div id="si-3" class="flex flex-col items-center gap-1.5">
     <div id="sd-3" class="w-8 h-8 rounded-full border-2 flex items-center justify-center text-xs font-bold transition-all duration-300 border-gray-700 bg-transparent text-gray-600">3</div>
     <span class="text-xs text-gray-600">Explore</span>
    </div>
   </div>
  </header>

  <!-- STEP 1: API Selection -->
  <div id="step-1" style="display:flex" class="flex-col items-center gap-6 flex-1">
   <div class="text-center">
    <h2 class="text-lg font-semibold text-white">Select an API</h2>
    <p class="text-gray-500 text-sm mt-1">Browse available SDK-native APIs</p>
   </div>
   <div id="api-grid" class="grid grid-cols-2 gap-4 w-full max-w-3xl"></div>
  </div>

  <!-- STEP 2: Language -->
  <div id="step-2" style="display:none" class="flex-col items-center gap-6 flex-1">
   <div class="flex items-center gap-3 w-full max-w-xl">
    <button onclick="goToStep(1)"
     class="flex items-center gap-1 text-gray-500 hover:text-gray-300 text-sm transition-colors">
     <i data-lucide="arrow-left" class="w-4 h-4"></i> Back
    </button>
    <div class="flex-1 text-center">
     <h2 class="text-lg font-semibold text-white">Choose a Language</h2>
     <p class="text-gray-500 text-sm mt-0.5">
      Showing SDKs for <span id="api-label" class="text-indigo-400 font-medium"></span>
     </p>
    </div>
    <div class="w-16"></div>
   </div>
   <div id="lang-grid" class="grid grid-cols-3 gap-4 w-full max-w-xl"></div>
  </div>

  <!-- STEP 3: Tools -->
  <div id="step-3" style="display:none" class="flex-col gap-4 flex-1">
   <!-- Context bar -->
   <div class="flex items-center justify-between bg-[#161b22] border border-gray-700/60 rounded-lg px-4 py-2.5">
    <div class="flex items-center gap-3">
     <button onclick="goToStep(1)"
      class="flex items-center gap-1 text-xs text-gray-500 hover:text-gray-300 transition-colors">
      <i data-lucide="arrow-left" class="w-3 h-3"></i> Change
     </button>
     <div class="flex items-center gap-2">
      <span id="ctx-lang" class="text-xs bg-[#0d1117] border border-gray-700 rounded px-2 py-0.5 text-indigo-400 font-mono"></span>
      <i data-lucide="chevron-right" class="w-3 h-3 text-gray-600"></i>
      <span id="ctx-api"  class="text-xs bg-[#0d1117] border border-gray-700 rounded px-2 py-0.5 text-emerald-400 font-mono"></span>
     </div>
    </div>
    <button onclick="goToStep(2)"
     class="flex items-center gap-1 text-xs text-gray-500 hover:text-gray-300 transition-colors">
     Switch Language <i data-lucide="repeat-2" class="w-3 h-3"></i>
    </button>
   </div>

   <!-- Three-column tool grid -->
   <div class="grid grid-cols-3 gap-4 flex-1">
    <!-- Ask -->
    <div class="tool-column flex flex-col bg-[#161b22] border border-gray-700/60 rounded-xl overflow-hidden transition-colors duration-200">
     <div class="flex items-center gap-2 px-4 py-3 border-b border-gray-700/60 bg-[#1c2128]">
      <i data-lucide="message-circle" class="w-4 h-4 text-emerald-400"></i>
      <span class="font-medium text-sm text-white">Ask</span>
      <code class="ml-auto text-[10px] text-gray-600 bg-[#0d1117] px-1.5 py-0.5 rounded font-mono">ask</code>
     </div>
     <div class="p-4 flex flex-col gap-3 flex-1">
      <textarea id="ask-input" rows="3"
       placeholder="e.g. How do I initialize the client?"
       class="w-full bg-[#0d1117] border border-gray-700 rounded-lg px-3 py-2 text-sm font-mono text-gray-200 placeholder-gray-500 outline-none focus:border-indigo-500 resize-none"></textarea>
      <button onclick="executeTool('ask')"
       class="self-start bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-medium px-4 py-2 rounded-md transition-colors flex items-center gap-2">
       <i data-lucide="send" class="w-3 h-3"></i> Ask
      </button>
      <div id="ask-result"
       class="result-box flex-1 min-h-[180px] bg-[#0d1117] border border-gray-800 rounded-lg p-3 text-xs font-mono text-gray-400 overflow-auto whitespace-pre-wrap">
       <span class="text-gray-600 italic">Ask any integration question...</span>
      </div>
     </div>
    </div>

    <!-- Model Search -->
    <div class="tool-column flex flex-col bg-[#161b22] border border-gray-700/60 rounded-xl overflow-hidden transition-colors duration-200">
     <div class="flex items-center gap-2 px-4 py-3 border-b border-gray-700/60 bg-[#1c2128]">
      <i data-lucide="box" class="w-4 h-4 text-amber-400"></i>
      <span class="font-medium text-sm text-white">Model Search</span>
      <code class="ml-auto text-[10px] text-gray-600 bg-[#0d1117] px-1.5 py-0.5 rounded font-mono">model_search</code>
     </div>
     <div class="p-4 flex flex-col gap-3 flex-1">
      <input id="model-input" type="text"
       placeholder="e.g. Customer, Invoice, Message..."
       class="w-full bg-[#0d1117] border border-gray-700 rounded-lg px-3 py-2 text-sm font-mono text-gray-200 placeholder-gray-500 outline-none focus:border-indigo-500">
      <button onclick="executeTool('model')"
       class="self-start bg-amber-600 hover:bg-amber-500 text-white text-xs font-medium px-4 py-2 rounded-md transition-colors flex items-center gap-2">
       <i data-lucide="search" class="w-3 h-3"></i> Search
      </button>
      <div id="model-result"
       class="result-box flex-1 min-h-[180px] bg-[#0d1117] border border-gray-800 rounded-lg p-3 text-xs font-mono text-gray-400 overflow-auto whitespace-pre-wrap">
       <span class="text-gray-600 italic">Search a model by name...</span>
      </div>
     </div>
    </div>

    <!-- Endpoint Search -->
    <div class="tool-column flex flex-col bg-[#161b22] border border-gray-700/60 rounded-xl overflow-hidden transition-colors duration-200">
     <div class="flex items-center gap-2 px-4 py-3 border-b border-gray-700/60 bg-[#1c2128]">
      <i data-lucide="globe" class="w-4 h-4 text-sky-400"></i>
      <span class="font-medium text-sm text-white">Endpoint Search</span>
      <code class="ml-auto text-[10px] text-gray-600 bg-[#0d1117] px-1.5 py-0.5 rounded font-mono">endpoint_search</code>
     </div>
     <div class="p-4 flex flex-col gap-3 flex-1">
      <input id="endpoint-input" type="text"
       placeholder="e.g. createMessage, listCustomers..."
       class="w-full bg-[#0d1117] border border-gray-700 rounded-lg px-3 py-2 text-sm font-mono text-gray-200 placeholder-gray-500 outline-none focus:border-indigo-500">
      <button onclick="executeTool('endpoint')"
       class="self-start bg-sky-600 hover:bg-sky-500 text-white text-xs font-medium px-4 py-2 rounded-md transition-colors flex items-center gap-2">
       <i data-lucide="search" class="w-3 h-3"></i> Search
      </button>
      <div id="endpoint-result"
       class="result-box flex-1 min-h-[180px] bg-[#0d1117] border border-gray-800 rounded-lg p-3 text-xs font-mono text-gray-400 overflow-auto whitespace-pre-wrap">
       <span class="text-gray-600 italic">Search an endpoint by method name...</span>
      </div>
     </div>
    </div>
   </div>
  </div>

 </div>

 <script>
  // MCP Configuration — routes through local CORS proxy
  const MCP_URL     = '/proxy';
  const MCP_HEADERS = {
    'Content-Type':          'application/json',
    'Accept':                'application/json, text/event-stream',
    'X-Apimatic-Mcp-Client': 'VsCode',
    'Authorization':         'Bearer PLAYGROUND_DEMO_TOKEN'
  };

  // State
  var langKey       = '';
  var langLabel     = '';
  var apiKey        = '';
  var apiName       = '';
  var availableApis = [];
  var apiLanguages  = {}; // apiKey -> [lang, ...]

  // MCP Session
  var mcpSessionId   = null;
  var mcpInitialized = false;
  var mcpInitPromise = null;

  function buildHeaders() {
    var h = Object.assign({}, MCP_HEADERS);
    if (mcpSessionId) h['Mcp-Session-Id'] = mcpSessionId;
    return h;
  }

  async function mcpInit() {
    const res = await fetch(MCP_URL, {
      method:  'POST',
      headers: MCP_HEADERS,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id:      1,
        method:  'initialize',
        params:  {
          protocolVersion: '2024-11-05',
          capabilities:    {},
          clientInfo:      { name: 'playground', version: '1.0.0' }
        }
      })
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error('MCP init failed ' + res.status + (body ? ': ' + body.slice(0, 200) : ''));
    }

    const sid = res.headers.get('Mcp-Session-Id');
    if (sid) mcpSessionId = sid;

    const ct = (res.headers.get('content-type') || '').toLowerCase();
    if (ct.includes('text/event-stream')) {
      await readSSERaw(res);
    } else {
      await res.json().catch(() => {});
    }

    // Send initialized notification
    await fetch(MCP_URL, {
      method:  'POST',
      headers: buildHeaders(),
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} })
    });

    mcpInitialized = true;
  }

  async function ensureInit() {
    if (mcpInitialized) return;
    if (!mcpInitPromise) mcpInitPromise = mcpInit().catch(function(e) { mcpInitPromise = null; throw e; });
    await mcpInitPromise;
  }

  async function mcpCall(toolName, args) {
    await ensureInit();
    const res = await fetch(MCP_URL, {
      method:  'POST',
      headers: buildHeaders(),
      body: JSON.stringify({
        jsonrpc: '2.0',
        id:      Date.now(),
        method:  'tools/call',
        params:  { name: toolName, arguments: args }
      })
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error('Server returned ' + res.status + (body ? ': ' + body.slice(0, 200) : ''));
    }

    const ct = (res.headers.get('content-type') || '').toLowerCase();
    if (ct.includes('text/event-stream')) return readSSE(res);
    const json = await res.json();
    return extractContent(json);
  }

  async function readSSERaw(response) {
    const reader = response.body.getReader();
    while (true) {
      const { done } = await reader.read();
      if (done) break;
    }
  }

  async function readSSE(response) {
    const reader  = response.body.getReader();
    const decoder = new TextDecoder();
    var buf    = '';
    var result = null;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\\n');
      buf = lines.pop();
      for (const line of lines) {
        if (!line.startsWith('data:')) continue;
        const raw = line.slice(5).trim();
        if (!raw || raw === '[DONE]') continue;
        try {
          const json = JSON.parse(raw);
          const c = extractContent(json);
          if (c !== null) result = c;
        } catch (e) { /* skip malformed */ }
      }
    }
    if (result === null) throw new Error('Empty response from server');
    return result;
  }

  function extractContent(rpc) {
    if (rpc.error) throw new Error(rpc.error.message || JSON.stringify(rpc.error));
    const content = rpc.result && rpc.result.content;
    if (Array.isArray(content)) return content.map(function(c) { return c.text || ''; }).join('\\n');
    if (rpc.result != null) return JSON.stringify(rpc.result, null, 2);
    return null;
  }

  // Navigation
  function goToStep(n) {
    [1, 2, 3].forEach(function(i) {
      document.getElementById('step-' + i).style.display = (i === n) ? 'flex' : 'none';
    });
    updateStepDots(n);
    lucide.createIcons();
  }

  function updateStepDots(active) {
    var CLS_DONE   = 'border-emerald-500 bg-emerald-500 text-white';
    var CLS_ACTIVE = 'border-indigo-500  bg-indigo-500  text-white';
    var CLS_IDLE   = 'border-gray-700   bg-transparent text-gray-600';
    var CHECK = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" class="w-4 h-4"><polyline points="20 6 9 17 4 12"/></svg>';
    var base  = 'w-8 h-8 rounded-full border-2 flex items-center justify-center text-xs font-bold transition-all duration-300 ';

    [1, 2, 3].forEach(function(i) {
      var dot  = document.getElementById('sd-' + i);
      var conn = document.getElementById('sc-' + i);
      var lbl  = dot.parentElement.querySelector('span');
      if (i < active) {
        dot.className = base + CLS_DONE;
        dot.innerHTML = CHECK;
        lbl.className = 'text-xs text-gray-400';
        if (conn) conn.className = 'w-16 h-px mb-5 transition-all duration-300 bg-emerald-500';
      } else if (i === active) {
        dot.className = base + CLS_ACTIVE;
        dot.innerHTML = i;
        lbl.className = 'text-xs text-white';
        if (conn) conn.className = 'w-16 h-px mb-5 transition-all duration-300 bg-gray-700';
      } else {
        dot.className = base + CLS_IDLE;
        dot.innerHTML = i;
        lbl.className = 'text-xs text-gray-600';
        if (conn) conn.className = 'w-16 h-px mb-5 transition-all duration-300 bg-gray-700';
      }
    });
  }

  // Step 2: Language
  function selectLanguage(key, label) {
    langKey   = key;
    langLabel = label;
    document.getElementById('ctx-lang').textContent = langLabel;
    document.getElementById('ctx-api').textContent  = apiName;
    ['ask', 'model', 'endpoint'].forEach(function(t) {
      document.getElementById(t + '-result').innerHTML = '<span class="text-gray-600 italic">Results will appear here...</span>';
      var inp = document.getElementById(t + '-input');
      if (inp) inp.value = '';
    });
    goToStep(3);
  }

  // Step 2: Load APIs
  var ALL_LANGUAGES = ['csharp', 'go', 'java', 'php', 'python', 'ruby', 'typescript'];

  async function loadApis() {
    var grid = document.getElementById('api-grid');

    function setProgress(done) {
      var pct = Math.round((done / ALL_LANGUAGES.length) * 100);
      grid.innerHTML =
        '<div class="col-span-2 flex flex-col items-center gap-4 py-16">' +
          '<div class="w-64 flex flex-col gap-2">' +
            '<p class="text-xs text-gray-500 font-mono">Loading APIs</p>' +
            '<div class="w-full h-2 bg-gray-800 rounded-full overflow-hidden">' +
              '<div class="h-full bg-indigo-500 rounded-full transition-all duration-300" style="width:' + pct + '%"></div>' +
            '</div>' +
          '</div>' +
        '</div>';
    }

    setProgress(0);

    try {
      // Server does not support concurrent requests — call sequentially
      var results = [];
      for (var li = 0; li < ALL_LANGUAGES.length; li++) {
        var currentLang = ALL_LANGUAGES[li];
        try {
          var text = await mcpCall('fetch_api', { language: currentLang, key: '' });
          results.push({ status: 'fulfilled', value: text });
        } catch (e) {
          results.push({ status: 'rejected', reason: e });
        }
        setProgress(li + 1);
      }

      // Merge and deduplicate by key; track languages per API
      var seen = {};
      var apis = [];
      apiLanguages = {};
      results.forEach(function(r, i) {
        if (r.status !== 'fulfilled') return;
        var lang = ALL_LANGUAGES[i];
        parseApiList(r.value).forEach(function(api) {
          if (!api.key) return;
          if (!apiLanguages[api.key]) apiLanguages[api.key] = [];
          apiLanguages[api.key].push(lang);
          if (!seen[api.key]) {
            seen[api.key] = true;
            apis.push(api);
          }
        });
      });

      if (!apis.length) {
        // Show per-language debug info to help diagnose the issue
        var debugRows = results.map(function(r, i) {
          var lang = ALL_LANGUAGES[i];
          if (r.status === 'rejected') {
            return '<tr><td class="pr-3 text-gray-500 font-mono">' + escHtml(lang) + '</td>' +
              '<td class="text-red-400">' + escHtml(r.reason && r.reason.message || String(r.reason)) + '</td></tr>';
          }
          var preview = String(r.value || '').slice(0, 120).replace(/\\n/g, ' ');
          return '<tr><td class="pr-3 text-gray-500 font-mono">' + escHtml(lang) + '</td>' +
            '<td class="text-yellow-400">' + escHtml(preview || '(empty)') + '</td></tr>';
        }).join('');
        grid.innerHTML =
          '<div class="col-span-2 flex flex-col gap-3 py-6">' +
            '<p class="text-yellow-400 text-sm text-center font-medium">No APIs could be parsed from server responses:</p>' +
            '<div class="result-box bg-[#0d1117] border border-gray-800 rounded-lg p-3 overflow-auto max-h-64">' +
              '<table class="text-xs font-mono w-full border-collapse"><tbody>' + debugRows + '</tbody></table>' +
            '</div>' +
            '<button onclick="loadApis()" class="self-center text-xs text-indigo-400 hover:text-indigo-300 underline">Retry</button>' +
          '</div>';
        return;
      }

      availableApis = apis;
      grid.innerHTML = apis.map(function(api, i) {
        return '<button onclick="selectApi(' + i + ')" class="api-card bg-[#161b22] border border-gray-700/60 rounded-xl p-5 text-left transition-colors duration-200 cursor-pointer">' +
          '<div class="flex items-start justify-between gap-2 mb-2">' +
            '<span class="font-semibold text-white text-sm">' + escHtml(api.name) + '</span>' +
            '<code class="text-[10px] bg-[#0d1117] border border-gray-700 rounded px-2 py-0.5 text-gray-500 font-mono shrink-0">' + escHtml(api.key) + '</code>' +
          '</div>' +
          '<p class="text-xs text-gray-500 leading-relaxed line-clamp-3">' + escHtml(api.description) + '</p>' +
        '</button>';
      }).join('');

      lucide.createIcons();
    } catch (err) {
      grid.innerHTML =
        '<div class="col-span-2 flex flex-col items-center gap-2 py-16">' +
          '<i data-lucide="alert-circle" class="w-6 h-6 text-red-400"></i>' +
          '<p class="text-red-400 text-sm font-medium">Failed to load APIs</p>' +
          '<p class="text-gray-600 text-xs">' + escHtml(err.message) + '</p>' +
          '<button onclick="loadApis()" class="mt-2 text-xs text-indigo-400 hover:text-indigo-300 underline">Retry</button>' +
        '</div>';
      lucide.createIcons();
    }
  }

  function parseApiList(text) {
    try {
      var json = JSON.parse(text);
      var arr  = Array.isArray(json) ? json : (json.apis || json.data || json.results || []);
      if (arr.length) return arr.map(normalizeEntry);
    } catch (e) { /* not JSON */ }

    var apis  = [];
    var lines = text.split('\\n');

    for (var li = 0; li < lines.length; li++) {
      var line = lines[li].trim();
      if (!line) continue;

      if (line.startsWith('|') && !/^\\|[-: |]+\\|$/.test(line)) {
        var cols = line.split('|').map(function(c) { return c.trim(); }).filter(Boolean);
        if (cols.length >= 3) {
          var n = stripMd(cols[0]);
          var k = stripMd(cols[1]).toLowerCase().replace(/\\s+/g, '-');
          if (n && k && n.toLowerCase() !== 'name' && n.toLowerCase() !== 'api') {
            apis.push({ name: n, key: k, description: stripMd(cols[2]) });
          }
        }
        continue;
      }

      var m = line.match(/^[-*]\\s+\\*{0,2}([^*(]+?)\\*{0,2}\\s*\\(?key\\s*[:=]\\s*[\\x60'"]?([a-z0-9_-]+)[\\x60'"]?\\)?\\s*[:\\-\\u2013]\\s*(.*)/i);
      if (m) { apis.push({ name: m[1].trim(), key: m[2].trim(), description: m[3].trim() }); continue; }

      m = line.match(/^[-*]\\s+\\*{0,2}([^*(]+?)\\*{0,2}\\s*\\(([a-z0-9_-]+)\\)\\s*[:\\-\\u2013]\\s*(.*)/);
      if (m) { apis.push({ name: m[1].trim(), key: m[2].trim(), description: m[3].trim() }); continue; }

      m = line.match(/^\\*{0,2}([A-Z][^(*\\n]{2,40}?)\\*{0,2}\\s*\\(([a-z0-9_-]+)\\)\\s*[:\\-\\u2013]\\s*(.*)/);
      if (m) { apis.push({ name: m[1].trim(), key: m[2].trim(), description: m[3].trim() }); }
    }

    return apis;
  }

  function normalizeEntry(e) {
    return {
      name:        e.name        || e.api_name || e.title || '',
      key:         e.key         || e.api_key  || e.id    || '',
      description: e.description || e.desc     || ''
    };
  }

  function stripMd(s) {
    return String(s)
      .replace(/\\*{1,2}([^*]+)\\*{1,2}/g, '$1')
      .replace(/\\x60([^\\x60]+)\\x60/g, '$1')
      .trim();
  }

  var LANG_META = {
    typescript: { label: 'TypeScript', abbr: 'TS',  color: 'blue'   },
    python:     { label: 'Python',     abbr: 'Py',  color: 'yellow' },
    csharp:     { label: 'C#',         abbr: 'C#',  color: 'purple' },
    java:       { label: 'Java',       abbr: 'Ja',  color: 'orange' },
    php:        { label: 'PHP',        abbr: 'PHP', color: 'indigo' },
    ruby:       { label: 'Ruby',       abbr: 'Rb',  color: 'red'    },
    go:         { label: 'Go',         abbr: 'Go',  color: 'cyan'   }
  };

  function selectApi(index) {
    var api  = availableApis[index];
    apiKey   = api.key;
    apiName  = api.name;
    document.getElementById('api-label').textContent = apiName;

    var langs = (apiLanguages[apiKey] || ALL_LANGUAGES).slice();
    // preserve display order from ALL_LANGUAGES
    langs.sort(function(a, b) { return ALL_LANGUAGES.indexOf(a) - ALL_LANGUAGES.indexOf(b); });

    var grid = document.getElementById('lang-grid');
    grid.innerHTML = langs.map(function(lang) {
      var m = LANG_META[lang] || { label: lang, abbr: lang, color: 'gray' };
      return '<button onclick="selectLanguage(\\'' + lang + '\\',\\'' + m.label + '\\')"' +
        ' class="lang-card bg-[#161b22] border border-gray-700/60 rounded-xl p-6 flex flex-col items-center gap-3 cursor-pointer">' +
        '<div class="w-12 h-12 rounded-lg bg-' + m.color + '-500/10 flex items-center justify-center">' +
          '<span class="text-' + m.color + '-400 text-xl font-bold font-mono">' + escHtml(m.abbr) + '</span>' +
        '</div>' +
        '<span class="text-white font-medium text-sm">' + escHtml(m.label) + '</span>' +
        '</button>';
    }).join('');

    goToStep(2);
  }

  // Step 3: Tool Execution
  var TOOL_CONFIG = {
    ask:      { input: 'ask-input',      result: 'ask-result',      mcp: 'ask',           buildArgs: function(q) { return { language: langKey, key: apiKey, query: q }; } },
    model:    { input: 'model-input',    result: 'model-result',    mcp: 'model_search',  buildArgs: function(q) { return { language: langKey, key: apiKey, query: q }; } },
    endpoint: { input: 'endpoint-input', result: 'endpoint-result', mcp: 'endpoint_search',buildArgs: function(q) { return { language: langKey, key: apiKey, query: q }; } }
  };

  async function executeTool(tool) {
    var cfg      = TOOL_CONFIG[tool];
    var inputEl  = document.getElementById(cfg.input);
    var resultEl = document.getElementById(cfg.result);
    var query    = inputEl.value.trim();

    if (!query) {
      resultEl.innerHTML = '<span class="text-red-400">Please enter a query first.</span>';
      return;
    }

    resultEl.innerHTML =
      '<span class="loading-dot text-indigo-400">&#9679;</span> <span class="text-gray-500">Calling MCP server...</span>';

    try {
      var text = await mcpCall(cfg.mcp, cfg.buildArgs(query));
      resultEl.innerHTML =
        '<span class="text-gray-600">// ' + escHtml(apiKey) + ' &#x2192; ' + escHtml(cfg.mcp) + '</span>\\n\\n' +
        escHtml(text);
    } catch (err) {
      resultEl.innerHTML = '<span class="text-red-400">Error: ' + escHtml(err.message) + '</span>';
    }
  }

  function escHtml(s) {
    return String(s)
      .replace(/&/g,  '&amp;')
      .replace(/</g,  '&lt;')
      .replace(/>/g,  '&gt;')
      .replace(/"/g,  '&quot;')
      .replace(/'/g,  '&#039;');
  }

  loadApis();
  goToStep(1);
 </script>
</body>
</html>`;


// ─── HTTP SERVER ──────────────────────────────────────────────────────────────
const PAGE = HTML;

const server = http.createServer((req, res) => {
  const origin = req.headers["origin"] || "*";

  // CORS preflight for everything
  // CORS preflight for everything
  if (req.method === "OPTIONS") {
    setCORS(res, origin);
    res.writeHead(204);
    res.end();
    return;
  }

  // Serve the UI
  if (req.url === "/" || req.url === "/index.html") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(PAGE);
    return;
  }

  // CORS proxy
  if (req.url.startsWith("/proxy")) {
    proxy(req, res);
    return;
  }

  res.writeHead(404);
  res.end("Not found");
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`  Ready → http://localhost:${PORT}\n`);
});

server.on("error", (e) => {
  if (e.code === "EADDRINUSE") {
    console.error(`  ✖  Port ${PORT} is in use. Try --port 9090`);
  } else {
    console.error("  ✖ ", e.message);
  }
  process.exit(1);
});