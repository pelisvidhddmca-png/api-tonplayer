/*
|--------------------------------------------------------------------------
| TON SCRAPER API
|--------------------------------------------------------------------------
|
| SSE REAL + FALLBACK ALPHA -> BETA
|
| Flujo:
|
| 1. Recibe TMDB ID
| 2. Envía eventos SSE inmediatamente
| 3. Consulta Alpha
| 4. Extrae all_embeds
| 5. Si no existe/está vacío, usa embeds
| 6. Filtra blacklist
| 7. Si Alpha falla/no responde/no tiene enlaces:
|       -> consulta Beta
| 8. Si Alpha tiene <= 4 enlaces:
|       -> consulta Beta
| 9. Si Alpha tiene > 4 enlaces:
|       -> no consulta Beta
| 10. Si se consulta Beta:
|       -> Beta aparece primero en el JSON
| 11. Elimina duplicados
| 12. Envía complete con los enlaces
|
|--------------------------------------------------------------------------
| SECRETS
|--------------------------------------------------------------------------
|
| API_KEY
| SOURCE_URL
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
  "cache-control": "no-cache, no-transform",
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "Content-Type, Authorization",
  "access-control-allow-methods": "GET, OPTIONS",
  "connection": "keep-alive"
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
| Idiomas
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

  return value
    ? value.charAt(0).toUpperCase() + value.slice(1)
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
| Procesar objeto de idioma
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
    const [rawServerName, rawValue]
    of Object.entries(languageObject)
  ) {

    if (
      isBlacklistedServer(rawServerName)
    ) {
      continue;
    }

    const urls = extractUrls(rawValue);

    if (!urls.length) {
      continue;
    }

    const idioma =
      normalizeLanguage(languageName);

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
| Extraer enlaces de Alpha
|--------------------------------------------------------------------------
|
| PRIORIDAD:
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
      const [language, languageObject]
      of Object.entries(data.all_embeds)
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
      const [rawServerName, rawValue]
      of Object.entries(data.embeds)
    ) {

      if (
        isBlacklistedServer(rawServerName)
      ) {
        continue;
      }

      const urls = extractUrls(rawValue);

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

  const started = Date.now();

  try {

    const response =
      await fetch(
        endpoint,
        {
          method: "GET",
          headers: {
            "Accept": "application/json",
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
        http_code: response.status,
        content_type: contentType,
        elapsed_ms: elapsed,
        error:
          `Alpha respondió HTTP ${response.status}`,
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
        http_code: response.status,
        content_type: contentType,
        elapsed_ms: elapsed,
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
      http_code: response.status,
      content_type: contentType,
      elapsed_ms: elapsed,
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
    "Accept": "application/json",
    "User-Agent":
      "TON-Scraper-Worker/1.0"
  };

  if (apiKey) {
    headers.Authorization =
      `Bearer ${apiKey}`;
  }

  const started = Date.now();

  try {

    const response =
      await fetch(
        endpoint.toString(),
        {
          method: "GET",
          headers
        }
      );

    const elapsed =
      Date.now() - started;

    const text =
      await response.text();

    let data;

    try {
      data = JSON.parse(text);
    } catch {

      return {
        success: false,
        source: BETA_NAME,
        endpoint:
          endpoint.toString(),
        http_code:
          response.status,
        elapsed_ms: elapsed,
        error:
          "Beta devolvió una respuesta no JSON.",
        links: []
      };
    }

    let links = [];

    /*
    |--------------------------------------------------------------------------
    | Formato:
    |
    | { links: [...] }
    |--------------------------------------------------------------------------
    */

    if (Array.isArray(data?.links)) {

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
    | Formato:
    |
    | [...]
    |--------------------------------------------------------------------------
    */

    } else if (Array.isArray(data)) {

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
    | Blacklist
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
    | Duplicados
    |--------------------------------------------------------------------------
    */

    const seen = new Set();

    links =
      links.filter(item => {

        const key =
          `${item.url_embed}|${item.idioma}`;

        if (seen.has(key)) {
          return false;
        }

        seen.add(key);

        return true;
      });

    return {
      success:
        response.ok,
      source: BETA_NAME,
      endpoint:
        endpoint.toString(),
      http_code:
        response.status,
      elapsed_ms: elapsed,
      links
    };

  } catch (error) {

    return {
      success: false,
      source: BETA_NAME,
      endpoint:
        endpoint.toString(),
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
| Combinar enlaces
|--------------------------------------------------------------------------
|
| Cuando Beta participa:
|
| Beta -> Alpha
|
| Si Alpha es suficiente:
|
| Alpha
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
| Crear SSE
|--------------------------------------------------------------------------
*/

function createSSE() {

  let controllerRef;

  const stream =
    new ReadableStream({

      start(controller) {
        controllerRef =
          controller;
      }

    });

  return {
    stream,
    controller: controllerRef
  };
}

/*
|--------------------------------------------------------------------------
| Enviar evento SSE
|--------------------------------------------------------------------------
*/

function sendSSE(
  controller,
  event,
  data
) {

  if (!controller) {
    return;
  }

  const payload =
    typeof data === "string"
      ? data
      : JSON.stringify(data);

  controller.enqueue(
    new TextEncoder().encode(
      `event: ${event}\n` +
      `data: ${payload}\n\n`
    )
  );
}

/*
|--------------------------------------------------------------------------
| Heartbeat SSE
|--------------------------------------------------------------------------
*/

function sendHeartbeat(controller) {

  if (!controller) {
    return;
  }

  controller.enqueue(
    new TextEncoder().encode(
      `: heartbeat\n\n`
    )
  );
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
          headers: SSE_HEADERS
        }
      );
    }

    /*
    |--------------------------------------------------------------------------
    | Solo GET
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
    | Health check
    |--------------------------------------------------------------------------
    */

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
        suppliedKey !== apiKey
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
    | Ruta
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
      parts[0] !== "play"
    ) {

      return json(
        {
          success: false,
          status: "not_found",
          event: "complete"
        },
        404
      );
    }

    const type = parts[1];

    if (
      type !== "movie" &&
      type !== "tv"
    ) {

      return json(
        {
          success: false,
          status: "invalid_type",
          event: "complete"
        },
        400
      );
    }

    const tmdbId = parts[2];

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
    | SSE STREAM
    |--------------------------------------------------------------------------
    */

    const encoder =
      new TextEncoder();

    let controller;

    const stream =
      new ReadableStream({

        start(c) {

          controller = c;

          /*
          |--------------------------------------------------------------------------
          | HEARTBEAT INICIAL
          |--------------------------------------------------------------------------
          */

          c.enqueue(
            encoder.encode(
              ": connected\n\n"
            )
          );

          /*
          |--------------------------------------------------------------------------
          | Ejecutar flujo
          |--------------------------------------------------------------------------
          */

          runSearchFlow({
            controller,
            sourceUrl,
            apiKey,
            tmdbId,
            type,
            season,
            episode
          })
            .catch(error => {

              sendSSE(
                controller,
                "complete",
                {
                  success: false,
                  status:
                    "internal_error",
                  event:
                    "complete",
                  message:
                    error?.message ||
                    String(error)
                }
              );

            })
            .finally(() => {

              try {
                controller.close();
              } catch {}

            });
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

/*
|--------------------------------------------------------------------------
| Flujo principal SSE
|--------------------------------------------------------------------------
*/

async function runSearchFlow({
  controller,
  sourceUrl,
  apiKey,
  tmdbId,
  type,
  season,
  episode
}) {

  /*
  |--------------------------------------------------------------------------
  | TMDB
  |--------------------------------------------------------------------------
  */

  sendSSE(
    controller,
    "tmdb_receiving",
    {
      success: true,
      status:
        "tmdb_receiving",
      message:
        "Recibiendo datos de TMDB",
      tmdb_id: tmdbId,
      type,
      season,
      episode
    }
  );

  /*
  |--------------------------------------------------------------------------
  | Pequeña pausa para permitir
  | que el evento sea observable.
  |--------------------------------------------------------------------------
  */

  await sleep(10);

  sendSSE(
    controller,
    "tmdb_received",
    {
      success: true,
      status:
        "tmdb_received",
      message:
        "Datos de TMDB recibidos",
      tmdb_id: tmdbId,
      type,
      season,
      episode
    }
  );

  await sleep(10);

  /*
  |--------------------------------------------------------------------------
  | BUSCANDO
  |--------------------------------------------------------------------------
  */

  sendSSE(
    controller,
    "searching",
    {
      success: true,
      status: "searching",
      message:
        "Buscando servidores"
    }
  );

  await sleep(10);

  /*
  |--------------------------------------------------------------------------
  | ALPHA
  |--------------------------------------------------------------------------
  */

  sendSSE(
    controller,
    "alpha_search",
    {
      success: true,
      status:
        "searching_alpha",
      source: ALPHA_NAME,
      message:
        "Consultando Alpha"
    }
  );

  /*
  |--------------------------------------------------------------------------
  | Heartbeat mientras Alpha responde.
  |
  | No bloquea la consulta.
  |--------------------------------------------------------------------------
  */

  const alphaPromise =
    fetchAlpha(
      sourceUrl,
      tmdbId,
      type,
      season,
      episode
    );

  let alpha;

  /*
  |--------------------------------------------------------------------------
  | Esperamos Alpha.
  |--------------------------------------------------------------------------
  */

  alpha =
    await alphaPromise;

  /*
  |--------------------------------------------------------------------------
  | ALPHA RESULTADO
  |--------------------------------------------------------------------------
  */

  if (
    alpha.success &&
    alpha.links.length > 0
  ) {

    sendSSE(
      controller,
      "alpha_found",
      {
        success: true,
        status:
          "alpha_found",
        source:
          ALPHA_NAME,
        found:
          alpha.links.length,
        message:
          `Alpha: ${alpha.links.length} ` +
          `servidor${
            alpha.links.length === 1
              ? ""
              : "es"
          } encontrado${
            alpha.links.length === 1
              ? ""
              : "s"
          }`
      }
    );

  } else {

    sendSSE(
      controller,
      "alpha_found",
      {
        success: false,
        status:
          "alpha_unavailable",
        source:
          ALPHA_NAME,
        found: 0,
        message:
          "Alpha no respondió o no encontró servidores",
        error:
          alpha.error || null
      }
    );
  }

  /*
  |--------------------------------------------------------------------------
  | DECISIÓN DE BETA
  |--------------------------------------------------------------------------
  |
  | Beta se consulta cuando:
  |
  | A) Alpha falló
  | B) Alpha no tiene enlaces
  | C) Alpha tiene <= 4 enlaces
  |
  |--------------------------------------------------------------------------
  */

  const alphaFailed =
    !alpha.success ||
    alpha.links.length === 0;

  const alphaInsufficient =
    alpha.success &&
    alpha.links.length > 0 &&
    alpha.links.length <= 4;

  const shouldUseBeta =
    alphaFailed ||
    alphaInsufficient;

  /*
  |--------------------------------------------------------------------------
  | ALPHA SUFICIENTE
  |--------------------------------------------------------------------------
  */

  if (!shouldUseBeta) {

    sendSSE(
      controller,
      "complete",
      {
        success: true,
        status:
          "complete",
        event:
          "complete",
        source:
          ALPHA_NAME,
        fallback:
          BETA_NAME,
        tmdb_id: tmdbId,
        type,
        season,
        episode,
        alpha_found:
          alpha.links.length,
        beta_found: 0,
        found:
          alpha.links.length,
        links:
          mergeLinks(
            alpha.links,
            [],
            false
          ),
        message:
          "Búsqueda completada"
      }
    );

    return;
  }

  /*
  |--------------------------------------------------------------------------
  | BETA
  |--------------------------------------------------------------------------
  */

  sendSSE(
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

  await sleep(10);

  const beta =
    await fetchBeta(
      sourceUrl,
      tmdbId,
      type,
      season,
      episode,
      apiKey
    );

  /*
  |--------------------------------------------------------------------------
  | BETA RESULTADO
  |--------------------------------------------------------------------------
  */

  if (
    beta.success &&
    beta.links.length > 0
  ) {

    sendSSE(
      controller,
      "beta_found",
      {
        success: true,
        status:
          "beta_found",
        source:
          BETA_NAME,
        found:
          beta.links.length,
        message:
          `Beta: ${beta.links.length} ` +
          `servidor${
            beta.links.length === 1
              ? ""
              : "es"
          } encontrado${
            beta.links.length === 1
              ? ""
              : "s"
          }`
      }
    );

  } else {

    sendSSE(
      controller,
      "beta_found",
      {
        success: false,
        status:
          "beta_unavailable",
        source:
          BETA_NAME,
        found: 0,
        message:
          "Beta no respondió o no encontró servidores",
        error:
          beta.error || null
      }
    );
  }

  /*
  |--------------------------------------------------------------------------
  | COMBINACIÓN FINAL
  |--------------------------------------------------------------------------
  |
  | Si Beta participa, va primero.
  |--------------------------------------------------------------------------
  */

  const finalLinks =
    mergeLinks(
      alpha.links,
      beta.links,
      true
    );

  /*
  |--------------------------------------------------------------------------
  | FUENTE FINAL
  |--------------------------------------------------------------------------
  */

  let finalSource;

  if (
    beta.success &&
    beta.links.length > 0
  ) {
    finalSource = BETA_NAME;
  } else if (
    alpha.success &&
    alpha.links.length > 0
  ) {
    finalSource = ALPHA_NAME;
  } else {
    finalSource = null;
  }

  /*
  |--------------------------------------------------------------------------
  | TODO FALLÓ
  |--------------------------------------------------------------------------
  */

  if (finalLinks.length === 0) {

    sendSSE(
      controller,
      "complete",
      {
        success: false,
        status:
          "source_unavailable",
        event:
          "complete",
        source:
          ALPHA_NAME,
        fallback:
          BETA_NAME,
        tmdb_id: tmdbId,
        type,
        season,
        episode,
        alpha_found:
          alpha.links.length,
        beta_found:
          beta.links.length,
        found: 0,
        links: [],
        message:
          "Alpha y Beta no devolvieron servidores válidos."
      }
    );

    return;
  }

  /*
  |--------------------------------------------------------------------------
  | COMPLETE
  |--------------------------------------------------------------------------
  */

  sendSSE(
    controller,
    "complete",
    {
      success: true,
      status:
        "complete",
      event:
        "complete",
      source:
        finalSource,
      fallback:
        finalSource === BETA_NAME
          ? ALPHA_NAME
          : BETA_NAME,
      tmdb_id: tmdbId,
      type,
      season,
      episode,
      alpha_found:
        alpha.links.length,
      beta_found:
        beta.links.length,
      found:
        finalLinks.length,
      links:
        finalLinks,
      message:
        "Búsqueda completada"
    }
  );
}

/*
|--------------------------------------------------------------------------
| Sleep
|--------------------------------------------------------------------------
*/

function sleep(ms) {
  return new Promise(
    resolve =>
      setTimeout(resolve, ms)
  );
}