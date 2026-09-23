/*
 * ==========================================================
 * TONPLAYER FINDER WORKER
 *
 * Alpha = Supabase
 * Beta  = scraper
 *
 * Flujo normal:
 *   Alpha (KV -> Supabase)
 *      ↓
 *   si no encuentra
 *      ↓
 *   Beta (KV -> scraper)
 *
 * SIN SSE
 *
 * KV:
 *   ALPHA_KV -> Alpha, TTL 6h
 *   BETA_KV  -> Beta,  TTL 6h
 *
 * Variables:
 *   SUPABASE_URL
 *   SUPABASE_ANON_KEY
 *   SOURCE_URL
 *
 * Bindings:
 *   ALPHA_KV
 *   BETA_KV
 * ==========================================================
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


/*
 * ==========================================================
 * ENTRY
 * ==========================================================
 */

export default {
  async fetch(request, env, ctx) {

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: CORS
      });
    }

    if (request.method !== "GET") {
      return jsonResponse({
        success: false,
        status: "method_not_allowed"
      }, 405);
    }

    try {
      return await router(request, env, ctx);

    } catch (err) {

      console.error(err);

      return jsonResponse({
        success: false,
        status: "worker_error",
        error: err?.message || String(err)
      }, 500);
    }
  }
};


/*
 * ==========================================================
 * ROUTER
 * ==========================================================
 */

async function router(request, env, ctx) {

  const url = new URL(request.url);

  const path = url.pathname.replace(/\/+$/, "");

  /*
   * HEALTH
   */

  if (path === "/health") {

    return jsonResponse({
      success: true,
      status: "online",
      service: "tonplayer-finder"
    });
  }


  /*
   * QUERY PARAMETERS
   */

  const fallbackBeta =
    isBetaFallback(
      url.searchParams.get("fallback")
    );

  const force =
    isTrue(
      url.searchParams.get("force")
    );


  /*
   * MOVIE
   */

  let match =
    path.match(/^\/play\/movie\/(\d+)$/);

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

  match =
    path.match(/^\/play\/tv\/(\d+)\/(\d+)\/(\d+)$/);

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
   * NOT FOUND
   */

  return jsonResponse({
    success: false,
    status: "not_found"
  }, 404);
}


/*
 * ==========================================================
 * MAIN CONTENT FLOW
 * ==========================================================
 */

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
   * ========================================================
   * FORCE BETA
   * ========================================================
   */

  if (fallbackBeta) {

    const betaResult = await runBeta({
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
        (betaResult.links || [])
          .filter(isValidLink)
      );

    return jsonResponse({

      success: betaLinks.length > 0,

      status:
        betaLinks.length > 0
          ? "success"
          : "source_unavailable",

      source: "Beta",

      fallback: null,

      tmdb_id: tmdbId,

      type,

      season,

      episode,

      alpha_found: 0,

      beta_found: betaLinks.length,

      beta_queried: true,

      found: betaLinks.length,

      links: betaLinks,

      beta_cache:
        betaResult.cache_status || "miss",

      beta_error:
        betaResult.error || null

    });
  }


  /*
   * ========================================================
   * ALPHA
   * ========================================================
   */

  const alphaKey =
    buildAlphaCacheKey(
      type,
      tmdbId,
      season,
      episode
    );


  let alpha = null;

  let alphaCacheStatus = "miss";


  /*
   * ALPHA KV
   */

  if (!force && env.ALPHA_KV) {

    const cached =
      await env.ALPHA_KV.get(
        alphaKey,
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

        alphaCacheStatus = "hit";

        alpha = {

          success: true,

          links,

          elapsed_ms: 0,

          error: null,

          mode: "kv"
        };
      }
    }
  }


  /*
   * ALPHA -> SUPABASE
   */

  if (!alpha) {

    alpha =
      await fetchAlphaFromSupabase({
        env,
        tmdbId,
        type,
        season,
        episode
      });


    /*
     * CACHE POSITIVE RESULT
     */

    if (
      env.ALPHA_KV &&
      alpha.success &&
      alpha.links.length > 0
    ) {

      ctx.waitUntil(

        env.ALPHA_KV.put(

          alphaKey,

          JSON.stringify({

            links: alpha.links,

            cached_at: Date.now()

          }),

          {
            expirationTtl:
              ALPHA_CACHE_TTL
          }
        )
      );
    }
  }


  /*
   * NORMALIZE ALPHA
   */

  const alphaLinks =
    deduplicateLinks(
      (alpha.links || [])
        .filter(isValidLink)
    );


  /*
   * ========================================================
   * ALPHA FOUND
   * ========================================================
   */

  if (alphaLinks.length > 0) {

    return jsonResponse({

      success: true,

      status: "success",

      source: "Alpha",

      fallback: "Beta",

      tmdb_id: tmdbId,

      type,

      season,

      episode,

      alpha_found:
        alphaLinks.length,

      beta_found: 0,

      beta_queried: false,

      found:
        alphaLinks.length,

      links: alphaLinks,

      alpha_cache:
        alphaCacheStatus,

      alpha_error:
        alpha.error || null

    });
  }


  /*
   * ========================================================
   * ALPHA EMPTY -> BETA
   * ========================================================
   */

  const betaResult =
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
      (betaResult.links || [])
        .filter(isValidLink)
    );


  /*
   * ========================================================
   * FINAL BETA RESPONSE
   * ========================================================
   */

  return jsonResponse({

    success:
      betaLinks.length > 0,

    status:
      betaLinks.length > 0
        ? "success"
        : "source_unavailable",

    source: "Beta",

    fallback: null,

    tmdb_id: tmdbId,

    type,

    season,

    episode,

    alpha_found: 0,

    beta_found:
      betaLinks.length,

    beta_queried: true,

    found:
      betaLinks.length,

    links:
      betaLinks,

    alpha_cache:
      alphaCacheStatus,

    alpha_error:
      alpha.error || null,

    beta_cache:
      betaResult.cache_status || "miss",

    beta_error:
      betaResult.error || null

  });
}


/*
 * ==========================================================
 * BETA
 * ==========================================================
 */

async function runBeta({
  env,
  ctx,
  tmdbId,
  type,
  season,
  episode,
  force
}) {

  const betaKey =
    buildBetaCacheKey(
      type,
      tmdbId,
      season,
      episode
    );


  let beta = null;

  let betaCacheStatus = "miss";


  /*
   * BETA KV
   */

  if (!force && env.BETA_KV) {

    const cached =
      await env.BETA_KV.get(
        betaKey,
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

        betaCacheStatus = "hit";

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


  /*
   * SCRAPER
   */

  if (!beta) {

    beta =
      await scrapeBeta({

        env,

        tmdbId,

        type,

        season,

        episode

      });


    const links =
      beta.success

        ? deduplicateLinks(
            (beta.links || [])
              .filter(isValidLink)
          )

        : [];


    beta.links = links;


    /*
     * CACHE ONLY POSITIVE RESULTS
     */

    if (
      env.BETA_KV &&
      links.length > 0
    ) {

      ctx.waitUntil(

        env.BETA_KV.put(

          betaKey,

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
  }


  return {

    ...beta,

    links:
      deduplicateLinks(
        (beta.links || [])
          .filter(isValidLink)
      ),

    cache_status:
      betaCacheStatus

  };
}


/*
 * ==========================================================
 * ALPHA / SUPABASE
 * ==========================================================
 */

async function fetchAlphaFromSupabase({
  env,
  tmdbId,
  type,
  season,
  episode
}) {

  const started =
    Date.now();


  /*
   * CONFIG CHECK
   */

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
    env.SUPABASE_URL
      .replace(/\/+$/, "");


  const params =
    new URLSearchParams();


  /*
   * IMPORTANT:
   * calidad incluida.
   */

  params.set(

    "select",

    "tmdb_id,tipo,url_embed,servidor,idioma,calidad,temporada,episodio"

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

      err?.message ||
        String(err),

      started

    );
  }


  const contentType =
    response.headers
      .get("content-type") || "";


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
        ),

      calidad:
        normalizeQuality(
          row.calidad ||
            "Desconocida"
        )

    });
  }


  const unique =
    deduplicateLinks(links);


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


/*
 * ==========================================================
 * BETA / SCRAPER
 * ==========================================================
 */

async function scrapeBeta({
  env,
  tmdbId,
  type,
  season,
  episode
}) {

  const started =
    Date.now();


  if (!env.SOURCE_URL) {

    return failure(

      "not_configured",

      "SOURCE_URL no está configurado.",

      started

    );
  }


  const base =
    env.SOURCE_URL
      .replace(/\/+$/, "");


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

    response =
      await fetch(

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
              "AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36"

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
    response.headers
      .get("content-type") || "";


  const text =
    await response.text();


  let data;


  try {

    data =
      JSON.parse(text);

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

      raw_keys: [],

      parser: null,

      error:
        response.ok

          ? "Beta devolvió una respuesta que no es JSON."

          : `Beta respondió HTTP ${response.status}.`

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

      raw_keys:
        objectKeys(data),

      parser: null,

      error:
        extractErrorMessage(data)

    };
  }


  const rawKeys =
    objectKeys(data);


  /*
   * ========================================================
   * ALL_EMBEDS
   * ========================================================
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
   * ========================================================
   * EMBEDS FALLBACK
   * ========================================================
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
          data.language ||
            "latino"
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
        "Beta respondió JSON pero no quedaron URLs válidas."

    };
  }


  /*
   * NO EMBEDS
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
      "Beta devolvió JSON pero no contiene all_embeds ni embeds."

  };
}


/*
 * ==========================================================
 * EXTRACTION
 * ==========================================================
 */

function extractAllEmbeds(allEmbeds) {

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


      for (const url of urls) {

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

          idioma,

          calidad:
            "Desconocida"

        });
      }
    }
  }


  return deduplicateLinks(
    result
  );
}


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


    for (const url of urls) {

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

        idioma,

        calidad:
          "Desconocida"

      });
    }
  }


  return deduplicateLinks(
    result
  );
}


/*
 * ==========================================================
 * DIAGNOSTICS
 * ==========================================================
 */

function countAllEmbeds(allEmbeds) {

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


      for (const url of list) {

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


function countEmbeds(embeds) {

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


    for (const url of list) {

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


/*
 * ==========================================================
 * DEDUPLICATION
 * ==========================================================
 */

function deduplicateLinks(links) {

  const map =
    new Map();


  for (const link of links) {

    if (
      !isValidLink(link)
    ) {
      continue;
    }


    const key =
      `${normalizeKey(link.idioma)}|` +
      `${normalizeKey(link.servidor)}`;


    if (!map.has(key)) {

      map.set(
        key,
        link
      );
    }
  }


  const result =
    Array.from(
      map.values()
    );


  /*
   * Vimeus primero
   */

  result.sort(
    (a, b) => {

      const aPriority =
        normalizeKey(
          a.servidor
        ) === "vimeus"
          ? 0
          : 1;


      const bPriority =
        normalizeKey(
          b.servidor
        ) === "vimeus"
          ? 0
          : 1;


      return (
        aPriority -
        bPriority
      );
    }
  );


  return result;
}


/*
 * ==========================================================
 * VALIDATION
 * ==========================================================
 */

function isValidLink(link) {

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


function normalizeKey(value) {

  return String(
    value || ""
  )
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(
      /[\u0300-\u036f]/g,
      ""
    )
    .replace(
      /[\s_-]+/g,
      ""
    );
}


function isHttpUrl(value) {

  return (

    typeof value === "string" &&

    /^https?:\/\//i.test(value)

  );
}


function isBlacklisted(server) {

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


/*
 * ==========================================================
 * NORMALIZATION
 * ==========================================================
 */

function normalizeServerName(server) {

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
      "Vimeus"

  };


  return (
    map[base] ||
    capitalize(base)
  );
}


function normalizeLanguage(language) {

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


function normalizeQuality(quality) {

  const value =
    String(quality || "")
      .trim()
      .toLowerCase();


  if (!value) {
    return "Desconocida";
  }


  const map = {

    "2160p":
      "2160p",

    "4k":
      "2160p",

    "uhd":
      "2160p",

    "1080p":
      "1080p",

    "fullhd":
      "1080p",

    "full hd":
      "1080p",

    "720p":
      "720p",

    "hd":
      "720p",

    "480p":
      "480p",

    "360p":
      "360p"

  };


  return (
    map[value] ||
    String(quality)
      .trim()
  );
}


function capitalize(value) {

  if (!value) {
    return "Desconocido";
  }


  return (
    value.charAt(0)
      .toUpperCase() +
    value.slice(1)
  );
}


/*
 * ==========================================================
 * CACHE KEYS
 * ==========================================================
 */

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


/*
 * ==========================================================
 * HELPERS
 * ==========================================================
 */

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


function extractErrorMessage(data) {

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

    String(value || "")
      .trim()
      .toLowerCase()

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

    String(value || "")
      .trim()
      .toLowerCase()

  );
}


/*
 * ==========================================================
 * JSON RESPONSE
 * ==========================================================
 */

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