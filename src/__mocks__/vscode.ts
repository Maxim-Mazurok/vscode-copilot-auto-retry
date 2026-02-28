/**
 * Minimal mock of the `vscode` module for unit tests.
 *
 * Stubs the API surface used by extension modules so they can be imported
 * and tested without the VS Code extension host.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

export class Uri {
	readonly scheme: string;
	readonly authority: string;
	readonly path: string;
	readonly query: string;
	readonly fragment: string;
	readonly fsPath: string;

	private constructor(filePath: string) {
		this.scheme = "file";
		this.authority = "";
		this.path = filePath;
		this.query = "";
		this.fragment = "";
		this.fsPath = filePath;
	}

	static file(filePath: string): Uri {
		return new Uri(filePath);
	}

	static joinPath(base: Uri, ...pathSegments: string[]): Uri {
		const joined = [base.path, ...pathSegments].join("/");
		return new Uri(joined);
	}

	toString(): string {
		return `file://${this.path}`;
	}
}

export class RelativePattern {
	constructor(
		public base: any,
		public pattern: string,
	) {}
}

export const FileType = {
	Unknown: 0,
	File: 1,
	Directory: 2,
	SymbolicLink: 64,
} as const;

export const ConfigurationTarget = {
	Global: 1,
	Workspace: 2,
	WorkspaceFolder: 3,
} as const;

export const workspace = {
	fs: {
		stat: async () => ({ type: FileType.File, size: 0, ctime: 0, mtime: 0 }),
		readDirectory: async () => [],
		readFile: async () => new Uint8Array(),
	},
	createFileSystemWatcher: () => ({
		onDidChange: () => ({ dispose: () => {} }),
		onDidCreate: () => ({ dispose: () => {} }),
		onDidDelete: () => ({ dispose: () => {} }),
		dispose: () => {},
	}),
	getConfiguration: () => ({
		get: (_key: string, defaultValue: any) => defaultValue,
		update: async () => {},
	}),
};

export const window = {
	createOutputChannel: () => ({
		info: () => {},
		warn: () => {},
		error: () => {},
		debug: () => {},
		show: () => {},
		dispose: () => {},
		appendLine: () => {},
	}),
};

export const commands = {
	executeCommand: async () => {},
};
