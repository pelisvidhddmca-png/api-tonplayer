/*
|--------------------------------------------------------------------------
| TON SCRAPER API
|--------------------------------------------------------------------------
|
| ENDPOINTS
|
| GET /play/movie/:tmdb_id
| GET /play/tv/:tmdb_id/:season/:episode
|
| GET /events/movie/:tmdb_id
| GET /events/tv/:tmdb_id/:season/:episode
|
|--------------------------------------------------------------------------
| SECRETS
|--------------------------------------------------------------------------
|
| API_KEY
| SOURCE_URL
| BETA_URL
| BETA_SUPABASE_KEY
|
|--------------------------------------------------------------------------
| LÓGICA
|--------------------------------------------------------------------------
|
| 1. Recibe TMDB ID
| 2. Consulta Alpha primero
| 3. Extrae all_embeds -> embeds
| 4. Aplica blacklist
| 5. Si Alpha falla, consulta Beta
| 6. Si Alpha tiene <= 4 enlaces, consulta Beta
| 7. Si se consulta Beta por fallback, Beta queda primero
| 8. Elimina duplicados
| 9. Devuelve JSON por /play
| 10. Devuelve SSE real por /events
|
|--------------------------------------------------------------------------
*/

const ALPHA_NAME = "Alpha";
const BETA_NAME = "Beta";

const ALPHA_LIMIT_FOR_BETA = 4;

/*
|--------------------------------------------------------------------------
| BLACKLIST
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
  "cache-control": "no-store",
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
  "access-control-allow-methods": "GET, OPTIONS"
};

/*
|--------------------------------------------------------------------------
| JSON HELPER
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

/*
|--------------------------------------------------------------------------
| BLACKLIST
|--------------------------------------------------------------------------
*/

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
  const value = String(language || "")
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

  return value.charAt(0).toUpperCase() + value.slice(1);
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
| PROCESAR OBJETO DE IDIOMA DE ALPHA
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

  const idioma =
    normalizeLanguage(languageName);

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

    const servidor =
      String(rawServerName).trim();

    for (const url of urls) {
      const duplicateKey =
        `${url}|${idioma}`;

      if (seen.has(duplicateKey)) {
        continue;
      }

      seen.add(duplicateKey);

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
| EXTRAER ENLACES DE ALPHA
|--------------------------------------------------------------------------
|
| Prioridad:
|
| all_embeds
|     ↓
| embeds
|
|--------------------------------------------------------------------------
*/

function extractAlphaLinks(data) {
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

    if (links.length > 0) {
      return links;
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
        const duplicateKey =
          `${url}|${idioma}`;

        if (seen.has(duplicateKey)) {
          continue;
        }

        seen.add(duplicateKey);

        links.push({
          url_embed: url,
          servidor:
            String(rawServerName).trim(),
          idioma
        });
      }
    }
  }

  return links;
}

/*
|--------------------------------------------------------------------------
| CONSTRUIR URL ALPHA
|--------------------------------------------------------------------------
*/

function buildAlphaUrl(
  sourceUrl,
  tmdbId,
  type,
  season,
  episode
) {
  const url =
    new URL(sourceUrl);

  url.searchParams.set(
    "action",
    "details"
  );

  url.searchParams.set(
    "id",
    String(tmdbId)
  );

  url.searchParams.set(
    "type",
    type
  );

  if (type === "tv") {
    url.searchParams.set(
      "season",
      String(season)
    );

    url.searchParams.set(
      "episode",
      String(episode)
    );
  }

  return url.toString();
}

/*
|--------------------------------------------------------------------------
| FETCH ALPHA
|--------------------------------------------------------------------------
*/

async function fetchAlpha(
  sourceUrl,
  tmdbId,
  type,
  season,
  episode
) {
  if (!sourceUrl) {
    return {
      success: false,
      source: ALPHA_NAME,
      error:
        "El Secret SOURCE_URL no está configurado.",
      links: []
    };
  }

  const endpoint =
    buildAlphaUrl(
      sourceUrl,
      tmdbId,
      type,
      season,
      episode
    );

  const started = Date.now();

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

    const elapsed =
      Date.now() - started;

    const contentType =
      response.headers.get(
        "content-type"
      ) || "";

    const text =
      await response.text();

    if (!response.ok) {
      return {
        success: false,
        source: ALPHA_NAME,
        endpoint,
        http_code:
          response.status,
        content_type:
          contentType,
        elapsed_ms:
          elapsed,
        error:
          `HTTP ${response.status}`,
        links: []
      };
    }

    let data;

    try {
      data = JSON.parse(text);
    } catch {
      return {
        success: false,
        source: ALPHA_NAME,
        endpoint,
        http_code:
          response.status,
        content_type:
          contentType,
        elapsed_ms:
          elapsed,
        error:
          "Alpha devolvió una respuesta que no es JSON.",
        links: []
      };
    }

    const links =
      extractAlphaLinks(data);

    return {
      success: true,
      source: ALPHA_NAME,
      endpoint,
      http_code:
        response.status,
      content_type:
        contentType,
      elapsed_ms:
        elapsed,
      links,
      raw: data
    };

  } catch (error) {
    return {
      success: false,
      source: ALPHA_NAME,
      endpoint,
      http_code: 0,
      elapsed_ms:
        Date.now() - started,
      error:
        error?.message ||
        String(error),
      links: []
    };
  }
}

/*
|--------------------------------------------------------------------------
| CONSTRUIR URL BETA
|--------------------------------------------------------------------------
|
| Beta es Supabase REST:
|
| /rest/v1/enlaces
|
| Filtros PostgREST:
|
| tmdb_id=eq.44956
| tipo=eq.movie
| temporada=eq.0
| episodio=eq.0
|
|--------------------------------------------------------------------------
*/

function buildBetaUrl(
  betaUrl,
  tmdbId,
  type,
  season,
  episode
) {
  const url =
    new URL(betaUrl);

  url.searchParams.set(
    "tmdb_id",
    `eq.${tmdbId}`
  );

  url.searchParams.set(
    "tipo",
    `eq.${type}`
  );

  url.searchParams.set(
    "temporada",
    `eq.${season}`
  );

  url.searchParams.set(
    "episodio",
    `eq.${episode}`
  );

  /*
  |--------------------------------------------------------------------------
  | Orden estable
  |--------------------------------------------------------------------------
  */

  url.searchParams.set(
    "order",
    "id.asc"
  );

  return url.toString();
}

/*
|--------------------------------------------------------------------------
| NORMALIZAR LINKS DE BETA
|--------------------------------------------------------------------------
*/

function normalizeBetaLinks(data) {
  if (!Array.isArray(data)) {
    return [];
  }

  const links = [];
  const seen = new Set();

  for (const item of data) {
    if (
      !item ||
      typeof item !== "object"
    ) {
      continue;
    }

    const url =
      typeof item.url_embed === "string"
        ? item.url_embed.trim()
        : "";

    if (
      !url ||
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

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);

    links.push({
      url_embed: url,
      servidor,
      idioma
    });
  }

  return links;
}

/*
|--------------------------------------------------------------------------
| FETCH BETA
|--------------------------------------------------------------------------
*/

async function fetchBeta(
  betaUrl,
  betaSupabaseKey,
  tmdbId,
  type,
  season,
  episode
) {
  if (!betaUrl) {
    return {
      success: false,
      source: BETA_NAME,
      error:
        "El Secret BETA_URL no está configurado.",
      links: []
    };
  }

  if (!betaSupabaseKey) {
    return {
      success: false,
      source: BETA_NAME,
      error:
        "El Secret BETA_SUPABASE_KEY no está configurado.",
      links: []
    };
  }

  const endpoint =
    buildBetaUrl(
      betaUrl,
      tmdbId,
      type,
      season,
      episode
    );

  try {
    const response =
      await fetch(
        endpoint,
        {
          method: "GET",
          headers: {
            "Accept":
              "application/json",
            "apikey":
              betaSupabaseKey,
            "Authorization":
              `Bearer ${betaSupabaseKey}`,
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

    let data;

    try {
      data = JSON.parse(text);
    } catch {
      return {
        success: false,
        source: BETA_NAME,
        endpoint,
        http_code:
          response.status,
        content_type:
          contentType,
        error:
          "Beta devolvió una respuesta no JSON.",
        preview:
          text.slice(0, 300),
        links: []
      };
    }

    if (!response.ok) {
      return {
        success: false,
        source: BETA_NAME,
        endpoint,
        http_code:
          response.status,
        content_type:
          contentType,
        error:
          data?.message ||
          data?.error ||
          `HTTP ${response.status}`,
        links: []
      };
    }

    const links =
      normalizeBetaLinks(data);

    return {
      success: true,
      source: BETA_NAME,
      endpoint,
      http_code:
        response.status,
      content_type:
        contentType,
      links
    };

  } catch (error) {
    return {
      success: false,
      source: BETA_NAME,
      endpoint,
      http_code: 0,
      error:
        error?.message ||
        String(error),
      links: []
    };
  }
}

/*
|--------------------------------------------------------------------------
| MERGE
|--------------------------------------------------------------------------
*/

function mergeLinks(
  alphaLinks,
  betaLinks,
  betaFirst
) {
  const result = [];
  const seen = new Set();

  const ordered =
    betaFirst
      ? [
          ...betaLinks,
          ...alphaLinks
        ]
      : [
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

    const key =
      `${link.url_embed}|${link.idioma}`;

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);

    result.push(link);
  }

  return result;
}

/*
|--------------------------------------------------------------------------
| EVENTOS SSE
|--------------------------------------------------------------------------
*/

function formatSSE(
  event,
  data
) {
  return (
    `event: ${event}\n` +
    `data: ${JSON.stringify(data)}\n\n`
  );
}

/*
|--------------------------------------------------------------------------
| AUTENTICACIÓN
|--------------------------------------------------------------------------
*/

function authorize(
  request,
  url,
  apiKey
) {
  if (!apiKey) {
    return true;
  }

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

  return suppliedKey === apiKey;
}

/*
|--------------------------------------------------------------------------
| PARSEAR RUTA
|--------------------------------------------------------------------------
*/

function parsePlayPath(pathname) {
  const parts =
    pathname
      .split("/")
      .filter(Boolean);

  if (
    parts.length < 3 ||
    (
      parts[0] !== "play" &&
      parts[0] !== "events"
    )
  ) {
    return null;
  }

  const mode =
    parts[0];

  const type =
    parts[1];

  const tmdbId =
    parts[2];

  if (
    type !== "movie" &&
    type !== "tv"
  ) {
    return null;
  }

  if (!tmdbId) {
    return null;
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
      return null;
    }
  }

  return {
    mode,
    type,
    tmdbId,
    season,
    episode
  };
}

/*
|--------------------------------------------------------------------------
| REALIZAR BÚSQUEDA
|--------------------------------------------------------------------------
*/

async function performSearch(
  env,
  tmdbId,
  type,
  season,
  episode,
  sendEvent = null
) {
  /*
  |--------------------------------------------------------------------------
  | TMDB
  |--------------------------------------------------------------------------
  |
  | El Worker no consulta directamente TMDB aquí.
  | El ID ya fue recibido del Player.
  |
  */

  if (sendEvent) {
    await sendEvent(
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

    await sendEvent(
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

    await sendEvent(
      "searching",
      {
        success: true,
        status:
          "searching",
        message:
          "Buscando servidores"
      }
    );

    await sendEvent(
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
  }

  /*
  |--------------------------------------------------------------------------
  | ALPHA
  |--------------------------------------------------------------------------
  */

  const alpha =
    await fetchAlpha(
      env.SOURCE_URL,
      tmdbId,
      type,
      season,
      episode
    );

  const alphaFound =
    alpha.links.length;

  /*
  |--------------------------------------------------------------------------
  | Evento Alpha
  |--------------------------------------------------------------------------
  */

  if (sendEvent) {
    await sendEvent(
      "alpha_found",
      alpha.success &&
      alphaFound > 0
        ? {
            success: true,
            status:
              "alpha_found",
            source:
              ALPHA_NAME,
            found:
              alphaFound,
            message:
              `Alpha: ${alphaFound} ${
                alphaFound === 1
                  ? "servidor"
                  : "servidores"
              } encontrados`
          }
        : {
            success: false,
            status:
              "alpha_unavailable",
            source:
              ALPHA_NAME,
            found: 0,
            message:
              "Alpha no respondió o no encontró servidores",
            error:
              alpha.error ||
              "Sin enlaces válidos"
          }
    );
  }

  /*
  |--------------------------------------------------------------------------
  | DECIDIR SI CONSULTAMOS BETA
  |--------------------------------------------------------------------------
  |
  | Beta se consulta:
  |
  | - Si Alpha falla
  | - Si Alpha devuelve <= 4 enlaces
  |
  |--------------------------------------------------------------------------
  */

  const shouldQueryBeta =
    !alpha.success ||
    alphaFound <=
      ALPHA_LIMIT_FOR_BETA;

  let beta = {
    success: false,
    source: BETA_NAME,
    links: []
  };

  if (shouldQueryBeta) {
    if (sendEvent) {
      await sendEvent(
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
    }

    beta =
      await fetchBeta(
        env.BETA_URL,
        env.BETA_SUPABASE_KEY,
        tmdbId,
        type,
        season,
        episode
      );

    const betaFound =
      beta.links.length;

    if (sendEvent) {
      await sendEvent(
        "beta_found",
        beta.success &&
        betaFound > 0
          ? {
              success: true,
              status:
                "beta_found",
              source:
                BETA_NAME,
              found:
                betaFound,
              message:
                `Beta: ${betaFound} ${
                  betaFound === 1
                    ? "servidor"
                    : "servidores"
                } encontrados`
            }
          : {
              success: false,
              status:
                "beta_unavailable",
              source:
                BETA_NAME,
              found: 0,
              message:
                "Beta no respondió o no encontró servidores",
              error:
                beta.error ||
                "Sin enlaces válidos"
            }
      );
    }
  }

  /*
  |--------------------------------------------------------------------------
  | BETA FIRST
  |--------------------------------------------------------------------------
  |
  | Si Beta fue consultado porque Alpha tenía <= 4
  | o porque Alpha falló, Beta queda primero.
  |
  |--------------------------------------------------------------------------
  */

  const betaFirst =
    shouldQueryBeta &&
    beta.links.length > 0;

  const links =
    mergeLinks(
      alpha.links,
      beta.links,
      betaFirst
    );

  /*
  |--------------------------------------------------------------------------
  | RESULTADO
  |--------------------------------------------------------------------------
  */

  const result = {
    success:
      links.length > 0,
    status:
      links.length > 0
        ? "complete"
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
      alphaFound,

    beta_found:
      beta.links.length,

    found:
      links.length,

    links
  };

  /*
  |--------------------------------------------------------------------------
  | ERRORES
  |--------------------------------------------------------------------------
  */

  if (!links.length) {
    result.message =
      "Alpha y Beta no devolvieron servidores válidos.";

    result.alpha_error =
      alpha.error || null;

    result.beta_error =
      beta.error || null;
  } else {
    result.message =
      "Búsqueda completada";
  }

  /*
  |--------------------------------------------------------------------------
  | COMPLETE SSE
  |--------------------------------------------------------------------------
  */

  if (sendEvent) {
    await sendEvent(
      "complete",
      result
    );
  }

  return result;
}

/*
|--------------------------------------------------------------------------
| HANDLER
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
    | SOLO GET
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
            "method_not_allowed"
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
        event:
          "complete",
        worker:
          "TON Scraper API"
      });
    }

    /*
    |--------------------------------------------------------------------------
    | API KEY
    |--------------------------------------------------------------------------
    */

    if (
      !authorize(
        request,
        url,
        env.API_KEY
      )
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

    /*
    |--------------------------------------------------------------------------
    | PARSEAR RUTA
    |--------------------------------------------------------------------------
    */

    const route =
      parsePlayPath(
        url.pathname
      );

    if (!route) {
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

    const {
      mode,
      type,
      tmdbId,
      season,
      episode
    } = route;

    /*
    |--------------------------------------------------------------------------
    | SSE
    |--------------------------------------------------------------------------
    */

    if (
      mode === "events"
    ) {
      const encoder =
        new TextEncoder();

      let controllerRef;

      const stream =
        new ReadableStream({
          start(controller) {
            controllerRef =
              controller;
          },

          cancel() {
            controllerRef = null;
          }
        });

      const response =
        new Response(
          stream,
          {
            status: 200,
            headers:
              SSE_HEADERS
          }
        );

      /*
      |--------------------------------------------------------------------------
      | Ejecutar búsqueda
      |--------------------------------------------------------------------------
      */

      ctx.waitUntil(
        (async () => {
          try {
            const sendEvent =
              async (
                event,
                data
              ) => {
                if (
                  !controllerRef
                ) {
                  return;
                }

                try {
                  controllerRef.enqueue(
                    encoder.encode(
                      formatSSE(
                        event,
                        data
                      )
                    )
                  );
                } catch {
                  controllerRef = null;
                }
              };

            /*
            |--------------------------------------------------------------------------
            | Conexión inicial
            |--------------------------------------------------------------------------
            */

            if (
              controllerRef
            ) {
              controllerRef.enqueue(
                encoder.encode(
                  ":\n\n"
                )
              );
            }

            await performSearch(
              env,
              tmdbId,
              type,
              season,
              episode,
              sendEvent
            );

            /*
            |--------------------------------------------------------------------------
            | Cerrar SSE
            |--------------------------------------------------------------------------
            */

            if (
              controllerRef
            ) {
              controllerRef.close();
              controllerRef = null;
            }

          } catch (error) {
            if (
              controllerRef
            ) {
              try {
                controllerRef.enqueue(
                  encoder.encode(
                    formatSSE(
                      "complete",
                      {
                        success:
                          false,
                        status:
                          "internal_error",
                        event:
                          "complete",
                        message:
                          error?.message ||
                          String(error)
                      }
                    )
                  )
                );

                controllerRef.close();
              } catch {}

              controllerRef = null;
            }
          }
        })()
      );

      return response;
    }

    /*
    |--------------------------------------------------------------------------
    | JSON /play
    |--------------------------------------------------------------------------
    */

    const result =
      await performSearch(
        env,
        tmdbId,
        type,
        season,
        episode,
        null
      );

    return json(
      result,
      result.success
        ? 200
        : 404
    );
  }
};