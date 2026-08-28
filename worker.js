/*
|--------------------------------------------------------------------------
| TON SCRAPER API
|--------------------------------------------------------------------------
|
| FLUJO ACTUAL
|
| 1. Recibe TMDB ID
| 2. Consulta Alpha = Supabase / BD
| 3. Alpha utiliza caché KV de 6 horas
| 4. Aunque Alpha encuentre enlaces, SIEMPRE consulta Beta
| 5. Beta = scraper externo
| 6. Alpha aparece primero en la respuesta
| 7. Beta se agrega después
| 8. Se filtran servidores blacklist
| 9. Se eliminan duplicados
| 10. Devuelve todos los enlaces válidos
|
|--------------------------------------------------------------------------
| SECRETS / VARIABLES
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
| Servidores bloqueados
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
| Headers JSON
|--------------------------------------------------------------------------
*/

const JSON_HEADERS = {
  "content-type":
    "application/json; charset=UTF-8",

  "cache-control":
    "no-store, no-cache, must-revalidate",

  "access-control-allow-origin":
    "*",

  "access-control-allow-headers":
    "Content-Type, Authorization",

  "access-control-allow-methods":
    "GET, OPTIONS"
};


/*
|--------------------------------------------------------------------------
| Headers SSE
|--------------------------------------------------------------------------
*/

const SSE_HEADERS = {
  "content-type":
    "text/event-stream; charset=UTF-8",

  "cache-control":
    "no-cache, no-store, must-revalidate",

  "connection":
    "keep-alive",

  "access-control-allow-origin":
    "*",

  "access-control-allow-headers":
    "Content-Type, Authorization",

  "access-control-allow-methods":
    "GET, OPTIONS",

  "x-accel-buffering":
    "no"
};


/*
|--------------------------------------------------------------------------
| JSON helper
|--------------------------------------------------------------------------
*/

function json(data, status = 200) {

  return new Response(
    JSON.stringify(
      data,
      null,
      2
    ),
    {
      status,
      headers:
        JSON_HEADERS
    }
  );
}


/*
|--------------------------------------------------------------------------
| Normalizar servidor
|--------------------------------------------------------------------------
*/

function normalizeServerName(name) {

  return String(name || "")
    .trim()
    .toLowerCase()
    .replace(/_\d+$/, "");
}


/*
|--------------------------------------------------------------------------
| Comprobar blacklist
|--------------------------------------------------------------------------
*/

function isBlacklistedServer(name) {

  return BLACKLISTED_SERVERS.has(
    normalizeServerName(name)
  );
}


/*
|--------------------------------------------------------------------------
| Normalizar idioma
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

  return value
    ? value.charAt(0).toUpperCase() +
      value.slice(1)
    : "Desconocido";
}


/*
|--------------------------------------------------------------------------
| Extraer URLs
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
| Procesar estructura de idioma
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
    ] of Object.entries(
      languageObject
    )
  ) {

    if (
      isBlacklistedServer(
        rawServerName
      )
    ) {
      continue;
    }

    const urls =
      extractUrls(rawValue);

    if (!urls.length) {
      continue;
    }

    const idioma =
      normalizeLanguage(
        languageName
      );

    const servidor =
      String(rawServerName || "")
        .trim();

    for (const url of urls) {

      const duplicateKey =
        `${url}|${idioma}`;

      if (
        seen.has(duplicateKey)
      ) {
        continue;
      }

      seen.add(
        duplicateKey
      );

      output.push({
        url_embed:
          url,

        servidor:
          servidor,

        idioma:
          idioma
      });
    }
  }
}


/*
|--------------------------------------------------------------------------
| Extraer enlaces Alpha
|--------------------------------------------------------------------------
|
| Esta función procesa exactamente las estructuras:
|
| all_embeds
| embeds
|
|--------------------------------------------------------------------------
*/

function extractAlphaLinks(data) {

  const links = [];
  const seen = new Set();


  /*
  |--------------------------------------------------------------------------
  | PRIORIDAD 1: all_embeds
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
      ] of Object.entries(
        data.all_embeds
      )
    ) {

      processLanguageObject(
        language,
        languageObject,
        links,
        seen
      );
    }

    if (links.length > 0) {
      return links;
    }
  }


  /*
  |--------------------------------------------------------------------------
  | PRIORIDAD 2: embeds
  |--------------------------------------------------------------------------
  */

  if (
    data &&
    data.embeds &&
    typeof data.embeds === "object"
  ) {

    const idioma =
      normalizeLanguage(
        data.language
      );

    for (
      const [
        rawServerName,
        rawValue
      ] of Object.entries(
        data.embeds
      )
    ) {

      if (
        isBlacklistedServer(
          rawServerName
        )
      ) {
        continue;
      }

      const urls =
        extractUrls(rawValue);

      if (!urls.length) {
        continue;
      }

      for (const url of urls) {

        const duplicateKey =
          `${url}|${idioma}`;

        if (
          seen.has(duplicateKey)
        ) {
          continue;
        }

        seen.add(
          duplicateKey
        );

        links.push({
          url_embed:
            url,

          servidor:
            String(
              rawServerName || ""
            ).trim(),

          idioma
        });
      }
    }
  }

  return links;
}


/*
|--------------------------------------------------------------------------
| Normalizar enlaces provenientes de Supabase
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
      isBlacklistedServer(
        servidor
      )
    ) {
      continue;
    }

    const idioma =
      normalizeLanguage(
        item.idioma
      );

    const key =
      `${url}|${idioma}`;

    if (
      seen.has(key)
    ) {
      continue;
    }

    seen.add(key);

    output.push({
      url_embed:
        url,

      servidor:
        servidor,

      idioma:
        idioma
    });
  }

  return output;
}


/*
|--------------------------------------------------------------------------
| Construir clave KV
|--------------------------------------------------------------------------
*/

function buildCacheKey(
  tmdbId,
  type,
  season,
  episode
) {

  return [
    "beta-db",
    String(tmdbId),
    type,
    String(season || 0),
    String(episode || 0)
  ].join(":");
}


/*
|--------------------------------------------------------------------------
| Obtener Alpha desde Supabase
|--------------------------------------------------------------------------
|
| IMPORTANTE:
|
| Esta función solamente hace SELECT.
|
| No necesita service_role.
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

  const started =
    Date.now();

  const cacheKey =
    buildCacheKey(
      tmdbId,
      type,
      season,
      episode
    );


  /*
  |--------------------------------------------------------------------------
  | Comprobar configuración
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
      elapsed_ms:
        Date.now() - started,
      cache:
        "disabled",
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
        Array.isArray(
          cached.links
        )
      ) {

        return {
          success: true,
          source: ALPHA_NAME,
          found:
            cached.links.length,
          links:
            cached.links,
          elapsed_ms:
            Date.now() - started,
          cache:
            "hit"
        };
      }

    } catch (error) {

      // El error de KV no debe impedir
      // consultar Supabase.
    }
  }


  /*
  |--------------------------------------------------------------------------
  | CACHE MISS
  |--------------------------------------------------------------------------
  */

  const supabaseUrl =
    new URL(
      env.SUPABASE_URL
    );

  /*
  |--------------------------------------------------------------------------
  | Endpoint REST
  |--------------------------------------------------------------------------
  */

  const endpoint =
    new URL(
      "/rest/v1/enlaces",
      supabaseUrl
    );

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

  /*
  |--------------------------------------------------------------------------
  | Orden
  |--------------------------------------------------------------------------
  */

  endpoint.searchParams.set(
    "order",
    "id.asc"
  );


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


    /*
    |--------------------------------------------------------------------------
    | HTTP error
    |--------------------------------------------------------------------------
    */

    if (!response.ok) {

      return {
        success: false,
        source: ALPHA_NAME,
        found: 0,
        links: [],
        http_code:
          response.status,
        elapsed_ms:
          Date.now() - started,
        cache:
          "miss",
        error:
          `Supabase respondió HTTP ${response.status}`,
        raw:
          text.slice(0, 1000)
      };
    }


    /*
    |--------------------------------------------------------------------------
    | JSON
    |--------------------------------------------------------------------------
    */

    let data;

    try {

      data =
        JSON.parse(text);

    } catch {

      return {
        success: false,
        source: ALPHA_NAME,
        found: 0,
        links: [],
        http_code:
          response.status,
        elapsed_ms:
          Date.now() - started,
        cache:
          "miss",
        error:
          "Supabase devolvió una respuesta que no es JSON.",
        raw:
          text.slice(0, 1000)
      };
    }


    /*
    |--------------------------------------------------------------------------
    | Procesar enlaces
    |--------------------------------------------------------------------------
    */

    const links =
      normalizeDatabaseLinks(
        data
      );


    /*
    |--------------------------------------------------------------------------
    | Guardar en KV
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

      } catch (error) {

        // No bloquear la respuesta
        // si KV falla.
      }
    }


    return {
      success: true,
      source: ALPHA_NAME,
      found:
        links.length,
      links,
      http_code:
        response.status,
      elapsed_ms:
        Date.now() - started,
      cache:
        "miss"
    };

  } catch (error) {

    return {
      success: false,
      source: ALPHA_NAME,
      found: 0,
      links: [],
      http_code: 0,
      elapsed_ms:
        Date.now() - started,
      cache:
        "miss",
      error:
        error?.message ||
        String(error)
    };
  }
}


/*
|--------------------------------------------------------------------------
| Construir endpoint Beta
|--------------------------------------------------------------------------
|
| SOURCE_URL debe apuntar al dominio/base del scraper.
|
| Si SOURCE_URL ya termina en:
|
| /embed/api.php
|
| se utiliza directamente.
|
| Si no, se agrega automáticamente.
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
    String(sourceUrl || "")
      .trim();

  if (!base) {
    throw new Error(
      "SOURCE_URL no está configurado."
    );
  }


  /*
  |--------------------------------------------------------------------------
  | Asegurar /embed/api.php
  |--------------------------------------------------------------------------
  */

  if (
    !base.includes(
      "/embed/api.php"
    )
  ) {

    base =
      base.replace(
        /\/+$/,
        ""
      ) +
      "/embed/api.php";
  }


  const endpoint =
    new URL(base);


  /*
  |--------------------------------------------------------------------------
  | Parámetros del scraper
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
| Obtener Beta
|--------------------------------------------------------------------------
|
| Beta es ahora el antiguo Alpha scraper.
|--------------------------------------------------------------------------
*/

async function fetchBeta(
  sourceUrl,
  tmdbId,
  type,
  season,
  episode
) {

  const started =
    Date.now();

  let endpoint;

  try {

    endpoint =
      buildBetaUrl(
        sourceUrl,
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
      http_code: 0,
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


    /*
    |--------------------------------------------------------------------------
    | HTTP error
    |--------------------------------------------------------------------------
    */

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


    /*
    |--------------------------------------------------------------------------
    | JSON
    |--------------------------------------------------------------------------
    */

    let data;

    try {

      data =
        JSON.parse(text);

    } catch {

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


    /*
    |--------------------------------------------------------------------------
    | Extraer enlaces
    |--------------------------------------------------------------------------
    */

    const links =
      extractAlphaLinks(data);


    return {
      success: true,
      source: BETA_NAME,
      found:
        links.length,
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
| Combinar Alpha + Beta
|--------------------------------------------------------------------------
|
| IMPORTANTE:
|
| Alpha SIEMPRE primero.
| Beta SIEMPRE después.
|--------------------------------------------------------------------------
*/

function mergeLinks(
  alphaLinks,
  betaLinks
) {

  const result = [];
  const seen = new Set();

  const ordered = [
    ...alphaLinks,
    ...betaLinks
  ];


  for (const link of ordered) {

    if (
      !link ||
      !link.url_embed
    ) {
      continue;
    }


    if (
      isBlacklistedServer(
        link.servidor
      )
    ) {
      continue;
    }


    const idioma =
      normalizeLanguage(
        link.idioma
      );


    const key =
      `${link.url_embed}|${idioma}`;


    if (
      seen.has(key)
    ) {
      continue;
    }


    seen.add(key);


    result.push({
      url_embed:
        link.url_embed,

      servidor:
        link.servidor ||
        "Desconocido",

      idioma
    });
  }


  return result;
}


/*
|--------------------------------------------------------------------------
| SSE helper
|--------------------------------------------------------------------------
*/

function createSSE() {

  const encoder =
    new TextEncoder();

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


  function send(
    event,
    data
  ) {

    if (!controller) {
      return;
    }


    const payload =
      `event: ${event}\n` +
      `data: ${JSON.stringify(data)}\n\n`;


    try {

      controller.enqueue(
        encoder.encode(
          payload
        )
      );

    } catch {

      controller = null;
    }
  }


  function close() {

    if (!controller) {
      return;
    }

    try {

      controller.close();

    } catch {}

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
| Worker
|--------------------------------------------------------------------------
*/

export default {

  async fetch(
    request,
    env,
    ctx
  ) {

    const url =
      new URL(
        request.url
      );


    /*
    |--------------------------------------------------------------------------
    | CORS OPTIONS
    |--------------------------------------------------------------------------
    */

    if (
      request.method ===
      "OPTIONS"
    ) {

      return new Response(
        null,
        {
          status: 204,
          headers:
            JSON_HEADERS
        }
      );
    }


    /*
    |--------------------------------------------------------------------------
    | Solo GET
    |--------------------------------------------------------------------------
    */

    if (
      request.method !==
      "GET"
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
    | Health check
    |--------------------------------------------------------------------------
    */

    if (
      url.pathname ===
      "/"
    ) {

      return json({
        success: true,
        status:
          "online",
        event:
          "complete",
        worker:
          "TON Scraper API"
      });
    }


    /*
    |--------------------------------------------------------------------------
    | API KEY del Worker
    |--------------------------------------------------------------------------
    */

    const apiKey =
      env.API_KEY || "";


    if (apiKey) {

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
        suppliedKey !==
        apiKey
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
    | Rutas
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
      parts[0] !==
      "play"
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


    if (
      type === "tv"
    ) {

      season =
        Number(
          parts[3] || 0
        );

      episode =
        Number(
          parts[4] || 0
        );


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
    | Verificar SOURCE_URL
    |--------------------------------------------------------------------------
    */

    if (
      !env.SOURCE_URL
    ) {

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
    | Crear SSE
    |--------------------------------------------------------------------------
    */

    const sse =
      createSSE();


    /*
    |--------------------------------------------------------------------------
    | Ejecutar proceso
    |--------------------------------------------------------------------------
    */

    ctx.waitUntil(
      (async () => {

        try {

          /*
          |--------------------------------------------------------------------------
          | TMDB receiving
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


          /*
          |--------------------------------------------------------------------------
          | TMDB received
          |--------------------------------------------------------------------------
          |
          | El Worker recibe el ID de TMDB.
          | No necesitamos hacer una llamada
          | adicional a TMDB para realizar
          | las búsquedas de fuentes.
          |--------------------------------------------------------------------------
          */

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
          | Searching
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
          | ALPHA = SUPABASE
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


          const alpha =
            await fetchAlpha(
              env,
              tmdbId,
              type,
              season,
              episode
            );


          /*
          |--------------------------------------------------------------------------
          | Evento de caché
          |--------------------------------------------------------------------------
          */

          if (
            alpha.cache ===
            "hit"
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
            alpha.cache ===
            "miss"
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
                  "Alpha: caché no encontrada, consultando BD"
              }
            );
          }


          /*
          |--------------------------------------------------------------------------
          | Alpha found
          |--------------------------------------------------------------------------
          */

          if (
            alpha.success
          ) {

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
                cache:
                  alpha.cache,
                http_code:
                  alpha.http_code ||
                  0,
                elapsed_ms:
                  alpha.elapsed_ms,
                message:
                  "Alpha no respondió o no encontró servidores",
                error:
                  alpha.error
              }
            );
          }


          /*
          |--------------------------------------------------------------------------
          | BETA = SCRAPER
          |--------------------------------------------------------------------------
          |
          | IMPORTANTE:
          |
          | Siempre se consulta.
          |
          | Aunque Alpha haya encontrado
          | enlaces, Beta continúa.
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


          const beta =
            await fetchBeta(
              env.SOURCE_URL,
              tmdbId,
              type,
              season,
              episode
            );


          /*
          |--------------------------------------------------------------------------
          | Beta found
          |--------------------------------------------------------------------------
          */

          if (
            beta.success
          ) {

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
                http_code:
                  beta.http_code ||
                  0,
                content_type:
                  beta.content_type ||
                  "",
                elapsed_ms:
                  beta.elapsed_ms,
                message:
                  "Beta no respondió o no encontró servidores",
                error:
                  beta.error
              }
            );
          }


          /*
          |--------------------------------------------------------------------------
          | Combinar
          |--------------------------------------------------------------------------
          |
          | Alpha primero.
          | Beta después.
          |--------------------------------------------------------------------------
          */

          const alphaLinks =
            Array.isArray(
              alpha.links
            )
              ? alpha.links
              : [];


          const betaLinks =
            Array.isArray(
              beta.links
            )
              ? beta.links
              : [];


          const links =
            mergeLinks(
              alphaLinks,
              betaLinks
            );


          /*
          |--------------------------------------------------------------------------
          | Búsqueda completada
          |--------------------------------------------------------------------------
          */

          sse.send(
            "search_complete",
            {
              success:
                links.length > 0,
              status:
                "search_complete",
              alpha_found:
                alphaLinks.length,
              beta_found:
                betaLinks.length,
              found:
                links.length,
              message:
                "Búsqueda completada"
            }
          );


          /*
          |--------------------------------------------------------------------------
          | COMPLETE
          |--------------------------------------------------------------------------
          */

          sse.send(
            "complete",
            {
              success:
                links.length > 0,

              status:
                links.length > 0
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
                links.length,

              links,

              alpha_cache:
                alpha.cache ||
                "disabled",

              alpha_error:
                alpha.success
                  ? null
                  : alpha.error,

              beta_error:
                beta.success
                  ? null
                  : beta.error,

              message:
                links.length > 0
                  ? "Búsqueda completada correctamente."
                  : "Alpha y Beta no devolvieron servidores válidos."
            }
          );

        } catch (error) {

          /*
          |--------------------------------------------------------------------------
          | Error inesperado
          |--------------------------------------------------------------------------
          */

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
    | Respuesta SSE
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