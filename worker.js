/**
 * ============================================================================
 *  TonPlayer (Player Worker) — Cloudflare Worker
 * ============================================================================
 *  UI embebible cyberpunk/minimalista ultra fluida. Este Worker NUNCA habla
 *  directo con Supabase ni con las fuentes de scraping (Alpha/Beta): los
 *  enlaces se obtienen vía HTTPS de un segundo Cloudflare Worker separado
 *  (el "API/Scraper Worker" — otra cuenta de Cloudflare, otro repositorio
 *  de GitHub), autenticado con un Bearer token (API_KEY) compartido entre
 *  ambos. El navegador nunca consulta directamente al API Worker, a Alpha,
 *  ni a Supabase — todo pasa por este Worker.
 *
 *  Arquitectura: Navegador → Player Worker → HTTPS+API_KEY → API Worker →
 *                Cache → Alpha → Beta (Supabase, fallback)
 *
 *  Ruta principal : /play/:tipo/:tmdb_id/:temporada?/:episodio?
 *  Ruta de salud  : /health
 *
 *  Variables de entorno requeridas:
 *    API_WORKER_URL   — URL base del API/Scraper Worker (otra cuenta CF)
 *    API_KEY          — Secret compartido con el API Worker (Bearer token).
 *                        Nunca se envía al navegador: solo viaja en el
 *                        fetch server-to-server hacia el API Worker.
 *    TMDB_API_KEY     — API key v3 de TMDB
 * ============================================================================
 */

// ============================================================================
// 1. ENTRYPOINT / ROUTER
// ============================================================================

export default {
  async fetch(request, env, ctx) {
    try {
      const url = new URL(request.url);
      const { pathname } = url;

      // --- Health check -------------------------------------------------
      if (pathname === "/health") {
        return new Response("OK", {
          status: 200,
          headers: { "content-type": "text/plain; charset=utf-8" },
        });
      }

      // --- Proxy del stream de búsqueda automática (SSE) ------------------
      // El cliente nunca ve SEARCH_STREAM_URL: solo llama a esta ruta
      // interna, y el Worker reenvía la conexión hacia el servicio real.
      if (pathname === "/play/search-stream") {
        return await handleSearchStreamProxy(url, env);
      }

      // --- Proxy de enlaces del API Worker (obtención rápida/lenta) --------
      // El gate de carga llama a esta ruta interna vía fetch() desde el
      // navegador, después de que el HTML ya se pintó, para no bloquear
      // la respuesta inicial esperando al API Worker (que puede tardar
      // 5-7s). El cliente nunca ve API_WORKER_URL ni API_KEY.
      if (pathname === "/play/api-links") {
        return await handleApiWorkerProxy(url, env);
      }

      // --- Ruta principal: /play/:tipo/:tmdb_id/:temporada?/:episodio? --
      const match = pathname.match(
        /^\/play\/(movie|tv)\/(\d+)(?:\/(\d+))?(?:\/(\d+))?\/?$/
      );

      if (match) {
        const [, tipo, tmdbId, temporada, episodio] = match;

        if (request.method === "POST") {
          // El cliente ya recibió los links directamente del servicio de
          // búsqueda SSE (ya no se insertan en Supabase) y los reenvía
          // aquí para que el Worker renderice el reproductor real.
          return await handlePlayFromClientLinks(
            { tipo, tmdbId, temporada, episodio },
            request,
            env,
            url.searchParams
          );
        }

        return await handlePlay(
          { tipo, tmdbId, temporada, episodio },
          env,
          ctx,
          url.searchParams
        );
      }

      // --- Fallback: 404 genérico ----------------------------------------
      return htmlResponse(renderErrorPage({
        code: 404,
        title: "Ruta no encontrada",
        message:
          "La URL solicitada no corresponde a ningún recurso de TonPlayer.",
      }), 404);
    } catch (err) {
      console.error("Unhandled worker error:", err.stack || err);
      const debugMode = new URL(request.url).searchParams.get("debug") === "1";
      return htmlResponse(
        renderErrorPage({
          code: 500,
          title: "Error interno del servidor",
          message: debugMode
            ? `[DEBUG] ${err.message}`
            : "Ocurrió un problema inesperado al procesar tu solicitud. Intenta de nuevo en unos segundos.",
        }),
        500
      );
    }
  },
};

// ============================================================================
// 2. HANDLER PRINCIPAL /play
// ============================================================================

async function handlePlay(params, env, ctx, searchParams) {
  const { tipo, tmdbId, temporada, episodio } = params;

  // --- Validación de parámetros clave --------------------------------
  if (!tipo || !tmdbId || !["movie", "tv"].includes(tipo)) {
    return htmlResponse(
      renderErrorPage({
        code: 400,
        title: "Parámetros inválidos",
        message:
          "Debes indicar un tipo válido (movie o tv) y un tmdb_id numérico. Ejemplo: /play/movie/550",
      }),
      400
    );
  }

  // Para series, si no se especifica temporada/episodio hacemos fallback
  // explícito a 1x1. Sin esto, la consulta a Supabase no filtraba por
  // temporada/episodio y devolvía TODOS los enlaces de TODOS los episodios
  // de la serie mezclados como si fueran servidores intercambiables.
  let temporadaFinal = temporada;
  let episodioFinal = episodio;
  if (tipo === "tv") {
    if (temporadaFinal === undefined) temporadaFinal = "1";
    if (episodioFinal === undefined) episodioFinal = "1";
  }

  validateEnv(env);

  const debugMode = searchParams.get("debug") === "1";
  const yaListoParaJugar = searchParams.get("ready") === "1";

  // --- Metadata (TMDB) -------------------------------------------------
  // Solo esperamos a TMDB antes de responder: es rápido (normalmente
  // <500ms) y nos permite mostrar el gate ya con título/backdrop reales.
  // El fetch al API Worker (el lento, 5-7s en algunos casos) NUNCA se
  // espera del lado del servidor — si lo hiciéramos, el navegador
  // quedaría varios segundos totalmente en blanco antes de recibir
  // cualquier HTML, lo que dispara sistemas de fallback en sitios que
  // embeben este player (si el iframe no responde rápido, prueban otra
  // URL). En su lugar, el propio JS del gate hace ese fetch después de
  // que la página ya cargó y se está pintando.
  let metadata;
  try {
    metadata = await fetchTmdbMetadata(
      { tipo, tmdbId, temporada: temporadaFinal, episodio: episodioFinal },
      env
    );
  } catch (err) {
    console.error("Error obteniendo metadata de TMDB:", err.stack || err);
    return htmlResponse(
      renderErrorPage({
        code: 500,
        title: "Error al consultar los servicios",
        message: debugMode
          ? `[DEBUG] ${err.message}`
          : "No se pudo contactar al proveedor de metadata. Intenta de nuevo más tarde.",
      }),
      500
    );
  }

  if (!yaListoParaJugar) {
    // Primera visita (o recarga sin confirmar datos todavía): SIEMPRE
    // respondemos el gate de inmediato, sin saber aún si hay enlaces
    // disponibles. El propio cliente consulta al API Worker (vía el
    // proxy interno) y, si no encuentra nada, recién ahí cae al SSE de
    // búsqueda automática como fallback.
    const streamUrl = env.SEARCH_STREAM_URL
      ? buildInternalStreamUrl({
          tipo,
          tmdbId,
          temporada: temporadaFinal,
          episodio: episodioFinal,
        })
      : null;

    return htmlResponse(
      renderLoadingGatePage({
        mode: "searching",
        metadata,
        streamUrl,
        apiUrl: buildInternalApiUrl({ tipo, tmdbId, temporada: temporadaFinal, episodio: episodioFinal }),
        vastTagUrl: env.VAST_TAG_URL || null,
      }),
      200
    );
  }

  // yaListoParaJugar=true pero llegamos acá por GET (no por el POST de
  // handlePlayFromClientLinks): no tenemos links en la mano server-side
  // porque ya no se consultan aquí. Esto solo pasa si alguien navega a
  // mano a la URL con ?ready=1, así que devolvemos 404 en vez de un
  // estado inconsistente.
  return htmlResponse(
    renderErrorPage({
      code: 404,
      title: "Contenido no disponible",
      message:
        "Todavía no tenemos servidores disponibles para este título. Vuelve a intentarlo más tarde.",
      metadata,
    }),
    404
  );
}

/**
 * Toma una lista cruda de enlaces (venga de Supabase o del JSON que manda
 * el servicio de búsqueda SSE) y decide si mostrar el gate en modo "ready"
 * (esperando solo al VAST) o el reproductor real directamente.
 */
async function renderPlayerFromEnlaces({ enlaces, tipo, tmdbId, temporada, episodio, metadata, env, yaListoParaJugar }) {
  const servidores = normalizeServidores(enlaces);
  const idiomaDefault = pickDefaultIdioma(servidores);
  const imagenParaColor = metadata.poster || metadata.backdrop || null;
  const accent = await fetchDominantAccent(imagenParaColor);

  if (!yaListoParaJugar && env.VAST_TAG_URL) {
    // Los datos YA están listos, pero todavía no confirmamos que el VAST
    // terminó de reproducirse: mostramos el gate en modo "ready", que
    // solo espera al anuncio (sin disparar ninguna búsqueda SSE) y
    // luego navega al reproductor real.
    return htmlResponse(
      renderLoadingGatePage({
        mode: "ready",
        metadata,
        vastTagUrl: env.VAST_TAG_URL,
      }),
      200
    );
  }

  // --- Render final del reproductor real ---------------------------------
  const html = renderPlayerPage({
    tipo,
    tmdbId,
    temporada,
    episodio,
    metadata,
    servidores,
    idiomaDefault,
    accent,
  });

  return htmlResponse(html, 200);
}

/**
 * Ruta POST /play/:tipo/:tmdb_id/:temporada?/:episodio?
 *
 * El servicio de búsqueda SSE ya NO inserta los links en Supabase: los
 * manda directamente en el evento final del stream (status:"links_found").
 * Como el Worker solo hace streaming pass-through de ese SSE (nunca lo
 * inspecciona), es el propio cliente quien recibe esos links y se los
 * reenvía al Worker por POST para que renderice el reproductor real —
 * ya sin necesidad de re-consultar Supabase ni esperar propagación.
 */
async function handlePlayFromClientLinks(params, request, env, searchParams) {
  const { tipo, tmdbId, temporada, episodio } = params;

  if (!tipo || !tmdbId || !["movie", "tv"].includes(tipo)) {
    return htmlResponse(
      renderErrorPage({
        code: 400,
        title: "Parámetros inválidos",
        message:
          "Debes indicar un tipo válido (movie o tv) y un tmdb_id numérico. Ejemplo: /play/movie/550",
      }),
      400
    );
  }

  let temporadaFinal = temporada;
  let episodioFinal = episodio;
  if (tipo === "tv") {
    if (temporadaFinal === undefined) temporadaFinal = "1";
    if (episodioFinal === undefined) episodioFinal = "1";
  }

  // El cliente envía los links mediante un <form> real (navegación con
  // POST, no fetch), así que el body llega como
  // application/x-www-form-urlencoded con un campo "links" que contiene
  // el JSON serializado. También se acepta application/json directo,
  // por si en el futuro se llama a esta ruta programáticamente.
  let links = null;
  try {
    const contentType = request.headers.get("content-type") || "";
    if (contentType.includes("application/json")) {
      const body = await request.json();
      links = Array.isArray(body?.links) ? body.links : null;
    } else {
      const formData = await request.formData();
      const raw = formData.get("links");
      if (raw) links = JSON.parse(raw);
    }
  } catch (err) {
    return new Response("Body inválido: se esperaba un campo 'links' con JSON.", { status: 400 });
  }

  if (!links || links.length === 0) {
    return htmlResponse(
      renderErrorPage({
        code: 404,
        title: "Contenido no disponible",
        message: "El buscador no encontró servidores disponibles para este título.",
      }),
      404
    );
  }

  validateEnv(env);

  // La metadata no viaja desde el cliente (solo los links), así que se
  // vuelve a pedir a TMDB. Es una consulta liviana y mantiene al Worker
  // como única fuente de verdad para la metadata mostrada.
  let metadata;
  try {
    metadata = await fetchTmdbMetadata(
      { tipo, tmdbId, temporada: temporadaFinal, episodio: episodioFinal },
      env
    );
  } catch (err) {
    console.error("Error obteniendo metadata de TMDB:", err.stack || err);
    return htmlResponse(
      renderErrorPage({
        code: 500,
        title: "Error al consultar los servicios",
        message: searchParams.get("debug") === "1"
          ? `[DEBUG] ${err.message}`
          : "No se pudo contactar al proveedor de metadata. Intenta de nuevo más tarde.",
      }),
      500
    );
  }

  const yaListoParaJugar = searchParams.get("ready") === "1";

  return await renderPlayerFromEnlaces({
    enlaces: links,
    tipo,
    tmdbId,
    temporada: temporadaFinal,
    episodio: episodioFinal,
    metadata,
    env,
    yaListoParaJugar,
  });
}

function validateEnv(env) {
  const required = ["API_WORKER_URL", "API_KEY", "TMDB_API_KEY"];
  const missing = required.filter((k) => !env[k]);
  if (missing.length) {
    throw new Error(`Faltan variables de entorno: ${missing.join(", ")}`);
  }
}

/**
 * Construye la URL del servicio de búsqueda automática (SSE) con los
 * parámetros de la película/episodio como query params.
 * SEARCH_STREAM_URL es una variable de entorno opcional; si no está
 * configurada, el flujo de auto-búsqueda queda deshabilitado.
 * Esta URL (con el dominio/token real) SOLO se usa server-side dentro
 * de handleSearchStreamProxy — nunca se envía al cliente.
 */
function buildSearchStreamUrl(baseUrl, { tipo, tmdbId, temporada, episodio }) {
  const url = new URL(baseUrl);
  url.searchParams.set("id", tmdbId);
  url.searchParams.set("type", tipo);
  if (tipo === "tv") {
    if (temporada !== undefined) url.searchParams.set("season", temporada);
    if (episodio !== undefined) url.searchParams.set("episode", episodio);
  }
  return url.toString();
}

/**
 * Construye la URL INTERNA (propia del Worker) que el cliente sí puede
 * ver en el HTML/consola. No revela el dominio real del buscador.
 */
function buildInternalStreamUrl({ tipo, tmdbId, temporada, episodio }) {
  const params = new URLSearchParams();
  params.set("id", tmdbId);
  params.set("type", tipo);
  if (tipo === "tv") {
    if (temporada !== undefined) params.set("season", temporada);
    if (episodio !== undefined) params.set("episode", episodio);
  }
  return `/play/search-stream?${params.toString()}`;
}

/**
 * Proxy del stream SSE: recibe la petición del cliente en la ruta interna
 * /play/search-stream, la reenvía hacia SEARCH_STREAM_URL (oculta) y
 * devuelve el body como streaming pass-through, sin bufferear, para no
 * romper el tiempo real del SSE.
 */
async function handleSearchStreamProxy(requestUrl, env) {
  if (!env.SEARCH_STREAM_URL) {
    return new Response("Servicio de búsqueda no configurado.", { status: 501 });
  }

  const id = requestUrl.searchParams.get("id");
  const type = requestUrl.searchParams.get("type");
  const season = requestUrl.searchParams.get("season");
  const episode = requestUrl.searchParams.get("episode");

  if (!id || !type || !["movie", "tv"].includes(type)) {
    return new Response("Parámetros inválidos.", { status: 400 });
  }

  const realUrl = buildSearchStreamUrl(env.SEARCH_STREAM_URL, {
    tipo: type,
    tmdbId: id,
    temporada: season !== null ? season : undefined,
    episodio: episode !== null ? episode : undefined,
  });

  let upstream;
  try {
    upstream = await fetch(realUrl, {
      headers: { Accept: "text/event-stream" },
    });
  } catch (err) {
    console.error("Error conectando al servicio de búsqueda:", err);
    return new Response("No se pudo conectar con el servicio de búsqueda.", {
      status: 502,
    });
  }

  if (!upstream.ok || !upstream.body) {
    return new Response("El servicio de búsqueda respondió con error.", {
      status: 502,
    });
  }

  // Pass-through del stream tal cual, sin tocar el body, para preservar
  // el comportamiento en tiempo real del SSE.
  return new Response(upstream.body, {
    status: 200,
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    },
  });
}

// ============================================================================
// 3. API WORKER (Scraper) — Obtención de enlaces vía HTTPS
// ============================================================================
//
// Este Worker (Player) ya NO habla directo con Supabase. Los enlaces se
// obtienen de un segundo Cloudflare Worker completamente separado (otra
// cuenta, otro repositorio de GitHub): el "API/Scraper Worker", que a su
// vez resuelve Cache → Alpha → Beta (Supabase) y devuelve la lista de
// servidores ya filtrada y renombrada (fuentes visibles como "Alpha"/
// "Beta", servidores bloqueados ya excluidos).
//
// La comunicación es HTTPS simple (sin Service Binding, ya que las
// cuentas de Cloudflare son distintas), autenticada con un Bearer token
// (API_KEY) que ambos Workers comparten como Secret. Esta API_KEY nunca
// se expone al navegador: solo viaja en el fetch server-to-server que
// hace este Worker.
//
// IMPORTANTE: este fetch es LENTO (puede tardar 5-7s en algunos casos:
// Cache MISS → Alpha → Beta como fallback). Por eso el Worker NUNCA lo
// espera antes de responder el HTML inicial — si lo hiciera, el
// navegador quedaría en blanco varios segundos, lo que dispara sistemas
// de fallback en sitios que embeben este player. En su lugar, el propio
// JavaScript del gate de carga hace este fetch DESPUÉS de que la página
// ya se pintó, a través de la ruta proxy interna /play/api-links (ver
// buildInternalApiUrl/handleApiWorkerProxy más abajo), que oculta
// API_WORKER_URL y API_KEY del cliente igual que ya hacíamos con el SSE.

async function fetchEnlacesFromApiWorker({ tipo, tmdbId, temporada, episodio }, env) {
  if (!env.API_WORKER_URL) {
    throw new Error("API_WORKER_URL no está configurada en este Worker.");
  }
  if (!env.API_KEY) {
    throw new Error("API_KEY no está configurada en este Worker.");
  }

  const base = env.API_WORKER_URL.replace(/\/+$/, "");

  let path = `/play/${tipo}/${tmdbId}`;
  if (tipo === "tv") {
    path += `/${temporada ?? "1"}/${episodio ?? "1"}`;
  }

  const fullUrl = `${base}${path}`;
  let res;
  try {
    res = await fetch(fullUrl, {
      headers: {
        Authorization: `Bearer ${env.API_KEY}`,
        Accept: "application/json",
      },
    });
  } catch (networkErr) {
    // Fallo de red/DNS/TLS antes de recibir cualquier respuesta (URL mal
    // escrita, dominio inexistente, Worker de destino caído, etc.)
    throw new Error(
      `No se pudo conectar al API Worker (${fullUrl}): ${networkErr.message}`
    );
  }

  if (!res.ok) {
    const body = await safeText(res);
    let hint = "";
    if (res.status === 401 || res.status === 403) {
      hint = " — revisa que API_KEY sea idéntica en ambos Workers.";
    } else if (res.status === 404) {
      hint = " — revisa la ruta/formato de URL que espera el API Worker.";
    }
    throw new Error(
      `API Worker respondió ${res.status} en ${fullUrl}${hint} Cuerpo: ${body?.slice(0, 300) || "sin cuerpo"}`
    );
  }

  let data;
  try {
    data = await res.json();
  } catch (parseErr) {
    throw new Error(
      `El API Worker no devolvió JSON válido (${fullUrl}). Puede estar devolviendo HTML/texto (revisa la ruta o un posible error 500 silencioso).`
    );
  }

  if (!data || data.success !== true) {
    // success:false (o formato inesperado) no es un error de red, es una
    // respuesta válida indicando que no hay enlaces disponibles todavía.
    return [];
  }

  return Array.isArray(data.links) ? data.links : [];
}

/**
 * Construye la URL INTERNA (propia del Worker) que el cliente sí puede
 * ver en el HTML/consola para pedir los enlaces del API Worker. Igual
 * que con el SSE, esto oculta API_WORKER_URL y API_KEY del navegador:
 * el cliente solo conoce esta ruta propia, nunca el destino real.
 */
function buildInternalApiUrl({ tipo, tmdbId, temporada, episodio }) {
  const params = new URLSearchParams();
  params.set("id", tmdbId);
  params.set("type", tipo);
  if (tipo === "tv") {
    if (temporada !== undefined) params.set("season", temporada);
    if (episodio !== undefined) params.set("episode", episodio);
  }
  return `/play/api-links?${params.toString()}`;
}

/**
 * Maneja la ruta interna /play/api-links: el gate de carga la llama vía
 * fetch() desde el navegador (después de que la página ya se pintó) para
 * obtener los enlaces sin bloquear el HTML inicial. Internamente reusa
 * fetchEnlacesFromApiWorker, que ya tiene toda la lógica de autenticación
 * y manejo de errores con el API Worker real.
 *
 * Responde siempre 200 con {success, links} (incluso si no hay enlaces
 * o hubo un error) para que el cliente pueda distinguir "no hay enlaces
 * todavía" (success:true, links:[]) de "el API Worker falló" (success:
 * false, error:"...") sin depender de status HTTP, y decidir si cae al
 * fallback de búsqueda SSE.
 */
async function handleApiWorkerProxy(requestUrl, env) {
  const id = requestUrl.searchParams.get("id");
  const type = requestUrl.searchParams.get("type");
  const season = requestUrl.searchParams.get("season");
  const episode = requestUrl.searchParams.get("episode");

  if (!id || !type || !["movie", "tv"].includes(type)) {
    return new Response(JSON.stringify({ success: false, error: "Parámetros inválidos." }), {
      status: 400,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  }

  try {
    const links = await fetchEnlacesFromApiWorker(
      {
        tipo: type,
        tmdbId: id,
        temporada: season !== null ? season : undefined,
        episodio: episode !== null ? episode : undefined,
      },
      env
    );

    return new Response(JSON.stringify({ success: true, links }), {
      status: 200,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  } catch (err) {
    console.error("Error consultando al API Worker (proxy interno):", err.stack || err);
    return new Response(
      JSON.stringify({ success: false, error: err.message || "Error desconocido." }),
      { status: 200, headers: { "content-type": "application/json; charset=utf-8" } }
    );
  }
}

// ============================================================================
// 4. TMDB — Obtención de metadata
// ============================================================================

async function fetchTmdbMetadata({ tipo, tmdbId, temporada, episodio }, env) {
  const lang = "es-MX";
  let endpoint;

  if (tipo === "movie") {
    endpoint = `https://api.themoviedb.org/3/movie/${tmdbId}?language=${lang}`;
  } else if (temporada !== undefined && episodio !== undefined) {
    // Metadata específica del episodio, pero conservamos también datos de la serie
    endpoint = `https://api.themoviedb.org/3/tv/${tmdbId}?language=${lang}`;
  } else {
    endpoint = `https://api.themoviedb.org/3/tv/${tmdbId}?language=${lang}`;
  }

  const res = await fetch(endpoint, {
    headers: {
      Authorization: `Bearer ${env.TMDB_API_KEY}`,
      Accept: "application/json",
    },
  });

  // Soporte para API key v3 tradicional (?api_key=) como fallback
  let json;
  if (!res.ok) {
    const fallbackUrl = `${endpoint}&api_key=${env.TMDB_API_KEY}`;
    const fallbackRes = await fetch(fallbackUrl, {
      headers: { Accept: "application/json" },
    });
    if (!fallbackRes.ok) {
      throw new Error(`TMDB respondió ${res.status} / ${fallbackRes.status} en ${endpoint}`);
    }
    json = await fallbackRes.json();
  } else {
    json = await res.json();
  }

  const title = tipo === "movie" ? json.title : json.name;
  const releaseDate = tipo === "movie" ? json.release_date : json.first_air_date;
  const year = releaseDate ? String(releaseDate).slice(0, 4) : "";
  const generos = Array.isArray(json.genres)
    ? json.genres.map((g) => g.name)
    : [];

  let episodioInfo = null;
  if (tipo === "tv" && temporada !== undefined && episodio !== undefined) {
    try {
      const epUrl = `https://api.themoviedb.org/3/tv/${tmdbId}/season/${temporada}/episode/${episodio}?language=${lang}&api_key=${env.TMDB_API_KEY}`;
      const epRes = await fetch(epUrl, { headers: { Accept: "application/json" } });
      if (epRes.ok) {
        const epJson = await epRes.json();
        episodioInfo = {
          nombre: epJson.name || `Episodio ${episodio}`,
          overview: epJson.overview || "",
          still_path: epJson.still_path
            ? `https://image.tmdb.org/t/p/w500${epJson.still_path}`
            : null,
        };
      }
    } catch (e) {
      console.warn("No se pudo obtener metadata del episodio:", e);
    }
  }

  return {
    tmdbId,
    tipo,
    titulo: title || "Título no disponible",
    backdrop: json.backdrop_path
      ? `https://image.tmdb.org/t/p/w1280${json.backdrop_path}`
      : null,
    poster: json.poster_path
      ? `https://image.tmdb.org/t/p/w780${json.poster_path}`
      : null,
    voteAverage: typeof json.vote_average === "number" ? json.vote_average : null,
    generos,
    year,
    temporada: temporada !== undefined ? Number(temporada) : null,
    episodio: episodio !== undefined ? Number(episodio) : null,
    episodioInfo,
  };
}

async function safeText(res) {
  try {
    return await res.text();
  } catch {
    return "";
  }
}

// ============================================================================
// 5. NORMALIZACIÓN — Idiomas y servidores
// ============================================================================

const IDIOMA_MAP = {
  LAT: "LATINO",
  LATINO: "LATINO",
  ESP: "CASTELLANO",
  ESPAÑOL: "CASTELLANO",
  CASTELLANO: "CASTELLANO",
  SPANISH: "CASTELLANO",
  SUB: "SUBTITULADO",
  SUBS: "SUBTITULADO",
  SUBTITULADO: "SUBTITULADO",
  SUBTITULOS: "SUBTITULADO",
  VOSE: "SUBTITULADO",
  ENGLISH: "SUBTITULADO",
};

const IDIOMA_META = {
  LATINO: { label: "Latino", flag: "🇲🇽", code: "MX" },
  SUBTITULADO: { label: "Subtitulado", flag: "🇺🇸", code: "US" },
  CASTELLANO: { label: "Castellano", flag: "🇪🇸", code: "ES" },
};

function normalizeIdioma(raw) {
  if (!raw) return "SUBTITULADO";
  const clean = String(raw).trim().toUpperCase();
  return IDIOMA_MAP[clean] || "SUBTITULADO";
}

function extractServerName(urlEmbed) {
  try {
    const u = new URL(urlEmbed);
    let host = u.hostname.replace(/^www\./, "");
    const parts = host.split(".");
    // Toma el segmento principal del dominio (ej. vidsrc.to -> vidsrc)
    const main = parts.length > 2 ? parts[parts.length - 2] : parts[0];
    return main.charAt(0).toUpperCase() + main.slice(1);
  } catch {
    return "Servidor";
  }
}

function getFaviconUrl(urlEmbed) {
  try {
    const u = new URL(urlEmbed);
    return `https://www.google.com/s2/favicons?domain=${u.hostname}&sz=64`;
  } catch {
    return "https://www.google.com/s2/favicons?domain=example.com&sz=64";
  }
}

/**
 * Normaliza la lista cruda de Supabase a una estructura consistente:
 * [{ id, servidor, favicon, idioma, url_embed }]
 */
function normalizeServidores(enlaces) {
  return enlaces
    .filter((row) => row && row.url_embed)
    .map((row, index) => {
      const servidorRaw = row.servidor && row.servidor !== "Auto"
        ? row.servidor
        : extractServerName(row.url_embed);

      const idioma = normalizeIdioma(row.idioma);

      return {
        id: row.id ?? `srv-${index}`,
        servidor: servidorRaw,
        favicon: getFaviconUrl(row.url_embed),
        idioma,
        idiomaLabel: IDIOMA_META[idioma].label,
        idiomaFlag: IDIOMA_META[idioma].flag,
        url_embed: row.url_embed,
        calidad: row.calidad || null,
      };
    });
}

function pickDefaultIdioma(servidores) {
  const idiomasDisponibles = new Set(servidores.map((s) => s.idioma));
  if (idiomasDisponibles.has("LATINO")) return "LATINO";
  if (idiomasDisponibles.has("CASTELLANO")) return "CASTELLANO";
  if (idiomasDisponibles.has("SUBTITULADO")) return "SUBTITULADO";
  return servidores[0]?.idioma || "LATINO";
}

// ============================================================================
// 5.5 EXTRACCIÓN DE COLOR DOMINANTE (SERVER-SIDE, SIN DEPENDENCIAS)
// ============================================================================
//
// Cloudflare Workers no tiene <canvas> ni Image(), y depender del canvas en
// el cliente resultó poco confiable (CORS/timing). En su lugar, el propio
// Worker descarga una miniatura JPEG de TMDB (w45, unos pocos KB) y extrae
// el color dominante decodificando SOLO los coeficientes DC (el "color
// promedio" de cada bloque 8x8) de un JPEG baseline — sin hacer la IDCT
// completa ni decodificar los coeficientes AC. Esto es suficiente para
// aproximar la paleta dominante y es rápido incluso en el edge.
//
// Limitación conocida: solo soporta JPEG baseline (no progresivo). TMDB
// sirve baseline para sus miniaturas, así que esto cubre el caso real.

async function fetchDominantAccent(posterOrBackdropUrl) {
  if (!posterOrBackdropUrl) return null;
  try {
    // Miniatura pequeña (w45) para minimizar bytes transferidos y CPU.
    const thumbUrl = posterOrBackdropUrl.replace(
      /\/t\/p\/w\d+\//,
      "/t/p/w45/"
    );
    const res = await fetch(thumbUrl);
    if (!res.ok) return null;
    const buf = await res.arrayBuffer();
    const { samples, qTables } = decodeJpegDcSamples(buf);
    if (!samples || samples.length === 0) return null;
    return computeAccentFromDcSamples(samples, qTables);
  } catch (err) {
    console.warn("No se pudo extraer el color dominante:", err.message || err);
    return null;
  }
}

/**
 * Decodificador JPEG baseline mínimo — solo coeficientes DC.
 * Soporta: DQT, SOF0/SOF1, DHT, DRI, SOS, subsampling 4:2:0/4:2:2/4:4:4,
 * restart markers. No soporta JPEG progresivo (SOF2).
 */
function decodeJpegDcSamples(buf) {
  const view = new DataView(buf);
  let offset = 0;

  function u16() { const v = view.getUint16(offset); offset += 2; return v; }
  function u8() { const v = view.getUint8(offset); offset += 1; return v; }

  if (u16() !== 0xffd8) throw new Error("No es un JPEG válido (falta SOI)");

  const qTables = {};
  const hDcTables = {};
  const hAcTables = {};
  let frame = null;
  let scanComponents = null;
  let restartInterval = 0;

  function parseDQT(len) {
    const end = offset + len - 2;
    while (offset < end) {
      const pqTq = u8();
      const precision = pqTq >> 4;
      const id = pqTq & 0x0f;
      const table = new Int32Array(64);
      for (let i = 0; i < 64; i++) table[i] = precision === 0 ? u8() : u16();
      qTables[id] = table;
    }
  }

  function parseSOF(len) {
    const end = offset + len - 2;
    u8(); // precisión de muestra
    const height = u16();
    const width = u16();
    const nComponents = u8();
    const components = [];
    for (let i = 0; i < nComponents; i++) {
      const id = u8();
      const hv = u8();
      const qId = u8();
      components.push({ id, h: hv >> 4, v: hv & 0x0f, qId });
    }
    frame = { width, height, components };
    offset = end;
  }

  function buildHuffTable(codeLengths, values) {
    const table = {};
    let code = 0;
    let k = 0;
    for (let len = 1; len <= 16; len++) {
      const count = codeLengths[len - 1];
      for (let i = 0; i < count; i++) {
        table[code.toString(2).padStart(len, "0")] = values[k];
        code++;
        k++;
      }
      code <<= 1;
    }
    return table;
  }

  function parseDHT(len) {
    const end = offset + len - 2;
    while (offset < end) {
      const tcTh = u8();
      const cls = tcTh >> 4;
      const id = tcTh & 0x0f;
      const codeLengths = [];
      let total = 0;
      for (let i = 0; i < 16; i++) {
        const c = u8();
        codeLengths.push(c);
        total += c;
      }
      const values = [];
      for (let i = 0; i < total; i++) values.push(u8());
      const table = buildHuffTable(codeLengths, values);
      if (cls === 0) hDcTables[id] = table;
      else hAcTables[id] = table;
    }
  }

  function parseDRI() {
    restartInterval = u16();
  }

  function parseSOS(len) {
    const end = offset + len - 2;
    const nComponents = u8();
    scanComponents = [];
    for (let i = 0; i < nComponents; i++) {
      const cs = u8();
      const tdTa = u8();
      scanComponents.push({ id: cs, dcTable: tdTa >> 4, acTable: tdTa & 0x0f });
    }
    offset += 3; // Ss, Se, AhAl
    offset = end;
  }

  let sosFound = false;
  while (offset < view.byteLength - 1 && !sosFound) {
    const marker = u16();
    if (marker === 0xffd9) break; // EOI
    if (marker >= 0xffd0 && marker <= 0xffd7) continue; // RST sin longitud
    const len = u16();
    const segStart = offset;
    if (marker === 0xffdb) parseDQT(len);
    else if (marker === 0xffc0 || marker === 0xffc1) parseSOF(len);
    else if (marker === 0xffc2) throw new Error("JPEG progresivo no soportado");
    else if (marker === 0xffc4) parseDHT(len);
    else if (marker === 0xffdd) parseDRI();
    else if (marker === 0xffda) {
      parseSOS(len);
      sosFound = true;
    } else {
      offset = segStart + len - 2;
    }
  }

  if (!frame || !scanComponents) throw new Error("JPEG incompleto: falta frame/scan");

  let bitBuffer = 0;
  let bitCount = 0;

  function fillBits() {
    while (bitCount <= 24 && offset < view.byteLength) {
      let byte = view.getUint8(offset);
      offset++;
      if (byte === 0xff) {
        const next = view.getUint8(offset);
        if (next === 0x00) {
          offset++;
        } else {
          offset -= 1;
          break;
        }
      }
      bitBuffer = (bitBuffer << 8) | byte;
      bitCount += 8;
    }
  }

  function readBit() {
    if (bitCount === 0) fillBits();
    if (bitCount === 0) return 0;
    bitCount--;
    return (bitBuffer >> bitCount) & 1;
  }

  function decodeHuffman(table) {
    let code = "";
    for (let i = 0; i < 16; i++) {
      code += readBit();
      if (Object.prototype.hasOwnProperty.call(table, code)) return table[code];
    }
    return 0;
  }

  function receive(n) {
    let v = 0;
    for (let i = 0; i < n; i++) v = (v << 1) | readBit();
    return v;
  }

  function extend(v, n) {
    if (n === 0) return 0;
    const vt = 1 << (n - 1);
    return v < vt ? v - (1 << n) + 1 : v;
  }

  const maxH = Math.max(...frame.components.map((c) => c.h));
  const maxV = Math.max(...frame.components.map((c) => c.v));
  const mcusPerLine = Math.ceil(frame.width / (8 * maxH));
  const mcusPerColumn = Math.ceil(frame.height / (8 * maxV));
  const totalMcus = mcusPerLine * mcusPerColumn;

  const predictors = {};
  scanComponents.forEach((sc) => (predictors[sc.id] = 0));

  const compMeta = {};
  frame.components.forEach((c) => (compMeta[c.id] = c));

  const samples = [];
  const maxMcusToSample = Math.min(totalMcus, 2500); // límite de seguridad/CPU

  outer:
  for (let mcuIndex = 0; mcuIndex < totalMcus; mcuIndex++) {
    if (restartInterval && mcuIndex > 0 && mcuIndex % restartInterval === 0) {
      bitBuffer = 0;
      bitCount = 0;
      if (offset < view.byteLength - 1 && view.getUint8(offset) === 0xff) {
        const m = view.getUint8(offset + 1);
        if (m >= 0xd0 && m <= 0xd7) offset += 2;
      }
      Object.keys(predictors).forEach((k) => (predictors[k] = 0));
    }

    for (const sc of scanComponents) {
      const meta = compMeta[sc.id];
      for (let by = 0; by < meta.v; by++) {
        for (let bx = 0; bx < meta.h; bx++) {
          const dcTable = hDcTables[sc.dcTable];
          const acTable = hAcTables[sc.acTable];
          if (!dcTable || !acTable) break outer;

          const t = decodeHuffman(dcTable);
          const diffBits = receive(t);
          const diff = extend(diffBits, t);
          predictors[sc.id] += diff;

          samples.push({ compId: sc.id, dc: predictors[sc.id], qId: meta.qId });

          // Salta los coeficientes AC: no se necesitan para el color promedio.
          let k = 1;
          while (k < 64) {
            const rs = decodeHuffman(acTable);
            const r = rs >> 4;
            const s = rs & 0x0f;
            if (s === 0) {
              if (r === 15) { k += 16; continue; }
              break; // EOB
            }
            k += r;
            receive(s);
            k++;
          }
        }
      }
    }

    if (mcuIndex >= maxMcusToSample) break;
  }

  return { samples, qTables, width: frame.width, height: frame.height };
}

function computeAccentFromDcSamples(samples, qTables) {
  function dequantLevel(dc, qId) {
    const qVal = qTables[qId] ? qTables[qId][0] : 8;
    return (dc * qVal) / 8 + 128;
  }
  function ycbcrToRgb(y, cb, cr) {
    cb -= 128;
    cr -= 128;
    const r = y + 1.402 * cr;
    const g = y - 0.344136 * cb - 0.714136 * cr;
    const b = y + 1.772 * cb;
    return [clamp255(r), clamp255(g), clamp255(b)];
  }
  function clamp255(v) { return Math.max(0, Math.min(255, Math.round(v))); }

  const yVals = samples.filter((s) => s.compId === 1).map((s) => dequantLevel(s.dc, s.qId));
  const cbVals = samples.filter((s) => s.compId === 2).map((s) => dequantLevel(s.dc, s.qId));
  const crVals = samples.filter((s) => s.compId === 3).map((s) => dequantLevel(s.dc, s.qId));

  if (yVals.length === 0) return null;

  // Emparejamiento aproximado 4:1 (subsampling 4:2:0 típico): cada bloque
  // de crominancia corresponde a ~4 bloques de luma consecutivos.
  const ratio = cbVals.length > 0 ? Math.max(1, Math.round(yVals.length / cbVals.length)) : 1;
  const n = cbVals.length > 0 ? Math.min(cbVals.length, crVals.length) : yVals.length;

  const buckets = {};
  let bestKey = null;
  let bestScore = -1;
  let bestRgb = null;

  for (let i = 0; i < n; i++) {
    const y = cbVals.length > 0 ? (yVals[i * ratio] ?? yVals[yVals.length - 1]) : yVals[i];
    const cb = cbVals.length > 0 ? cbVals[i] : 128;
    const cr = crVals.length > 0 ? crVals[i] : 128;
    const [r, g, b] = ycbcrToRgb(y, cb, cr);

    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const lum = (max + min) / 2 / 255;
    const sat = max === min ? 0 : (max - min) / (255 - Math.abs(max + min - 255));

    // Descarta sombras, luces puras y grises apagados — igual que en la
    // heurística previa del cliente, pero ahora corre en el servidor.
    if (lum < 0.08 || lum > 0.92 || sat < 0.12) continue;

    const key = [Math.round(r / 24), Math.round(g / 24), Math.round(b / 24)].join(",");
    if (!buckets[key]) buckets[key] = { count: 0, r: 0, g: 0, b: 0 };
    buckets[key].count++;
    buckets[key].r += r;
    buckets[key].g += g;
    buckets[key].b += b;

    const score = buckets[key].count * (0.5 + sat);
    if (score > bestScore) {
      bestScore = score;
      bestKey = key;
      bestRgb = {
        r: Math.round(buckets[key].r / buckets[key].count),
        g: Math.round(buckets[key].g / buckets[key].count),
        b: Math.round(buckets[key].b / buckets[key].count),
      };
    }
  }

  if (!bestRgb) return null;
  return normalizeAccentRgb(bestRgb);
}

function normalizeAccentRgb(rgb) {
  const { h, s } = rgbToHsl(rgb.r, rgb.g, rgb.b);
  const mainL = 0.6;
  const softL = 0.76;
  const targetS = Math.max(0.45, Math.min(s, 0.85));
  return {
    main: hslToHex(h, targetS, mainL),
    soft: hslToHex(h, targetS * 0.85, softL),
  };
}

function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h, s;
  const l = (max + min) / 2;
  if (max === min) { h = s = 0; }
  else {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r: h = (g - b) / d + (g < b ? 6 : 0); break;
      case g: h = (b - r) / d + 2; break;
      default: h = (r - g) / d + 4;
    }
    h /= 6;
  }
  return { h: h * 360, s, l };
}

function hslToHex(h, s, l) {
  h = ((h % 360) + 360) % 360;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let r = 0, g = 0, b = 0;
  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  const toHex = (v) => Math.round((v + m) * 255).toString(16).padStart(2, "0");
  return "#" + toHex(r) + toHex(g) + toHex(b);
}

function hexToRgba(hex, alpha) {
  const clean = hex.replace("#", "");
  const r = parseInt(clean.substring(0, 2), 16);
  const g = parseInt(clean.substring(2, 4), 16);
  const b = parseInt(clean.substring(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

// ============================================================================
// 6. RESPUESTAS HTTP
// ============================================================================

function htmlResponse(html, status = 200) {
  return new Response(html, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function escapeHtml(str = "") {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// ============================================================================
// 7. PÁGINA DE ERROR
// ============================================================================

function renderErrorPage({ code, title, message, metadata }) {
  const backdrop = metadata?.backdrop || "";
  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
<title>TonPlayer — ${escapeHtml(title)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap" rel="stylesheet">
<link rel="stylesheet" href="https://unpkg.com/@phosphor-icons/web@2.1.1/src/regular/style.css" />
<link rel="stylesheet" href="https://unpkg.com/@phosphor-icons/web@2.1.1/src/fill/style.css" />
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  html, body {
    height:100%; width:100%;
    background:#030305; color:#f4f4f7;
    font-family:'Plus Jakarta Sans', sans-serif;
  }
  .bg {
    position:fixed; inset:0;
    background: ${backdrop ? `url('${backdrop}') center/cover no-repeat` : "radial-gradient(circle at 30% 20%, #14141c, #030305 70%)"};
    filter: blur(28px) brightness(0.35);
    transform: scale(1.15);
  }
  .overlay {
    position:fixed; inset:0;
    background: linear-gradient(180deg, rgba(3,3,5,0.55), rgba(3,3,5,0.92));
  }
  .wrap {
    position:relative; z-index:2;
    min-height:100%; display:flex; align-items:center; justify-content:center;
    padding:24px;
    overflow-y:auto; /* salvaguarda: permite scroll si el contenido no cabe */
  }
  .card {
    max-width:440px; width:100%;
    background: rgba(255,255,255,0.05);
    border: 1px solid rgba(255,255,255,0.09);
    backdrop-filter: blur(24px);
    -webkit-backdrop-filter: blur(24px);
    border-radius: 24px;
    padding: 40px 32px;
    text-align:center;
    box-shadow: 0 24px 60px rgba(0,0,0,0.5);
    animation: rise .5s cubic-bezier(.2,.8,.2,1);
  }
  @keyframes rise { from { opacity:0; transform: translateY(18px); } to { opacity:1; transform: translateY(0); } }
  .icon {
    width:64px; height:64px; margin: 0 auto 20px;
    display:flex; align-items:center; justify-content:center;
    border-radius:50%;
    background: linear-gradient(135deg, rgba(255,90,90,0.18), rgba(255,90,90,0.02));
    border: 1px solid rgba(255,90,90,0.3);
  }
  .icon i { font-size: 30px; color:#ff5c5c; }
  .code {
    font-size: 12px; letter-spacing: 2px; font-weight:700;
    color: rgba(244,244,247,0.45); margin-bottom:8px; text-transform:uppercase;
  }
  h1 { font-size:20px; font-weight:800; margin-bottom:10px; letter-spacing:-0.2px; }
  p { font-size:14px; line-height:1.6; color: rgba(244,244,247,0.65); }
  .brand {
    margin-top:28px; display:flex; align-items:center; justify-content:center; gap:8px;
    font-size:12px; font-weight:700; letter-spacing:1px; color: rgba(244,244,247,0.35);
    text-transform:uppercase;
  }
  .brand span.dot { width:6px; height:6px; border-radius:50%; background:#e5384b; box-shadow:0 0 12px #e5384b; }

  /* --- Pantallas pequeñas / poca altura: tarjeta más compacta --- */
  @media (max-width: 420px), (max-height: 700px) {
    .wrap { padding:16px; }
    .card { padding:28px 22px; border-radius:20px; }
    .icon { width:52px; height:52px; margin-bottom:14px; }
    .icon i { font-size:24px; }
    .code { font-size:11px; margin-bottom:6px; }
    h1 { font-size:17px; margin-bottom:8px; }
    p { font-size:13px; line-height:1.5; }
    .brand { margin-top:20px; }
  }
  @media (max-height: 560px) {
    .card { padding:20px 20px; }
    .icon { width:44px; height:44px; margin-bottom:10px; }
    .icon i { font-size:20px; }
    h1 { font-size:16px; }
    .brand { margin-top:14px; font-size:11px; }
  }
</style>
</head>
<body>
  <div class="bg"></div>
  <div class="overlay"></div>
  <div class="wrap">
    <div class="card">
      <div class="icon"><i class="ph ph-warning-circle"></i></div>
      <div class="code">Error ${code}</div>
      <h1>${escapeHtml(title)}</h1>
      <p>${escapeHtml(message)}</p>
      <div class="brand"><span class="dot"></span> TonPlayer</div>
    </div>
  </div>
</body>
</html>`;
}

// ============================================================================
// 7.5 PÁGINA DE CARGA UNIFICADA (VAST + disponibilidad de datos)
// ============================================================================
//
// Reemplaza al viejo flujo de "servir el reproductor directo". Ahora TODA
// carga pasa por este gate, que se responde de inmediato (el Worker solo
// espera a TMDB para metadata, NUNCA al API Worker de enlaces — ese fetch
// es lento, 5-7s en cache MISS, y esperarlo dejaría al navegador en blanco
// el tiempo suficiente para que sistemas de fallback externos que embeben
// este player salten a otra URL). El gate ejecuta en paralelo:
//   (a) el anuncio VAST (si hay VAST_TAG_URL configurada)
//   (b) la confirmación de que los datos están listos:
//       - modo "searching": el cliente pide los enlaces al API Worker vía
//         el proxy interno /play/api-links (fetch desde el navegador, ya
//         con el gate pintado). Si no hay enlaces todavía y hay un
//         SEARCH_STREAM_URL configurado, cae como fallback a la búsqueda
//         automática por SSE, cuyo evento final manda los links
//         directamente (success:true, status:"links_found", links:[...]),
//         sin pasar por Supabase. En ambos casos, al navegar, los links
//         se reenvían al Worker por POST (un GET no tendría de dónde
//         sacarlos server-side, ya que este Worker no los consulta antes
//         de responder el HTML inicial).
//       - modo "ready": los datos YA están confirmados (vinieron del
//         POST anterior, ver handlePlayFromClientLinks): solo se espera
//         a que también termine el VAST, y se navega con un GET simple.
//
// Solo cuando AMBOS procesos terminan, navega a la misma URL con ?ready=1,
// lo que le indica al Worker que sirva el reproductor real sin volver a
// mostrar este gate ni disparar el SSE de nuevo.
//
// Si el VAST termina antes que los datos: se oculta el anuncio y se
// muestra un spinner simple mientras se sigue esperando. Si los datos
// están listos antes que el VAST: el anuncio se deja terminar solo, sin
// cortarlo — nunca se interrumpe una reproducción de video a la fuerza.

function renderLoadingGatePage({ mode, metadata, streamUrl, apiUrl, vastTagUrl }) {
  const backdrop = metadata?.backdrop || metadata?.poster || "";
  const titulo = escapeHtml(metadata?.titulo || "Cargando contenido");
  const streamUrlJson = JSON.stringify(streamUrl || null);
  const apiUrlJson = JSON.stringify(apiUrl || null);
  const vastTagUrlJson = JSON.stringify(vastTagUrl || null);
  const modeJson = JSON.stringify(mode);

  return `<!DOCTYPE html>
<html lang="es">
<!-- TONPLAYER_LOADING_GATE: marcador informativo de esta página. -->
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
<title>TonPlayer — Cargando ${titulo}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap" rel="stylesheet">
<link rel="stylesheet" href="https://unpkg.com/@phosphor-icons/web@2.1.1/src/regular/style.css" />
<link rel="stylesheet" href="https://unpkg.com/@phosphor-icons/web@2.1.1/src/fill/style.css" />
${vastTagUrl ? `<script src="https://imasdk.googleapis.com/js/sdkloader/ima3.js"></script>` : ""}
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  html, body {
    height:100%; width:100%;
    background:#030305; color:#f4f4f7;
    font-family:'Plus Jakarta Sans', sans-serif;
  }
  .bg {
    position:fixed; inset:0;
    background: ${backdrop ? `url('${backdrop}') center/cover no-repeat` : "radial-gradient(circle at 30% 20%, #14141c, #030305 70%)"};
    filter: blur(22px) brightness(0.55);
    transform: scale(1.15);
  }
  .overlay {
    position:fixed; inset:0;
    background:
      radial-gradient(circle at 50% 25%, rgba(229,56,75,0.14), transparent 55%),
      linear-gradient(180deg, rgba(3,3,5,0.35), rgba(3,3,5,0.82));
  }
  .wrap {
    position:relative; z-index:2;
    min-height:100%; display:flex; align-items:center; justify-content:center;
    padding:24px;
    overflow-y:auto;
  }
  .card {
    max-width:460px; width:100%;
    background: rgba(255,255,255,0.05);
    border: 1px solid rgba(255,255,255,0.09);
    backdrop-filter: blur(24px);
    -webkit-backdrop-filter: blur(24px);
    border-radius: 24px;
    padding: 36px 32px;
    text-align:center;
    box-shadow: 0 24px 60px rgba(0,0,0,0.5);
    animation: rise .5s cubic-bezier(.2,.8,.2,1);
  }
  @keyframes rise { from { opacity:0; transform: translateY(18px); } to { opacity:1; transform: translateY(0); } }

  .spinner-wrap { width:64px; height:64px; margin: 0 auto 20px; position:relative; }
  .spinner-ring {
    width:100%; height:100%; border-radius:50%;
    border: 3px solid rgba(229,56,75,0.15);
    border-top-color: #e5384b;
    animation: spin 0.9s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }

  h1 { font-size:19px; font-weight:800; margin-bottom:6px; letter-spacing:-0.2px; }
  .subtitle { font-size:13px; color: rgba(244,244,247,0.5); margin-bottom:22px; }

  .step-message {
    font-size:14px; font-weight:600; color: rgba(244,244,247,0.85);
    min-height: 40px; display:flex; align-items:center; justify-content:center;
    padding: 0 8px; line-height:1.4;
    transition: opacity .25s ease;
  }
  .step-message.fading { opacity: 0; }

  .step-track {
    height:5px; border-radius:99px; background: rgba(255,255,255,0.08);
    overflow:hidden; margin: 16px 0 8px;
  }
  .step-fill {
    height:100%; width:8%;
    background: linear-gradient(90deg, #e5384b, #ff7a6b);
    border-radius:99px;
    box-shadow: 0 0 12px #e5384b;
    transition: width .5s ease;
  }
  .step-count { font-size:11px; color: rgba(244,244,247,0.4); letter-spacing:0.4px; }

  .brand {
    margin-top:26px; display:flex; align-items:center; justify-content:center; gap:8px;
    font-size:12px; font-weight:700; letter-spacing:1px; color: rgba(244,244,247,0.35);
    text-transform:uppercase;
  }
  .brand span.dot { width:6px; height:6px; border-radius:50%; background:#e5384b; box-shadow:0 0 12px #e5384b; }

  /* ============ ANUNCIO VAST (ocupa toda la pantalla mientras dura) ============ */
  .ad-stage {
    position:fixed; inset:0; z-index:10;
    background:#000;
    display:none;
  }
  .ad-stage.show { display:block; }
  .ad-video-container, .ad-ui-container { position:absolute; inset:0; width:100%; height:100%; }
  .ad-ui-container { z-index:2; }
  .ad-label {
    position:absolute; top:14px; left:14px; z-index:3;
    background: rgba(0,0,0,0.55);
    border: 1px solid rgba(255,255,255,0.15);
    color: rgba(255,255,255,0.75);
    font-size:11px; font-weight:700; letter-spacing:0.5px; text-transform:uppercase;
    padding: 5px 10px; border-radius:99px;
    backdrop-filter: blur(8px);
    pointer-events:none;
  }
  .ad-loading-note {
    position:absolute; bottom:22px; left:0; right:0; z-index:3;
    text-align:center; font-size:12px; color: rgba(255,255,255,0.55);
    padding: 0 20px; pointer-events:none;
  }

  /* --- Pantallas pequeñas / poca altura: tarjeta más compacta --- */
  @media (max-width: 420px), (max-height: 700px) {
    .wrap { padding:16px; }
    .card { padding:26px 22px; border-radius:20px; }
    .spinner-wrap { width:48px; height:48px; margin-bottom:14px; }
    h1 { font-size:16px; margin-bottom:4px; }
    .subtitle { font-size:12px; margin-bottom:16px; }
    .step-message { font-size:13px; min-height:32px; }
    .step-track { margin:12px 0 6px; }
    .step-count { font-size:10px; }
    .brand { margin-top:16px; }
  }
  @media (max-height: 560px) {
    .card { padding:18px 20px; }
    .spinner-wrap { width:38px; height:38px; margin-bottom:10px; }
    h1 { font-size:15px; }
    .subtitle { font-size:11px; margin-bottom:12px; }
    .step-message { font-size:12px; min-height:26px; }
    .step-track { margin:10px 0 4px; }
    .brand { margin-top:10px; font-size:11px; }
  }
</style>
</head>
<body>
  <!-- Escenario del anuncio VAST: cubre toda la pantalla mientras dura -->
  <div class="ad-stage" id="ad-stage">
    <div class="ad-video-container" id="ad-video-container"></div>
    <div class="ad-ui-container" id="ad-ui-container"></div>
    <div class="ad-label">Anuncio</div>
    <div class="ad-loading-note" id="ad-loading-note">Preparando tu contenido en segundo plano…</div>
  </div>

  <div class="bg"></div>
  <div class="overlay"></div>
  <div class="wrap">
    <div class="card">
      <div class="spinner-wrap"><div class="spinner-ring" id="spinner"></div></div>
      <h1>${titulo}</h1>
      <div class="subtitle" id="subtitle">Preparando tu contenido…</div>

      <div class="step-message" id="step-message">Un momento…</div>
      <div class="step-track"><div class="step-fill" id="step-fill"></div></div>
      <div class="step-count" id="step-count"></div>

      <div class="brand"><span class="dot"></span> TonPlayer</div>
    </div>
  </div>

<script>
(function () {
  "use strict";

  var MODE = ${modeJson};               // "searching" | "ready"
  var STREAM_URL = ${streamUrlJson};    // null en modo "ready" o si no hay fallback SSE configurado
  var API_URL = ${apiUrlJson};          // ruta interna para pedir enlaces al API Worker
  var VAST_TAG_URL = ${vastTagUrlJson}; // null si no hay anuncio configurado

  var STEP_ORDER = ["start", "source", "extract", "found", "database", "compare", "insert", "complete"];

  var dom = {
    card: document.querySelector(".card"),
    subtitle: document.getElementById("subtitle"),
    message: document.getElementById("step-message"),
    fill: document.getElementById("step-fill"),
    count: document.getElementById("step-count"),
    spinner: document.getElementById("spinner"),
    adStage: document.getElementById("ad-stage"),
    adVideoContainer: document.getElementById("ad-video-container"),
    adUiContainer: document.getElementById("ad-ui-container"),
  };

  // --- Estado de finalización de los dos procesos en paralelo -----------
  var adDone = !VAST_TAG_URL;          // sin VAST configurado, ya está "listo"
  var dataDone = MODE === "ready";     // en modo ready, los datos ya se confirmaron
  var capturedLinks = null;            // links recibidos del SSE (solo modo "searching")
  var navigated = false;

  function maybeNavigate() {
    if (navigated) return;
    if (!adDone || !dataDone) return;
    navigated = true;

    var url = new URL(window.location.href);
    url.searchParams.set("ready", "1");

    if (MODE === "searching") {
      // El servicio de búsqueda ya no inserta en Supabase: los links
      // llegaron directo por SSE y hay que reenviárselos al Worker por
      // POST para que renderice el reproductor (un GET normal no tendría
      // de dónde sacarlos). Se usa un <form> real en vez de fetch() para
      // que sea una navegación de verdad (URL limpia, botón atrás, etc.)
      var form = document.createElement("form");
      form.method = "POST";
      form.action = url.toString();
      form.style.display = "none";

      var input = document.createElement("input");
      input.type = "hidden";
      input.name = "links";
      input.value = JSON.stringify(capturedLinks || []);
      form.appendChild(input);

      document.body.appendChild(form);
      form.submit();
    } else {
      // Modo "ready": los enlaces ya estaban confirmados por el Worker
      // desde el request original (vinieron de Supabase), así que un
      // GET simple con ready=1 alcanza para saltarse el gate.
      window.location.href = url.toString();
    }
  }

  function markAdDone() {
    if (adDone) return;
    adDone = true;
    dom.adStage.classList.remove("show");
    maybeNavigate();
  }

  function markDataDone() {
    if (dataDone) return;
    dataDone = true;
    maybeNavigate();
  }

  // --- UI helpers ---------------------------------------------------
  function setMessage(text) {
    dom.message.classList.add("fading");
    setTimeout(function () {
      dom.message.textContent = text;
      dom.message.classList.remove("fading");
    }, 150);
  }

  function setProgress(step) {
    var idx = STEP_ORDER.indexOf(step);
    var pct = idx >= 0 ? Math.round(((idx + 1) / STEP_ORDER.length) * 100) : null;
    if (pct !== null) dom.fill.style.width = Math.max(8, pct) + "%";
  }

  // Ya no se muestra un error inline con botón de "Reintentar": cuando
  // ninguna fuente (API Worker ni el fallback SSE) encuentra contenido,
  // reintentar siempre va a fallar por la misma razón (no hay servidores
  // disponibles, no es un problema transitorio). En su lugar, navegamos
  // directo a la página real de "contenido no disponible" — el Worker,
  // al ver ?ready=1 sin datos confirmados por POST, la sirve tal cual
  // (ver handlePlay).
  var navigatedToError = false;
  function showError() {
    if (navigatedToError || navigated) return;
    navigatedToError = true;
    var url = new URL(window.location.href);
    url.searchParams.set("ready", "1");
    window.location.href = url.toString();
  }

  // --- Búsqueda SSE (solo en modo "searching") -----------------------
  var es;
  var gotAnyEvent = false;
  var sseFinished = false;

  // --- Consulta al API Worker (vía proxy interno) ---------------------
  // Primer intento en modo "searching": pedimos los enlaces al API
  // Worker desde el navegador (no desde el servidor, para no bloquear
  // el HTML inicial). Si no hay enlaces todavía y existe un fallback de
  // búsqueda automática (STREAM_URL), recién ahí caemos al SSE.
  function checkApiWorker() {
    if (!API_URL) {
      // No debería pasar en modo "searching", pero por seguridad caemos
      // directo al SSE si está disponible, o mostramos error.
      if (STREAM_URL) startStream();
      else showError("No se pudo determinar cómo buscar servidores.");
      return;
    }

    dom.spinner.style.display = "";
    dom.fill.style.width = "15%";
    setMessage("Consultando servidores disponibles…");

    fetch(API_URL, { cache: "no-store" })
      .then(function (res) { return res.json(); })
      .then(function (data) {
        if (data && data.success === true && Array.isArray(data.links) && data.links.length > 0) {
          capturedLinks = data.links;
          dom.fill.style.width = "100%";
          setMessage("¡Listo! Preparando reproductor…");
          markDataDone();
          return;
        }

        // Sin enlaces todavía (o el API Worker falló): si hay un
        // servicio de búsqueda automática configurado, lo intentamos
        // como fallback. Si no, no hay más nada que hacer.
        if (STREAM_URL) {
          startStream();
        } else {
          showError(
            data && data.success === false
              ? "No se pudo consultar los servidores disponibles."
              : "Todavía no hay servidores disponibles para este título."
          );
        }
      })
      .catch(function () {
        if (STREAM_URL) {
          startStream();
        } else {
          showError("No se pudo conectar con el servicio de enlaces.");
        }
      });
  }

  function startStream() {
    sseFinished = false;
    gotAnyEvent = false;
    dom.spinner.style.display = "";
    dom.fill.style.width = "8%";
    setMessage("Conectando con el buscador…");

    try {
      es = new EventSource(STREAM_URL);
    } catch (e) {
      showError("No se pudo iniciar la búsqueda automática.");
      return;
    }

    es.onmessage = function (evt) {
      gotAnyEvent = true;
      var data;
      try {
        data = JSON.parse(evt.data);
      } catch (e) {
        return;
      }

      if (data.message) setMessage(data.message);
      if (data.step) setProgress(data.step);

      if (data.success === false) {
        sseFinished = true;
        es.close();
        showError(data.message || "El buscador reportó un error.");
        return;
      }

      // Evento final: el servicio manda los links directamente en el
      // JSON (ya no los inserta en Supabase), así que los capturamos
      // acá y marcamos los datos como listos sin necesidad de ningún
      // polling ni re-consulta.
      if (data.success === true && data.status === "links_found") {
        sseFinished = true;
        es.close();
        dom.fill.style.width = "100%";
        setMessage("¡Listo! Preparando reproductor…");
        dom.count.textContent = "";

        if (Array.isArray(data.links) && data.links.length > 0) {
          capturedLinks = data.links;
          markDataDone();
        } else {
          showError("El buscador no encontró servidores disponibles.");
        }
      }
    };

    es.onerror = function () {
      if (sseFinished) return;
      sseFinished = true;
      es.close();
      showError(
        gotAnyEvent
          ? "Se perdió la conexión con el buscador antes de terminar."
          : "No se pudo conectar con el servicio de búsqueda."
      );
    };
  }

  // --- Anuncio VAST (Google IMA SDK) ---------------------------------
  // Se reproduce en paralelo a la búsqueda/confirmación de datos. Al
  // terminar (éxito, error, o skip) llama a markAdDone(), que solo
  // navega si los datos también están listos.
  function initAndPlayAd() {
    if (!VAST_TAG_URL || typeof google === "undefined" || !google.ima) {
      markAdDone();
      return;
    }

    try {
      var ima = google.ima;
      var adDisplayContainer = new ima.AdDisplayContainer(dom.adVideoContainer);
      var adsLoader = new ima.AdsLoader(adDisplayContainer);

      var adWatchdog = setTimeout(function () {
        markAdDone();
      }, 8000);

      function onAdError() {
        clearTimeout(adWatchdog);
        markAdDone();
      }

      adsLoader.addEventListener(ima.AdErrorEvent.Type.AD_ERROR, onAdError, false);

      adsLoader.addEventListener(
        ima.AdsManagerLoadedEvent.Type.ADS_MANAGER_LOADED,
        function (event) {
          var settings = new ima.AdsRenderingSettings();
          var adsManager = event.getAdsManager(dom.adVideoContainer, settings);

          adsManager.addEventListener(ima.AdErrorEvent.Type.AD_ERROR, function () {
            clearTimeout(adWatchdog);
            try { adsManager.destroy(); } catch (e) {}
            markAdDone();
          });
          adsManager.addEventListener(ima.AdEvent.Type.CONTENT_PAUSE_REQUESTED, function () {
            clearTimeout(adWatchdog);
            dom.adStage.classList.add("show");
          });
          // CONTENT_RESUME_REQUESTED es el evento que el SDK dispara tanto
          // al hacer clic en "Saltar" como al terminar un ad individual
          // normalmente — es la señal real de "podés continuar al
          // contenido". ALL_ADS_COMPLETED cubre el pod completo de
          // anuncios (puede haber varios en secuencia) y no es fiable
          // como único disparador: escuchar solo ese evento es lo que
          // causaba que "Saltar" no funcionara, quedando a la espera de
          // un evento que a veces tarda más o no llega en el mismo punto.
          adsManager.addEventListener(ima.AdEvent.Type.CONTENT_RESUME_REQUESTED, function () {
            markAdDone();
          });
          adsManager.addEventListener(ima.AdEvent.Type.ALL_ADS_COMPLETED, function () {
            markAdDone();
          });

          try {
            adsManager.init(window.innerWidth, window.innerHeight, ima.ViewMode.NORMAL);
            adsManager.start();
          } catch (e) {
            markAdDone();
          }
        },
        false
      );

      adDisplayContainer.initialize();
      var adsRequest = new ima.AdsRequest();
      adsRequest.adTagUrl = VAST_TAG_URL;
      adsRequest.linearAdSlotWidth = window.innerWidth;
      adsRequest.linearAdSlotHeight = window.innerHeight;
      adsRequest.nonLinearAdSlotWidth = window.innerWidth;
      adsRequest.nonLinearAdSlotHeight = window.innerHeight / 3;
      adsLoader.requestAds(adsRequest);
    } catch (e) {
      markAdDone();
    }
  }

  // --- Arranque: dispara ambos procesos en paralelo -------------------
  if (MODE === "searching") {
    checkApiWorker();
  } else {
    // Modo "ready": los datos ya están confirmados por el Worker.
    // Solo mostramos un mensaje de espera breve mientras corre el VAST.
    setMessage("Preparando el reproductor…");
    dom.fill.style.width = "100%";
  }

  initAndPlayAd();
})();
</script>
</body>
</html>`;
}

// ============================================================================
// 8. PÁGINA DEL REPRODUCTOR (UI principal)
// ============================================================================

function renderPlayerPage({ tipo, tmdbId, temporada, episodio, metadata, servidores, idiomaDefault, accent }) {
  const totalServidores = servidores.length;
  const backdrop = metadata.backdrop || metadata.poster || "";
  const poster = metadata.poster || metadata.backdrop || "";
  const titulo = escapeHtml(metadata.titulo);
  const year = metadata.year || "";
  const rating = metadata.voteAverage ? metadata.voteAverage.toFixed(1) : null;
  const generos = (metadata.generos || []).slice(0, 3).join(" · ");

  // Acento calculado server-side a partir del póster/backdrop. Si la
  // extracción falló (imagen no disponible, JPEG no soportado, etc.),
  // se conserva el violeta por defecto definido en :root dentro del CSS.
  const accentCss = accent
    ? `
  :root {
    --accent: ${accent.main};
    --accent-2: ${accent.soft};
    --accent-soft: ${hexToRgba(accent.main, 0.18)};
    --accent-border: ${hexToRgba(accent.main, 0.4)};
  }`
    : "";

  const dataServidores = JSON.stringify(servidores).replace(/</g, "\\u003c");
  const dataMetadata = JSON.stringify({
    titulo: metadata.titulo,
    year,
    rating,
    generos: metadata.generos || [],
    tipo,
    temporada: metadata.temporada,
    episodio: metadata.episodio,
    episodioInfo: metadata.episodioInfo,
    backdrop_source: backdrop || null,
  }).replace(/</g, "\\u003c");

  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover, user-scalable=no" />
<title>TonPlayer — ${titulo}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap" rel="stylesheet">
<link rel="stylesheet" href="https://unpkg.com/@phosphor-icons/web@2.1.1/src/regular/style.css" />
<link rel="stylesheet" href="https://unpkg.com/@phosphor-icons/web@2.1.1/src/fill/style.css" />
<style>
${playerCss()}
${accentCss}
</style>
</head>
<body>

  <!-- ============================ PRELOADER ============================ -->
  <div id="preloader" class="preloader">
    <div class="preloader-bg" id="preloader-bg" style="background-image:${backdrop ? `url('${backdrop}'), ` : ""}radial-gradient(circle at 30% 20%, var(--accent-soft), transparent 60%), linear-gradient(160deg, #1a1a24, #0a0a0e 70%)"></div>
    <div class="preloader-scrim"></div>
    <div class="preloader-card">
      <div class="preloader-poster" style="background-image:url('${poster}')"></div>
      <div class="preloader-info">
        <div class="preloader-title">${titulo}</div>
        <div class="preloader-sub" id="preloader-sub">
          ${year ? `<span>${year}</span>` : ""}
          ${rating ? `<span class="dot-sep"></span><span><i class="ph-fill ph-star"></i> ${rating}</span>` : ""}
          ${generos ? `<span class="dot-sep"></span><span>${escapeHtml(generos)}</span>` : ""}
        </div>
        <div class="preloader-servers">
          <i class="ph ph-broadcast"></i>
          <span id="preloader-server-count">${totalServidores}</span> servidor${totalServidores === 1 ? "" : "es"} disponible${totalServidores === 1 ? "" : "s"}
        </div>
        <div class="preloader-bar-track">
          <div class="preloader-bar-fill" id="preloader-bar-fill"></div>
        </div>
        <div class="preloader-pct" id="preloader-pct">0%</div>
      </div>
    </div>
  </div>

  <!-- ============================ PLAYER STAGE ========================== -->
  <div class="stage" id="stage">
    <iframe id="player-iframe" class="player-iframe" allow="autoplay; fullscreen; encrypted-media; picture-in-picture" allowfullscreen referrerpolicy="no-referrer"></iframe>

    <!-- Barra superior -->
    <div class="topbar" id="topbar">
      <div class="topbar-inner">

        <!-- Izquierda: avisos (el logo fue eliminado a pedido) -->
        <div class="topbar-left" id="topbar-left">

          <!-- Desktop/tablet: avisos alternados con fade -->
          <div class="notice-rotator" id="notice-rotator">
            <div class="notice notice-warning" data-notice="ads">
              <i class="ph-fill ph-warning"></i>
              <span>Este servidor contiene anuncios</span>
            </div>
            <div class="notice notice-info" data-notice="adblock">
              <i class="ph-fill ph-shield-check"></i>
              <span>Se recomienda usar AdBlock / Brave</span>
            </div>
          </div>

          <!-- Móvil: cinta de texto en marquee continuo -->
          <div class="notice-marquee" id="notice-marquee" aria-hidden="true">
            <div class="notice-marquee-track">
              <span class="notice-marquee-item notice-marquee-warning"><i class="ph-fill ph-warning"></i> Este servidor contiene anuncios</span>
              <span class="notice-marquee-item notice-marquee-info"><i class="ph-fill ph-shield-check"></i> Se recomienda usar AdBlock / Brave</span>
              <span class="notice-marquee-item notice-marquee-warning"><i class="ph-fill ph-warning"></i> Este servidor contiene anuncios</span>
              <span class="notice-marquee-item notice-marquee-info"><i class="ph-fill ph-shield-check"></i> Se recomienda usar AdBlock / Brave</span>
            </div>
          </div>
        </div>

        <!-- Acciones: arrancan a la derecha, migran a la izquierda cuando
             los avisos terminan (ver CSS .topbar-inner.notices-done y
             JS startNoticeRotation) -->
        <div class="topbar-right" id="topbar-right">
          <button class="icon-btn" id="btn-lang" aria-label="Cambiar idioma">
            <i class="ph ph-globe"></i>
            <span class="icon-btn-label" id="btn-lang-label">Idioma</span>
          </button>
          <button class="icon-btn" id="btn-servers" aria-label="Cambiar servidor">
            <i class="ph ph-faders-horizontal"></i>
            <span class="icon-btn-label">Servidores</span>
          </button>
        </div>
      </div>
    </div>
  </div>

  <!-- ============================ DRAWER: IDIOMA ======================== -->
  <div class="drawer-backdrop" id="lang-drawer-backdrop">
    <div class="drawer" id="lang-drawer">
      <div class="drawer-header">
        <div class="drawer-title"><i class="ph ph-globe"></i> Selecciona idioma</div>
        <button class="drawer-close" data-close-drawer><i class="ph ph-x"></i></button>
      </div>
      <div class="drawer-body" id="lang-list"></div>
    </div>
  </div>

  <!-- ============================ DRAWER: SERVIDORES ==================== -->
  <div class="drawer-backdrop" id="servers-drawer-backdrop">
    <div class="drawer" id="servers-drawer">
      <div class="drawer-header">
        <div class="drawer-title"><i class="ph ph-faders-horizontal"></i> Selecciona servidor</div>
        <button class="drawer-close" data-close-drawer><i class="ph ph-x"></i></button>
      </div>
      <div class="drawer-body" id="servers-list"></div>
    </div>
  </div>

<script>
${playerJs()}
</script>
<script>
  window.__TONPLAYER_DATA__ = {
    servidores: ${dataServidores},
    metadata: ${dataMetadata},
    idiomaDefault: ${JSON.stringify(idiomaDefault)}
  };
  TonPlayer.init(window.__TONPLAYER_DATA__);
</script>
</body>
</html>`;
}

// ============================================================================
// 9. CSS DEL REPRODUCTOR
// ============================================================================

function playerCss() {
  return `
  :root {
    --bg: #030305;
    --accent: #e5384b;
    --accent-2: #ff7a6b;
    --accent-soft: rgba(229,56,75,0.18);
    --accent-border: rgba(229,56,75,0.4);
    --warn: #ffb020;
    --info: #4fd1ff;
    --glass: rgba(255,255,255,0.06);
    --glass-border: rgba(255,255,255,0.1);
    --text: #f4f4f7;
    --text-dim: rgba(244,244,247,0.6);
    --radius: 18px;
  }
  * { margin:0; padding:0; box-sizing:border-box; -webkit-tap-highlight-color: transparent; }
  html, body {
    height:100%; width:100%; overflow:hidden;
    background: var(--bg); color: var(--text);
    font-family:'Plus Jakarta Sans', sans-serif;
  }

  /* ============ PRELOADER ============ */
  .preloader {
    position:fixed; inset:0; z-index:100;
    display:flex; align-items:center; justify-content:center;
    transition: opacity .6s ease, visibility .6s ease;
  }
  .preloader.hidden { opacity:0; visibility:hidden; pointer-events:none; }
  .preloader-bg {
    position:absolute; inset:0;
    background-color: #14141c;
    background-size:cover; background-position:center;
    filter: blur(30px) brightness(0.32) saturate(1.1);
    transform: scale(1.2);
  }
  .preloader-scrim {
    position:absolute; inset:0;
    background:
      radial-gradient(circle at 50% 30%, var(--accent-soft), transparent 60%),
      radial-gradient(circle at 50% 40%, rgba(3,3,5,0.5), rgba(3,3,5,0.94));
    transition: background .6s ease;
  }
  .preloader-card {
    position:relative; z-index:2;
    display:flex; align-items:center; gap:22px;
    background: var(--glass);
    border: 1px solid var(--glass-border);
    backdrop-filter: blur(28px); -webkit-backdrop-filter: blur(28px);
    border-radius: 24px;
    padding: 22px 28px;
    max-width: 480px; width: calc(100% - 48px);
    box-shadow: 0 30px 80px rgba(0,0,0,0.55);
    animation: cardIn .55s cubic-bezier(.2,.8,.2,1);
  }
  @keyframes cardIn { from { opacity:0; transform: translateY(20px) scale(.97); } to { opacity:1; transform:none; } }
  .preloader-poster {
    width:64px; height:96px; border-radius:12px; flex-shrink:0;
    background-size:cover; background-position:center;
    box-shadow: 0 10px 24px rgba(0,0,0,0.5);
    border: 1px solid rgba(255,255,255,0.12);
  }
  .preloader-info { flex:1; min-width:0; }
  .preloader-title {
    font-size:16px; font-weight:800; letter-spacing:-0.2px;
    white-space:nowrap; overflow:hidden; text-overflow:ellipsis;
    margin-bottom:6px;
  }
  .preloader-sub {
    font-size:12px; color:var(--text-dim); display:flex; align-items:center; gap:6px;
    margin-bottom:10px; flex-wrap:wrap;
  }
  .preloader-sub i { color: var(--warn); font-size:11px; margin-right:2px; }
  .dot-sep { width:3px; height:3px; border-radius:50%; background:var(--text-dim); display:inline-block; }
  .preloader-servers {
    font-size:12px; color: var(--text-dim); display:flex; align-items:center; gap:6px;
    margin-bottom:12px;
  }
  .preloader-servers i { color: var(--accent); transition: color .5s ease; }
  .preloader-bar-track {
    height:5px; border-radius:99px; background: rgba(255,255,255,0.08);
    overflow:hidden; margin-bottom:8px;
  }
  .preloader-bar-fill {
    height:100%; width:0%;
    background: linear-gradient(90deg, var(--accent), var(--accent-2));
    border-radius:99px;
    box-shadow: 0 0 12px var(--accent);
    transition: width .2s ease, background .5s ease, box-shadow .5s ease;
  }
  .preloader-pct {
    font-size:11px; font-weight:700; color: var(--text-dim); letter-spacing: 0.5px;
    text-align:right;
  }

  /* ============ STAGE / IFRAME ============ */
  .stage { position:fixed; inset:0; background:#000; overflow:hidden; }
  .player-iframe {
    position:absolute; inset:0; width:100%; height:100%; border:0; background:#000;
  }

  /* ============ TOPBAR (siempre visible) ============ */
  .topbar {
    position:absolute; top:0; left:0; right:0; z-index:30;
    padding: 14px 18px;
    background: linear-gradient(180deg, rgba(3,3,5,0.85) 0%, rgba(3,3,5,0.35) 70%, transparent 100%);
    pointer-events:auto;
  }
  .topbar-inner {
    display:flex; align-items:center; justify-content:space-between; gap:12px;
  }
  .topbar-left { flex:1; min-width:0; display:flex; align-items:center; gap:14px; order:1; }
  .topbar-right { display:flex; align-items:center; gap:8px; flex-shrink:0; order:2; }

  /* Cuando los avisos terminan de rotar, los botones de acción pasan a
     la izquierda (mismo lugar donde estaban los avisos / el logo). */
  .topbar-inner.notices-done .topbar-left { order:2; flex:0 0 auto; }
  .topbar-inner.notices-done .topbar-right { order:1; }

  .notice-rotator { position:relative; height:26px; overflow:hidden; max-width: 280px; flex:1; min-width:0; transition: opacity .4s ease; }
  .notice-rotator.notices-hidden { opacity:0; pointer-events:none; }
  .notice {
    position:absolute; inset:0;
    display:flex; align-items:center; gap:7px;
    font-size:12.5px; font-weight:600;
    padding: 4px 12px 4px 10px;
    border-radius: 99px;
    white-space:nowrap;
    opacity:0; transform: translateY(8px);
    transition: opacity .4s ease, transform .4s ease;
    backdrop-filter: blur(12px);
  }
  .notice.show { opacity:1; transform: translateY(0); }
  .notice-warning { background: rgba(255,176,32,0.14); border:1px solid rgba(255,176,32,0.35); color:#ffcf80; }
  .notice-info { background: rgba(79,209,255,0.14); border:1px solid rgba(79,209,255,0.35); color:#9fe6ff; }

  /* Marquee de avisos: solo visible en móvil (ver media query abajo) */
  .notice-marquee {
    display:none;
    position:relative; flex:1; min-width:0;
    height:26px; overflow:hidden;
    border-radius:99px;
    background: rgba(255,255,255,0.05);
    border: 1px solid rgba(255,255,255,0.08);
    -webkit-mask-image: linear-gradient(90deg, transparent 0, #000 18px, #000 calc(100% - 18px), transparent 100%);
    mask-image: linear-gradient(90deg, transparent 0, #000 18px, #000 calc(100% - 18px), transparent 100%);
    transition: opacity .4s ease;
  }
  .notice-marquee.notices-hidden { opacity:0; pointer-events:none; }
  .notice-marquee-track {
    position:absolute; top:0; left:0; height:100%;
    display:flex; align-items:center; gap:28px;
    white-space:nowrap;
    padding-left: 100%; /* arranca fuera de la vista, a la derecha */
    animation: marquee-scroll 14s linear infinite;
  }
  .notice-marquee-item {
    display:inline-flex; align-items:center; gap:6px;
    font-size:11.5px; font-weight:600;
  }
  .notice-marquee-warning { color:#ffcf80; }
  .notice-marquee-info { color:#9fe6ff; }
  @keyframes marquee-scroll {
    from { transform: translateX(0); }
    to { transform: translateX(-50%); } /* contenido duplicado: -50% = un ciclo completo, sin salto */
  }

  .icon-btn {
    display:flex; align-items:center; gap:6px;
    background: rgba(255,255,255,0.06);
    border: 1px solid rgba(255,255,255,0.1);
    color: var(--text);
    padding: 8px 12px;
    border-radius: 99px;
    font-family: inherit; font-size:12.5px; font-weight:600;
    cursor:pointer;
    backdrop-filter: blur(10px);
    transition: background .2s ease, transform .15s ease, border-color .2s ease;
  }
  .icon-btn:hover { background: rgba(255,255,255,0.12); border-color: rgba(255,255,255,0.2); }
  .icon-btn:active { transform: scale(0.94); }
  .icon-btn i { font-size:16px; }
  .icon-btn-label { display:inline; }
  @media (max-width: 480px) {
    .icon-btn-label { display:none; }
    .icon-btn { padding:9px; }
    .notice-rotator { display:none; }
    .notice-marquee { display:block; }
    .notice span { overflow:hidden; text-overflow:ellipsis; }
  }

  /* ============ DRAWERS ============ */
  .drawer-backdrop {
    position:fixed; inset:0; z-index:60;
    background: rgba(3,3,5,0.55);
    backdrop-filter: blur(6px); -webkit-backdrop-filter: blur(6px);
    display:flex; align-items:flex-end; justify-content:center;
    opacity:0; visibility:hidden; pointer-events:none;
    transition: opacity .3s ease, visibility .3s ease;
  }
  .drawer-backdrop.open { opacity:1; visibility:visible; pointer-events:auto; }
  @media (min-width: 720px) {
    .drawer-backdrop { align-items:center; }
  }
  .drawer {
    width:100%; max-width: 420px;
    max-height: 70vh;
    background: rgba(14,14,20,0.85);
    border: 1px solid rgba(255,255,255,0.1);
    backdrop-filter: blur(30px); -webkit-backdrop-filter: blur(30px);
    border-radius: 22px 22px 0 0;
    overflow:hidden;
    display:flex; flex-direction:column;
    transform: translateY(30px);
    transition: transform .35s cubic-bezier(.2,.8,.2,1);
    box-shadow: 0 -20px 60px rgba(0,0,0,0.5);
  }
  @media (min-width: 720px) {
    .drawer { border-radius: 22px; transform: scale(.96) translateY(10px); }
  }
  .drawer-backdrop.open .drawer { transform: none; }
  .drawer-header {
    display:flex; align-items:center; justify-content:space-between;
    padding: 18px 20px; border-bottom: 1px solid rgba(255,255,255,0.08);
  }
  .drawer-title {
    display:flex; align-items:center; gap:8px;
    font-size:15px; font-weight:800;
  }
  .drawer-title i { color: var(--accent); font-size:18px; transition: color .5s ease; }
  .drawer-close {
    width:32px; height:32px; border-radius:50%;
    background: rgba(255,255,255,0.06); border:1px solid rgba(255,255,255,0.1);
    color: var(--text); display:flex; align-items:center; justify-content:center;
    cursor:pointer; font-size:15px;
  }
  .drawer-body { overflow-y:auto; padding: 10px 12px 18px; }

  .option-row {
    display:flex; align-items:center; gap:12px;
    padding: 12px 14px; border-radius:14px;
    cursor:pointer; margin-bottom:6px;
    border: 1px solid transparent;
    transition: background .2s ease, border-color .2s ease;
  }
  .option-row:hover { background: rgba(255,255,255,0.05); }
  .option-row.active {
    background: var(--accent-soft);
    border-color: var(--accent-border, rgba(229,56,75,0.4));
    transition: background .4s ease, border-color .4s ease;
  }
  .option-flag { font-size:20px; width:28px; text-align:center; flex-shrink:0; }
  .option-favicon {
    width:28px; height:28px; border-radius:8px; flex-shrink:0;
    background: rgba(255,255,255,0.08); object-fit:cover;
  }
  .option-main { flex:1; min-width:0; }
  .option-title { font-size:14px; font-weight:700; }
  .option-sub { font-size:11.5px; color: var(--text-dim); margin-top:1px; }
  .option-tag {
    font-size:10.5px; font-weight:700; padding: 3px 9px; border-radius:99px;
    background: rgba(255,255,255,0.08); color: var(--text-dim); flex-shrink:0;
    letter-spacing:0.3px;
  }
  .option-check { color: var(--accent); font-size:18px; flex-shrink:0; opacity:0; transition: color .5s ease; }
  .option-row.active .option-check { opacity:1; }
  .empty-state {
    text-align:center; padding: 30px 10px; color: var(--text-dim); font-size:13px;
  }
  `;
}

// ============================================================================
// 10. JS DEL REPRODUCTOR (cliente)
// ============================================================================

function playerJs() {
  return `
(function () {
  "use strict";

  const TonPlayer = {
    state: {
      servidores: [],
      metadata: null,
      idiomaActual: null,
      servidorActual: null,
      noticeTimer: null,
      noticeHideTimer: null,
      progressTimer: null,
    },

    init(data) {
      this.state.servidores = data.servidores || [];
      this.state.metadata = data.metadata;
      this.state.idiomaActual = data.idiomaDefault;

      this.cacheDom();
      this.bindEvents();

      // El color de acento ya llega calculado desde el servidor como
      // variables CSS inline (ver renderPlayerPage/accentCss), así que
      // el preloader nace directamente con la paleta correcta, sin
      // depender de canvas/CORS/timing en el cliente.
      this.runPreloaderSequence(true);

      this.selectInitialServer();
      this.renderLangDrawer();
      this.renderServersDrawer();
      this.startNoticeRotation();
    },

    cacheDom() {
      this.dom = {
        preloader: document.getElementById("preloader"),
        preloaderBar: document.getElementById("preloader-bar-fill"),
        preloaderPct: document.getElementById("preloader-pct"),
        preloaderServerCount: document.getElementById("preloader-server-count"),
        iframe: document.getElementById("player-iframe"),
        topbar: document.getElementById("topbar"),
        stage: document.getElementById("stage"),
        btnLang: document.getElementById("btn-lang"),
        btnLangLabel: document.getElementById("btn-lang-label"),
        btnServers: document.getElementById("btn-servers"),
        langDrawerBackdrop: document.getElementById("lang-drawer-backdrop"),
        serversDrawerBackdrop: document.getElementById("servers-drawer-backdrop"),
        langList: document.getElementById("lang-list"),
        serversList: document.getElementById("servers-list"),
        notices: Array.from(document.querySelectorAll(".notice")),
        topbarInner: document.querySelector(".topbar-inner"),
        noticeRotator: document.getElementById("notice-rotator"),
        noticeMarquee: document.getElementById("notice-marquee"),
      };
    },

    // ---------------------------------------------------------------
    // PRELOADER
    // ---------------------------------------------------------------
    runPreloaderSequence(isInitial) {
      const dom = this.dom;
      dom.preloaderServerCount.textContent = this.getFilteredServers().length;
      dom.preloader.classList.remove("hidden");

      let pct = 0;
      clearInterval(this.state.progressTimer);
      dom.preloaderBar.style.width = "0%";
      dom.preloaderPct.textContent = "0%";

      const duration = isInitial ? 1400 : 900;
      const stepTime = 30;
      const steps = duration / stepTime;
      const increment = 100 / steps;

      this.state.progressTimer = setInterval(() => {
        pct = Math.min(100, pct + increment + Math.random() * 2);
        const rounded = Math.round(pct);
        dom.preloaderBar.style.width = rounded + "%";
        dom.preloaderPct.textContent = rounded + "%";
        if (pct >= 100) {
          clearInterval(this.state.progressTimer);
          setTimeout(() => {
            dom.preloader.classList.add("hidden");
          }, 220);
        }
      }, stepTime);
    },

    // ---------------------------------------------------------------
    // SELECCIÓN DE SERVIDOR / IDIOMA
    // ---------------------------------------------------------------
    getFilteredServers() {
      return this.state.servidores.filter(
        (s) => s.idioma === this.state.idiomaActual
      );
    },

    selectInitialServer() {
      const filtered = this.getFilteredServers();
      const first = filtered[0] || this.state.servidores[0];
      if (first) this.setServidor(first, false);
      this.updateLangButtonLabel();
    },

    setServidor(servidor, showPreloader) {
      this.state.servidorActual = servidor;
      this.dom.iframe.src = servidor.url_embed;
      if (showPreloader) this.runPreloaderSequence(false);
      this.renderServersDrawer();
      this.renderLangDrawer();
    },

    setIdioma(idioma) {
      if (idioma === this.state.idiomaActual) return;
      this.state.idiomaActual = idioma;
      this.updateLangButtonLabel();

      const filtered = this.getFilteredServers();
      if (filtered.length > 0) {
        this.setServidor(filtered[0], true);
      } else {
        this.runPreloaderSequence(false);
      }
      this.renderLangDrawer();
      this.renderServersDrawer();
    },

    updateLangButtonLabel() {
      const meta = { LATINO: "Latino", SUBTITULADO: "Subtitulado", CASTELLANO: "Castellano" };
      this.dom.btnLangLabel.textContent = meta[this.state.idiomaActual] || "Idioma";
    },

    // ---------------------------------------------------------------
    // DRAWERS
    // ---------------------------------------------------------------
    getAvailableLangs() {
      const set = new Set(this.state.servidores.map((s) => s.idioma));
      const order = ["LATINO", "CASTELLANO", "SUBTITULADO"];
      return order.filter((l) => set.has(l));
    },

    renderLangDrawer() {
      const flags = { LATINO: "🇲🇽", CASTELLANO: "🇪🇸", SUBTITULADO: "🇺🇸" };
      const labels = { LATINO: "Latino", CASTELLANO: "Castellano", SUBTITULADO: "Subtitulado" };
      const langs = this.getAvailableLangs();

      if (langs.length === 0) {
        this.dom.langList.innerHTML = '<div class="empty-state">No hay idiomas disponibles.</div>';
        return;
      }

      this.dom.langList.innerHTML = langs.map((lang) => {
        const count = this.state.servidores.filter((s) => s.idioma === lang).length;
        const active = lang === this.state.idiomaActual;
        return \`
          <div class="option-row \${active ? "active" : ""}" data-lang="\${lang}">
            <div class="option-flag">\${flags[lang]}</div>
            <div class="option-main">
              <div class="option-title">\${labels[lang]}</div>
              <div class="option-sub">\${count} servidor\${count === 1 ? "" : "es"}</div>
            </div>
            <i class="ph-fill ph-check-circle option-check"></i>
          </div>
        \`;
      }).join("");

      this.dom.langList.querySelectorAll("[data-lang]").forEach((el) => {
        el.addEventListener("click", () => {
          this.setIdioma(el.getAttribute("data-lang"));
          this.closeDrawer(this.dom.langDrawerBackdrop);
        });
      });
    },

    renderServersDrawer() {
      const filtered = this.getFilteredServers();
      const labels = { LATINO: "Latino", CASTELLANO: "Castellano", SUBTITULADO: "Subtitulado" };

      if (filtered.length === 0) {
        this.dom.serversList.innerHTML = '<div class="empty-state">No hay servidores para este idioma.</div>';
        return;
      }

      this.dom.serversList.innerHTML = filtered.map((s) => {
        const active = this.state.servidorActual && s.id === this.state.servidorActual.id;
        return \`
          <div class="option-row \${active ? "active" : ""}" data-server-id="\${s.id}">
            <img class="option-favicon" src="\${s.favicon}" alt="" loading="lazy" onerror="this.style.opacity=0" />
            <div class="option-main">
              <div class="option-title">\${s.servidor}</div>
              <div class="option-sub">\${s.calidad || "Calidad estándar"}</div>
            </div>
            <span class="option-tag">\${labels[s.idioma]}</span>
            <i class="ph-fill ph-check-circle option-check"></i>
          </div>
        \`;
      }).join("");

      this.dom.serversList.querySelectorAll("[data-server-id]").forEach((el) => {
        el.addEventListener("click", () => {
          const id = el.getAttribute("data-server-id");
          const servidor = this.state.servidores.find((s) => String(s.id) === String(id));
          if (servidor) this.setServidor(servidor, true);
          this.closeDrawer(this.dom.serversDrawerBackdrop);
        });
      });
    },

    openDrawer(backdrop) { backdrop.classList.add("open"); },
    closeDrawer(backdrop) { backdrop.classList.remove("open"); },

    // ---------------------------------------------------------------
    // AVISOS ROTATIVOS
    // ---------------------------------------------------------------
    // Rotan (fade en desktop, marquee en móvil) durante un tiempo fijo
    // y luego desaparecen; en ese momento los botones de acción
    // (idioma/servidores) migran de la derecha a la izquierda del topbar.
    startNoticeRotation() {
      const notices = this.dom.notices;
      const NOTICE_DURATION_MS = 8000; // ~1 ciclo completo del rotator (2 avisos x 3.5s)

      if (notices.length) {
        let index = 0;
        const show = (i) => {
          notices.forEach((n, ni) => n.classList.toggle("show", ni === i));
        };
        show(0);
        clearInterval(this.state.noticeTimer);
        this.state.noticeTimer = setInterval(() => {
          index = (index + 1) % notices.length;
          show(index);
        }, 3500);
      }

      clearTimeout(this.state.noticeHideTimer);
      this.state.noticeHideTimer = setTimeout(() => {
        clearInterval(this.state.noticeTimer);
        if (this.dom.noticeRotator) this.dom.noticeRotator.classList.add("notices-hidden");
        if (this.dom.noticeMarquee) this.dom.noticeMarquee.classList.add("notices-hidden");
        if (this.dom.topbarInner) this.dom.topbarInner.classList.add("notices-done");
      }, NOTICE_DURATION_MS);
    },

    // ---------------------------------------------------------------
    // EVENTOS GENERALES
    // ---------------------------------------------------------------
    bindEvents() {
      this.dom = this.dom || {};
      document.getElementById("btn-lang").addEventListener("click", () => {
        this.openDrawer(document.getElementById("lang-drawer-backdrop"));
      });
      document.getElementById("btn-servers").addEventListener("click", () => {
        this.openDrawer(document.getElementById("servers-drawer-backdrop"));
      });

      document.querySelectorAll("[data-close-drawer]").forEach((btn) => {
        btn.addEventListener("click", () => {
          document.getElementById("lang-drawer-backdrop").classList.remove("open");
          document.getElementById("servers-drawer-backdrop").classList.remove("open");
        });
      });

      [document.getElementById("lang-drawer-backdrop"), document.getElementById("servers-drawer-backdrop")].forEach((backdrop) => {
        backdrop.addEventListener("click", (e) => {
          if (e.target === backdrop) backdrop.classList.remove("open");
        });
      });

      document.addEventListener("keydown", (e) => {
        if (e.key === "Escape") {
          document.getElementById("lang-drawer-backdrop").classList.remove("open");
          document.getElementById("servers-drawer-backdrop").classList.remove("open");
        }
      });
    },
  };

  window.TonPlayer = TonPlayer;
})();
`;
}
