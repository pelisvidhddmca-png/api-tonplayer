/*
|--------------------------------------------------------------------------
| TON SCRAPER API
|--------------------------------------------------------------------------
|
| FLUJO:
|
| 1. CACHE
|       ↓
| 2. ALPHA (PelixPlay)
|       ↓
| 3. Contar enlaces VÁLIDOS
|       ↓
|    ┌─────────────────────────────┐
|    │ Alpha >= 5                  │
|    │ → devolver solamente Alpha  │
|    └─────────────────────────────┘
|
|    ┌─────────────────────────────┐
|    │ Alpha <= 4                  │
|    │ → consultar Beta            │
|    │ → Beta primero              │
|    │ → Alpha después             │
|    └─────────────────────────────┘
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

// Si Alpha devuelve 4 o menos,
// se utiliza Beta como refuerzo.
const ALPHA_THRESHOLD = 4;


/*
|--------------------------------------------------------------------------
| BLACKLIST
|--------------------------------------------------------------------------
*/

const BLACKLIST = [
    "servidortrinity",
    "servidormahoutokoro",
    "servidordeathstar",
    "servidorgoldmember"
];


/*
|--------------------------------------------------------------------------
| CORS
|--------------------------------------------------------------------------
*/

const CORS_HEADERS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization"
};


/*
|--------------------------------------------------------------------------
| WORKER
|--------------------------------------------------------------------------
*/

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

            return await router(
                request,
                env,
                ctx
            );

        } catch (error) {

            console.error(
                "Worker error:",
                error
            );


            return jsonResponse({
                success: false,
                status: "worker_error",
                event: "complete",
                message:
                    error instanceof Error
                        ? error.message
                        : String(error)
            }, 500);
        }
    }
};


/*
|--------------------------------------------------------------------------
| ROUTER
|--------------------------------------------------------------------------
*/

async function router(
    request,
    env,
    ctx
) {

    const url =
        new URL(request.url);

    const pathname =
        url.pathname.replace(
            /\/+$/,
            ""
        );


    /*
    |--------------------------------------------------------------------------
    | HEALTH
    |--------------------------------------------------------------------------
    */

    if (pathname === "/health") {

        return jsonResponse({
            success: true,
            status: "online",
            event: "complete",
            worker: "TON Scraper API"
        });
    }


    /*
    |--------------------------------------------------------------------------
    | AUTH
    |--------------------------------------------------------------------------
    */

    if (!validateApiKey(
        request,
        env
    )) {

        return jsonResponse({
            success: false,
            status: "unauthorized",
            event: "complete",
            message: "API key inválida o ausente."
        }, 401);
    }


    /*
    |--------------------------------------------------------------------------
    | MOVIE
    |--------------------------------------------------------------------------
    |
    | /play/movie/550
    |--------------------------------------------------------------------------
    */

    const movieMatch =
        pathname.match(
            /^\/play\/movie\/(\d+)$/
        );


    if (movieMatch) {

        return processContent({

            env,
            ctx,

            tmdbId:
                movieMatch[1],

            type:
                "movie",

            season:
                0,

            episode:
                0,

            force:
                isTrue(
                    url.searchParams.get(
                        "force"
                    )
                )
        });
    }


    /*
    |--------------------------------------------------------------------------
    | TV
    |--------------------------------------------------------------------------
    |
    | /play/tv/1399/1/1
    |--------------------------------------------------------------------------
    */

    const tvMatch =
        pathname.match(
            /^\/play\/tv\/(\d+)\/(\d+)\/(\d+)$/
        );


    if (tvMatch) {

        return processContent({

            env,
            ctx,

            tmdbId:
                tvMatch[1],

            type:
                "tv",

            season:
                Number(tvMatch[2]),

            episode:
                Number(tvMatch[3]),

            force:
                isTrue(
                    url.searchParams.get(
                        "force"
                    )
                )
        });
    }


    /*
    |--------------------------------------------------------------------------
    | 404
    |--------------------------------------------------------------------------
    */

    return jsonResponse({

        success: false,

        status:
            "not_found",

        event:
            "complete",

        endpoints: {

            health:
                "/health",

            movie:
                "/play/movie/ID",

            tv:
                "/play/tv/ID/SEASON/EPISODE"
        }

    }, 404);
}


/*
|--------------------------------------------------------------------------
| API KEY
|--------------------------------------------------------------------------
*/

function validateApiKey(
    request,
    env
) {

    if (!env.API_KEY) {

        console.error(
            "API_KEY no está configurada."
        );

        return false;
    }


    const authorization =
        request.headers.get(
            "Authorization"
        );


    if (!authorization) {

        return false;
    }


    const match =
        authorization.match(
            /^Bearer\s+(.+)$/i
        );


    if (!match) {

        return false;
    }


    return (
        match[1].trim() ===
        env.API_KEY
    );
}


/*
|--------------------------------------------------------------------------
| PROCESAR CONTENIDO
|--------------------------------------------------------------------------
*/

async function processContent({
    env,
    ctx,
    tmdbId,
    type,
    season,
    episode,
    force
}) {

    const cacheKey =
        buildCacheKey(
            type,
            tmdbId,
            season,
            episode
        );


    const cache =
        caches.default;


    /*
    |--------------------------------------------------------------------------
    | CACHE
    |--------------------------------------------------------------------------
    */

    if (!force) {

        const cached =
            await cache.match(
                cacheKey
            );


        if (cached) {

            const output =
                await cached.json();


            output.cache =
                "HIT";


            return jsonResponse(
                output,
                200,
                CACHE_TTL
            );
        }
    }


    /*
    |--------------------------------------------------------------------------
    | ALPHA — SIEMPRE PRIMERO
    |--------------------------------------------------------------------------
    */

    const alpha =
        await scrapeAlpha({

            env,

            tmdbId,

            type,

            season,

            episode
        });


    const alphaLinks =
        cleanLinks(
            alpha.links || []
        );


    /*
    |--------------------------------------------------------------------------
    | ALPHA TIENE SUFICIENTES ENLACES
    |--------------------------------------------------------------------------
    */

    if (
        alphaLinks.length >
        ALPHA_THRESHOLD
    ) {

        const result = {

            success:
                true,

            status:
                "complete",

            event:
                "complete",

            source:
                "Alpha",

            cache:
                "MISS",

            tmdb_id:
                tmdbId,

            type,

            season,

            episode,

            found:
                alphaLinks.length,

            alpha_found:
                alphaLinks.length,

            beta_found:
                0,

            links:
                alphaLinks
        };


        const response =
            jsonResponse(
                result,
                200,
                CACHE_TTL
            );


        ctx.waitUntil(
            cache.put(
                cacheKey,
                response.clone()
            )
        );


        return response;
    }


    /*
    |--------------------------------------------------------------------------
    | ALPHA TIENE 0-4
    |
    | CONSULTAMOS BETA
    |--------------------------------------------------------------------------
    */

    const beta =
        await getBeta({

            env,

            tmdbId,

            type,

            season,

            episode
        });


    const betaLinks =
        cleanLinks(
            beta.links || []
        );


    /*
    |--------------------------------------------------------------------------
    | ORDEN FINAL
    |--------------------------------------------------------------------------
    |
    | IMPORTANTE:
    |
    | Beta primero.
    | Alpha después.
    |
    */

    const combined =
        mergeBetaFirst(
            betaLinks,
            alphaLinks
        );


    /*
    |--------------------------------------------------------------------------
    | RESULTADO
    |--------------------------------------------------------------------------
    */

    if (
        combined.length > 0
    ) {

        let source;


        if (
            betaLinks.length > 0 &&
            alphaLinks.length > 0
        ) {

            source =
                "Beta+Alpha";

        } else if (
            betaLinks.length > 0
        ) {

            source =
                "Beta";

        } else {

            source =
                "Alpha";
        }


        const result = {

            success:
                true,

            status:
                "complete",

            event:
                "complete",

            source,

            cache:
                "MISS",

            tmdb_id:
                tmdbId,

            type,

            season,

            episode,

            found:
                combined.length,

            alpha_found:
                alphaLinks.length,

            beta_found:
                betaLinks.length,

            links:
                combined
        };


        const response =
            jsonResponse(
                result,
                200,
                CACHE_TTL
            );


        ctx.waitUntil(
            cache.put(
                cacheKey,
                response.clone()
            )
        );


        return response;
    }


    /*
    |--------------------------------------------------------------------------
    | NINGUNA FUENTE
    |--------------------------------------------------------------------------
    */

    return jsonResponse({

        success:
            false,

        status:
            "source_unavailable",

        event:
            "complete",

        source:
            "Alpha",

        fallback:
            "Beta",

        tmdb_id:
            tmdbId,

        type,

        season,

        episode,

        found:
            0,

        alpha_found:
            0,

        beta_found:
            0,

        links:
            []

    }, 200);
}


/*
|--------------------------------------------------------------------------
| ALPHA
|--------------------------------------------------------------------------
*/

async function scrapeAlpha({
    env,
    tmdbId,
    type,
    season,
    episode
}) {

    if (!env.SOURCE_URL) {

        console.error(
            "SOURCE_URL no está configurada."
        );


        return {
            success: false,
            status:
                "source_not_configured",
            links: []
        };
    }


    const sourceUrl =
        env.SOURCE_URL.replace(
            /\/+$/,
            ""
        );


    const params =
        new URLSearchParams();


    params.set(
        "action",
        "details"
    );


    params.set(
        "id",
        tmdbId
    );


    params.set(
        "type",
        type
    );


    if (
        type === "tv"
    ) {

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
        `${sourceUrl}/embed/api.php?${params.toString()}`;


    let response;


    try {

        response =
            await fetch(
                endpoint,
                {

                    method:
                        "GET",

                    redirect:
                        "follow",

                    headers: {

                        "Accept":
                            "application/json,text/plain,*/*",

                        "Accept-Language":
                            "es-ES,es;q=0.9,en;q=0.8",

                        "User-Agent":
                            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36"
                    }
                }
            );

    } catch (error) {

        console.error(
            "Alpha request error:",
            error
        );


        return {
            success: false,
            status:
                "request_error",
            links: []
        };
    }


    if (!response.ok) {

        console.error(
            "Alpha HTTP:",
            response.status
        );


        return {
            success: false,
            status:
                "http_error",
            http:
                response.status,
            links: []
        };
    }


    let data;


    try {

        data =
            await response.json();

    } catch (error) {

        console.error(
            "Alpha JSON error:",
            error
        );


        return {
            success: false,
            status:
                "invalid_json",
            links: []
        };
    }


    /*
    |--------------------------------------------------------------------------
    | ALL_EMBEDS — PRIORIDAD
    |--------------------------------------------------------------------------
    */

    if (
        data?.all_embeds &&
        typeof data.all_embeds ===
            "object" &&
        !Array.isArray(
            data.all_embeds
        )
    ) {

        const links =
            extractAllEmbeds(
                data.all_embeds
            );


        const cleaned =
            cleanLinks(
                links
            );


        if (
            cleaned.length > 0
        ) {

            return {

                success:
                    true,

                status:
                    "links_found",

                mode:
                    "all_embeds",

                links:
                    cleaned
            };
        }
    }


    /*
    |--------------------------------------------------------------------------
    | EMBEDS — FALLBACK
    |--------------------------------------------------------------------------
    */

    if (
        data?.embeds &&
        typeof data.embeds ===
            "object" &&
        !Array.isArray(
            data.embeds
        )
    ) {

        const language =
            normalizeLanguage(
                data.language ||
                "latino"
            );


        const links =
            extractEmbedsFallback(
                data.embeds,
                language
            );


        const cleaned =
            cleanLinks(
                links
            );


        if (
            cleaned.length > 0
        ) {

            return {

                success:
                    true,

                status:
                    "links_found",

                mode:
                    "embeds_fallback",

                links:
                    cleaned
            };
        }
    }


    return {

        success:
            false,

        status:
            "no_embeds",

        links:
            []
    };
}


/*
|--------------------------------------------------------------------------
| EXTRAER ALL_EMBEDS
|--------------------------------------------------------------------------
*/

function extractAllEmbeds(
    allEmbeds
) {

    const result = [];


    for (
        const [
            languageKey,
            servers
        ]
        of Object.entries(
            allEmbeds
        )
    ) {

        if (
            !servers ||
            typeof servers !==
                "object" ||
            Array.isArray(
                servers
            )
        ) {

            continue;
        }


        const idioma =
            normalizeLanguage(
                languageKey
            );


        for (
            const [
                serverName,
                urls
            ]
            of Object.entries(
                servers
            )
        ) {

            if (
                isBlacklisted(
                    serverName
                )
            ) {

                continue;
            }


            const servidor =
                normalizeServerName(
                    serverName
                );


            if (
                Array.isArray(
                    urls
                )
            ) {

                for (
                    const url
                    of urls
                ) {

                    if (
                        typeof url !==
                        "string"
                    ) {

                        continue;
                    }


                    if (
                        !isHttpUrl(
                            url
                        )
                    ) {

                        continue;
                    }


                    result.push({

                        url_embed:
                            url,

                        servidor,

                        idioma
                    });
                }

            } else if (
                typeof urls ===
                    "string" &&
                isHttpUrl(
                    urls
                )
            ) {

                result.push({

                    url_embed:
                        urls,

                    servidor,

                    idioma
                });
            }
        }
    }


    return result;
}


/*
|--------------------------------------------------------------------------
| EXTRAER EMBEDS FALLBACK
|--------------------------------------------------------------------------
*/

function extractEmbedsFallback(
    embeds,
    idioma
) {

    const result = [];


    for (
        const [
            serverName,
            urls
        ]
        of Object.entries(
            embeds
        )
    ) {

        if (
            isBlacklisted(
                serverName
            )
        ) {

            continue;
        }


        const servidor =
            normalizeServerName(
                serverName
            );


        if (
            Array.isArray(
                urls
            )
        ) {

            for (
                const url
                of urls
            ) {

                if (
                    typeof url !==
                    "string" ||
                    !isHttpUrl(
                        url
                    )
                ) {

                    continue;
                }


                result.push({

                    url_embed:
                        url,

                    servidor,

                    idioma
                });
            }

        } else if (
            typeof urls ===
                "string" &&
            isHttpUrl(
                urls
            )
        ) {

            result.push({

                url_embed:
                    urls,

                servidor,

                idioma
            });
        }
    }


    return result;
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

        console.error(
            "Supabase no está configurado."
        );


        return {
            success: false,
            status:
                "beta_not_configured",
            links: []
        };
    }


    const params =
        new URLSearchParams();


    params.set(
        "select",
        "tmdb_id,tipo,url_embed,servidor,idioma,temporada,episodio"
    );


    params.set(
        "tmdb_id",
        `eq.${tmdbId}`
    );


    params.set(
        "tipo",
        `eq.${type}`
    );


    if (
        type === "tv"
    ) {

        params.set(
            "temporada",
            `eq.${season}`
        );

        params.set(
            "episodio",
            `eq.${episode}`
        );

    } else {

        params.set(
            "temporada",
            "eq.0"
        );

        params.set(
            "episodio",
            "eq.0"
        );
    }


    const endpoint =
        `${env.SUPABASE_URL}/rest/v1/enlaces?${params.toString()}`;


    let response;


    try {

        response =
            await fetch(
                endpoint,
                {

                    method:
                        "GET",

                    headers: {

                        "apikey":
                            env.SUPABASE_SERVICE_KEY,

                        "Authorization":
                            `Bearer ${env.SUPABASE_SERVICE_KEY}`,

                        "Accept":
                            "application/json"
                    }
                }
            );

    } catch (error) {

        console.error(
            "Beta request error:",
            error
        );


        return {
            success: false,
            status:
                "request_error",
            links: []
        };
    }


    if (!response.ok) {

        console.error(
            "Beta HTTP:",
            response.status
        );


        return {
            success: false,
            status:
                "http_error",
            http:
                response.status,
            links: []
        };
    }


    let rows;


    try {

        rows =
            await response.json();

    } catch {

        return {
            success: false,
            status:
                "invalid_json",
            links: []
        };
    }


    if (
        !Array.isArray(
            rows
        )
    ) {

        return {
            success: false,
            status:
                "invalid_response",
            links: []
        };
    }


    const links =
        rows

            .filter(
                row =>
                    row &&
                    row.url_embed
            )

            .filter(
                row =>
                    !isBlacklisted(
                        row.servidor
                    )
            )

            .map(
                row => ({

                    url_embed:
                        row.url_embed,

                    servidor:
                        normalizeServerName(
                            row.servidor ||
                            "Desconocido"
                        ),

                    idioma:
                        normalizeLanguage(
                            row.idioma ||
                            "Desconocido"
                        )
                })
            );


    return {

        success:
            links.length > 0,

        status:
            links.length > 0
                ? "links_found"
                : "no_links",

        links:
            links
    };
}


/*
|--------------------------------------------------------------------------
| BETA PRIMERO + ALPHA DESPUÉS
|--------------------------------------------------------------------------
*/

function mergeBetaFirst(
    betaLinks,
    alphaLinks
) {

    const result = [];

    const seen =
        new Set();


    /*
    |--------------------------------------------------------------------------
    | PRIMERO BETA
    |--------------------------------------------------------------------------
    */

    for (
        const link
        of betaLinks
    ) {

        addUniqueLink(
            result,
            seen,
            link
        );
    }


    /*
    |--------------------------------------------------------------------------
    | DESPUÉS ALPHA
    |--------------------------------------------------------------------------
    */

    for (
        const link
        of alphaLinks
    ) {

        addUniqueLink(
            result,
            seen,
            link
        );
    }


    return result;
}


/*
|--------------------------------------------------------------------------
| LIMPIAR LINKS
|--------------------------------------------------------------------------
*/

function cleanLinks(
    links
) {

    const result = [];

    const seen =
        new Set();


    for (
        const link
        of links
    ) {

        if (
            !link ||
            !link.url_embed
        ) {

            continue;
        }


        if (
            !isHttpUrl(
                link.url_embed
            )
        ) {

            continue;
        }


        if (
            isBlacklisted(
                link.servidor
            )
        ) {

            continue;
        }


        const cleaned = {

            url_embed:
                String(
                    link.url_embed
                ).trim(),

            servidor:
                normalizeServerName(
                    link.servidor ||
                    "Desconocido"
                ),

            idioma:
                normalizeLanguage(
                    link.idioma ||
                    "Desconocido"
                )
        };


        const key =
            cleaned.url_embed
                .toLowerCase();


        if (
            seen.has(key)
        ) {

            continue;
        }


        seen.add(key);


        result.push(
            cleaned
        );
    }


    return result;
}


/*
|--------------------------------------------------------------------------
| AGREGAR LINK ÚNICO
|--------------------------------------------------------------------------
*/

function addUniqueLink(
    result,
    seen,
    link
) {

    if (
        !link ||
        !link.url_embed
    ) {

        return;
    }


    if (
        isBlacklisted(
            link.servidor
        )
    ) {

        return;
    }


    const url =
        String(
            link.url_embed
        ).trim();


    if (
        !isHttpUrl(
            url
        )
    ) {

        return;
    }


    const key =
        url.toLowerCase();


    if (
        seen.has(key)
    ) {

        return;
    }


    seen.add(key);


    result.push({

        url_embed:
            url,

        servidor:
            normalizeServerName(
                link.servidor ||
                "Desconocido"
            ),

        idioma:
            normalizeLanguage(
                link.idioma ||
                "Desconocido"
            )
    });
}


/*
|--------------------------------------------------------------------------
| BLACKLIST
|--------------------------------------------------------------------------
*/

function isBlacklisted(
    server
) {

    const normalized =
        String(
            server || ""
        )
        .toLowerCase()
        .replace(
            /[\s_-]+/g,
            ""
        );


    return BLACKLIST.some(
        blocked =>
            normalized.includes(
                blocked
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


    const map = {

        latino:
            "Latino",

        latam:
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
            "Subtitulado"
    };


    if (
        map[value]
    ) {

        return map[value];
    }


    return capitalize(
        value
    );
}


/*
|--------------------------------------------------------------------------
| NORMALIZAR SERVIDOR
|--------------------------------------------------------------------------
*/

function normalizeServerName(
    server
) {

    const value =
        String(
            server || ""
        )
        .trim()
        .toLowerCase();


    const base =
        value.replace(
            /_\d+$/,
            ""
        );


    const map = {

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

        ok:
            "OK"
    };


    if (
        map[base]
    ) {

        return map[base];
    }


    return capitalize(
        base
    );
}


/*
|--------------------------------------------------------------------------
| HTTP URL
|--------------------------------------------------------------------------
*/

function isHttpUrl(
    value
) {

    return (
        typeof value ===
            "string" &&
        /^https?:\/\//i.test(
            value
        )
    );
}


/*
|--------------------------------------------------------------------------
| CACHE KEY
|--------------------------------------------------------------------------
*/

function buildCacheKey(
    type,
    tmdbId,
    season,
    episode
) {

    let key;


    if (
        type === "movie"
    ) {

        key =
            `movie:${tmdbId}`;

    } else {

        key =
            `tv:${tmdbId}:${season}:${episode}`;
    }


    return new Request(
        `https://ton-cache.internal/${key}`,
        {
            method:
                "GET"
        }
    );
}


/*
|--------------------------------------------------------------------------
| BOOLEAN
|--------------------------------------------------------------------------
*/

function isTrue(
    value
) {

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
        String(value)
            .toLowerCase()
    );
}


/*
|--------------------------------------------------------------------------
| CAPITALIZE
|--------------------------------------------------------------------------
*/

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


/*
|--------------------------------------------------------------------------
| JSON RESPONSE
|--------------------------------------------------------------------------
*/

function jsonResponse(
    data,
    status = 200,
    ttl = 0
) {

    const headers =
        new Headers();


    headers.set(
        "Content-Type",
        "application/json; charset=UTF-8"
    );


    for (
        const [
            key,
            value
        ]
        of Object.entries(
            CORS_HEADERS
        )
    ) {

        headers.set(
            key,
            value
        );
    }


    if (
        ttl > 0
    ) {

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
        JSON.stringify(
            data,
            null,
            2
        ),
        {
            status,
            headers
        }
    );
}