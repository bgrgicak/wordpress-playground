/// <reference types="vitest" />
// eslint-disable-next-line @nx/enforce-module-boundaries
import { viteTsConfigPaths } from '../../vite-extensions/vite-ts-config-paths';
// eslint-disable-next-line @nx/enforce-module-boundaries
import { getExternalModules } from '../../vite-extensions/vite-external-modules';
// eslint-disable-next-line @nx/enforce-module-boundaries
import viteGlobalExtensions from '../../vite-extensions/vite-global-extensions';

export default {
	root: __dirname,
	base: '/',

	cacheDir: '../../../node_modules/.vite/packages-playground-couchbase-sync',

	plugins: [
		viteTsConfigPaths({
			root: '../../../',
		}),
		...viteGlobalExtensions,
	],

	build: {
		lib: {
			entry: 'src/index.ts',
			name: 'playground-couchbase-sync',
			fileName: 'index',
			formats: ['es', 'cjs'],
		},
		sourcemap: true,
		rollupOptions: {
			external: getExternalModules(),
		},
	},

	test: {
		globals: true,
		cache: {
			dir: '../../../node_modules/.vitest',
		},
		environment: 'node',
		include: ['src/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}'],
		reporters: ['default'],
	},
};
