/*
|--------------------------------------------------------------------------
| CONTENT WORKER — SSE REAL
|--------------------------------------------------------------------------
|
| Flujo:
|
| NORMAL:
|   Player -> Alpha (Supabase / BD)
|                 |
|                 +--> KV HIT  -> alpha_cache_hit -> alpha_found -> complete
|                 |
|                 +--> KV MISS -> alpha_cache_miss -> Supabase -> alpha_found
|                                      -> complete
|
| FALLBACK:
|   Player -> ?fallback=beta -> Beta (scraper / SOURCE_URL)
|                                  -> beta_search -> beta_found -> complete
|
| IMPORTANTE:
| - Beta NO se consulta automáticamente.
| - Alpha es exclusivamente Supabase/BD.
| - Beta es exclusivamente SOURCE_URL.
| - Supabase usa únicamente lectura mediante SUPABASE_ANON_KEY.
| - SOURCE_URL conserva /embed/api.php.
| - KV de Alpha: 6 horas.
|--------------------------------------------------------------------------
|
| SECRETS / VARIABLES:
|
| API_KEY
| SUPABASE_URL
| SUPABASE_ANON_KEY
| SOURCE_URL
|
| KV binding:
| ALPHA_KV
|--------------------------------------------------------------------------
*/

const CACHE_TTL = 6 * 60 * 60;

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
    "Access-Control-Allow-Headers": "Content-Type, Authorization"
};

export default {
    async fetch(request, env, ctx) {
        if (request.method === "OPTIONS") {
            return new Response(null, {
                status: 204,
                headers: CORS_HEADERS
            });
        }

        if (request.method !== "GET") {
            return jsonResponse({
                success: false,
                status: "method_not_allowed",
                event: "complete",
                message: "Solo se permite GET."
            }, 405);
        }

        try {
            return await router(request, env, ctx);
        } catch (error) {
            console.error("Worker error:", error);

            return jsonResponse({
                success: false,
                status: "worker_error",
                event: "complete",
                message: error instanceof Error
                    ? error.message
                    : String(error)
            }, 500);
        }
    }
};

async function router(request, env, ctx) {
    const url = new URL(request.url);
    const pathname = url.pathname.replace(/\/+$/, "");

    if (pathname === "/health") {
        return jsonResponse({
            success: true,
            status: "online",
            event: "complete",
            worker: "Content Worker SSE"
        });
    }

    if (!validateApiKey(request, env)) {
        return jsonResponse({
            success: false,
            status: "unauthorized",
            event: "complete",
            message: "API key inválida o ausente."
        }, 401);
    }

    const fallbackBeta = isBetaFallback(
        url.searchParams.get("fallback")
    );

    const force = isTrue(url.searchParams.get("force"));

    const movieMatch = pathname.match(/^\/play\/movie\/(\d+)$/);

    if (movieMatch) {
        return processContent({
            env,
            ctx,
            tmdbId: movieMatch[1],
            type: "movie",
            season: 0,
            episode: 0,
            fallbackBeta,
            force
        });
    }

    const tvMatch = pathname.match(/^\/play\/tv\/(\d+)\/(\d+)\/(\d+)$/);

    if (tvMatch) {
        return processContent({
            env,
            ctx,
            tmdbId: tvMatch[1],
            type: "tv",
            season: Number(tvMatch[2]),
            episode: Number(tvMatch[3]),
            fallbackBeta,
            force
        });
    }

    return jsonResponse({
        success: false,
        status: "not_found",
        event: "complete",
        endpoints: {
            health: "/health",
            movie: "/play/movie/ID",
            tv: "/play/tv/ID/SEASON/EPISODE"
        }
    }, 404);
}

function validateApiKey(request, env) {
    if (!env.API_KEY) {
        console.error("API_KEY no está configurada.");
        return false;
    }

    const authorization = request.headers.get("Authorization") || "";
    const match = authorization.match(/^Bearer\s+(.+)$/i);

    if (!match) {
        return false;
    }

    return match[1].trim() === env.API_KEY;
}

async function processContent({
    env,
    ctx,
    tmdbId,
    type,
    season,
    episode,
    fallbackBeta,
    force
}) {
    const stream = createSSEStream();
    const writer = stream.writer;

    if (fallbackBeta) {
        await sendSSE(writer, "connected", {
            success: true,
            status: "connected",
            message: "Conexión SSE establecida.",
            tmdb_id: tmdbId,
            type,
            season,
            episode,
            mode: "beta_fallback"
        });

        await sendSSE(writer, "beta_search", {
            success: true,
            status: "searching_beta",
            source: "Beta",
            message: "Consultando servidores alternativos."
        });

        const beta = await scrapeBeta({
            env,
            tmdbId,
            type,
            season,
            episode
        });

        const betaLinks = beta.success
            ? deduplicateLinks(
                beta.links.filter(isValidLink)
            )
            : [];

        await sendSSE(writer, "beta_found", {
            success: betaLinks.length > 0,
            status: betaLinks.length > 0
                ? "beta_found"
                : "beta_unavailable",
            source: "Beta",
            found: betaLinks.length,
            links: betaLinks,
            http_code: beta.http_code ?? null,
            content_type: beta.content_type ?? null,
            elapsed_ms: beta.elapsed_ms ?? null,
            parser: beta.parser ?? null,
            raw_keys: beta.raw_keys ?? [],
            all_embeds_languages: beta.all_embeds_languages ?? [],
            all_embeds_urls: beta.all_embeds_urls ?? 0,
            all_embeds_valid: beta.all_embeds_valid ?? 0,
            all_embeds_discarded: beta.all_embeds_discarded ?? 0,
            embeds_urls: beta.embeds_urls ?? 0,
            embeds_valid: beta.embeds_valid ?? 0,
            embeds_discarded: beta.embeds_discarded ?? 0,
            error: beta.error ?? null,
            message: betaLinks.length > 0
                ? `Beta: ${betaLinks.length} servidor(es) encontrado(s).`
                : "Beta no respondió o no encontró servidores."
        });

        await sendSSE(writer, "search_complete", {
            success: betaLinks.length > 0,
            status: "search_complete",
            alpha_found: 0,
            beta_found: betaLinks.length,
            found: betaLinks.length,
            message: "Búsqueda de servidores alternativos completada."
        });

        await sendSSE(writer, "complete", {
            success: betaLinks.length > 0,
            status: betaLinks.length > 0
                ? "success"
                : "source_unavailable",
            event: "complete",
            source: "Beta",
            fallback: null,
            tmdb_id: tmdbId,
            type,
            season,
            episode,
            alpha_found: 0,
            beta_found: betaLinks.length,
            beta_queried: true,
            found: betaLinks.length,
            links: betaLinks,
            beta_error: beta.error ?? null,
            message: betaLinks.length > 0
                ? "Servidores alternativos encontrados."
                : "No se encontraron servidores alternativos."
        });

        writer.close();

        return stream.response;
    }

    await sendSSE(writer, "connected", {
        success: true,
        status: "connected",
        message: "Conexión SSE establecida.",
        tmdb_id: tmdbId,
        type,
        season,
        episode,
        mode: "alpha"
    });

    await sendSSE(writer, "tmdb_receiving", {
        success: true,
        status: "tmdb_receiving",
        message: "Recibiendo datos de TMDB",
        tmdb_id: tmdbId,
        type,
        season,
        episode
    });

    await sendSSE(writer, "tmdb_received", {
        success: true,
        status: "tmdb_received",
        message: "Datos de TMDB recibidos",
        tmdb_id: tmdbId,
        type,
        season,
        episode
    });

    await sendSSE(writer, "searching", {
        success: true,
        status: "searching",
        message: "Buscando servidores."
    });

    await sendSSE(writer, "alpha_search", {
        success: true,
        status: "searching_alpha",
        source: "Alpha",
        message: "Consultando Alpha (Supabase)."
    });

    const cacheKey = buildAlphaCacheKey(
        type,
        tmdbId,
        season,
        episode
    );

    let alpha;
    let cacheStatus = "miss";

    if (!force && env.ALPHA_KV) {
        const cached = await env.ALPHA_KV.get(cacheKey, "json");

        if (cached && Array.isArray(cached.links)) {
            cacheStatus = "hit";

            const cachedLinks = deduplicateLinks(
                cached.links.filter(isValidLink)
            );

            await sendSSE(writer, "alpha_cache_hit", {
                success: true,
                status: "alpha_cache_hit",
                source: "Alpha",
                found: cachedLinks.length,
                ttl_seconds: CACHE_TTL,
                message: "Alpha: resultados obtenidos desde caché."
            });

            alpha = {
                success: cachedLinks.length > 0,
                status: cachedLinks.length > 0
                    ? "links_found"
                    : "no_links",
                links: cachedLinks,
                mode: "kv",
                elapsed_ms: 0
            };
        }
    }

    if (!alpha) {
        await sendSSE(writer, "alpha_cache_miss", {
            success: true,
            status: "alpha_cache_miss",
            source: "Alpha",
            force,
            message: force
                ? "Alpha: force=true, se salta el caché."
                : env.ALPHA_KV
                    ? "Alpha: no hay resultado válido en KV."
                    : "Alpha: ALPHA_KV no está configurado; consultando BD."
        });

        alpha = await fetchAlphaFromSupabase({
            env,
            tmdbId,
            type,
            season,
            episode
        });

        if (
            env.ALPHA_KV &&
            alpha.success &&
            alpha.links.length > 0
        ) {
            ctx.waitUntil(
                env.ALPHA_KV.put(
                    cacheKey,
                    JSON.stringify({
                        links: alpha.links,
                        cached_at: Date.now()
                    }),
                    { expirationTtl: CACHE_TTL }
                )
            );
        }
    }

    const alphaLinks = alpha.success
        ? deduplicateLinks(
            alpha.links.filter(isValidLink)
        )
        : [];

    await sendSSE(writer, "alpha_found", {
        success: alphaLinks.length > 0,
        status: alphaLinks.length > 0
            ? "alpha_found"
            : "alpha_unavailable",
        source: "Alpha",
        found: alphaLinks.length,
        links: alphaLinks,
        cache: cacheStatus,
        http_code: alpha.http_code ?? null,
        content_type: alpha.content_type ?? null,
        elapsed_ms: alpha.elapsed_ms ?? null,
        parser: alpha.parser ?? "supabase_rest",
        rows_received: alpha.rows_received ?? 0,
        rows_valid: alpha.rows_valid ?? 0,
        rows_discarded: alpha.rows_discarded ?? 0,
        error: alpha.error ?? null,
        message: alphaLinks.length > 0
            ? `Alpha: ${alphaLinks.length} servidor(es) encontrado(s).`
            : "Alpha no encontró servidores."
    });

    await sendSSE(writer, "search_complete", {
        success: alphaLinks.length > 0,
        status: "search_complete",
        alpha_found: alphaLinks.length,
        beta_found: 0,
        found: alphaLinks.length,
        beta_pending: true,
        message: alphaLinks.length > 0
            ? "Búsqueda principal completada. Beta queda disponible bajo demanda."
            : "Alpha no encontró servidores. Beta queda disponible bajo demanda."
    });

    await sendSSE(writer, "complete", {
        success: alphaLinks.length > 0,
        status: alphaLinks.length > 0
            ? "success"
            : "source_unavailable",
        event: "complete",
        source: "Alpha",
        fallback: "Beta",
        tmdb_id: tmdbId,
        type,
        season,
        episode,
        alpha_found: alphaLinks.length,
        beta_found: 0,
        beta_queried: false,
        found: alphaLinks.length,
        links: alphaLinks,
        alpha_cache: cacheStatus,
        alpha_error: alpha.error ?? null,
        beta_pending: true,
        beta_endpoint: buildBetaEndpoint(
            tmdbId,
            type,
            season,
            episode
        ),
        message: alphaLinks.length > 0
            ? "Servidores de Alpha encontrados. Beta no se consultó."
            : "Alpha no encontró servidores. Puedes solicitar servidores alternativos."
    });

    writer.close();

    return stream.response;
}

/*
|--------------------------------------------------------------------------
| ALPHA — SUPABASE / BD
|--------------------------------------------------------------------------
|
| Solo lectura.
| Requiere:
|   SUPABASE_URL
|   SUPABASE_ANON_KEY
|
| La tabla esperada es:
|   enlaces
|
| Columnas:
|   tmdb_id
|   tipo
|   url_embed
|   servidor
|   idioma
|   temporada
|   episodio
|--------------------------------------------------------------------------
*/

async function fetchAlphaFromSupabase({
    env,
    tmdbId,
    type,
    season,
    episode
}) {
    const started = Date.now();

    if (!env.SUPABASE_URL) {
        return {
            success: false,
            status: "not_configured",
            links: [],
            elapsed_ms: Date.now() - started,
            error: "SUPABASE_URL no está configurado."
        };
    }

    if (!env.SUPABASE_ANON_KEY) {
        return {
            success: false,
            status: "not_configured",
            links: [],
            elapsed_ms: Date.now() - started,
            error: "SUPABASE_ANON_KEY no está configurado."
        };
    }

    const baseUrl = env.SUPABASE_URL.replace(/\/+$/, "");

    const params = new URLSearchParams();

    params.set(
        "select",
        "tmdb_id,tipo,url_embed,servidor,idioma,temporada,episodio"
    );

    params.set("tmdb_id", `eq.${tmdbId}`);
    params.set("tipo", `eq.${type}`);
    params.set("temporada", `eq.${season}`);
    params.set("episodio", `eq.${episode}`);

    const endpoint =
        `${baseUrl}/rest/v1/enlaces?${params.toString()}`;

    let response;

    try {
        response = await fetch(endpoint, {
            method: "GET",
            headers: {
                "apikey": env.SUPABASE_ANON_KEY,
                "Authorization":
                    `Bearer ${env.SUPABASE_ANON_KEY}`,
                "Accept": "application/json"
            }
        });
    } catch (error) {
        return {
            success: false,
            status: "request_error",
            links: [],
            elapsed_ms: Date.now() - started,
            error: error instanceof Error
                ? error.message
                : String(error)
        };
    }

    const contentType =
        response.headers.get("content-type") || "";

    let rows;

    try {
        rows = await response.json();
    } catch (error) {
        return {
            success: false,
            status: "invalid_json",
            links: [],
            http_code: response.status,
            content_type: contentType,
            elapsed_ms: Date.now() - started,
            error: `Supabase devolvió una respuesta no JSON: ${
                error instanceof Error ? error.message : String(error)
            }`
        };
    }

    if (!response.ok) {
        return {
            success: false,
            status: "http_error",
            links: [],
            http_code: response.status,
            content_type: contentType,
            elapsed_ms: Date.now() - started,
            error: extractErrorMessage(rows)
        };
    }

    if (!Array.isArray(rows)) {
        return {
            success: false,
            status: "invalid_response",
            links: [],
            http_code: response.status,
            content_type: contentType,
            elapsed_ms: Date.now() - started,
            error: "Supabase no devolvió un array."
        };
    }

    const rowsReceived = rows.length;

    const mapped = rows.map(row => {
        if (!row || typeof row !== "object") {
            return null;
        }

        if (!isHttpUrl(row.url_embed)) {
            return null;
        }

        if (isBlacklisted(row.servidor)) {
            return null;
        }

        return {
            url_embed: row.url_embed,
            servidor: normalizeServerName(
                row.servidor || "Desconocido"
            ),
            idioma: normalizeLanguage(
                row.idioma || "Desconocido"
            )
        };
    });

    const links = deduplicateLinks(
        mapped.filter(Boolean).filter(isValidLink)
    );

    return {
        success: links.length > 0,
        status: links.length > 0
            ? "links_found"
            : "no_links",
        links,
        http_code: response.status,
        content_type: contentType,
        elapsed_ms: Date.now() - started,
        parser: "supabase_rest",
        rows_received: rowsReceived,
        rows_valid: links.length,
        rows_discarded: Math.max(
            0,
            rowsReceived - links.length
        ),
        error: links.length > 0
            ? null
            : "Supabase respondió correctamente pero no hay enlaces válidos."
    };
}

/*
|--------------------------------------------------------------------------
| BETA — SCRAPER
|--------------------------------------------------------------------------
|
| SOURCE_URL debe apuntar al dominio/base del Content.
|
| IMPORTANTE:
|   `${SOURCE_URL}/embed/api.php?...`
|
| Esto evita llamar a la página HTML principal.
|--------------------------------------------------------------------------
*/

async function scrapeBeta({
    env,
    tmdbId,
    type,
    season,
    episode
}) {
    const started = Date.now();

    if (!env.SOURCE_URL) {
        return {
            success: false,
            status: "not_configured",
            links: [],
            elapsed_ms: Date.now() - started,
            error: "SOURCE_URL no está configurado."
        };
    }

    const sourceUrl = env.SOURCE_URL.replace(/\/+$/, "");

    const params = new URLSearchParams();

    params.set("action", "details");
    params.set("id", tmdbId);
    params.set("type", type);

    if (type === "tv") {
        params.set("season", String(season));
        params.set("episode", String(episode));
    }

    const endpoint =
        `${sourceUrl}/embed/api.php?${params.toString()}`;

    let response;

    try {
        response = await fetch(endpoint, {
            method: "GET",
            redirect: "follow",
            headers: {
                "Accept": "application/json,text/plain,*/*",
                "Accept-Language": "es-ES,es;q=0.9,en;q=0.8",
                "User-Agent":
                    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
                    "AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36"
            }
        });
    } catch (error) {
        return {
            success: false,
            status: "request_error",
            links: [],
            elapsed_ms: Date.now() - started,
            error: error instanceof Error
                ? error.message
                : String(error)
        };
    }

    const contentType =
        response.headers.get("content-type") || "";

    let data;
    let rawText = "";

    try {
        rawText = await response.text();
        data = JSON.parse(rawText);
    } catch (error) {
        return {
            success: false,
            status: "invalid_json",
            links: [],
            http_code: response.status,
            content_type: contentType,
            elapsed_ms: Date.now() - started,
            raw_keys: [],
            parser: null,
            error:
                response.ok
                    ? "Beta devolvió una respuesta que no es JSON."
                    : `Beta respondió HTTP ${response.status}.`
        };
    }

    if (!response.ok) {
        return {
            success: false,
            status: "http_error",
            links: [],
            http_code: response.status,
            content_type: contentType,
            elapsed_ms: Date.now() - started,
            raw_keys: objectKeys(data),
            parser: null,
            error: extractErrorMessage(data)
        };
    }

    const rawKeys = objectKeys(data);

    /*
    |--------------------------------------------------------------------------
    | PRIORIDAD 1: all_embeds
    |--------------------------------------------------------------------------
    */
    if (
        data?.all_embeds &&
        typeof data.all_embeds === "object" &&
        !Array.isArray(data.all_embeds)
    ) {
        const diagnostics = countAllEmbeds(data.all_embeds);

        const links = extractAllEmbeds(data.all_embeds)
            .filter(isValidLink);

        if (links.length > 0) {
            return {
                success: true,
                status: "links_found",
                mode: "all_embeds",
                links,
                http_code: response.status,
                content_type: contentType,
                elapsed_ms: Date.now() - started,
                parser: "all_embeds",
                raw_keys: rawKeys,
                ...diagnostics
            };
        }

        /*
        | Si all_embeds existe pero quedó vacío después de filtros,
        | seguimos probando embeds.
        */
    }

    /*
    |--------------------------------------------------------------------------
    | PRIORIDAD 2: embeds
    |--------------------------------------------------------------------------
    */
    if (
        data?.embeds &&
        typeof data.embeds === "object" &&
        !Array.isArray(data.embeds)
    ) {
        const fallbackLanguage = normalizeLanguage(
            data.language || "latino"
        );

        const diagnostics = countEmbeds(data.embeds);

        const links = extractEmbedsFallback(
            data.embeds,
            fallbackLanguage
        ).filter(isValidLink);

        if (links.length > 0) {
            return {
                success: true,
                status: "links_found",
                mode: "embeds_fallback",
                links,
                http_code: response.status,
                content_type: contentType,
                elapsed_ms: Date.now() - started,
                parser: "embeds",
                raw_keys: rawKeys,
                ...diagnostics
            };
        }

        return {
            success: false,
            status: "no_embeds",
            links: [],
            http_code: response.status,
            content_type: contentType,
            elapsed_ms: Date.now() - started,
            parser: "embeds",
            raw_keys: rawKeys,
            ...diagnostics,
            error: "Beta respondió JSON pero no quedaron URLs válidas."
        };
    }

    return {
        success: false,
        status: "no_embeds",
        links: [],
        http_code: response.status,
        content_type: contentType,
        elapsed_ms: Date.now() - started,
        parser: null,
        raw_keys: rawKeys,
        all_embeds_languages: [],
        all_embeds_urls: 0,
        all_embeds_valid: 0,
        all_embeds_discarded: 0,
        embeds_urls: 0,
        embeds_valid: 0,
        embeds_discarded: 0,
        error: "Beta devolvió JSON pero no contiene all_embeds ni embeds."
    };
}

function extractAllEmbeds(allEmbeds) {
    const result = [];

    for (const [languageKey, servers] of Object.entries(allEmbeds)) {
        if (
            !servers ||
            typeof servers !== "object" ||
            Array.isArray(servers)
        ) {
            continue;
        }

        const idioma = normalizeLanguage(languageKey);

        for (const [serverName, urls] of Object.entries(servers)) {
            if (isBlacklisted(serverName)) {
                continue;
            }

            const servidor = normalizeServerName(serverName);

            if (Array.isArray(urls)) {
                for (const url of urls) {
                    if (!isHttpUrl(url)) continue;

                    result.push({
                        url_embed: url,
                        servidor,
                        idioma
                    });
                }

                continue;
            }

            if (
                typeof urls === "string" &&
                isHttpUrl(urls)
            ) {
                result.push({
                    url_embed: urls,
                    servidor,
                    idioma
                });
            }
        }
    }

    return deduplicateLinks(result);
}

function extractEmbedsFallback(embeds, idioma) {
    const result = [];

    for (const [serverName, urls] of Object.entries(embeds)) {
        if (isBlacklisted(serverName)) {
            continue;
        }

        const servidor = normalizeServerName(serverName);

        if (Array.isArray(urls)) {
            for (const url of urls) {
                if (!isHttpUrl(url)) continue;

                result.push({
                    url_embed: url,
                    servidor,
                    idioma
                });
            }

            continue;
        }

        if (
            typeof urls === "string" &&
            isHttpUrl(urls)
        ) {
            result.push({
                url_embed: urls,
                servidor,
                idioma
            });
        }
    }

    return deduplicateLinks(result);
}

function countAllEmbeds(allEmbeds) {
    let urls = 0;
    let valid = 0;
    let discarded = 0;
    const languages = [];

    for (const [languageKey, servers] of Object.entries(allEmbeds)) {
        languages.push(languageKey);

        if (
            !servers ||
            typeof servers !== "object" ||
            Array.isArray(servers)
        ) {
            continue;
        }

        for (const [serverName, values] of Object.entries(servers)) {
            const list = Array.isArray(values)
                ? values
                : typeof values === "string"
                    ? [values]
                    : [];

            for (const url of list) {
                urls++;

                if (
                    isHttpUrl(url) &&
                    !isBlacklisted(serverName)
                ) {
                    valid++;
                } else {
                    discarded++;
                }
            }
        }
    }

    return {
        all_embeds_languages: languages,
        all_embeds_urls: urls,
        all_embeds_valid: valid,
        all_embeds_discarded: discarded
    };
}

function countEmbeds(embeds) {
    let urls = 0;
    let valid = 0;
    let discarded = 0;

    for (const [serverName, values] of Object.entries(embeds)) {
        const list = Array.isArray(values)
            ? values
            : typeof values === "string"
                ? [values]
                : [];

        for (const url of list) {
            urls++;

            if (
                isHttpUrl(url) &&
                !isBlacklisted(serverName)
            ) {
                valid++;
            } else {
                discarded++;
            }
        }
    }

    return {
        embeds_urls: urls,
        embeds_valid: valid,
        embeds_discarded: discarded
    };
}

function deduplicateLinks(links) {
    const unique = new Map();

    for (const link of links) {
        if (!isValidLink(link)) continue;

        const key = `${link.idioma}|${link.url_embed}`;

        if (!unique.has(key)) {
            unique.set(key, link);
        }
    }

    return Array.from(unique.values());
}

function isValidLink(link) {
    if (
        !link ||
        typeof link !== "object" ||
        !isHttpUrl(link.url_embed)
    ) {
        return false;
    }

    if (isBlacklisted(link.servidor)) {
        return false;
    }

    return true;
}

function normalizeLanguage(language) {
    const value = String(language || "")
        .trim()
        .toLowerCase();

    const map = {
        latino: "Latino",
        latam: "Latino",
        "español latino": "Latino",
        "espanol latino": "Latino",

        castellano: "Castellano",
        español: "Castellano",
        espanol: "Castellano",

        subtitulado: "Subtitulado",
        subtitulos: "Subtitulado",
        subtítulo: "Subtitulado",
        subtitulo: "Subtitulado",
        subtitle: "Subtitulado",
        sub: "Subtitulado"
    };

    if (map[value]) {
        return map[value];
    }

    return capitalize(value);
}

function normalizeServerName(server) {
    const value = String(server || "")
        .trim()
        .toLowerCase();

    const base = value.replace(/_\d+$/, "");

    const map = {
        abyss: "Abyss",
        streamwish: "Streamwish",
        filelions: "Filelions",
        voe: "Voe",
        doodstream: "Doodstream",
        primeload: "Primeload",
        mixdrop: "Mixdrop",
        filemoon: "Filemoon",
        powvideo: "Powvideo",
        streamplay: "Streamplay",
        streamtape: "Streamtape",
        vidmoly: "Vidmoly",
        vimeos: "Vimeos",
        ok: "OK"
    };

    if (map[base]) {
        return map[base];
    }

    return capitalize(base);
}

function isBlacklisted(server) {
    const normalized = String(server || "")
        .trim()
        .toLowerCase()
        .replace(/[\s_-]+/g, "");

    return BLACKLIST.some(blocked => {
        const normalizedBlocked = String(blocked)
            .toLowerCase()
            .replace(/[\s_-]+/g, "");

        return normalized === normalizedBlocked ||
               normalized.startsWith(normalizedBlocked);
    });
}

function buildAlphaCacheKey(
    type,
    tmdbId,
    season,
    episode
) {
    return type === "movie"
        ? `alpha:movie:${tmdbId}`
        : `alpha:tv:${tmdbId}:${season}:${episode}`;
}

function buildBetaEndpoint(
    tmdbId,
    type,
    season,
    episode
) {
    if (type === "movie") {
        return `/play/movie/${tmdbId}?fallback=beta`;
    }

    return `/play/tv/${tmdbId}/${season}/${episode}?fallback=beta`;
}

function isBetaFallback(value) {
    return [
        "beta",
        "1",
        "true",
        "yes",
        "on"
    ].includes(
        String(value || "").trim().toLowerCase()
    );
}

function isHttpUrl(value) {
    return (
        typeof value === "string" &&
        /^https?:\/\//i.test(value)
    );
}

function objectKeys(value) {
    return (
        value &&
        typeof value === "object" &&
        !Array.isArray(value)
    )
        ? Object.keys(value)
        : [];
}

function extractErrorMessage(data) {
    if (typeof data === "string") {
        return data.slice(0, 500);
    }

    if (data && typeof data === "object") {
        return (
            data.message ||
            data.error ||
            data.msg ||
            `HTTP ${data.status || "error"}`
        );
    }

    return "Respuesta HTTP no válida.";
}

function capitalize(value) {
    if (!value) {
        return "Desconocido";
    }

    return (
        value.charAt(0).toUpperCase() +
        value.slice(1)
    );
}

function isTrue(value) {
    if (!value) {
        return false;
    }

    return [
        "1",
        "true",
        "yes",
        "on",
        "force"
    ].includes(
        String(value).toLowerCase()
    );
}

/*
|--------------------------------------------------------------------------
| SSE
|--------------------------------------------------------------------------
*/

function createSSEStream() {
    let controllerRef;

    const stream = new ReadableStream({
        start(controller) {
            controllerRef = controller;
        },
        cancel() {
            controllerRef = null;
        }
    });

    const writer = {
        write(chunk) {
            if (!controllerRef) return;
            controllerRef.enqueue(
                new TextEncoder().encode(chunk)
            );
        },
        close() {
            if (!controllerRef) return;
            controllerRef.close();
            controllerRef = null;
        }
    };

    const headers = new Headers({
        ...CORS_HEADERS,
        "Content-Type": "text/event-stream; charset=UTF-8",
        "Cache-Control": "no-cache, no-store, must-revalidate",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no"
    });

    return {
        writer,
        response: new Response(stream, {
            status: 200,
            headers
        })
    };
}

async function sendSSE(writer, event, data) {
    writer.write(`event: ${event}\n`);
    writer.write(`data: ${JSON.stringify(data)}\n\n`);

    /*
    | Permite que el runtime tenga una oportunidad de enviar
    | cada evento antes de continuar con la siguiente operación.
    */
    await Promise.resolve();
}

function jsonResponse(data, status = 200) {
    const headers = new Headers();

    headers.set(
        "Content-Type",
        "application/json; charset=UTF-8"
    );

    for (const [key, value] of Object.entries(CORS_HEADERS)) {
        headers.set(key, value);
    }

    headers.set("Cache-Control", "no-store");

    return new Response(
        JSON.stringify(data, null, 2),
        {
            status,
            headers
        }
    );
}
