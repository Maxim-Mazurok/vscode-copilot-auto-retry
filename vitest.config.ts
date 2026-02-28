import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		deps: {
			// Mock the 'vscode' module which is only available in the VS Code extension host
			inline: [],
		},
	},
	resolve: {
		alias: {
			vscode: new URL("./src/__mocks__/vscode.ts", import.meta.url).pathname,
		},
	},
});
