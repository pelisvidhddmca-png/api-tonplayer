/*
|--------------------------------------------------------------------------
| TON SCRAPER API
|--------------------------------------------------------------------------
|
| Flujo:
|
| 1. Recibe TMDB ID
| 2. SSE: Recibiendo datos de TMDB
| 3. SSE: Datos de TMDB recibidos
| 4. SSE: Buscando servidores
| 5. SSE: Consultando Alpha
| 6. Alpha responde -> procesa enlaces
| 7. Si Alpha no responde O tiene <= 4 enlaces válidos -> consulta Beta
| 8. Beta consulta Supabase REST
| 9. SSE: resultado de Alpha
| 10. SSE: resultado de Beta
| 11. SSE: Búsqueda completada
|
|--------------------------------------------------------------------------
| Rutas:
|
| GET /play/movie/:tmdb_id
| GET /play/tv/:tmdb_id/:season/:episode
|
|--------------------------------------------------------------------------
| Secrets:
|
| API_KEY
| SOURCE_URL
| BETA_URL
| BETA_SUPABASE_KEY
|
|--------------------------------------------------------------------------
*/


/*
|--------------------------------------------------------------------------
| CONFIGURACIÓN
|--------------------------------------------------------------------------
*/

const ALPHA_NAME = "Alpha";
const BETA_NAME = "Beta";

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
  "content-type":
    "application/json; charset=UTF-8",

  "cache-control":
    "no-store",

  "access-control-allow-origin":
    "*",

  "access-control-allow-headers":
    "Content-Type, Authorization",

  "access-control-allow-methods":
    "GET, OPTIONS"
};


/*
|--------------------------------------------------------------------------
| JSON
|--------------------------------------------------------------------------
*/

function json(
  data,
  status = 200
) {
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
| NORMALIZAR SERVIDOR
|--------------------------------------------------------------------------
*/

function normalizeServerName(
  name
) {
  return String(name || "")
    .trim()
    .toLowerCase()
    .replace(
      /_\d+$/,
      ""
    );
}


/*
|--------------------------------------------------------------------------
| BLACKLIST
|--------------------------------------------------------------------------
*/

function isBlacklistedServer(
  name
) {
  return BLACKLISTED_SERVERS.has(
    normalizeServerName(
      name
    )
  );
}


/*
|--------------------------------------------------------------------------
| NORMALIZAR IDIOMA
|--------------------------------------------------------------------------
*/

function normalizeLanguage(
  language
) {
  const value =
    String(
      language || ""
    )
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
| EXTRAER URLS
|--------------------------------------------------------------------------
*/

function extractUrls(
  value
) {
  if (
    !Array.isArray(value)
  ) {
    return [];
  }

  return value.filter(
    item =>
      typeof item ===
        "string" &&
      /^https?:\/\//i.test(
        item
      )
  );
}


/*
|--------------------------------------------------------------------------
| PROCESAR IDIOMA
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
    typeof languageObject !==
      "object"
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
      extractUrls(
        rawValue
      );

    if (
      !urls.length
    ) {
      continue;
    }

    const idioma =
      normalizeLanguage(
        languageName
      );

    const servidor =
      String(
        rawServerName
      ).trim();

    for (
      const url of urls
    ) {

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
  }
}


/*
|--------------------------------------------------------------------------
| EXTRAER ALPHA
|--------------------------------------------------------------------------
*/

function extractAlphaLinks(
  data
) {
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
    typeof data.all_embeds ===
      "object"
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

    if (
      links.length > 0
    ) {
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
    typeof data.embeds ===
      "object"
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
        extractUrls(
          rawValue
        );

      for (
        const url of urls
      ) {

        const key =
          `${url}|${idioma}`;

        if (
          seen.has(key)
        ) {
          continue;
        }

        seen.add(key);

        links.push({
          url_embed:
            url,

          servidor:
            String(
              rawServerName
            ).trim(),

          idioma:
            idioma
        });
      }
    }
  }

  return links;
}


/*
|--------------------------------------------------------------------------
| ALPHA URL
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
    new URL(
      sourceUrl
    );

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

  if (
    type === "tv"
  ) {

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
  if (
    !sourceUrl
  ) {
    return {
      success: false,
      source:
        ALPHA_NAME,
      http_code: 0,
      endpoint: null,
      error:
        "El Secret SOURCE_URL no está configurado.",
      links: []
    };
  }

  let endpoint;

  try {
    endpoint =
      buildAlphaUrl(
        sourceUrl,
        tmdbId,
        type,
        season,
        episode
      );
  } catch (
    error
  ) {
    return {
      success: false,
      source:
        ALPHA_NAME,
      http_code: 0,
      endpoint: null,
      error:
        `SOURCE_URL inválida: ${
          error?.message ||
          String(error)
        }`,
      links: []
    };
  }

  const started =
    Date.now();

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
      Date.now() -
      started;

    const contentType =
      response.headers.get(
        "content-type"
      ) || "";

    const text =
      await response.text();

    if (
      !response.ok
    ) {
      return {
        success: false,
        source:
          ALPHA_NAME,
        http_code:
          response.status,
        endpoint,
        elapsed_ms:
          elapsed,
        error:
          `HTTP ${response.status}`,
        response_preview:
          text.slice(0, 500),
        links: []
      };
    }

    let data;

    try {
      data =
        JSON.parse(
          text
        );
    } catch {
      return {
        success: false,
        source:
          ALPHA_NAME,
        http_code:
          response.status,
        endpoint,
        elapsed_ms:
          elapsed,
        error:
          "Alpha devolvió una respuesta que no es JSON.",
        response_preview:
          text.slice(0, 500),
        links: []
      };
    }

    const links =
      extractAlphaLinks(
        data
      );

    return {
      success: true,
      source:
        ALPHA_NAME,
      http_code:
        response.status,
      content_type:
        contentType,
      elapsed_ms:
        elapsed,
      links,
      raw:
        data
    };

  } catch (
    error
  ) {

    return {
      success: false,
      source:
        ALPHA_NAME,
      http_code: 0,
      endpoint,
      elapsed_ms:
        Date.now() -
        started,
      error:
        error?.message ||
        String(error),
      links: []
    };
  }
}


/*
|--------------------------------------------------------------------------
| CONSTRUIR BETA URL
|--------------------------------------------------------------------------
|
| Acepta:
|
| https://proyecto.supabase.co
|
| https://proyecto.supabase.co/rest/v1
|
| https://proyecto.supabase.co/rest/v1/enlaces
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

  let base =
    String(
      betaUrl || ""
    )
      .trim()
      .replace(
        /\/+$/,
        ""
      );

  if (
    base.endsWith(
      "/rest/v1/enlaces"
    )
  ) {
    // Correcto.
  }

  else if (
    base.endsWith(
      "/rest/v1"
    )
  ) {
    base +=
      "/enlaces";
  }

  else {
    base +=
      "/rest/v1/enlaces";
  }

  const url =
    new URL(
      base
    );

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

  return url.toString();
}


/*
|--------------------------------------------------------------------------
| FETCH BETA
|--------------------------------------------------------------------------
|
| Supabase REST
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

  if (
    !betaUrl
  ) {
    return {
      success: false,
      source:
        BETA_NAME,
      http_code: 0,
      endpoint: null,
      error:
        "El Secret BETA_URL no está configurado.",
      links: []
    };
  }

  if (
    !betaSupabaseKey
  ) {
    return {
      success: false,
      source:
        BETA_NAME,
      http_code: 0,
      endpoint: null,
      error:
        "El Secret BETA_SUPABASE_KEY no está configurado.",
      links: []
    };
  }

  let endpoint;

  try {

    endpoint =
      buildBetaUrl(
        betaUrl,
        tmdbId,
        type,
        season,
        episode
      );

  } catch (
    error
  ) {

    return {
      success: false,
      source:
        BETA_NAME,
      http_code: 0,
      endpoint: null,
      error:
        `BETA_URL inválida: ${
          error?.message ||
          String(error)
        }`,
      links: []
    };
  }

  try {

    const response =
      await fetch(
        endpoint,
        {
          method: "GET",

          headers: {
            "apikey":
              betaSupabaseKey,

            "Authorization":
              `Bearer ${betaSupabaseKey}`,

            "Accept":
              "application/json",

            "User-Agent":
              "TON-Scraper-Worker/1.0"
          }
        }
      );

    const httpCode =
      response.status;

    const contentType =
      response.headers.get(
        "content-type"
      ) || "";

    const contentRange =
      response.headers.get(
        "content-range"
      ) || "";

    const text =
      await response.text();

    /*
    |--------------------------------------------------------------------------
    | ERROR HTTP
    |--------------------------------------------------------------------------
    */

    if (
      !response.ok
    ) {

      let errorData =
        null;

      try {
        errorData =
          JSON.parse(
            text
          );
      } catch {}

      return {
        success: false,
        source:
          BETA_NAME,
        http_code:
          httpCode,
        content_type:
          contentType,
        content_range:
          contentRange,
        endpoint,

        error:
          errorData?.message ||
          errorData?.error ||
          errorData?.hint ||
          `HTTP ${httpCode}`,

        response_preview:
          text.slice(0, 1000),

        links: []
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
        JSON.parse(
          text
        );

    } catch {

      return {
        success: false,
        source:
          BETA_NAME,
        http_code:
          httpCode,
        content_type:
          contentType,
        content_range:
          contentRange,
        endpoint,

        error:
          "Beta respondió HTTP 200 pero el cuerpo no es JSON.",

        response_preview:
          text.slice(0, 1000),

        links: []
      };
    }

    /*
    |--------------------------------------------------------------------------
    | SUPABASE DEBE DEVOLVER ARRAY
    |--------------------------------------------------------------------------
    */

    if (
      !Array.isArray(
        data
      )
    ) {

      return {
        success: false,
        source:
          BETA_NAME,
        http_code:
          httpCode,
        content_type:
          contentType,
        content_range:
          contentRange,
        endpoint,

        error:
          "Beta devolvió JSON pero no un array.",

        response_preview:
          JSON.stringify(
            data
          ).slice(
            0,
            1000
          ),

        links: []
      };
    }

    /*
    |--------------------------------------------------------------------------
    | PROCESAR ENLACES
    |--------------------------------------------------------------------------
    */

    const links = [];
    const seen = new Set();

    for (
      const item of data
    ) {

      if (
        !item ||
        typeof item !==
          "object"
      ) {
        continue;
      }

      const url =
        String(
          item.url_embed ||
          ""
        ).trim();

      if (
        !url ||
        !/^https?:\/\//i.test(
          url
        )
      ) {
        continue;
      }

      const servidor =
        String(
          item.servidor ||
          "Desconocido"
        ).trim();

      /*
      |--------------------------------------------------------------------------
      | BLACKLIST
      |--------------------------------------------------------------------------
      */

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

      links.push({
        url_embed:
          url,

        servidor:
          servidor,

        idioma:
          idioma
      });
    }

    return {
      success: true,
      source:
        BETA_NAME,
      http_code:
        httpCode,
      content_type:
        contentType,
      content_range:
        contentRange,
      endpoint,

      rows_received:
        data.length,

      links
    };

  } catch (
    error
  ) {

    return {
      success: false,
      source:
        BETA_NAME,
      http_code: 0,
      endpoint,

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
|
| Si Alpha tiene <= 4 enlaces:
| Beta se coloca primero.
|
| Si Alpha tiene > 4:
| Alpha primero.
|
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

  for (
    const link of ordered
  ) {

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

    if (
      seen.has(key)
    ) {
      continue;
    }

    seen.add(key);

    result.push(
      link
    );
  }

  return result;
}


/*
|--------------------------------------------------------------------------
| SSE
|--------------------------------------------------------------------------
*/

function createSSEStream(
  handler
) {

  const encoder =
    new TextEncoder();

  let controllerRef;

  const stream =
    new ReadableStream({

      start(controller) {

        controllerRef =
          controller;

        const send =
          (
            event,
            data
          ) => {

            controller.enqueue(
              encoder.encode(
                `event: ${event}\n` +
                `data: ${JSON.stringify(data)}\n\n`
              )
            );
          };

        Promise.resolve()
          .then(
            () =>
              handler(
                send
              )
          )
          .then(
            () => {
              try {
                controller.close();
              } catch {}
            }
          )
          .catch(
            error => {

              send(
                "error",
                {
                  success:
                    false,

                  status:
                    "worker_error",

                  message:
                    error?.message ||
                    String(error)
                }
              );

              try {
                controller.close();
              } catch {}
            }
          );
      }
    });

  return stream;
}


/*
|--------------------------------------------------------------------------
| SSE HEADERS
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
    "GET, OPTIONS"
};


/*
|--------------------------------------------------------------------------
| WORKER
|--------------------------------------------------------------------------
*/

export default {

  async fetch(
    request,
    env
  ) {

    const url =
      new URL(
        request.url
      );

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
    | GET
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
    | API KEY
    |--------------------------------------------------------------------------
    */

    const apiKey =
      env.API_KEY ||
      "";

    if (
      apiKey
    ) {

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
    | RUTA
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

    if (
      !tmdbId
    ) {

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
    | SSE STREAM
    |--------------------------------------------------------------------------
    */

    const stream =
      createSSEStream(
        async send => {

          /*
          |--------------------------------------------------------------------------
          | 1. TMDB RECEIVING
          |--------------------------------------------------------------------------
          */

          send(
            "tmdb_receiving",
            {
              success: true,
              status:
                "tmdb_receiving",
              message:
                "Recibiendo datos de TMDB",
              tmdb_id:
                String(tmdbId),
              type,
              season,
              episode
            }
          );

          /*
          |--------------------------------------------------------------------------
          | 2. TMDB RECEIVED
          |--------------------------------------------------------------------------
          */

          send(
            "tmdb_received",
            {
              success: true,
              status:
                "tmdb_received",
              message:
                "Datos de TMDB recibidos",
              tmdb_id:
                String(tmdbId),
              type,
              season,
              episode
            }
          );

          /*
          |--------------------------------------------------------------------------
          | 3. SEARCHING
          |--------------------------------------------------------------------------
          */

          send(
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
          | 4. ALPHA
          |--------------------------------------------------------------------------
          */

          send(
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
          | ALPHA RESULT
          |--------------------------------------------------------------------------
          */

          send(
            "alpha_found",
            {
              success:
                alpha.success,

              status:
                alpha.success
                  ? "alpha_found"
                  : "alpha_unavailable",

              source:
                ALPHA_NAME,

              found:
                alphaFound,

              message:
                alpha.success
                  ? `Alpha: ${alphaFound} servidor${
                      alphaFound === 1
                        ? ""
                        : "es"
                    } encontrado${
                      alphaFound === 1
                        ? ""
                        : "s"
                    }`
                  : "Alpha no respondió o no encontró servidores",

              http_code:
                alpha.http_code,

              elapsed_ms:
                alpha.elapsed_ms,

              error:
                alpha.error ||
                null
            }
          );

          /*
          |--------------------------------------------------------------------------
          | 5. DECIDIR BETA
          |--------------------------------------------------------------------------
          |
          | Beta se consulta cuando:
          |
          | - Alpha no respondió
          | - Alpha devolvió 4 o menos
          |
          |--------------------------------------------------------------------------
          */

          const shouldUseBeta =
            !alpha.success ||
            alphaFound <= 4;

          let beta = {
            success: false,
            source:
              BETA_NAME,
            links: [],
            endpoint: null,
            error: null,
            http_code: 0
          };

          if (
            shouldUseBeta
          ) {

            /*
            |--------------------------------------------------------------------------
            | BETA SEARCH
            |--------------------------------------------------------------------------
            */

            send(
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
                env.BETA_URL,
                env.BETA_SUPABASE_KEY,
                tmdbId,
                type,
                season,
                episode
              );

            const betaFound =
              beta.links.length;

            /*
            |--------------------------------------------------------------------------
            | BETA FOUND
            |--------------------------------------------------------------------------
            |
            | Diagnóstico detallado
            |--------------------------------------------------------------------------
            */

            send(
              "beta_found",
              {
                success:
                  beta.success,

                status:
                  beta.success
                    ? "beta_found"
                    : "beta_unavailable",

                source:
                  BETA_NAME,

                found:
                  betaFound,

                message:
                  beta.success
                    ? `Beta: ${betaFound} servidor${
                        betaFound === 1
                          ? ""
                          : "es"
                      } encontrado${
                        betaFound === 1
                          ? ""
                          : "s"
                      }`
                    : "Beta no respondió o no encontró servidores",

                http_code:
                  beta.http_code,

                content_type:
                  beta.content_type ||
                  null,

                content_range:
                  beta.content_range ||
                  null,

                rows_received:
                  beta.rows_received ??
                  0,

                endpoint:
                  beta.endpoint ||
                  null,

                error:
                  beta.error ||
                  null,

                response_preview:
                  beta.response_preview ||
                  null
              }
            );

          } else {

            /*
            |--------------------------------------------------------------------------
            | BETA OMITIDO
            |--------------------------------------------------------------------------
            */

            send(
              "beta_skipped",
              {
                success: true,
                status:
                  "beta_skipped",
                source:
                  BETA_NAME,
                reason:
                  "Alpha encontró más de 4 servidores válidos.",
                alpha_found:
                  alphaFound
              }
            );
          }

          /*
          |--------------------------------------------------------------------------
          | MERGE
          |--------------------------------------------------------------------------
          */

          const alphaLinks =
            alpha.links || [];

          const betaLinks =
            beta.links || [];

          /*
          |--------------------------------------------------------------------------
          | Si Alpha tiene <= 4:
          | Beta primero.
          |
          | Si Alpha tiene > 4:
          | Alpha primero.
          |--------------------------------------------------------------------------
          */

          const betaFirst =
            alphaLinks.length <= 4;

          const links =
            mergeLinks(
              alphaLinks,
              betaLinks,
              betaFirst
            );

          /*
          |--------------------------------------------------------------------------
          | COMPLETE
          |--------------------------------------------------------------------------
          */

          const success =
            links.length > 0;

          send(
            "complete",
            {
              success,

              status:
                success
                  ? "complete"
                  : "source_unavailable",

              event:
                "complete",

              source:
                ALPHA_NAME,

              fallback:
                BETA_NAME,

              tmdb_id:
                String(tmdbId),

              type,

              season,

              episode,

              alpha_found:
                alphaLinks.length,

              beta_found:
                betaLinks.length,

              found:
                links.length,

              beta_first:
                betaFirst,

              links,

              message:
                success
                  ? "Búsqueda completada"
                  : "Alpha y Beta no devolvieron servidores válidos.",

              alpha_error:
                alpha.error ||
                null,

              beta_error:
                beta.error ||
                null
            }
          );
        }
      );

    /*
    |--------------------------------------------------------------------------
    | RESPUESTA SSE
    |--------------------------------------------------------------------------
    */

    return new Response(
      stream,
      {
        status: 200,
        headers:
          SSE_HEADERS
      }
    );
  }
};