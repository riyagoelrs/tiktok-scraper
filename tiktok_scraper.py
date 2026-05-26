"""
TikTok Scraper — uses TikTokApi (davidteather/TikTok-Api on GitHub)
Modes: hashtag | user | trending | search

Setup (one-time):
  pip install TikTokApi
  playwright install chromium

Run:
  python tiktok_scraper.py --mode hashtag --query cooking --count 50
  python tiktok_scraper.py --mode user    --query charlidamelio --count 30
  python tiktok_scraper.py --mode trending                      --count 20
  python tiktok_scraper.py --mode search  --query "pasta recipe" --count 40

How to get ms_token (needed to avoid blocks):
  1. Open TikTok in your browser and log in (or just browse a bit).
  2. Open DevTools → Application → Cookies → www.tiktok.com
  3. Copy the value of the cookie named "msToken"
  4. Paste it below or pass via --ms-token flag.
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
    print("TikTokApi not installed. Run:  pip install TikTokApi")
    sys.exit(1)


def extract_video(video) -> dict:
    """Pull all fields we care about from a TikTokApi video object."""
    v = video.as_dict

    author = v.get("author", {})
    stats = v.get("stats", {})
    author_stats = v.get("authorStats", {})

    return {
        "id": v.get("id"),
        "created_at": datetime.utcfromtimestamp(v.get("createTime", 0)).isoformat() + "Z",
        # caption
        "description": v.get("desc", ""),
        "hashtags": [tag.get("hashtagName", "") for tag in v.get("challenges", [])],
        # engagement
        "views": stats.get("playCount", 0),
        "likes": stats.get("diggCount", 0),
        "comments": stats.get("commentCount", 0),
        "shares": stats.get("shareCount", 0),
        # author
        "author_username": author.get("uniqueId", ""),
        "author_nickname": author.get("nickname", ""),
        "author_followers": author_stats.get("followerCount", 0),
        "author_following": author_stats.get("followingCount", 0),
        "author_verified": author.get("verified", False),
        # video link  (direct download URL, expires after a few hours)
        "video_url": v.get("video", {}).get("downloadAddr", ""),
        "cover_url": v.get("video", {}).get("cover", ""),
        "duration_sec": v.get("video", {}).get("duration", 0),
        "music_title": v.get("music", {}).get("title", ""),
    }


async def scrape(mode: str, query: str, count: int, ms_token, out_path: Path):
    videos_data = []

    async with TikTokApi() as api:
        # ms_token helps bypass TikTok's bot detection — highly recommended
        await api.create_sessions(
            ms_tokens=[ms_token] if ms_token else [],
            num_sessions=1,
            sleep_after=5,
            headless=False,
            browser="chromium",
        )

        if mode == "hashtag":
            print(f"Scraping hashtag: #{query}")
            tag = api.hashtag(name=query)
            async for video in tag.videos(count=count):
                videos_data.append(extract_video(video))
                print(f"  [{len(videos_data)}/{count}] {video.id}")

        elif mode == "user":
            print(f"Scraping user: @{query}")
            user = api.user(username=query)
            async for video in user.videos(count=count):
                videos_data.append(extract_video(video))
                print(f"  [{len(videos_data)}/{count}] {video.id}")

        elif mode == "trending":
            print("Scraping trending / For You feed")
            async for video in api.trending.videos(count=count):
                videos_data.append(extract_video(video))
                print(f"  [{len(videos_data)}/{count}] {video.id}")

        elif mode == "search":
            print(f"Scraping search: '{query}'")
            async for video in api.search.videos(query, count=count):
                videos_data.append(extract_video(video))
                print(f"  [{len(videos_data)}/{count}] {video.id}")

    # write output
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(videos_data, f, indent=2, ensure_ascii=False)

    print(f"\nSaved {len(videos_data)} videos → {out_path}")


def build_output_path(mode: str, query: str) -> Path:
    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    slug = query.replace(" ", "_").replace("#", "") if query else "feed"
    filename = f"tiktok_{mode}_{slug}_{ts}.json"
    return Path(__file__).parent / "output" / filename


def main():
    parser = argparse.ArgumentParser(description="TikTok scraper")
    parser.add_argument("--mode", choices=["hashtag", "user", "trending", "search"],
                        required=True)
    parser.add_argument("--query", default="",
                        help="Hashtag name, username, or search term (not needed for trending)")
    parser.add_argument("--count", type=int, default=30,
                        help="Number of videos to fetch (default: 30)")
    parser.add_argument("--ms-token", default=os.environ.get("TIKTOK_MS_TOKEN"),
                        help="TikTok msToken cookie value (or set TIKTOK_MS_TOKEN env var)")
    parser.add_argument("--out", default=None,
                        help="Output JSON file path (default: auto-named in ./output/)")
    args = parser.parse_args()

    if args.mode in ("hashtag", "user", "search") and not args.query:
        parser.error(f"--query is required for mode '{args.mode}'")

    out_path = Path(args.out) if args.out else build_output_path(args.mode, args.query)

    if not args.ms_token:
        print("Warning: no msToken provided. TikTok may block requests.")
        print("See the top of this file for how to get one.\n")

    asyncio.run(scrape(args.mode, args.query, args.count, args.ms_token, out_path))


if __name__ == "__main__":
    main()
