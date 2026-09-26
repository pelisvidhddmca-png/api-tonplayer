/*
 * CONTENT WORKER
 *
 * Alpha = PelixPlay scraper
 * Beta  = Supabase
 * Gamma = NSR (sources -> resolve -> playUrl)
 *
 * Flujo normal:
 *   1) Alpha/PelixPlay + Beta/Supabase en paralelo
 *   2) Si Beta encontró servidores, sus servidores van primero
 *   3) Si Alpha + Beta no encuentran nada -> Gamma/NSR
 *
 * KV:
 *   ALPHA_KV -> PelixPlay, TTL 6h
 *   BETA_KV  -> Supabase, TTL 6h
 *
 * Variables:
 *   NSR_API_KEY
 *   SOURCE_URL
 *   SUPABASE_URL
 *   SUPABASE_ANON_KEY
 *
 * Bindings:
 *   ALPHA_KV
 *   BETA_KV
 */

const ALPHA_CACHE_TTL = 6 * 60 * 60;
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

  const fallbackBeta = isBetaFallback(url.searchParams.get("fallback"));
  const force = isTrue(url.searchParams.get("force"));

  let match = path.match(/^\/play\/movie\/(\d+)$/);
  if (match) {
    return processContent({
      env, ctx,
      tmdbId: match[1],
      type: "movie",
      season: 0,
      episode: 0,
      fallbackBeta,
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
      fallbackBeta,
      force
    });
  }

  return jsonResponse({
    success: false,
    status: "not_found",
    event: "complete"
  }, 404);
}



async function processContent({
  env, ctx, tmdbId, type, season, episode, fallbackBeta, force
}) {
  const { writer, response } = createSSE();

  await sendSSE(writer, "connected", {
    success: true,
    status: "connected",
    mode: fallbackBeta ? "alpha_fallback" : "alpha_beta_parallel",
    tmdb_id: tmdbId,
    type,
    season,
    episode
  });

  /*
   * fallback=beta conserva el comportamiento histórico:
   * ejecutar directamente Alpha/PelixPlay.
   */
  if (fallbackBeta) {
    await sendSSE(writer, "alpha_search", {
      success: true,
      status: "searching_alpha",
      source: "Alpha",
      provider: "PelixPlay",
      mode: "fallback"
    });

    const alpha = await runAlpha({
      env, ctx, tmdbId, type, season, episode, force
    });

    const alphaLinks = prioritizeVimeus(
      deduplicateLinks((alpha.links || []).filter(isValidLink))
    );

    await sendSSE(writer, "alpha_found", {
      success: alphaLinks.length > 0,
      status: alphaLinks.length > 0 ? "alpha_found" : "alpha_unavailable",
      source: "Alpha",
      provider: "PelixPlay",
      found: alphaLinks.length,
      links: alphaLinks,
      http_code: alpha.http_code ?? null,
      content_type: alpha.content_type ?? null,
      elapsed_ms: alpha.elapsed_ms ?? null,
      parser: alpha.parser ?? "pelixplay_scraper",
      cache: alpha.cache ?? "miss",
      error: alpha.error ?? null
    });

    await sendSSE(writer, "complete", {
      success: alphaLinks.length > 0,
      status: alphaLinks.length > 0 ? "success" : "source_unavailable",
      event: "complete",
      source: alphaLinks.length > 0 ? "Alpha" : null,
      provider: alphaLinks.length > 0 ? "PelixPlay" : null,
      fallback: null,
      tmdb_id: tmdbId,
      type,
      season,
      episode,
      alpha_found: alphaLinks.length,
      beta_found: 0,
      gamma_found: 0,
      beta_queried: false,
      gamma_queried: false,
      found: alphaLinks.length,
      links: alphaLinks
    });

    writer.close();
    return response;
  }

  /*
   * Alpha (PelixPlay) y Beta (Supabase) se ejecutan en paralelo.
   * No esperamos a Alpha para iniciar Beta ni viceversa.
   */
  await Promise.all([
    sendSSE(writer, "alpha_search", {
      success: true,
      status: "searching_alpha",
      source: "Alpha",
      provider: "PelixPlay"
    }),
    sendSSE(writer, "beta_search", {
      success: true,
      status: "searching_beta",
      source: "Beta",
      provider: "Supabase"
    })
  ]);

  const [alpha, beta] = await Promise.all([
    runAlpha({ env, ctx, tmdbId, type, season, episode, force }),
    runBeta({ env, ctx, tmdbId, type, season, episode, force })
  ]);

  const alphaLinks = prioritizeVimeus(
    deduplicateLinks((alpha.links || []).filter(isValidLink))
  );

  const betaLinks = prioritizeVimeus(
    deduplicateLinks((beta.links || []).filter(isValidLink))
  );

  /*
   * Beta/Supabase tiene prioridad sobre Alpha/PelixPlay:
   * si Beta encontró un servidor, su enlace queda primero.
   * La deduplicación por idioma+servidor hace que Beta gane también
   * cuando ambas fuentes tienen exactamente el mismo servidor.
   */
  const combinedLinks = deduplicateLinks([
    ...prioritizeVimeus(betaLinks),
    ...prioritizeVimeus(alphaLinks)
  ]);

  await sendSSE(writer, "alpha_found", {
    success: alphaLinks.length > 0,
    status: alphaLinks.length > 0 ? "alpha_found" : "alpha_unavailable",
    source: "Alpha",
    provider: "PelixPlay",
    found: alphaLinks.length,
    links: alphaLinks,
    cache: alpha.cache ?? "miss",
    http_code: alpha.http_code ?? null,
    content_type: alpha.content_type ?? null,
    elapsed_ms: alpha.elapsed_ms ?? null,
    parser: alpha.parser ?? "pelixplay_scraper",
    raw_keys: alpha.raw_keys ?? [],
    all_embeds_languages: alpha.all_embeds_languages ?? [],
    all_embeds_urls: alpha.all_embeds_urls ?? 0,
    all_embeds_valid: alpha.all_embeds_valid ?? 0,
    all_embeds_discarded: alpha.all_embeds_discarded ?? 0,
    embeds_urls: alpha.embeds_urls ?? 0,
    embeds_valid: alpha.embeds_valid ?? 0,
    embeds_discarded: alpha.embeds_discarded ?? 0,
    error: alpha.error ?? null
  });

  await sendSSE(writer, "beta_found", {
    success: betaLinks.length > 0,
    status: betaLinks.length > 0 ? "beta_found" : "beta_unavailable",
    source: "Beta",
    provider: "Supabase",
    found: betaLinks.length,
    links: betaLinks,
    cache: beta.cache ?? "miss",
    http_code: beta.http_code ?? null,
    content_type: beta.content_type ?? null,
    elapsed_ms: beta.elapsed_ms ?? null,
    parser: beta.parser ?? "supabase_rest",
    rows_received: beta.rows_received ?? 0,
    rows_valid: beta.rows_valid ?? 0,
    rows_discarded: beta.rows_discarded ?? 0,
    error: beta.error ?? null
  });

  if (combinedLinks.length > 0) {
    await sendSSE(writer, "complete", {
      success: true,
      status: "success",
      event: "complete",
      source: betaLinks.length > 0 ? "Beta" : "Alpha",
      provider: betaLinks.length > 0 ? "Supabase" : "PelixPlay",
      fallback: "Gamma",
      tmdb_id: tmdbId,
      type,
      season,
      episode,
      alpha_found: alphaLinks.length,
      beta_found: betaLinks.length,
      gamma_found: 0,
      beta_queried: true,
      gamma_queried: false,
      found: combinedLinks.length,
      links: combinedLinks,
      priority: betaLinks.length > 0
        ? "Beta/Supabase primero, luego Alpha/PelixPlay"
        : "Alpha/PelixPlay"
    });

    writer.close();
    return response;
  }

  /*
   * Solo si Alpha + Beta no encontraron absolutamente nada,
   * se activa Gamma/NSR.
   */
  await sendSSE(writer, "gamma_auto_fallback", {
    success: true,
    status: "alpha_beta_empty_gamma_starting",
    source: "Gamma",
    provider: "NSR",
    reason: "alpha_found_0_beta_found_0",
    message: "Alpha/PelixPlay y Beta/Supabase no encontraron servidores; se consulta Gamma/NSR."
  });

  await sendSSE(writer, "gamma_search", {
    success: true,
    status: "searching_gamma",
    source: "Gamma",
    provider: "NSR"
  });

  const gamma = await runGamma({
    env, tmdbId, type, season, episode
  });

  const gammaLinks = prioritizeVimeus(
    deduplicateLinks((gamma.links || []).filter(isValidLink))
  );

  await sendSSE(writer, "gamma_found", {
    success: gammaLinks.length > 0,
    status: gammaLinks.length > 0 ? "gamma_found" : "gamma_unavailable",
    source: "Gamma",
    provider: "NSR",
    found: gammaLinks.length,
    links: gammaLinks,
    http_code: gamma.http_code ?? null,
    content_type: gamma.content_type ?? null,
    elapsed_ms: gamma.elapsed_ms ?? null,
    parser: gamma.parser ?? "nsr_sources_resolve",
    sources_received: gamma.sources_received ?? 0,
    tokens_found: gamma.tokens_found ?? 0,
    resolved: gamma.resolved ?? 0,
    resolve_errors: gamma.resolve_errors ?? 0,
    error: gamma.error ?? null
  });

  await sendSSE(writer, "complete", {
    success: gammaLinks.length > 0,
    status: gammaLinks.length > 0 ? "success" : "source_unavailable",
    event: "complete",
    source: gammaLinks.length > 0 ? "Gamma" : null,
    provider: gammaLinks.length > 0 ? "NSR" : null,
    fallback: null,
    tmdb_id: tmdbId,
    type,
    season,
    episode,
    alpha_found: 0,
    beta_found: 0,
    gamma_found: gammaLinks.length,
    beta_queried: true,
    gamma_queried: true,
    found: gammaLinks.length,
    links: gammaLinks
  });

  writer.close();
  return response;
}


async function runNsr({
  env,
  ctx,
  tmdbId,
  type,
  season,
  episode,
  force
}) {
  const alphaKey = buildAlphaCacheKey(type, tmdbId, season, episode);

  if (!force && env.ALPHA_KV) {
    const cached = await env.ALPHA_KV.get(alphaKey, "json");

    if (cached && Array.isArray(cached.links)) {
      const links = prioritizeVimeus(
        deduplicateLinks(cached.links.filter(isValidLink))
      );

      if (links.length > 0) {
        return {
          success: true,
          links,
          elapsed_ms: 0,
          error: null,
          mode: "kv",
          cache: "hit",
          parser: "pelixplay_scraper"
        };
      }
    }
  }

  const result = await scrapeAlpha({
    env, tmdbId, type, season, episode
  });

  const links = prioritizeVimeus(
    deduplicateLinks((result.links || []).filter(isValidLink))
  );

  if (env.ALPHA_KV && links.length > 0) {
    ctx.waitUntil(
      env.ALPHA_KV.put(
        alphaKey,
        JSON.stringify({
          links,
          cached_at: Date.now()
        }),
        { expirationTtl: ALPHA_CACHE_TTL }
      )
    );
  }

  return {
    ...result,
    links,
    cache: "miss"
  };
}

async function runAlpha({ env, tmdbId, type, season, episode }) {
  const started = Date.now();

  if (!env.NSR_API_KEY) {
    return failure("not_configured", "NSR_API_KEY no está configurado.", started);
  }

  const endpoint = type === "movie"
    ? `https://nsrplay.space/api/v1/embed/sources/movie/${encodeURIComponent(tmdbId)}?fast=true`
    : `https://nsrplay.space/api/v1/embed/sources/tv/${encodeURIComponent(tmdbId)}/${encodeURIComponent(season)}/${encodeURIComponent(episode)}?fast=true`;

  let response, data;
  try {
    response = await fetch(endpoint, {
      method: "GET",
      headers: { "X-API-Key": env.NSR_API_KEY, "Accept": "application/json" }
    });
    const text = await response.text();
    try { data = JSON.parse(text); }
    catch {
      return {
        success: false, status: "invalid_json", links: [], http_code: response.status,
        content_type: response.headers.get("content-type") || "",
        elapsed_ms: Date.now() - started, parser: "nsr_sources",
        sources_received: 0, tokens_found: 0, resolved: 0, resolve_errors: 0,
        error: response.ok ? "NSR devolvió una respuesta que no es JSON." : `NSR respondió HTTP ${response.status}.`
      };
    }
  } catch (err) {
    return failure("request_error", err?.message || String(err), started);
  }

  if (!response.ok) {
    return {
      success: false, status: "http_error", links: [], http_code: response.status,
      content_type: response.headers.get("content-type") || "",
      elapsed_ms: Date.now() - started, parser: "nsr_sources",
      sources_received: 0, tokens_found: 0, resolved: 0, resolve_errors: 0,
      error: extractErrorMessage(data)
    };
  }

  const sources = collectNsrSources(data);
  const results = await Promise.all(sources.map(source => resolveNsrToken({
    env, token: source.token, server: source.server, language: source.language
  })));

  const links = [];
  let resolved = 0, resolveErrors = 0;

  for (const item of results) {
    if (item.ok) {
      resolved++;
      links.push({
        url_embed: item.playUrl,
        servidor: normalizeServerName(item.server || "Desconocido"),
        idioma: normalizeLanguage(item.language || "Latino")
      });
    } else {
      resolveErrors++;
    }
  }

  const unique = prioritizeVimeus(deduplicateLinks(links));

  return {
    success: unique.length > 0,
    status: unique.length > 0 ? "links_found" : "no_links",
    links: unique, http_code: response.status,
    content_type: response.headers.get("content-type") || "",
    elapsed_ms: Date.now() - started, parser: "nsr_sources_resolve",
    sources_received: sources.length, tokens_found: sources.length,
    resolved, resolve_errors: resolveErrors,
    error: unique.length > 0 ? null : "NSR no devolvió playUrl válidos."
  };
}

async function resolveNsrToken({ env, token, server, language }) {
  if (!token) return { ok: false, server, language, error: "Token vacío." };

  const endpoint = `https://nsrplay.space/api/v1/embed/resolve?token=${encodeURIComponent(token)}`;

  try {
    const response = await fetch(endpoint, {
      method: "GET",
      headers: { "X-API-Key": env.NSR_API_KEY, "Accept": "application/json" }
    });
    const text = await response.text();
    let data;
    try { data = JSON.parse(text); }
    catch { return { ok: false, server, language, error: "Resolve no devolvió JSON." }; }

    if (!response.ok) {
      return { ok: false, server, language, error: extractErrorMessage(data) };
    }

    const playUrl = findValue(data, ["playUrl", "play_url"]);
    if (!isHttpUrl(playUrl)) {
      return { ok: false, server, language, error: "Resolve no devolvió un playUrl HTTP válido." };
    }

    return {
      ok: true, playUrl,
      server: server || findValue(data, ["server","servidor","name","source","provider","host"]),
      language: language || findValue(data, ["language","idioma","lang"])
    };
  } catch (err) {
    return { ok: false, server, language, error: err?.message || String(err) };
  }
}

function collectNsrSources(data) {
  const result = [];
  const seen = new Set();

  function visit(value, inheritedServer = null, inheritedLanguage = null) {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item, inheritedServer, inheritedLanguage);
      return;
    }

    const token = firstString(value, ["token","source_token","embed_token"]);
    const server = firstString(value, ["server","servidor","name","source","provider","host","title"]) || inheritedServer;
    const language = firstString(value, ["language","idioma","lang"]) || inheritedLanguage;

    if (token) {
      const key = `${token}|${server || ""}|${language || ""}`;
      if (!seen.has(key)) {
        seen.add(key);
        result.push({ token, server, language });
      }
    }

    for (const [key, child] of Object.entries(value)) {
      if (["token","source_token","embed_token"].includes(key)) continue;
      if (child && typeof child === "object") visit(child, server, language);
    }
  }

  visit(data);
  return result;
}

function firstString(object, keys) {
  for (const key of keys) {
    const value = object?.[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function findValue(data, keys) {
  if (!data || typeof data !== "object") return null;
  if (Array.isArray(data)) {
    for (const item of data) {
      const found = findValue(item, keys);
      if (found) return found;
    }
    return null;
  }
  const direct = firstString(data, keys);
  if (direct) return direct;
  for (const value of Object.values(data)) {
    if (value && typeof value === "object") {
      const found = findValue(value, keys);
      if (found) return found;
    }
  }
  return null;
}




async function runBeta({
  env,
  ctx,
  tmdbId,
  type,
  season,
  episode,
  force
}) {
  const betaKey = buildBetaCacheKey(type, tmdbId, season, episode);

  if (!force && env.BETA_KV) {
    const cached = await env.BETA_KV.get(betaKey, "json");

    if (cached && Array.isArray(cached.links)) {
      const links = prioritizeVimeus(
        deduplicateLinks(cached.links.filter(isValidLink))
      );

      if (links.length > 0) {
        return {
          success: true,
          links,
          elapsed_ms: 0,
          error: null,
          mode: "kv",
          cache: "hit",
          parser: "supabase_rest"
        };
      }
    }
  }

  const result = await fetchBetaFromSupabase({
    env, tmdbId, type, season, episode
  });

  const links = prioritizeVimeus(
    deduplicateLinks((result.links || []).filter(isValidLink))
  );

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

  return {
    ...result,
    links,
    cache: "miss"
  };
}

async function fetchBetaFromSupabase({
  env,
  tmdbId,
  type,
  season,
  episode
}) {
  const started = Date.now();

  if (!env.SUPABASE_URL) {
    return failure(
      "not_configured",
      "SUPABASE_URL no está configurado.",
      started
    );
  }

  if (!env.SUPABASE_ANON_KEY) {
    return failure(
      "not_configured",
      "SUPABASE_ANON_KEY no está configurado.",
      started
    );
  }

  const base = env.SUPABASE_URL.replace(/\/+$/, "");

  const params = new URLSearchParams();

  params.set(
    "select",
    "tmdb_id,tipo,url_embed,servidor,idioma,temporada,episodio"
  );
  params.set("tmdb_id", `eq.${tmdbId}`);
  params.set("tipo", `eq.${type}`);
  params.set("temporada", `eq.${season}`);
  params.set("episodio", `eq.${episode}`);

  const endpoint =
    `${base}/rest/v1/enlaces?${params.toString()}`;

  let response;

  try {
    response = await fetch(endpoint, {
      method: "GET",
      headers: {
        "apikey": env.SUPABASE_ANON_KEY,
        "Authorization": `Bearer ${env.SUPABASE_ANON_KEY}`,
        "Accept": "application/json"
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

  let rows;

  try {
    rows = await response.json();
  } catch (err) {
    return {
      success: false,
      status: "invalid_json",
      links: [],
      http_code: response.status,
      content_type: contentType,
      elapsed_ms: Date.now() - started,
      parser: "supabase_rest",
      error: "Supabase devolvió una respuesta no JSON."
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
      parser: "supabase_rest",
      error: extractErrorMessage(rows)
    };
  }

  if (!Array.isArray(rows)) {
    return {
      success: false,
      status: "invalid_response",
      links: [],
      http_code: response.status,
      content_type: contentType,
      elapsed_ms: Date.now() - started,
      parser: "supabase_rest",
      error: "Supabase no devolvió un array."
    };
  }

  const rowsReceived = rows.length;
  const links = [];

  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    if (!isHttpUrl(row.url_embed)) continue;
    if (isBlacklisted(row.servidor)) continue;

    links.push({
      url_embed: row.url_embed,
      servidor: normalizeServerName(row.servidor || "Desconocido"),
      idioma: normalizeLanguage(row.idioma || "Desconocido")
    });
  }

  const unique = deduplicateLinks(links);

  return {
    success: unique.length > 0,
    status: unique.length > 0
      ? "links_found"
      : "no_links",
    links: unique,
    http_code: response.status,
    content_type: contentType,
    elapsed_ms: Date.now() - started,
    parser: "supabase_rest",
    rows_received: rowsReceived,
    rows_valid: unique.length,
    rows_discarded: Math.max(0, rowsReceived - unique.length),
    error: unique.length > 0
      ? null
      : "Supabase respondió correctamente pero no hay enlaces válidos."
  };
}

/*
 * ==================================================================
 * BETA / SCRAPER
 * ==================================================================
 *
 * Conserva /embed/api.php como endpoint principal de PelixPlay.
 */

async function scrapeAlpha({
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
        ? "PelixPlay devolvió una respuesta que no es JSON."
        : `PelixPlay respondió HTTP ${response.status}.`
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
      error: "PelixPlay respondió JSON pero no quedaron URLs válidas."
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
    error: "PelixPlay devolvió JSON pero no contiene all_embeds ni embeds."
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

    const key = `${link.idioma}|${link.servidor}`;

    if (!map.has(key)) {
      map.set(key, link);
    }
  }

  return Array.from(map.values());
}

function prioritizeVimeus(links) {
  return [...links].sort((a, b) => {
    const av = String(a?.servidor || "").toLowerCase() === "vimeus" ? 1 : 0;
    const bv = String(b?.servidor || "").toLowerCase() === "vimeus" ? 1 : 0;
    return bv - av;
  });
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
    vimeus: "Vimeus",
    vimeos: "Vimeus",
    vimeo: "Vimeus"
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

function buildAlphaCacheKey(type, tmdbId, season, episode) {
  return type === "movie"
    ? `alpha:pelixplay:movie:${tmdbId}`
    : `alpha:pelixplay:tv:${tmdbId}:${season}:${episode}`;
}

function buildBetaCacheKey(type, tmdbId, season, episode) {
  return type === "movie"
    ? `beta:supabase:movie:${tmdbId}`
    : `beta:supabase:tv:${tmdbId}:${season}:${episode}`;
}

function buildAlphaEndpoint(
  tmdbId,
  type,
  season,
  episode
) {
  if (type === "movie") {
    return `/play/movie/${tmdbId}?fallback=beta`;
  }

  return `/play/tv/${tmdbId}/${season}/${episode}?fallback=beta`;
}

/*
 * ==================================================================
 * SSE / HELPERS
 * ==================================================================
 */

function createSSE() {
  let controller;

  const stream = new ReadableStream({
    start(c) {
      controller = c;
    },
    cancel() {
      controller = null;
    }
  });

  const writer = {
    write(chunk) {
      if (!controller) return;
      controller.enqueue(
        new TextEncoder().encode(chunk)
      );
    },
    close() {
      if (!controller) return;
      controller.close();
      controller = null;
    }
  };

  const headers = new Headers({
    ...CORS,
    "Content-Type": "text/event-stream; charset=UTF-8",
    "Cache-Control": "no-cache, no-store, must-revalidate",
    "X-Accel-Buffering": "no"
  });

  return {
    writer,
    response: new Response(stream, {
      status: 200,
      headers
    })
  };
}

async function sendSSE(writer, event, data) {
  writer.write(`event: ${event}\n`);
  writer.write(`data: ${JSON.stringify(data)}\n\n`);
  await Promise.resolve();
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

function isBetaFallback(value) {
  return [
    "beta",
    "1",
    "true",
    "yes",
    "on"
  ].includes(
    String(value || "").trim().toLowerCase()
  );
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
