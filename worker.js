/*
|--------------------------------------------------------------------------
| TON SCRAPER API
|--------------------------------------------------------------------------
|
| Flujo:
|
| Player
|   |
|   +--> Worker
|          |
|          +--> Alpha
|          |      |
|          |      +--> /embed/api.php
|          |      +--> all_embeds
|          |      +--> embeds fallback
|          |
|          +--> Beta
|                 |
|                 +--> KV cache 6 horas
|                 |      |
|                 |      +--> HIT
|                 |
|                 +--> Supabase
|                        |
|                        +--> guardar en KV
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
| KV
|--------------------------------------------------------------------------
|
| Binding:
|
| BETA_CACHE
|
|--------------------------------------------------------------------------
*/

const BETA_CACHE_TTL = 6 * 60 * 60;

/*
|--------------------------------------------------------------------------
| BLACKLIST
|--------------------------------------------------------------------------
*/

const BLACKLIST = [
    "servidortrinity",
    "servidormahoutokoro",
    "servidordeathstar",
    "servidorgoldmember",

    "powvideo",
    "streamplay"
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
            worker: "TON Scraper API",
            beta_cache:
                env.BETA_CACHE
                    ? "configured"
                    : "missing"
        });
    }


    /*
    |--------------------------------------------------------------------------
    | API KEY
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
            message:
                "API key inválida o ausente."
        }, 401);
    }


    /*
    |--------------------------------------------------------------------------
    | MOVIE
    |--------------------------------------------------------------------------
    |
    | /play/movie/550
    |
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
    |
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
                Number(
                    tvMatch[2]
                ),

            episode:
                Number(
                    tvMatch[3]
                ),

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
        status: "not_found",
        event: "complete",

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


    const providedKey =
        match[1].trim();


    return (
        providedKey ===
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

    /*
    |--------------------------------------------------------------------------
    | ALPHA
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


    /*
    |--------------------------------------------------------------------------
    | Si Alpha tiene resultados
    |--------------------------------------------------------------------------
    */

    if (
        alpha.success &&
        alpha.links.length > 0
    ) {

        return jsonResponse({

            success: true,

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
                alpha.links.length,

            links:
                alpha.links

        });
    }


    /*
    |--------------------------------------------------------------------------
    | BETA
    |--------------------------------------------------------------------------
    */

    const beta =
        await getBeta({
            env,
            tmdbId,
            type,
            season,
            episode,
            force
        });


    /*
    |--------------------------------------------------------------------------
    | Beta encontró enlaces
    |--------------------------------------------------------------------------
    */

    if (
        beta.success &&
        beta.links.length > 0
    ) {

        return jsonResponse({

            success: true,

            status:
                "complete",

            event:
                "complete",

            source:
                "Beta",

            cache:
                beta.cache || "MISS",

            tmdb_id:
                tmdbId,

            type,

            season,

            episode,

            found:
                beta.links.length,

            links:
                beta.links

        });
    }


    /*
    |--------------------------------------------------------------------------
    | NADA
    |--------------------------------------------------------------------------
    */

    return jsonResponse({

        success: false,

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

        alpha_found:
            alpha.links
                ? alpha.links.length
                : 0,

        beta_found:
            beta.links
                ? beta.links.length
                : 0,

        found:
            0,

        links:
            [],

        alpha_error:
            alpha.error || null,

        beta_error:
            beta.error || null,

        message:
            "Alpha y Beta no devolvieron servidores válidos."

    }, 200);
}


/*
|--------------------------------------------------------------------------
| CACHE KEY BETA
|--------------------------------------------------------------------------
*/

function buildBetaCacheKey(
    type,
    tmdbId,
    season,
    episode
) {

    if (type === "movie") {

        return `beta:movie:${tmdbId}`;
    }


    return `beta:tv:${tmdbId}:${season}:${episode}`;
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
            links: [],
            error:
                "SOURCE_URL no está configurada."
        };
    }


    /*
    |--------------------------------------------------------------------------
    | IMPORTANTE
    |
    | SOURCE_URL es el dominio/base.
    |
    | El endpoint real es:
    |
    | /embed/api.php
    |--------------------------------------------------------------------------
    */

    const sourceUrl =
        env.SOURCE_URL
            .replace(
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
        `${sourceUrl}/embed/api.php?${params.toString()}`;


    let response;


    try {

        response =
            await fetch(
                endpoint,
                {
                    method: "GET",

                    redirect: "follow",

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

            links: [],

            error:
                error instanceof Error
                    ? error.message
                    : String(error)
        };
    }


    /*
    |--------------------------------------------------------------------------
    | HTTP
    |--------------------------------------------------------------------------
    */

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

            links: [],

            error:
                `Alpha respondió HTTP ${response.status}`
        };
    }


    /*
    |--------------------------------------------------------------------------
    | JSON
    |--------------------------------------------------------------------------
    */

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

            links: [],

            error:
                "Alpha devolvió una respuesta que no es JSON."
        };
    }


    /*
    |--------------------------------------------------------------------------
    | PRIORIDAD 1
    |
    | all_embeds
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


        if (links.length > 0) {

            return {

                success: true,

                status:
                    "links_found",

                mode:
                    "all_embeds",

                links
            };
        }
    }


    /*
    |--------------------------------------------------------------------------
    | PRIORIDAD 2
    |
    | embeds
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

        const fallbackLanguage =
            normalizeLanguage(
                data.language ||
                "latino"
            );


        const links =
            extractEmbedsFallback(
                data.embeds,
                fallbackLanguage
            );


        if (links.length > 0) {

            return {

                success: true,

                status:
                    "links_found",

                mode:
                    "embeds_fallback",

                links
            };
        }
    }


    /*
    |--------------------------------------------------------------------------
    | NADA
    |--------------------------------------------------------------------------
    */

    return {

        success: false,

        status:
            "no_embeds",

        links: [],

        error:
            "Alpha no devolvió enlaces válidos."
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


            /*
            |--------------------------------------------------------------------------
            | ARRAY
            |--------------------------------------------------------------------------
            */

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


                continue;
            }


            /*
            |--------------------------------------------------------------------------
            | STRING
            |--------------------------------------------------------------------------
            */

            if (
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


    return deduplicateLinks(
        result
    );
}


/*
|--------------------------------------------------------------------------
| FALLBACK EMBEDS
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


            continue;
        }


        if (
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


    return deduplicateLinks(
        result
    );
}


/*
|--------------------------------------------------------------------------
| BETA — SUPABASE + KV
|--------------------------------------------------------------------------
*/

async function getBeta({
    env,
    tmdbId,
    type,
    season,
    episode,
    force
}) {

    const cacheKey =
        buildBetaCacheKey(
            type,
            tmdbId,
            season,
            episode
        );


    /*
    |--------------------------------------------------------------------------
    | CACHE HIT
    |--------------------------------------------------------------------------
    */

    if (
        env.BETA_CACHE &&
        !force
    ) {

        try {

            const cached =
                await env.BETA_CACHE.get(
                    cacheKey,
                    {
                        type:
                            "json"
                    }
                );


            if (
                Array.isArray(
                    cached
                ) &&
                cached.length > 0
            ) {

                return {

                    success: true,

                    status:
                        "beta_cache_hit",

                    cache:
                        "HIT",

                    links:
                        cached
                };
            }

        } catch (error) {

            console.error(
                "Beta KV read error:",
                error
            );
        }
    }


    /*
    |--------------------------------------------------------------------------
    | CACHE MISS
    |--------------------------------------------------------------------------
    */

    /*
    | El Worker no convierte esto
    | en un evento SSE por sí mismo.
    |
    | El estado queda disponible para
    | el resultado de diagnóstico.
    |--------------------------------------------------------------------------
    */

    const beta =
        await querySupabaseBeta({
            env,
            tmdbId,
            type,
            season,
            episode
        });


    /*
    |--------------------------------------------------------------------------
    | Si encontró enlaces
    |--------------------------------------------------------------------------
    */

    if (
        beta.success &&
        beta.links.length > 0
    ) {

        /*
        |--------------------------------------------------------------------------
        | Guardar en KV durante 6 horas
        |--------------------------------------------------------------------------
        */

        if (
            env.BETA_CACHE
        ) {

            try {

                await env.BETA_CACHE.put(
                    cacheKey,
                    JSON.stringify(
                        beta.links
                    ),
                    {
                        expirationTtl:
                            BETA_CACHE_TTL
                    }
                );

            } catch (error) {

                console.error(
                    "Beta KV write error:",
                    error
                );
            }
        }


        return {

            success: true,

            status:
                "links_found",

            cache:
                "MISS",

            cache_status:
                "beta_cache_miss",

            links:
                beta.links
        };
    }


    /*
    |--------------------------------------------------------------------------
    | No guardar resultados vacíos
    |--------------------------------------------------------------------------
    */

    return {

        ...beta,

        cache:
            "MISS",

        cache_status:
            "beta_cache_miss"
    };
}


/*
|--------------------------------------------------------------------------
| CONSULTAR SUPABASE
|--------------------------------------------------------------------------
*/

async function querySupabaseBeta({
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

            links: [],

            error:
                "SUPABASE_URL o SUPABASE_SERVICE_KEY no está configurado."
        };
    }


    const baseUrl =
        env.SUPABASE_URL
            .replace(
                /\/+$/,
                ""
            );


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
        `${baseUrl}/rest/v1/enlaces?${params.toString()}`;


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

            links: [],

            error:
                error instanceof Error
                    ? error.message
                    : String(error)
        };
    }


    /*
    |--------------------------------------------------------------------------
    | HTTP
    |--------------------------------------------------------------------------
    */

    if (!response.ok) {

        let detail = "";

        try {

            detail =
                await response.text();

        } catch {
            detail = "";
        }


        console.error(
            "Beta HTTP:",
            response.status,
            detail
        );


        return {

            success: false,

            status:
                "http_error",

            http:
                response.status,

            links: [],

            error:
                `Beta respondió HTTP ${response.status}`,

            detail
        };
    }


    /*
    |--------------------------------------------------------------------------
    | JSON
    |--------------------------------------------------------------------------
    */

    let rows;


    try {

        rows =
            await response.json();

    } catch (error) {

        return {

            success: false,

            status:
                "invalid_json",

            links: [],

            error:
                "Beta devolvió una respuesta no JSON."
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

            links: [],

            error:
                "Beta no devolvió un array."
        };
    }


    /*
    |--------------------------------------------------------------------------
    | PROCESAR ENLACES
    |--------------------------------------------------------------------------
    */

    const links =
        rows

            .filter(
                row =>
                    row &&
                    typeof row.url_embed ===
                        "string" &&
                    isHttpUrl(
                        row.url_embed
                    )
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


    const uniqueLinks =
        deduplicateLinks(
            links
        );


    return {

        success:
            uniqueLinks.length > 0,

        status:
            uniqueLinks.length > 0
                ? "links_found"
                : "no_links",

        links:
            uniqueLinks
    };
}


/*
|--------------------------------------------------------------------------
| DEDUPLICAR
|--------------------------------------------------------------------------
*/

function deduplicateLinks(
    links
) {

    const unique =
        new Map();


    for (
        const link
        of links
    ) {

        const key =
            `${link.idioma}|${link.url_embed}`;


        if (
            !unique.has(
                key
            )
        ) {

            unique.set(
                key,
                link
            );
        }
    }


    return Array.from(
        unique.values()
    );
}


/*
|--------------------------------------------------------------------------
| NORMALIZAR IDIOMAS
|--------------------------------------------------------------------------
*/

function normalizeLanguage(
    language
) {

    const value =
        String(
            language ||
            ""
        )
            .trim()
            .toLowerCase();


    const map = {

        latino:
            "Latino",

        latam:
            "Latino",

        latin:
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
            server ||
            ""
        )
            .trim()
            .toLowerCase();


    /*
    |--------------------------------------------------------------------------
    | Elimina sufijos:
    |
    | streamwish_2
    | filelions_3
    | powvideo_8
    |--------------------------------------------------------------------------
    */

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

        vimeos:
            "Vimeos",

        ok:
            "OK",

        abyss:
            "Abyss"
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
| BLACKLIST
|--------------------------------------------------------------------------
*/

function isBlacklisted(
    server
) {

    const normalized =
        String(
            server ||
            ""
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
| URL HTTP
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
| CAPITALIZAR
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
| JSON RESPONSE
|--------------------------------------------------------------------------
*/

function jsonResponse(
    data,
    status = 200
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


    /*
    |--------------------------------------------------------------------------
    | No cachear la respuesta del Worker.
    |
    | La caché de Beta vive en KV.
    |--------------------------------------------------------------------------
    */

    headers.set(
        "Cache-Control",
        "no-store, no-cache, must-revalidate"
    );


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