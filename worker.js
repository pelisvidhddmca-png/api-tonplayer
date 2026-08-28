/*
|--------------------------------------------------------------------------
| TON SCRAPER API — FINAL
|--------------------------------------------------------------------------
|
| Flujo:
|
| 1. Player Worker -> Scraper Worker
| 2. CACHE
| 3. Alpha / PelixPlay
| 4. all_embeds -> embeds
| 5. Filtrar blacklist
| 6. Si Alpha tiene <= 4 enlaces VÁLIDOS, consultar Beta
| 7. Si se usa Beta, Beta aparece primero en links
| 8. Deduplicar
| 9. event: complete
|
|--------------------------------------------------------------------------
| SECRETS
|--------------------------------------------------------------------------
|
| API_KEY
| SOURCE_URL
| SUPABASE_URL
| SUPABASE_SERVICE_KEY
|
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
            worker: "TON Scraper API"
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

    const movieMatch = pathname.match(/^\/play\/movie\/(\d+)$/);

    if (movieMatch) {
        return processContent({
            env,
            ctx,
            tmdbId: movieMatch[1],
            type: "movie",
            season: 0,
            episode: 0,
            force: isTrue(url.searchParams.get("force"))
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
            force: isTrue(url.searchParams.get("force"))
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
    force
}) {
    const cacheKey = buildCacheKey(type, tmdbId, season, episode);
    const cache = caches.default;

    if (!force) {
        const cached = await cache.match(cacheKey);

        if (cached) {
            const output = await cached.json();
            output.cache = "HIT";

            return jsonResponse(output, 200, CACHE_TTL);
        }
    }

    /*
    |--------------------------------------------------------------------------
    | ALPHA SIEMPRE SE CONSULTA PRIMERO
    |--------------------------------------------------------------------------
    */
    const alpha = await scrapeAlpha({
        env,
        tmdbId,
        type,
        season,
        episode
    });

    /*
    |--------------------------------------------------------------------------
    | IMPORTANTE:
    |
    | La decisión de llamar a Beta se toma DESPUÉS de aplicar la blacklist.
    |
    | Ejemplo:
    | Alpha devuelve 6
    | - 1 powvideo
    | - 1 streamplay
    | = 4 válidos
    |
    | Como quedan <= 4, se consulta Beta.
    |--------------------------------------------------------------------------
    */
    const alphaLinks = alpha.success
        ? deduplicateLinks(
            alpha.links.filter(isValidLink)
        )
        : [];

    const shouldUseBeta = alphaLinks.length <= 4;

    let beta = {
        success: false,
        status: "not_needed",
        links: []
    };

    if (shouldUseBeta) {
        beta = await getBeta({
            env,
            tmdbId,
            type,
            season,
            episode
        });
    }

    const betaLinks = beta.success
        ? deduplicateLinks(
            beta.links.filter(isValidLink)
        )
        : [];

    /*
    |--------------------------------------------------------------------------
    | ORDEN:
    |
    | Si Beta fue consultado:
    |
    | Beta -> Alpha
    |
    | Si Beta no fue necesario:
    |
    | Alpha
    |--------------------------------------------------------------------------
    */
    const links = shouldUseBeta
        ? mergeLinks(betaLinks, alphaLinks)
        : alphaLinks;

    if (links.length > 0) {
        const result = {
            success: true,
            status: "complete",
            event: "complete",
            source: shouldUseBeta && betaLinks.length > 0
                ? "Beta+Alpha"
                : "Alpha",
            cache: "MISS",
            tmdb_id: tmdbId,
            type,
            season,
            episode,
            alpha_found: alphaLinks.length,
            beta_found: betaLinks.length,
            beta_queried: shouldUseBeta,
            found: links.length,
            links
        };

        const response = jsonResponse(result, 200, CACHE_TTL);

        ctx.waitUntil(
            cache.put(cacheKey, response.clone())
        );

        return response;
    }

    /*
    |--------------------------------------------------------------------------
    | SIN ENLACES
    |--------------------------------------------------------------------------
    */
    const result = {
        success: false,
        status: "source_unavailable",
        event: "complete",
        source: "Alpha",
        fallback: "Beta",
        tmdb_id: tmdbId,
        type,
        season,
        episode,
        alpha_found: alphaLinks.length,
        beta_found: betaLinks.length,
        beta_queried: shouldUseBeta,
        found: 0,
        links: []
    };

    return jsonResponse(result, 200);
}

function buildCacheKey(type, tmdbId, season, episode) {
    const key = type === "movie"
        ? `movie:${tmdbId}`
        : `tv:${tmdbId}:${season}:${episode}`;

    return new Request(
        `https://ton-cache.internal/${key}`,
        { method: "GET" }
    );
}

async function scrapeAlpha({
    env,
    tmdbId,
    type,
    season,
    episode
}) {
    if (!env.SOURCE_URL) {
        console.error("SOURCE_URL no está configurada.");

        return {
            success: false,
            status: "source_not_configured",
            links: []
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

    const endpoint = `${sourceUrl}/embed/api.php?${params.toString()}`;

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
        console.error("Alpha request error:", error);

        return {
            success: false,
            status: "request_error",
            links: []
        };
    }

    if (!response.ok) {
        console.error("Alpha HTTP:", response.status);

        return {
            success: false,
            status: "http_error",
            http: response.status,
            links: []
        };
    }

    let data;

    try {
        data = await response.json();
    } catch (error) {
        console.error("Alpha JSON error:", error);

        return {
            success: false,
            status: "invalid_json",
            links: []
        };
    }

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
        const links = extractAllEmbeds(data.all_embeds)
            .filter(isValidLink);

        if (links.length > 0) {
            return {
                success: true,
                status: "links_found",
                mode: "all_embeds",
                links
            };
        }
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

        const links = extractEmbedsFallback(
            data.embeds,
            fallbackLanguage
        ).filter(isValidLink);

        if (links.length > 0) {
            return {
                success: true,
                status: "links_found",
                mode: "embeds_fallback",
                links
            };
        }
    }

    return {
        success: false,
        status: "no_embeds",
        links: []
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

function mergeLinks(betaLinks, alphaLinks) {
    const result = [];
    const seen = new Set();

    /*
    |--------------------------------------------------------------------------
    | BETA PRIMERO, ALPHA DESPUÉS
    |--------------------------------------------------------------------------
    */
    for (const link of [...betaLinks, ...alphaLinks]) {
        if (!isValidLink(link)) {
            continue;
        }

        const key = `${link.idioma}|${link.url_embed}`;

        if (seen.has(key)) {
            continue;
        }

        seen.add(key);
        result.push(link);
    }

    return result;
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

    /*
    |--------------------------------------------------------------------------
    | Esto bloquea también:
    |
    | powvideo_2
    | powvideo_8
    | streamplay_2
    | streamplay_10
    |
    | y variantes como:
    |
    | Pow Video
    | stream-play
    |--------------------------------------------------------------------------
    */
    return BLACKLIST.some(blocked => {
        const normalizedBlocked = String(blocked)
            .toLowerCase()
            .replace(/[\s_-]+/g, "");

        return normalized === normalizedBlocked ||
               normalized.startsWith(normalizedBlocked);
    });
}

/*
|--------------------------------------------------------------------------
| BETA — SUPABASE
|--------------------------------------------------------------------------
*/
async function getBeta({
    env,
    tmdbId,
    type,
    season,
    episode
}) {
    if (
        !env.SUPABASE_URL ||
        !env.SUPABASE_SERVICE_KEY
    ) {
        console.error("Supabase no está configurado.");

        return {
            success: false,
            status: "beta_not_configured",
            links: []
        };
    }

    const params = new URLSearchParams();

    params.set(
        "select",
        "tmdb_id,tipo,url_embed,servidor,idioma,temporada,episodio"
    );

    params.set("tmdb_id", `eq.${tmdbId}`);
    params.set("tipo", `eq.${type}`);

    if (type === "tv") {
        params.set("temporada", `eq.${season}`);
        params.set("episodio", `eq.${episode}`);
    } else {
        params.set("temporada", "eq.0");
        params.set("episodio", "eq.0");
    }

    const endpoint =
        `${env.SUPABASE_URL}/rest/v1/enlaces?${params.toString()}`;

    let response;

    try {
        response = await fetch(endpoint, {
            method: "GET",
            headers: {
                "apikey": env.SUPABASE_SERVICE_KEY,
                "Authorization":
                    `Bearer ${env.SUPABASE_SERVICE_KEY}`,
                "Accept": "application/json"
            }
        });
    } catch (error) {
        console.error("Beta request error:", error);

        return {
            success: false,
            status: "request_error",
            links: []
        };
    }

    if (!response.ok) {
        console.error("Beta HTTP:", response.status);

        return {
            success: false,
            status: "http_error",
            http: response.status,
            links: []
        };
    }

    let rows;

    try {
        rows = await response.json();
    } catch {
        return {
            success: false,
            status: "invalid_json",
            links: []
        };
    }

    if (!Array.isArray(rows)) {
        return {
            success: false,
            status: "invalid_response",
            links: []
        };
    }

    const links = rows
        .filter(row => row && isHttpUrl(row.url_embed))
        .filter(row => !isBlacklisted(row.servidor))
        .map(row => ({
            url_embed: row.url_embed,
            servidor: normalizeServerName(
                row.servidor || "Desconocido"
            ),
            idioma: normalizeLanguage(
                row.idioma || "Desconocido"
            )
        }))
        .filter(isValidLink);

    return {
        success: links.length > 0,
        status: links.length > 0
            ? "links_found"
            : "no_links",
        links: deduplicateLinks(links)
    };
}

function isHttpUrl(value) {
    return (
        typeof value === "string" &&
        /^https?:\/\//i.test(value)
    );
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

function jsonResponse(data, status = 200, ttl = 0) {
    const headers = new Headers();

    headers.set(
        "Content-Type",
        "application/json; charset=UTF-8"
    );

    for (const [key, value] of Object.entries(CORS_HEADERS)) {
        headers.set(key, value);
    }

    if (ttl > 0) {
        headers.set(
            "Cache-Control",
            `public, max-age=${ttl}`
        );
    } else {
        headers.set(
            "Cache-Control",
            "no-store"
        );
    }

    return new Response(
        JSON.stringify(data, null, 2),
        {
            status,
            headers
        }
    );
}
