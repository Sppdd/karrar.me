// @ts-check
import { defineConfig } from 'astro/config';

// https://astro.build/config
// Deployed as a GitHub Pages *project* site at https://sppdd.github.io/karrar.me/
// so `site` is the origin and `base` is the subpath. If the apex domain is ever
// wired up via DNS, switch to site: 'https://karrar.me', drop `base`, and add
// a public/CNAME file.
export default defineConfig({
	site: 'https://sppdd.github.io',
	base: '/karrar.me/',
});
