/**
 * Minimal subagent extension
 *
 * Delegates a task to a fresh pi process with an isolated context window.
 * Optionally restricts child tools, selects a model via --model, and loads startup skills via --skill flags.
 */

import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { Message } from "@earendil-works/pi-ai";
import { type AgentToolResult, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "@sinclair/typebox";

const MAX_TASK_ARG_LENGTH = 4000;
const MODEL_DISCOVERY_TIMEOUT_MS = 30_000;
const MIN_SUBAGENT_TIMEOUT_MS = 1_000;
const MAX_SUBAGENT_TIMEOUT_MS = 86_400_000;
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
type ThinkingLevel = (typeof THINKING_LEVELS)[number];
const ACCESS_MODES = ["read-only", "workspace-write"] as const;
type AccessMode = (typeof ACCESS_MODES)[number];
const DEFAULT_ACCESS_MODE: AccessMode = "workspace-write";
const READ_ONLY_TOOLS = ["read", "grep", "find", "ls"] as const;
const activeWorkspaceWriteLeases = new Set<string>();

function getWorkspaceLeaseKey(cwd: string): string {
	let resolved: string;
	try {
		resolved = fs.realpathSync.native(cwd);
	} catch {
		resolved = path.resolve(cwd);
	}
	return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function acquireWorkspaceWriteLease(cwd: string): () => void {
	const key = getWorkspaceLeaseKey(cwd);
	if (activeWorkspaceWriteLeases.has(key)) {
		throw new Error(
			`A workspace-write subagent is already running in ${cwd}. Wait for it to finish, use access: "read-only" for parallel inspection, or run against a different working directory.`,
		);
	}
	activeWorkspaceWriteLeases.add(key);

	let released = false;
	return () => {
		if (released) return;
		released = true;
		activeWorkspaceWriteLeases.delete(key);
	};
}

function getMinimalSystemPrompt(access: AccessMode): string {
	const accessGuidance = access === "read-only"
		? "You are in read-only access mode. Use only the available non-mutating tools and do not modify the workspace."
		: "You are in workspace-write access mode. You may use the available tools to inspect and modify the workspace as the task requires.";

	return `You are a subagent running in an isolated pi process.

${accessGuidance}

Your job is to focus exclusively on the assigned task, use tools as needed, and provide a concise, evidence-based final report.

Guidelines:
- Stay focused on the task. Do not drift into unrelated work.
- Honor the task's stated objective, scope, access expectations, exclusions, verification, stopping conditions, and requested report format.
- Report work completed or findings, files changed (if any), commands and checks actually run with their outcomes, unresolved blockers, and material uncertainty.
- Distinguish observed results from assumptions, and never claim that an unrun check passed.
- Do not claim parent-level acceptance or completion beyond the evidence; the parent agent will review your report and decide next steps.`;
}

type MessageContent = {
	type?: string;
	text?: unknown;
	name?: unknown;
};

type AgentMessage = Message & { content: MessageContent[] };

type PiRuntime = {
	currentScript?: string;
	execPath: string;
	fileExists: (filePath: string) => boolean;
};

export function parseMessageEnd(line: string): AgentMessage | undefined {
	if (!line.trim()) return undefined;

	try {
		const event: unknown = JSON.parse(line);
		if (!event || typeof event !== "object") return undefined;

		const candidate = event as { type?: unknown; message?: unknown };
		if (candidate.type !== "message_end" || !candidate.message || typeof candidate.message !== "object") {
			return undefined;
		}

		return candidate.message as AgentMessage;
	} catch {
		return undefined;
	}
}

export function getMessageText(message: Pick<AgentMessage, "content">): string {
	if (!Array.isArray(message.content)) return "";

	return message.content
		.filter((part) => part?.type === "text" && typeof part.text === "string")
		.map((part) => part.text as string)
		.join("");
}

export function formatAssistantProgress(message: AgentMessage, turnCount: number): string {
	const content = Array.isArray(message.content) ? message.content : [];
	const toolCalls = content.filter((part) => part?.type === "toolCall");
	let updateText: string;

	if (toolCalls.length > 0) {
		const counts = new Map<string, number>();
		for (const call of toolCalls) {
			const name = typeof call.name === "string" && call.name ? call.name : "unknown tool";
			counts.set(name, (counts.get(name) || 0) + 1);
		}
		const tools = Array.from(counts.entries())
			.map(([name, count]) => (count > 1 ? `${name} (x${count})` : name))
			.join(", ");
		updateText = `Turn ${turnCount}: ${tools}`;
	} else {
		updateText = `Turn ${turnCount}: thinking...`;
	}

	const text = getMessageText(message);
	if (text) {
		const preview = text.length > 60 ? text.slice(0, 60) + "..." : text;
		updateText += `\n${preview}`;
	}

	return updateText;
}

export function getPiInvocation(
	args: string[],
	runtime: PiRuntime = {
		currentScript: process.argv[1],
		execPath: process.execPath,
		fileExists: fs.existsSync,
	},
): { command: string; args: string[] } {
	const currentScript = runtime.currentScript;
	if (currentScript && runtime.fileExists(currentScript)) {
		return { command: runtime.execPath, args: [currentScript, ...args] };
	}
	const execName = path.basename(runtime.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) {
		return { command: runtime.execPath, args };
	}
	return { command: "pi", args };
}

const terminatingProcesses = new WeakSet<ChildProcess>();

function terminateProcessTree(proc: ChildProcess): void {
	if (terminatingProcesses.has(proc)) return;
	terminatingProcesses.add(proc);

	const pid = proc.pid;
	if (pid === undefined) {
		proc.kill("SIGKILL");
		return;
	}

	if (process.platform === "win32") {
		try {
			const taskkill = spawn(
				path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe"),
				["/F", "/T", "/PID", String(pid)],
				{ stdio: "ignore", detached: true, windowsHide: true },
			);
			taskkill.once("error", () => proc.kill("SIGKILL"));
		} catch {
			proc.kill("SIGKILL");
		}
		return;
	}

	try {
		process.kill(-pid, "SIGKILL");
	} catch {
		proc.kill("SIGKILL");
	}
}

type JsonRecord = Record<string, unknown>;

type DiscoveredModel = {
	selector: string;
	provider: string;
	model: string;
	name: string;
	api?: string;
	capabilities: {
		input: string[];
		images: boolean;
		reasoning: boolean;
		thinkingLevels: ThinkingLevel[];
		toolSupport: {
			additionalTools: boolean;
			grammarTools: boolean;
			toolSearch: boolean;
		};
	};
	limits: { contextTokens?: number; maxOutputTokens?: number };
	pricing?: {
		unit: "USD per million tokens";
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		tiers: Array<{ inputTokensAbove: number; input: number; output: number; cacheRead: number; cacheWrite: number }>;
	};
};

function isJsonRecord(value: unknown): value is JsonRecord {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function optionalNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function getThinkingLevels(model: JsonRecord): ThinkingLevel[] {
	if (model.reasoning !== true) return ["off"];

	const levelMap = isJsonRecord(model.thinkingLevelMap) ? model.thinkingLevelMap : {};
	return THINKING_LEVELS.filter((level) => {
		const mapped = levelMap[level];
		if (mapped === null) return false;
		if (level === "xhigh" || level === "max") return typeof mapped === "string";
		return true;
	});
}

function getPricing(value: unknown): DiscoveredModel["pricing"] {
	if (!isJsonRecord(value)) return undefined;
	const input = optionalNumber(value.input);
	const output = optionalNumber(value.output);
	const cacheRead = optionalNumber(value.cacheRead);
	const cacheWrite = optionalNumber(value.cacheWrite);
	if (input === undefined || output === undefined || cacheRead === undefined || cacheWrite === undefined) return undefined;

	const tiers = Array.isArray(value.tiers)
		? value.tiers.flatMap((tier) => {
			if (!isJsonRecord(tier)) return [];
			const inputTokensAbove = optionalNumber(tier.inputTokensAbove);
			const tierInput = optionalNumber(tier.input);
			const tierOutput = optionalNumber(tier.output);
			const tierCacheRead = optionalNumber(tier.cacheRead);
			const tierCacheWrite = optionalNumber(tier.cacheWrite);
			return inputTokensAbove === undefined || tierInput === undefined || tierOutput === undefined || tierCacheRead === undefined || tierCacheWrite === undefined
				? []
				: [{ inputTokensAbove, input: tierInput, output: tierOutput, cacheRead: tierCacheRead, cacheWrite: tierCacheWrite }];
		})
		: [];
	return { unit: "USD per million tokens", input, output, cacheRead, cacheWrite, tiers };
}

function normalizeDiscoveredModels(models: unknown[]): DiscoveredModel[] {
	return models.flatMap((rawModel) => {
		if (!isJsonRecord(rawModel)) return [];
		const provider = optionalString(rawModel.provider);
		const model = optionalString(rawModel.id);
		if (!provider || !model) return [];

		const input = Array.isArray(rawModel.input)
			? rawModel.input.filter((type): type is string => typeof type === "string")
			: [];
		const compat = isJsonRecord(rawModel.compat) ? rawModel.compat : {};
		return [{
			selector: `${provider}/${model}`,
			provider,
			model,
			name: optionalString(rawModel.name) ?? model,
			api: optionalString(rawModel.api),
			capabilities: {
				input,
				images: input.includes("image"),
				reasoning: rawModel.reasoning === true,
				thinkingLevels: getThinkingLevels(rawModel),
				toolSupport: {
					additionalTools: compat.supportsAdditionalTools === true,
					grammarTools: compat.supportsOpenAIGrammarTools === true,
					toolSearch: compat.supportsToolSearch === true,
				},
			},
			limits: {
				contextTokens: optionalNumber(rawModel.contextWindow),
				maxOutputTokens: optionalNumber(rawModel.maxTokens),
			},
			pricing: getPricing(rawModel.cost),
		}];
	}).sort((a, b) => a.selector.localeCompare(b.selector));
}

class ModelDiscoveryError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ModelDiscoveryError";
	}
}

class PiStartupError extends ModelDiscoveryError {
	constructor(message: string) {
		super(message);
		this.name = "PiStartupError";
	}
}

async function listSubagentModels(cwd: string, signal?: AbortSignal, modelSelector?: string): Promise<string> {
	const requestId = "subagent-models";
	const args = ["--mode", "rpc", "--no-session"];
	if (modelSelector) args.push("--model", modelSelector);
	const invocation = getPiInvocation(args);
	const proc = spawn(invocation.command, invocation.args, {
		cwd,
		shell: false,
		stdio: ["pipe", "pipe", "pipe"],
		detached: process.platform !== "win32",
		windowsHide: true,
		env: { ...process.env, PI_SUBAGENT_LITE_DISABLE: "true" },
	});

	let buffer = "";
	let stderr = "";
	let models: unknown[] | undefined;
	let rpcError: string | undefined;
	let spawnError: Error | undefined;
	let stdinError: Error | undefined;
	let timedOut = false;
	let aborted = signal?.aborted ?? false;
	const stdoutDecoder = new StringDecoder("utf8");
	const stderrDecoder = new StringDecoder("utf8");
	const cancelUiRequest = (request: JsonRecord) => {
		const id = optionalString(request.id);
		const method = optionalString(request.method);
		if (aborted || !id || !["select", "confirm", "input", "editor"].includes(method ?? "") || !proc.stdin || proc.stdin.destroyed) return;
		try {
			proc.stdin.write(`${JSON.stringify({ type: "extension_ui_response", id, cancelled: true })}\n`);
		} catch (error) {
			stdinError = error instanceof Error ? error : new Error(String(error));
		}
	};
	const processLine = (line: string) => {
		if (!line.trim()) return;
		try {
			const message: unknown = JSON.parse(line);
			if (!isJsonRecord(message)) return;
			if (message.type === "extension_ui_request") {
				cancelUiRequest(message);
				return;
			}
			if (message.type !== "response" || message.id !== requestId) return;
			if (message.success !== true) {
				rpcError = optionalString(message.error) ?? "Model discovery request failed";
			} else {
				const data = isJsonRecord(message.data) ? message.data : undefined;
				if (Array.isArray(data?.models)) models = data.models;
				else rpcError = "Model discovery response did not include models";
			}
			terminateProcessTree(proc);
		} catch {
			// RPC extensions may emit non-protocol output; only a correlated response matters.
		}
	};

	const exitCode = await new Promise<number>((resolve) => {
		let settled = false;
		const onAbort = () => {
			aborted = true;
			terminateProcessTree(proc);
		};
		const timeout = setTimeout(() => {
			timedOut = true;
			terminateProcessTree(proc);
		}, MODEL_DISCOVERY_TIMEOUT_MS);
		timeout.unref();
		const finish = (code: number) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			signal?.removeEventListener("abort", onAbort);
			resolve(code);
		};

		if (aborted) onAbort();
		else signal?.addEventListener("abort", onAbort, { once: true });

		proc.stdout.on("data", (data) => {
			buffer += stdoutDecoder.write(data);
			const lines = buffer.split("\n");
			buffer = lines.pop() || "";
			for (const line of lines) processLine(line);
		});
		proc.stderr.on("data", (data) => {
			stderr += stderrDecoder.write(data);
		});
		proc.once("close", (code) => {
			buffer += stdoutDecoder.end();
			stderr += stderrDecoder.end();
			if (buffer.trim()) processLine(buffer);
			finish(code ?? 0);
		});
		proc.once("error", (error) => {
			spawnError = error;
			finish(1);
		});
		if (!proc.stdin) {
			spawnError = new Error("Pi RPC stdin is unavailable");
			terminateProcessTree(proc);
			finish(1);
			return;
		}
		proc.stdin.once("error", (error) => {
			stdinError = error;
			if (!models && !rpcError) {
				terminateProcessTree(proc);
				finish(1);
			}
		});
		if (aborted) return;
		try {
			proc.stdin.write(`${JSON.stringify({ id: requestId, type: "get_available_models" })}\n`);
		} catch (error) {
			stdinError = error instanceof Error ? error : new Error(String(error));
			terminateProcessTree(proc);
			finish(1);
		}
	});

	if (aborted || signal?.aborted) throw new ModelDiscoveryError("Model discovery aborted");
	if (timedOut) throw new ModelDiscoveryError(`Model discovery timed out after ${MODEL_DISCOVERY_TIMEOUT_MS / 1000} seconds`);
	// A correlated RPC response intentionally terminates the persistent child,
	// so process-tree termination may produce a non-zero platform exit code.
	if (exitCode !== 0 && !models && !rpcError) {
		const error = spawnError ?? new Error(stderr.trim() || stdinError?.message || `Pi exited with code ${exitCode}`);
		throw new PiStartupError(error.message);
	}
	if (rpcError) throw new ModelDiscoveryError(rpcError);
	if (!models) throw new ModelDiscoveryError(stdinError?.message || stderr.trim() || "Pi did not return a model catalog");
	return JSON.stringify({ schemaVersion: 1, source: "isolated-pi-rpc", models: normalizeDiscoveredModels(models) }, null, 2);
}

function isPiModelSelectorRejection(message: string): boolean {
	return /(?:Unknown provider|Model ".+" (?:not found|is ambiguous)|No models available)/i.test(message);
}

async function validateModelSelector(cwd: string, modelSelector: string, signal?: AbortSignal): Promise<void> {
	try {
		// Starting the same Pi runtime in RPC mode lets its native CLI resolver
		// validate exact selectors, patterns, and :thinking suffixes without
		// starting the task-bearing JSON child process.
		await listSubagentModels(cwd, signal, modelSelector);
	} catch (error) {
		if (signal?.aborted) throw new Error("Subagent aborted by caller");
		const message = error instanceof Error ? error.message : String(error);
		if (error instanceof PiStartupError && isPiModelSelectorRejection(message)) {
			throw new Error(
				`Model selector ${JSON.stringify(modelSelector)} was rejected before launching a subagent: ${message} Refresh subagent_models and choose an available selector.`,
			);
		}
		throw new Error(
			`Unable to validate model selector ${JSON.stringify(modelSelector)} because live model discovery failed: ${message} Retry subagent_models before launching another subagent.`,
		);
	}
}

async function runSubagent(
	cwd: string,
	task: string,
	skills: string[],
	access: AccessMode,
	model?: string,
	thinking?: ThinkingLevel,
	timeoutMs?: number,
	signal?: AbortSignal,
	onUpdate?: (result: AgentToolResult) => void,
): Promise<string> {
	if (timeoutMs !== undefined && (!Number.isInteger(timeoutMs) || timeoutMs < MIN_SUBAGENT_TIMEOUT_MS || timeoutMs > MAX_SUBAGENT_TIMEOUT_MS)) {
		throw new Error(`timeoutMs must be an integer between ${MIN_SUBAGENT_TIMEOUT_MS} and ${MAX_SUBAGENT_TIMEOUT_MS}`);
	}
	if (signal?.aborted) throw new Error("Subagent aborted by caller");

	const modelSelector = model?.trim();
	if (modelSelector !== undefined) {
		if (!modelSelector) throw new Error("model must be a non-empty Pi model ID or provider/model selector");
		await validateModelSelector(cwd, modelSelector, signal);
	}

	const args: string[] = ["--mode", "json", "-p", "--no-session"];
	if (access === "read-only") args.push("--tools", READ_ONLY_TOOLS.join(","));
	if (modelSelector) {
		// Pi performs its native resolution again when launching the task child;
		// the preflight is advisory because configuration can change in between.
		args.push("--model", modelSelector);
	}
	if (thinking) args.push("--thinking", thinking);

	for (const skill of skills) {
		args.push("--skill", skill);
	}

	const releaseWorkspaceWriteLease = access === "workspace-write"
		? acquireWorkspaceWriteLease(cwd)
		: undefined;
	let tmpDir: string | null = null;

	try {
		const selection = [
			`access: ${access}`,
			modelSelector && `model: ${modelSelector}`,
			thinking && `thinking: ${thinking}`,
			timeoutMs !== undefined && `timeout: ${timeoutMs}ms`,
		].filter(Boolean).join(", ");
		onUpdate?.({
			content: [{ type: "text", text: `Subagent running (${selection})...` }],
		});

		tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-"));
		const promptFile = path.join(tmpDir, "prompt.md");
		await fs.promises.writeFile(promptFile, getMinimalSystemPrompt(access), { encoding: "utf-8", mode: 0o600 });
		args.push("--append-system-prompt", promptFile);

		if (task.length > MAX_TASK_ARG_LENGTH) {
			const taskFile = path.join(tmpDir, "task.md");
			await fs.promises.writeFile(taskFile, task, { encoding: "utf-8", mode: 0o600 });
			args.push(`Task: Please read ${taskFile} and follow the instructions there.`);
		} else {
			args.push(`Task: ${task}`);
		}

		const invocation = getPiInvocation(args);
		const proc = spawn(invocation.command, invocation.args, {
			cwd,
			shell: false,
			stdio: ["ignore", "pipe", "pipe"],
			detached: process.platform !== "win32",
			windowsHide: true,
			env: { ...process.env, PI_SUBAGENT_LITE_DISABLE: "true" },
		});

		let buffer = "";
		let stderr = "";
		let spawnError: Error | undefined;
		let lastAssistantText = "";
		let lastAssistantError: string | undefined;
		let turnCount = 0;

		const processLine = (line: string) => {
			const message = parseMessageEnd(line);
			if (!message || message.role !== "assistant") return;

			// JSON mode may exit zero after a provider error. A later successful
			// response clears the error if Pi's automatic retry recovers.
			lastAssistantError = message.stopReason === "error" || message.stopReason === "aborted"
				? message.errorMessage || `Subagent request ${message.stopReason}`
				: undefined;
			const text = getMessageText(message);
			if (text && !lastAssistantError) lastAssistantText = text;

			if (onUpdate) {
				turnCount++;
				onUpdate({
					content: [{ type: "text", text: formatAssistantProgress(message, turnCount) }],
				});
			}
		};

		const onStdoutData = (data: Buffer) => {
			buffer += data.toString();
			const lines = buffer.split("\n");
			buffer = lines.pop() || "";
			for (const line of lines) processLine(line);
		};
		const onStderrData = (data: Buffer) => {
			stderr += data.toString();
		};
		proc.stdout.on("data", onStdoutData);
		proc.stderr.on("data", onStderrData);

		let terminationReason: "caller-abort" | "timeout" | undefined;
		const exitCode = await new Promise<number>((resolve) => {
			let settled = false;
			let timeoutHandle: NodeJS.Timeout | undefined;
			const terminate = (reason: "caller-abort" | "timeout") => {
				if (settled || terminationReason) return;
				terminationReason = reason;
				terminateProcessTree(proc);
			};
			const onAbort = () => terminate("caller-abort");
			const finish = (code: number) => {
				if (settled) return;
				settled = true;
				if (timeoutHandle) clearTimeout(timeoutHandle);
				signal?.removeEventListener("abort", onAbort);
				proc.removeListener("close", onClose);
				proc.removeListener("error", onProcessError);
				proc.stdout.removeListener("data", onStdoutData);
				proc.stderr.removeListener("data", onStderrData);
				resolve(code);
			};
			const onClose = (code: number | null) => {
				if (settled) return;
				if (buffer.trim()) processLine(buffer);
				finish(code ?? 0);
			};
			const onProcessError = (error: Error) => {
				spawnError = error;
				finish(1);
			};

			if (timeoutMs !== undefined) {
				timeoutHandle = setTimeout(() => terminate("timeout"), timeoutMs);
				timeoutHandle.unref();
			}
			if (signal?.aborted) onAbort();
			else signal?.addEventListener("abort", onAbort, { once: true });

			proc.once("close", onClose);
			proc.once("error", onProcessError);
		});

		if (terminationReason === "caller-abort") throw new Error("Subagent aborted by caller");
		if (terminationReason === "timeout") throw new Error(`Subagent timed out after ${timeoutMs}ms`);

		if (exitCode !== 0) {
			throw spawnError ?? new Error(stderr.trim() || lastAssistantError || `Subagent exited with code ${exitCode}`);
		}
		if (lastAssistantError) throw new Error(lastAssistantError);

		return lastAssistantText;
	} finally {
		try {
			if (tmpDir) await fs.promises.rm(tmpDir, { recursive: true, force: true });
		} catch {
			/* ignore */
		} finally {
			releaseWorkspaceWriteLease?.();
		}
	}
}

const SubagentParams = Type.Object({
	task: Type.String({ description: "Bounded delegation task. For non-trivial work, state the objective, scope, access expectations, exclusions, verification, stopping conditions, and requested report format." }),
	model: Type.Optional(
		Type.String({
			description: "Pi model selector returned by subagent_models, preferably provider/model. Shorthand and :thinking suffixes are supported by Pi. Omit to use the child Pi process's configured default, not the parent session's active model.",
			minLength: 1,
			pattern: "\\S",
		}),
	),
	thinking: Type.Optional(
		Type.Union(THINKING_LEVELS.map((level) => Type.Literal(level)), {
			description: "Pi thinking level for the child model. Displayed with the selected model.",
		}),
	),
	access: Type.Optional(
		Type.Union(ACCESS_MODES.map((mode) => Type.Literal(mode)), {
			description: "Child tool access mode. read-only enables only read, grep, find, and ls; workspace-write preserves Pi's normal tool configuration. Defaults to workspace-write for compatibility.",
		}),
	),
	timeoutMs: Type.Optional(
		Type.Integer({
			description: "Maximum child runtime in milliseconds. Omit for no extension-imposed deadline.",
			minimum: MIN_SUBAGENT_TIMEOUT_MS,
			maximum: MAX_SUBAGENT_TIMEOUT_MS,
		}),
	),
	skills: Type.Optional(
		Type.Array(Type.String({ description: "Skill path or name to load via --skill" }), {
			description: "Optional startup skills to load into the subagent process",
		}),
	),
});

export default function (pi: ExtensionAPI) {
	if (process.env.PI_SUBAGENT_LITE_DISABLE === "true") {
		return;
	}

	pi.registerTool({
		name: "subagent_models",
		label: "Subagent Models",
		description: "Discover the isolated Pi child process's live model catalog as structured JSON. Each model includes a selector, modality, exact thinking levels, token limits, configured cost metadata, and supported tool capabilities. Use it before selecting a subagent model in a fresh session or after model configuration changes. Compare objective requirements such as image input, context, output budget, and configured cost; do not infer unreported quality or latency.",
		promptSnippet: "Discover the child model catalog and compare objective capabilities",
		promptGuidelines: [
			"Before the first model-selected subagent call in a session, use subagent_models to obtain live selectors and capabilities. Pick explicitly based on task requirements: modality, context, output budget, supported thinking levels, and configured cost. Metadata does not establish relative quality, actual billing, or latency.",
		],
		parameters: Type.Object({}),

		async execute(_toolCallId, _params, signal, _onUpdate, ctx) {
			const output = await listSubagentModels(ctx.cwd, signal);
			return { content: [{ type: "text", text: output }] };
		},
	});

	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description: "Delegate tasks to fresh pi subagents with isolated context windows. Read-only calls and workspace-write calls using different working directories may run in parallel; a second workspace-write call for the same working directory is rejected while the first is active. Each subagent returns a concise report when its work is done. A successful tool result is provisional: it is not proof that tests passed or that the parent should accept the work. Select read-only or workspace-write access and an optional runtime deadline per call; workspace-write with no deadline is the compatibility default. A model and thinking level can be selected per call, and optional startup skills can be preloaded. Use subagent_models to compare the child runtime's live selectors, capabilities, limits, and configured cost metadata before selecting one in a fresh session.",
		promptSnippet: "Delegate a bounded task and receive a provisional report",
		promptGuidelines: [
			"Delegate non-trivial, self-contained tasks to subagents so you can stay focused on the overall picture.",
			"For non-trivial delegation, state the objective, scope, access expectations, exclusions, verification, stopping conditions, and desired report format in the task.",
			"Treat every successful subagent result as a provisional report, not proof that tests passed or that the task is accepted. Review the reported evidence, unresolved blockers, uncertainty, and workspace state before deciding next steps.",
			"Parallelize read-only work freely, but run at most one workspace-write subagent per working directory at a time; a concurrent same-directory writer is rejected rather than queued.",
			"Before selecting a subagent model in a fresh session, use subagent_models. Select from its live catalog based on the task's concrete needs; do not guess selectors or assume the parent model is available to the child.",
		],
		parameters: SubagentParams,

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			// Pi marks thrown errors as failed tool results; returning isError does not.
			const output = await runSubagent(
				ctx.cwd,
				params.task,
				params.skills ?? [],
				params.access ?? DEFAULT_ACCESS_MODE,
				params.model,
				params.thinking,
				params.timeoutMs,
				signal,
				onUpdate,
			);
			return {
				content: [{ type: "text", text: output || "(no output)" }],
			};
		},

		renderCall(args, theme, context) {
			const task = args.task ?? "";
			const taskPreview = task.length > 60 ? task.slice(0, 60) + "..." : task;
			let text = theme.fg("toolTitle", theme.bold("subagent ")) + theme.fg("dim", taskPreview);
			const access = args.access ?? (context.argsComplete ? DEFAULT_ACCESS_MODE : undefined);
			if (access) text += ` ${theme.fg("accent", `[access: ${access}]`)}`;
			const model = args.model?.trim();
			if (model) text += ` ${theme.fg("accent", `[${model}]`)}`;
			if (args.thinking) text += ` ${theme.fg("accent", `[thinking: ${args.thinking}]`)}`;
			if (args.timeoutMs !== undefined) text += ` ${theme.fg("accent", `[timeout: ${args.timeoutMs}ms]`)}`;
			const skillsArr = args.skills ?? [];
			if (skillsArr.length > 0) {
				text += ` ${theme.fg("accent", `+${skillsArr.length} skills`)}`;
			}
			return new Text(text, 0, 0);
		},

		renderResult(result, options, theme, context) {
			const output = result.content.find((c) => c.type === "text")?.text ?? "";
			if (options.isPartial) {
				return new Text(theme.fg("muted", output || "Subagent running..."), 0, 0);
			}
			const marker = context.isError ? theme.fg("error", "✗ ") : theme.fg("success", "✓ ");
			const separator = theme.fg("muted", "--- Result ---");
			const text = `${marker}${separator}\n${output}`;
			return new Text(text, 0, 0);
		},
	});
}
