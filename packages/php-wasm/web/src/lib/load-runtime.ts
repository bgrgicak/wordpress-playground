import type {
	SupportedPHPVersion,
	EmscriptenOptions,
	PHPLoaderModule,
} from '@php-wasm/universal';
import { loadPHPRuntime } from '@php-wasm/universal';
import { getPHPLoaderModule } from './get-php-loader-module';
import type { TCPOverFetchOptions } from './tcp-over-fetch-websocket';
import { tcpOverFetchWebsocket } from './tcp-over-fetch-websocket';
import { withSMTPSink } from '@php-wasm/universal';
import { withICUData } from './with-icu-data';

export interface LoaderOptions {
	emscriptenOptions?: EmscriptenOptions;
	onPhpLoaderModuleLoaded?: (module: PHPLoaderModule) => void;
	tcpOverFetch?: TCPOverFetchOptions;
	withICU?: boolean;
	withSMTPSink?: { port: number; onEmail: (m: any) => void };
}

/**
 * Fake a websocket connection to prevent errors in the web app
 * from cascading and breaking the Playground.
 */
const fakeWebsocket = () => {
	return {
		websocket: {
			decorator: (WebSocketConstructor: any) => {
				return class FakeWebsocketConstructor extends WebSocketConstructor {
					constructor() {
						try {
							super();
						} catch {
							// pass
						}
					}

					send() {
						return null;
					}
				};
			},
		},
	};
};

export async function loadWebRuntime(
	phpVersion: SupportedPHPVersion,
	loaderOptions: LoaderOptions = {}
) {
	let emscriptenOptions: EmscriptenOptions | Promise<EmscriptenOptions> = {
		...fakeWebsocket(),
		...(loaderOptions.emscriptenOptions || {}),
	};

	if (loaderOptions.tcpOverFetch) {
		emscriptenOptions = tcpOverFetchWebsocket(
			emscriptenOptions,
			loaderOptions.tcpOverFetch
		);
	}

	if (loaderOptions.withSMTPSink) {
		const prevWs = (await emscriptenOptions)['websocket'] || {};
		const prevDecorator = prevWs.decorator as
			| ((Base: any) => any)
			| undefined;
		const smtp = withSMTPSink(loaderOptions.withSMTPSink);
		const smtpDecorator = smtp['websocket']?.decorator as (
			Base: any
		) => any;
		emscriptenOptions = {
			...(await emscriptenOptions),
			websocket: {
				...prevWs,
				decorator: (Base: any) => {
					const AfterPrev = prevDecorator
						? prevDecorator(Base)
						: Base;
					return smtpDecorator(AfterPrev);
				},
			},
		};
	}

	if (loaderOptions.withICU) {
		emscriptenOptions = withICUData(emscriptenOptions);
	}

	const [phpLoaderModule, options] = await Promise.all([
		getPHPLoaderModule(phpVersion),
		emscriptenOptions,
	]);

	loaderOptions.onPhpLoaderModuleLoaded?.(phpLoaderModule);

	return await loadPHPRuntime(phpLoaderModule, options);
}
