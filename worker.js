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
| FLUJO
|--------------------------------------------------------------------------
|
| 1. Recibe TMDB ID
| 2. Consulta Alpha
| 3. Extrae all_embeds -> embeds
| 4. Filtra blacklist
| 5. Si Alpha falla, consulta Beta
| 6. Si Alpha tiene <= 4 enlaces, consulta Beta
| 7. Si Beta se utiliza como fallback, Beta aparece primero
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
| HEADERS SSE
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
| JSON HELPER
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
  return String(
    name || ""
  )
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
    value ===
      "español latino" ||
    value ===
      "espanol latino"
  ) {
    return "Latino";
  }

  if (
    value ===
      "castellano" ||
    value ===
      "español" ||
    value ===
      "espanol"
  ) {
    return "Castellano";
  }

  if (
    value ===
      "subtitulado" ||
    value ===
      "subtitle" ||
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
| PROCESAR OBJETO DE IDIOMA ALPHA
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

  const idioma =
    normalizeLanguage(
      languageName
    );

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

    if (!urls.length) {
      continue;
    }

    const servidor =
      String(
        rawServerName
      ).trim();

    for (const url of urls) {
      const duplicateKey =
        `${url}|${idioma}`;

      if (
        seen.has(
          duplicateKey
        )
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
| EXTRAER LINKS ALPHA
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

      if (!urls.length) {
        continue;
      }

      for (const url of urls) {
        const duplicateKey =
          `${url}|${idioma}`;

        if (
          seen.has(
            duplicateKey
          )
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
    new URL(
      sourceUrl
    );

  url.searchParams.set(
    "action",
    "details"
  );

  url.searchParams.set(
    "id",
    String(
      tmdbId
    )
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
      String(
        season
      )
    );

    url.searchParams.set(
      "episode",
      String(
        episode
      )
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
      source:
        ALPHA_NAME,

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

  const started =
    Date.now();

  try {
    const response =
      await fetch(
        endpoint,
        {
          method:
            "GET",

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
      data =
        JSON.parse(
          text
        );
    } catch {
      return {
        success: false,
        source:
          ALPHA_NAME,

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
      extractAlphaLinks(
        data
      );

    return {
      success:
        true,

      source:
        ALPHA_NAME,

      endpoint,

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
      success:
        false,

      source:
        ALPHA_NAME,

      endpoint,

      http_code:
        0,

      elapsed_ms:
        Date.now() -
        started,

      error:
        error?.message ||
        String(
          error
        ),

      links: []
    };
  }
}

/*
|--------------------------------------------------------------------------
| CONSTRUIR URL BETA
|--------------------------------------------------------------------------
|
| Supabase REST / PostgREST
|
| Ejemplo:
|
| /rest/v1/enlaces
|   ?tmdb_id=eq.44956
|   &tipo=eq.movie
|   &temporada=eq.0
|   &episodio=eq.0
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
    new URL(
      betaUrl
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

  url.searchParams.set(
    "order",
    "id.asc"
  );

  return url.toString();
}

/*
|--------------------------------------------------------------------------
| NORMALIZAR LINKS BETA
|--------------------------------------------------------------------------
*/

function normalizeBetaLinks(
  data
) {
  if (
    !Array.isArray(data)
  ) {
    return [];
  }

  const links = [];
  const seen =
    new Set();

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
      typeof item.url_embed ===
        "string"
        ? item.url_embed.trim()
        : "";

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

  return links;
}

/*
|--------------------------------------------------------------------------
| FETCH BETA
|--------------------------------------------------------------------------
|
| ESTA ES LA PARTE CORREGIDA.
|
| Beta es Supabase REST.
|
| Se envían:
|
| apikey
| Authorization: Bearer
| Accept: application/json
|
| Además se conserva información de diagnóstico.
|
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
  /*
  |--------------------------------------------------------------------------
  | Validar URL
  |--------------------------------------------------------------------------
  */

  if (!betaUrl) {
    return {
      success:
        false,

      source:
        BETA_NAME,

      http_code:
        0,

      content_type:
        "",

      endpoint:
        null,

      error:
        "El Secret BETA_URL no está configurado.",

      links: []
    };
  }

  /*
  |--------------------------------------------------------------------------
  | Validar key
  |--------------------------------------------------------------------------
  */

  if (!betaSupabaseKey) {
    return {
      success:
        false,

      source:
        BETA_NAME,

      http_code:
        0,

      content_type:
        "",

      endpoint:
        null,

      error:
        "El Secret BETA_SUPABASE_KEY no está configurado.",

      links: []
    };
  }

  let endpoint;

  /*
  |--------------------------------------------------------------------------
  | Construir endpoint
  |--------------------------------------------------------------------------
  */

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
      success:
        false,

      source:
        BETA_NAME,

      http_code:
        0,

      content_type:
        "",

      endpoint:
        null,

      error:
        `BETA_URL inválida: ${
          error?.message ||
          String(error)
        }`,

      links: []
    };
  }

  /*
  |--------------------------------------------------------------------------
  | FETCH
  |--------------------------------------------------------------------------
  */

  try {
    const response =
      await fetch(
        endpoint,
        {
          method:
            "GET",

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

    /*
    |--------------------------------------------------------------------------
    | Diagnóstico HTTP
    |--------------------------------------------------------------------------
    */

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
    | Si Supabase devuelve HTTP != 2xx
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
        success:
          false,

        source:
          BETA_NAME,

        endpoint,

        http_code:
          httpCode,

        content_type:
          contentType,

        content_range:
          contentRange,

        error:
          errorData?.message ||
          errorData?.error ||
          errorData?.hint ||
          `HTTP ${httpCode}`,

        response_preview:
          text.slice(
            0,
            500
          ),

        links: []
      };
    }

    /*
    |--------------------------------------------------------------------------
    | Comprobar content-type
    |--------------------------------------------------------------------------
    |
    | No rechazamos automáticamente la respuesta.
    | Intentamos JSON igualmente porque Supabase
    | puede responder correctamente aunque el header
    | no sea exactamente el esperado.
    |--------------------------------------------------------------------------
    */

    let data;

    try {
      data =
        JSON.parse(
          text
        );
    } catch (
      error
    ) {
      return {
        success:
          false,

        source:
          BETA_NAME,

        endpoint,

        http_code:
          httpCode,

        content_type:
          contentType,

        content_range:
          contentRange,

        error:
          "Beta devolvió HTTP 200 pero el cuerpo no pudo interpretarse como JSON.",

        response_preview:
          text.slice(
            0,
            500
          ),

        links: []
      };
    }

    /*
    |--------------------------------------------------------------------------
    | Validar estructura
    |--------------------------------------------------------------------------
    */

    if (
      !Array.isArray(
        data
      )
    ) {
      return {
        success:
          false,

        source:
          BETA_NAME,

        endpoint,

        http_code:
          httpCode,

        content_type:
          contentType,

        content_range:
          contentRange,

        error:
          "Beta devolvió JSON, pero no devolvió un array de enlaces.",

        response_type:
          typeof data,

        response_preview:
          JSON.stringify(
            data
          ).slice(
            0,
            500
          ),

        links: []
      };
    }

    /*
    |--------------------------------------------------------------------------
    | NORMALIZAR
    |--------------------------------------------------------------------------
    */

    const links =
      normalizeBetaLinks(
        data
      );

    /*
    |--------------------------------------------------------------------------
    | RESPUESTA CORRECTA
    |--------------------------------------------------------------------------
    */

    return {
      success:
        true,

      source:
        BETA_NAME,

      endpoint,

      http_code:
        httpCode,

      content_type:
        contentType,

      content_range:
        contentRange,

      rows_received:
        data.length,

      links
    };

  } catch (
    error
  ) {
    return {
      success:
        false,

      source:
        BETA_NAME,

      endpoint,

      http_code:
        0,

      content_type:
        "",

      error:
        error?.message ||
        String(
          error
        ),

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
  const seen =
    new Set();

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

function formatSSE(
  event,
  data
) {
  return (
    `event: ${event}\n` +
    `data: ${JSON.stringify(
      data
    )}\n\n`
  );
}

/*
|--------------------------------------------------------------------------
| AUTORIZACIÓN
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

  return (
    suppliedKey ===
    apiKey
  );
}

/*
|--------------------------------------------------------------------------
| PARSEAR RUTA
|--------------------------------------------------------------------------
*/

function parsePlayPath(
  pathname
) {
  const parts =
    pathname
      .split("/")
      .filter(Boolean);

  if (
    parts.length < 3 ||
    (
      parts[0] !==
        "play" &&
      parts[0] !==
        "events"
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
| BÚSQUEDA
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
  | TMDB RECEIVING
  |--------------------------------------------------------------------------
  */

  if (sendEvent) {
    await sendEvent(
      "tmdb_receiving",
      {
        success:
          true,

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
        success:
          true,

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
        success:
          true,

        status:
          "searching",

        message:
          "Buscando servidores"
      }
    );

    await sendEvent(
      "alpha_search",
      {
        success:
          true,

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
  | ALPHA FOUND
  |--------------------------------------------------------------------------
  */

  if (sendEvent) {
    if (
      alpha.success &&
      alphaFound > 0
    ) {
      await sendEvent(
        "alpha_found",
        {
          success:
            true,

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
      );
    } else {
      await sendEvent(
        "alpha_found",
        {
          success:
            false,

          status:
            "alpha_unavailable",

          source:
            ALPHA_NAME,

          found:
            0,

          message:
            "Alpha no respondió o no encontró servidores",

          error:
            alpha.error ||
            "Sin enlaces válidos"
        }
      );
    }
  }

  /*
  |--------------------------------------------------------------------------
  | DECIDIR BETA
  |--------------------------------------------------------------------------
  */

  const shouldQueryBeta =
    !alpha.success ||
    alphaFound <=
      ALPHA_LIMIT_FOR_BETA;

  let beta = {
    success:
      false,

    source:
      BETA_NAME,

    links: []
  };

  /*
  |--------------------------------------------------------------------------
  | BETA
  |--------------------------------------------------------------------------
  */

  if (
    shouldQueryBeta
  ) {
    if (sendEvent) {
      await sendEvent(
        "beta_search",
        {
          success:
            true,

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

    /*
    |--------------------------------------------------------------------------
    | BETA FOUND
    |--------------------------------------------------------------------------
    |
    | Ahora incluye diagnóstico.
    |--------------------------------------------------------------------------
    */

    if (sendEvent) {
      if (
        beta.success
      ) {
        await sendEvent(
          "beta_found",
          {
            success:
              true,

            status:
              betaFound > 0
                ? "beta_found"
                : "beta_empty",

            source:
              BETA_NAME,

            found:
              betaFound,

            message:
              `Beta: ${betaFound} ${
                betaFound === 1
                  ? "servidor"
                  : "servidores"
              } encontrados`,

            http_code:
              beta.http_code,

            content_type:
              beta.content_type,

            content_range:
              beta.content_range,

            rows_received:
              beta.rows_received,

            endpoint:
              beta.endpoint
          }
        );
      } else {
        await sendEvent(
          "beta_found",
          {
            success:
              false,

            status:
              "beta_unavailable",

            source:
              BETA_NAME,

            found:
              0,

            message:
              "Beta no respondió o no encontró servidores",

            error:
              beta.error ||
              "Error desconocido",

            http_code:
              beta.http_code,

            content_type:
              beta.content_type,

            content_range:
              beta.content_range,

            endpoint:
              beta.endpoint,

            response_preview:
              beta.response_preview ||
              null
          }
        );
      }
    }
  }

  /*
  |--------------------------------------------------------------------------
  | BETA FIRST
  |--------------------------------------------------------------------------
  */

  const betaFirst =
    shouldQueryBeta &&
    beta.links.length >
      0;

  /*
  |--------------------------------------------------------------------------
  | COMBINAR
  |--------------------------------------------------------------------------
  */

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
      links.length >
      0,

    status:
      links.length >
      0
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

  if (
    !links.length
  ) {
    result.message =
      "Alpha y Beta no devolvieron servidores válidos.";

    result.alpha_error =
      alpha.error ||
      null;

    result.beta_error =
      beta.error ||
      null;
  } else {
    result.message =
      "Búsqueda completada";
  }

  /*
  |--------------------------------------------------------------------------
  | COMPLETE
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
          status:
            204,

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
          success:
            false,

          status:
            "method_not_allowed"
        },
        405
      );
    }

    /*
    |--------------------------------------------------------------------------
    | HEALTH CHECK
    |--------------------------------------------------------------------------
    */

    if (
      url.pathname ===
      "/"
    ) {
      return json({
        success:
          true,

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

    if (
      !authorize(
        request,
        url,
        env.API_KEY
      )
    ) {
      return json(
        {
          success:
            false,

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
    | RUTA
    |--------------------------------------------------------------------------
    */

    const route =
      parsePlayPath(
        url.pathname
      );

    if (!route) {
      return json(
        {
          success:
            false,

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
      mode ===
      "events"
    ) {
      const encoder =
        new TextEncoder();

      let controllerRef;

      const stream =
        new ReadableStream({
          start(
            controller
          ) {
            controllerRef =
              controller;
          },

          cancel() {
            controllerRef =
              null;
          }
        });

      const response =
        new Response(
          stream,
          {
            status:
              200,

            headers:
              SSE_HEADERS
          }
        );

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
                  controllerRef =
                    null;
                }
              };

            /*
            |--------------------------------------------------------------------------
            | Keep-alive
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

            if (
              controllerRef
            ) {
              controllerRef.close();

              controllerRef =
                null;
            }

          } catch (
            error
          ) {
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
                          String(
                            error
                          )
                      }
                    )
                  )
                );

                controllerRef.close();
              } catch {}

              controllerRef =
                null;
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