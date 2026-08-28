/*
|--------------------------------------------------------------------------
| WORKER
|--------------------------------------------------------------------------
|
| FLUJO
|
| Alpha = Supabase / BD
| Beta  = Scraper
|
| Alpha se procesa primero y sus resultados se envían inmediatamente
| mediante SSE.
|
| Beta continúa después y sus resultados se envían mediante otro evento
| SSE, sin obligar al player a esperar para comenzar.
|
|--------------------------------------------------------------------------
| VARIABLES
|--------------------------------------------------------------------------
|
| API_KEY
| SUPABASE_URL
| SUPABASE_ANON_KEY
| SOURCE_URL
|
|--------------------------------------------------------------------------
| KV
|--------------------------------------------------------------------------
|
| CACHE_KV
|
|--------------------------------------------------------------------------
*/


const ALPHA_NAME = "Alpha";
const BETA_NAME = "Beta";

const CACHE_TTL = 60 * 60 * 6;


/*
|--------------------------------------------------------------------------
| SERVIDORES BLOQUEADOS
|--------------------------------------------------------------------------
*/

const BLACKLISTED_SERVERS = new Set([
  "servidortrinity",
  "servidormahoutokoro",
  "servidordeathstar",
  "servidorgoldmember",
  "powvideo",
  "streamplay"
]);


/*
|--------------------------------------------------------------------------
| HEADERS
|--------------------------------------------------------------------------
*/

const JSON_HEADERS = {
  "content-type": "application/json; charset=UTF-8",
  "cache-control": "no-store, no-cache, must-revalidate",
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "Content-Type, Authorization",
  "access-control-allow-methods": "GET, OPTIONS"
};


const SSE_HEADERS = {
  "content-type": "text/event-stream; charset=UTF-8",
  "cache-control": "no-cache, no-store, must-revalidate",
  "connection": "keep-alive",
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "Content-Type, Authorization",
  "access-control-allow-methods": "GET, OPTIONS",
  "x-accel-buffering": "no"
};


/*
|--------------------------------------------------------------------------
| JSON
|--------------------------------------------------------------------------
*/

function json(data, status = 200) {
  return new Response(
    JSON.stringify(data, null, 2),
    {
      status,
      headers: JSON_HEADERS
    }
  );
}


/*
|--------------------------------------------------------------------------
| NORMALIZAR SERVIDOR
|--------------------------------------------------------------------------
*/

function normalizeServerName(name) {
  return String(name || "")
    .trim()
    .toLowerCase()
    .replace(/_\d+$/, "");
}


function isBlacklistedServer(name) {
  return BLACKLISTED_SERVERS.has(
    normalizeServerName(name)
  );
}


/*
|--------------------------------------------------------------------------
| NORMALIZAR IDIOMA
|--------------------------------------------------------------------------
*/

function normalizeLanguage(language) {

  const value =
    String(language || "")
      .trim()
      .toLowerCase();

  if (
    value === "latino" ||
    value === "latin" ||
    value === "español latino" ||
    value === "espanol latino"
  ) {
    return "Latino";
  }

  if (
    value === "castellano" ||
    value === "español" ||
    value === "espanol"
  ) {
    return "Castellano";
  }

  if (
    value === "subtitulado" ||
    value === "subtitle" ||
    value === "sub"
  ) {
    return "Subtitulado";
  }

  if (!value) {
    return "Desconocido";
  }

  return (
    value.charAt(0).toUpperCase() +
    value.slice(1)
  );
}


/*
|--------------------------------------------------------------------------
| EXTRAER URLS
|--------------------------------------------------------------------------
*/

function extractUrls(value) {

  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter(
    item =>
      typeof item === "string" &&
      /^https?:\/\//i.test(item)
  );
}


/*
|--------------------------------------------------------------------------
| PROCESAR ALL_EMBEDS
|--------------------------------------------------------------------------
*/

function processLanguageObject(
  languageName,
  languageObject,
  output,
  seen
) {

  if (
    !languageObject ||
    typeof languageObject !== "object"
  ) {
    return;
  }

  for (
    const [
      rawServerName,
      rawValue
    ] of Object.entries(languageObject)
  ) {

    if (
      isBlacklistedServer(rawServerName)
    ) {
      continue;
    }

    const urls =
      extractUrls(rawValue);

    if (!urls.length) {
      continue;
    }

    const idioma =
      normalizeLanguage(languageName);

    const servidor =
      String(rawServerName || "").trim();

    for (const url of urls) {

      const key =
        `${url}|${idioma}`;

      if (seen.has(key)) {
        continue;
      }

      seen.add(key);

      output.push({
        url_embed: url,
        servidor,
        idioma
      });
    }
  }
}


/*
|--------------------------------------------------------------------------
| EXTRAER LINKS DEL SCRAPER
|--------------------------------------------------------------------------
|
| Soporta:
|
| embeds
| all_embeds
|
|--------------------------------------------------------------------------
*/

function extractScraperLinks(data) {

  const links = [];
  const seen = new Set();


  /*
  |--------------------------------------------------------------------------
  | all_embeds
  |--------------------------------------------------------------------------
  */

  if (
    data &&
    data.all_embeds &&
    typeof data.all_embeds === "object"
  ) {

    for (
      const [
        language,
        languageObject
      ] of Object.entries(data.all_embeds)
    ) {

      processLanguageObject(
        language,
        languageObject,
        links,
        seen
      );
    }
  }


  /*
  |--------------------------------------------------------------------------
  | embeds
  |--------------------------------------------------------------------------
  */

  if (
    data &&
    data.embeds &&
    typeof data.embeds === "object"
  ) {

    const idioma =
      normalizeLanguage(data.language);

    for (
      const [
        rawServerName,
        rawValue
      ] of Object.entries(data.embeds)
    ) {

      if (
        isBlacklistedServer(rawServerName)
      ) {
        continue;
      }

      const urls =
        extractUrls(rawValue);

      if (!urls.length) {
        continue;
      }

      for (const url of urls) {

        const key =
          `${url}|${idioma}`;

        if (seen.has(key)) {
          continue;
        }

        seen.add(key);

        links.push({
          url_embed: url,
          servidor:
            String(rawServerName || "").trim(),
          idioma
        });
      }
    }
  }

  return links;
}


/*
|--------------------------------------------------------------------------
| NORMALIZAR LINKS DE SUPABASE
|--------------------------------------------------------------------------
*/

function normalizeDatabaseLinks(rows) {

  if (!Array.isArray(rows)) {
    return [];
  }

  const output = [];
  const seen = new Set();

  for (const item of rows) {

    if (
      !item ||
      typeof item.url_embed !== "string"
    ) {
      continue;
    }

    const url =
      item.url_embed.trim();

    if (
      !/^https?:\/\//i.test(url)
    ) {
      continue;
    }

    const servidor =
      String(
        item.servidor ||
        "Desconocido"
      ).trim();

    if (
      isBlacklistedServer(servidor)
    ) {
      continue;
    }

    const idioma =
      normalizeLanguage(item.idioma);

    const key =
      `${url}|${idioma}`;

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);

    output.push({
      url_embed: url,
      servidor,
      idioma
    });
  }

  return output;
}


/*
|--------------------------------------------------------------------------
| CACHE KEY
|--------------------------------------------------------------------------
*/

function buildCacheKey(
  tmdbId,
  type,
  season,
  episode
) {

  return [
    "alpha-db",
    String(tmdbId),
    type,
    String(season || 0),
    String(episode || 0)
  ].join(":");
}


/*
|--------------------------------------------------------------------------
| FETCH ALPHA
|--------------------------------------------------------------------------
|
| Alpha = Supabase
|
| SOLO LECTURA
|
|--------------------------------------------------------------------------
*/

async function fetchAlpha(
  env,
  tmdbId,
  type,
  season,
  episode
) {

  const started = Date.now();

  const cacheKey =
    buildCacheKey(
      tmdbId,
      type,
      season,
      episode
    );


  /*
  |--------------------------------------------------------------------------
  | CONFIG
  |--------------------------------------------------------------------------
  */

  if (
    !env.SUPABASE_URL ||
    !env.SUPABASE_ANON_KEY
  ) {

    return {
      success: false,
      source: ALPHA_NAME,
      found: 0,
      links: [],
      cache: "disabled",
      elapsed_ms:
        Date.now() - started,
      error:
        "SUPABASE_URL o SUPABASE_ANON_KEY no está configurado."
    };
  }


  /*
  |--------------------------------------------------------------------------
  | CACHE HIT
  |--------------------------------------------------------------------------
  */

  if (env.CACHE_KV) {

    try {

      const cached =
        await env.CACHE_KV.get(
          cacheKey,
          "json"
        );

      if (
        cached &&
        Array.isArray(cached.links)
      ) {

        return {
          success: true,
          source: ALPHA_NAME,
          found: cached.links.length,
          links: cached.links,
          cache: "hit",
          elapsed_ms:
            Date.now() - started
        };
      }

    } catch (_) {
      // Continuar con Supabase.
    }
  }


  /*
  |--------------------------------------------------------------------------
  | SUPABASE REST
  |--------------------------------------------------------------------------
  */

  let endpoint;

  try {

    const base =
      new URL(env.SUPABASE_URL);

    endpoint =
      new URL(
        "/rest/v1/enlaces",
        base
      );

  } catch (error) {

    return {
      success: false,
      source: ALPHA_NAME,
      found: 0,
      links: [],
      cache: "miss",
      elapsed_ms:
        Date.now() - started,
      error:
        error?.message ||
        String(error)
    };
  }


  /*
  |--------------------------------------------------------------------------
  | FILTROS
  |--------------------------------------------------------------------------
  */

  endpoint.searchParams.set(
    "tmdb_id",
    `eq.${String(tmdbId)}`
  );

  endpoint.searchParams.set(
    "tipo",
    `eq.${type}`
  );

  endpoint.searchParams.set(
    "temporada",
    `eq.${String(season || 0)}`
  );

  endpoint.searchParams.set(
    "episodio",
    `eq.${String(episode || 0)}`
  );

  endpoint.searchParams.set(
    "order",
    "id.asc"
  );


  /*
  |--------------------------------------------------------------------------
  | REQUEST
  |--------------------------------------------------------------------------
  */

  try {

    const response =
      await fetch(
        endpoint.toString(),
        {
          method: "GET",
          headers: {
            "Accept":
              "application/json",
            "apikey":
              env.SUPABASE_ANON_KEY,
            "Authorization":
              `Bearer ${env.SUPABASE_ANON_KEY}`
          }
        }
      );


    const text =
      await response.text();


    if (!response.ok) {

      return {
        success: false,
        source: ALPHA_NAME,
        found: 0,
        links: [],
        cache: "miss",
        http_code:
          response.status,
        elapsed_ms:
          Date.now() - started,
        error:
          `Supabase respondió HTTP ${response.status}`,
        raw:
          text.slice(0, 1000)
      };
    }


    let rows;

    try {

      rows =
        JSON.parse(text);

    } catch (_) {

      return {
        success: false,
        source: ALPHA_NAME,
        found: 0,
        links: [],
        cache: "miss",
        http_code:
          response.status,
        elapsed_ms:
          Date.now() - started,
        error:
          "Supabase devolvió una respuesta que no es JSON.",
        raw:
          text.slice(0, 1000)
      };
    }


    const links =
      normalizeDatabaseLinks(rows);


    /*
    |--------------------------------------------------------------------------
    | GUARDAR CACHE
    |--------------------------------------------------------------------------
    */

    if (env.CACHE_KV) {

      try {

        await env.CACHE_KV.put(
          cacheKey,
          JSON.stringify({
            links
          }),
          {
            expirationTtl:
              CACHE_TTL
          }
        );

      } catch (_) {
        // No bloquear por fallo de KV.
      }
    }


    return {
      success: true,
      source: ALPHA_NAME,
      found: links.length,
      links,
      cache: "miss",
      http_code:
        response.status,
      elapsed_ms:
        Date.now() - started
    };

  } catch (error) {

    return {
      success: false,
      source: ALPHA_NAME,
      found: 0,
      links: [],
      cache: "miss",
      http_code: 0,
      elapsed_ms:
        Date.now() - started,
      error:
        error?.message ||
        String(error)
    };
  }
}


/*
|--------------------------------------------------------------------------
| CONSTRUIR URL BETA
|--------------------------------------------------------------------------
|
| Si SOURCE_URL no contiene /embed/api.php,
| se agrega automáticamente.
|--------------------------------------------------------------------------
*/

function buildBetaUrl(
  sourceUrl,
  tmdbId,
  type,
  season,
  episode
) {

  let base =
    String(sourceUrl || "").trim();

  if (!base) {

    throw new Error(
      "SOURCE_URL no está configurado."
    );
  }


  /*
  |--------------------------------------------------------------------------
  | /embed/api.php
  |--------------------------------------------------------------------------
  */

  if (
    !base.includes("/embed/api.php")
  ) {

    base =
      base.replace(/\/+$/, "") +
      "/embed/api.php";
  }


  const endpoint =
    new URL(base);


  /*
  |--------------------------------------------------------------------------
  | Parámetros
  |--------------------------------------------------------------------------
  */

  endpoint.searchParams.set(
    "action",
    "details"
  );

  endpoint.searchParams.set(
    "id",
    String(tmdbId)
  );

  endpoint.searchParams.set(
    "type",
    type
  );


  if (type === "tv") {

    endpoint.searchParams.set(
      "season",
      String(season)
    );

    endpoint.searchParams.set(
      "episode",
      String(episode)
    );
  }


  return endpoint.toString();
}


/*
|--------------------------------------------------------------------------
| FETCH BETA
|--------------------------------------------------------------------------
*/

async function fetchBeta(
  env,
  tmdbId,
  type,
  season,
  episode
) {

  const started = Date.now();

  let endpoint;

  try {

    endpoint =
      buildBetaUrl(
        env.SOURCE_URL,
        tmdbId,
        type,
        season,
        episode
      );

  } catch (error) {

    return {
      success: false,
      source: BETA_NAME,
      found: 0,
      links: [],
      elapsed_ms:
        Date.now() - started,
      error:
        error?.message ||
        String(error)
    };
  }


  try {

    const response =
      await fetch(
        endpoint,
        {
          method: "GET",
          headers: {
            "Accept":
              "application/json",
            "User-Agent":
              "TON-Scraper-Worker/1.0"
          }
        }
      );


    const contentType =
      response.headers.get(
        "content-type"
      ) || "";


    const text =
      await response.text();


    if (!response.ok) {

      return {
        success: false,
        source: BETA_NAME,
        found: 0,
        links: [],
        http_code:
          response.status,
        content_type:
          contentType,
        elapsed_ms:
          Date.now() - started,
        error:
          `Beta respondió HTTP ${response.status}`,
        raw:
          text.slice(0, 1000)
      };
    }


    let data;

    try {

      data =
        JSON.parse(text);

    } catch (_) {

      return {
        success: false,
        source: BETA_NAME,
        found: 0,
        links: [],
        http_code:
          response.status,
        content_type:
          contentType,
        elapsed_ms:
          Date.now() - started,
        error:
          "Beta devolvió una respuesta no JSON.",
        raw:
          text.slice(0, 1000)
      };
    }


    const links =
      extractScraperLinks(data);


    return {
      success: true,
      source: BETA_NAME,
      found: links.length,
      links,
      http_code:
        response.status,
      content_type:
        contentType,
      elapsed_ms:
        Date.now() - started
    };

  } catch (error) {

    return {
      success: false,
      source: BETA_NAME,
      found: 0,
      links: [],
      http_code: 0,
      elapsed_ms:
        Date.now() - started,
      error:
        error?.message ||
        String(error)
    };
  }
}


/*
|--------------------------------------------------------------------------
| SSE
|--------------------------------------------------------------------------
*/

function createSSE() {

  const encoder =
    new TextEncoder();

  let controller = null;


  const stream =
    new ReadableStream({

      start(c) {
        controller = c;
      },

      cancel() {
        controller = null;
      }
    });


  function send(event, data) {

    if (!controller) {
      return;
    }


    const payload =
      `event: ${event}\n` +
      `data: ${JSON.stringify(data)}\n\n`;


    try {

      controller.enqueue(
        encoder.encode(payload)
      );

    } catch (_) {

      controller = null;
    }
  }


  function close() {

    if (!controller) {
      return;
    }

    try {
      controller.close();
    } catch (_) {}

    controller = null;
  }


  return {
    stream,
    send,
    close
  };
}


/*
|--------------------------------------------------------------------------
| WORKER
|--------------------------------------------------------------------------
*/

export default {

  async fetch(
    request,
    env,
    ctx
  ) {

    const url =
      new URL(request.url);


    /*
    |--------------------------------------------------------------------------
    | OPTIONS
    |--------------------------------------------------------------------------
    */

    if (
      request.method === "OPTIONS"
    ) {

      return new Response(
        null,
        {
          status: 204,
          headers: JSON_HEADERS
        }
      );
    }


    /*
    |--------------------------------------------------------------------------
    | GET
    |--------------------------------------------------------------------------
    */

    if (
      request.method !== "GET"
    ) {

      return json(
        {
          success: false,
          status:
            "method_not_allowed",
          event:
            "complete"
        },
        405
      );
    }


    /*
    |--------------------------------------------------------------------------
    | HEALTH
    |--------------------------------------------------------------------------
    */

    if (
      url.pathname === "/"
    ) {

      return json({
        success: true,
        status: "online",
        worker:
          "TON Scraper API"
      });
    }


    /*
    |--------------------------------------------------------------------------
    | API KEY
    |--------------------------------------------------------------------------
    */

    if (env.API_KEY) {

      const authorization =
        request.headers.get(
          "Authorization"
        ) || "";


      const suppliedKey =
        authorization.startsWith(
          "Bearer "
        )
          ? authorization
              .slice(7)
              .trim()
          : url.searchParams.get(
              "key"
            );


      if (
        suppliedKey !== env.API_KEY
      ) {

        return json(
          {
            success: false,
            status:
              "unauthorized",
            event:
              "complete",
            message:
              "API key inválida o ausente."
          },
          401
        );
      }
    }


    /*
    |--------------------------------------------------------------------------
    | RUTA
    |--------------------------------------------------------------------------
    |
    | /play/movie/44956
    |
    | /play/tv/1399/1/1
    |--------------------------------------------------------------------------
    */

    const parts =
      url.pathname
        .split("/")
        .filter(Boolean);


    if (
      parts[0] !== "play"
    ) {

      return json(
        {
          success: false,
          status:
            "not_found",
          event:
            "complete"
        },
        404
      );
    }


    const type =
      parts[1];


    if (
      type !== "movie" &&
      type !== "tv"
    ) {

      return json(
        {
          success: false,
          status:
            "invalid_type",
          event:
            "complete"
        },
        400
      );
    }


    const tmdbId =
      parts[2];


    if (!tmdbId) {

      return json(
        {
          success: false,
          status:
            "missing_tmdb_id",
          event:
            "complete"
        },
        400
      );
    }


    let season = 0;
    let episode = 0;


    if (type === "tv") {

      season =
        Number(parts[3] || 0);

      episode =
        Number(parts[4] || 0);


      if (
        !season ||
        !episode
      ) {

        return json(
          {
            success: false,
            status:
              "invalid_episode",
            event:
              "complete"
          },
          400
        );
      }
    }


    /*
    |--------------------------------------------------------------------------
    | SOURCE_URL
    |--------------------------------------------------------------------------
    */

    if (!env.SOURCE_URL) {

      return json(
        {
          success: false,
          status:
            "source_url_missing",
          event:
            "complete",
          message:
            "El Secret SOURCE_URL no está configurado."
        },
        500
      );
    }


    /*
    |--------------------------------------------------------------------------
    | SSE
    |--------------------------------------------------------------------------
    */

    const sse =
      createSSE();


    /*
    |--------------------------------------------------------------------------
    | PROCESO
    |--------------------------------------------------------------------------
    */

    ctx.waitUntil(
      (async () => {

        let alpha = null;
        let beta = null;


        try {

          /*
          |--------------------------------------------------------------------------
          | TMDB
          |--------------------------------------------------------------------------
          */

          sse.send(
            "tmdb_receiving",
            {
              success: true,
              status:
                "tmdb_receiving",
              message:
                "Recibiendo datos de TMDB",
              tmdb_id:
                tmdbId,
              type,
              season,
              episode
            }
          );


          sse.send(
            "tmdb_received",
            {
              success: true,
              status:
                "tmdb_received",
              message:
                "Datos de TMDB recibidos",
              tmdb_id:
                tmdbId,
              type,
              season,
              episode
            }
          );


          /*
          |--------------------------------------------------------------------------
          | SEARCHING
          |--------------------------------------------------------------------------
          */

          sse.send(
            "searching",
            {
              success: true,
              status:
                "searching",
              message:
                "Buscando servidores"
            }
          );


          /*
          |--------------------------------------------------------------------------
          | ALPHA
          |--------------------------------------------------------------------------
          */

          sse.send(
            "alpha_search",
            {
              success: true,
              status:
                "searching_alpha",
              source:
                ALPHA_NAME,
              message:
                "Consultando Alpha"
            }
          );


          alpha =
            await fetchAlpha(
              env,
              tmdbId,
              type,
              season,
              episode
            );


          /*
          |--------------------------------------------------------------------------
          | CACHE EVENT
          |--------------------------------------------------------------------------
          */

          if (
            alpha.cache === "hit"
          ) {

            sse.send(
              "alpha_cache_hit",
              {
                success: true,
                status:
                  "alpha_cache_hit",
                source:
                  ALPHA_NAME,
                found:
                  alpha.found,
                message:
                  "Alpha: resultados obtenidos desde caché",
                cache_ttl:
                  CACHE_TTL
              }
            );

          } else if (
            alpha.cache === "miss"
          ) {

            sse.send(
              "alpha_cache_miss",
              {
                success: true,
                status:
                  "alpha_cache_miss",
                source:
                  ALPHA_NAME,
                message:
                  "Alpha: consultando BD"
              }
            );
          }


          /*
          |--------------------------------------------------------------------------
          | ALPHA FOUND
          |--------------------------------------------------------------------------
          |
          | ESTE ES EL MOMENTO IMPORTANTE:
          |
          | Los links de Alpha se envían inmediatamente.
          |
          | El player NO necesita esperar a Beta.
          |--------------------------------------------------------------------------
          */

          if (alpha.success) {

            sse.send(
              "alpha_found",
              {
                success: true,
                status:
                  "alpha_found",
                source:
                  ALPHA_NAME,
                found:
                  alpha.found,
                links:
                  alpha.links,
                cache:
                  alpha.cache,
                elapsed_ms:
                  alpha.elapsed_ms,
                message:
                  `Alpha: ${alpha.found} ${
                    alpha.found === 1
                      ? "servidor encontrado"
                      : "servidores encontrados"
                  }`
              }
            );

          } else {

            sse.send(
              "alpha_found",
              {
                success: false,
                status:
                  "alpha_unavailable",
                source:
                  ALPHA_NAME,
                found: 0,
                links: [],
                cache:
                  alpha.cache,
                elapsed_ms:
                  alpha.elapsed_ms,
                error:
                  alpha.error,
                message:
                  "Alpha no respondió o no encontró servidores"
              }
            );
          }


          /*
          |--------------------------------------------------------------------------
          | BETA
          |--------------------------------------------------------------------------
          |
          | AHORA se inicia después de haber entregado Alpha.
          |
          | Desde el punto de vista del player, Beta trabaja en segundo plano.
          |--------------------------------------------------------------------------
          */

          sse.send(
            "beta_search",
            {
              success: true,
              status:
                "searching_beta",
              source:
                BETA_NAME,
              message:
                "Consultando Beta"
            }
          );


          beta =
            await fetchBeta(
              env,
              tmdbId,
              type,
              season,
              episode
            );


          /*
          |--------------------------------------------------------------------------
          | BETA FOUND
          |--------------------------------------------------------------------------
          |
          | Estos enlaces se agregan al player cuando llegan.
          |--------------------------------------------------------------------------
          */

          if (beta.success) {

            sse.send(
              "beta_found",
              {
                success: true,
                status:
                  "beta_found",
                source:
                  BETA_NAME,
                found:
                  beta.found,
                links:
                  beta.links,
                http_code:
                  beta.http_code,
                content_type:
                  beta.content_type,
                elapsed_ms:
                  beta.elapsed_ms,
                message:
                  `Beta: ${beta.found} ${
                    beta.found === 1
                      ? "servidor encontrado"
                      : "servidores encontrados"
                  }`
              }
            );

          } else {

            sse.send(
              "beta_found",
              {
                success: false,
                status:
                  "beta_unavailable",
                source:
                  BETA_NAME,
                found: 0,
                links: [],
                http_code:
                  beta.http_code || 0,
                content_type:
                  beta.content_type || "",
                elapsed_ms:
                  beta.elapsed_ms,
                error:
                  beta.error,
                message:
                  "Beta no respondió o no encontró servidores"
              }
            );
          }


          /*
          |--------------------------------------------------------------------------
          | SEARCH COMPLETE
          |--------------------------------------------------------------------------
          */

          const alphaLinks =
            alpha &&
            Array.isArray(alpha.links)
              ? alpha.links
              : [];


          const betaLinks =
            beta &&
            Array.isArray(beta.links)
              ? beta.links
              : [];


          /*
          |--------------------------------------------------------------------------
          | TOTAL
          |--------------------------------------------------------------------------
          */

          const total =
            alphaLinks.length +
            betaLinks.length;


          sse.send(
            "search_complete",
            {
              success:
                total > 0,

              status:
                "search_complete",

              alpha_found:
                alphaLinks.length,

              beta_found:
                betaLinks.length,

              found:
                total,

              message:
                "Búsqueda completada"
            }
          );


          /*
          |--------------------------------------------------------------------------
          | COMPLETE
          |--------------------------------------------------------------------------
          |
          | Alpha siempre aparece primero.
          |--------------------------------------------------------------------------
          */

          sse.send(
            "complete",
            {
              success:
                total > 0,

              status:
                total > 0
                  ? "success"
                  : "source_unavailable",

              event:
                "complete",

              source:
                ALPHA_NAME,

              fallback:
                BETA_NAME,

              tmdb_id:
                tmdbId,

              type,

              season,

              episode,

              alpha_found:
                alphaLinks.length,

              beta_found:
                betaLinks.length,

              found:
                total,

              /*
              |--------------------------------------------------------------
              | IMPORTANTE
              |
              | Alpha primero.
              | Beta después.
              |--------------------------------------------------------------
              */

              links: [
                ...alphaLinks,
                ...betaLinks
              ],

              alpha_cache:
                alpha?.cache ||
                "disabled",

              alpha_error:
                alpha?.success
                  ? null
                  : alpha?.error || null,

              beta_error:
                beta?.success
                  ? null
                  : beta?.error || null,

              message:
                total > 0
                  ? "Búsqueda completada correctamente."
                  : "Alpha y Beta no devolvieron servidores válidos."
            }
          );


        } catch (error) {

          sse.send(
            "complete",
            {
              success: false,
              status:
                "internal_error",
              event:
                "complete",
              tmdb_id:
                tmdbId,
              type,
              season,
              episode,
              alpha_found:
                alpha?.found || 0,
              beta_found:
                beta?.found || 0,
              found: 0,
              links: [],
              message:
                "Error interno del Worker.",
              error:
                error?.message ||
                String(error)
            }
          );

        } finally {

          sse.close();
        }

      })()
    );


    /*
    |--------------------------------------------------------------------------
    | RESPUESTA
    |--------------------------------------------------------------------------
    */

    return new Response(
      sse.stream,
      {
        status: 200,
        headers:
          SSE_HEADERS
      }
    );
  }
};