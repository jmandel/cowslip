# Sow's Ear

A cooperative word game where every letter counts.

## Development

```sh
bun install
bun run dev
```

## Checks

```sh
bun test
bun run typecheck
bun run build
```

## Deployment

This repo deploys to GitHub Pages with the workflow in `.github/workflows/pages.yml`.

The Pages target is:

```text
https://joshuamandel.com/sowsear/
```

`BUN_PUBLIC_INSTANT_APP_ID` is public client configuration and is supplied as a GitHub repository variable. No Instant admin token is required for the static Pages build.
