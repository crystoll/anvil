// Initialize localStorage for MSW in Node environment
try {
	if (typeof globalThis !== "undefined" && !globalThis.localStorage) {
		throw new Error("no localStorage");
	}
} catch {
	const storage: Record<string, string> = {};
	globalThis.localStorage = {
		getItem: (key: string) => storage[key] ?? null,
		setItem: (key: string, value: string) => {
			storage[key] = value;
		},
		removeItem: (key: string) => {
			delete storage[key];
		},
		clear: () => {
			for (const key of Object.keys(storage)) delete storage[key];
		},
		key: (index: number) => Object.keys(storage)[index] ?? null,
		length: Object.keys(storage).length,
	} as Storage;
}
