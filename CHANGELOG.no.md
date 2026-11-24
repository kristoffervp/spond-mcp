# Endringslogg

[English](CHANGELOG.md)

## 0.3.0 (2026-11-24)

- `list_posts` og `get_chat` tar `include_images: true` for også å gi bildelenker, bare `https://`-adresser på `spond.com`. Uten den er alt som før.
- Chatmeldinger med bilder får `hasImage`. Spond sender dem som `images`, ikke `image`.

## 0.2.0 (2026-11-24)

- Nye verktøy, `list_chats` og `get_chat`, leser chatter i Spond, også gruppechatter du følger som foresatt. Meldinger fra deg og de andre foresatte til barna dine merkes `fromFamily`.
- Chat-tokenet holdes bare i minnet og byttes én gang hvis det går ut. Chat-forespørsler går bare til en `spond.com`-vert over HTTPS.

## 0.1.0 (2026-10-08)

- Første offentlige versjon: `list_family`, `list_groups`, `list_events`, `get_event` og `list_posts`.
