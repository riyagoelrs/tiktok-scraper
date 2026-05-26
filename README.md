# TikTok Scraper

A Python scraper for pulling public TikTok video data using the unofficial [TikTokApi](https://github.com/davidteather/TikTok-Api) library. Supports scraping by hashtag, username, trending feed, or search keyword.

## Features

- Scrape videos by **hashtag**, **user**, **trending**, or **search**
- Extracts: views, likes, comments, shares, caption, hashtags, author info, video URL, music
- Outputs clean **JSON files** with auto-generated filenames
- Supports `msToken` for authenticated sessions (reduces bot detection)

## Setup

**Requirements:** Python 3.9+

```bash
pip install TikTokApi
playwright install chromium
```

## Usage

```bash
# By hashtag
python tiktok_scraper.py --mode hashtag --query cooking --count 50

# By user
python tiktok_scraper.py --mode user --query charlidamelio --count 30

# Trending feed
python tiktok_scraper.py --mode trending --count 20

# Search
python tiktok_scraper.py --mode search --query "pasta recipe" --count 40
```

Output is saved to `./output/tiktok_<mode>_<query>_<timestamp>.json`.

## Getting an msToken (recommended)

TikTok may block requests without a session token. To get one:

1. Open [tiktok.com](https://www.tiktok.com) in your browser and scroll around
2. Open DevTools → Application → Cookies → `www.tiktok.com`
3. Copy the value of the cookie named `msToken`
4. Pass it via flag or environment variable:

```bash
# via flag
python tiktok_scraper.py --mode user --query yourname --ms-token YOUR_TOKEN

# via env var
export TIKTOK_MS_TOKEN=YOUR_TOKEN
python tiktok_scraper.py --mode user --query yourname
```

## Output fields

Each video in the JSON includes:

| Field | Description |
|-------|-------------|
| `id` | TikTok video ID |
| `created_at` | Upload timestamp (UTC) |
| `description` | Caption text |
| `hashtags` | List of hashtag names |
| `views` | Total play count |
| `likes` | Like count |
| `comments` | Comment count |
| `shares` | Share count |
| `author_username` | TikTok handle |
| `author_nickname` | Display name |
| `author_followers` | Follower count |
| `author_verified` | Verified status |
| `video_url` | Direct download URL (expires) |
| `cover_url` | Thumbnail URL |
| `duration_sec` | Video length in seconds |
| `music_title` | Audio track name |

## Notes

- This uses the **unofficial** TikTokApi — TikTok occasionally changes their internals and breaks it. Run `pip install --upgrade TikTokApi` if things stop working.
- `video_url` download links expire after a few hours.
- Scraping TikTok without permission may violate their ToS. Use responsibly.

## License

MIT
