class Provider {

    api = "https://animesalt.ac"
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/107.0.0.0 Safari/537.36 Edg/107.0.1418.56",
    }

    getSettings() {
        return {
            episodeServers: ["default"],
            supportsDub: true,
        }
    }

    async search(opts) {
        const req = await fetch(`${this.api}/?s=${encodeURIComponent(opts.query)}`, {
            headers: this.headers,
        })
        const html = await req.text()
        const $ = LoadDoc(html)
        const results = []

        $("ul.post-lst > li").each((_, el) => {
            const title = $(el).find("h2.entry-title").text().trim()
            const url = $(el).find("a.lnk-blk").attr("href")
            const id = url ? url.split("/").filter(Boolean).pop() : ""
            if (title && url && id) {
                results.push({
                    id: url,
                    title: title,
                    url: url,
                    subOrDub: "sub",
                })
            }
        })

        return results
    }

    async findEpisodes(id) {
        const req = await fetch(id, {
            headers: this.headers,
        })
        const html = await req.text()
        const $ = LoadDoc(html)
        
        const episodes = []

        $("a[href*='/episode/']").each((_, el) => {
            const url = $(el).attr("href")
            if (url && !episodes.find(e => e.url === url)) {
                const match = url.match(/-(\d+)x(\d+)\/$/)
                let number = episodes.length + 1
                if (match) {
                    number = parseInt(match[2])
                }
                episodes.push({
                    id: url,
                    number: number,
                    title: `Episode ${number}`,
                    url: url,
                })
            }
        })
        
        episodes.sort((a, b) => a.number - b.number)

        return episodes
    }

    async findEpisodeServer(episode, _server) {
        const req = await fetch(episode.id, {
            headers: this.headers,
        })
        const html = await req.text()
        const $ = LoadDoc(html)
        
        const result = {
            videoSources: [],
            headers: this.headers,
            server: "default",
        }

        let iframeUrl = ""
        $("iframe").each((_, el) => {
            const src = $(el).attr("src")
            if (src && src.includes("cdn")) {
                iframeUrl = src
            }
        })
        
        if (iframeUrl) {
            const srcReq = await fetch(iframeUrl, { headers: { Referer: episode.id } })
            const srcHtml = await srcReq.text()
            
            const m3u8Match = srcHtml.match(/(https?:\/\/[^"']+\.m3u8[^"']*)/i)
            if (m3u8Match) {
                result.videoSources.push({
                    url: m3u8Match[1],
                    type: "m3u8",
                    quality: "auto",
                    subtitles: []
                })
            } else {
                const scripts = srcHtml.match(/eval\(f.+?\}\)\)/g)
                if (scripts) {
                    for (const _script of scripts) {
                        const scriptMatch = _script.match(/eval\((.+)\)/)
                        if (!scriptMatch || !scriptMatch[1]) continue
                        
                        try {
                            const decoded = eval("(" + scriptMatch[1] + ")")
                            const videoExtracted = decoded.match(/(https?:\/\/[^"']+\.(?:m3u8|mp4)[^"']*)/i)
                            if (videoExtracted) {
                                result.videoSources.push({
                                    url: videoExtracted[1],
                                    type: videoExtracted[1].includes(".m3u8") ? "m3u8" : "mp4",
                                    quality: "auto",
                                    subtitles: []
                                })
                            }
                        } catch (e) {
                            console.error("Failed to decode eval", e)
                        }
                    }
                }
            }
        }
        
        return result
    }
}
