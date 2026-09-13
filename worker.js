/*
 * ================================================================
 * CONTENT INGESTOR WORKER
 * ================================================================
 *
 * Función:
 *
 *   URL con parámetros
 *        ↓
 *   Scraper Beta
 *        ↓
 *   Extraer enlaces
 *        ↓
 *   Filtrar servidores bloqueados
 *        ↓
 *   Detectar duplicados
 *        ↓
 *   Supabase → enlaces
 *
 * RUTAS:
 *
 *   GET /play/movie/:tmdb_id
 *   GET /play/movie/:tmdb_id?force=true
 *
 *   GET /play/tv/:tmdb_id/:season/:episode
 *   GET /play/tv/:tmdb_id/:season/:episode?force=true
 *
 * VARIABLES DE CLOUDFLARE:
 *
 *   SOURCE_URL
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_KEY
 *
 * También acepta:
 *
 *   SUPABASE_ANON_KEY
 *
 * si las políticas RLS permiten INSERT/SELECT.
 *
 * NO USA:
 *
 *   API_KEY
 *   SSE
 *   BETA_KV
 *   CACHE
 *   ALPHA
 *
 * ================================================================
 */

const BLACKLIST = [
  "servidortrinity",
  "servidormahoutokoro",
  "servidordeathstar",
  "servidorgoldmember",
  "powvideo",
  "streamplay"
];

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type"
};


/* ================================================================
 * WORKER
 * ================================================================ */

export default {
  async fetch(request, env, ctx) {

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: CORS_HEADERS
      });
    }

    if (request.method !== "GET") {
      return jsonResponse(
        {
          success: false,
          status: "method_not_allowed"
        },
        405
      );
    }

    try {
      return await router(request, env, ctx);
    } catch (error) {

      console.error("Worker error:", error);

      return jsonResponse(
        {
          success: false,
          status: "worker_error",
          error: error?.message || String(error)
        },
        500
      );
    }
  }
};


/* ================================================================
 * ROUTER
 * ================================================================ */

async function router(request, env, ctx) {

  const url = new URL(request.url);

  const path = url.pathname.replace(/\/+$/, "");

  const force = isTrue(
    url.searchParams.get("force")
  );


  /* --------------------------------------------------------------
   * HEALTH
   * -------------------------------------------------------------- */

  if (path === "/health") {

    return jsonResponse({
      success: true,
      status: "online"
    });
  }


  /* --------------------------------------------------------------
   * MOVIE
   *
   * /play/movie/550
   * -------------------------------------------------------------- */

  let match = path.match(
    /^\/play\/movie\/(\d+)$/
  );

  if (match) {

    const tmdbId = match[1];

    return ingestContent({
      env,
      ctx,
      tmdbId,
      type: "movie",
      season: 0,
      episode: 0,
      force
    });
  }


  /* --------------------------------------------------------------
   * TV
   *
   * /play/tv/1399/1/1
   * -------------------------------------------------------------- */

  match = path.match(
    /^\/play\/tv\/(\d+)\/(\d+)\/(\d+)$/
  );

  if (match) {

    const tmdbId = match[1];

    const season = Number(match[2]);

    const episode = Number(match[3]);

    return ingestContent({
      env,
      ctx,
      tmdbId,
      type: "tv",
      season,
      episode,
      force
    });
  }


  /* --------------------------------------------------------------
   * NOT FOUND
   * -------------------------------------------------------------- */

  return jsonResponse(
    {
      success: false,
      status: "not_found"
    },
    404
  );
}


/* ================================================================
 * MAIN INGEST
 * ================================================================ */

async function ingestContent({
  env,
  ctx,
  tmdbId,
  type,
  season,
  episode,
  force
}) {

  const started = Date.now();


  /* --------------------------------------------------------------
   * CHECK CONFIG
   * -------------------------------------------------------------- */

  if (!env.SOURCE_URL) {

    return jsonResponse(
      {
        success: false,
        status: "not_configured",
        error: "SOURCE_URL no está configurado."
      },
      500
    );
  }


  const supabase = getSupabaseConfig(env);


  if (!supabase) {

    return jsonResponse(
      {
        success: false,
        status: "not_configured",
        error:
          "Configura SUPABASE_URL y SUPABASE_SERVICE_KEY."
      },
      500
    );
  }


  /* --------------------------------------------------------------
   * COMPROBAR BASE DE DATOS
   *
   * Si no se utiliza force=true y ya existen enlaces,
   * no hacemos scraping innecesario.
   * -------------------------------------------------------------- */

  let existing = [];


  if (!force) {

    const dbCheck = await getExistingLinks({
      supabase,
      tmdbId,
      type,
      season,
      episode
    });


    if (!dbCheck.ok) {

      return jsonResponse(
        {
          success: false,
          status: "database_error",
          tmdb_id: tmdbId,
          type,
          season,
          episode,
          error: dbCheck.error,
          elapsed_ms: Date.now() - started
        },
        502
      );
    }


    existing = dbCheck.links;


    if (existing.length > 0) {

      return jsonResponse({
        success: true,
        status: "already_exists",

        tmdb_id: tmdbId,

        type,

        season,

        episode,

        found: existing.length,

        inserted: 0,

        existing: existing.length,

        force: false,

        elapsed_ms: Date.now() - started
      });
    }
  }


  /* --------------------------------------------------------------
   * SCRAPER BETA
   * -------------------------------------------------------------- */

  const beta = await scrapeBeta({
    env,
    tmdbId,
    type,
    season,
    episode
  });


  const links = beta.success
    ? deduplicateLinks(
        (beta.links || []).filter(isValidLink)
      )
    : [];


  /* --------------------------------------------------------------
   * SIN ENLACES
   * -------------------------------------------------------------- */

  if (links.length === 0) {

    return jsonResponse({
      success: false,

      status:
        beta.status ||
        "no_links",

      tmdb_id: tmdbId,

      type,

      season,

      episode,

      found: 0,

      inserted: 0,

      existing: existing.length,

      force,

      scraper: {

        http_code:
          beta.http_code ?? null,

        content_type:
          beta.content_type ?? null,

        elapsed_ms:
          beta.elapsed_ms ?? null,

        parser:
          beta.parser ?? null,

        raw_keys:
          beta.raw_keys ?? [],

        error:
          beta.error ?? null
      },

      elapsed_ms:
        Date.now() - started
    });
  }


  /* --------------------------------------------------------------
   * CONSULTAR DB
   *
   * Incluso con force=true se consulta antes de insertar,
   * para evitar duplicados.
   * -------------------------------------------------------------- */

  const dbCheck = await getExistingLinks({
    supabase,
    tmdbId,
    type,
    season,
    episode
  });


  if (!dbCheck.ok) {

    return jsonResponse(
      {
        success: false,

        status: "database_error",

        tmdb_id: tmdbId,

        type,

        season,

        episode,

        found: links.length,

        inserted: 0,

        error: dbCheck.error,

        elapsed_ms:
          Date.now() - started
      },
      502
    );
  }


  existing = dbCheck.links;


  /* --------------------------------------------------------------
   * CREAR SET DE DUPLICADOS
   * -------------------------------------------------------------- */

  const existingKeys = new Set(
    existing.map(
      link =>
        `${link.idioma}|${link.url_embed}`
    )
  );


  /* --------------------------------------------------------------
   * SOLO ENLACES NUEVOS
   * -------------------------------------------------------------- */

  const newLinks = links.filter(
    link =>
      !existingKeys.has(
        `${link.idioma}|${link.url_embed}`
      )
  );


  /* --------------------------------------------------------------
   * INSERTAR
   * -------------------------------------------------------------- */

  let inserted = 0;


  if (newLinks.length > 0) {

    const rows = newLinks.map(link => ({

      tmdb_id: String(tmdbId),

      tipo: type,

      url_embed: link.url_embed,

      servidor:
        link.servidor ||
        "Desconocido",

      idioma:
        link.idioma ||
        "Latino",

      temporada:
        type === "tv"
          ? Number(season)
          : 0,

      episodio:
        type === "tv"
          ? Number(episode)
          : 0

    }));


    const insertResult =
      await insertLinks({
        supabase,
        rows
      });


    if (!insertResult.ok) {

      return jsonResponse(
        {
          success: false,

          status:
            "database_insert_error",

          tmdb_id: tmdbId,

          type,

          season,

          episode,

          found: links.length,

          inserted: 0,

          existing:
            existing.length,

          new_links:
            newLinks.length,

          error:
            insertResult.error,

          elapsed_ms:
            Date.now() - started
        },
        502
      );
    }


    inserted =
      insertResult.inserted;
  }


  /* --------------------------------------------------------------
   * RESULTADO
   *
   * NO DEVUELVE LOS ENLACES.
   * Solo informa qué ocurrió.
   * -------------------------------------------------------------- */

  return jsonResponse({

    success: true,

    status: "saved",

    tmdb_id: tmdbId,

    type,

    season,

    episode,

    found:
      links.length,

    inserted,

    existing:
      existing.length,

    skipped_duplicates:
      links.length -
      newLinks.length,

    force,

    scraper: {

      http_code:
        beta.http_code ?? null,

      content_type:
        beta.content_type ?? null,

      elapsed_ms:
        beta.elapsed_ms ?? null,

      parser:
        beta.parser ?? null,

      raw_keys:
        beta.raw_keys ?? [],

      all_embeds_languages:
        beta.all_embeds_languages ?? [],

      all_embeds_urls:
        beta.all_embeds_urls ?? 0,

      all_embeds_valid:
        beta.all_embeds_valid ?? 0,

      all_embeds_discarded:
        beta.all_embeds_discarded ?? 0,

      embeds_urls:
        beta.embeds_urls ?? 0,

      embeds_valid:
        beta.embeds_valid ?? 0,

      embeds_discarded:
        beta.embeds_discarded ?? 0,

      error:
        beta.error ?? null
    },

    elapsed_ms:
      Date.now() - started
  });
}


/* ================================================================
 * SUPABASE CONFIG
 * ================================================================ */

function getSupabaseConfig(env) {

  const url =
    String(
      env.SUPABASE_URL || ""
    ).replace(/\/+$/, "");


  const key =
    env.SUPABASE_SERVICE_KEY ||
    env.SUPABASE_ANON_KEY ||
    "";


  if (!url || !key) {
    return null;
  }


  return {
    url,
    key
  };
}


/* ================================================================
 * SUPABASE HEADERS
 * ================================================================ */

function supabaseHeaders(supabase) {

  return {

    "apikey":
      supabase.key,

    "Authorization":
      `Bearer ${supabase.key}`,

    "Content-Type":
      "application/json",

    "Accept":
      "application/json"
  };
}


/* ================================================================
 * BUSCAR ENLACES EXISTENTES
 * ================================================================ */

async function getExistingLinks({
  supabase,
  tmdbId,
  type,
  season,
  episode
}) {

  const params =
    new URLSearchParams();


  params.set(
    "select",
    "id,tmdb_id,tipo,url_embed,servidor,idioma,temporada,episodio"
  );


  params.set(
    "tmdb_id",
    `eq.${tmdbId}`
  );


  params.set(
    "tipo",
    `eq.${type}`
  );


  if (type === "tv") {

    params.set(
      "temporada",
      `eq.${season}`
    );

    params.set(
      "episodio",
      `eq.${episode}`
    );
  }


  const endpoint =
    `${supabase.url}/rest/v1/enlaces?${params.toString()}`;


  try {

    const response =
      await fetch(endpoint, {

        method: "GET",

        headers: {
          ...supabaseHeaders(supabase),
          "Prefer":
            "return=representation"
        }
      });


    const text =
      await response.text();


    if (!response.ok) {

      return {

        ok: false,

        links: [],

        error:
          `Supabase GET HTTP ${response.status}: ${text.slice(0, 500)}`
      };
    }


    let data;


    try {

      data =
        JSON.parse(text);

    } catch {

      return {

        ok: false,

        links: [],

        error:
          "Supabase devolvió una respuesta que no es JSON."
      };
    }


    return {

      ok: true,

      links:
        Array.isArray(data)
          ? data
          : []
    };

  } catch (error) {

    return {

      ok: false,

      links: [],

      error:
        error?.message ||
        String(error)
    };
  }
}


/* ================================================================
 * INSERTAR EN SUPABASE
 * ================================================================ */

async function insertLinks({
  supabase,
  rows
}) {

  const endpoint =
    `${supabase.url}/rest/v1/enlaces`;


  try {

    const response =
      await fetch(endpoint, {

        method: "POST",

        headers: {

          ...supabaseHeaders(
            supabase
          ),

          "Prefer":
            "return=minimal"
        },

        body:
          JSON.stringify(rows)
      });


    const text =
      await response.text();


    if (!response.ok) {

      return {

        ok: false,

        inserted: 0,

        error:
          `Supabase POST HTTP ${response.status}: ${text.slice(0, 700)}`
      };
    }


    return {

      ok: true,

      inserted:
        rows.length
    };

  } catch (error) {

    return {

      ok: false,

      inserted: 0,

      error:
        error?.message ||
        String(error)
    };
  }
}


/* ================================================================
 * SCRAPER BETA
 * ================================================================ */

async function scrapeBeta({
  env,
  tmdbId,
  type,
  season,
  episode
}) {

  const started =
    Date.now();


  const base =
    String(env.SOURCE_URL)
      .replace(/\/+$/, "");


  const params =
    new URLSearchParams();


  params.set(
    "action",
    "details"
  );


  params.set(
    "id",
    String(tmdbId)
  );


  params.set(
    "type",
    type
  );


  if (type === "tv") {

    params.set(
      "season",
      String(season)
    );

    params.set(
      "episode",
      String(episode)
    );
  }


  const endpoint =
    `${base}/embed/api.php?${params.toString()}`;


  let response;


  /* --------------------------------------------------------------
   * FETCH
   * -------------------------------------------------------------- */

  try {

    response =
      await fetch(endpoint, {

        method: "GET",

        redirect: "follow",

        headers: {

          "Accept":
            "application/json,text/plain,*/*",

          "Accept-Language":
            "es-ES,es;q=0.9,en;q=0.8",

          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
            "AppleWebKit/537.36 (KHTML, like Gecko) " +
            "Chrome/131.0.0.0 Safari/537.36"
        }
      });

  } catch (error) {

    return {

      success: false,

      status:
        "request_error",

      links: [],

      elapsed_ms:
        Date.now() -
        started,

      error:
        error?.message ||
        String(error)
    };
  }


  const contentType =
    response.headers.get(
      "content-type"
    ) || "";


  const text =
    await response.text();


  /* --------------------------------------------------------------
   * JSON
   * -------------------------------------------------------------- */

  let data;


  try {

    data =
      JSON.parse(text);

  } catch {

    return {

      success: false,

      status:
        "invalid_json",

      links: [],

      http_code:
        response.status,

      content_type:
        contentType,

      elapsed_ms:
        Date.now() -
        started,

      raw_keys: [],

      parser: null,

      error:
        response.ok
          ? "Beta devolvió una respuesta que no es JSON."
          : `Beta respondió HTTP ${response.status}.`
    };
  }


  /* --------------------------------------------------------------
   * HTTP ERROR
   * -------------------------------------------------------------- */

  if (!response.ok) {

    return {

      success: false,

      status:
        "http_error",

      links: [],

      http_code:
        response.status,

      content_type:
        contentType,

      elapsed_ms:
        Date.now() -
        started,

      raw_keys:
        objectKeys(data),

      parser: null,

      error:
        extractErrorMessage(data)
    };
  }


  const rawKeys =
    objectKeys(data);


  /* ==============================================================
   * ALL_EMBEDS
   * ============================================================== */

  if (
    data?.all_embeds &&
    typeof data.all_embeds === "object" &&
    !Array.isArray(data.all_embeds)
  ) {

    const diagnostics =
      countAllEmbeds(
        data.all_embeds
      );


    const links =
      extractAllEmbeds(
        data.all_embeds
      );


    if (links.length > 0) {

      return {

        success: true,

        status:
          "links_found",

        links,

        http_code:
          response.status,

        content_type:
          contentType,

        elapsed_ms:
          Date.now() -
          started,

        parser:
          "all_embeds",

        raw_keys:
          rawKeys,

        ...diagnostics
      };
    }
  }


  /* ==============================================================
   * EMBEDS FALLBACK
   * ============================================================== */

  if (
    data?.embeds &&
    typeof data.embeds === "object" &&
    !Array.isArray(data.embeds)
  ) {

    const diagnostics =
      countEmbeds(
        data.embeds
      );


    const idioma =
      normalizeLanguage(
        data.language ||
        "latino"
      );


    const links =
      extractEmbedsFallback(
        data.embeds,
        idioma
      );


    if (links.length > 0) {

      return {

        success: true,

        status:
          "links_found",

        links,

        http_code:
          response.status,

        content_type:
          contentType,

        elapsed_ms:
          Date.now() -
          started,

        parser:
          "embeds",

        raw_keys:
          rawKeys,

        ...diagnostics
      };
    }


    return {

      success: false,

      status:
        "no_embeds",

      links: [],

      http_code:
        response.status,

      content_type:
        contentType,

      elapsed_ms:
        Date.now() -
        started,

      parser:
        "embeds",

      raw_keys:
        rawKeys,

      ...diagnostics,

      error:
        "Beta respondió JSON pero no quedaron URLs válidas."
    };
  }


  /* ==============================================================
   * NO EMBEDS
   * ============================================================== */

  return {

    success: false,

    status:
      "no_embeds",

    links: [],

    http_code:
      response.status,

    content_type:
      contentType,

    elapsed_ms:
      Date.now() -
      started,

    parser: null,

    raw_keys:
      rawKeys,

    all_embeds_languages: [],

    all_embeds_urls: 0,

    all_embeds_valid: 0,

    all_embeds_discarded: 0,

    embeds_urls: 0,

    embeds_valid: 0,

    embeds_discarded: 0,

    error:
      "Beta devolvió JSON pero no contiene all_embeds ni embeds."
  };
}


/* ================================================================
 * EXTRAER ALL_EMBEDS
 * ================================================================ */

function extractAllEmbeds(
  allEmbeds
) {

  const result = [];


  for (
    const [language, servers]
    of Object.entries(allEmbeds)
  ) {

    if (
      !servers ||
      typeof servers !== "object" ||
      Array.isArray(servers)
    ) {
      continue;
    }


    const idioma =
      normalizeLanguage(
        language
      );


    for (
      const [serverName, values]
      of Object.entries(servers)
    ) {

      if (
        isBlacklisted(
          serverName
        )
      ) {
        continue;
      }


      const urls =
        Array.isArray(values)
          ? values
          : typeof values === "string"
            ? [values]
            : [];


      for (const url of urls) {

        if (!isHttpUrl(url)) {
          continue;
        }


        result.push({

          url_embed:
            url,

          servidor:
            normalizeServerName(
              serverName
            ),

          idioma
        });
      }
    }
  }


  return deduplicateLinks(
    result
  );
}


/* ================================================================
 * EXTRAER EMBEDS FALLBACK
 * ================================================================ */

function extractEmbedsFallback(
  embeds,
  idioma
) {

  const result = [];


  for (
    const [serverName, values]
    of Object.entries(embeds)
  ) {

    if (
      isBlacklisted(
        serverName
      )
    ) {
      continue;
    }


    const urls =
      Array.isArray(values)
        ? values
        : typeof values === "string"
          ? [values]
          : [];


    for (const url of urls) {

      if (!isHttpUrl(url)) {
        continue;
      }


      result.push({

        url_embed:
          url,

        servidor:
          normalizeServerName(
            serverName
          ),

        idioma
      });
    }
  }


  return deduplicateLinks(
    result
  );
}


/* ================================================================
 * CONTAR ALL_EMBEDS
 * ================================================================ */

function countAllEmbeds(
  allEmbeds
) {

  let urls = 0;

  let valid = 0;

  let discarded = 0;

  const languages = [];


  for (
    const [language, servers]
    of Object.entries(allEmbeds)
  ) {

    languages.push(
      language
    );


    if (
      !servers ||
      typeof servers !== "object" ||
      Array.isArray(servers)
    ) {
      continue;
    }


    for (
      const [serverName, values]
      of Object.entries(servers)
    ) {

      const list =
        Array.isArray(values)
          ? values
          : typeof values === "string"
            ? [values]
            : [];


      for (const url of list) {

        urls++;


        if (
          isHttpUrl(url) &&
          !isBlacklisted(
            serverName
          )
        ) {

          valid++;

        } else {

          discarded++;
        }
      }
    }
  }


  return {

    all_embeds_languages:
      languages,

    all_embeds_urls:
      urls,

    all_embeds_valid:
      valid,

    all_embeds_discarded:
      discarded
  };
}


/* ================================================================
 * CONTAR EMBEDS
 * ================================================================ */

function countEmbeds(
  embeds
) {

  let urls = 0;

  let valid = 0;

  let discarded = 0;


  for (
    const [serverName, values]
    of Object.entries(embeds)
  ) {

    const list =
      Array.isArray(values)
        ? values
        : typeof values === "string"
          ? [values]
          : [];


    for (const url of list) {

      urls++;


      if (
        isHttpUrl(url) &&
        !isBlacklisted(
          serverName
        )
      ) {

        valid++;

      } else {

        discarded++;
      }
    }
  }


  return {

    embeds_urls:
      urls,

    embeds_valid:
      valid,

    embeds_discarded:
      discarded
  };
}


/* ================================================================
 * DEDUPLICAR
 * ================================================================ */

function deduplicateLinks(
  links
) {

  const map =
    new Map();


  for (const link of links) {

    if (!isValidLink(link)) {
      continue;
    }


    const key =
      `${link.idioma}|${link.url_embed}`;


    if (!map.has(key)) {

      map.set(
        key,
        link
      );
    }
  }


  return Array.from(
    map.values()
  );
}


/* ================================================================
 * VALIDAR LINK
 * ================================================================ */

function isValidLink(
  link
) {

  return !!(
    link &&
    typeof link === "object" &&
    isHttpUrl(
      link.url_embed
    ) &&
    !isBlacklisted(
      link.servidor
    )
  );
}


/* ================================================================
 * VALIDAR HTTP URL
 * ================================================================ */

function isHttpUrl(
  value
) {

  return (
    typeof value === "string" &&
    /^https?:\/\//i.test(value)
  );
}


/* ================================================================
 * BLACKLIST
 * ================================================================ */

function isBlacklisted(
  server
) {

  const normalized =
    String(server || "")
      .trim()
      .toLowerCase()
      .replace(
        /[\s_-]+/g,
        ""
      );


  return BLACKLIST.some(
    blocked => {

      const b =
        blocked
          .toLowerCase()
          .replace(
            /[\s_-]+/g,
            ""
          );


      return (
        normalized === b ||
        normalized.startsWith(b)
      );
    }
  );
}


/* ================================================================
 * NORMALIZAR SERVIDOR
 * ================================================================ */

function normalizeServerName(
  server
) {

  const value =
    String(server || "")
      .trim()
      .toLowerCase();


  const base =
    value.replace(
      /_\d+$/,
      ""
    );


  const map = {

    abyss:
      "Abyss",

    streamwish:
      "Streamwish",

    filelions:
      "Filelions",

    voe:
      "Voe",

    doodstream:
      "Doodstream",

    primeload:
      "Primeload",

    mixdrop:
      "Mixdrop",

    filemoon:
      "Filemoon",

    powvideo:
      "Powvideo",

    streamplay:
      "Streamplay",

    streamtape:
      "Streamtape",

    vidmoly:
      "Vidmoly",

    vimeos:
      "Vimeos"
  };


  return (
    map[base] ||
    capitalize(base)
  );
}


/* ================================================================
 * NORMALIZAR IDIOMA
 * ================================================================ */

function normalizeLanguage(
  language
) {

  const value =
    String(language || "")
      .trim()
      .toLowerCase();


  const map = {

    latino:
      "Latino",

    latam:
      "Latino",

    "español latino":
      "Latino",

    "espanol latino":
      "Latino",

    castellano:
      "Castellano",

    español:
      "Castellano",

    espanol:
      "Castellano",

    subtitulado:
      "Subtitulado",

    subtitulos:
      "Subtitulado",

    subtítulo:
      "Subtitulado",

    subtitulo:
      "Subtitulado",

    subtitle:
      "Subtitulado",

    sub:
      "Subtitulado"
  };


  return (
    map[value] ||
    capitalize(value)
  );
}


/* ================================================================
 * CAPITALIZAR
 * ================================================================ */

function capitalize(
  value
) {

  if (!value) {
    return "Desconocido";
  }


  return (
    value.charAt(0).toUpperCase() +
    value.slice(1)
  );
}


/* ================================================================
 * OBJECT KEYS
 * ================================================================ */

function objectKeys(
  value
) {

  return (
    value &&
    typeof value === "object" &&
    !Array.isArray(value)
  )
    ? Object.keys(value)
    : [];
}


/* ================================================================
 * EXTRAER ERROR
 * ================================================================ */

function extractErrorMessage(
  data
) {

  if (
    typeof data === "string"
  ) {

    return data.slice(
      0,
      500
    );
  }


  if (
    data &&
    typeof data === "object"
  ) {

    return (
      data.message ||
      data.error ||
      data.msg ||
      "Respuesta HTTP no válida."
    );
  }


  return "Respuesta HTTP no válida.";
}


/* ================================================================
 * TRUE
 * ================================================================ */

function isTrue(
  value
) {

  return [

    "1",

    "true",

    "yes",

    "on",

    "force"

  ].includes(
    String(value || "")
      .trim()
      .toLowerCase()
  );
}


/* ================================================================
 * JSON RESPONSE
 * ================================================================ */

function jsonResponse(
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

      headers: {

        ...CORS_HEADERS,

        "Content-Type":
          "application/json; charset=UTF-8",

        "Cache-Control":
          "no-store"
      }
    }
  );
}