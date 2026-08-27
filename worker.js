/*
|--------------------------------------------------------------------------
| TON SCRAPER API
|--------------------------------------------------------------------------
|
| SSE REAL
|
| Flujo:
|
| Player
|   |
|   +--> tmdb_receiving
|   +--> tmdb_received
|   +--> searching
|   |
|   +--> alpha_search
|   +--> Alpha
|   |      |
|   |      +--> alpha_found
|   |      |
|   |      +--> timeout / error
|   |
|   +--> Beta
|          |
|          +--> beta_cache_hit
|          |
|          +--> beta_cache_miss
|                 |
|                 +--> beta_search
|                 +--> beta_found
|
|   +--> complete
|
|--------------------------------------------------------------------------
| SECRETS / VARIABLES
|--------------------------------------------------------------------------
|
| API_KEY
| SOURCE_URL
| SUPABASE_URL
| SUPABASE_KEY
|
|--------------------------------------------------------------------------
| KV
|--------------------------------------------------------------------------
|
| BETA_CACHE
|
|--------------------------------------------------------------------------
*/

const ALPHA_NAME = "Alpha";
const BETA_NAME = "Beta";

const BETA_CACHE_TTL = 6 * 60 * 60;

// Alpha no debe bloquear todo el Worker.
const ALPHA_TIMEOUT_MS = 8000;

/*
|--------------------------------------------------------------------------
| SERVIDORES BLOQUEADOS
|--------------------------------------------------------------------------
|
| powvideo
| powvideo_2
| powvideo_3
|
| todos se consideran "powvideo".
|
| Lo mismo para streamplay.
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
| CORS
|--------------------------------------------------------------------------
*/

const CORS_HEADERS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers":
        "Content-Type, Authorization",
    "Access-Control-Allow-Methods":
        "GET, OPTIONS"
};

/*
|--------------------------------------------------------------------------
| WORKER
|--------------------------------------------------------------------------
*/

export default {
    async fetch(request, env, ctx) {

        /*
        |--------------------------------------------------------------------------
        | OPTIONS
        |--------------------------------------------------------------------------
        */

        if (request.method === "OPTIONS") {
            return new Response(null, {
                status: 204,
                headers: CORS_HEADERS
            });
        }

        /*
        |--------------------------------------------------------------------------
        | SOLO GET
        |--------------------------------------------------------------------------
        */

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
                    error?.message ||
                    String(error)
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

    if (pathname === "/health" ||
        pathname === "/") {

        return jsonResponse({
            success: true,
            status: "online",
            event: "complete",
            worker: "TON Scraper API"
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
    | /play/movie/44956
    |
    |--------------------------------------------------------------------------
    */

    const movieMatch =
        pathname.match(
            /^\/play\/movie\/(\d+)$/
        );

    if (movieMatch) {

        return createSSE(
            env,
            ctx,
            {
                tmdbId:
                    movieMatch[1],

                type:
                    "movie",

                season:
                    0,

                episode:
                    0
            }
        );
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

        return createSSE(
            env,
            ctx,
            {
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
                    )
            }
        );
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
| SSE
|--------------------------------------------------------------------------
*/

function createSSE(
    env,
    ctx,
    content
) {

    const stream =
        new TransformStream();

    const writer =
        stream.writable.getWriter();

    /*
    |--------------------------------------------------------------------------
    | Procesar de forma asíncrona
    |--------------------------------------------------------------------------
    */

    const task =
        processSSE(
            writer,
            env,
            content
        )
        .catch(async error => {

            console.error(
                "SSE processing error:",
                error
            );

            try {

                await sendSSE(
                    writer,
                    "complete",
                    {
                        success: false,
                        status:
                            "worker_error",
                        event:
                            "complete",
                        tmdb_id:
                            content.tmdbId,
                        type:
                            content.type,
                        season:
                            content.season,
                        episode:
                            content.episode,
                        found:
                            0,
                        links: [],
                        message:
                            error?.message ||
                            String(error)
                    }
                );

            } catch {
                // conexión cerrada
            }

        })
        .finally(async () => {

            try {
                await writer.close();
            } catch {
                // conexión cerrada
            }
        });

    ctx.waitUntil(task);

    /*
    |--------------------------------------------------------------------------
    | RESPUESTA SSE
    |--------------------------------------------------------------------------
    */

    const headers =
        new Headers();

    headers.set(
        "Content-Type",
        "text/event-stream; charset=UTF-8"
    );

    headers.set(
        "Cache-Control",
        "no-cache, no-store, must-revalidate"
    );

    headers.set(
        "Connection",
        "keep-alive"
    );

    headers.set(
        "X-Accel-Buffering",
        "no"
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

    return new Response(
        stream.readable,
        {
            status: 200,
            headers
        }
    );
}

/*
|--------------------------------------------------------------------------
| PROCESAMIENTO SSE
|--------------------------------------------------------------------------
*/

async function processSSE(
    writer,
    env,
    content
) {

    const {
        tmdbId,
        type,
        season,
        episode
    } = content;

    /*
    |--------------------------------------------------------------------------
    | EVENTO 1
    |--------------------------------------------------------------------------
    */

    await sendSSE(
        writer,
        "tmdb_receiving",
        {
            success: true,
            status:
                "tmdb_receiving",
            message:
                "Recibiendo datos de TMDB",
            tmdb_id:
                tmdbId,
            type,
            season,
            episode
        }
    );

    /*
    |--------------------------------------------------------------------------
    | EVENTO 2
    |--------------------------------------------------------------------------
    |
    | En este Worker no hacemos una petición adicional
    | a TMDB. El ID ya viene del Player.
    |
    |--------------------------------------------------------------------------
    */

    await sendSSE(
        writer,
        "tmdb_received",
        {
            success: true,
            status:
                "tmdb_received",
            message:
                "Datos de TMDB recibidos",
            tmdb_id:
                tmdbId,
            type,
            season,
            episode
        }
    );

    /*
    |--------------------------------------------------------------------------
    | EVENTO 3
    |--------------------------------------------------------------------------
    */

    await sendSSE(
        writer,
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
    | ALPHA SEARCH
    |--------------------------------------------------------------------------
    */

    await sendSSE(
        writer,
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
    | CONSULTAR ALPHA
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
    | ALPHA FOUND
    |--------------------------------------------------------------------------
    */

    if (
        alpha.success &&
        alpha.links.length > 0
    ) {

        await sendSSE(
            writer,
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
                    `Alpha: ${alpha.links.length} servidor${
                        alpha.links.length === 1
                            ? ""
                            : "es"
                    } encontrado${
                        alpha.links.length === 1
                            ? ""
                            : "s"
                    }`,

                parser:
                    alpha.parser,

                mode:
                    alpha.mode,

                links:
                    alpha.links
            }
        );

    } else {

        await sendSSE(
            writer,
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

                http_code:
                    alpha.http_code || 0,

                content_type:
                    alpha.content_type || "",

                elapsed_ms:
                    alpha.elapsed_ms || 0,

                parser:
                    alpha.parser || null,

                raw_keys:
                    alpha.raw_keys || [],

                all_embeds_languages:
                    alpha.all_embeds_languages || [],

                all_embeds_urls:
                    alpha.all_embeds_urls || 0,

                all_embeds_valid:
                    alpha.all_embeds_valid || 0,

                all_embeds_discarded:
                    alpha.all_embeds_discarded || 0,

                embeds_urls:
                    alpha.embeds_urls || 0,

                embeds_valid:
                    alpha.embeds_valid || 0,

                embeds_discarded:
                    alpha.embeds_discarded || 0,

                error:
                    alpha.error ||
                    null
            }
        );
    }

    /*
    |--------------------------------------------------------------------------
    | SI ALPHA TIENE SERVIDORES
    |--------------------------------------------------------------------------
    |
    | No necesitamos consultar Beta.
    |
    |--------------------------------------------------------------------------
    */

    if (
        alpha.success &&
        alpha.links.length > 0
    ) {

        await sendSSE(
            writer,
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

                tmdb_id:
                    tmdbId,

                type,

                season,

                episode,

                alpha_found:
                    alpha.links.length,

                beta_found:
                    0,

                found:
                    alpha.links.length,

                links:
                    alpha.links,

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

    /*
    |--------------------------------------------------------------------------
    | Comprobar KV
    |--------------------------------------------------------------------------
    */

    const cachedBeta =
        await getBetaCache(
            env,
            tmdbId,
            type,
            season,
            episode
        );

    if (
        cachedBeta &&
        Array.isArray(
            cachedBeta.links
        ) &&
        cachedBeta.links.length > 0
    ) {

        await sendSSE(
            writer,
            "beta_cache_hit",
            {
                success: true,
                status:
                    "beta_cache_hit",
                source:
                    BETA_NAME,

                found:
                    cachedBeta.links.length,

                message:
                    `Beta: ${cachedBeta.links.length} servidor${
                        cachedBeta.links.length === 1
                            ? ""
                            : "es"
                    } encontrado${
                        cachedBeta.links.length === 1
                            ? ""
                            : "s"
                    } en caché`,

                cache_ttl:
                    BETA_CACHE_TTL
            }
        );

        await sendSSE(
            writer,
            "complete",
            {
                success: true,
                status:
                    "complete",
                event:
                    "complete",

                source:
                    BETA_NAME,

                cache:
                    "HIT",

                fallback:
                    BETA_NAME,

                tmdb_id:
                    tmdbId,

                type,

                season,

                episode,

                alpha_found:
                    0,

                beta_found:
                    cachedBeta.links.length,

                found:
                    cachedBeta.links.length,

                links:
                    cachedBeta.links,

                message:
                    "Búsqueda completada"
            }
        );

        return;
    }

    /*
    |--------------------------------------------------------------------------
    | CACHE MISS
    |--------------------------------------------------------------------------
    */

    await sendSSE(
        writer,
        "beta_cache_miss",
        {
            success: true,
            status:
                "beta_cache_miss",
            source:
                BETA_NAME,
            found: 0,
            message:
                "Beta no está en caché"
        }
    );

    /*
    |--------------------------------------------------------------------------
    | BETA SEARCH
    |--------------------------------------------------------------------------
    */

    await sendSSE(
        writer,
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
    | CONSULTAR BETA
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

    /*
    |--------------------------------------------------------------------------
    | BETA FOUND
    |--------------------------------------------------------------------------
    */

    if (
        beta.success &&
        beta.links.length > 0
    ) {

        /*
        |--------------------------------------------------------------------------
        | Guardar Beta en KV
        |--------------------------------------------------------------------------
        */

        await saveBetaCache(
            env,
            tmdbId,
            type,
            season,
            episode,
            beta.links
        );

        await sendSSE(
            writer,
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
                    `Beta: ${beta.links.length} servidor${
                        beta.links.length === 1
                            ? ""
                            : "es"
                    } encontrado${
                        beta.links.length === 1
                            ? ""
                            : "s"
                    }`,

                http_code:
                    beta.http_code || 200,

                content_type:
                    beta.content_type ||
                    "application/json",

                elapsed_ms:
                    beta.elapsed_ms || 0,

                parser:
                    beta.parser ||
                    "supabase_rest",

                rows:
                    beta.rows || 0,

                valid:
                    beta.valid || 0,

                discarded:
                    beta.discarded || 0,

                blacklisted:
                    beta.blacklisted || 0,

                links:
                    beta.links
            }
        );

        await sendSSE(
            writer,
            "complete",
            {
                success: true,
                status:
                    "complete",
                event:
                    "complete",

                source:
                    BETA_NAME,

                cache:
                    "MISS",

                fallback:
                    BETA_NAME,

                tmdb_id:
                    tmdbId,

                type,

                season,

                episode,

                alpha_found:
                    0,

                beta_found:
                    beta.links.length,

                found:
                    beta.links.length,

                links:
                    beta.links,

                message:
                    "Búsqueda completada"
            }
        );

        return;
    }

    /*
    |--------------------------------------------------------------------------
    | BETA FALLÓ
    |--------------------------------------------------------------------------
    */

    await sendSSE(
        writer,
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

            http_code:
                beta.http_code || 0,

            content_type:
                beta.content_type || "",

            elapsed_ms:
                beta.elapsed_ms || 0,

            parser:
                beta.parser || null,

            rows:
                beta.rows || 0,

            valid:
                beta.valid || 0,

            discarded:
                beta.discarded || 0,

            blacklisted:
                beta.blacklisted || 0,

            error:
                beta.error ||
                null
        }
    );

    /*
    |--------------------------------------------------------------------------
    | COMPLETE SIN RESULTADOS
    |--------------------------------------------------------------------------
    */

    await sendSSE(
        writer,
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

            tmdb_id:
                tmdbId,

            type,

            season,

            episode,

            alpha_found:
                0,

            beta_found:
                0,

            found:
                0,

            links: [],

            alpha_error:
                alpha.error ||
                null,

            beta_error:
                beta.error ||
                null,

            message:
                "Alpha y Beta no devolvieron servidores válidos."
        }
    );
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

        return {
            success: false,
            status:
                "source_not_configured",

            links: [],

            error:
                "SOURCE_URL no está configurado."
        };
    }

    /*
    |--------------------------------------------------------------------------
    | SOURCE_URL
    |--------------------------------------------------------------------------
    |
    | IMPORTANTE:
    |
    | SOURCE_URL debe ser el dominio/base.
    |
    | El endpoint final será:
    |
    | SOURCE_URL/embed/api.php
    |
    |--------------------------------------------------------------------------
    */

    const sourceUrl =
        String(
            env.SOURCE_URL
        )
            .trim()
            .replace(
                /\/+$/,
                ""
            );

    const endpoint =
        `${sourceUrl}/embed/api.php`;

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

    const fullUrl =
        `${endpoint}?${params.toString()}`;

    const started =
        Date.now();

    let response;

    try {

        response =
            await fetchWithTimeout(
                fullUrl,
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
                },

                ALPHA_TIMEOUT_MS
            );

    } catch (error) {

        return {
            success: false,
            status:
                error?.name ===
                    "AbortError"
                    ? "timeout"
                    : "request_error",

            links: [],

            elapsed_ms:
                Date.now() -
                started,

            http_code:
                0,

            content_type:
                "",

            parser:
                null,

            raw_keys: [],

            all_embeds_languages: [],

            all_embeds_urls: 0,

            all_embeds_valid: 0,

            all_embeds_discarded: 0,

            embeds_urls: 0,

            embeds_valid: 0,

            embeds_discarded: 0,

            error:
                error?.name ===
                    "AbortError"
                    ? `Alpha superó el timeout de ${ALPHA_TIMEOUT_MS} ms.`
                    : (
                        error?.message ||
                        String(error)
                    )
        };
    }

    const elapsed =
        Date.now() -
        started;

    const contentType =
        response.headers.get(
            "content-type"
        ) || "";

    let text = "";

    try {
        text =
            await response.text();

    } catch (error) {

        return {
            success: false,
            status:
                "read_error",

            links: [],

            http_code:
                response.status,

            content_type:
                contentType,

            elapsed_ms:
                elapsed,

            error:
                error?.message ||
                String(error)
        };
    }

    /*
    |--------------------------------------------------------------------------
    | HTTP ERROR
    |--------------------------------------------------------------------------
    */

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
                elapsed,

            parser:
                null,

            raw_keys: [],

            all_embeds_languages: [],

            all_embeds_urls: 0,

            all_embeds_valid: 0,

            all_embeds_discarded: 0,

            embeds_urls: 0,

            embeds_valid: 0,

            embeds_discarded: 0,

            error:
                `Alpha respondió HTTP ${response.status}`
        };
    }

    /*
    |--------------------------------------------------------------------------
    | PARSE JSON
    |--------------------------------------------------------------------------
    */

    let data;

    try {

        data =
            JSON.parse(text);

    } catch (error) {

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
                elapsed,

            parser:
                "JSON.parse",

            raw_keys: [],

            all_embeds_languages: [],

            all_embeds_urls: 0,

            all_embeds_valid: 0,

            all_embeds_discarded: 0,

            embeds_urls: 0,

            embeds_valid: 0,

            embeds_discarded: 0,

            error:
                "Alpha devolvió una respuesta que no es JSON."
        };
    }

    const rawKeys =
        data &&
        typeof data === "object"
            ? Object.keys(data)
            : [];

    /*
    |--------------------------------------------------------------------------
    | ALL_EMBEDS
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

        const diagnostics =
            inspectAllEmbeds(
                data.all_embeds
            );

        const links =
            extractAllEmbeds(
                data.all_embeds
            );

        const filtered =
            links.filter(
                link =>
                    !isBlacklistedServer(
                        link.servidor
                    )
            );

        if (
            filtered.length > 0
        ) {

            return {
                success: true,

                status:
                    "links_found",

                parser:
                    "all_embeds",

                mode:
                    "all_embeds",

                links:
                    filtered,

                http_code:
                    response.status,

                content_type:
                    contentType,

                elapsed_ms:
                    elapsed,

                raw_keys:
                    rawKeys,

                ...diagnostics
            };
        }
    }

    /*
    |--------------------------------------------------------------------------
    | EMBEDS FALLBACK
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

        const diagnostics =
            inspectEmbeds(
                data.embeds
            );

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

        const filtered =
            links.filter(
                link =>
                    !isBlacklistedServer(
                        link.servidor
                    )
            );

        if (
            filtered.length > 0
        ) {

            return {
                success: true,

                status:
                    "links_found",

                parser:
                    "embeds",

                mode:
                    "embeds_fallback",

                links:
                    filtered,

                http_code:
                    response.status,

                content_type:
                    contentType,

                elapsed_ms:
                    elapsed,

                raw_keys:
                    rawKeys,

                all_embeds_languages:
                    [],

                all_embeds_urls:
                    0,

                all_embeds_valid:
                    0,

                all_embeds_discarded:
                    0,

                ...diagnostics
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

        http_code:
            response.status,

        content_type:
            contentType,

        elapsed_ms:
            elapsed,

        parser:
            data?.all_embeds
                ? "all_embeds"
                : data?.embeds
                    ? "embeds"
                    : null,

        raw_keys:
            rawKeys,

        all_embeds_languages:
            data?.all_embeds
                ? Object.keys(
                    data.all_embeds
                )
                : [],

        all_embeds_urls:
            0,

        all_embeds_valid:
            0,

        all_embeds_discarded:
            0,

        embeds_urls:
            0,

        embeds_valid:
            0,

        embeds_discarded:
            0,

        error:
            "Alpha no devolvió enlaces válidos."
    };
}

/*
|--------------------------------------------------------------------------
| INSPECCIONAR ALL_EMBEDS
|--------------------------------------------------------------------------
*/

function inspectAllEmbeds(
    allEmbeds
) {

    let urls = 0;
    let valid = 0;
    let discarded = 0;

    const languages =
        Object.keys(
            allEmbeds
        );

    for (
        const [
            language,
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

        for (
            const [
                server,
                values
            ]
            of Object.entries(
                servers
            )
        ) {

            const arr =
                Array.isArray(values)
                    ? values
                    : [
                        values
                    ];

            for (
                const value
                of arr
            ) {

                if (
                    typeof value !==
                    "string"
                ) {
                    continue;
                }

                urls++;

                if (
                    !isHttpUrl(
                        value
                    )
                ) {
                    discarded++;
                    continue;
                }

                if (
                    isBlacklistedServer(
                        server
                    )
                ) {
                    discarded++;
                    continue;
                }

                valid++;
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

/*
|--------------------------------------------------------------------------
| INSPECCIONAR EMBEDS
|--------------------------------------------------------------------------
*/

function inspectEmbeds(
    embeds
) {

    let urls = 0;
    let valid = 0;
    let discarded = 0;

    for (
        const [
            server,
            values
        ]
        of Object.entries(
            embeds
        )
    ) {

        const arr =
            Array.isArray(values)
                ? values
                : [
                    values
                ];

        for (
            const value
            of arr
        ) {

            if (
                typeof value !==
                "string"
            ) {
                continue;
            }

            urls++;

            if (
                !isHttpUrl(
                    value
                )
            ) {
                discarded++;
                continue;
            }

            if (
                isBlacklistedServer(
                    server
                )
            ) {
                discarded++;
                continue;
            }

            valid++;
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
                values
            ]
            of Object.entries(
                servers
            )
        ) {

            if (
                isBlacklistedServer(
                    serverName
                )
            ) {
                continue;
            }

            const servidor =
                normalizeServerName(
                    serverName
                );

            const urls =
                Array.isArray(values)
                    ? values
                    : [
                        values
                    ];

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
        }
    }

    return deduplicateLinks(
        result
    );
}

/*
|--------------------------------------------------------------------------
| EMBEDS FALLBACK
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
            values
        ]
        of Object.entries(
            embeds
        )
    ) {

        if (
            isBlacklistedServer(
                serverName
            )
        ) {
            continue;
        }

        const servidor =
            normalizeServerName(
                serverName
            );

        const urls =
            Array.isArray(values)
                ? values
                : [
                    values
                ];

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
    }

    return deduplicateLinks(
        result
    );
}

/*
|--------------------------------------------------------------------------
| BETA — SUPABASE
|--------------------------------------------------------------------------
|
| SOLO LECTURA
|
| SUPABASE_KEY puede ser una clave que tenga
| permiso de SELECT sobre public.enlaces.
|
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
        !env.SUPABASE_KEY
    ) {

        return {
            success: false,

            status:
                "beta_not_configured",

            links: [],

            http_code:
                0,

            rows:
                0,

            valid:
                0,

            discarded:
                0,

            blacklisted:
                0,

            error:
                "SUPABASE_URL o SUPABASE_KEY no está configurado."
        };
    }

    const baseUrl =
        String(
            env.SUPABASE_URL
        )
            .trim()
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

    const started =
        Date.now();

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
                            env.SUPABASE_KEY,

                        "Authorization":
                            `Bearer ${env.SUPABASE_KEY}`,

                        "Accept":
                            "application/json"
                    }
                }
            );

    } catch (error) {

        return {
            success: false,

            status:
                "request_error",

            links: [],

            http_code:
                0,

            content_type:
                "",

            elapsed_ms:
                Date.now() -
                started,

            rows:
                0,

            valid:
                0,

            discarded:
                0,

            blacklisted:
                0,

            parser:
                null,

            error:
                error?.message ||
                String(error)
        };
    }

    const elapsed =
        Date.now() -
        started;

    const contentType =
        response.headers.get(
            "content-type"
        ) || "";

    let text;

    try {

        text =
            await response.text();

    } catch (error) {

        return {
            success: false,

            status:
                "read_error",

            links: [],

            http_code:
                response.status,

            content_type:
                contentType,

            elapsed_ms:
                elapsed,

            rows:
                0,

            valid:
                0,

            discarded:
                0,

            blacklisted:
                0,

            error:
                error?.message ||
                String(error)
        };
    }

    /*
    |--------------------------------------------------------------------------
    | HTTP ERROR
    |--------------------------------------------------------------------------
    */

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
                elapsed,

            rows:
                0,

            valid:
                0,

            discarded:
                0,

            blacklisted:
                0,

            error:
                `Beta respondió HTTP ${response.status}: ${text.slice(0, 500)}`
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
            JSON.parse(
                text
            );

    } catch (error) {

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
                elapsed,

            rows:
                0,

            valid:
                0,

            discarded:
                0,

            blacklisted:
                0,

            parser:
                "JSON.parse",

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

            http_code:
                response.status,

            content_type:
                contentType,

            elapsed_ms:
                elapsed,

            rows:
                0,

            valid:
                0,

            discarded:
                0,

            blacklisted:
                0,

            parser:
                "supabase_rest",

            error:
                "Beta no devolvió un array."
        };
    }

    let valid = 0;
    let discarded = 0;
    let blacklisted = 0;

    const links = [];

    for (
        const row
        of rows
    ) {

        if (
            !row ||
            typeof row.url_embed !==
                "string" ||
            !isHttpUrl(
                row.url_embed
            )
        ) {

            discarded++;
            continue;
        }

        if (
            isBlacklistedServer(
                row.servidor
            )
        ) {

            blacklisted++;
            discarded++;

            continue;
        }

        links.push({
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
        });

        valid++;
    }

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
            uniqueLinks,

        http_code:
            response.status,

        content_type:
            contentType,

        elapsed_ms:
            elapsed,

        parser:
            "supabase_rest",

        rows:
            rows.length,

        valid:
            uniqueLinks.length,

        discarded,

        blacklisted,

        error:
            uniqueLinks.length > 0
                ? null
                : "Beta no encontró enlaces válidos."
    };
}

/*
|--------------------------------------------------------------------------
| BETA CACHE KEY
|--------------------------------------------------------------------------
*/

function buildBetaCacheKey(
    tmdbId,
    type,
    season,
    episode
) {

    if (
        type === "tv"
    ) {

        return `beta:${type}:${tmdbId}:${season}:${episode}`;
    }

    return `beta:${type}:${tmdbId}`;
}

/*
|--------------------------------------------------------------------------
| GET BETA CACHE
|--------------------------------------------------------------------------
*/

async function getBetaCache(
    env,
    tmdbId,
    type,
    season,
    episode
) {

    if (!env.BETA_CACHE) {
        return null;
    }

    const key =
        buildBetaCacheKey(
            tmdbId,
            type,
            season,
            episode
        );

    try {

        const value =
            await env.BETA_CACHE.get(
                key,
                {
                    type:
                        "json"
                }
            );

        if (
            !value ||
            !Array.isArray(
                value.links
            )
        ) {
            return null;
        }

        /*
        |--------------------------------------------------------------------------
        | Segunda protección contra servidores bloqueados
        |--------------------------------------------------------------------------
        */

        value.links =
            value.links.filter(
                link =>
                    link &&
                    link.url_embed &&
                    !isBlacklistedServer(
                        link.servidor
                    )
            );

        return value;

    } catch (error) {

        console.error(
            "Beta KV read error:",
            error
        );

        return null;
    }
}

/*
|--------------------------------------------------------------------------
| SAVE BETA CACHE
|--------------------------------------------------------------------------
*/

async function saveBetaCache(
    env,
    tmdbId,
    type,
    season,
    episode,
    links
) {

    if (!env.BETA_CACHE) {
        return false;
    }

    const key =
        buildBetaCacheKey(
            tmdbId,
            type,
            season,
            episode
        );

    const data = {
        saved_at:
            new Date().toISOString(),

        expires_in:
            BETA_CACHE_TTL,

        tmdb_id:
            tmdbId,

        type,

        season,

        episode,

        links:
            links.filter(
                link =>
                    !isBlacklistedServer(
                        link.servidor
                    )
            )
    };

    try {

        await env.BETA_CACHE.put(
            key,
            JSON.stringify(
                data
            ),
            {
                expirationTtl:
                    BETA_CACHE_TTL
            }
        );

        return true;

    } catch (error) {

        console.error(
            "Beta KV write error:",
            error
        );

        return false;
    }
}

/*
|--------------------------------------------------------------------------
| BLACKLIST
|--------------------------------------------------------------------------
*/

function isBlacklistedServer(
    server
) {

    const normalized =
        String(
            server || ""
        )
            .trim()
            .toLowerCase()
            .replace(
                /[\s_-]+/g,
                ""
            );

    /*
    |--------------------------------------------------------------------------
    | Comprobar por prefijo/base
    |--------------------------------------------------------------------------
    |
    | powvideo_2
    | powvideo_3
    | streamplay_2
    |
    | también quedan bloqueados.
    |--------------------------------------------------------------------------
    */

    for (
        const blocked
        of BLACKLISTED_SERVERS
    ) {

        if (
            normalized ===
                blocked
                .replace(
                    /[\s_-]+/g,
                    ""
                )
        ) {
            return true;
        }

        if (
            normalized.startsWith(
                blocked
                    .replace(
                        /[\s_-]+/g,
                        ""
                    )
            )
        ) {
            return true;
        }
    }

    return false;
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

        vimeos:
            "Vimeos",

        abyss:
            "Abyss",

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

        latin:
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

        if (
            !link ||
            !link.url_embed
        ) {
            continue;
        }

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
| API KEY
|--------------------------------------------------------------------------
*/

function validateApiKey(
    request,
    env
) {

    /*
    |--------------------------------------------------------------------------
    | Si no configuraste API_KEY,
    | se considera configuración inválida.
    |--------------------------------------------------------------------------
    */

    if (!env.API_KEY) {

        console.error(
            "API_KEY no está configurada."
        );

        return false;
    }

    const authorization =
        request.headers.get(
            "Authorization"
        ) || "";

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
| FETCH CON TIMEOUT
|--------------------------------------------------------------------------
*/

async function fetchWithTimeout(
    url,
    options = {},
    timeoutMs = 8000
) {

    const controller =
        new AbortController();

    const timer =
        setTimeout(
            () =>
                controller.abort(),
            timeoutMs
        );

    try {

        return await fetch(
            url,
            {
                ...options,
                signal:
                    controller.signal
            }
        );

    } finally {

        clearTimeout(
            timer
        );
    }
}

/*
|--------------------------------------------------------------------------
| SSE SEND
|--------------------------------------------------------------------------
*/

async function sendSSE(
    writer,
    event,
    data
) {

    const payload =
        `event: ${event}\n` +
        `data: ${JSON.stringify(data)}\n\n`;

    await writer.write(
        new TextEncoder().encode(
            payload
        )
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

    headers.set(
        "Cache-Control",
        "no-store, no-cache, must-revalidate"
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