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
| 6. Procesa all_embeds de Alpha
| 7. Si all_embeds no produce enlaces, usa embeds
| 8. Si Alpha tiene <= 4 enlaces válidos, consulta Beta
| 9. Beta consulta Supabase REST
| 10. SSE: resultados
| 11. Búsqueda completada
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


const ALPHA_NAME = "Alpha";
const BETA_NAME = "Beta";


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
| HEADERS JSON
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
| JSON RESPONSE
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
| AGREGAR ENLACE
|--------------------------------------------------------------------------
|
| Helper común para Alpha.
|
|--------------------------------------------------------------------------
*/

function addAlphaLink(
  output,
  seen,
  rawServerName,
  rawUrl,
  languageName
) {

  const servidor =
    String(
      rawServerName || ""
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
    return false;
  }

  const url =
    String(
      rawUrl || ""
    ).trim();

  if (
    !/^https?:\/\//i.test(
      url
    )
  ) {
    return false;
  }

  const idioma =
    normalizeLanguage(
      languageName
    );

  const key =
    `${url}|${idioma}`;

  if (
    seen.has(key)
  ) {
    return false;
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

  return true;
}


/*
|--------------------------------------------------------------------------
| PROCESAR all_embeds
|--------------------------------------------------------------------------
|
| Estructura esperada:
|
| all_embeds: {
|   latino: {
|     streamwish: [...]
|   },
|   castellano: {
|     ...
|   }
| }
|
|--------------------------------------------------------------------------
*/

function processAllEmbeds(
  allEmbeds,
  output,
  seen,
  diagnostics
) {

  if (
    !allEmbeds ||
    typeof allEmbeds !==
      "object" ||
    Array.isArray(
      allEmbeds
    )
  ) {
    return;
  }

  diagnostics.all_embeds_languages =
    Object.keys(
      allEmbeds
    );

  for (
    const [
      rawLanguage,
      languageObject
    ] of Object.entries(
      allEmbeds
    )
  ) {

    if (
      !languageObject ||
      typeof languageObject !==
        "object" ||
      Array.isArray(
        languageObject
      )
    ) {
      continue;
    }

    for (
      const [
        rawServerName,
        rawValue
      ] of Object.entries(
        languageObject
      )
    ) {

      diagnostics.all_embeds_servers++;

      const urls =
        extractUrls(
          rawValue
        );

      diagnostics.all_embeds_urls +=
        urls.length;

      for (
        const url of urls
      ) {

        if (
          addAlphaLink(
            output,
            seen,
            rawServerName,
            url,
            rawLanguage
          )
        ) {
          diagnostics.all_embeds_valid++;
        } else {
          diagnostics.all_embeds_discarded++;
        }
      }
    }
  }
}


/*
|--------------------------------------------------------------------------
| PROCESAR embeds
|--------------------------------------------------------------------------
|
| Estructura:
|
| embeds: {
|   streamwish: [...],
|   filelions: [...],
|   voe: [...]
| }
|
| Como embeds no contiene idioma,
| usamos data.language si existe.
|
| Si tampoco existe, usamos "Desconocido".
|
|--------------------------------------------------------------------------
*/

function processEmbeds(
  embeds,
  language,
  output,
  seen,
  diagnostics
) {

  if (
    !embeds ||
    typeof embeds !==
      "object" ||
    Array.isArray(
      embeds
    )
  ) {
    return;
  }

  diagnostics.embeds_servers =
    Object.keys(
      embeds
    );

  for (
    const [
      rawServerName,
      rawValue
    ] of Object.entries(
      embeds
    )
  ) {

    diagnostics.embeds_servers_count++;

    const urls =
      extractUrls(
        rawValue
      );

    diagnostics.embeds_urls +=
      urls.length;

    for (
      const url of urls
    ) {

      if (
        addAlphaLink(
          output,
          seen,
          rawServerName,
          url,
          language
        )
      ) {
        diagnostics.embeds_valid++;
      } else {
        diagnostics.embeds_discarded++;
      }
    }
  }
}


/*
|--------------------------------------------------------------------------
| EXTRAER ENLACES ALPHA
|--------------------------------------------------------------------------
|
| IMPORTANTE:
|
| 1. Primero intenta all_embeds.
| 2. Si all_embeds produjo enlaces, los utiliza.
| 3. Si NO produjo enlaces, usa embeds.
|
|--------------------------------------------------------------------------
*/

function extractAlphaLinks(
  data
) {

  const links = [];
  const seen = new Set();

  const diagnostics = {
    raw_keys:
      data &&
      typeof data === "object"
        ? Object.keys(data)
        : [],

    all_embeds_present:
      !!(
        data &&
        data.all_embeds &&
        typeof data.all_embeds ===
          "object"
      ),

    embeds_present:
      !!(
        data &&
        data.embeds &&
        typeof data.embeds ===
          "object"
      ),

    all_embeds_languages: [],

    all_embeds_servers: 0,

    all_embeds_urls: 0,

    all_embeds_valid: 0,

    all_embeds_discarded: 0,

    embeds_servers: [],

    embeds_servers_count: 0,

    embeds_urls: 0,

    embeds_valid: 0,

    embeds_discarded: 0,

    parser:
      null
  };


  /*
  |--------------------------------------------------------------------------
  | PRIORIDAD 1: all_embeds
  |--------------------------------------------------------------------------
  */

  if (
    data &&
    data.all_embeds &&
    typeof data.all_embeds ===
      "object"
  ) {

    processAllEmbeds(
      data.all_embeds,
      links,
      seen,
      diagnostics
    );

    if (
      links.length > 0
    ) {

      diagnostics.parser =
        "all_embeds";

      return {
        links,
        diagnostics
      };
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
    typeof data.embeds ===
      "object"
  ) {

    /*
    |--------------------------------------------------------------------------
    | embeds no tiene idioma.
    |
    | Intentamos utilizar:
    |
    | data.language
    | data.idioma
    |
    |--------------------------------------------------------------------------
    */

    const language =
      data.language ||
      data.idioma ||
      "Desconocido";

    processEmbeds(
      data.embeds,
      language,
      links,
      seen,
      diagnostics
    );

    if (
      links.length > 0
    ) {

      diagnostics.parser =
        "embeds";

      return {
        links,
        diagnostics
      };
    }
  }


  /*
  |--------------------------------------------------------------------------
  | SIN RESULTADOS
  |--------------------------------------------------------------------------
  */

  diagnostics.parser =
    "none";

  return {
    links: [],
    diagnostics
  };
}


/*
|--------------------------------------------------------------------------
| BUILD ALPHA URL
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
      links: [],
      diagnostics: null
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
      links: [],
      diagnostics: null
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


    /*
    |--------------------------------------------------------------------------
    | HTTP ERROR
    |--------------------------------------------------------------------------
    */

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

        content_type:
          contentType,

        elapsed_ms:
          elapsed,

        error:
          `HTTP ${response.status}`,

        response_preview:
          text.slice(
            0,
            1000
          ),

        links: [],

        diagnostics: null
      };
    }


    /*
    |--------------------------------------------------------------------------
    | PARSE JSON
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
          ALPHA_NAME,

        http_code:
          response.status,

        endpoint,

        content_type:
          contentType,

        elapsed_ms:
          elapsed,

        error:
          "Alpha devolvió una respuesta que no es JSON.",

        response_preview:
          text.slice(
            0,
            1000
          ),

        links: [],

        diagnostics: null
      };
    }


    /*
    |--------------------------------------------------------------------------
    | EXTRAER ENLACES
    |--------------------------------------------------------------------------
    */

    const extracted =
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

      links:
        extracted.links,

      diagnostics:
        extracted.diagnostics,

      /*
      | No devolvemos todo el JSON
      | para no inflar el SSE.
      */
      raw_keys:
        extracted
          .diagnostics
          .raw_keys,

      response_preview:
        text.slice(
          0,
          1000
        )
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

      links: [],

      diagnostics: null
    };
  }
}


/*
|--------------------------------------------------------------------------
| BETA
|--------------------------------------------------------------------------
|
| ESTA PARTE SE MANTIENE COMO LA VERSIÓN
| QUE YA ESTÁ FUNCIONANDO.
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
          text.slice(
            0,
            1000
          ),

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
          text.slice(
            0,
            1000
          ),

        links: []
      };
    }


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
| SSE STREAM
|--------------------------------------------------------------------------
*/

function createSSEStream(
  handler
) {

  const encoder =
    new TextEncoder();

  const stream =
    new ReadableStream({

      start(controller) {

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
    | SSE
    |--------------------------------------------------------------------------
    */

    const stream =
      createSSEStream(
        async send => {

          /*
          |--------------------------------------------------------------------------
          | TMDB RECEIVING
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
          | TMDB RECEIVED
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
          | SEARCHING
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
          | ALPHA SEARCH
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
          | ALPHA FOUND
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

              content_type:
                alpha.content_type ||
                null,

              elapsed_ms:
                alpha.elapsed_ms ||
                null,

              raw_keys:
                alpha.raw_keys ||
                [],

              parser:
                alpha.diagnostics?.parser ||
                null,

              all_embeds_languages:
                alpha.diagnostics
                  ?.all_embeds_languages ||
                [],

              all_embeds_urls:
                alpha.diagnostics
                  ?.all_embeds_urls ||
                0,

              all_embeds_valid:
                alpha.diagnostics
                  ?.all_embeds_valid ||
                0,

              all_embeds_discarded:
                alpha.diagnostics
                  ?.all_embeds_discarded ||
                0,

              embeds_urls:
                alpha.diagnostics
                  ?.embeds_urls ||
                0,

              embeds_valid:
                alpha.diagnostics
                  ?.embeds_valid ||
                0,

              embeds_discarded:
                alpha.diagnostics
                  ?.embeds_discarded ||
                0,

              error:
                alpha.error ||
                null
            }
          );


          /*
          |--------------------------------------------------------------------------
          | DECIDIR BETA
          |--------------------------------------------------------------------------
          |
          | No se modifica la lógica existente.
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
            | BETA SKIPPED
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
    | RESPUESTA
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