/*
|--------------------------------------------------------------------------
| TON SCRAPER API
|--------------------------------------------------------------------------
|
| SSE:
|
| 1. Recibiendo datos de TMDB
| 2. Datos de TMDB recibidos
| 3. Buscando servidores
| 4. Consultando Alpha
| 5. Alpha: X servidores encontrados
| 6. Consultando Beta (solo si Alpha <= 4)
| 7. Beta: X servidores encontrados
| 8. Búsqueda completada
|
|--------------------------------------------------------------------------
| Rutas
|--------------------------------------------------------------------------
|
| GET /play/movie/550
|
| GET /play/tv/1399/1/1
|
|--------------------------------------------------------------------------
| Secrets
|--------------------------------------------------------------------------
|
| API_KEY
| SOURCE_URL
|
|--------------------------------------------------------------------------
*/

const ALPHA_NAME = "Alpha";
const BETA_NAME = "Beta";

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
| Headers SSE
|--------------------------------------------------------------------------
*/

const SSE_HEADERS = {
  "content-type": "text/event-stream; charset=UTF-8",
  "cache-control": "no-cache, no-store, must-revalidate",
  "connection": "keep-alive",
  "access-control-allow-origin": "*",
  "access-control-allow-headers":
    "Content-Type, Authorization",
  "access-control-allow-methods":
    "GET, OPTIONS"
};

/*
|--------------------------------------------------------------------------
| Headers JSON
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
| JSON helper
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
| SSE helper
|--------------------------------------------------------------------------
*/

function sseEvent(
  controller,
  event,
  data
) {
  const payload =
    typeof data === "string"
      ? data
      : JSON.stringify(data);

  controller.enqueue(
    new TextEncoder().encode(
      `event: ${event}\ndata: ${payload}\n\n`
    )
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
| Blacklist
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
| Construir URL Alpha
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
| Procesar idioma
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
      rawServerName.trim();

    for (const url of urls) {

      const duplicateKey =
        `${url}|${idioma}`;

      if (
        seen.has(duplicateKey)
      ) {
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
| Extraer enlaces Alpha
|--------------------------------------------------------------------------
|
| PRIORIDAD:
|
| 1. all_embeds
| 2. embeds
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
          url_embed: url,
          servidor:
            rawServerName.trim(),
          idioma
        });
      }
    }
  }

  return links;
}

/*
|--------------------------------------------------------------------------
| Fetch Alpha
|--------------------------------------------------------------------------
*/

async function fetchAlpha(
  sourceUrl,
  tmdbId,
  type,
  season,
  episode
) {

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

    if (!response.ok) {
      return {
        success: false,
        source: ALPHA_NAME,
        endpoint,
        http_code:
          response.status,
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
        JSON.parse(text);
    } catch {
      return {
        success: false,
        source: ALPHA_NAME,
        endpoint,
        http_code:
          response.status,
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
| Fetch Beta
|--------------------------------------------------------------------------
*/

async function fetchBeta(
  sourceUrl,
  tmdbId,
  type,
  season,
  episode,
  apiKey
) {

  const endpoint =
    new URL(sourceUrl);

  endpoint.searchParams.set(
    "tmdb_id",
    String(tmdbId)
  );

  endpoint.searchParams.set(
    "type",
    type
  );

  endpoint.searchParams.set(
    "season",
    String(season)
  );

  endpoint.searchParams.set(
    "episode",
    String(episode)
  );

  const headers = {
    "Accept":
      "application/json",
    "User-Agent":
      "TON-Scraper-Worker/1.0"
  };

  /*
  |--------------------------------------------------------------------------
  | Si Beta utiliza API key,
  | se envía como Bearer.
  |--------------------------------------------------------------------------
  */

  if (apiKey) {
    headers.Authorization =
      `Bearer ${apiKey}`;
  }

  try {

    const response =
      await fetch(
        endpoint.toString(),
        {
          method: "GET",
          headers
        }
      );

    const text =
      await response.text();

    let data;

    try {
      data =
        JSON.parse(text);
    } catch {
      return {
        success: false,
        source: BETA_NAME,
        endpoint:
          endpoint.toString(),
        http_code:
          response.status,
        error:
          "Beta devolvió una respuesta no JSON.",
        links: []
      };
    }

    let links = [];

    /*
    |--------------------------------------------------------------------------
    | Beta -> links
    |--------------------------------------------------------------------------
    */

    if (
      Array.isArray(data?.links)
    ) {

      links =
        data.links
          .filter(
            item =>
              item &&
              typeof item.url_embed ===
                "string"
          )
          .map(item => ({
            url_embed:
              item.url_embed,
            servidor:
              item.servidor ||
              "Desconocido",
            idioma:
              normalizeLanguage(
                item.idioma
              )
          }));

    /*
    |--------------------------------------------------------------------------
    | Beta -> array directo
    |--------------------------------------------------------------------------
    */

    } else if (
      Array.isArray(data)
    ) {

      links =
        data
          .filter(
            item =>
              item &&
              typeof item.url_embed ===
                "string"
          )
          .map(item => ({
            url_embed:
              item.url_embed,
            servidor:
              item.servidor ||
              "Desconocido",
            idioma:
              normalizeLanguage(
                item.idioma
              )
          }));
    }

    /*
    |--------------------------------------------------------------------------
    | Blacklist Beta
    |--------------------------------------------------------------------------
    */

    links =
      links.filter(
        item =>
          !isBlacklistedServer(
            item.servidor
          )
      );

    /*
    |--------------------------------------------------------------------------
    | Duplicados Beta
    |--------------------------------------------------------------------------
    */

    const seen =
      new Set();

    links =
      links.filter(
        item => {

          const key =
            `${item.url_embed}|${item.idioma}`;

          if (
            seen.has(key)
          ) {
            return false;
          }

          seen.add(key);

          return true;
        }
      );

    return {
      success:
        response.ok,
      source: BETA_NAME,
      endpoint:
        endpoint.toString(),
      http_code:
        response.status,
      links
    };

  } catch (error) {

    return {
      success: false,
      source: BETA_NAME,
      endpoint:
        endpoint.toString(),
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
| Combinar Alpha + Beta
|--------------------------------------------------------------------------
|
| Si Beta fue utilizado:
|
| Beta primero
| Alpha después
|
|--------------------------------------------------------------------------
*/

function mergeLinks(
  alphaLinks,
  betaLinks,
  betaFirst = false
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

    if (
      seen.has(key)
    ) {
      continue;
    }

    seen.add(key);

    result.push(link);
  }

  return result;
}

/*
|--------------------------------------------------------------------------
| Singular / plural
|--------------------------------------------------------------------------
*/

function serverLabel(count) {

  if (count === 1) {
    return "1 servidor encontrado";
  }

  return `${count} servidores encontrados`;
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
    | OPTIONS / CORS
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
            "method_not_allowed"
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

    /*
    |--------------------------------------------------------------------------
    | Rutas
    |--------------------------------------------------------------------------
    |
    | /play/movie/550
    |
    | /play/tv/1399/1/1
    |
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

    if (type === "tv") {

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
    | SOURCE_URL
    |--------------------------------------------------------------------------
    */

    const sourceUrl =
      env.SOURCE_URL || "";

    if (!sourceUrl) {

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
    | STREAM SSE
    |--------------------------------------------------------------------------
    */

    const stream =
      new ReadableStream({

        async start(controller) {

          try {

            /*
            |--------------------------------------------------------------------------
            | 1. Recibiendo datos de TMDB
            |--------------------------------------------------------------------------
            */

            sseEvent(
              controller,
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
            | Pequeña pausa para que el Player
            | pueda renderizar el primer estado.
            |--------------------------------------------------------------------------
            */

            await new Promise(
              resolve =>
                setTimeout(
                  resolve,
                  20
                )
            );

            /*
            |--------------------------------------------------------------------------
            | 2. Datos de TMDB recibidos
            |--------------------------------------------------------------------------
            |
            | Aquí no se consulta directamente TMDB.
            | El Worker valida los datos recibidos
            | desde el Player.
            |--------------------------------------------------------------------------
            */

            sseEvent(
              controller,
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
            | 3. Buscando servidores
            |--------------------------------------------------------------------------
            */

            sseEvent(
              controller,
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
            | 4. Consultando Alpha
            |--------------------------------------------------------------------------
            */

            sseEvent(
              controller,
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

            /*
            |--------------------------------------------------------------------------
            | Consultar Alpha
            |--------------------------------------------------------------------------
            */

            const alpha =
              await fetchAlpha(
                sourceUrl,
                tmdbId,
                type,
                season,
                episode
              );

            const alphaLinks =
              alpha.links || [];

            /*
            |--------------------------------------------------------------------------
            | 5. Alpha encontrados
            |--------------------------------------------------------------------------
            */

            sseEvent(
              controller,
              "alpha_found",
              {
                success:
                  alpha.success,
                status:
                  "alpha_found",
                source:
                  ALPHA_NAME,
                message:
                  `Alpha: ${serverLabel(alphaLinks.length)}`,
                found:
                  alphaLinks.length
              }
            );

            /*
            |--------------------------------------------------------------------------
            | Decidir si consultar Beta
            |--------------------------------------------------------------------------
            |
            | Alpha <= 4:
            |     consultar Beta
            |
            | Alpha > 4:
            |     no hace falta Beta
            |--------------------------------------------------------------------------
            */

            const shouldUseBeta =
              alphaLinks.length <= 4;

            let betaLinks = [];
            let beta = null;

            if (shouldUseBeta) {

              /*
              |--------------------------------------------------------------------------
              | 6. Consultando Beta
              |--------------------------------------------------------------------------
              */

              sseEvent(
                controller,
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

              /*
              |--------------------------------------------------------------------------
              | Consultar Beta
              |--------------------------------------------------------------------------
              */

              beta =
                await fetchBeta(
                  sourceUrl,
                  tmdbId,
                  type,
                  season,
                  episode,
                  apiKey
                );

              betaLinks =
                beta.links || [];

              /*
              |--------------------------------------------------------------------------
              | 7. Beta encontrados
              |--------------------------------------------------------------------------
              */

              sseEvent(
                controller,
                "beta_found",
                {
                  success:
                    beta.success,
                  status:
                    "beta_found",
                  source:
                    BETA_NAME,
                  message:
                    `Beta: ${serverLabel(betaLinks.length)}`,
                  found:
                    betaLinks.length
                }
              );

            } else {

              /*
              |--------------------------------------------------------------------------
              | Beta no necesario
              |--------------------------------------------------------------------------
              */

              sseEvent(
                controller,
                "beta_skipped",
                {
                  success: true,
                  status:
                    "beta_skipped",
                  source:
                    BETA_NAME,
                  message:
                    "Beta no consultado: Alpha tiene más de 4 servidores válidos.",
                  alpha_found:
                    alphaLinks.length
                }
              );
            }

            /*
            |--------------------------------------------------------------------------
            | Combinar
            |--------------------------------------------------------------------------
            |
            | Si Beta fue consultado, Beta queda
            | primero en el JSON final.
            |--------------------------------------------------------------------------
            */

            const finalLinks =
              mergeLinks(
                alphaLinks,
                betaLinks,
                shouldUseBeta
              );

            /*
            |--------------------------------------------------------------------------
            | Determinar resultado
            |--------------------------------------------------------------------------
            */

            const success =
              finalLinks.length > 0;

            /*
            |--------------------------------------------------------------------------
            | 8. Búsqueda completada
            |--------------------------------------------------------------------------
            */

            sseEvent(
              controller,
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
                  shouldUseBeta
                    ? BETA_NAME
                    : null,
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
                  finalLinks.length,
                links:
                  finalLinks,
                message:
                  success
                    ? "Búsqueda completada"
                    : "No se encontraron servidores válidos."
              }
            );

          } catch (error) {

            /*
            |--------------------------------------------------------------------------
            | Error inesperado
            |--------------------------------------------------------------------------
            */

            sseEvent(
              controller,
              "complete",
              {
                success: false,
                status:
                  "error",
                event:
                  "complete",
                tmdb_id:
                  String(tmdbId),
                type,
                season,
                episode,
                found: 0,
                links: [],
                message:
                  error?.message ||
                  String(error)
              }
            );

          } finally {

            /*
            |--------------------------------------------------------------------------
            | Cerrar SSE
            |--------------------------------------------------------------------------
            */

            controller.close();
          }
        }
      });

    return new Response(
      stream,
      {
        status: 200,
        headers: SSE_HEADERS
      }
    );
  }
};