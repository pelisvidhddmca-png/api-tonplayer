/*
 * ================================================================
 * TONPLAYER CONTENT WORKER
 * ================================================================
 *
 * FUENTES
 *
 * Alpha = PelixPlay
 * Beta  = Supabase
 *
 * Flujo normal:
 *
 *   PelixPlay ─────┐
 *                  ├──> combinar ──> Supabase primero ──> deduplicar
 *   Supabase ──────┘
 *
 * Las dos fuentes se consultan EN PARALELO.
 *
 * Si Supabase encuentra un servidor:
 *   queda delante de los servidores de PelixPlay.
 *
 * Si una fuente falla:
 *   se utilizan igualmente los resultados de la otra.
 *
 * NSR:
 *   ELIMINADO
 *
 * KV:
 *   ALPHA_KV = PelixPlay, 6 horas
 *   BETA_KV  = Supabase, 6 horas
 *
 * VARIABLES:
 *   SUPABASE_URL
 *   SUPABASE_ANON_KEY
 *   SOURCE_URL
 *
 * BINDINGS:
 *   ALPHA_KV
 *   BETA_KV
 *
 * ENDPOINTS:
 *
 *   GET /health
 *
 *   GET /play/movie/ID
 *
 *   GET /play/movie/ID?force=true
 *
 *   GET /play/movie/ID?fallback=beta
 *
 *   GET /play/tv/ID/SEASON/EPISODE
 *
 *   GET /play/tv/ID/SEASON/EPISODE?force=true
 *
 *   GET /play/tv/ID/SEASON/EPISODE?fallback=beta
 *
 * ================================================================
 */

const ALPHA_CACHE_TTL = 6 * 60 * 60;
const BETA_CACHE_TTL  = 6 * 60 * 60;

/*
 * Servidores que nunca deben aparecer.
 */
const BLACKLIST = [
  "servidortrinity",
  "servidormahoutokoro",
  "servidordeathstar",
  "servidorgoldmember",
  "powvideo",
  "streamplay"
];

/*
 * CORS
 */
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization"
};


/* ================================================================
 * ENTRYPOINT
 * ================================================================ */

export default {
  async fetch(request, env, ctx) {

    /*
     * Preflight
     */
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: CORS
      });
    }

    /*
     * Solo GET
     */
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

      console.error("WORKER ERROR:", err);

      return jsonResponse({
        success: false,
        status: "worker_error",
        event: "complete",
        error: err?.message || String(err)
      }, 500);
    }
  }
};


/* ================================================================
 * ROUTER
 * ================================================================ */

async function router(request, env, ctx) {

  const url = new URL(request.url);

  const path = url.pathname.replace(/\/+$/, "");

  /*
   * Health
   */
  if (path === "/health") {

    return jsonResponse({
      success: true,
      status: "online",
      event: "complete",
      sources: {
        alpha: "PelixPlay",
        beta: "Supabase",
        nsr: false
      }
    });
  }

  /*
   * Parámetros
   */
  const fallbackBeta = isBetaFallback(
    url.searchParams.get("fallback")
  );

  const force = isTrue(
    url.searchParams.get("force")
  );

  /*
   * Movie
   */
  let match = path.match(
    /^\/play\/movie\/(\d+)$/
  );

  if (match) {

    return processContent({
      env,
      ctx,
      tmdbId: match[1],
      type: "movie",
      season: 0,
      episode: 0,
      fallbackBeta,
      force
    });
  }

  /*
   * TV
   */
  match = path.match(
    /^\/play\/tv\/(\d+)\/(\d+)\/(\d+)$/
  );

  if (match) {

    return processContent({
      env,
      ctx,
      tmdbId: match[1],
      type: "tv",
      season: Number(match[2]),
      episode: Number(match[3]),
      fallbackBeta,
      force
    });
  }

  /*
   * Not found
   */
  return jsonResponse({
    success: false,
    status: "not_found",
    event: "complete",
    endpoints: {
      health: "/health",
      movie: "/play/movie/ID",
      tv: "/play/tv/ID/SEASON/EPISODE"
    }
  }, 404);
}


/* ================================================================
 * PROCESS CONTENT
 * ================================================================ */

async function processContent({
  env,
  ctx,
  tmdbId,
  type,
  season,
  episode,
  fallbackBeta,
  force
}) {

  const {
    writer,
    response
  } = createSSE();


  /*
   * ==============================================================
   * FALLBACK=BETA
   * ==============================================================
   *
   * Beta ahora es Supabase.
   *
   * Esto permite:
   *
   * ?fallback=beta
   *
   * para saltarse PelixPlay y consultar solamente Supabase.
   */

  if (fallbackBeta) {

    await sendSSE(
      writer,
      "connected",
      {
        success: true,
        status: "connected",
        mode: "beta_fallback",
        source: "Supabase",
        tmdb_id: tmdbId,
        type,
        season,
        episode
      }
    );

    await sendSSE(
      writer,
      "beta_search",
      {
        success: true,
        status: "searching_beta",
        source: "Supabase"
      }
    );

    const beta = await runBeta({
      env,
      ctx,
      tmdbId,
      type,
      season,
      episode,
      force
    });

    await sendSSE(
      writer,
      "beta_found",
      {
        success: beta.links.length > 0,
        status: beta.links.length > 0
          ? "beta_found"
          : "beta_unavailable",
        source: "Supabase",
        found: beta.links.length,
        links: beta.links,
        cache: beta.cache || "miss",
        error: beta.error || null
      }
    );

    await sendSSE(
      writer,
      "complete",
      {
        success: beta.links.length > 0,
        status: beta.links.length > 0
          ? "success"
          : "source_unavailable",
        event: "complete",
        source: "Supabase",
        tmdb_id: tmdbId,
        type,
        season,
        episode,
        alpha_found: 0,
        beta_found: beta.links.length,
        found: beta.links.length,
        links: beta.links
      }
    );

    writer.close();

    return response;
  }


  /*
   * ==============================================================
   * FLUJO NORMAL
   * ==============================================================
   *
   * PelixPlay + Supabase se ejecutan simultáneamente.
   */

  await sendSSE(
    writer,
    "connected",
    {
      success: true,
      status: "connected",
      mode: "parallel",
      tmdb_id: tmdbId,
      type,
      season,
      episode
    }
  );


  /*
   * Avisamos que las dos búsquedas comienzan.
   */

  await sendSSE(
    writer,
    "alpha_search",
    {
      success: true,
      status: "searching_alpha",
      source: "PelixPlay"
    }
  );

  await sendSSE(
    writer,
    "beta_search",
    {
      success: true,
      status: "searching_beta",
      source: "Supabase"
    }
  );


  /*
   * ==============================================================
   * EJECUCIÓN EN PARALELO
   * ==============================================================
   *
   * IMPORTANTE:
   *
   * No esperamos primero a PelixPlay para luego llamar Supabase.
   *
   * Las dos funciones arrancan juntas.
   */

  const [
    alpha,
    beta
  ] = await Promise.all([
    runAlpha({
      env,
      ctx,
      tmdbId,
      type,
      season,
      episode,
      force
    }),

    runBeta({
      env,
      ctx,
      tmdbId,
      type,
      season,
      episode,
      force
    })
  ]);


  /*
   * ==============================================================
   * RESULTADOS
   * ==============================================================
   */

  const alphaLinks = deduplicateLinks(
    (alpha.links || [])
      .filter(isValidLink)
  );

  const betaLinks = deduplicateLinks(
    (beta.links || [])
      .filter(isValidLink)
  );


  /*
   * SSE Alpha
   */

  await sendSSE(
    writer,
    "alpha_found",
    {
      success: alphaLinks.length > 0,
      status: alphaLinks.length > 0
        ? "alpha_found"
        : "alpha_unavailable",
      source: "PelixPlay",
      found: alphaLinks.length,
      links: alphaLinks,
      cache: alpha.cache || "miss",
      http_code: alpha.http_code ?? null,
      content_type: alpha.content_type ?? null,
      elapsed_ms: alpha.elapsed_ms ?? null,
      parser: alpha.parser ?? null,
      raw_keys: alpha.raw_keys ?? [],
      all_embeds_languages:
        alpha.all_embeds_languages ?? [],
      all_embeds_urls:
        alpha.all_embeds_urls ?? 0,
      all_embeds_valid:
        alpha.all_embeds_valid ?? 0,
      all_embeds_discarded:
        alpha.all_embeds_discarded ?? 0,
      embeds_urls:
        alpha.embeds_urls ?? 0,
      embeds_valid:
        alpha.embeds_valid ?? 0,
      embeds_discarded:
        alpha.embeds_discarded ?? 0,
      error: alpha.error ?? null
    }
  );


  /*
   * SSE Beta
   */

  await sendSSE(
    writer,
    "beta_found",
    {
      success: betaLinks.length > 0,
      status: betaLinks.length > 0
        ? "beta_found"
        : "beta_unavailable",
      source: "Supabase",
      found: betaLinks.length,
      links: betaLinks,
      cache: beta.cache || "miss",
      http_code: beta.http_code ?? null,
      content_type: beta.content_type ?? null,
      elapsed_ms: beta.elapsed_ms ?? null,
      parser: beta.parser ?? "supabase_rest",
      rows_received:
        beta.rows_received ?? 0,
      rows_valid:
        beta.rows_valid ?? 0,
      rows_discarded:
        beta.rows_discarded ?? 0,
      error: beta.error ?? null
    }
  );


  /*
   * ==============================================================
   * COMBINACIÓN
   * ==============================================================
   *
   * SUPABASE PRIMERO
   *
   * Después PelixPlay.
   *
   * Ejemplo:
   *
   * Supabase:
   *   Streamwish
   *   Filelions
   *
   * PelixPlay:
   *   Vimeus
   *   Streamwish
   *   Doodstream
   *
   * Resultado:
   *
   *   Streamwish
   *   Filelions
   *   Vimeus
   *   Doodstream
   *
   * Streamwish de PelixPlay se elimina por duplicado.
   */

  const combinedLinks = deduplicateLinks([
    ...betaLinks,
    ...prioritizeVimeus(alphaLinks)
  ]);


  /*
   * ==============================================================
   * RESULTADO FINAL
   * ==============================================================
   */

  await sendSSE(
    writer,
    "complete",
    {
      success: combinedLinks.length > 0,

      status: combinedLinks.length > 0
        ? "success"
        : "source_unavailable",

      event: "complete",

      source:
        betaLinks.length > 0 &&
        alphaLinks.length > 0
          ? "Supabase+PelixPlay"
          : betaLinks.length > 0
            ? "Supabase"
            : alphaLinks.length > 0
              ? "PelixPlay"
              : "none",

      tmdb_id: tmdbId,
      type,
      season,
      episode,

      alpha_source: "PelixPlay",
      beta_source: "Supabase",

      alpha_found: alphaLinks.length,
      beta_found: betaLinks.length,

      alpha_queried: true,
      beta_queried: true,

      found: combinedLinks.length,

      links: combinedLinks,

      nsr: false
    }
  );


  writer.close();

  return response;
}


/* ================================================================
 * ALPHA = PELIXPLAY
 * ================================================================ */

async function runAlpha({
  env,
  ctx,
  tmdbId,
  type,
  season,
  episode,
  force
}) {

  const cacheKey = buildAlphaCacheKey(
    type,
    tmdbId,
    season,
    episode
  );


  /*
   * ==============================================================
   * ALPHA KV
   * ==============================================================
   */

  if (!force && env.ALPHA_KV) {

    try {

      const cached =
        await env.ALPHA_KV.get(
          cacheKey,
          "json"
        );

      if (
        cached &&
        Array.isArray(cached.links)
      ) {

        const links =
          deduplicateLinks(
            cached.links.filter(isValidLink)
          );

        if (links.length > 0) {

          return {
            success: true,
            status: "cache_hit",
            links,
            cache: "hit",
            elapsed_ms: 0,
            parser: "pelixplay_kv"
          };
        }
      }

    } catch (err) {

      console.error(
        "ALPHA_KV ERROR:",
        err
      );
    }
  }


  /*
   * ==============================================================
   * SCRAPER PELIXPLAY
   * ==============================================================
   */

  const result =
    await scrapePelixPlay({
      env,
      tmdbId,
      type,
      season,
      episode
    });


  const links =
    deduplicateLinks(
      (result.links || [])
        .filter(isValidLink)
    );


  /*
   * ==============================================================
   * GUARDAR EN KV
   * ==============================================================
   */

  if (
    env.ALPHA_KV &&
    links.length > 0
  ) {

    ctx.waitUntil(
      env.ALPHA_KV.put(
        cacheKey,
        JSON.stringify({
          links,
          cached_at: Date.now()
        }),
        {
          expirationTtl:
            ALPHA_CACHE_TTL
        }
      )
    );
  }


  return {
    ...result,
    links,
    cache: "miss"
  };
}


/* ================================================================
 * BETA = SUPABASE
 * ================================================================ */

async function runBeta({
  env,
  ctx,
  tmdbId,
  type,
  season,
  episode,
  force
}) {

  const cacheKey = buildBetaCacheKey(
    type,
    tmdbId,
    season,
    episode
  );


  /*
   * ==============================================================
   * BETA KV
   * ==============================================================
   */

  if (!force && env.BETA_KV) {

    try {

      const cached =
        await env.BETA_KV.get(
          cacheKey,
          "json"
        );

      if (
        cached &&
        Array.isArray(cached.links)
      ) {

        const links =
          deduplicateLinks(
            cached.links.filter(isValidLink)
          );

        if (links.length > 0) {

          return {
            success: true,
            status: "cache_hit",
            links,
            cache: "hit",
            elapsed_ms: 0,
            parser: "supabase_kv"
          };
        }
      }

    } catch (err) {

      console.error(
        "BETA_KV ERROR:",
        err
      );
    }
  }


  /*
   * ==============================================================
   * SUPABASE
   * ==============================================================
   */

  const result =
    await fetchSupabase({
      env,
      tmdbId,
      type,
      season,
      episode
    });


  const links =
    deduplicateLinks(
      (result.links || [])
        .filter(isValidLink)
    );


  /*
   * ==============================================================
   * GUARDAR EN KV
   * ==============================================================
   */

  if (
    env.BETA_KV &&
    links.length > 0
  ) {

    ctx.waitUntil(
      env.BETA_KV.put(
        cacheKey,
        JSON.stringify({
          links,
          cached_at: Date.now()
        }),
        {
          expirationTtl:
            BETA_CACHE_TTL
        }
      )
    );
  }


  return {
    ...result,
    links,
    cache: "miss"
  };
}


/* ================================================================
 * PELIXPLAY SCRAPER
 * ================================================================ */

async function scrapePelixPlay({
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


  const base =
    env.SOURCE_URL.replace(
      /\/+$/,
      ""
    );


  const params =
    new URLSearchParams();

  params.set(
    "action",
    "details"
  );

  params.set(
    "id",
    tmdbId
  );

  params.set(
    "type",
    type
  );


  if (type === "tv") {

    params.set(
      "season",
      String(season)
    );

    params.set(
      "episode",
      String(episode)
    );
  }


  const endpoint =
    `${base}/embed/api.php?${params.toString()}`;


  let response;


  try {

    response = await fetch(
      endpoint,
      {
        method: "GET",
        redirect: "follow",

        headers: {
          "Accept":
            "application/json,text/plain,*/*",

          "Accept-Language":
            "es-ES,es;q=0.9,en;q=0.8",

          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
            "AppleWebKit/537.36 " +
            "Chrome/131.0.0.0 " +
            "Safari/537.36"
        }
      }
    );

  } catch (err) {

    return failure(
      "request_error",
      err?.message || String(err),
      started
    );
  }


  const contentType =
    response.headers.get(
      "content-type"
    ) || "";


  const text =
    await response.text();


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
      elapsed_ms:
        Date.now() - started,
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
      elapsed_ms:
        Date.now() - started,
      raw_keys: objectKeys(data),
      parser: null,
      error:
        extractErrorMessage(data)
    };
  }


  const rawKeys =
    objectKeys(data);


  /*
   * ==============================================================
   * ALL_EMBEDS
   * ==============================================================
   */

  if (
    data?.all_embeds &&
    typeof data.all_embeds === "object" &&
    !Array.isArray(data.all_embeds)
  ) {

    const diagnostics =
      countAllEmbeds(
        data.all_embeds
      );


    const links =
      extractAllEmbeds(
        data.all_embeds
      );


    if (links.length > 0) {

      return {
        success: true,
        status: "links_found",
        links,

        http_code:
          response.status,

        content_type:
          contentType,

        elapsed_ms:
          Date.now() - started,

        parser:
          "all_embeds",

        raw_keys:
          rawKeys,

        ...diagnostics
      };
    }
  }


  /*
   * ==============================================================
   * EMBEDS FALLBACK
   * ==============================================================
   */

  if (
    data?.embeds &&
    typeof data.embeds === "object" &&
    !Array.isArray(data.embeds)
  ) {

    const diagnostics =
      countEmbeds(
        data.embeds
      );


    const links =
      extractEmbedsFallback(
        data.embeds,
        normalizeLanguage(
          data.language || "latino"
        )
      );


    if (links.length > 0) {

      return {
        success: true,
        status: "links_found",
        links,

        http_code:
          response.status,

        content_type:
          contentType,

        elapsed_ms:
          Date.now() - started,

        parser:
          "embeds",

        raw_keys:
          rawKeys,

        ...diagnostics
      };
    }


    return {
      success: false,
      status: "no_embeds",
      links: [],

      http_code:
        response.status,

      content_type:
        contentType,

      elapsed_ms:
        Date.now() - started,

      parser:
        "embeds",

      raw_keys:
        rawKeys,

      ...diagnostics,

      error:
        "PelixPlay respondió JSON pero no quedaron URLs válidas."
    };
  }


  /*
   * Sin embeds
   */

  return {
    success: false,
    status: "no_embeds",
    links: [],

    http_code:
      response.status,

    content_type:
      contentType,

    elapsed_ms:
      Date.now() - started,

    parser: null,

    raw_keys:
      rawKeys,

    all_embeds_languages: [],
    all_embeds_urls: 0,
    all_embeds_valid: 0,
    all_embeds_discarded: 0,

    embeds_urls: 0,
    embeds_valid: 0,
    embeds_discarded: 0,

    error:
      "PelixPlay devolvió JSON pero no contiene all_embeds ni embeds."
  };
}


/* ================================================================
 * SUPABASE
 * ================================================================ */

async function fetchSupabase({
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


  const base =
    env.SUPABASE_URL.replace(
      /\/+$/,
      ""
    );


  const params =
    new URLSearchParams();


  params.set(
    "select",
    "tmdb_id,tipo,url_embed,servidor,idioma,temporada,episodio"
  );


  params.set(
    "tmdb_id",
    `eq.${tmdbId}`
  );


  params.set(
    "tipo",
    `eq.${type}`
  );


  params.set(
    "temporada",
    `eq.${season}`
  );


  params.set(
    "episodio",
    `eq.${episode}`
  );


  const endpoint =
    `${base}/rest/v1/enlaces?${params.toString()}`;


  let response;


  try {

    response = await fetch(
      endpoint,
      {
        method: "GET",

        headers: {
          "apikey":
            env.SUPABASE_ANON_KEY,

          "Authorization":
            `Bearer ${env.SUPABASE_ANON_KEY}`,

          "Accept":
            "application/json"
        }
      }
    );

  } catch (err) {

    return failure(
      "request_error",
      err?.message || String(err),
      started
    );
  }


  const contentType =
    response.headers.get(
      "content-type"
    ) || "";


  let rows;


  try {

    rows =
      await response.json();

  } catch {

    return {
      success: false,
      status: "invalid_json",
      links: [],

      http_code:
        response.status,

      content_type:
        contentType,

      elapsed_ms:
        Date.now() - started,

      parser:
        "supabase_rest",

      error:
        "Supabase devolvió una respuesta no JSON."
    };
  }


  if (!response.ok) {

    return {
      success: false,
      status: "http_error",
      links: [],

      http_code:
        response.status,

      content_type:
        contentType,

      elapsed_ms:
        Date.now() - started,

      parser:
        "supabase_rest",

      error:
        extractErrorMessage(rows)
    };
  }


  if (!Array.isArray(rows)) {

    return {
      success: false,
      status: "invalid_response",
      links: [],

      http_code:
        response.status,

      content_type:
        contentType,

      elapsed_ms:
        Date.now() - started,

      parser:
        "supabase_rest",

      error:
        "Supabase no devolvió un array."
    };
  }


  const rowsReceived =
    rows.length;


  const links = [];


  for (const row of rows) {

    if (
      !row ||
      typeof row !== "object"
    ) {
      continue;
    }


    if (
      !isHttpUrl(
        row.url_embed
      )
    ) {
      continue;
    }


    if (
      isBlacklisted(
        row.servidor
      )
    ) {
      continue;
    }


    links.push({
      url_embed:
        row.url_embed,

      servidor:
        normalizeServerName(
          row.servidor ||
          "Desconocido"
        ),

      idioma:
        normalizeLanguage(
          row.idioma ||
          "Desconocido"
        )
    });
  }


  const unique =
    deduplicateLinks(
      links
    );


  return {
    success:
      unique.length > 0,

    status:
      unique.length > 0
        ? "links_found"
        : "no_links",

    links:
      unique,

    http_code:
      response.status,

    content_type:
      contentType,

    elapsed_ms:
      Date.now() - started,

    parser:
      "supabase_rest",

    rows_received:
      rowsReceived,

    rows_valid:
      unique.length,

    rows_discarded:
      Math.max(
        0,
        rowsReceived -
        unique.length
      ),

    error:
      unique.length > 0
        ? null
        : "Supabase respondió correctamente pero no hay enlaces válidos."
  };
}


/* ================================================================
 * ALL EMBEDS
 * ================================================================ */

function extractAllEmbeds(
  allEmbeds
) {

  const result = [];


  for (
    const [language, servers]
    of Object.entries(allEmbeds)
  ) {

    if (
      !servers ||
      typeof servers !== "object" ||
      Array.isArray(servers)
    ) {
      continue;
    }


    const idioma =
      normalizeLanguage(
        language
      );


    for (
      const [serverName, values]
      of Object.entries(servers)
    ) {

      if (
        isBlacklisted(
          serverName
        )
      ) {
        continue;
      }


      const urls =
        Array.isArray(values)
          ? values
          : typeof values === "string"
            ? [values]
            : [];


      for (
        const url of urls
      ) {

        if (
          !isHttpUrl(url)
        ) {
          continue;
        }


        result.push({
          url_embed: url,

          servidor:
            normalizeServerName(
              serverName
            ),

          idioma
        });
      }
    }
  }


  return deduplicateLinks(
    result
  );
}


/* ================================================================
 * EMBEDS FALLBACK
 * ================================================================ */

function extractEmbedsFallback(
  embeds,
  idioma
) {

  const result = [];


  for (
    const [serverName, values]
    of Object.entries(embeds)
  ) {

    if (
      isBlacklisted(
        serverName
      )
    ) {
      continue;
    }


    const urls =
      Array.isArray(values)
        ? values
        : typeof values === "string"
          ? [values]
          : [];


    for (
      const url of urls
    ) {

      if (
        !isHttpUrl(url)
      ) {
        continue;
      }


      result.push({
        url_embed: url,

        servidor:
          normalizeServerName(
            serverName
          ),

        idioma
      });
    }
  }


  return deduplicateLinks(
    result
  );
}


/* ================================================================
 * DIAGNOSTICS
 * ================================================================ */

function countAllEmbeds(
  allEmbeds
) {

  let urls = 0;
  let valid = 0;
  let discarded = 0;

  const languages = [];


  for (
    const [language, servers]
    of Object.entries(allEmbeds)
  ) {

    languages.push(
      language
    );


    if (
      !servers ||
      typeof servers !== "object" ||
      Array.isArray(servers)
    ) {
      continue;
    }


    for (
      const [serverName, values]
      of Object.entries(servers)
    ) {

      const list =
        Array.isArray(values)
          ? values
          : typeof values === "string"
            ? [values]
            : [];


      for (
        const url of list
      ) {

        urls++;


        if (
          isHttpUrl(url) &&
          !isBlacklisted(
            serverName
          )
        ) {

          valid++;

        } else {

          discarded++;
        }
      }
    }
  }


  return {
    all_embeds_languages:
      languages,

    all_embeds_urls:
      urls,

    all_embeds_valid:
      valid,

    all_embeds_discarded:
      discarded
  };
}


/* ================================================================
 * EMBEDS DIAGNOSTICS
 * ================================================================ */

function countEmbeds(
  embeds
) {

  let urls = 0;
  let valid = 0;
  let discarded = 0;


  for (
    const [serverName, values]
    of Object.entries(embeds)
  ) {

    const list =
      Array.isArray(values)
        ? values
        : typeof values === "string"
          ? [values]
          : [];


    for (
      const url of list
    ) {

      urls++;


      if (
        isHttpUrl(url) &&
        !isBlacklisted(
          serverName
        )
      ) {

        valid++;

      } else {

        discarded++;
      }
    }
  }


  return {
    embeds_urls:
      urls,

    embeds_valid:
      valid,

    embeds_discarded:
      discarded
  };
}


/* ================================================================
 * DEDUPLICATION
 * ================================================================ */

function deduplicateLinks(
  links
) {

  const map = new Map();


  for (
    const link of links
  ) {

    if (
      !isValidLink(link)
    ) {
      continue;
    }


    /*
     * Duplicado =
     *
     * mismo idioma + mismo servidor
     *
     * Así, si Supabase y PelixPlay
     * tienen Streamwish Latino,
     * solo queda uno.
     */

    const key =
      `${link.idioma}|${link.servidor}`;


    if (
      !map.has(key)
    ) {

      map.set(
        key,
        link
      );
    }
  }


  return Array.from(
    map.values()
  );
}


/* ================================================================
 * VIMEUS FIRST
 * ================================================================ */

function prioritizeVimeus(
  links
) {

  return [...links].sort(
    (a, b) => {

      const aVimeus =
        isVimeus(
          a.servidor
        )
          ? 0
          : 1;

      const bVimeus =
        isVimeus(
          b.servidor
        )
          ? 0
          : 1;

      return aVimeus -
        bVimeus;
    }
  );
}


function isVimeus(
  server
) {

  const value =
    String(server || "")
      .trim()
      .toLowerCase()
      .replace(/[\s_-]+/g, "");


  return [
    "vimeus",
    "vimeos",
    "vimeo"
  ].includes(value);
}


/* ================================================================
 * VALIDATION
 * ================================================================ */

function isValidLink(
  link
) {

  return !!(
    link &&
    typeof link === "object" &&
    isHttpUrl(
      link.url_embed
    ) &&
    !isBlacklisted(
      link.servidor
    )
  );
}


function isHttpUrl(
  value
) {

  return (
    typeof value === "string" &&
    /^https?:\/\//i.test(value)
  );
}


/* ================================================================
 * BLACKLIST
 * ================================================================ */

function isBlacklisted(
  server
) {

  const normalized =
    String(server || "")
      .trim()
      .toLowerCase()
      .replace(
        /[\s_-]+/g,
        ""
      );


  return BLACKLIST.some(
    blocked => {

      const b =
        blocked
          .toLowerCase()
          .replace(
            /[\s_-]+/g,
            ""
          );


      return (
        normalized === b ||
        normalized.startsWith(b)
      );
    }
  );
}


/* ================================================================
 * SERVER NORMALIZATION
 * ================================================================ */

function normalizeServerName(
  server
) {

  const value =
    String(server || "")
      .trim()
      .toLowerCase();


  const base =
    value.replace(
      /_\d+$/,
      ""
    );


  const map = {

    abyss:
      "Abyss",

    streamwish:
      "Streamwish",

    filelions:
      "Filelions",

    voe:
      "Voe",

    doodstream:
      "Doodstream",

    primeload:
      "Primeload",

    mixdrop:
      "Mixdrop",

    filemoon:
      "Filemoon",

    powvideo:
      "Powvideo",

    streamplay:
      "Streamplay",

    streamtape:
      "Streamtape",

    vidmoly:
      "Vidmoly",

    vimeus:
      "Vimeus",

    vimeos:
      "Vimeus",

    vimeo:
      "Vimeus"
  };


  return (
    map[base] ||
    capitalize(base)
  );
}


/* ================================================================
 * LANGUAGE NORMALIZATION
 * ================================================================ */

function normalizeLanguage(
  language
) {

  const value =
    String(language || "")
      .trim()
      .toLowerCase();


  const map = {

    latino:
      "Latino",

    latam:
      "Latino",

    "español latino":
      "Latino",

    "espanol latino":
      "Latino",

    castellano:
      "Castellano",

    español:
      "Castellano",

    espanol:
      "Castellano",

    subtitulado:
      "Subtitulado",

    subtitulos:
      "Subtitulado",

    subtítulo:
      "Subtitulado",

    subtitulo:
      "Subtitulado",

    subtitle:
      "Subtitulado",

    sub:
      "Subtitulado"
  };


  return (
    map[value] ||
    capitalize(value)
  );
}


/* ================================================================
 * CAPITALIZE
 * ================================================================ */

function capitalize(
  value
) {

  if (!value) {
    return "Desconocido";
  }


  return (
    value.charAt(0).toUpperCase() +
    value.slice(1)
  );
}


/* ================================================================
 * CACHE KEYS
 * ================================================================ */

function buildAlphaCacheKey(
  type,
  tmdbId,
  season,
  episode
) {

  return type === "movie"

    ? `alpha:movie:${tmdbId}`

    : `alpha:tv:${tmdbId}:${season}:${episode}`;
}


function buildBetaCacheKey(
  type,
  tmdbId,
  season,
  episode
) {

  return type === "movie"

    ? `beta:movie:${tmdbId}`

    : `beta:tv:${tmdbId}:${season}:${episode}`;
}


/* ================================================================
 * LEGACY BETA ENDPOINT
 * ================================================================ */

function buildBetaEndpoint(
  tmdbId,
  type,
  season,
  episode
) {

  if (type === "movie") {

    return (
      `/play/movie/${tmdbId}?fallback=beta`
    );
  }


  return (
    `/play/tv/${tmdbId}/${season}/${episode}?fallback=beta`
  );
}


/* ================================================================
 * SSE
 * ================================================================ */

function createSSE() {

  let controller;


  const stream =
    new ReadableStream({

      start(c) {

        controller = c;
      },


      cancel() {

        controller = null;
      }
    });


  const writer = {

    write(chunk) {

      if (!controller) {
        return;
      }


      controller.enqueue(
        new TextEncoder().encode(
          chunk
        )
      );
    },


    close() {

      if (!controller) {
        return;
      }


      controller.close();

      controller = null;
    }
  };


  const headers =
    new Headers({

      ...CORS,

      "Content-Type":
        "text/event-stream; charset=UTF-8",

      "Cache-Control":
        "no-cache, no-store, must-revalidate",

      "X-Accel-Buffering":
        "no"
    });


  return {

    writer,

    response:
      new Response(
        stream,
        {
          status: 200,
          headers
        }
      )
  };
}


/* ================================================================
 * SEND SSE
 * ================================================================ */

async function sendSSE(
  writer,
  event,
  data
) {

  writer.write(
    `event: ${event}\n`
  );

  writer.write(
    `data: ${JSON.stringify(data)}\n\n`
  );


  await Promise.resolve();
}


/* ================================================================
 * FAILURE
 * ================================================================ */

function failure(
  status,
  error,
  started
) {

  return {

    success: false,

    status,

    links: [],

    elapsed_ms:
      Date.now() - started,

    error
  };
}


/* ================================================================
 * ERROR MESSAGE
 * ================================================================ */

function extractErrorMessage(
  data
) {

  if (
    typeof data === "string"
  ) {

    return data.slice(
      0,
      500
    );
  }


  if (
    data &&
    typeof data === "object"
  ) {

    return (
      data.message ||
      data.error ||
      data.msg ||
      "Respuesta HTTP no válida."
    );
  }


  return (
    "Respuesta HTTP no válida."
  );
}


/* ================================================================
 * OBJECT KEYS
 * ================================================================ */

function objectKeys(
  value
) {

  return (
    value &&
    typeof value === "object" &&
    !Array.isArray(value)
  )

    ? Object.keys(value)

    : [];
}


/* ================================================================
 * BOOLEAN HELPERS
 * ================================================================ */

function isBetaFallback(
  value
) {

  return [
    "beta",
    "1",
    "true",
    "yes",
    "on"
  ].includes(
    String(
      value || ""
    )
      .trim()
      .toLowerCase()
  );
}


function isTrue(
  value
) {

  return [
    "1",
    "true",
    "yes",
    "on",
    "force"
  ].includes(
    String(
      value || ""
    )
      .trim()
      .toLowerCase()
  );
}


/* ================================================================
 * JSON RESPONSE
 * ================================================================ */

function jsonResponse(
  data,
  status = 200
) {

  const headers =
    new Headers({

      ...CORS,

      "Content-Type":
        "application/json; charset=UTF-8",

      "Cache-Control":
        "no-store"
    });


  return new Response(
    JSON.stringify(
      data,
      null,
      2
    ),
    {
      status,
      headers
    }
  );
}d var(--glass-border);box-shadow:var(--glass-highlight);
    display:flex;align-items:center;justify-content:center;transition:transform .12s, background .12s;
  }
  .vp-cbtn:active{background:var(--glass-bg-hover);transform:scale(.93);}
  .vp-cbtn.main{width:68px;height:68px;}
  .vp-center.hidden .vp-cbtn{pointer-events:none;}
  .vplayer.is-buffering .vp-cbtn.main{visibility:hidden;} /* en su lugar se ve el spinner */
  .vp-buffering{
    position:absolute;left:50%;top:50%;width:38px;height:38px;margin:-19px 0 0 -19px;z-index:6;
    border-radius:50%;border:3px solid rgba(255,255,255,0.15);border-top-color:var(--accent);
    animation:spin .8s linear infinite;display:none;pointer-events:none;
  }
  .vp-buffering.on{display:block;}

  .vp-controls{
    position:absolute;left:0;right:0;bottom:0;z-index:7;
    padding:28px 12px calc(env(safe-area-inset-bottom,0px) + 10px);
    background:linear-gradient(to top, rgba(0,0,0,0.88), rgba(0,0,0,0));
    display:flex;flex-direction:column;gap:4px;transition:opacity .25s;
  }
  .vp-controls.hidden{opacity:0;pointer-events:none;}

  /* Zona táctil de 28 px (la línea visible es más fina) para acertar con el dedo. */
  .vp-progress{position:relative;height:28px;display:flex;align-items:center;cursor:pointer;touch-action:none;}
  .vp-track{position:relative;width:100%;height:4px;border-radius:2px;background:rgba(255,255,255,0.22);transition:height .12s;}
  .vp-progress:hover .vp-track,.vp-progress.scrubbing .vp-track{height:6px;}
  .vp-buffered{position:absolute;left:0;top:0;height:100%;width:0;border-radius:2px;background:rgba(255,255,255,0.38);}
  .vp-played{position:absolute;left:0;top:0;height:100%;width:0;border-radius:2px;background:var(--accent);}
  .vp-thumb{
    position:absolute;top:50%;left:0;width:12px;height:12px;border-radius:50%;
    background:var(--accent);transform:translate(-50%,-50%);box-shadow:0 0 0 3px rgba(229,9,20,0.28);
    transition:transform .12s, box-shadow .12s;
  }
  /* Al arrastrar, el punto crece y su halo rojo se agranda. */
  .vp-progress.scrubbing .vp-thumb{transform:translate(-50%,-50%) scale(1.35);box-shadow:0 0 0 6px rgba(229,9,20,0.30);}

  .vp-row{display:flex;align-items:center;gap:6px;}
  .vp-row .spacer{flex:1;}
  .vp-btn{
    background:none;border:none;color:#fff;cursor:pointer;padding:6px;border-radius:8px;flex:none;
    display:flex;align-items:center;justify-content:center;
  }
  .vp-btn:active{background:rgba(255,255,255,0.14);}
  .vp-time{color:#eee;font-size:12px;font-variant-numeric:tabular-nums;flex:none;padding:0 4px;}

  .vp-volume{display:flex;align-items:center;}
  .vp-vol-track{position:relative;width:64px;height:16px;display:flex;align-items:center;cursor:pointer;touch-action:none;}
  .vp-vol-bg{position:relative;width:100%;height:4px;border-radius:2px;background:rgba(255,255,255,0.22);}
  .vp-vol-fill{position:absolute;left:0;top:0;height:100%;width:100%;border-radius:2px;background:#fff;}
  @media (max-width: 520px){ .vp-vol-track{display:none;} }

  /* Menú de ajustes (velocidad / calidad / audio) */
  .vp-settings{
    position:absolute;z-index:8;right:12px;
    bottom:calc(env(safe-area-inset-bottom,0px) + 62px);
    width:min(260px, calc(100% - 24px));max-height:calc(100% - 84px);overflow-y:auto;
    background:var(--glass-panel);
    -webkit-backdrop-filter:var(--glass-blur);backdrop-filter:var(--glass-blur);
    border:1px solid var(--glass-border);border-radius:12px;
    padding:5px;display:none;flex-direction:column;gap:1px;
    box-shadow:var(--glass-highlight), 0 12px 32px rgba(0,0,0,0.6);
  }
  .vp-settings.open{display:flex;}
  .vp-mi{
    display:flex;align-items:center;gap:10px;width:100%;text-align:left;cursor:pointer;
    background:transparent;border:none;color:var(--text);font-family:inherit;font-size:13px;
    padding:9px 10px;border-radius:8px;line-height:1.2;
  }
  .vp-mi:hover,.vp-mi:active{background:var(--glass-hover-item);}
  .vp-mi-l{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
  .vp-mi-v{color:var(--text-dim);font-size:12px;flex:none;max-width:45%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
  .vp-mi-head{font-weight:600;border-bottom:1px solid var(--border);border-radius:8px 8px 0 0;margin-bottom:3px;}
  .vp-mi.active{color:#ff8a8a;}
  .vp-mi .vp-check{width:18px;height:18px;flex:none;display:flex;align-items:center;justify-content:center;color:var(--accent);}

  .empty{
    position:absolute;inset:0;display:flex;align-items:center;justify-content:center;
    color:var(--text-dim);font-size:14px;text-align:center;padding:24px;
  }

  /* Pantalla de poster / play inicial */
  .poster{
    position:absolute;inset:0;z-index:15;
    display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px;
    background:#000;
  }
  .poster-backdrop{
    position:absolute;inset:0;background-size:cover;background-position:center;opacity:0;transition:opacity .4s ease;
  }
  .poster-backdrop.visible{opacity:1;}
  .poster-backdrop::after{
    content:"";position:absolute;inset:0;
    background:linear-gradient(to bottom, rgba(0,0,0,0.35), rgba(0,0,0,0.55) 55%, #000);
  }
  .poster-logo{position:absolute;top:calc(env(safe-area-inset-top,0px) + 18px);left:20px;z-index:2;height:26px;}
  .poster-logo img{height:100%;display:block;}
  /* Título/año en la pantalla de poster: compacto, sin el rótulo "Estás
     viendo" (ese aparece luego, sobre el reproductor). */
  .poster-heading{
    position:absolute;top:calc(env(safe-area-inset-top,0px) + 18px);left:0;right:0;z-index:2;
    display:flex;justify-content:center;padding:0 64px;text-align:center;
  }
  .poster-heading-title{font-size:12px;font-weight:600;color:var(--text-dim);
    overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:100%;}

  /* Rótulo "Estás viendo" sobre el reproductor, centrado en la barra superior
     entre los botones de idioma y servidor. */
  .watching{
    display:none;flex:1;min-width:0;flex-direction:column;align-items:center;gap:1px;
    pointer-events:none;
  }
  .watching.visible{display:flex;}
  .watching-kicker{font-size:9.5px;letter-spacing:.13em;text-transform:uppercase;color:var(--text-dim);font-weight:600;}
  .watching-title{font-size:12px;font-weight:600;color:var(--text);
    overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:100%;}
  .poster-content{position:relative;z-index:2;display:flex;flex-direction:column;align-items:center;gap:16px;}
  .play-btn{
    width:74px;height:74px;border-radius:50%;background:var(--accent);border:none;cursor:pointer;
    display:flex;align-items:center;justify-content:center;box-shadow:0 8px 28px rgba(229,9,20,0.45);
    transition:transform .15s;
  }
  .play-btn:active{transform:scale(.94);}
  .play-btn iconify-icon{color:#fff;margin-left:3px;}
  .poster-title{font-size:19px;font-weight:700;color:var(--text);text-align:center;padding:0 24px;}
  .poster-year{font-size:14px;color:var(--text-dim);}
</style>
</head>
<body>
<div id="app">
  <div class="poster" id="poster">
    <div class="poster-backdrop" id="posterBackdrop"></div>
    <div class="poster-logo"><img src="${LOGO_DATA_URI}" alt="" /></div>
    <div class="poster-heading" id="posterHeading" style="display:none;">
      <span class="poster-heading-title" id="posterHeadingTitle"></span>
    </div>
    <div class="poster-content">
      <button class="play-btn" id="playBtn" type="button" aria-label="Reproducir">
        <iconify-icon icon="uil:play" width="30" height="30"></iconify-icon>
      </button>
    </div>
  </div>

  <div class="player-wrap" id="playerWrap">
    <div class="backdrop" id="backdrop"></div>
    <div class="state" id="playerState">
      <div class="spinner"></div>
      <div>Buscando servidores...</div>
    </div>
  </div>

  <div class="top-bar" id="topBar" style="display:none;">
    <div class="menu left" id="langMenu">
      <button class="menu-btn" id="langBtn" type="button" aria-label="Idioma">
        <iconify-icon id="langFlag" icon="circle-flags:xx" width="18" height="18" style="display:none;"></iconify-icon>
        <iconify-icon icon="uil:globe" width="17" height="17" id="langIcon"></iconify-icon>
        <iconify-icon icon="uil:angle-down" width="13" height="13" class="chev"></iconify-icon>
      </button>
      <div class="menu-panel" id="langPanel"></div>
    </div>

    <div class="watching" id="watching">
      <span class="watching-kicker">Estás viendo</span>
      <span class="watching-title" id="watchingTitle"></span>
    </div>

    <div class="menu right" id="serverMenu">
      <button class="menu-btn" id="serverBtn" type="button" aria-label="Servidor">
        <iconify-icon icon="uil:cloud" width="17" height="17"></iconify-icon>
        <iconify-icon icon="uil:angle-down" width="13" height="13" class="chev"></iconify-icon>
      </button>
      <div class="menu-panel" id="serverPanel"></div>
    </div>
  </div>

  <div class="empty" id="emptyState" style="display:none;">No hay servidores disponibles para este contenido.</div>
</div>

<script>
(function(){
  var API_PATH = ${JSON.stringify(apiPath)};
  var BACKDROP_PATH = ${JSON.stringify(backdropApiPath)};
  var CONTENT_KIND = ${JSON.stringify(params.kind)};
  var CONTENT_SEASON = ${JSON.stringify(params.season || null)};
  var CONTENT_EPISODE = ${JSON.stringify(params.episode || null)};

  var playerWrap = document.getElementById('playerWrap');
  var backdropEl = document.getElementById('backdrop');
  var topBar = document.getElementById('topBar');
  var emptyState = document.getElementById('emptyState');

  var poster = document.getElementById('poster');
  var posterBackdrop = document.getElementById('posterBackdrop');
  var posterHeading = document.getElementById('posterHeading');
  var posterHeadingTitle = document.getElementById('posterHeadingTitle');
  var playBtn = document.getElementById('playBtn');
  var watching = document.getElementById('watching');
  var watchingTitle = document.getElementById('watchingTitle');

  var langMenu = document.getElementById('langMenu');
  var langBtn = document.getElementById('langBtn');
  var langPanel = document.getElementById('langPanel');
  var langFlag = document.getElementById('langFlag');
  var langIcon = document.getElementById('langIcon');

  var serverMenu = document.getElementById('serverMenu');
  var serverBtn = document.getElementById('serverBtn');
  var serverPanel = document.getElementById('serverPanel');

  var allServers = [];
  var currentLang = null;
  var currentServer = null;

  function escapeHtml(str){
    return String(str).replace(/[&<>"']/g, function(c){
      return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];
    });
  }

  function setPlayerState(html){
    destroyPlayer();
    playerWrap.innerHTML = '';
    playerWrap.appendChild(backdropEl);
    var div = document.createElement('div');
    div.className = 'state';
    div.innerHTML = html;
    playerWrap.appendChild(div);
  }

  var tmdbInfo = null; // { url, title, year } — cache local en memoria, sin KV.
  var contentLine = null; // "Título (Año)" o "Título (Año) T1E1", para el rótulo sobre el player.
  var playbackStarted = false; // true tras pulsar play; si TMDB responde después, igual se muestra.

  function loadInfo(){
    fetch(BACKDROP_PATH)
      .then(function(res){ return res.json(); })
      .then(function(data){
        if(!data || !data.success) return;
        tmdbInfo = data;

        if(data.url){
          posterBackdrop.style.backgroundImage = 'url(' + data.url + ')';
          posterBackdrop.classList.add('visible');
          backdropEl.style.backgroundImage = 'url(' + data.url + ')';
          backdropEl.classList.add('visible');
        }
        if(data.title){
          var line = data.title;
          if(data.year) line += ' (' + data.year + ')';
          if(CONTENT_KIND === 'tv' && CONTENT_SEASON && CONTENT_EPISODE){
            line += ' T' + CONTENT_SEASON + 'E' + CONTENT_EPISODE;
          }
          contentLine = line;
          posterHeadingTitle.textContent = line;
          posterHeading.style.display = 'flex';
          watchingTitle.textContent = line;
          if(playbackStarted) watching.classList.add('visible');
        }
      })
      .catch(function(){ /* decorativo: silenciosamente ignorado */ });
  }

  function closeMenus(except){
    if(except !== langMenu) langMenu.classList.remove('open');
    if(except !== serverMenu) serverMenu.classList.remove('open');
  }

  function toggleMenu(menu){
    var willOpen = !menu.classList.contains('open');
    closeMenus(null);
    if(willOpen) menu.classList.add('open');
  }

  langBtn.addEventListener('click', function(e){ e.stopPropagation(); toggleMenu(langMenu); });
  serverBtn.addEventListener('click', function(e){ e.stopPropagation(); toggleMenu(serverMenu); });
  document.addEventListener('click', function(){ closeMenus(null); });

  function init(){
    loadInfo();
  }

  playBtn.addEventListener('click', function(){
    poster.style.display = 'none';
    playbackStarted = true;
    if(contentLine){
      watchingTitle.textContent = contentLine;
      watching.classList.add('visible');
    }
    startPlayback();
  });

  async function startPlayback(){
    try{
      var res = await fetch(API_PATH);
      var data = await res.json();

      if(!data.success || !Array.isArray(data.servers) || data.servers.length === 0){
        setPlayerState('<div>Contenido no disponible por el momento</div>');
        emptyState.style.display = 'flex';
        return;
      }

      allServers = data.servers;
      topBar.style.display = 'flex';

      buildLangPanel();
      selectLanguage(allServers[0].idioma);
    }catch(err){
      setPlayerState('<div>No se pudo cargar el contenido</div>');
    }
  }

  function uniqueLanguages(){
    var seen = {};
    var list = [];
    allServers.forEach(function(s){
      if(!seen[s.idioma]){ seen[s.idioma] = true; list.push(s.idioma); }
    });
    return list;
  }

  // Mapeo de nombres de idioma (tal como los entrega el Finder) a un código
  // de país para Circle Flags. Es heurístico: cubre los casos más comunes en
  // plataformas de streaming en español; si no hay match, no se muestra bandera.
  var LANG_FLAG_MAP = {
    'latino': 'mx',
    'español latino': 'mx',
    'espanol latino': 'mx',
    'castellano': 'es',
    'español': 'es',
    'espanol': 'es',
    'español (españa)': 'es',
    'ingles': 'us',
    'inglés': 'us',
    'english': 'us',
    'subtitulado': 'us',
    'subtitulado español': 'us',
    'vose': 'us',
    'vos': 'us',
    'portugues': 'pt',
    'portugués': 'pt',
    'brasileño': 'br',
    'brasil': 'br',
    'frances': 'fr',
    'francés': 'fr',
    'aleman': 'de',
    'alemán': 'de',
    'italiano': 'it',
    'japones': 'jp',
    'japonés': 'jp',
    'coreano': 'kr'
  };

  function flagCodeForLanguage(lang){
    if(!lang) return null;
    var key = String(lang).trim().toLowerCase();
    return LANG_FLAG_MAP[key] || null;
  }

  function flagIconHtml(lang){
    var code = flagCodeForLanguage(lang);
    if(!code) return '<span class="favicon"></span>';
    return '<iconify-icon class="favicon" icon="circle-flags:' + code + '" width="16" height="16"></iconify-icon>';
  }

  function buildLangPanel(){
    var langs = uniqueLanguages();
    langPanel.innerHTML = '';
    langs.forEach(function(lang){
      var item = document.createElement('button');
      item.className = 'menu-item';
      item.type = 'button';
      item.innerHTML = flagIconHtml(lang) +
        '<span class="label-group"><span class="name">' + escapeHtml(lang) + '</span></span>';
      item.addEventListener('click', function(e){
        e.stopPropagation();
        selectLanguage(lang);
        closeMenus(null);
      });
      langPanel.appendChild(item);
    });
  }

  function selectLanguage(lang){
    currentLang = lang;

    var code = flagCodeForLanguage(lang);
    if(code){
      langFlag.setAttribute('icon', 'circle-flags:' + code);
      langFlag.style.display = 'inline-block';
      langIcon.style.display = 'none';
    } else {
      langFlag.style.display = 'none';
      langIcon.style.display = 'inline-block';
    }

    Array.prototype.forEach.call(langPanel.children, function(el, i){
      el.classList.toggle('active', uniqueLanguages()[i] === lang);
    });

    var filtered = allServers.filter(function(s){ return s.idioma === lang; });
    buildServerPanel(filtered);

    if(filtered.length > 0){
      selectServer(filtered[0]);
    } else {
      setPlayerState('<div>No hay servidores para este idioma</div>');
    }
  }

  function faviconUrl(domain){
    if(!domain) return null;
    return 'https://www.google.com/s2/favicons?sz=64&domain=' + encodeURIComponent(domain);
  }

  function buildServerPanel(servers){
    serverPanel.innerHTML = '';
    servers.forEach(function(s){
      var item = document.createElement('button');
      item.className = 'menu-item';
      item.type = 'button';
      item.setAttribute('data-server-id', s.id);

      var favicon = faviconUrl(s.domain);
      var faviconHtml = favicon
        ? '<img class="favicon" src="' + favicon + '" alt="" loading="lazy" data-fallback-hide="1" />'
        : '<span class="favicon"></span>';

      item.innerHTML = faviconHtml +
        '<span class="label-group">' +
          '<span class="name">' + escapeHtml(s.servidor) + '</span>' +
          '<span class="sub">' + escapeHtml(s.calidad) + '</span>' +
        '</span>';
      item.addEventListener('click', function(e){
        e.stopPropagation();
        selectServer(s);
        closeMenus(null);
      });
      serverPanel.appendChild(item);

      var faviconImg = item.querySelector('img.favicon');
      if(faviconImg){
        faviconImg.addEventListener('error', function(){
          faviconImg.style.visibility = 'hidden';
        });
      }
    });
  }

  async function selectServer(server){
    currentServer = server;
    Array.prototype.forEach.call(serverPanel.children, function(el){
      el.classList.toggle('active', el.getAttribute('data-server-id') === server.id);
    });

    setPlayerState('<div class="spinner"></div><div>Buscando reproducción...</div>');

    try{
      var res = await fetch('/api/resolve?token=' + encodeURIComponent(server.token));
      var data = await res.json();

      // Diagnóstico visible en la consola del navegador (sin secretos):
      // mode = "mediaflow" (HLS ok) o "iframe_fallback"; reason = por qué
      // MediaFlow no se usó (ej. mediaflow_not_configured, mediaflow_status_401).
      console.log('[player] resolve', server.servidor, '->', data.mode || data.error, data.reason || '');

      if(!data.success){
        setPlayerState('<div>No se pudo procesar este servidor</div>');
        return;
      }

      mountPlayer(data, server);
    }catch(err){
      setPlayerState('<div>No se pudo procesar este servidor</div>');
    }
  }

  function mountPlayer(data, server){
    destroyPlayer();
    playerWrap.innerHTML = '';

    if(data.type === 'hls' && data.url){
      buildCustomPlayer(data.url, server);
    } else if(data.type === 'iframe' && data.url){
      mountIframe(data.url);
    } else {
      setPlayerState('<div>No se pudo procesar este servidor</div>');
    }
  }

  function mountIframe(url){
    destroyPlayer();
    playerWrap.innerHTML = '';
    var iframe = document.createElement('iframe');
    iframe.src = url;
    iframe.allow = 'autoplay; fullscreen; picture-in-picture';
    iframe.allowFullscreen = true;
    playerWrap.appendChild(iframe);
  }

  var fallbackTriggered = false;

  // Si el HLS resuelto por MediaFlow falla en tiempo de reproducción (404,
  // error de red, manifest corrupto, etc.), en vez de dejar el player
  // pausado/roto se pide directamente el iframe original del mismo servidor
  // (sin reintentar MediaFlow) y se reemplaza el player por él.
  function fallbackToIframeOnError(server){
    if(fallbackTriggered) return;
    // Si el usuario ya cambió a otro servidor, este error no le corresponde.
    if(currentServer && server && currentServer.id !== server.id) return;
    fallbackTriggered = true;

    setPlayerState('<div class="spinner"></div><div>Buscando reproducción...</div>');

    fetch('/api/resolve?token=' + encodeURIComponent(server.token) + '&force_iframe=1')
      .then(function(res){ return res.json(); })
      .then(function(data){
        if(data && data.success && data.type === 'iframe' && data.url){
          mountIframe(data.url);
        } else {
          setPlayerState('<div>No se pudo procesar este servidor</div>');
        }
      })
      .catch(function(){
        setPlayerState('<div>No se pudo procesar este servidor</div>');
      });
  }

  // ---------------------------------------------------------------
  // Reproductor propio: <video> nativo + hls.js (solo motor) + controles
  // custom con Tabler Icons (Iconify).
  // ---------------------------------------------------------------
  var activePlayer = null; // { destroy() } del reproductor montado

  function destroyPlayer(){
    if(activePlayer){
      try{ activePlayer.destroy(); }catch(e){}
      activePlayer = null;
    }
  }

  function fmtTime(sec){
    if(!isFinite(sec) || sec < 0) sec = 0;
    sec = Math.floor(sec);
    var h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    var ss = (s < 10 ? '0' : '') + s;
    return h > 0 ? (h + ':' + (m < 10 ? '0' : '') + m + ':' + ss) : (m + ':' + ss);
  }

  function icon(name, size){
    return '<iconify-icon icon="tabler:' + name + '" width="' + size + '" height="' + size + '"></iconify-icon>';
  }

  function buildCustomPlayer(url, server){
    fallbackTriggered = false;

    var wrap = document.createElement('div');
    wrap.className = 'vplayer';
    wrap.tabIndex = 0;

    var video = document.createElement('video');
    video.playsInline = true;
    video.setAttribute('playsinline', '');
    video.autoplay = true;
    wrap.appendChild(video);

    wrap.insertAdjacentHTML('beforeend',
      '<div class="vp-buffering" data-r="buffering"></div>' +
      '<div class="vp-center" data-r="centerLayer">' +
        '<button class="vp-cbtn" type="button" data-r="back" aria-label="Retroceder 10 segundos">' + icon('rewind-backward-10', 30) + '</button>' +
        '<button class="vp-cbtn main" type="button" data-r="center" aria-label="Reproducir/Pausar">' + icon('player-play-filled', 34) + '</button>' +
        '<button class="vp-cbtn" type="button" data-r="fwd" aria-label="Adelantar 10 segundos">' + icon('rewind-forward-10', 30) + '</button>' +
      '</div>' +
      '<div class="vp-controls" data-r="controls">' +
        '<div class="vp-progress" data-r="progress"><div class="vp-track" data-r="track">' +
          '<div class="vp-buffered" data-r="buffered"></div><div class="vp-played" data-r="played"></div><div class="vp-thumb" data-r="thumb"></div>' +
        '</div></div>' +
        '<div class="vp-row">' +
          '<button class="vp-btn" type="button" data-r="play" aria-label="Reproducir/Pausar">' + icon('player-play-filled', 22) + '</button>' +
          '<div class="vp-volume">' +
            '<button class="vp-btn" type="button" data-r="mute" aria-label="Silenciar">' + icon('volume', 22) + '</button>' +
            '<div class="vp-vol-track" data-r="volTrack"><div class="vp-vol-bg"><div class="vp-vol-fill" data-r="volFill"></div></div></div>' +
          '</div>' +
          '<span class="vp-time" data-r="time">0:00 / 0:00</span>' +
          '<span class="spacer"></span>' +
          '<button class="vp-btn" type="button" data-r="gear" aria-label="Ajustes">' + icon('settings', 22) + '</button>' +
          '<button class="vp-btn" type="button" data-r="pip" aria-label="Picture in Picture">' + icon('picture-in-picture', 22) + '</button>' +
          '<button class="vp-btn" type="button" data-r="fs" aria-label="Pantalla completa">' + icon('maximize', 22) + '</button>' +
        '</div>' +
      '</div>' +
      '<div class="vp-settings" data-r="settings"></div>');
    playerWrap.appendChild(wrap);

    var r = {};
    Array.prototype.forEach.call(wrap.querySelectorAll('[data-r]'), function(el){ r[el.getAttribute('data-r')] = el; });
    function setIcon(btn, name){ btn.querySelector('iconify-icon').setAttribute('icon', 'tabler:' + name); }

    var hls = null, hideTimer = null, startTimer = null, disposed = false, mediaRecovered = false;
    var started = false;

    // ---- Ajustes: velocidad, calidad y audio ----
    var SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2];
    var menuView = null; // null = cerrado | 'main' | 'speed' | 'quality' | 'audio'
    var langNames = null;
    try{ langNames = new Intl.DisplayNames(['es'], { type: 'language' }); }catch(e){}

    function esc(s){ return escapeHtml(String(s)); }

    // Calidades que expone el manifest (solo si hay 2 o más).
    function qualityOptions(){
      if(!hls || !hls.levels || hls.levels.length < 2) return [];
      var opts = hls.levels.map(function(lv, i){
        var kbps = Math.round((lv.bitrate || 0) / 1000);
        return { index: i, height: lv.height || 0, kbps: kbps, base: lv.height ? lv.height + 'p' : (kbps + ' kbps') };
      });
      var count = {};
      opts.forEach(function(o){ count[o.base] = (count[o.base] || 0) + 1; });
      opts.forEach(function(o){ o.label = count[o.base] > 1 ? (o.base + ' · ' + o.kbps + ' kbps') : o.base; });
      opts.sort(function(a, b){ return (b.height - a.height) || (b.kbps - a.kbps); });
      return opts;
    }

    // Pistas de audio que expone el manifest (solo si hay 2 o más).
    function audioOptions(){
      if(!hls || !hls.audioTracks || hls.audioTracks.length < 2) return [];
      var opts = hls.audioTracks.map(function(t, i){
        var name = t.name ? String(t.name).trim() : '';
        var lang = t.lang ? String(t.lang).trim() : '';
        var pretty = '';
        if(lang && langNames){ try{ pretty = langNames.of(lang) || ''; }catch(e){} }
        return { index: i, name: name, label: pretty || name || lang || ('Pista ' + (i + 1)) };
      });
      var count = {};
      opts.forEach(function(o){ count[o.label] = (count[o.label] || 0) + 1; });
      opts.forEach(function(o){ if(count[o.label] > 1) o.label += ' · ' + (o.name || (o.index + 1)); });
      return opts;
    }

    function speedText(){ return video.playbackRate === 1 ? 'Normal' : (video.playbackRate + 'x'); }
    function qualityText(){
      if(!hls) return '';
      if(hls.autoLevelEnabled){
        var lv = hls.levels && hls.levels[hls.currentLevel];
        return lv && lv.height ? ('Auto (' + lv.height + 'p)') : 'Auto';
      }
      var cur = hls.levels && hls.levels[hls.currentLevel];
      return cur ? (cur.height ? cur.height + 'p' : Math.round((cur.bitrate || 0) / 1000) + ' kbps') : 'Auto';
    }
    function audioText(){
      var sel = null;
      audioOptions().forEach(function(o){ if(o.index === hls.audioTrack) sel = o; });
      return sel ? sel.label : '';
    }

    function menuRow(view, iconName, label, value){
      return '<button class="vp-mi" type="button" data-act="open" data-val="' + view + '">' +
        icon(iconName, 18) + '<span class="vp-mi-l">' + esc(label) + '</span>' +
        '<span class="vp-mi-v">' + esc(value) + '</span>' + icon('chevron-right', 16) + '</button>';
    }
    function menuOption(val, label, active){
      return '<button class="vp-mi' + (active ? ' active' : '') + '" type="button" data-act="pick" data-val="' + esc(val) + '">' +
        '<span class="vp-check">' + (active ? icon('check', 16) : '') + '</span>' +
        '<span class="vp-mi-l">' + esc(label) + '</span></button>';
    }

    function renderMenu(){
      if(!menuView){ r.settings.classList.remove('open'); return; }
      var q = qualityOptions(), a = audioOptions(), html = '';
      // Si la sección abierta dejó de existir (p. ej. cambió el manifest), volver al menú principal.
      if((menuView === 'quality' && !q.length) || (menuView === 'audio' && !a.length)) menuView = 'main';

      if(menuView === 'main'){
        html += menuRow('speed', 'gauge', 'Velocidad', speedText());
        if(q.length) html += menuRow('quality', 'adjustments-horizontal', 'Calidad', qualityText());
        if(a.length) html += menuRow('audio', 'language', 'Audio', audioText());
      } else {
        var titles = { speed: 'Velocidad', quality: 'Calidad', audio: 'Audio' };
        html += '<button class="vp-mi vp-mi-head" type="button" data-act="back">' + icon('chevron-left', 18) +
                '<span class="vp-mi-l">' + titles[menuView] + '</span></button>';
        if(menuView === 'speed'){
          SPEEDS.forEach(function(s){ html += menuOption(String(s), s === 1 ? 'Normal' : (s + 'x'), video.playbackRate === s); });
        } else if(menuView === 'quality'){
          html += menuOption('-1', 'Auto', hls.autoLevelEnabled);
          q.forEach(function(o){ html += menuOption(String(o.index), o.label, !hls.autoLevelEnabled && hls.currentLevel === o.index); });
        } else if(menuView === 'audio'){
          a.forEach(function(o){ html += menuOption(String(o.index), o.label, hls.audioTrack === o.index); });
        }
      }
      r.settings.innerHTML = html;
      r.settings.classList.add('open');
    }

    function openMenu(){ menuView = 'main'; renderMenu(); showControls(); }
    function closeMenu(){ menuView = null; renderMenu(); showControls(); }
    function refreshMenuIfOpen(){ if(menuView) renderMenu(); }

    function applyChoice(view, val){
      if(view === 'speed'){ video.playbackRate = parseFloat(val); }
      else if(view === 'quality' && hls){ hls.currentLevel = parseInt(val, 10); } // -1 = automática
      else if(view === 'audio' && hls){ hls.audioTrack = parseInt(val, 10); }
    }

    r.gear.addEventListener('click', function(){ if(menuView){ closeMenu(); } else { openMenu(); } });
    r.settings.addEventListener('click', function(e){
      var t = e.target && e.target.closest ? e.target.closest('[data-act]') : null;
      if(!t) return;
      var act = t.getAttribute('data-act'), val = t.getAttribute('data-val');
      if(act === 'open'){ menuView = val; }
      else if(act === 'back'){ menuView = 'main'; }
      else if(act === 'pick'){ applyChoice(menuView, val); menuView = 'main'; }
      renderMenu();
      if(e.stopPropagation) e.stopPropagation();
    });
    video.addEventListener('ratechange', refreshMenuIfOpen);


    function fail(reason){
      if(disposed) return;
      console.log('[player] error de reproducción ->', reason, '-> embed');
      fallbackToIframeOnError(server);
    }

    // ---- Carga del stream: hls.js (motor) o HLS nativo (Safari/iOS) ----
    if(window.Hls && Hls.isSupported()){
      hls = new Hls({ enableWorker: true, lowLatencyMode: false });
      hls.on(Hls.Events.MANIFEST_PARSED, refreshMenuIfOpen);
      hls.on(Hls.Events.LEVEL_SWITCHED, refreshMenuIfOpen);
      hls.on(Hls.Events.AUDIO_TRACKS_UPDATED, refreshMenuIfOpen);
      hls.on(Hls.Events.AUDIO_TRACK_SWITCHED, refreshMenuIfOpen);
      hls.on(Hls.Events.ERROR, function(ev, data){
        if(!data || !data.fatal) return;
        var detail = data.type + '/' + data.details + (data.response && data.response.code !== undefined ? ' (HTTP ' + data.response.code + ')' : '');
        // Un único intento de recuperación para errores de decodificación.
        if(data.type === Hls.ErrorTypes.MEDIA_ERROR && !mediaRecovered){
          mediaRecovered = true;
          console.log('[player] hls media error, reintentando:', detail);
          hls.recoverMediaError();
          return;
        }
        // Red caída, 404, código 0, manifest inválido, etc.: directo al embed.
        fail(detail);
      });
      hls.loadSource(url);
      hls.attachMedia(video);
    } else if(video.canPlayType('application/vnd.apple.mpegurl')){
      video.src = url;
    } else {
      fail('navegador sin soporte HLS');
      return;
    }

    video.addEventListener('error', function(){
      var e = video.error;
      fail('video.error ' + (e ? e.code : '?'));
    });

    // Red de seguridad: si en 15 s no hay ni metadatos ni reproducción.
    startTimer = setTimeout(function(){ if(!started) fail('sin respuesta en 15 s'); }, 15000);
    function markStarted(){ started = true; clearTimeout(startTimer); }
    video.addEventListener('loadedmetadata', function(){
      markStarted();
      var b = video.getBoundingClientRect();
      console.log('[player] video ' + (video.videoWidth || 0) + 'x' + (video.videoHeight || 0) + ' | elemento ' + Math.round(b.width) + 'x' + Math.round(b.height));
      updateProgress();
    });
    video.addEventListener('playing', markStarted);
    video.addEventListener('canplay', markStarted);

    // ---- Play / pausa ----
    function refreshPlayIcons(){
      var n = video.paused ? 'player-play-filled' : 'player-pause-filled';
      setIcon(r.play, n); setIcon(r.center, n);
    }
    function togglePlay(){
      if(video.paused){ var p = video.play(); if(p && p.catch) p.catch(function(){}); } else { video.pause(); }
    }
    r.play.addEventListener('click', togglePlay);
    r.center.addEventListener('click', togglePlay);
    // Tocar el vídeo ya NO pausa/reproduce: muestra u oculta la interfaz.
    // Con ratón los controles ya aparecen al mover el puntero, así que un
    // clic solo los muestra; con dedo/lápiz el toque los alterna.
    video.addEventListener('click', function(){
      if(menuView){ closeMenu(); return; } // el primer toque solo cierra el menú
      if(controlsHidden() || lastPointerType === 'mouse'){ showControls(); }
      else { hideControls(); }
    });
    video.addEventListener('play', function(){ refreshPlayIcons(); showControls(); });
    video.addEventListener('pause', function(){ refreshPlayIcons(); showControls(); });
    function setBuffering(on){
      if(on){ r.buffering.classList.add('on'); wrap.classList.add('is-buffering'); }
      else { r.buffering.classList.remove('on'); wrap.classList.remove('is-buffering'); }
    }
    video.addEventListener('waiting', function(){ setBuffering(true); });
    video.addEventListener('playing', function(){ setBuffering(false); refreshPlayIcons(); });
    video.addEventListener('canplay', function(){ setBuffering(false); });

    // ---- ±10 s ----
    r.back.addEventListener('click', function(){ video.currentTime = Math.max(0, video.currentTime - 10); });
    r.fwd.addEventListener('click', function(){
      var d = isFinite(video.duration) ? video.duration : Infinity;
      video.currentTime = Math.min(d, video.currentTime + 10);
    });

    // ---- Progreso ----
    // La línea roja y el punto siguen al dedo/puntero al instante (no esperan
    // al reloj del vídeo). El salto real se aplica al soltar, para no lanzar
    // decenas de peticiones HLS mientras se arrastra.
    var scrubbing = false;   // arrastrando/tocando la barra
    var pendingSeek = false; // salto aplicado, esperando el evento "seeked"
    var scrubFrac = 0;       // posición elegida (0..1)

    function paintProgress(frac){
      var pct = Math.min(100, Math.max(0, frac * 100));
      r.played.style.width = pct + '%';
      r.thumb.style.left = pct + '%';
    }
    function canScrub(){ return video.duration && isFinite(video.duration); }
    function updateProgress(){
      var d = video.duration;
      var hasDur = d && isFinite(d);
      var following = scrubbing || pendingSeek; // mostrar lo elegido, no el reloj
      if(hasDur){
        if(!following) paintProgress(video.currentTime / d);
        if(video.buffered.length){
          var end = video.buffered.end(video.buffered.length - 1);
          r.buffered.style.width = Math.min(100, (end / d) * 100) + '%';
        }
      }
      var shown = (following && hasDur) ? scrubFrac * d : video.currentTime;
      r.time.textContent = fmtTime(shown) + ' / ' + fmtTime(d);
    }
    video.addEventListener('timeupdate', updateProgress);
    video.addEventListener('progress', updateProgress);
    video.addEventListener('durationchange', updateProgress);
    video.addEventListener('seeked', function(){ pendingSeek = false; updateProgress(); });

    function pointerFraction(el, ev){
      var b = el.getBoundingClientRect();
      return Math.min(1, Math.max(0, (ev.clientX - b.left) / b.width));
    }
    function scrubTo(ev){
      scrubFrac = pointerFraction(r.track, ev);
      paintProgress(scrubFrac);
      updateProgress();
    }
    function endScrub(commit){
      if(!scrubbing) return;
      scrubbing = false;
      r.progress.classList.remove('scrubbing');
      if(commit && canScrub()){
        pendingSeek = true;
        video.currentTime = scrubFrac * video.duration;
      }
      updateProgress();
      showControls(); // reinicia la cuenta atrás de auto-ocultado
    }
    r.progress.addEventListener('pointerdown', function(ev){
      if(!canScrub()) return;
      scrubbing = true;
      r.progress.classList.add('scrubbing');
      r.progress.setPointerCapture(ev.pointerId);
      scrubTo(ev);
    });
    r.progress.addEventListener('pointermove', function(ev){ if(scrubbing) scrubTo(ev); });
    r.progress.addEventListener('pointerup', function(ev){
      if(!scrubbing) return;
      scrubTo(ev);
      endScrub(true);
    });
    r.progress.addEventListener('pointercancel', function(){ endScrub(false); });

    // ---- Volumen ----
    function refreshVolume(){
      var v = video.muted ? 0 : video.volume;
      r.volFill.style.width = (v * 100) + '%';
      setIcon(r.mute, v === 0 ? 'volume-3' : (v < 0.5 ? 'volume-2' : 'volume'));
    }
    r.mute.addEventListener('click', function(){ video.muted = !video.muted; refreshVolume(); });
    var draggingVol = false;
    function setVol(ev){
      var f = pointerFraction(r.volTrack, ev);
      video.volume = f; video.muted = f === 0; refreshVolume();
    }
    r.volTrack.addEventListener('pointerdown', function(ev){ draggingVol = true; r.volTrack.setPointerCapture(ev.pointerId); setVol(ev); });
    r.volTrack.addEventListener('pointermove', function(ev){ if(draggingVol) setVol(ev); });
    r.volTrack.addEventListener('pointerup', function(){ draggingVol = false; });
    video.addEventListener('volumechange', refreshVolume);
    refreshVolume();

    // ---- Picture in Picture ----
    if(document.pictureInPictureEnabled && !video.disablePictureInPicture){
      r.pip.addEventListener('click', function(){
        if(document.pictureInPictureElement){ document.exitPictureInPicture().catch(function(){}); }
        else { video.requestPictureInPicture().catch(function(){}); }
      });
    } else {
      r.pip.style.display = 'none';
    }

    // ---- Pantalla completa (iPhone solo permite fullscreen del <video>) ----
    function inFullscreen(){ return !!(document.fullscreenElement || document.webkitFullscreenElement || video.webkitDisplayingFullscreen); }
    r.fs.addEventListener('click', function(){
      if(inFullscreen()){
        if(document.exitFullscreen) document.exitFullscreen().catch(function(){});
        else if(document.webkitExitFullscreen) document.webkitExitFullscreen();
        else if(video.webkitExitFullscreen) video.webkitExitFullscreen();
      } else if(wrap.requestFullscreen){
        wrap.requestFullscreen().catch(function(){});
      } else if(wrap.webkitRequestFullscreen){
        wrap.webkitRequestFullscreen();
      } else if(video.webkitEnterFullscreen){
        video.webkitEnterFullscreen();
      }
    });
    function onFsChange(){ setIcon(r.fs, inFullscreen() ? 'minimize' : 'maximize'); }
    document.addEventListener('fullscreenchange', onFsChange);
    document.addEventListener('webkitfullscreenchange', onFsChange);

    // ---- Auto-ocultar controles ----
    var lastPointerType = 'mouse';
    function controlsHidden(){ return r.controls.classList.contains('hidden'); }
    function hideControls(){
      clearTimeout(hideTimer);
      r.controls.classList.add('hidden');
      r.centerLayer.classList.add('hidden');
    }
    function showControls(){
      r.controls.classList.remove('hidden');
      r.centerLayer.classList.remove('hidden');
      clearTimeout(hideTimer);
      if(!video.paused && !menuView && !scrubbing){
        hideTimer = setTimeout(hideControls, 3000);
      }
    }
    // El puntero solo revela los controles si es un ratón; con dedo, el toque
    // sobre el vídeo los alterna (ver el manejador de "click" del vídeo).
    wrap.addEventListener('pointerdown', function(ev){ lastPointerType = ev.pointerType || 'mouse'; });
    wrap.addEventListener('pointermove', function(ev){ if(ev.pointerType === 'mouse') showControls(); });
    // Usar cualquier control reinicia la cuenta atrás de auto-ocultado.
    [r.controls, r.centerLayer, r.settings].forEach(function(el){
      el.addEventListener('pointerdown', function(){ showControls(); });
    });

    // ---- Atajos de teclado ----
    wrap.addEventListener('keydown', function(e){
      if(e.code === 'Space'){ e.preventDefault(); togglePlay(); }
      else if(e.code === 'ArrowRight'){ r.fwd.click(); }
      else if(e.code === 'ArrowLeft'){ r.back.click(); }
      else if(e.code === 'KeyM'){ r.mute.click(); }
      else if(e.code === 'KeyF'){ r.fs.click(); }
      else if(e.code === 'Escape' && menuView){ closeMenu(); }
      showControls();
    });

    activePlayer = {
      destroy: function(){
        disposed = true;
        clearTimeout(hideTimer); clearTimeout(startTimer);
        document.removeEventListener('fullscreenchange', onFsChange);
        document.removeEventListener('webkitfullscreenchange', onFsChange);
        try{ video.pause(); }catch(e){}
        if(hls){ hls.destroy(); hls = null; }
        try{ video.removeAttribute('src'); video.load(); }catch(e){}
      }
    };

    refreshPlayIcons();
    showControls();
    var pp = video.play(); if(pp && pp.catch) pp.catch(function(){ /* autoplay bloqueado: queda el botón central */ });
  }

  init();
})();
</script>
</body>
</html>`;

  return new Response(html, { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } });
}
