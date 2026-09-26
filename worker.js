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
}
  const retryServerBtn = document.getElementById('retryServerBtn');
  const embedToast = document.getElementById('embedToast');
  const embedToastClose = document.getElementById('embedToastClose');
  const badgeQuality = document.getElementById('badgeQuality');
  const topActions = document.getElementById('topActions');
  const topLeftActions = document.getElementById('topLeftActions');
  const nowWatching = document.getElementById('nowWatching');
  const langBtn = document.getElementById('langBtn');
  const langDropdown = document.getElementById('langDropdown');
  const serversTopBtn = document.getElementById('serversTopBtn');
  const serversDropdown = document.getElementById('serversDropdown');
  const playGate = document.getElementById('playGate');
  const playBtn = document.getElementById('playBtn');
  const controlsBar = document.getElementById('controlsBar');
  const centerControls = document.getElementById('centerControls');
  const playPauseBtn = document.getElementById('playPauseBtn');
  const backBtn = document.getElementById('backBtn');
  const fwdBtn = document.getElementById('fwdBtn');
  const muteBtn = document.getElementById('muteBtn');
  const volumeSlider = document.getElementById('volumeSlider');
  const pipBtn = document.getElementById('pipBtn');
  const fullscreenBtn = document.getElementById('fullscreenBtn');
  const settingsBtn = document.getElementById('settingsBtn');
  const settingsDropdown = document.getElementById('settingsDropdown');
  const speedOptions = document.getElementById('speedOptions');
  const qualityMenuItem = document.getElementById('qualityMenuItem');
  const qualityOptions = document.getElementById('qualityOptions');
  const speedCurrentLabel = document.getElementById('speedCurrentLabel');
  const qualityCurrentLabel = document.getElementById('qualityCurrentLabel');
  const normalizeToggle = document.getElementById('normalizeToggle');
  const normalizeToggleRow = document.getElementById('normalizeToggleRow');
  const progressTrack = document.getElementById('progressTrack');
  const progressFilled = document.getElementById('progressFilled');
  const progressBuffered = document.getElementById('progressBuffered');
  const progressThumb = document.getElementById('progressThumb');
  const timeCurrent = document.getElementById('timeCurrent');
  const timeDuration = document.getElementById('timeDuration');
  const playerWrap = document.getElementById('playerWrap');

  let hlsInstance = null;
  let currentIndex = -1;
  let started = false;
  let selectedLang = null; // null = todos los idiomas
  let fallbackAttempted = false; // evita loops: solo un intento de fallback a iframe por carga de servidor

  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }

  function getLanguages() {
    const set = [];
    SERVERS.forEach(s => { if (set.indexOf(s.idioma) === -1) set.push(s.idioma); });
    return set;
  }

  function renderLangDropdown() {
    const langs = getLanguages();
    langDropdown.innerHTML = '';
    const allItem = document.createElement('div');
    allItem.className = 'dropdown-item' + (selectedLang === null ? ' active' : '');
    allItem.innerHTML = '<div class="name">Todos</div>';
    allItem.addEventListener('click', () => { selectedLang = null; closeDropdowns(); onLangChange(); });
    langDropdown.appendChild(allItem);
    langs.forEach(lang => {
      const item = document.createElement('div');
      item.className = 'dropdown-item' + (selectedLang === lang ? ' active' : '');
      item.innerHTML = '<div class="name">' + escapeHtml(lang) + '</div>';
      item.addEventListener('click', () => { selectedLang = lang; closeDropdowns(); onLangChange(); });
      langDropdown.appendChild(item);
    });
  }

  function renderServersDropdown() {
    serversDropdown.innerHTML = '';
    const filtered = selectedLang ? SERVERS.filter(s => s.idioma === selectedLang) : SERVERS;
    filtered.forEach(s => {
      const realIndex = SERVERS.indexOf(s);
      const item = document.createElement('div');
      item.className = 'dropdown-item' + (realIndex === currentIndex ? ' active' : '');
      const metaText = s.calidad && s.calidad !== 'Desconocida'
        ? escapeHtml(s.idioma) + ' · ' + escapeHtml(s.calidad)
        : escapeHtml(s.idioma);
      const faviconUrl = s.domain
        ? 'https://www.google.com/s2/favicons?sz=64&domain=' + encodeURIComponent(s.domain)
        : null;
      const iconHtml = faviconUrl
        ? '<img class="server-favicon" src="' + faviconUrl + '" alt="" onerror="this.style.visibility=\'hidden\'" />'
        : '<div class="server-favicon server-favicon-placeholder"></div>';
      item.innerHTML = '<div class="dropdown-item-row">' + iconHtml +
        '<div class="dropdown-item-text"><div class="name">' + escapeHtml(s.servidor) + '</div>' +
        '<div class="meta">' + metaText + '</div></div></div>';
      item.addEventListener('click', () => { closeDropdowns(); loadServer(realIndex); });
      serversDropdown.appendChild(item);
    });
  }

  function onLangChange() {
    renderLangDropdown();
    renderServersDropdown();
    const filtered = selectedLang ? SERVERS.filter(s => s.idioma === selectedLang) : SERVERS;
    if (filtered.length && filtered.indexOf(SERVERS[currentIndex]) === -1) {
      loadServer(SERVERS.indexOf(filtered[0]));
    }
  }

  const dropdownCloseTimers = new WeakMap();

  function closeDropdowns() {
    [langDropdown, serversDropdown, settingsDropdown].forEach(d => {
      const pending = dropdownCloseTimers.get(d);
      if (pending) clearTimeout(pending);
      if (!d.classList.contains('open')) return;
      d.classList.remove('show');
      const timer = setTimeout(() => d.classList.remove('open'), 180);
      dropdownCloseTimers.set(d, timer);
    });
    langBtn.classList.remove('open');
    serversTopBtn.classList.remove('open');
    settingsBtn.classList.remove('open');
  }

  function openDropdown(dropdown, btn) {
    const pending = dropdownCloseTimers.get(dropdown);
    if (pending) { clearTimeout(pending); dropdownCloseTimers.delete(dropdown); }
    dropdown.classList.add('open');
    btn.classList.add('open');
    requestAnimationFrame(() => requestAnimationFrame(() => dropdown.classList.add('show')));
  }

  function toggleDropdown(dropdown, btn) {
    const willOpen = !dropdown.classList.contains('show');
    closeDropdowns();
    if (willOpen) openDropdown(dropdown, btn);
  }

  langBtn.addEventListener('click', (e) => { e.stopPropagation(); toggleDropdown(langDropdown, langBtn); });
  serversTopBtn.addEventListener('click', (e) => { e.stopPropagation(); toggleDropdown(serversDropdown, serversTopBtn); });
  settingsBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    showSettingsPage('pageRoot');
    toggleDropdown(settingsDropdown, settingsBtn);
  });
  settingsDropdown.addEventListener('click', (e) => e.stopPropagation());
  langDropdown.addEventListener('click', (e) => e.stopPropagation());
  serversDropdown.addEventListener('click', (e) => e.stopPropagation());
  document.addEventListener('click', closeDropdowns);

  // ---------- Navegación por submenús del panel de configuración (estilo JWPlayer) ----------

  function showSettingsPage(pageId) {
    settingsDropdown.querySelectorAll('.settings-page').forEach(p => {
      p.classList.toggle('active', p.id === pageId);
    });
  }

  settingsDropdown.querySelectorAll('.settings-menu-item[data-target]').forEach(item => {
    item.addEventListener('click', () => showSettingsPage(item.dataset.target));
  });
  settingsDropdown.querySelectorAll('.settings-page-header[data-back]').forEach(header => {
    header.addEventListener('click', () => showSettingsPage(header.dataset.back));
  });

  function resetPlayerUI() {
    if (hlsInstance) { hlsInstance.destroy(); hlsInstance = null; }
    if (loadTimeoutTimer) { clearTimeout(loadTimeoutTimer); loadTimeoutTimer = null; }
    clearEmbedWatchdog();
    isActuallyPlaying = false;
    playGate.classList.remove('gate-ready');
    videoEl.pause();
    videoEl.removeAttribute('src');
    videoEl.style.display = 'none';
    iframeEl.src = '';
    iframeEl.style.display = 'none';
    errorEl.style.display = 'none';
    playBtn.style.display = 'none';
    controlsBar.style.display = 'none';
    centerControls.style.display = 'none';
    hideBufferSpinner();
    qualityMenuItem.style.display = 'none';
    embedToast.style.display = 'none';
    if (embedToastTimer) clearTimeout(embedToastTimer);
    nowWatching.style.display = 'none';
    loadingEl.style.display = 'flex';

    // Reinicia el contador/barra de progreso: sin esto quedan mostrando
    // el tiempo/duración del servidor anterior hasta que llega el primer evento.
    timeCurrent.textContent = '0:00';
    timeDuration.textContent = '0:00';
    progressFilled.style.width = '0%';
    progressBuffered.style.width = '0%';
    progressThumb.style.left = '0%';
    releaseWakeLock();
  }

  let loadTimeoutTimer = null;

  playBtn.addEventListener('click', () => {
    if (started) return;
    started = true;
    playGate.style.display = 'none';
    centerControls.style.display = 'flex';
    videoEl.play().catch(() => {});
    updateNowWatchingVisibility();

    // Máximo 15s desde que se pide reproducir hasta que el video realmente
    // empieza (evento 'playing'). Si no llega a tiempo, se asume que MediaFlow/
    // el HLS está trabado y se cae directo al embed original.
    if (loadTimeoutTimer) clearTimeout(loadTimeoutTimer);
    loadTimeoutTimer = setTimeout(() => {
      if (!isActuallyPlaying) {
        tryFallbackToEmbed();
      }
    }, 15000);
  });

  async function fetchServers() {
    const params = new URLSearchParams({
      kind: MEDIA.kind, tmdb_id: MEDIA.tmdbId, season: MEDIA.season, episode: MEDIA.episode
    });
    try {
      const res = await fetch('/api/servers?' + params.toString());
      const data = await res.json();
      if (!data.success || !data.servers || !data.servers.length) {
        loadingEl.style.display = 'none';
        errorText.textContent = data.error || 'Sin servidores disponibles';
        errorEl.style.display = 'flex';
        return;
      }
      SERVERS = data.servers;
      topActions.style.display = 'flex';
      topLeftActions.style.display = 'flex';
      renderLangDropdown();
      renderServersDropdown();
      loadServer(0);
    } catch (err) {
      loadingEl.style.display = 'none';
      errorText.textContent = 'No se pudo consultar el buscador de servidores';
      errorEl.style.display = 'flex';
    }
  }

  async function loadServer(index) {
    const server = SERVERS[index];
    if (!server) return;
    currentIndex = index;
    renderLangDropdown();
    renderServersDropdown();
    resetPlayerUI();
    loadingEl.querySelector('span').textContent = 'Buscando reproducción...';
    badgeQuality.textContent = (server.calidad && server.calidad !== 'Desconocida') ? server.calidad : '';
    fallbackAttempted = false;

    const params = new URLSearchParams({
      kind: MEDIA.kind, tmdb_id: MEDIA.tmdbId, season: MEDIA.season, episode: MEDIA.episode, index: String(index)
    });

    try {
      const res = await fetch('/api/resolve?' + params.toString());
      const data = await res.json();
      loadingEl.style.display = 'none';

      if (!data.success) {
        showFatalError();
        return;
      }
      prepareStream(data);
    } catch (err) {
      loadingEl.style.display = 'none';
      showFatalError();
    }
  }

  // Prepara el stream (carga la fuente) sin reproducir todavía.
  // El botón play queda visible sobre el backdrop hasta que el usuario lo pulse.
  function prepareStream(data) {
    if (data.mode === 'direct' && data.is_hls) {
      videoEl.style.display = 'block';
      if (window.Hls && Hls.isSupported()) {
        hlsInstance = new Hls();
        hlsInstance.loadSource(data.playable_url);
        hlsInstance.attachMedia(videoEl);
        hlsInstance.on(Hls.Events.ERROR, (event, errData) => {
          if (errData.fatal) {
            tryFallbackToEmbed();
          }
        });
        hlsInstance.on(Hls.Events.MANIFEST_PARSED, () => {
          renderQualityOptions();
          // Si el HLS expone múltiples calidades, se extiende el margen de
          // carga de 15s a 30s (streams con varios niveles suelen tardar más
          // en negociar la conexión inicial).
          if (hlsInstance.levels && hlsInstance.levels.length > 1 && loadTimeoutTimer) {
            clearTimeout(loadTimeoutTimer);
            loadTimeoutTimer = setTimeout(() => {
              if (!isActuallyPlaying) tryFallbackToEmbed();
            }, 30000);
          }
        });
      } else {
        videoEl.src = data.playable_url;
      }
      controlsBar.style.display = 'flex';
      showPlayGateOrAutoplay();
    } else if (data.mode === 'direct') {
      videoEl.style.display = 'block';
      videoEl.src = data.playable_url;
      videoEl.addEventListener('error', () => tryFallbackToEmbed(), { once: true });
      controlsBar.style.display = 'flex';
      showPlayGateOrAutoplay();
    } else {
      // Fallback directo (ya venía marcado como iframe desde el backend).
      iframeEl.style.display = 'block';
      iframeEl.src = data.playable_url;
      playGate.style.display = 'none';
      started = true;
      updateNowWatchingVisibility();
      showEmbedToast();
      startEmbedWatchdog();
    }
  }

  // Cuando el HLS falla de forma fatal, intenta reproducir el embed original
  // (url_embed) dentro de un iframe, en vez de dejar al usuario sin salida.
  async function tryFallbackToEmbed() {
    if (fallbackAttempted) {
      showFatalError();
      return;
    }
    fallbackAttempted = true;

    if (hlsInstance) { hlsInstance.destroy(); hlsInstance = null; }
    isActuallyPlaying = false;
    videoEl.style.display = 'none';
    videoEl.removeAttribute('src');
    controlsBar.style.display = 'none';
    centerControls.style.display = 'none';
    errorEl.style.display = 'none';
    hideBufferSpinner();
    nowWatching.style.display = 'none';
    playGate.style.display = 'flex';
    playBtn.style.display = 'none';
    loadingEl.style.display = 'flex';
    loadingEl.querySelector('span').textContent = 'Redirigiendo a embed original...';

    const params = new URLSearchParams({
      kind: MEDIA.kind, tmdb_id: MEDIA.tmdbId, season: MEDIA.season, episode: MEDIA.episode, index: String(currentIndex)
    });

    try {
      const res = await fetch('/api/embed?' + params.toString());
      const data = await res.json();
      loadingEl.style.display = 'none';

      if (!data.success || !data.embed_url) {
        showFatalError();
        return;
      }

      // Fallback silencioso: solo queda el spinner ya oculto y el iframe.
      errorEl.style.display = 'none';
      hideBufferSpinner();
      iframeEl.style.display = 'block';
      iframeEl.src = data.embed_url;
      playGate.style.display = 'none';
      started = true;
      updateNowWatchingVisibility();
      showEmbedToast();
      startEmbedWatchdog();
    } catch (err) {
      loadingEl.style.display = 'none';
      showFatalError();
    }
  }

  // Muestra el overlay de error con opción de reintentar o cambiar de servidor,
  // en vez de dejar al usuario sin ninguna salida.
  function showFatalError() {
    loadingEl.style.display = 'none';
    isActuallyPlaying = false;
    hideBufferSpinner();
    nowWatching.style.display = 'none';
    playGate.style.display = 'flex';
    playBtn.style.display = 'none';
    const hasMore = SERVERS.length > 1;
    errorText.textContent = 'No se pudo procesar este servidor.';
    retryServerBtn.style.display = hasMore ? 'inline-block' : 'none';
    errorEl.style.display = 'flex';
  }

  let embedToastTimer = null;
  function showEmbedToast() {
    embedToast.style.display = 'flex';
    if (embedToastTimer) clearTimeout(embedToastTimer);
    embedToastTimer = setTimeout(() => { embedToast.style.display = 'none'; }, 8000);
  }
  embedToastClose.addEventListener('click', () => {
    embedToast.style.display = 'none';
    if (embedToastTimer) clearTimeout(embedToastTimer);
  });

  let embedWatchdogTimer = null;

  // Un iframe cross-origin no avisa si el contenido embebido falló realmente
  // (solo si el propio iframe no llegó a cargar), así que el único fallback
  // automático posible es por tiempo: si no dispara 'load' en 10s, se asume
  // que el embed no respondió y se avanza al siguiente servidor.
  function startEmbedWatchdog() {
    clearEmbedWatchdog();
    embedWatchdogTimer = setTimeout(() => {
      advanceToNextServer();
    }, 10000);
    iframeEl.addEventListener('load', clearEmbedWatchdog, { once: true });
  }

  function clearEmbedWatchdog() {
    if (embedWatchdogTimer) { clearTimeout(embedWatchdogTimer); embedWatchdogTimer = null; }
  }

  function advanceToNextServer() {
    if (SERVERS.length <= 1) {
      showFatalError();
      return;
    }
    const nextIndex = (currentIndex + 1) % SERVERS.length;
    loadServer(nextIndex);
  }

  retryServerBtn.addEventListener('click', () => {
    advanceToNextServer();
  });

  // Solo en la primera carga se muestra el gate con botón play. En cambios de
  // servidor posteriores (started=true) se reproduce directo, sin gate.
  function updateNowWatchingVisibility() {
    const hasTitle = !!nowWatching.querySelector('.now-watching-title').textContent.trim();
    nowWatching.style.display = hasTitle ? 'block' : 'none';
  }

  function showPlayGateOrAutoplay() {
    if (started) {
      // Cambios de servidor posteriores al primero: sin gate, reproduce directo
      // y los controles centrales (play/pause, ±10s) quedan visibles de una.
      playGate.style.display = 'none';
      centerControls.style.display = 'flex';
      videoEl.play().catch(() => {});
      updateNowWatchingVisibility();
      if (loadTimeoutTimer) clearTimeout(loadTimeoutTimer);
      loadTimeoutTimer = setTimeout(() => {
        if (!isActuallyPlaying) tryFallbackToEmbed();
      }, 15000);
    } else {
      // Primera carga: solo el botón play del gate es interactivo. Los
      // controles centrales permanecen ocultos para que no se superpongan
      // y capturen el click antes de que el usuario inicie la reproducción.
      // "Estás viendo" tampoco se muestra aún: recién aparece cuando hay
      // player o embed realmente activo.
      centerControls.style.display = 'none';
      nowWatching.style.display = 'none';
      playGate.style.display = 'flex';
      playBtn.style.display = 'flex';
      // El backdrop pasa de escala de grises a color una vez que ya se
      // encontraron servidores y el player está listo para reproducir.
      playGate.classList.add('gate-ready');
    }
  }

  // ---------- Player custom (controles propios sobre <video>) ----------

  function formatTime(sec) {
    if (!isFinite(sec) || sec < 0) sec = 0;
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return m + ':' + String(s).padStart(2, '0');
  }

  function updatePlayIcon() {
    const icon = videoEl.paused ? 'solar:play-bold' : 'solar:pause-bold';
    playPauseBtn.innerHTML = '<iconify-icon icon="' + icon + '"></iconify-icon>';
  }

  playPauseBtn.addEventListener('click', () => {
    if (videoEl.paused) videoEl.play().catch(() => {});
    else videoEl.pause();
  });
  videoEl.addEventListener('play', updatePlayIcon);
  videoEl.addEventListener('pause', updatePlayIcon);

  // Spinner de buffering: aparece mientras el video está cargando/rebuffering.
  // Mientras se muestra, los controles centrales (play/pause, ±10s) se ocultan
  // para no interferir visualmente con la carga.
  let bufferStatusInterval = null;

  function formatBytes(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  }

  function updateBufferStatus() {
    if (!videoEl.buffered || videoEl.buffered.length === 0) {
      bufferStatus.textContent = 'Almacenando en búfer...';
      return;
    }
    const bufferedEnd = videoEl.buffered.end(videoEl.buffered.length - 1);
    const bufferedSeconds = Math.max(0, bufferedEnd - videoEl.currentTime);

    // Estimación de KB en búfer a partir del bitrate del nivel HLS actual
    // (no hay una API que exponga bytes reales descargados en <video>).
    let bitrateBps = null;
    if (hlsInstance && hlsInstance.levels && hlsInstance.levels[hlsInstance.currentLevel >= 0 ? hlsInstance.currentLevel : 0]) {
      const level = hlsInstance.levels[hlsInstance.currentLevel >= 0 ? hlsInstance.currentLevel : 0];
      bitrateBps = level.bitrate;
    }

    if (bitrateBps) {
      const bytes = (bitrateBps / 8) * bufferedSeconds;
      bufferStatus.textContent = 'Almacenando en búfer, ' + formatBytes(bytes);
    } else {
      bufferStatus.textContent = 'Almacenando en búfer, ' + bufferedSeconds.toFixed(1) + 's';
    }
  }

  function showBufferSpinner() {
    bufferSpinner.style.display = 'flex';
    centerControls.style.display = 'none';
    updateBufferStatus();
    if (bufferStatusInterval) clearInterval(bufferStatusInterval);
    bufferStatusInterval = setInterval(updateBufferStatus, 500);
  }

  function hideBufferSpinner() {
    bufferSpinner.style.display = 'none';
    if (bufferStatusInterval) { clearInterval(bufferStatusInterval); bufferStatusInterval = null; }
    // Se usa el estado real del <video> (no la variable isActuallyPlaying) para
    // evitar depender del orden de ejecución entre listeners del mismo evento.
    if (!videoEl.paused && videoEl.style.display !== 'none') {
      centerControls.style.display = 'flex';
    }
  }

  videoEl.addEventListener('waiting', showBufferSpinner);
  videoEl.addEventListener('canplay', hideBufferSpinner);
  videoEl.addEventListener('seeking', showBufferSpinner);
  videoEl.addEventListener('seeked', () => { if (!videoEl.paused) hideBufferSpinner(); });
  // Zonas táctiles: doble-tap izquierda = -10s, centro = play/pause, derecha = +10s.
  // Un solo tap en cualquier zona alterna play/pause (comportamiento simple);
  // el doble-tap en los laterales hace seek en vez de eso.
  let lastTapTime = 0;
  let lastTapZone = null;

  function getTapZone(clientX) {
    const rect = videoEl.getBoundingClientRect();
    const ratio = (clientX - rect.left) / rect.width;
    if (ratio < 1 / 3) return 'left';
    if (ratio > 2 / 3) return 'right';
    return 'center';
  }

  function showSeekIndicator(zone) {
    const el = zone === 'left' ? seekIndicatorLeft : seekIndicatorRight;
    el.classList.remove('flash');
    void el.offsetWidth; // reinicia la animación si ya estaba corriendo
    el.classList.add('flash');
  }

  videoEl.addEventListener('click', (e) => {
    const zone = getTapZone(e.clientX);
    const now = Date.now();
    const isDoubleTap = now - lastTapTime < 350 && lastTapZone === zone;
    lastTapTime = now;
    lastTapZone = zone;

    if (isDoubleTap && zone === 'left') {
      videoEl.currentTime = Math.max(0, videoEl.currentTime - 10);
      showSeekIndicator('left');
      showUiTemporarily();
      return;
    }
    if (isDoubleTap && zone === 'right') {
      videoEl.currentTime = Math.min(videoEl.duration || Infinity, videoEl.currentTime + 10);
      showSeekIndicator('right');
      showUiTemporarily();
      return;
    }

    // Tap simple: si la interfaz está oculta, el primer toque solo la muestra
    // (no reproduce/pausa). Con la interfaz ya visible, el tap en el centro
    // alterna play/pause como antes.
    const uiWasHidden = wasUiHiddenBeforeTap;
    if (uiWasHidden) {
      showUiTemporarily();
      return;
    }
    if (zone === 'center') {
      if (videoEl.paused) videoEl.play().catch(() => {});
      else videoEl.pause();
    } else {
      showUiTemporarily();
    }
  });

  backBtn.addEventListener('click', () => { videoEl.currentTime = Math.max(0, videoEl.currentTime - 10); });
  fwdBtn.addEventListener('click', () => { videoEl.currentTime = Math.min(videoEl.duration || Infinity, videoEl.currentTime + 10); });

  function updateMuteIcon() {
    const effectiveVolume = videoEl.muted ? 0 : (audioGainNode ? audioGainNode.gain.value : videoEl.volume);
    const icon = effectiveVolume === 0 ? 'solar:volume-cross-bold' : 'solar:volume-loud-bold';
    muteBtn.innerHTML = '<iconify-icon icon="' + icon + '"></iconify-icon>';
  }
  muteBtn.addEventListener('click', () => {
    videoEl.muted = !videoEl.muted;
    updateMuteIcon();
  });

  // ---------- Amplificación de volumen + Normalización (Web Audio API) ----------
  // El <video>.volume nativo solo llega a 1.0 (100%); para superar ese límite
  // (como VLC) se enruta el audio por un GainNode. Se crea una sola vez por
  // <video> porque createMediaElementSource no puede llamarse dos veces sobre
  // el mismo elemento. Un DynamicsCompressorNode opcional (normalización de
  // volumen) puede insertarse/quitarse de la cadena sin recrear el grafo.
  let audioCtx = null;
  let audioGainNode = null;
  let audioSourceNode = null;
  let audioCompressorNode = null;
  let normalizationEnabled = false;

  function ensureAudioGraph() {
    if (audioGainNode) return; // ya inicializado
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      audioCtx = new Ctx();
      audioSourceNode = audioCtx.createMediaElementSource(videoEl);
      audioGainNode = audioCtx.createGain();
      audioGainNode.gain.value = 1;

      audioCompressorNode = audioCtx.createDynamicsCompressor();
      // Ajustes típicos de normalización/limitador suave, similares a lo que
      // hacen reproductores como VLC con su opción "Normalizar volumen".
      audioCompressorNode.threshold.value = -24;
      audioCompressorNode.knee.value = 30;
      audioCompressorNode.ratio.value = 12;
      audioCompressorNode.attack.value = 0.003;
      audioCompressorNode.release.value = 0.25;

      audioSourceNode.connect(audioGainNode);
      rewireCompressor();
    } catch (e) {
      // Si Web Audio no está disponible o falla, se mantiene el volumen nativo (máx. 100%).
      audioGainNode = null;
    }
  }

  // Conecta gain -> compressor -> destino (normalización activa) o
  // gain -> destino directo (normalización desactivada / bypass real).
  function rewireCompressor() {
    if (!audioGainNode) return;
    audioGainNode.disconnect();
    audioCompressorNode.disconnect();
    if (normalizationEnabled) {
      audioGainNode.connect(audioCompressorNode).connect(audioCtx.destination);
    } else {
      audioGainNode.connect(audioCtx.destination);
    }
  }

  normalizeToggleRow.addEventListener('click', () => {
    normalizationEnabled = !normalizationEnabled;
    normalizeToggle.classList.toggle('on', normalizationEnabled);
    ensureAudioGraph();
    if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
    rewireCompressor();
  });

  // ---------- Screen Wake Lock: evita que la pantalla se apague reproduciendo ----------

  let wakeLock = null;
  let noSleepVideo = null;

  async function requestWakeLock() {
    if ('wakeLock' in navigator) {
      try {
        wakeLock = await navigator.wakeLock.request('screen');
        wakeLock.addEventListener('release', () => { wakeLock = null; });
        return;
      } catch (e) {
        // cae al fallback de abajo
      }
    }
    // Fallback para navegadores/WebViews sin Wake Lock API: un <video> mudo,
    // en loop, de 1x1, reproduciéndose en segundo plano. Es la técnica estándar
    // ("NoSleep.js") porque el propio sistema evita apagar la pantalla mientras
    // hay un elemento de video activo. No es 100% garantizado en todos los SO.
    if (!noSleepVideo) {
      noSleepVideo = document.createElement('video');
      noSleepVideo.setAttribute('playsinline', '');
      noSleepVideo.muted = true;
      noSleepVideo.loop = true;
      noSleepVideo.style.cssText = 'position:fixed;width:1px;height:1px;opacity:0;pointer-events:none;';
      // Fuente generada en el propio navegador (canvas -> MediaStream) para no
      // depender de un archivo de video embebido a mano.
      const canvas = document.createElement('canvas');
      canvas.width = 2; canvas.height = 2;
      const ctx2d = canvas.getContext('2d');
      let toggleFlag = false;
      setInterval(() => {
        toggleFlag = !toggleFlag;
        ctx2d.fillStyle = toggleFlag ? '#000' : '#010101';
        ctx2d.fillRect(0, 0, 2, 2);
      }, 1000);
      const stream = canvas.captureStream ? canvas.captureStream(1) : null;
      if (stream) {
        noSleepVideo.srcObject = stream;
      }
      document.body.appendChild(noSleepVideo);
    }
    noSleepVideo.play().catch(() => {});
  }

  function releaseWakeLock() {
    if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
    if (noSleepVideo) { noSleepVideo.pause(); }
  }

  // Vuelve a pedir el wake lock si la pestaña recupera visibilidad mientras el video sigue reproduciendo.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && isActuallyPlaying) requestWakeLock();
  });

  volumeSlider.addEventListener('input', () => {
    const value = parseFloat(volumeSlider.value); // 0 a 3 (0% a 300%)
    ensureAudioGraph();
    if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();

    if (audioGainNode) {
      // Con el grafo de Web Audio activo, el <video>.volume se deja fijo en 1
      // y toda la ganancia (incluida la atenuación 0-100%) la controla el GainNode.
      videoEl.volume = 1;
      audioGainNode.gain.value = value;
    } else {
      // Fallback sin Web Audio: se limita al rango nativo 0-100%.
      videoEl.volume = Math.min(1, value);
    }

    videoEl.muted = value === 0;
    updateMuteIcon();
  });

  // El primer gesto del usuario (play) es también el momento de habilitar el
  // grafo de audio, ya que los navegadores requieren interacción para AudioContext.
  playBtn.addEventListener('click', () => { ensureAudioGraph(); }, { once: true });

  pipBtn.addEventListener('click', async () => {
    try {
      if (document.pictureInPictureElement) {
        await document.exitPictureInPicture();
      } else if (document.pictureInPictureEnabled) {
        await videoEl.requestPictureInPicture();
      }
    } catch (e) {}
  });

  function updateFullscreenIcon() {
    const isFs = !!document.fullscreenElement;
    fullscreenBtn.innerHTML = '<iconify-icon icon="' + (isFs ? 'solar:minimize-square-2-bold' : 'solar:maximize-bold') + '"></iconify-icon>';
  }
  fullscreenBtn.addEventListener('click', async () => {
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
      } else {
        await playerWrap.requestFullscreen();
      }
    } catch (e) {}
  });
  document.addEventListener('fullscreenchange', updateFullscreenIcon);

  // ---------- Settings: velocidad + calidad ----------

  const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2];

  function renderSpeedOptions() {
    speedOptions.innerHTML = '';
    SPEEDS.forEach(speed => {
      const opt = document.createElement('div');
      const label = speed === 1 ? 'Normal' : speed + 'x';
      opt.className = 'settings-option' + (videoEl.playbackRate === speed ? ' active' : '');
      opt.innerHTML = '<span>' + label + '</span><iconify-icon icon="solar:check-circle-bold" class="check"></iconify-icon>';
      opt.addEventListener('click', () => {
        videoEl.playbackRate = speed;
        renderSpeedOptions();
        showSettingsPage('pageRoot');
      });
      speedOptions.appendChild(opt);
      if (videoEl.playbackRate === speed) speedCurrentLabel.textContent = label;
    });
  }

  // La calidad solo se muestra si hls.js expone niveles reales (varias resoluciones).
  // Si el HLS no trae niveles múltiples, la sección se oculta por completo.
  function renderQualityOptions() {
    if (!hlsInstance || !hlsInstance.levels || hlsInstance.levels.length <= 1) {
      qualityMenuItem.style.display = 'none';
      return;
    }
    qualityMenuItem.style.display = 'flex';
    qualityOptions.innerHTML = '';

    const autoOpt = document.createElement('div');
    autoOpt.className = 'settings-option' + (hlsInstance.currentLevel === -1 ? ' active' : '');
    autoOpt.innerHTML = '<span>Automática</span><iconify-icon icon="solar:check-circle-bold" class="check"></iconify-icon>';
    autoOpt.addEventListener('click', () => {
      hlsInstance.currentLevel = -1;
      renderQualityOptions();
      showSettingsPage('pageRoot');
    });
    qualityOptions.appendChild(autoOpt);
    if (hlsInstance.currentLevel === -1) qualityCurrentLabel.textContent = 'Automática';

    hlsInstance.levels.forEach((level, idx) => {
      const label = level.height ? level.height + 'p' : Math.round(level.bitrate / 1000) + ' kbps';
      const opt = document.createElement('div');
      opt.className = 'settings-option' + (hlsInstance.currentLevel === idx ? ' active' : '');
      opt.innerHTML = '<span>' + label + '</span><iconify-icon icon="solar:check-circle-bold" class="check"></iconify-icon>';
      opt.addEventListener('click', () => {
        hlsInstance.currentLevel = idx;
        renderQualityOptions();
        showSettingsPage('pageRoot');
      });
      qualityOptions.appendChild(opt);
      if (hlsInstance.currentLevel === idx) qualityCurrentLabel.textContent = label;
    });
  }

  renderSpeedOptions();

  videoEl.addEventListener('timeupdate', () => {
    if (!videoEl.duration) return;
    const pct = (videoEl.currentTime / videoEl.duration) * 100;
    progressFilled.style.width = pct + '%';
    progressThumb.style.left = pct + '%';
    timeCurrent.textContent = formatTime(videoEl.currentTime);
  });
  videoEl.addEventListener('loadedmetadata', () => {
    timeDuration.textContent = formatTime(videoEl.duration);
  });
  videoEl.addEventListener('progress', () => {
    if (!videoEl.duration || !videoEl.buffered.length) return;
    const end = videoEl.buffered.end(videoEl.buffered.length - 1);
    progressBuffered.style.width = (end / videoEl.duration) * 100 + '%';
  });

  function seekFromEvent(clientX) {
    const rect = progressTrack.getBoundingClientRect();
    const pct = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    if (videoEl.duration) videoEl.currentTime = pct * videoEl.duration;
  }
  let seeking = false;
  progressTrack.addEventListener('pointerdown', (e) => { seeking = true; seekFromEvent(e.clientX); });
  window.addEventListener('pointermove', (e) => { if (seeking) seekFromEvent(e.clientX); });
  window.addEventListener('pointerup', () => { seeking = false; });

  // Atajos de teclado
  document.addEventListener('keydown', (e) => {
    if (videoEl.style.display === 'none') return;
    if (e.code === 'Space') { e.preventDefault(); playPauseBtn.click(); }
    else if (e.code === 'ArrowLeft') { backBtn.click(); }
    else if (e.code === 'ArrowRight') { fwdBtn.click(); }
    else if (e.code === 'KeyM') { muteBtn.click(); }
    else if (e.code === 'KeyF') { fullscreenBtn.click(); }
    showUiTemporarily();
  });

  // ---------- Auto-ocultado de controles tras 3s de inactividad ----------
  // Solo se activa cuando el video está reproduciéndose de verdad (evento
  // 'playing', no solo 'play'), nunca mientras carga, está en pausa, en el
  // gate/backdrop, o con un dropdown abierto.

  let hideUiTimer = null;
  let isActuallyPlaying = false;

  function showUi() {
    playerWrap.classList.remove('ui-hidden');
  }

  function scheduleHideUi() {
    if (hideUiTimer) clearTimeout(hideUiTimer);
    hideUiTimer = setTimeout(() => {
      const dropdownOpen = langDropdown.classList.contains('open') ||
        serversDropdown.classList.contains('open') || settingsDropdown.classList.contains('open');
      if (isActuallyPlaying && !videoEl.paused && !dropdownOpen) {
        playerWrap.classList.add('ui-hidden');
      }
    }, 3000);
  }

  function showUiTemporarily() {
    showUi();
    if (isActuallyPlaying) scheduleHideUi();
  }

  let wasUiHiddenBeforeTap = false;
  videoEl.addEventListener('pointerdown', () => {
    wasUiHiddenBeforeTap = playerWrap.classList.contains('ui-hidden');
  });

  ['mousemove', 'touchstart', 'click', 'pointerdown'].forEach(evt => {
    playerWrap.addEventListener(evt, (e) => {
      // El click/tap sobre el propio video lo resuelve su handler dedicado
      // (decide entre solo-revelar-UI vs play/pause vs seek). mousemove y el
      // resto de la superficie del player siguen revelando la UI normalmente.
      if (evt === 'click' && e.target === videoEl) return;
      showUiTemporarily();
    }, { passive: true });
  });
  videoEl.addEventListener('playing', () => {
    hideBufferSpinner();
    isActuallyPlaying = true;
    showUiTemporarily();
    requestWakeLock();
    if (loadTimeoutTimer) { clearTimeout(loadTimeoutTimer); loadTimeoutTimer = null; }
  });
  videoEl.addEventListener('waiting', () => { isActuallyPlaying = false; showUi(); });
  videoEl.addEventListener('pause', () => { isActuallyPlaying = false; showUi(); releaseWakeLock(); });
  videoEl.addEventListener('ended', () => { isActuallyPlaying = false; releaseWakeLock(); });
  videoEl.addEventListener('seeking', () => { isActuallyPlaying = false; showUi(); });
  if (hideUiTimer) clearTimeout(hideUiTimer);

  // Auto-inicio: busca servidores y resuelve el primero automáticamente al cargar.
  // El usuario solo interactúa para darle play una vez que el stream está listo.
  fetchServers();
})();
</script>
</body>
</html>`;
}
