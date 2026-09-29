/*
 * ================================================================
 * TONPLAYER CONTENT WORKER
 * ================================================================
 *
 * Alpha = PelixPlay
 * Beta  = Supabase
 *
 * Flujo normal:
 *   1. Alpha + Beta en paralelo
 *   2. Beta / BD primero
 *   3. Alpha después
 *   4. Alpha: Vimeus -> Streamwish -> resto
 *   5. NO se eliminan servidores repetidos
 *   6. URLs exactamente iguales sí se deduplican
 *   7. Duplicados de servidor se numeran:
 *        Streamwish
 *        Streamwish 2
 *        Streamwish 3
 *
 * KV:
 *   ALPHA_KV -> PelixPlay, TTL 6h
 *   BETA_KV  -> Supabase,  TTL 6h
 *
 * VARIABLES:
 *   SOURCE_URL
 *   SUPABASE_URL
 *   SUPABASE_ANON_KEY
 *
 * BINDINGS:
 *   ALPHA_KV
 *   BETA_KV
 *
 * ENDPOINTS:
 *   GET /health
 *
 *   GET /play/movie/ID
 *   GET /play/movie/ID?force=true
 *   GET /play/movie/ID?fallback=beta
 *
 *   GET /play/tv/ID/SEASON/EPISODE
 *   GET /play/tv/ID/SEASON/EPISODE?force=true
 *   GET /play/tv/ID/SEASON/EPISODE?fallback=beta
 *
 * ================================================================
 */

const ALPHA_CACHE_TTL = 6 * 60 * 60;
const BETA_CACHE_TTL = 6 * 60 * 60;

const BLACKLIST = [
    "servidortrinity",
    "servidormahoutokoro",
    "servidordeathstar",
    "servidorgoldmember",
    "powvideo",
    "streamplay"
];

const CORS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization"
};


/*
 * ================================================================
 * ENTRYPOINT
 * ================================================================
 */

export default {
    async fetch(request, env, ctx) {

        if (request.method === "OPTIONS") {
            return new Response(null, {
                status: 204,
                headers: CORS
            });
        }

        if (request.method !== "GET") {
            return jsonResponse({
                success: false,
                status: "method_not_allowed",
                event: "complete"
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
                error: error?.message || String(error)
            }, 500);
        }
    }
};


/*
 * ================================================================
 * ROUTER
 * ================================================================
 */

async function router(request, env, ctx) {

    const url = new URL(request.url);

    const path = url.pathname.replace(/\/+$/, "");

    /*
     * ------------------------------------------------------------
     * HEALTH
     * ------------------------------------------------------------
     */

    if (path === "/health") {

        return jsonResponse({
            success: true,
            status: "online",
            event: "complete",
            worker: "TONPlayer Content Worker"
        });
    }


    /*
     * ------------------------------------------------------------
     * OPTIONS
     * ------------------------------------------------------------
     */

    const force = isTrue(
        url.searchParams.get("force")
    );

    const fallbackBeta =
        isBetaFallback(
            url.searchParams.get("fallback")
        );


    /*
     * ------------------------------------------------------------
     * MOVIE
     * ------------------------------------------------------------
     */

    const movieMatch = path.match(
        /^\/play\/movie\/(\d+)$/
    );

    if (movieMatch) {

        return processContent({
            env,
            ctx,

            tmdbId: movieMatch[1],

            type: "movie",

            season: 0,
            episode: 0,

            force,
            fallbackBeta
        });
    }


    /*
     * ------------------------------------------------------------
     * TV
     * ------------------------------------------------------------
     */

    const tvMatch = path.match(
        /^\/play\/tv\/(\d+)\/(\d+)\/(\d+)$/
    );

    if (tvMatch) {

        return processContent({
            env,
            ctx,

            tmdbId: tvMatch[1],

            type: "tv",

            season: Number(tvMatch[2]),
            episode: Number(tvMatch[3]),

            force,
            fallbackBeta
        });
    }


    /*
     * ------------------------------------------------------------
     * NOT FOUND
     * ------------------------------------------------------------
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
 * ================================================================
 * MAIN PROCESS
 * ================================================================
 */

async function processContent({
    env,
    ctx,
    tmdbId,
    type,
    season,
    episode,
    force,
    fallbackBeta
}) {

    /*
     * ------------------------------------------------------------
     * FALLBACK BETA
     *
     * ?fallback=beta
     *
     * Se consulta solamente Supabase.
     * ------------------------------------------------------------
     */

    if (fallbackBeta) {

        const beta = await runBeta({
            env,
            ctx,
            tmdbId,
            type,
            season,
            episode,
            force
        });

        const betaLinks = prepareLinks(
            beta.links || []
        );

        const numberedLinks =
            numberDuplicateServers(betaLinks);


        return jsonResponse({

            success: numberedLinks.length > 0,

            status: numberedLinks.length > 0
                ? "complete"
                : "source_unavailable",

            event: "complete",

            source: "Beta",

            fallback: null,

            tmdb_id: tmdbId,
            type,
            season,
            episode,

            alpha_found: 0,

            beta_found: numberedLinks.length,

            alpha_queried: false,

            beta_queried: true,

            found: numberedLinks.length,

            links: numberedLinks,

            beta_cache: beta.cache || "MISS",

            beta_error: beta.error || null

        });
    }


    /*
     * ------------------------------------------------------------
     * ALPHA + BETA EN PARALELO
     * ------------------------------------------------------------
     *
     * Importante:
     *
     * Los dos se ejecutan simultáneamente.
     *
     * Después se ordenan:
     *
     * Beta
     * ↓
     * Vimeus
     * ↓
     * Streamwish
     * ↓
     * resto Alpha
     *
     * ------------------------------------------------------------
     */

    const [
        alpha,
        beta
    ] = await Promise.all([

        runAlpha({
            env,
            ctx,
            tmdbId,
            type,
            season,
            episode,
            force
        }),

        runBeta({
            env,
            ctx,
            tmdbId,
            type,
            season,
            episode,
            force
        })

    ]);


    /*
     * ------------------------------------------------------------
     * PREPARAR ALPHA
     * ------------------------------------------------------------
     */

    const alphaLinks = prepareLinks(
        alpha.links || []
    );


    /*
     * ------------------------------------------------------------
     * PREPARAR BETA
     * ------------------------------------------------------------
     */

    const betaLinks = prepareLinks(
        beta.links || []
    );


    /*
     * ------------------------------------------------------------
     * ORDEN FINAL
     * ------------------------------------------------------------
     *
     * Beta primero.
     *
     * Alpha:
     *   1. Vimeus
     *   2. Streamwish
     *   3. resto
     *
     * NO eliminamos servidores repetidos.
     * ------------------------------------------------------------
     */

    const orderedAlpha =
        orderAlphaLinks(alphaLinks);


    /*
     * ------------------------------------------------------------
     * COMBINAR
     * ------------------------------------------------------------
     */

    const combinedLinks = [
        ...betaLinks,
        ...orderedAlpha
    ];


    /*
     * ------------------------------------------------------------
     * DEDUPLICACIÓN
     *
     * Solo elimina:
     *
     * mismo idioma + misma URL
     *
     * NO elimina:
     *
     * Streamwish + Streamwish
     * Voe + Voe
     * Vimeus + Vimeus
     *
     * siempre que las URLs sean diferentes.
     * ------------------------------------------------------------
     */

    const uniqueLinks =
        deduplicateExactLinks(combinedLinks);


    /*
     * ------------------------------------------------------------
     * NUMERAR DUPLICADOS
     *
     * Streamwish
     * Streamwish 2
     * Streamwish 3
     *
     * El contador es independiente por idioma.
     * ------------------------------------------------------------
     */

    const finalLinks =
        numberDuplicateServers(uniqueLinks);


    /*
     * ------------------------------------------------------------
     * RESULTADO
     * ------------------------------------------------------------
 */

    if (finalLinks.length > 0) {

        return jsonResponse({

            success: true,

            status: "complete",

            event: "complete",

            source:
                betaLinks.length > 0 && alphaLinks.length > 0
                    ? "Beta+Alpha"
                    : betaLinks.length > 0
                        ? "Beta"
                        : "Alpha",

            cache: "MISS",

            tmdb_id: tmdbId,

            type,

            season,

            episode,

            alpha_found: alphaLinks.length,

            beta_found: betaLinks.length,

            alpha_queried: true,

            beta_queried: true,

            found: finalLinks.length,

            links: finalLinks,

            alpha: {
                success: alpha.success,
                status: alpha.status,
                cache: alpha.cache || "MISS",
                http_code: alpha.http_code ?? null,
                content_type: alpha.content_type ?? null,
                elapsed_ms: alpha.elapsed_ms ?? null,
                parser: alpha.parser ?? null,
                error: alpha.error ?? null
            },

            beta: {
                success: beta.success,
                status: beta.status,
                cache: beta.cache || "MISS",
                http_code: beta.http_code ?? null,
                content_type: beta.content_type ?? null,
                elapsed_ms: beta.elapsed_ms ?? null,
                parser: beta.parser ?? null,
                error: beta.error ?? null
            },

            nsr: false

        });
    }


    /*
     * ------------------------------------------------------------
     * SIN RESULTADOS
     * ------------------------------------------------------------
     */

    return jsonResponse({

        success: false,

        status: "source_unavailable",

        event: "complete",

        source: "Beta+Alpha",

        tmdb_id: tmdbId,

        type,

        season,

        episode,

        alpha_found: 0,

        beta_found: 0,

        alpha_queried: true,

        beta_queried: true,

        found: 0,

        links: [],

        alpha: {
            success: alpha.success,
            status: alpha.status,
            error: alpha.error || null
        },

        beta: {
            success: beta.success,
            status: beta.status,
            error: beta.error || null
        },

        nsr: false

    });
}


/*
 * ================================================================
 * ALPHA — PELIXPLAY
 * ================================================================
 */

async function runAlpha({
    env,
    ctx,
    tmdbId,
    type,
    season,
    episode,
    force
}) {

    const cacheKey =
        buildAlphaCacheKey(
            type,
            tmdbId,
            season,
            episode
        );


    /*
     * ------------------------------------------------------------
     * KV HIT
     * ------------------------------------------------------------
     */

    if (!force && env.ALPHA_KV) {

        try {

            const cached =
                await env.ALPHA_KV.get(
                    cacheKey,
                    "json"
                );


            if (
                cached &&
                Array.isArray(cached.links)
            ) {

                const links =
                    prepareLinks(cached.links);


                if (links.length > 0) {

                    return {
                        success: true,

                        status: "cache_hit",

                        links,

                        cache: "HIT",

                        elapsed_ms: 0,

                        error: null
                    };
                }
            }

        } catch (error) {

            console.error(
                "ALPHA_KV error:",
                error
            );
        }
    }


    /*
     * ------------------------------------------------------------
     * SCRAPE PELIXPLAY
     * ------------------------------------------------------------
     */

    const result =
        await scrapePelixPlay({
            env,
            tmdbId,
            type,
            season,
            episode
        });


    const links =
        prepareLinks(
            result.links || []
        );


    /*
     * ------------------------------------------------------------
     * GUARDAR KV
     * ------------------------------------------------------------
     */

    if (
        env.ALPHA_KV &&
        links.length > 0
    ) {

        ctx.waitUntil(

            env.ALPHA_KV.put(

                cacheKey,

                JSON.stringify({

                    links,

                    cached_at: Date.now()

                }),

                {
                    expirationTtl:
                        ALPHA_CACHE_TTL
                }
            )
        );
    }


    return {

        ...result,

        links,

        cache: "MISS"
    };
}


/*
 * ================================================================
 * BETA — SUPABASE
 * ================================================================
 */

async function runBeta({
    env,
    ctx,
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
     * ------------------------------------------------------------
     * KV HIT
     * ------------------------------------------------------------
     */

    if (!force && env.BETA_KV) {

        try {

            const cached =
                await env.BETA_KV.get(
                    cacheKey,
                    "json"
                );


            if (
                cached &&
                Array.isArray(cached.links)
            ) {

                const links =
                    prepareLinks(cached.links);


                if (links.length > 0) {

                    return {

                        success: true,

                        status: "cache_hit",

                        links,

                        cache: "HIT",

                        elapsed_ms: 0,

                        error: null
                    };
                }
            }

        } catch (error) {

            console.error(
                "BETA_KV error:",
                error
            );
        }
    }


    /*
     * ------------------------------------------------------------
     * SUPABASE
     * ------------------------------------------------------------
     */

    const result =
        await fetchSupabase({

            env,

            tmdbId,

            type,

            season,

            episode

        });


    const links =
        prepareLinks(
            result.links || []
        );


    /*
     * ------------------------------------------------------------
     * GUARDAR KV
     * ------------------------------------------------------------
     */

    if (
        env.BETA_KV &&
        links.length > 0
    ) {

        ctx.waitUntil(

            env.BETA_KV.put(

                cacheKey,

                JSON.stringify({

                    links,

                    cached_at: Date.now()

                }),

                {
                    expirationTtl:
                        BETA_CACHE_TTL
                }
            )
        );
    }


    return {

        ...result,

        links,

        cache: "MISS"
    };
}


/*
 * ================================================================
 * PELIXPLAY SCRAPER
 * ================================================================
 */

async function scrapePelixPlay({
    env,
    tmdbId,
    type,
    season,
    episode
}) {

    const started =
        Date.now();


    if (!env.SOURCE_URL) {

        return {

            success: false,

            status: "source_not_configured",

            links: [],

            elapsed_ms:
                Date.now() - started,

            error:
                "SOURCE_URL no está configurada."
        };
    }


    const sourceUrl =
        env.SOURCE_URL
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
        `${sourceUrl}/embed/api.php?${params.toString()}`;


    let response;


    try {

        response =
            await fetch(endpoint, {

                method: "GET",

                headers: {

                    "Accept":
                        "application/json",

                    "Accept-Language":
                        "es-US,es;q=0.9",

                    "User-Agent":
                        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131 Safari/537.36"
                }
            });

    } catch (error) {

        return {

            success: false,

            status: "request_error",

            links: [],

            elapsed_ms:
                Date.now() - started,

            error:
                error?.message ||
                String(error)
        };
    }


    const contentType =
        response.headers.get(
            "content-type"
        ) || "";


    if (!response.ok) {

        return {

            success: false,

            status: "http_error",

            links: [],

            http_code:
                response.status,

            content_type:
                contentType,

            elapsed_ms:
                Date.now() - started,

            error:
                `PelixPlay respondió HTTP ${response.status}.`
        };
    }


    let data;


    try {

        data =
            await response.json();

    } catch (error) {

        return {

            success: false,

            status: "invalid_json",

            links: [],

            http_code:
                response.status,

            content_type:
                contentType,

            elapsed_ms:
                Date.now() - started,

            error:
                "PelixPlay no devolvió JSON válido."
        };
    }


    let links = [];


    /*
     * ------------------------------------------------------------
     * all_embeds
     * ------------------------------------------------------------
     */

    if (
        data &&
        data.all_embeds &&
        typeof data.all_embeds === "object"
    ) {

        links =
            extractAllEmbeds(
                data.all_embeds
            );
    }


    /*
     * ------------------------------------------------------------
     * FALLBACK embeds
     * ------------------------------------------------------------
     */

    if (
        links.length === 0 &&
        data &&
        data.embeds &&
        typeof data.embeds === "object"
    ) {

        links =
            extractEmbedsFallback(
                data.embeds
            );
    }


    links =
        prepareLinks(links);


    if (links.length > 0) {

        return {

            success: true,

            status: "links_found",

            links,

            http_code:
                response.status,

            content_type:
                contentType,

            elapsed_ms:
                Date.now() - started,

            parser:
                data.all_embeds
                    ? "all_embeds"
                    : "embeds",

            error: null
        };
    }


    return {

        success: false,

        status: "no_embeds",

        links: [],

        http_code:
            response.status,

        content_type:
            contentType,

        elapsed_ms:
            Date.now() - started,

        parser: null,

        error:
            "PelixPlay respondió correctamente pero no se encontraron servidores."
    };
}


/*
 * ================================================================
 * EXTRACT ALL_EMBEDS
 * ================================================================
 */

function extractAllEmbeds(allEmbeds) {

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
                isBlacklisted(serverName)
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

                    url_embed: url,

                    servidor:
                        normalizeServerName(
                            serverName
                        ),

                    idioma
                });
            }
        }
    }


    return result;
}


/*
 * ================================================================
 * EXTRACT FALLBACK EMBEDS
 * ================================================================
 */

function extractEmbedsFallback(embeds) {

    const result = [];


    for (
        const [serverName, values]
        of Object.entries(embeds)
    ) {

        if (
            isBlacklisted(serverName)
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

                url_embed: url,

                servidor:
                    normalizeServerName(
                        serverName
                    ),

                idioma:
                    "Latino"
            });
        }
    }


    return result;
}


/*
 * ================================================================
 * SUPABASE
 * ================================================================
 */

async function fetchSupabase({
    env,
    tmdbId,
    type,
    season,
    episode
}) {

    const started =
        Date.now();


    if (!env.SUPABASE_URL) {

        return {

            success: false,

            status: "not_configured",

            links: [],

            elapsed_ms:
                Date.now() - started,

            error:
                "SUPABASE_URL no está configurada."
        };
    }


    if (!env.SUPABASE_ANON_KEY) {

        return {

            success: false,

            status: "not_configured",

            links: [],

            elapsed_ms:
                Date.now() - started,

            error:
                "SUPABASE_ANON_KEY no está configurada."
        };
    }


    const baseUrl =
        env.SUPABASE_URL
            .replace(/\/+$/, "");


    const params =
        new URLSearchParams();


    params.set(
        "select",
        [
            "tmdb_id",
            "tipo",
            "url_embed",
            "servidor",
            "idioma",
            "temporada",
            "episodio"
        ].join(",")
    );


    params.set(
        "tmdb_id",
        `eq.${tmdbId}`
    );


    params.set(
        "tipo",
        `eq.${type}`
    );


    params.set(
        "temporada",
        `eq.${season}`
    );


    params.set(
        "episodio",
        `eq.${episode}`
    );


    const endpoint =
        `${baseUrl}/rest/v1/enlaces?${params.toString()}`;


    let response;


    try {

        response =
            await fetch(endpoint, {

                method: "GET",

                headers: {

                    "apikey":
                        env.SUPABASE_ANON_KEY,

                    "Authorization":
                        `Bearer ${env.SUPABASE_ANON_KEY}`,

                    "Accept":
                        "application/json"
                }
            });

    } catch (error) {

        return {

            success: false,

            status: "request_error",

            links: [],

            elapsed_ms:
                Date.now() - started,

            error:
                error?.message ||
                String(error)
        };
    }


    const contentType =
        response.headers.get(
            "content-type"
        ) || "";


    if (!response.ok) {

        return {

            success: false,

            status: "http_error",

            links: [],

            http_code:
                response.status,

            content_type:
                contentType,

            elapsed_ms:
                Date.now() - started,

            error:
                `Supabase respondió HTTP ${response.status}.`
        };
    }


    let rows;


    try {

        rows =
            await response.json();

    } catch (error) {

        return {

            success: false,

            status: "invalid_json",

            links: [],

            http_code:
                response.status,

            content_type:
                contentType,

            elapsed_ms:
                Date.now() - started,

            error:
                "Supabase no devolvió JSON válido."
        };
    }


    if (!Array.isArray(rows)) {

        return {

            success: false,

            status: "invalid_response",

            links: [],

            http_code:
                response.status,

            content_type:
                contentType,

            elapsed_ms:
                Date.now() - started,

            error:
                "Supabase no devolvió un array."
        };
    }


    const links =
        rows

            .filter(row =>
                row &&
                isHttpUrl(
                    row.url_embed
                )
            )

            .filter(row =>
                !isBlacklisted(
                    row.servidor
                )
            )

            .map(row => ({

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

            }))

            .filter(isValidLink);


    return {

        success:
            links.length > 0,

        status:
            links.length > 0
                ? "links_found"
                : "no_links",

        links,

        http_code:
            response.status,

        content_type:
            contentType,

        elapsed_ms:
            Date.now() - started,

        parser:
            "supabase_rest",

        rows_received:
            rows.length,

        rows_valid:
            links.length,

        error: null
    };
}


/*
 * ================================================================
 * ORDEN ALPHA
 * ================================================================
 *
 * Vimeus
 * Streamwish
 * resto
 *
 * Si hay varios Vimeus o Streamwish,
 * conservan su orden original.
 * ================================================================
 */

function orderAlphaLinks(links) {

    return [...links].sort(
        (a, b) => {

            const priorityA =
                getAlphaPriority(
                    a.servidor
                );

            const priorityB =
                getAlphaPriority(
                    b.servidor
                );

            return priorityA -
                priorityB;
        }
    );
}


function getAlphaPriority(server) {

    const normalized =
        String(server || "")
            .trim()
            .toLowerCase();


    if (normalized === "vimeus") {
        return 1;
    }


    if (normalized === "streamwish") {
        return 2;
    }


    return 3;
}


/*
 * ================================================================
 * PREPARAR LINKS
 * ================================================================
 */

function prepareLinks(links) {

    if (!Array.isArray(links)) {
        return [];
    }


    return links
        .filter(isValidLink)
        .map(link => ({

            url_embed:
                link.url_embed,

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
        }));
}


/*
 * ================================================================
 * DEDUPLICACIÓN EXACTA
 * ================================================================
 *
 * IMPORTANTE:
 *
 * NO usamos:
 *
 * idioma + servidor
 *
 * porque queremos permitir:
 *
 * Streamwish
 * Streamwish 2
 *
 * etc.
 *
 * Solo eliminamos exactamente la misma:
 *
 * idioma + URL
 * ================================================================
 */

function deduplicateExactLinks(links) {

    const seen =
        new Set();

    const result = [];


    for (const link of links) {

        if (!isValidLink(link)) {
            continue;
        }


        const key =
            `${link.idioma}|${link.url_embed}`;


        if (seen.has(key)) {
            continue;
        }


        seen.add(key);

        result.push(link);
    }


    return result;
}


/*
 * ================================================================
 * NUMERAR SERVIDORES DUPLICADOS
 * ================================================================
 *
 * El contador es independiente por idioma.
 *
 * Latino:
 *   Streamwish
 *   Streamwish 2
 *
 * Castellano:
 *   Streamwish
 *   Streamwish 2
 *
 * Subtitulado:
 *   Streamwish
 *
 * ================================================================
 */

function numberDuplicateServers(links) {

    const counters =
        new Map();


    return links.map(link => {

        const baseName =
            String(
                link.servidor ||
                "Desconocido"
            ).trim();


        const idioma =
            String(
                link.idioma ||
                "Desconocido"
            ).trim();


        const key =
            `${idioma}|${baseName.toLowerCase()}`;


        const count =
            (counters.get(key) || 0) + 1;


        counters.set(
            key,
            count
        );


        return {

            ...link,

            servidor:
                count === 1
                    ? baseName
                    : `${baseName} ${count}`
        };

    });
}


/*
 * ================================================================
 * VALIDACIÓN
 * ================================================================
 */

function isValidLink(link) {

    if (
        !link ||
        typeof link !== "object"
    ) {
        return false;
    }


    if (
        !isHttpUrl(
            link.url_embed
        )
    ) {
        return false;
    }


    if (
        isBlacklisted(
            link.servidor
        )
    ) {
        return false;
    }


    return true;
}


function isHttpUrl(value) {

    return (
        typeof value === "string" &&
        /^https?:\/\//i.test(value)
    );
}


/*
 * ================================================================
 * BLACKLIST
 * ================================================================
 */

function isBlacklisted(server) {

    const normalized =
        String(server || "")
            .trim()
            .toLowerCase()
            .replace(/[\s_-]+/g, "");


    return BLACKLIST.some(blocked => {

        const b =
            blocked
                .toLowerCase()
                .replace(/[\s_-]+/g, "");


        return (
            normalized === b ||
            normalized.startsWith(b)
        );
    });
}


/*
 * ================================================================
 * NORMALIZAR SERVIDOR
 * ================================================================
 */

function normalizeServerName(server) {

    const value =
        String(server || "")
            .trim()
            .toLowerCase();


    /*
     * Permite nombres que ya vengan numerados.
     *
     * Streamwish_2
     * Streamwish_3
     *
     * vuelven a ser Streamwish antes
     * de aplicar nuestro contador.
     */

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

        streamwishes:
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

        vimeus:
            "Vimeus",

        vimeos:
            "Vimeus",

        vimeo:
            "Vimeus"
    };


    return (
        map[base] ||
        capitalize(base)
    );
}


/*
 * ================================================================
 * NORMALIZAR IDIOMA
 * ================================================================
 */

function normalizeLanguage(language) {

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


/*
 * ================================================================
 * CAPITALIZE
 * ================================================================
 */

function capitalize(value) {

    if (!value) {
        return "Desconocido";
    }


    return (
        value.charAt(0).toUpperCase() +
        value.slice(1)
    );
}


/*
 * ================================================================
 * CACHE KEYS
 * ================================================================
 */

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


function buildBetaCacheKey(
    type,
    tmdbId,
    season,
    episode
) {

    return type === "movie"

        ? `beta:movie:${tmdbId}`

        : `beta:tv:${tmdbId}:${season}:${episode}`;
}


/*
 * ================================================================
 * QUERY HELPERS
 * ================================================================
 */

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


function isBetaFallback(value) {

    if (!value) {
        return false;
    }


    return [
        "beta",
        "1",
        "true",
        "yes",
        "on"
    ].includes(
        String(value).toLowerCase()
    );
}


/*
 * ================================================================
 * JSON RESPONSE
 * ================================================================
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
        const [key, value]
        of Object.entries(CORS)
    ) {

        headers.set(
            key,
            value
        );
    }


    headers.set(
        "Cache-Control",
        "no-store"
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