/*
|--------------------------------------------------------------------------
| TON SCRAPER API WORKER
|--------------------------------------------------------------------------
|
| Arquitectura:
|
| Player Worker
|      ↓ HTTPS + API_KEY
| Scraper API Worker
|      ↓
| Cache
|      ↓
| Alpha (pelixplay)
|      ↓
| Beta (Supabase)
|
|--------------------------------------------------------------------------
| Secrets requeridos:
|
| API_KEY
| SOURCE_URL
| SUPABASE_URL
| SUPABASE_SERVICE_KEY
|--------------------------------------------------------------------------
*/


const CACHE_TTL = 6 * 60 * 60; // 6 horas


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
| ENTRYPOINT
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


/*
|--------------------------------------------------------------------------
| ROUTER
|--------------------------------------------------------------------------
*/

async function router(request, env, ctx) {

    const url = new URL(request.url);

    const pathname = url.pathname.replace(/\/+$/, "");


    /*
    |--------------------------------------------------------------------------
    | HEALTH
    |--------------------------------------------------------------------------
    |
    | Público.
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
    */

    const movie = pathname.match(
        /^\/play\/movie\/(\d+)$/
    );

    if (movie) {

        return processContent({
            request,
            env,
            ctx,

            tmdbId: movie[1],
            type: "movie",
            season: 0,
            episode: 0,

            force: isTrue(
                url.searchParams.get("force")
            )
        });
    }


    /*
    |--------------------------------------------------------------------------
    | TV
    |--------------------------------------------------------------------------
    */

    const tv = pathname.match(
        /^\/play\/tv\/(\d+)\/(\d+)\/(\d+)$/
    );

    if (tv) {

        return processContent({
            request,
            env,
            ctx,

            tmdbId: tv[1],
            type: "tv",
            season: Number(tv[2]),
            episode: Number(tv[3]),

            force: isTrue(
                url.searchParams.get("force")
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
            health: "/health",
            movie: "/play/movie/ID",
            tv: "/play/tv/ID/SEASON/EPISODE"
        }
    }, 404);
}


/*
|--------------------------------------------------------------------------
| API KEY
|--------------------------------------------------------------------------
*/

function validateApiKey(request, env) {

    if (!env.API_KEY) {

        console.error(
            "Secret API_KEY no configurado."
        );

        return false;
    }

    const authorization =
        request.headers.get("Authorization");

    if (!authorization) {
        return false;
    }

    const match =
        authorization.match(/^Bearer\s+(.+)$/i);

    if (!match) {
        return false;
    }

    const providedKey =
        match[1].trim();

    return providedKey === env.API_KEY;
}


/*
|--------------------------------------------------------------------------
| PROCESAR CONTENIDO
|--------------------------------------------------------------------------
*/

async function processContent({
    request,
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
    | SOURCE
    |--------------------------------------------------------------------------
    */

    if (!env.SOURCE_URL) {

        return jsonResponse({
            success: false,
            status: "source_not_configured",
            event: "complete",
            message: "SOURCE_URL no está configurado."
        }, 500);
    }


    /*
    |--------------------------------------------------------------------------
    | CACHE KEY
    |--------------------------------------------------------------------------
    */

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
    | CACHE HIT
    |--------------------------------------------------------------------------
    */

    if (!force) {

        const cached =
            await cache.match(cacheKey);

        if (cached) {

            const response =
                cloneResponse(cached);

            response.headers.set(
                "X-Worker-Cache",
                "HIT"
            );

            return response;
        }
    }


    /*
    |--------------------------------------------------------------------------
    | ALPHA
    |--------------------------------------------------------------------------
    */

    const alpha =
        await scrapeAlpha({
            tmdbId,
            type,
            season,
            episode,
            sourceUrl: env.SOURCE_URL
        });


    /*
    |--------------------------------------------------------------------------
    | ALPHA ENCONTRÓ ENLACES
    |--------------------------------------------------------------------------
    */

    if (
        alpha.success &&
        alpha.links.length > 0
    ) {

        const result = {
            success: true,
            status: "complete",
            event: "complete",

            source: "Alpha",

            cache: "MISS",

            tmdb_id: tmdbId,
            type,
            season,
            episode,

            found: alpha.links.length,

            links: alpha.links
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


        const output =
            cloneResponse(response);

        output.headers.set(
            "X-Worker-Cache",
            "MISS"
        );

        return output;
    }


    /*
    |--------------------------------------------------------------------------
    | BETA
    |--------------------------------------------------------------------------
    */

    const beta =
        await getBeta({
            tmdbId,
            type,
            season,
            episode,
            env
        });


    /*
    |--------------------------------------------------------------------------
    | BETA ENCONTRÓ ENLACES
    |--------------------------------------------------------------------------
    */

    if (
        beta.success &&
        beta.links.length > 0
    ) {

        const result = {
            success: true,
            status: "complete",
            event: "complete",

            source: "Beta",

            cache: "MISS",

            tmdb_id: tmdbId,
            type,
            season,
            episode,

            found: beta.links.length,

            links: beta.links
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


        const output =
            cloneResponse(response);

        output.headers.set(
            "X-Worker-Cache",
            "MISS"
        );

        return output;
    }


    /*
    |--------------------------------------------------------------------------
    | NO ENCONTRADO
    |--------------------------------------------------------------------------
    */

    return jsonResponse({
        success: false,

        status: "source_unavailable",

        event: "complete",

        source: "Alpha",
        fallback: "Beta",

        tmdb_id: tmdbId,
        type,
        season,
        episode,

        found: 0,

        links: []
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

    const key =
        type === "movie"
            ? `movie:${tmdbId}`
            : `tv:${tmdbId}:${season}:${episode}`;


    return new Request(
        `https://ton-cache.internal/${key}`,
        {
            method: "GET"
        }
    );
}


/*
|--------------------------------------------------------------------------
| SCRAPER ALPHA
|--------------------------------------------------------------------------
*/

async function scrapeAlpha({
    tmdbId,
    type,
    season,
    episode,
    sourceUrl
}) {

    sourceUrl =
        sourceUrl.replace(/\/+$/, "");


    const params =
        new URLSearchParams();

    params.set("action", "details");
    params.set("id", tmdbId);
    params.set("type", type);


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

        response = await fetch(endpoint, {
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
        });

    } catch (error) {

        console.error(
            "Alpha request:",
            error
        );

        return {
            success: false,
            status: "request_error",
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
            status: "http_error",
            http: response.status,
            links: []
        };
    }


    let data;

    try {

        data =
            await response.json();

    } catch (error) {

        console.error(
            "Alpha JSON:",
            error
        );

        return {
            success: false,
            status: "invalid_json",
            links: []
        };
    }


    /*
    |--------------------------------------------------------------------------
    | EXTRAER ALL_EMBEDS
    |--------------------------------------------------------------------------
    */

    const links =
        extractAllEmbeds(data);


    /*
    |--------------------------------------------------------------------------
    | BLACKLIST
    |--------------------------------------------------------------------------
    */

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

        links: filtered
    };
}


/*
|--------------------------------------------------------------------------
| EXTRAER ALL_EMBEDS
|--------------------------------------------------------------------------
*/

function extractAllEmbeds(data) {

    const result = [];

    const allEmbeds =
        data?.all_embeds;


    if (
        !allEmbeds ||
        typeof allEmbeds !== "object"
    ) {
        return [];
    }


    for (
        const [languageKey, servers]
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
                languageKey
            );


        for (
            const [serverName, urls]
            of Object.entries(servers)
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
                Array.isArray(urls)
            ) {

                for (
                    const url
                    of urls
                ) {

                    if (
                        typeof url !== "string"
                    ) {
                        continue;
                    }

                    if (
                        !isHttpUrl(url)
                    ) {
                        continue;
                    }


                    result.push({
                        url_embed: url,
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


    /*
    |--------------------------------------------------------------------------
    | DEDUPLICAR
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
| IDIOMAS
|--------------------------------------------------------------------------
*/

function normalizeLanguage(
    language
) {

    const value =
        String(language)
            .trim()
            .toLowerCase();


    const languages = {

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
            "Subtitulado",

        idioma36:
            "Idioma36"
    };


    if (
        languages[value]
    ) {

        return languages[value];
    }


    return capitalize(value);
}


/*
|--------------------------------------------------------------------------
| SERVIDORES
|--------------------------------------------------------------------------
*/

function normalizeServerName(
    name
) {

    const value =
        String(name)
            .trim()
            .toLowerCase();


    const names = {

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


    const base =
        value.replace(
            /_\d+$/,
            ""
        );


    if (
        names[base]
    ) {

        return names[base];
    }


    return capitalize(base);
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
| SUPABASE / BETA
|--------------------------------------------------------------------------
*/

async function getBeta({
    tmdbId,
    type,
    season,
    episode,
    env
}) {

    if (
        !env.SUPABASE_URL ||
        !env.SUPABASE_SERVICE_KEY
    ) {

        return {
            success: false,
            status: "beta_not_configured",
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


    if (type === "tv") {

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
            await fetch(endpoint, {

                method: "GET",

                headers: {

                    "apikey":
                        env.SUPABASE_SERVICE_KEY,

                    "Authorization":
                        `Bearer ${env.SUPABASE_SERVICE_KEY}`,

                    "Accept":
                        "application/json"
                }
            });

    } catch (error) {

        console.error(
            "Beta request:",
            error
        );

        return {
            success: false,
            status: "request_error",
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
            status: "http_error",
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


    const links =
        rows
            .filter(
                row =>
                    row?.url_embed
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


function cloneResponse(response) {

    const headers =
        new Headers(
            response.headers
        );


    for (
        const [key, value]
        of Object.entries(
            CORS_HEADERS
        )
    ) {

        headers.set(
            key,
            value
        );
    }


    return new Response(
        response.body,
        {
            status:
                response.status,

            statusText:
                response.statusText,

            headers
        }
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
        const [key, value]
        of Object.entries(
            CORS_HEADERS
        )
    ) {

        headers.set(
            key,
            value
        );
    }


    if (ttl > 0) {

        headers.set(
            "Cache-Control",
            `public, max-age=${ttl}, s-maxage=${ttl}`
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