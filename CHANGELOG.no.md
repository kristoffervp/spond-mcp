# Endringslogg

[English](CHANGELOG.md)

## 0.4.0 (2026-11-25)

- Usynlige tegn (retningsoverstyring, tegn uten bredde og Unicode-tagger) fjernes fra all tekst, og tekst som kuttes midt i en emoji, er fortsatt gyldig. Før kunne et langt innlegg med en emoji i kuttet hindre familiedashbordet i å lagre Spond-data.
- Når en gammel lås fjernes, fjernes ikke lenger en lås en annen prosess nettopp har tatt, så to prosesser ikke kan bruke samme fornyelsestoken.
- En chat-vert som avviser et nytt chat-token, sier det, i stedet for å be deg logge inn på nytt.
- `get_chat` gir `olderBefore` også når den eldste meldingen som vises, har nummer 1.
- Kall kjøres samtidig, ugyldige JSON-RPC-id-er avvises, versjonen hentes fra `package.json`, og datoer har et formatmønster. En mislykket skriving av innloggingen etterlater ingen kopi.
- Tider formateres med én formatter per tidssone, som går raskere på en Raspberry Pi. Fjernet ubrukte felt fra den lagrede innloggingen.

## 0.3.0 (2026-11-24)

- `list_posts` og `get_chat` tar `include_images: true` for også å gi bildelenker, bare `https://`-adresser på `spond.com`. Uten den er alt som før.
- Chatmeldinger med bilder får `hasImage`. Spond sender dem som `images`, ikke `image`.

## 0.2.0 (2026-11-24)

- Nye verktøy, `list_chats` og `get_chat`, leser chatter i Spond, også gruppechatter du følger som foresatt. Meldinger fra deg og de andre foresatte til barna dine merkes `fromFamily`.
- Chat-tokenet holdes bare i minnet og byttes én gang hvis det går ut. Chat-forespørsler går bare til en `spond.com`-vert over HTTPS.

## 0.1.0 (2026-10-08)

- Første offentlige versjon: `list_family`, `list_groups`, `list_events`, `get_event` og `list_posts`.
