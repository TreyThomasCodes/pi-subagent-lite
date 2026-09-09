import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { stripVTControlCharacters } from "node:util";
import type { AgentToolResult, ExtensionAPI, ToolRenderContext } from "@earendil-works/pi-coding-agent";
import type { TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import registerSubagent from "../index.js";

type SubagentTool = Parameters<ExtensionAPI["registerTool"]>[0];
type SubagentInput = { task: string; model?: string; thinking?: string; access?: string; timeoutMs?: number; skills?: string[] };
type Invocation = { args: string[]; cwd: string; disabled: string; prompt: string; task: string; thinking?: string; tools?: string };

// Exercise the real spawn/argument/parsing path without invoking Pi or a paid model.
const FAKE_PI = String.raw`
const fs = require("node:fs");
const { spawn } = require("node:child_process");
const args = process.argv.slice(2);
const modelIndex = args.indexOf("--model");
const model = modelIndex === -1 ? undefined : args[modelIndex + 1];
const modelPreflightFile = process.env.PI_SUBAGENT_TEST_MODEL_PREFLIGHT_FILE;
const taskSpawnFile = process.env.PI_SUBAGENT_TEST_TASK_SPAWN_FILE;
const thinkingIndex = args.indexOf("--thinking");
const thinking = thinkingIndex === -1 ? undefined : args[thinkingIndex + 1];
const toolsIndex = args.indexOf("--tools");
const tools = toolsIndex === -1 ? undefined : args[toolsIndex + 1];
const emit = (message) => process.stdout.write(JSON.stringify({ type: "message_end", message }) + "\n");
if (args.includes("--mode") && args[args.indexOf("--mode") + 1] === "rpc") {
  const mode = process.env.PI_SUBAGENT_TEST_MODE;
  if (model && modelPreflightFile) fs.appendFileSync(modelPreflightFile, model + "\n");
  if (mode === "model-rejected" && model === "_fixture_invalid_model_") {
    process.stderr.write('Model "_fixture_invalid_model_" not found. Use --list-models to see available models.\n');
    process.exit(1);
  }
  let input = "";
  const respondWithCatalog = (id) => {
    const response = JSON.stringify({
      id,
      type: "response",
      command: "get_available_models",
      success: true,
      data: {
        models: [
          {
            provider: "fixture",
            id: "economical-model",
            name: "Économical fixture",
            api: "fixture-api",
            reasoning: true,
            thinkingLevelMap: { off: null, low: null, xhigh: "xhigh", max: null },
            input: ["text", "image"],
            contextWindow: 200000,
            maxTokens: 32000,
            cost: {
              input: 1,
              output: 2,
              cacheRead: 0.1,
              cacheWrite: 0.2,
              tiers: [{ inputTokensAbove: 100000, input: 2, output: 4, cacheRead: 0.2, cacheWrite: 0.4 }],
            },
            compat: { supportsAdditionalTools: true, supportsOpenAIGrammarTools: true, supportsToolSearch: true },
          },
          { provider: "fixture", id: "basic-model", reasoning: false, input: ["text"], contextWindow: 1000, maxTokens: 100 },
          { provider: "missing-id" },
        ],
      },
    }) + "\n";
    process.stdout.write(JSON.stringify({ type: "extension_ui_request", id: "unrelated", method: "setStatus" }) + "\n");
    if (mode === "fragmented") {
      const encoded = Buffer.from(response);
      const split = encoded.indexOf(Buffer.from("É")) + 1;
      process.stdout.write(encoded.subarray(0, split));
      setImmediate(() => process.stdout.write(encoded.subarray(split)));
    } else {
      process.stdout.write(response);
    }
  };
  const processCommand = (line) => {
    const command = JSON.parse(line);
    if (command.type === "get_available_models") {
      if (mode === "hang") return;
      if (mode === "failure" || mode === "failure-no-models") {
        const error = mode === "failure-no-models" ? "No models available" : "Fixture discovery failed";
        process.stdout.write(JSON.stringify({ id: command.id, type: "response", command: command.type, success: false, error }) + "\n");
      } else if (mode === "ui") {
        process.stdout.write(JSON.stringify({ type: "extension_ui_request", id: "fixture-dialog", method: "confirm" }) + "\n");
      } else {
        respondWithCatalog(command.id);
      }
    } else if (command.type === "extension_ui_response" && command.id === "fixture-dialog" && command.cancelled === true) {
      respondWithCatalog("subagent-models");
    }
  };
  process.stdin.on("data", (chunk) => {
    input += chunk;
    const lines = input.split("\n");
    input = lines.pop();
    for (const line of lines) if (line) processCommand(line);
  });
} else {
  if (taskSpawnFile) fs.appendFileSync(taskSpawnFile, (model || "(default)") + "\n");
  if (model === "_fixture_hanging_tree_") {
    emit({ role: "assistant", content: [{ type: "text", text: "Starting bounded work" }], stopReason: "toolUse" });
    const descendant = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    const promptIndex = args.indexOf("--append-system-prompt");
    fs.writeFileSync(process.env.PI_SUBAGENT_TEST_PID_FILE, JSON.stringify({
      pid: descendant.pid,
      rootPid: process.pid,
      promptFile: promptIndex >= 0 ? args[promptIndex + 1] : undefined,
    }));
    setInterval(() => {}, 1000);
  } else if (model === "_fixture_error_then_hang_") {
    emit({ role: "assistant", content: [{ type: "text", text: "Earlier terminal error must not be treated as final" }], stopReason: "error", errorMessage: "Transient provider failure" });
    emit({ role: "assistant", content: [{ type: "text", text: "Retry is still running" }], stopReason: "toolUse" });
    setInterval(() => {}, 1000);
  } else if (model === "_fixture_oversized_protocol_") {
    process.stdout.write("x".repeat(1_000_001) + "\n");
  } else if (model === "_fixture_signaled_") {
    process.kill(process.pid, "SIGTERM");
  } else if (model === "_fixture_invalid_model_") {
    process.stderr.write('Model "_fixture_invalid_model_" not found. Use --list-models to see available models.\n');
    process.exitCode = 1;
  } else if (["_fixture_provider_error_", "_fixture_aborted_", "_fixture_empty_error_"].includes(model)) {
    emit({
      role: "assistant",
      content: [{ type: "text", text: "Incomplete answer that must not be returned as a success" }],
      stopReason: model === "_fixture_aborted_" ? "aborted" : "error",
      errorMessage: model === "_fixture_empty_error_" ? undefined : "Provider rejected the request",
    });
  } else {
    if (model === "_fixture_recovered_") {
      emit({ role: "assistant", content: [], stopReason: "error", errorMessage: "Transient provider failure" });
    }
    const promptFile = args[args.indexOf("--append-system-prompt") + 1];
    const taskArg = args.at(-1);
    const spillPrefix = "Task: Please read ";
    const spillSuffix = " and follow the instructions there.";
    const task = taskArg.startsWith(spillPrefix)
      ? fs.readFileSync(taskArg.slice(spillPrefix.length, -spillSuffix.length), "utf8")
      : taskArg.slice("Task: ".length);
    const text = JSON.stringify({
      args,
      cwd: process.cwd(),
      disabled: process.env.PI_SUBAGENT_LITE_DISABLE,
      prompt: fs.readFileSync(promptFile, "utf8"),
      task,
      thinking,
      tools,
    });
    emit({ role: "assistant", content: [{ type: "text", text }], stopReason: "stop" });
  }
}
`;

test("subagent model selection", { timeout: 30_000 }, async (t) => {
	const fixtureDir = await mkdtemp(join(tmpdir(), "subagent-model-test-"));
	const originalScript = process.argv[1];
	const originalDisabled = process.env.PI_SUBAGENT_LITE_DISABLE;
	const originalPidFile = process.env.PI_SUBAGENT_TEST_PID_FILE;
	const originalModelPreflightFile = process.env.PI_SUBAGENT_TEST_MODEL_PREFLIGHT_FILE;
	const originalTaskSpawnFile = process.env.PI_SUBAGENT_TEST_TASK_SPAWN_FILE;
	const pidFile = join(fixtureDir, "descendant.pid");
	const modelPreflightFile = join(fixtureDir, "model-preflights.log");
	const taskSpawnFile = join(fixtureDir, "task-spawns.log");
	const descendantPids = new Set<number>();
	t.after(async () => {
		process.argv[1] = originalScript;
		if (originalDisabled === undefined) delete process.env.PI_SUBAGENT_LITE_DISABLE;
		else process.env.PI_SUBAGENT_LITE_DISABLE = originalDisabled;
		if (originalPidFile === undefined) delete process.env.PI_SUBAGENT_TEST_PID_FILE;
		else process.env.PI_SUBAGENT_TEST_PID_FILE = originalPidFile;
		if (originalModelPreflightFile === undefined) delete process.env.PI_SUBAGENT_TEST_MODEL_PREFLIGHT_FILE;
		else process.env.PI_SUBAGENT_TEST_MODEL_PREFLIGHT_FILE = originalModelPreflightFile;
		if (originalTaskSpawnFile === undefined) delete process.env.PI_SUBAGENT_TEST_TASK_SPAWN_FILE;
		else process.env.PI_SUBAGENT_TEST_TASK_SPAWN_FILE = originalTaskSpawnFile;
		for (const pid of descendantPids) {
			try {
				process.kill(pid, "SIGKILL");
			} catch {
				/* already stopped */
			}
		}
		await rm(fixtureDir, { recursive: true, force: true });
	});

	const fixtureScript = join(fixtureDir, "fake-pi.cjs");
	const otherCwd = join(fixtureDir, "other-workspace");
	await Promise.all([writeFile(fixtureScript, FAKE_PI), mkdir(otherCwd)]);
	// This file's tests run serially in their own test-runner process. Point the
	// normal getPiInvocation path at the fixture and restore it in the hook above.
	process.argv[1] = fixtureScript;
	delete process.env.PI_SUBAGENT_LITE_DISABLE;
	process.env.PI_SUBAGENT_TEST_PID_FILE = pidFile;
	process.env.PI_SUBAGENT_TEST_MODEL_PREFLIGHT_FILE = modelPreflightFile;
	process.env.PI_SUBAGENT_TEST_TASK_SPAWN_FILE = taskSpawnFile;
	const registeredTools: SubagentTool[] = [];
	registerSubagent({ registerTool: (tool) => { registeredTools.push(tool); } });
	const tool = registeredTools.find((candidate) => candidate.name === "subagent");
	const modelsTool = registeredTools.find((candidate) => candidate.name === "subagent_models");
	assert.ok(tool);
	assert.ok(modelsTool);
	const parentModel = Object.freeze({ provider: "parent-provider", id: "parent-model" });
	const ctx = Object.freeze({ cwd: fixtureDir, hasUI: false, model: parentModel });
	const task = "Find all test files";
	const isProcessRunning = (pid: number) => {
		try {
			process.kill(pid, 0);
			return true;
		} catch (error) {
			return (error as NodeJS.ErrnoException).code === "EPERM";
		}
	};
	const readDescendantState = async (): Promise<{ pid: number; rootPid: number; promptFile: string }> => {
		const deadline = Date.now() + 5_000;
		while (Date.now() < deadline) {
			try {
				const state = JSON.parse(await readFile(pidFile, "utf8")) as { pid?: unknown; rootPid?: unknown; promptFile?: unknown };
				if (
					Number.isInteger(state.pid) && (state.pid as number) > 0
					&& Number.isInteger(state.rootPid) && (state.rootPid as number) > 0
					&& typeof state.promptFile === "string"
				) {
					descendantPids.add(state.pid as number);
					descendantPids.add(state.rootPid as number);
					return state as { pid: number; rootPid: number; promptFile: string };
				}
			} catch {
				/* wait for the fake child to spawn its descendant */
			}
			await delay(20);
		}
		throw new Error("Fake Pi did not report its process-tree state");
	};
	const waitForProcessExit = async (pid: number) => {
		const deadline = Date.now() + 5_000;
		while (Date.now() < deadline && isProcessRunning(pid)) await delay(20);
		assert.equal(isProcessRunning(pid), false, `descendant process ${pid} survived termination`);
		descendantPids.delete(pid);
	};

	await t.test("discovers a structured model catalog from the isolated child process", async () => {
		const result = await modelsTool.execute("models-test", {}, undefined, undefined, ctx);
		const catalog = JSON.parse(result.content[0].text) as {
			schemaVersion: number;
			source: string;
			models: Array<{
				selector: string;
				name: string;
				capabilities: { input: string[]; images: boolean; reasoning: boolean; thinkingLevels: string[]; toolSupport: Record<string, boolean> };
				limits: { contextTokens?: number; maxOutputTokens?: number };
				pricing?: { unit: string; input: number; tiers: Array<{ inputTokensAbove: number }> };
			}>;
		};
		assert.equal(catalog.schemaVersion, 1);
		assert.equal(catalog.source, "isolated-pi-rpc");
		assert.deepEqual(catalog.models.map((model) => model.selector), ["fixture/basic-model", "fixture/economical-model"]);
		const economical = catalog.models[1];
		assert.equal(economical.name, "Économical fixture");
		assert.deepEqual(economical.capabilities.input, ["text", "image"]);
		assert.equal(economical.capabilities.images, true);
		assert.deepEqual(economical.capabilities.thinkingLevels, ["minimal", "medium", "high", "xhigh"]);
		assert.deepEqual(economical.capabilities.toolSupport, { additionalTools: true, grammarTools: true, toolSearch: true });
		assert.deepEqual(economical.limits, { contextTokens: 200000, maxOutputTokens: 32000 });
		assert.deepEqual(economical.pricing, {
			unit: "USD per million tokens", input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.2,
			tiers: [{ inputTokensAbove: 100000, input: 2, output: 4, cacheRead: 0.2, cacheWrite: 0.4 }],
		});
		assert.deepEqual(catalog.models[0].capabilities.thinkingLevels, ["off"]);
		assert.match(modelsTool.description, /structured JSON/);
		assert.match(tool.description, /subagent_models/);
	});

	await t.test("registered metadata defines bounded delegation and provisional results", () => {
		const guidelines = tool.promptGuidelines?.join(" ") ?? "";
		assert.match(tool.description, /successful tool result is provisional.*not proof that tests passed.*accept/i);
		assert.match(tool.promptSnippet ?? "", /bounded task.*provisional report/i);
		assert.match(guidelines, /objective.*scope.*access expectations.*exclusions.*verification.*stopping conditions.*report format/i);
		assert.match(guidelines, /successful subagent result.*provisional report.*not proof.*tests passed.*accepted/i);
	});

	const withDiscoveryMode = async (mode: string, action: () => Promise<void>) => {
		const originalMode = process.env.PI_SUBAGENT_TEST_MODE;
		process.env.PI_SUBAGENT_TEST_MODE = mode;
		try {
			await action();
		} finally {
			if (originalMode === undefined) delete process.env.PI_SUBAGENT_TEST_MODE;
			else process.env.PI_SUBAGENT_TEST_MODE = originalMode;
		}
	};

	await t.test("cancels blocking extension UI requests during model discovery", async () => {
		await withDiscoveryMode("ui", async () => {
			const result = await modelsTool.execute("models-ui-test", {}, undefined, undefined, ctx);
			assert.equal(JSON.parse(result.content[0].text).models.length, 2);
		});
	});

	await t.test("preserves fragmented UTF-8 RPC output", async () => {
		await withDiscoveryMode("fragmented", async () => {
			const result = await modelsTool.execute("models-fragmented-test", {}, undefined, undefined, ctx);
			const economical = JSON.parse(result.content[0].text).models.find((model: { selector: string }) => model.selector === "fixture/economical-model");
			assert.equal(economical.name, "Économical fixture");
		});
	});

	await t.test("propagates RPC model-discovery failures", async () => {
		await withDiscoveryMode("failure", async () => {
			await assert.rejects(modelsTool.execute("models-failure-test", {}, undefined, undefined, ctx), /Fixture discovery failed/);
		});
	});

	await t.test("aborts a waiting RPC model discovery", async () => {
		await withDiscoveryMode("hang", async () => {
			const controller = new AbortController();
			setTimeout(() => controller.abort(), 20).unref();
			await assert.rejects(modelsTool.execute("models-abort-test", {}, controller.signal, undefined, ctx), /Model discovery aborted/);
		});
	});

	const invoke = async (params: SubagentInput, updates?: AgentToolResult[], invocationCtx = ctx): Promise<Invocation> => {
		const result = await tool.execute("model-test", params, undefined, updates ? (r) => updates.push(r) : undefined, invocationCtx);
		const invocation = JSON.parse(result.content[0].text) as Invocation;
		const promptFile = invocation.args[invocation.args.indexOf("--append-system-prompt") + 1];
		assert.equal(existsSync(dirname(promptFile)), false, "temporary prompts are cleaned up");
		return invocation;
	};

	await t.test("schema makes optional selections strict", () => {
		const schema = tool.parameters as TSchema;
		const taskDescription = (schema as unknown as { properties?: { task?: { description?: string } } })
			.properties?.task?.description ?? "";
		assert.match(taskDescription, /objective.*scope.*access expectations.*exclusions.*verification.*stopping conditions.*report format/i);
		assert.equal(Value.Check(schema, { task }), true);
		assert.equal(Value.Check(schema, { task, model: "anthropic/claude-haiku-4-5" }), true);
		assert.equal(Value.Check(schema, { task, thinking: "high" }), true);
		assert.equal(Value.Check(schema, { task, thinking: "ultra" }), false);
		assert.equal(Value.Check(schema, { task, access: "read-only" }), true);
		assert.equal(Value.Check(schema, { task, access: "workspace-write" }), true);
		assert.equal(Value.Check(schema, { task, access: "write" }), false);
		assert.equal(Value.Check(schema, { task, timeoutMs: 1_000 }), true);
		assert.equal(Value.Check(schema, { task, timeoutMs: 86_400_000 }), true);
		for (const timeoutMs of [999, 86_400_001, 1_000.5, "1000", null]) {
			assert.equal(Value.Check(schema, { task, timeoutMs }), false, `invalid timeout: ${JSON.stringify(timeoutMs)}`);
		}
		for (const model of ["", " \t\n", 42, null, [], {}]) {
			assert.equal(Value.Check(schema, { task, model }), false, `invalid model: ${JSON.stringify(model)}`);
		}
	});

	for (const model of [
		"anthropic/claude-haiku-4-5",
		"claude-haiku-4-5",
		"haiku",
		"openrouter/anthropic/claude-sonnet-4.5",
		"ollama/qwen2.5-coder:7b",
		"anthropic/claude-sonnet-4-5:high",
		"custom/model with spaces:$value;echo literal",
	]) {
		await t.test(`passes ${JSON.stringify(model)} as a single --model value`, async () => {
			const updates: AgentToolResult[] = [];
			const invocation = await invoke({ task, model }, updates);
			assert.deepEqual(invocation.args.slice(0, 6), ["--mode", "json", "-p", "--no-session", "--model", model]);
			assert.equal(invocation.args[6], "--append-system-prompt");
			assert.equal(invocation.args.at(-1), `Task: ${task}`);
			assert.equal(invocation.task, task);
			assert.equal(invocation.cwd, fixtureDir);
			assert.equal(invocation.disabled, "true");
			assert.match(invocation.prompt, /You are a subagent/);
			assert.equal(updates[0].content[0].text, `Subagent running (access: workspace-write, model: ${model})...`);
			assert.match(updates[1].content[0].text, /^Turn 1:/);
		});
	}

	await t.test("omitting model preserves defaults without a catalog preflight", async () => {
		const updates: AgentToolResult[] = [];
		await withDiscoveryMode("failure", async () => {
			const invocation = await invoke({ task }, updates);
			assert.deepEqual(invocation.args.slice(0, 5), ["--mode", "json", "-p", "--no-session", "--append-system-prompt"]);
			assert.equal(invocation.args.includes("--model"), false);
			assert.equal(invocation.args.includes("--provider"), false);
			assert.equal(invocation.args.includes("--thinking"), false);
		});
		assert.equal(updates[0].content[0].text, "Subagent running (access: workspace-write)...");
		assert.equal(ctx.model, parentModel);
	});

	await t.test("preflights returned exact selectors and preserves native shorthand", async () => {
		await rm(modelPreflightFile, { force: true });
		const exact = await invoke({ task, model: "fixture/economical-model" });
		const shorthand = await invoke({ task, model: "economical" });
		assert.equal(exact.args[5], "fixture/economical-model");
		assert.equal(shorthand.args[5], "economical");
		assert.deepEqual((await readFile(modelPreflightFile, "utf8")).trim().split("\n"), ["fixture/economical-model", "economical"]);
	});

	await t.test("trims surrounding whitespace", async () => {
		const invocation = await invoke({ task, model: " \tanthropic/claude-haiku-4-5\n" });
		assert.equal(invocation.args[5], "anthropic/claude-haiku-4-5");
	});

	await t.test("passes and displays the requested thinking level", async () => {
		const updates: AgentToolResult[] = [];
		const invocation = await invoke({ task, model: "haiku", thinking: "high" }, updates);
		assert.deepEqual(invocation.args.slice(4, 8), ["--model", "haiku", "--thinking", "high"]);
		assert.equal(invocation.thinking, "high");
		assert.equal(updates[0].content[0].text, "Subagent running (access: workspace-write, model: haiku, thinking: high)...");
	});

	await t.test("forwards thinking off", async () => {
		const updates: AgentToolResult[] = [];
		const invocation = await invoke({ task, model: "haiku", thinking: "off" }, updates);
		assert.deepEqual(invocation.args.slice(4, 8), ["--model", "haiku", "--thinking", "off"]);
		assert.equal(invocation.thinking, "off");
		assert.equal(updates[0].content[0].text, "Subagent running (access: workspace-write, model: haiku, thinking: off)...");
	});

	await t.test("forwards thinking without a model and displays it in progress", async () => {
		const updates: AgentToolResult[] = [];
		const invocation = await invoke({ task, thinking: "high" }, updates);
		assert.deepEqual(invocation.args.slice(4, 7), ["--thinking", "high", "--append-system-prompt"]);
		assert.equal(invocation.args.includes("--model"), false);
		assert.equal(invocation.thinking, "high");
		assert.equal(updates[0].content[0].text, "Subagent running (access: workspace-write, thinking: high)...");
	});

	await t.test("enforces read-only mode with an explicit non-mutating tool allowlist", async () => {
		const updates: AgentToolResult[] = [];
		const invocation = await invoke({ task, access: "read-only" }, updates);
		assert.deepEqual(invocation.args.slice(0, 7), [
			"--mode", "json", "-p", "--no-session", "--tools", "read,grep,find,ls", "--append-system-prompt",
		]);
		assert.equal(invocation.tools, "read,grep,find,ls");
		assert.match(invocation.prompt, /read-only access mode/);
		assert.match(invocation.prompt, /do not modify the workspace/);
		assert.equal(updates[0].content[0].text, "Subagent running (access: read-only)...");
	});

	await t.test("explicit workspace-write mode preserves Pi's normal tool configuration", async () => {
		const updates: AgentToolResult[] = [];
		const invocation = await invoke({ task, access: "workspace-write" }, updates);
		assert.equal(invocation.args.includes("--tools"), false);
		assert.equal(invocation.tools, undefined);
		assert.match(invocation.prompt, /workspace-write access mode/);
		assert.match(invocation.prompt, /objective, scope, access expectations, exclusions, verification, stopping conditions, and requested report format/);
		assert.match(invocation.prompt, /commands and checks actually run with their outcomes, unresolved blockers, and material uncertainty/);
		assert.match(invocation.prompt, /never claim that an unrun check passed/);
		assert.match(invocation.prompt, /Do not claim parent-level acceptance or completion beyond the evidence/);
		assert.equal(updates[0].content[0].text, "Subagent running (access: workspace-write)...");
	});

	await t.test("releases the workspace-write lease after normal completion", async () => {
		const [first, second] = [
			await invoke({ task, access: "workspace-write", model: "first-writer" }),
			await invoke({ task, access: "workspace-write", model: "second-writer" }),
		];
		assert.deepEqual([first.cwd, second.cwd], [fixtureDir, fixtureDir]);
	});

	await t.test("normal completion accepts and reports a deadline without forwarding a Pi flag", async () => {
		const updates: AgentToolResult[] = [];
		const invocation = await invoke({ task, timeoutMs: 10_000 }, updates);
		assert.equal(invocation.args.includes("--timeout"), false);
		assert.equal(updates[0].content[0].text, "Subagent running (access: workspace-write, timeout: 10000ms)...");
	});

	await t.test("rejects invalid deadlines before starting work", async () => {
		const updates: AgentToolResult[] = [];
		for (const timeoutMs of [999, 86_400_001, 1_000.5]) {
			await assert.rejects(
				tool.execute("invalid-timeout-test", { task, timeoutMs }, undefined, (update) => updates.push(update), ctx),
				/timeoutMs must be an integer between 1000 and 86400000/,
			);
		}
		assert.equal(updates.length, 0);
	});

	await t.test("preserves skills and long-task spillover alongside model selection", async () => {
		const longTask = "x".repeat(4001);
		const invocation = await invoke({ task: longTask, model: "haiku", skills: ["code-review", "skills/my skill.md"] });
		assert.deepEqual(invocation.args.slice(4, 10), ["--model", "haiku", "--skill", "code-review", "--skill", "skills/my skill.md"]);
		assert.equal(invocation.task, longTask);
		assert.match(invocation.args.at(-1)!, /^Task: Please read .+task\.md and follow the instructions there\.$/);
	});

	await t.test("rejects blank selectors before starting work instead of using a default", async () => {
		const updates: AgentToolResult[] = [];
		for (const model of ["", " \t\n"]) {
			await assert.rejects(invoke({ task, model }, updates), /model must be a non-empty Pi model ID/);
		}
		assert.equal(updates.length, 0);
	});

	await t.test("rejects an invalid selector before starting the task child", async () => {
		await rm(taskSpawnFile, { force: true });
		const updates: AgentToolResult[] = [];
		await withDiscoveryMode("model-rejected", async () => {
			await assert.rejects(
				tool.execute("invalid-model-test", { task, model: "_fixture_invalid_model_" }, undefined, (update) => updates.push(update), ctx),
				/Model selector "_fixture_invalid_model_" was rejected before launching a subagent: Model "_fixture_invalid_model_" not found.*Refresh subagent_models/,
			);
		});
		assert.equal(existsSync(taskSpawnFile), false, "invalid selectors must not start the task child");
		assert.equal(updates.length, 0);
		await invoke({ task, access: "workspace-write" });
	});

	await t.test("reports catalog failures distinctly from invalid selectors", async () => {
		const updates: AgentToolResult[] = [];
		await withDiscoveryMode("failure", async () => {
			await assert.rejects(
				tool.execute("catalog-failure-test", { task, model: "fixture/economical-model" }, undefined, (update) => updates.push(update), ctx),
				/Unable to validate model selector "fixture\/economical-model" because live model discovery failed: Fixture discovery failed.*Retry subagent_models/,
			);
		});
		assert.equal(updates.length, 0);
	});

	await t.test("does not mislabel a catalog response as selector rejection", async () => {
		await withDiscoveryMode("failure-no-models", async () => {
			await assert.rejects(
				tool.execute("catalog-no-models-test", { task, model: "fixture/economical-model" }, undefined, undefined, ctx),
				/Unable to validate model selector "fixture\/economical-model" because live model discovery failed: No models available/,
			);
		});
	});

	await t.test("surfaces a task-child model failure after a successful advisory preflight", async () => {
		await rm(taskSpawnFile, { force: true });
		await assert.rejects(
			invoke({ task, model: "_fixture_invalid_model_" }),
			/Model "_fixture_invalid_model_" not found\. Use --list-models/,
		);
		assert.deepEqual((await readFile(taskSpawnFile, "utf8")).trim().split("\n"), ["_fixture_invalid_model_"]);
	});

	await t.test("releases the workspace-write lease after a spawn error", async () => {
		const missingCtx = { ...ctx, cwd: join(fixtureDir, "missing-workspace") };
		for (let attempt = 0; attempt < 2; attempt++) {
			await assert.rejects(
				tool.execute(`spawn-error-${attempt}`, { task }, undefined, undefined, missingCtx),
				/ENOENT/,
			);
		}
	});

	for (const model of ["_fixture_provider_error_", "_fixture_aborted_", "_fixture_empty_error_"]) {
		await t.test(`reports JSON message failure for ${model} even when the child exits zero`, async () => {
			await assert.rejects(
				tool.execute("json-error-test", { task, model, timeoutMs: 10_000 }, undefined, undefined, ctx),
				model === "_fixture_empty_error_" ? /Subagent request error/ : /Provider rejected the request/,
			);
		});
	}

	await t.test("adds bounded recovery diagnostics to abnormal child results without retaining assistant text", async () => {
		await assert.rejects(
			tool.execute("provider-recovery-test", { task, model: "_fixture_provider_error_" }, undefined, undefined, ctx),
			(error: unknown) => {
				assert.ok(error instanceof Error);
				assert.match(error.message, /^Provider rejected the request/);
				assert.match(error.message, /- reason: abnormal-exit/);
				assert.match(error.message, /- final child response received: yes/);
				assert.match(error.message, /- process-tree termination: not attempted/);
				assert.doesNotMatch(error.message, /Incomplete answer that must not be returned as a success/);
				return true;
			},
		);
	});

	await t.test("does not silently accept oversized protocol output", async () => {
		await assert.rejects(
			tool.execute("oversized-protocol-test", { task, model: "_fixture_oversized_protocol_" }, undefined, undefined, ctx),
			(error: unknown) => {
				assert.ok(error instanceof Error);
				assert.match(error.message, /Subagent protocol output exceeded 1000000 characters/);
				assert.match(error.message, /- reason: abnormal-exit/);
				return true;
			},
		);
	});

	await t.test("reports unexpected signal termination as an abnormal child failure", async () => {
		await assert.rejects(
			tool.execute("signal-test", { task, model: "_fixture_signaled_" }, undefined, undefined, ctx),
			(error: unknown) => {
				assert.ok(error instanceof Error);
				assert.match(error.message, process.platform === "win32" ? /Subagent exited with code 1/ : /Subagent terminated by signal SIGTERM/);
				assert.match(error.message, /- reason: abnormal-exit/);
				return true;
			},
		);
	});

	await t.test("reports only the latest assistant state as final-response evidence", async () => {
		await assert.rejects(
			tool.execute("retry-timeout-test", { task, model: "_fixture_error_then_hang_", timeoutMs: 1_000 }, undefined, undefined, ctx),
			(error: unknown) => {
				assert.ok(error instanceof Error);
				assert.match(error.message, /- reason: timeout/);
				assert.match(error.message, /- final child response received: no/);
				assert.match(error.message, /- latest assistant stop reason: toolUse/);
				assert.doesNotMatch(error.message, /Earlier terminal error|Retry is still running/);
				return true;
			},
		);
	});

	await t.test("accepts a successful response after Pi recovers from a transient failure", async () => {
		const invocation = await invoke({ task, model: "_fixture_recovered_" });
		assert.equal(invocation.task, task);
	});

	await t.test("parallel read-only calls remain supported and keep model selections independent", async () => {
		const models = ["anthropic/claude-haiku-4-5", "openai/gpt-4.1"];
		const results = await Promise.all(models.map((model) => invoke({ task, model, access: "read-only" })));
		assert.deepEqual(results.map((result) => result.args[result.args.indexOf("--model") + 1]), models);
		assert.equal(ctx.model, parentModel);
	});

	await t.test("rejects a second same-cwd writer while allowing readers and a different cwd", async () => {
		await rm(pidFile, { force: true });
		const controller = new AbortController();
		const owner = assert.rejects(
			tool.execute("lease-owner", { task, model: "_fixture_hanging_tree_" }, controller.signal, undefined, ctx),
			/Subagent aborted by caller/,
		);
		let state: { pid: number; rootPid: number; promptFile: string } | undefined;
		try {
			state = await readDescendantState();

			const rejectedUpdates: AgentToolResult[] = [];
			await assert.rejects(
				tool.execute("lease-contender", { task }, undefined, (update) => rejectedUpdates.push(update), ctx),
				/A workspace-write subagent is already running.*Wait for it to finish.*access: "read-only".*different working directory/,
			);
			assert.equal(rejectedUpdates.length, 0);

			const [readerA, readerB, otherWriter] = await Promise.all([
				invoke({ task, access: "read-only", model: "reader-a" }),
				invoke({ task, access: "read-only", model: "reader-b" }),
				invoke({ task, access: "workspace-write", model: "other-writer" }, undefined, { ...ctx, cwd: otherCwd }),
			]);
			assert.deepEqual([readerA.cwd, readerB.cwd, otherWriter.cwd], [fixtureDir, fixtureDir, otherCwd]);
		} finally {
			controller.abort();
			await owner;
			if (state) {
				await waitForProcessExit(state.pid);
				await waitForProcessExit(state.rootPid);
				await assert.rejects(access(state.promptFile));
			}
		}
		await invoke({ task, access: "workspace-write" });
	});

	await t.test("times out a progressing child, reports bounded recovery evidence, and terminates its process tree", async () => {
		await rm(pidFile, { force: true });
		const updates: AgentToolResult[] = [];
		const rejection = assert.rejects(
			tool.execute("timeout-test", { task, model: "_fixture_hanging_tree_", timeoutMs: 1_000 }, undefined, (update) => updates.push(update), ctx),
			(error: unknown) => {
				assert.ok(error instanceof Error);
				assert.match(error.message, /^Subagent timed out after 1000ms/);
				assert.match(error.message, /Recovery diagnostics \(bounded\):\n- reason: timeout\n- elapsed: \d+ms\n- requested model: _fixture_hanging_tree_\n- access: workspace-write/);
				assert.match(error.message, /requested deadline: 1000ms/);
				assert.match(error.message, /final child response received: no/);
				assert.match(error.message, /assistant message_end observed: yes/);
				assert.match(error.message, /progress tail: last 1 entry\n  - \+\d+ms Turn 1: thinking\.\.\./);
				assert.match(error.message, /root process exit observed: yes/);
				assert.match(error.message, process.platform === "win32" ? /taskkill completed \(exit 0\)/ : /process-group requested/);
				assert.match(error.message, /known descendants after cleanup: unavailable/);
				assert.doesNotMatch(error.message, /Starting bounded work/);
				return true;
			},
		);
		const { pid, rootPid, promptFile } = await readDescendantState();
		assert.equal(isProcessRunning(pid), true);
		assert.equal(isProcessRunning(rootPid), true);
		await rejection;
		await waitForProcessExit(pid);
		await waitForProcessExit(rootPid);
		await assert.rejects(access(promptFile));
		assert.match(updates.at(-1)?.content[0].text ?? "", /Starting bounded work/);
		await invoke({ task, access: "workspace-write" });
	});

	await t.test("caller abort reports distinct recovery evidence and terminates the child process tree", async () => {
		await rm(pidFile, { force: true });
		const controller = new AbortController();
		const rejection = assert.rejects(
			tool.execute("abort-tree-test", { task, model: "_fixture_hanging_tree_" }, controller.signal, undefined, ctx),
			(error: unknown) => {
				assert.ok(error instanceof Error);
				assert.match(error.message, /^Subagent aborted by caller/);
				assert.match(error.message, /- reason: caller-abort/);
				assert.match(error.message, /- requested model: _fixture_hanging_tree_/);
				return true;
			},
		);
		const { pid, rootPid, promptFile } = await readDescendantState();
		assert.equal(isProcessRunning(pid), true);
		assert.equal(isProcessRunning(rootPid), true);
		controller.abort();
		await rejection;
		await waitForProcessExit(pid);
		await waitForProcessExit(rootPid);
		await assert.rejects(access(promptFile));
		await invoke({ task, access: "workspace-write" });
	});

	await t.test("still forwards a pre-aborted signal with a model selected", async () => {
		const controller = new AbortController();
		controller.abort();
		await assert.rejects(
			tool.execute("aborted-test", { task, model: "haiku" }, controller.signal, undefined, ctx),
			/Subagent aborted/,
		);
	});

	const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
	const renderContext: ToolRenderContext = {
		args: {}, toolCallId: "render-test", invalidate() {}, lastComponent: undefined, state: {},
		cwd: fixtureDir, executionStarted: false, argsComplete: true, isPartial: false,
		expanded: false, showImages: false, isError: false,
	};

	await t.test("renders the requested model and skill count in the header", () => {
		const component = tool.renderCall!({ task, model: " haiku ", thinking: "high", skills: ["review", "tests"] }, theme, renderContext);
		const text = stripVTControlCharacters(component.render(300).join("\n"));
		assert.match(text, /subagent Find all test files \[access: workspace-write\] \[haiku\] \[thinking: high\] \+2 skills/);
	});

	await t.test("renders explicit read-only access in the header", () => {
		const component = tool.renderCall!({ task, access: "read-only" }, theme, renderContext);
		const text = stripVTControlCharacters(component.render(300).join("\n"));
		assert.match(text, /subagent Find all test files \[access: read-only\]/);
	});

	await t.test("renders calls without a model and partial arguments", () => {
		for (const args of [{ task }, {}]) {
			const component = tool.renderCall!(args, theme, { ...renderContext, argsComplete: false });
			const text = stripVTControlCharacters(component.render(300).join("\n"));
			assert.match(text, /subagent/);
			assert.doesNotMatch(text, /\[|undefined/);
		}
	});

	await t.test("renders the requested deadline", () => {
		const component = tool.renderCall!({ task, timeoutMs: 15_000 }, theme, renderContext);
		const text = stripVTControlCharacters(component.render(300).join("\n"));
		assert.match(text, /subagent Find all test files \[access: workspace-write\] \[timeout: 15000ms\]/);
	});

	await t.test("renders thinking without a model", () => {
		const component = tool.renderCall!({ task, thinking: "off" }, theme, renderContext);
		const text = stripVTControlCharacters(component.render(300).join("\n"));
		assert.match(text, /subagent Find all test files \[access: workspace-write\] \[thinking: off\]/);
		assert.doesNotMatch(text, /undefined/);
	});

	await t.test("renders failed model selection as an error rather than a success", () => {
		const result = { content: [{ type: "text" as const, text: "Model not found" }] };
		for (const isError of [true, false]) {
			const component = tool.renderResult!(result, { expanded: false, isPartial: false }, theme, { ...renderContext, isError });
			const text = stripVTControlCharacters(component.render(300).join("\n"));
			assert.match(text, isError ? /^✗ --- Result ---/ : /^✓ --- Result ---/);
		}
	});
});
