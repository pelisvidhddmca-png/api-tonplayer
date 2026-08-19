/*
|--------------------------------------------------------------------------
| TON SCRAPER API WORKER — FINAL
|--------------------------------------------------------------------------
|
| Flujo:
|
| Player Worker
|      │
|      │ HTTPS + Authorization: Bearer API_KEY
|      ▼
| Scraper Worker
|      │
|      ├── Cache HIT ───────────────► devuelve enlaces
|      │
|      └── Cache MISS
|             │
|             ▼
|           Alpha
|       PelixPlay API
|             │
|        all_embeds
|             │
|       ┌─────┼──────────┐
|       ▼     ▼          ▼
|     Latino Castellano Subtitulado
|             │
|             ▼
|         Blacklist
|             │
|             ▼
|           Cache
|             │
|             ▼
|          respuesta
|
| Si Alpha no encuentra enlaces:
|
| Alpha → Beta (Supabase) → Cache → respuesta
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


/*
|--------------------------------------------------------------------------
| SERVIDORES BLOQUEADOS
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
    |
    | No requiere API key.
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
    | AUTENTICACIÓN
    |--------------------------------------------------------------------------
    */

    if (!validateApiKey(request, env)) {

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


    if (
        alpha.success &&
        alpha.links.length > 0
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
                alpha.links.length,

            links:
                alpha.links
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
    | BETA
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


    if (
        beta.success &&
        beta.links.length > 0
    ) {

        const result = {

            success:
                true,

            status:
                "complete",

            event:
                "complete",

            source:
                "Beta",

            cache:
                "MISS",

            tmdb_id:
                tmdbId,

            type,

            season,

            episode,

            found:
                beta.links.length,

            links:
                beta.links
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
    | SIN RESULTADOS
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

        found:
            0,

        links:
            []
    }, 404);
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


    if (type === "movie") {

        key =
            `movie:${tmdbId}`;

    } else {

        key =
            `tv:${tmdbId}:${season}:${episode}`;
    }


    return new Request(
        `https://ton-cache.internal/${key}`,
        {
            method: "GET"
        }
    );
}


/*
|--------------------------------------------------------------------------
| ALPHA — PELIXPLAY
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
    | ALL_EMBEDS
    |--------------------------------------------------------------------------
    |
    | Importante:
    | NO utilizamos solamente "embeds".
    |
    | "all_embeds" contiene:
    |
    | latino
    | castellano
    | subtitulado
    | idioma36
    |--------------------------------------------------------------------------
    */

    const links =
        extractAllEmbeds(
            data
        );


    const filtered =
        links.filter(
            link =>
                !isBlacklisted(
                    link.servidor
                )
        );


    return {

        success:
            filtered.length > 0,

        status:
            filtered.length > 0
                ? "links_found"
                : "no_embeds",

        links:
            filtered
    };
}


/*
|--------------------------------------------------------------------------
| EXTRAER ALL_EMBEDS
|--------------------------------------------------------------------------
*/

function extractAllEmbeds(
    data
) {

    const result = [];


    const allEmbeds =
        data?.all_embeds;


    if (
        !allEmbeds ||
        typeof allEmbeds !== "object" ||
        Array.isArray(allEmbeds)
    ) {

        return [];
    }


    /*
    |--------------------------------------------------------------------------
    | IDIOMAS
    |--------------------------------------------------------------------------
    */

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
            typeof servers !== "object" ||
            Array.isArray(servers)
        ) {
            continue;
        }


        const idioma =
            normalizeLanguage(
                languageKey
            );


        /*
        |--------------------------------------------------------------------------
        | SERVIDORES
        |--------------------------------------------------------------------------
        */

        for (
            const [
                serverName,
                urls
            ]
            of Object.entries(
                servers
            )
        ) {

            /*
            |--------------------------------------------------------------------------
            | BLACKLIST
            |--------------------------------------------------------------------------
            */

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
            | ARRAY DE URLS
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


                continue;
            }


            /*
            |--------------------------------------------------------------------------
            | URL ÚNICA
            |--------------------------------------------------------------------------
            */

            if (
                typeof urls ===
                    "string" &&
                isHttpUrl(urls)
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


    /*
    |--------------------------------------------------------------------------
    | DEDUPLICAR
    |--------------------------------------------------------------------------
    |
    | Mismo idioma + misma URL = una sola entrada.
    |--------------------------------------------------------------------------
    */

    const unique =
        new Map();


    for (
        const link
        of result
    ) {

        const key =
            `${link.idioma}|${link.url_embed}`;


        if (
            !unique.has(key)
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
        String(language)
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
| NORMALIZAR SERVIDORES
|--------------------------------------------------------------------------
*/

function normalizeServerName(
    server
) {

    const value =
        String(server)
            .trim()
            .toLowerCase();


    /*
    |--------------------------------------------------------------------------
    | El API puede devolver:
    |
    | streamwish
    | streamwish_2
    | streamwish_3
    |
    | Todos se muestran como Streamwish.
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
| BLACKLIST
|--------------------------------------------------------------------------
*/

function isBlacklisted(
    server
) {

    const normalized =
        String(server)
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
        !Array.isArray(rows)
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

        links
    };
}


/*
|--------------------------------------------------------------------------
| UTILIDADES
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