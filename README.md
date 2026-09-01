# karrar.me

Personal site, built with [Astro](https://astro.build).

## Develop

```sh
npm install
npm run dev      # http://localhost:4321/karrar.me/
```

| Command           | Action                                    |
| :---------------- | :---------------------------------------- |
| `npm install`     | Install dependencies                      |
| `npm run dev`     | Dev server at `localhost:4321`            |
| `npm run build`   | Production build to `./dist/`             |
| `npm run preview` | Preview the build locally                 |

## Structure

```
src/
├── layouts/Base.astro    shared <head>, fonts, favicon
├── styles/global.css     type system + design tokens
└── pages/index.astro     routes are files here
public/                   copied verbatim to the build output
```

## Deploy

Pushes to `main` build and publish to GitHub Pages via
`.github/workflows/deploy.yml`. The site is a *project* site served from
`https://sppdd.github.io/karrar.me/`, so `astro.config.mjs` sets `base:
'/karrar.me/'`. Moving to the apex domain means dropping `base`, pointing
`site` at `https://karrar.me`, and adding `public/CNAME`.

## docs/

`docs/` holds the architecture and phasing plan for a separate project — an AI
video-generation platform. It is written here for reference; the implementation
lives in its own repository. Start at [`docs/00-overview.md`](docs/00-overview.md).
