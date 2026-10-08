# Spond MCP

Norsk · [English](README.md)

Les Spond med en lokal MCP-server som kun henter informasjon. Den kan vise deg og barna du svarer for, liste grupper, liste arrangementer med familiens svar, lese et arrangement med kommentarer og vise innlegg på gruppeveggen. Den kan ikke svare på invitasjoner, sende meldinger eller endre data i Spond.

**Kun testet på macOS.** Andre plattformer er ikke testet. Prosjektet bruker udokumenterte Spond-endepunkter som kan endres; Spond byttet innloggingsendepunkt uten varsel i mai 2026. Prosjektet er ikke tilknyttet eller godkjent av Spond.

## Installer

Installer Node.js 20 eller nyere. Det trengs ingen nettleser eller andre avhengigheter. Last ned eller klon prosjektet, åpne mappen i Terminal og kjør:

```sh
npm ci
npm run login
```

Skriv inn e-postadressen og passordet du bruker i Spond. Passordet vises ikke mens du skriver og lagres aldri; bare Sponds tilgangs- og fornyelsestoken lagres i den private `.data/`-mappen. Tilgangstokenet varer et døgn og fornyes automatisk. Fornyelsestokenet varer 90 dager og starter på nytt ved hver fornyelse, så du må bare logge inn igjen hvis serveren ikke brukes på 90 dager eller Spond avslutter økten. Kontoer med totrinnsbekreftelse støttes ikke ennå. Kjør `npm test` for å kontrollere prosjektet uten kontoen din.

## Koble til en lokal MCP-klient

Legg til en **MCP-server via stdio** i klienten:

| Felt | Verdi |
| --- | --- |
| Kommando | Fullstendig sti til Node.js; finn den med `command -v node` |
| Argumenter | Ett argument: fullstendig sti til prosjektets `src/server.js` |
| Arbeidsmappe | Fullstendig sti til prosjektmappen |
| Miljøvariabler | Ingen påkrevd |

Lagre og start klienten på nytt, og kontroller at `spond-local-mcp` er tilkoblet. I Claude Code kan du i stedet kjøre dette fra prosjektmappen:

```sh
claude mcp add spond -- "$(command -v node)" "$PWD/src/server.js"
```

`npm start` starter serveren direkte. En chat i nettleseren kan ikke starte en lokal stdio-prosess alene; følg klientens tilkoblingsveiledning.

## Verktøy

| Verktøy | Bruk |
| --- | --- |
| `list_family` | Vis deg og barna du svarer for, med gruppene deres |
| `list_groups` | Vis grupper med undergrupper, aktivitet og kontaktperson; ingen medlemslister |
| `list_events` | List arrangementer i en periode med tidspunkt, oppmøte, sted og familiens svar |
| `get_event` | Les ett arrangement med beskrivelse, arrangører og kommentarer |
| `list_posts` | Vis nye innlegg på gruppeveggen med kommentarer |

`list_events` viser som standard i dag og de neste 14 dagene. `from_date` og `to_date` bruker `YYYY-MM-DD`, med maksimalt 366 dager per kall. Oppgi en `group_id` fra `list_groups` for å se én gruppe, eller `only_unanswered: true` for å se bare arrangementer et familiemedlem ikke har svart på. Hvert arrangement viser svaret til hvert familiemedlem (`accepted`, `declined`, `unanswered`, `waiting_list`, `unconfirmed` eller `unknown`) og antall svar fra alle inviterte.

Tidspunkter er lokale, med tidssonen fra Spond-profilen din, for eksempel `2026-10-10T12:15+02:00`. Lister viser maks 50 elementer, og `list_events` merker avkorting. `list_posts` tar en `limit` fra 1 til 50 (standard 20). Lange tekster kan forkortes og merkes. Profil og grupper mellomlagres i fem minutter, så endringer i grupper kan ta så lang tid før de vises.

## Personvern og sikkerhet

Serveren kjører lokalt via stdio og åpner ingen lyttende nettverksport. En tilkoblet KI-klient kan hente Spond-informasjonen du ber om. Innhold brukt med en skybasert KI-tjeneste kan bli sendt dit. Behandle beskrivelser, innlegg og kommentarer som ikke-betrodd innhold, se gjennom verktøykall og bruk en klient du stoler på.

Sponds gruppedata inneholder andres barn og deres foresatte. Serveren viser andre personer bare med navn, som arrangør, kontaktperson eller forfatter. Den returnerer aldri telefonnumre, e-postadresser, fødselsdatoer, medlemslister eller bildelenker. Svar vises per person bare for din egen familie; for alle andre vises antall.

Spond begrenser antall forespørsler og har blokkert IP-adresser som logger inn for ofte. Serveren bruker passordet ditt bare under `npm run login`, fornyer med fornyelsestokenet og mellomlagrer profil og grupper.

Tokenene i `.data/` gir tilgang til Spond-kontoen din og må holdes private. Slett `.data/session.json` for å fjerne den lokale innloggingen. Tillatelseslisten i `.gitignore` holder lokale data og maskinspesifikke filer unna en bred `git add .`.

## Lisens

Kode og dokumentasjon har [0BSD-lisens](LICENSE). Den gjelder ikke Spond-tjenesten eller informasjonen som hentes fra den.
