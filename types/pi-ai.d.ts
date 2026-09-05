declare module "@earendil-works/pi-ai" {
	export interface Message {
		role: string;
		content: any[];
		usage?: {
			input?: number;
			output?: number;
			cacheRead?: number;
			cacheWrite?: number;
			cost?: { total?: number };
			totalTokens?: number;
		};
		model?: string;
		stopReason?: string;
		errorMessage?: string;
	}
}
