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
 * NSR:
 *   ELIMINADO
 *
 * KV:
 *   ALPHA_KV = PelixPlay, 6 horas
 *   BETA_KV  = Supabase, 6 horas
 *
 * VARIABLES:
 *
 *   SUPABASE_URL
 *   SUPABASE_ANON_KEY
 *   SOURCE_URL
 *
 * BINDINGS:
 *
 *   ALPHA_KV
 *   BETA_KV
 *
 * ENDPOINTS:
 *
 *   GET /health
 *
 *   GET /play/movie/ID
 *   GET /play/movie/ID?force=true
 *   GET /play/movie/ID?fallback=beta
 *
 *   GET /play/tv/ID/SEASON/EPISODE
 *   GET /play/tv/ID/SEASON/EPISODE?force=true
 *   GET /play/tv/ID/SEASON/EPISODE?fallback=beta
 *
 * RESPUESTA:
 *
 *   JSON normal
 *
 * ================================================================
 */

const ALPHA_CACHE_TTL = 6 * 60 * 60;
const BETA_CACHE_TTL = 6 * 60 * 60;


/* ================================================================
 * BLACKLIST
 * ================================================================ */

const BLACKLIST = [
  "servidortrinity",
  "servidormahoutokoro",
  "servidordeathstar",
  "servidorgoldmember",
  "powvideo",
  "streamplay"
];


/* ================================================================
 * CORS
 * ================================================================ */

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

      return await router(
        request,
        env,
        ctx
      );

    } catch (err) {

      console.error(
        "WORKER ERROR:",
        err
      );

      return jsonResponse({
        success: false,
        status: "worker_error",
        event: "complete",
        error:
          err?.message ||
          String(err)
      }, 500);
    }
  }
};


/* ================================================================
 * ROUTER
 * ================================================================ */

async function router(
  request,
  env,
  ctx
) {

  const url =
    new URL(request.url);


  const path =
    url.pathname.replace(
      /\/+$/,
      ""
    );


  /*
   * HEALTH
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

  const fallbackBeta =
    isBetaFallback(
      url.searchParams.get(
        "fallback"
      )
    );


  const force =
    isTrue(
      url.searchParams.get(
        "force"
      )
    );


  /*
   * MOVIE
   */

  let match =
    path.match(
      /^\/play\/movie\/(\d+)$/
    );


  if (match) {

    return processContent({

      env,
      ctx,

      tmdbId:
        match[1],

      type:
        "movie",

      season:
        0,

      episode:
        0,

      fallbackBeta,

      force
    });
  }


  /*
   * TV
   */

  match =
    path.match(
      /^\/play\/tv\/(\d+)\/(\d+)\/(\d+)$/
    );


  if (match) {

    return processContent({

      env,
      ctx,

      tmdbId:
        match[1],

      type:
        "tv",

      season:
        Number(match[2]),

      episode:
        Number(match[3]),

      fallbackBeta,

      force
    });
  }


  /*
   * NOT FOUND
   */

  return jsonResponse({

    success: false,

    status:
      "not_found",

    event:
      "complete",

    endpoints: {

      health:
        "/health",

      movie:
        "/play/movie/ID",

      tv:
        "/play/tv/ID/SEASON/EPISODE"
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

  /*
   * ==============================================================
   * FALLBACK = BETA
   * ==============================================================
   *
   * ?fallback=beta
   *
   * Consulta únicamente Supabase.
   */

  if (fallbackBeta) {

    const beta =
      await runBeta({

        env,
        ctx,

        tmdbId,
        type,

        season,
        episode,

        force
      });


    const betaLinks =
      deduplicateLinks(
        (beta.links || [])
          .filter(isValidLink)
      );


    return jsonResponse({

      success:
        betaLinks.length > 0,

      status:
        betaLinks.length > 0
          ? "success"
          : "source_unavailable",

      event:
        "complete",

      source:
        "Supabase",

      tmdb_id:
        tmdbId,

      type,

      season,

      episode,

      alpha_source:
        "PelixPlay",

      beta_source:
        "Supabase",

      alpha_found:
        0,

      beta_found:
        betaLinks.length,

      alpha_queried:
        false,

      beta_queried:
        true,

      found:
        betaLinks.length,

      links:
        betaLinks,

      cache:
        beta.cache ||
        "miss",

      error:
        beta.error ||
        null,

      nsr:
        false

    });
  }


  /*
   * ==============================================================
   * FLUJO NORMAL
   * ==============================================================
   *
   * PelixPlay + Supabase
   *
   * EN PARALELO.
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
   * LIMPIAR ALPHA
   * ==============================================================
   */

  const alphaLinks =
    deduplicateLinks(

      (alpha.links || [])
        .filter(isValidLink)

    );


  /*
   * ==============================================================
   * LIMPIAR BETA
   * ==============================================================
   */

  const betaLinks =
    deduplicateLinks(

      (beta.links || [])
        .filter(isValidLink)

    );


  /*
   * ==============================================================
   * COMBINACIÓN
   * ==============================================================
   *
   * SUPABASE PRIMERO.
   *
   * DESPUÉS PELIXPLAY.
   *
   * VIMEUS se prioriza dentro de PelixPlay.
   */

  const combinedLinks =
    deduplicateLinks([

      ...betaLinks,

      ...prioritizeVimeus(
        alphaLinks
      )

    ]);


  /*
   * ==============================================================
   * SOURCE
   * ==============================================================
   */

  let source =
    "none";


  if (
    betaLinks.length > 0 &&
    alphaLinks.length > 0
  ) {

    source =
      "Supabase+PelixPlay";

  } else if (
    betaLinks.length > 0
  ) {

    source =
      "Supabase";

  } else if (
    alphaLinks.length > 0
  ) {

    source =
      "PelixPlay";
  }


  /*
   * ==============================================================
   * RESPUESTA JSON
   * ==============================================================
   */

  return jsonResponse({

    success:
      combinedLinks.length > 0,

    status:
      combinedLinks.length > 0
        ? "success"
        : "source_unavailable",

    event:
      "complete",

    source,

    tmdb_id:
      tmdbId,

    type,

    season,

    episode,

    alpha_source:
      "PelixPlay",

    beta_source:
      "Supabase",

    alpha_found:
      alphaLinks.length,

    beta_found:
      betaLinks.length,

    alpha_queried:
      true,

    beta_queried:
      true,

    found:
      combinedLinks.length,

    links:
      combinedLinks,

    /*
     * ============================================================
     * DIAGNÓSTICO ALPHA
     * ============================================================
     */

    alpha: {

      success:
        alpha.success ||
        false,

      cache:
        alpha.cache ||
        "miss",

      http_code:
        alpha.http_code ??
        null,

      content_type:
        alpha.content_type ??
        null,

      elapsed_ms:
        alpha.elapsed_ms ??
        null,

      parser:
        alpha.parser ??
        null,

      raw_keys:
        alpha.raw_keys ??
        [],

      all_embeds_languages:
        alpha.all_embeds_languages ??
        [],

      all_embeds_urls:
        alpha.all_embeds_urls ??
        0,

      all_embeds_valid:
        alpha.all_embeds_valid ??
        0,

      all_embeds_discarded:
        alpha.all_embeds_discarded ??
        0,

      embeds_urls:
        alpha.embeds_urls ??
        0,

      embeds_valid:
        alpha.embeds_valid ??
        0,

      embeds_discarded:
        alpha.embeds_discarded ??
        0,

      error:
        alpha.error ??
        null

    },


    /*
     * ============================================================
     * DIAGNÓSTICO BETA
     * ============================================================
     */

    beta: {

      success:
        beta.success ||
        false,

      cache:
        beta.cache ||
        "miss",

      http_code:
        beta.http_code ??
        null,

      content_type:
        beta.content_type ??
        null,

      elapsed_ms:
        beta.elapsed_ms ??
        null,

      parser:
        beta.parser ||
        "supabase_rest",

      rows_received:
        beta.rows_received ??
        0,

      rows_valid:
        beta.rows_valid ??
        0,

      rows_discarded:
        beta.rows_discarded ??
        0,

      error:
        beta.error ??
        null

    },

    nsr:
      false

  });
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

  const cacheKey =
    buildAlphaCacheKey(
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

  if (
    !force &&
    env.ALPHA_KV
  ) {

    try {

      const cached =
        await env.ALPHA_KV.get(
          cacheKey,
          "json"
        );


      if (
        cached &&
        Array.isArray(
          cached.links
        )
      ) {

        const links =
          deduplicateLinks(

            cached.links
              .filter(
                isValidLink
              )

          );


        if (
          links.length > 0
        ) {

          return {

            success:
              true,

            status:
              "cache_hit",

            links,

            cache:
              "hit",

            elapsed_ms:
              0,

            parser:
              "pelixplay_kv"
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

          cached_at:
            Date.now()

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

    cache:
      "miss"

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

  const cacheKey =
    buildBetaCacheKey(
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

  if (
    !force &&
    env.BETA_KV
  ) {

    try {

      const cached =
        await env.BETA_KV.get(
          cacheKey,
          "json"
        );


      if (
        cached &&
        Array.isArray(
          cached.links
        )
      ) {

        const links =
          deduplicateLinks(

            cached.links
              .filter(
                isValidLink
              )

          );


        if (
          links.length > 0
        ) {

          return {

            success:
              true,

            status:
              "cache_hit",

            links,

            cache:
              "hit",

            elapsed_ms:
              0,

            parser:
              "supabase_kv"
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

          cached_at:
            Date.now()

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

    cache:
      "miss"

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

  const started =
    Date.now();


  if (
    !env.SOURCE_URL
  ) {

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


  if (
    type === "tv"
  ) {

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

    response =
      await fetch(

        endpoint,

        {

          method:
            "GET",

          redirect:
            "follow",

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

      err?.message ||
        String(err),

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

    data =
      JSON.parse(text);

  } catch {

    return {

      success:
        false,

      status:
        "invalid_json",

      links: [],

      http_code:
        response.status,

      content_type:
        contentType,

      elapsed_ms:
        Date.now() -
        started,

      raw_keys: [],

      parser:
        null,

      error:
        response.ok

          ? "PelixPlay devolvió una respuesta que no es JSON."

          : `PelixPlay respondió HTTP ${response.status}.`

    };
  }


  if (
    !response.ok
  ) {

    return {

      success:
        false,

      status:
        "http_error",

      links: [],

      http_code:
        response.status,

      content_type:
        contentType,

      elapsed_ms:
        Date.now() -
        started,

      raw_keys:
        objectKeys(data),

      parser:
        null,

      error:
        extractErrorMessage(data)

    };
  }


  const rawKeys =
    objectKeys(data);


  /*
   * ==============================================================
   * ALL EMBEDS
   * ==============================================================
   */

  if (

    data?.all_embeds &&

    typeof data.all_embeds ===
      "object" &&

    !Array.isArray(
      data.all_embeds
    )

  ) {

    const diagnostics =
      countAllEmbeds(
        data.all_embeds
      );


    const links =
      extractAllEmbeds(
        data.all_embeds
      );


    if (
      links.length > 0
    ) {

      return {

        success:
          true,

        status:
          "links_found",

        links,

        http_code:
          response.status,

        content_type:
          contentType,

        elapsed_ms:
          Date.now() -
          started,

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

    typeof data.embeds ===
      "object" &&

    !Array.isArray(
      data.embeds
    )

  ) {

    const diagnostics =
      countEmbeds(
        data.embeds
      );


    const links =
      extractEmbedsFallback(

        data.embeds,

        normalizeLanguage(
          data.language ||
          "latino"
        )

      );


    if (
      links.length > 0
    ) {

      return {

        success:
          true,

        status:
          "links_found",

        links,

        http_code:
          response.status,

        content_type:
          contentType,

        elapsed_ms:
          Date.now() -
          started,

        parser:
          "embeds",

        raw_keys:
          rawKeys,

        ...diagnostics

      };
    }


    return {

      success:
        false,

      status:
        "no_embeds",

      links: [],

      http_code:
        response.status,

      content_type:
        contentType,

      elapsed_ms:
        Date.now() -
        started,

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
   * ==============================================================
   * SIN EMBEDS
   * ==============================================================
   */

  return {

    success:
      false,

    status:
      "no_embeds",

    links: [],

    http_code:
      response.status,

    content_type:
      contentType,

    elapsed_ms:
      Date.now() -
      started,

    parser:
      null,

    raw_keys:
      rawKeys,

    all_embeds_languages: [],

    all_embeds_urls:
      0,

    all_embeds_valid:
      0,

    all_embeds_discarded:
      0,

    embeds_urls:
      0,

    embeds_valid:
      0,

    embeds_discarded:
      0,

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

  const started =
    Date.now();


  if (
    !env.SUPABASE_URL
  ) {

    return failure(

      "not_configured",

      "SUPABASE_URL no está configurado.",

      started

    );
  }


  if (
    !env.SUPABASE_ANON_KEY
  ) {

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

    response =
      await fetch(

        endpoint,

        {

          method:
            "GET",

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

      err?.message ||
        String(err),

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

      success:
        false,

      status:
        "invalid_json",

      links: [],

      http_code:
        response.status,

      content_type:
        contentType,

      elapsed_ms:
        Date.now() -
        started,

      parser:
        "supabase_rest",

      error:
        "Supabase devolvió una respuesta no JSON."

    };
  }


  if (
    !response.ok
  ) {

    return {

      success:
        false,

      status:
        "http_error",

      links: [],

      http_code:
        response.status,

      content_type:
        contentType,

      elapsed_ms:
        Date.now() -
        started,

      parser:
        "supabase_rest",

      error:
        extractErrorMessage(
          rows
        )

    };
  }


  if (
    !Array.isArray(rows)
  ) {

    return {

      success:
        false,

      status:
        "invalid_response",

      links: [],

      http_code:
        response.status,

      content_type:
        contentType,

      elapsed_ms:
        Date.now() -
        started,

      parser:
        "supabase_rest",

      error:
        "Supabase no devolvió un array."

    };
  }


  const rowsReceived =
    rows.length;


  const links = [];


  for (
    const row of rows
  ) {

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
      Date.now() -
      started,

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
    of Object.entries(
      allEmbeds
    )
  ) {

    if (

      !servers ||

      typeof servers !==
        "object" ||

      Array.isArray(
        servers
      )

    ) {

      continue;
    }


    const idioma =
      normalizeLanguage(
        language
      );


    for (
      const [
        serverName,
        values
      ]
      of Object.entries(
        servers
      )
    ) {

      if (
        isBlacklisted(
          serverName
        )
      ) {

        continue;
      }


      const urls =
        Array.isArray(
          values
        )

          ? values

          : typeof values ===
              "string"

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

          url_embed:
            url,

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
    const [
      serverName,
      values
    ]
    of Object.entries(
      embeds
    )
  ) {

    if (
      isBlacklisted(
        serverName
      )
    ) {

      continue;
    }


    const urls =
      Array.isArray(
        values
      )

        ? values

        : typeof values ===
            "string"

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

        url_embed:
          url,

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
 * DIAGNOSTICS - ALL EMBEDS
 * ================================================================ */

function countAllEmbeds(
  allEmbeds
) {

  let urls =
    0;

  let valid =
    0;

  let discarded =
    0;

  const languages =
    [];


  for (
    const [
      language,
      servers
    ]
    of Object.entries(
      allEmbeds
    )
  ) {

    languages.push(
      language
    );


    if (

      !servers ||

      typeof servers !==
        "object" ||

      Array.isArray(
        servers
      )

    ) {

      continue;
    }


    for (
      const [
        serverName,
        values
      ]
      of Object.entries(
        servers
      )
    ) {

      const list =
        Array.isArray(
          values
        )

          ? values

          : typeof values ===
              "string"

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
 * DIAGNOSTICS - EMBEDS
 * ================================================================ */

function countEmbeds(
  embeds
) {

  let urls =
    0;

  let valid =
    0;

  let discarded =
    0;


  for (
    const [
      serverName,
      values
    ]
    of Object.entries(
      embeds
    )
  ) {

    const list =
      Array.isArray(
        values
      )

        ? values

        : typeof values ===
            "string"

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

  const map =
    new Map();


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
     * mismo idioma +
     * mismo servidor
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

  return [
    ...links
  ].sort(

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


      return (
        aVimeus -
        bVimeus
      );
    }

  );
}


function isVimeus(
  server
) {

  const value =
    String(
      server || ""
    )
      .trim()
      .toLowerCase()
      .replace(
        /[\s_-]+/g,
        ""
      );


  return [

    "vimeus",
    "vimeos",
    "vimeo"

  ].includes(
    value
  );
}


/* ================================================================
 * VALIDATION
 * ================================================================ */

function isValidLink(
  link
) {

  return !!(

    link &&

    typeof link ===
      "object" &&

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

    typeof value ===
      "string" &&

    /^https?:\/\//i.test(
      value
    )

  );
}


/* ================================================================
 * BLACKLIST
 * ================================================================ */

function isBlacklisted(
  server
) {

  const normalized =
    String(
      server || ""
    )
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
    String(
      server || ""
    )
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

    capitalize(
      base
    )

  );
}


/* ================================================================
 * LANGUAGE NORMALIZATION
 * ================================================================ */

function normalizeLanguage(
  language
) {

  const value =
    String(
      language || ""
    )
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

    capitalize(
      value
    )

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

    value.charAt(0)
      .toUpperCase() +

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

  if (
    type === "movie"
  ) {

    return (
      `/play/movie/${tmdbId}?fallback=beta`
    );
  }


  return (
    `/play/tv/${tmdbId}/${season}/${episode}?fallback=beta`
  );
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

    success:
      false,

    status,

    links: [],

    elapsed_ms:
      Date.now() -
      started,

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
    typeof data ===
      "string"
  ) {

    return data.slice(
      0,
      500
    );
  }


  if (

    data &&

    typeof data ===
      "object"

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

    typeof value ===
      "object" &&

    !Array.isArray(
      value
    )

  )

    ? Object.keys(
        value
      )

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