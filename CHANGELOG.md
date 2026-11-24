# Changelog

[Norsk](CHANGELOG.no.md)

## 0.3.0 (2026-11-24)

- `list_posts` and `get_chat` take `include_images: true` to also return image links, only `https://` addresses on `spond.com`. Without it, nothing changes.
- Chat messages with images get `hasImage`. Spond sends them as `images`, not `image`.

## 0.2.0 (2026-11-24)

- New tools `list_chats` and `get_chat` read Spond chats, including group chats you follow as a guardian. Messages from you and the other guardians of your children are marked `fromFamily`.
- The chat token is kept in memory only and replaced once if it expires. Chat requests only go to a `spond.com` host over HTTPS.

## 0.1.0 (2026-10-08)

- First public version: `list_family`, `list_groups`, `list_events`, `get_event` and `list_posts`.
