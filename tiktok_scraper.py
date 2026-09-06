"""TikTok scraper using TikTokApi.

Modes: hashtag | user | trending | search

The scraper writes public video metadata to JSON. In CI it runs Chromium
headlessly; locally it keeps the visible-browser behavior unless
TIKTOK_HEADLESS=1 is set.
"""

import asyncio
import argparse
import json
import os
import sys
from datetime import datetime
from pathlib import Path

try:
    from TikTokApi import TikTokApi
except ImportError:
    print("TikTokApi not installed. Run: pip install TikTokApi")
    sys.exit(1)


def extract_video(video) -> dict:
    v = video.as_dict
    author = v.get("author", {})
    stats = v.get("stats", {})
    author_stats = v.get("authorStats", {})
    return {
        "id": v.get("id"),
        "created_at": datetime.utcfromtimestamp(v.get("createTime", 0)).isoformat() + "Z",
        "description": v.get("desc", ""),
        "hashtags": [tag.get("hashtagName", "") for tag in v.get("challenges", [])],
        "views": stats.get("playCount", 0),
        "likes": stats.get("diggCount", 0),
        "comments": stats.get("commentCount", 0),
        "shares": stats.get("shareCount", 0),
        "author_username": author.get("uniqueId", ""),
        "author_nickname": author.get("nickname", ""),
        "author_followers": author_stats.get("followerCount", 0),
        "author_following": author_stats.get("followingCount", 0),
        "author_verified": author.get("verified", False),
        "video_url": v.get("video", {}).get("downloadAddr", ""),
        "cover_url": v.get("video", {}).get("cover", ""),
        "duration_sec": v.get("video", {}).get("duration", 0),
        "music_title": v.get("music", {}).get("title", ""),
    }


def _headless() -> bool:
    explicit = os.environ.get("TIKTOK_HEADLESS")
    if explicit is not None:
        return explicit.lower() in {"1", "true", "yes", "on"}
    return bool(os.environ.get("CI"))


async def scrape(mode: str, query: str, count: int, ms_token, out_path: Path):
    videos_data = []
    async with TikTokApi() as api:
        await api.create_sessions(
            ms_tokens=[ms_token] if ms_token else [],
            num_sessions=1,
            sleep_after=5,
            headless=_headless(),
            browser="chromium",
        )

        if mode == "hashtag":
            print(f"Scraping hashtag: #{query}")
            tag = api.hashtag(name=query)
            async for video in tag.videos(count=count):
                videos_data.append(extract_video(video))
        elif mode == "user":
            print(f"Scraping user: @{query}")
            user = api.user(username=query)
            async for video in user.videos(count=count):
                videos_data.append(extract_video(video))
        elif mode == "trending":
            print("Scraping trending feed")
            async for video in api.trending.videos(count=count):
                videos_data.append(extract_video(video))
        elif mode == "search":
            print(f"Scraping search: '{query}'")
            async for video in api.search.videos(query, count=count):
                videos_data.append(extract_video(video))

    out_path.parent.mkdir(parents=True, exist_ok=True)
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(videos_data, f, indent=2, ensure_ascii=False)
    print(f"Saved {len(videos_data)} videos -> {out_path}")


def build_output_path(mode: str, query: str) -> Path:
    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    slug = query.replace(" ", "_").replace("#", "") if query else "feed"
    return Path(__file__).parent / "output" / f"tiktok_{mode}_{slug}_{ts}.json"


def main():
    parser = argparse.ArgumentParser(description="TikTok scraper")
    parser.add_argument("--mode", choices=["hashtag", "user", "trending", "search"], required=True)
    parser.add_argument("--query", default="")
    parser.add_argument("--count", type=int, default=30)
    parser.add_argument("--ms-token", default=os.environ.get("TIKTOK_MS_TOKEN"))
    parser.add_argument("--out", default=None)
    args = parser.parse_args()

    if args.mode in ("hashtag", "user", "search") and not args.query:
        parser.error(f"--query is required for mode '{args.mode}'")

    out_path = Path(args.out) if args.out else build_output_path(args.mode, args.query)
    if not args.ms_token:
        print("No msToken provided; collection may be less reliable.")
    asyncio.run(scrape(args.mode, args.query, args.count, args.ms_token, out_path))


if __name__ == "__main__":
    main()
