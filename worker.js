/*
|--------------------------------------------------------------------------
| TON SCRAPER API
|--------------------------------------------------------------------------
|
| Alpha:
|   - all_embeds -> embeds
|   - blacklist
|   - diagnóstico HTML detallado
|
| Beta:
|   - lógica mantenida
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

const BLACKLISTED_SERVERS = new Set([
  "servidortrinity",
  "servidormahoutokoro",
  "servidordeathstar",
  "servidorgoldmember",
  "powvideo",
  "streamplay"
]);

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

function json(data, status = 200) {
  return new Response(
    JSON.stringify(data, null, 2),
    {
      status,
      headers: JSON_HEADERS
    }
  );
}

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

  return value
    ? value.charAt(0).toUpperCase() + value.slice(1)
    : "Desconocido";
}

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
| ALPHA
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
    String(rawServerName || "").trim();

  if (isBlacklistedServer(servidor)) {
    return false;
  }

  const url =
    String(rawUrl || "").trim();

  if (!/^https?:\/\//i.test(url)) {
    return false;
  }

  const idioma =
    normalizeLanguage(languageName);

  const key = `${url}|${idioma}`;

  if (seen.has(key)) {
    return false;
  }

  seen.add(key);

  output.push({
    url_embed: url,
    servidor,
    idioma
  });

  return true;
}

function processAllEmbeds(
  allEmbeds,
  output,
  seen,
  diagnostics
) {
  if (
    !allEmbeds ||
    typeof allEmbeds !== "object" ||
    Array.isArray(allEmbeds)
  ) {
    return;
  }

  diagnostics.all_embeds_languages =
    Object.keys(allEmbeds);

  for (
    const [rawLanguage, languageObject]
    of Object.entries(allEmbeds)
  ) {
    if (
      !languageObject ||
      typeof languageObject !== "object" ||
      Array.isArray(languageObject)
    ) {
      continue;
    }

    for (
      const [rawServerName, rawValue]
      of Object.entries(languageObject)
    ) {
      diagnostics.all_embeds_servers++;

      const urls = extractUrls(rawValue);

      diagnostics.all_embeds_urls += urls.length;

      for (const url of urls) {
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

function processEmbeds(
  embeds,
  language,
  output,
  seen,
  diagnostics
) {
  if (
    !embeds ||
    typeof embeds !== "object" ||
    Array.isArray(embeds)
  ) {
    return;
  }

  diagnostics.embeds_servers =
    Object.keys(embeds);

  for (
    const [rawServerName, rawValue]
    of Object.entries(embeds)
  ) {
    diagnostics.embeds_servers_count++;

    const urls = extractUrls(rawValue);

    diagnostics.embeds_urls += urls.length;

    for (const url of urls) {
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

function extractAlphaLinks(data) {
  const links = [];
  const seen = new Set();

  const diagnostics = {
    raw_keys:
      data && typeof data === "object"
        ? Object.keys(data)
        : [],

    all_embeds_present:
      !!(
        data &&
        data.all_embeds &&
        typeof data.all_embeds === "object"
      ),

    embeds_present:
      !!(
        data &&
        data.embeds &&
        typeof data.embeds === "object"
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

    parser: null
  };

  if (
    data &&
    data.all_embeds &&
    typeof data.all_embeds === "object"
  ) {
    processAllEmbeds(
      data.all_embeds,
      links,
      seen,
      diagnostics
    );

    if (links.length > 0) {
      diagnostics.parser = "all_embeds";

      return {
        links,
        diagnostics
      };
    }
  }

  if (
    data &&
    data.embeds &&
    typeof data.embeds === "object"
  ) {
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

    if (links.length > 0) {
      diagnostics.parser = "embeds";

      return {
        links,
        diagnostics
      };
    }
  }

  diagnostics.parser = "none";

  return {
    links: [],
    diagnostics
  };
}

function buildAlphaUrl(
  sourceUrl,
  tmdbId,
  type,
  season,
  episode
) {
  const url = new URL(sourceUrl);

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
| ALPHA — FETCH CON DIAGNÓSTICO HTML
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
    endpoint = buildAlphaUrl(
      sourceUrl,
      tmdbId,
      type,
      season,
      episode
    );
  } catch (error) {
    return {
      success: false,
      source: ALPHA_NAME,
      http_code: 0,
      endpoint: null,
      error:
        `SOURCE_URL inválida: ${
          error?.message || String(error)
        }`,
      links: [],
      diagnostics: null
    };
  }

  const started = Date.now();

  try {
    const response = await fetch(
      endpoint,
      {
        method: "GET",
        redirect: "follow",
        headers: {
          "Accept":
            "application/json, text/plain, */*",

          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36",

          "Cache-Control":
            "no-cache",

          "Pragma":
            "no-cache"
        }
      }
    );

    const elapsed =
      Date.now() - started;

    const contentType =
      response.headers.get(
        "content-type"
      ) || "";

    const finalUrl =
      response.url || endpoint;

    const location =
      response.headers.get(
        "location"
      );

    const server =
      response.headers.get(
        "server"
      );

    const cfRay =
      response.headers.get(
        "cf-ray"
      );

    const cfCacheStatus =
      response.headers.get(
        "cf-cache-status"
      );

    const contentLength =
      response.headers.get(
        "content-length"
      );

    const text =
      await response.text();

    /*
    |--------------------------------------------------------------------------
    | HTTP ERROR
    |--------------------------------------------------------------------------
    */

    if (!response.ok) {
      return {
        success: false,
        source: ALPHA_NAME,
        http_code: response.status,
        endpoint,
        final_url: finalUrl,
        content_type: contentType,
        elapsed_ms: elapsed,

        error:
          `HTTP ${response.status}`,

        response_length:
          text.length,

        response_preview:
          text.slice(0, 1500),

        location,
        server,
        cf_ray: cfRay,
        cf_cache_status:
          cfCacheStatus,

        content_length:
          contentLength,

        links: [],
        diagnostics: null
      };
    }

    /*
    |--------------------------------------------------------------------------
    | DIAGNÓSTICO ESPECIAL PARA HTML
    |--------------------------------------------------------------------------
    |
    | Alpha responde HTTP 200 pero text/html.
    | Aquí NO intentamos tratar el HTML como JSON.
    | Devolvemos información suficiente para saber
    | qué está entregando realmente Alpha.
    |--------------------------------------------------------------------------
    */

    if (
      contentType
        .toLowerCase()
        .includes("text/html")
    ) {
      return {
        success: false,
        source: ALPHA_NAME,

        http_code:
          response.status,

        endpoint,

        final_url:
          finalUrl,

        content_type:
          contentType,

        elapsed_ms:
          elapsed,

        error:
          "Alpha respondió HTTP 200 pero Content-Type es text/html en lugar de JSON.",

        response_length:
          text.length,

        response_preview:
          text.slice(0, 2000),

        response_start:
          text.slice(0, 500),

        response_end:
          text.slice(
            Math.max(
              0,
              text.length - 500
            )
          ),

        location,

        server,

        cf_ray:
          cfRay,

        cf_cache_status:
          cfCacheStatus,

        content_length:
          contentLength,

        looks_like_cloudflare:
          /cloudflare|cf-chl|challenge-platform|just a moment/i.test(
            text
          ),

        looks_like_login:
          /login|sign in|iniciar sesión|iniciar sesion/i.test(
            text
          ),

        looks_like_error_page:
          /error|forbidden|access denied|not found|unauthorized/i.test(
            text
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
      data = JSON.parse(text);
    } catch {
      return {
        success: false,
        source: ALPHA_NAME,

        http_code:
          response.status,

        endpoint,

        final_url:
          finalUrl,

        content_type:
          contentType,

        elapsed_ms:
          elapsed,

        error:
          "Alpha devolvió una respuesta que no es JSON.",

        response_length:
          text.length,

        response_preview:
          text.slice(0, 2000),

        location,
        server,
        cf_ray:
          cfRay,

        cf_cache_status:
          cfCacheStatus,

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
      extractAlphaLinks(data);

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

      endpoint,

      final_url:
        finalUrl,

      links:
        extracted.links,

      diagnostics:
        extracted.diagnostics,

      raw_keys:
        extracted.diagnostics.raw_keys,

      response_length:
        text.length
    };

  } catch (error) {
    return {
      success: false,

      source:
        ALPHA_NAME,

      http_code: 0,

      endpoint,

      elapsed_ms:
        Date.now() - started,

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
| MANTENIDO.
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
    String(betaUrl || "")
      .trim()
      .replace(/\/+$/, "");

  if (
    base.endsWith(
      "/rest/v1/enlaces"
    )
  ) {
    // Correcto.
  } else if (
    base.endsWith(
      "/rest/v1"
    )
  ) {
    base += "/enlaces";
  } else {
    base += "/rest/v1/enlaces";
  }

  const url =
    new URL(base);

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
  if (!betaUrl) {
    return {
      success: false,
      source: BETA_NAME,
      http_code: 0,
      endpoint: null,
      error:
        "El Secret BETA_URL no está configurado.",
      links: []
    };
  }

  if (!betaSupabaseKey) {
    return {
      success: false,
      source: BETA_NAME,
      http_code: 0,
      endpoint: null,
      error:
        "El Secret BETA_SUPABASE_KEY no está configurado.",
      links: []
    };
  }

  let endpoint;

  try {
    endpoint = buildBetaUrl(
      betaUrl,
      tmdbId,
      type,
      season,
      episode
    );
  } catch (error) {
    return {
      success: false,
      source: BETA_NAME,
      http_code: 0,
      endpoint: null,
      error:
        `BETA_URL inválida: ${
          error?.message || String(error)
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

    if (!response.ok) {
      let errorData = null;

      try {
        errorData =
          JSON.parse(text);
      } catch {}

      return {
        success: false,
        source: BETA_NAME,
        http_code: httpCode,
        content_type: contentType,
        content_range: contentRange,
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

    let data;

    try {
      data = JSON.parse(text);
    } catch {
      return {
        success: false,
        source: BETA_NAME,
        http_code: httpCode,
        content_type: contentType,
        content_range: contentRange,
        endpoint,

        error:
          "Beta respondió HTTP 200 pero el cuerpo no es JSON.",

        response_preview:
          text.slice(0, 1000),

        links: []
      };
    }

    if (!Array.isArray(data)) {
      return {
        success: false,
        source: BETA_NAME,
        http_code: httpCode,
        content_type: contentType,
        content_range: contentRange,
        endpoint,

        error:
          "Beta devolvió JSON pero no un array.",

        response_preview:
          JSON.stringify(data)
            .slice(0, 1000),

        links: []
      };
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
        String(
          item.url_embed || ""
        ).trim();

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

    return {
      success: true,
      source: BETA_NAME,
      http_code: httpCode,
      content_type: contentType,
      content_range: contentRange,
      endpoint,
      rows_received:
        data.length,
      links
    };

  } catch (error) {
    return {
      success: false,
      source: BETA_NAME,
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
| SSE
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
          (event, data) => {
            controller.enqueue(
              encoder.encode(
                `event: ${event}\n` +
                `data: ${JSON.stringify(data)}\n\n`
              )
            );
          };

        Promise.resolve()
          .then(
            () => handler(send)
          )
          .then(
            () => {
              try {
                controller.close();
              } catch {}
            }
          )
          .catch(error => {
            send(
              "error",
              {
                success: false,
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
          });
      }
    });

  return stream;
}


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

    if (
      url.pathname === "/"
    ) {
      return json({
        success: true,
        status: "online",
        event: "complete",
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
          | ALPHA
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
          | DIAGNÓSTICO ALPHA
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

              endpoint:
                alpha.endpoint ||
                null,

              final_url:
                alpha.final_url ||
                null,

              response_length:
                alpha.response_length ??
                null,

              response_preview:
                alpha.response_preview ||
                null,

              response_start:
                alpha.response_start ||
                null,

              response_end:
                alpha.response_end ||
                null,

              location:
                alpha.location ||
                null,

              server:
                alpha.server ||
                null,

              cf_ray:
                alpha.cf_ray ||
                null,

              cf_cache_status:
                alpha.cf_cache_status ||
                null,

              content_length:
                alpha.content_length ||
                null,

              looks_like_cloudflare:
                alpha.looks_like_cloudflare ??
                false,

              looks_like_login:
                alpha.looks_like_login ??
                false,

              looks_like_error_page:
                alpha.looks_like_error_page ??
                false,

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
          | BETA
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