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
}ng:7px 8px;font-size:12.5px;font-family:inherit;
    text-align:left;cursor:pointer;width:100%;line-height:1.25;
  }
  .menu-item:hover{background:var(--glass-hover-item);}
  .menu-item.active{background:var(--accent-dim);color:#ff8a8a;}
  .menu-item .favicon{width:15px;height:15px;border-radius:3px;flex:none;background:rgba(255,255,255,0.06);}
  .menu-item .label-group{display:flex;flex-direction:column;gap:1px;min-width:0;}
  .menu-item .name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
  .menu-item .sub{font-size:10.5px;color:var(--text-dim);}
  .menu-item.active .sub{color:#ff8a8a;opacity:.8;}

  /* Reproductor propio: <video> nativo con controles custom. El contenedor es
     absolute + inset:0, así que el <video> siempre tiene un tamaño definido. */
  .vplayer{position:absolute;inset:0;background:#000;overflow:hidden;user-select:none;-webkit-user-select:none;}
  .vplayer video{position:absolute;inset:0;width:100%;height:100%;object-fit:contain;background:#000;display:block;}

  /* Controles centrales: -10 s, play/pausa y +10 s. Se muestran u ocultan
     junto con la barra inferior; la capa no captura toques (los botones sí),
     así el toque sobre el vídeo llega siempre al <video>. */
  .vp-center{
    position:absolute;inset:0;z-index:6;display:flex;align-items:center;justify-content:center;
    gap:clamp(20px, 9vw, 48px);pointer-events:none;transition:opacity .25s;
  }
  .vp-center.hidden{opacity:0;}
  .vp-cbtn{
    pointer-events:auto;width:48px;height:48px;padding:0;border-radius:50%;cursor:pointer;color:#fff;
    background:var(--glass-bg);
    -webkit-backdrop-filter:var(--glass-blur);backdrop-filter:var(--glass-blur);
    border:1px solid var(--glass-border);box-shadow:var(--glass-highlight);
    display:flex;align-items:center;justify-content:center;transition:transform .12s, background .12s;
  }
  .vp-cbtn:active{background:var(--glass-bg-hover);transform:scale(.93);}
  .vp-cbtn.main{width:68px;height:68px;}
  .vp-center.hidden .vp-cbtn{pointer-events:none;}
  .vplayer.is-buffering .vp-cbtn.main{visibility:hidden;} /* en su lugar se ve el spinner */
  .vp-buffering{
    position:absolute;left:50%;top:50%;width:38px;height:38px;margin:-19px 0 0 -19px;z-index:6;
    border-radius:50%;border:3px solid rgba(255,255,255,0.15);border-top-color:var(--accent);
    animation:spin .8s linear infinite;display:none;pointer-events:none;
  }
  .vp-buffering.on{display:block;}

  .vp-controls{
    position:absolute;left:0;right:0;bottom:0;z-index:7;
    padding:28px 12px calc(env(safe-area-inset-bottom,0px) + 10px);
    background:linear-gradient(to top, rgba(0,0,0,0.88), rgba(0,0,0,0));
    display:flex;flex-direction:column;gap:4px;transition:opacity .25s;
  }
  .vp-controls.hidden{opacity:0;pointer-events:none;}

  /* Zona táctil de 28 px (la línea visible es más fina) para acertar con el dedo. */
  .vp-progress{position:relative;height:28px;display:flex;align-items:center;cursor:pointer;touch-action:none;}
  .vp-track{position:relative;width:100%;height:4px;border-radius:2px;background:rgba(255,255,255,0.22);transition:height .12s;}
  .vp-progress:hover .vp-track,.vp-progress.scrubbing .vp-track{height:6px;}
  .vp-buffered{position:absolute;left:0;top:0;height:100%;width:0;border-radius:2px;background:rgba(255,255,255,0.38);}
  .vp-played{position:absolute;left:0;top:0;height:100%;width:0;border-radius:2px;background:var(--accent);}
  .vp-thumb{
    position:absolute;top:50%;left:0;width:12px;height:12px;border-radius:50%;
    background:var(--accent);transform:translate(-50%,-50%);box-shadow:0 0 0 3px rgba(229,9,20,0.28);
    transition:transform .12s, box-shadow .12s;
  }
  /* Al arrastrar, el punto crece y su halo rojo se agranda. */
  .vp-progress.scrubbing .vp-thumb{transform:translate(-50%,-50%) scale(1.35);box-shadow:0 0 0 6px rgba(229,9,20,0.30);}

  .vp-row{display:flex;align-items:center;gap:6px;}
  .vp-row .spacer{flex:1;}
  .vp-btn{
    background:none;border:none;color:#fff;cursor:pointer;padding:6px;border-radius:8px;flex:none;
    display:flex;align-items:center;justify-content:center;
  }
  .vp-btn:active{background:rgba(255,255,255,0.14);}
  .vp-time{color:#eee;font-size:12px;font-variant-numeric:tabular-nums;flex:none;padding:0 4px;}

  .vp-volume{display:flex;align-items:center;}
  .vp-vol-track{position:relative;width:64px;height:16px;display:flex;align-items:center;cursor:pointer;touch-action:none;}
  .vp-vol-bg{position:relative;width:100%;height:4px;border-radius:2px;background:rgba(255,255,255,0.22);}
  .vp-vol-fill{position:absolute;left:0;top:0;height:100%;width:100%;border-radius:2px;background:#fff;}
  @media (max-width: 520px){ .vp-vol-track{display:none;} }

  /* Menú de ajustes (velocidad / calidad / audio) */
  .vp-settings{
    position:absolute;z-index:8;right:12px;
    bottom:calc(env(safe-area-inset-bottom,0px) + 62px);
    width:min(260px, calc(100% - 24px));max-height:calc(100% - 84px);overflow-y:auto;
    background:var(--glass-panel);
    -webkit-backdrop-filter:var(--glass-blur);backdrop-filter:var(--glass-blur);
    border:1px solid var(--glass-border);border-radius:12px;
    padding:5px;display:flex;flex-direction:column;gap:1px;
    box-shadow:var(--glass-highlight), 0 12px 32px rgba(0,0,0,0.6);
    /* Crece hacia arriba desde el botón de ajustes: origen abajo-derecha. */
    opacity:0;visibility:hidden;transform:translateY(6px) scale(.96);transform-origin:bottom right;
    transition:opacity .16s ease, transform .16s ease, visibility 0s linear .16s;
  }
  .vp-settings.open{
    opacity:1;visibility:visible;transform:translateY(0) scale(1);
    transition:opacity .18s ease, transform .18s ease;
  }
  .vp-mi{
    display:flex;align-items:center;gap:10px;width:100%;text-align:left;cursor:pointer;
    background:transparent;border:none;color:var(--text);font-family:inherit;font-size:13px;
    padding:9px 10px;border-radius:8px;line-height:1.2;
  }
  .vp-mi:hover,.vp-mi:active{background:var(--glass-hover-item);}
  .vp-mi-l{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
  .vp-mi-v{color:var(--text-dim);font-size:12px;flex:none;max-width:45%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
  .vp-mi-head{font-weight:600;border-bottom:1px solid var(--border);border-radius:8px 8px 0 0;margin-bottom:3px;}
  .vp-mi.active{color:#ff8a8a;}
  .vp-mi .vp-check{width:18px;height:18px;flex:none;display:flex;align-items:center;justify-content:center;color:var(--accent);}

  .empty{
    position:absolute;inset:0;display:flex;align-items:center;justify-content:center;
    color:var(--text-dim);font-size:14px;text-align:center;padding:24px;
  }

  /* Pantalla de poster / play inicial */
  .poster{
    position:absolute;inset:0;z-index:15;
    display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px;
    background:#000;opacity:1;transition:opacity .55s ease;
  }
  /* Al pulsar play el poster se desvanece (revelando el fondo del player, que
     a la vez pasa de color a blanco y negro) y deja de capturar toques. */
  .poster.leaving{opacity:0;pointer-events:none;}
  /* Backdrop del poster inicial: a color, con la misma sombra sutil de
     legibilidad que el del reproductor (nada de degradado oscuro). */
  .poster-backdrop{
    position:absolute;inset:0;background-size:cover;background-position:center;opacity:0;
    box-shadow:inset 0 0 0 2000px rgba(0,0,0,0.18);
    transition:opacity .5s ease;
  }
  .poster-backdrop.visible{opacity:1;}
  .poster-logo{position:absolute;top:calc(env(safe-area-inset-top,0px) + 18px);left:20px;z-index:2;height:26px;}
  .poster-logo img{height:100%;display:block;}

  /* Rótulo "Estás viendo" sobre el reproductor, centrado en la barra superior
     entre los botones de idioma y servidor. */
  .watching{
    display:none;flex:1;min-width:0;flex-direction:column;align-items:center;gap:1px;
    pointer-events:none;
  }
  .watching.visible{display:flex;animation:watchingIn .5s ease both;}
  @keyframes watchingIn{from{opacity:0;transform:translateY(-4px);}to{opacity:1;transform:none;}}
  .watching-kicker{font-size:9.5px;letter-spacing:.13em;text-transform:uppercase;color:var(--text-dim);font-weight:600;}
  .watching-title{font-size:12px;font-weight:600;color:var(--text);
    overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:100%;}
  /* Título grande + año, centrados debajo del botón de play (como en la
     referencia): sin rótulo arriba, sin degradado ni sombra en el fondo. */
  .poster-content{
    position:relative;z-index:2;display:flex;flex-direction:column;align-items:center;gap:16px;
    padding:0 32px;text-align:center;
  }
  .play-btn{
    width:46px;height:46px;border-radius:50%;background:#fff;border:none;cursor:pointer;
    display:flex;align-items:center;justify-content:center;
    transition:transform .15s;
  }
  .play-btn:active{transform:scale(.94);}
  .play-btn iconify-icon{color:#000;margin-left:2px;}
  .poster-heading{display:flex;flex-direction:column;align-items:center;gap:5px;}
  .poster-heading-title{
    font-size:20px;font-weight:800;letter-spacing:.02em;text-transform:uppercase;color:var(--text);
    line-height:1.15;overflow-wrap:break-word;
  }
  .poster-heading-year{font-size:10px;font-weight:500;color:var(--text-dim);}
  /* Accesibilidad: quien pide menos movimiento no ve transiciones ni animaciones
     (el spinner se mantiene: es un indicador de carga, no decoración). */
  @media (prefers-reduced-motion: reduce){
    *,*::before,*::after{transition-duration:.01ms !important;transition-delay:0s !important;}
    .watching.visible{animation:none;}
  }
</style>
</head>
<body>
<div id="app">
  <div class="poster" id="poster">
    <div class="poster-backdrop" id="posterBackdrop"></div>
    <div class="poster-logo"><img src="${LOGO_DATA_URI}" alt="" /></div>
    <div class="poster-content">
      <button class="play-btn" id="playBtn" type="button" aria-label="Reproducir">
        <iconify-icon icon="uil:play" width="18" height="18"></iconify-icon>
      </button>
      <div class="poster-heading" id="posterHeading" style="display:none;">
        <span class="poster-heading-title" id="posterHeadingTitle"></span>
        <span class="poster-heading-year" id="posterHeadingYear" style="display:none;"></span>
      </div>
    </div>
  </div>

  <div class="player-wrap" id="playerWrap">
    <div class="backdrop" id="backdrop"></div>
    <div class="state" id="playerState">
      <div class="spinner"></div>
      <div>Buscando servidores...</div>
    </div>
  </div>

  <div class="top-bar" id="topBar" style="display:none;">
    <div class="menu left" id="langMenu">
      <button class="menu-btn" id="langBtn" type="button" aria-label="Idioma">
        <iconify-icon id="langFlag" icon="circle-flags:xx" width="18" height="18" style="display:none;"></iconify-icon>
        <iconify-icon icon="uil:globe" width="17" height="17" id="langIcon"></iconify-icon>
        <iconify-icon icon="uil:angle-down" width="13" height="13" class="chev"></iconify-icon>
      </button>
      <div class="menu-panel" id="langPanel"></div>
    </div>

    <div class="watching" id="watching">
      <span class="watching-kicker">Estás viendo</span>
      <span class="watching-title" id="watchingTitle"></span>
    </div>

    <div class="menu right" id="serverMenu">
      <button class="menu-btn" id="serverBtn" type="button" aria-label="Servidor">
        <iconify-icon icon="uil:cloud" width="17" height="17"></iconify-icon>
        <iconify-icon icon="uil:angle-down" width="13" height="13" class="chev"></iconify-icon>
      </button>
      <div class="menu-panel" id="serverPanel"></div>
    </div>
  </div>

  <div class="empty" id="emptyState" style="display:none;">No hay servidores disponibles para este contenido.</div>
</div>

<script>
(function(){
  var API_PATH = ${JSON.stringify(apiPath)};
  var BACKDROP_PATH = ${JSON.stringify(backdropApiPath)};
  var CONTENT_KIND = ${JSON.stringify(params.kind)};
  var CONTENT_SEASON = ${JSON.stringify(params.season || null)};
  var CONTENT_EPISODE = ${JSON.stringify(params.episode || null)};

  var playerWrap = document.getElementById('playerWrap');
  var backdropEl = document.getElementById('backdrop');
  var topBar = document.getElementById('topBar');
  var emptyState = document.getElementById('emptyState');

  var poster = document.getElementById('poster');
  var posterBackdrop = document.getElementById('posterBackdrop');
  var posterHeading = document.getElementById('posterHeading');
  var posterHeadingTitle = document.getElementById('posterHeadingTitle');
  var posterHeadingYear = document.getElementById('posterHeadingYear');
  var playBtn = document.getElementById('playBtn');
  var watching = document.getElementById('watching');
  var watchingTitle = document.getElementById('watchingTitle');

  var langMenu = document.getElementById('langMenu');
  var langBtn = document.getElementById('langBtn');
  var langPanel = document.getElementById('langPanel');
  var langFlag = document.getElementById('langFlag');
  var langIcon = document.getElementById('langIcon');

  var serverMenu = document.getElementById('serverMenu');
  var serverBtn = document.getElementById('serverBtn');
  var serverPanel = document.getElementById('serverPanel');

  var allServers = [];
  var currentLang = null;
  var currentServer = null;

  function escapeHtml(str){
    return String(str).replace(/[&<>"']/g, function(c){
      return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];
    });
  }

  function setPlayerState(html){
    destroyPlayer();
    // Se quita todo MENOS el fondo: si se reinsertara, perdería su transición
    // de color a blanco y negro y saltaría directo al estado final.
    Array.prototype.slice.call(playerWrap.children).forEach(function(ch){
      if(ch !== backdropEl) playerWrap.removeChild(ch);
    });
    if(backdropEl.parentNode !== playerWrap) playerWrap.appendChild(backdropEl);
    var div = document.createElement('div');
    div.className = 'state';
    div.innerHTML = html;
    playerWrap.appendChild(div);
  }

  var tmdbInfo = null; // { url, title, year } — cache local en memoria, sin KV.
  var contentLine = null; // "Título (Año)" o "Título (Año) T1E1", para el rótulo sobre el player.
  var playbackStarted = false; // true tras pulsar play; si TMDB responde después, igual se muestra.

  function loadInfo(){
    fetch(BACKDROP_PATH)
      .then(function(res){ return res.json(); })
      .then(function(data){
        if(!data || !data.success) return;
        tmdbInfo = data;

        if(data.url){
          posterBackdrop.style.backgroundImage = 'url(' + data.url + ')';
          posterBackdrop.classList.add('visible');
          // El fondo del player (blanco y negro) queda preparado pero oculto:
          // entra al pulsar play, con la transición de color a griseado.
          backdropEl.style.backgroundImage = 'url(' + data.url + ')';
          if(playbackStarted) backdropEl.classList.add('visible');
        }
        if(data.title){
          // Rótulo "Estás viendo" (sobre el reproductor): una sola línea.
          var line = data.title;
          if(data.year) line += ' (' + data.year + ')';
          if(CONTENT_KIND === 'tv' && CONTENT_SEASON && CONTENT_EPISODE){
            line += ' T' + CONTENT_SEASON + 'E' + CONTENT_EPISODE;
          }
          contentLine = line;
          watchingTitle.textContent = line;
          if(playbackStarted) watching.classList.add('visible');

          // Poster inicial: título grande arriba, año (+ temporada/episodio
          // si es serie) en una segunda línea más pequeña debajo, como en
          // la referencia visual.
          posterHeadingTitle.textContent = data.title;
          var sub = data.year || '';
          if(CONTENT_KIND === 'tv' && CONTENT_SEASON && CONTENT_EPISODE){
            sub += (sub ? ' · ' : '') + 'T' + CONTENT_SEASON + 'E' + CONTENT_EPISODE;
          }
          if(sub){
            posterHeadingYear.textContent = sub;
            posterHeadingYear.style.display = 'block';
          }
          posterHeading.style.display = 'flex';
        }
      })
      .catch(function(){ /* decorativo: silenciosamente ignorado */ });
  }

  function closeMenus(except){
    if(except !== langMenu) langMenu.classList.remove('open');
    if(except !== serverMenu) serverMenu.classList.remove('open');
  }

  function toggleMenu(menu){
    var willOpen = !menu.classList.contains('open');
    closeMenus(null);
    if(willOpen) menu.classList.add('open');
  }

  langBtn.addEventListener('click', function(e){ e.stopPropagation(); toggleMenu(langMenu); });
  serverBtn.addEventListener('click', function(e){ e.stopPropagation(); toggleMenu(serverMenu); });
  document.addEventListener('click', function(){ closeMenus(null); });

  function init(){
    loadInfo();
  }

  playBtn.addEventListener('click', function(){
    if(playbackStarted) return; // evita dobles toques durante el fundido
    playbackStarted = true;
    // Fundido del poster + el fondo del player pasa de color a blanco y negro.
    poster.classList.add('leaving');
    backdropEl.classList.add('visible');
    setTimeout(function(){ poster.style.display = 'none'; }, 600);
    if(contentLine){
      watchingTitle.textContent = contentLine;
      watching.classList.add('visible');
    }
    startPlayback();
  });

  async function startPlayback(){
    try{
      var res = await fetch(API_PATH);
      var data = await res.json();

      if(!data.success || !Array.isArray(data.servers) || data.servers.length === 0){
        setPlayerState('<div>Contenido no disponible por el momento</div>');
        emptyState.style.display = 'flex';
        return;
      }

      allServers = data.servers;
      topBar.style.display = 'flex';

      buildLangPanel();
      selectLanguage(allServers[0].idioma);
    }catch(err){
      setPlayerState('<div>No se pudo cargar el contenido</div>');
    }
  }

  function uniqueLanguages(){
    var seen = {};
    var list = [];
    allServers.forEach(function(s){
      if(!seen[s.idioma]){ seen[s.idioma] = true; list.push(s.idioma); }
    });
    return list;
  }

  // Mapeo de nombres de idioma (tal como los entrega el Finder) a un código
  // de país para Circle Flags. Es heurístico: cubre los casos más comunes en
  // plataformas de streaming en español; si no hay match, no se muestra bandera.
  var LANG_FLAG_MAP = {
    'latino': 'mx',
    'español latino': 'mx',
    'espanol latino': 'mx',
    'castellano': 'es',
    'español': 'es',
    'espanol': 'es',
    'español (españa)': 'es',
    'ingles': 'us',
    'inglés': 'us',
    'english': 'us',
    'subtitulado': 'us',
    'subtitulado español': 'us',
    'vose': 'us',
    'vos': 'us',
    'portugues': 'pt',
    'portugués': 'pt',
    'brasileño': 'br',
    'brasil': 'br',
    'frances': 'fr',
    'francés': 'fr',
    'aleman': 'de',
    'alemán': 'de',
    'italiano': 'it',
    'japones': 'jp',
    'japonés': 'jp',
    'coreano': 'kr'
  };

  function flagCodeForLanguage(lang){
    if(!lang) return null;
    var key = String(lang).trim().toLowerCase();
    return LANG_FLAG_MAP[key] || null;
  }

  function flagIconHtml(lang){
    var code = flagCodeForLanguage(lang);
    if(!code) return '<span class="favicon"></span>';
    return '<iconify-icon class="favicon" icon="circle-flags:' + code + '" width="16" height="16"></iconify-icon>';
  }

  function buildLangPanel(){
    var langs = uniqueLanguages();
    langPanel.innerHTML = '';
    langs.forEach(function(lang){
      var item = document.createElement('button');
      item.className = 'menu-item';
      item.type = 'button';
      item.innerHTML = flagIconHtml(lang) +
        '<span class="label-group"><span class="name">' + escapeHtml(lang) + '</span></span>';
      item.addEventListener('click', function(e){
        e.stopPropagation();
        selectLanguage(lang);
        closeMenus(null);
      });
      langPanel.appendChild(item);
    });
  }

  function selectLanguage(lang){
    currentLang = lang;

    var code = flagCodeForLanguage(lang);
    if(code){
      langFlag.setAttribute('icon', 'circle-flags:' + code);
      langFlag.style.display = 'inline-block';
      langIcon.style.display = 'none';
    } else {
      langFlag.style.display = 'none';
      langIcon.style.display = 'inline-block';
    }

    Array.prototype.forEach.call(langPanel.children, function(el, i){
      el.classList.toggle('active', uniqueLanguages()[i] === lang);
    });

    var filtered = allServers.filter(function(s){ return s.idioma === lang; });
    buildServerPanel(filtered);

    if(filtered.length > 0){
      selectServer(filtered[0]);
    } else {
      setPlayerState('<div>No hay servidores para este idioma</div>');
    }
  }

  function faviconUrl(domain){
    if(!domain) return null;
    return 'https://www.google.com/s2/favicons?sz=64&domain=' + encodeURIComponent(domain);
  }

  function buildServerPanel(servers){
    serverPanel.innerHTML = '';
    servers.forEach(function(s){
      var item = document.createElement('button');
      item.className = 'menu-item';
      item.type = 'button';
      item.setAttribute('data-server-id', s.id);

      var favicon = faviconUrl(s.domain);
      var faviconHtml = favicon
        ? '<img class="favicon" src="' + favicon + '" alt="" loading="lazy" data-fallback-hide="1" />'
        : '<span class="favicon"></span>';

      item.innerHTML = faviconHtml +
        '<span class="label-group">' +
          '<span class="name">' + escapeHtml(s.servidor) + '</span>' +
          '<span class="sub">' + escapeHtml(s.calidad) + '</span>' +
        '</span>';
      item.addEventListener('click', function(e){
        e.stopPropagation();
        selectServer(s);
        closeMenus(null);
      });
      serverPanel.appendChild(item);

      var faviconImg = item.querySelector('img.favicon');
      if(faviconImg){
        faviconImg.addEventListener('error', function(){
          faviconImg.style.visibility = 'hidden';
        });
      }
    });
  }

  async function selectServer(server){
    currentServer = server;
    Array.prototype.forEach.call(serverPanel.children, function(el){
      el.classList.toggle('active', el.getAttribute('data-server-id') === server.id);
    });

    setPlayerState('<div class="spinner"></div><div>Buscando reproducción...</div>');

    try{
      var res = await fetch('/api/resolve?token=' + encodeURIComponent(server.token));
      var data = await res.json();

      // Diagnóstico visible en la consola del navegador (sin secretos):
      // mode = "mediaflow" (HLS ok) o "iframe_fallback"; reason = por qué
      // MediaFlow no se usó (ej. mediaflow_not_configured, mediaflow_status_401).
      console.log('[player] resolve', server.servidor, '->', data.mode || data.error, data.reason || '');

      if(!data.success){
        setPlayerState('<div>No se pudo procesar este servidor</div>');
        return;
      }

      mountPlayer(data, server);
    }catch(err){
      setPlayerState('<div>No se pudo procesar este servidor</div>');
    }
  }

  function mountPlayer(data, server){
    destroyPlayer();
    playerWrap.innerHTML = '';

    if(data.type === 'hls' && data.url){
      buildCustomPlayer(data.url, server);
    } else if(data.type === 'iframe' && data.url){
      mountIframe(data.url);
    } else {
      setPlayerState('<div>No se pudo procesar este servidor</div>');
    }
  }

  function mountIframe(url){
    destroyPlayer();
    playerWrap.innerHTML = '';
    var iframe = document.createElement('iframe');
    iframe.src = url;
    iframe.allow = 'autoplay; fullscreen; picture-in-picture';
    iframe.allowFullscreen = true;
    playerWrap.appendChild(iframe);
  }

  var fallbackTriggered = false;

  // Si el HLS resuelto por MediaFlow falla en tiempo de reproducción (404,
  // error de red, manifest corrupto, etc.), en vez de dejar el player
  // pausado/roto se pide directamente el iframe original del mismo servidor
  // (sin reintentar MediaFlow) y se reemplaza el player por él.
  function fallbackToIframeOnError(server){
    if(fallbackTriggered) return;
    // Si el usuario ya cambió a otro servidor, este error no le corresponde.
    if(currentServer && server && currentServer.id !== server.id) return;
    fallbackTriggered = true;

    setPlayerState('<div class="spinner"></div><div>Buscando reproducción...</div>');

    fetch('/api/resolve?token=' + encodeURIComponent(server.token) + '&force_iframe=1')
      .then(function(res){ return res.json(); })
      .then(function(data){
        if(data && data.success && data.type === 'iframe' && data.url){
          mountIframe(data.url);
        } else {
          setPlayerState('<div>No se pudo procesar este servidor</div>');
        }
      })
      .catch(function(){
        setPlayerState('<div>No se pudo procesar este servidor</div>');
      });
  }

  // ---------------------------------------------------------------
  // Reproductor propio: <video> nativo + hls.js (solo motor) + controles
  // custom con Tabler Icons (Iconify).
  // ---------------------------------------------------------------
  var activePlayer = null; // { destroy() } del reproductor montado

  function destroyPlayer(){
    if(activePlayer){
      try{ activePlayer.destroy(); }catch(e){}
      activePlayer = null;
    }
  }

  function fmtTime(sec){
    if(!isFinite(sec) || sec < 0) sec = 0;
    sec = Math.floor(sec);
    var h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    var ss = (s < 10 ? '0' : '') + s;
    return h > 0 ? (h + ':' + (m < 10 ? '0' : '') + m + ':' + ss) : (m + ':' + ss);
  }

  function icon(name, size){
    return '<iconify-icon icon="tabler:' + name + '" width="' + size + '" height="' + size + '"></iconify-icon>';
  }

  function buildCustomPlayer(url, server){
    fallbackTriggered = false;

    var wrap = document.createElement('div');
    wrap.className = 'vplayer';
    wrap.tabIndex = 0;

    var video = document.createElement('video');
    video.playsInline = true;
    video.setAttribute('playsinline', '');
    video.autoplay = true;
    wrap.appendChild(video);

    wrap.insertAdjacentHTML('beforeend',
      '<div class="vp-buffering" data-r="buffering"></div>' +
      '<div class="vp-center" data-r="centerLayer">' +
        '<button class="vp-cbtn" type="button" data-r="back" aria-label="Retroceder 10 segundos">' + icon('rewind-backward-10', 30) + '</button>' +
        '<button class="vp-cbtn main" type="button" data-r="center" aria-label="Reproducir/Pausar">' + icon('player-play-filled', 34) + '</button>' +
        '<button class="vp-cbtn" type="button" data-r="fwd" aria-label="Adelantar 10 segundos">' + icon('rewind-forward-10', 30) + '</button>' +
      '</div>' +
      '<div class="vp-controls" data-r="controls">' +
        '<div class="vp-progress" data-r="progress"><div class="vp-track" data-r="track">' +
          '<div class="vp-buffered" data-r="buffered"></div><div class="vp-played" data-r="played"></div><div class="vp-thumb" data-r="thumb"></div>' +
        '</div></div>' +
        '<div class="vp-row">' +
          '<button class="vp-btn" type="button" data-r="play" aria-label="Reproducir/Pausar">' + icon('player-play-filled', 22) + '</button>' +
          '<div class="vp-volume">' +
            '<button class="vp-btn" type="button" data-r="mute" aria-label="Silenciar">' + icon('volume', 22) + '</button>' +
            '<div class="vp-vol-track" data-r="volTrack"><div class="vp-vol-bg"><div class="vp-vol-fill" data-r="volFill"></div></div></div>' +
          '</div>' +
          '<span class="vp-time" data-r="time">0:00 / 0:00</span>' +
          '<span class="spacer"></span>' +
          '<button class="vp-btn" type="button" data-r="gear" aria-label="Ajustes">' + icon('settings', 22) + '</button>' +
          '<button class="vp-btn" type="button" data-r="pip" aria-label="Picture in Picture">' + icon('picture-in-picture', 22) + '</button>' +
          '<button class="vp-btn" type="button" data-r="fs" aria-label="Pantalla completa">' + icon('maximize', 22) + '</button>' +
        '</div>' +
      '</div>' +
      '<div class="vp-settings" data-r="settings"></div>');
    playerWrap.appendChild(wrap);

    var r = {};
    Array.prototype.forEach.call(wrap.querySelectorAll('[data-r]'), function(el){ r[el.getAttribute('data-r')] = el; });
    function setIcon(btn, name){ btn.querySelector('iconify-icon').setAttribute('icon', 'tabler:' + name); }

    var hls = null, hideTimer = null, startTimer = null, disposed = false, mediaRecovered = false;
    var started = false;

    // ---- Ajustes: velocidad, calidad y audio ----
    var SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2];
    var menuView = null; // null = cerrado | 'main' | 'speed' | 'quality' | 'audio'
    var langNames = null;
    try{ langNames = new Intl.DisplayNames(['es'], { type: 'language' }); }catch(e){}

    function esc(s){ return escapeHtml(String(s)); }

    // Calidades que expone el manifest (solo si hay 2 o más).
    function qualityOptions(){
      if(!hls || !hls.levels || hls.levels.length < 2) return [];
      var opts = hls.levels.map(function(lv, i){
        var kbps = Math.round((lv.bitrate || 0) / 1000);
        return { index: i, height: lv.height || 0, kbps: kbps, base: lv.height ? lv.height + 'p' : (kbps + ' kbps') };
      });
      var count = {};
      opts.forEach(function(o){ count[o.base] = (count[o.base] || 0) + 1; });
      opts.forEach(function(o){ o.label = count[o.base] > 1 ? (o.base + ' · ' + o.kbps + ' kbps') : o.base; });
      opts.sort(function(a, b){ return (b.height - a.height) || (b.kbps - a.kbps); });
      return opts;
    }

    // Pistas de audio que expone el manifest (solo si hay 2 o más).
    function audioOptions(){
      if(!hls || !hls.audioTracks || hls.audioTracks.length < 2) return [];
      var opts = hls.audioTracks.map(function(t, i){
        var name = t.name ? String(t.name).trim() : '';
        var lang = t.lang ? String(t.lang).trim() : '';
        var pretty = '';
        if(lang && langNames){ try{ pretty = langNames.of(lang) || ''; }catch(e){} }
        return { index: i, name: name, label: pretty || name || lang || ('Pista ' + (i + 1)) };
      });
      var count = {};
      opts.forEach(function(o){ count[o.label] = (count[o.label] || 0) + 1; });
      opts.forEach(function(o){ if(count[o.label] > 1) o.label += ' · ' + (o.name || (o.index + 1)); });
      return opts;
    }

    function speedText(){ return video.playbackRate === 1 ? 'Normal' : (video.playbackRate + 'x'); }
    function qualityText(){
      if(!hls) return '';
      if(hls.autoLevelEnabled){
        var lv = hls.levels && hls.levels[hls.currentLevel];
        return lv && lv.height ? ('Auto (' + lv.height + 'p)') : 'Auto';
      }
      var cur = hls.levels && hls.levels[hls.currentLevel];
      return cur ? (cur.height ? cur.height + 'p' : Math.round((cur.bitrate || 0) / 1000) + ' kbps') : 'Auto';
    }
    function audioText(){
      var sel = null;
      audioOptions().forEach(function(o){ if(o.index === hls.audioTrack) sel = o; });
      return sel ? sel.label : '';
    }

    function menuRow(view, iconName, label, value){
      return '<button class="vp-mi" type="button" data-act="open" data-val="' + view + '">' +
        icon(iconName, 18) + '<span class="vp-mi-l">' + esc(label) + '</span>' +
        '<span class="vp-mi-v">' + esc(value) + '</span>' + icon('chevron-right', 16) + '</button>';
    }
    function menuOption(val, label, active){
      return '<button class="vp-mi' + (active ? ' active' : '') + '" type="button" data-act="pick" data-val="' + esc(val) + '">' +
        '<span class="vp-check">' + (active ? icon('check', 16) : '') + '</span>' +
        '<span class="vp-mi-l">' + esc(label) + '</span></button>';
    }

    function renderMenu(){
      if(!menuView){ r.settings.classList.remove('open'); return; }
      var q = qualityOptions(), a = audioOptions(), html = '';
      // Si la sección abierta dejó de existir (p. ej. cambió el manifest), volver al menú principal.
      if((menuView === 'quality' && !q.length) || (menuView === 'audio' && !a.length)) menuView = 'main';

      if(menuView === 'main'){
        html += menuRow('speed', 'gauge', 'Velocidad', speedText());
        if(q.length) html += menuRow('quality', 'adjustments-horizontal', 'Calidad', qualityText());
        if(a.length) html += menuRow('audio', 'language', 'Audio', audioText());
      } else {
        var titles = { speed: 'Velocidad', quality: 'Calidad', audio: 'Audio' };
        html += '<button class="vp-mi vp-mi-head" type="button" data-act="back">' + icon('chevron-left', 18) +
                '<span class="vp-mi-l">' + titles[menuView] + '</span></button>';
        if(menuView === 'speed'){
          SPEEDS.forEach(function(s){ html += menuOption(String(s), s === 1 ? 'Normal' : (s + 'x'), video.playbackRate === s); });
        } else if(menuView === 'quality'){
          html += menuOption('-1', 'Auto', hls.autoLevelEnabled);
          q.forEach(function(o){ html += menuOption(String(o.index), o.label, !hls.autoLevelEnabled && hls.currentLevel === o.index); });
        } else if(menuView === 'audio'){
          a.forEach(function(o){ html += menuOption(String(o.index), o.label, hls.audioTrack === o.index); });
        }
      }
      r.settings.innerHTML = html;
      r.settings.classList.add('open');
    }

    function openMenu(){ menuView = 'main'; renderMenu(); showControls(); }
    function closeMenu(){ menuView = null; renderMenu(); showControls(); }
    function refreshMenuIfOpen(){ if(menuView) renderMenu(); }

    function applyChoice(view, val){
      if(view === 'speed'){ video.playbackRate = parseFloat(val); }
      else if(view === 'quality' && hls){ hls.currentLevel = parseInt(val, 10); } // -1 = automática
      else if(view === 'audio' && hls){ hls.audioTrack = parseInt(val, 10); }
    }

    r.gear.addEventListener('click', function(){ if(menuView){ closeMenu(); } else { openMenu(); } });
    r.settings.addEventListener('click', function(e){
      var t = e.target && e.target.closest ? e.target.closest('[data-act]') : null;
      if(!t) return;
      var act = t.getAttribute('data-act'), val = t.getAttribute('data-val');
      if(act === 'open'){ menuView = val; }
      else if(act === 'back'){ menuView = 'main'; }
      else if(act === 'pick'){ applyChoice(menuView, val); menuView = 'main'; }
      renderMenu();
      if(e.stopPropagation) e.stopPropagation();
    });
    video.addEventListener('ratechange', refreshMenuIfOpen);


    function fail(reason){
      if(disposed) return;
      console.log('[player] error de reproducción ->', reason, '-> embed');
      fallbackToIframeOnError(server);
    }

    // ---- Carga del stream: hls.js (motor) o HLS nativo (Safari/iOS) ----
    if(window.Hls && Hls.isSupported()){
      hls = new Hls({ enableWorker: true, lowLatencyMode: false });
      hls.on(Hls.Events.MANIFEST_PARSED, refreshMenuIfOpen);
      hls.on(Hls.Events.LEVEL_SWITCHED, refreshMenuIfOpen);
      hls.on(Hls.Events.AUDIO_TRACKS_UPDATED, refreshMenuIfOpen);
      hls.on(Hls.Events.AUDIO_TRACK_SWITCHED, refreshMenuIfOpen);
      hls.on(Hls.Events.ERROR, function(ev, data){
        if(!data || !data.fatal) return;
        var detail = data.type + '/' + data.details + (data.response && data.response.code !== undefined ? ' (HTTP ' + data.response.code + ')' : '');
        // Un único intento de recuperación para errores de decodificación.
        if(data.type === Hls.ErrorTypes.MEDIA_ERROR && !mediaRecovered){
          mediaRecovered = true;
          console.log('[player] hls media error, reintentando:', detail);
          hls.recoverMediaError();
          return;
        }
        // Red caída, 404, código 0, manifest inválido, etc.: directo al embed.
        fail(detail);
      });
      hls.loadSource(url);
      hls.attachMedia(video);
    } else if(video.canPlayType('application/vnd.apple.mpegurl')){
      video.src = url;
    } else {
      fail('navegador sin soporte HLS');
      return;
    }

    video.addEventListener('error', function(){
      var e = video.error;
      fail('video.error ' + (e ? e.code : '?'));
    });

    // Red de seguridad: si en 15 s no hay ni metadatos ni reproducción.
    startTimer = setTimeout(function(){ if(!started) fail('sin respuesta en 15 s'); }, 15000);
    function markStarted(){ started = true; clearTimeout(startTimer); }
    video.addEventListener('loadedmetadata', function(){
      markStarted();
      var b = video.getBoundingClientRect();
      console.log('[player] video ' + (video.videoWidth || 0) + 'x' + (video.videoHeight || 0) + ' | elemento ' + Math.round(b.width) + 'x' + Math.round(b.height));
      updateProgress();
    });
    video.addEventListener('playing', markStarted);
    video.addEventListener('canplay', markStarted);

    // ---- Play / pausa ----
    function refreshPlayIcons(){
      var n = video.paused ? 'player-play-filled' : 'player-pause-filled';
      setIcon(r.play, n); setIcon(r.center, n);
    }
    function togglePlay(){
      if(video.paused){ var p = video.play(); if(p && p.catch) p.catch(function(){}); } else { video.pause(); }
    }
    r.play.addEventListener('click', togglePlay);
    r.center.addEventListener('click', togglePlay);
    // Tocar el vídeo ya NO pausa/reproduce: muestra u oculta la interfaz.
    // Con ratón los controles ya aparecen al mover el puntero, así que un
    // clic solo los muestra; con dedo/lápiz el toque los alterna.
    video.addEventListener('click', function(){
      if(menuView){ closeMenu(); return; } // el primer toque solo cierra el menú
      if(controlsHidden() || lastPointerType === 'mouse'){ showControls(); }
      else { hideControls(); }
    });
    video.addEventListener('play', function(){ refreshPlayIcons(); showControls(); });
    video.addEventListener('pause', function(){ refreshPlayIcons(); showControls(); });
    function setBuffering(on){
      if(on){ r.buffering.classList.add('on'); wrap.classList.add('is-buffering'); }
      else { r.buffering.classList.remove('on'); wrap.classList.remove('is-buffering'); }
    }
    video.addEventListener('waiting', function(){ setBuffering(true); });
    video.addEventListener('playing', function(){ setBuffering(false); refreshPlayIcons(); });
    video.addEventListener('canplay', function(){ setBuffering(false); });

    // ---- ±10 s ----
    r.back.addEventListener('click', function(){ video.currentTime = Math.max(0, video.currentTime - 10); });
    r.fwd.addEventListener('click', function(){
      var d = isFinite(video.duration) ? video.duration : Infinity;
      video.currentTime = Math.min(d, video.currentTime + 10);
    });

    // ---- Progreso ----
    // La línea roja y el punto siguen al dedo/puntero al instante (no esperan
    // al reloj del vídeo). El salto real se aplica al soltar, para no lanzar
    // decenas de peticiones HLS mientras se arrastra.
    var scrubbing = false;   // arrastrando/tocando la barra
    var pendingSeek = false; // salto aplicado, esperando el evento "seeked"
    var scrubFrac = 0;       // posición elegida (0..1)

    function paintProgress(frac){
      var pct = Math.min(100, Math.max(0, frac * 100));
      r.played.style.width = pct + '%';
      r.thumb.style.left = pct + '%';
    }
    function canScrub(){ return video.duration && isFinite(video.duration); }
    function updateProgress(){
      var d = video.duration;
      var hasDur = d && isFinite(d);
      var following = scrubbing || pendingSeek; // mostrar lo elegido, no el reloj
      if(hasDur){
        if(!following) paintProgress(video.currentTime / d);
        if(video.buffered.length){
          var end = video.buffered.end(video.buffered.length - 1);
          r.buffered.style.width = Math.min(100, (end / d) * 100) + '%';
        }
      }
      var shown = (following && hasDur) ? scrubFrac * d : video.currentTime;
      r.time.textContent = fmtTime(shown) + ' / ' + fmtTime(d);
    }
    video.addEventListener('timeupdate', updateProgress);
    video.addEventListener('progress', updateProgress);
    video.addEventListener('durationchange', updateProgress);
    video.addEventListener('seeked', function(){ pendingSeek = false; updateProgress(); });

    function pointerFraction(el, ev){
      var b = el.getBoundingClientRect();
      return Math.min(1, Math.max(0, (ev.clientX - b.left) / b.width));
    }
    function scrubTo(ev){
      scrubFrac = pointerFraction(r.track, ev);
      paintProgress(scrubFrac);
      updateProgress();
    }
    function endScrub(commit){
      if(!scrubbing) return;
      scrubbing = false;
      r.progress.classList.remove('scrubbing');
      if(commit && canScrub()){
        pendingSeek = true;
        video.currentTime = scrubFrac * video.duration;
      }
      updateProgress();
      showControls(); // reinicia la cuenta atrás de auto-ocultado
    }
    r.progress.addEventListener('pointerdown', function(ev){
      if(!canScrub()) return;
      scrubbing = true;
      r.progress.classList.add('scrubbing');
      r.progress.setPointerCapture(ev.pointerId);
      scrubTo(ev);
    });
    r.progress.addEventListener('pointermove', function(ev){ if(scrubbing) scrubTo(ev); });
    r.progress.addEventListener('pointerup', function(ev){
      if(!scrubbing) return;
      scrubTo(ev);
      endScrub(true);
    });
    r.progress.addEventListener('pointercancel', function(){ endScrub(false); });

    // ---- Volumen ----
    function refreshVolume(){
      var v = video.muted ? 0 : video.volume;
      r.volFill.style.width = (v * 100) + '%';
      setIcon(r.mute, v === 0 ? 'volume-3' : (v < 0.5 ? 'volume-2' : 'volume'));
    }
    r.mute.addEventListener('click', function(){ video.muted = !video.muted; refreshVolume(); });
    var draggingVol = false;
    function setVol(ev){
      var f = pointerFraction(r.volTrack, ev);
      video.volume = f; video.muted = f === 0; refreshVolume();
    }
    r.volTrack.addEventListener('pointerdown', function(ev){ draggingVol = true; r.volTrack.setPointerCapture(ev.pointerId); setVol(ev); });
    r.volTrack.addEventListener('pointermove', function(ev){ if(draggingVol) setVol(ev); });
    r.volTrack.addEventListener('pointerup', function(){ draggingVol = false; });
    video.addEventListener('volumechange', refreshVolume);
    refreshVolume();

    // ---- Picture in Picture ----
    if(document.pictureInPictureEnabled && !video.disablePictureInPicture){
      r.pip.addEventListener('click', function(){
        if(document.pictureInPictureElement){ document.exitPictureInPicture().catch(function(){}); }
        else { video.requestPictureInPicture().catch(function(){}); }
      });
    } else {
      r.pip.style.display = 'none';
    }

    // ---- Pantalla completa (iPhone solo permite fullscreen del <video>) ----
    function inFullscreen(){ return !!(document.fullscreenElement || document.webkitFullscreenElement || video.webkitDisplayingFullscreen); }
    r.fs.addEventListener('click', function(){
      if(inFullscreen()){
        if(document.exitFullscreen) document.exitFullscreen().catch(function(){});
        else if(document.webkitExitFullscreen) document.webkitExitFullscreen();
        else if(video.webkitExitFullscreen) video.webkitExitFullscreen();
      } else if(wrap.requestFullscreen){
        wrap.requestFullscreen().catch(function(){});
      } else if(wrap.webkitRequestFullscreen){
        wrap.webkitRequestFullscreen();
      } else if(video.webkitEnterFullscreen){
        video.webkitEnterFullscreen();
      }
    });
    function onFsChange(){ setIcon(r.fs, inFullscreen() ? 'minimize' : 'maximize'); }
    document.addEventListener('fullscreenchange', onFsChange);
    document.addEventListener('webkitfullscreenchange', onFsChange);

    // ---- Auto-ocultar controles ----
    var lastPointerType = 'mouse';
    function controlsHidden(){ return r.controls.classList.contains('hidden'); }
    function hideControls(){
      clearTimeout(hideTimer);
      r.controls.classList.add('hidden');
      r.centerLayer.classList.add('hidden');
    }
    function showControls(){
      r.controls.classList.remove('hidden');
      r.centerLayer.classList.remove('hidden');
      clearTimeout(hideTimer);
      if(!video.paused && !menuView && !scrubbing){
        hideTimer = setTimeout(hideControls, 3000);
      }
    }
    // El puntero solo revela los controles si es un ratón; con dedo, el toque
    // sobre el vídeo los alterna (ver el manejador de "click" del vídeo).
    wrap.addEventListener('pointerdown', function(ev){ lastPointerType = ev.pointerType || 'mouse'; });
    wrap.addEventListener('pointermove', function(ev){ if(ev.pointerType === 'mouse') showControls(); });
    // Usar cualquier control reinicia la cuenta atrás de auto-ocultado.
    [r.controls, r.centerLayer, r.settings].forEach(function(el){
      el.addEventListener('pointerdown', function(){ showControls(); });
    });

    // ---- Atajos de teclado ----
    wrap.addEventListener('keydown', function(e){
      if(e.code === 'Space'){ e.preventDefault(); togglePlay(); }
      else if(e.code === 'ArrowRight'){ r.fwd.click(); }
      else if(e.code === 'ArrowLeft'){ r.back.click(); }
      else if(e.code === 'KeyM'){ r.mute.click(); }
      else if(e.code === 'KeyF'){ r.fs.click(); }
      else if(e.code === 'Escape' && menuView){ closeMenu(); }
      showControls();
    });

    activePlayer = {
      destroy: function(){
        disposed = true;
        clearTimeout(hideTimer); clearTimeout(startTimer);
        document.removeEventListener('fullscreenchange', onFsChange);
        document.removeEventListener('webkitfullscreenchange', onFsChange);
        try{ video.pause(); }catch(e){}
        if(hls){ hls.destroy(); hls = null; }
        try{ video.removeAttribute('src'); video.load(); }catch(e){}
      }
    };

    refreshPlayIcons();
    showControls();
    var pp = video.play(); if(pp && pp.catch) pp.catch(function(){ /* autoplay bloqueado: queda el botón central */ });
  }

  init();
})();
</script>
</body>
</html>`;

  return new Response(html, { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } });
}
