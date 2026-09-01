/*
 * CONTENT WORKER
 *
 * Beta = scraper
 *
 * KV:
 *   BETA_KV  -> Beta, TTL 6h
 *
 * Variables:
 *   API_KEY
 *   SOURCE_URL
 *
 * Bindings:
 *   BETA_KV
 */

const BETA_CACHE_TTL  = 6 * 60 * 60;

const BLACKLIST = [
  "servidortrinity",
  "servidormahoutokoro",
  "servidordeathstar",
  "servidorgoldmember",
  "powvideo",
  "streamplay"
];

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization"
};

export default {
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS });
    }

    if (request.method !== "GET") {
      return jsonResponse({
        success: false,
        status: "method_not_allowed",
        event: "complete"
      }, 405);
    }

    try {
      return await router(request, env, ctx);
    } catch (err) {
      console.error(err);
      return jsonResponse({
        success: false,
        status: "worker_error",
        event: "complete",
        error: err?.message || String(err)
      }, 500);
    }
  }
};

async function router(request, env, ctx) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "");

  if (path === "/health") {
    return jsonResponse({
      success: true,
      status: "online",
      event: "complete"
    });
  }

  if (!authorized(request, env)) {
    return jsonResponse({
      success: false,
      status: "unauthorized",
      event: "complete",
      message: "API key inválida o ausente."
    }, 401);
  }

  const force = isTrue(url.searchParams.get("force"));

  let match = path.match(/^\/play\/movie\/(\d+)$/);
  if (match) {
    return processContent({
      env, ctx,
      tmdbId: match[1],
      type: "movie",
      season: 0,
      episode: 0,
      force
    });
  }

  match = path.match(/^\/play\/tv\/(\d+)\/(\d+)\/(\d+)$/);
  if (match) {
    return processContent({
      env, ctx,
      tmdbId: match[1],
      type: "tv",
      season: Number(match[2]),
      episode: Number(match[3]),
      force
    });
  }

  return jsonResponse({
    success: false,
    status: "not_found",
    event: "complete"
  }, 404);
}

function authorized(request, env) {
  if (!env.API_KEY) return false;

  const auth = request.headers.get("Authorization") || "";
  const match = auth.match(/^Bearer\s+(.+)$/i);

  return !!match && match[1].trim() === env.API_KEY;
}

async function processContent({
  env,
  ctx,
  tmdbId,
  type,
  season,
  episode,
  force
}) {
  const { writer, response } = createSSE();

  await sendSSE(writer, "connected", {
    success: true,
    status: "connected",
    mode: "beta",
    source: "Beta",
    tmdb_id: tmdbId,
    type,
    season,
    episode
  });

  await runBeta({
    env,
    ctx,
    writer,
    tmdbId,
    type,
    season,
    episode,
    force
  });

  writer.close();
  return response;
}

/*
 * Ejecuta Beta usando BETA_KV antes del scraper.
 */
async function runBeta({
  env,
  ctx,
  writer,
  tmdbId,
  type,
  season,
  episode,
  force
}) {
  const betaKey = buildBetaCacheKey(
    type, tmdbId, season, episode
  );

  let beta = null;
  let betaCacheStatus = "miss";

  if (!force && env.BETA_KV) {
    const cached = await env.BETA_KV.get(betaKey, "json");

    if (cached && Array.isArray(cached.links)) {
      const links = deduplicateLinks(
        cached.links.filter(isValidLink)
      );

      if (links.length > 0) {
        betaCacheStatus = "hit";

        await sendSSE(writer, "beta_cache_hit", {
          success: true,
          status: "beta_cache_hit",
          source: "Beta",
          found: links.length,
          ttl_seconds: BETA_CACHE_TTL
        });

        beta = {
          success: true,
          links,
          elapsed_ms: 0,
          error: null,
          mode: "kv"
        };
      }
    }
  }

  if (!beta) {
    await sendSSE(writer, "beta_cache_miss", {
      success: true,
      status: "beta_cache_miss",
      source: "Beta",
      force,
      message: force
        ? "force=true: se ignora BETA_KV."
        : env.BETA_KV
          ? "No existe un resultado válido en BETA_KV."
          : "BETA_KV no está configurado."
    });

    await sendSSE(writer, "beta_search", {
      success: true,
      status: "searching_beta",
      source: "Beta"
    });

    beta = await scrapeBeta({
      env,
      tmdbId,
      type,
      season,
      episode
    });

    const links = beta.success
      ? deduplicateLinks(beta.links.filter(isValidLink))
      : [];

    beta.links = links;

    /*
     * Solo se cachean resultados positivos.
     * Los resultados vacíos no se almacenan durante 6h.
     */
    if (env.BETA_KV && links.length > 0) {
      ctx.waitUntil(
        env.BETA_KV.put(
          betaKey,
          JSON.stringify({
            links,
            cached_at: Date.now()
          }),
          { expirationTtl: BETA_CACHE_TTL }
        )
      );
    }
  }

  const betaLinks = deduplicateLinks(
    (beta.links || []).filter(isValidLink)
  );

  await sendSSE(writer, "beta_found", {
    success: betaLinks.length > 0,
    status: betaLinks.length > 0
      ? "beta_found"
      : "beta_unavailable",
    source: "Beta",
    found: betaLinks.length,
    links: betaLinks,
    cache: betaCacheStatus,
    http_code: beta.http_code ?? null,
    content_type: beta.content_type ?? null,
    elapsed_ms: beta.elapsed_ms ?? null,
    parser: beta.parser ?? null,
    raw_keys: beta.raw_keys ?? [],
    all_embeds_languages: beta.all_embeds_languages ?? [],
    all_embeds_urls: beta.all_embeds_urls ?? 0,
    all_embeds_valid: beta.all_embeds_valid ?? 0,
    all_embeds_discarded: beta.all_embeds_discarded ?? 0,
    embeds_urls: beta.embeds_urls ?? 0,
    embeds_valid: beta.embeds_valid ?? 0,
    embeds_discarded: beta.embeds_discarded ?? 0,
    error: beta.error ?? null
  });

  await sendSSE(writer, "complete", {
    success: betaLinks.length > 0,
    status: betaLinks.length > 0
      ? "success"
      : "source_unavailable",
    event: "complete",
    source: "Beta",
    fallback: null,
    tmdb_id: tmdbId,
    type,
    season,
    episode,
    beta_found: betaLinks.length,
    beta_queried: true,
    found: betaLinks.length,
    links: betaLinks,
    beta_cache: betaCacheStatus,
    beta_error: beta.error ?? null
  });

  return betaLinks;
}

/*
 * ==================================================================
 * BETA / SCRAPER
 * ==================================================================
 *
 * Conserva /embed/api.php como slug principal.
 */

async function scrapeBeta({
  env,
  tmdbId,
  type,
  season,
  episode
}) {
  const started = Date.now();

  if (!env.SOURCE_URL) {
    return failure(
      "not_configured",
      "SOURCE_URL no está configurado.",
      started
    );
  }

  const base = env.SOURCE_URL.replace(/\/+$/, "");
  const params = new URLSearchParams();

  params.set("action", "details");
  params.set("id", tmdbId);
  params.set("type", type);

  if (type === "tv") {
    params.set("season", String(season));
    params.set("episode", String(episode));
  }

  const endpoint =
    `${base}/embed/api.php?${params.toString()}`;

  let response;

  try {
    response = await fetch(endpoint, {
      method: "GET",
      redirect: "follow",
      headers: {
        "Accept": "application/json,text/plain,*/*",
        "Accept-Language": "es-ES,es;q=0.9,en;q=0.8",
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
          "AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36"
      }
    });
  } catch (err) {
    return failure(
      "request_error",
      err?.message || String(err),
      started
    );
  }

  const contentType =
    response.headers.get("content-type") || "";

  const text = await response.text();

  let data;

  try {
    data = JSON.parse(text);
  } catch {
    return {
      success: false,
      status: "invalid_json",
      links: [],
      http_code: response.status,
      content_type: contentType,
      elapsed_ms: Date.now() - started,
      raw_keys: [],
      parser: null,
      error: response.ok
        ? "Beta devolvió una respuesta que no es JSON."
        : `Beta respondió HTTP ${response.status}.`
    };
  }

  if (!response.ok) {
    return {
      success: false,
      status: "http_error",
      links: [],
      http_code: response.status,
      content_type: contentType,
      elapsed_ms: Date.now() - started,
      raw_keys: objectKeys(data),
      parser: null,
      error: extractErrorMessage(data)
    };
  }

  const rawKeys = objectKeys(data);

  if (
    data?.all_embeds &&
    typeof data.all_embeds === "object" &&
    !Array.isArray(data.all_embeds)
  ) {
    const diagnostics = countAllEmbeds(data.all_embeds);
    const links = extractAllEmbeds(data.all_embeds);

    if (links.length > 0) {
      return {
        success: true,
        status: "links_found",
        links,
        http_code: response.status,
        content_type: contentType,
        elapsed_ms: Date.now() - started,
        parser: "all_embeds",
        raw_keys: rawKeys,
        ...diagnostics
      };
    }
  }

  if (
    data?.embeds &&
    typeof data.embeds === "object" &&
    !Array.isArray(data.embeds)
  ) {
    const diagnostics = countEmbeds(data.embeds);
    const links = extractEmbedsFallback(
      data.embeds,
      normalizeLanguage(data.language || "latino")
    );

    if (links.length > 0) {
      return {
        success: true,
        status: "links_found",
        links,
        http_code: response.status,
        content_type: contentType,
        elapsed_ms: Date.now() - started,
        parser: "embeds",
        raw_keys: rawKeys,
        ...diagnostics
      };
    }

    return {
      success: false,
      status: "no_embeds",
      links: [],
      http_code: response.status,
      content_type: contentType,
      elapsed_ms: Date.now() - started,
      parser: "embeds",
      raw_keys: rawKeys,
      ...diagnostics,
      error: "Beta respondió JSON pero no quedaron URLs válidas."
    };
  }

  return {
    success: false,
    status: "no_embeds",
    links: [],
    http_code: response.status,
    content_type: contentType,
    elapsed_ms: Date.now() - started,
    parser: null,
    raw_keys: rawKeys,
    all_embeds_languages: [],
    all_embeds_urls: 0,
    all_embeds_valid: 0,
    all_embeds_discarded: 0,
    embeds_urls: 0,
    embeds_valid: 0,
    embeds_discarded: 0,
    error: "Beta devolvió JSON pero no contiene all_embeds ni embeds."
  };
}

/*
 * ==================================================================
 * EXTRACCIÓN / NORMALIZACIÓN
 * ==================================================================
 */

function extractAllEmbeds(allEmbeds) {
  const result = [];

  for (const [language, servers] of Object.entries(allEmbeds)) {
    if (
      !servers ||
      typeof servers !== "object" ||
      Array.isArray(servers)
    ) continue;

    const idioma = normalizeLanguage(language);

    for (const [serverName, values] of Object.entries(servers)) {
      if (isBlacklisted(serverName)) continue;

      const urls = Array.isArray(values)
        ? values
        : typeof values === "string"
          ? [values]
          : [];

      for (const url of urls) {
        if (!isHttpUrl(url)) continue;

        result.push({
          url_embed: url,
          servidor: normalizeServerName(serverName),
          idioma
        });
      }
    }
  }

  return deduplicateLinks(result);
}

function extractEmbedsFallback(embeds, idioma) {
  const result = [];

  for (const [serverName, values] of Object.entries(embeds)) {
    if (isBlacklisted(serverName)) continue;

    const urls = Array.isArray(values)
      ? values
      : typeof values === "string"
        ? [values]
        : [];

    for (const url of urls) {
      if (!isHttpUrl(url)) continue;

      result.push({
        url_embed: url,
        servidor: normalizeServerName(serverName),
        idioma
      });
    }
  }

  return deduplicateLinks(result);
}

function countAllEmbeds(allEmbeds) {
  let urls = 0;
  let valid = 0;
  let discarded = 0;
  const languages = [];

  for (const [language, servers] of Object.entries(allEmbeds)) {
    languages.push(language);

    if (
      !servers ||
      typeof servers !== "object" ||
      Array.isArray(servers)
    ) continue;

    for (const [serverName, values] of Object.entries(servers)) {
      const list = Array.isArray(values)
        ? values
        : typeof values === "string"
          ? [values]
          : [];

      for (const url of list) {
        urls++;

        if (
          isHttpUrl(url) &&
          !isBlacklisted(serverName)
        ) valid++;
        else discarded++;
      }
    }
  }

  return {
    all_embeds_languages: languages,
    all_embeds_urls: urls,
    all_embeds_valid: valid,
    all_embeds_discarded: discarded
  };
}

function countEmbeds(embeds) {
  let urls = 0;
  let valid = 0;
  let discarded = 0;

  for (const [serverName, values] of Object.entries(embeds)) {
    const list = Array.isArray(values)
      ? values
      : typeof values === "string"
        ? [values]
        : [];

    for (const url of list) {
      urls++;

      if (
        isHttpUrl(url) &&
        !isBlacklisted(serverName)
      ) valid++;
      else discarded++;
    }
  }

  return {
    embeds_urls: urls,
    embeds_valid: valid,
    embeds_discarded: discarded
  };
}

function deduplicateLinks(links) {
  const map = new Map();

  for (const link of links) {
    if (!isValidLink(link)) continue;

    const key = `${link.idioma}|${link.url_embed}`;

    if (!map.has(key)) {
      map.set(key, link);
    }
  }

  return Array.from(map.values());
}

function isValidLink(link) {
  return !!(
    link &&
    typeof link === "object" &&
    isHttpUrl(link.url_embed) &&
    !isBlacklisted(link.servidor)
  );
}

function isHttpUrl(value) {
  return (
    typeof value === "string" &&
    /^https?:\/\//i.test(value)
  );
}

function isBlacklisted(server) {
  const normalized = String(server || "")
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, "");

  return BLACKLIST.some(blocked => {
    const b = blocked
      .toLowerCase()
      .replace(/[\s_-]+/g, "");

    return (
      normalized === b ||
      normalized.startsWith(b)
    );
  });
}

function normalizeServerName(server) {
  const value = String(server || "")
    .trim()
    .toLowerCase();

  const base = value.replace(/_\d+$/, "");

  const map = {
    abyss: "Abyss",
    streamwish: "Streamwish",
    filelions: "Filelions",
    voe: "Voe",
    doodstream: "Doodstream",
    primeload: "Primeload",
    mixdrop: "Mixdrop",
    filemoon: "Filemoon",
    powvideo: "Powvideo",
    streamplay: "Streamplay",
    streamtape: "Streamtape",
    vidmoly: "Vidmoly",
    vimeos: "Vimeos"
  };

  return map[base] || capitalize(base);
}

function normalizeLanguage(language) {
  const value = String(language || "")
    .trim()
    .toLowerCase();

  const map = {
    latino: "Latino",
    latam: "Latino",
    "español latino": "Latino",
    "espanol latino": "Latino",
    castellano: "Castellano",
    español: "Castellano",
    espanol: "Castellano",
    subtitulado: "Subtitulado",
    subtitulos: "Subtitulado",
    subtítulo: "Subtitulado",
    subtitulo: "Subtitulado",
    subtitle: "Subtitulado",
    sub: "Subtitulado"
  };

  return map[value] || capitalize(value);
}

function capitalize(value) {
  if (!value) return "Desconocido";
  return value.charAt(0).toUpperCase() + value.slice(1);
}

/*
 * ==================================================================
 * KEYS
 * ==================================================================
 */

/*
 * ==================================================================
 * SSE / HELPERS
 * ==================================================================
 */

function createSSE() {
  let controller = null;
  let closed = false;
  const encoder = new TextEncoder();

  // Comentario inicial grande para reducir buffering de proxies/clientes.
  const SSE_PADDING = ":" + " ".repeat(2048) + "\n\n";

  const stream = new ReadableStream({
    start(c) {
      controller = c;
      c.enqueue(encoder.encode(SSE_PADDING));
    },
    cancel() {
      closed = true;
      controller = null;
    }
  });

  // Heartbeat: mantiene viva la conexión mientras Beta puede tardar.
  const heartbeat = setInterval(() => {
    if (closed || !controller) return;
    try {
      controller.enqueue(encoder.encode(
        `: heartbeat ${Date.now()}\n\n`
      ));
    } catch {
      closed = true;
      controller = null;
    }
  }, 10000);

  const writer = {
    write(chunk) {
      if (closed || !controller) return;
      try {
        controller.enqueue(encoder.encode(chunk));
      } catch {
        closed = true;
        controller = null;
      }
    },
    close() {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      if (!controller) return;
      try {
        controller.close();
      } catch {}
      controller = null;
    }
  };

  const headers = new Headers({
    ...CORS,
    "Content-Type": "text/event-stream; charset=UTF-8",
    "Cache-Control": "no-cache, no-store, must-revalidate, no-transform",
    "X-Accel-Buffering": "no",
    "Connection": "keep-alive"
  });

  return {
    writer,
    response: new Response(stream, {
      status: 200,
      headers
    })
  };
}

function sendSSE(writer, event, data) {
  // Un solo chunk por evento. El comentario final/padding ayuda a
  // que cada evento atraviese intermediarios que agrupan chunks pequeños.
  writer.write(
    `event: ${event}\n` +
    `data: ${JSON.stringify(data)}\n\n` +
    `: flush ${Date.now()}\n\n`
  );
}

function failure(status, error, started) {
  return {
    success: false,
    status,
    links: [],
    elapsed_ms: Date.now() - started,
    error
  };
}

function extractErrorMessage(data) {
  if (typeof data === "string") {
    return data.slice(0, 500);
  }

  if (data && typeof data === "object") {
    return (
      data.message ||
      data.error ||
      data.msg ||
      "Respuesta HTTP no válida."
    );
  }

  return "Respuesta HTTP no válida.";
}

function objectKeys(value) {
  return (
    value &&
    typeof value === "object" &&
    !Array.isArray(value)
  )
    ? Object.keys(value)
    : [];
}

function isTrue(value) {
  return [
    "1",
    "true",
    "yes",
    "on",
    "force"
  ].includes(
    String(value || "").trim().toLowerCase()
  );
}

function jsonResponse(data, status = 200) {
  const headers = new Headers({
    ...CORS,
    "Content-Type": "application/json; charset=UTF-8",
    "Cache-Control": "no-store"
  });

  return new Response(
    JSON.stringify(data, null, 2),
    { status, headers }
  );
}
