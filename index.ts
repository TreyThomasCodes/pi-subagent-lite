/**
 * Minimal subagent extension
 *
 * Delegates a task to a fresh pi process with an isolated context window.
 * Optionally selects a model via --model and loads startup skills via --skill flags.
 */

import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Message } from "@earendil-works/pi-ai";
import { type AgentToolResult, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "@sinclair/typebox";

const MAX_TASK_ARG_LENGTH = 4000;
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
type ThinkingLevel = (typeof THINKING_LEVELS)[number];

const MINIMAL_SYSTEM_PROMPT = `You are a subagent running in an isolated pi process with access to file system and shell tools.

Your job is to focus exclusively on the assigned task, use tools as needed, and provide a clear, concise report or summary at the end.

Guidelines:
- Stay focused on the task. Do not drift into unrelated work.
- Be concise, but include enough detail for the parent agent to act on your findings.
- End with a clear summary or conclusion.`;

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

function terminateProcess(proc: ChildProcess): void {
	if (proc.exitCode !== null || proc.signalCode !== null) return;

	const forceKillTimer = setTimeout(() => {
		if (proc.exitCode === null && proc.signalCode === null) {
			proc.kill("SIGKILL");
		}
	}, 5000);
	forceKillTimer.unref();

	const clearForceKillTimer = () => clearTimeout(forceKillTimer);
	proc.once("close", clearForceKillTimer);
	proc.once("error", clearForceKillTimer);
	proc.kill("SIGTERM");
}

async function listSubagentModels(cwd: string, signal?: AbortSignal): Promise<string> {
	const invocation = getPiInvocation(["--list-models"]);
	const proc = spawn(invocation.command, invocation.args, {
		cwd,
		shell: false,
		stdio: ["ignore", "pipe", "pipe"],
		env: { ...process.env, PI_SUBAGENT_LITE_DISABLE: "true" },
	});

	let stdout = "";
	let stderr = "";
	let spawnError: Error | undefined;
	const exitCode = await new Promise<number>((resolve) => {
		let settled = false;
		const onAbort = () => terminateProcess(proc);
		const finish = (code: number) => {
			if (settled) return;
			settled = true;
			signal?.removeEventListener("abort", onAbort);
			resolve(code);
		};

		if (signal?.aborted) onAbort();
		else signal?.addEventListener("abort", onAbort, { once: true });

		proc.stdout.on("data", (data) => {
			stdout += data.toString();
		});
		proc.stderr.on("data", (data) => {
			stderr += data.toString();
		});
		proc.once("close", (code) => finish(code ?? 0));
		proc.once("error", (error) => {
			spawnError = error;
			finish(1);
		});
	});

	if (signal?.aborted) throw new Error("Model discovery aborted");
	if (exitCode !== 0) throw spawnError ?? new Error(stderr.trim() || `Pi exited with code ${exitCode}`);
	return stdout.trim() || "No models are currently available to the isolated subagent process.";
}

async function runSubagent(
	cwd: string,
	task: string,
	skills: string[],
	model?: string,
	thinking?: ThinkingLevel,
	signal?: AbortSignal,
	onUpdate?: (result: AgentToolResult) => void,
): Promise<string> {
	const args: string[] = ["--mode", "json", "-p", "--no-session"];
	const modelSelector = model?.trim();
	if (modelSelector !== undefined) {
		if (!modelSelector) throw new Error("model must be a non-empty Pi model ID or provider/model selector");
		// Let Pi resolve providers, shorthand matches, and thinking-level suffixes.
		args.push("--model", modelSelector);
	}
	if (thinking) args.push("--thinking", thinking);

	for (const skill of skills) {
		args.push("--skill", skill);
	}

	let tmpDir: string | null = null;

	try {
		const selection = [
			modelSelector && `model: ${modelSelector}`,
			thinking && `thinking: ${thinking}`,
		].filter(Boolean).join(", ");
		onUpdate?.({
			content: [{ type: "text", text: selection ? `Subagent running (${selection})...` : "Subagent running..." }],
		});

		tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-"));
		const promptFile = path.join(tmpDir, "prompt.md");
		await fs.promises.writeFile(promptFile, MINIMAL_SYSTEM_PROMPT, { encoding: "utf-8", mode: 0o600 });
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

		proc.stdout.on("data", (data) => {
			buffer += data.toString();
			const lines = buffer.split("\n");
			buffer = lines.pop() || "";
			for (const line of lines) processLine(line);
		});

		proc.stderr.on("data", (data) => {
			stderr += data.toString();
		});

		const exitCode = await new Promise<number>((resolve) => {
			let settled = false;
			const onAbort = () => terminateProcess(proc);
			const finish = (code: number) => {
				if (settled) return;
				settled = true;
				signal?.removeEventListener("abort", onAbort);
				resolve(code);
			};

			if (signal?.aborted) {
				onAbort();
			} else {
				signal?.addEventListener("abort", onAbort, { once: true });
			}

			proc.once("close", (code) => {
				if (settled) return;
				if (buffer.trim()) processLine(buffer);
				finish(code ?? 0);
			});
			proc.once("error", (error) => {
				spawnError = error;
				finish(1);
			});
		});

		if (signal?.aborted) throw new Error("Subagent aborted");

		if (exitCode !== 0) {
			throw spawnError ?? new Error(stderr.trim() || lastAssistantError || `Subagent exited with code ${exitCode}`);
		}
		if (lastAssistantError) throw new Error(lastAssistantError);

		return lastAssistantText;
	} finally {
		if (tmpDir) {
			try {
				await fs.promises.rm(tmpDir, { recursive: true, force: true });
			} catch {
				/* ignore */
			}
		}
	}
}

const SubagentParams = Type.Object({
	task: Type.String({ description: "Task to delegate to the subagent" }),
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
		description: "List the models available to the isolated Pi child process, including its exact provider/model selectors and thinking support. Call this before choosing a subagent model in a fresh session or after model configuration changes. Do not invent model selectors.",
		promptSnippet: "Discover the models available to isolated subagents",
		promptGuidelines: [
			"Before the first model-selected subagent call in a session, use subagent_models to discover valid selectors. Choose an explicit model appropriate to the task; do not rely on the child default when cost or capability matters.",
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
		description: "Delegate tasks to fresh pi subagents with isolated context windows. You may invoke multiple subagents in parallel via separate tool calls. Each subagent returns a concise summary or report when its work is done. A model can be selected per call, and optional startup skills can be preloaded. Use subagent_models to discover valid model selectors before selecting one in a fresh session.",
		promptSnippet: "Delegate a task to an isolated subagent process",
		promptGuidelines: [
			"Delegate non-trivial, self-contained tasks to subagents so you can stay focused on the overall picture.",
			"Before selecting a subagent model in a fresh session, use subagent_models. Do not guess selectors or assume the parent model is available to the child.",
		],
		parameters: SubagentParams,

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			// Pi marks thrown errors as failed tool results; returning isError does not.
			const output = await runSubagent(ctx.cwd, params.task, params.skills ?? [], params.model, params.thinking, signal, onUpdate);
			return {
				content: [{ type: "text", text: output || "(no output)" }],
			};
		},

		renderCall(args, theme) {
			const task = args.task ?? "";
			const taskPreview = task.length > 60 ? task.slice(0, 60) + "..." : task;
			let text = theme.fg("toolTitle", theme.bold("subagent ")) + theme.fg("dim", taskPreview);
			const model = args.model?.trim();
			if (model) text += ` ${theme.fg("accent", `[${model}]`)}`;
			if (args.thinking) text += ` ${theme.fg("accent", `[thinking: ${args.thinking}]`)}`;
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
