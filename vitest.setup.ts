// Initialize localStorage for MSW in Node environment
if (typeof globalThis !== 'undefined' && !globalThis.localStorage) {
	// Polyfill localStorage for MSW
	const storage: Record<string, string> = {};
	globalThis.localStorage = {
		getItem: (key: string) => storage[key] ?? null,
		setItem: (key: string, value: string) => { storage[key] = value; },
		removeItem: (key: string) => { delete storage[key]; },
		clear: () => { Object.keys(storage).forEach(key => delete storage[key]); },
		key: (index: number) => Object.keys(storage)[index] ?? null,
		length: Object.keys(storage).length,
	} as Storage;
}
