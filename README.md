# Spond MCP

English · [Norsk](README.no.md)

Read Spond through a local, read-only MCP server. It can list you and the children you answer for, list groups, list events with your family's responses, read an event with its comments, and list group wall posts. It cannot answer invitations, send messages, or change Spond data.

**Tested only on macOS.** Other platforms have not been tested. This project uses undocumented Spond endpoints that may change; Spond replaced its sign-in endpoint without notice in May 2026. It is not affiliated with or endorsed by Spond.

## Install

Install Node.js 20 or later. No browser or other dependencies are needed. Download or clone this repository, open its folder in Terminal, and run:

```sh
npm ci
npm run login
```

Enter your Spond email address and password. The password is read without echo and is never saved; only Spond's access and refresh tokens are stored in the private `.data/` folder. The access token lasts a day and renews automatically. The refresh token lasts 90 days and restarts with every renewal, so you only need to sign in again if the server goes unused for 90 days or Spond ends the session. Accounts with two-factor verification are not supported yet. Run `npm test` to check the project without using your account.

## Connect a local MCP client

Add a **stdio MCP server** in your client:

| Field | Value |
| --- | --- |
| Command | Absolute path to Node.js; find it with `command -v node` |
| Arguments | One argument: absolute path to this project's `src/server.js` |
| Working directory | Absolute path to this project folder |
| Environment variables | None required |

Save and restart the client, then check that `spond-local-mcp` is connected. In Claude Code, run this from the project folder instead:

```sh
claude mcp add spond -- "$(command -v node)" "$PWD/src/server.js"
```

`npm start` starts the server directly. A browser chat cannot launch a local stdio process by itself; follow your client's connection instructions.

## Tools

| Tool | Purpose |
| --- | --- |
| `list_family` | List you and the children you answer for, with their groups |
| `list_groups` | List groups with subgroups, activity, and contact person; no member lists |
| `list_events` | List events in a date range with times, meetup, location, and your family's responses |
| `get_event` | Read one event with description, organizers, and comments |
| `list_posts` | List recent group wall posts with comments |

`list_events` covers today and the next 14 days by default. `from_date` and `to_date` accept `YYYY-MM-DD`, with a maximum range of 366 days. Pass a `group_id` from `list_groups` to see one group, or `only_unanswered: true` to see only events a family member has not answered. Each event lists every family member's response (`accepted`, `declined`, `unanswered`, `waiting_list`, `unconfirmed`, or `unknown`) and counts the responses of everyone invited.

Times are local, with the offset of your Spond profile's time zone, for example `2026-10-10T12:15+02:00`. Lists return at most 50 entries, and `list_events` indicates truncation. `list_posts` takes a `limit` from 1 to 50 (default 20). Long text may be shortened and marked as such. Profile and groups are cached for five minutes, so group changes can take that long to appear.

## Privacy and security

The server runs locally over stdio and opens no listening port. A connected AI client can retrieve the Spond information you request. Content used with a cloud AI service may be sent to that service. Treat event descriptions, posts, and comments as untrusted content, review tool calls, and use a client you trust.

Spond's group data includes other people's children and their guardians. The server returns other people by name only, as organizers, contact persons, and authors. It never returns phone numbers, email addresses, birth dates, member lists, or image links. Responses are shown per person only for your own family; everyone else is counted.

Spond limits request volume and has blocked IP addresses that sign in too often. The server uses your password only during `npm run login`, renews with the refresh token, and caches profile and groups.

The tokens in `.data/` give access to your Spond account and must stay private. Delete `.data/session.json` to remove the local sign-in. The `.gitignore` allowlist keeps local data and machine-specific files out of a broad `git add .`.

## License

Code and documentation use the [0BSD license](LICENSE). This does not cover Spond's service or retrieved data.
