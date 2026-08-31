/// <reference path="./eg/anime-torrent-provider.d.ts" />

// ─────────────────────────────────────────────────────────────────────────────
//  AnimeSalt – Anime Torrent Provider
//  Source: Nyaa.si  (the de-facto public anime torrent index)
// ─────────────────────────────────────────────────────────────────────────────

class Provider {

    private api = "https://nyaa.si"

    // ── Settings ──────────────────────────────────────────────────────────────

    getSettings(): AnimeProviderSettings {
        return {
            canSmartSearch: true,
            smartSearchFilters: ["batch", "episodeNumber", "resolution", "query", "bestReleases"],
            supportsAdult: false,
            type: "main",
        }
    }


    // ── Public API ────────────────────────────────────────────────────────────

    /**
     * Free-text search. Called when the user types a custom query in Seanime.
     */
    async search(opts: AnimeSearchOptions): Promise<AnimeTorrent[]> {
        const rows = await this.fetchRows(`/?f=0&c=1_2&q=${encodeURIComponent(opts.query)}&s=seeders&o=desc`)
        return rows.map(r => this.toAnimeTorrent(r))
    }

    /**
     * Smart search. Called by Seanime's auto-downloader with structured filters.
     */
    async smartSearch(opts: AnimeSmartSearchOptions): Promise<AnimeTorrent[]> {
        const parts: string[] = []

        if (opts.query) {
            parts.push(opts.query)
        } else {
            const title = opts.media.englishTitle || opts.media.romajiTitle || ""
            if (title) parts.push(title)
        }

        if (opts.resolution) parts.push(this.formatResolution(opts.resolution))

        const q = parts.join(" ").trim()
        const base = `/?f=0&c=1_2&q=${encodeURIComponent(q)}&s=seeders&o=desc`

        const rows = await this.fetchRows(base)
        let results = rows.map(r => this.toAnimeTorrent(r))

        // ── Apply client-side filters ────────────────────────────────────────

        if (opts.resolution) {
            const res = opts.resolution.toLowerCase()
            results = results.filter(t => {
                const name = t.name.toLowerCase()
                return name.includes(res) || name.includes(res.replace("p", ""))
            })
        }

        if (opts.batch) {
            results = results.filter(t => this.looksLikeBatch(t.name))
            results.forEach(t => { t.isBatch = true })
        } else if (opts.episodeNumber > 0) {
            results = results.filter(t => {
                if (t.episodeNumber === -1) return true
                return t.episodeNumber === opts.episodeNumber
            })
        }

        if (opts.bestReleases) {
            const best = this.pickBestReleases(results)
            if (best.length > 0) {
                best.forEach(t => { t.isBestRelease = true })
                return best
            }
        }

        return results
    }

    /**
     * Return the info hash for a torrent.
     * Nyaa includes it directly in the listing, so no extra scraping needed.
     */
    async getTorrentInfoHash(torrent: AnimeTorrent): Promise<string> {
        return torrent.infoHash || ""
    }

    /**
     * Return the magnet link for a torrent.
     * Nyaa includes it directly in the listing, so no extra scraping needed.
     */
    async getTorrentMagnetLink(torrent: AnimeTorrent): Promise<string> {
        return torrent.magnetLink || ""
    }

    /**
     * Return the latest torrents from the anime category.
     */
    async getLatest(): Promise<AnimeTorrent[]> {
        const rows = await this.fetchRows("/?f=0&c=1_2&s=id&o=desc")
        return rows.map(r => this.toAnimeTorrent(r))
    }

    // ── Nyaa RSS fetch ────────────────────────────────────────────────────────

    /**
     * Fetch torrent rows from Nyaa's RSS feed.
     * We use the RSS endpoint because it returns structured XML without
     * requiring any fragile HTML parsing.
     */
    private async fetchRows(path: string): Promise<NyaaItem[]> {
        const rsspath = path.replace("/?", "/?page=rss&")
        const url = `${this.api}${rsspath}`

        let response: Response
        try {
            response = await fetch(url, {
                headers: {
                    "User-Agent": "Mozilla/5.0 (compatible; Seanime/1.0)",
                    "Accept": "application/rss+xml, application/xml, text/xml",
                },
            })
        } catch (err) {
            throw new Error(`AnimeSalt torrent provider: network error – ${err}`)
        }

        if (!response.ok) {
            throw new Error(`AnimeSalt torrent provider: HTTP ${response.status} from Nyaa`)
        }

        const xml = await response.text()
        return this.parseRss(xml)
    }

    // ── RSS parser ────────────────────────────────────────────────────────────

    /**
     * Lightweight RSS → NyaaItem parser (no DOM dependency).
     */
    private parseRss(xml: string): NyaaItem[] {
        const items: NyaaItem[] = []
        const itemBlocks = xml.match(/<item[\s\S]*?<\/item>/gi) || []

        for (const block of itemBlocks) {
            const title      = this.xmlText(block, "title")
            const link       = this.xmlText(block, "link")
            const guid       = this.xmlText(block, "guid")
            const pubDate    = this.xmlText(block, "pubDate")
            const seeders    = parseInt(this.xmlText(block, "nyaa:seeders") || "0", 10)
            const leechers   = parseInt(this.xmlText(block, "nyaa:leechers") || "0", 10)
            const downloads  = parseInt(this.xmlText(block, "nyaa:downloads") || "0", 10)
            const size       = this.xmlText(block, "nyaa:size")
            const infoHash   = (this.xmlText(block, "nyaa:infoHash") || "").toLowerCase()
            const magnetLink = this.xmlText(block, "nyaa:magnetLink") ||
                               (infoHash ? this.buildMagnet(infoHash, title) : "")
            const downloadUrl = link ? link + "/download" : undefined

            if (!title || !link) continue

            items.push({
                title, link, guid, pubDate,
                seeders, leechers, downloads,
                size, infoHash, magnetLink, downloadUrl,
            })
        }

        return items
    }

    /** Extract the text content of the first matching XML tag. */
    private xmlText(xml: string, tag: string): string {
        const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
        const match = xml.match(new RegExp(`<${escaped}[^>]*>([\\s\\S]*?)</${escaped}>`, "i"))
        return match ? match[1].replace(/<!\[CDATA\[|\]\]>/g, "").trim() : ""
    }

    /** Build a minimal magnet URI from an info hash + display name. */
    private buildMagnet(hash: string, name: string): string {
        const trackers = [
            "udp://open.stealth.si:80/announce",
            "udp://tracker.opentrackr.org:1337/announce",
            "http://nyaa.tracker.wf:7777/announce",
        ].map(t => `&tr=${encodeURIComponent(t)}`).join("")
        return `magnet:?xt=urn:btih:${hash}&dn=${encodeURIComponent(name)}${trackers}`
    }

    // ── Conversion ────────────────────────────────────────────────────────────

    private toAnimeTorrent(item: NyaaItem): AnimeTorrent {
        return {
            name:          item.title,
            date:          item.pubDate ? new Date(item.pubDate).toISOString() : new Date().toISOString(),
            size:          this.parseSize(item.size),
            formattedSize: item.size || "",
            seeders:       item.seeders,
            leechers:      item.leechers,
            downloadCount: item.downloads,
            link:          item.link,
            downloadUrl:   item.downloadUrl,
            magnetLink:    item.magnetLink || undefined,
            infoHash:      item.infoHash || undefined,
            resolution:    this.parseResolution(item.title),
            isBatch:       this.looksLikeBatch(item.title),
            episodeNumber: this.parseEpisodeNumber(item.title),
            releaseGroup:  this.parseReleaseGroup(item.title),
            isBestRelease: false,
            confirmed:     false,
        }
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    /** Convert Nyaa's human-readable size string to bytes. */
    private parseSize(size: string): number {
        if (!size) return 0
        const match = size.match(/([\d,.]+)\s*(GiB|MiB|KiB|GB|MB|KB|B)/i)
        if (!match) return 0
        const value = parseFloat(match[1].replace(",", ""))
        const unit  = match[2].toUpperCase()
        const multipliers: { [key: string]: number } = {
            GIB: 1024 ** 3, GB: 1000 ** 3,
            MIB: 1024 ** 2, MB: 1000 ** 2,
            KIB: 1024,      KB: 1000,
            B:   1,
        }
        return Math.round(value * (multipliers[unit] || 1))
    }

    /** Strip trailing "p" so Nyaa's query accepts "1080" instead of "1080p". */
    private formatResolution(res: string): string {
        return res.replace(/p$/i, "")
    }

    /** Extract resolution from a torrent name, e.g. "[1080p]" → "1080p". */
    private parseResolution(name: string): string {
        const match = name.match(/\b(2160|1440|1080|720|480|360)p?\b/i)
        return match ? `${match[1]}p` : ""
    }

    /**
     * Heuristic episode-number parser for typical fansub naming conventions:
     *   "[Group] Show Name - 12 [1080p].mkv"
     *   "[Group] Show Name - S02E05 [720p].mkv"
     *   "[Group] Show Name E03 [480p].mkv"
     */
    private parseEpisodeNumber(name: string): number {
        // S01E05 style
        const seMatch = name.match(/\bS\d+E(\d+)\b/i)
        if (seMatch) return parseInt(seMatch[1], 10)

        // " - 12 " style (typical fansub dash-number)
        const dashMatch = name.match(/\s-\s(\d{1,4})(?:\s|v\d|\[|\.mkv|\.mp4)/i)
        if (dashMatch) return parseInt(dashMatch[1], 10)

        // E12 / EP12
        const eMatch = name.match(/\bEP?(\d{1,4})\b/i)
        if (eMatch) return parseInt(eMatch[1], 10)

        return -1
    }

    /** Extract release group from a torrent name (text inside first square brackets). */
    private parseReleaseGroup(name: string): string {
        const match = name.match(/^\[([^\]]+)\]/)
        return match ? match[1] : ""
    }

    /**
     * Return true when the name strongly suggests a batch/complete pack.
     * Patterns: "Batch", "Complete", "01-12", "S01", etc.
     */
    private looksLikeBatch(name: string): boolean {
        return /\b(batch|complete|vol\.?\s*\d+\s*-\s*\d+|\d+\s*-\s*\d+)\b/i.test(name) ||
               /\bS\d+\b(?!\s*E\d+)/i.test(name)
    }

    /**
     * Rank results and return the top tier.
     * Prefers well-known fansub groups, 1080p quality, and high seeder counts.
     */
    private pickBestReleases(torrents: AnimeTorrent[]): AnimeTorrent[] {
        const topGroups = new Set(["subsplease", "erai-raws", "ember", "judas", "dual audio", "blu-ray"])

        const scored = torrents.map(t => {
            let score = 0
            const lower = t.name.toLowerCase()
            for (const g of topGroups) if (lower.includes(g)) score += 30
            if (lower.includes("1080p") || lower.includes("1080")) score += 20
            if (lower.includes("blu-ray") || lower.includes("bluray")) score += 15
            score += Math.min(t.seeders, 200) / 10   // up to +20 for seeders
            return { t, score }
        })

        scored.sort((a, b) => b.score - a.score)

        if (scored.length === 0) return []
        const threshold = scored[0].score * 0.8
        return scored.filter(s => s.score >= threshold).map(s => s.t)
    }
}

// ── Internal type ─────────────────────────────────────────────────────────────

type NyaaItem = {
    title:        string
    link:         string
    guid:         string
    pubDate:      string
    seeders:      number
    leechers:     number
    downloads:    number
    size:         string
    infoHash:     string
    magnetLink:   string
    downloadUrl?: string
}

