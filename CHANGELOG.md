# Changelog

[Norsk](CHANGELOG.no.md)

## 0.5.0 (2026-11-25)

- `list_polls` lists polls with options, vote counts and what your family members voted. Polls are not in `list_posts`.
- Sending, off unless `SPOND_ALLOW_SEND=1`: answer events and vote in polls for a family member in two steps (`prepare_event_response` or `prepare_poll_vote`, then `send_prepared` with a one-time code), and mark chats and posts as read. With MCP elicitation the parent confirms each one in the client's dialog; `send_prepared` also needs the prepared `summary`, and refuses if the event or poll changed since. Not yet tested against Spond.

## 0.4.0 (2026-11-25)

- Invisible characters (direction overrides, zero-width and Unicode tag characters) are removed from all text, and text cut in the middle of an emoji stays valid. Before, a long post with an emoji at the cut could stop the family dashboard from saving Spond data.
- Removing a stale lock no longer removes a lock another process has just taken, so two processes can't both use the same refresh token.
- A chat host that refuses a fresh chat token says so, instead of asking you to sign in again.
- `get_chat` returns `olderBefore` also when the oldest message shown is number 1.
- Requests run concurrently, invalid JSON-RPC ids are refused, the version comes from `package.json`, and dates have a format pattern. A failed write of the sign-in leaves no copy behind.
- Times are formatted with one cached formatter per time zone, which is faster on a Raspberry Pi. Removed unused fields from the saved sign-in.

## 0.3.0 (2026-11-24)

- `list_posts` and `get_chat` take `include_images: true` to also return image links, only `https://` addresses on `spond.com`. Without it, nothing changes.
- Chat messages with images get `hasImage`. Spond sends them as `images`, not `image`.

## 0.2.0 (2026-11-24)

- New tools `list_chats` and `get_chat` read Spond chats, including group chats you follow as a guardian. Messages from you and the other guardians of your children are marked `fromFamily`.
- The chat token is kept in memory only and replaced once if it expires. Chat requests only go to a `spond.com` host over HTTPS.

## 0.1.0 (2026-10-08)

- First public version: `list_family`, `list_groups`, `list_events`, `get_event` and `list_posts`.
