import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { stripVTControlCharacters } from "node:util";
import type { AgentToolResult, ExtensionAPI, ToolRenderContext } from "@earendil-works/pi-coding-agent";
import type { TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import registerSubagent from "../index.js";

type SubagentTool = Parameters<ExtensionAPI["registerTool"]>[0];
type SubagentInput = { task: string; model?: string; thinking?: string; skills?: string[] };
type Invocation = { args: string[]; cwd: string; disabled: string; prompt: string; task: string; thinking?: string };

// Exercise the real spawn/argument/parsing path without invoking Pi or a paid model.
const FAKE_PI = String.raw`
const fs = require("node:fs");
const args = process.argv.slice(2);
const modelIndex = args.indexOf("--model");
const model = modelIndex === -1 ? undefined : args[modelIndex + 1];
const thinkingIndex = args.indexOf("--thinking");
const thinking = thinkingIndex === -1 ? undefined : args[thinkingIndex + 1];
const emit = (message) => process.stdout.write(JSON.stringify({ type: "message_end", message }) + "\n");
if (args.includes("--mode") && args[args.indexOf("--mode") + 1] === "rpc") {
  const mode = process.env.PI_SUBAGENT_TEST_MODE;
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
      if (mode === "failure") {
        process.stdout.write(JSON.stringify({ id: command.id, type: "response", command: command.type, success: false, error: "Fixture discovery failed" }) + "\n");
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
  });
  emit({ role: "assistant", content: [{ type: "text", text }], stopReason: "stop" });
}
`;

test("subagent model selection", { timeout: 30_000 }, async (t) => {
	const fixtureDir = await mkdtemp(join(tmpdir(), "subagent-model-test-"));
	const originalScript = process.argv[1];
	const originalDisabled = process.env.PI_SUBAGENT_LITE_DISABLE;
	t.after(async () => {
		process.argv[1] = originalScript;
		if (originalDisabled === undefined) delete process.env.PI_SUBAGENT_LITE_DISABLE;
		else process.env.PI_SUBAGENT_LITE_DISABLE = originalDisabled;
		await rm(fixtureDir, { recursive: true, force: true });
	});

	const fixtureScript = join(fixtureDir, "fake-pi.cjs");
	await writeFile(fixtureScript, FAKE_PI);
	// This file's tests run serially in their own test-runner process. Point the
	// normal getPiInvocation path at the fixture and restore it in the hook above.
	process.argv[1] = fixtureScript;
	delete process.env.PI_SUBAGENT_LITE_DISABLE;
	const registeredTools: SubagentTool[] = [];
	registerSubagent({ registerTool: (tool) => { registeredTools.push(tool); } });
	const tool = registeredTools.find((candidate) => candidate.name === "subagent");
	const modelsTool = registeredTools.find((candidate) => candidate.name === "subagent_models");
	assert.ok(tool);
	assert.ok(modelsTool);
	const parentModel = Object.freeze({ provider: "parent-provider", id: "parent-model" });
	const ctx = Object.freeze({ cwd: fixtureDir, hasUI: false, model: parentModel });
	const task = "Find all test files";

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

	const invoke = async (params: SubagentInput, updates?: AgentToolResult[]): Promise<Invocation> => {
		const result = await tool.execute("model-test", params, undefined, updates ? (r) => updates.push(r) : undefined, ctx);
		const invocation = JSON.parse(result.content[0].text) as Invocation;
		const promptFile = invocation.args[invocation.args.indexOf("--append-system-prompt") + 1];
		assert.equal(existsSync(dirname(promptFile)), false, "temporary prompts are cleaned up");
		return invocation;
	};

	await t.test("schema makes model optional and rejects blank or non-string selectors", () => {
		const schema = tool.parameters as TSchema;
		assert.equal(Value.Check(schema, { task }), true);
		assert.equal(Value.Check(schema, { task, model: "anthropic/claude-haiku-4-5" }), true);
		assert.equal(Value.Check(schema, { task, thinking: "high" }), true);
		assert.equal(Value.Check(schema, { task, thinking: "ultra" }), false);
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
			assert.equal(updates[0].content[0].text, `Subagent running (model: ${model})...`);
			assert.match(updates[1].content[0].text, /^Turn 1:/);
		});
	}

	await t.test("omitting model preserves defaults even after explicit selection", async () => {
		const updates: AgentToolResult[] = [];
		const invocation = await invoke({ task }, updates);
		assert.deepEqual(invocation.args.slice(0, 5), ["--mode", "json", "-p", "--no-session", "--append-system-prompt"]);
		assert.equal(invocation.args.includes("--model"), false);
		assert.equal(invocation.args.includes("--provider"), false);
		assert.equal(invocation.args.includes("--thinking"), false);
		assert.equal(updates[0].content[0].text, "Subagent running...");
		assert.equal(ctx.model, parentModel);
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
		assert.equal(updates[0].content[0].text, "Subagent running (model: haiku, thinking: high)...");
	});

	await t.test("forwards thinking off", async () => {
		const updates: AgentToolResult[] = [];
		const invocation = await invoke({ task, model: "haiku", thinking: "off" }, updates);
		assert.deepEqual(invocation.args.slice(4, 8), ["--model", "haiku", "--thinking", "off"]);
		assert.equal(invocation.thinking, "off");
		assert.equal(updates[0].content[0].text, "Subagent running (model: haiku, thinking: off)...");
	});

	await t.test("forwards thinking without a model and displays it in progress", async () => {
		const updates: AgentToolResult[] = [];
		const invocation = await invoke({ task, thinking: "high" }, updates);
		assert.deepEqual(invocation.args.slice(4, 7), ["--thinking", "high", "--append-system-prompt"]);
		assert.equal(invocation.args.includes("--model"), false);
		assert.equal(invocation.thinking, "high");
		assert.equal(updates[0].content[0].text, "Subagent running (thinking: high)...");
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

	await t.test("propagates child model errors as failures without retrying with a default", async () => {
		await assert.rejects(
			invoke({ task, model: "_fixture_invalid_model_" }),
			/Model "_fixture_invalid_model_" not found\. Use --list-models/,
		);
	});

	for (const model of ["_fixture_provider_error_", "_fixture_aborted_", "_fixture_empty_error_"]) {
		await t.test(`reports JSON message failure for ${model} even when the child exits zero`, async () => {
			await assert.rejects(
				tool.execute("json-error-test", { task, model }, undefined, undefined, ctx),
				model === "_fixture_empty_error_" ? /Subagent request error/ : /Provider rejected the request/,
			);
		});
	}

	await t.test("accepts a successful response after Pi recovers from a transient failure", async () => {
		const invocation = await invoke({ task, model: "_fixture_recovered_" });
		assert.equal(invocation.task, task);
	});

	await t.test("parallel calls keep their model selections independent", async () => {
		const models = ["anthropic/claude-haiku-4-5", "openai/gpt-4.1"];
		const results = await Promise.all(models.map((model) => invoke({ task, model })));
		assert.deepEqual(results.map((r) => r.args[5]), models);
		assert.equal(ctx.model, parentModel);
	});

	await t.test("still forwards the abort signal with a model selected", async () => {
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
		assert.match(text, /subagent Find all test files \[haiku\] \[thinking: high\] \+2 skills/);
	});

	await t.test("renders calls without a model and partial arguments", () => {
		for (const args of [{ task }, {}]) {
			const component = tool.renderCall!(args, theme, { ...renderContext, argsComplete: false });
			const text = stripVTControlCharacters(component.render(300).join("\n"));
			assert.match(text, /subagent/);
			assert.doesNotMatch(text, /\[|undefined/);
		}
	});

	await t.test("renders thinking without a model", () => {
		const component = tool.renderCall!({ task, thinking: "off" }, theme, renderContext);
		const text = stripVTControlCharacters(component.render(300).join("\n"));
		assert.match(text, /subagent Find all test files \[thinking: off\]/);
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
